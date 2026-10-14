/**
 * NÚCLEO OS — core/css.js
 * Parser e cascata de CSS (subconjunto) para o motor de renderização do Navegador.
 *
 * Escopo deliberado: o que aparece em páginas reais e dá para renderizar bem —
 * cor, tipografia, caixa (margin/padding/border), dimensões, alinhamento, listas.
 * Tudo que é moderno (flex, grid, transform, media queries complexas) é ignorado
 * em silêncio: ignorar é diferente de quebrar, e o layout degrada para o fluxo
 * de blocos em vez de sumir.
 *
 * Este módulo é puro: não toca no DOM, não faz I/O e nunca lança exceção por CSS
 * malformado (a web é malformada). É por isso que ele é testável por tabela.
 */

/** Cores nomeadas aceitas (subconjunto suficiente para a web real). */
const NAMED = {
  transparent: 'rgba(0,0,0,0)', black: '#000000', white: '#ffffff', red: '#ff0000',
  green: '#008000', lime: '#00ff00', blue: '#0000ff', navy: '#000080', teal: '#008080',
  aqua: '#00ffff', cyan: '#00ffff', yellow: '#ffff00', orange: '#ffa500', gold: '#ffd700',
  maroon: '#800000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  olive: '#808000', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  crimson: '#dc143c', tomato: '#ff6347', salmon: '#fa8072', pink: '#ffc0cb',
  brown: '#a52a2a', chocolate: '#d2691e', tan: '#d2b48c', beige: '#f5f5dc',
  ivory: '#fffff0', snow: '#fffafa', whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc',
  steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff', skyblue: '#87ceeb',
  midnightblue: '#191970', darkblue: '#00008b', darkgreen: '#006400', seagreen: '#2e8b57',
  forestgreen: '#228b22', darkred: '#8b0000', firebrick: '#b22222', indigo: '#4b0082',
  violet: '#ee82ee', plum: '#dda0dd', orchid: '#da70d6', khaki: '#f0e68c',
  darkorange: '#ff8c00', coral: '#ff7f50'
};

/** Tabela de `display` por tag — o padrão do navegador, não o nosso desejo. */
const DISPLAY_PADRAO = {
  block: 'div p h1 h2 h3 h4 h5 h6 ul ol dl dt dd blockquote pre header footer section article nav aside main form fieldset figure figcaption center address hr table thead tbody tfoot tr caption details summary',
  'list-item': 'li',
  none: 'script style head title meta link noscript template',
  inline: 'span a strong b em i u s small big sub sup code kbd samp var mark abbr cite q time label button input select textarea img br wbr'
};

const TAG_DISPLAY = (() => {
  const mapa = {};
  for (const [display, tags] of Object.entries(DISPLAY_PADRAO)) {
    for (const t of tags.split(' ')) mapa[t] = display;
  }
  return mapa;
})();

export function defaultDisplay(tag) {
  return TAG_DISPLAY[String(tag || '').toLowerCase()] || 'inline';
}

/** Herdam do pai em vez de voltar ao valor inicial. */
const INHERITED = new Set([
  'color', 'font-size', 'font-weight', 'font-style', 'font-family',
  'text-align', 'line-height', 'list-style-type', 'white-space', 'visibility'
]);

