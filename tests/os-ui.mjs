/**
 * SECTOR OS — tests/os-ui.mjs
 * Testes da camada de interface com DOM real (jsdom), sem navegador:
 * boot, sondagens de capacidade, window manager, HUD e toasts.
 *
 * O que este arquivo NÃO cobre (e por isso existe tests/os.mjs com Playwright):
 * workers com SharedArrayBuffer, OPFS, WebGL2 e eventos de ponteiro.
 *
 * Execute: npm run test:os-ui
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

// --- ambiente DOM ----------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:3000/os'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;

const { createBoot, probeCapabilities } = await import('../os/js/boot.js');
const { createWM } = await import('../os/js/core/wm.js');
const { createToasts } = await import('../os/js/ui/toast.js');
const { createHUD } = await import('../os/js/ui/hud.js');
const { createBus } = await import('../os/js/core/bus.js');
const { fmt1 } = await import('../os/js/core/util.js');

const fresh = () => { document.body.replaceChildren(); return document.body; };

// ------------------------------------------------------------------- boot --
section('boot (tela de inicialização e sondagens)');

await test('createBoot monta o overlay e escreve linhas', async () => {
  const root = fresh();
  const boot = createBoot(root);
  assert.ok(document.querySelector('.boot'), 'overlay de boot precisa existir');
  assert.ok(document.querySelector('.boot .logo').textContent.includes('SECTOR'));
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

// ---------------------------------------------------------------- relatório
console.log(results.join('\n'));
console.log(`\n${passed} passaram · ${failed} falharam${failed ? ' ✗' : ' ✓'}`);
process.exit(failed ? 1 : 0);
