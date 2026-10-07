'use strict';
const express = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_CHUNK = 2 * 1024 * 1024;
const MAX_ACTIVE = 8;
let active = 0;
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  next();
});

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
function diskURL(query) {
  const { item, file } = query;
  if (typeof item !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(item))
    throw fail(400, 'Identificador do Archive inválido.');
  if (typeof file !== 'string' || file.length > 1024 || !/\.iso$/i.test(file) ||
      file.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f]/.test(file))
    throw fail(400, 'Informe o caminho exato de um arquivo .iso não compactado.');
  return `https://archive.org/download/${encodeURIComponent(item)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
function allowedURL(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password ||
      (u.port && u.port !== '443') ||
      !(u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org')))
    throw fail(502, 'Redirecionamento remoto não permitido.');
  return u;
}
async function remote(url, headers, signal) {
  for (let hop = 0; hop < 6; hop++) {
    const u = allowedURL(url);
    const r = await fetch(u, {
      headers: { 'Accept-Encoding': 'identity', ...headers },
      redirect: 'manual', signal
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location');
      await r.body?.cancel();
      if (!location) throw fail(502, 'Redirecionamento sem destino.');
      url = new URL(location, u).href;
      continue;
    }
    return r;
  }
  throw fail(502, 'Excesso de redirecionamentos.');
}
async function ranged(url, start, end, signal) {
  const r = await remote(url, { Range: `bytes=${start}-${end}` }, signal);
  const encoding = r.headers.get('content-encoding');
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') || '');
  const a = m ? Number(m[1]) : NaN;
  const b = m ? Number(m[2]) : NaN;
  const total = m ? Number(m[3]) : NaN;
  const valid = r.status === 206 && (!encoding || encoding === 'identity') &&
    [a, b, total].every(Number.isSafeInteger) && total > 0 &&
    a === start && b === Math.min(end, total - 1) && b >= a;
  if (!valid) {
    await r.body?.cancel();
    if (r.status === 404) throw fail(404, 'ISO não encontrada.');
    if ([401, 403].includes(r.status)) throw fail(403, 'O arquivo não é público.');
    if (r.status === 429) throw fail(503, 'Archive ocupado; tente novamente.');
    if (r.status === 416) throw fail(416, 'Setor fora do disco.');
    throw fail(502, 'Origem sem Range válido. Download integral bloqueado para proteger a RAM.');
  }
  return { r, start: a, end: b, total };
}
// O pipeline respeita backpressure; o limite impede respostas remotas excessivas.
async function* bounded(body, expected) {
  let received = 0;
  for await (const chunk of body) {
    received += chunk.byteLength;
    if (received > expected) throw fail(502, 'Resposta remota maior que o setor solicitado.');
    yield chunk;
  }
  if (received !== expected) throw fail(502, 'Resposta remota incompleta.');
}
function api(handler) {
  return async (req, res) => {
    if (active >= MAX_ACTIVE) return res.set('Retry-After', '2').status(503).json({ error: 'Leitor ocupado.' });
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    res.set('Cache-Control', 'no-store');
    try {
      await handler(req, res, controller.signal);
    } catch (e) {
      if (!res.headersSent && !res.destroyed)
        res.status(e.status || (controller.signal.aborted ? 504 : 502)).json({ error: e.status ? e.message : 'Falha ou timeout na leitura remota.' });
      else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);
      controller.abort();
      res.off('close', close);
      active--;
    }
  };
}
app.get('/api/disc', api(async (req, res, signal) => {
  const { r, total } = await ranged(diskURL(req.query), 0, 0, signal);
  await r.body.cancel();
  res.json({ size: total, sectorSize: 2048, maxChunk: MAX_CHUNK });
}));
app.get('/api/stream-iso', api(async (req, res, signal) => {
  const url = diskURL(req.query);
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (!m) throw fail(400, 'Use um único Range fechado: bytes=início-fim.');
  const start = Number(m[1]), end = Number(m[2]);
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end - start + 1 > MAX_CHUNK)
    throw fail(400, 'Range inválido ou maior que 2 MiB.');
  const result = await ranged(url, start, end, signal);
  const length = result.end - result.start + 1;
  res.status(206).set({
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${result.start}-${result.end}/${result.total}`,
    'Content-Length': String(length)
  });
  await pipeline(Readable.from(bounded(result.r.body, length)), res, { signal });
}));
// Game data stays outside the distributed ZIP. Nothing is downloaded at startup.
app.use('/api/game', require('./game-installer').router(
  process.env.GAME_DIR || path.join(__dirname, 'games', 'gta-sa-ps2')
));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// Coloque um adaptador real e seus assets nesta pasta; não é exposto nenhum outro diretório.
app.use('/emulator', express.static(path.join(__dirname, 'emulator'), { dotfiles: 'deny' }));
app.listen(PORT, '0.0.0.0', () => console.log(`Launcher: http://localhost:${PORT}`));
