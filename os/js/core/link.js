/**
 * SECTOR OS — core/link.js
 * Encanamento entre a thread principal e um worker: demultiplexa opcodes,
 * oferece request/response com timeout e expõe estatísticas de transporte.
 *
 * Duas implementações, mesma interface:
 *   RING/SAB  — SharedArrayBuffer + Atomics (preferida, baixa latência)
 *   MESSAGE   — MessagePort com buffers transferíveis (degradação honesta)
 *
 * Contrato de alocação: binário para bloco de dados (BLK_*), JSON para metadados
 * de FS/estatística (≤ 10 Hz). O HUD mostra qual transporte está ativo.
 */

import {
  OP, RingReader, RingWriter, PortReader, PortWriter,
  createLink, attachLink, sharedBusAvailable
} from './ipc.js';
import { textEncoder, textDecoder } from './wire.js';

const REQUEST_TIMEOUT = 6000;

export class Link {
  /**
   * @param {object} cfg
   * @param {RingWriter|PortWriter} cfg.writer  saída (main -> worker)
   * @param {RingReader|PortReader} cfg.reader  entrada (worker -> main)
   * @param {string} cfg.name
   * @param {'ring'|'message'} cfg.transport
   */
  constructor({ writer, reader, name, transport }) {
    this.writer = writer;
    this.reader = reader;
    this.name = name;
    this.transport = transport;
    this.handlers = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.framesIn = 0;
    this.framesOut = 0;
    this.closed = false;
  }

  /** Registra handler. `fn(view, len)` recebe a scratch reutilizada. */
  on(op, fn) {
    const list = this.handlers.get(op) || [];
    list.push(fn);
    this.handlers.set(op, list);
    return this;
  }

  send(op, data) {
    if (this.closed) return false;
    const ok = this.writer.push(op, data);
    if (ok) this.framesOut++;
    return ok;
  }

  /** Envia JSON curto (metadados). Devolve false se o canal estiver cheio. */
  sendJSON(op, obj) { return this.send(op, JSON.stringify(obj)); }

  /**
   * Envio com backpressure: o anel é limitado, então o produtor espera em vez de
   * perder o dado. Nunca chamado do caminho do quadro — só de tarefas assíncronas.
   */
  async sendBlocking(op, data, timeoutMs = 8000) {
    const t0 = Date.now();
    for (;;) {
      if (this.send(op, data)) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`${this.name}: canal saturado em ${opName(op)}`);
      await new Promise(r => setTimeout(r, 2));
    }
  }

  /** Request/response com id numérico e timeout. Resolve com JSON desserializado. */
  request(op, obj, resOp, timeout = REQUEST_TIMEOUT) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: timeout em ${opName(op)} (${timeout} ms)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, op: resOp });
      this.sendBlocking(op, JSON.stringify({ id, ...obj })).catch(error => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Bloco binário: u32 id + bytes. Resolve com Uint8Array copiado. */
  readBlock(id, bytes) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: timeout de bloco`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer, binary: true });
      this.sendBlocking(OP.BLK_READ, bytes).catch(error => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Bloco binário em escrita: u32 id + header + bytes; resolvido no ack do worker. */
  writeBlock(id, bytes) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: timeout de escrita`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer, binary: true });
      this.sendBlocking(OP.BLK_WRITE, bytes).catch(error => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  #settle(id, fn) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    fn(entry);
    return true;
  }

  /** Chamado pelo transporte com cada frame recebido. */
  ingest(op, view, len) {
    this.framesIn++;
    const list = this.handlers.get(op);
    if (list) for (const fn of list) {
      try { fn(view, len); } catch (e) { console.error(`[${this.name}] handler 0x${op.toString(16)}`, e); }
    }
    // STAT é binário (packStats) e não passa por aqui; JSON só para metadados com id.
    if (op === OP.FS_RES || op === OP.SYS_OUT) {
      let payload;
      try { payload = JSON.parse(textDecoder.decode(view.subarray(0, len))); }
      catch { return; }
      this.#settle(payload.id, entry => entry.resolve(payload));
    } else if (op === OP.BLK_DATA && len >= 4) {
      const id = new DataView(view.buffer, view.byteOffset, len).getUint32(0, true);
      const copy = view.slice(4, len);
      this.#settle(id, entry => entry.resolve(copy));
    } else if (op === OP.BLK_WRITE) {
      const id = new DataView(view.buffer, view.byteOffset, len).getUint32(0, true);
      this.#settle(id, entry => entry.resolve(true));
    }
  }

  /** Consome o que houver. No transporte MESSAGE é no-op (entrega é imediata). */
  drain() { return this.reader.drain?.() ?? 0; }

  stats() {
    return {
      ...this.reader.stats?.(),
      transport: this.transport,
      name: this.name,
      queues: this.pending.size,
      out: this.framesOut,
      in: this.framesIn
    };
  }

  dispose() {
    this.closed = true;
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error('link encerrado')); }
    this.pending.clear();
    this.handlers.clear();
    this.reader.close?.();
  }
}

