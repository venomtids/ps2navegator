// npm run test:smoke (server running; Chromium installed with npx playwright install chromium)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  try {
    const page = await browser.newPage();
    const errors = [], responses = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.url().includes('/emulator/')) responses.push([r.status(), r.url()]); });
    await page.route('https://cdn.tailwindcss.com/**', r => r.abort());
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:3000');
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    // Deliberately incomplete ISO: validates reads and graceful boot failure, not gameplay.
    const iso = Buffer.alloc(1024 * 1024);
    iso.write('CD001', 32769, 'ascii');
    await page.locator('#localIso').setInputFiles({ name: 'invalid-test.iso', mimeType: 'application/octet-stream', buffer: iso });
    await page.locator('#mountLocal').click();
    await page.waitForFunction(() => /ISO local/.test(document.querySelector('#log').textContent));
    await page.locator('#test').click();
    await page.waitForFunction(() => /2048 bytes/.test(document.querySelector('#log').textContent));
    await page.locator('#play').click();
    await page.waitForFunction(() => /Falha:|Failed to start|Falha no|interrompido/.test(document.querySelector('#log').textContent), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('iframe'), null, { timeout: 15000 });
    assert.ok(responses.some(([s, u]) => s === 200 && u.endsWith('Play.wasm')), 'WASM must load');
    await page.locator('#eject').click();
    assert.equal(await page.locator('#discStatus').innerText(), 'Sem disco');
    await page.screenshot({ path: 'tests/dashboard.png', fullPage: true });
    console.log(JSON.stringify({ result: 'PASS', checks: ['isolation', 'local sector read', 'real WASM load', 'invalid disc fails safely', 'eject'], events: await page.locator('#log').innerText(), errors, responses }, null, 2));
    assert.equal(errors.length, 0, 'Unexpected browser errors');
    // Check actual physical-key translation without starting a VM.
    await page.goto((process.env.TEST_URL || 'http://127.0.0.1:3000') + '/emulator/host.html');
    await page.evaluate(() => {
      window.seenKeys = [];
      document.querySelector('canvas').addEventListener('keydown', e => window.seenKeys.push(e.code));
    });
    await page.locator('canvas').focus();
    await page.keyboard.press('w');
    await page.keyboard.press('j');
    assert.deepEqual(await page.evaluate(() => window.seenKeys), ['KeyT', 'KeyZ']);
    console.log('PASS: WASD and action-key translation.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
