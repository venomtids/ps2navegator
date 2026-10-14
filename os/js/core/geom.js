/**
 * SECTOR OS — core/geom.js
 * Geometria pura do window manager: sem DOM, sem estado, testável em Node
 * (tests/os-core.mjs). É a matemática de posicionar, prender, redimensionar e
 * fazer snap de janelas — o resto do WM é encanamento de eventos.
 */

import { clamp } from './util.js';

export const MIN_W = 320;
export const MIN_H = 200;

/** Barra de títulos sempre alcançável, mesmo com a janela meio fora da tela. */
export const KEEP_VISIBLE = 96;

export function cascade(index, viewport, size) {
  const step = 28;
  const base = 24 + (index % 8) * step;
  return {
    x: clamp(base, 8, Math.max(8, viewport.w - size.w - 8)),
    y: clamp(base + 8, 42, Math.max(42, viewport.h - size.h - 40))
  };
}

export function fitWithin(rect, viewport, minW = MIN_W, minH = MIN_H) {
  const w = clamp(rect.w, minW, Math.max(minW, viewport.w - 16));
  const h = clamp(rect.h, minH, Math.max(minH, viewport.h - 16));
  return { x: clamp(rect.x, 8, Math.max(8, viewport.w - w - 8)), y: clamp(rect.y, 40, Math.max(40, viewport.h - h - 8)), w, h };
}

/** Prende a janela mantendo o título visível (não permite perdê-la fora da tela). */
export function clampRect(rect, viewport, minW = MIN_W, minH = MIN_H) {
  const w = clamp(rect.w, minW, Math.max(minW, viewport.w));
  const h = clamp(rect.h, minH, Math.max(minH, viewport.h));
  const x = clamp(rect.x, KEEP_VISIBLE - w, viewport.w - KEEP_VISIBLE);
  const y = clamp(rect.y, 34, viewport.h - 40);
  return { x, y, w, h };
}

/** Redimensiona a partir de uma alça, respeitando os mínimos. */
export function applyResize(start, handle, dx, dy, minW = MIN_W, minH = MIN_H) {
  let { x, y, w, h } = start;
  if (handle.includes('e')) w = start.w + dx;
  if (handle.includes('s')) h = start.h + dy;
  if (handle.includes('w')) { w = start.w - dx; x = start.x + dx; }
  if (handle.includes('n')) { h = start.h - dy; y = start.y + dy; }
  if (w < minW) { w = minW; if (handle.includes('w')) x = start.x + start.w - minW; }
  if (h < minH) { h = minH; if (handle.includes('n')) y = start.y + start.h - minH; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Zona de snap durante o arrasto (borda de 26 px).
 * 'max' no topo, 'left'/'right' nas laterais, 'tl'/'tr'/'bl'/'br' nos cantos.
 */
export function snapZone(px, py, viewport, edge = 26, corner = 90) {
  const nearTop = py <= edge, nearBottom = py >= viewport.h - edge;
  const nearLeft = px <= edge, nearRight = px >= viewport.w - edge;
  if (nearTop && nearLeft && px <= corner) return 'tl';
  if (nearTop && nearRight && px >= viewport.w - corner) return 'tr';
  if (nearTop) return 'max';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  if (nearBottom && nearLeft) return 'bl';
  if (nearBottom && nearRight) return 'br';
  return null;
}

/** Retângulo resultante de um snap. `chrome` = altura da barra de status + margem. */
export function zoneRect(zone, viewport, chrome = 40) {
  const w = viewport.w, h = viewport.h - chrome - 40;
  const hw = Math.round(w / 2), hh = Math.round(h / 2);
  switch (zone) {
    case 'max': return { x: 0, y: chrome, w, h: viewport.h - chrome - 34 };
    case 'left': return { x: 0, y: chrome, w: hw, h };
    case 'right': return { x: w - hw, y: chrome, w: hw, h };
    case 'tl': return { x: 0, y: chrome, w: hw, h: hh };
    case 'tr': return { x: w - hw, y: chrome, w: hw, h: hh };
    case 'bl': return { x: 0, y: chrome + hh, w: hw, h: hh };
    case 'br': return { x: w - hw, y: chrome + hh, w: hw, h: hh };
    default: return null;
  }
}

/** Interseção de retângulos (para saber se a janela está de fato visível). */
export function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
