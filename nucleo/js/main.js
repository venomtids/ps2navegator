/**
 * NÚCLEO OS — js/main.js
 * Orquestrador do desktop: workers, barramento, VMFS, WM, HUD e registro de apps.
 * Nada aqui desenha a interface dos apps — só cria o ambiente e mede o ambiente.
 */

import { $, el, fmt1, fmtBytes, clamp, sleep } from './core/util.js';
import { createBus } from './core/bus.js';
import { OP, sharedBusAvailable } from './core/ipc.js';
import { connectWorker } from './core/link.js';
import { unpackStats, writeTick, emptyStats, textDecoder } from './core/wire.js';
import { createSnapshotBuffer, createReader, snapshotStrategy, applyPackedSnapshot, FIELDS } from './core/snapshot.js';
import { createVFS } from './core/vfs.js';
import { createLocalVFS } from './core/vfs-local.js';
import { installFiles as installIntoDisk, describeInstall, INSTALL_DIR } from './core/import.js';
import { createWM } from './core/wm.js';
import { createHUD } from './ui/hud.js';
import { createToasts } from './ui/toast.js';
import { svgIcon } from './ui/icons.js';
import { createBoot, probeCapabilities } from './boot.js';
import { createTerminal } from './apps/terminal.js';
import { createFiles } from './apps/files.js';
import { createBrowser } from './apps/browser.js';
import { createGame } from './apps/game.js';
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
  boot.line('iniciando NÚCLEO OS');
  const capabilities = await probeCapabilities({ boot });
  const bus = createBus();
  const toasts = createToasts($('#toasts'));
  const settings = loadSettings();

  boot.progress(0.55);
  boot.line(`criando workers (transporte ${sharedBusAvailable() ? 'RING/SAB' : 'MESSAGE'})`);

  // ------------------------------------------------------------- workers --
  // Sem SharedArrayBuffer (página não isolada) este buffer é um ArrayBuffer
  // comum: o estado do mundo passa a viajar por postMessage, com buffers
  // ping-pong. O boot não depende de memória compartilhada existir.
  const snapshotBuffer = createSnapshotBuffer(MAX_ENTITIES, FIELDS);
  const snapReader = createReader(snapshotBuffer);
  const scratch = new Float32Array(MAX_ENTITIES * FIELDS);
  const snapStrategy = snapshotStrategy(snapshotBuffer);
  let packedCount = -1;          // último estado recebido por mensagem

  // Cada worker é opcional por projeto: um contexto restrito (iframe com origem
  // opaca, política que bloqueia workers) não pode impedir o desktop de abrir.
  // O que não existe é declarado como inexistente — na interface, não no console.
  // Em paralelo: três handshakes simultâneos em vez de três em série.
  const [kernel, engineWorker, io] = await Promise.all([
    spawn('w-kernel', './workers/kernel.worker.js', boot, toasts),
    spawn('w-engine', './workers/engine.worker.js', boot, toasts),
    spawn('w-io', './workers/io.worker.js', boot, toasts)
  ]);
  const workers = { kernel, engine: engineWorker, io };
  const live = Object.entries(workers).filter(([, entry]) => entry);

  for (const [key, entry] of live) {
    const stats = emptyStats();
    entry.stats = stats;
    entry.link.on(OP.STAT, (view, len) => unpackStats(view, len, stats));
    entry.link.on(OP.LOG, (view, len) => console.info(`[${key}]`, textDecoder.decode(view.subarray(0, len))));
  }

  if (!live.length) {
    boot.line('nenhum worker pôde ser criado: modo local (sem kernel, motor e disco virtual)', 'err');
  }

  /** Entrega a configuração do snapshot ao w-engine no modo que o contexto permite. */
  function configureEngine() {
    if (!workers.engine) return;
    const msg = { type: 'nucleo-config', entities: settings.entities };
    if (snapStrategy === 'shared') msg.snapshot = snapshotBuffer;
    else msg.snapshotMode = 'post';
    workers.engine.worker.postMessage(msg);
  }
  configureEngine();
  workers.kernel?.link.send(OP.CFG, JSON.stringify({ load: 0.45 }));
  bus.on('toast', p => toasts.push(p));

  // Snapshot sem memória compartilhada: recebe, copia para o scratch pré-alocado
  // e devolve o buffer ao worker (ping-pong: zero alocação nos dois lados).
  workers.engine?.worker.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== 'nucleo-snapshot') return;
    packedCount = applyPackedSnapshot(scratch, data.data, data.count);
    workers.engine.worker.postMessage({ type: 'nucleo-snapshot-back', data: data.data }, [data.data.buffer]);
  });

  // Layout de estatística por worker (contrato espelhado em cada worker):
  //   w-kernel: 0=ms/tick 1=ticks 2=carga 3=workers
  //   w-engine: 0=simMs   1=aiMs  2=entidades 3=ticks 4=pior tick
  //   w-io:     0=ioMs    1=MB/s  2=ops      3=arquivos
  const ENGINE_ENTITIES = 2;
  const engine = {
    scratch,
    /** false quando o motor não pôde subir: a UI mostra o motivo, não uma cena vazia mentirosa. */
    available: Boolean(workers.engine),
    unavailableReason: workers.engine ? '' : 'worker do motor indisponível neste contexto',
    /** Entidades simulado pelo w-engine; sem motor, zero é a verdade (não um número inventado). */
    get entityCount() {
      const n = workers.engine?.stats[ENGINE_ENTITIES];
      return Number.isFinite(n) ? n : (workers.engine ? settings.entities : 0);
    },
    /** 'shared' (seqlock em SAB) ou 'post' (ping-pong por mensagem) — declarado no HUD. */
    get snapshotMode() { return snapStrategy; },
    /** Lê o snapshot lock-free. Devolve -1 (e o leitor pula um quadro) se instável. */
    readEntities() {
      if (!workers.engine) return -1;
      if (snapStrategy === 'shared') return snapReader.read(scratch);
      if (packedCount < 0) return -1;             // ainda não chegou o primeiro estado
      return packedCount;                          // scratch já preenchida na chegada
    },
    setEntities(n) {
      settings.entities = clamp(n | 0, 0, MAX_ENTITIES);
      workers.engine?.link.send(OP.CFG, JSON.stringify({ entities: settings.entities }));
      saveSettings(settings);
    }
  };

  // ---------------------------------------------------------------- VMFS --
  boot.progress(0.7);
  boot.line(workers.io ? 'montando VMFS (worker de I/O é o dono do disco)'
    : 'sem worker de I/O: montando VMFS volátil em memória (modo local)',
    workers.io ? undefined : 'warn');
  const vfs = workers.io
    ? createVFS(workers.io.link, { log: text => console.info('[vfs]', text) })
    : createLocalVFS({ log: text => console.info('[vfs]', text) });
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
    installFiles,
    installDir: INSTALL_DIR,
    browse: url => browse(url),
    destroy,
    restartWorkers
  };

  os.apps = [
    { id: 'terminal', title: 'Terminal', icon: 'terminal', w: 780, h: 440, create: () => createTerminal({ vfs, os }) },
    { id: 'navegador', title: 'Navegador', icon: 'globe', w: 820, h: 580,
      create: () => createBrowser({ toast: toasts, os, vfs }) },
    { id: 'arquivos', title: 'Arquivos', icon: 'files', w: 760, h: 460,
      create: () => createFiles({ vfs, toast: toasts, onDropFiles: (dir, files) => installFiles(dir, files) }) },
    { id: 'cidade', title: 'Cidade — motor 3D', icon: 'game', w: 900, h: 560, create: makeGame },
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

  // --------------------------------------------------------------- navegador --
  /** Abre (ou reusa) a janela do navegador já apontada para uma URL. */
  function browse(url = null) {
    launch('navegador');                       // singleton: reusa a janela aberta
    const app = wm.instance('navegador');
    if (url && app?.openUrl) app.openUrl(url);
    return app;
  }

  // ------------------------------------------------------------ instalação --
  /**
   * Copia arquivos do computador real para o disco virtual. É o único caminho de
   * entrada de dados no sistema — sem rede, sem upload, sem telemetria.
   *
   * `files` nulo abre o seletor do navegador; um `FileList` (drop) segue direto.
   */
  async function installFiles(dir = INSTALL_DIR, files = null) {
    if (!files) return pickFiles(dir);
    const items = Array.from(files);
    if (!items.length) return null;

    const total = items.reduce((a, f) => a + (f.size || 0), 0);
    toasts.push({ kind: 'info', ms: 2500, title: 'Instalando', text: `${items.length} arquivo(s) · ${fmtBytes(total)} → ${String(dir).replace('/home/nucleo', '~')}` });

    const res = await installIntoDisk(vfs, items, {
      dir,
      quotaMb: os.storageSnapshot?.quotaMb,
      usedMb: os.storageSnapshot?.usedMb
    });

    if (res.ok.length) {
      toasts.ok('Instalado no disco virtual', describeInstall(res));
      bus.emit('vfs:changed', { dir: res.dir });
      // O painel de arquivos, se aberto, precisa mostrar o que acabou de entrar.
      settingsPanel?.refresh?.();
    }
    for (const f of res.failed) toasts.err(`Falhou: ${f.name}`, f.error);
    console.info('[install]', res);
    return res;
  }

  function pickFiles(dir) {
    const input = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const chosen = input.files;
      input.remove();
      installFiles(dir, chosen);
    });
    document.body.append(input);
    input.click();
  }

  // Soltar arquivos em qualquer lugar do desktop instala em ~/Downloads.
  // O gesto é o mesmo de qualquer SO — e o destino é dito antes de soltar.
  const dropzone = el('div', { class: 'dropzone', id: 'dropzone', 'aria-hidden': 'true' },
    el('div', { class: 'dz-icon' }, svgIcon('files', 26)),
    el('div', { class: 'dz-title', text: 'Solte para instalar no PC virtual' }),
    el('div', { class: 'dz-path', text: String(INSTALL_DIR).replace('/home/nucleo', 'home/nucleo/') })
  );
  document.body.append(dropzone);

  const hasFiles = e => Boolean(e.dataTransfer?.files?.length) || (e.dataTransfer?.types || []).includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; dropzone.classList.add('on'); });
  window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropzone.classList.remove('on'); } });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('on');
    installFiles(INSTALL_DIR, e.dataTransfer.files);
  });

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

  let running = true;

  function loop(now) {
    if (!running) return;
    const dt = now - lastFrame;
    lastFrame = now;
    frameHist[frameIdx] = dt;
    frameIdx = (frameIdx + 1) % frameHist.length;
    frameLen = Math.min(frameLen + 1, frameHist.length);

    // TICK para o motor (u16 ms; o worker aplica passo fixo com acumulador)
    writeTick(tickBuf, Math.min(65535, Math.round(dt)), 0);
    workers.engine?.link.send(OP.TICK, tickBuf);

    // Drenagem dos barramentos (rápido: 2 Atomics.load por canal)
    for (const entry of live) entry.link.drain();

    // Pedido de estatísticas: 2 Hz, nunca por quadro (Design System §6.7)
    statTick += dt;
    if (statTick > 500) {
      statTick = 0;
      for (const entry of live) entry.link.send(OP.STAT_REQ, '{}');
      const usage = workers.io
        ? workers.io.link.request(OP.FS_OP, { op: 'usage' }, OP.FS_RES, 4000)
        : vfs.usage().then(data => ({ ok: true, data }));
      usage
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
    metrics.kernelMs = workers.kernel ? workers.kernel.stats[0] : NaN;
    metrics.kernelTicks = workers.kernel ? workers.kernel.stats[1] : NaN;
    metrics.simMs = workers.engine ? workers.engine.stats[0] : NaN;
    metrics.aiMs = workers.engine ? workers.engine.stats[1] : NaN;
    metrics.entities = workers.engine ? workers.engine.stats[ENGINE_ENTITIES] : NaN;
    metrics.ioMs = workers.io ? workers.io.stats[0] : NaN;
    metrics.ioMbps = workers.io ? workers.io.stats[1] : NaN;
    metrics.transport = !live.length ? 'NENHUM (modo local)'
      : live.every(([, w]) => w.link.transport === 'ring') ? 'RING/SAB' : 'MESSAGE';
    metrics.queue = live.reduce((a, [, w]) => a + w.link.stats().queues, 0);
    metrics.diskMb = os.storageSnapshot.usedMb;
    metrics.diskQuotaMb = os.storageSnapshot.quotaMb;
    metrics.workers = [
      { pid: 1, name: 'w-io', alive: Boolean(workers.io), ms: metrics.ioMs,
        note: workers.io ? `${fmt1(metrics.ioMbps)} MB/s` : 'ausente (modo local)' },
      { pid: 2, name: 'w-engine', alive: Boolean(workers.engine), ms: metrics.simMs,
        note: workers.engine ? `${Number.isFinite(metrics.entities) ? metrics.entities : 'N/D'} entidades` : 'ausente (modo local)' },
      { pid: 3, name: 'w-kernel', alive: Boolean(workers.kernel), ms: metrics.kernelMs,
        note: workers.kernel ? 'carga SIM' : 'ausente (modo local)' }
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
      { label: 'Instalar arquivos no PC virtual (vai para ~/Downloads)', icon: 'files', run: () => installFiles(INSTALL_DIR) },
      { label: 'Abrir o navegador do sistema (modo texto)', icon: 'globe', run: () => browse() },
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
      'NÚCLEO OS 0.4.0 — diagnóstico',
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

  /**
   * Desliga o sistema: para o laço de quadro, encerra os workers e libera o disco.
   * Existe porque um desktop que não pode ser desmontado não pode ser testado —
   * e porque "desligar o computador" é parte do produto, não só do teste.
   */
  async function destroy() {
    running = false;
    for (const [key, entry] of Object.entries(workers)) {
      if (!entry) continue;
      try { entry.link.dispose(); } catch { /* já fechado */ }
      try { entry.worker.postMessage({ type: 'nucleo-shutdown' }); } catch { /* morto */ }
      try { await entry.worker.terminate?.(); } catch { /* morte dura */ }
      workers[key] = null;
    }
    try { await vfs.dispose?.(); } catch { /* VFS local não tem nada a liberar */ }
    closeSettings();
    bus.emit('os:destroyed');
  }

  async function restartWorkers() {
    const labels = { kernel: 'w-kernel', engine: 'w-engine', io: 'w-io' };
    let recovered = 0;
    for (const [key, label] of Object.entries(labels)) {
      const entry = workers[key];
      entry?.worker.postMessage({ type: 'nucleo-shutdown' });
      entry?.link.dispose();
      await sleep(60);
      const fresh = await spawn(label, `./workers/${key}.worker.js`, boot, toasts);
      if (!fresh) { workers[key] = null; continue; }
      const stats = emptyStats();
      fresh.stats = stats;
      fresh.link.on(OP.STAT, (view, len) => unpackStats(view, len, stats));
      fresh.link.on(OP.LOG, (view, len) => console.info(`[${key}]`, textDecoder.decode(view.subarray(0, len))));
      workers[key] = fresh;
      recovered++;
    }
    configureEngine();
    workers.kernel?.link.send(OP.CFG, JSON.stringify({ load: 0.45 }));
    if (recovered) await vfs.init();
    bus.emit('workers:restarted');
    return recovered;
  }

  await boot.finish();
  if (!live.length) {
    toasts.push({
      kind: 'warn', ms: 14000,
      title: 'Modo local',
      text: 'Este contexto não permitiu criar Web Workers: kernel, motor e disco virtual ficaram de fora. O desktop funciona; a telemetria mostra N/D onde não há medição.'
    });
  } else if (!capabilities.isolated) {
    toasts.push({
      kind: 'info', ms: 11000,
      title: 'Sem isolamento de origem',
      text: 'Sem COOP/COEP não há SharedArrayBuffer: o barramento entre threads usa MESSAGE (mais lento). Abra direto no navegador, em aba própria, para ativar o anel RING/SAB.'
    });
  }
  requestAnimationFrame(loop);
  refreshMetrics();
  console.info('[os] pronto', { capabilities, settings });
  return os;
}

// ---------------------------------------------------------------- helpers --
/**
 * Cria um worker e devolve o link — ou `null` se o contexto proibir workers
 * (origem opaca em iframe sandbox, CSP restritiva, navegador sem módulos em
 * worker). Nunca lança: o desktop precisa abrir mesmo sem subsistemas.
 */
async function spawn(name, url, boot, toasts) {
  let worker = null;
  try {
    worker = new Worker(url, { type: 'module', name });
    const link = await connectWorker(worker, name);
    worker.addEventListener('error', e => {
      console.error(`[${name}]`, e);
      toasts?.err(`Falha em ${name}`, String(e.message || 'erro no worker'));
    });
    worker.addEventListener('message', event => {
      if (event.data?.type === 'nucleo-log') boot?.line(`[${name}] ${event.data.text}`);
    });
    return { worker, link, name };
  } catch (e) {
    const reason = String(e?.message || e);
    boot?.line(`${name}: indisponível (${reason})`, 'err');
    console.warn(`[${name}] worker indisponível:`, reason);
    try { worker?.terminate(); } catch { /* já morto */ }
    return null;
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('nucleo-os:settings');
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* primeira execução ou storage bloqueado */ }
  return { ...DEFAULTS };
}
function saveSettings(settings) {
  try { localStorage.setItem('nucleo-os:settings', JSON.stringify(settings)); } catch { /* modo privado */ }
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
    terminal: 'terminal', navegador: 'globe', arquivos: 'files', cidade: 'game',
    ajustes: 'settings', hud: 'hud'
  };
  const desktop = $('#icons');
  for (const [id, label] of Object.entries({ terminal: 'Terminal', navegador: 'Navegador', arquivos: 'Arquivos', cidade: 'Cidade 3D', ajustes: 'Configurações', hud: 'Telemetria' })) {
    desktop.append(el('button', {
      class: 'dicon', 'data-app': id,
      ondblclick: () => id === 'hud' ? hud.toggle() : launch(id),
      onclick: e => { [...desktop.children].forEach(c => c.classList.remove('sel')); e.currentTarget.classList.add('sel'); },
      onkeydown: e => { if (e.key === 'Enter') id === 'hud' ? hud.toggle() : launch(id); }
    }, svgIcon(ICONS[id], 26), el('span', { text: label })));
  }

  const dock = $('#dock');
  for (const [id, label] of Object.entries({ terminal: 'Terminal', arquivos: 'Arquivos', cidade: 'Cidade 3D', hud: 'Telemetria', ajustes: 'Configurações' })) {
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
