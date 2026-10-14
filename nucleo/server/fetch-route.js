/**
 * NÚCLEO OS — server/fetch-route.js
 * Rota `/api/fetch`: o "modem" do navegador do sistema.
 *
 * Por que existe no servidor e não no navegador: a página é `crossOriginIsolated`
 * (COEP `require-corp`), então recursos de outras origens são bloqueados pelo
 * navegador host — e a maioria dos sites também não permite ser embutida em iframe
 * (`X-Frame-Options`/CSP). Buscar no servidor é o único caminho que funciona, e é
 * por isso que este arquivo existe com guardas explícitas em vez de um `fetch` solto.
 *
 * Segurança (ver js/core/fetchpolicy.js, que é puro e testado à parte):
 *  - só http/https, sem credenciais na URL, sem portas baixas fora de 80/443;
 *  - IP privado/loopback/link-local bloqueado, antes E depois do DNS;
 *  - redirecionamentos seguidos À MÃO (máx. 5), validando cada salto — seguir
 *    redirects automaticamente é como um proxy deixa de ser seguro;
 *  - teto de bytes lido do corpo (2 MiB texto / 8 MiB bruto) com aborto real;
 *  - timeout duro de 15 s.
 *
 * As dependências (`fetch`, `lookup`) são injetáveis: o comportamento acima é
 * testado sem rede e sem servidor no meio (tests/core.mjs §17).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import {
  checkTarget, checkResolvedAddresses,
  MAX_TEXT_BYTES, MAX_RAW_BYTES, MAX_REDIRECTS, FETCH_TIMEOUT_MS
} from '../js/core/fetchpolicy.js';

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|x-javascript|javascript|rss|atom)\b)/i;
const HTML_LIKE = /^(text\/html|application\/xhtml)/i;

/** Lê o corpo com teto real de bytes (não confia em content-length). */
async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length') || NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return { tooBig: true, declared, bytes: null };
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.length > limit ? { tooBig: true, declared: buf.length, bytes: null } : { tooBig: false, declared, bytes: buf };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { tooBig: true, declared: total, bytes: null };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return { tooBig: false, declared, bytes: out };
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]   injetável para teste
 * @param {Function} [deps.lookup]          resolver DNS (dns.lookup do Node)
 * @returns {(req, res, send) => Promise<boolean>} true se tratou a requisição
 */
export function createFetchRoute({ fetchImpl = globalThis.fetch, lookup = dnsLookup } = {}) {
  return async function handleFetch(req, res, send) {
    const parsed = new URL(req.url || '/', 'http://localhost');
    if (parsed.pathname !== '/api/fetch') return false;

    const raw = parsed.searchParams.get('url') || '';
    const wantRaw = parsed.searchParams.get('raw') === '1';
    const limit = wantRaw ? MAX_RAW_BYTES : MAX_TEXT_BYTES;

    const check = checkTarget(raw);
    if (!check.ok) {
      return send(res, 400, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, error: check.reason })), true;
    }

    const t0 = Date.now();
    let current = check.url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const target = new URL(current);

        // Checagem de DNS: mesmo um hostname público pode apontar para dentro.
        let resolved = [];
        try { resolved = await lookup(target.hostname, { all: true }); } catch { resolved = []; }
        const dnsCheck = checkResolvedAddresses(resolved);
        if (!dnsCheck.ok) {
          return send(res, 403, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({ ok: false, error: dnsCheck.reason, url: current })), true;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let response;
        try {
          response = await fetchImpl(current, {
            redirect: 'manual',                       // cada salto é validado aqui
            signal: controller.signal,
            headers: {
              'user-agent': 'NucleoOS/0.1 (+text browser; local)',
              accept: wantRaw ? '*/*' : 'text/html,text/plain;q=0.9,*/*;q=0.5'
            }
          });
        } finally {
          clearTimeout(timer);
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          const next = location ? new URL(location, current).href : null;
          const nextCheck = next ? checkTarget(next) : { ok: false, reason: 'redirecionamento sem destino' };
          if (!nextCheck.ok) {
            return send(res, 403, { 'Content-Type': 'application/json; charset=utf-8' },
              JSON.stringify({ ok: false, error: `redirecionamento bloqueado: ${nextCheck.reason}`, url: current })), true;
          }
          if (hop === MAX_REDIRECTS) {
            return send(res, 508, { 'Content-Type': 'application/json; charset=utf-8' },
              JSON.stringify({ ok: false, error: `mais de ${MAX_REDIRECTS} redirecionamentos` })), true;
          }
          current = nextCheck.url;
          continue;
        }

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const { tooBig, declared, bytes } = await readCapped(response, limit);
        const ms = Date.now() - t0;

        if (tooBig) {
          return send(res, 413, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({
              ok: false, url: current, status: response.status, contentType, ms, limit,
              error: `resposta maior que o teto de ${limit / 1048576} MiB (declarado ${declared} bytes)`
            })), true;
        }

        if (wantRaw) {
          // Download pedido explicitamente pelo app: devolve os bytes como vieram.
          res.writeHead(response.status, {
            'Content-Type': contentType,
            'Content-Length': bytes.length,
            'X-Nucleo-Fetch': 'raw',
            'X-Nucleo-Url': current,
            'Cache-Control': 'no-store'
          });
          res.end(Buffer.from(bytes));
          return true;
        }

        const textual = TEXTUAL.test(contentType) || contentType === '';
        const body = textual ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : null;
        send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          JSON.stringify({
            ok: true, url: current, status: response.status, contentType,
            bytes: bytes.length, ms, htmlLike: HTML_LIKE.test(contentType),
            text: body,
            note: textual ? null : 'conteúdo binário: use "salvar no disco virtual" para baixar'
          }));
        return true;
      }
    } catch (e) {
      // `fetch failed` sozinho não diz nada: a causa real (ENOTFOUND, certificado,
      // recusa de conexão) vem em `e.cause`. Esconder isso seria justamente o tipo
      // de resposta vazia que este projeto não aceita.
      const causa = e?.cause?.code || e?.cause?.message;
      const motivo = [String(e?.message || e), causa].filter(Boolean).join(' · ');
      const reason = e?.name === 'AbortError'
        ? `tempo esgotado (${FETCH_TIMEOUT_MS} ms)`
        : `falha de rede: ${motivo}`;
      send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, url: current, error: reason, ms: Date.now() - t0 }));
      return true;
    }
    return true;
  };
}

