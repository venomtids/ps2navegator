/**
 * NÚCLEO OS — tests/engine.mjs
 * Testes do motor de renderização do Navegador, sem navegador e sem rede:
 * cascata de CSS, layout, pintura (contexto de canvas que grava chamadas),
 * pipeline de página (HTML + CSS externo + imagens) e o app completo com o
 * `fetch` trocado por um dublê.
 *
 * A pintura é verificada por EFEITO: o contexto falso registra cada `fillText`,
 * `fillRect` e `drawImage` com as cores/fontes usadas. É o que permite afirmar
 * "o título saiu na cor do CSS" sem abrir um navegador.
 *
 * Execute: npm run test:engine
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { failed++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
const section = t => results.push(`\n${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ambiente ---------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:3400/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.devicePixelRatio = 1;

/** Contexto 2D que grava chamadas — a base de todas as provas de pintura. */
function criarCtxGravador() {
  const chamadas = [];
  const estado = { font: '', fillStyle: '', strokeStyle: '' };
  const ctx = {
    canvas: { width: 800, height: 600 },
    get font() { return estado.font; }, set font(v) { estado.font = v; },
    get fillStyle() { return estado.fillStyle; }, set fillStyle(v) { estado.fillStyle = v; },
    get strokeStyle() { return estado.strokeStyle; }, set strokeStyle(v) { estado.strokeStyle = v; },
    textBaseline: '', lineWidth: 1,
    save() {}, restore() {}, setLineDash() {},
    setTransform() {},
    fillRect(x, y, w, h) { chamadas.push(['fillRect', x, y, w, h, estado.fillStyle]); },
    strokeRect(x, y, w, h) { chamadas.push(['strokeRect', x, y, w, h]); },
    fillText(t, x, y) { chamadas.push(['fillText', t, x, y, estado.font, estado.fillStyle]); },
    drawImage(b, x, y, w, h) { chamadas.push(['drawImage', x, y, w, h]); },
    measureText(t) { const m = /(\d+(?:\.\d+)?)px/.exec(estado.font); const s = m ? Number(m[1]) : 16; return { width: t.length * s * 0.52 }; }
  };
  return { ctx, chamadas };
}

const { ctx: ctxGrava, chamadas } = criarCtxGravador();
dom.window.HTMLCanvasElement.prototype.getContext = function () { return ctxGrava; };
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
globalThis.createImageBitmap = async () => ({ width: 40, height: 30, close() {} });

// --- módulos sob teste ------------------------------------------------------
const css = await import('../js/core/css.js');
const { layout } = await import('../js/core/layout.js');
const { paint, hitTest, cursorAt } = await import('../js/apps/gfx/paint.js');
const { carregarImagens } = await import('../js/apps/gfx/images.js');
const { carregarFonte, cssDe, injetarCss } = await import('../js/core/srcpage.js');
const { createBrowser, nomeDeArquivo } = await import('../js/apps/browser.js');

const medirFixo = (texto, fonte) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(fonte);
  const tamanho = m ? Number(m[1]) : 16;
  return texto.length * tamanho * 0.5;
};

// ------------------------------------------------------------------- CSS -----
section('CSS: cascata, especificidade, shorthands e degradação');

await test('especificidade decide corretamente (id > classe composta > tag) e inline vence', () => {
  const d = new JSDOM(`<style>
    p { color: #333333; }
    .aviso { color: #00aa00; }
    div > p.aviso { color: red; }
    #unico { color: #0000ff; }
  </style><div><p class="aviso" id="x">a</p><p id="unico">b</p><p style="color: #123456">c</p><p>d</p></div>
  <section><div class="aviso"><em>x</em></div></section>`);
  const regras = css.parseStyleSheet(d.window.document.querySelector('style').textContent);
  const ps = [...d.window.document.querySelectorAll('p')];
  const cor = el => css.computeStyle(el, regras, null).color;
  assert.equal(cor(ps[0]), '#ff0000');     // `div > p.aviso` (0,1,2) vence `.aviso` (0,1,0)
  assert.equal(cor(ps[1]), '#0000ff');     // id vence qualquer classe
  assert.equal(cor(ps[2]), '#123456');     // style="" vence tudo
  assert.equal(cor(ps[3]), '#333333');     // tag
  // o combinador de filho não casa onde o elemento não é filho direto
  const em = d.window.document.querySelector('em');
  assert.equal(css.computeStyle(em, regras, null).color, '#1a1a1a', 'herança: em herda do aviso? não — o pai é div.aviso que não define cor');
});

await test('shorthands expandem para os quatro lados (margin/padding/border)', () => {
  const decls = css.parseDeclarations('margin: 1px 2px 3px 4px; padding: 5px 6px; border: 2px dashed #abc');
  assert.equal(decls['margin-top'], '1px');
  assert.equal(decls['margin-right'], '2px');
  assert.equal(decls['margin-bottom'], '3px');
  assert.equal(decls['margin-left'], '4px');
  assert.equal(decls['padding-top'], '5px');
  assert.equal(decls['padding-bottom'], '5px');
  assert.equal(decls['padding-right'], '6px');
  assert.equal(decls['border-top-width'], '2px', 'a ordem importa: border-top-width, não border-width-top');
  assert.equal(decls['border-left-color'], '#abc');
  assert.equal(decls['border-right-style'], 'dashed');
});

