/**
 * Fixture de teste: worker real (node:worker_threads) que usa o MESMO caminho de
 * produção — acceptWorkerLink + pump assíncrono — para provar o handshake, o
 * transporte SAB e o request/response entre threads.
 */
import { parentPort } from 'node:worker_threads';
import { OP } from '../os/js/core/ipc.js';
import { acceptWorkerLink } from '../os/js/core/link.js';
import { packStats } from '../os/js/core/wire.js';

const shim = {
  addEventListener(type, fn) {
    if (type !== 'message') return;
    parentPort.on('message', data => fn({ data, ports: data && data.__ports ? data.__ports : [] }));
  },
  postMessage: data => parentPort.postMessage(data),
  close: () => process.exit(0)
};

acceptWorkerLink(shim, {
  onReady(link) {
    link.on(OP.SYS_EXEC, (view, len) => {
      const msg = JSON.parse(new TextDecoder().decode(view.subarray(0, len)));
      link.send(OP.SYS_OUT, JSON.stringify({ id: msg.id, ok: true, data: { eco: msg.msg, dobrado: msg.msg * 2 } }));
    });
    link.on(OP.STAT_REQ, () => {
      link.send(OP.STAT, packStats(new Float32Array([42.5, 7])));
    });
    link.reader.pump().catch(e => console.error('[fixture]', e));
    return () => link.reader.close();
  }
});
