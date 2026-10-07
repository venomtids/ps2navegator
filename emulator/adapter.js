// Play! bridge. The core runs in its own document so stopping releases its VM,
// WebGL context, event handlers, pthread workers and audio contexts together.
export async function createPS2({ canvas, disc, onStatus = () => {}, onError = () => {}, onFPS = () => {} }) {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    throw new Error('Play! exige SharedArrayBuffer. Abra pelo servidor em localhost ou HTTPS, com COOP/COEP.');
  }
  if (!disc || !Number.isSafeInteger(disc.size) || disc.size < 1) throw new Error('Nenhum disco válido.');
  let frame, port, timer, active = false, closed = false, pending = false;
  let rejectStart, stopAck;
  const start = () => new Promise((resolve, reject) => {
    if (active || closed) return reject(new Error('Crie uma nova instância para iniciar novamente.'));
    active = true;
    rejectStart = reject;
    frame = document.createElement('iframe');
    frame.title = 'Play! — Emulador PS2';
    frame.allow = 'autoplay; fullscreen';
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;z-index:1';
    frame.src = '/emulator/host.html';
    frame.onload = () => {
      if (closed) return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = async ({ data: m }) => {
        if (closed || !m) return;
        if (m.type === 'stopped') { stopAck?.(); return; }
        if (m.type === 'ready') {
          clearTimeout(timer);
          rejectStart = null;
          frame.focus();
          onStatus('Play! inicializado; boot do disco solicitado.');
          resolve();
        } else if (m.type === 'status') {
          onStatus(String(m.text).slice(0, 600));
        } else if (m.type === 'fps') {
          onFPS(m.fps);
        } else if (m.type === 'error') {
          const error = new Error(m.text || 'Falha no núcleo.');
          rejectStart?.(error); rejectStart = null;
          clearTimeout(timer);
          onError(error);
        } else if (m.type === 'read') {
          if (pending) {
            port.postMessage({ type: 'read-result', id: m.id, error: 'Leitura concorrente inesperada no CDVD.' });
            return;
          }
          pending = true;
          try {
            const bytes = await disc.read(m.offset, m.length);
            if (!closed) port.postMessage({ type: 'read-result', id: m.id, bytes }, [bytes.buffer]);
          } catch (e) {
            if (!closed) port.postMessage({ type: 'read-result', id: m.id, error: e.message });
          } finally { pending = false; }
        }
      };
      frame.contentWindow.postMessage({ type: 'sector-init', size: disc.size }, location.origin, [channel.port2]);
    };
    canvas.parentElement.append(frame);
    timer = setTimeout(() => {
      const error = new Error('O núcleo não inicializou em 60 segundos. Verifique WebGL2, WASM e o console.');
      rejectStart?.(error); rejectStart = null;
      onError(error);
    }, 60000);
  });
  async function stop() {
    if (closed) return;
    clearTimeout(timer);
    rejectStart?.(new Error('Inicialização cancelada.')); rejectStart = null;
    if (port) {
      await new Promise(resolve => {
        let deadline;
        stopAck = () => { clearTimeout(deadline); resolve(); };
        deadline = setTimeout(resolve, 1000);
        port.postMessage({ type: 'stop' });
      });
    }
    closed = true;
    port?.close();
    frame?.remove();
  }
  return { start, stop };
}
