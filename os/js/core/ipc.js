/**
 * SECTOR OS — core/ipc.js
 * Barramento SPSC (single-producer/single-consumer) sobre SharedArrayBuffer.
 *
 * Estado: [B] funcional — testado em Node (tests/os-core.mjs) e no navegador.
 * Contrato: docs/00-arquitetura.md §3.
 *
 * Regras de projeto:
 *  - Zero alocação no caminho quente: o consumidor recebe uma *view* reutilizável
 *    (scratch) e deve copiar/consumir antes do próximo drain().
 *  - Um escritor por canal. Leitura apenas avança HEAD, escrita apenas avança TAIL.
 *  - Nenhum quadro atravessa o fim do buffer: quando não cabe, escrevemos um
 *    marcador de WRAP (len = 0xFFFFFFFF) e voltamos a TAIL = 0.
 *  - Backpressure explícita: se não houver espaço, o produtor registra `drops`
 *    e devolve false — nunca bloqueia o quadro do compositor.
 */

export const OP = Object.freeze({
  HB: 0x01,          // worker -> main : batimento
  TICK: 0x10,        // main -> engine: passo de simulação
  TICK_REPORT: 0x11, // engine -> main: custo do tick
  CFG: 0x12,         // main -> worker: configuração em JSON
  BLK_READ: 0x20,    // main -> io    : leitura de bloco
  BLK_DATA: 0x21,    // io -> main    : dados
  BLK_WRITE: 0x22,   // main -> io    : escrita de bloco
  FS_OP: 0x28,       // main -> io    : operação de metadados (JSON curto)
  FS_RES: 0x29,      // io -> main    : resposta
  SYS_EXEC: 0x30,    // main -> kernel: comando
  SYS_OUT: 0x31,     // kernel -> main: saída
  STAT_REQ: 0x40,    // main -> worker: pedir métricas
  STAT: 0x41,        // worker -> main: métricas empacotadas (Float32)
  LOG: 0x50,         // worker -> main: linha de log
  PING: 0x60,
  PONG: 0x61
});

const MAGIC = 0x53454354; // "SECT"
const HDR = 8;            // u32 len | u16 op | u16 flags
const ALIGN = 16;
const WRAP_LEN = 0xffffffff;
const SLACK = 32;         // margem de segurança (cobre o marcador de wrap)

// Índices do bloco de controle (Int32Array de 32 slots)
const C_MAGIC = 0, C_HEAD = 1, C_TAIL = 2, C_CAP = 3;
const C_FRAMES = 4, C_DROPS = 5, C_WAITS = 6, C_BYTES = 7, C_ALIVE = 8;
// Contadores monotônicos de frames: separam "vazio" de "mesma posição".
// Sem eles, um WRAP que faz TAIL coincidir com HEAD pareceria buffer vazio e
// prenderia o quadro publicado (bug real encontrado pelo teste de wrap).
const C_WRITTEN = 9, C_READ = 10;
export const CONTROL_SLOTS = 32;

const align16 = n => (n + (ALIGN - 1)) & ~(ALIGN - 1);

/** Cria um canal compartilhado (lado que *cria* o SAB). */
export function createChannel(bytes = 1 << 16) {
  const cap = Math.max(4096, align16(bytes));
  const buffer = new SharedArrayBuffer(128 + cap);
  const control = new Int32Array(buffer, 0, CONTROL_SLOTS);
  const payload = new Uint8Array(buffer, 128, cap);
  Atomics.store(control, C_MAGIC, MAGIC);
  Atomics.store(control, C_CAP, cap);
  Atomics.store(control, C_ALIVE, 1);
  return { buffer, control, payload, capacity: cap };
}

/** Reconstrói um canal a partir de um SAB recebido (lado do worker). */
export function attachChannel(buffer) {
  const control = new Int32Array(buffer, 0, CONTROL_SLOTS);
  if (Atomics.load(control, C_MAGIC) !== MAGIC) throw new Error('Canal IPC inválido (magic).');
  const cap = Atomics.load(control, C_CAP);
  return { buffer, control, payload: new Uint8Array(buffer, 128, cap), capacity: cap };
}

export function createLink(bytes) {
  return { a2b: createChannel(bytes), b2a: createChannel(bytes) };
}
export function attachLink({ a2b, b2a }) {
  return { a2b: attachChannel(a2b), b2a: attachChannel(b2a) };
}

/**
 * Fila de saída (produtor). Interface idêntica ao transporte de fallback.
 */
export class RingWriter {
  #cap; #control; #payload; #dv;
  #enc = new TextEncoder();
  #strBuf = new Uint8Array(64 * 1024);

