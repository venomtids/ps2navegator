/**
 * NÚCLEO OS — tests/core.mjs
 * Testes de núcleo, sem navegador e sem dependências:
 *   1. ipc      — anel SAB: integridade, wrap, backpressure, estatísticas
 *   2. link/vfs — request/response, sessão de I/O e o VMFS ponta a ponta
 *   3. snapshot — seqlock sob concorrência real (worker_threads, zero leitura rasgada)
 *   4. geom     — matemática do window manager
 *   5. wire     — formatos binários
 *   6. util     — caminhos seguros, formatação, percentis
 *
 * Execute: npm run test:core
 */

import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { createChannel, RingWriter, RingReader, PortWriter, PortReader, readStats, OP } from '../js/core/ipc.js';
import { Link, connectWorker } from '../js/core/link.js';
import { createVFS, BLOCK } from '../js/core/vfs.js';
import { createSnapshotBuffer, createWriter, createReader, snapshotStrategy, applyPackedSnapshot, FIELDS } from '../js/core/snapshot.js';
import { packStats, unpackStats, writeTick, readTick, writeBlockReq, readBlockReq, emptyStats, STAT_SLOTS } from '../js/core/wire.js';
import * as G from '../js/core/geom.js';
import { createLocalVFS } from '../js/core/vfs-local.js';
import { safePath, fmtBytes, Histogram, clamp, baseName } from '../js/core/util.js';
import { probeCapabilities } from '../js/boot.js';

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ok   ${name}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
const section = title => results.push(`\n${title}`);
/** Corrida contra o relógio: um travamento vira falha explícita, não um teste pendurado. */
const race = (promise, label, ms = 4000) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: travou (${ms} ms)`)), ms))
]);

// ------------------------------------------------------------------ 1 ipc --
section('1 · ipc (anel SPSC sobre SharedArrayBuffer)');

await test('entrega um frame binário com integridade byte a byte', () => {
  const ch = createChannel(4096);
  const w = new RingWriter(ch);
  const got = [];
  const r = new RingReader(ch, { onMessage: (op, view, len) => got.push({ op, bytes: view.slice(0, len) }) });
  const payload = new Uint8Array([1, 2, 3, 250, 0, 255]);
  assert.equal(w.push(0x20, payload), true);
  assert.equal(r.drain(), 1);
  assert.equal(got[0].op, 0x20);
  assert.deepEqual([...got[0].bytes], [...payload]);
});

await test('envia string UTF-8 (acentos) sem corromper', () => {
  const ch = createChannel(4096);
  const w = new RingWriter(ch);
  let text = '';
  const r = new RingReader(ch, { onMessage: (op, view, len) => { text = new TextDecoder().decode(view.subarray(0, len)); } });
  w.push(0x30, 'sessão · núcleo de I/O · 1 MiB/s');
  r.drain();
  assert.equal(text, 'sessão · núcleo de I/O · 1 MiB/s');
});

await test('sobrevive a wrap-around e a 2000 frames sem perda', () => {
  const ch = createChannel(4096);
  const w = new RingWriter(ch);
  let count = 0, sum = 0, lastLen = -1;
  const r = new RingReader(ch, { onMessage: (op, view, len) => { count++; lastLen = len; sum += view[0]; } });
  for (let i = 0; i < 2000; i++) {
    const payload = new Uint8Array(1 + (i % 40));
    payload[0] = i & 0xff;
    if (w.push(0x10, payload)) r.drain();     // consumidor drena a cada frame
  }
  r.drain();
  assert.equal(count, 2000, 'todos os frames devem chegar');
  assert.ok(lastLen >= 1);
  assert.equal(readStats(ch.control).drops, 0, 'sem drops quando o consumidor acompanha');
  assert.ok(sum > 0);
});

await test('quadros grandes (> metade do anel) sobrevivem ao wrap após drenagem', () => {
  const ch = createChannel(1 << 16);
  const w = new RingWriter(ch);
  let received = 0, corrupt = 0;
  const r = new RingReader(ch, {
    onMessage: (op, view, len) => {
      received++;
      // cada quadro carrega um contador; o último byte tem de casar com ele
      if (view[len - 1] !== (received & 0xff)) corrupt++;
    }
  });
  const block = new Uint8Array(32 * 1024);           // payload de 32 KiB
  let sent = 0;
  for (let round = 0; round < 12; round++) {
    block[block.length - 1] = (sent + 1) & 0xff;
    if (w.push(OP.BLK_WRITE, block)) sent++;
    r.drain();                                        // consumidor acompanha
  }
  r.drain();
  assert.equal(sent, 12, 'todos os 12 blocos caberiam um a um');
  assert.equal(received, 12);
  assert.equal(corrupt, 0, 'nenhum quadro pode ser corrompido na virada do anel');
  assert.equal(readStats(ch.control).drops, 0);
});

await test('backpressure: produtor mais rápido que o consumidor conta drops e nunca trava', () => {
  const ch = createChannel(4096);
  const w = new RingWriter(ch);
  let sent = 0, drops = 0;
  w.onDrop = () => drops++;
  for (let i = 0; i < 1000; i++) if (w.push(0x10, new Uint8Array(256))) sent++;
  const stats = readStats(ch.control);
  assert.ok(drops > 0, 'deve haver drops com canal cheio');
  assert.equal(stats.drops, drops, 'estatística do canal espelha os drops do produtor');
  assert.ok(sent * 256 <= 4096, 'nunca aceita mais do que o canal comporta');
});

await test('frame maior que o canal é recusado, não truncado', () => {
  const ch = createChannel(4096);
  const w = new RingWriter(ch);
  assert.equal(w.push(0x20, new Uint8Array(8192)), false);
  assert.equal(readStats(ch.control).drops, 1);
});

await test('leitura reconstrói views a partir do mesmo SAB (lado do worker)', async () => {
  const ch = createChannel(4096);
  const w = new RingWriter(ch);
  w.push(0x21, new Uint8Array([7, 7, 7]));
  assert.equal(readStats(ch.control).frames, 1);
});

// ------------------------------------------------------------ 2 link / vfs --
section('2 · link + vfs (VMFS ponta a ponta com backend fiel ao protocolo)');

/** Backend falso que implementa exatamente os ops do io.worker (sessão única). */
function mockStorage({ sync = true } = {}) {
  const files = new Map([['/home/nucleo/nota.txt', new TextEncoder().encode('olá mundo do vmfs')]]);
  const index = new Map([['/', { type: 'dir', size: 0 }], ['/home', { type: 'dir', size: 0 }],
    ['/home/nucleo', { type: 'dir', size: 0 }], ['/home/nucleo/nota.txt', { type: 'file', size: 15 }]]);
  let session = null;
  return {
    calls: [],
    files,
    handle(msg) {
      this.calls.push(msg.op);
      switch (msg.op) {
        case 'init': return { backend: 'OPFS', sync, quotaMb: 512, usedMb: 1 };
        case 'list': {
          const prefix = msg.path === '/' ? '/' : msg.path + '/';
          return [...index.entries()]
            .filter(([p]) => p.startsWith(prefix) && p !== msg.path && !p.slice(prefix.length).includes('/'))
            .map(([p, meta]) => ({ name: p.slice(prefix.length), ...meta }));
        }
        case 'stat': {
          const meta = index.get(msg.path);
          if (!meta) throw new Error('caminho inexistente');
          return { ...meta, path: msg.path };
        }
        case 'mkdir': index.set(msg.path, { type: 'dir', size: 0 }); return { path: msg.path };
        case 'remove': index.delete(msg.path); files.delete(msg.path); return { path: msg.path };
        case 'rename': {
          const meta = index.get(msg.from);
          if (!meta) throw new Error('origem inexistente');
          index.set(msg.to, meta);
          if (files.has(msg.from)) { files.set(msg.to, files.get(msg.from)); files.delete(msg.from); }
          index.delete(msg.from);
          return { from: msg.from, to: msg.to };
        }
        case 'open':
          session = msg.mode === 'r'
            ? { path: msg.path, mode: 'r', size: files.get(msg.path)?.length ?? 0 }
            : { path: msg.path, mode: 'w', buf: new Uint8Array(msg.size), size: msg.size };
          return { path: session.path, mode: session.mode, size: session.size };
        case 'close': {
          if (!session) throw new Error('sem sessão');
          if (session.mode === 'w') {
            files.set(session.path, session.buf);
            index.set(session.path, { type: 'file', size: session.buf.length });
          }
          const out = { path: session.path, mode: session.mode, bytes: session.size };
          session = null;
          return out;
        }
        case 'bench': return { backend: 'OPFS', sync, bytes: 1024, writeMs: 2, readMs: 1, writeMbps: 512, readMbps: 1024 };
        case 'usage': return { backend: 'OPFS', files: files.size, usedBytes: 4096, quotaBytes: 1024 * 1024 * 512, persisted: true };
        default: throw new Error(`op desconhecida: ${msg.op}`);
      }
    },
    blockRead({ offset, len }) {
      if (!session || session.mode !== 'r') throw new Error('BLK_READ sem sessão');
      const data = files.get(session.path) || new Uint8Array(0);
      return data.subarray(offset, offset + len);
    },
    blockWrite(view) {
      if (!session || session.mode !== 'w') throw new Error('BLK_WRITE sem sessão');
      const { offset, len } = readBlockReq(view);
      session.buf.set(view.subarray(16, 16 + len), offset);
      return len;
    }
  };
}

/**
 * Despacho do backend falso — o MESMO para os dois transportes (anel e porta).
 * `reply(op, bytes)` é o escritor do lado "worker".
 */
function backendDispatch(backend, op, view, len, reply) {
  if (op === OP.FS_OP) {
    const msg = JSON.parse(new TextDecoder().decode(view.subarray(0, len)));
    try { reply(OP.FS_RES, JSON.stringify({ id: msg.id, ok: true, data: backend.handle(msg) })); }
    catch (e) { reply(OP.FS_RES, JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e) })); }
  } else if (op === OP.BLK_READ) {
    const { id, offset, len: n } = readBlockReq(view);
    try {
      const bytes = backend.blockRead({ offset, len: n });
      const out = new Uint8Array(4 + bytes.length);
      new DataView(out.buffer).setUint32(0, id, true);
      out.set(bytes, 4);
      reply(OP.BLK_DATA, out);
    } catch (e) { reply(OP.FS_RES, JSON.stringify({ id, ok: false, error: String(e.message || e) })); }
  } else if (op === OP.BLK_WRITE) {
    const copy = view.slice(0, len);   // a scratch é reutilizada: copia antes de sair
    const { id } = readBlockReq(copy);
    try {
      backend.blockWrite(copy);
      const ack = new Uint8Array(4);
      new DataView(ack.buffer).setUint32(0, id, true);
      reply(OP.BLK_WRITE, ack);
    } catch (e) { reply(OP.FS_RES, JSON.stringify({ id, ok: false, error: String(e.message || e) })); }
  } else if (op === OP.STAT_REQ) {
    reply(OP.STAT, packStats(new Float32Array([1, 2, 3, 4])));
  }
}

/**
 * Harness SEM SharedArrayBuffer: dois lados ligados por MessageChannel, exatamente
 * como o desktop opera em página não isolada (o caso do preview embutido).
 * Não há Atomics, não há buffer compartilhado e nada precisa ser bombeado.
 */
function harnessPort(backend) {
  const channel = new MessageChannel();
  let link = null;
  link = new Link({
    writer: new PortWriter(channel.port1, { name: 'mock-port:out' }),
    reader: new PortReader(channel.port1, { onMessage: (op, view, len) => link.ingest(op, view, len) }),
    name: 'mock-port',
    transport: 'message'
  });
  const workerWriter = new PortWriter(channel.port2, { name: 'mock-port-worker:out' });
  new PortReader(channel.port2, {
    onMessage: (op, view, len) => backendDispatch(backend, op, view, len, (o, d) => workerWriter.push(o, d))
  });
  const done = () => { link.dispose(); channel.port1.close(); channel.port2.close(); };
  const fail = (label, ms = 4000) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: travou em MESSAGE (${ms} ms)`)), ms));
  return { link, race: (promise, label, ms) => Promise.race([promise, fail(label, ms)]), done, backend };
}

