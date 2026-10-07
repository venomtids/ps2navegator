const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const express = require('express');
const { GameInstaller, router, sevenZip, allowedURL } = require('../game-installer');

(async () => {
  const root = await fsp.mkdtemp(path.join(__dirname, 'installer-fixture-'));
  const realFetch = global.fetch;
  let server;
  try {
    const input = path.join(root, 'fixture.iso'), archive = path.join(root, 'fixture.zip');
    const data = Buffer.alloc(128 * 1024, 0x5a);
    data[32768] = 1; data.write('CD001', 32769);
    await fsp.writeFile(input, data);
    const pack = spawnSync(sevenZip(), ['a', '-tzip', '-pfixture-password', archive, input], { encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr);
    const length = fs.statSync(archive).size;
    let requests = 0;
    global.fetch = async url => {
      requests++;
      if (String(url).includes('romsfun.com')) return new Response('<a href="https://sto.romsfast.com/fixture.zip?e=1&amp;s=public">Download</a>', { status: 200 });
      return new Response(Readable.toWeb(fs.createReadStream(archive)), { status: 200, headers: { 'Content-Length': String(length), 'Content-Type': 'application/zip' } });
    };
    const dir = path.join(root, 'installed');
    const installer = new GameInstaller(dir);
    await installer.ready;
    assert.equal(requests, 0, 'Startup must not download');
    assert.equal(installer.state.phase, 'idle');
    await installer.start('https://sto.romsfast.com/fixture.zip', 'fixture-password');
    await installer.task;
    assert.equal(installer.state.phase, 'ready', installer.state.message);
    assert.deepEqual(await fsp.readFile(installer.iso), data);
    assert.equal(fs.existsSync(installer.archive), false);
    assert.equal(fs.existsSync(installer.partialISO), false);
    const before = requests;
    await installer.start();
    assert.equal(requests, before, 'Ready game must not download again');
    assert.throws(() => allowedURL('http://127.0.0.1/secrets.iso'));
    assert.throws(() => allowedURL('https://archive.org.evil.example/test.iso'));

    const failure = new GameInstaller(path.join(root, 'blocked'));
    global.fetch = async () => new Response('Forbidden', { status: 403 });
    await failure.start(); await failure.task;
    assert.equal(failure.state.phase, 'error');
    assert.match(failure.state.message, /403/);
    assert.equal(fs.existsSync(failure.iso), false);

    const cancelled = new GameInstaller(path.join(root, 'cancelled'));
    global.fetch = async (url, options) => new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(new Error('aborted'));
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await cancelled.start();
    cancelled.cancel(); await cancelled.task;
    assert.equal(cancelled.state.phase, 'cancelled');
    assert.equal(fs.existsSync(cancelled.partialISO), false);

    global.fetch = realFetch;
    const app = express(); app.use('/api/game', router(dir));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/game`;
    const status = await (await realFetch(base + '/status')).json();
    assert.equal(status.phase, 'ready', 'Existing ISO must survive restart');
    const response = await realFetch(base + '/stream', { headers: { Range: 'bytes=32768-34815' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(32768, 34816));
    assert.equal((await realFetch(base + '/stream')).status, 400);
    const forbidden = await realFetch(base + '/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403, 'Cross-site action must be rejected');
    console.log('PASS: no auto-download on startup; encrypted ZIP streamed to disk; ISO extraction; partial cleanup; idempotent install; 403 origin error; host validation; restart detection; local HTTP Range; cross-site protection.');
  } finally {
    global.fetch = realFetch;
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
