/**
 * SECTOR OS — workers/engine.worker.js
 * Núcleo do motor: ECS planar (SoA), passo fixo de 120 Hz com acumulador,
 * tráfego com *car following* por faixa e broadphase por faixa (counting sort).
 * Publica o estado em snapshot lock-free (core/snapshot.js) para o renderizador.
 *
 * O que é medido é o que acontece: `simMs` é o custo real do passo de física e
 * `aiMs` o custo real da IA de tráfego — os dois aparecem no HUD.
 *
 * Slots de estatística: 0=simMs 1=aiMs 2=entidades 3=ticks 4=pior tick
 */

import { OP } from './../js/core/ipc.js';
import { acceptWorkerLink } from './../js/core/link.js';
import { createWriter } from './../js/core/snapshot.js';
import { readTick } from './../js/core/wire.js';

const STEP = 1 / 120;             // passo fixo (docs/00 §1.3)
const WORLD = 640;                // meio-lado do mundo em unidades
const LANE_GAP = 40;              // vias a cada 40 unidades
const MAX_AGENTS = 4096;

// --- ECS em SoA: nenhum objeto por entidade ------------------------------
const px = new Float32Array(MAX_AGENTS);
const pz = new Float32Array(MAX_AGENTS);
const vx = new Float32Array(MAX_AGENTS);
const vz = new Float32Array(MAX_AGENTS);
const sp = new Float32Array(MAX_AGENTS);
const axis = new Int8Array(MAX_AGENTS);      // 0:+x 1:+z 2:-x 3:-z
const lane = new Int16Array(MAX_AGENTS);     // coordenada fixa da faixa
const kind = new Float32Array(MAX_AGENTS);
const want = new Float32Array(MAX_AGENTS);   // velocidade desejada

// Ordenação por faixa (counting sort) + ordenação por posição (insertion sort).
const laneKey = new Int32Array(MAX_AGENTS);
const order = new Int32Array(MAX_AGENTS);
const counts = new Int32Array(4096);   // 4 eixos × 1024 faixas
const laneCount = 1024;

let count = 0;
let accumulator = 0;
let simMs = 0, aiMs = 0, ticks = 0, tickMax = 0;
let snapshot = null, writer = null;

// --- geração determinística ---------------------------------------------
function buildSeed() {
  let s = 0x9e3779b9;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < MAX_AGENTS; i++) {
    const a = (i % 4);
    const laneIdx = Math.floor(rnd() * (WORLD / LANE_GAP)) * LANE_GAP - WORLD / 2 + LANE_GAP / 2;
    axis[i] = a;
    lane[i] = Math.round(laneIdx) + (a % 2 ? 4 : -4);
    const s0 = rnd() * WORLD - WORLD / 2;
    if (a === 0 || a === 2) { px[i] = s0; pz[i] = lane[i]; } else { px[i] = lane[i]; pz[i] = s0; }
    const speed = 8 + rnd() * 10;
    want[i] = speed;
    sp[i] = speed;
    kind[i] = rnd() < 0.35 ? 0 : rnd() < 0.9 ? 1 : 2;
    if (a === 0) { vx[i] = 1; vz[i] = 0; }
    else if (a === 1) { vx[i] = 0; vz[i] = 1; }
    else if (a === 2) { vx[i] = -1; vz[i] = 0; }
    else { vx[i] = 0; vz[i] = -1; }
  }
  count = MAX_AGENTS;
}

function laneIndexOf(i) {
  const a = axis[i];
  const l = Math.round((lane[i] + WORLD / 2) / LANE_GAP);
  return a * laneCount + Math.min(laneCount - 1, Math.max(0, l));
}

function position(i) {
  return (axis[i] === 0 || axis[i] === 2) ? px[i] : pz[i];
}

