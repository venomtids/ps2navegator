/**
 * NÚCLEO OS — tests/ui.mjs
 * Testes da camada de interface com DOM real (jsdom), sem navegador:
 * boot, sondagens de capacidade, window manager, HUD e toasts.
 *
 * O que este arquivo NÃO cobre (e por isso existe tests/browser.mjs com Playwright):
 * workers com SharedArrayBuffer, OPFS, WebGL2 e eventos de ponteiro.
 *
 * Execute: npm run test:ui
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { failed++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
const section = t => results.push(`\n${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ambiente DOM ----------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:3400'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;

const { createBoot, probeCapabilities } = await import('../js/boot.js');
const { createWM } = await import('../js/core/wm.js');
const { createToasts } = await import('../js/ui/toast.js');
const { createHUD } = await import('../js/ui/hud.js');
const { createBus } = await import('../js/core/bus.js');
const { renderPage, pageToText, resolveUrl } = await import('../js/core/htmltext.js');
const { createBrowser, fileNameFrom } = await import('../js/apps/browser.js');
const { createTerminal } = await import('../js/apps/terminal.js');
const { fmt1 } = await import('../js/core/util.js');

const fresh = () => { document.body.replaceChildren(); return document.body; };

// ------------------------------------------------------------------- boot --
section('boot (tela de inicialização e sondagens)');

await test('createBoot monta o overlay e escreve linhas', async () => {
  const root = fresh();
  const boot = createBoot(root);
  assert.ok(document.querySelector('.boot'), 'overlay de boot precisa existir');
  assert.ok(document.querySelector('.boot .logo').textContent.includes('NÚCLEO'));
  boot.line('linha normal');
  boot.line('aviso', 'warn');
  boot.line('erro', 'err');
  boot.progress(0.5);
  const bar = document.querySelector('.boot .track i');
  assert.equal(bar.style.width, '50%');
  assert.equal(boot.lines, 3);
  assert.match(document.querySelector('.boot .log').textContent, /aviso/);
});

await test('finish() respeita a duração mínima e remove o overlay', async () => {
  const root = fresh();
  const boot = createBoot(root);
  const t0 = performance.now();
  await boot.finish();
  const elapsed = performance.now() - t0;
  assert.ok(elapsed >= 880, `boot curto demais (${elapsed} ms) causaria flash de tela`);
  await sleep(500);
  assert.equal(document.querySelector('.boot'), null, 'overlay deveria sair do DOM');
});

await test('probeCapabilities é honesto quando faltam APIs', async () => {
  const root = fresh();
  const boot = createBoot(root);
  const caps = await probeCapabilities({ boot });
  assert.equal(typeof caps.isolated, 'boolean');
  assert.equal(caps.cores >= 1, true);
  assert.equal(caps.opfs, false, 'jsdom não tem OPFS: o probe deve dizer que não tem');
  assert.equal(caps.webgl2, false, 'sem canvas/GL o probe não pode afirmar suporte');
  const text = document.querySelector('.boot .log').textContent;
  assert.match(text, /WebGL 2\.0 indisponível|WebGPU/);
  assert.ok(text.length > 40);
});

// --------------------------------------------------------------------- wm --
section('window manager (abrir, focar, empilhar, snap, fechar)');

function mountWM() {
  const root = fresh();
  const layer = document.createElement('div'); layer.id = 'windows';
  const taskbar = document.createElement('div'); taskbar.id = 'taskbar';
  const icons = document.createElement('div');
  root.append(layer, taskbar, icons);
  const bus = createBus();
  const events = [];
  bus.on('wm:focus', p => events.push(['focus', p.id]));
  bus.on('wm:close', p => events.push(['close', p.id]));
  bus.on('wm:geometry', p => events.push(['geometry', p.id]));
  const wm = createWM({ layer, taskbar, bus, statusH: 34 });
  return { wm, layer, taskbar, bus, events };
}

await test('abre janela com título, corpo e controles; barra de tarefas acompanha', async () => {
  const { wm, taskbar } = mountWM();
  const win = wm.open({
    id: 'terminal', app: 'terminal', title: 'Terminal', w: 700, h: 400,
    mount: body => { const p = document.createElement('p'); p.textContent = 'conteúdo'; body.append(p); return {}; }
  });
  assert.ok(win.el.classList.contains('win'));
  assert.equal(win.el.querySelector('h2').textContent, 'Terminal');
  assert.equal(win.el.querySelector('.wbody').textContent, 'conteúdo');
  assert.equal(win.el.querySelectorAll('.wbtn').length, 3, 'minimizar, maximizar e fechar');
  assert.equal(win.el.querySelectorAll('.rz').length, 8, 'oito alças de redimensionamento');
  assert.equal(win.el.classList.contains('active'), true, 'a janela aberta recebe foco');
  assert.match(taskbar.textContent, /Terminal/);
  assert.ok(win.rect.w >= 320 && win.rect.h >= 200, 'respeita o tamanho mínimo');
});

await test('singleton não abre duas vezes; foco alterna entre janelas', async () => {
  const { wm } = mountWM();
  wm.open({ id: 'a', app: 'a', title: 'A', w: 400, h: 300 });
  const first = wm.open({ id: 'a', app: 'a', title: 'A', w: 400, h: 300, singleton: true });
  assert.equal(wm.count, 1, 'singleton deve reutilizar a janela');
  assert.ok(first.rect);
  const b = wm.open({ id: 'b', app: 'b', title: 'B', w: 400, h: 300 });
  assert.equal(wm.count, 2);
  wm.focus('a');
  assert.equal(document.querySelector('.win[data-app="a"]').classList.contains('active'), true);
  assert.equal(b.el.classList.contains('active'), false);
});

await test('teto de 3 superfícies translúcidas: a quarta janela vira sólida', async () => {
  const { wm } = mountWM();
  for (let i = 0; i < 4; i++) wm.open({ id: `w${i}`, app: `w${i}`, title: `W${i}`, w: 320, h: 220 });
  const opaque = document.querySelectorAll('.win.opaque');
  assert.equal(opaque.length, 1, 'exatamente a superfície mais antiga deve ficar sólida');
  wm.focus('w0');
  assert.equal(document.querySelectorAll('.win.opaque').length, 1, 'o teto se mantém após trocar o foco');
  assert.equal(document.querySelector('.win[data-app="w0"]').classList.contains('opaque'), false);
});

await test('maximizar ocupa o viewport, restaurar volta à geometria anterior', async () => {
  const { wm } = mountWM();
  const w = wm.open({ id: 'max', app: 'max', title: 'Max', w: 500, h: 300 });
  const before = { ...w.rect };
  wm.toggleMax('max');
  assert.equal(w.el.classList.contains('maximized'), true);
  assert.equal(w.rect.x, 0);
  assert.equal(w.rect.y, 34);
  assert.equal(w.rect.w, window.innerWidth);
  wm.toggleMax('max');
  assert.equal(w.el.classList.contains('maximized'), false);
  assert.deepEqual(w.rect, before, 'restaurar deve devolver a geometria exata');
});

await test('minimizar esconde e devolve o foco à próxima janela', async () => {
  const { wm } = mountWM();
  wm.open({ id: 'k1', app: 'k1', title: 'K1', w: 400, h: 300 });
  const k2 = wm.open({ id: 'k2', app: 'k2', title: 'K2', w: 400, h: 300 });
  wm.minimize('k2');
  assert.equal(k2.el.classList.contains('minimized'), true);
  assert.equal(document.querySelector('.win[data-app="k1"]').classList.contains('active'), true);
  wm.focus('k2');
  assert.equal(k2.el.classList.contains('minimized'), false, 'focar restaura a janela minimizada');
});

await test('fechar dispara onClose uma única vez e libera a barra de tarefas', async () => {
  const { wm, taskbar } = mountWM();
  let closes = 0;
  wm.open({ id: 'x', app: 'x', title: 'X', w: 400, h: 300, mount: () => ({ onClose: () => { closes++; } }) });
  wm.close('x');
  await sleep(220);
  assert.equal(wm.count, 0);
  assert.equal(closes, 1);
  assert.equal(document.querySelector('.win[data-app="x"]'), null);
  assert.match(taskbar.textContent, /nenhuma janela aberta/);
});

await test('onResize recebe a geometria depois de maximizar', async () => {
  const { wm } = mountWM();
  const seen = [];
  const w = wm.open({ id: 'r', app: 'r', title: 'R', w: 500, h: 300, mount: () => ({ onResize: r => seen.push({ ...r }) }) });
  wm.toggleMax('r');
  assert.ok(seen.length >= 1, 'o app precisa saber que foi redimensionado');
  assert.equal(seen.at(-1).w, window.innerWidth);
  void w;
});

// ------------------------------------------------------------- hud / toast --
section('HUD e notificações');

await test('HUD mostra métricas reais e marca indisponíveis como N/D', async () => {
  const root = fresh();
  let closed = false;
  const hud = createHUD({ host: root, onClose: () => { closed = true; } });
  assert.equal(hud.visible, false);
  hud.show();
  assert.equal(hud.visible, true);
  hud.update({
    fps: 58.6, frameP50: 16.4, frameP95: 17.1, heapMb: 41.2,
    diskMb: 12, diskQuotaMb: 512, kernelMs: 1.8, kernelTicks: 1234,
    simMs: 4.2, aiMs: 1.1, entities: 1024, ioMs: 0.4, ioMbps: 312.7,
    transport: 'RING/SAB', backend: 'WEBGL2', queue: 0
  });
  const text = document.querySelector('.hud').textContent;
  assert.match(text, /59/, 'FPS é exibido como inteiro (Design System §8)');
  assert.match(text, /16,4/);
  assert.match(text, /RING\/SAB/);
  assert.match(text, /1\.024|1,024|1024/, 'entidades formatadas com separador pt-BR');
  assert.match(text, /N\/D — não é exposta pelo navegador/);
  assert.match(text, /w-io/);
  hud.update({ fps: NaN, frameP50: NaN, frameP95: NaN, heapMb: NaN, diskMb: NaN, diskQuotaMb: NaN,
    kernelMs: NaN, simMs: NaN, ioMs: NaN, transport: 'MESSAGE', backend: 'INDISPONÍVEL', queue: NaN });
  assert.match(document.querySelector('.hud').textContent, /N\/D/, 'métrica ausente nunca vira número inventado');
  document.querySelector('.hud .close').click();
  assert.equal(closed, true);
  assert.equal(hud.diskLabel(null), 'N/D');
  assert.equal(hud.diskLabel({ usedMb: 12, quotaMb: 512 }), '12 MB / 512 MB');
  assert.equal(fmt1(NaN), 'N/D');
});

await test('toasts limitam a 3 visíveis e fecham pelo botão', async () => {
  const root = fresh();
  const container = document.createElement('div');
  root.append(container);
  const toasts = createToasts(container);
  toasts.ok('a', '1');
  toasts.warn('b', '2');
  toasts.err('c', '3');
  assert.equal(container.children.length, 3);
  toasts.push({ kind: 'info', title: 'd', text: '4' });
  assert.equal(toasts.count, 3, 'a quarta empurra a mais antiga para fora');
  await sleep(320);
  assert.equal(container.children.length, 3, 'o DOM converge para 3 após a animação de saída');
  const node = container.lastElementChild;
  node.querySelector('.x').click();
  await sleep(300);
  assert.ok(node.classList.contains('out') || !node.isConnected);
  assert.match(container.textContent, /c|c/);
});


// --------------------------------------- boot degradado (cenário do preview) --
section('modo local: startOS() sem Web Workers (contexto restrito de iframe)');

await test('o desktop monta inteiro mesmo sem worker, OPFS e canvas', async () => {
  // Este é o cenário que um preview embutido pode impor: origem opaca (sem
  // allow-same-origin), sem SharedArrayBuffer, sem OPFS e com worker bloqueado.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const restrito = new JSDOM(html, { url: 'http://127.0.0.1:3400/', pretendToBeVisual: true });
  const antes = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Worker: globalThis.Worker };
  globalThis.window = restrito.window;
  globalThis.document = restrito.window.document;
  globalThis.HTMLElement = restrito.window.HTMLElement;
  globalThis.Node = restrito.window.Node;
  delete globalThis.Worker;            // o contexto não oferece workers

  // O preview embutido não tem isolamento de origem → não existe SharedArrayBuffer.
  // Este delete é a regressão exata do erro "Falha ao iniciar o desktop": o boot
  // chamava `new SharedArrayBuffer` sem checar e derrubava tudo na primeira linha.
  const sabAntes = globalThis.SharedArrayBuffer;
  delete globalThis.SharedArrayBuffer;
  let os = null;
  try {
    const { startOS } = await import('../js/main.js');
    os = await startOS();

    assert.ok(document.querySelector('#windows'), 'a camada de janelas precisa existir');
    assert.ok(document.querySelector('#taskbar'), 'a barra de tarefas precisa existir');
    assert.ok(document.querySelectorAll('.dockitem').length >= 4, 'o dock precisa estar montado');
    assert.ok(document.querySelectorAll('#icons .dicon').length >= 4, 'os atalhos do desktop precisam estar montados');

    assert.equal(os.metrics.transport, 'NENHUM (modo local)', 'sem workers, o transporte é declarado como ausente');
    assert.equal(os.engine.snapshotMode, 'post', 'sem SharedArrayBuffer o snapshot precisa ser declarado como envio por mensagem');
    assert.equal(os.capabilities.isolated, false);
    assert.match(os.vfs.info.backend, /volátil/, 'o disco cai para memória volátil');
    assert.ok(Number.isNaN(os.vfs.info.quotaMb), 'sem cota do navegador → N/D');
    assert.ok(document.body.textContent.includes('Modo local'), 'a interface precisa avisar o usuário');

    // O VFS degradado precisa ser utilizável de verdade, não decorativo.
    await os.vfs.write('/home/nucleo/sobrevive.txt', 'escrito sem worker');
    assert.equal(new TextDecoder().decode(await os.vfs.read('/home/nucleo/sobrevive.txt')), 'escrito sem worker');
    const raiz = await os.vfs.list('/');
    assert.ok(raiz.some(r => r.name === 'home'));

    // Instalação por arrastar-e-soltar: o gesto que traz arquivos do computador
    // real para dentro do PC virtual, exercitado com `File` de verdade.
    const conteudo = new TextEncoder().encode('vindo do meu computador');
    const arquivo = new restrito.window.File([conteudo], 'documento.txt');
    const drop = new restrito.window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = { files: [arquivo], types: ['Files'], dropEffect: 'copy' };
    restrito.window.dispatchEvent(drop);
    await sleep(60);

    const instalado = new TextDecoder().decode(await os.vfs.read(`${os.installDir}/documento.txt`));
    assert.equal(instalado, 'vindo do meu computador', 'o arquivo solto precisa estar no disco virtual');
    assert.ok(document.body.textContent.includes('Instalado no disco virtual'), 'a interface precisa confirmar a instalação');

    // Soltar de novo o mesmo nome não pode sobrescrever: vira cópia "(1)".
    const drop2 = new restrito.window.Event('drop', { bubbles: true, cancelable: true });
    drop2.dataTransfer = { files: [arquivo], types: ['Files'], dropEffect: 'copy' };
    restrito.window.dispatchEvent(drop2);
    await sleep(60);
    const listados = (await os.vfs.list(os.installDir)).map(r => r.name).sort();
    assert.deepEqual(listados, ['documento (1).txt', 'documento.txt']);

    // E o overlay de instalação existe e é anunciado ao arrastar por cima.
    assert.ok(document.querySelector('#dropzone'), 'o destino do drop precisa existir no DOM');
    const drag = new restrito.window.Event('dragenter', { bubbles: true });
    drag.dataTransfer = { files: [arquivo], types: ['Files'] };
    restrito.window.dispatchEvent(drag);
    assert.ok(document.querySelector('#dropzone').classList.contains('on'), 'arrastar precisa revelar o destino');

    // O navegador do sistema abre pelo mesmo caminho dos outros apps: `os.browse`.
    // O `fetch` é substituído por uma página falsa — aqui se prova o encanamento
    // (janela, rota /api/fetch, renderização), não a internet.
    const fetchAntes = globalThis.fetch;
    globalThis.fetch = async url => ({
      status: 200, ok: true,
      json: async () => ({
        ok: true, url: 'https://exemplo.org/', status: 200, contentType: 'text/html', bytes: 64, ms: 3, htmlLike: true,
        text: '<html><title>Exemplo</title><body><h1>Funcionou</h1><p>Veja <a href="/dois">a segunda</a>.</p></body></html>'
      })
    });
    try {
      os.browse('https://exemplo.org/');
      await sleep(40);
      const janelaNav = document.querySelector('#windows');
      assert.ok(os.wm.has('navegador'), 'os.browse precisa abrir a janela do navegador');
      assert.match(janelaNav.textContent, /Funcionou/, 'a página precisa ser renderizada dentro da janela');
      assert.ok(janelaNav.querySelector('.blink'), 'os links precisam existir como elementos clicáveis');
      assert.match(janelaNav.querySelector('.bmeta').textContent, /200 · 64 B · 3 ms/, 'a barra de estado mostra o que foi medido');
    } finally { globalThis.fetch = fetchAntes; }

    // Abrir janela sem engine: precisa aparecer a declaração, não uma cena vazia mentirosa.
    const win = os.wm.open({ id: 'cidade', app: 'game', title: 'Cidade', w: 900, h: 560, create: () => ({ el: document.createElement('div') }) });
    assert.ok(win, 'o window manager precisa abrir uma janela mesmo sem subsistemas');
    await os.destroy();
  } finally {
    try { await os?.destroy(); } catch { /* já desmontado */ }
    restrito.window.close();
    Object.assign(globalThis, antes);
    if (!antes.Worker) delete globalThis.Worker;
    if (sabAntes) globalThis.SharedArrayBuffer = sabAntes;
  }
});


