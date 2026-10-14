/**
 * SECTOR OS — ui/hud.js
 * HUD de telemetria (§6.7). Atualiza 2 Hz, nunca por quadro: dado que pisca a
 * 60 Hz é ilegível e custa caro. Toda métrica indisponível aparece como N/D com
 * o motivo no rodapé — o HUD não inventa número (Design System §1.4).
 *
 * Zero realocação: os nós de texto são criados uma vez e só recebem textContent.
 */

import { el, fmt1, fmtInt, fmtBytes } from '../core/util.js';

const PEAK = 60;

export function createHUD({ host, onClose, hudThresholds = { warn: 0.7, crit: 0.92 } }) {
  const spark = el('canvas', { class: 'spark', width: 300, height: 34 });
  const ctx = spark.getContext('2d', { alpha: true });   // pode ser null (canvas off)
  const fpsHist = new Float32Array(120);
  let fpsIdx = 0, fpsLen = 0;

  const make = (k, unit = '') => {
    const v = el('span', { class: 'v' });
    const bar = el('i');
    return {
      row: el('div', { class: 'mrow' }, el('span', { class: 'k', text: k }), v, el('div', { class: 'bar' }, bar)),
      v, bar, unit
    };
  };

  const sys = {
    fps: make('fps'), frame: make('quadro p50'), p95: make('quadro p95'), heap: make('heap js')
  };
  const sub = {
    kernel: el('div', { class: 'wrow' }, el('span', { class: 'nm' }, el('i', { class: 'dot' }), el('span', { text: 'w-kernel' })), el('span', { class: 'ms', text: '—' }), el('span', { class: 'ms', text: '' })),
    engine: el('div', { class: 'wrow' }, el('span', { class: 'nm' }, el('i', { class: 'dot' }), el('span', { text: 'w-engine' })), el('span', { class: 'ms', text: '—' }), el('span', { class: 'ms', text: '' })),
    io: el('div', { class: 'wrow' }, el('span', { class: 'nm' }, el('i', { class: 'dot' }), el('span', { text: 'w-io' })), el('span', { class: 'ms', text: '—' }), el('span', { class: 'ms', text: '' }))
  };
  const subCells = {
    kernel: [sub.kernel.children[1], sub.kernel.children[2], sub.kernel.children[0].children[0]],
    engine: [sub.engine.children[1], sub.engine.children[2], sub.engine.children[0].children[0]],
    io: [sub.io.children[1], sub.io.children[2], sub.io.children[0].children[0]]
  };

  const disk = make('vmfs usado');
  const transport = el('span', { class: 'v', text: '—' });
  const backend = el('span', { class: 'v', text: '—' });
  const queue = el('span', { class: 'v', text: '—' });
  const note = el('div', { class: 'hudnote' });

  const panel = el('aside', { class: 'hud glass', role: 'complementary', 'aria-label': 'Telemetria de desempenho' },
    el('h3', {}, el('span', { text: 'telemetria' }), el('button', { class: 'close', 'aria-label': 'Fechar HUD', onclick: () => onClose?.(), text: '✕' })),
    el('h3', {}, el('span', { text: 'sistema' })),
    sys.fps.row, sys.frame.row, sys.p95.row, sys.heap.row,
    spark,
    el('h3', {}, el('span', { text: 'subsistemas' })),
    el('div', { class: 'wlist' }, sub.kernel, sub.engine, sub.io),
    el('h3', {}, el('span', { text: 'disco e transporte' })),
    disk.row,
    el('div', { class: 'mrow' }, el('span', { class: 'k', text: 'transporte' }), transport),
    el('div', { class: 'mrow' }, el('span', { class: 'k', text: 'backend gpu' }), backend),
    el('div', { class: 'mrow' }, el('span', { class: 'k', text: 'fila de requests' }), queue),
    note
  );
  host.append(panel);

  function level(v, budget) {
    if (!Number.isFinite(v)) return '';
    const r = v / budget;
    return r > hudThresholds.crit ? 'crit' : r > hudThresholds.warn ? 'warn' : '';
  }

  function setRow(cell, value, unit, budget) {
    if (!Number.isFinite(value)) { cell.v.textContent = 'N/D'; cell.v.classList.add('nd'); cell.bar.style.width = '0%'; return; }
    cell.v.classList.remove('nd');
    cell.v.replaceChildren(document.createTextNode(unit === 'fps' ? fmtInt(value) : fmt1(value)), el('small', { text: ` ${unit}` }));
    if (budget) {
      cell.bar.style.width = `${Math.min(100, (value / budget) * 100).toFixed(0)}%`;
      cell.bar.className = level(value, budget);
    }
  }

  function drawSpark() {
    if (!ctx) return;                    // sem contexto 2D: o HUD segue com números
    const w = spark.width, h = spark.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,150,180,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of [h * 0.25, h * 0.5]) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    if (fpsLen < 2) return;
    ctx.strokeStyle = '#35f0ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < fpsLen; i++) {
      const v = fpsHist[(fpsIdx + i) % fpsHist.length];
      const x = (i / (fpsHist.length - 1)) * w;
      const y = h - Math.min(1, v / 90) * (h - 2) - 1;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  let visible = false;
  const api = {
    get visible() { return visible; },
    show() { visible = true; panel.classList.add('show'); drawSpark(); },
    hide() { visible = false; panel.classList.remove('show'); },
    toggle() { visible ? api.hide() : api.show(); },
    /** @param {object} m métricas agregadas (main + workers) */
    update(m) {
      fpsHist[fpsIdx] = m.fps;
      fpsIdx = (fpsIdx + 1) % fpsHist.length;
      fpsLen = Math.min(fpsLen + 1, fpsHist.length);
      setRow(sys.fps, m.fps, 'fps', 60);
      setRow(sys.frame, m.frameP50, 'ms', 16.6);
      setRow(sys.p95, m.frameP95, 'ms', 16.6);
      setRow(sys.heap, m.heapMb, 'MB', 1024);
      setRow(disk, m.diskMb, 'MB', m.diskQuotaMb > 0 ? m.diskQuotaMb : 0);

      const cells = [
        ['kernel', m.kernelMs, Number.isFinite(m.kernelTicks) ? `${fmtInt(m.kernelTicks)} ticks` : ''],
        ['engine', m.simMs, Number.isFinite(m.entities) ? `${fmtInt(m.entities)} ent` : ''],
        ['io', m.ioMs, Number.isFinite(m.ioMbps) ? `${fmt1(m.ioMbps)} MB/s` : '']
      ];
      for (const [key, ms, extra] of cells) {
        const [a, b, dot] = subCells[key];
        const txt = Number.isFinite(ms) ? `${fmt1(ms)} ms` : '—';
        if (a.textContent !== txt) a.textContent = txt;
        if (b.textContent !== extra) b.textContent = extra;
        dot.className = `dot${Number.isFinite(ms) ? (ms > 8 ? ' warn breathe' : ' on') : ''}`;
      }

      if (transport.textContent !== m.transport) transport.textContent = m.transport;
      if (backend.textContent !== m.backend) backend.textContent = m.backend;
      queue.textContent = Number.isFinite(m.queue) ? `${fmtInt(m.queue)}` : 'N/D';
      note.textContent = `VRAM: N/D — não é exposta pelo navegador. ${m.heapNote || ''} Amostragem 2 Hz; P95 evita esconder travamento.`;
      if (visible) drawSpark();
    },
    /** Estatística honesta de cota/uso. */
    diskLabel(usage) {
      if (!usage || !Number.isFinite(usage.quotaMb)) return 'N/D';
      return `${fmtBytes(usage.usedMb * 1048576, 0)} / ${fmtBytes(usage.quotaMb * 1048576, 0)}`;
    }
  };
  return api;
}