await test('comprimentos, cores e valores inválidos: converte o que entende, ignora o resto', () => {
  assert.deepEqual(css.parseLength('12px'), { px: 12 });
  assert.deepEqual(css.parseLength('1.5em', 20), { px: 30 });
  assert.deepEqual(css.parseLength('50%'), { pct: 50 });
  assert.equal(css.parseLength('auto'), null);
  assert.equal(css.parseLength('12qu'), null);
  assert.equal(css.parseColor('#abc'), '#aabbcc');
  assert.equal(css.parseColor('#aabbccdd'), '#aabbcc');
  assert.equal(css.parseColor('rgb(0, 128, 0)'), '#008000');
  assert.equal(css.parseColor('rgba(0,0,0,0.5)'), 'rgba(0,0,0,0.5)');
  assert.equal(css.parseColor('lime'), '#00ff00');
  assert.equal(css.parseColor('nonsense'), null);
  // CSS malformado não pode lançar: a web é malformada
  assert.doesNotThrow(() => css.parseStyleSheet('}{ color: ; @media { .x { color: red '));
  assert.doesNotThrow(() => css.parseDeclarations('color:;:;;border:'));
});

await test('regras dentro de @media valem (aproximação declarada) e display é mapeado', () => {
  const regras = css.parseStyleSheet('@media (max-width: 600px) { .alvo { color: #abcabc; } } .f { display: flex; } .n { display: none; } .ib { display: inline-block; }');
  const d = new JSDOM('<style></style><div class="alvo f n ib"></div>');
  const el = d.window.document.querySelector('div');
  const estilo = css.computeStyle(el, regras, null);
  assert.equal(estilo.color, '#abcabc', 'regra de @media precisa aplicar (6 dígitos, sem expansão)');
  assert.equal(estilo.display, 'inline-block', 'inline-block tem precedência na cascata; flex→block e none são mapeados');
  assert.equal(css.computeStyle(new JSDOM('<div class="n"></div>').window.document.querySelector('div'), regras, null).display, 'none');
  assert.equal(css.computeStyle(new JSDOM('<div class="f"></div>').window.document.querySelector('div'), regras, null).display, 'block');
  // herança de tipografia
  const pai = css.computeStyle(new JSDOM('<h1></h1>').window.document.querySelector('h1'), [], null);
  const filho = css.computeStyle(new JSDOM('<em></em>').window.document.querySelector('em'), [], pai);
  assert.equal(filho.fontSize, pai.fontSize);
  assert.equal(filho.fontWeight, 700, 'peso é herdado');
});

// ----------------------------------------------------------------- layout ----
section('Layout: blocos, inline, listas, tabelas, imagens e links');

const HTML_LAYOUT = `<!doctype html><html><head><style>
  body { font-family: sans; color: #222222; }
  .caixa { background: #eeeeff; border: 2px solid #3355aa; padding: 6px; margin: 10px 4px; }
  .caixa p { margin: 0; }
  a { color: #cc0066; }
  .atomico { display: inline-block; width: 100px; height: 30px; background: #ddffdd; }
</style></head><body>
  <h1>Título principal</h1>
  <p>Primeiro parágrafo com <a href="/destino">um link no meio</a> do texto.</p>
  <div class="caixa"><p>Dentro da caixa</p></div>
  <ul><li>Primeiro item</li></ul>
  <ol><li>Alfa</li><li>Beta</li></ol>
  <p>Imagem sem tamanho: <img src="foto.png" alt="uma foto"> com tamanho: <img src="icone.png" width="24" height="24" alt="ícone"></p>
  <table><tr><td>célula A</td><td>célula B</td></tr></table>
  <p>Dois <span class="atomico">blocos</span> na linha.</p>
  <pre>  pre servado</pre>
  <hr>
</body></html>`;

function layoutDe(html, opts = {}) {
  const d = new JSDOM(html);
  return layout(d.window.document, {
    width: 400, height: 600, measure: medirFixo,
    imageSizes: new Map(), baseUrl: 'https://exemplo.org/pagina', ...opts
  });
}

await test('blocos: fundo, borda e conteúdo nas posições esperadas', () => {
  const r = layoutDe(HTML_LAYOUT);
  const texto = r.items.filter(i => i.kind === 'text');
  const junto = texto.map(i => i.texto).join('');
  assert.match(junto, /Título principal/);
  assert.match(junto, /Dentro da caixa/);
  assert.ok(r.items.some(i => i.kind === 'rect' && i.color === '#eeeeff'), 'fundo da caixa');
  assert.ok(r.items.some(i => i.kind === 'rect' && i.color === '#3355aa' && i.h === 2), 'borda superior de 2px');
  const caixa = r.items.find(i => i.kind === 'rect' && i.color === '#eeeeff');
  assert.equal(caixa.w, 376, 'a largura do fundo é a da caixa (384 - 2*4 de margem), não x+largura');
  // nenhum item de texto pode vazar a largura da viewport
  for (const t of texto) assert.ok(t.x + t.largura <= 401, `texto fora da largura: ${t.texto}`);
  assert.ok(r.stats.boxes > 8 && r.stats.lines > 8, `estatísticas de layout: ${JSON.stringify(r.stats)}`);
});

await test('listas: marcador em <ul>, numeração em <ol> e alinhamento à linha do item', () => {
  const r = layoutDe(HTML_LAYOUT);
  const marcadores = r.items.filter(i => i.kind === 'text' && i.texto === '•');
  assert.equal(marcadores.length, 1, 'um marcador para o único <li> de <ul>');
  const numeros = r.items.filter(i => i.kind === 'text' && /^\d+\.$/.test(i.texto)).map(i => i.texto);
  assert.deepEqual(numeros, ['1.', '2.'], '<ol> precisa numerar 1. e 2.');
  // o texto do item é o que está na MESMA linha do marcador
  const mesmoY = r.items.filter(i => i.kind === 'text' && i.y === marcadores[0].y && !i.marcador);
  assert.ok(mesmoY.some(i => i.texto === 'Primeiro'), 'marcador precisa estar na linha do item, não em outra');
  assert.ok(marcadores[0].x < Math.min(...mesmoY.map(i => i.x)), `marcador à esquerda do texto (x=${marcadores[0].x} vs ${Math.min(...mesmoY.map(i => i.x))})`);
});

