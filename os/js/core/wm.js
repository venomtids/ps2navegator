/**
 * SECTOR OS — core/wm.js
 * Window manager: abrir/fechar, arrastar, redimensionar, snap, foco, minimizar,
 * maximizar e barra de tarefas. Toda a matemática vive em core/geom.js (testado);
 * aqui só há encanamento de DOM e eventos de ponteiro.
 *
 * Regras do Design System aplicadas:
 *  - §2.1 teto de 3 superfícies translúcidas: a quarta janela visível vira sólida.
 *  - §6.5 arrastar pelo título, snap em bordas, 8 alças de redimensionamento.
 *  - §7 janela abre a partir do ponto de clique (origem do transform).
 */

import { el } from './util.js';
import * as G from './geom.js';

const svgNS = 'http://www.w3.org/2000/svg';
const icon = (d, extra = '') => {
  const node = document.createElementNS(svgNS, 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', d);
  if (extra) path.setAttribute('stroke-linejoin', extra);
  node.append(path);
  return node;
};
const ICONS = {
  min: 'M3 8h10',
  max: 'M4 4h8v8H4z',
  restore: 'M5 5h7v7M4 8v5h5',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7'
};

export function createWM({ layer, taskbar, bus, statusH = 34 }) {
  let zTop = 20;
  let openIndex = 0;
  const wins = new Map();
  const ghost = el('div', { class: 'snapghost' });
  layer.append(ghost);

  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

  function glassPolicy() {
    const visible = [...wins.values()].filter(w => !w.minimized && !w.el.classList.contains('maximized'));
    visible.sort((a, b) => b.z - a.z);
    visible.forEach((w, i) => w.el.classList.toggle('opaque', i >= 3));
  }

  function focus(id) {
    const win = wins.get(id);
    if (!win) return null;
    win.z = ++zTop;
    win.el.style.zIndex = String(win.z);
    for (const w of wins.values()) w.el.classList.toggle('active', w === win);
    win.minimized = false;
    win.el.classList.remove('minimized');
    renderTaskbar();
    glassPolicy();          // as 3 superfícies mais recentes mantêm o vidro
    bus.emit('wm:focus', { id, app: win.app });
    return win;
  }

  function renderTaskbar() {
    taskbar.replaceChildren();
    if (!wins.size) {
      taskbar.append(el('span', { class: 'empty', text: 'nenhuma janela aberta' }));
      return;
    }
    for (const w of [...wins.values()].sort((a, b) => a.openedAt - b.openedAt)) {
      const active = w.el.classList.contains('active') && !w.minimized;
      const item = el('button', {
        class: `tw${active ? ' focus' : ''}`,
        title: w.title,
        onclick: () => (active ? minimize(w.id) : focus(w.id))
      },
        el('i', { class: `dot${active ? ' on' : ''}` }),
        el('span', { text: w.title })
      );
      taskbar.append(item);
    }
  }

  function geometry(win, rect) {
    win.rect = { ...rect };
    Object.assign(win.el.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  }

  function makeWindow(spec) {
    const view = viewport();
    const w0 = spec.w ?? 760, h0 = spec.h ?? 460;
    const start = spec.rect
      ? G.fitWithin(spec.rect, view)
      : { ...G.cascade(openIndex++, view, { w: w0, h: h0 }), w: w0, h: h0 };

    const win = {
      id: spec.id, app: spec.app, title: spec.title, el: null, z: 0,
      minimized: false, maximized: false, restore: null, rect: start,
      mounted: null, dispose: null, openedAt: performance.now()
    };

    const titlebar = el('header', { class: 'titlebar' },
      el('i', { class: 'wled' }),
      el('h2', { text: spec.title }),
      el('div', { class: 'wctl' },
        mkBtn('min', 'Minimizar', () => minimize(spec.id)),
        mkBtn('max', 'Maximizar', () => toggleMax(spec.id)),
        mkBtn('close', 'Fechar', () => close(spec.id))
      )
    );
    const body = el('div', { class: 'wbody' });
    const node = el('section', {
      class: 'win', role: 'dialog', 'aria-label': spec.title, 'aria-modal': 'false',
      'data-app': spec.id,
      onpointerdown: () => focus(spec.id)
    }, titlebar, body,
      ...['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].map(h => el('b', { class: `rz rz-${h}`, 'data-h': h }))
    );
    titlebar.style.cursor = 'default';
    win.el = node;
    geometry(win, start);
    layer.append(node);

    // --- arrastar -------------------------------------------------------
    let drag = null;
    titlebar.addEventListener('pointerdown', event => {
      if (event.target.closest('.wbtn') || event.button !== 0) return;
      const rect = win.rect;
      drag = { dx: event.clientX - rect.x, dy: event.clientY - rect.y, moved: false, zone: null };
      titlebar.setPointerCapture(event.pointerId);
      node.classList.add('dragging');
    });
    titlebar.addEventListener('pointermove', event => {
      if (!drag) return;
      const v = viewport();
      const x = event.clientX - drag.dx, y = Math.max(0, event.clientY - drag.dy);
      if (Math.abs(x - win.rect.x) + Math.abs(y - win.rect.y) > 2) drag.moved = true;
      node.style.transform = `translate3d(${x - win.rect.x}px,${y - win.rect.y}px,0)`;
      const zone = win.maximized ? null : G.snapZone(event.clientX, event.clientY, v, 26, 90);
      drag.zone = zone;
      const rect2 = zone ? G.zoneRect(zone, v, statusH) : null;
      Object.assign(ghost.style, {
        display: rect2 ? 'block' : 'none',
        left: `${rect2?.x ?? 0}px`, top: `${rect2?.y ?? 0}px`,
        width: `${rect2?.w ?? 0}px`, height: `${rect2?.h ?? 0}px`
      });
    });
    const endDrag = event => {
      if (!drag) return;
      const v = viewport();
      const moved = drag.moved;
      const zone = drag.zone;
      const nx = event ? event.clientX - drag.dx : win.rect.x;
      const ny = event ? Math.max(0, event.clientY - drag.dy) : win.rect.y;
      drag = null;
      node.style.transform = '';
      node.classList.remove('dragging');
      ghost.style.display = 'none';
      if (!moved) return;
      if (win.maximized) {           // arrastar a janela maximizada restaura e continua o gesto
        unmaximize(win.id);
      }
      if (zone) applyZone(win, zone);
      else geometry(win, G.clampRect({ ...win.rect, x: nx, y: ny }, v));
      bus.emit('wm:geometry', { id: win.id, rect: win.rect });
    };
    titlebar.addEventListener('pointerup', endDrag);
    titlebar.addEventListener('pointercancel', () => endDrag(null));
    titlebar.addEventListener('dblclick', () => toggleMax(win.id));

    // --- redimensionar --------------------------------------------------
    for (const handle of node.querySelectorAll('.rz')) {
      let start = null;
      handle.addEventListener('pointerdown', event => {
        event.stopPropagation();
        if (win.maximized || event.button !== 0) return;
        start = { ...win.rect, px: event.clientX, py: event.clientY };
        handle.setPointerCapture(event.pointerId);
        node.classList.add('dragging');
        focus(win.id);
      });
      handle.addEventListener('pointermove', event => {
        if (!start) return;
        const rect = G.applyResize(
          { x: start.x, y: start.y, w: start.w, h: start.h },
          handle.dataset.h,
          event.clientX - start.px,
          event.clientY - start.py
        );
        geometry(win, G.clampRect(rect, viewport()));
        win.mounted?.onResize?.(win.rect);
      });
      const stop = () => { if (start) { start = null; node.classList.remove('dragging'); bus.emit('wm:geometry', { id: win.id, rect: win.rect }); } };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    }

    wins.set(spec.id, win);
    if (spec.mount) {
      try { win.mounted = spec.mount(body, win) || null; }
      catch (e) { console.error('[wm] mount', e); bus.emit('toast', { kind: 'err', title: 'Falha ao abrir', text: String(e.message || e) }); }
    }
    focus(spec.id);
    glassPolicy();
    return win;
  }

  function mkBtn(kind, label, onclick) {
    return el('button', { class: `wbtn${kind === 'close' ? ' close' : ''}`, 'aria-label': label, title: label, onclick }, icon(ICONS[kind]));
  }

  function applyZone(win, zone) {
    if (zone === 'max') return maximize(win.id);
    const rect = G.zoneRect(zone, viewport(), statusH);
    if (!rect) return;
    win.el.classList.add('snapped');
    geometry(win, rect);
    win.mounted?.onResize?.(win.rect);
  }

  function maximize(id) {
    const win = wins.get(id);
    if (!win || win.maximized) return;
    win.restore = { ...win.rect };
    win.maximized = true;
    win.el.classList.add('maximized');
    win.el.classList.remove('snapped');
    const rect = G.zoneRect('max', viewport(), statusH);
    geometry(win, rect);
    win.mounted?.onResize?.(win.rect);
    focus(id);
    glassPolicy();
  }

  function unmaximize(id) {
    const win = wins.get(id);
    if (!win?.maximized) return;
    win.maximized = false;
    win.el.classList.remove('maximized');
    geometry(win, G.fitWithin(win.restore || { x: 60, y: 60, w: 760, h: 460 }, viewport()));
    win.restore = null;
    win.mounted?.onResize?.(win.rect);
    glassPolicy();
  }

  function toggleMax(id) {
    const win = wins.get(id);
    if (!win) return;
    win.maximized ? unmaximize(id) : maximize(id);
  }

  function minimize(id) {
    const win = wins.get(id);
    if (!win) return;
    win.minimized = true;
    win.el.classList.add('minimized');
    const next = [...wins.values()].filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0];
    if (next) focus(next.id); else renderTaskbar();
    bus.emit('wm:minimize', { id });
  }

  function close(id) {
    const win = wins.get(id);
    if (!win) return;
    win.el.classList.add('closing');
    const node = win.el;
    const finish = () => {
      try { win.dispose?.(); win.mounted?.onClose?.(); } catch (e) { console.error('[wm] close', e); }
      node.remove();
      wins.delete(id);
      const next = [...wins.values()].filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0];
      if (next) focus(next.id); else renderTaskbar();
      glassPolicy();
      bus.emit('wm:close', { id });
    };
    setTimeout(finish, 150);
  }

  function open(spec) {
    if (spec.singleton && wins.has(spec.id)) { const w = wins.get(spec.id); if (w.minimized) focus(spec.id); else focus(spec.id); return w; }
    return makeWindow(spec);
  }

  // Reancora janelas quando o viewport muda (rotação de tela, janela do navegador).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const v = viewport();
      for (const win of wins.values()) {
        const rect = win.maximized ? G.zoneRect('max', v, statusH) : G.clampRect(win.rect, v);
        geometry(win, rect);
        win.mounted?.onResize?.(win.rect);
      }
    }, 120);
  });

  return {
    open, close, focus, minimize, toggleMax,
    get count() { return wins.size; },
    list: () => [...wins.values()].map(w => ({ id: w.id, title: w.title, minimized: w.minimized, maximized: w.maximized, rect: { ...w.rect } })),
    has: id => wins.has(id),
    setTitle(id, title) { const w = wins.get(id); if (w) { w.title = title; w.el.querySelector('h2').textContent = title; renderTaskbar(); } },
    refreshTaskbar: renderTaskbar
  };
}
