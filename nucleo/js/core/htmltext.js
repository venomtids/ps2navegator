/**
 * NÚCLEO OS — core/htmltext.js
 * Renderiza HTML em texto estruturado, para o navegador do sistema (modo texto).
 *
 * Por que texto e não um motor gráfico: um navegador com layout completo dentro do
 * PC virtual exigiria um runtime Linux de verdade (fase F4) e não caberia em um
 * iframe por causa de `X-Frame-Options`/CSP dos sites. O que é honesto e útil agora
 * é o que o Lynx faz há 30 anos: buscar, extrair o conteúdo, navegar por links.
 *
 * Usa `DOMParser` de verdade (o mesmo motor que o navegador host já tem) em vez de
 * expressões regulares sobre HTML — a diferença aparece no primeiro `<script>` com
 * `"<div>"` dentro de uma string, ou em qualquer `&amp;` mal colocado.
 *
 * Nada aqui depende de DOM global: o parser é injetado, então o módulo é testável
 * em jsdom e continua puro para o resto do núcleo.
 */

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'HEAD', 'META', 'LINK']);
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'TABLE', 'TR', 'FORM', 'FIELDSET', 'FIGURE', 'BLOCKQUOTE', 'DL', 'UL', 'OL', 'PRE', 'HR', 'ADDRESS', 'DETAILS', 'SUMMARY']);
const MAX_LINES = 4000;
const MAX_LINE_CHARS = 200;

export const DEFAULT_PARSER = () => globalThis.DOMParser || globalThis.window?.DOMParser || null;

/**
 * Converte HTML em `{ title, lines, links }`.
 *
 * Cada linha é `{ text, kind, href }`:
 *   kind: 'title' | 'h1' | 'h2' | 'text' | 'li' | 'quote' | 'pre' | 'rule' | 'meta'
 *   href: presente quando a linha contém um link (texto clicável)
 *
 * `links` é a lista de destinos absolutos, na ordem em que aparecem — é o que o
 * modo terminal numera como [1], [2]…
 */
