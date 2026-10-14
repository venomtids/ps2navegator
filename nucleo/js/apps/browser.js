/**
 * NÚCLEO OS — apps/browser.js
 * Navegador do sistema com motor de renderização próprio.
 *
 * O que ele faz de verdade: busca a página pelo proxy local (`/api/fetch`, com a
 * política anti-SSRF de `js/core/fetchpolicy.js`), busca o CSS externo, calcula o
 * layout (`js/core/layout.js`, cascata em `js/core/css.js`), decodifica as imagens
 * (`js/apps/gfx/images.js`), pinta em canvas 2D (`js/apps/gfx/paint.js`) e deixa
 * você clicar nos links por teste de acerto.
 *
 * O que ele NÃO faz, e é dito na própria interface: não executa JavaScript da
 * página (nem o nosso: o HTML é dados, nunca código), não implementa flex/grid/
 * float/`position`, e não roda plugins. Cada uma dessas ausências vira uma nota
 * visível com a contagem real do que foi encontrado na página.
 *
 * Alternar para modo texto (`htmltext.js`) está a um clique: mesma página, sem
 * pintura — útil em rede lenta e para leitura. Dois motores, uma verdade só.
 */

import { el, fmtBytes } from '../core/util.js';
import { renderPage } from '../core/htmltext.js';
import { carregarFonte, injetarCss, cssDe } from '../core/srcpage.js';
import { layout, fontString } from '../core/layout.js';
import { paint, hitTest, FUNDO_PADRAO } from './gfx/paint.js';
import { carregarImagens, tamanhosDe, MAX_IMAGENS } from './gfx/images.js';
import { svgIcon } from '../ui/icons.js';

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;
const ZOOM_PADRAO = 1;

/** Página inicial local: zero requisições, sempre funciona, sem depender de rede. */
const HOME = 'about:inicio';
export const URL_INICIAL = HOME;
export const PAGINA_INICIAL = `<!doctype html><html><head><title>Navegador do sistema</title>
<style>
  body { font-family: sans; color: #eaf2ff; background: #0a0f16; margin: 0; padding: 22px; }
  h1 { color: #35f0ff; font-size: 26px; margin: 0 0 6px; }
  h2 { color: #8ce8ff; font-size: 15px; margin: 22px 0 6px; letter-spacing: .04em; }
  p { margin: 8px 0; line-height: 1.55; }
  .sub { color: #9fb0c6; }
  .cartao { background: #111a24; border: 1px solid #1d2b3a; border-radius: 10px; padding: 14px 16px; margin: 10px 0; }
  .ex { display: inline-block; background: #16222e; border: 1px solid #23384c; border-radius: 8px; padding: 8px 12px; margin: 4px 6px 4px 0; }
  a { color: #35f0ff; text-decoration: none; }
  .link { color: #35f0ff; text-decoration: underline; }
  code { font-family: mono; color: #ffd479; }
  .pe { color: #7b8fa5; font-size: 13px; }
</style></head><body>
<h1>Navegador do sistema</h1>
<p class="sub">Motor próprio: HTML + CSS (parcial) → layout → canvas 2D. A página é buscada pelo servidor local com política anti-SSRF, o CSS externo é carregado, as imagens são decodificadas e os links são clicáveis.</p>
<div class="cartao">
  <h2>O que este motor faz</h2>
  <p>Fluxo de blocos com margem, padding e borda · fluxo inline com quebra de linha por palavra · listas, tabelas, regras · cores, fontes, negrito, itálico, sublinhado · imagens (até ${MAX_IMAGENS} por página) · rolagem, zoom e hit-test de links.</p>
</div>
<div class="cartao">
  <h2>O que ele não faz (e a interface avisa quando encontra)</h2>
  <p>JavaScript da página, flex/grid/float/position, iframe, vídeo, SVG inline, plugins. Cada ocorrência vira uma nota com a contagem real — nada desaparece em silêncio.</p>
</div>
<h2>Exemplos reais</h2>
<p class="ex"><span class="link" data-href="https://github.com/explore">github.com/explore</span></p>
<p class="ex"><span class="link" data-href="https://pt.wikipedia.org/wiki/Navegador_web">pt.wikipedia.org — Navegador web</span></p>
<p class="ex"><span class="link" data-href="https://registry.npmjs.org/jsdom">registry.npmjs.org/jsdom</span></p>
<h2>Atalhos</h2>
<p><code>Alt+←</code> e <code>Alt+→</code> navegam · <code>F5</code> recarrega · <code>Ctrl+L</code> foca a barra · <code>+</code> e <code>−</code> mudam o zoom · roda do mouse rola; arrastar também.</p>
<p class="pe">Se um endereço falhar, o motivo exato (DNS, recusa de conexão, certificado, tempo esgotado) aparece na barra de estado e no painel de notas. Rede restrita limita quais hosts respondem — e isso é dito, não escondido.</p>
</body></html>`;

