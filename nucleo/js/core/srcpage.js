/**
 * NÚCLEO OS — core/srcpage.js
 * Pipeline da página: URL → bytes (pelo proxy) → documento + CSS + lista de imagens.
 *
 * Aqui vive o que um navegador de verdade faz antes de pintar: buscar o HTML,
 * buscar as folhas de estilo EXTERNAS (quase todo site real põe o CSS num arquivo),
 * juntar o CSS inline e listar as imagens a decodificar.
 *
 * Duas decisões de honestidade, porque afetam o que o usuário vê:
 *  1. Falha de folha de estilo NÃO derruba a página: ela é registrada em `notas`
 *     (com o motivo) e a página é pintada sem aquelas regras — degradação visível;
 *  2. O que o motor não renderiza (SVG inline, vídeo, canvas, iframe) é **contado
 *     e reportado**, em vez de sumir em silêncio e o usuário achar que a página
 *     está quebrada por culpa própria.
 */

const MAX_FOLHAS = 8;
const MAX_BYTES_FOLHA = 512 * 1024;
const TIMEOUT_FOLHA_MS = 6000;

/**
 * @param {string} url                        URL final (já resolvida pelo proxy)
 * @param {object} opts
 * @param {(url:string) => Promise<object>} opts.buscarJson   devolve o JSON de /api/fetch
 * @param {Function} opts.parser               DOMParser
 * @param {string} [opts.texto]                HTML já obtido (evita re-buscar)
 * @returns {Promise<{doc, url, folhas, inlineCss, imagens, notas, scripts}>}
 */
export async function carregarFonte(url, { buscarJson, parser, texto = null, log = null } = {}) {
  const notas = [];
  let html = texto;
  let urlFinal = url;

  if (html == null) {
    const resposta = await buscarJson(url);
    if (!resposta?.ok) throw new Error(resposta?.error || 'falha ao buscar a página');
    html = resposta.text;
    urlFinal = resposta.url || url;
  }
  if (typeof html !== 'string') throw new Error('a página não retornou texto');

  const Doc = typeof parser === 'function' ? parser : (globalThis.DOMParser || globalThis.window?.DOMParser || null);
  if (!Doc) throw new Error('DOMParser indisponível neste contexto');
  const dom = new Doc();
  const doc = dom.parseFromString(html, 'text/html');

  const resolver = valor => {
    try { return new URL(valor, urlFinal).href; } catch { return null; }
  };

  // ---- folhas de estilo externas -------------------------------------------
  const ligacoes = [...doc.querySelectorAll('link[rel~="stylesheet"][href], link[rel="stylesheet"][href]')];
  const alvos = [];
  for (const link of ligacoes) {
    const absoluta = resolver(link.getAttribute('href'));
    if (absoluta && !alvos.includes(absoluta)) alvos.push(absoluta);
    if (alvos.length >= MAX_FOLHAS) break;
  }
  if (ligacoes.length > alvos.length) {
    notas.push(`${ligacoes.length - alvos.length} folha(s) de estilo além do teto de ${MAX_FOLHAS} não foram buscadas`);
  }

  const folhas = [];
  for (const href of alvos) {
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_FOLHA_MS) : null;
      const resposta = await buscarJson(href);
      if (timer) clearTimeout(timer);
      if (!resposta?.ok) throw new Error(resposta?.error || 'falha');
      const css = String(resposta.text ?? '');
      if (css.length > MAX_BYTES_FOLHA) {
        folhas.push({ href, css: css.slice(0, MAX_BYTES_FOLHA), truncada: true });
        notas.push(`folha ${nomeCurto(href)} truncada em ${Math.round(MAX_BYTES_FOLHA / 1024)} KB`);
      } else {
        folhas.push({ href, css, truncada: false });
      }
    } catch (e) {
      // Degradação visível: a página fica sem aquele CSS e o motivo aparece.
      folhas.push({ href, css: '', erro: String(e?.message || e) });
      notas.push(`folha ${nomeCurto(href)} não carregou (${String(e?.message || e)})`);
      log?.('css falhou', href, String(e?.message || e));
    }
  }

  const inlineCss = [...doc.querySelectorAll('style')].map(s => s.textContent || '').join('\n');

  // ---- imagens --------------------------------------------------------------
  const imagens = [];
  const vistas = new Set();
  for (const img of doc.querySelectorAll('img[src]')) {
    const absoluta = resolver(img.getAttribute('src'));
    if (!absoluta || vistas.has(absoluta)) continue;
    vistas.add(absoluta);
    imagens.push(absoluta);
  }
  const comSrcset = doc.querySelectorAll('img[srcset]').length;
  if (comSrcset) notas.push(`${comSrcset} imagem(ns) com \`srcset\`: usamos o \`src\` simples (sem seletor de densidade)`);

  // ---- o que o motor não renderiza (reportado, nunca escondido) -------------
  const scripts = doc.querySelectorAll('script').length;
  if (scripts) notas.push(`${scripts} <script> ignorado(s): o motor não executa JavaScript de página`);
  const svgs = doc.querySelectorAll('svg').length;
  if (svgs) notas.push(`${svgs} SVG inline não é renderizado (aparece o texto alternativo, quando existe)`);
  const midias = doc.querySelectorAll('video, audio, canvas, object, embed').length;
  if (midias) notas.push(`${midias} mídia(s) embutida(s) (vídeo/canvas/objeto) não são renderizadas`);
  const iframes = doc.querySelectorAll('iframe').length;
  if (iframes) notas.push(`${iframes} iframe(s) ignorado(s)`);

  return { doc, url: urlFinal, folhas, inlineCss, imagens, notas, scripts, htmlBytes: html.length };
}

/** Reúne o CSS usado no layout: externo (na ordem) + inline. */
export function cssDe(fonte) {
  const externas = (fonte.folhas || []).filter(f => f.css).map(f => f.css).join('\n');
  return `${externas}\n${fonte.inlineCss || ''}`;
}

function nomeCurto(href) {
  try {
    const u = new URL(href);
    const parte = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return parte.slice(0, 40);
  } catch { return String(href).slice(0, 40); }
}

/**
 * Mescla o CSS externo no documento (o layout lê `<style>` de dentro do doc).
 * Feito assim, e não passando regras soltas, porque mantém a ordem de cascata que
 * o autor escreveu: links na ordem do documento e depois o `<style>` inline.
 */
export function injetarCss(doc, css, { origem = 'externa' } = {}) {
  if (!css?.trim()) return null;
  const tag = doc.createElement('style');
  tag.setAttribute('data-origem', origem);
  tag.textContent = css;
  (doc.head || doc.documentElement).appendChild(tag);
  return tag;
}
