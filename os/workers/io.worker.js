/**
 * SECTOR OS — workers/io.worker.js
 * Dono único do armazenamento (docs/00 §9.2). Só este worker abre arquivos.
 *
 * Backends, do melhor para o possível:
 *   1. OPFS + SyncAccessHandle   (síncrono, exclusivo de worker)
 *   2. OPFS + createWritable     (assíncrono, mesmo original)
 *   3. memória volátil           (a UI mostra DISCO: VOLÁTIL)
 *
 * Protocolo de sessão (explícito, sem ambiguidade):
 *   FS_OP  {op:'open', path, mode:'r'|'w', size?}   abre sessão única
 *   BLK_*  binário (u32 id, u64 offset, u32 len)    opera na sessão aberta
 *   FS_OP  {op:'close'}                             fecha, faz flush e indexa
 * Metadados (list/stat/mkdir/...) são JSON: ≤ 10 Hz, custo irrelevante.
 */

import { OP } from './../js/core/ipc.js';
import { acceptWorkerLink } from './../js/core/link.js';
import { readBlockReq } from './../js/core/wire.js';

const DIR = 'vmfs';
const INDEX_FILE = '__index.json';
const SEEDS = {
  '/etc/os-release': 'NAME="SECTOR OS"\nID=sector\nVERSION="0.4.0 (sim)"\nPRETTY_NAME="SECTOR OS 0.4.0 (runtime Linux: fase F4)"\n',
  '/etc/hostname': 'vpc\n',
  '/home/sector/LEIA-ME.txt': 'Este disco é real: os arquivos vivem no OPFS do navegador.\n'
    + 'O runtime Linux do guest entra na fase F4; o VMFS já é o disco do PC virtual.\n',
  '/var/sector/mundo/manifesto.txt': 'células do mundo: nenhuma gerada ainda (fase F3)\n'
};

const state = {
  backend: 'memória volátil', sync: false,
  index: new Map(), memory: new Map(), opfsRoot: null,
  session: null, ioMs: 0, ioMbps: 0, ops: 0,
  quotaBytes: NaN, usedBytes: NaN, persisted: false
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const encName = p => encodeURIComponent(p);
const parentOf = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };

function idx(path, type, size) {
  state.index.set(path, { type, size, mtime: Date.now() });
  const par = parentOf(path);
  if (par && par !== path && !state.index.has(par)) idx(par, 'dir', 0);
}
function listDir(path) {
  const out = [];
  const prefix = path === '/' ? '/' : path + '/';
  for (const [p, meta] of state.index) {
    if (!p.startsWith(prefix) || p === path) continue;
    if (p.slice(prefix.length).includes('/')) continue;
    out.push({ name: p.slice(prefix.length), type: meta.type, size: meta.size, mtime: meta.mtime });
  }
  return out;
}

async function atomicWrite(path, bytes) {
  if (!state.opfsRoot) { state.memory.set(path, bytes.slice()); return; }
  const handle = await state.opfsRoot.getFileHandle(encName(path), { create: true });
  if (state.sync) {
    const sh = await handle.createSyncAccessHandle();
    sh.truncate(0);
    if (bytes.length) sh.write(bytes, { at: 0 });
    sh.flush();
    sh.close();
  } else {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  }
}

async function persistIndex() {
  if (!state.opfsRoot) return;
  try { await atomicWrite(INDEX_FILE, enc.encode(JSON.stringify([...state.index]))); }
  catch { /* índice é cache; a perda não corrompe dados */ }
}