/** Passo de simulação: física + IA de tráfego. Custo real medido. */
function step(dt) {
  const t0 = performance.now();

  // 1) integração e wrap do mundo
  for (let i = 0; i < count; i++) {
    const a = axis[i];
    const v = sp[i] * dt;
    if (a === 0 || a === 2) {
      px[i] += vx[i] * v;
      if (px[i] > WORLD / 2) px[i] -= WORLD;
      else if (px[i] < -WORLD / 2) px[i] += WORLD;
    } else {
      pz[i] += vz[i] * v;
      if (pz[i] > WORLD / 2) pz[i] -= WORLD;
      else if (pz[i] < -WORLD / 2) pz[i] += WORLD;
    }
  }
  const t1 = performance.now();
  simMs = simMs * 0.85 + (t1 - t0) * 0.15;

  // 2) IA: counting sort por faixa, insertion sort por posição, car following
  counts.fill(0, 0, laneCount * 4);
  for (let i = 0; i < count; i++) laneKey[i] = laneIndexOf(i);
  for (let i = 0; i < count; i++) counts[laneKey[i]]++;
  let acc = 0;
  for (let k = 0; k < laneCount * 4; k++) { const c = counts[k]; counts[k] = acc; acc += c; }
  for (let i = 0; i < count; i++) order[counts[laneKey[i]]++] = i;

  for (let k = 0; k < laneCount * 4; k++) {
    const start = k === 0 ? 0 : counts[k - 1];
    const end = k === 0 ? counts[0] : counts[k];
    // insertion sort por posição dentro da faixa (grupos pequenos)
    for (let i = start + 1; i < end; i++) {
      const key = order[i];
      const keyPos = position(key);
      let j = i - 1;
      while (j >= start && position(order[j]) > keyPos) { order[j + 1] = order[j]; j--; }
      order[j + 1] = key;
    }
    // car following: quem está atrás ajusta a velocidade pela distância do da frente
    for (let i = start; i < end; i++) {
      const me = order[i];
      let target = want[me];
      if (i + 1 < end) {
        const leader = order[i + 1];
        let gap = position(leader) - position(me);
        if (gap < 0) gap += WORLD;                 // faixa dá a volta no mundo
        if (gap < 14) target = Math.min(target, want[leader] * (gap / 14));
      }
      sp[me] += (target - sp[me]) * Math.min(1, dt * (i + 1 < end ? 3 : 2));
      if (sp[me] < 0.5) sp[me] = 0.5;
    }
  }
  const t2 = performance.now();
  aiMs = aiMs * 0.85 + (t2 - t1) * 0.15;

  ticks++;
  const total = t2 - t0;
  if (total > tickMax) tickMax = total;
}

/** Publica o estado para o renderizador sem cópia intermediária. */
function publish() {
  if (!writer) return;
  writer.publish((view, capacity) => {
    const n = Math.min(count, capacity);
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      view[o] = px[i];
      view[o + 1] = pz[i];
      view[o + 2] = 0;
      view[o + 3] = vx[i];
      view[o + 4] = 0;
      view[o + 5] = vz[i];
      view[o + 6] = sp[i];
      view[o + 7] = kind[i];
    }
    return n;
  });
}

function setCount(n) {
  const next_ = Math.min(MAX_AGENTS, Math.max(0, n | 0));
  count = next_;
}

buildSeed();

let chain = Promise.resolve();
const serial = fn => { chain = chain.then(fn).catch(e => console.error('[eng]', e)); return chain; };

acceptWorkerLink(self, {
  onReady(link) {
    // O snapshot é um SharedArrayBuffer: viaja por postMessage, não por JSON.
    self.addEventListener('message', event => {
      const data = event.data;
      if (data?.type !== 'sector-config') return;
      if (data.snapshot) {
        snapshot = data.snapshot;
        writer = createWriter(snapshot);
        publish();
      }
      if (Number.isFinite(data.entities)) setCount(data.entities);
    });

    link.on(OP.CFG, (view, len) => {
      const cfg = JSON.parse(new TextDecoder().decode(view.subarray(0, len)));
      if (Number.isFinite(cfg.entities)) setCount(cfg.entities);
    });

    link.on(OP.TICK, (view, len) => {
      if (len < 6) return;
      const { dtMs } = readTick(view);
      serial(() => {
        accumulator += Math.min(dtMs, 100) / 1000;
        let steps = 0;
        while (accumulator >= STEP && steps < 8) { step(STEP); accumulator -= STEP; steps++; }
        if (steps === 8) accumulator = 0;      // nunca acumula dívida infinita
        publish();
        const report = new Uint8Array(12);
        const dv = new DataView(report.buffer);
        dv.setUint16(0, Math.min(65535, Math.round(simMs * 100)), true);
        dv.setUint16(2, Math.min(65535, Math.round(aiMs * 100)), true);
        dv.setUint32(4, count, true);
        dv.setFloat32(8, Math.min(65535, tickMax), true);
        link.send(OP.TICK_REPORT, report);
      });
    });

    link.on(OP.STAT_REQ, () => {
      const buf = new ArrayBuffer(4 + 16 * 4);
      const dv = new DataView(buf);
      dv.setUint16(2, 16, true);
      [simMs, aiMs, count, ticks, tickMax].forEach((v, i) => dv.setFloat32(4 + i * 4, v, true));
      link.send(OP.STAT, new Uint8Array(buf));
    });

    // Laço de bombeamento: waitAsync mantém o event loop vivo para os handlers
    // assíncronos (Atomics.wait bloqueante congelaria microtasks).
    link.reader.pump().catch(e => console.error('[eng] pump', e));
    return () => { stopRequested = true; link.reader.close(); };
  }
});

