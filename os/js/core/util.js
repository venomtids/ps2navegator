/** SECTOR OS — core/util.js : utilidades puras, sem estado global. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Cria elementos sem innerHTML (evita injeção e reparse). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') throw new Error('innerHTML é proibido no SECTOR OS.');
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmtInt = v => (Number.isFinite(v) ? nf0.format(v) : 'N/D');
export const fmt1 = v => (Number.isFinite(v) ? nf1.format(v) : 'N/D');

export function fmtBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes)) return 'N/D';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  // ≤ 3 algarismos significativos: "12 MB" é mais legível que "12,0 MB",
  // mas "1,5 GB" precisa da casa decimal.
  const comDecimal = digits > 0 && i > 0 && v < 10;
  return `${comDecimal ? nf1.format(v) : nf0.format(v)} ${u[i]}`;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'N/D';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(ss).padStart(2, '0')}s`;
}

export const fmtClock = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

/** Normaliza e valida um caminho do VMFS. Lança em qualquer entrada suspeita. */
export function safePath(input, cwd = '/home/sector') {
  if (typeof input !== 'string' || !input || input.length > 512) throw new Error('caminho inválido');
  if (input.includes('\0')) throw new Error('caminho contém byte nulo');
  const base = input.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (base.length) base.pop(); continue; }
    if (part.length > 128 || /[\\:*?"<>|\x00-\x1f]/.test(part)) throw new Error('nome de arquivo inválido');
    base.push(part);
  }
  return '/' + base.join('/');
}

export const baseName = p => p.replace(/\/+$/, '').split('/').pop() || '/';
export const dirName = p => { const t = p.replace(/\/+$/, ''); const i = t.lastIndexOf('/'); return i <= 0 ? '/' : t.slice(0, i); };

/** FNV-1a 32 bits — usado para ids estáveis de janelas e sementes determinísticas. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** PRNG determinístico (mulberry32) para geração procedural. */
export function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs = null;
  return (...args) => {
    const now = performance.now();
    lastArgs = args;
    if (now - last >= ms) { last = now; fn(...lastArgs); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(...lastArgs); }, ms - (now - last));
  };
}

/** Medidor de taxa sustentável (EMA) para telemetria — não é média simples. */
export class Rate {
  #last = 0; #value = 0; #alpha;
  constructor(alpha = 0.2) { this.#alpha = alpha; }
  sample(value) { this.#value = this.#value === 0 ? value : this.#value * (1 - this.#alpha) + value * this.#alpha; return this.#value; }
  get value() { return this.#value; }
}

/**
 * Histograma circular para percentis (P50/P95). Zero alocação após o construtor.
 * Média esconde travamento; é por isso que o HUD mostra P95 (Design System §8).
 */
export class Histogram {
  #buf; #i = 0; #n = 0;
  constructor(size = 120) { this.#buf = new Float32Array(size); }
  push(v) { this.#buf[this.#i] = v; this.#i = (this.#i + 1) % this.#buf.length; if (this.#n < this.#buf.length) this.#n++; }
  get count() { return this.#n; }
  get last() { return this.#n ? this.#buf[(this.#i - 1 + this.#buf.length) % this.#buf.length] : 0; }
  percentile(p) {
    if (!this.#n) return NaN;
    const arr = Array.prototype.slice.call(this.#buf, 0, this.#n).sort((a, b) => a - b);
    return arr[clamp(Math.floor((p / 100) * (arr.length - 1)), 0, arr.length - 1)];
  }
  mean() { let s = 0; for (let i = 0; i < this.#n; i++) s += this.#buf[i]; return this.#n ? s / this.#n : NaN; }
  forEach(fn) { for (let i = 0; i < this.#n; i++) fn(this.#buf[(this.#i + i) % this.#buf.length], i); }
}