async function initStorage() {
  try {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS ausente');
    const root = await navigator.storage.getDirectory();
    state.opfsRoot = await root.getDirectoryHandle(DIR, { create: true });
    try {                                    // sonda de SyncAccessHandle
      const probe = await state.opfsRoot.getFileHandle('__probe', { create: true });
      (await probe.createSyncAccessHandle()).close();
      state.sync = true;
      state.backend = 'OPFS';
    } catch { state.sync = false; state.backend = 'OPFS (assíncrono)'; }

    let restored = 0;
    try {
      const f = await (await state.opfsRoot.getFileHandle(INDEX_FILE)).getFile();
      for (const [p, meta] of JSON.parse(await f.text())) { state.index.set(p, meta); restored++; }
    } catch { restored = 0; }

    for (const [path, text] of Object.entries(SEEDS)) {
      if (restored && state.index.has(path)) continue;
      await atomicWrite(path, enc.encode(text));
      idx(path, 'file', text.length);
    }
    await persistIndex();
  } catch {
    state.backend = 'memória volátil';
    for (const [path, text] of Object.entries(SEEDS)) {
      state.memory.set(path, enc.encode(text));
      idx(path, 'file', text.length);
    }
  }
  for (const dir of ['/', '/home', '/home/sector', '/etc', '/var', '/var/sector']) idx(dir, 'dir', 0);
  await refreshQuota();
}

async function refreshQuota() {
  try {
    const est = await navigator.storage.estimate();
    state.quotaBytes = est.quota ?? NaN;
    state.usedBytes = est.usage ?? NaN;
    state.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  } catch { /* sem estimate(): o HUD mostra N/D em vez de estimar */ }
}

// ---------------------------------------------------------------- sessões --
async function openSession({ path, mode, size = 0 }) {
  if (state.session) throw new Error('já existe sessão de I/O aberta');
  const meta = state.index.get(path);
  if (mode === 'r') {
    if (!meta || meta.type !== 'file') throw new Error(`${path}: arquivo inexistente`);
    const session = { path, mode, size: meta.size, handle: null, buf: null, chunks: 0, t0: performance.now() };
    if (state.opfsRoot && state.sync) {
      const h = await state.opfsRoot.getFileHandle(encName(path));
      session.handle = await h.createSyncAccessHandle();
      session.size = session.handle.getSize();
    }
    state.session = session;
    return { path, mode, size: session.size };
  }
  const session = { path, mode: 'w', size, handle: null, buf: null, chunks: 0, t0: performance.now() };
  if (state.opfsRoot && state.sync) {
    const h = await state.opfsRoot.getFileHandle(encName(path), { create: true });
    session.handle = await h.createSyncAccessHandle();
    session.handle.truncate(0);
  } else {
    session.buf = new Uint8Array(size);
  }
  state.session = session;
  return { path, mode: 'w', size };
}

async function closeSession() {
  const s = state.session;
  if (!s) throw new Error('nenhuma sessão de I/O aberta');
  state.session = null;
  try {
    if (s.mode === 'r') {
      s.handle?.close();
      return { path: s.path, mode: 'r', bytes: s.size, ms: performance.now() - s.t0 };
    }
    if (s.handle) { s.handle.flush(); s.handle.close(); }
    else await atomicWrite(s.path, s.buf);
    idx(s.path, 'file', s.size);
    await persistIndex();
    return { path: s.path, mode: 'w', bytes: s.size, ms: performance.now() - s.t0 };
  } catch (e) {
    // Nunca deixamos handle aberto vazando por causa de um erro no meio.
    try { s.handle?.close(); } catch { /* já fechado */ }
    throw e;
  }
}

async function blockRead(view, len) {
  const s = state.session;
  if (!s || s.mode !== 'r') throw new Error('BLK_READ sem sessão de leitura');
  const { id, offset, len: n } = readBlockReq(view);
  let bytes;
  if (s.handle) {
    const end = Math.min(offset + n, s.size);
    const out = new Uint8Array(Math.max(0, end - offset));
    if (out.length) s.handle.read(out, { at: offset });
    bytes = out;
  } else if (state.opfsRoot) {
    const f = await (await state.opfsRoot.getFileHandle(encName(s.path))).getFile();
    bytes = new Uint8Array(await f.slice(offset, offset + n).arrayBuffer());
  } else {
    const data = state.memory.get(s.path);
    if (!data) throw new Error(`${s.path}: não existe`);
    bytes = data.subarray(offset, offset + n);
  }
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, id, true);
  out.set(bytes, 4);
  return { id, out, bytes: bytes.length };
}

