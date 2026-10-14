/**
 * NÚCLEO OS — apps/settings.js
 * Painel de controle (§6.8). Cada controle altera algo imediatamente, no jogo,
 * nos workers ou no armazenamento. O que depende de fase futura aparece
 * desabilitado com o motivo visível no próprio campo.
 */

import { el, fmt1, fmtBytes, clamp } from '../core/util.js';

export function createSettings({ os, vfs, toast, hud }) {
  const body = el('div', { class: 'body' });
  const tabs = el('div', { class: 'tabs' });
  const TABS = {
    graficos: { label: 'Gráficos', build: buildGraphics },
    desempenho: { label: 'Desempenho', build: buildPerf },
    armazenamento: { label: 'Armazenamento', build: buildStorage },
    sistema: { label: 'Sistema', build: buildSystem }
  };

  function seg(options, current, onPick, disabled = null) {
    return el('div', { class: 'seg', title: disabled || '' },
      ...options.map(o => el('button', {
        class: o.value === current() ? 'on' : '', text: o.label, disabled: Boolean(disabled),
        onclick: () => { onPick(o.value); render(); }
      }))
    );
  }
  function row(label, control, desc = '') {
    return el('div', { class: 'field' },
      el('span', { class: 'fk', text: label }), control,
      desc ? el('span', { class: 'fd', text: desc }) : null
    );
  }
  function toggle(get, set) {
    const on = get();
    return el('button', {
      class: `sw${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': 'alternar',
      onclick: () => { set(!get()); render(); }
    });
  }
  function range(get, set, min, max, step, unit = '') {
    const out = el('output', { text: `${Number(get()).toFixed(step < 1 ? 2 : 0)}${unit}` });
    return el('div', { class: 'rng' },
      el('input', {
        type: 'range', min, max, step, value: get(), 'aria-label': 'valor',
        oninput: e => { set(Number(e.target.value)); out.textContent = `${Number(e.target.value).toFixed(step < 1 ? 2 : 0)}${unit}`; }
      }), out);
  }

  function render() {
    tabs.replaceChildren(...Object.entries(TABS).map(([key, def]) =>
      el('button', { class: `tab${state === key ? ' on' : ''}`, text: def.label, onclick: () => { state = key; render(); } })));
    body.replaceChildren(TABS[state].build());
  }

  let state = 'graficos';

  function buildGraphics() {
    const s = os.settings;
    return el('div', {},
      row('Backend de renderização',
        seg([{ value: 'auto', label: 'auto' }, { value: 'webgl2', label: 'webgl2' }, { value: 'webgpu', label: 'webgpu' }],
          () => s.backend, v => os.setSetting('backend', v), 'WebGPU: pipeline compute é fase F3'),
        'WebGPU exige navegador com navigator.gpu. Sem ele o OS cai para WebGL2, com perfil rebaixado.'),
      row('Escala de resolução', range(() => s.renderScale, v => os.setSetting('renderScale', v), 0.4, 1, 0.05, '×'),
        '540p/720p/1080p efetivos. Reduz VRAM e fill rate — o ganho mais direto em GPU fraca.'),
      row('Sombras', toggle(() => s.shadows, v => os.setSetting('shadows', v)),
        '1 passe de contato agora; CSM 2 cascatas quando o pipeline de sombra entrar.'),
      row('Partículas na GPU', seg([{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }], () => s.particles ? 'on' : 'off', v => os.setSetting('particles', v === 'on'), 'compute WGSL — fase F5'),
        'Requer WebGPU com compute. Em WebGL2 ficaria na CPU e não vale o custo.'),
      row('Teto de FPS', seg([{ value: 30, label: '30' }, { value: 60, label: '60' }, { value: 120, label: '120' }],
        () => s.fpsCap, v => os.setSetting('fpsCap', v)),
        'Trava de 30 FPS melhora a estabilidade em hardware básico (perfil baseline).')
    );
  }

  function buildPerf() {
    const s = os.settings;
    return el('div', {},
      row('Perfil', seg([
        { value: 'baseline', label: 'baseline' }, { value: 'balanced', label: 'balanced' }, { value: 'ultra', label: 'ultra' }
      ], () => s.profile, v => os.setProfile(v)),
        'baseline: 540p, 30 fps, sombras off · balanced: 720p, 60 · ultra: nativo, sombras on.'),
      row('Resolução dinâmica (DRS)', toggle(() => s.drs, v => os.setSetting('drs', v)),
        'Se o P95 do quadro passar de 18 ms, a escala cai 0,04× por quadro; sobe só após estabilidade.'),
      row('Tráfego simulado (w-engine)', range(() => s.entities, v => os.setSetting('entities', Math.round(v)), 0, 4096, 128, ''),
        'Agentes reais no worker: posição, rumo e velocidade. Alimenta o render por snapshot lock-free.'),
      row('Escala de resolução efetiva', el('span', { class: 'v mono', text: `${os.metrics.gameScale.toFixed(2)}×` }),
        'Valor aplicado agora — o DRS pode estar reduzindo abaixo do teto escolhido.')
    );
  }

  function buildStorage() {
    const u = os.storageSnapshot;
    const usedPct = Number.isFinite(u?.quotaMb) && u.quotaMb > 0 ? clamp(u.usedMb / u.quotaMb, 0, 1) : NaN;
    return el('div', {},
      row('Backend', el('span', { class: 'v mono', text: vfs.info.backend + (vfs.info.sync ? ' · SyncAccessHandle' : ' · assíncrono') }),
        'OPFS é o disco NVMe virtual: só o w-io abre arquivos, com escrita em blocos de 32 KiB.'),
      row('Uso', el('span', { class: 'v mono', text: `${fmtBytes((u?.usedMb || 0) * 1048576, 1)} de ${Number.isFinite(u?.quotaMb) ? fmtBytes(u.quotaMb * 1048576, 0) : 'N/D'}` }),
        Number.isFinite(usedPct) ? `Ocupação ${fmt1(usedPct * 100)}% da cota concedida ao site.` : 'O navegador não informa cota: mostramos N/D em vez de estimar.'),
      row('Persistência', el('button', { class: 'btn', text: 'solicitar persist()', onclick: askPersist }),
        'Sem persist(), o navegador pode despejar o disco virtual sob pressão de espaço.'),
      row('Benchmark', el('button', { class: 'btn', text: 'medir 1 MiB', onclick: runBench }), 'Escrita + leitura reais, em blocos de 32 KiB.'),
      row('Eviction', el('button', { class: 'btn danger', text: 'limpar cache', onclick: evict }),
        'Remove apenas o arquivo de benchmark e caches voláteis; perfil do usuário fica.')
    );
  }

  function buildSystem() {
    const s = os.capabilities;
    return el('div', {},
      el('div', { class: 'kv' },
        kv('origem isolada (COOP/COEP)', String(s.isolated)),
        kv('SharedArrayBuffer', String(s.sab)),
        kv('transporte IPC', os.metrics.transport),
        kv('backend GPU', os.metrics.backend),
        kv('CPU lógicas', String(s.cores)),
        kv('OPFS', s.opfs ? 'sim' : 'não'),
        kv('WebGPU', s.webgpu ? 'sim' : 'não')
      ),
      row('Reiniciar workers', el('button', { class: 'btn', text: 'reiniciar', onclick: restart }),
        'Recria w-kernel, w-engine e w-io. O desktop não recarrega; janelas permanecem.'),
      row('Diagnóstico', el('button', { class: 'btn', text: 'copiar relatório', onclick: copyDiag }),
        'Snapshot das métricas atuais em texto, para colar em uma issue.'),
      row('Reiniciar o OS', el('button', { class: 'btn danger', text: 'reboot', onclick: () => os.reboot() }),
        'Recarrega a página do desktop. O VMFS (OPFS) persiste.')
    );
  }

  const kv = (k, v) => el('div', {}, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));

  async function askPersist() {
    if (!navigator.storage?.persist) return toast.warn('Indisponível', 'StorageManager.persist não existe neste navegador.');
    const granted = await navigator.storage.persist();
    toast[granted ? 'ok' : 'warn']('Persistência', granted ? 'Concedida: o disco virtual não será despejado automaticamente.' : 'Negada: armazenamento segue em melhor esforço.');
  }
  async function runBench() {
    try {
      const r = await vfs.bench();
      toast.ok('I/O do VMFS', `escrita ${fmt1(r.writeMbps)} MB/s · leitura ${fmt1(r.readMbps)} MB/s`);
    } catch (e) { toast.err('Benchmark falhou', String(e.message || e)); }
  }
  async function evict() {
    try { const r = await vfs.remove('/var/nucleo/bench.bin'); toast.ok('Cache limpo', `/var/nucleo/bench.bin removido`); void r; render(); }
    catch (e) { toast.warn('Nada para limpar', String(e.message || e)); }
  }
  async function restart() {
    await os.restartWorkers();
    toast.ok('Subsistemas reiniciados', 'kernel, engine e io recriados sem recarregar o desktop.');
  }
  async function copyDiag() {
    const text = os.diagnostics();
    try { await navigator.clipboard.writeText(text); toast.ok('Diagnóstico copiado', `${text.split('\n').length} linhas na área de transferência.`); }
    catch { toast.err('Clipboard bloqueado', 'Copie manualmente pelo terminal: `top`.'); }
  }

  render();

  return {
    el: el('div', { class: 'modal glass' },
      el('header', {},
        el('h2', { text: 'Configurações — NÚCLEO OS' }),
        el('button', { class: 'btn', text: 'fechar', onclick: () => os.closeSettings() })
      ),
      tabs, body
    ),
    refresh: render
  };
}
