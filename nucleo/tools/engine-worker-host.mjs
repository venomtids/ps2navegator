/**
 * NÚCLEO OS — tools/engine-worker-host.mjs
 * Hospeda o `workers/engine.worker.js` REAL dentro de uma thread do Node, com o
 * mínimo de ambiente de browser (`self`), do mesmo modo que `tests/io-worker-host.mjs`
 * faz com o worker de I/O. Nada do worker é simulado: o protocolo (js/core/link.js),
 * o passo fixo, a IA de tráfego e o snapshot binário são os de produção.
 *
 * Usado por `tools/render-cidade.mjs` para renderizar um quadro com tráfego real.
 */

import { parentPort, MessagePort } from 'node:worker_threads';

const listeners = [];

globalThis.self = {
  addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
  postMessage(data, transfer) { parentPort.postMessage(data, transfer); },
  close() { process.exit(0); }
};

// Node entrega MessagePort transferido dentro do objeto; normalizamos para o
// formato de evento do browser (`event.ports`) — igual ao host do worker de I/O.
parentPort.on('message', data => {
  const ports = [];
  if (data && data.port instanceof MessagePort) ports.push(data.port);
  for (const fn of listeners) fn({ data, ports });
});

await import('../workers/engine.worker.js');
