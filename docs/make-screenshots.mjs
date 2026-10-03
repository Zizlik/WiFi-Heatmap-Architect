#!/usr/bin/env node
/**
 * Captures the README screenshots from the real UI, using the built-in DEMO flat only (never a private floor plan).
 *
 *   npm install --no-save puppeteer-core      (once; package.json stays dependency-free)
 *   node build.mjs && node docs/make-screenshots.mjs [--lang=en|cs] [--dark] [--out=docs]
 *
 * Writes (next to this script unless --out is given):
 *   screenshot-wifi.png    1440x900  Wi-Fi mode after "Find the best spot"
 *   screenshot-editor.png  1440x900  Floor-plan mode
 *   screenshot-phone.png   390x844 viewport (2x pixels)  Wi-Fi mode on a phone
 *
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
const DARK = process.argv.includes('--dark');
const OUT = path.resolve(arg('out', HERE));
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
async function openDemo(browser, { width, height, dpr = 1, mobile = false }) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${(e && e.message) || e}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: DARK ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'load' });
  // fresh storage; no tour offer / getting-started checklist in the pictures; language fixed by the saved pref
  await page.evaluate((lang) => {
    localStorage.clear();
    localStorage.setItem('wifi-heatmap-prefs', JSON.stringify({ lang, tourOffered: true, tourDone: true, checklistDismissed: true }));
  }, LANG);
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

const clean = (page) => page.evaluate(() => {
  document.querySelectorAll('#toast-root .toast, .popover, .menu').forEach((n) => n.remove());
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});

async function findBestSpot(page) {
  await page.evaluate(() => document.getElementById('pl-find').click());
  await page.waitForFunction(() => WH.store.labels().undo === 'planner.undo.optimize', { timeout: 30000 }).catch(() => {
    throw new Error('"Find the best spot" did not finish within 30 s');
  });
  await sleep(900); // the fine heat map is drawn ~120 ms after the last change; give fonts/raster time to settle
}

async function shot(page, file) {
  await clean(page);
  await page.mouse.move(2, 2);
  await sleep(250);
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
  {
    const { page, problems } = await openDemo(browser, { width: 1440, height: 900 });
    await findBestSpot(page);
    await shot(page, 'screenshot-wifi.png');
    await page.evaluate(() => WH.views.go('editor'));
    await sleep(900);
    await shot(page, 'screenshot-editor.png');
    allProblems.push(...problems);
    await page.close();
  }
  {
    const { page, problems } = await openDemo(browser, { width: 390, height: 844, dpr: 2, mobile: true });
    await findBestSpot(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'screenshot-phone.png');
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
