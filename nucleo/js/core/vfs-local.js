/**
 * NÚCLEO OS — core/vfs-local.js
 * VFS volátil em memória: o MESMO contrato público de `createVFS(link)`, sem worker,
 * sem OPFS e sem barramento.
 *
 * Por que existe: em contextos restritos (iframe com origem opaca, storage de
 * terceiros bloqueado, política que impede Web Workers) o modo normal não pode
 * montar o disco. Antes de falhar, o sistema cai para cá — o desktop continua
 * utilizável e a interface declara, sem rodeios, que o armazenamento é volátil.
 *
 * Contrato idêntico ao de `core/vfs.js` (troca transparente):
 *   init() · list(path) · read(path) · write(path, data) · stat(path) · mkdir(path)
 *   remove(path) · rename(from, to) · bench() · usage() · journal() · info
 *
 * Nada aqui finge persistência: `backend` é sempre 'memória volátil (modo local)'
 * e `quotaMb` fica NaN (não há cota do navegador envolvida).
 */

import { safePath, baseName } from './util.js';

const BLOCK = 32 * 1024;

export function createLocalVFS({ log = () => {}, root = '/' } = {}) {
  /** índice: path absoluto → { type: 'file'|'dir', size, mtime } */
  const index = new Map();
  /** conteúdo dos arquivos: path absoluto → Uint8Array */
  const files = new Map();
  const SEED_DIRS = ['/', '/home', '/home/nucleo', '/etc', '/var', '/var/nucleo', '/mnt'];
  const SEED_FILES = {
    '/etc/hostname': 'nucleo\n',
    '/etc/motd': 'NÚCLEO OS — modo local.\nArmazenamento volátil: nada aqui sobrevive a um recarregamento.\n',
    '/home/nucleo/leia-me.txt': 'Este disco virtual está em memória porque o contexto atual não permite OPFS com worker.\n'
  };

  const info = {
    backend: 'memória volátil (modo local)',
    sync: false,
    quotaMb: NaN,
    usedMb: NaN,
    persisted: false
  };

  const parentOf = path => {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  };

  function markDir(path) {
    if (!index.has(path)) index.set(path, { type: 'dir', size: 0, mtime: Date.now() });
  }

  function seed() {
    index.clear();
    files.clear();
    for (const dir of SEED_DIRS) markDir(dir);
    for (const [path, text] of Object.entries(SEED_FILES)) {
      const bytes = new TextEncoder().encode(text);
      files.set(path, bytes);
      index.set(path, { type: 'file', size: bytes.length, mtime: Date.now() });
      markDir(parentOf(path));
    }
    markDir(root === '/' ? '/' : root);
  }

  /** Sobe a árvore criando os diretórios pais que faltarem. */
  function ensureParents(path) {
    let dir = parentOf(path);
    const chain = [];
    while (dir && dir !== '/' && !index.has(dir)) { chain.push(dir); dir = parentOf(dir); }
    for (let i = chain.length - 1; i >= 0; i--) markDir(chain[i]);
    markDir('/');
  }

  function entryOf(path) {
    const meta = index.get(path);
    if (!meta) throw new Error(`caminho inexistente: ${path}`);
    return meta;
  }

  function listDir(path) {
    const prefix = path === '/' ? '/' : `${path}/`;
    const out = [];
    for (const [p, meta] of index) {
      if (!p.startsWith(prefix) || p === path) continue;
      if (p.slice(prefix.length).includes('/')) continue;
      out.push({ name: p.slice(prefix.length), type: meta.type, size: meta.size, mtime: meta.mtime });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  function bytesUsed() {
    let total = 0;
    for (const meta of index.values()) if (meta.type === 'file') total += meta.size || 0;
    return total;
  }

  async function init() {
    seed();
    log(`VMFS local: ${info.backend}`);
    return { ...info };
  }

  async function list(path = '/') {
    const p = safePath(path);
    const meta = index.get(p);
    if (!meta) throw new Error(`caminho inexistente: ${p}`);
    if (meta.type !== 'dir') throw new Error(`não é diretório: ${p}`);
    return listDir(p);
  }

  async function stat(path) {
    const p = safePath(path);
    return { ...entryOf(p), path: p, name: baseName(p) };
  }

  async function read(path) {
    const p = safePath(path);
    const meta = entryOf(p);
    if (meta.type !== 'file') throw new Error(`não é arquivo: ${p}`);
    const bytes = files.get(p) || new Uint8Array(0);
    return bytes.slice();   // cópia: o chamador não pode mutar o "disco"
  }

  async function write(path, data) {
    const p = safePath(path);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    ensureParents(p);
    files.set(p, bytes);
    index.set(p, { type: 'file', size: bytes.length, mtime: Date.now() });
    return { path: p, size: bytes.length };
  }

  async function mkdir(path) {
    const p = safePath(path);
    if (index.has(p)) throw new Error('já existe');
    ensureParents(p);
    markDir(p);
    return { path: p };
  }

  async function remove(path) {
    const p = safePath(path);
    const meta = entryOf(p);
    if (meta.type === 'dir' && listDir(p).length) throw new Error('diretório não está vazio');
    if (meta.type === 'dir') index.delete(p);
    files.delete(p);
    index.delete(p);
    return { path: p };
  }

  async function rename(from, to) {
    const a = safePath(from);
    const b = safePath(to);
    const meta = entryOf(a);
    if (index.has(b)) throw new Error('destino já existe');
    ensureParents(b);
    index.set(b, { ...meta, mtime: Date.now() });
    if (meta.type === 'file') {
      files.set(b, files.get(a) || new Uint8Array(0));
      files.delete(a);
    } else {
      // move a subárvore no índice (o caminho do diretório é a chave)
      for (const [p, m] of [...index]) {
        if (p.startsWith(`${a}/`)) { index.set(b + p.slice(a.length), m); index.delete(p); }
      }
    }
    index.delete(a);
    return { from: a, to: b };
  }

  /** Mesma forma do worker de I/O, medindo memória: honestidade acima de vaidade. */
  async function bench() {
    const size = 1024 * 1024;
    const chunk = BLOCK;
    const payload = new Uint8Array(chunk).fill(0x5a);
    const path = '/var/nucleo/bench.bin';

    const t0 = performance.now();
    const buf = new Uint8Array(size);
    for (let off = 0; off < size; off += chunk) buf.set(payload, off);
    await write(path, buf);
    const t1 = performance.now();
    const back = await read(path);
    const t2 = performance.now();

    const writeMs = t1 - t0;
    const readMs = t2 - t1;
    return {
      backend: info.backend, sync: false, bytes: size, readBytes: back.length, writeMs, readMs,
      writeMbps: size / 1048576 / Math.max(writeMs / 1000, 1e-6),
      readMbps: size / 1048576 / Math.max(readMs / 1000, 1e-6)
    };
  }

  async function usage() {
    let count = 0;
    for (const meta of index.values()) if (meta.type === 'file') count++;
    return {
      backend: info.backend,
      files: count,
      usedBytes: bytesUsed(),
      quotaBytes: NaN,          // não há cota do navegador: NaN, nunca um número inventado
      persisted: false
    };
  }

  async function journal() {
    return { backend: info.backend, sync: false, journalBytes: 0, supported: false };
  }

  async function dispose() { /* nada a liberar: tudo em memória */ }

  return { init, list, read, write, stat, mkdir, remove, rename, bench, usage, journal, dispose, info, BLOCK };
}