  constructor(channel, { onDrop = null, name = 'ring' } = {}) {
    this.#cap = channel.capacity;
    this.#control = channel.control;
    this.#payload = channel.payload;
    this.#dv = new DataView(channel.payload.buffer, channel.payload.byteOffset, channel.payload.byteLength);
    this.name = name;
    this.onDrop = onDrop;
  }

  /**
   * Envia um frame. `data` pode ser Uint8Array, string (≤ 64 KiB) ou null.
   * Devolve false (e conta um drop) quando não há região livre contígua suficiente.
   *
   * Regiões do anel (dois ponteiros, um escritor/um leitor):
   *   usada  = [head, tail)  mod cap
   *   livre  = [tail, head)  mod cap
   * Como um quadro não atravessa o fim do buffer, ao chegar perto do fim
   * escrevemos um marcador de WRAP (len = 0xFFFFFFFF) e voltamos a escrever em 0.
   * Isso só é válido quando a região livre realmente dá a volta (head <= tail) e
   * o começo do buffer está livre por pelo menos `frame` bytes (frame <= head).
   */
  push(op, data = null) {
    const cap = this.#cap, control = this.#control, payload = this.#payload, dv = this.#dv;
    let len = 0, src = null;
    if (typeof data === 'string') {
      const r = this.#enc.encodeInto(data, this.#strBuf);
      len = r.written; src = this.#strBuf;
    } else if (data && data.length) {
      len = data.length; src = data;
    }
    const limit = cap - HDR - SLACK;
    if (len > limit) { this.#drop('frame maior que o canal'); return false; }

    const frame = HDR + align16(len);
    const head = Atomics.load(control, C_HEAD);
    let tail = Atomics.load(control, C_TAIL);
    const used = (tail - head + cap) % cap;
    const free = cap - used - SLACK;
    let at = tail;

    if (at + frame > cap - SLACK) {
      const freeWraps = head <= at;
      if (at === 0 || !freeWraps || frame > head) { this.#drop('sem região livre contígua'); return false; }
      dv.setUint32(at, WRAP_LEN, true);
      dv.setUint16(at + 4, 0, true);
      dv.setUint16(at + 6, 1, true);
      at = 0;
    }
    if (free < frame) { this.#drop('canal cheio'); return false; }

    dv.setUint32(at, len, true);
    dv.setUint16(at + 4, op, true);
    dv.setUint16(at + 6, 0, true);
    if (len) payload.set(src.subarray(0, len), at + HDR);
    for (let i = HDR + len; i < frame; i += 4) dv.setUint32(at + i, 0, true); // padding determinístico
    Atomics.store(control, C_TAIL, (at + frame) % cap);
    Atomics.add(control, C_FRAMES, 1);
    Atomics.add(control, C_BYTES, len);
    // Publicação: os bytes são escritos antes; o contador (seq-cst) é a barreira
    // que o consumidor observa. Depois vem o notify para acordar quem espera.
    Atomics.add(control, C_WRITTEN, 1);
    Atomics.notify(control, C_WRITTEN, 1);
    return true;
  }

  #drop(why) {
    Atomics.add(this.#control, C_DROPS, 1);
    this.onDrop?.(why);
  }
  stats() { return readStats(this.#control); }
  close() { Atomics.store(this.#control, C_ALIVE, 0); Atomics.notify(this.#control, C_TAIL, 1); }
}

/**
 * Fila de entrada (consumidor). `onMessage(op, view, len)` recebe a scratch view
 * reutilizada — copie o que precisar guardar.
 */
export class RingReader {
  #cap; #control; #payload; #dv; #scratch; #view; #onMessage = null;
  constructor(channel, { onMessage, scratch = 1 << 16, name = 'ring' } = {}) {
    this.#cap = channel.capacity;
    this.#control = channel.control;
    this.#payload = channel.payload;
    this.#dv = new DataView(channel.payload.buffer, channel.payload.byteOffset, channel.payload.byteLength);
    this.#scratch = new Uint8Array(Math.min(scratch, channel.capacity));
    this.#view = this.#scratch;
    this.#onMessage = onMessage;
    this.name = name;
    this.corrupt = 0;
  }

  get view() { return this.#view; }

  /**
   * Consome tudo que estiver disponível. Devolve o número de frames lidos.
   * A condição de parada é a comparação dos contadores de frames (escritos vs
   * lidos), nunca a igualdade das posições — ver comentário de C_WRITTEN.
   */
  drain() {
    const cap = this.#cap, control = this.#control, payload = this.#payload, dv = this.#dv;
    let n = 0;
    for (;;) {
      if (Atomics.load(control, C_READ) === Atomics.load(control, C_WRITTEN)) break;
      const head = Atomics.load(control, C_HEAD);
      const len = dv.getUint32(head, true);
      const op = dv.getUint16(head + 4, true);
      if (len === WRAP_LEN) {                       // marcador de wrap: não é um frame
        Atomics.store(control, C_HEAD, 0);
        continue;
      }
      const frame = HDR + align16(len);
      if (head + frame > cap || len > this.#scratch.length) {
        // Estado inconsistente: ressincroniza e descarta este frame.
        this.corrupt++;
        Atomics.store(control, C_HEAD, 0);
        Atomics.add(control, C_READ, 1);
        continue;
      }
      if (len) this.#scratch.set(payload.subarray(head + HDR, head + HDR + len));
      Atomics.store(control, C_HEAD, (head + frame) % cap);
      Atomics.add(control, C_READ, 1);
      this.#onMessage(op, this.#scratch, len);
      n++;
      if (n > 4096) break; // teto por passada: nunca monopoliza o quadro
    }
    return n;
  }

  /**
   * Espera *assíncrona* por dados. É o caminho suportado nos workers.
   *
   * Por que não Atomics.wait bloqueante: ele impede que a pilha se desenrole,
   * e portanto congela microtasks — um handler `async` (leitura de OPFS, por
   * exemplo) nunca retomaria. Atomics.waitAsync mantém o event loop vivo com
   * latência de wake-up igual à do notify.
   */
  async waitAsync(timeoutMs = 200) {
    const control = this.#control;
    const written = Atomics.load(control, C_WRITTEN);
    if (written !== Atomics.load(control, C_READ)) return true;
    if (typeof Atomics.waitAsync === 'function') {
      const r = Atomics.waitAsync(control, C_WRITTEN, written, timeoutMs);
      const value = await r.value;
      if (value !== 'timed-out') Atomics.add(control, C_WAITS, 1);
      return value !== 'timed-out';
    }
    // Navegador sem waitAsync: sondagem curta (ainda dentro do event loop).
    await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 8)));
    return Atomics.load(control, C_WRITTEN) !== Atomics.load(control, C_READ);
  }

  /** Laço de bombeamento de um worker: aguarda, drena e repete. */
  async pump(onIdle = null, { timeoutMs = 200 } = {}) {
    while (this.alive) {
      const woke = await this.waitAsync(timeoutMs);
      const n = this.drain();
      if (!woke && !n && onIdle) onIdle();
    }
  }

  get alive() { return Atomics.load(this.#control, C_ALIVE) === 1; }
  stats() { return readStats(this.#control); }
  close() { Atomics.store(this.#control, C_ALIVE, 0); Atomics.notify(this.#control, C_WRITTEN, 1); }
}

export function readStats(control) {
  return {
    frames: Atomics.load(control, C_FRAMES),
    drops: Atomics.load(control, C_DROPS),
    waits: Atomics.load(control, C_WAITS),
    bytes: Atomics.load(control, C_BYTES)
  };
}

/**
 * Transporte de degradação: mesma API, sem SharedArrayBuffer.
 * Usado quando a página não está isolada (COOP/COEP ausente). A UI marca
 * TRANSPORTE: MESSAGE — o sistema funciona, com mais latência.
 */
export class PortWriter {
  constructor(port, { name = 'port' } = {}) { this.port = port; this.name = name; this.frames = 0; this.drops = 0; }
  push(op, data = null) {
    let buf = null;
    if (typeof data === 'string') buf = new TextEncoder().encode(data);
    else if (data && data.length) buf = data.slice();
    this.port.postMessage({ op, buf }, buf ? [buf.buffer] : []);
    this.frames++;
    return true;
  }
  stats() { return { frames: this.frames, drops: 0, waits: 0, bytes: 0 }; }
  close() { this.port.close?.(); }
}

export class PortReader {
  #cb = null;
  constructor(port, { onMessage } = {}) {
    this.port = port; this.frames = 0; this.corrupt = 0;
    this.#cb = onMessage;
    port.onmessage = ({ data }) => {
      this.frames++;
      const buf = data.buf && data.buf.byteLength ? new Uint8Array(data.buf) : null;
      this.#cb(data.op, buf, buf ? buf.length : 0);
    };
  }
  drain() { return 0; }
  /** No transporte MESSAGE os frames chegam por onmessage: só cedemos o loop. */
  async waitAsync(timeoutMs = 200) { await new Promise(r => setTimeout(r, Math.min(timeoutMs, 16))); return false; }
  async pump(onIdle = null) { while (this.alive) { await this.waitAsync(); if (onIdle) onIdle(); } }
  get alive() { return true; }
  stats() { return { frames: this.frames, drops: 0, waits: 0, bytes: 0 }; }
  close() { this.port.close?.(); }
}

/** Detecta se o ambiente suporta o barramento de memória compartilhada. */
export function sharedBusAvailable() {
  return typeof SharedArrayBuffer === 'function' &&
    (typeof crossOriginIsolated === 'undefined' ? true : crossOriginIsolated === true);
}
