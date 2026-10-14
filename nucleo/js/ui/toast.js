/** NÚCLEO OS — ui/toast.js : notificações (§6.11 do Design System). */
import { el } from '../core/util.js';

export function createToasts(container) {
  const live = [];
  const MAX = 3;

  function remove(node) {
    const i = live.indexOf(node);
    if (i >= 0) live.splice(i, 1);
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }

  function push({ kind = 'info', title = '', text = '', ms = null }) {
    const node = el('div', { class: `toast ${kind}`, role: 'status' },
      el('div', { class: 'txt' },
        el('b', { text: title }),
        text ? el('span', { text }) : null
      ),
      el('button', { class: 'x', 'aria-label': 'Fechar aviso', onclick: () => remove(node), text: '✕' })
    );
    container.append(node);
    live.push(node);
    while (live.length > MAX) remove(live[0]);
    const life = ms ?? (kind === 'err' ? 8000 : 4000);
    setTimeout(() => { if (node.isConnected) remove(node); }, life);
    return node;
  }

  return {
    push,
    ok: (title, text) => push({ kind: 'ok', title, text }),
    warn: (title, text) => push({ kind: 'warn', title, text }),
    err: (title, text) => push({ kind: 'err', title, text, ms: 8000 }),
    get count() { return live.length; }
  };
}