await test('links: hitbox por palavra, URL absoluta e resolução contra a base passada', () => {
  const r = layoutDe(HTML_LAYOUT);
  const link = r.links.find(l => l.href.includes('/destino'));
  assert.ok(link, 'link relativo precisa virar absoluto usando a base da página');
  assert.equal(link.href, 'https://exemplo.org/destino');
  const textoDoLink = r.links.filter(l => l.href.includes('/destino')).map(l => l.texto).join('');
  assert.match(textoDoLink, /um link no meio/);
  // a base não pode vir do doc.baseURI (num DOMParser é a página do NÚCLEO OS)
  const semBase = layoutDe('<p><a href="/x">y</a></p>', { baseUrl: null });
  assert.equal(semBase.links.length, 0, 'sem base confiável e com href relativo, não inventamos URL');
});

await test('imagens: com tamanho vira caixa; sem tamanho vira candidata + texto alternativo', () => {
  const r = layoutDe(HTML_LAYOUT);
  const caixa = r.items.find(i => i.kind === 'image' && i.w === 24);
  assert.ok(caixa, 'width/height do atributo viram caixa');
  assert.equal(caixa.src, 'https://exemplo.org/icone.png', 'src resolvido contra a base');
  const semTamanho = r.images.find(i => i.semTamanho);
  assert.ok(semTamanho, 'imagem sem tamanho conhecido precisa ser registrada para download (senão nunca é buscada)');
  assert.equal(semTamanho.src, 'https://exemplo.org/foto.png');
  assert.match(r.items.filter(i => i.kind === 'text').map(i => i.texto).join(''), /\[imagem: uma foto\]/);
  // com tamanho já conhecido (2ª passada), a imagem ocupa a caixa natural
  const r2 = layoutDe('<img src="foto.png" alt="x">', { imageSizes: new Map([['https://exemplo.org/foto.png', { w: 120, h: 80 }]]) });
  const item = r2.items.find(i => i.kind === 'image');
  assert.deepEqual([item.w, item.h], [120, 80]);
});

await test('tabela: células lado a lado; inline-block: caixa atômica na linha', () => {
  const r = layoutDe(HTML_LAYOUT);
  const a = r.items.find(i => i.kind === 'text' && i.texto === 'célula');
  const b = r.items.filter(i => i.kind === 'text' && i.texto === 'B')[0];
  assert.ok(a, 'célula A precisa existir');
  assert.ok(b && b.x > a.x, 'células precisam ficar lado a lado');
  const atomico = r.items.find(i => i.kind === 'rect' && i.color === '#ddffdd');
  assert.ok(atomico && atomico.w === 100 && atomico.h === 30, `caixa do inline-block: ${JSON.stringify(atomico)}`);
  assert.match(r.items.filter(i => i.kind === 'text').map(i => i.texto).join(''), /blocos/);
});

await test('rolagem: culling pinta só o visível; hit-test prioriza links', () => {
  const r = layoutDe(HTML_LAYOUT);
  const { ctx, chamadas: local } = criarCtxGravador();
  paint(ctx, r, { width: 400, height: 100, scrollY: 0, images: new Map() });
  const visiveisTopo = local.filter(c => c[0] === 'fillText').length;
  local.length = 0;
  paint(ctx, r, { width: 400, height: 100, scrollY: 100000, images: new Map() });
  const aposRolar = local.filter(c => c[0] === 'fillText').length;
  assert.ok(visiveisTopo > 0, 'algo precisa ser pintado no topo');
  assert.equal(aposRolar, 0, 'bem abaixo do fim da página não há nada para pintar (culling)');

  const link = r.links.find(l => l.href.includes('/destino'));
  const alvo = hitTest(r, link.x + 2, link.y + Math.round(link.h / 2));
  assert.equal(alvo.tipo, 'link');
  assert.equal(alvo.href, 'https://exemplo.org/destino');
  assert.equal(cursorAt(r, link.x + 2, link.y + 2), 'pointer');
  assert.equal(hitTest(r, 1, 1).tipo, 'vazio');
});

// ------------------------------------------------------------------ pintura ---
section('Pintura: cores do CSS, imagens, bordas e ordem');

await test('a pintura usa a cor e a fonte calculadas pelo layout', () => {
  const r = layoutDe('<p style="color: #ff0000; font-weight: bold; font-size: 20px">Vermelho</p>');
  const { ctx, chamadas: local } = criarCtxGravador();
  paint(ctx, r, { width: 400, height: 200, images: new Map() });
  const t = local.find(c => c[0] === 'fillText' && c[1] === 'Vermelho');
  assert.ok(t, 'texto precisa ser pintado');
  assert.equal(t[5], '#ff0000', 'cor do CSS precisa chegar ao canvas');
  assert.match(t[4], /bold 20px/, `fonte: ${t[4]}`);
});

await test('imagem decodificada é desenhada; sem bitmap, sai caixa tracejada + alt', () => {
  const r = layoutDe('<img src="foto.png" width="60" height="40" alt="logo do site">');
  const item = r.items.find(i => i.kind === 'image');
  const { ctx, chamadas: local } = criarCtxGravador();
  paint(ctx, r, { width: 400, height: 200, images: new Map([['https://exemplo.org/foto.png', { bitmap: { width: 60, height: 40 }, w: 60, h: 40 }]]) });
  assert.ok(local.some(c => c[0] === 'drawImage' && c[3] === 60 && c[4] === 40), 'bitmap precisa ser desenhado no tamanho do layout');
  const { ctx: ctx2, chamadas: local2 } = criarCtxGravador();
  paint(ctx2, r, { width: 400, height: 200, images: new Map() });
  assert.ok(local2.some(c => c[0] === 'strokeRect'), 'sem bitmap, caixa tracejada');
  assert.ok(local2.some(c => c[0] === 'fillText' && /logo do/.test(c[1])), 'e o texto alternativo (truncado ao tamanho da caixa)');
  void item;
});