function blockWrite(view) {
  const s = state.session;
  if (!s || s.mode !== 'w') throw new Error('BLK_WRITE sem sessão de escrita');
  const { id, offset, len } = readBlockReq(view);
  const payload = view.subarray(16, 16 + len);
  if (s.handle) s.handle.write(payload, { at: offset });
  else s.buf.set(payload, offset);
  s.chunks++;
  return { id, bytes: len };
}

async function bench() {
  const size = 1024 * 1024, chunk = 32 * 1024;
  const buf = new Uint8Array(chunk);
  for (let i = 0; i < chunk; i++) buf[i] = (i * 31) & 0xff;
  const path = '/var/sector/bench.bin';

  const t0 = performance.now();
  await openSession({ path, mode: 'w', size });
  for (let off = 0; off < size; off += chunk) {
    const frame = new Uint8Array(16 + chunk);
    new DataView(frame.buffer).setUint32(0, 1, true);
    new DataView(frame.buffer).setBigUint64(4, BigInt(off), true);
    new DataView(frame.buffer).setUint32(12, chunk, true);
    frame.set(buf, 16);
    blockWrite(frame);
  }
  await closeSession();
  const t1 = performance.now();

  let total = 0;
  await openSession({ path, mode: 'r' });
  for (let off = 0; off < size; off += chunk) {
    const frame = new Uint8Array(16);
    new DataView(frame.buffer).setUint32(0, 2, true);
    new DataView(frame.buffer).setBigUint64(4, BigInt(off), true);
    new DataView(frame.buffer).setUint32(12, chunk, true);
    total += (await blockRead(frame, 16)).bytes;
  }
  await closeSession();
  const t2 = performance.now();
  const writeMs = t1 - t0, readMs = t2 - t1;
  return {
    backend: state.backend, sync: state.sync, bytes: size, readBytes: total, writeMs, readMs,
    writeMbps: size / 1048576 / (writeMs / 1000), readMbps: size / 1048576 / (readMs / 1000)
  };
}

// -------------------------------------------------------------- despacho ---
let chain = Promise.resolve();
const serial = fn => { chain = chain.then(fn).catch(e => { console.error('[io]', e); }); return chain; };

async function fsOp(msg, link) {
  const t0 = performance.now();
  try {
    let data;
    switch (msg.op) {
      case 'init': data = { backend: state.backend, sync: state.sync, quotaBytes: state.quotaBytes, usedBytes: state.usedBytes, persisted: state.persisted }; break;
      case 'list': data = listDir(msg.path); break;
      case 'stat': {
        const meta = state.index.get(msg.path);
        if (!meta) throw new Error('caminho inexistente');
        data = { ...meta, path: msg.path };
        break;
      }
      case 'mkdir':
        if (state.index.has(msg.path)) throw new Error('já existe');
        idx(msg.path, 'dir', 0); await persistIndex(); data = { path: msg.path };
        break;
      case 'remove': {
        const meta = state.index.get(msg.path);
        if (!meta) throw new Error('caminho inexistente');
        if (meta.type === 'dir' && listDir(msg.path).length) throw new Error('diretório não está vazio');
        if (state.opfsRoot) await state.opfsRoot.removeEntry(encName(msg.path), { recursive: meta.type === 'dir' }).catch(() => {});
        state.memory.delete(msg.path);
        state.index.delete(msg.path);
        await persistIndex();
        data = { path: msg.path };
        break;
      }
      case 'rename': {
        const meta = state.index.get(msg.from);
        if (!meta) throw new Error('origem inexistente');
        if (state.index.has(msg.to)) throw new Error('destino já existe');
        if (meta.type === 'file') await atomicWrite(msg.to, await readAll(msg.from));
        else if (state.opfsRoot) await state.opfsRoot.getDirectoryHandle(encName(msg.to), { create: true });
        if (state.opfsRoot) await state.opfsRoot.removeEntry(encName(msg.from), { recursive: meta.type === 'dir' }).catch(() => {});
        state.memory.delete(msg.from);
        state.index.delete(msg.from);
        idx(msg.to, meta.type, meta.size);
        await persistIndex();
        data = { from: msg.from, to: msg.to };
        break;
      }
      case 'open': data = await openSession(msg); break;
      case 'close': data = await closeSession(); break;
      case 'bench': data = await bench(); break;
      case 'usage': {
        await refreshQuota();
        const files = [...state.index.values()].filter(v => v.type === 'file');
        data = {
          backend: state.backend, files: files.length,
          usedBytes: Number.isFinite(state.usedBytes) ? state.usedBytes : files.reduce((a, v) => a + (v.size || 0), 0),
          quotaBytes: state.quotaBytes, persisted: state.persisted
        };
        break;
      }
      default: throw new Error(`operação desconhecida: ${msg.op}`);
    }
    link.send(OP.FS_RES, JSON.stringify({ id: msg.id, ok: true, data }));
  } catch (e) {
    link.send(OP.FS_RES, JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e) }));
  } finally {
    state.ioMs = state.ioMs * 0.8 + (performance.now() - t0) * 0.2;
    state.ops++;
  }
}

