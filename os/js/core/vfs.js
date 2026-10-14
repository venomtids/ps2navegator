/**
 * SECTOR OS — core/vfs.js
 * VMFS: sistema de arquivos virtual do PC. O *dono* do armazenamento é o worker
 * `w-io` (OPFS com SyncAccessHandle / IndexedDB / memória volátil como fallback).
 * Este módulo é o cliente: cache de índice, validação de caminho e API tipada.
 * A thread principal nunca abre arquivo grande — só pede blocos.
 */

import { OP } from './ipc.js';
import { writeBlockReq } from './wire.js';
import { safePath, dirName, baseName } from './util.js';

export const BLOCK = 32 * 1024; // cabe com folga no anel de 64 KiB

export function createVFS(link, { log = () => {} } = {}) {
  let nextBlockId = 1;
  const cache = new Map();          // caminho -> {type,size,mtime}
  let info = { backend: 'desconhecido', quotaMb: NaN, usedMb: NaN, sync: false };

  async function init() {
    const res = await link.request(OP.FS_OP, { op: 'init' }, OP.FS_RES, 15000);
    if (!res.ok) throw new Error(res.error || 'falha ao iniciar o armazenamento');
    const d = res.data || {};
    info = {
      backend: d.backend || 'desconhecido',
      sync: Boolean(d.sync),
      quotaMb: Number.isFinite(d.quotaBytes) ? d.quotaBytes / 1048576 : NaN,
      usedMb: Number.isFinite(d.usedBytes) ? d.usedBytes / 1048576 : NaN,
      persisted: Boolean(d.persisted)
    };
    log(`VMFS pronto · backend=${info.backend}${info.sync ? ' (sync)' : ''}`);
    return info;
  }

  async function call(op, args = {}, timeout) {
    const res = await link.request(OP.FS_OP, { op, ...args }, OP.FS_RES, timeout);
    if (!res.ok) throw new Error(res.error || `operação ${op} falhou`);
    return res.data;
  }

  async function refresh(path) {
    const p = safePath(path);
    const rows = await call('list', { path: p });
    for (const row of rows) cache.set(`${p === '/' ? '' : p}/${row.name}`, row);
    return rows;
  }

  /** Abre sessão, opera em blocos de 32 KiB, fecha. Serializado por sessão única. */
  async function read(path) {
    const p = safePath(path);
    let session = null;
    try {
      session = await call('open', { path: p, mode: 'r' });
      const out = new Uint8Array(session.size);
      for (let off = 0; off < session.size; off += BLOCK) {
        const len = Math.min(BLOCK, session.size - off);
        const req = new Uint8Array(16);
        writeBlockReq(req, nextBlockId, off, len);
        const chunk = await link.readBlock(nextBlockId, req);
        nextBlockId = (nextBlockId + 1) >>> 0;
        if (chunk.length !== len) throw new Error(`bloco curto em ${p} (${chunk.length}/${len})`);
        out.set(chunk, off);
      }
      return out;
    } finally {
      if (session) await call('close', {}).catch(() => {});
    }
  }

  async function write(path, data) {
    const p = safePath(path);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let session = null;
    try {
      session = await call('open', { path: p, mode: 'w', size: bytes.length });
      for (let off = 0; off < bytes.length; off += BLOCK) {
        const slice = bytes.subarray(off, Math.min(off + BLOCK, bytes.length));
        const payload = new Uint8Array(16 + slice.length);
        writeBlockReq(payload, nextBlockId, off, slice.length);
        payload.set(slice, 16);
        await link.writeBlock(nextBlockId, payload);
        nextBlockId = (nextBlockId + 1) >>> 0;
      }
      return await call('close', {});
    } catch (e) {
      if (session) await call('close', {}).catch(() => {});
      throw e;
    }
  }

  const list = path => refresh(path);
  const stat = path => call('stat', { path: safePath(path) });
  const mkdir = path => call('mkdir', { path: safePath(path) });
  const remove = path => call('remove', { path: safePath(path) });
  const rename = (from, to) => call('rename', { from: safePath(from), to: safePath(to) });
  const bench = () => call('bench', {}, 20000);
  const usage = () => call('usage', {});

  /** Fecha o arquivo em escrita e devolve os bytes da página de journal se houver. */
  const journal = () => call('journal');

  return { init, list, read, write, stat, mkdir, remove, rename, bench, usage, journal,
    get info() { return info; }, get cached() { return cache; }, path: { safePath, dirName, baseName } };
}
