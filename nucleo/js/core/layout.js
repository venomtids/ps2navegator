/**
 * NÚCLEO OS — core/layout.js
 * Motor de layout: elemento do DOM + estilo computado → árvore de caixas → lista
 * plana de itens de pintura com posições absolutas.
 *
 * O que implementa (o suficiente para páginas reais ficarem legíveis e bonitas):
 *  - fluxo de blocos com colapso de margem, padding e borda;
 *  - fluxo inline com quebra de linha por palavra (largura medida de verdade);
 *  - `inline-block` e células de tabela como caixas atômicas na linha;
 *  - listas com marcador, regras (`<hr>`), imagens como caixa ou como `[imagem: alt]`;
 *  - links como itens clicáveis (hitbox), que é o que transforma pintura em navegação.
 *
 * O que NÃO implementa, de propósito: float, position absolute/fixed e grid.
 * Em vez de fingir, esses elementos caem no fluxo normal — o conteúdo continua
 * visível e clicável, que é o requisito real.
 *
 * O módulo é puro: não conhece canvas, DOM de verdade nem rede. A medição de texto
 * entra por injeção (`measure`), então o layout é testável sem navegador.
 */

import { computeStyle, parseStyleSheet, resolveLength, defaultDisplay } from './css.js';

const BLOCK_LEVEL = new Set(['block', 'list-item', 'table', 'row', 'cell']);

export const FONT_FAMILIES = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
};

/** String de fonte no formato que o canvas entende. */
export function fontString(style) {
  const peso = style.fontWeight >= 600 ? 'bold' : 'normal';
  const italico = style.fontStyle === 'italic' ? 'italic ' : '';
  return `${italico}${peso} ${Math.max(8, Math.round(style.fontSize * 100) / 100)}px ${FONT_FAMILIES[style.fontFamily] || FONT_FAMILIES.sans}`;
}

const pad = n => Math.max(0, Math.round(n));

/** Medidor de emergência: usado só quando o chamador não injeta um de verdade. */
export const FALLBACK_MEASURE = (texto, fonte) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(fonte);
  const tamanho = m ? Number(m[1]) : 16;
  const mono = /mono|Menlo|Consolas|Courier/i.test(fonte);
  const fator = mono ? 0.6 : (/bold/.test(fonte) ? 0.56 : 0.52);
  return texto.length * tamanho * fator;
};

/**
 * @param {Document} doc                documento já parseado (DOMParser)
 * @param {object} opts
 * @param {number} opts.width            largura da viewport em px
 * @param {number} [opts.height]         altura da viewport (para `vh`)
 * @param {Function} opts.measure        (texto, fontString) → largura em px
 * @param {Map} [opts.imageSizes]        src absoluto → {w,h} já decodificado
 * @param {Map} [opts.imageSrcs]         src absoluto → URL de origem do blob
 * @param {object} [opts.media]          {width,height} para resolver vw/vh
 * @returns {{items: Array, height: number, links: Array, images: Array, stats: object}}
 */
