/**
 * NÚCLEO OS — core/wire.js
 * Formato binário das mensagens de telemetria e de tick (docs/00 §3.2).
 * Escolha consciente: o caminho quente (tick) usa struct binário de tamanho fixo
 * e a leitura escreve em objeto reutilizado — zero alocação por quadro.
 * Metadados de sistema de arquivos (≤ 10 Hz) usam JSON, e isso está documentado
 * em vez de escondido.
 */

export const STAT_SLOTS = 16;

/** Índice canônico das métricas. Mudar isto é mudar o HUD. */
export const S = Object.freeze({
  FRAME_MS: 0, FRAME_P95: 1, FPS: 2, SIM_MS: 3,
  AI_MS: 4, KERNEL_MS: 5, IO_MS: 6, IO_MBPS: 7,
  ENTITIES: 8, HEAP_MB: 9, DISK_MB: 10, DISK_QUOTA_MB: 11,
  TICKS: 12, TICK_MAX_MS: 13, EXTRA_A: 14, EXTRA_B: 15
});

export const emptyStats = () => new Float32Array(STAT_SLOTS).fill(NaN);

/** Empacota estatísticas: header u16 count + f32[]. Alocação pequena e rara (2 Hz). */
export function packStats(values, code = 0) {
  const count = Math.min(values.length, STAT_SLOTS);
  const out = new Uint8Array(4 + count * 4);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, code, true);
  dv.setUint16(2, count, true);
  for (let i = 0; i < count; i++) dv.setFloat32(4 + i * 4, values[i], true);
  return out;
}

/** Desempacota dentro de um Float32Array reutilizável. */
export function unpackStats(view, len, out) {
  if (len < 4) return null;
  const dv = new DataView(view.buffer, view.byteOffset, len);
  const count = Math.min(dv.getUint16(2, true), out.length);
  for (let i = 0; i < count; i++) out[i] = dv.getFloat32(4 + i * 4, true);
  return count;
}

/** TICK: u16 dt em ms + u32 máscara de input (6 bytes, fixo). */
export function writeTick(view, dtMs, inputBits) {
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  dv.setUint16(0, dtMs & 0xffff, true);
  dv.setUint32(2, inputBits >>> 0, true);
  return 6;
}
export function readTick(view) {
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  return { dtMs: dv.getUint16(0, true), input: dv.getUint32(2, true) };
}

/** Localização de bloco: u32 id + u64 offset + u32 len (16 bytes). */
export function writeBlockReq(view, id, offset, len) {
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  dv.setUint32(0, id >>> 0, true);
  dv.setBigUint64(4, BigInt(offset), true);
  dv.setUint32(12, len >>> 0, true);
  return 16;
}
export function readBlockReq(view) {
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  return { id: dv.getUint32(0, true), offset: Number(dv.getBigUint64(4, true)), len: dv.getUint32(12, true) };
}

/** Requisição/entrega de bloco na volta: u32 id + bytes. */
export function writeBlockRes(view, id, bytes) {
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  dv.setUint32(0, id >>> 0, true);
  view.set(bytes, 4);
  return 4 + bytes.length;
}
export function readBlockResId(view) {
  return new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true);
}

export const textDecoder = new TextDecoder();
export const textEncoder = new TextEncoder();
