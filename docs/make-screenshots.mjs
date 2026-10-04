#!/usr/bin/env node
/**
 * Captures the README screenshots from the real UI, using the built-in DEMO flat only (never a private floor plan).
 *
 *   npm install --no-save puppeteer-core      (once; package.json stays dependency-free)
 *   node build.mjs && node docs/make-screenshots.mjs [--lang=en|cs] [--out=docs] [--only=wifi,editor,guide,phone,dark]
 *
 * Writes (next to this script unless --out is given):
 *   screenshot-wifi.png    1440x900  Wi-Fi mode, every layer on: heat map in band mode Auto (Wi-Fi 7 router: 2.4 / 5 /
 *                                    6 GHz range lines), room values, walls, furniture, labels, five measured spots and
 *                                    a wired second access point, so every spot shows its predicted change ("→ +12")
 *   screenshot-editor.png  1440x900  Floor-plan mode: the showcase flat with a wall selected (its material and losses)
 *   screenshot-phone.png   390x844 viewport (2x pixels)  the measuring mode on a phone: the sheet of a new spot with the
 *                                    band question and "Změřit vše"
 *   screenshot-guide.png   1440x900  the "First measurement" guide: the suggested spots on the map, nothing measured yet
 *   screenshot-dark.png    1440x900  the same Wi-Fi scene as screenshot-wifi.png in the Deep dark theme: Signal view with
 *                                    the predicted change at every measured spot ("−61 → −48 (+13)")
 *
 * The measured spots are made up for the picture: the model's own prediction at each spot +-2 dB, with plausible speed
 * tests; no network name, BSSID or MAC address appears anywhere.
 * Chrome: env CHROME, else the default Windows / macOS / Linux install path. Every run uses a fresh, throw-away
 * browser profile and opens the built index.html / index.cs.html from the project root over file://.
 * puppeteer-core is looked up next to this project, then in the current directory, then in $PUPPETEER_CORE_DIR
 * (a folder whose node_modules contains it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const LANG = arg('lang', 'en') === 'cs' ? 'cs' : 'en';
const OUT = path.resolve(arg('out', HERE));
const ONLY = arg('only', '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const PAGE = path.join(ROOT, LANG === 'cs' ? 'index.cs.html' : 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = {
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  const hit = candidates.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('Chrome not found - set the CHROME environment variable to the browser executable.');
  return hit;
}

async function loadPuppeteer() {
  const bases = [path.join(ROOT, 'x.js'), path.join(process.cwd(), 'x.js')];
  if (process.env.PUPPETEER_CORE_DIR) bases.push(path.join(path.resolve(process.env.PUPPETEER_CORE_DIR), 'x.js'));
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve('puppeteer-core');
      const mod = await import(pathToFileURL(resolved).href);
      return mod.default && mod.default.launch ? mod.default : mod;
    } catch { /* try the next place */ }
  }
  throw new Error('puppeteer-core is not installed. Run: npm install --no-save puppeteer-core');
}

/** Open the built app with fresh storage and the demo flat; refuses to continue if anything but the demo is loaded. */
async function openDemo(browser, { width, height, dpr = 1, mobile = false, theme = 'light' }) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${(e && e.message) || e}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme === 'light' ? 'light' : 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'load' });
  // fresh storage; no tour offer / getting-started checklist in the pictures; language and theme fixed by the saved prefs
  await page.evaluate((lang, theme) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('wifi-heatmap-prefs', JSON.stringify({ lang, theme, tourOffered: true, tourDone: true, checklistDismissed: true }));
  }, LANG, theme);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#welcome-demo', { visible: true });
  await page.evaluate(() => document.getElementById('welcome-demo').click());
  await page.waitForFunction(() => window.WH && WH.views && WH.views.current === 'planner' && document.querySelector('#view-planner canvas'), { timeout: 15000 });
  const isDemo = await page.evaluate((lang) => {
    const demo = WH.engine.project.create({ template: 'demo', lang });
    const names = (p) => JSON.stringify(p.plan.rooms.map((r) => [r.name, r.points.length]));
    return names(WH.store.project) === names(demo) && !WH.store.project.plan.background;
  }, LANG);
  if (!isDemo) throw new Error('The loaded project is not the built-in demo flat - refusing to take screenshots.');
  await sleep(600);
  return { page, problems };
}