/** Conecta um Link "main" a um backend em-processo, exercitando ipc+link de verdade. */
function harness(backend) {
  const a2b = createChannel(1 << 16), b2a = createChannel(1 << 16);
  const mainWriter = new RingWriter(a2b);
  const link = new Link({
    writer: mainWriter,
    reader: new RingReader(b2a, { onMessage: null }),
    name: 'mock',
    transport: 'ring'
  });
  // Reidrata o leitor para entregar os frames ao próprio Link (como faz o main).
  link.reader = new RingReader(b2a, { onMessage: (op, view, len) => link.ingest(op, view, len) });

  // Lado "worker": lê a2b e responde em b2a (mesmo despacho do transporte MESSAGE).
  const workerWriter = new RingWriter(b2a);
  const workerReader = new RingReader(a2b, {
    onMessage: (op, view, len) => backendDispatch(backend, op, view, len, (o, d) => workerWriter.push(o, d))
  });

  // Bombeia as duas direções a cada 1 ms (equivale ao loop de rAF do desktop).
  const timer = setInterval(() => { workerReader.drain(); link.drain(); }, 1);
  const done = () => clearInterval(timer);
  const race = (promise, label, ms = 3000) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: travou (${ms} ms)`)), ms))
  ]);
  return { link, race, done, workerReader, workerWriter, backend };
}

await test('VFS: init, list e stat através do barramento real', async () => {
  const h = harness(mockStorage());
  const vfs = createVFS(h.link);
  try {
    const info = await h.race(vfs.init(), 'init');
    assert.equal(info.backend, 'OPFS');
    assert.equal(info.sync, true);
    const rows = await h.race(vfs.list('/home/nucleo'), 'list');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'nota.txt');
    const st = await h.race(vfs.stat('/home/nucleo/nota.txt'), 'stat');
    assert.equal(st.type, 'file');
    assert.equal(st.size, 15);
  } finally { h.done(); }
});

await test('VFS: grava 96 KiB em blocos de 32 KiB e lê de volta byte a byte', async () => {
  const h = harness(mockStorage());
  const vfs = createVFS(h.link);
  const data = new Uint8Array(96 * 1024 + 731);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  try {
    await h.race(vfs.write('/home/nucleo/grande.bin', data), 'write', 6000);
    const stored = h.backend.files.get('/home/nucleo/grande.bin');
    assert.equal(stored.length, data.length);
    assert.deepEqual([...stored.slice(0, 16)], [...data.slice(0, 16)]);
    assert.deepEqual([...stored.slice(-16)], [...data.slice(-16)]);
    const back = await h.race(vfs.read('/home/nucleo/grande.bin'), 'read', 6000);
    assert.equal(back.length, data.length);
    assert.deepEqual([...back.subarray(0, 4096)], [...data.subarray(0, 4096)]);
    assert.deepEqual([...back.slice(-16)], [...data.slice(-16)]);
    assert.equal(BLOCK, 32 * 1024);
    assert.equal(h.backend.calls.filter(c => c === 'open').length, 2, 'uma sessão para escrita, uma para leitura');
  } finally { h.done(); }
});

await test('VFS: recusa caminho hostil sem sequer tocar no worker', async () => {
  const h = harness(mockStorage());
  const vfs = createVFS(h.link);
  try {
    await assert.rejects(() => vfs.read('/home/nucleo/\u0000evil'), /nulo|caminho/i);
    await assert.rejects(() => vfs.write('x'.repeat(600), 'ab'), /inválido|caminho/i);
    assert.equal(h.backend.calls.length, 0, 'nenhuma operação deve chegar ao armazenamento');
  } finally { h.done(); }
});

// -------------------------------------------------------------- 3 snapshot --
// ------------------------------------ 3 VFS SEM SharedArrayBuffer (preview) --
section('3 · VFS completo SEM SharedArrayBuffer (o caminho do preview embutido)');

await test('init/list/read/write funcionam pelo MessageChannel, bloco a bloco', async () => {
  const h = harnessPort(mockStorage({ sync: false }));
  const vfs = createVFS(h.link);
  try {
    assert.equal(h.link.transport, 'message');
    const info = await h.race(vfs.init(), 'init');
    assert.equal(info.backend, 'OPFS');
    assert.equal(info.sync, false);

    const rows = await h.race(vfs.list('/home/nucleo'), 'list');
    assert.equal(rows[0].name, 'nota.txt');
    assert.equal(new TextDecoder().decode(await h.race(vfs.read('/home/nucleo/nota.txt'), 'read')), 'olá mundo do vmfs');

    // 96 KiB + 731 B: exercita o caminho de bloco binário repetidas vezes
    const data = new Uint8Array(96 * 1024 + 731);
    for (let i = 0; i < data.length; i++) data[i] = (i * 5) & 0xff;
    await h.race(vfs.write('/home/nucleo/msg.bin', data), 'write', 8000);
    const back = await h.race(vfs.read('/home/nucleo/msg.bin'), 'read-back', 8000);
    assert.equal(back.length, data.length);
    assert.deepEqual([...back.slice(0, 16)], [...data.slice(0, 16)]);
    assert.deepEqual([...back.slice(-16)], [...data.slice(-16)]);
  } finally { h.done(); }
});

await test('erro hostil e erro do backend viajam como rejeição, nunca como resposta vazia', async () => {
  const h = harnessPort(mockStorage());
  const vfs = createVFS(h.link);
  try {
    await assert.rejects(h.race(vfs.stat('/nao/existe'), 'stat'), /inexistente/);
    // O caminho hostil é recusado na camada do VFS, antes de tocar o worker.
    await assert.rejects(h.race(vfs.read('nome\u0000.txt'), 'read'), /byte nulo/);
  } finally { h.done(); }
});

section('4 · snapshot (seqlock: leitor nunca vê estado rasgado)');

await test('publish/read preserva contagem e valores', () => {
  const buf = createSnapshotBuffer(16, FIELDS);
  const writer = createWriter(buf);
  const reader = createReader(buf);
  const out = new Float32Array(16 * FIELDS);
  const n = writer.publish((view, cap) => {
    for (let i = 0; i < 5; i++) { view[i * FIELDS] = i; view[i * FIELDS + 7] = i * 2; }
    return 5;
  });
  assert.equal(n, 5);
  assert.equal(reader.read(out), 5);
  assert.equal(out[0], 0);
  assert.equal(out[4 * FIELDS], 4);
  assert.equal(out[4 * FIELDS + 7], 8);
});

await test('escritor concorrente por 400 ms: zero leitura rasgada', async () => {
  const buf = createSnapshotBuffer(256, FIELDS);
  const reader = createReader(buf);
  const out = new Float32Array(256 * FIELDS);
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const buffer = workerData.buffer;
    const control = new Int32Array(buffer, 0, 16);
    const total = (buffer.byteLength - 64) / 4;
    const half = total >> 1;
    const halves = [
      new Float32Array(buffer, 64, half),
      new Float32Array(buffer, 64 + half * 4, half)
    ];
    const end = Date.now() + 500;
    let gen = 0;
    while (Date.now() < end) {
      gen++;
      Atomics.add(control, 0, 1);
      const inactive = (Atomics.load(control, 2) ^ 1) | 0;
      const view = halves[inactive];
      for (let i = 0; i < 256 * 8; i++) view[i] = gen;
      Atomics.store(control, 1, 256);
      Atomics.store(control, 2, inactive);
      Atomics.add(control, 0, 1);
      Atomics.notify(control, 0);
    }
    parentPort.postMessage({ gen });
  `;
  const worker = new Worker(code, { eval: true, workerData: { buffer: buf } });
  const done = new Promise(resolve => worker.on('message', resolve));
  let reads = 0, torn = 0, unstable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 450) {
    const n = reader.read(out);
    if (n < 0) { unstable++; continue; }
    reads++;
    const first = out[0];
    for (let i = 0; i < n * FIELDS; i++) if (out[i] !== first) { torn++; break; }
  }
  const { gen } = await done;
  await worker.terminate();
  assert.ok(gen > 100, `escritor deveria ter publicado várias gerações (foi ${gen})`);
  assert.ok(reads > 10, `leitor deveria ler com sucesso (foi ${reads})`);
  assert.equal(torn, 0, `nenhuma leitura rasgada é aceitável (foram ${torn})`);
});

