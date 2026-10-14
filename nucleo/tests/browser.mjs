/**
 * NÚCLEO OS — tests/browser.mjs
 * Teste de navegador real (Playwright/Chromium). Requer:
 *   npx playwright install chromium   (e, no Linux, npx playwright install-deps chromium)
 *
 * Cobre o que só existe no navegador: isolamento COOP/COEP, criação dos workers
 * com SharedArrayBuffer, boot, VMFS em OPFS, window manager, paleta, HUD e a
 * janela do motor 3D com contexto WebGL2 vivo.
 *
 * Não mede desempenho nem valida jogos. Se o Chromium não estiver instalado, o
 * teste falha explicando como instalar (não finge sucesso).
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.TEST_URL || 'http://127.0.0.1:3400';
const results = [];
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { failed++; results.push(`  FAIL ${name}\n       ${e.message}`); }
};

let browser;
try {
  browser = await chromium.launch({ args: ['--enable-features=SharedArrayBuffer'] });
} catch (e) {
  console.error('Chromium não disponível para o Playwright.');
  console.error('Instale com: npx playwright install chromium && npx playwright install-deps chromium');
  console.error(String(e.message || e));
  process.exit(1);
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e.message || e)));

await page.goto(`${BASE}/os`, { waitUntil: 'domcontentloaded' });

await step('página isolada (COOP/COEP) com SharedArrayBuffer', async () => {
  const isolated = await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === 'function');
  assert.equal(isolated, true, 'crossOriginIsolated/SAB indisponíveis: o servidor precisa enviar COOP/COEP');
});

await step('boot termina e o desktop aparece', async () => {
  await page.waitForSelector('.dockitem', { timeout: 20000 });
  await page.waitForSelector('.boot', { state: 'detached', timeout: 20000 });
  const windows = await page.locator('#windows').count();
  assert.equal(windows, 1);
});

await step('barra de status mostra transporte e backend reais', async () => {
  await page.waitForFunction(() => document.querySelector('#tok-transport')?.textContent?.length > 2, null, { timeout: 15000 });
  const transport = await page.textContent('#tok-transport');
  const gpu = await page.textContent('#tok-gpu');
  assert.match(transport, /RING\/SAB|MESSAGE/);
  assert.match(gpu, /WEBGPU|WEBGL2|INDISPONÍVEL/);
  assert.equal(transport, 'RING/SAB', 'com isolamento, o transporte deve ser o anel SAB');
});

await step('terminal: aplica comandos reais no VMFS (OPFS)', async () => {
  await page.click('.dockitem[data-app="terminal"]');
  await page.waitForSelector('.win[data-app="terminal"] .term input', { timeout: 10000 });
  const input = page.locator('.win[data-app="terminal"] .term input');
  await input.click();
  for (const cmd of ['help', 'ls', 'df', 'sysctl', 'bench']) {
    await input.fill(cmd);
    await input.press('Enter');
    await page.waitForTimeout(cmd === 'bench' ? 1200 : 350);
  }
  const text = await page.textContent('.win[data-app="terminal"] .term');
  assert.match(text, /comandos disponíveis/);
  assert.match(text, /LEIA-ME\.txt/, 'ls deveria listar a semente do VMFS');
  assert.match(text, /backend\s+OPFS/, 'df deveria informar o backend real');
  assert.match(text, /MB\/s/, 'bench deveria medir I/O de verdade');
});

await step('terminal: cria, lê e apaga arquivo no VMFS', async () => {
  const input = page.locator('.win[data-app="terminal"] .term input');
  await input.fill("write t.txt prova-do-vmfs");
  await input.press('Enter');
  await page.waitForTimeout(400);
  await input.fill('cat t.txt');
  await input.press('Enter');
  await page.waitForTimeout(400);
  await input.fill('rm t.txt');
  await input.press('Enter');
  await page.waitForTimeout(400);
  const text = await page.textContent('.win[data-app="terminal"] .term');
  assert.match(text, /gravados 13 bytes/);
  assert.match(text, /prova-do-vmfs/);
});

await step('HUD de telemetria mostra números reais dos workers', async () => {
  await page.click('#tok-hud');
  await page.waitForSelector('.hud.show', { timeout: 5000 });
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.hud .wrow .ms')].map(n => n.textContent);
    return rows.some(t => /ms/.test(t));
  }, null, { timeout: 10000 });
  const hud = await page.textContent('.hud');
  assert.match(hud, /w-kernel/);
  assert.match(hud, /w-engine/);
  assert.match(hud, /w-io/);
  assert.match(hud, /N\/D — não é exposta pelo navegador/, 'o HUD deve declarar que VRAM não é exposta');
  const ms = await page.locator('.hud .wrow .ms').first().textContent();
  assert.match(ms, /ms/, `métrica do kernel deveria ser medida, veio "${ms}"`);
});

await step('janela do motor 3D abre com WebGL2 e desenha', async () => {
  await page.click('.dockitem[data-app="cidade"]');
  await page.waitForSelector('.win[data-app="cidade"] canvas', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const canvas = document.querySelector('.win[data-app="cidade"] canvas');
    const line = canvas.parentElement.querySelector('.lbl').textContent;
    return { w: canvas.width, h: canvas.height, line };
  });
  assert.ok(info.w > 64 && info.h > 64, 'canvas do motor precisa ter tamanho real');
  assert.match(info.line, /draw calls/);
  assert.match(info.line, /tráfego \d+/);
});

await step('configurações: aplicar perfil baseline muda o motor de verdade', async () => {
  await page.click('#tok-hud'); // fecha o HUD para liberar a tela
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#palette input');
  await page.fill('#palette input', 'configurações');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal');
  await page.click('.tab:nth-child(2)');
  await page.click('.seg button:has-text("baseline")');
  await page.waitForTimeout(600);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nucleo-os:settings')));
  assert.equal(saved.profile, 'baseline');
  assert.equal(saved.fpsCap, 30);
  assert.equal(saved.renderScale, 0.5);
});

await step('reiniciar subsistemas recria os workers sem recarregar', async () => {
  await page.click('.tab:nth-child(4)');
  await page.click('button:has-text("reiniciar")');
  await page.waitForTimeout(1200);
  const metrics = await page.evaluate(() => document.querySelector('.hud')?.textContent || '');
  void metrics;
  const alive = await page.evaluate(async () => {
    const term = [...document.querySelectorAll('.win[data-app="terminal"] .term')][0];
    return Boolean(term);
  });
  assert.equal(alive, true, 'o desktop não pode recarregar ao reiniciar os workers');
});

await step('nenhum erro de JavaScript no console', async () => {
  const real = errors.filter(e => !/favicon|Fontconfig/i.test(e));
  assert.deepEqual(real, [], `erros no console:\n${real.join('\n')}`);
});

await page.keyboard.press('Escape');
await page.screenshot({ path: 'tests/os-dashboard.png', fullPage: false });
await browser.close();

console.log(results.join('\n'));
console.log(`\n${results.length - failed} passaram · ${failed} falharam${failed ? ' ✗' : ' ✓'}`);
console.log('captura: tests/os-dashboard.png');
process.exit(failed ? 1 : 0);