/**
 * The showcase scene: a Wi-Fi 7 router (2.4 + 5 + 6 GHz, band mode Auto), every layer on, measured spots in five rooms
 * (the model's prediction +-2 dB, speeds that fit the signal, the band each one was measured on - confirmed) and,
 * optionally, a wired access point in the bedroom so the dots show what it would change.
 */
const showcase = (page, { node = true } = {}) => page.evaluate((node) => {
  const E = WH.engine;
  const P = WH.store.project;
  const roomBy = (k) => P.plan.rooms[k];
  // rooms of the demo flat by their place in the plan (names differ between cs and en):
  // 0 living room + kitchen, 1 bedroom, 2 study, 3 bathroom, 4 WC, 5 hall, 6 balcony
  const spots = [
    // [room index, shift (m) from the room's label point, noise dB, band]
    [1, [0.9, 0.9], 1, 5],      // bedroom
    [2, [-0.4, 1.1], -2, 5],    // study
    [0, [0.2, 1.5], 2, 6],      // living room + kitchen, by the sofa
    [3, [0.1, 0.9], -1, 5],     // bathroom
    [5, [0.6, -0.5], 0, 6],     // hall, next to the router
  ];
  const mpp = P.scale.mpp;
  const { W, H } = E.CANVAS;   // normalized plan coordinates over the fixed 1080 x 942 canvas
  const ctx = E.model.createContext(P, { fit: false });
  const ms = [];
  WH.store.commit('Showcase', (p) => { p.net.routerBands = { '2.4': true, 5: true, 6: true }; p.view.band = 'auto'; }, ['net', 'view']);
  spots.forEach(([ri, [dx, dy], nz, band], k) => {
    const r = roomBy(ri);
    if (!r) return;
    const lp = E.geom.labelPoint(r.points);
    const q = WH.planner.insidePoint({ x: lp.x + dx / (W * mpp), y: lp.y + dy / (H * mpp) }, 0.45);
    const sig = Math.round(E.model.softSignal(ctx, P.net.baseline, q, band, 0) + nz);
    const down = Math.round(Math.max(20, Math.min(940, 1050 * Math.pow(10, (sig + 44) / 24))));
    ms.push({
      id: `demo-m${k + 1}`, x: Math.round(q.x * 1e6) / 1e6, y: Math.round(q.y * 1e6) / 1e6, band, value: sig, name: r.name,
      download: down, upload: Math.round(down * 0.34), device: P.goal.device, t: Date.UTC(2026, 9, 3, 18, k * 3),
      wifi: { ssid: null, bssid: null, channel: band === 6 ? 37 : 100, band, rxRate: null, txRate: null, radio: null, security: null },
    });
  });
  WH.store.commit('Showcase', (p) => {
    p.measurements = ms;
    // every map layer on, incl. "Body měření" + "Předpověď u bodů" (the dots and their "→ +12" labels)
    Object.assign(p.view, { layer: 'signal', ranges: true, values: true, walls: true, furniture: true, labels: true, points: true, whatif: true });
    if (node) {
      const bed = roomBy(1);
      const lp = E.geom.labelPoint(bed.points);
      p.node.mode = 'ap_cable';
      p.node.pos = E.project.nearestFloor(p.plan, WH.planner.insidePoint({ x: lp.x - 0.9 / (W * mpp), y: lp.y - 0.6 / (H * mpp) }, 0.5));
    }
  }, ['measurements', 'view', 'node']);
  return ms.length;
}, node);

const clean = (page) => page.evaluate(() => {
  document.querySelectorAll('#toast-root .toast, .popover, .menu, .tooltip, [role="tooltip"]').forEach((n) => n.remove());
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});

async function shot(page, file) {
  await clean(page);
  await page.mouse.move(2, 2);
  await sleep(300);
  const dest = path.join(OUT, file);
  await page.screenshot({ path: dest, type: 'png' });
  console.log(`wrote ${path.relative(process.cwd(), dest)}`);
}