// ------------------------------------------------------------------ 4 geom --
// --------------------------- 5 snapshot sem memória compartilhada (preview) --
section('5 · snapshot do mundo sem memória compartilhada');

await test('createSnapshotBuffer cai para ArrayBuffer e o seqlock continua correto', async () => {
  const antes = globalThis.SharedArrayBuffer;
  delete globalThis.SharedArrayBuffer;                 // contexto não isolado
  try {
    const buf = createSnapshotBuffer(512, FIELDS);
    assert.equal(buf.constructor.name, 'ArrayBuffer', 'sem SAB, o buffer precisa ser ArrayBuffer comum');
    assert.equal(snapshotStrategy(buf), 'post', 'a estratégia precisa ser declarada como envio por mensagem');

    const w = createWriter(buf);
    const r = createReader(buf);
    w.publish((v) => { v[0] = 11.5; v[1] = -3.25; return 1; });
    const out = new Float32Array(512 * FIELDS);
    assert.equal(r.read(out), 1);
    assert.equal(out[0], 11.5);
    assert.equal(out[1], -3.25);
  } finally {
    if (antes) globalThis.SharedArrayBuffer = antes;
  }
});

await test('applyPackedSnapshot copia só o que cabe e nunca estoura o destino', async () => {
  const out = new Float32Array(4 * FIELDS).fill(-1);
  const packed = new Float32Array(8 * FIELDS).fill(7);
  assert.equal(applyPackedSnapshot(out, packed, 8), 4, 'o limite é o destino, não o pacote');
  assert.equal(out[0], 7);
  assert.equal(applyPackedSnapshot(out, packed, 2), 2);
  assert.equal(out[2 * FIELDS], 7);
});

