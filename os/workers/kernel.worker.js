/**
 * SECTOR OS — workers/kernel.worker.js
 * vCPU do subsistema Linux.
 *
 * HONESTIDADE (docs/00 §6): a carga aqui é **SIM** — um laço de trabalho real
 * com dados reais, instrumentado de verdade (o HUD mostra o que este worker
 * consome, não um número decorativo). O runtime Linux completo (v86 ou
 * equivalente) entra pela fase F4 atrás do mesmo adaptador `mountRuntime`,
 * e o WM/terminal não mudam.
 *
 * Slots de estatística deste worker: 0=ms/tick · 1=ticks · 2=carga (0..1) · 3=workers internos
 */

import { OP } from './../js/core/ipc.js';
import { acceptWorkerLink } from './../js/core/link.js';

const N = 1 << 18;                       // 262 144 células de trabalho
const work = new Float32Array(N);
const next = new Float32Array(N);
let load = 0.5;                          // fração de trabalho por tick (0..1)
let tickMs = 0, ticks = 0, tickMax = 0, paused = false;

// Estado inicial determinístico (sem alocação depois disto).
for (let i = 0; i < N; i++) work[i] = ((i * 2654435761) % 1000) / 1000;

/** Um tick de "sistema": difusão discreta com fronteiras fixas (carga real). */
function tick() {
  const t0 = performance.now();
  const n = Math.max(1024, (N * load) | 0);
  for (let i = 1; i < n - 1; i++) next[i] = work[i] + 0.02 * (work[i - 1] + work[i + 1] - 2 * work[i]);
  for (let i = 1; i < n - 1; i++) work[i] = next[i];
  const dt = performance.now() - t0;
  tickMs = tickMs ? tickMs * 0.85 + dt * 0.15 : dt;
  tickMax = Math.max(tickMax, dt);
  ticks++;
  return dt;
}

const COMMANDS = {
  uname: () => 'SECTOR-KRN sim-0.4.0 wasm32 #1 SMP\n',
  uptime: () => `ticks ${ticks} · carga ${(load * 100).toFixed(0)}%\n`,
  stress: args => {
    const target = Math.min(200, Number(args[0]) || 25);
    const t0 = performance.now();
    let rounds = 0;
    while (performance.now() - t0 < target) { tick(); rounds++; }
    return `estresse por ${target} ms → ${rounds} ticks, pior ${tickMax.toFixed(1)} ms\n`;
  },
  pause: () => { paused = true; return 'vCPU pausada\n'; },
  resume: () => { paused = false; return 'vCPU ativa\n'; },
  load: args => {
    const v = Number(args[0]);
    if (!Number.isFinite(v)) return `carga atual: ${(load * 100).toFixed(0)}%\n`;
    load = Math.min(1, Math.max(0, v / 100));
    return `carga definida para ${(load * 100).toFixed(0)}%\n`;
  },
  halt: () => { stopRequested = true; return 'encerrando vCPU…\n'; }
};

let chain = Promise.resolve();
const serial = fn => { chain = chain.then(fn).catch(e => console.error('[krn]', e)); return chain; };

acceptWorkerLink(self, {
  onReady(link) {
    link.on(OP.SYS_EXEC, (view, len) => {
      const text = new TextDecoder().decode(view.subarray(0, len));
      serial(async () => {
        const [cmd, ...args] = text.trim().split(/\s+/);
        let id = 0;
        try { id = JSON.parse(text).id ?? 0; } catch { /* comando cru do terminal */ }
        const fn = COMMANDS[cmd];
        const out = fn ? fn(args) : `kern: comando desconhecido: ${cmd}\n(disponível: ${Object.keys(COMMANDS).join(', ')})\n`;
        link.send(OP.SYS_OUT, JSON.stringify({ id, ok: Boolean(fn), text: out }));
      });
    });
    link.on(OP.CFG, (view, len) => {
      const cfg = JSON.parse(new TextDecoder().decode(view.subarray(0, len)));
      if (Number.isFinite(cfg.load)) load = Math.min(1, Math.max(0, cfg.load));
      if (typeof cfg.paused === 'boolean') paused = cfg.paused;
    });
    link.on(OP.STAT_REQ, () => {
      const buf = new ArrayBuffer(4 + 16 * 4);
      const dv = new DataView(buf);
      dv.setUint16(2, 16, true);
      [tickMs, ticks, load, 1].forEach((v, i) => dv.setFloat32(4 + i * 4, v, true));
      link.send(OP.STAT, new Uint8Array(buf));
    });

    self.postMessage({ type: 'sector-log', name: 'w-kernel', text: 'vCPU simulada pronta (runtime Linux: fase F4)' });

    // Laço de trabalho: acorda no notify do main (ou no teto de tempo) e executa
    // um tick de vCPU. Assíncrono para não congelar os handlers do worker.
    link.reader.pump(() => { if (!paused) tick(); }, { timeoutMs: 33 })
      .catch(e => console.error('[krn] pump', e));
    return () => { stopRequested = true; link.reader.close(); };
  }
});