// ------------------------------------------------------------- navegador -----
section('navegador de texto (HTML → texto, links, histórico e download)');

await test('renderPage extrai título, texto e links; descarta script e style', () => {
  const html = `<html><head><title>Meu título</title>
    <script>var html = '<h1>não sou conteúdo</h1>';</script><style>h1{color:red}</style>
    <base href="https://base.example/x/"></head><body>
    <h1>Cabeçalho &amp; cia</h1>
    <p>Frase com <a href="rel.html">um link</a> no meio dela.</p>
    <ul><li>item simples</li></ul>
    <pre>    literal
    preservado</pre>
    <img src="foto.png" alt="uma foto">
    </body></html>`;
  const page = renderPage(html, { url: 'https://site.com/p/' });

  assert.equal(page.title, 'Meu título');
  const texto = pageToText(page);
  assert.match(texto, /Cabeçalho & cia/, 'entidades resolvidas');
  assert.match(texto, /Frase com um link no meio dela\./, 'a frase não pode ser fatiada');
  assert.ok(!texto.includes('não sou conteúdo'), 'conteúdo de <script> não é texto da página');
  assert.ok(!texto.includes('color:red'), 'CSS não é conteúdo');
  assert.match(texto, /literal/, '<pre> preservado');
  assert.match(texto, /\[imagem: uma foto\]/);

  // item que só tem o marcador não é conteúdo (HTML real chega assim: GitHub usa <li>•</li>)
  const comEnfeite = renderPage('<ul><li>•</li><li>isto é conteúdo</li></ul>', { url: 'https://s.com/' });
  const itens = comEnfeite.lines.filter(l => l.kind === 'li');
  assert.equal(itens.length, 1, `marcador solto virou linha: ${JSON.stringify(itens.map(l => l.text))}`);
  assert.match(itens[0].text, /• isto é conteúdo/);

  // <base href> manda nos links relativos — inclusive no <img>
  assert.ok(page.links.includes('https://base.example/x/rel.html'), page.links.join(' '));
  assert.ok(page.links.includes('https://base.example/x/foto.png'));

  // segmentos: só o trecho do link é clicável
  const linha = page.lines.find(l => l.text.includes('Frase com'));
  assert.equal(linha.segments.filter(s => s.href).length, 1);
  assert.equal(linha.segments.find(s => s.href).text, 'um link');
  assert.equal(linha.href, null, 'linha com mais de um segmento não é um link inteiro');

  // link sozinho na linha vira linha-link
  const soLink = renderPage('<a href="/x">clique</a>', { url: 'https://site.com/' });
  assert.equal(soLink.lines.at(-1).href, 'https://site.com/x');
  assert.equal(resolveUrl('a/b', 'https://s.com/d/e'), 'https://s.com/d/a/b');
  assert.equal(resolveUrl(null, 'https://s.com'), null);
});