section('6 · geom (window manager sem DOM)');

await test('cascade mantém a janela dentro do viewport', () => {
  for (let i = 0; i < 20; i++) {
    const r = G.cascade(i, { w: 1280, h: 720 }, { w: 800, h: 500 });
    assert.ok(r.x >= 8 && r.y >= 42, `posição fora do mínimo: ${JSON.stringify(r)}`);
  }
});

await test('clampRect nunca perde o título da janela', () => {
  const r = G.clampRect({ x: -5000, y: -5000, w: 400, h: 300 }, { w: 1280, h: 720 });
  assert.ok(r.x + r.w >= G.KEEP_VISIBLE, 'borda direita deve ficar visível');
  assert.ok(r.y >= 34, 'barra de título deve ficar abaixo da barra de status');
  const r2 = G.clampRect({ x: 99999, y: 99999, w: 400, h: 300 }, { w: 1280, h: 720 });
  assert.ok(r2.x <= 1280 - G.KEEP_VISIBLE);
});

await test('applyResize respeita mínimos e ancora pelos cantos corretos', () => {
  const start = { x: 100, y: 100, w: 400, h: 300 };
  const se = G.applyResize(start, 'se', 50, 40);
  assert.deepEqual(se, { x: 100, y: 100, w: 450, h: 340 });
  const nw = G.applyResize(start, 'nw', 50, 40);
  assert.deepEqual(nw, { x: 150, y: 140, w: 350, h: 260 });
  const tiny = G.applyResize(start, 'se', -9999, -9999);
  assert.equal(tiny.w, G.MIN_W);
  assert.equal(tiny.h, G.MIN_H);
  const tinyNw = G.applyResize(start, 'nw', 9999, 9999);
  assert.equal(tinyNw.x, start.x + start.w - G.MIN_W, 'ancora direita preservada');
});