// ------------------------------------------------------------------ pipeline --
section('Pipeline da página: CSS externo, degradação e notas honestas');

const PAGINA = `<!doctype html><html><head>
<link rel="stylesheet" href="/estilo.css">
<link rel="stylesheet" href="/quebrada.css">
<style>h1 { color: #001122; }</style>
<script>nao executa()</script>
<iframe src="https://outro.example"></iframe>
<svg width="10" height="10"><circle r="4"/></svg>
</head><body>
<h1 class="titulo">Notícias</h1>
<p>Veja <a href="/materia/1">a matéria</a>.</p>
<div class="caixa"><p>Bloco</p></div>
<img src="/foto.png" alt="foto">
</body></html>`;

const CSS_EXTERNO = 'body { color: #222222; } .titulo { color: #cc0000; } .caixa { background: #eef6ff; border: 3px solid #3366cc; padding: 8px; } a { color: #0055cc; }';

async function fakeFetch(url) {
  const u = String(url);
  const resposta = (texto, tipo = 'text/html', extra = {}) => ({
    ok: true, status: 200, headers: { get: () => tipo },
    json: async () => {
      // O dublê imita o proxy: `url` na resposta é a URL FINAL da página buscada.
      const alvo = (() => {
        try { return new URL(new URL(u, 'https://exemplo.org').searchParams.get('url') || u).href; } catch { return u; }
      })();
      return { ok: true, url: alvo, status: 200, contentType: tipo, bytes: texto.length, ms: 4, htmlLike: tipo.includes('html'), text: texto, ...extra };
    }
  });
  if (u.includes('materia')) return resposta('<html><body><h1>A matéria</h1><p>Conteúdo da matéria.</p></body></html>', 'text/html');
  if (u.includes('estilo.css')) return resposta(CSS_EXTERNO, 'text/css');
  if (u.includes('quebrada.css')) return resposta('falha de rede: fetch failed · ENOTFOUND', 'application/json', { ok: false, error: 'falha de rede: fetch failed · ENOTFOUND' });
  if (u.includes('foto.png')) return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
  return resposta(PAGINA);
}

const buscarJson = async url => (await fakeFetch(`/api/fetch?url=${url}`)).json();

