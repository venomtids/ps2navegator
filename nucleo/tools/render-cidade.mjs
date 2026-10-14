/**
 * NÚCLEO OS — tools/render-cidade.mjs
 * Renderiza UM quadro da janela "Cidade — motor 3D" sem navegador e grava um PNG.
 *
 * O que é REAL neste caminho:
 *   • `workers/engine.worker.js` rodando numa thread do Node (tools/engine-worker-host.mjs)
 *     com o protocolo de produção (js/core/link.js, transporte MESSAGE), recebendo TICK
 *     de verdade — o tráfego desenhado é o tráfego simulado, não uma lista inventada;
 *   • `js/apps/game.js` inteiro: mesma câmera, mesma matriz (js/core/mat4.js), mesmo
 *     `fillInstances()`, mesma geometria (`makeCubeData`, `buildCity`) e as mesmas
 *     cores. Só o rasterizador é deste arquivo.
 *
 * O que NÃO é exercitado aqui (e está declarado no relatório): o caminho WebGL2. Não há
 * GPU no Node, então este quadro sai do degrau 2 da escada (software 2D). O objetivo é
 * provar que a cena tem cidade e movimento — não medir desempenho.
 *
 * Uso:
 *   node tools/render-cidade.mjs [--largura 960] [--altura 540] [--ticks 90] [--ms 1400]
 *                                [--saida cidade-frame.png] [--entidades 256] [--semente 0x51c7]
 */

import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { connectWorker } from '../js/core/link.js';
import { OP } from '../js/core/ipc.js';
import { writeTick } from '../js/core/wire.js';

// ------------------------------------------------------------------ argumentos --
function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : padrao;
}
const LARGURA = Number(arg('largura', 960));
const ALTURA = Number(arg('altura', 540));
const TICKS = Number(arg('ticks', 90));
const JANELA_MS = Number(arg('ms', 1400));
const SAIDA = arg('saida', 'cidade-frame.png');
const ENTIDADES = Number(arg('entidades', 256));
const CAM = arg('cam', '').split(',').map(Number);
const camera = CAM.length === 5 && CAM.every(Number.isFinite)
  ? { x: CAM[0], y: CAM[1], z: CAM[2], yaw: CAM[3], pitch: CAM[4] } : null;

// --------------------------------------------------------------- rasterizador --
const parseCor = txt => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(String(txt));
  if (!m) return [0, 0, 0, 1];
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
};

class Raster {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  misturar(x, y, cor) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const a = cor[3];
    if (a <= 0) return;
    const i = (y * this.w + x) * 4, inv = 1 - a;
    this.data[i] = cor[0] * a + this.data[i] * inv;
    this.data[i + 1] = cor[1] * a + this.data[i + 1] * inv;
    this.data[i + 2] = cor[2] * a + this.data[i + 2] * inv;
    this.data[i + 3] = 255;
  }
  retangulo(x, y, w, h, cor) {
    for (let j = Math.floor(y); j < y + h; j++) for (let i = Math.floor(x); i < x + w; i++) this.misturar(i, j, cor);
  }
  /** Preenchimento por varredura, regra par-ímpar (serve para os quads convexos). */
  poligono(pontos, cor) {
    if (pontos.length < 3) return;
    let yMin = Infinity, yMax = -Infinity;
    for (const p of pontos) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
    const y0 = Math.max(0, Math.floor(yMin)), y1 = Math.min(this.h - 1, Math.ceil(yMax));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const sy = y + 0.5;
      for (let i = 0; i < pontos.length; i++) {
        const a = pontos[i], b = pontos[(i + 1) % pontos.length];
        if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
          xs.push(a[0] + (sy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xi = Math.max(0, Math.ceil(xs[k] - 0.5)), xf = Math.min(this.w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xi; x <= xf; x++) this.misturar(x, y, cor);
      }
    }
  }
  linha(x0, y0, x1, y1, cor, largura = 1) {
    const passos = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const raio = Math.max(0, (largura - 1) / 2);
    for (let i = 0; i <= passos; i++) {
      const t = passos ? i / passos : 0;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let dy = -raio; dy <= raio; dy++) for (let dx = -raio; dx <= raio; dx++) this.misturar(x + dx, y + dy, cor);
    }
  }
}

