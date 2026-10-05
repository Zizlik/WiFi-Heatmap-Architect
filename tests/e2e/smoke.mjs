// Browser smoke tests of the BUILT app (index.html / index.cs.html): it boots without errors from file:// and over http,
// the demo flat draws a heat map, the router moves, a room can be drawn, the project round-trips through SVG, nothing
// overflows on a phone, a failing browser storage is reported, and axe finds no serious accessibility problem on the
// main screens.
//
//   npm i --no-save --no-package-lock playwright-core axe-core        (once; nothing is added to the repository)
//   node tests/e2e/smoke.mjs                                           (Chromium that Playwright installed:  npx playwright-core install chromium)
//   PW_CHANNEL=msedge node tests/e2e/smoke.mjs                         (or an installed Edge / Chrome:  PW_CHANNEL=chrome)
//
// Needs `node build.mjs` first (it tests the generated files).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const AXE = require.resolve('axe-core/axe.min.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
let server;
let origin;
let browser;

before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.resolve(ROOT, '.' + p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, executablePath: process.env.PW_EXECUTABLE || undefined });
});
after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

/** A fresh page that records page errors and console errors. */
async function open(url, ctxOpts) {
  const context = await browser.newContext(ctxOpts || { viewport: { width: 1360, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.WH && WH.store && WH.shell && WH.engine);
  return { page, context, errors };
}
const close = async (c) => c.context.close();
const demo = async (page) => {
  await page.getByRole('button', { name: /Try the demo flat/ }).click();
  await page.waitForFunction(() => WH.store.project && WH.store.project.plan.rooms.length > 0);
};

for (const [label, url] of [['http', () => `${origin}/index.html`], ['file://', () => pathToFileURL(path.join(ROOT, 'index.html')).href]]) {
  test(`boots without errors over ${label} and shows the welcome screen`, async () => {
    const c = await open(url());
    assert.ok(await c.page.getByRole('button', { name: /Try the demo flat/ }).isVisible());
    assert.deepEqual(c.errors, []);
    await close(c);
  });
}

test('the Czech build boots in Czech', async () => {
  const c = await open(`${origin}/index.cs.html`);
  assert.equal(await c.page.evaluate(() => WH.i18n.lang), 'cs');
  assert.equal(await c.page.evaluate(() => document.documentElement.lang), 'cs');
  assert.deepEqual(c.errors, []);
  await close(c);
});

test('the demo flat draws a heat map and tells the coverage; the router moves with the arrow keys', async () => {
  const c = await open(`${origin}/index.html`);
  await demo(c.page);
  await c.page.keyboard.press('2');
  await c.page.waitForTimeout(600);
  // heat colours on the plan canvas: strongly coloured pixels (the plan itself is greys and a few accents)
  const heat = async () => c.page.evaluate(() => {
    const cv = document.querySelector('canvas.stage__canvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    let col = 0;
    for (let i = 0; i < d.length; i += 4 * 13) {
      n++;
      if (d[i + 3] > 0 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) col++;
    }
    return col / n;
  });
  const share = await heat();
  assert.ok(share > 0.02, `heat colours cover ${(share * 100).toFixed(1)} % of the canvas samples`);
  // the Result card states the coverage the engine computes for this plan
  const engineCov = await c.page.evaluate(() => Math.round(WH.engine.analysis.building(WH.store.project, { cell: 8, offsets: { ...WH.planner.S.offs } }).total.trial.coverage));
  const shown = (await c.page.locator('body').innerText()).match(/Coverage with good signal\D{0,20}(\d+)\s?%/i);
  assert.ok(shown, 'the coverage line is on the screen');
  assert.ok(Math.abs(Number(shown[1]) - engineCov) <= 3, `shown ${shown[1]} % vs engine ${engineCov} %`);
  const x0 = await c.page.evaluate(() => WH.store.project.net.router.x);
  await c.page.locator('canvas[tabindex]:visible').first().focus(); // the arrows act on the focused plan (keyboard users)
  for (let i = 0; i < 4; i++) await c.page.keyboard.press('ArrowRight');
  await c.page.waitForTimeout(300);
  const x1 = await c.page.evaluate(() => WH.store.project.net.router.x);
  assert.ok(x1 > x0, `router moved right (${x0} -> ${x1})`);
  assert.deepEqual(c.errors, []);
  await close(c);
});

test('a room can be drawn from scratch with the rectangle tool; undo takes it back', async () => {
  const c = await open(`${origin}/index.html`);
  await c.page.getByRole('button', { name: /Draw from scratch/ }).click();
  await c.page.waitForFunction(() => location.hash === '#plan');
  await c.page.keyboard.press('r');
  const stage = c.page.locator('.stage').first();
  const box = await stage.boundingBox();
  await c.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await c.page.mouse.down();
  await c.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await c.page.mouse.up();
  await c.page.waitForFunction(() => WH.store.project.plan.rooms.length === 1);
  await c.page.keyboard.press('Control+z');
  await c.page.waitForFunction(() => WH.store.project.plan.rooms.length === 0);
  assert.deepEqual(c.errors, []);
  await close(c);
});

test('Ctrl+S downloads the project as SVG and opening it brings the same plan back', async () => {
  const c = await open(`${origin}/index.html`);
  await demo(c.page);
  const rooms = await c.page.evaluate(() => WH.store.project.plan.rooms.length);
  const [dl] = await Promise.all([c.page.waitForEvent('download'), c.page.keyboard.press('Control+s')]);
  assert.match(dl.suggestedFilename(), /\.svg$/);
  const svg = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(svg.includes('<svg'));
  await c.page.evaluate(() => WH.store.replace && WH.store.replace(WH.engine.project.create({ template: 'blank', lang: 'en' })));
  const kind = await c.page.evaluate(async (text) => (await WH.io.importFile(new File([text], 'back.svg', { type: 'image/svg+xml' }), {})).kind, svg);
  assert.equal(kind, 'project');
  assert.equal(await c.page.evaluate(() => WH.store.project.plan.rooms.length), rooms);
  assert.deepEqual(c.errors, []);
  await close(c);
});

test('on a phone nothing overflows sideways and the main controls are reachable', async () => {
  const c = await open(`${origin}/index.html`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  assert.ok((await overflow(c.page)) <= 1, 'welcome screen');
  await demo(c.page);
  await c.page.waitForTimeout(600);
  assert.ok((await overflow(c.page)) <= 1, 'plan on a phone');
  await c.page.evaluate(() => WH.app.go('wifi'));
  await c.page.waitForTimeout(800);
  assert.ok((await overflow(c.page)) <= 1, 'Wi-Fi view on a phone');
  assert.deepEqual(c.errors, []);
  await close(c);
});

test('a browser storage that refuses to save is reported with a way out; recovery is announced', async () => {
  const c = await open(`${origin}/index.html`);
  await demo(c.page);
  await c.page.evaluate(() => {
    window.__setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('wifi-heatmap-v3')) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
      return window.__setItem.call(this, k, v);
    };
    WH.io.saveLocal(WH.store.project);
  });
  const toast = c.page.locator('.toast', { hasText: /NOT being saved/ });
  await toast.waitFor({ state: 'visible' });
  assert.ok(await toast.getByRole('button', { name: /Save project as SVG/ }).isVisible());
  // three ordinary toasts later the notice is still there (ordinary toasts are pushed out first)
  await c.page.evaluate(() => { for (let i = 0; i < 4; i++) WH.ui.toast('test toast ' + i, { kind: 'info' }); });
  await c.page.waitForTimeout(300);
  assert.ok(await toast.isVisible(), 'the "NOT being saved" notice survives newer toasts');
  await c.page.evaluate(() => { Storage.prototype.setItem = window.__setItem; WH.io.saveLocal(WH.store.project); });
  await c.page.locator('.toast', { hasText: /works again/ }).waitFor({ state: 'visible' });
  await close(c);
});

test('axe finds no serious accessibility problem on the welcome screen, the editor and the Wi-Fi view', async () => {
  const c = await open(`${origin}/index.html`);
  const scan = async (label) => {
    await c.page.addScriptTag({ path: AXE });
    const res = await c.page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    const bad = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    assert.deepEqual(bad, [], `${label}`);
  };
  await scan('welcome screen');
  await demo(c.page);
  await c.page.keyboard.press('1');
  await c.page.waitForTimeout(500);
  await scan('editor');
  await c.page.keyboard.press('2');
  await c.page.waitForTimeout(800);
  await scan('Wi-Fi view');
  await close(c);
});
