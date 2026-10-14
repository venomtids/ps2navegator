/**
 * NÚCLEO OS — server.js
 * Servidor estático mínimo, sem dependências, para o Virtual PC.
 *
 * Por que existe um servidor: `SharedArrayBuffer` (e portanto threads Wasm,
 * os anéis IPC e o OPFS com SyncAccessHandle) só existe em contexto
 * `crossOriginIsolated`, o que exige COOP + COEP. Isso é impossível de obter
 * abrindo o `index.html` por `file://`. Sem COOP/COEP o sistema **funciona**,
 * mas degradado: transporte MESSAGE e backend de disco volátil — o HUD mostra isso.
 *
 * Sem framework: `node:http` custa menos que uma árvore de dependências em um
 * projeto cujo ponto é ser auditável e offline.
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetchRoute } from './server/fetch-route.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 3400);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/** Estes cabeçalhos são o motivo de o servidor existir (ver topo do arquivo). */
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

/** Caminho pedido → arquivo real dentro de ROOT, ou null se tentar sair da raiz. */
function resolveTarget(urlPath) {
  let clean;
  try { clean = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const rel = normalize(clean).replace(/^([/\\])+/, '');
  const full = join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...ISOLATION, ...headers });
  if (body === undefined) res.end(); else res.end(body);
}

/**
 * Rota de busca do navegador do sistema (`/api/fetch`). É um proxy — por isso
 * vem com as guardas de js/core/fetchpolicy.js e só vale para uso local: NÃO
 * exponha este servidor na internet aberta (README).
 */
const handleFetch = createFetchRoute();

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'method not allowed\n');
  }

  try {
    if (await handleFetch(req, res, send)) return;
  } catch (e) {
    console.error('[fetch]', e);
    return send(res, 500, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ ok: false, error: 'falha interna na rota de busca' }));
  }

  const target = resolveTarget(req.url || '/');
  if (!target) return send(res, 403, { 'Content-Type': 'text/plain' }, 'caminho inválido\n');

  let file = target;
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    const info = statSync(file);
    if (!info.isFile()) throw new Error('não é arquivo');
    res.writeHead(200, {
      ...ISOLATION,
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
    return;
  } catch {
    // Sem SPA catch-all: um caminho desconhecido é 404 honesto, não index.html.
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' },
      '404 — não encontrado. O desktop fica em /\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NÚCLEO OS: http://localhost:${PORT}`);
  console.log('COOP/COEP ativos — SharedArrayBuffer disponível quando aberto em aba própria.');
  console.log('Navegador de texto disponível (rota /api/fetch) — este servidor é para uso LOCAL:');
  console.log('não exponha esta porta na internet, ela é um proxy de leitura.');
});
