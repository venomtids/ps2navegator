/**
 * SECTOR OS — js/boot.js
 * Tela de boot (§6.1): mostra a sequência REAL de sondagens de capacidade.
 * Nenhuma linha é decorativa — cada uma corresponde a uma checagem que pode
 * falhar e alterar o modo de operação do OS.
 */

import { el } from './core/util.js';

export function createBoot(root) {
  const log = el('div', { class: 'log', role: 'status', 'aria-live': 'polite' });
  const bar = el('i');
  const overlay = el('div', { class: 'boot' },
    el('div', { class: 'sigil', style: { width: '34px', height: '34px' } }),
    el('div', { class: 'logo' }, 'SECTOR', el('span', { text: ' OS' })),
    el('div', { class: 'sub', text: 'virtual pc no navegador · v0.4.0' }),
    el('div', { class: 'track' }, bar),
    log
  );
  root.append(overlay);
  const started = performance.now();
  let lines = 0;

  return {
    line(text, kind = '') {
      const tag = { ok: 'b', warn: 'i', err: 'u' }[kind];
      const node = el('div', {}, tag ? el(tag, { text: `${kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '✗'} ` }) : null, text);
      log.append(node);
      lines++;
      while (log.children.length > 8) log.removeChild(log.firstChild);
    },
    progress(p) { bar.style.width = `${Math.round(p * 100)}%`; },
    /** Fecha o boot respeitando o mínimo de 900 ms (evita flash de tela). */
    async finish() {
      const elapsed = performance.now() - started;
      if (elapsed < 900) await new Promise(r => setTimeout(r, 900 - elapsed));
      bar.style.width = '100%';
      overlay.classList.add('done');
      setTimeout(() => overlay.remove(), 420);
    },
    get lines() { return lines; }
  };
}

/** Sondagens de capacidade. Cada item é independente e honesto quanto ao resultado. */
export async function probeCapabilities({ boot }) {
  const cap = {
    isolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer === 'function',
    atomicsWait: typeof Atomics?.wait === 'function',
    cores: navigator.hardwareConcurrency || 1,
    webgl2: false, webgpu: typeof navigator.gpu !== 'undefined',
    opfs: Boolean(navigator.storage?.getDirectory),
    syncAccess: false, quotaMb: NaN, persisted: false
  };

  boot.progress(0.1);
  if (cap.isolated) boot.line('isolamento de origem (COOP/COEP) ativo', 'ok');
  else boot.line('sem isolamento: SharedArrayBuffer indisponível — modo degradado', 'warn');

  if (cap.sab && cap.isolated) boot.line('SharedArrayBuffer + Atomics disponíveis', 'ok');
  else if (cap.sab) boot.line('SharedArrayBuffer presente, mas sem isolamento (risco de bloqueio)', 'warn');
  else boot.line('SharedArrayBuffer ausente: transporte MESSAGE', 'warn');

  boot.progress(0.2);
  boot.line(`${cap.cores} CPU lógicas visíveis para o pool de workers`);

  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    cap.webgl2 = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    boot.line(cap.webgl2 ? 'WebGL 2.0 disponível' : 'WebGL 2.0 indisponível', cap.webgl2 ? 'ok' : 'err');
  } catch { boot.line('WebGL 2.0 indisponível (exceção ao criar contexto)', 'err'); }

  if (cap.webgpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      cap.webgpu = Boolean(adapter);
      boot.line(cap.webgpu ? 'WebGPU disponível (pipeline compute: fase F3)' : 'navigator.gpu presente, sem adaptador', cap.webgpu ? 'ok' : 'warn');
    } catch { cap.webgpu = false; boot.line('WebGPU falhou ao pedir adaptador', 'warn'); }
  } else {
    boot.line('WebGPU indisponível — render cai para WebGL 2.0', 'warn');
  }

  boot.progress(0.35);
  if (cap.opfs) {
    boot.line('Origin Private File System disponível');
    try {
      const est = await navigator.storage.estimate();
      cap.quotaMb = (est.quota ?? 0) / 1048576;
      boot.line(`cota de armazenamento: ${Number.isFinite(cap.quotaMb) ? `${Math.round(cap.quotaMb)} MB` : 'N/D'}`);
    } catch { boot.line('cota de armazenamento: N/D (estimate indisponível)', 'warn'); }
    cap.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    boot.line(cap.persisted ? 'armazenamento persistente concedido' : 'armazenamento em melhor esforço (pode ser despejado)', cap.persisted ? 'ok' : 'warn');
  } else {
    boot.line('OPFS indisponível: disco virtual em memória volátil', 'err');
  }
  boot.progress(0.5);
  return cap;
}