/** Canvas falso: expõe o contrato que `js/apps/game.js` usa, sem DOM. */
function canvasFalso(raster, largura, altura) {
  const ctx = {
    set fillStyle(v) { ctx.__fill = parseCor(v); ctx.__fillTxt = v; },
    get fillStyle() { return ctx.__fillTxt; },
    set strokeStyle(v) { ctx.__stroke = parseCor(v); ctx.__strokeTxt = v; },
    get strokeStyle() { return ctx.__strokeTxt; },
    lineWidth: 1, __fill: [255, 255, 255, 1], __stroke: [255, 255, 255, 1],
    __fillTxt: '#fff', __strokeTxt: '#fff',
    chamadas: { fill: 0, stroke: 0, fillRect: 0, fillText: 0 },
    pontos: [], __exemplos: [], __maiores: [], __porCor: new Map(), quadro: 0, __fora: 0, __dentro: 0,
    __debug: process.argv.includes('--debug'),
    setTransform() {}, save() {}, restore() {},
    beginPath() { ctx.pontos.length = 0; },
    moveTo(x, y) { ctx.pontos.push([[x, y]]); },
    lineTo(x, y) { if (!ctx.pontos.length) ctx.pontos.push([]); ctx.pontos.at(-1).push([x, y]); },
    closePath() {},
    fill() {
      for (const sub of ctx.pontos) {
        if (sub.length < 3) continue;
        const xs = sub.map(p => p[0]), ys = sub.map(p => p[1]);
        const bbox = {
          largura: (Math.max(...xs) - Math.min(...xs)) | 0,
          altura: (Math.max(...ys) - Math.min(...ys)) | 0,
          x: Math.min(...xs) | 0, y: Math.min(...ys) | 0,
          cor: ctx.__fillTxt, n: sub.length
        };
        if (ctx.__debug && ctx.__exemplos.length < 4) {
          ctx.__exemplos.push(`  ${bbox.n} pontos · x ${bbox.x}..${bbox.x + bbox.largura} · y ${bbox.y}..${bbox.y + bbox.altura} · ${bbox.cor}`);
        }
        // As 4 MAIORES faces do quadro (por área da caixa): é o que mede se a cidade
        // realmente ocupa a tela, em vez de depender da ordem de desenho.
        const area = bbox.largura * bbox.altura;
        ctx.__maiores.push({ area, ...bbox });
        ctx.__maiores.sort((p, q) => q.area - p.area);
        if (ctx.__maiores.length > 4) ctx.__maiores.length = 4;
        const fora = bbox.x + bbox.largura < 0 || bbox.y + bbox.altura < 0 || bbox.x > raster.w || bbox.y > raster.h;
        if (fora) ctx.__fora++; else ctx.__dentro++;
        const chave = ctx.__fillTxt;
        ctx.__porCor.set(chave, (ctx.__porCor.get(chave) || 0) + Math.max(0, bbox.largura) * Math.max(0, bbox.altura));
        raster.poligono(sub, ctx.__fill);
        ctx.chamadas.fill++;
      }
    },
    stroke() {
      for (const sub of ctx.pontos) {
        for (let i = 0; i + 1 < sub.length; i++) raster.linha(sub[i][0], sub[i][1], sub[i + 1][0], sub[i + 1][1], ctx.__stroke, ctx.lineWidth);
        ctx.chamadas.stroke++;
      }
    },
    fillRect(x, y, w, h) {
      raster.retangulo(x, y, w, h, ctx.__fill);
      ctx.chamadas.fillRect++;
      ctx.quadro++;                       // o céu abre o quadro: estatística por quadro
      ctx.__porCor.clear();
      ctx.__fora = 0; ctx.__dentro = 0;
    }
  };
  const canvas = {
    width: largura, height: altura, style: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {}, focus() {}, append() {},
    getContext: tipo => (tipo === '2d' ? ctx : null),     // sem WebGL2: degrau 2
    getBoundingClientRect: () => ({ width: largura, height: altura, left: 0, top: 0, right: largura, bottom: altura }),
    __ctx: ctx
  };
  return canvas;
}

