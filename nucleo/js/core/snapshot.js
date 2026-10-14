/**
 * NÚCLEO OS — core/snapshot.js
 * Estado do mundo compartilhado entre `w-engine` (produtor) e o renderizador
 * (consumidor) por *double buffering* + *seqlock*: o leitor nunca vê estado
 * rasgado e nunca precisa de lock.
 *
 *   controle (Int32Array, 64 B)      dados (Float32Array ×2 metades)
 *   [0] SEQ       contador ímpar = escrita em andamento
 *   [1] COUNT     entidades válidas na metade ativa
 *   [2] ACTIVE    índice da metade estável (0|1)
 *   [3] CYCLE     total de publicações
 *
 * Custo por leitura: 1 memcpy. Custo por escrita: nenhum (escreve na metade livre).
 */

import { S } from './wire.js';

const HEADER_BYTES = 64;
export const FIELDS = 8; // x, y, z, dx, dy, dz, speed, kind

/** Existe memória compartilhada neste contexto? (falso em iframe sem COOP/COEP) */
export const snapshotShared = () => typeof SharedArrayBuffer === 'function';

/**
 * Cria o buffer de estado do mundo.
 *
 * Com SharedArrayBuffer: memória compartilhada — o worker escreve e o renderizador
 * lê sem cópia (seqlock, caminho rápido).
 *
 * Sem SharedArrayBuffer (página não isolada — preview embutido, por exemplo):
 * um `ArrayBuffer` comum. `Atomics` funciona igual em buffer não compartilhado,
 * então o mesmo seqlock roda; o que muda é o transporte até a outra thread, e
 * quem decide isso é `snapshotStrategy()`.
 *
 * Antes desta função existir nos dois modos, `new SharedArrayBuffer` sem
 * isolamento de origem lançava `ReferenceError` e derrubava o boot inteiro — era
 * a mensagem "Falha ao iniciar o desktop" exibida no preview.
 */
export function createSnapshotBuffer(maxEntities, fields = FIELDS) {
  if (maxEntities < 1 || fields < 1) throw new Error('parâmetros de snapshot inválidos');
  const bytes = HEADER_BYTES + maxEntities * fields * 4 * 2;
  const buffer = snapshotShared() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  const control = new Int32Array(buffer, 0, 16);
  Atomics.store(control, 2, 0);
  return buffer;
}

/** 'shared' quando há memória compartilhada; 'post' quando o estado viaja por mensagem. */
export const snapshotStrategy = (buffer = null) =>
  (snapshotShared() && (!buffer || buffer instanceof SharedArrayBuffer)) ? 'shared' : 'post';

/** Copia um estado empacotado recebido por mensagem para o `out` pré-alocado. */
export function applyPackedSnapshot(out, packed, count) {
  const n = Math.min(count | 0, Math.floor(out.length / FIELDS), Math.floor(packed.length / FIELDS));
  if (n > 0) out.set(packed.subarray(0, n * FIELDS), 0);
  return n;
}

export function attachSnapshot(buffer) {
  const control = new Int32Array(buffer, 0, 16);
  const total = (buffer.byteLength - HEADER_BYTES) / 4;
  const half = total >> 1;
  const halves = [
    new Float32Array(buffer, HEADER_BYTES, half),
    new Float32Array(buffer, HEADER_BYTES + half * 4, half)
  ];
  return { control, halves, half, fields: FIELDS };
}

export function createWriter(buffer) {
  const { control, halves, half } = attachSnapshot(buffer);
  const capacity = half / FIELDS;
  return {
    capacity,
    /** `fill(view, capacity)` escreve a metade livre; devolve quantas entidades usou. */
    publish(fill) {
      Atomics.add(control, 0, 1);                       // ímpar: escrita em curso
      const inactive = (Atomics.load(control, 2) ^ 1) | 0;
      const view = halves[inactive];
      const count = Math.max(0, Math.min(fill(view, capacity) | 0, capacity));
      Atomics.store(control, 1, count);
      Atomics.store(control, 2, inactive);              // publica a metade nova
      Atomics.add(control, 3, 1);
      Atomics.add(control, 0, 1);                       // par: estável
      return count;
    },
    get cycle() { return Atomics.load(control, 3); }
  };
}

export function createReader(buffer) {
  const { control, halves } = attachSnapshot(buffer);
  return {
    /** Copia a metade ativa para `out` (pré-alocado). Devolve -1 se instável. */
    read(out) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const seq = Atomics.load(control, 0);
        if (seq & 1) continue;                          // escritor ativo
        const active = Atomics.load(control, 2) & 1;
        const count = Atomics.load(control, 1);
        const n = Math.min(count, Math.floor(out.length / FIELDS));
        const src = halves[active];
        const len = n * FIELDS;
        for (let i = 0; i < len; i++) out[i] = src[i];   // memcpy, sem alocação
        if (Atomics.load(control, 0) === seq) return n;  // estável durante a cópia
      }
      return -1;                                        // pula interpolação neste quadro
    },
    get cycle() { return Atomics.load(control, 3); },
    get count() { return Atomics.load(control, 1); }
  };
}

/** Preenche o objeto de estatísticas com o que o snapshot sabe (usado pelo engine). */
export function snapshotStats(reader, stats) {
  if (stats) stats[S.ENTITIES] = reader.count;
  return stats;
}