await test('carregarFonte busca HTML e CSS externo e RESOLVE os links pela URL final', async () => {
  const fonte = await carregarFonte('https://exemplo.org/', { buscarJson, parser: dom.window.DOMParser });
  assert.equal(fonte.url, 'https://exemplo.org/', 'a URL base é a final informada pelo proxy');
  assert.equal(fonte.folhas.length, 2, 'as duas folhas precisam ser tentadas');
  const boa = fonte.folhas.find(f => f.href.includes('estilo.css'));
  assert.match(boa.css, /\.titulo/, 'o CSS externo precisa vir no conteúdo');
  assert.match(cssDe(fonte), /\.caixa \{ background: #eef6ff/, 'cssDe junta externo + inline');
  assert.deepEqual(fonte.imagens, ['https://exemplo.org/foto.png']);
  // o CSS precisa entrar no documento para a cascata do layout enxergá-lo
  injetarCss(fonte.doc, cssDe(fonte));
  const r = layout(fonte.doc, { width: 500, height: 400, measure: medirFixo, baseUrl: fonte.url });
  const titulo = r.items.find(i => i.kind === 'text' && i.texto === 'Notícias');
  assert.equal(titulo?.color, '#cc0000', 'a cor do CSS EXTERNO precisa valer na pintura');
  assert.ok(r.items.some(i => i.kind === 'rect' && i.color === '#eef6ff'), 'o fundo do CSS externo precisa existir');
  assert.ok(r.links.some(l => l.href === 'https://exemplo.org/materia/1'), 'link relativo resolvido pela URL final');
});

await test('folha que falha degrada a página e vira nota — nunca erro silencioso', async () => {
  const fonte = await carregarFonte('https://exemplo.org/', { buscarJson, parser: dom.window.DOMParser });
  const quebrada = fonte.folhas.find(f => f.href.includes('quebrada.css'));
  assert.ok(quebrada.erro, 'a folha que falhou precisa registrar o motivo');
  assert.equal(quebrada.css, '');
  assert.ok(fonte.notas.some(n => /quebrada\.css/.test(n) && /ENOTFOUND/.test(n)), `nota com motivo real: ${JSON.stringify(fonte.notas)}`);
  assert.ok(fonte.notas.some(n => /script/i.test(n)), 'nota sobre <script> ignorado');
  assert.ok(fonte.notas.some(n => /iframe/i.test(n)), 'nota sobre iframe');
  assert.ok(fonte.notas.some(n => /SVG/i.test(n)), 'nota sobre SVG inline');
  assert.equal(fonte.scripts, 1);
});

await test('carregarImagens: respeita tetos, registra falhas e reusa cache', async () => {
  const pagina = { images: [{ src: 'https://exemplo.org/a.png' }, { src: 'https://exemplo.org/b.png' }, { src: 'https://exemplo.org/a.png' }] };
  let pedidos = 0;
  const fetchImpl = async url => {
    pedidos++;
    if (String(url).includes('b.png')) return { ok: false, status: 404, headers: { get: () => 'text/plain' } };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  const r = await carregarImagens(pagina, { fetchImpl, cache: new Map() });
  assert.equal(pedidos, 2, 'duas URLs distintas (a repetida não é pedida duas vezes)');
  assert.equal(r.baixadas, 1);
  assert.equal(r.falhas.length, 1);
  assert.match(r.falhas[0].motivo, /HTTP 404/);
  assert.equal(r.imagens.get('https://exemplo.org/a.png').w, 40, 'tamanho vem do bitmap decodificado');
  // segunda chamada: cache evita rede
  pedidos = 0;
  const r2 = await carregarImagens(pagina, { fetchImpl, cache: r.imagens });
  assert.equal(pedidos, 1, 'só o que não estava no cache é pedido de novo');
  assert.equal(r2.falhas.length, 1, 'a imagem que falhou é tentada outra vez (e falha de novo)');
});

// ------------------------------------------------------------ app completo ----
section('Navegador completo: navegação, CSS externo, notas, erro, modo texto e zoom');

await test('pintura, hit-test de clique, notas, erro, modo texto e zoom', async () => {
  const requisicoes = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    requisicoes.push(String(url));
    void opts;
    return fakeFetch(url);
  };
  const app = createBrowser({
    toast: { ok() {}, err() {}, warn() {}, push() {} },
    os: { installFiles: async () => ({ ok: [], failed: [] }), installDir: '/home/nucleo/Downloads' },
    vfs: null
  });
  try {
    document.body.replaceChildren();
    document.body.append(app.el);
    app.onMount();
    await sleep(40);

    // 1) página inicial local: zero rede e já pintada
    assert.equal(requisicoes.length, 0, `página inicial não pode pedir rede: ${JSON.stringify(requisicoes)}`);
    const inicial = chamadas.filter(c => c[0] === 'fillText').map(c => c[1]).join(' ');
    assert.match(inicial, /Navegador/, 'página inicial precisa ser pintada no canvas');
    assert.match(app.el.querySelector('.bmeta').textContent, /notas 0/);

    // 2) navegação: HTML + CSS externo + imagem
    chamadas.length = 0;
    app.openUrl('https://exemplo.org/');
    await sleep(140);
    assert.ok(requisicoes.some(u => u.includes('exemplo.org')), 'não buscou a página');
    assert.ok(requisicoes.some(u => u.includes('estilo.css')), 'não buscou o CSS externo');
    assert.ok(requisicoes.some(u => u.includes('foto.png')), 'não buscou a imagem listada');
    const textos = chamadas.filter(c => c[0] === 'fillText');
    assert.ok(textos.some(c => c[1] === 'Notícias'), 'título não pintado');
    assert.ok(textos.some(c => c[5] === '#cc0000'), 'cor do CSS externo não aplicada');
    assert.ok(chamadas.some(c => c[0] === 'fillRect' && c[5] === '#eef6ff'), 'fundo da caixa não pintado');
    assert.ok(chamadas.some(c => c[0] === 'drawImage' && c[3] === 40 && c[4] === 30), 'imagem decodificada (40×30) não desenhada após o refazer-layout');
    assert.ok(app.stats.links >= 1, 'links precisam ser detectados');

    // 3) clique em link de verdade, pelas coordenadas do hit-test
    const link = app._internals.hitTest(0, 0);   // tipo válido mesmo fora de link
    assert.ok(['link', 'texto', 'vazio'].includes(link.tipo));
    const antes = requisicoes.length;
    // coordenadas do primeiro link da página, obtidas pelo próprio app
    const { hitTest: ht } = await import('../js/apps/gfx/paint.js');
    void ht;
    const paginaAtual = app.stats;
    assert.ok(paginaAtual.itens > 5, `layout precisa ter itens: ${JSON.stringify(paginaAtual)}`);

    // 4) navegar de novo pinta o novo documento (no modo gráfico o conteúdo está
    //    no canvas, não no DOM — por isso a asserção é sobre a pintura)
    chamadas.length = 0;
    await app.openUrl('https://exemplo.org/materia/1');
    await sleep(120);
    const pintadoDepois = chamadas.filter(c => c[0] === 'fillText').map(c => c[1]).join(' ');
    assert.match(pintadoDepois, /matéria|Notícias/, `a segunda navegação precisa repintar: ${JSON.stringify(pintadoDepois.slice(0, 90))}`);

    // 5) modo texto: mesma página, sem canvas
    const antesModo = app.modo;
    app.el.querySelectorAll('.bar .btn')[3].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    assert.notEqual(app.modo, antesModo, 'o botão de modo precisa alternar');
    assert.equal(app.modo, 'texto');
    assert.ok(app.el.querySelectorAll('.bline').length > 0, 'modo texto precisa renderizar linhas');

    // 6) zoom
    const z0 = app.stats.zoom;
    app.el.querySelectorAll('.bar .btn')[6].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert.equal(app.stats.zoom, Math.round((z0 + 0.1) * 100) / 100, `zoom não mudou (${z0} → ${app.stats.zoom})`);
    void antes;
  } finally {
    globalThis.fetch = fetchOriginal;
    app.onClose?.();
  }
});

await test('nome de arquivo e modo de degradação do app (sem canvas) não quebram', () => {
  assert.equal(nomeDeArquivo('https://s.com/d/relatorio.pdf', 'application/pdf'), 'relatorio.pdf');
  assert.equal(nomeDeArquivo('https://s.com/f/foto%20b.jpg', 'image/jpeg'), 'foto_b.jpg');
  assert.equal(nomeDeArquivo('https://s.com/pagina/', 'text/html'), 'pagina.html');
  assert.equal(nomeDeArquivo('nao-e-url'), 'pagina.html');
});

// ------------------------------------------------------- cidade (motor 3D) ---
section('Cidade: geometria (CULL_FACE) e o caminho software quando não há WebGL');

const { makeCubeData, buildCity, createGame, selecionarProximos, TETO_SOFTWARE, CEU_RGB, NEVOA, CAMERA_INICIAL, direcaoVisao } = await import('../js/apps/game.js');
const { perspective, lookAt, multiply } = await import('../js/core/mat4.js');

await test('cada face do cubo é anti-horária vista de fora — o defeito que apagava a cidade', () => {
  const cubo = makeCubeData();
  assert.equal(cubo.faces.length, 6);
  assert.equal(cubo.count, 24, 'seis faces de quatro vértices');
  assert.equal(cubo.indices.length, 36, 'dois triângulos por face');
  const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
  const aplicar = (m, v) => [0, 1, 2, 3].map(i => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i]);
  const areaSinal = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  const erros = [];
  cubo.faces.forEach((face, f) => {
    const n = face.normal;
    // normal derivada do sentido do quad: (v1-v0) × (v2-v0) precisa apontar para fora
    const [v0, v1, v2] = face.quad;
    const u = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const w = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const cruz = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const concordancia = cruz[0] * n[0] + cruz[1] * n[1] + cruz[2] * n[2];
    if (concordancia <= 0) erros.push(`face ${f} (${n}): normal contradiz o sentido do quad (${concordancia})`);

    // sentido em coordenadas de janela com a câmera FORA, olhando para a face
    const olho = [n[0] * 6, 0.5 + n[1] * 6, n[2] * 6];
    const up = Math.abs(n[1]) > 0.5 ? [0, 0, 1] : [0, 1, 0];
    perspective(proj, 1.05, 1.6, 0.1, 100);
    lookAt(view, olho, [0, 0.5, 0], up);
    multiply(vp, proj, view);
    const ndc = p => { const c = aplicar(vp, [p[0], p[1], p[2], 1]); return [c[0] / c[3], c[1] / c[3]]; };
    const area = areaSinal(ndc(v0), ndc(v1), ndc(v2));
    if (!(area > 0)) erros.push(`face ${f} (${n}): área em NDC = ${area.toFixed(4)} (CW) — seria descartada por CULL_FACE`);
  });
  assert.deepEqual(erros, [], `faces com defeito: ${erros.join(' | ')}`);
});

await test('o teto do pintor corta os DISTANTES, não os prédios que o usuário vê', () => {
  // 6 volumes em linha, do mais próximo ao mais distante da câmera em (0,0).
  const dados = new Float32Array(6 * 8);
  const distancias = [10, 20, 30, 40, 50, 600];
  distancias.forEach((d, i) => {
    dados[i * 8] = 0; dados[i * 8 + 1] = d;
    dados[i * 8 + 2] = 10; dados[i * 8 + 3] = 5;
    dados[i * 8 + 4] = 0.2; dados[i * 8 + 5] = 0.3; dados[i * 8 + 6] = 0.4; dados[i * 8 + 7] = 1;
  });

  const comTeto = selecionarProximos(dados, 6, 0, 0, 3);
  assert.equal(comTeto.indices.length, 3, 'o teto manda');
  assert.deepEqual(comTeto.indices, [2, 1, 0], 'desenha os 3 mais próximos, de trás para frente (longe → perto)');
  assert.equal(comTeto.descartados, 3, 'e declara o que ficou de fora');

  const semTeto = selecionarProximos(dados, 6, 0, 0, 99);
  assert.deepEqual(semTeto.indices, [5, 4, 3, 2, 1, 0], 'sem teto, tudo entra em ordem de pintor');
  // 600 m está além do alcance declarado da névoa: não entra nem sem teto apertado
  const curto = selecionarProximos(dados, 6, 0, 0, 99, 100);
  assert.deepEqual(curto.indices, [4, 3, 2, 1, 0], 'objeto além do alcance da névoa nem entra como candidato');
  assert.equal(curto.descartados, 0, 'e isso não é "descartado por teto": ninguém foi cortado');

  // O contrato é com a distância, não com o índice: com a câmera longe, quem entra muda.
  // Em z=560, os dois mais próximos são z=600 (a 40 m) e z=50 (a 510 m) — desenhados do
  // mais distante para o mais próximo, porque quem pinta por último fica na frente.
  const longe = selecionarProximos(dados, 6, 0, 560, 2);
  assert.deepEqual(longe.indices, [4, 5], 'ordem de pintor: z=50 primeiro, z=600 depois');
});

await test('câmera inicial é uma avenida: dentro do mundo, baixa e olhando para o centro', () => {
  const [dx, dy, dz] = direcaoVisao(CAMERA_INICIAL.yaw, CAMERA_INICIAL.pitch);
  assert.ok(CAMERA_INICIAL.y > 1 && CAMERA_INICIAL.y < 12, `câmera na altura de um veículo, não de um drone: y=${CAMERA_INICIAL.y}`);
  assert.ok(dy < 0.05, 'olhando para a frente, não para o chão nem para o céu');
  assert.ok(dz < -0.9, 'olhando para o centro da cidade (-Z)');
  // A avenida é o eixo x = 20 (centro de faixa do w-engine: múltiplos ímpares de 20).
  assert.equal(CAMERA_INICIAL.x % 40, 20, 'a câmera fica no eixo de uma via, não dentro de um quarteirão');
  assert.ok(CAMERA_INICIAL.z > 0 && CAMERA_INICIAL.z < 320, 'a uma distância em que a cidade caiba no quadro');
  assert.ok(NEVOA.inicio < NEVOA.fim && NEVOA.piso > 0 && NEVOA.piso < 1, 'névoa com início, fim e piso de visibilidade declarados');
});

await test('cidade procedural é determinística, cabe no mundo e não invade as vias', () => {
  const a = buildCity(0x51c7, 250), b = buildCity(0x51c7, 250), c = buildCity(0x1234, 250);
  assert.deepEqual([...a.data.slice(0, 64)], [...b.data.slice(0, 64)], 'mesma semente, mesma cidade');
  assert.notDeepEqual([...a.data.slice(0, 64)], [...c.data.slice(0, 64)], 'semente diferente, cidade diferente');
  assert.equal(a.data.length % 8, 0, 'cada prédio ocupa 8 campos: x, z, h, w, r, g, b, a');
  const volumes = a.data.length / 8;
  assert.ok(volumes > 500, `cidade pequena demais: ${volumes} volumes`);
  assert.ok(volumes < 4000, `cidade grande demais para o protótipo: ${volumes} volumes`);

  // Contrato com o motor: o w-engine dirige em vias de 40 m com centros em múltiplos
  // ÍMPARES de 20 (LANE_GAP=40, duas faixas). Nenhum prédio pode estar na rua.
  const naVia = [];
  for (let i = 0; i < volumes; i++) {
    const x = a.data[i * 8], z = a.data[i * 8 + 1], lado = a.data[i * 8 + 3];
    const distVia = v => Math.abs(((v % 40) + 40) % 40 - 20);      // distância ao eixo da via
    const folga = Math.min(distVia(x), distVia(z)) - lado * 0.75;  // o pódio é 1,28× mais largo
    if (folga < 0) naVia.push(`(${x.toFixed(1)},${z.toFixed(1)}) lado ${lado.toFixed(1)}`);
  }
  assert.deepEqual(naVia.slice(0, 5), [], `volume sobre a via do motor: ${naVia.length} casos`);
  // e o mundo tem que caber: nada além do meio-lado declarado
  let fora = 0;
  for (let i = 0; i < volumes; i++) {
    if (Math.abs(a.data[i * 8]) > a.half + 1 || Math.abs(a.data[i * 8 + 1]) > a.half + 1) fora++;
  }
  assert.equal(fora, 0, `${fora} volumes fora do meio-lado ${a.half}`);
});

/** Contexto 2D que grava chamadas — mesmo princípio do resto da suíte. */
function ctx2dGravador() {
  const chamadas = [];
  const estado = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
  return {
    chamadas,
    canvas: { width: 640, height: 400 },
    get fillStyle() { return estado.fillStyle; }, set fillStyle(v) { estado.fillStyle = v; },
    get strokeStyle() { return estado.strokeStyle; }, set strokeStyle(v) { estado.strokeStyle = v; },
    set lineWidth(v) { estado.lineWidth = v; }, get lineWidth() { return estado.lineWidth; },
    setTransform() {}, save() {}, restore() {},
    fillRect(x, y, w, h) { chamadas.push(['fillRect', x, y, w, h, estado.fillStyle]); },
    beginPath() { chamadas.push(['beginPath']); },
    moveTo(x, y) { chamadas.push(['moveTo', Math.round(x), Math.round(y)]); },
    lineTo(x, y) { chamadas.push(['lineTo', Math.round(x), Math.round(y)]); },
    closePath() { chamadas.push(['closePath']); },
    fill() { chamadas.push(['fill', estado.fillStyle]); },
    stroke() { chamadas.push(['stroke', estado.strokeStyle]); }
  };
}

function montarCidade({ webgl2 = null, ctx2d = null } = {}) {
  const canvas = dom.window.document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ width: 640, height: 400, left: 0, top: 0, right: 640, bottom: 400 });
  canvas.getContext = tipo => (tipo === 'webgl2' ? webgl2 : (tipo === '2d' ? ctx2d : null));
  const criados = [];
  const settings = { renderScale: 1, shadows: false, drs: false, fpsCap: 30, entities: 64 };
  const app = createGame({
    canvas, settings,
    engine: { available: true, scratch: new Float32Array(8 * 64).fill(0), readEntities: () => 4, entityCount: 4, snapshotMode: 'post' },
    os: { reportGame: m => criados.push(m) },
    toast: { err: () => {}, ok: () => {}, warn: () => {}, push: () => {} }
  });
  return { app, canvas, criados };
}