function opName(op) {
  for (const [k, v] of Object.entries(OP)) if (v === op) return k;
  return `0x${op.toString(16)}`;
}

/**
 * Adaptador de eventos: aceita tanto Web Worker (addEventListener) quanto
 * worker_threads do Node (EventEmitter). É o que permite testar este caminho
 * fora do navegador.
 */
function listen(worker, type, fn) {
  if (typeof worker.addEventListener === 'function') {
    worker.addEventListener(type, fn);
    return () => worker.removeEventListener?.(type, fn);
  }
  const handler = type === 'message' ? data => fn({ data }) : error => fn({ error, message: error?.message });
  worker.on(type, handler);
  return () => worker.off?.(type, handler);
}

/**
 * Cria um link para um Worker. Com SAB disponível, envia os dois canais pelo
 * handshake inicial; sem SAB, usa um MessageChannel dedicado.
 * @returns {Promise<Link>}
 */
export function connectWorker(worker, name = 'worker', { shared = sharedBusAvailable() } = {}) {
  if (!shared) {
    const channel = new MessageChannel();
    return Promise.resolve(openPort(worker, channel, name));
  }
  const link = createLink(1 << 16);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: handshake expirou`)), 8000);
    let offMessage = () => {};
    const onMessage = event => {
      if (event.data?.type !== 'sector-link-ready' || event.data.name !== name) return;
      clearTimeout(timer);
      offMessage();
      resolve();
    };
    offMessage = listen(worker, 'message', onMessage);
    listen(worker, 'error', e => { clearTimeout(timer); reject(e.error || new Error(String(e.message || e))); });
  });
  const out = new RingWriter(link.a2b, { name: `${name}:out` });
  const incoming = new RingReader(link.b2a, { onMessage: (op, view, len) => target.ingest(op, view, len), name: `${name}:in` });
  const target = new Link({ writer: out, reader: incoming, name, transport: 'ring' });
  worker.postMessage({ type: 'sector-link', a2b: link.a2b.buffer, b2a: link.b2a.buffer, name });
  return ready.then(() => target);
}

function openPort(worker, channel, name) {
  const out = new PortWriter(channel.port1, { name: `${name}:out` });
  const incoming = new PortReader(channel.port2, { onMessage: (op, view, len) => target.ingest(op, view, len) });
  const target = new Link({ writer: out, reader: incoming, name, transport: 'message' });
  worker.postMessage({ type: 'sector-port', port: channel.port2, name }, [channel.port2]);
  return target;
}

/** Lado do worker: recebe o handshake e devolve {link, stop}. */
export function acceptWorkerLink(self, { onReady, onMessage } = {}) {
  let stop = () => {};
  const state = { link: null, name: 'worker' };
  self.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'sector-link') {
      const { a2b, b2a } = attachLink({ a2b: data.a2b, b2a: data.b2a });
      const writer = new RingWriter(b2a, { name: `${data.name}:out` });
      const reader = new RingReader(a2b, {
        // Todo frame precisa passar pelo Link (ingest) para chegar aos handlers
        // registrados com link.on(op, fn). Sem isto, o worker consome e descarta.
        onMessage: (op, view, len) => {
          state.link?.ingest(op, view, len);
          onMessage?.(op, view, len, state.link);
        },
        name: `${data.name}:in`
      });
      state.link = new Link({ writer, reader, name: data.name, transport: 'ring' });
      state.name = data.name;
      self.postMessage({ type: 'sector-link-ready', name: data.name });
      stop = onReady?.(state.link, state);
    } else if (data.type === 'sector-port') {
      const port = event.ports?.[0] || data.port;
      const writer = new PortWriter(port, { name: `${data.name}:out` });
      const reader = new PortReader(port, {
        onMessage: (op, view, len) => {
          state.link?.ingest(op, view, len);
          onMessage?.(op, view, len, state.link);
        }
      });
      state.link = new Link({ writer, reader, name: data.name, transport: 'message' });
      state.name = data.name;
      stop = onReady?.(state.link, state);
    } else if (data.type === 'sector-shutdown') {
      stop?.();
      state.link?.dispose();
      self.close();
    }
  });
  return state;
}

export { OP };