async function readAll(path) {
  await openSession({ path, mode: 'r' });
  const s = state.session;
  const frame = new Uint8Array(16);
  new DataView(frame.buffer).setUint32(0, 1, true);
  new DataView(frame.buffer).setBigUint64(4, 0n, true);
  new DataView(frame.buffer).setUint32(12, s.size, true);
  const { bytes } = await blockRead(frame, 16);
  await closeSession();
  return bytes;
}

// ------------------------------------------------------------------ boot ---
initStorage().then(info => console.info(`[w-io] backend=${state.backend} sync=${state.sync}`));

acceptWorkerLink(self, {
  onReady(link) {
    link.on(OP.FS_OP, (view, len) => {
      const msg = JSON.parse(dec.decode(view.subarray(0, len)));
      serial(() => fsOp(msg, link));
    });
    link.on(OP.BLK_READ, (view, len) => {
      // Copia obrigatória: a scratch view é reutilizada na próxima leitura.
      const copy = view.slice(0, len);
      serial(async () => {
        const t0 = performance.now();
        try {
          const { id, out, bytes } = await blockRead(copy, len);
          link.send(OP.BLK_DATA, out);
          state.ioMbps = state.ioMbps * 0.8 + (bytes / 1048576) / Math.max((performance.now() - t0) / 1000, 1e-6) * 0.2;
        } catch (e) {
          link.send(OP.FS_RES, JSON.stringify({ id: readBlockReq(copy).id, ok: false, error: String(e.message || e) }));
        }
      });
    });
    link.on(OP.BLK_WRITE, (view, len) => {
      const copy = view.slice(0, len);
      serial(() => {
        try {
          const { id, bytes } = blockWrite(copy);
          const ack = new Uint8Array(4);
          new DataView(ack.buffer).setUint32(0, id, true);
          link.send(OP.BLK_WRITE, ack);
          state.ioMbps = state.ioMbps * 0.8 + (bytes / 1048576) * 8 * 0.2;
        } catch (e) {
          link.send(OP.FS_RES, JSON.stringify({ id: readBlockReq(copy).id, ok: false, error: String(e.message || e) }));
        }
      });
    });
    // Laço de bombeamento do anel. Sem ele o worker nunca consumiria os pedidos
    // de FS nem os blocos — os promises do VFS ficariam pendurados para sempre.
    link.reader.pump().catch(e => console.error('[io] pump', e));

    // Slots de estatística deste worker: 0=ioMs 1=MB/s 2=ops 3=arquivos
    link.on(OP.STAT_REQ, () => {
      const buf = new ArrayBuffer(4 + 16 * 4);
      const dv = new DataView(buf);
      dv.setUint16(2, 16, true);
      [state.ioMs, state.ioMbps, state.ops, state.index.size].forEach((v, i) => dv.setFloat32(4 + i * 4, v, true));
      link.send(OP.STAT, new Uint8Array(buf));
    });
    return () => { link.reader.close(); };
  }
});