if (!fs.existsSync(PAGE)) throw new Error(`${PAGE} not found - run node build.mjs first`);
fs.mkdirSync(OUT, { recursive: true });
const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files', '--hide-scrollbars'] });
const allProblems = [];
try {
  if (want('wifi') || want('editor')) {
    const { page, problems } = await openDemo(browser, { width: 1440, height: 900 });
    await showcase(page);
    await sleep(1500); // the fine heat map is drawn ~120 ms after the last change; give fonts / raster / labels time
    if (want('wifi')) await shot(page, 'screenshot-wifi.png');
    if (want('editor')) {
      await page.evaluate(() => WH.views.go('editor'));
      await sleep(800);
      // a wall selected: the inspector shows its material and the loss at 2.4 / 5 / 6 GHz
      // (the brick load-bearing spine between the bedrooms and the hall: the longest inner brick wall)
      await page.evaluate(() => {
        const ws = WH.store.project.plan.walls.filter((x) => x.material === 'brick' && Math.abs(x.a.y - x.b.y) < 1e-6 && x.a.y > 0.4 && x.a.y < 0.8);
        const w = ws.sort((a, b) => Math.abs(b.a.x - b.b.x) - Math.abs(a.a.x - a.b.x))[0];
        if (w) WH.editor.select(w.id);
      });
      await sleep(700);
      await shot(page, 'screenshot-editor.png');
    }
    allProblems.push(...problems);
    await page.close();
  }
  if (want('guide')) {
    // the "First measurement" guide on the demo flat: router confirmed, the numbered spots on the map
    const { page, problems } = await openDemo(browser, { width: 1440, height: 900 });
    const step = (f) => page.evaluate((f) => { const b = document.querySelector(`.pl-cw [data-f="${f}"]`); if (!b) throw new Error(`guide button ${f} missing`); b.click(); }, f);
    await page.evaluate(() => WH.planner.calib.open());
    await sleep(500);
    await step('yes');
    await sleep(400);
    await step('go');
    await sleep(1200);
    await shot(page, 'screenshot-guide.png');
    allProblems.push(...problems);
    await page.close();
  }
  if (want('phone')) {
    // the measuring mode on a phone: earlier spots on the map, the sheet of a new one (band answered, "Změřit vše")
    const { page, problems } = await openDemo(browser, { width: 390, height: 844, dpr: 2, mobile: true });
    await showcase(page, { node: false });
    await page.evaluate(() => { WH.planner.bands.choice.set(5); WH.planner.mm.enter(); });
    await sleep(900);
    await page.evaluate(() => {
      const r = WH.store.project.plan.rooms[0];
      const lp = WH.engine.geom.labelPoint(r.points);
      WH.planner.openMeasure(WH.planner.insidePoint({ x: lp.x - 0.05, y: lp.y - 0.06 }, 0.5));
    });
    await sleep(1000);
    await page.evaluate(() => { document.querySelectorAll('#toast-root .toast').forEach((n) => n.remove()); window.scrollTo(0, 0); });
    await page.mouse.move(2, 2);
    await sleep(300);
    const dest = path.join(OUT, 'screenshot-phone.png');
    await page.screenshot({ path: dest, type: 'png' });
    console.log(`wrote ${path.relative(process.cwd(), dest)}`);
    allProblems.push(...problems);
    await page.close();
  }
  if (want('dark')) {
    // Deep dark, the Signal view of the showcase scene: the wired AP's predicted change at every spot ("−61 → −48 (+13)")
    const { page, problems } = await openDemo(browser, { width: 1440, height: 900, theme: 'dark' });
    await showcase(page);
    const on = await page.evaluate(() => { const v = WH.store.project.view; return v.layer === 'signal' && v.points && v.whatif && WH.planner.wi.active(); });
    if (!on) throw new Error('dark shot: the Signal view with the predicted change at the points is not on');
    await sleep(1500);
    await shot(page, 'screenshot-dark.png');
    allProblems.push(...problems);
    await page.close();
  }
} finally {
  await browser.close();
}
if (allProblems.length) {
  console.error('The page reported errors while capturing:\n  ' + allProblems.join('\n  '));
  process.exit(1);
}