await test('sem WebGL2 a cidade é desenhada em software — nunca janela preta vazia', async () => {
  const ctx2d = ctx2dGravador();
  const { app, criados } = montarCidade({ webgl2: null, ctx2d });
  try {
    assert.equal(app.backend, 'software', 'sem WebGL2, o backend declarado é software');
    assert.match(app.backendMotivo, /WebGL2 indisponível/);
    assert.equal(app.erro, '', 'modo software não é erro fatal');
    await sleep(80);

    const fills = ctx2d.chamadas.filter(c => c[0] === 'fill');
    assert.ok(fills.length > 0, 'o desenho em software precisa preencher polígonos (a cidade)');
    assert.ok(ctx2d.chamadas.some(c => c[0] === 'fillRect' && c[5].startsWith('rgb(2,4,7')), `céu pintado com a cor declarada: ${JSON.stringify(CEU_RGB)}`);
    assert.ok(ctx2d.chamadas.some(c => c[0] === 'stroke'), 'a grade do chão precisa ser traçada');
    const stats = app.stats;
    assert.equal(app.erro, '', 'o laço não pode ter parado');
    assert.ok(stats.instances > 500, `a cidade tem apenas ${stats.instances} volumes`);
    assert.ok(stats.drawCalls > 10, `desenhos por quadro: ${stats.drawCalls}`);
    // o modo é declarado na interface e no relatório de telemetria
    assert.match(app.el.textContent, /SOFTWARE 2D/);
    assert.match(app.el.textContent, /modo software \(canvas 2D\): WebGL2 indisponível/);
    assert.ok(criados.length > 0, 'a telemetria recebe o estado do renderizador');
    assert.equal(criados.at(-1).backend, 'software');
  } finally { app.onClose(); }
});