/** Comprimento: `{px: n}` ou `{pct: n}` (resolvido depois, contra a largura do container). */
export function parseLength(valor, base = null) {
  if (valor == null) return null;
  const texto = String(valor).trim().toLowerCase();
  if (!texto || texto === 'auto' || texto === 'inherit' || texto === 'initial' || texto === 'none') return null;
  const m = texto.match(/^(-?[\d.]+)(px|pt|pc|in|cm|mm|em|rem|ex|ch|%|vw|vh)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unidade = m[2] || 'px';
  switch (unidade) {
    case 'px': return { px: n };
    case 'pt': return { px: n * (4 / 3) };
    case 'pc': return { px: n * 16 };
    case 'in': return { px: n * 96 };
    case 'cm': return { px: n * (96 / 2.54) };
    case 'mm': return { px: n * (96 / 25.4) };
    case 'em': case 'ex': case 'ch': return base != null ? { px: n * base } : { px: n * 16 };
    case 'rem': return { px: n * 16 };
    case '%': return { pct: n };
    case 'vw': return { vw: n };
    case 'vh': return { vh: n };
    default: return { px: n };
  }
}

/** Cor para `#rrggbb`/`rgba(...)`; devolve null quando não entende. */
export function parseColor(valor) {
  if (!valor) return null;
  const texto = String(valor).trim().toLowerCase();
  if (NAMED[texto]) return NAMED[texto];
  if (texto.startsWith('#')) {
    const h = texto.slice(1);
    if (/^[0-9a-f]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (/^[0-9a-f]{4}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (/^[0-9a-f]{6}$/.test(h)) return `#${h}`;
    if (/^[0-9a-f]{8}$/.test(h)) return `#${h.slice(0, 6)}`;
    return null;
  }
  const rgb = texto.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const partes = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const [r, g, b, a] = partes;
    const num = v => (String(v).endsWith('%') ? Math.round(Number(v.slice(0, -1)) * 2.55) : Math.round(Number(v)));
    if ([r, g, b].some(v => v == null || Number.isNaN(num(v)))) return null;
    const alfa = a == null ? 1 : Number(a);
    if (alfa >= 1) return `#${[r, g, b].map(v => num(v).toString(16).padStart(2, '0')).join('')}`;
    return `rgba(${num(r)},${num(g)},${num(b)},${Number.isFinite(alfa) ? alfa : 1})`;
  }
  return null;
}

/** Declarações → objeto, com shorthands expandidos. Nunca lança. */
export function parseDeclarations(texto) {
  const decls = {};
  if (!texto) return decls;
  for (const parte of String(texto).split(';')) {
    const corte = parte.indexOf(':');
    if (corte <= 0) continue;
    const prop = parte.slice(0, corte).trim().toLowerCase();
    const valor = parte.slice(corte + 1).trim();
    if (!prop || !valor) continue;
    // Comentários soltos dentro de declarações acontecem em CSS minificado quebrado.
    decls[prop] = valor.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  }
  expandShorthand(decls, 'margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  expandShorthand(decls, 'padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
  expandBorder(decls);
  if (decls['background-color'] == null && decls.background != null) {
    const cor = parseColor(decls.background.split(/\s+/)[0]);
    if (cor) decls['background-color'] = cor;
    // `background: url(...)` fica de fora de propósito: imagem de fundo em página
    // real costuma ser textura de layout — pintar por cima do texto seria pior
    // do que não pintar.
  }
  return decls;
}

function expandShorthand(decls, nome, destinos) {
  const valor = decls[nome];
  if (valor == null) return;
  const partes = valor.trim().split(/\s+/);
  if (partes.length < 1 || partes.length > 4) return;
  const [a, b = a, c = a, d = b] = partes;
  const valores = destinos.length === 1 ? [a] : [a, b, c, d];
  destinos.forEach((destino, i) => { if (decls[destino] == null) decls[destino] = valores[i]; });
}

function expandBorder(decls) {
  const atalho = decls.border;
  const lados = ['top', 'right', 'bottom', 'left'];
  // Atenção à ordem: `applyDecls` lê `border-top-width`, não `border-width-top`.
  // A primeira versão escrevia na ordem errada e a borda simplesmente não existia.
  const aplicar = (aspecto, valor) => {
    if (valor == null) return;
    for (const lado of lados) {
      if (decls[`border-${lado}-${aspecto}`] == null) decls[`border-${lado}-${aspecto}`] = valor;
    }
  };
  aplicar('width', decls['border-width']);
  aplicar('color', decls['border-color']);
  aplicar('style', decls['border-style']);
  if (atalho != null) {
    const partes = atalho.trim().split(/\s+/);
    for (const parte of partes) {
      if (/^(solid|dashed|dotted|double|none|hidden)$/i.test(parte)) aplicar('style', parte.toLowerCase());
      else if (parseColor(parte)) aplicar('color', parte);
      else if (/^[\d.]+(px|pt|em|rem)$/i.test(parte)) aplicar('width', parte);
    }
  }
}

/**
 * Um seletor composto: tag, id, classes, atributos e combinador com o anterior.
 * `combinator: ' '` (descendente) ou `'>'` (filho). `null` no primeiro.
 */
function parseCompound(texto) {
  const composto = { tag: null, id: null, classes: [], attrs: [], pseudo: false };
  // Pseudo-classes não são avaliadas: `:hover` nunca casa (o link continua
  // aparecendo), `:root`/`:first-child` casam sempre. Guardamos a marca para
  // não inventar comportamento.
  // Pseudo-classes não são avaliadas: o que sobra do seletor é o que casa.
  // `:hover` continua valendo como o elemento-base — melhor um link que aparece
  // sem o efeito do que um link invisível.
  composto.pseudo = /::?[a-z-]+/i.test(texto);
  const limpo = texto.replace(/::?[a-z-]+(\([^)]*\))?/gi, '');
  const m = limpo.match(/^(\*|[a-z][a-z0-9-]*)?((?:[.#][\w-]+)*)((?:\[[^\]]*\])*)/i);
  if (!m) return composto;
  if (m[1] && m[1] !== '*') composto.tag = m[1].toLowerCase();
  for (const parte of (m[2] || '').matchAll(/([.#])([\w-]+)/g)) {
    if (parte[1] === '#') composto.id = parte[2];
    else composto.classes.push(parte[2]);
  }
  for (const parte of (m[3] || '').matchAll(/\[([^\]]*)\]/g)) composto.attrs.push(parte[1].trim());
  return composto;
}

function parseSelector(texto) {
  const bruto = String(texto).trim().replace(/\s+/g, ' ');
  if (!bruto) return null;
  const partes = bruto.replace(/>/g, ' > ').split(/\s+/).filter(Boolean);
  const compostos = [];
  let combinador = null;
  for (const parte of partes) {
    if (parte === '>') { combinador = '>'; continue; }
    const composto = parseCompound(parte);
    if (!composto.tag && !composto.id && !composto.classes.length && !composto.attrs.length && !composto.pseudo) continue;
    compostos.push({ ...composto, combinator: compostos.length === 0 ? null : (combinador || ' ') });
    combinador = null;
  }
  if (!compostos.length) return null;
  const especificidade = compostos.reduce((soma, c) =>
    soma + (c.id ? 100 : 0) + c.classes.length * 10 + c.attrs.length * 10 + (c.tag ? 1 : 0), 0);
  return { compostos, especificidade };
}

/**
 * Folha de estilo → lista de regras.
 * @returns {Array<{selector: string, compostos: object[], especificidade: number, decls: object, ordem: number}>}
 */
export function parseStyleSheet(css) {
  const regras = [];
  if (!css) return regras;
  let texto = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  // @media: as regras internas valem como se a condição tivesse sido satisfeita.
  // Descartá-las deixava páginas reais (que quase sempre têm layout em @media)
  // sem nada; aplicar todas é a aproximação honesta para uma tela só.
  texto = texto.replace(/@[a-z-]+[^{;]*\{/gi, '');
  let ordem = 0;
  for (const bloco of texto.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const seletorTexto = bloco[1].trim();
    const decls = parseDeclarations(bloco[2]);
    if (!Object.keys(decls).length) continue;
    for (const alternativa of seletorTexto.split(',')) {
      const seletor = parseSelector(alternativa);
      if (!seletor) continue;
      regras.push({ selector: alternativa.trim(), ...seletor, decls, ordem: ordem++ });
    }
  }
  return regras;
}

/** O composto casa com o elemento? (sem combinadores) */
function matchesCompound(el, composto) {
  const tag = (el.tagName || '').toLowerCase();
  if (composto.tag && composto.tag !== tag) return false;
  if (composto.id) {
    const id = el.getAttribute?.('id');
    if (id !== composto.id) return false;
  }
  for (const classe of composto.classes) {
    const valor = el.getAttribute?.('class') || '';
    if (!valor.split(/\s+/).includes(classe)) return false;
  }
  for (const attr of composto.attrs) {
    const [nome, esperado] = attr.split('=').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const valor = el.getAttribute?.(nome.toLowerCase());
    if (valor == null) return false;
    if (esperado != null && !esperado.startsWith('^') && !esperado.startsWith('*') && !esperado.startsWith('~') && valor !== esperado) return false;
  }
  return true;
}

/** Regra casa com o elemento, considerando combinadores e ancestrais? */
export function matchesSelector(el, regra) {
  const compostos = regra?.compostos;
  if (!el || !compostos?.length) return false;
  // Da direita para a esquerda (como todo motor de CSS): o último composto casa
  // com o próprio elemento; os anteriores sobem pelos ancestrais.
  if (!matchesCompound(el, compostos[compostos.length - 1])) return false;
  let atual = el.parentElement;
  for (let i = compostos.length - 2; i >= 0; i--) {
    const combinador = compostos[i + 1].combinator;   // conexão entre i e i+1
    if (combinador === '>') {
      if (!atual || !matchesCompound(atual, compostos[i])) return false;
      atual = atual.parentElement;
    } else {
      let achado = null;
      while (atual) {
        if (matchesCompound(atual, compostos[i])) { achado = atual; break; }
        atual = atual.parentElement;
      }
      if (!achado) return false;
      atual = achado.parentElement;
    }
  }
  return true;
}

const VALOR_INICIAL = {
  display: 'inline', color: '#1a1a1a', background: null,
  fontFamily: 'sans', fontSize: 16, fontWeight: 400, fontStyle: 'normal',
  textAlign: 'left', textDecoration: 'none', lineHeight: null,
  whiteSpace: 'normal', listStyleType: 'disc', borderRadius: 0,
  boxSizing: 'content-box'
};

const MARGEM_LADOS = ['top', 'right', 'bottom', 'left'];

function resolverFonte(familia) {
  const f = String(familia || '').toLowerCase();
  if (/mono|consolas|courier|menlo|monaco/.test(f)) return 'mono';
  if (/serif|georgia|times|garamond|palatino|book/.test(f) && !/sans/.test(f)) return 'serif';
  return 'sans';
}

/**
 * Estilo computado de um elemento.
 * @param {object} el            elemento do DOM
 * @param {object[]} regras      de `parseStyleSheet`
 * @param {object} pai           estilo computado do pai (herança)
 */
export function computeStyle(el, regras, pai = null) {
  const tag = (el.tagName || '').toLowerCase();
  const base = pai || { ...VALOR_INICIAL, fontSize: 16, margin: {}, padding: {}, border: {} };

  // 1) valores herdados
  const estilo = {
    ...VALOR_INICIAL,
    display: defaultDisplay(tag),
    fontSize: base.fontSize,
    fontFamily: base.fontFamily,
    fontWeight: base.fontWeight,
    fontStyle: base.fontStyle,
    color: base.color,
    textAlign: base.textAlign,
    lineHeight: base.lineHeight,
    listStyleType: base.listStyleType,
    whiteSpace: base.whiteSpace,
    textDecoration: 'none',
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: Object.fromEntries(MARGEM_LADOS.map(l => [l, { w: 0, color: null }])),
    width: null, height: null, maxWidth: null, minHeight: null
  };

  // Margens padrão do navegador para os elementos que as têm (sem isso, títulos e
  // parágrafos colam um no outro e a página "funciona" ficando ilegível).
  const padrao = PADROES_TAG[tag];
  if (padrao) {
    // Os padrões são escritos como números (21 = 21px) e viram `{px}` aqui: o
    // layout só entende comprimento resolvido, e número cru virava `undefined`.
    for (const lado of MARGEM_LADOS) {
      const m = padrao.margin?.[lado];
      if (m != null) estilo.margin[lado] = { px: m };
      const p = padrao.padding?.[lado];
      if (p != null) estilo.padding[lado] = { px: p };
    }
    if (padrao.fontSize) estilo.fontSize *= padrao.fontSize;
    if (padrao.fontWeight) estilo.fontWeight = padrao.fontWeight;
  }

  // 2) regras, na ordem: menor especificidade primeiro, empate pela ordem de escrita
  const aplicaveis = [];
  for (const regra of regras) {
    if (matchesSelector(el, regra)) aplicaveis.push(regra);
  }
  aplicaveis.sort((a, b) => (a.especificidade - b.especificidade) || (a.ordem - b.ordem));
  for (const regra of aplicaveis) applyDecls(estilo, regra.decls, base);

  // 3) `style=""` vence tudo
  const inline = el.getAttribute?.('style');
  if (inline) applyDecls(estilo, parseDeclarations(inline), base);

  return estilo;
}

/** Aplica declarações já expandidas sobre um estilo computado. */
export function applyDecls(estilo, decls) {
  for (const [prop, valor] of Object.entries(decls || {})) {
    switch (prop) {
      case 'display': {
        const v = String(valor).toLowerCase();
        if (v === 'none') estilo.display = 'none';
        else if (/^(block|list-item|inline|inline-block|table|table-row|table-cell|flex|grid)$/.test(v)) {
          // flex/grid não existem neste motor: viram bloco (conteúdo continua
          // visível; é a degradação que já estava prometida no design).
          estilo.display = v === 'inline-block' ? 'inline-block'
            : v === 'table-row' ? 'row' : v === 'table-cell' ? 'cell'
              : v === 'list-item' ? 'list-item'
                : v === 'inline' ? 'inline' : 'block';
        }
        break;
      }
      case 'color': { const c = parseColor(valor); if (c) estilo.color = c; break; }
      case 'background-color': { const c = parseColor(valor); if (c) estilo.background = c; break; }
      case 'background': { const c = parseColor(String(valor).split(/\s+/)[0]); if (c) estilo.background = c; break; }
      case 'font-size': { const l = parseLength(valor, estilo.fontSize); if (l?.px) estilo.fontSize = l.px; else if (l?.pct) estilo.fontSize *= l.pct / 100; break; }
      case 'font-weight': {
        const v = String(valor).toLowerCase();
        if (v === 'bold' || v === 'bolder') estilo.fontWeight = 700;
        else if (v === 'normal' || v === 'lighter') estilo.fontWeight = 400;
        else { const n = Number(v); if (Number.isFinite(n)) estilo.fontWeight = n; }
        break;
      }
      case 'font-style': estilo.fontStyle = /italic|oblique/.test(String(valor)) ? 'italic' : 'normal'; break;
      case 'font-family': estilo.fontFamily = resolverFonte(valor); break;
      case 'font': {
        const partes = String(valor).split(/\s+/);
        // `bold 20px/1.5 serif`: tamanho e line-height vêm colados por uma barra.
        const token = partes.find(p => /^[\d.]+(px|pt|em|rem|%)(\/[\d.]+)?$/.test(p));
        if (token) {
          const [tam, lh] = token.split('/');
          const l = parseLength(tam, estilo.fontSize);
          if (l?.px) estilo.fontSize = l.px;
          if (lh) estilo.lineHeight = Number(lh) || null;
        }
        if (/bold|[789]00/.test(valor)) estilo.fontWeight = 700;
        if (/italic|oblique/.test(valor)) estilo.fontStyle = 'italic';
        estilo.fontFamily = resolverFonte(valor);
        break;
      }
      case 'text-align': {
        const v = String(valor).toLowerCase();
        if (v === 'center' || v === 'right' || v === 'justify') estilo.textAlign = v === 'justify' ? 'left' : v;
        else if (v === 'left' || v === 'start') estilo.textAlign = 'left';
        break;
      }
      case 'text-decoration': case 'text-decoration-line':
        estilo.textDecoration = /underline/.test(String(valor)) ? 'underline' : (/line-through/.test(String(valor)) ? 'line-through' : 'none');
        break;
      case 'line-height': {
        const v = String(valor).trim();
        if (/^[\d.]+$/.test(v)) estilo.lineHeight = Number(v);
        else { const l = parseLength(v, estilo.fontSize); if (l?.px) estilo.lineHeight = l.px / estilo.fontSize; }
        break;
      }
      case 'white-space': estilo.whiteSpace = /pre/.test(String(valor)) ? 'pre' : 'normal'; break;
      case 'list-style-type': case 'list-style': {
        const v = String(valor).toLowerCase();
        if (/none/.test(v)) estilo.listStyleType = 'none';
        else if (/decimal/.test(v)) estilo.listStyleType = 'decimal';
        else if (/disc|circle|square/.test(v)) estilo.listStyleType = 'disc';
        break;
      }
      case 'border-radius': { const l = parseLength(String(valor).split(/\s+/)[0], estilo.fontSize); if (l?.px) estilo.borderRadius = l.px; break; }
      case 'box-sizing': estilo.boxSizing = /border-box/.test(String(valor)) ? 'border-box' : 'content-box'; break;
      case 'width': estilo.width = parseLength(valor, estilo.fontSize); break;
      case 'height': estilo.height = parseLength(valor, estilo.fontSize); break;
      case 'max-width': estilo.maxWidth = parseLength(valor, estilo.fontSize); break;
      case 'min-height': estilo.minHeight = parseLength(valor, estilo.fontSize); break;
      default: {
        const margem = prop.match(/^margin-(top|right|bottom|left)$/);
        if (margem) { const l = parseLength(valor, estilo.fontSize); estilo.margin[margem[1]] = l; break; }
        const padding = prop.match(/^padding-(top|right|bottom|left)$/);
        if (padding) { const l = parseLength(valor, estilo.fontSize); estilo.padding[padding[1]] = l; break; }
        const borda = prop.match(/^border-(top|right|bottom|left)-(width|color|style)$/);
        if (borda) {
          const lado = estilo.border[borda[1]];
          if (borda[2] === 'width') { const l = parseLength(valor, estilo.fontSize); lado.w = l?.px || 0; }
          else if (borda[2] === 'color') { const c = parseColor(valor); if (c) lado.color = c; }
          else if (borda[2] === 'style') lado.estilo = String(valor).toLowerCase();
          break;
        }
        if (prop === 'border-width') {
          const l = parseLength(valor, estilo.fontSize);
          for (const lado of MARGEM_LADOS) estilo.border[lado].w = l?.px || 0;
          break;
        }
        if (prop === 'border-color') {
          const c = parseColor(valor);
          if (c) for (const lado of MARGEM_LADOS) estilo.border[lado].color = c;
          break;
        }
        if (prop === 'border-style') {
          const v = String(valor).toLowerCase();
          for (const lado of MARGEM_LADOS) estilo.border[lado].estilo = v;
          break;
        }
      }
    }
  }
  // Borda sem estilo nunca é pintada (padrão do CSS: `border-width` sozinho não desenha).
  for (const lado of MARGEM_LADOS) {
    const b = estilo.border[lado];
    if (b.w > 0 && (!b.estilo || b.estilo === 'none' || b.estilo === 'hidden')) b.w = 0;
    if (b.w > 0 && !b.color) b.color = estilo.color;
  }
  return estilo;
}

/** Margens/pesos padrão do agente — o mínimo para a página ser legível. */
const PADROES_TAG = {
  body: { margin: { top: 8, right: 8, bottom: 8, left: 8 } },
  p: { margin: { top: 16, right: 0, bottom: 16, left: 0 } },
  h1: { margin: { top: 21, right: 0, bottom: 21, left: 0 }, fontSize: 1.6, fontWeight: 700 },
  h2: { margin: { top: 19, right: 0, bottom: 19, left: 0 }, fontSize: 1.4, fontWeight: 700 },
  h3: { margin: { top: 17, right: 0, bottom: 17, left: 0 }, fontSize: 1.17, fontWeight: 700 },
  h4: { margin: { top: 16, right: 0, bottom: 16, left: 0 }, fontSize: 1.05, fontWeight: 700 },
  h5: { margin: { top: 16, right: 0, bottom: 16, left: 0 }, fontSize: 0.95, fontWeight: 700 },
  h6: { margin: { top: 16, right: 0, bottom: 16, left: 0 }, fontSize: 0.85, fontWeight: 700 },
  blockquote: { margin: { top: 16, right: 40, bottom: 16, left: 40 } },
  ul: { margin: { top: 16, right: 0, bottom: 16, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 40 } },
  ol: { margin: { top: 16, right: 0, bottom: 16, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 40 } },
  pre: { margin: { top: 16, right: 0, bottom: 16, left: 0 } },
  hr: { margin: { top: 8, right: 0, bottom: 8, left: 0 } },
  dd: { margin: { top: 0, right: 0, bottom: 0, left: 40 } },
  table: { margin: { top: 0, right: 0, bottom: 0, left: 0 } },
  td: { padding: { top: 1, right: 2, bottom: 1, left: 2 } },
  th: { padding: { top: 1, right: 2, bottom: 1, left: 2 }, fontWeight: 700 }
};

/** Resolve um comprimento em px para uso no layout. */
export function resolveLength(len, contexto) {
  if (!len) return null;
  if (len.px != null) return len.px;
  if (len.pct != null && contexto?.width != null) return (len.pct / 100) * contexto.width;
  if (len.vw != null && contexto?.viewportWidth != null) return (len.vw / 100) * contexto.viewportWidth;
  if (len.vh != null && contexto?.viewportHeight != null) return (len.vh / 100) * contexto.viewportHeight;
  return null;
}

export function isInherited(prop) { return INHERITED.has(prop); }
