const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  try {
    const page = await browser.newPage();
    let installs = 0, polls = 0, reads = 0;
    const iso = Buffer.alloc(128 * 1024);
    iso.write('CD001', 32769);
    await page.route('https://cdn.tailwindcss.com/**', r => r.abort());
    await page.route('**/api/game/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const status = (phase, busy) => ({ phase, busy, message: phase, total: 100, downloaded: 100, extracted: iso.length, isoSize: iso.length });
      let body;
      if (pathname.endsWith('/config')) body = require('../game-config.json');
      else if (pathname.endsWith('/install')) { installs++; body = status('downloading', true); }
      else if (pathname.endsWith('/status')) body = installs ? (++polls > 1 ? status('ready', false) : status('extracting', true)) : status('idle', false);
      else if (pathname.endsWith('/disc')) body = { size: iso.length, sectorSize: 2048 };
      else if (pathname.endsWith('/stream')) {
        reads++;
        const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range);
        return route.fulfill({ status: 206, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${a}-${b}/${iso.length}`, 'Content-Length': String(Number(b) - Number(a) + 1)
        }, body: iso.subarray(Number(a), Number(b) + 1) });
      } else return route.abort();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:3000');
    await page.waitForFunction(() => document.querySelector('#installStatus').textContent === 'idle');
    assert.equal(installs, 0, 'Opening the page must never download');
    await page.locator('#install').click();
    await page.waitForFunction(() => /Falha:/.test(document.querySelector('#log').textContent), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('iframe'));
    assert.equal(installs, 1);
    assert.ok(reads > 0, 'The core must read from the installed ISO route');
    assert.match(await page.locator('#install').innerText(), /Iniciar GTA instalado/);
    console.log('PASS: one-click UI; no startup download; progress; automatic mount; real Play! boot/read with mock installed ISO; safe invalid-disc failure. Not a GTA gameplay test.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
