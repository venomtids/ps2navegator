'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn, spawnSync } = require('node:child_process');

const GAME = require('./game-config.json');
const { createHash } = require('node:crypto');
const GiB = 1024 ** 3;
const MAX_ARCHIVE = 8 * GiB, MAX_ISO = 9 * GiB;
const busy = phase => ['resolving', 'downloading', 'extracting', 'validating', 'cancelling'].includes(phase);
const error = (message, status = 400) => Object.assign(new Error(message), { status });

function allowedURL(value) {
  let u;
  try { u = new URL(value); } catch { throw error('Link direto inválido.'); }
  const allowed = ['romsfun.com', 'romsfast.com', 'archive.org'];
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !allowed.some(h => u.hostname === h || u.hostname.endsWith('.' + h)))
    throw error('Use HTTPS em romsfun.com, romsfast.com ou archive.org. Outros hosts não estão liberados.');
  return u;
}
async function remote(url, signal, extra = {}) {
  for (let hop = 0; hop < 6; hop++) {
    const u = allowedURL(url);
    const r = await fetch(u, { signal, redirect: 'manual', headers: {
      'Accept-Encoding': 'identity', ...extra
    }});
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location');
      await r.body?.cancel();
      if (!location) throw error('Redirecionamento inválido.', 502);
      url = new URL(location, u).href;
      continue;
    }
    return r;
  }
  throw error('Redirecionamentos demais.', 502);
}
async function readSmall(body, max) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) throw error('Página de download excedeu o limite.', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function resolveSource(direct) {
  const u = allowedURL(direct || GAME.url);
  if (!/\.(zip|7z|iso)$/i.test(u.pathname)) throw error('Use um link direto .zip, .7z ou .iso, não uma página.');
  return u.href;
}
function sevenZip() {
  // Prefer a maintained system installation. The npm binary is the offline fallback.
  for (const executable of [process.env.SEVEN_ZIP, '7zz', '7z'].filter(Boolean)) {
    const check = spawnSync(executable, ['i'], { timeout: 5000, stdio: 'ignore', windowsHide: true });
    if (!check.error && check.status === 0) return executable;
  }
  const executable = require('7zip-bin').path7za;
  if (!fs.existsSync(executable)) throw error('7-Zip não disponível nesta plataforma. Instale 7-Zip e configure SEVEN_ZIP.');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  return executable;
}
function completion(child) {
  // Resolve instead of rejecting to avoid unhandled rejections while pipeline runs.
  return new Promise(resolve => {
    child.once('error', err => resolve({ err, code: -1 }));
    child.once('close', code => resolve({ code }));
  });
}
async function listISO(executable, archive, password, signal) {
  const child = spawn(executable, ['l', '-slt', '-ba', '-sccUTF-8', '-p' + password, '--', archive],
    { signal, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const done = completion(child);
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const text = await readSmall(child.stdout, 2 * 1024 * 1024);
    const result = await done;
    if (result.err || result.code !== 0) throw error('Não foi possível listar o pacote. Senha/formato inválido ou extrator indisponível.');
    const entries = text.split(/\r?\n\r?\n/).map(block => Object.fromEntries(
      block.split(/\r?\n/).filter(line => line.includes(' = ')).map(line => {
        const n = line.indexOf(' = '); return [line.slice(0, n), line.slice(n + 3)];
      })
    ));
    const isos = entries.filter(e => /\.iso$/i.test(e.Path || '') && e.Folder !== '+' && !e['Symbolic Link'] && !e['Hard Link']);
    if (isos.length !== 1) throw error(`O pacote contém ${isos.length} ISOs identificáveis; é necessária exatamente uma ISO.`);
    const iso = isos[0], size = Number(iso.Size);
    if (!Number.isSafeInteger(size) || size < 34816 || size > MAX_ISO) throw error('ISO fora do limite de tamanho permitido.');
    return { name: iso.Path, size };
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}
function limitStream(max, update) {
  let size = 0;
  return new Transform({ transform(chunk, encoding, cb) {
    size += chunk.length;
    if (size > max) return cb(error('Arquivo excedeu o limite de segurança.'));
    update(size, chunk); cb(null, chunk);
  }});
}
async function validateISO(file) {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size < 34816 || stat.size > MAX_ISO) throw error('ISO extraída tem tamanho inválido.');
  const handle = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(6); await handle.read(b, 0, 6, 32768);
    if (b.subarray(1).toString('ascii') !== 'CD001') throw error('Arquivo não possui cabeçalho ISO9660. Não será montado.');
  } finally { await handle.close(); }
  return stat.size;
}
class GameInstaller {
  constructor(directory) {
    this.directory = directory;
    this.iso = path.join(directory, 'game.iso');
    this.archive = path.join(directory, 'download.part');
    this.partialISO = path.join(directory, 'game.iso.part');
    this.state = { phase: 'idle', message: 'Jogo não instalado.', downloaded: 0, total: 0, extracted: 0, isoSize: 0 };
    this.task = null;
    this.ready = this.initialize().catch(e => {
      this.set({ phase: 'error', message: `Armazenamento indisponível: ${e.message}` });
    });
  }
  async initialize() {
    await fsp.mkdir(this.directory, { recursive: true });
    // After an interrupted process, partial files are not mistaken for installed games.
    await Promise.all([this.archive, this.partialISO].map(f => fsp.rm(f, { force: true })));
    try {
      const size = await validateISO(this.iso);
      this.set({ phase: 'ready', isoSize: size, message: 'ISO instalada; pronta para iniciar.' });
    } catch { /* No valid installed ISO. Never auto-download at startup. */ }
  }
  set(values) { Object.assign(this.state, values); }
  status() { return { ...this.state, busy: busy(this.state.phase) }; }
  async start(direct = '', password = '') {
    await this.ready;
    if (this.task || busy(this.state.phase)) throw error('Já existe uma instalação em andamento.', 409);
    if (this.state.phase === 'ready') return this.status();
    if (direct) allowedURL(direct);
    this.controller = new AbortController();
    this.set({ phase: 'resolving', message: 'Localizando link de download…', downloaded: 0, total: 0, extracted: 0, isoSize: 0 });
    this.task = this.install(direct, password).catch(e => {
      this.set({ phase: this.cancelled ? 'cancelled' : 'error', message: this.cancelled ? 'Instalação cancelada.' :
        (e.code === 'ENOSPC' ? 'Sem espaço em disco para instalar.' : e.message || 'Falha na instalação.') });
    }).finally(() => { this.task = null; this.controller = null; this.cancelled = false; });
    return this.status();
  }
  cancel() {
    if (this.controller) {
      this.cancelled = true;
      this.set({ phase: 'cancelling', message: 'Cancelando e removendo arquivos parciais…' });
      this.controller.abort();
    }
    return this.status();
  }
  async install(direct, password) {
    const signal = this.controller.signal;
    const timeout = setTimeout(() => this.controller?.abort(), 4 * 60 * 60 * 1000);
    let idle;
    const pulse = () => { clearTimeout(idle); idle = setTimeout(() => this.controller?.abort(), 90000); };
    try {
      pulse();
      const source = await resolveSource(direct);
      const expected = source === GAME.url ? GAME : null;
      const digest = expected ? createHash('sha1') : null;
      const r = await remote(source, signal);
      if (!r.ok || r.status !== 200) {
        await r.body?.cancel();
        throw error(`Download recusado pela origem (HTTP ${r.status}). O link pode estar expirado ou restrito ao IP/sessão. Não será tentado contornar o bloqueio.`, 502);
      }
      const length = Number(r.headers.get('content-length')) || 0;
      if (!Number.isSafeInteger(length) || length < 0 ||
          !['identity', null].includes(r.headers.get('content-encoding'))) {
        await r.body?.cancel(); throw error('Cabeçalhos de tamanho/codificação inválidos na origem.');
      }
      const isISO = /\.iso$/i.test(new URL(source).pathname);
      const max = isISO ? MAX_ISO : MAX_ARCHIVE;
      if (length > max || /text\/html|application\/json/i.test(r.headers.get('content-type') || '')) {
        await r.body?.cancel(); throw error('A origem não retornou um pacote binário válido ou excedeu o limite.');
      }
      const disk = await fsp.statfs(this.directory);
      const reserve = (length || max) + (isISO ? 0 : MAX_ISO) + 512 * 1024 * 1024;
      if (disk.bavail * disk.bsize < reserve) {
        await r.body?.cancel(); throw error(`Espaço insuficiente. Reserve aproximadamente ${(reserve / GiB).toFixed(1)} GiB livres para baixar e extrair com segurança.`);
      }
      this.set({ phase: 'downloading', total: length, message: 'Baixando para o disco do servidor; nenhum buffer integral na RAM.' });
      await pipeline(Readable.fromWeb(r.body), limitStream(max, (n, chunk) => { pulse(); digest?.update(chunk); this.set({ downloaded: n }); }),
        fs.createWriteStream(isISO ? this.partialISO : this.archive, { flags: 'wx' }), { signal });
      if (length && this.state.downloaded !== length) throw error('Download incompleto. Tente novamente.');
      if (expected && (this.state.downloaded !== expected.size || digest.digest('hex') !== expected.sha1))
        throw error('Tamanho ou SHA-1 diferente do metadado do Archive. A ISO não será instalada.');
      if (!isISO) {
        const executable = sevenZip();
        const entry = await listISO(executable, this.archive, password, signal);
        this.set({ phase: 'extracting', isoSize: entry.size, message: 'Extraindo somente a ISO para disco…' });
        pulse();
        // Only stdout is written to a fixed destination. Archive paths cannot escape it.
        const child = spawn(executable, ['x', '-so', '-y', '-spd', '-p' + password, '--', this.archive, entry.name],
          { signal, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const finished = completion(child);
        try {
          await pipeline(child.stdout, limitStream(entry.size, n => { pulse(); this.set({ extracted: n }); }),
            fs.createWriteStream(this.partialISO, { flags: 'wx' }), { signal });
          const result = await finished;
          if (result.err || result.code !== 0 || this.state.extracted !== entry.size)
            throw error('Extração falhou: senha, integridade CRC ou formato inválido.');
        } finally { if (child.exitCode === null) child.kill('SIGKILL'); await finished; }
      }
      this.set({ phase: 'validating', message: 'Validando ISO antes de disponibilizar ao núcleo…' });
      const size = await validateISO(this.partialISO);
      signal.throwIfAborted();
      await fsp.rename(this.partialISO, this.iso);
      this.set({ phase: 'ready', isoSize: size, message: 'ISO instalada. Pronta para iniciar Play!.' });
    } catch (e) {
      if (signal.aborted && !this.cancelled) throw error('Timeout ou ausência de progresso na instalação. Tente novamente.');
      throw e;
    } finally {
      clearTimeout(timeout); clearTimeout(idle);
      await Promise.all([this.archive, this.partialISO].map(f => fsp.rm(f, { force: true }).catch(() => {})));
    }
  }
}
function router(directory) {
  const router = require('express').Router();
  const installer = new GameInstaller(directory);
  router.use(require('express').json({ limit: '12kb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = fn => async (req, res, next) => {
    try {
      // Browser-only mutation routes: prevents cross-site pages triggering multi-GB downloads.
      if (req.get('Sec-Fetch-Site') !== 'same-origin' || !req.is('application/json'))
        throw error('Ação permitida somente pelo painel de mesma origem.', 403);
      res.json(await fn(req));
    } catch (e) { next(e); }
  };
  router.get('/config', (req, res) => res.json(GAME));
  router.get('/status', async (req, res, next) => { try { await installer.ready; res.json(installer.status()); } catch (e) { next(e); } });
  router.post('/install', action(req => {
    const direct = req.body?.url || '', password = req.body?.password ?? '';
    if (typeof direct !== 'string' || direct.length > 8192 || typeof password !== 'string' || password.length > 128)
      throw error('Link ou senha inválidos.');
    return installer.start(direct.trim(), password);
  }));
  router.post('/cancel', action(() => installer.cancel()));
  router.get('/disc', async (req, res, next) => {
    try { await installer.ready; if (installer.state.phase !== 'ready') throw error('Jogo não instalado.', 409);
      res.json({ size: installer.state.isoSize, sectorSize: 2048, maxChunk: 2 * 1024 * 1024 });
    } catch (e) { next(e); }
  });
  router.get('/stream', async (req, res, next) => {
    try {
      await installer.ready;
      if (installer.state.phase !== 'ready') throw error('Jogo não instalado.', 409);
      const size = installer.state.isoSize;
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!m) throw error('Use um Range fechado.');
      const start = Number(m[1]), requestedEnd = Number(m[2]);
      if (![start, requestedEnd].every(Number.isSafeInteger) || start < 0 || start >= size || requestedEnd < start || requestedEnd - start + 1 > 2 * 1024 * 1024) {
        res.set('Content-Range', `bytes */${size}`); throw error('Range inválido.', 416);
      }
      const end = Math.min(requestedEnd, size - 1);
      res.status(206).set({ 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1), 'Content-Type': 'application/octet-stream' });
      await pipeline(fs.createReadStream(installer.iso, { start, end, highWaterMark: 64 * 1024 }), res);
    } catch (e) { if (res.headersSent) res.destroy(); else next(e); }
  });
  router.use((e, req, res, next) => { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message || 'Falha no instalador.' }); });
  return router;
}
module.exports = { router, GameInstaller, validateISO, allowedURL, listISO, sevenZip };
