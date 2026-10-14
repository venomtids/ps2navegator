/**
 * SECTOR OS — apps/ps2.js
 * Console PS2 como janela do sistema: reaproveita o núcleo Play! deste
 * repositório (emulator/adapter.js) e a rota Range do backend **[P]**.
 *
 * Três origens de disco, todas explícitas quanto ao que fazem:
 *   1. disco instalado   → /api/game/disc + /api/game/stream (Range local)
 *   2. ISO do computador → File.slice() (nada é enviado ao servidor)
 *   3. item remoto       → /api/disc + /api/stream-iso (allowlist archive.org)
 *
 * Nada aqui promete compatibilidade: se o núcleo falhar, mostramos o erro real.
 */

import { el, fmtBytes } from '../core/util.js';

export function createPS2({ toast }) {
  const canvas = el('canvas', { id: 'os-ps2-canvas', width: 640, height: 480, tabindex: '0', 'aria-label': 'Tela do console' });
  canvas.style.cssText = 'width:100%;height:100%;display:block;background:#000;outline:none';
  const stage = el('div', { style: { position: 'relative', flex: '1', minHeight: '0' } }, canvas);
  const status = el('div', { class: 'lbl', text: 'núcleo parado' });
  const meta = el('span', { class: 'path', text: '—' });
  const controls = el('div', { class: 'bar' });

  let instance = null;
  let source = null;          // { kind, label, size, read(offset,len) }
  let remote = { item: '', file: '' };

  const root = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    el('div', { class: 'phead' }, el('span', { class: 'lbl', text: 'ps2 · play!' }), meta, status),
    stage,
    controls
  );

  function btn(label, onclick, disabled = false) {
    const b = el('button', { class: 'btn', text: label, onclick, disabled });
    return b;
  }

  function render() {
    controls.replaceChildren(
      btn(source ? `Iniciar (${source.label})` : 'Iniciar', start, !source),
      btn('Parar', stop, !instance),
      btn('Escolher ISO local', pickLocal),
      btn('Disco instalado', useInstalled, false),
      btn('Item remoto…', askRemote)
    );
    meta.textContent = source ? `${source.label} · ${fmtBytes(source.size, 2)}` : 'nenhum disco montado';
  }

  async function api(path, init) {
    const res = await fetch(path, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* resposta não-JSON */ }
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  }

  function rangeReader(url, label) {
    return async (offset, length) => {
      const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (res.status !== 206) throw new Error(`${label}: origem sem Range válido (HTTP ${res.status})`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== length) throw new Error(`${label}: setor curto (${buf.byteLength}/${length})`);
      return new Uint8Array(buf);
    };
  }

  async function useInstalled() {
    try {
      const info = await api('/api/game/disc');
      source = {
        kind: 'installed', label: 'disco instalado', size: info.size,
        read: rangeReader('/api/game/stream', 'disco instalado')
      };
      toast.ok('Disco instalado montado', fmtBytes(info.size, 2));
      render();
    } catch (e) {
      toast.warn('Sem disco instalado', `${e.message}. Baixe pelo painel / ou escolha uma ISO local.`);
    }
  }

  function pickLocal() {
    const input = el('input', { type: 'file', accept: '.iso,application/octet-stream', style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      source = {
        kind: 'local', label: file.name, size: file.size,
        read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
      };
      toast.ok('ISO local montada', `${file.name} · ${fmtBytes(file.size, 2)} — o arquivo não sai do seu computador.`);
      render();
    });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 30000);
  }

  async function askRemote() {
    const item = prompt('Identificador no Internet Archive (ex.: grand-theft-auto-san-andreas-usa-v-3.00_202401):', remote.item); // eslint-disable-line no-alert
    if (!item) return;
    const file = prompt('Caminho do arquivo .iso dentro do item:', remote.file); // eslint-disable-line no-alert
    if (!file) return;
    try {
      const q = `item=${encodeURIComponent(item)}&file=${encodeURIComponent(file)}`;
      const info = await api(`/api/disc?${q}`);
      remote = { item, file };
      source = { kind: 'remote', label: `${item}`, size: info.size, read: rangeReader(`/api/stream-iso?${q}`, 'origem remota') };
      toast.push({ kind: 'warn', title: 'Origem remota montada', text: 'Use apenas conteúdo que você tem direito de utilizar.', ms: 9000 });
      render();
    } catch (e) { toast.err('Falha ao montar', String(e.message || e)); }
  }

  async function start() {
    if (!source) return;
    if (!crossOriginIsolated) {
      toast.err('Isolamento ausente', 'Play! exige SharedArrayBuffer: abra pelo servidor (localhost/HTTPS) com COOP/COEP.');
      return;
    }
    status.textContent = 'carregando núcleo…';
    try {
      const { createPS2: createCore } = await import('/emulator/adapter.js');
      instance = await createCore({
        canvas,
        disc: { size: source.size, read: source.read },
        onStatus: text => { status.textContent = text.slice(0, 90); },
        onError: error => { toast.err('Núcleo PS2', String(error.message || error)); status.textContent = 'erro no núcleo'; },
        onFPS: fps => { status.textContent = `${fps} fps · ${source.label.slice(0, 40)}`; }
      });
      await instance.start();
      toast.ok('Núcleo iniciado', 'Boot do disco solicitado. Clique na tela para teclado e áudio.');
    } catch (e) {
      status.textContent = 'falha ao iniciar';
      toast.err('Play! não iniciou', String(e.message || e));
      instance = null;
    }
    render();
  }

  async function stop() {
    try { await instance?.stop(); } catch { /* núcleo já encerrado */ }
    instance = null;
    stage.querySelectorAll('iframe').forEach(f => f.remove());
    status.textContent = 'núcleo parado';
    toast.push({ kind: 'info', title: 'Console parado', text: 'Workers, áudio e documento do núcleo foram encerrados.' });
    render();
  }

  render();

  return {
    el: root,
    onResize() { /* o núcleo se adapta ao canvas via CSS */ },
    async onClose() { await stop(); }
  };
}