export function layout(doc, {
  width = 800, height = 720, measure = FALLBACK_MEASURE,
  imageSizes = new Map(), imageSrcs = new Map(), maxItems = 20000,
  baseUrl = null
} = {}) {
  const folhas = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
  const regras = parseStyleSheet(folhas);

  // Resolução de URLs relativas. Isto NÃO pode depender de `doc.baseURI`: um
  // documento criado por `DOMParser` herda a URL da página do NÚCLEO OS, então
  // `href="/x"` apontaria para o nosso próprio servidor. A base é a URL real da
  // página buscada, respeitando `<base href>` quando existir — como no navegador.
  let baseEfetiva = baseUrl;
  const tagBase = doc.querySelector('base[href]')?.getAttribute('href');
  if (tagBase) {
    try { baseEfetiva = baseUrl ? new URL(tagBase, baseUrl).href : new URL(tagBase).href; } catch { /* mantém a original */ }
  }
  const resolver = valor => {
    if (!valor) return null;
    try {
      if (baseEfetiva) return new URL(valor, baseEfetiva).href;
      return new URL(valor).href;                      // absoluta sem base: ainda resolve
    } catch { return null; }
  };

  const items = [];
  const links = [];
  const images = [];
  let overflowed = false;

  const push = item => {
    if (items.length >= maxItems) { overflowed = true; return; }
    items.push(item);
  };

  const contextoBase = { width, viewportWidth: width, viewportHeight: height };
  const bodyEl = doc.body || doc.documentElement;
  if (!bodyEl) return { items, height, links, images, stats: { items: 0, boxes: 0, lines: 0, overflowed: false } };

  // O <body> pinta o fundo da página inteira quando tem cor — como no navegador.
  const estiloBody = computeStyle(bodyEl, regras, null);
  if (estiloBody.background) {
    push({ kind: 'rect', x: 0, y: 0, w: width, h: Math.max(height, 1), color: estiloBody.background, fundo: true });
  }

  const stats = { boxes: 0, lines: 0 };

  /** Comprimento resolvido para px, com teto (uma página hostil não derruba o layout). */
  const px = (len, ctx) => {
    const v = resolveLength(len, ctx);
    if (v == null) return 0;
    return Math.max(0, Math.min(v, 100000));
  };

  /**
   * Caixa de bloco: margem → borda → padding → conteúdo → padding → borda → margem.
   * `cursor` é o fluxo vertical do container (objeto mutável { y, prevMargin }).
   */
  function bloco(el, estilo, cursor, container, opcoes = {}) {
    stats.boxes++;
    const { marcador = null } = opcoes;
    const margem = {
      top: px(estilo.margin.top, contextoBase), right: px(estilo.margin.right, contextoBase),
      bottom: px(estilo.margin.bottom, contextoBase), left: px(estilo.margin.left, contextoBase)
    };
    const padding = {
      top: px(estilo.padding.top, contextoBase), right: px(estilo.padding.right, contextoBase),
      bottom: px(estilo.padding.bottom, contextoBase), left: px(estilo.padding.left, contextoBase)
    };
    const borda = {};
    let temBorda = false;
    for (const lado of ['top', 'right', 'bottom', 'left']) {
      const b = estilo.border[lado];
      const w = Math.min(b?.w || 0, 24);
      borda[lado] = w > 0 ? { w, color: b.color || estilo.color } : { w: 0, color: null };
      if (w > 0) temBorda = true;
    }

    // Colapso de margem vertical: fica a maior, não a soma (senão a página infla).
    const margemEfetiva = cursor.temConteudo ? Math.max(cursor.prevMargin || 0, margem.top) : margem.top;
    cursor.y += margemEfetiva;

    const larguraDisponivel = container.largura - margem.left - margem.right;
    const larguraCaixa = Math.max(0, larguraDisponivel - borda.left.w - borda.right.w - padding.left - padding.right);
    const x = container.x + margem.left;
    const yTopo = cursor.y;
    const xConteudo = x + borda.left.w + padding.left;
    const yConteudo = yTopo + borda.top.w + padding.top;
    const larguraConteudo = estilo.boxSizing === 'border-box' && estilo.width
      ? Math.max(0, px(estilo.width, { width: larguraCaixa }) - padding.left - padding.right - borda.left.w - borda.right.w)
      : Math.min(larguraCaixa, estilo.width ? (px(estilo.width, { width: larguraCaixa }) || larguraCaixa) : larguraCaixa);
    const alturaExplicita = estilo.height ? px(estilo.height, { width: larguraCaixa }) : null;

    let topoPintado = yTopo;
    const filhoCursor = { y: yConteudo, prevMargin: 0, temConteudo: false };
    const interno = {
      x: xConteudo, largura: larguraConteudo, height,
      alinhamento: estilo.textAlign === 'center' ? null : null,
      estiloPai: estilo
    };
    const antesDoConteudo = items.length;
    conteudoDe(el, estilo, filhoCursor, interno, { x: xConteudo, largura: larguraConteudo });

    // Marcador do item de lista: alinhado à linha de base do primeiro texto do
    // item (por isso é pintado depois — a posição só existe depois do conteúdo).
    if (marcador) {
      const primeiroTexto = items.slice(antesDoConteudo).find(i => i.kind === 'text');
      if (primeiroTexto) {
        const fonte = primeiroTexto.font;
        const largura = Math.round(measure(marcador, fonte));
        // O marcador vive no espaço que o `padding-left` da lista reserva, à ESQUERDA
        // do conteúdo do item. Limitar ao `container.x` (que já é o x do conteúdo)
        // jogava o marcador em cima do texto — o teste de posição pegou isso.
        push({
          kind: 'text', x: pad(Math.max(0, xConteudo - largura - 8)),
          y: primeiroTexto.y, texto: marcador, font: fonte, color: estilo.color,
          largura, altura: primeiroTexto.altura, marcador: true
        });
      }
    }

    let alturaConteudo = filhoCursor.y - yConteudo;
    if (alturaExplicita != null) alturaConteudo = Math.max(alturaConteudo, alturaExplicita);

    const alturaTotal = borda.top.w + padding.top + alturaConteudo + padding.bottom + borda.bottom.w;

    // Fundo primeiro (para ficar atrás de texto e filhos), depois bordas.
    if (estilo.background) {
      push({ kind: 'rect', x: pad(x), y: pad(topoPintado), w: pad(larguraDisponivel), h: pad(alturaTotal), color: estilo.background });
    } else if (estilo.display === 'list-item' || (estilo.margin.top?.px ?? 0) > 0 || temBorda) {
      // nada: bloco sem fundo não pinta nada, como no navegador
    }
    if (estilo.display === 'list-item') {
      // O marcador é pintado pelo container da lista (`marcador`), não aqui.
    }
    if (temBorda) {
      const bx = x, bw = larguraDisponivel, by = topoPintado, bh = alturaTotal;
      if (borda.top.w) push({ kind: 'rect', x: pad(bx), y: pad(by), w: pad(bw), h: pad(borda.top.w), color: borda.top.color });
      if (borda.bottom.w) push({ kind: 'rect', x: pad(bx), y: pad(by + bh - borda.bottom.w), w: pad(bw), h: pad(borda.bottom.w), color: borda.bottom.color });
      if (borda.left.w) push({ kind: 'rect', x: pad(bx), y: pad(by), w: pad(borda.left.w), h: pad(bh), color: borda.left.color });
      if (borda.right.w) push({ kind: 'rect', x: pad(bx + bw - borda.right.w), y: pad(by), w: pad(borda.right.w), h: pad(bh), color: borda.right.color });
    }

    cursor.y = topoPintado + alturaTotal;
    cursor.prevMargin = margem.bottom;
    cursor.temConteudo = true;
    return { altura: alturaTotal };
  }

  /** Distribui filhos de um container: blocos empilham, inline corre na linha. */
  function conteudoDe(el, estiloPai, cursor, container, area) {
    const linha = criarLinhaRunner(area, container, cursor);
    const tagPai = (el.tagName || '').toLowerCase();
    const ehLista = tagPai === 'ul' || tagPai === 'ol';
    let indiceItem = 0;
    for (const filho of el.childNodes) {
      if (filho.nodeType === 3) { linha.texto(filho.nodeValue, estiloPai, hrefDe(el), el); continue; }
      if (filho.nodeType !== 1) continue;
      const tag = (filho.tagName || '').toLowerCase();
      const estilo = computeStyle(filho, regras, estiloPai);

      if (estilo.display === 'none') continue;
      if (tag === 'br') { linha.quebra(); continue; }

      if (BLOCK_LEVEL.has(estilo.display) || estilo.display === 'block') {
        // Tabela: `tr` empilha e suas células ficam lado a lado (ver linhasDeTabela).
        if (tag === 'tr') { linha.descarregar(); linhasDeTabela(filho, estilo, cursor, container, area); continue; }
        linha.descarregar();
        let marcador = null;
        if (tag === 'li' || estilo.display === 'list-item') {
          indiceItem++;
          // `list-style-type` do próprio item manda; senão o do container decide
          // entre marcador e numeração (a diferença entre <ul> e <ol>).
          const tipo = estilo.listStyleType !== 'disc' ? estilo.listStyleType
            : (ehLista && tagPai === 'ol' ? 'decimal' : 'disc');
          if (tipo === 'decimal') marcador = `${indiceItem}.`;
          else if (tipo !== 'none') marcador = '•';
        }
        bloco(filho, estilo, cursor, container, { marcador });
        continue;
      }
      if (estilo.display === 'inline-block' || tag === 'td' || tag === 'th') {
        linha.atomico(filho, estilo, container, area);
        continue;
      }
      if (tag === 'img') { linha.imagem(filho, estilo, hrefDe(el)); continue; }
      if (tag === 'hr') {
        linha.descarregar();
        cursor.y += px(estilo.margin.top, contextoBase);
        push({ kind: 'rect', x: pad(area.x), y: pad(cursor.y), w: pad(area.largura), h: 1, color: estilo.color });
        cursor.y += 1 + px(estilo.margin.bottom, contextoBase);
        cursor.temConteudo = true;
        continue;
      }
      // Inline: herda cor/peso e continua na mesma linha.
      const href = hrefDe(filho) || hrefDe(el);
      if (filho.childNodes.length) {
        const guarda = linha.marca();
        for (const neto of filho.childNodes) {
          if (neto.nodeType === 3) { linha.texto(neto.nodeValue, estilo, href, filho); continue; }
          if (neto.nodeType !== 1) continue;
          const estiloNeto = computeStyle(neto, regras, estilo);
          if (estiloNeto.display === 'none') continue;
          const tagNeto = (neto.tagName || '').toLowerCase();
          if (tagNeto === 'br') { linha.quebra(); continue; }
          if (tagNeto === 'img') { linha.imagem(neto, estiloNeto, hrefDe(neto) || href); continue; }
          if (BLOCK_LEVEL.has(estiloNeto.display) || estiloNeto.display === 'inline-block') {
            linha.atomico(neto, estiloNeto, container, area);
            continue;
          }
          linha.inlineRecursivo(neto, estiloNeto, hrefDe(neto) || href, regras);
        }
        void guarda;
      }
    }
    linha.descarregar();
  }

  const hrefDe = el => {
    const tag = (el.tagName || '').toLowerCase();
    if (!el.getAttribute) return null;
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (!href || /^javascript:/i.test(href)) return null;
      return resolver(href);
    }
    return el.getAttribute('data-href') || null;
  };

  /**
   * Runner de linha: acumula runs inline e materializa em linhas, quebrando por
   * palavra conforme a largura disponível. É aqui que a página "ganha forma".
   */
  function criarLinhaRunner(area, container, cursor) {
    let runs = [];
    let alturaLinha = 0;

    const tamanhoFonte = run => (run.fonteRatio || 1) * (run.fontSize || 16);
    const linhasDe = () => {};

    function medir(run, texto) {
      return measure(texto, run.font);
    }

    function descarregar() {
      if (!runs.length) return;
      const alturaPadrao = 16;
      let x = area.x;
      let y = cursor.y;
      let alturaDaLinha = alturaPadrao * 1.25;
      let primeiro = true;
      const empurrar = run => {
        if (run.kind === 'break') {
          cursor.y = y + Math.max(alturaDaLinha, run.altura || alturaPadrao * 1.25);
          return 'quebrou';
        }
        const largura = run.kind === 'texto' ? medir(run, run.texto) : run.w;
        const alturaRun = run.kind === 'texto' ? (run.lineHeight ? run.fontSize * run.lineHeight : run.fontSize * 1.25) : run.h;
        if (!primeiro && x + largura > area.x + area.largura) {
          cursor.y = y + Math.max(alturaDaLinha, alturaRun);
          y = cursor.y;
          x = area.x;
          primeiro = true;
        }
        alturaDaLinha = Math.max(alturaDaLinha, alturaRun);
        if (run.kind === 'texto') {
          const linhaBase = y + Math.max(alturaDaLinha, alturaRun) - alturaRun * 0.28;
          const item = {
            kind: 'text', x: pad(x), y: pad(linhaBase), texto: run.texto,
            font: run.font, color: run.cor, decoracao: run.decoracao, href: run.href,
            largura: Math.round(largura), altura: Math.round(alturaRun),
            node: run.node || null
          };
          push(item);
          if (run.href) links.push({ x: pad(x), y: pad(linhaBase - alturaRun), w: Math.round(largura), h: Math.round(alturaRun), href: run.href, texto: run.texto });
          if (run.fundo) push({ kind: 'rect', x: pad(x - 1), y: pad(linhaBase - alturaRun + 2), w: pad(largura + 2), h: pad(alturaRun), color: run.fundo, atras: true });
        } else if (run.kind === 'imagem') {
          push({ kind: 'image', x: pad(x), y: pad(y), w: Math.round(run.w), h: Math.round(run.h), src: run.src, original: run.original, href: run.href, alt: run.alt });
          if (run.href) links.push({ x: pad(x), y: pad(y), w: Math.round(run.w), h: Math.round(run.h), href: run.href, texto: run.alt || '[imagem]' });
          images.push({ src: run.src, original: run.original, w: Math.round(run.w), h: Math.round(run.h) });
        } else if (run.kind === 'marcador') {
          push({ kind: 'text', x: pad(x), y: pad(y + alturaDaLinha - run.fontSize * 0.3), texto: run.texto, font: run.font, color: run.cor, largura: Math.round(largura), altura: Math.round(alturaRun) });
        } else if (run.kind === 'atomico') {
          // Caixa atômica (`inline-block`, célula): os itens internos já existem e
          // são transladados para a posição final na linha.
          for (const item of run.itens) {
            items.push({ ...item, x: item.x + pad(x), y: item.y + pad(y) });
            if (item.href) links.push({ x: item.x + pad(x), y: item.y + pad(y), w: item.w, h: item.h, href: item.href, texto: item.texto || '' });
          }
          if (run.href && !run.itens.some(i => i.href)) {
            links.push({ x: pad(x), y: pad(y), w: Math.round(run.w), h: Math.round(run.h), href: run.href, texto: '' });
          }
        }
        x += largura + (run.kind === 'texto' ? 0 : 2);
        primeiro = false;
        return 'ok';
      };

      for (const run of runs) {
        if (run.kind === 'texto' && /^\s+$/.test(run.texto)) { continue; }   // espaços no início da linha somem
        if (run.kind === 'texto' && run.whiteSpace === 'pre') {
          const partes = run.texto.split('\n');
          partes.forEach((parte, i) => {
            if (i > 0) empurrar({ ...run, kind: 'break' });
            if (parte) empurrar({ ...run, texto: parte.replace(/\t/g, '    ') });
          });
          continue;
        }
        if (run.kind === 'texto') {
          // Quebra por palavra; palavra maior que a linha é cortada por caractere.
          const palavras = run.texto.split(/(\s+)/).filter(t => t !== '');
          for (const palavra of palavras) {
            if (/^\s+$/.test(palavra)) {
              if (x > area.x) { empurrar({ ...run, texto: ' ', node: null }); }
              continue;
            }
            let resto = palavra;
            while (resto.length) {
              const larguraResto = medir(run, resto);
              const espaco = area.x + area.largura - x;
              if (larguraResto <= espaco || x === area.x) {
                if (larguraResto > espaco && x === area.x) {
                  // corta por caractere
                  let corte = 1;
                  while (corte < resto.length && medir(run, resto.slice(0, corte + 1)) <= espaco) corte++;
                  empurrar({ ...run, texto: resto.slice(0, corte) });
                  resto = resto.slice(corte);
                  continue;
                }
                empurrar({ ...run, texto: resto });
                resto = '';
                continue;
              }
              // Não cabe: fecha a linha e tenta de novo na próxima.
              cursor.y = y + Math.max(alturaDaLinha, tamanhoFonte(run) * 1.25);
              y = cursor.y;
              x = area.x;
              alturaDaLinha = 0;
              primeiro = true;
              const item = { ...run, texto: resto };
              const larguraItem = medir(item, resto);
              if (larguraItem <= area.largura) {
                empurrar(item);
                resto = '';
              } else {
                let corte = 1;
                while (corte < resto.length && medir(run, resto.slice(0, corte + 1)) <= area.largura) corte++;
                empurrar({ ...run, texto: resto.slice(0, corte) });
                resto = resto.slice(corte);
              }
            }
          }
          continue;
        }
        empurrar(run);
      }
      cursor.y = y + alturaDaLinha;
      cursor.prevMargin = 0;
      if (runs.length) cursor.temConteudo = true;
      runs = [];
      stats.lines++;
    }

    return {
      texto(conteudo, estilo, href, node) {
        const texto = style_textoNorm(conteudo, estilo.whiteSpace);
        if (!texto) return;
        runs.push(paraRunTexto(texto, estilo, href, node));
      },
      inlineRecursivo(el, estilo, href, regrasLocais) {
        // Inline aninhado (ex.: <a><strong>): herda tudo e continua na mesma linha.
        for (const neto of el.childNodes) {
          if (neto.nodeType === 3) {
            const texto = style_textoNorm(neto.nodeValue, estilo.whiteSpace);
            if (texto) runs.push(paraRunTexto(texto, estilo, href, neto));
            continue;
          }
          if (neto.nodeType !== 1) continue;
          const tag = (neto.tagName || '').toLowerCase();
          if (tag === 'br') { runs.push({ kind: 'break', altura: estilo.fontSize * 1.25 }); continue; }
          const estiloNeto = computeStyle(neto, regrasLocais, estilo);
          if (estiloNeto.display === 'none') continue;
          if (tag === 'img') { this.imagem(neto, estiloNeto, hrefDe(neto) || href); continue; }
          if (BLOCK_LEVEL.has(estiloNeto.display) || estiloNeto.display === 'inline-block') { this.atomico(neto, estiloNeto, container, area); continue; }
          if (neto.childNodes.length) this.inlineRecursivo(neto, estiloNeto, hrefDe(neto) || href, regrasLocais);
        }
      },
      imagem(el, estilo, href) {
        const original = el.getAttribute?.('src') || '';
        const absoluta = resolver(original);
        const alt = el.getAttribute?.('alt') || '';
        const larguraAtrib = Number(el.getAttribute?.('width'));
        const alturaAtrib = Number(el.getAttribute?.('height'));
        const tamanho = absoluta ? imageSizes.get(absoluta) : null;
        let w = estilo.width ? px(estilo.width, contextoBase) : (Number.isFinite(larguraAtrib) && larguraAtrib > 0 ? larguraAtrib : (tamanho?.w || null));
        let h = estilo.height ? px(estilo.height, contextoBase) : (Number.isFinite(alturaAtrib) && alturaAtrib > 0 ? alturaAtrib : (tamanho?.h || null));
        if (w && h) {
          if (!estilo.width && !Number.isFinite(larguraAtrib) && !tamanho) { /* já resolvido */ }
          runs.push({ kind: 'imagem', w: Math.min(w, area.largura), h: h * (Math.min(w, area.largura) / w), src: absoluta, original: imageSrcs.get(absoluta) || null, href, alt });
          return;
        }
        // Sem tamanho conhecido: registra como CANDIDATA a download e mostra o texto
        // alternativo nesta primeira passada. Quando o bitmap chega, o app refaz o
        // layout com o tamanho real e a imagem substitui o texto — o mesmo
        // "reflow" que um navegador faz depois que a imagem carrega.
        // (Sem este registro, uma imagem sem `width`/`height` nunca seria buscada:
        // o ovo e a galinha que o teste de integração pegou.)
        if (absoluta) images.push({ src: absoluta, original: imageSrcs.get(absoluta) || null, w: null, h: null, semTamanho: true, alt });
        if (alt) runs.push(paraRunTexto(`[imagem: ${alt}]`, { ...estilo, fontStyle: 'italic' }, href, null));
        else if (absoluta) runs.push(paraRunTexto('[imagem]', { ...estilo, fontStyle: 'italic' }, href, null));
      },
      atomico(el, estilo, containerAtual, areaAtual) {
        // Layout independente, depois deslocado para a posição na linha.
        const itensAntes = items.length;
        const alturaAlvo = estilo.height ? px(estilo.height, contextoBase) : null;
        const largura = estilo.width ? Math.min(px(estilo.width, contextoBase) || areaAtual.largura, areaAtual.largura) : Math.min(areaAtual.largura, 200);
        const sub = { y: 0, prevMargin: 0, temConteudo: false };
        bloco(el, estilo, sub, { x: 0, largura });
        const novos = items.slice(itensAntes);
        const altura = Math.max(alturaAlvo || 0, sub.y);
        // O bloco empilhou os itens em coordenadas locais (a partir de 0,0):
        // guardamos uma cópia e desfazemos, porque quem posiciona é o runner.
        items.length = itensAntes;
        // Os links internos são recriados no posicionamento, com as coordenadas finais.
        const itensLocais = [];
        for (const item of novos) if (!item.fundo) itensLocais.push({ ...item, href: item.href || hrefDe(el) });
        runs.push({ kind: 'atomico', itens: itensLocais, w: largura, h: altura, href: hrefDe(el) });
      },
      quebra() { runs.push({ kind: 'break', altura: 16 * 1.25 }); },
      marca() { return runs.length; },
      descarregar
    };

    function paraRunTexto(texto, estilo, href, node) {
      return {
        kind: 'texto', texto, font: fontString(estilo), fontSize: estilo.fontSize,
        lineHeight: estilo.lineHeight, cor: estilo.color, decoracao: estilo.textDecoration,
        href: href || null, node, whiteSpace: estilo.whiteSpace,
        // Fundo por run só faz sentido em elemento inline: um bloco já pintou o seu,
        // e pintar de novo por run duplicava retângulos (dois por <span>).
        fundo: estilo.display === 'inline' && estilo.background && estilo.background !== 'rgba(0,0,0,0)' ? estilo.background : null
      };
    }
  }

  /** `<tr>`: células lado a lado, dividindo a largura quando não têm largura própria. */
  function linhasDeTabela(tr, estiloTr, cursor, container, area) {
    const celulas = [...tr.children].filter(c => /^(td|th)$/i.test(c.tagName));
    if (!celulas.length) return;
    cursor.y += px(estiloTr.margin.top, contextoBase);
    const itensAntes = items.length;
    const larguraDisponivel = area.largura;
    const larguras = celulas.map(c => {
      const attr = Number(c.getAttribute('width'));
      if (Number.isFinite(attr) && attr > 0) return Math.min(attr, larguraDisponivel);
      const m = /^(\d+(?:\.\d+)?)%$/.exec(c.getAttribute('style') || '');
      if (m) return (Number(m[1]) / 100) * larguraDisponivel;
      return larguraDisponivel / celulas.length;
    });
    const soma = larguras.reduce((a, b) => a + b, 0) || 1;
    const fator = soma > larguraDisponivel ? larguraDisponivel / soma : 1;
    let x = area.x;
    let alturaLinha = 0;
    for (const [i, celula] of celulas.entries()) {
      const largura = Math.max(0, larguras[i] * fator);
      const estiloCelula = computeStyle(celula, regras, estiloTr);
      const sub = { y: 0, prevMargin: 0, temConteudo: false };
      const antes = items.length;
      bloco(celula, estiloCelula, sub, { x: 0, largura });
      const novos = items.slice(antes);
      items.length = antes;
      for (const item of novos) push({ ...item, x: item.x + pad(x), y: item.y + pad(cursor.y) });
      alturaLinha = Math.max(alturaLinha, sub.y);
      x += largura;
    }
    cursor.y += Math.max(alturaLinha, 1);
    cursor.temConteudo = true;
  }

  // ------------------------------------------------------------------ execução --
  bloco(bodyEl, estiloBody, { y: 0, prevMargin: 0, temConteudo: false }, { x: 0, largura: width });
  const alturaFinal = items.reduce((m, i) => Math.max(m, i.y + (i.h || i.altura || 0)), 0) + 24;

  return {
    items, links, images,
    height: Math.max(height, alturaFinal),
    stats: { items: items.length, boxes: stats.boxes, lines: stats.lines, overflowed }
  };
}

/** Normaliza espaços como o CSS faz por padrão (`white-space: normal`). */
function style_textoNorm(texto, whiteSpace) {
  if (!texto) return '';
  if (whiteSpace === 'pre') return texto;
  return String(texto).replace(/\s+/g, ' ');
}

export { style_textoNorm };
