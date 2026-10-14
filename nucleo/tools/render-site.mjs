/**
 * NÚCLEO OS — tools/render-site.mjs
 * Roda o motor do Navegador contra uma URL REAL, de ponta a ponta, no terminal.
 *
 * Para que serve: provar (e depurar) o pipeline sem abrir navegador —
 * proxy → HTML → CSS externo → layout → pintura — e imprimir um "retrato" em
 * texto do que seria pintado no canvas. Também serve como referência de
 * desempenho: os tempos são medidos de verdade.
 *
 * Uso:
 *   node tools/render-site.mjs https://github.com/explore
 *   node tools/render-site.mjs https://pt.wikipedia.org/wiki/Brasil --largura 1200 --largura-col 200
 *
 * Requer o servidor do projeto rodando (npm start) — é ele que faz a busca com a
 * política de rede. Sem servidor, nada aqui funciona: o motor não busca sozinho.
 */

import { JSDOM } from 'jsdom';

const args = process.argv.slice(2);
// O primeiro argumento que PARECE endereço é a URL: assim `--largura 900` não é
// confundido com ela (era o que fazia o cabeçalho imprimir "900").
const url = args.find(a => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^[\w-]+(\.[\w-]+)+/.test(a));
const opcao = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const PORTA = opcao('porta', '3400');
const LARGURA = Number(opcao('largura', '1000'));
const ALTURA = Number(opcao('altura', '900'));
const LARGURA_COL = Number(opcao('largura-col', '160'));
const ALTURA_COL = Number(opcao('altura-col', '110'));

const LOCAL = args.includes('--local');

if (!url && !LOCAL) {
  console.error('uso: node tools/render-site.mjs <url> [--porta 3400] [--largura 1000] [--altura 900]');
  console.error('     node tools/render-site.mjs --local     (página inicial do sistema, com o CSS dela)');
  process.exit(2);
}

const BASE = `http://127.0.0.1:${PORTA}`;

// jsdom dá DOMParser/blob para os módulos do motor, que são escritos para o navegador.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: BASE });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Blob = dom.window.Blob;
globalThis.createImageBitmap = async () => null;      // sem decodificação fora do navegador
globalThis.devicePixelRatio = 1;

const { carregarFonte, cssDe, injetarCss } = await import('../js/core/srcpage.js');
const { layout } = await import('../js/core/layout.js');
const { paint } = await import('../js/apps/gfx/paint.js');

/** Medidor do terminal: sem canvas, usa a mesma estimativa declarada do app. */
const medir = (texto, fonte) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(fonte);
  const tamanho = m ? Number(m[1]) : 16;
  const mono = /mono|Menlo|Consolas|Courier/i.test(fonte);
  return texto.length * tamanho * (mono ? 0.6 : (/bold/.test(fonte) ? 0.56 : 0.52));
};

/** Contexto 2D que grava — mesma técnica dos testes, aqui para imprimir o retrato. */
function ctxGravador() {
  const itens = [];
  const estado = { fillStyle: '#000000', font: '16px sans' };
  return {
    itens,
    canvas: { width: LARGURA, height: ALTURA },
    get fillStyle() { return estado.fillStyle; }, set fillStyle(v) { estado.fillStyle = v; },
    get font() { return estado.font; }, set font(v) { estado.font = v; },
    get strokeStyle() { return estado.fillStyle; }, set strokeStyle(v) { estado.fillStyle = v; },
    textBaseline: '', lineWidth: 1,
    save() {}, restore() {}, setLineDash() {}, setTransform() {},
    fillRect(x, y, w, h) { itens.push({ tipo: 'rect', x, y, w, h, cor: estado.fillStyle }); },
    strokeRect(x, y, w, h) { itens.push({ tipo: 'borda', x, y, w, h, cor: estado.fillStyle }); },
    fillText(t, x, y) { itens.push({ tipo: 'texto', x, y, w: medir(t, estado.font), h: 14, texto: t, cor: estado.fillStyle, fonte: estado.font }); },
    measureText(t) { return { width: medir(t, estado.font) }; },
    drawImage(b, x, y, w, h) { itens.push({ tipo: 'imagem', x, y, w, h, cor: '#8899aa' }); }
  };
}

async function buscarJson(alvo) {
  const res = await fetch(`${BASE}/api/fetch?url=${encodeURIComponent(alvo)}`);
  return await res.json().catch(() => ({ ok: false, error: `resposta inválida (HTTP ${res.status})` }));
}

// ------------------------------------------------------------------- execução --
console.log(`\nNÚCLEO OS · motor do Navegador · ${LOCAL ? 'página inicial do sistema' : url}\n${'─'.repeat(72)}`);