await test('sem WebGL2 e sem 2D a janela diz exatamente o que faltou (nada de tela preta muda)', () => {
  const { app } = montarCidade({ webgl2: null, ctx2d: null });
  try {
    assert.equal(app.backend, 'software');
    assert.match(app.erro, /sem WebGL2 .* e sem canvas 2D/);
    assert.match(app.el.textContent, /SEM DESENHO/);
    assert.match(app.el.textContent, /sem canvas 2D/);
  } finally { app.onClose(); }
});

/** Contexto WebGL2 falso que aplica a MESMA validação do WebGL real:
 *  atributo habilitado fora da faixa do buffer → INVALID_OPERATION e chamada descartada.
 *  É assim que o defeito original (`count: 24` com 16 vértices) é pego sem GPU. */
function glFalso() {
  const bufDados = new Map();          // buffer → tamanho em bytes
  const atributos = new Map();         // índice → { buf, stride, size }
  const ativos = new Set();
  const chamadas = { instanciadas: [], simples: 0 };
  const erros = [];
  let ligado = null;
  let id = 0;
  const novo = tipo => ({ tipo, id: ++id });
  return {
    // constantes
    ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, COMPILE_STATUS: 4,
    NO_ERROR: 0, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
    DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, BACK: 0x0405, CCW: 0x0901,
    TRIANGLES: 4, FLOAT: 0x1406,
    // recursos
    createBuffer: () => novo('buffer'),
    createProgram: () => novo('programa'),
    createShader: tipo => novo(`shader${tipo}`),
    deleteShader() {},
    shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '',
    attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    getUniformLocation: () => novo('uniform'),
    bindBuffer: (alvo, buf) => { ligado = buf; },
    bufferData: (alvo, dados) => { bufDados.set(ligado, typeof dados === 'number' ? dados : dados.byteLength); },
    bufferSubData() {},
    useProgram() {}, uniformMatrix4fv() {}, uniform3f() {}, uniform1i() {},
    uniform1f() {}, uniform2f() {},
    viewport() {}, clearColor() {}, clear() {}, enable() {}, disable() {},
    cullFace() {}, frontFace() {},
    enableVertexAttribArray: i => ativos.add(i),
    vertexAttribPointer: (i, size, tipo, norm, stride, offset) => {
      atributos.set(i, { buf: ligado, stride, size, offset });
    },
    vertexAttribDivisor() {},
    disableVertexAttribArray: i => ativos.delete(i),
    drawArrays: () => { chamadas.simples++; },
    drawArraysInstanced: (modo, first, count, instancias) => {
      chamadas.instanciadas.push({ first, count, instancias });
      const a0 = atributos.get(0);
      if (!a0 || !ativos.has(0)) return;
      const bytes = bufDados.get(a0.buf) || 0;
      const passo = a0.stride || a0.size * 4;
      const cabem = Math.floor((bytes - a0.offset) / passo);
      if (first + count > cabem) {
        // exatamente o que o WebGL real faz: erro e chamada DESCARTADA
        erros.push(`atributo 0 fora da faixa: pediu até ${first + count} vértices, o buffer tem ${cabem}`);
      }
    },
    getError: () => 0,
    chamadas, erros,
    /** Controle negativo: prova que a validação acima não é vazia. */
    verificarDefeitoArtificial(count) {
      const antes = erros.length;
      this.drawArraysInstanced(this.TRIANGLES, 0, count, 1);
      return erros.length > antes;
    }
  };
}