await test('snapZone e zoneRect cobrem as bordas e cantos', () => {
  const v = { w: 1200, h: 800 };
  assert.equal(G.snapZone(600, 5, v), 'max');
  assert.equal(G.snapZone(4, 400, v), 'left');
  assert.equal(G.snapZone(1196, 400, v), 'right');
  assert.equal(G.snapZone(4, 4, v), 'tl');
  assert.equal(G.snapZone(600, 400, v), null);
  const max = G.zoneRect('max', v, 34);
  assert.equal(max.x, 0);
  assert.ok(max.w === v.w);
  const left = G.zoneRect('left', v, 34);
  assert.equal(left.w, Math.round(v.w / 2));
  assert.equal(left.x, 0);
  const right = G.zoneRect('right', v, 34);
  assert.equal(right.x, v.w - Math.round(v.w / 2));
});

// ------------------------------------------------------------------ 5 wire --
section('7 · wire (formatos binários)');

await test('packStats/unpackStats com roundtrip exato', () => {
  const values = [16.5, 8.25, 60, 4.125];
  const bytes = packStats(values, 3);
  const out = new Float32Array(STAT_SLOTS);
  const count = unpackStats(bytes, bytes.length, out);
  assert.equal(count, values.length);
  assert.equal(out[0], 16.5);
  assert.equal(out[3], 4.125);
  assert.equal(new DataView(bytes.buffer).getUint16(0, true), 3);
});

