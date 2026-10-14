/**
 * SECTOR OS — js/main.js
 * Orquestrador do desktop: workers, barramento, VMFS, WM, HUD e registro de apps.
 * Nada aqui desenha a interface dos apps — só cria o ambiente e mede o ambiente.
 */

import { $, el, fmt1, clamp, sleep } from './core/util.js';
import { createBus } from './core/bus.js';
import { OP, sharedBusAvailable } from './core/ipc.js';
import { connectWorker } from './core/link.js';
import { unpackStats, writeTick, emptyStats, textDecoder } from './core/wire.js';
import { createSnapshotBuffer, createReader, FIELDS } from './core/snapshot.js';
import { createVFS } from './core/vfs.js';
import { createWM } from './core/wm.js';
import { createHUD } from './ui/hud.js';
import { createToasts } from './ui/toast.js';
import { svgIcon } from './ui/icons.js';
import { createBoot, probeCapabilities } from './boot.js';
import { createTerminal } from './apps/terminal.js';
import { createFiles } from './apps/files.js';
import { createGame } from './apps/game.js';
import { createPS2 } from './apps/ps2.js';
import { createSettings } from './apps/settings.js';

const DEFAULTS = Object.freeze({
  backend: 'auto', renderScale: 0.8, fpsCap: 60, shadows: false, particles: false,
  profile: 'balanced', drs: true, entities: 1024, hud: false
});
const PROFILES = {
  baseline: { renderScale: 0.5, fpsCap: 30, shadows: false, particles: false, entities: 512, drs: true },
  balanced: { renderScale: 0.72, fpsCap: 60, shadows: true, particles: false, entities: 1024, drs: true },
  ultra: { renderScale: 1.0, fpsCap: 120, shadows: true, particles: false, entities: 2048, drs: false }
};
const MAX_ENTITIES = 4096;

