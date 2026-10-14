/**
 * NÚCLEO OS — apps/browser.js
 * O navegador do sistema: modo TEXTO, de verdade.
 *
 * O que ele é: busca páginas pelo servidor local (`/api/fetch`, que aplica a
 * política de js/core/fetchpolicy.js), transforma HTML em texto com
 * js/core/htmltext.js e permite navegar clicando nos links — com histórico,
 * voltar/avançar, endereço digitável e "salvar no disco virtual".
 *
 * O que ele NÃO é, e por que: não é um motor gráfico. Renderizar HTML completo
 * dentro do PC virtual exigiria (a) um runtime Linux real, que é a fase F4, ou
 * (b) um iframe apontando para o site — que a maioria dos sites proíbe por
 * `X-Frame-Options`/CSP, e que a nossa própria COEP bloquearia. Um "Chrome dentro
 * do Chrome" que mostra página em branco seria pior do que dizer a verdade: este
 * é o Lynx do sistema, e ele funciona.
 */

import { el, fmtBytes, fmt1 } from '../core/util.js';
import { renderPage } from '../core/htmltext.js';
import { svgIcon } from '../ui/icons.js';

const HOME = 'https://pt.wikipedia.org/wiki/Navegador_web';

export function createBrowser({ toast, os, vfs }) {
  const history = [];
  let cursor = -1;
  let current = null;          // { url, page, meta }
  let busy = false;

  const address = el('input', {
    type: 'text', class: 'addr', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'endereço ou busca — ex.: wikipedia.org', 'aria-label': 'Endereço'
  });
  const status = el('span', { class: 'status mono' });
  const back = el('button', { class: 'btn sm', text: '←', title: 'Voltar', onclick: () => go(cursor - 1) });
  const fwd = el('button', { class: 'btn sm', text: '→', title: 'Avançar', onclick: () => go(cursor + 1) });
  const reload = el('button', { class: 'btn sm', text: '⟳', title: 'Recarregar', onclick: () => current && load(current.url, { push: false }) });
  const save = el('button', { class: 'btn sm', text: 'Salvar', title: 'Salvar no disco virtual (~/Downloads)', onclick: saveCurrent, disabled: true });
  const view = el('div', { class: 'bview', tabindex: '0', 'aria-label': 'Conteúdo da página' });

  const root = el('div', { class: 'browser' },
    el('div', { class: 'bar' }, back, fwd, reload, address, save),
    el('div', { class: 'bmeta' }, svgIcon('globe', 13), status),
    view
  );

  const setBusy = on => {
    busy = on;
    status.textContent = on ? 'buscando…' : status.textContent;
    root.classList.toggle('busy', on);
  };

  /** Normaliza o que o usuário digitou: URL, ou busca na Wikipédia se não parecer URL. */
  function toTarget(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
    if (/^[\w-]+(\.[\w-]+)+(\/|$|:)/.test(text)) return `https://${text}`;
    return `https://pt.wikipedia.org/w/index.php?search=${encodeURIComponent(text)}`;
  }

  async function fetchPage(url, { raw = false } = {}) {
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}${raw ? '&raw=1' : ''}`);
    if (raw) return res;
    const json = await res.json().catch(() => ({ ok: false, error: `resposta inválida (HTTP ${res.status})` }));
    return json;
  }

  async function load(url, { push = true } = {}) {
    const target = typeof url === 'string' ? url : String(url);
    if (busy) return;
    setBusy(true);
    view.classList.add('loading');
    try {
      const data = await fetchPage(target);
      if (!data.ok) {
        // A falha real é mostrada como página, no mesmo lugar do conteúdo —
        // não como um toast que some e deixa a tela em branco.
        renderError(target, data.error || 'falha desconhecida');
        status.textContent = `erro · ${target}`;
        return;
      }
      const page = data.htmlLike
        ? renderPage(data.text, { url: data.url })
        : renderPlain(data.text || '', data.url);
      current = { url: data.url, page, meta: data, raw: null };
      if (push) {
        history.splice(cursor + 1);
        history.push(data.url);
        cursor = history.length - 1;
      }
      renderDocument(current);
      const kb = fmtBytes(data.bytes, 1);
      status.textContent = `${data.status} · ${kb} · ${Math.round(data.ms)} ms · ${data.contentType.split(';')[0]}`;
      save.disabled = false;
      address.value = data.url;
    } catch (e) {
      renderError(target, String(e.message || e));
    } finally {
      setBusy(false);
      view.classList.remove('loading');
      updateNav();
    }
  }

  function renderPlain(text, url) {
    return {
      title: url,
      base: url,
      truncated: false,
      links: [],
      lines: text.split('\n').map(line => ({ text: line, kind: 'pre', segments: [], href: null }))
    };
  }

  function renderError(url, error) {
    current = { url, page: { title: 'Erro', lines: [], links: [], base: url }, meta: null, raw: null };
    view.replaceChildren(el('div', { class: 'berror' },
      el('div', { class: 'lbl', text: 'não foi possível abrir' }),
      el('div', { class: 'u mono', text: url }),
      el('div', { class: 'why', text: String(error) }),
      el('div', { class: 'hint', text: 'o motivo acima é o que o servidor informou — nada é arredondado nem escondido' })
    ));
    save.disabled = true;
    address.value = url;
  }

  function renderDocument({ url, page, meta }) {
    const nodes = [];
    for (const line of page.lines) {
      if (line.kind === 'rule') { nodes.push(el('div', { class: 'brule' })); continue; }
      if (line.kind === 'break') continue;
      const row = el('div', { class: `bline k-${line.kind}` });
      const segments = line.segments?.length ? line.segments : [{ text: line.text, href: line.href }];
      for (const seg of segments) {
        if (seg.href) {
          row.append(el('a', {
            class: 'blink', href: seg.href, text: seg.text,
            onclick: e => { e.preventDefault(); load(seg.href); }
          }));
        } else {
          row.append(document.createTextNode(seg.text));
        }
      }
      nodes.push(row);
    }
    if (page.truncated) {
      nodes.push(el('div', { class: 'btrunc', text: `… página truncada em ${page.lines.length} linhas — o resto foi cortado, não resumido` }));
    }
    if (meta) {
      nodes.push(el('div', { class: 'bfoot mono',
        text: `${meta.url} · ${meta.bytes} bytes · ${meta.ms} ms · ${page.links.length} links` }));
    }
    view.replaceChildren(...nodes);
    view.scrollTop = 0;
  }

  async function saveCurrent() {
    if (!current?.url) return;
    save.disabled = true;
    status.textContent = 'baixando para o disco virtual…';
    try {
      const res = await fetchPage(current.url, { raw: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const nome = fileNameFrom(current.url, res.headers.get('content-type') || '');
      // `size` é usado pelo toast de instalação para somar o total; sem ele o
      // resumo mostraria 0 B enquanto o arquivo teria sido gravado.
      await os.installFiles(os.installDir, [{ name: nome, size: bytes.length, arrayBuffer: async () => bytes.buffer }]);
      status.textContent = `salvo em ~/Downloads · ${fmtBytes(bytes.length, 1)}`;
    } catch (e) {
      toast.err('Não foi possível salvar', String(e.message || e));
      status.textContent = 'falha ao salvar';
    } finally {
      save.disabled = false;
    }
  }

  function updateNav() {
    back.disabled = cursor <= 0;
    fwd.disabled = cursor >= history.length - 1;
  }

  function go(index) {
    if (index < 0 || index >= history.length) return;
    cursor = index;
    load(history[index], { push: false });
  }

  address.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const target = toTarget(address.value);
    if (target) load(target);
  });

  // Atalhos de navegador de verdade: Alt+←, Alt+→, F5, Ctrl+L.
  root.addEventListener('keydown', e => {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); go(cursor - 1); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); go(cursor + 1); }
    else if (e.key === 'F5') { e.preventDefault(); if (current) load(current.url, { push: false }); }
    else if (e.key.toLowerCase() === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); address.select(); address.focus(); }
  });

  return {
    el: root,
    onMount() { if (!current) load(HOME); address.focus(); },
    onClose() { /* nada a liberar: não há processos nem conexões abertas */ },
    openUrl(url) { const t = toTarget(url); if (t) load(t); },
    focus() { address.focus(); },
    get url() { return current?.url || ''; },
    get stats() { return { history: history.length, cursor, lines: current?.page.lines.length || 0 }; }
  };
}

/** Nome de arquivo derivado da URL (e do content-type, quando a URL não ajuda). */
export function fileNameFrom(url, contentType = '') {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop() || '';
    const clean = decodeURIComponent(last).replace(/[^\w.\-]+/g, '_').slice(0, 80);
    if (clean && /\.[a-z0-9]{1,8}$/i.test(clean)) return clean;
    const ext = contentType.includes('html') ? '.html'
      : contentType.includes('json') ? '.json'
        : contentType.includes('plain') ? '.txt'
          : contentType.includes('png') ? '.png'
            : contentType.includes('jpeg') ? '.jpg'
              : contentType.includes('pdf') ? '.pdf'
                : contentType.includes('svg') ? '.svg'
                  : '.bin';
    return `${clean || 'pagina'}${ext}`;
  } catch { return 'pagina.html'; }
}