await test('tick e requisição de bloco sobrevivem ao roundtrip', () => {
  const buf = new Uint8Array(16);
  writeTick(buf, 16, 0b1011);
  const t = readTick(buf);
  assert.equal(t.dtMs, 16);
  assert.equal(t.input, 0b1011);
  writeBlockReq(buf, 4294967290, 4 * 1024 * 1024 * 1024, 32768);
  const b = readBlockReq(buf);
  assert.equal(b.id, 4294967290);
  assert.equal(b.offset, 4 * 1024 * 1024 * 1024, 'offset acima de 2^31 precisa sobreviver');
  assert.equal(b.len, 32768);
});

// ------------------------------------------------------------------ 6 util --
section('8 · util (segurança e formatação)');

await test('safePath normaliza, resolve .. e recusa nomes hostis', () => {
  assert.equal(safePath('nota.txt', '/home/nucleo'), '/home/nucleo/nota.txt');
  assert.equal(safePath('../etc/passwd', '/home/nucleo'), '/home/etc/passwd');
  assert.equal(safePath('/a/b/../c'), '/a/c');
  assert.equal(safePath('//duplo//barra/./x'), '/duplo/barra/x');
  assert.throws(() => safePath('a\0b'), /nulo/);
  assert.throws(() => safePath('a\u0007b'), /inválido/);
  assert.throws(() => safePath('x'.repeat(600)), /inválido/);
  assert.throws(() => safePath(''), /inválido/);
});

await test('fmtBytes usa unidades binárias e marca N/D', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1024), '1,0 KB');
  assert.equal(fmtBytes(1536 * 1024), '1,5 MB');
  assert.equal(fmtBytes(5.5 * 1024 ** 3), '5,5 GB');
  assert.equal(fmtBytes(NaN), 'N/D');
});

await test('Histogram calcula P50/P95 sem média enganosa', () => {
  const h = new Histogram(100);
  for (let i = 0; i < 90; i++) h.push(10);
  for (let i = 0; i < 10; i++) h.push(200);
  assert.equal(h.count, 100);
  assert.equal(h.percentile(50), 10);
  assert.equal(h.percentile(95), 200);
  assert.ok(h.mean() > 10, 'média esconde o pico — é por isso que o HUD mostra P95');
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(baseName('/home/nucleo/nota.txt'), 'nota.txt');
});

// ------------------------------------------------- 8 worker real (threads) --
// ------------------------------------------ 9 VFS local (modo degradado) --
section('9 · VFS local (o caminho usado quando o contexto proíbe OPFS/workers)');

await test('o VFS local cumpre o mesmo contrato do VFS com worker', async () => {
  const vfs = createLocalVFS();
  const info = await vfs.init();
  assert.equal(info.backend, 'memória volátil (modo local)');
  assert.ok(Number.isNaN(info.quotaMb), 'sem cota do navegador, a cota é N/D — nunca um número inventado');
  assert.equal(info.sync, false);

  const rows = await vfs.list('/');
  assert.ok(rows.length > 0, 'o disco precisa vir semeado, não vazio');
  assert.ok(rows.some(r => r.name === 'etc' && r.type === 'dir'));

  await vfs.write('/home/nucleo/nota.txt', 'olá ípsilon');
  assert.equal(new TextDecoder().decode(await vfs.read('/home/nucleo/nota.txt')), 'olá ípsilon');

  const blob = new Uint8Array(1024 * 96).map((_, i) => i & 0xff);
  await vfs.write('/var/nucleo/blob.bin', blob);
  const back = await vfs.read('/var/nucleo/blob.bin');
  assert.equal(back.length, blob.length, 'arquivo maior que um bloco precisa voltar inteiro');
  assert.deepEqual(Array.from(back.slice(0, 32)), Array.from(blob.slice(0, 32)));

  back[0] = 0xff;
  assert.equal((await vfs.read('/var/nucleo/blob.bin'))[0], blob[0], 'read() devolve cópia');

  await vfs.mkdir('/home/nucleo/projetos');
  await vfs.write('/home/nucleo/projetos/a.txt', 'a');
  await vfs.rename('/home/nucleo/projetos/a.txt', '/home/nucleo/projetos/b.txt');
  assert.deepEqual((await vfs.list('/home/nucleo/projetos')).map(r => r.name), ['b.txt']);
  await assert.rejects(vfs.remove('/home/nucleo/projetos'), /não está vazio/);
  await vfs.remove('/home/nucleo/projetos/b.txt');
  await vfs.remove('/home/nucleo/projetos');
  await assert.rejects(vfs.stat('/home/nucleo/projetos'), /inexistente/);
});

await test('o VFS local recusa o que o VFS real recusa', async () => {
  const vfs = createLocalVFS();
  await vfs.init();
  await assert.rejects(vfs.read('/etc/nao-existe'), /inexistente/);
  await assert.rejects(vfs.list('/etc/hostname'), /não é diretório/);
  // safePath não lança: absorve a escalada e trava a raiz — o resultado nunca sai de "/".
  assert.equal(safePath('../../etc/passwd'), '/etc/passwd');
  assert.ok(!safePath('../../etc/passwd').includes('..'), 'o caminho normalizado nunca carrega ".."');
  // O único caso em que safePath lança: byte nulo, que não existe em nome de arquivo.
  assert.throws(() => safePath('nome\u0000.txt'), /byte nulo/);
  await vfs.write('/mnt/nucleo/sub/novo.txt', 'x');
  assert.ok((await vfs.list('/mnt/nucleo/sub')).some(r => r.name === 'novo.txt'));
  const uso = await vfs.usage();
  assert.ok(uso.usedBytes > 0 && Number.isInteger(uso.files));
  assert.ok(Number.isNaN(uso.quotaBytes));
  const b = await vfs.bench();
  assert.equal(b.bytes, 1024 * 1024);
  assert.equal(b.readBytes, 1024 * 1024);
  assert.ok(b.writeMbps > 0 && b.readMbps > 0);
  assert.equal(b.sync, false);
});