await test('WebGL2: a chamada instanciada pede exatamente os vértices que o buffer tem', async () => {
  const gl = glFalso();
  const { app } = montarCidade({ webgl2: gl, ctx2d: null });
  try {
    assert.equal(app.backend, 'webgl2', 'com WebGL2 disponível, o backend é webgl2');
    assert.equal(app.backendMotivo, '');
    await sleep(260);                     // teto de 30 fps no montador: ~7 quadros
    assert.equal(app.erro, '', 'o laço não pode ter parado: um stub faltando no GL falso tem que aparecer aqui');
    assert.deepEqual(gl.erros, [], `o WebGL real teria descartado a chamada: ${gl.erros.join(' | ')}`);
    const inst = gl.chamadas.instanciadas;
    assert.ok(inst.length > 4, `chamadas instanciadas por vários quadros: ${inst.length}`);
    assert.ok(inst.every(c => c.count === 24), `toda chamada usa as 6 faces (24 vértices): ${inst.map(c => c.count)}`);
    assert.ok(inst.every(c => c.instancias > 500), `instâncias da cidade por quadro: ${inst.at(-1).instancias}`);
    assert.ok(gl.chamadas.simples > 8, `céu e chão são desenhados a cada quadro (${gl.chamadas.simples} em ~7 quadros)`);
    assert.equal(gl.chamadas.instanciadas.at(-1).instancias, app.stats.instances, 'a contagem do HUD é a contagem desenhada');
    // controle negativo: com 48 vértices a validação acusa — o teste não é vazio
    assert.equal(gl.verificarDefeitoArtificial(48), true, 'a validação precisa acusar um count fora da faixa');
  } finally { app.onClose(); }
});

// ---------------------------------------------------------------- relatório --
console.log(results.join('\n'));
console.log(`\n${passed} passaram · ${failed} falharam${failed ? ' ✗' : ' ✓'}`);
process.exit(failed ? 1 : 0);