// ------------------------------------------------------------------ DOM mínimo --
class NoShim {
  constructor(tag) { this.tag = tag; this.filhos = []; this.style = {}; this.className = ''; this._texto = ''; }
  append(...nos) { for (const n of nos) this.filhos.push(n); }
  addEventListener() {}
  set textContent(v) { this._texto = String(v); this.filhos.length = 0; }
  get textContent() { return this._texto + this.filhos.map(f => f.textContent).join(' '); }
}
globalThis.Node = NoShim;
globalThis.document = { createElement: tag => new NoShim(tag), createTextNode: t => { const n = new NoShim('#texto'); n._texto = String(t); return n; } };

// ------------------------------------------------------------------ PNG 8 bits --
const CRCTAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRCTAB[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(tipo, dados) {
  const cab = Buffer.alloc(8), dv = new DataView(cab.buffer);
  dv.setUint32(0, dados.length);
  cab.write(tipo, 4, 'ascii');
  const crc = Buffer.alloc(4);
  new DataView(crc.buffer).setUint32(0, crc32(Buffer.concat([cab.subarray(4), dados])));
  return Buffer.concat([cab, dados, crc]);
}
function pngDeRgba(raster) {
  const { w, h, data } = raster;
  const cru = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    cru[y * (w * 4 + 1)] = 0;                                   // filtro: nenhum
    for (let x = 0; x < w * 4; x++) cru[y * (w * 4 + 1) + 1 + x] = data[y * w * 4 + x];
  }
  const ihdr = Buffer.alloc(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(cru, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

// ================================================================== execução ===
const t0 = performance.now();
const worker = new Worker(new URL('./engine-worker-host.mjs', import.meta.url));
const link = await connectWorker(worker, 'engine', { shared: false });
console.log(`worker w-engine hospedado no Node · transporte ${link.transport}`);

const MAX = 4096 * 8;
const scratch = new Float32Array(MAX);
let snapshotCount = 0, snapshots = 0, ultimoCheck = null;
worker.on('message', data => {
  if (!data || data.type !== 'nucleo-snapshot') return;
  // Mesmo caminho do main.js: copia para a scratch pré-alocada e devolve o buffer
  // ao worker (ping-pong, zero alocação dos dois lados).
  snapshotCount = Math.min(data.count, MAX / 8);
  scratch.set(data.data.subarray(0, snapshotCount * 8), 0);
  snapshots++;
  worker.postMessage({ type: 'nucleo-snapshot-back', data: data.data }, [data.data.buffer]);
});

link.sendJSON(OP.CFG, { entities: ENTIDADES });
worker.postMessage({ type: 'nucleo-config', snapshotMode: 'post', entities: ENTIDADES });

const tickBuf = new Uint8Array(6);
const ticker = setInterval(() => {
  writeTick(tickBuf, 16, 0);
  link.send(OP.TICK, tickBuf);
}, 16);
// Alguns ticks antes de montar a janela: a IA precisa de tempo para distribuir o tráfego.
await new Promise(r => setTimeout(r, 260));

const raster = new Raster(LARGURA, ALTURA);
const canvas = canvasFalso(raster, LARGURA, ALTURA);
const { createGame } = await import('../js/apps/game.js');
const eventos = [];
const app = createGame({
  canvas,
  camera,
  settings: { renderScale: 1, shadows: false, drs: false, fpsCap: 0, entities: ENTIDADES },
  engine: {
    available: true, unavailableReason: '', scratch, snapshotMode: link.transport,
    get entityCount() { return snapshotCount; },
    readEntities() { return snapshotCount > 0 ? snapshotCount : -1; }
  },
  os: { reportGame: m => { eventos.push(m); ultimoCheck = m; } },
  toast: { err: (t, x) => console.error(`[toast] ${t}: ${x}`) }
});

await new Promise(r => setTimeout(r, JANELA_MS));
clearInterval(ticker);
const ultimo = eventos.at(-1) || {};
const stats = app.stats;
app.onClose();
link.dispose();
await worker.terminate();

writeFileSync(SAIDA, pngDeRgba(raster));

// ------------------------------------------------------------------ relatório --
const kb = n => `${(n / 1024).toFixed(1)} KB`;
console.log(`\nimagem      : ${SAIDA} (${LARGURA}×${ALTURA}, ${kb(pngDeRgba(raster).length)})`);
console.log(`renderizador: ${stats.backend} (software neste host — não há GPU no Node)`);
console.log(`cena        : ${stats.instances} volumes · ${stats.drawCalls} polígonos desenhados no quadro`);
console.log(`tráfego     : ${stats.entities} entidades lidas do w-engine · ${snapshots} snapshots recebidos · ${snapshotCount} no último`);
console.log(`tempo       : ${(performance.now() - t0).toFixed(0)} ms no total`);
// Autoverificação do raster: uma cena vazia ou um defeito da ferramenta aparecem aqui
// como "quase tudo num tom só". Comparar com uma cor fixa de céu não serve desde que o
// céu ganhou gradiente — então a medida é a concentração do tom dominante.
const contarTons = () => {
  const hist = new Map();
  for (let y = 0; y < ALTURA; y += 2) {
    for (let x = 0; x < LARGURA; x += 2) {
      const i = (y * LARGURA + x) * 4;
      const chave = `${raster.data[i] >> 3},${raster.data[i + 1] >> 3},${raster.data[i + 2] >> 3}`;
      hist.set(chave, (hist.get(chave) || 0) + 1);
    }
  }
  return hist;
};
const hist = contarTons();
const amostras = LARGURA * ALTURA / 4;
const [tomDominante, nDominante] = [...hist.entries()].sort((a, b) => b[1] - a[1])[0];
const domPct = nDominante / amostras * 100;
console.log(`pintura     : ${canvas.__ctx.chamadas.fill} polígonos preenchidos · ${canvas.__ctx.chamadas.stroke} linhas traçadas`);
console.log(`dominância  : tom mais comum rgb(${tomDominante.split(',').map(n => (n << 3) + 4).join(',')}) = ${domPct.toFixed(1)}% · ${hist.size} tons distintos`);
for (const m of canvas.__ctx.__maiores) console.log(`  maior face: ${m.largura}×${m.altura} px em (${m.x},${m.y}) · ${m.n} pontos · ${m.cor}`);
if (domPct > 95) console.warn('ATENÇÃO: o quadro é quase uma cor só — desconfie da cena E da ferramenta.');

// Mapa de caracteres (mesma técnica de tools/render-site.mjs): dá para ver o enquadramento
// no terminal, sem abrir o PNG.
const RAMPA = ' .:-=+*#%@';
const COLUNAS = 72, LINHAS = 24;
let mapa = '';
const histograma = new Map();
for (let ly = 0; ly < LINHAS; ly++) {
  for (let lx = 0; lx < COLUNAS; lx++) {
    let soma = 0, n = 0;
    for (let y = Math.floor(ly * ALTURA / LINHAS); y < Math.floor((ly + 1) * ALTURA / LINHAS); y++) {
      for (let x = Math.floor(lx * LARGURA / COLUNAS); x < Math.floor((lx + 1) * LARGURA / COLUNAS); x++) {
        const i = (y * LARGURA + x) * 4;
        soma += Math.max(raster.data[i], raster.data[i + 1], raster.data[i + 2]); n++;
      }
    }
    mapa += RAMPA[Math.min(RAMPA.length - 1, Math.round((soma / Math.max(1, n)) / 255 * RAMPA.length))];
  }
  mapa += '\n';
}
for (let y = 0; y < ALTURA; y += 2) {
  for (let x = 0; x < LARGURA; x += 2) {
    const i = (y * LARGURA + x) * 4;
    const chave = `${raster.data[i] >> 3},${raster.data[i + 1] >> 3},${raster.data[i + 2] >> 3}`;
    histograma.set(chave, (histograma.get(chave) || 0) + 1);
  }
}
const top = [...histograma.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([k, v]) => `rgb(${k.split(',').map(n => (n << 3) + 4).join(',')})=${(v / (LARGURA * ALTURA / 4) * 100).toFixed(1)}%`);
console.log(mapa);
console.log(`tom         : ${histograma.size} tons distintos · mais frequentes: ${top.join(' · ')}`);
console.log(`validado por este quadro: céu com gradiente · chão com grade viária · prédios com volume · veículos do w-engine`);
console.log(`não validado aqui: o caminho WebGL2 (shaders, instância, z-buffer) e o desempenho em GPU real`);
if (stats.erro) console.log(`ERRO declarado pela janela: ${stats.erro}`);
void ultimo; void ultimoCheck;