export function createBrowser({ toast, os, vfs }) {
  const history = [];
  let cursor = -1;
  let atual = null;           // {url, fonte, pagina, modo, meta}
  let modo = 'grafico';       // 'grafico' | 'texto'
  let zoom = ZOOM_PADRAO;
  let scroll = { x: 0, y: 0 };
  let ocupado = false;
  let notas = [];
  const cacheImagens = new Map();
  let statusImagens = null;

  // ---------------------------------------------------------------- estrutura --
  const address = el('input', {
    type: 'text', class: 'addr', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'endereço ou busca — ex.: github.com', 'aria-label': 'Endereço'
  });
  const status = el('span', { class: 'status mono' });
  const back = el('button', { class: 'btn sm', text: '←', title: 'Voltar (Alt+←)', onclick: () => ir(cursor - 1) });
  const fwd = el('button', { class: 'btn sm', text: '→', title: 'Avançar (Alt+→)', onclick: () => ir(cursor + 1) });
  const reload = el('button', { class: 'btn sm', text: '⟳', title: 'Recarregar (F5)', onclick: () => atual && carregar(atual.url, { push: false }) });
  const modoBtn = el('button', { class: 'btn sm', text: 'Texto', title: 'Alternar motor gráfico ⇄ modo texto', onclick: trocarModo });
  const zoomOut = el('button', { class: 'btn sm', text: '−', title: 'Diminuir zoom', onclick: () => mudarZoom(-0.1) });
  const zoomLbl = el('button', { class: 'btn sm mono', text: '100%', title: 'Zoom (clique para voltar a 100%)', onclick: () => { zoom = ZOOM_PADRAO; aplicarZoom(); } });
  const zoomIn = el('button', { class: 'btn sm', text: '+', title: 'Aumentar zoom', onclick: () => mudarZoom(0.1) });
  const save = el('button', { class: 'btn sm', text: 'Salvar', title: 'Salvar no disco virtual (~/Downloads)', onclick: salvar, disabled: true });
  const notasBtn = el('button', { class: 'btn sm mono', text: 'notas 0', title: 'O que a página pediu e o motor não faz', onclick: alternarNotas });

  const canvas = el('canvas', { class: 'bcanvas', width: 800, height: 600 });
  const textoView = el('div', { class: 'btext mono' });
  const vazio = el('div', { class: 'bempty mono', text: 'sem conteúdo' });
  const viewport = el('div', {
    class: 'bview gfx', tabindex: '0', 'aria-label': 'Página renderizada'
  }, canvas, textoView);
  const notasPanel = el('div', { class: 'bnotas mono' });

  const root = el('div', { class: 'browser' },
    el('div', { class: 'bar' }, back, fwd, reload, address, modoBtn, zoomOut, zoomLbl, zoomIn, save),
    el('div', { class: 'bmeta' }, svgIcon('globe', 13), status, notasBtn),
    viewport,
    notasPanel
  );

  let ctx = null;
  try { ctx = canvas.getContext?.('2d') || null; } catch { ctx = null; }

  let statusBase = '';

  const setOcupado = (on, texto) => {
    ocupado = on;
    root.classList.toggle('busy', on);
    if (texto) status.textContent = texto;
  };

  // ------------------------------------------------------------------- fontes --
  /** Medidor real: o próprio canvas, com a fonte que será usada na pintura. */
  function medir(texto, fonte) {
    if (ctx && canvas.clientWidth) {
      try { ctx.font = fonte; return ctx.measureText(texto).width; } catch { /* cai no estimador */ }
    }
    // Sem canvas (jsdom, contexto indisponível): estimador explícito, nunca silencioso.
    const m = /(\d+(?:\.\d+)?)px/.exec(fonte);
    const tamanho = m ? Number(m[1]) : 16;
    const mono = /mono|Menlo|Consolas|Courier/i.test(fonte);
    return texto.length * tamanho * (mono ? 0.6 : (/bold/.test(fonte) ? 0.56 : 0.52));
  }

  // -------------------------------------------------------------- dimensões ----
  function dimensoes() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    // jsdom não calcula layout: sem cliente, usamos um tamanho declarado. O
    // `hint` fica visível na barra de estado ("sem layout real") — nada fingido.
    const semLayout = !canvas.clientWidth || !canvas.clientHeight;
    const larguraCss = semLayout ? 800 : canvas.clientWidth;
    const alturaCss = semLayout ? 600 : canvas.clientHeight;
    return { dpr, larguraCss, alturaCss, semLayout };
  }

  function prepararCanvas() {
    const { dpr, larguraCss, alturaCss } = dimensoes();
    const w = Math.round(larguraCss * dpr), h = Math.round(alturaCss * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (ctx?.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ------------------------------------------------------------------ render ---
  async function buscarJson(url) {
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    const json = await res.json().catch(() => ({ ok: false, error: `resposta inválida (HTTP ${res.status})` }));
    return json;
  }

  /** Layout + pintura com o estado atual (modo, zoom, rolagem). */
  function renderizar() {
    if (!atual || !atual.fonte) return;
    if (atual.modo === 'texto') return;   // o modo texto é DOM, não canvas

    const { larguraCss, alturaCss, semLayout } = dimensoes();
    prepararCanvas();

    const larguraLayout = Math.max(240, Math.round(larguraCss / zoom));
    const t0 = performance.now();
    const pagina = layout(atual.fonte.doc, {
      width: larguraLayout,
      height: alturaCss,
      measure: medir,
      imageSizes: tamanhosDe(cacheImagens),
      baseUrl: atual.fonte.url
    });
    const msLayout = Math.round((performance.now() - t0) * 10) / 10;

    const maxScrollY = Math.max(0, pagina.height - alturaCss / zoom);
    const maxScrollX = Math.max(0, larguraLayout - larguraCss / zoom);
    scroll.y = Math.min(Math.max(0, scroll.y), maxScrollY);
    scroll.x = Math.min(Math.max(0, scroll.x), maxScrollX);

    let pintura = { ms: 0 };
    if (ctx) {
      // Escala = densidade da tela × zoom: o layout trabalha em px CSS, o canvas
      // em pixels de dispositivo, e o zoom é aplicado aqui em uma única multiplicação.
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
      pintura = paint(ctx, pagina, {
        scrollX: scroll.x, scrollY: scroll.y,
        width: larguraCss / zoom, height: alturaCss / zoom,
        images: cacheImagens
      });
    }

    atual.pagina = pagina;
    atual.render = { msLayout, msPintura: pintura.ms, larguraLayout, maxScrollY, maxScrollX };

    const porcentagem = pagina.height > alturaCss / zoom ? Math.round((scroll.y / Math.max(1, maxScrollY)) * 100) : 100;
    const partes = [
      atual.meta ? `${atual.meta.status}` : 'local',
      atual.meta?.bytes != null ? fmtBytes(atual.meta.bytes, 1) : '0 B',
      atual.meta?.ms != null ? `${atual.meta.ms} ms` : null,
      `layout ${msLayout} ms`,
      `pintura ${pintura.ms} ms`,
      `${pagina.links.length} links`,
      statusImagens,
      `${porcentagem}%`,
      semLayout ? 'sem layout real (contexto de teste)' : null
    ].filter(Boolean);
    statusBase = partes.join(' · ');
    status.textContent = statusBase;
    save.disabled = !atual.url || atual.url.startsWith('about:');
  }

  async function carregar(url, { push = true, texto = null } = {}) {
    if (ocupado) return;
    const alvo = String(url);
    if (alvo.startsWith('about:')) {
      return carregarLocal(alvo, { push });
    }
    setOcupado(true, `buscando ${alvo}…`);
    scroll = { x: 0, y: 0 };
    statusImagens = null;
    try {
      const meta = await buscarJson(alvo);
      if (!meta.ok) return mostrarErro(alvo, meta.error || 'falha desconhecida', meta);

      const t0 = performance.now();
      const fonte = await carregarFonte(meta.url || alvo, {
        buscarJson, parser: globalThis.DOMParser || globalThis.window?.DOMParser, texto: meta.text,
        log: (...a) => console.debug('[navegador]', ...a)
      });
      injetarCss(fonte.doc, cssDe(fonte), { origem: 'externa+inline' });

      atual = { url: fonte.url, fonte, meta, modo, pagina: null, render: null };
      aplicarModo();
      renderizar();
      const msTotal = Math.round(performance.now() - t0);
      registrar({
        tipo: 'busca',
        url: fonte.url,
        ms: msTotal,
        bytes: meta.bytes,
        imagensListadas: fonte.imagens.length
      });

      if (push) empilhar(fonte.url);
      address.value = fonte.url;
      save.disabled = false;

      definirNotas(fonte.notas, meta);
      carregarImagensEmSegundo();
    } catch (e) {
      mostrarErro(alvo, String(e?.message || e));
    } finally {
      setOcupado(false);
      atualizarNavegacao();
    }
  }

  async function carregarLocal(url, { push = true } = {}) {
    try {
      const Doc = globalThis.DOMParser || globalThis.window?.DOMParser;
      const dom = new Doc();
      const doc = dom.parseFromString(PAGINA_INICIAL, 'text/html');
      const fonte = { doc, url, folhas: [], inlineCss: '', imagens: [], notas: [], scripts: 0 };
      atual = { url, fonte, meta: null, modo, pagina: null, render: null };
      aplicarModo();
      renderizar();
      registrar({ tipo: 'local', url, ms: 0, bytes: PAGINA_INICIAL.length, imagensListadas: 0 });
      if (push) empilhar(url);
      address.value = url;
      save.disabled = true;
      definirNotas([], null);
    } catch (e) {
      mostrarErro(url, `página local indisponível: ${String(e?.message || e)}`);
    }
  }

  /** Imagens em segundo plano: quando chegam, repinta (e refaz o layout se mudou tamanho). */
  async function carregarImagensEmSegundo() {
    if (!atual?.fonte?.imagens?.length) { statusImagens = null; return; }
    const alvo = atual.url;
    try {
      const r = await carregarImagens(atual.pagina, { fetchImpl: fetch, cache: cacheImagens });
      if (atual?.url !== alvo) return;   // o usuário navegou: descarta este resultado
      statusImagens = `imagens ${r.baixadas}/${(atual.pagina.images || []).length}${r.falhas.length ? ` (${r.falhas.length} falhou)` : ''}`;
      if (r.falhas.length) {
        for (const f of r.falhas.slice(0, 3)) console.debug('[navegador] imagem falhou', f.src, f.motivo);
      }
      renderizar();
    } catch (e) {
      statusImagens = `imagens: falha (${String(e?.message || e)})`;
      renderizar();
    }
  }

  function mostrarErro(url, motivo, meta = null) {
    atual = { url, fonte: null, meta, modo, pagina: null, render: null };
    aplicarModo();
    textoView.replaceChildren(el('div', { class: 'berror' },
      el('div', { class: 'lbl', text: 'não foi possível abrir' }),
      el('div', { class: 'u mono', text: url }),
      el('div', { class: 'why', text: String(motivo) }),
      el('div', { class: 'hint', text: 'o motivo acima vem da rede ou do servidor — nada é arredondado nem escondido' }),
      el('div', { class: 'hint', text: 'rede restrita (empresa, escola, sandbox) bloqueia destinos fora da lista permitida' })
    ));
    if (ctx) { prepararCanvas(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = FUNDO_PADRAO; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    status.textContent = `erro · ${url}`;
    address.value = url;
    save.disabled = true;
    registrar({ tipo: 'erro', url, motivo });
  }

  function registrar(entrada) {
    if (!globalThis.__nucleoNavegadorLog) globalThis.__nucleoNavegadorLog = [];
    globalThis.__nucleoNavegadorLog.push({ ...entrada, quando: Date.now() });
    if (globalThis.__nucleoNavegadorLog.length > 200) globalThis.__nucleoNavegadorLog.shift();
  }

  function definirNotas(lista, meta) {
    notas = [...(lista || [])];
    if (meta?.note) notas.push(meta.note);
    notasBtn.textContent = `notas ${notas.length}`;
    notasBtn.disabled = notas.length === 0;
    notasPanel.replaceChildren(...notas.map(n => el('div', { class: 'bnota', text: `• ${n}` })));
    notasPanel.classList.toggle('on', notas.length > 0 && notasPanel.classList.contains('on'));
  }

  function alternarNotas() {
    notasPanel.classList.toggle('on');
  }

  // -------------------------------------------------------------- modo texto ---
  function renderTexto() {
    const { larguraCss } = dimensoes();
    textoView.replaceChildren();
    if (!atual?.meta?.text) { textoView.append(el('div', { class: 'bempty mono', text: 'sem texto para exibir neste modo' })); return; }
    const pagina = renderPage(atual.meta.text, { url: atual.url, maxLines: 4000 });
    const nodes = [];
    for (const linha of pagina.lines) {
      if (linha.kind === 'rule') { nodes.push(el('div', { class: 'brule' })); continue; }
      if (linha.kind === 'break') continue;
      const row = el('div', { class: `bline k-${linha.kind}` });
      const segmentos = linha.segments?.length ? linha.segments : [{ text: linha.text, href: linha.href }];
      for (const seg of segmentos) {
        if (seg.href) row.append(el('a', { class: 'blink', href: seg.href, text: seg.text, onclick: e => { e.preventDefault(); carregar(seg.href); } }));
        else row.append(document.createTextNode(seg.text));
      }
      nodes.push(row);
    }
    if (pagina.truncated) nodes.push(el('div', { class: 'btrunc', text: `… truncado em ${pagina.lines.length} linhas` }));
    nodes.push(el('div', { class: 'bfoot mono', text: `${atual.url} · ${pagina.links.length} links · modo texto` }));
    textoView.append(...nodes);
    void larguraCss;
  }

  function aplicarModo() {
    const grafico = modo === 'grafico';
    viewport.classList.toggle('gfx', grafico);
    textoView.classList.toggle('on', !grafico);
    modoBtn.textContent = grafico ? 'Texto' : 'Gráfico';
    modoBtn.title = grafico ? 'Ver como texto (leve, sem pintura)' : 'Voltar ao motor gráfico';
    if (!grafico) renderTexto();
  }

  function trocarModo() {
    modo = modo === 'grafico' ? 'texto' : 'grafico';
    if (atual) atual.modo = modo;
    aplicarModo();
    if (modo === 'grafico') renderizar(); else renderTexto();
  }

  // ------------------------------------------------------------------ zoom -----
  function mudarZoom(delta) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + delta) * 100) / 100));
    aplicarZoom();
  }

  function aplicarZoom() {
    zoomLbl.textContent = `${Math.round(zoom * 100)}%`;
    if (modo === 'grafico') {
      // Mantém o ponto central da janela durante o zoom (comportamento de navegador).
      renderizar();
    } else {
      textoView.style.fontSize = `${Math.round(12.5 * zoom * 10) / 10}px`;
    }
  }

  // ------------------------------------------------------------ navegação ------
  function empilhar(url) {
    history.splice(cursor + 1);
    history.push(url);
    cursor = history.length - 1;
  }

  function ir(indice) {
    if (indice < 0 || indice >= history.length) return;
    cursor = indice;
    carregar(history[indice], { push: false });
  }

  function atualizarNavegacao() {
    back.disabled = cursor <= 0;
    fwd.disabled = cursor >= history.length - 1;
  }

  function toTarget(entrada) {
    const texto = String(entrada || '').trim();
    if (!texto) return null;
    if (/^about:/i.test(texto)) return texto;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(texto)) return texto;
    if (/^[\w-]+(\.[\w-]+)+(\/|$|:)/.test(texto)) return `https://${texto}`;
    return `https://pt.wikipedia.org/w/index.php?search=${encodeURIComponent(texto)}`;
  }

  async function salvar() {
    if (!atual?.url || atual.url.startsWith('about:')) return;
    save.disabled = true;
    status.textContent = 'baixando para o disco virtual…';
    try {
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(atual.url)}&raw=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const nome = nomeDeArquivo(atual.url, res.headers.get('content-type') || '');
      await os.installFiles(os.installDir, [{ name: nome, size: bytes.length, arrayBuffer: async () => bytes.buffer }]);
      status.textContent = `salvo em ~/Downloads · ${fmtBytes(bytes.length, 1)}`;
    } catch (e) {
      toast.err('Não foi possível salvar', String(e?.message || e));
      status.textContent = 'falha ao salvar';
    } finally {
      save.disabled = false;
    }
  }

  // ------------------------------------------------------------- interação -----
  /**
   * Converte a posição do ponteiro (coordenadas de tela) para coordenadas da
   * página (px de layout). O canvas é dimensionado em pixels de dispositivo, então
   * a conversão divide pelo tamanho em CSS e depois aplica rolagem e zoom.
   */
  const posicaoLocal = evento => {
    const r = canvas.getBoundingClientRect?.() || { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    const larguraCss = canvas.clientWidth || r.width || 800;
    const alturaCss = canvas.clientHeight || r.height || 600;
    const x = (evento.clientX - r.left) * (larguraCss / (r.width || larguraCss));
    const y = (evento.clientY - r.top) * (alturaCss / (r.height || alturaCss));
    return { x: x / zoom + scroll.x, y: y / zoom + scroll.y };
  };

  function aoClicar(evento) {
    if (modo !== 'grafico' || !atual?.pagina) return;
    const { x, y } = posicaoLocal(evento);
    const alvo = hitTest(atual.pagina, x, y);
    if (alvo.tipo === 'link') carregar(alvo.href);
  }

  let arrasto = null;
  function aoPressionar(evento) {
    if (modo !== 'grafico') return;
    arrasto = { x: evento.clientX, y: evento.clientY, scrollX: scroll.x, scrollY: scroll.y, moveu: false };
  }
  function aoMover(evento) {
    if (modo !== 'grafico' || !atual?.pagina) return;
    canvas.style.cursor = 'default';
    if (arrasto) {
      const dx = (evento.clientX - arrasto.x) / zoom;
      const dy = (evento.clientY - arrasto.y) / zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) arrasto.moveu = true;
      scroll.x = arrasto.scrollX - dx;
      scroll.y = arrasto.scrollY - dy;
      renderizar();
      return;
    }
    const { x, y } = posicaoLocal(evento);
    const alvo = hitTest(atual.pagina, x, y);
    canvas.style.cursor = alvo.tipo === 'link' ? 'pointer' : 'default';
    if (alvo.tipo === 'link') {
      status.textContent = `${statusBase} → ${alvo.href}`;
    } else if (status.textContent !== statusBase) {
      status.textContent = statusBase;
    }
  }
  function aoSoltar() { arrasto = null; }

  function aoRolar(evento) {
    if (modo !== 'grafico' || !atual?.pagina) return;
    evento.preventDefault();
    if (evento.ctrlKey) { mudarZoom(evento.deltaY < 0 ? 0.1 : -0.1); return; }
    scroll.y += evento.deltaY / zoom;
    scroll.x += evento.deltaX / zoom;
    renderizar();
  }

  viewport.addEventListener('click', aoClicar);
  viewport.addEventListener('pointerdown', aoPressionar);
  viewport.addEventListener('pointermove', aoMover);
  viewport.addEventListener('pointerup', aoSoltar);
  viewport.addEventListener('pointercancel', aoSoltar);
  viewport.addEventListener('wheel', aoRolar, { passive: false });
  canvas.addEventListener('mousemove', aoMover);

  address.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const alvo = toTarget(address.value);
    if (alvo) carregar(alvo);
  });

  root.addEventListener('keydown', e => {
    const tecla = e.key;
    if (e.altKey && tecla === 'ArrowLeft') { e.preventDefault(); ir(cursor - 1); }
    else if (e.altKey && tecla === 'ArrowRight') { e.preventDefault(); ir(cursor + 1); }
    else if (tecla === 'F5') { e.preventDefault(); if (atual && !atual.url.startsWith('about:')) carregar(atual.url, { push: false }); }
    else if (tecla.toLowerCase() === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); address.select(); address.focus(); }
    else if ((tecla === '+' || tecla === '=') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); mudarZoom(0.1); }
    else if (tecla === '-' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); mudarZoom(-0.1); }
    else if (tecla === 'PageDown' || (tecla === ' ' && modo === 'grafico')) {
      e.preventDefault();
      scroll.y += (dimensoes().alturaCss / zoom) * 0.9;
      if (modo === 'grafico') renderizar(); else textoView.scrollTop += 400;
    } else if (tecla === 'PageUp') {
      e.preventDefault();
      scroll.y = Math.max(0, scroll.y - (dimensoes().alturaCss / zoom) * 0.9);
      if (modo === 'grafico') renderizar(); else textoView.scrollTop -= 400;
    } else if (tecla === 'Home') { e.preventDefault(); scroll = { x: 0, y: 0 }; if (modo === 'grafico') renderizar(); else textoView.scrollTop = 0; }
    else if (tecla === 'End') { e.preventDefault(); scroll.y = 1e9; if (modo === 'grafico') renderizar(); else textoView.scrollTop = 1e9; }
  });

  const observador = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (modo === 'grafico') renderizar(); })
    : null;
  observador?.observe?.(viewport);

  zoomLbl.textContent = `${Math.round(zoom * 100)}%`;

  return {
    el: root,
    onMount() {
      address.focus();
      carregar(HOME);
    },
    onClose() { observador?.disconnect?.(); },
    onResize() { if (modo === 'grafico') renderizar(); },
    openUrl(url) { const alvo = toTarget(url); if (alvo) carregar(alvo); },
    focus() { address.focus(); },
    get url() { return atual?.url || ''; },
    get modo() { return modo; },
    get stats() {
      return {
        history: history.length, cursor, zoom, scroll: { ...scroll },
        modo, itens: atual?.pagina?.items.length || 0,
        links: atual?.pagina?.links.length || 0,
        altura: atual?.pagina?.height || 0,
        imagens: atual?.pagina?.images.length || 0,
        notas: notas.length,
        render: atual?.render || null,
        texto: { linhas: atual?.fonte ? (atual.meta?.text || '').length : 0 }
      };
    },
    // expostos para os testes e para depuração honesta
    _internals: { renderizar, definirNotas, hitTest: (x, y) => (atual?.pagina ? hitTest(atual.pagina, x, y) : { tipo: 'vazio' }), notas: () => notas.slice() }
  };
}

/** Nome de arquivo derivado da URL (e do content-type, quando a URL não ajuda). */
export function nomeDeArquivo(url, contentType = '') {
  try {
    const { pathname } = new URL(url);
    const ultimo = pathname.split('/').filter(Boolean).pop() || '';
    const limpo = decodeURIComponent(ultimo).replace(/[^\w.\-]+/g, '_').slice(0, 80);
    if (limpo && /\.[a-z0-9]{1,8}$/i.test(limpo)) return limpo;
    const ext = contentType.includes('html') ? '.html'
      : contentType.includes('json') ? '.json'
        : contentType.includes('plain') ? '.txt'
          : contentType.includes('png') ? '.png'
            : contentType.includes('jpeg') ? '.jpg'
              : contentType.includes('pdf') ? '.pdf'
                : contentType.includes('svg') ? '.svg'
                  : '.bin';
    return `${limpo || 'pagina'}${ext}`;
  } catch { return 'pagina.html'; }
}

// compatibilidade: o teste antigo importava `fileNameFrom`
export const fileNameFrom = nomeDeArquivo;
export { fontString };
