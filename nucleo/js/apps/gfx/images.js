/**
 * NÚCLEO OS — apps/gfx/images.js
 * Carregador de imagens da página: bytes pelo proxy → bitmap utilizável no canvas.
 *
 * Regras que existem por motivo:
 *  - teto de imagens e de bytes: uma página com 300 imagens não pode travar o app;
 *  - timeout individual: uma imagem lenta não segura a página inteira;
 *  - `createImageBitmap` quando existe (decodificação fora da thread principal e
 *    sem `Image`/objectURL), com `Image` + objectURL como queda;
 *  - falha de UMA imagem não derruba a página: ela vira legenda `alt`.
 */

export const MAX_IMAGENS = 24;
export const MAX_BYTES_IMAGEM = 3 * 1024 * 1024;   // por imagem
export const TIMEOUT_IMAGEM_MS = 8000;

/** Formatos que o canvas aceita decodificar sem drama. */
const FORMATOS = /^image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;

/**
 * @param {object} pagina                resultado de `layout()` (campo `images`)
 * @param {object} opts
 * @param {(url:string, opts?:object) => Promise<Response>} opts.fetchImpl
 * @param {Map} [opts.cache]             src → {bitmap,w,h} entre navegações
 * @param {number} [opts.limite]
 * @returns {Promise<{imagens: Map, baixadas: number, falhas: Array, bytes: number, puladas: number}>}
 */
export async function carregarImagens(pagina, {
  fetchImpl = globalThis.fetch, cache = new Map(), limite = MAX_IMAGENS, timeoutMs = TIMEOUT_IMAGEM_MS
} = {}) {
  const alvos = [];
  const vistos = new Set();
  for (const img of pagina.images || []) {
    if (!img.src || vistos.has(img.src)) continue;
    vistos.add(img.src);
    alvos.push(img.src);
  }
  const resultado = new Map();
  const falhas = [];
  let baixadas = 0, bytes = 0, puladas = 0;

  // O que já está no cache entra sem ir à rede.
  for (const src of alvos) {
    if (cache.has(src)) resultado.set(src, cache.get(src));
  }

  const fila = alvos.filter(src => !resultado.has(src));
  if (fila.length > limite) { puladas = fila.length - limite; fila.length = limite; }

  const baixar = async src => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`/api/fetch?url=${encodeURIComponent(src)}&raw=1`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tipo = (res.headers?.get?.('content-type') || '').split(';')[0].trim();
      if (tipo && !FORMATOS.test(tipo)) throw new Error(`formato não suportado: ${tipo}`);
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_BYTES_IMAGEM) throw new Error(`${Math.round(buffer.byteLength / 1048576)} MB acima do teto de 3 MB`);
      const bitmap = await decodificar(buffer, tipo);
      if (!bitmap) throw new Error('não foi possível decodificar');
      const entrada = { bitmap, w: bitmap.width || 0, h: bitmap.height || 0, tipo };
      cache.set(src, entrada);
      resultado.set(src, entrada);
      baixadas++;
      bytes += buffer.byteLength;
      if (resultado.size % 4 === 0) await new Promise(r => setTimeout(r, 0));   // devolve a thread
    } catch (e) {
      falhas.push({ src, motivo: e?.name === 'AbortError' ? `tempo esgotado (${timeoutMs} ms)` : String(e.message || e) });
    } finally {
      clearTimeout(timer);
    }
  };

  // Em ondas de 4: o suficiente para paralelizar sem inundar o proxy.
  for (let i = 0; i < fila.length; i += 4) {
    await Promise.all(fila.slice(i, i + 4).map(baixar));
  }

  return { imagens: resultado, baixadas, falhas, bytes, puladas };
}

/** Bytes → bitmap. `createImageBitmap` quando existe; `Image` + objectURL como queda. */
async function decodificar(buffer, tipo) {
  if (typeof createImageBitmap === 'function') {
    try {
      // SVG precisa do tipo explícito; sem ele alguns navegadores recusam o blob.
      const blob = tipo ? new Blob([buffer], { type: tipo }) : new Blob([buffer]);
      return await createImageBitmap(blob);
    } catch { /* tenta a outra via */ }
  }
  if (typeof Image === 'function' && typeof URL?.createObjectURL === 'function') {
    const blob = tipo ? new Blob([buffer], { type: tipo }) : new Blob([buffer]);
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        const prazo = setTimeout(() => reject(new Error('decodificação demorou demais')), 8000);
        el.onload = () => { clearTimeout(prazo); resolve(el); };
        el.onerror = () => { clearTimeout(prazo); reject(new Error('imagem inválida')); };
        el.src = url;
      });
      return img;
    } catch { return null; } finally { URL.revokeObjectURL(url); }
  }
  return null;
}

/**
 * Descobre o tamanho de uma lista de imagens SEM pintar (para o layout saber a
 * caixa antes). Usado no fluxo: layout com tamanhos conhecidos → pintura → novas
 * imagens → novo layout (reflow, como um navegador faz).
 */
export function tamanhosDe(imagens = new Map()) {
  const mapa = new Map();
  for (const [src, entrada] of imagens) mapa.set(src, { w: entrada.w, h: entrada.h });
  return mapa;
}