export function renderPage(html, { url = 'about:blank', parser = DEFAULT_PARSER(), maxLines = MAX_LINES } = {}) {
  // `parser` aceita a classe (DOMParser do navegador/jsdom) ou uma instância.
  // Classe não pode ser chamada sem `new` — foi o primeiro erro deste módulo.
  const provided = parser ?? DEFAULT_PARSER();
  if (!provided) throw new Error('DOMParser indisponível neste contexto');
  const instance = typeof provided === 'function' ? new provided() : provided;
  const doc = instance.parseFromString(String(html ?? ''), 'text/html');

  // <base href> muda o alvo de todos os links relativos — respeitar isso é a
  // diferença entre navegar e tomar 404.
  const baseTag = doc.querySelector('base[href]')?.getAttribute('href');
  const base = resolveUrl(baseTag, url) || url;

  const lines = [];
  const links = [];
  let truncated = false;

  // Frase não é feita de fragmentos: um parágrafo vira UMA linha com segmentos,
  // e só os segmentos com href são clicáveis. Sem isto, "texto com um link no
  // meio" saía fatiado em quatro linhas soltas.
  let current = null;
  const openLine = (kind = 'text') => {
    if (!current) current = { kind, segments: [] };
    return current;
  };
  const flush = () => {
    if (!current) return;
    const text = current.segments.map(s => s.text).join('').replace(/\s+/g, ' ').trim();
    const filled = current.segments.filter(s => s.text.trim());
    const only = filled.length === 1 && filled[0].href ? filled[0].href : null;
    // `<li>•</li>` (enfeite comum: o GitHub usa) sozinho não é conteúdo. A regra
    // fica aqui, no único ponto que empurra linhas, porque um `flush()` interno
    // (li contendo <div>) já teria empurrado a linha antes de qualquer checagem.
    const soMarcador = current.kind === 'li' && /^[•\s]+$/.test(text);
    if (text && !soMarcador && lines.length < maxLines) {
      lines.push({ text: text.slice(0, MAX_LINE_CHARS), kind: current.kind, segments: current.segments, href: only });
    } else if (text && !soMarcador) {
      truncated = true;
    }
    current = null;
  };
  const addText = (text, href = null, kind = null) => {
    if (!text) return;
    const line = openLine(kind || 'text');
    if (kind) line.kind = kind;
    line.segments.push({ text, href });
  };
  const breakLine = (kind = 'rule') => {
    flush();
    if (lines.length < maxLines) lines.push({ text: '', kind, segments: [], href: null });
    else truncated = true;
  };

  const absolute = href => {
    if (!href) return null;
    const target = href.startsWith('#') ? `${base}${href}` : resolveUrl(href, base);
    if (target) links.push(target);
    return target;
  };

  const walk = node => {
    if (lines.length >= maxLines) { truncated = true; return; }
    if (node.nodeType === 3) { addText(node.nodeValue); return; }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag)) return;

    if (tag === 'BR') { breakLine('break'); return; }
    if (tag === 'HR') { breakLine('rule'); return; }

    if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || node.getAttribute('title') || '';
      addText(alt ? `[imagem: ${alt}]` : '[imagem]', absolute(node.getAttribute('src')), 'meta');
      return;
    }

    if (/^H[1-6]$/.test(tag)) {
      flush();
      const level = Number(tag[1]);
      const kind = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
      const before = links.length;
      const segments = [];
      const collect = n => {
        if (n.nodeType === 3) { if (n.nodeValue.trim()) segments.push({ text: n.nodeValue, href: null }); return; }
        if (n.nodeType !== 1) return;
        if (n.tagName.toUpperCase() === 'A') {
          const href = absolute(n.getAttribute('href'));
          const text = n.textContent.trim();
          if (text) segments.push({ text, href });
          return;
        }
        for (const c of n.childNodes) collect(c);
      };
      collect(node);
      const text = segments.map(s => s.text).join('').replace(/\s+/g, ' ').trim();
      if (text && lines.length < maxLines) {
        lines.push({ text, kind, segments, href: segments.length === 1 && segments[0].href ? segments[0].href : null });
      } else if (text) truncated = true;
      void before;
      return;
    }

    if (tag === 'A') {
      const href = absolute(node.getAttribute('href'));
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (href) addText(text || href, href);
      else if (text) addText(text);
      return;
    }

    if (tag === 'PRE' || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      const text = node.textContent;
      if (!text.trim()) return;
      flush();
      for (const linha of text.replace(/\t/g, '  ').split('\n')) {
        if (lines.length >= maxLines) { truncated = true; break; }
        if (linha.trim() || tag === 'PRE') lines.push({ text: linha.slice(0, MAX_LINE_CHARS), kind: 'pre', segments: [], href: null });
      }
      return;
    }

    if (tag === 'BLOCKQUOTE') {
      flush();
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) lines.push({ text: `> ${text}`, kind: 'quote', segments: [{ text: `> ${text}`, href: null }], href: null });
      return;
    }

    if (tag === 'LI') {
      flush();
      // O marcador é um segmento da própria linha: o texto continua fluindo junto.
      const line = openLine('li');
      line.segments.push({ text: '• ', href: null });
      for (const child of node.childNodes) walk(child);
      flush();
      return;
    }

    if (BLOCK.has(tag)) {
      flush();
      for (const child of node.childNodes) walk(child);
      flush();
      return;
    }

    for (const child of node.childNodes) walk(child);
  };

  const body = doc.body || doc.documentElement;
  for (const child of body.childNodes) walk(child);
  flush();

  const title = (doc.title || '').trim();
  if (title && !lines.some(l => l.kind === 'h1')) {
    lines.unshift({ text: title, kind: 'title', segments: [{ text: title, href: null }], href: null });
  }

  return { title, lines, links, truncated, base };
}

/** Resolve `href` contra a URL da página; devolve null se não der. */
export function resolveUrl(href, base) {
  if (!href) return null;
  try {
    if (base && base !== 'about:blank') return new URL(href, base).href;
    return new URL(href).href;
  } catch { return null; }
}

/** Texto puro (para o terminal e para o índice de busca). */
export function pageToText(page, { width = 100 } = {}) {
  const out = [];
  for (const line of page.lines) {
    if (line.kind === 'rule') { out.push('─'.repeat(Math.min(width, 40))); continue; }
    const prefix = line.kind === 'h1' ? '# ' : line.kind === 'h2' ? '## ' : line.kind === 'meta' ? '' : '';
    out.push(`${prefix}${line.text}`);
  }
  return out.join('\n');
}