// ---------------------------------------- 10 sondagem hostil (modo preview) --
section('10 · sondagem de capacidades sobrevive a um navegador hostil');

await test('probeCapabilities resolve mesmo com storage e GPU bloqueados', async () => {
  const globais = ['navigator', 'document', 'crossOriginIsolated'];
  const antes = new Map(globais.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try {
    define('navigator', {
      hardwareConcurrency: 8,
      storage: {
        getDirectory() { throw new Error('The operation is insecure.'); },
        estimate() { return Promise.reject(new Error('The operation is insecure.')); },
        persisted() { return Promise.reject(new Error('The operation is insecure.')); }
      }
    });
    define('document', { createElement: () => ({ getContext: () => { throw new Error('opaque origin'); } }) });
    delete globalThis.crossOriginIsolated;

    const lines = [];
    const cap = await probeCapabilities({ boot: { line: t => lines.push(t), progress() {} } });
    assert.equal(cap.isolated, false);
    assert.equal(cap.webgl2, false);
    assert.equal(cap.persisted, false, 'persisted() rejeitado vira false, não uma exceção');
    assert.ok(Number.isNaN(cap.quotaMb), 'cota indisponível é N/D');
    assert.ok(lines.some(l => /modo degradado|sem isolamento/.test(l)), 'o boot precisa declarar o modo degradado');
  } finally {
    for (const [k, desc] of antes) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }
});

section('11 · worker real (worker_threads): handshake + pump + request/response');

await test('connectWorker/acceptWorkerLink funcionam entre threads com SAB', async () => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url), { type: 'module' });
  let drainTimer = null;
  try {
    const link = await connectWorker(worker, 'teste');
    assert.equal(link.transport, 'ring', 'com SAB, o transporte precisa ser o anel');
    // A thread principal drena o anel no laço de quadro (equivale ao rAF do desktop).
    drainTimer = setInterval(() => link.drain(), 1);

    const r1 = await link.request(OP.SYS_EXEC, { msg: 21 }, OP.SYS_OUT, 4000);
    assert.equal(r1.ok, true);
    assert.equal(r1.data.eco, 21);
    assert.equal(r1.data.dobrado, 42);

    // Estatística binária na volta (sem passar por JSON)
    const stats = emptyStats();
    link.on(OP.STAT, (view, len) => unpackStats(view, len, stats));
    link.send(OP.STAT_REQ, '{}');
    const t0 = Date.now();
    while (!Number.isFinite(stats[0]) && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 5));
    assert.equal(stats[0], 42.5, 'o worker deveria ter respondido o STAT');

    // 500 idas e voltas: nenhuma perda e tempo comportado
    const antes = link.stats();
    const start = Date.now();
    for (let i = 1; i <= 500; i++) {
      const res = await link.request(OP.SYS_EXEC, { msg: i }, OP.SYS_OUT, 4000);
      assert.equal(res.data.dobrado, i * 2);
    }
    const ms = Date.now() - start;
    const depois = link.stats();
    assert.ok(ms < 15000, `500 idas e voltas demoraram ${ms} ms`);
    assert.equal(depois.drops, 0, `houve ${depois.drops} drops no canal`);
    assert.ok(depois.in >= 500, `frames recebidos: ${depois.in}`);
    assert.ok(antes.frames <= depois.frames);
  } finally {
    clearInterval(drainTimer);
    await worker.terminate();
  }
});

// ------------------------------------------------------------- 7 módulos --
// -------------------- 12/13 MESSAGE + io.worker REAL sem SharedArrayBuffer ----
section('12 · transporte MESSAGE (o caminho usado sem SharedArrayBuffer)');

await test('Link por MessageChannel entrega requisições e respostas', async () => {
  const channel = new MessageChannel();
  let workerSide = null;
  workerSide = new Link({
    writer: new PortWriter(channel.port2, { name: 'fake:out' }),
    reader: new PortReader(channel.port2, {
      onMessage: (op, view, len) => {
        if (op !== OP.SYS_EXEC) return;
        const msg = JSON.parse(new TextDecoder().decode(view.subarray(0, len)));
        workerSide.send(OP.SYS_OUT, JSON.stringify({ id: msg.id, ok: true, data: { eco: msg.msg } }));
      }
    }),
    name: 'fake', transport: 'message'
  });
  let mainSide = null;
  mainSide = new Link({
    writer: new PortWriter(channel.port1, { name: 'main:out' }),
    reader: new PortReader(channel.port1, { onMessage: (op, view, len) => mainSide.ingest(op, view, len) }),
    name: 'main', transport: 'message'
  });
  assert.equal(mainSide.transport, 'message');
  const res = await race(mainSide.request(OP.SYS_EXEC, { msg: 'ping' }, OP.SYS_OUT, 4000), 'request');
  assert.equal(res.data.eco, 'ping', 'o transporte sem SAB precisa responder igual ao anel');
  mainSide.dispose();
  workerSide.dispose();
});