export async function startOS() {
  const boot = createBoot(document.body);
  boot.line('iniciando SECTOR OS');
  const capabilities = await probeCapabilities({ boot });
  const bus = createBus();
  const toasts = createToasts($('#toasts'));
  const settings = loadSettings();

  boot.progress(0.55);
  boot.line(`criando workers (transporte ${sharedBusAvailable() ? 'RING/SAB' : 'MESSAGE'})`);

  // ------------------------------------------------------------- workers --
  const snapshotBuffer = createSnapshotBuffer(MAX_ENTITIES, FIELDS);
  const snapReader = createReader(snapshotBuffer);
  const scratch = new Float32Array(MAX_ENTITIES * FIELDS);

  const workers = {
    kernel: await spawn('w-kernel', './workers/kernel.worker.js', boot, toasts),
    engine: await spawn('w-engine', './workers/engine.worker.js', boot, toasts),
    io: await spawn('w-io', './workers/io.worker.js', boot, toasts)
  };

  for (const [key, entry] of Object.entries(workers)) {
    const stats = emptyStats();
    entry.stats = stats;
    entry.link.on(OP.STAT, (view, len) => unpackStats(view, len, stats));
    entry.link.on(OP.LOG, (view, len) => console.info(`[${key}]`, textDecoder.decode(view.subarray(0, len))));
  }

  // O snapshot do mundo vai por postMessage (é SAB, não cabe em JSON).
  workers.engine.worker.postMessage({ type: 'sector-config', snapshot: snapshotBuffer, entities: settings.entities });
  workers.kernel.link.send(OP.CFG, JSON.stringify({ load: 0.45 }));
  bus.on('toast', p => toasts.push(p));

  // Layout de estatística por worker (contrato espelhado em cada worker):
  //   w-kernel: 0=ms/tick 1=ticks 2=carga 3=workers
  //   w-engine: 0=simMs   1=aiMs  2=entidades 3=ticks 4=pior tick
  //   w-io:     0=ioMs    1=MB/s  2=ops      3=arquivos
  const ENGINE_ENTITIES = 2;
  const engine = {
    get entityCount() {
      const n = workers.engine.stats[ENGINE_ENTITIES];
      return Number.isFinite(n) ? n : settings.entities;
    },
    scratch,
    /** Lê o snapshot lock-free. Devolve -1 (e o leitor pula um quadro) se instável. */
    readEntities() { return snapReader.read(scratch); },
    setEntities(n) {
      settings.entities = clamp(n | 0, 0, MAX_ENTITIES);
      workers.engine.link.send(OP.CFG, JSON.stringify({ entities: settings.entities }));
      saveSettings(settings);
    }
  };

  // ---------------------------------------------------------------- VMFS --
  boot.progress(0.7);
  boot.line('montando VMFS (worker de I/O é o dono do disco)');
  const vfs = createVFS(workers.io.link, { log: text => console.info('[vfs]', text) });
  const storage = await vfs.init();
  capabilities.syncAccess = Boolean(storage.sync);
  boot.line(`disco virtual: ${storage.backend}${storage.sync ? ' · SyncAccessHandle' : ''}`,
    storage.backend.includes('OPFS') ? 'ok' : 'warn');

  // ------------------------------------------------------------ interface --
  boot.progress(0.85);
  const wm = createWM({ layer: $('#windows'), taskbar: $('#taskbar'), bus, statusH: 34 });
  const hud = createHUD({
    host: document.body,
    onClose: () => { hud.hide(); setSetting('hud', false); }
  });
  if (settings.hud) hud.show();

  const metrics = {
    fps: NaN, frameP50: NaN, frameP95: NaN, heapMb: NaN,
    diskMb: NaN, diskQuotaMb: NaN, kernelMs: NaN, kernelTicks: NaN,
    simMs: NaN, entities: NaN, ioMs: NaN, ioMbps: NaN,
    transport: sharedBusAvailable() ? 'RING/SAB' : 'MESSAGE',
    backend: capabilities.webgpu ? 'WEBGPU (probe)' : capabilities.webgl2 ? 'WEBGL2' : 'INDISPONÍVEL',
    queue: 0, gameScale: settings.renderScale, workers: [], heapNote: ''
  };

  const os = {
    capabilities, settings, metrics, engine, vfs, wm, bus, toasts, hud,
    storageSnapshot: { usedMb: NaN, quotaMb: NaN },
    apps: [],
    launch,
    setSetting,
    setProfile,
    openSettings,
    closeSettings,
    reportGame,
    diagnostics,
    reboot: () => location.reload(),
    restartWorkers
  };

  os.apps = [
    { id: 'terminal', title: 'Terminal', icon: 'terminal', w: 780, h: 440, create: () => createTerminal({ vfs, os }) },
    { id: 'arquivos', title: 'Arquivos', icon: 'files', w: 760, h: 460, create: () => createFiles({ vfs, toast: toasts }) },
    { id: 'cidade', title: 'Cidade — motor 3D', icon: 'game', w: 900, h: 560, create: makeGame },
    { id: 'ps2', title: 'Console PS2 (Play!)', icon: 'ps2', w: 860, h: 620, create: () => createPS2({ toast: toasts }) },
    { id: 'ajustes', title: 'Configurações', icon: 'settings', w: 720, h: 560, hidden: true }
  ];

  function makeGame() {
    const canvas = document.createElement('canvas');
    const app = createGame({
      canvas, engine, os, toast: toasts,
      settings: {
        get renderScale() { return settings.renderScale; },
        get shadows() { return settings.shadows; },
        get drs() { return settings.drs; },
        get fpsCap() { return settings.fpsCap; },
        get entities() { return settings.entities; }
      }
    });
    gameApp = app;
    return app;
  }
  let gameApp = null;
  function reportGame(m) {
    gameScale = m.scale;
    metrics.gameScale = m.scale;
    metrics.gameRenderMs = m.renderMs;
    metrics.gameInstances = m.instances;
    void gameApp;
  }
  let gameScale = settings.renderScale;

  function launch(id) {
    const app = os.apps.find(a => a.id === id);
    if (!app) { toasts.warn('App desconhecido', id); return; }
    if (id === 'ajustes') return openSettings();
    if (id === 'ajustes-hud') { hud.toggle(); return setSetting('hud', hud.visible); }
    wm.open({
      id, app: id, title: app.title, w: app.w, h: app.h, singleton: true,
      mount: body => {
        const inst = app.create();
        body.append(inst.el);
        inst.onMount?.();
        if (id === 'cidade') inst.onResize?.();
        return inst;
      }
    });
  }

  function setSetting(key, value) {
    settings[key] = value;
    saveSettings(settings);
    if (key === 'hud') (value ? hud.show() : hud.hide());
    if (key === 'entities') engine.setEntities(value);
    settingsPanel?.refresh();
    return value;
  }
  function setProfile(name) {
    const p = PROFILES[name];
    if (!p) return;
    Object.assign(settings, p, { profile: name });
    engine.setEntities(settings.entities);
    saveSettings(settings);
    toasts.ok(`Perfil ${name}`, `escala ${p.renderScale}× · ${p.fpsCap} fps · ${p.entities} entidades`);
    settingsPanel?.refresh();
  }

  let settingsPanel = null;
  function openSettings() {
    if (settingsPanel) return;
    const inst = createSettings({ os, vfs, toast: toasts, hud });
    settingsPanel = inst;
    const scrim = el('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closeSettings(); } }, inst.el);
    document.body.append(scrim);
    closeSettings.scrim = scrim;
  }
  function closeSettings() {
    closeSettings.scrim?.remove();
    closeSettings.scrim = null;
    settingsPanel = null;
  }

  buildShell({ os, wm, hud, toasts, launch: launch, bus });
  boot.progress(0.95);

  // ---------------------------------------------------------- loop e HUD --
  const frameHist = new Float32Array(120);
  const tickBuf = new Uint8Array(6);        // pré-alocado: zero alocação por quadro
  let frameIdx = 0, frameLen = 0, lastFrame = performance.now();
  let hudTick = 0, statTick = 0;

  function loop(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    frameHist[frameIdx] = dt;
    frameIdx = (frameIdx + 1) % frameHist.length;
    frameLen = Math.min(frameLen + 1, frameHist.length);

    // TICK para o motor (u16 ms; o worker aplica passo fixo com acumulador)
    writeTick(tickBuf, Math.min(65535, Math.round(dt)), 0);
    workers.engine.link.send(OP.TICK, tickBuf);

    // Drenagem dos barramentos (rápido: 2 Atomics.load por canal)
    for (const entry of Object.values(workers)) entry.link.drain();

    // Pedido de estatísticas: 2 Hz, nunca por quadro (Design System §6.7)
    statTick += dt;
    if (statTick > 500) {
      statTick = 0;
      for (const entry of Object.values(workers)) entry.link.send(OP.STAT_REQ, '{}');
      workers.io.link.request(OP.FS_OP, { op: 'usage' }, OP.FS_RES, 4000)
        .then(res => {
          if (!res.ok) return;
          os.storageSnapshot = { usedMb: res.data.usedBytes / 1048576, quotaMb: res.data.quotaBytes / 1048576 };
        })
        .catch(() => { /* cota pode falhar; o HUD mostra N/D */ });
    }

    hudTick += dt;
    if (hudTick > 500) { hudTick = 0; refreshMetrics(); }

    requestAnimationFrame(loop);
  }

  function percentile(p) {
    if (!frameLen) return NaN;
    const arr = Array.prototype.slice.call(frameHist, 0, frameLen).sort((a, b) => a - b);
    return arr[clamp(Math.floor((p / 100) * (arr.length - 1)), 0, arr.length - 1)];
  }

  function refreshMetrics() {
    const p50 = percentile(50), p95 = percentile(95);
    metrics.frameP50 = p50;
    metrics.frameP95 = p95;
    metrics.fps = p50 > 0 ? 1000 / p50 : NaN;
    metrics.heapMb = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN;
    metrics.heapNote = performance.memory ? '' : 'Heap JS: N/D neste navegador.';
    metrics.kernelMs = workers.kernel.stats[0];
    metrics.kernelTicks = workers.kernel.stats[1];
    metrics.simMs = workers.engine.stats[0];
    metrics.aiMs = workers.engine.stats[1];
    metrics.entities = workers.engine.stats[ENGINE_ENTITIES];
    metrics.ioMs = workers.io.stats[0];
    metrics.ioMbps = workers.io.stats[1];
    metrics.transport = Object.values(workers).every(w => w.link.transport === 'ring') ? 'RING/SAB' : 'MESSAGE';
    metrics.queue = Object.values(workers).reduce((a, w) => a + w.link.stats().queues, 0);
    metrics.diskMb = os.storageSnapshot.usedMb;
    metrics.diskQuotaMb = os.storageSnapshot.quotaMb;
    metrics.workers = [
      { pid: 1, name: 'w-io', alive: true, ms: metrics.ioMs, note: `${fmt1(metrics.ioMbps)} MB/s` },
      { pid: 2, name: 'w-engine', alive: true, ms: metrics.simMs, note: `${metrics.entities || 0} entidades` },
      { pid: 3, name: 'w-kernel', alive: true, ms: metrics.kernelMs, note: 'carga SIM' }
    ];
    metrics.kernelHeap = NaN;
    metrics.engineHeap = NaN;
    metrics.ioHeap = NaN;
    if (hud.visible) hud.update(metrics);
    bus.emit('metrics', metrics);
  }

  // Atalhos globais: F1 HUD, Ctrl+K paleta, Esc fecha camada superior.
  window.addEventListener('keydown', event => {
    if (event.key === 'F1') { event.preventDefault(); setSetting('hud', !hud.visible); }
    else if (event.key === 'Escape') {
      if (settingsPanel) closeSettings();
      else if ($('#palette')) $('#palette').remove();
      else if (hud.visible) setSetting('hud', false);
    } else if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openPalette();
    }
  });

  function openPalette() {
    $('#palette')?.remove();
    const input = el('input', { type: 'text', placeholder: 'buscar app, ação ou comando…', 'aria-label': 'Paleta de comandos' });
    const list = el('div', { class: 'plist' });
    const box = el('div', { class: 'palette glass' }, input, list);
    const scrim = el('div', { class: 'scrim', id: 'palette', onclick: e => { if (e.target === scrim) scrim.remove(); } }, box);
    const actions = [
      ...os.apps.filter(a => !a.hidden).map(a => ({ label: `Abrir ${a.title}`, icon: a.icon, run: () => launch(a.id) })),
      { label: 'Alternar HUD de telemetria', icon: 'hud', run: () => setSetting('hud', !hud.visible) },
      { label: 'Configurações do sistema', icon: 'settings', run: openSettings },
      { label: 'Benchmark do disco virtual', icon: 'storage', run: async () => { const r = await vfs.bench(); toasts.ok('I/O do VMFS', `escrita ${fmt1(r.writeMbps)} MB/s · leitura ${fmt1(r.readMbps)} MB/s`); } },
      { label: 'Copiar diagnóstico', icon: 'chip', run: async () => { await navigator.clipboard?.writeText(diagnostics()); toasts.ok('Diagnóstico', 'copiado'); } },
      { label: 'Reiniciar subsistemas (workers)', icon: 'reboot', run: restartWorkers }
    ];
    let filtered = actions, cursor = 0;

    function draw() {
      list.replaceChildren(...filtered.slice(0, 8).map((a, i) => el('div', {
        class: `pitem${i === cursor ? ' on' : ''}`,
        onclick: () => { scrim.remove(); a.run(); }
      }, svgIcon(a.icon, 15), el('span', { text: a.label }), el('span', { class: 'hint', text: i === cursor ? 'enter' : '' }))));
    }
    function filter(q) {
      const t = q.trim().toLowerCase();
      filtered = t ? actions.filter(a => a.label.toLowerCase().includes(t)) : actions;
      cursor = 0;
      draw();
    }
    input.addEventListener('input', () => filter(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, Math.min(filtered.length, 8) - 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { cursor = Math.max(0, cursor - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { const a = filtered[cursor]; if (a) { scrim.remove(); a.run(); } }
    });
    document.body.append(scrim);
    filter('');
    input.focus();
  }

  function diagnostics() {
    const m = metrics;
    return [
      'SECTOR OS 0.4.0 — diagnóstico',
      `data: ${new Date().toISOString()}`,
      `origem isolada: ${capabilities.isolated} · SAB: ${capabilities.sab} · transporte: ${m.transport}`,
      `backend: ${m.backend} · WebGL2: ${capabilities.webgl2} · WebGPU: ${capabilities.webgpu}`,
      `CPU lógicas: ${capabilities.cores} · DPR: ${window.devicePixelRatio}`,
      `frame p50/p95: ${fmt1(m.frameP50)} / ${fmt1(m.frameP95)} ms · fps: ${fmt1(m.fps)}`,
      `w-engine: ${fmt1(m.simMs)} ms sim / ${fmt1(m.aiMs)} ms IA · ${m.entities ?? 'N/D'} entidades`,
      `w-kernel: ${fmt1(m.kernelMs)} ms/tick · ${m.kernelTicks ?? 'N/D'} ticks`,
      `w-io: ${fmt1(m.ioMs)} ms · ${fmt1(m.ioMbps)} MB/s · backend ${vfs.info.backend}`,
      `VMFS: ${fmt1(os.storageSnapshot.usedMb)} MB de ${fmt1(os.storageSnapshot.quotaMb)} MB`,
      `janelas: ${wm.count}`
    ].join('\n');
  }

  async function restartWorkers() {
    for (const [key, entry] of Object.entries(workers)) {
      entry.worker.postMessage({ type: 'sector-shutdown' });
      entry.link.dispose();
      await sleep(60);
      const fresh = await spawn(key === 'kernel' ? 'w-kernel' : key === 'engine' ? 'w-engine' : 'w-io', `./workers/${key}.worker.js`, boot, toasts);
      const stats = emptyStats();
      fresh.stats = stats;
      fresh.link.on(OP.STAT, (view, len) => unpackStats(view, len, stats));
      workers[key] = fresh;
    }
    workers.engine.worker.postMessage({ type: 'sector-config', snapshot: snapshotBuffer, entities: settings.entities });
    workers.kernel.link.send(OP.CFG, JSON.stringify({ load: 0.45 }));
    await vfs.init();
    bus.emit('workers:restarted');
  }

  await boot.finish();
  requestAnimationFrame(loop);
  refreshMetrics();
  console.info('[os] pronto', { capabilities, settings });
  return os;
}

// ---------------------------------------------------------------- helpers --
async function spawn(name, url, boot, toasts) {
  const worker = new Worker(url, { type: 'module', name });
  const link = await connectWorker(worker, name);
  worker.addEventListener('error', e => {
    console.error(`[${name}]`, e);
    toasts?.err(`Falha em ${name}`, String(e.message || 'erro no worker'));
  });
  worker.addEventListener('message', event => {
    if (event.data?.type === 'sector-log') boot?.line(`[${name}] ${event.data.text}`);
  });
  return { worker, link, name };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('sector-os:settings');
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* primeira execução ou storage bloqueado */ }
  return { ...DEFAULTS };
}
function saveSettings(settings) {
  try { localStorage.setItem('sector-os:settings', JSON.stringify(settings)); } catch { /* modo privado */ }
}

/** Monta barra de status, ícones do desktop e dock. */
function buildShell({ os, wm, hud, launch, bus }) {
  const clock = $('#clock');
  const tick = () => { clock.textContent = new Date().toLocaleTimeString('pt-BR', { hour12: false }); };
  tick();
  setInterval(tick, 1000);

  const transport = $('#tok-transport');
  const gpu = $('#tok-gpu');
  const led = $('#led');
  const applyCaps = () => {
    transport.textContent = os.metrics.transport;
    transport.className = `token${os.metrics.transport === 'RING/SAB' ? ' ok' : ' warn'}`;
    gpu.textContent = os.metrics.backend;
    gpu.className = `token${os.metrics.backend.startsWith('WEBGL2') || os.metrics.backend.startsWith('WEBGPU') ? ' ok' : ' crit'}`;
    led.className = `dot ${os.capabilities.isolated && os.capabilities.opfs ? 'on' : 'warn'}`;
    led.title = `isolamento: ${os.capabilities.isolated} · OPFS: ${os.capabilities.opfs} · SAB: ${os.capabilities.sab}`;
  };
  applyCaps();
  bus.on('metrics', applyCaps);

  const ICONS = {
    terminal: 'terminal', arquivos: 'files', cidade: 'game', ps2: 'ps2',
    ajustes: 'settings', hud: 'hud'
  };
  const desktop = $('#icons');
  for (const [id, label] of Object.entries({ terminal: 'Terminal', arquivos: 'Arquivos', cidade: 'Cidade 3D', ps2: 'Console PS2', ajustes: 'Configurações', hud: 'Telemetria' })) {
    desktop.append(el('button', {
      class: 'dicon', 'data-app': id,
      ondblclick: () => id === 'hud' ? hud.toggle() : launch(id),
      onclick: e => { [...desktop.children].forEach(c => c.classList.remove('sel')); e.currentTarget.classList.add('sel'); },
      onkeydown: e => { if (e.key === 'Enter') id === 'hud' ? hud.toggle() : launch(id); }
    }, svgIcon(ICONS[id], 26), el('span', { text: label })));
  }

  const dock = $('#dock');
  for (const [id, label] of Object.entries({ terminal: 'Terminal', arquivos: 'Arquivos', cidade: 'Cidade 3D', ps2: 'Console PS2', hud: 'Telemetria', ajustes: 'Configurações' })) {
    const item = el('button', {
      class: 'dockitem', 'data-app': id, 'aria-label': label,
      onclick: () => id === 'hud' ? hud.toggle() : launch(id)
    }, svgIcon(ICONS[id], 22), el('span', { class: 'title', text: label }));
    dock.append(item);
    bus.on('wm:focus', ({ app }) => item.classList.toggle('running', app === id || wm.has(id)));
    bus.on('wm:close', () => item.classList.toggle('running', wm.has(id)));
  }
  bus.on('wm:focus', () => { for (const item of dock.children) item.classList.toggle('running', wm.has(item.dataset.app)); });

  // Cenário em repouso: sem interação por 30 s, a grade para de animar
  // (economia de GPU). Qualquer gesto rearma — Design System §2.2.
  const voidEl = $('#void');
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    voidEl.classList.remove('paused');
    idleTimer = setTimeout(() => voidEl.classList.add('paused'), 30000);
  };
  for (const type of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(type, armIdle, { passive: true });
  armIdle();

  // Vazio do desktop: clique único fecha a seleção.
  $('#desktop').addEventListener('pointerdown', () => {
    for (const child of desktop.children) child.classList.remove('sel');
  });
}
