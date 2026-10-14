/**
 * NÚCLEO OS — apps/gfx/paint.js
 * Pintor: lista de itens do layout → canvas 2D.
 *
 * Separado do layout de propósito: o layout decide ONDE as coisas ficam, o pintor
 * decide COMO aparecem. Isso permite testar a pintura sem navegador (um contexto
 * falso que grava chamadas) e trocar o backend (canvas 2D hoje, WebGPU depois)
 * sem tocar no layout.
 */

/** Cor de fundo quando a página não define nenhuma (branco, como o navegador). */
export const FUNDO_PADRAO = '#ffffff';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} pagina                resultado de `layout()`
 * @param {object} opts
 * @param {number} [opts.scrollX]
 * @param {number} [opts.scrollY]
 * @param {number} [opts.width]           largura visível em px CSS
 * @param {number} [opts.height]
 * @param {Map} [opts.images]             src absoluto → {bitmap, w, h}
 * @param {object} [opts.selecao]         {x,y,w,h} faixa selecionada (fundo azul)
 */
export function paint(ctx, pagina, {
  scrollX = 0, scrollY = 0, width = 0, height = 0, images = new Map(), selecao = null
} = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const stats = { rects: 0, textos: 0, imagens: 0, imagensVisiveis: 0, links: 0 };

  if (!ctx) return { ...stats, ms: 0 };

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // 1) fundo: a página inteira, depois o que o layout mandou.
  ctx.fillStyle = FUNDO_PADRAO;
  ctx.fillRect(0, 0, width, height);

  // Culling: só pinta o que está (ou quase) visível. É a razão de a rolagem ser
  // barata mesmo em páginas com milhares de itens.
  const margem = 64;
  const visivel = item => {
    const x0 = (item.x ?? 0) - scrollX;
    const y0 = (item.y ?? 0) - scrollY;
    const w = item.w ?? item.largura ?? 0;
    const h = item.h ?? item.altura ?? 0;
    return x0 + w >= -margem && x0 <= width + margem && (y0 + h >= -margem) && y0 <= height + margem;
  };

  // Seleção de texto (fundo azul antes do texto, para o texto ficar legível).
  if (selecao) {
    ctx.fillStyle = 'rgba(53, 240, 255, 0.22)';
    ctx.fillRect(selecao.x - scrollX, selecao.y - scrollY, selecao.w, selecao.h);
  }

  for (const item of pagina.items) {
    if (!visivel(item)) continue;
    const x = (item.x ?? 0) - scrollX;
    const y = (item.y ?? 0) - scrollY;

    if (item.kind === 'rect') {
      if (!item.color) continue;
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y, item.w ?? 0, item.h ?? 0);
      stats.rects++;
      continue;
    }

    if (item.kind === 'image') {
      const entrada = item.src ? images.get(item.src) : null;
      if (entrada?.bitmap) {
        try {
          ctx.drawImage(entrada.bitmap, x, y, item.w, item.h);
          stats.imagensVisiveis++;
        } catch { /* bitmap fechado/inválido: cai no marcador abaixo */ }
      }
      if (!entrada?.bitmap) {
        // Sem imagem decodificada: caixa tracejada com legenda alternativa.
        ctx.save();
        ctx.strokeStyle = '#c8cdd6';
        ctx.lineWidth = 1;
        if (ctx.setLineDash) ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, item.w - 1), Math.max(0, item.h - 1));
        if (ctx.setLineDash) ctx.setLineDash([]);
        if (item.alt && item.w >= 24) {
          ctx.fillStyle = '#7b8494';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(String(item.alt).slice(0, Math.max(3, Math.floor(item.w / 6))), x + 4, y + 14);
        }
        ctx.restore();
      }
      stats.imagens++;
      if (item.href) stats.links++;
      continue;
    }

    if (item.kind === 'text') {
      if (!item.texto) continue;
      ctx.font = item.font || '16px system-ui, sans-serif';
      ctx.fillStyle = item.color || '#1a1a1a';
      ctx.fillText(item.texto, x, y);
      stats.textos++;
      if (item.decoracao === 'underline') {
        const largura = item.largura ?? ctx.measureText(item.texto).width;
        ctx.fillRect(x, y + 2, largura, 1);
      } else if (item.decoracao === 'line-through') {
        const largura = item.largura ?? ctx.measureText(item.texto).width;
        ctx.fillRect(x, y - 4, largura, 1);
      }
      if (item.href) stats.links++;
      continue;
    }
  }

  ctx.restore();
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return { ...stats, ms: Math.round((t1 - t0) * 100) / 100, total: pagina.items.length };
}

/**
 * Teste de acerto: qual link (ou item) está sob o ponto.
 * Links ganham prioridade sobre texto e caixas — é o que torna a página navegável.
 */
export function hitTest(pagina, x, y) {
  const alvo = { x, y };
  let melhor = null;
  const contem = (item, px, py) => {
    const w = item.w ?? item.largura ?? 0;
    const h = item.h ?? item.altura ?? 0;
    return px >= item.x && px <= item.x + w && py >= item.y && py <= item.y + h;
  };

  for (const item of pagina.items) {
    if (item.kind !== 'text' && item.kind !== 'image') continue;
    if (!item.href) continue;
    // O texto é pintado pela linha de base: a caixa de acerto começa acima dela.
    const caixa = item.kind === 'text'
      ? { x: item.x, y: item.y - (item.altura || 16) + 3, w: item.largura ?? 0, h: item.altura || 16 }
      : item;
    const comFolga = { x: caixa.x - 1, y: caixa.y - 2, w: caixa.w + 2, h: caixa.h + 4 };
    if (contem(comFolga, alvo.x, alvo.y)) {
      if (!melhor || item.kind === 'text') melhor = { href: item.href, item, texto: item.texto || item.alt || '' };
    }
  }
  if (melhor) return { tipo: 'link', href: melhor.href, texto: melhor.texto };

  for (const item of pagina.items) {
    if (item.kind !== 'text') continue;
    if (contem({ x: item.x, y: item.y - (item.altura || 16) + 3, w: item.largura ?? 0, h: item.altura || 16 }, alvo.x, alvo.y)) {
      return { tipo: 'texto', texto: item.texto, item };
    }
  }
  return { tipo: 'vazio' };
}

/** Cursor apropriado para o ponto (a interface usa para o `cursor` do mouse). */
export function cursorAt(pagina, x, y) {
  const alvo = hitTest(pagina, x, y);
  return alvo.tipo === 'link' ? 'pointer' : 'text';
}
