/**
 * NÚCLEO OS — tests/io-worker-host.mjs
 * Hospeda o io.worker.js REAL dentro de uma thread do Node, com o mínimo de
 * ambiente de browser (`self`), para exercitar o worker de verdade — não um
 * sósia. Serve para provar o caminho que o preview embutido usa:
 *
 *   sem SharedArrayBuffer → transporte MESSAGE (MessagePort)
 *   sem OPFS (aqui, sem `navigator.storage`) → backend volátil, declarado
 *
 * O que NÃO é simulado: o código do worker, o protocolo (FS_OP/BLK_*) e o VFS
 * do lado principal são exatamente os de produção.
 */

import { parentPort, MessagePort } from 'node:worker_threads';

const listeners = [];

globalThis.self = {
  addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
  postMessage(data, transfer) { parentPort.postMessage(data, transfer); },
  close() { process.exit(0); }
};

// Node entrega MessagePort transferido dentro do objeto; normalizamos para o
// formato de evento do browser (`event.ports`).
parentPort.on('message', data => {
  const ports = [];
  if (data && data.port instanceof MessagePort) ports.push(data.port);
  for (const fn of listeners) fn({ data, ports });
});

await import('../workers/io.worker.js');
