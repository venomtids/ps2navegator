/**
 * NÚCLEO OS — core/vfs.js
 * VMFS: sistema de arquivos virtual do PC. O *dono* do armazenamento é o worker
 * `w-io` (OPFS com SyncAccessHandle / IndexedDB / memória volátil como fallback).
 * Este módulo é o cliente: cache de índice, validação de caminho e API tipada.
 * A thread principal nunca abre arquivo grande — só pede blocos.
 */

import { OP } from './ipc.js';
import { writeBlockReq } from './wire.js';
import { safePath, dirName, baseName } from './util.js';

export const BLOCK = 32 * 1024; // cabe com folga no anel de 64 KiB
/** Teto de uma leitura por faixa (o emulador de PS2 lê em blocos de 1 MiB). */
export const MAX_FAIXA = 1 << 20;

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

  /**
   * Leitura por FAIXA, para leitores de grande porte — o caso que existe hoje é o
   * leitor de setores do emulador de PS2, que monta uma ISO de vários GB sem
   * carregá-la na memória.
   *
   * Abre e fecha a sessão a cada chamada porque o worker `w-io` atende uma sessão
   * por vez: reter a sessão durante o jogo travaria terminal, arquivos e o próprio
   * instalador. Uma faixa é entregue em blocos de 32 KiB (o mesmo teto do resto do
   * VMFS, dimensionado para o anel de 64 KiB) e faixas fora do arquivo são
   * truncadas — quem chama decide se o tamanho curto é erro (o leitor de disco
   * decide, e reclama: `core/disc.js`).
   */
  async function readRange(path, offset, length) {
    const p = safePath(path);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('faixa com offset inválido');
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('faixa com tamanho inválido');
    if (length > MAX_FAIXA) throw new Error(`faixa de ${length} bytes acima do teto de ${MAX_FAIXA}`);
    let session = null;
    try {
      session = await call('open', { path: p, mode: 'r' });
      const inicio = Math.min(offset, session.size);
      const fim = Math.min(offset + length, session.size);
      const out = new Uint8Array(Math.max(0, fim - inicio));
      for (let off = 0; off < out.length; off += BLOCK) {
        const len = Math.min(BLOCK, out.length - off);
        const req = new Uint8Array(16);
        writeBlockReq(req, nextBlockId, inicio + off, len);
        const chunk = await link.readBlock(nextBlockId, req);
        nextBlockId = (nextBlockId + 1) >>> 0;
        if (chunk.length !== len) throw new Error(`faixa curta em ${p} (${chunk.length}/${len})`);
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

  return { init, list, read, readRange, write, stat, mkdir, remove, rename, bench, usage, journal,
    get info() { return info; }, get cached() { return cache; }, path: { safePath, dirName, baseName } };
}