/**
 * NÚCLEO OS — rota `/api/probe`: "quais destes hosts respondem daqui?"
 *
 * Existe porque a resposta honesta para "o navegador não abre nada" não pode ser
 * silêncio: em rede restrita (escola, empresa, *sandbox*) só uma parte da internet
 * responde, e o usuário precisa saber **quais** — com número, não com desculpa.
 *
 * Limites de propósito:
 *  - a lista de alvos é FIXA (chaves conhecidas), então esta rota não é scanner de
 *    portas nem proxy de URL arbitrária — isso é o trabalho de `/api/fetch`, com as
 *    guardas dele;
 *  - cada alvo passa pela MESMA política (`checkTarget` + checagem de DNS);
 *  - o corpo é lido com `Range: bytes=0-1023`, então não se baixa página inteira só
 *    para saber se o host responde;
 *  - falha de um alvo não derruba os outros.
 */
const ALVOS = {
  github: 'https://github.com/',
  npm: 'https://registry.npmjs.org/',
  pypi: 'https://pypi.org/',
  exemplo: 'https://example.com/',
  google: 'https://www.google.com/',
  wikipedia: 'https://pt.wikipedia.org/'
};
export const ALVOS_DE_SONDAGEM = Object.keys(ALVOS);
const PROBE_TIMEOUT_MS = 6000;

export function createProbeRoute({ fetchImpl = globalThis.fetch, lookup = dnsLookup } = {}) {
  return async function handleProbe(req, res, send) {
    const parsed = new URL(req.url || '/', 'http://localhost');
    if (parsed.pathname !== '/api/probe') return false;

    const pedidos = (parsed.searchParams.get('alvos') || '').split(',').map(s => s.trim()).filter(Boolean);
    const chaves = pedidos.length ? pedidos.filter(k => Object.hasOwn(ALVOS, k)) : ALVOS_DE_SONDAGEM;
    if (!chaves.length) {
      return send(res, 400, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, error: `alvos desconhecidos (disponíveis: ${ALVOS_DE_SONDAGEM.join(', ')})` })), true;
    }

    const hosts = [];
    for (const chave of chaves) {
      const url = ALVOS[chave];
      const t0 = Date.now();
      const check = checkTarget(url);
      if (!check.ok) { hosts.push({ chave, url, ok: false, error: check.reason, ms: 0 }); continue; }
      try {
        const target = new URL(url);
        let resolved = [];
        try { resolved = await lookup(target.hostname, { all: true }); } catch { resolved = []; }
        const dnsCheck = checkResolvedAddresses(resolved);
        if (!dnsCheck.ok) { hosts.push({ chave, url, ok: false, error: dnsCheck.reason, ms: Date.now() - t0 }); continue; }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        let response;
        try {
          response = await fetchImpl(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'user-agent': 'NucleoOS/0.1 (+sondagem de rede; local)',
              range: 'bytes=0-1023',
              accept: '*/*'
            }
          });
        } finally { clearTimeout(timer); }

        // Drena o corpo (com teto) para não deixar socket pendurado; o conteúdo em
        // si não interessa, só o fato de o host ter respondido.
        try { await readCapped(response, 4096); } catch { /* corpo irrelevante aqui */ }
        hosts.push({ chave, url, ok: true, status: response.status, ms: Date.now() - t0 });
      } catch (e) {
        const causa = e?.cause?.code || e?.cause?.message;
        const motivo = e?.name === 'AbortError'
          ? `tempo esgotado (${PROBE_TIMEOUT_MS} ms)`
          : [String(e?.message || e), causa].filter(Boolean).join(' · ');
        hosts.push({ chave, url, ok: false, error: motivo, ms: Date.now() - t0 });
      }
    }

    send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, quando: Date.now(), hosts }));
    return true;
  };
}