const t0 = performance.now();
let meta;
let fonte;
if (LOCAL) {
  // Sem rede: a página inicial do sistema, com o CSS que ela traz — é o modo que
  // funciona em qualquer rede e serve de referência visual do motor.
  const { PAGINA_INICIAL } = await import('../js/apps/browser.js');
  meta = { ok: true, status: 200, bytes: PAGINA_INICIAL.length, ms: 0, contentType: 'text/html', url: 'about:inicio' };
  console.log(`origem             página inicial do sistema (local, sem rede) · ${(PAGINA_INICIAL.length / 1024).toFixed(1)} KB`);
  fonte = await carregarFonte('about:inicio', { buscarJson, parser: dom.window.DOMParser, texto: PAGINA_INICIAL, log: () => {} });
} else {
  meta = await buscarJson(url);
  if (!meta.ok) {
    console.error(`falha ao buscar: ${meta.error}`);
    process.exit(1);
  }
  console.log(`busca pelo proxy   HTTP ${meta.status} · ${(meta.bytes / 1024).toFixed(1)} KB · ${meta.ms} ms · ${meta.contentType.split(';')[0]}`);
  console.log(`URL final          ${meta.url}`);
  fonte = await carregarFonte(meta.url, { buscarJson, parser: dom.window.DOMParser, texto: meta.text, log: () => {} });
}
const t1 = performance.now();
injetarCss(fonte.doc, cssDe(fonte));

const ok = fonte.folhas.filter(f => !f.erro).length;
const falhas = fonte.folhas.filter(f => f.erro);
console.log(`folhas de estilo   ${ok} carregada(s) · ${falhas.length} falhou(aram)`);
for (const f of falhas.slice(0, 4)) console.log(`   ✗ ${f.href.slice(0, 70)} — ${f.erro.slice(0, 60)}`);
const cssInline = fonte.inlineCss.length;
console.log(`css inline         ${(cssInline / 1024).toFixed(1)} KB em <style>`);
console.log(`imagens listadas   ${fonte.imagens.length}`);
if (fonte.notas.length) {
  console.log('notas (o motor declara o que não faz):');
  for (const n of fonte.notas.slice(0, 8)) console.log(`   • ${n}`);
}

const pagina = layout(fonte.doc, {
  width: LARGURA, height: ALTURA, measure: medir, baseUrl: fonte.url,
  imageSizes: new Map()
});
const t2 = performance.now();
const ctx = ctxGravador();
const stats = paint(ctx, pagina, { width: LARGURA, height: ALTURA, images: new Map() });
const t3 = performance.now();

console.log(`${'─'.repeat(72)}`);
console.log(`layout             ${pagina.stats.items} itens · ${pagina.stats.boxes} caixas · ${pagina.stats.lines} linhas · altura ${Math.round(pagina.height)} px · ${(t2 - t1).toFixed(1)} ms`);
console.log(`pintura            ${stats.textos} textos · ${stats.rects} retângulos · ${stats.imagens} imagens · ${(t3 - t2).toFixed(1)} ms`);
console.log(`links              ${pagina.links.length} hitboxes clicáveis`);
console.log(`total (busca+render) ${(t3 - t0).toFixed(1)} ms`);
console.log(`${'─'.repeat(72)}`);

// ------------------------------------------------------- retrato em texto ------
const COLUNAS = Math.floor(LARGURA_COL);
const LINHAS = Math.floor(ALTURA_COL);
const grade = Array.from({ length: LINHAS }, () => Array(COLUNAS).fill(' '));
const luz = cor => {
  if (!cor) return 0.5;
  if (cor.startsWith('rgba')) return 0.5;
  const hex = cor.replace('#', '');
  if (hex.length < 6) return 0.5;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const pxPorCol = LARGURA / COLUNAS, pxPorLin = ALTURA / LINHAS;
const marcar = (x, y, ch) => {
  const c = Math.floor(x / pxPorCol), l = Math.floor(y / pxPorLin);
  if (c >= 0 && c < COLUNAS && l >= 0 && l < LINHAS && grade[l][c] === ' ') grade[l][c] = ch;
};
for (const item of ctx.itens) {
  if (item.tipo === 'rect') {
    const ch = luz(item.cor) > 0.75 ? '.' : (luz(item.cor) > 0.4 ? ':' : '#');
    for (let y = item.y; y < item.y + Math.min(item.h, 3); y += pxPorLin) {
      for (let x = item.x; x < item.x + item.w; x += pxPorCol) marcar(x, y, ch);
    }
    continue;
  }
  if (item.tipo === 'texto') {
    const ch = luz(item.cor) > 0.6 ? '.' : (luz(item.cor) > 0.3 ? '=' : '@');
    for (let x = item.x; x < item.x + item.w; x += pxPorCol) marcar(x, item.y - 8, ch);
    continue;
  }
  if (item.tipo === 'imagem') {
    for (let y = item.y; y < item.y + item.h; y += pxPorLin) {
      for (let x = item.x; x < item.x + item.w; x += pxPorCol) marcar(x, y, '▒');
    }
    marcar(item.x, item.y, '▣');
    continue;
  }
  if (item.tipo === 'borda') { marcar(item.x, item.y, '+'); marcar(item.x + item.w, item.y, '+'); }
}

console.log('\nretrato do que seria pintado no canvas (1 caractere ≈ ' + Math.round(pxPorCol) + '×' + Math.round(pxPorLin) + ' px):');
console.log('  "." fundo claro   ":" fundo médio   "#" fundo escuro   "@" texto');
console.log('  "▒" imagem        "▣" imagem decodificada   "+" borda\n');
for (const linha of grade) {
  const texto = linha.join('').replace(/\s+$/, '');
  if (texto) console.log('  ' + texto);
}
console.log(`\n(${ctx.itens.length} operações de pintura · retrato acima é a miniatura, não a imagem final)\n`);