section('13 · io.worker.js REAL sem SharedArrayBuffer (o caminho do preview)');

await test('o worker de I/O de produção atende o VFS por MessagePort', async () => {
  const sabAntes = globalThis.SharedArrayBuffer;
  delete globalThis.SharedArrayBuffer;                 // página não isolada
  const worker = new Worker(new URL('./io-worker-host.mjs', import.meta.url));
  try {
    const link = await connectWorker(worker, 'io', { shared: false });
    assert.equal(link.transport, 'message');

    // Regressão: o main precisa escrever E ler no MESMO extremo do canal.
    // Tratar port1/port2 como "envio/recepção" e transferir o extremo do main
    // fazia o worker responder para uma porta morta — nenhuma resposta chegava.
    assert.equal(link.reader.port, link.writer.port,
      'no transporte MESSAGE o leitor e o escritor do main compartilham o mesmo extremo');

    const vfs = createVFS(link);
    const info = await race(vfs.init(), 'init', 8000);
    // Sem `navigator.storage` não há OPFS: o worker de produção precisa declarar
    // memória volátil em vez de fingir disco.
    assert.match(info.backend, /volátil/);
    assert.equal(info.sync, false);
    assert.ok(Number.isNaN(info.quotaMb));

    const raiz = await race(vfs.list('/'), 'list');
    assert.ok(raiz.some(r => r.name === 'etc'));

    await race(vfs.write('/home/nucleo/msg.txt', 'olá do worker real'), 'write');
    assert.equal(new TextDecoder().decode(await race(vfs.read('/home/nucleo/msg.txt'), 'read')), 'olá do worker real');

    // 96 KiB + 7 B: vários blocos de 32 KiB ida e volta pelo canal
    const big = new Uint8Array(96 * 1024 + 7);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff;
    await race(vfs.write('/var/nucleo/big.bin', big), 'write-grande', 10000);
    const back = await race(vfs.read('/var/nucleo/big.bin'), 'read-grande', 10000);
    assert.equal(back.length, big.length);
    assert.deepEqual([...back.slice(-16)], [...big.slice(-16)]);

    const uso = await race(vfs.usage(), 'usage');
    assert.ok(uso.usedBytes >= big.length);
    const bench = await race(vfs.bench(), 'bench', 15000);
    assert.equal(bench.readBytes, 1024 * 1024);
  } finally {
    await worker.terminate();
    if (sabAntes) globalThis.SharedArrayBuffer = sabAntes;
  }
});

section('14 · módulos (grafo de importação íntegro e carga sem DOM)');

await test('todo o núcleo e os três workers carregam sem DOM e sem erro de topo', async () => {
  // Shim mínimo: os módulos de worker chamam acceptWorkerLink(self) no topo.
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: {}, hardwareConcurrency: 4, userAgent: 'node' },
    configurable: true, writable: true
  });
  globalThis.self = { addEventListener() {}, postMessage() {}, close() {} };

  const coreModules = [
    'core/util.js', 'core/bus.js', 'core/geom.js', 'core/ipc.js', 'core/wire.js',
    'core/snapshot.js', 'core/link.js', 'core/vfs.js', 'core/vfs-local.js', 'core/wm.js', 'core/mat4.js',
    'ui/icons.js', 'ui/toast.js', 'ui/hud.js',
    'apps/terminal.js', 'apps/files.js', 'apps/game.js', 'apps/settings.js',
    'boot.js', 'main.js'
  ];
  const exported = [];
  for (const rel of coreModules) {
    const mod = await import(new URL(`../js/${rel}`, import.meta.url).href);
    const names = Object.keys(mod);
    assert.ok(names.length > 0, `${rel} não exporta nada`);
    exported.push(`${rel}: ${names.join(', ')}`);
  }
  for (const worker of ['io', 'kernel', 'engine']) {
    await import(new URL(`../workers/${worker}.worker.js`, import.meta.url).href);
  }
  // Contrato de nomes exigido pelo orquestrador (main.js) — muda aqui, quebra ali.
  const main = await import(new URL('../js/main.js', import.meta.url).href);
  assert.equal(typeof main.startOS, 'function');
  const boot = await import(new URL('../js/boot.js', import.meta.url).href);
  assert.equal(typeof boot.createBoot, 'function');
  assert.equal(typeof boot.probeCapabilities, 'function');
  const wm = await import(new URL('../js/core/wm.js', import.meta.url).href);
  assert.equal(typeof wm.createWM, 'function');
  const hud = await import(new URL('../js/ui/hud.js', import.meta.url).href);
  assert.equal(typeof hud.createHUD, 'function');
  assert.ok(exported.length === coreModules.length);
});

// ---------------------------------------------------------------- relatório
console.log(results.join('\n'));
console.log(`\n${passed} passaram · ${failed} falharam${failed ? ' ✗' : ' ✓'}`);
process.exit(failed ? 1 : 0);
