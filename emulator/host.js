import Play from './play/Play.js';

let port, module, stopped = false, statsTimer, nextID = 0;
const reads = new Map(), workers = new Set(), audioContexts = new Set();
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(...args) { super(...args); workers.add(this); }
  terminate() { workers.delete(this); return super.terminate(); }
};
for (const key of ['AudioContext', 'webkitAudioContext']) {
  const Original = window[key];
  if (Original) window[key] = class extends Original {
    constructor(...args) { super(...args); audioContexts.add(this); }
  };
}
function send(type, data = {}) { port?.postMessage({ type, ...data }); }
function dispose() {
  stopped = true;
  clearInterval(statsTimer);
  for (const w of workers) w.terminate();
  for (const context of audioContexts) context.close().catch(() => {});
  for (const r of reads.values()) { clearTimeout(r.timer); r.reject(new Error('Núcleo encerrado.')); }
  reads.clear();
}
function fatal(error) {
  if (stopped) return;
  send('error', { text: String(error?.message || error).slice(0, 600) });
  dispose();
}
function request(offset, length) {
  if (stopped) return Promise.reject(new Error('Leitor encerrado.'));
  return new Promise((resolve, reject) => {
    const id = ++nextID;
    const timer = setTimeout(() => {
      reads.delete(id);
      reject(new Error('Timeout na ponte de setores.'));
    }, 120000);
    reads.set(id, { resolve, reject, timer });
    send('read', { id, offset, length });
  });
}
class DiscDevice {
  constructor(size) { this.size = size; this.done = true; }
  getFileSize() { return this.size; }
  isDone() { return this.done; }
  read(pointer, offset, length) {
    // This method is called by Play!'s MAIN_THREAD_EM_ASM bridge. Its VM thread
    // polls isDone(); no Asyncify, fake sectors or full MEMFS ISO is needed.
    if (!this.done) return fatal(new Error('O núcleo solicitou leituras CDVD simultâneas.'));
    pointer >>>= 0; length >>>= 0;
    this.done = false;
    (async () => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > this.size)
        throw new Error('O núcleo tentou ler fora do disco. Confirme que o arquivo é uma ISO válida.');
      if (pointer + length > module.HEAPU8.length) throw new Error('Destino fora da memória WASM.');
      for (let n = 0; n < length;) {
        const count = Math.min(1024 * 1024, length - n);
        const bytes = await request(offset + n, count);
        if (stopped) return;
        if (bytes.byteLength !== count) throw new Error('Leitura parcial de setor.');
        // Read HEAPU8 again after await: memory growth can replace the view.
        module.HEAPU8.set(bytes, pointer + n);
        n += count;
      }
      this.done = true;
    })().catch(fatal);
  }
}

const canvas = document.getElementById('outputCanvas');
// Translate physical keys into the built-in Play! controller bindings.
const keys = { KeyW: 'KeyT', KeyA: 'KeyF', KeyS: 'KeyG', KeyD: 'KeyH',
  KeyJ: 'KeyZ', KeyK: 'KeyX', KeyU: 'KeyA', KeyI: 'KeyS',
  KeyQ: 'Key1', KeyE: 'Key8', Digit1: 'Key2', Digit3: 'Key9' };
const held = new Set();
let dispatching = false;
function emitKey(type, code) {
  dispatching = true;
  canvas.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
  dispatching = false;
}
for (const type of ['keydown', 'keyup']) canvas.addEventListener(type, event => {
  if (dispatching) return;
  event.preventDefault();
  const code = keys[event.code] || event.code;
  if (type === 'keydown') held.add(code); else held.delete(code);
  if (keys[event.code]) {
    event.stopImmediatePropagation();
    if (!event.repeat) emitKey(type, code);
  }
}, true);
canvas.addEventListener('blur', () => { for (const code of held) emitKey('keyup', code); held.clear(); });
canvas.addEventListener('pointerdown', () => {
  canvas.focus();
  for (const context of audioContexts) context.resume().catch(() => {});
});

window.addEventListener('message', async function initialize(event) {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'sector-init' || port) return;
  port = event.ports[0];
  if (!port) return;
  port.onmessage = ({ data: m }) => {
    if (m.type === 'stop') { dispose(); send('stopped'); return; }
    if (m.type !== 'read-result') return;
    const r = reads.get(m.id);
    if (!r) return;
    clearTimeout(r.timer); reads.delete(m.id);
    if (m.error) r.reject(new Error(m.error)); else r.resolve(m.bytes);
  };
  try {
    if (!crossOriginIsolated) throw new Error('SharedArrayBuffer indisponível: faltam isolamento ou HTTPS.');
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 indisponível neste navegador/dispositivo.');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const base = new URL('./play/', location.href).href;
    module = await Play({
      canvas,
      locateFile: file => new URL(file, base).href,
      mainScriptUrlOrBlob: new URL('Play.js', base).href,
      print: text => {
        send('status', { text: String(text).slice(0, 600) });
        if (/Failed to start:/i.test(text)) setTimeout(() => fatal(new Error(text)), 0);
      },
      printErr: text => console.warn('[Play!]', text),
      onAbort: text => fatal(new Error(`Play! interrompido: ${text}`))
    });
    if (stopped) { dispose(); return; }
    module.FS.mkdir('/work');
    module.discImageDevice = new DiscDevice(event.data.size);
    module.ccall('initVm', null, [], []);
    canvas.focus();
    module.bootDiscImage('disc.iso');
    statsTimer = setInterval(() => {
      if (stopped) return;
      try { const fps = module.getFrames(); module.clearStats(); send('fps', { fps }); }
      catch (e) { fatal(e); }
    }, 1000);
    send('ready');
  } catch (error) { fatal(error); }
});
window.addEventListener('error', event => fatal(event.error || event.message));
window.addEventListener('unhandledrejection', event => fatal(event.reason));
window.addEventListener('pagehide', dispose);