await test('o navegador carrega, navega por link e mantém histórico', async () => {
  const antigoFetch = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async url => {
    pedidos.push(url);
    if (String(url).includes('erro')) {
      return { status: 200, ok: true, json: async () => ({ ok: false, error: 'host bloqueado: localhost' }) };
    }
    return {
      status: 200, ok: true,
      json: async () => ({
        ok: true, url: 'https://site.com/pagina', status: 200, contentType: 'text/html; charset=utf-8',
        bytes: 120, ms: 7, htmlLike: true,
        text: '<html><head><title>Início</title></head><body><h1>Bem-vindo</h1><p>Veja <a href="/dois">a segunda página</a>.</p></body></html>'
      })
    };
  };
  try {
    const root = fresh();
    const app = createBrowser({ toast: { ok() {}, err() {}, warn() {}, push() {} }, os: { installDir: '/home/nucleo/Downloads', installFiles: async () => ({ ok: [], failed: [] }) }, vfs: null });
    root.append(app.el);
    app.onMount();
    await sleep(30);

    // A página inicial é LOCAL: abrir o navegador não pode depender da rede (em rede
    // restrita a primeira impressão era uma tela de erro).
    assert.deepEqual(pedidos, [], 'a página inicial não faz requisição nenhuma');
    assert.match(app.el.querySelector('.bview').textContent, /modo texto/i, 'a página inicial declara o modo texto');
    assert.equal(app.el.querySelector('.addr').value, 'about:inicio');
    assert.match(app.el.querySelector('.bmeta').textContent, /0 requisições/);
    assert.equal(app.stats.cursor, 0);

    // Navegar de verdade: busca pelo proxy e renderiza o HTML recebido.
    app.openUrl('https://site.com/pagina');
    await sleep(30);
    assert.equal(pedidos.length, 1, 'abrir um endereço precisa consultar o proxy');
    assert.match(pedidos[0], /%2Fpagina|\/pagina/, 'a URL precisa ir codificada no parâmetro');
    assert.match(app.el.querySelector('.bview').textContent, /Bem-vindo/);
    assert.ok(app.el.querySelector('.blink'), 'o link precisa existir como elemento clicável');
    assert.equal(app.el.querySelector('.addr').value, 'https://site.com/pagina', 'o endereço reflete a URL final');
    assert.equal(app.stats.cursor, 1);
    assert.match(app.el.querySelector('.bmeta').textContent, /200 · 120 B · 7 ms/, 'a barra de estado mostra o que foi medido');

    // Clicar no link navega e empilha histórico; o link era relativo ("/dois").
    app.el.querySelector('.blink').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert.equal(app.stats.history, 3, 'cada navegação empilha uma entrada');
    assert.equal(app.stats.cursor, 2);
    assert.ok(pedidos.some(u => String(u).includes('%2Fdois') || String(u).includes('/dois')),
      `o link relativo precisa ser resolvido antes de buscar: ${JSON.stringify(pedidos)}`);

    // Voltar usa o histórico, sem criar entrada nova.
    const buscasAntes = pedidos.length;
    app.el.querySelector('.bar .btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert.equal(app.stats.cursor, 1, 'voltar move o cursor, não cria entrada');
    assert.equal(app.stats.history, 3);
    assert.ok(pedidos.length > buscasAntes, 'voltar recarrega a URL anterior');

    // Erro mostrado no lugar do conteúdo, com o motivo do servidor.
    app.openUrl('https://site.com/erro');
    await sleep(30);
    assert.match(app.el.querySelector('.bview').textContent, /host bloqueado: localhost/);
    assert.match(app.el.querySelector('.bview').textContent, /não foi possível abrir/);
  } finally {
    globalThis.fetch = antigoFetch;
  }
});

await test('o terminal tem `browse` e ele chega ao navegador (alias, help e erro explícito)', async () => {
  const root = fresh();
  const chamadas = [];
  const vfs = {
    cwd: '/home/nucleo',
    list: async () => [],
    read: async () => new Uint8Array(),
    write: async () => ({}),
    stat: async () => null,
    remove: async () => ({})
  };
  const term = createTerminal({ vfs, os: { browse: url => chamadas.push(url), installFiles: async () => ({ ok: [], failed: [] }) } });
  root.append(term.el);
  term.onMount();

  const digitar = async texto => {
    const campo = term.el.querySelector('input');
    campo.value = texto;
    campo.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(30);
  };

  await digitar('browse exemplo.org');
  assert.deepEqual(chamadas, ['exemplo.org'], 'o comando precisa repassar o endereço, sem inventar');
  const help = term.el.textContent;
  assert.match(help, /exemplo\.org/, 'o terminal precisa confirmar o que abriu');

  await digitar('help');
  // o help é renderizado como "nome  descrição" (com padding), não "nome: descrição"
  assert.match(term.el.textContent, /browse\s+abre uma página no navegador/, 'o help precisa listar o comando');

  await digitar('navegar site.com/teste');
  assert.deepEqual(chamadas.at(-1), 'site.com/teste', 'o alias `navegar` precisa funcionar igual');

  await digitar('browse');
  assert.match(term.el.textContent, /uso: browse <endereço>/, 'sem argumento, ensina o uso em vez de falhar mudo');

  // Regressão do bug que este teste encontrou: `run()` passava o array COM o nome do
  // comando, então `write recado.txt oi` gravava um arquivo chamado "write".
  const criados = [];
  const vfsEscrita = {
    cwd: '/home/nucleo',
    write: async (p, data) => { criados.push([p, String(data)]); return { path: p, bytes: String(data).length }; },
    list: async () => criados.map(([p, d]) => ({ name: p, type: 'file', size: d.length })),
    read: async p => new TextEncoder().encode(criados.find(([n]) => n === p)?.[1] ?? ''),
    stat: async () => ({ type: 'dir' }), remove: async () => ({})
  };
  const term2 = createTerminal({ vfs: vfsEscrita, os: { browse: () => {} } });
  root.append(term2.el);
  term2.onMount();
  const campo2 = term2.el.querySelector('input');
  const digitar2 = async texto => {
    campo2.value = texto;
    campo2.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(25);
  };
  await digitar2('write recado.txt ola mundo');
  assert.deepEqual(criados, [['recado.txt', 'ola mundo']],
    'o primeiro argumento é o arquivo; o nome do comando não pode virar nome de arquivo');
  await digitar2('cat recado.txt');
  assert.match(term2.el.textContent, /ola mundo/, 'cat precisa ler o arquivo que foi escrito');
});

await test('fileNameFrom deriva nome de arquivo útil para salvar no disco', () => {
  assert.equal(fileNameFrom('https://site.com/docs/relatorio.pdf', 'application/pdf'), 'relatorio.pdf');
  assert.equal(fileNameFrom('https://site.com/fotos/foto%20bonita.jpg', 'image/jpeg'), 'foto_bonita.jpg');
  assert.equal(fileNameFrom('https://site.com/pagina/', 'text/html'), 'pagina.html');
  assert.equal(fileNameFrom('https://site.com/dados', 'application/json'), 'dados.json');
  assert.equal(fileNameFrom('https://site.com/x', 'application/octet-stream'), 'x.bin');
  assert.equal(fileNameFrom('nao-e-url'), 'pagina.html');
});

// ---------------------------------------------------------------- relatório
console.log(results.join('\n'));
console.log(`\n${passed} passaram · ${failed} falharam${failed ? ' ✗' : ' ✓'}`);
process.exit(failed ? 1 : 0);
