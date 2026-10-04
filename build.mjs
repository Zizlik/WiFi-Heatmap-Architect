#!/usr/bin/env node
/**
 * WiFi Heatmap Architect - build script (Node >= 18, no dependencies).
 *
 *   node build.mjs              build index.cs.html (Czech default) and index.html (English default)
 *   node build.mjs --check      build, then verify the sources (see "Checks" below); exit code 1 on any error
 *   node build.mjs --dry        do not write the output files (combine with --check for a pure verification)
 *   node build.mjs --quiet      print only warnings and errors
 *
 * What it does
 *   1. reads src/template.html (must exist - fails loudly otherwise)
 *   2. inlines src/css/*.css in lexical file-name order and src/js/**\/*.js in lexical path order
 *      (files named *.test.* and anything starting with "_" or "." are skipped)
 *   3. fills the template placeholders {{LANG}} {{TITLE}} {{DESCRIPTION}} {{FAVICON}} {{CSS}} {{JS}} {{BUILD}}
 *      ({{BUILD}} = window.WH_BUILD: a short hash of the bundle + the HTML line where every src/js file starts, so the
 *      error diary (src/js/00-core/diag.js) can name the source file of a stack frame inside the one inline script)
 *   4. escapes "</script" inside the JS so the inline <script> cannot be terminated early
 *   5. writes the two self-contained files next to this script
 *   6. PWA (SPEC 6.3): writes sw.js (from src/pwa/sw.js) and manifest.webmanifest (from src/pwa/manifest.webmanifest)
 *      next to them. The service worker's cache version is a short SHA-256 of everything it precaches (both HTML
 *      outputs, the manifest and the icons in assets/), so every change of the app ships a new cache and the running
 *      app shows "a new version is available". The icons are committed PNGs (rendered once from the brand SVG), so
 *      this script stays dependency-free. With --out=<dir> the icons are copied into <dir>/assets as well.
 *
 * Checks (--check)
 *   - the JS bundle parses (syntax errors are reported with the offending file)
 *   - no external URLs: http(s):// may appear only as XML namespaces or as plain-text help links inside strings*.js;
 *     the one exception is https://speed.cloudflare.com/ (+ fetch/XMLHttpRequest) inside src/js/35-speedtest/ - the
 *     speed test the user starts on purpose (SPEC 6.1); and the optional local Wi-Fi helper http://127.0.0.1:47823
 *     (+ fetch) inside src/js/36-devinfo/ and src/js/50-planner/26-* - a loopback-only program from pomocnik/ that the
 *     user starts on purpose (SPEC 8.1, 8.2)
 *   - PWA: manifest is valid JSON with the installability basics (name, start_url inside scope, standalone, 192 + 512 +
 *     maskable icons whose PNG sizes match), sw.js parses, the written sw.js carries the current cache version (with
 *     --dry this catches stale committed files; a --dry --out=<scratch> check has nothing on disk to compare and skips
 *     that part), the template never links the manifest itself (JS adds it on http(s)
 *     only, so file:// makes no request)
 *   - every data-i18n* / data-tip / data-hint key used in template.html exists in BOTH languages
 *   - the cs and en dictionaries have the same keys and the same {placeholders}; plural forms are well-formed
 *   - every mandatory hint key (SPEC 1.7) has a title and body in both languages
 *   - literal i18n keys used in JS exist in both languages (warning only: keys may be built dynamically)
 *   - the two Deep dark token blocks in 00-tokens.css are identical and the OLED block declares the same properties
 *   - template has no duplicate ids and contains the DOM contract ids
 *   - built files are <= 2.5 MB (readable, unminified code on purpose: this is a local app opened from disk, so a
 *     minifier would buy nothing but harder debugging)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const TEMPLATE = path.join(SRC, 'template.html');
const PWA_SRC = path.join(SRC, 'pwa');
const SIZE_LIMIT = 2.5 * 1024 * 1024; // 2.5 MB per built file (SPEC 0.10, raised from 2 MB in stage 9); no minifier by design

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const DRY = args.has('--dry');
const QUIET = args.has('--quiet');
// Dev-only isolation: `--out=<dir>` writes the two HTML files elsewhere (e.g. a QA scratch dir) instead of the
// project root; `--exclude=<substr>[,<substr>…]` leaves out every src file whose path contains one of the substrings
// (e.g. `--exclude=50-planner` lets the editor be built while the planner is still half-written).
const argValue = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; };
const OUT_DIR = argValue('out') ? path.resolve(argValue('out')) : '';
const EXCLUDE = argValue('exclude').split(',').map((s) => s.trim()).filter(Boolean);

/** Per-language page metadata. */
const VARIANTS = [
  {
    lang: 'cs',
    file: 'index.cs.html',
    title: 'WiFi Heatmap Architect',
    description: 'Plánovač pokrytí Wi-Fi: nakresli půdorys, přesuň router a hned uvidíš, kde je signál dobrý. Výpočty běží ve tvém prohlížeči.',
  },
  {
    lang: 'en',
    file: 'index.html',
    title: 'WiFi Heatmap Architect',
    description: 'Wi-Fi coverage planner: draw your floor plan, move the router and instantly see where the signal is good. Calculations run in your browser.',
  },
];

/** PWA files (SPEC 6.3). Icons are committed PNGs; `purpose`/`sizes` must match the manifest. */
const PWA_ICONS = [
  { file: 'assets/icon-192.png', size: 192, purpose: 'any' },
  { file: 'assets/icon-512.png', size: 512, purpose: 'any' },
  { file: 'assets/icon-maskable-512.png', size: 512, purpose: 'maskable' },
  { file: 'assets/apple-touch-icon.png', size: 180, purpose: 'apple' },
];
const SW_FILE = 'sw.js';
const MANIFEST_FILE = 'manifest.webmanifest';

/** The one external origin the app may talk to, and only from the speed-test module (SPEC 6.1). */
const SPEEDTEST_DIR = 'src/js/35-speedtest/';
const SPEEDTEST_ORIGIN = 'https://speed.cloudflare.com';
/** The optional local Wi-Fi helper (pomocnik/, SPEC 8.1/8.2): loopback only, probed only when the user measures. */
const HELPER_ORIGIN = 'http://127.0.0.1:47823';
const HELPER_FILE = /^src\/js\/(?:36-devinfo\/|50-planner\/26-[^/]*$)/;

/** Hint keys every build must ship in both languages (SPEC 1.7). */
const MANDATORY_HINTS = [
  'estimate', 'dbm', 'quality', 'band', 'band24', 'band5', 'band6', 'threshold', 'coverage', 'avgSignal', 'target', 'today', 'trial', 'baseline',
  'inlet', 'cable', 'optimize', 'allowedArea', 'nearSignal', 'decay', 'wallLoss', 'scale', 'calibration', 'measurement', 'residual', 'device',
  'speedView', 'diffView', 'speedTarget', 'reserve', 'plan', 'wan', 'wanPort', 'ontPort', 'link', 'cableCategory', 'secondAp', 'apCable',
  'meshCable', 'meshWifi', 'repeater', 'backhaul', 'power', 'ranges', 'rangeThreshold', 'wallMaterial', 'doorLoss', 'furnitureLoss',
  'blocksSignal', 'snap', 'trace', 'autoWalls', 'roomsCount', 'palette', 'p10',
];

/** http(s):// strings that are allowed anywhere (XML namespaces are identifiers, never fetched). */
const NAMESPACE_URLS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/XML/1998/namespace',
]);

/** Files that only call WH.i18n.add(): strings.js, strings-help.js, 99-strings.js ... */
const STRINGS_FILE = /(^|\/)(?:\d+-)?strings[^/]*\.js$/;

const errors = [];
const warnings = [];
const log = (...a) => { if (!QUIET) console.log(...a); };
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

// -------------------------------------------------------------------------------------------------------------------
// file helpers
// -------------------------------------------------------------------------------------------------------------------

/** Recursively list files below `dir` (relative posix paths), sorted by code point so the order is identical on every OS. */
function walk(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_') || ent.name === 'node_modules') continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');

function listSources() {
  const cssDir = path.join(SRC, 'css');
  const jsDir = path.join(SRC, 'js');
  const css = fs.existsSync(cssDir)
    ? walk(cssDir).filter((f) => f.endsWith('.css') && !f.includes('/') && !/\.test\./.test(f)).map((f) => ({ rel: `src/css/${f}`, abs: path.join(cssDir, f) }))
    : [];
  const js = fs.existsSync(jsDir)
    ? walk(jsDir).filter((f) => f.endsWith('.js') && !/\.test\./.test(f)).map((f) => ({ rel: `src/js/${f}`, abs: path.join(jsDir, f) }))
    : [];
  const keep = (f) => !EXCLUDE.some((s) => f.rel.includes(s));
  return { css: css.filter(keep), js: js.filter(keep) };
}

function faviconDataUri() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0f766e"/>'
    + '<path d="M7.5 13.2a12.5 12.5 0 0 1 17 0M11 17.1a7.6 7.6 0 0 1 10 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'
    + '<circle cx="16" cy="22" r="2.2" fill="#fff"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// -------------------------------------------------------------------------------------------------------------------
// build
// -------------------------------------------------------------------------------------------------------------------

function bundle() {
  if (!fs.existsSync(TEMPLATE)) {
    console.error(`build.mjs: template not found: ${path.relative(ROOT, TEMPLATE)}`);
    process.exit(2);
  }
  const template = read(TEMPLATE);
  const { css, js } = listSources();
  if (!css.length) fail('no CSS files found in src/css');
  if (!js.length) fail('no JS files found in src/js');

  const cssParts = css.map((f) => `/* ===== ${f.rel} ===== */\n${read(f.abs).trim()}\n`);
  const jsParts = js.map((f) => `/* ===== ${f.rel} ===== */\n${read(f.abs).trim()}\n`);

  let cssText = cssParts.join('\n');
  if (/<\/style/i.test(cssText)) fail('CSS contains "</style" which would end the inline <style> block');
  // A literal "</script" inside JS (even in a string or regex) would terminate the inline <script>; "<\/script" is
  // equivalent in every JS context where it can legally occur.
  const jsText = jsParts.join('\n').replace(/<\/(script)/gi, '<\\/$1');
  if (/<!--/.test(jsText)) fail('JS bundle contains "<!--" (HTML comment opener inside an inline script is unsafe)');

  return { template, cssText, jsText, css, js };
}

/** Short, deterministic id of the bundle (same for both languages): changes whenever any CSS / JS / template byte does. */
function buildHash(b) {
  return crypto.createHash('sha256').update(b.template).update('\0').update(b.cssText).update('\0').update(b.jsText).digest('hex').slice(0, 10);
}

/**
 * window.WH_BUILD for one output: {v: hash, files: [[line, 'src/js/...'], ...]} - `line` is the 1-based line of the
 * "/* ===== src/js/... ===== *\/" marker in the final HTML (the file's own line n is HTML line `line + n`). Rendered
 * in two passes: first with a one-line placeholder, then the JSON (also one line), so no line number moves.
 */
function buildInfo(html, hash) {
  const files = [];
  const lines = html.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\/\* ===== (src\/js\/[^ ]+) ===== \*\/$/.exec(lines[i]);
    if (m) files.push([i + 1, m[1]]);
  }
  return JSON.stringify({ v: hash, files }).replace(/</g, '\\u003c');
}

function render(b, v) {
  const map = {
    LANG: v.lang,
    TITLE: escAttr(v.title),
    DESCRIPTION: escAttr(v.description),
    FAVICON: faviconDataUri(),
    CSS: b.cssText,
    JS: b.jsText,
  };
  let html = b.template;
  // {{BUILD}} last: its value depends on where the other placeholders put the JS
  for (const [k, val] of Object.entries(map)) html = html.split(`{{${k}}}`).join(val);
  if (html.includes('{{BUILD}}')) html = html.split('{{BUILD}}').join(buildInfo(html.split('{{BUILD}}').join('null'), buildHash(b)));
  const left = html.match(/\{\{[A-Z]+\}\}/g);
  if (left) fail(`unreplaced template placeholders in ${v.file}: ${[...new Set(left)].join(', ')}`);
  return html;
}

// -------------------------------------------------------------------------------------------------------------------
// checks
// -------------------------------------------------------------------------------------------------------------------

/** Run every src/js/**\/strings*.js file in a sandbox with a stub WH.i18n.add and collect the dictionaries. */
function loadDictionaries(jsFiles) {
  const dicts = { cs: {}, en: {} };
  const owners = { cs: {}, en: {} };
  for (const f of jsFiles) {
    // strings*.js + the engine's own dictionary (10-engine/99-strings.js mirrors its engine.* / err.* keys into WH.i18n)
    if (!/(^|\/)strings[^/]*\.js$/.test(f.rel) && f.rel !== 'src/js/10-engine/99-strings.js') continue;
    const sandbox = { console };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    let current = f.rel;
    sandbox.WH = {
      i18n: {
        add(lang, dict) {
          if (!dicts[lang]) { fail(`${current}: unknown language "${lang}" passed to WH.i18n.add`); return; }
          if (!dict || typeof dict !== 'object') { fail(`${current}: WH.i18n.add(${lang}, ...) needs an object`); return; }
          for (const [k, val] of Object.entries(dict)) {
            if (typeof val !== 'string') fail(`${current}: [${lang}] "${k}" is not a string`);
            if (k in dicts[lang]) warn(`${current}: [${lang}] "${k}" is already defined in ${owners[lang][k]} (the later definition wins)`);
            dicts[lang][k] = val;
            owners[lang][k] = current;
          }
        },
      },
      engine: { text: { add() {} } },
    };
    try {
      vm.runInContext(read(f.abs), sandbox, { filename: f.rel, timeout: 2000 });
    } catch (e) {
      fail(`${f.rel}: cannot be evaluated with a stub WH.i18n (${e.message}). Strings files must only call WH.i18n.add().`);
    }
  }
  return dicts;
}

const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;
const baseKey = (k) => k.replace(PLURAL_SUFFIX, '');
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

function checkDictionaries(dicts) {
  const csKeys = Object.keys(dicts.cs);
  const enKeys = Object.keys(dicts.en);
  const csBase = new Set(csKeys.map(baseKey));
  const enBase = new Set(enKeys.map(baseKey));
  for (const k of csBase) if (!enBase.has(k)) fail(`i18n: key "${k}" exists in cs but not in en`);
  for (const k of enBase) if (!csBase.has(k)) fail(`i18n: key "${k}" exists in en but not in cs`);

  // plural families
  const fam = (keys) => {
    const m = new Map();
    for (const k of keys) {
      if (!PLURAL_SUFFIX.test(k)) continue;
      const b = baseKey(k);
      if (!m.has(b)) m.set(b, new Set());
      m.get(b).add(k.slice(b.length + 1));
    }
    return m;
  };
  for (const [b, forms] of fam(csKeys)) for (const need of ['one', 'few', 'other']) if (!forms.has(need)) fail(`i18n: cs plural "${b}" lacks .${need}`);
  for (const [b, forms] of fam(enKeys)) for (const need of ['one', 'other']) if (!forms.has(need)) fail(`i18n: en plural "${b}" lacks .${need}`);

  // identical placeholders for keys present in both
  for (const k of csKeys) {
    if (k in dicts.en && placeholders(dicts.cs[k]) !== placeholders(dicts.en[k])) {
      warn(`i18n: placeholders differ for "${k}": cs {${placeholders(dicts.cs[k])}} vs en {${placeholders(dicts.en[k])}}`);
    }
  }
  // empty strings
  for (const lang of ['cs', 'en']) for (const [k, val] of Object.entries(dicts[lang])) if (!String(val).trim()) fail(`i18n: [${lang}] "${k}" is empty`);

  // mandatory hints
  for (const h of MANDATORY_HINTS) {
    for (const lang of ['cs', 'en']) {
      if (!dicts[lang][`help.${h}.t`]) fail(`hint: help.${h}.t missing in ${lang}`);
      if (!dicts[lang][`help.${h}.b`]) fail(`hint: help.${h}.b missing in ${lang}`);
    }
  }
  // every help.<k>.t needs a .b
  for (const lang of ['cs', 'en']) {
    for (const k of Object.keys(dicts[lang])) {
      const m = /^help\.([^.]+)\.t$/.exec(k);
      if (m && !dicts[lang][`help.${m[1]}.b`]) fail(`hint: help.${m[1]}.b missing in ${lang}`);
    }
  }
}

function hasKey(dicts, lang, key) {
  const d = dicts[lang];
  return key in d || `${key}.other` in d || `${key}.one` in d;
}

function checkTemplate(template, dicts) {
  const needKey = (key, where) => {
    for (const lang of ['cs', 'en']) if (!hasKey(dicts, lang, key)) fail(`template: key "${key}" (${where}) is missing in ${lang}`);
  };
  for (const m of template.matchAll(/\bdata-i18n(?:-html|-title|-aria|-ph)?="([^"]+)"/g)) needKey(m[1], 'data-i18n');
  for (const m of template.matchAll(/\bdata-tip="([^"]+)"/g)) needKey(m[1], 'data-tip');
  for (const m of template.matchAll(/\bdata-hint="([^"]+)"/g)) {
    needKey(`help.${m[1]}.t`, 'data-hint');
    needKey(`help.${m[1]}.b`, 'data-hint');
  }
  // ids
  const ids = [...template.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const id of ids) { if (seen.has(id)) fail(`template: duplicate id "${id}"`); seen.add(id); }
  for (const id of ['app-header', 'mode-plan', 'mode-wifi', 'app-main', 'view-planner', 'view-editor', 'welcome', 'overlay-root', 'sr-live', 'toast-root']) {
    if (!seen.has(id)) fail(`template: required id "${id}" is missing`);
  }
}

/** Crude comment stripper (good enough for scanning keys; keeps strings that contain // such as URLs untouched when preceded by a colon). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

/** Literal keys in JS: t('a.b'), i18n:'a.b', data-i18n="a.b", tip(el,'a.b'), hint('x'). Warnings only (keys can be dynamic). */
function checkJsKeys(jsFiles, dicts) {
  const keyRe = /^[a-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;
  const found = new Map();
  const add = (key, rel) => { if (keyRe.test(key)) { if (!found.has(key)) found.set(key, new Set()); found.get(key).add(rel); } };
  for (const f of jsFiles) {
    if (STRINGS_FILE.test(f.rel)) continue;
    const src = stripComments(read(f.abs));
    for (const m of src.matchAll(/\b(?:t|tt|i18nT)\(\s*(['"`])([A-Za-z][\w.-]*)\1/g)) add(m[2], f.rel);
    for (const m of src.matchAll(/\b(?:i18n|titleKey|labelKey|textKey|bodyKey|tip|title|body|label|ok|cancel)\s*:\s*(['"])([a-z][\w-]*\.[\w.-]+)\1/g)) add(m[2], f.rel);
    for (const m of src.matchAll(/data-(?:i18n(?:-html|-title|-aria|-ph)?|tip)=\\?"([a-z][\w.-]*\.[\w.-]+)\\?"/g)) add(m[1], f.rel);
    for (const m of src.matchAll(/\.tip\(\s*[^,()]+,\s*(['"])([a-z][\w-]*\.[\w.-]+)\1/g)) add(m[2], f.rel);
    for (const m of src.matchAll(/\bhint\(\s*(['"])(\w+)\1/g)) { add(`help.${m[2]}.t`, f.rel); add(`help.${m[2]}.b`, f.rel); }
    for (const m of src.matchAll(/data-hint=\\?"(\w+)\\?"/g)) { add(`help.${m[1]}.t`, f.rel); add(`help.${m[1]}.b`, f.rel); }
  }
  for (const [key, files] of found) {
    for (const lang of ['cs', 'en']) {
      if (!hasKey(dicts, lang, key)) warn(`js: literal i18n key "${key}" is missing in ${lang} (used in ${[...files].join(', ')})`);
    }
  }
}

/** True for a URL of the speed-test origin used from a file inside src/js/35-speedtest/ (the only allowed network use). */
const isSpeedtestFile = (rel) => rel.startsWith(SPEEDTEST_DIR);
const isSpeedtestUrl = (url) => url === SPEEDTEST_ORIGIN || url.startsWith(`${SPEEDTEST_ORIGIN}/`);
/** True for the loopback Wi-Fi helper URL used from src/js/36-devinfo/ or src/js/50-planner/26-* (SPEC 8.1). */
const isHelperFile = (rel) => HELPER_FILE.test(rel);
const isHelperUrl = (url) => url === HELPER_ORIGIN || url.startsWith(`${HELPER_ORIGIN}/`);

function checkExternalUrls(template, cssFiles, jsFiles, outputs) {
  const urlRe = /https?:\/\/[^\s"'`<>)\\\]}]+/g;
  const scan = (text, rel, allowHelp) => {
    for (const m of text.matchAll(urlRe)) {
      const url = m[0].replace(/[.,;:]+$/, '');
      if (NAMESPACE_URLS.has(url)) continue;
      if (isSpeedtestFile(rel) && isSpeedtestUrl(url)) { log(`  speed-test endpoint (allow-listed): ${url}  [${rel}]`); continue; }
      if (isHelperFile(rel) && isHelperUrl(url)) { log(`  local Wi-Fi helper (allow-listed, loopback): ${url}  [${rel}]`); continue; }
      if (allowHelp) { log(`  help link (plain text): ${url}  [${rel}]`); continue; }
      fail(`external URL in ${rel}: ${url}`);
    }
  };
  scan(template, 'src/template.html', false);
  for (const f of cssFiles) scan(read(f.abs), f.rel, false);
  for (const f of jsFiles) scan(read(f.abs), f.rel, STRINGS_FILE.test(f.rel));

  for (const { file, html } of outputs) {
    // look at the markup only: <style> and <script> bodies are checked from their sources
    const markup = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
    if (/<(?:script|img|iframe|source|video|audio|embed)\b[^>]*\ssrc\s*=\s*["']?(?:https?:)?\/\//i.test(markup)) fail(`${file}: external src= found`);
    if (/<link\b[^>]*\shref\s*=\s*["']?(?:https?:)?\/\//i.test(markup)) fail(`${file}: external <link href> found`);
    if (/<script\b[^>]*\ssrc\s*=/i.test(html.replace(/<script>[\s\S]*?<\/script>/gi, '<script></script>'))) fail(`${file}: <script src> found (everything must be inline)`);
  }
  for (const f of cssFiles) {
    const css = read(f.abs);
    if (/@import\b/i.test(css)) fail(`${f.rel}: CSS @import found`);
    if (/url\(\s*["']?(?:https?:)?\/\//i.test(css)) fail(`${f.rel}: CSS url() pointing outside found`);
  }
  for (const f of jsFiles) {
    const s = stripComments(read(f.abs));
    // The speed test (and only it) may use fetch/XMLHttpRequest - against the allow-listed origin checked above.
    const speed = isSpeedtestFile(f.rel);
    if (/\bnavigator\.sendBeacon\b|\bWebSocket\b|\bEventSource\b|\bimportScripts\b/.test(s)) fail(`${f.rel}: uses a network API (the app must stay offline)`);
    if (!speed && /\bXMLHttpRequest\b/.test(s)) fail(`${f.rel}: uses XMLHttpRequest (only ${SPEEDTEST_DIR} may talk to the network)`);
    // ... and the device-info module may fetch() the loopback Wi-Fi helper (its only allowed URL, checked above).
    if (!speed && !isHelperFile(f.rel) && /\bfetch\s*\(/.test(s)) fail(`${f.rel}: uses fetch() (only ${SPEEDTEST_DIR} and the Wi-Fi helper probe may talk to the network)`);
    // the service worker is registered in exactly one place, which guards it to http(s) (never file://)
    if (/\bserviceWorker\s*\.\s*register\b/.test(s) && f.rel !== 'src/js/20-ui/pwa.js') fail(`${f.rel}: registers a service worker (only src/js/20-ui/pwa.js may)`);
  }
}

/** The two Deep dark blocks in 00-tokens.css must be identical; the OLED block must declare the same custom properties. */
function checkDarkTokens() {
  const p = path.join(SRC, 'css', '00-tokens.css');
  if (!fs.existsSync(p)) { fail('src/css/00-tokens.css is missing'); return; }
  const css = read(p);
  const decls = (block) => block.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).sort().join(';');
  const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}\s*\}/.exec(css);
  const attr = /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css);
  const oled = /:root\[data-theme="oled"\] \{([\s\S]*?)\n\}/.exec(css);
  if (!media || !attr) { fail('00-tokens.css: dark theme blocks not found in the expected form'); return; }
  if (!oled) fail('00-tokens.css: the OLED block (:root[data-theme="oled"]) is missing (SPEC 12)');
  const a = decls(media[1]);
  const b = decls(attr[1]);
  if (a !== b) {
    const as = new Set(a.split(';'));
    const bs = new Set(b.split(';'));
    const diff = [...as].filter((x) => !bs.has(x)).concat([...bs].filter((x) => !as.has(x)));
    fail(`00-tokens.css: the two dark blocks differ: ${diff.slice(0, 4).join(' | ')}${diff.length > 4 ? ' ...' : ''}`);
  }
  // OLED: the same set of properties as Deep dark (values differ) - a missing one would leak the Deep dark value
  // through the media block on a dark OS, or the light value on a light OS
  if (oled) {
    const names = (block) => new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).concat(/color-scheme\s*:/.test(block) ? ['color-scheme'] : []));
    const dn = names(attr[1]);
    const on = names(oled[1]);
    const miss = [...dn].filter((n) => !on.has(n));
    const extra = [...on].filter((n) => !dn.has(n));
    if (miss.length || extra.length) fail(`00-tokens.css: the OLED block differs from Deep dark in its properties: ${miss.map((n) => `missing ${n}`).concat(extra.map((n) => `extra ${n}`)).slice(0, 6).join(', ')}`);
  }
  // every custom property overridden in dark must exist in light
  const lightNames = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  for (const m of media[1].matchAll(/(--[\w-]+):/g)) if (!lightNames.has(m[1])) fail(`00-tokens.css: ${m[1]} is set in dark but never declared`);
}

function checkSyntax(jsFiles, jsText) {
  // Per-file first so the message names the culprit, then the bundle as a whole.
  for (const f of jsFiles) {
    try { new vm.Script(read(f.abs), { filename: f.rel }); } catch (e) { fail(`syntax error in ${f.rel}: ${e.message}`); }
  }
  try { new vm.Script(jsText, { filename: 'bundle.js' }); } catch (e) { fail(`syntax error in the bundle: ${e.message}`); }
}

/**
 * SPEC 1.8.1: icons are inline SVG from WH.ui.icon(), never Unicode glyphs / emoji (they render differently per OS and font).
 * Geometric shapes, dingbats, arrows-in-symbols blocks and emoji are refused in the template, CSS and non-string JS.
 * (Help/toast copy in strings*.js may still contain an emoji.)
 */
function checkGlyphIcons(template, cssFiles, jsFiles) {
  const GLYPH = /[■-◿☀-➿⬀-⯿\u{1F300}-\u{1FAFF}️]/u;
  const scan = (text, rel) => {
    const m = GLYPH.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      fail(`${rel}:${line}: Unicode glyph "${m[0]}" (U+${m[0].codePointAt(0).toString(16).toUpperCase()}) - use WH.ui.icon() instead`);
    }
  };
  scan(template, 'src/template.html');
  for (const f of cssFiles) scan(stripComments(read(f.abs)), f.rel);
  for (const f of jsFiles) if (!STRINGS_FILE.test(f.rel)) scan(stripComments(read(f.abs)), f.rel);
}

// -------------------------------------------------------------------------------------------------------------------
// PWA: service worker + web app manifest (SPEC 6.3)
// -------------------------------------------------------------------------------------------------------------------

/** Width/height of a PNG from its IHDR chunk, or null when the buffer is not a PNG. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * Build the two PWA files from src/pwa. The cache version hashes every precached byte (HTML outputs, manifest, icons),
 * in a fixed order, so it is identical on every OS and changes whenever anything the worker serves changes.
 */
function buildPwa(outputs) {
  const swPath = path.join(PWA_SRC, 'sw.js');
  const manPath = path.join(PWA_SRC, 'manifest.webmanifest');
  if (!fs.existsSync(swPath) || !fs.existsSync(manPath)) {
    fail(`PWA sources missing: ${path.relative(ROOT, swPath)} and ${path.relative(ROOT, manPath)} are required`);
    return null;
  }
  let manifest = null;
  try { manifest = JSON.parse(read(manPath)); } catch (e) { fail(`src/pwa/manifest.webmanifest is not valid JSON: ${e.message}`); return null; }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const icons = PWA_ICONS.map((i) => {
    const abs = path.join(ROOT, i.file);
    return { ...i, abs, buf: fs.existsSync(abs) ? fs.readFileSync(abs) : null };
  });
  for (const i of icons) if (!i.buf) fail(`PWA icon missing: ${i.file} (render it from the brand SVG, see README "Development")`);

  const h = crypto.createHash('sha256');
  for (const o of outputs) h.update(`${o.file}\0`).update(o.html).update('\0');
  h.update(`${MANIFEST_FILE}\0`).update(manifestText).update('\0');
  for (const i of icons) h.update(`${i.file}\0`).update(i.buf || '').update('\0');
  const version = h.digest('hex').slice(0, 10);

  const precache = [...outputs.map((o) => o.file), MANIFEST_FILE, ...icons.map((i) => i.file)];
  const swSrc = read(swPath);
  if (!swSrc.includes('{{VERSION}}') || !swSrc.includes('{{PRECACHE}}')) fail('src/pwa/sw.js must contain the {{VERSION}} and {{PRECACHE}} placeholders');
  const sw = swSrc.split('{{VERSION}}').join(version).split('{{PRECACHE}}').join(JSON.stringify(precache));
  return { version, sw, manifest, manifestText, icons, precache };
}

function writePwa(pwa) {
  const dir = OUT_DIR || ROOT;
  fs.writeFileSync(path.join(dir, SW_FILE), pwa.sw, 'utf8');
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), pwa.manifestText, 'utf8');
  if (OUT_DIR) {
    // an isolated build must be servable on its own (QA over http), so it gets its own copy of the icons
    for (const i of pwa.icons) {
      if (!i.buf) continue;
      const dest = path.join(OUT_DIR, i.file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, i.buf);
    }
  }
}

function checkPwa(pwa, template) {
  if (!pwa) return;
  const m = pwa.manifest;
  const need = (cond, msg) => { if (!cond) fail(`manifest.webmanifest: ${msg}`); };
  need(typeof m.name === 'string' && m.name.trim(), '"name" is required');
  need(typeof m.short_name === 'string' && m.short_name.trim() && m.short_name.length <= 15, '"short_name" is required (<= 15 characters, it sits under the home-screen icon)');
  need(['standalone', 'fullscreen', 'minimal-ui'].includes(m.display), '"display" must be standalone (or fullscreen / minimal-ui) to be installable');
  for (const k of ['theme_color', 'background_color']) need(/^#[0-9a-f]{6}$/i.test(m[k] || ''), `"${k}" must be a #rrggbb colour`);
  // start_url and scope are relative to the manifest URL; the start page must lie inside the scope
  try {
    const base = 'https://example.test/app/manifest.webmanifest';
    const start = new URL(m.start_url, base).href;
    const scope = new URL(m.scope || './', base).href;
    need(typeof m.start_url === 'string', '"start_url" is required');
    need(start.startsWith(scope), `start_url (${m.start_url}) must be inside scope (${m.scope})`);
    need(new URL(start).origin === 'https://example.test' && new URL(scope).origin === 'https://example.test', 'start_url and scope must be relative (the app also runs from a sub-path, e.g. GitHub Pages)');
  } catch (e) { fail(`manifest.webmanifest: start_url / scope cannot be resolved (${e.message})`); }
  const list = Array.isArray(m.icons) ? m.icons : [];
  need(list.length, '"icons" is required');
  for (const ic of list) {
    const local = PWA_ICONS.find((i) => i.file === ic.src);
    need(local, `icon ${ic.src} is not one of the build's PWA icons (${PWA_ICONS.map((i) => i.file).join(', ')})`);
    if (!local) continue;
    const icon = pwa.icons.find((i) => i.file === ic.src);
    const dim = pngSize(icon && icon.buf);
    need(ic.type === 'image/png', `icon ${ic.src} needs "type": "image/png"`);
    need(dim && ic.sizes === `${dim.w}x${dim.h}` && dim.w === local.size && dim.h === local.size, `icon ${ic.src}: "sizes" ${ic.sizes} does not match the PNG (${dim ? `${dim.w}x${dim.h}` : 'not a PNG'})`);
  }
  const has = (size, purpose) => list.some((ic) => ic.sizes === `${size}x${size}` && String(ic.purpose || 'any').split(/\s+/).includes(purpose));
  need(has(192, 'any') && has(512, 'any'), 'installable apps need a 192x192 and a 512x512 icon (purpose "any")');
  need(has(512, 'maskable'), 'a 512x512 maskable icon is expected (Android adaptive icons)');
  const apple = pwa.icons.find((i) => i.purpose === 'apple');
  const ad = pngSize(apple && apple.buf);
  if (!ad || ad.w !== 180 || ad.h !== 180) fail(`${apple ? apple.file : 'apple-touch-icon'} must be a 180x180 PNG`);

  // the worker: valid classic script, every precached file exists, and the written copy is current
  try { new vm.Script(pwa.sw, { filename: SW_FILE }); } catch (e) { fail(`${SW_FILE}: syntax error: ${e.message}`); }
  const dir = OUT_DIR || ROOT;
  for (const f of pwa.precache) if (!fs.existsSync(path.join(dir, f)) && !DRY) fail(`${SW_FILE} precaches ${f}, which is missing in ${path.relative(ROOT, dir) || '.'}`);
  // a dry check into a scratch --out folder writes nothing there, so there is no on-disk copy to be stale: the
  // staleness check only guards the committed files next to build.mjs (and a written --out build)
  if (DRY && OUT_DIR) { log(`  pwa: dry run into ${path.relative(ROOT, OUT_DIR) || OUT_DIR} - on-disk ${SW_FILE} / ${MANIFEST_FILE} not compared`); }
  else checkPwaOnDisk(pwa, dir);

  // file:// must never request the manifest or touch the worker: both are added by JS on http(s) only
  if (/<link\b[^>]*\brel\s*=\s*["']?(?:manifest|apple-touch-icon)\b/i.test(template)) fail('template.html must not link the manifest / apple-touch-icon itself (src/js/20-ui/pwa.js adds them on http(s) only)');
}

/** The written sw.js / manifest in `dir` carry the current cache version and manifest text. */
function checkPwaOnDisk(pwa, dir) {
  const onDisk = path.join(dir, SW_FILE);
  if (!fs.existsSync(onDisk)) fail(`${SW_FILE} is missing - run node build.mjs`);
  else {
    const mv = /const VERSION = '([0-9a-f]+)'/.exec(read(onDisk));
    if (!mv || mv[1] !== pwa.version) fail(`${SW_FILE} is stale (cache version ${mv ? mv[1] : '?'} != ${pwa.version}) - run node build.mjs`);
  }
  const manDisk = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manDisk)) fail(`${MANIFEST_FILE} is missing - run node build.mjs`);
  else if (read(manDisk) !== pwa.manifestText) fail(`${MANIFEST_FILE} is stale - run node build.mjs`);
}

// -------------------------------------------------------------------------------------------------------------------
// main
// -------------------------------------------------------------------------------------------------------------------

const t0 = Date.now();
const b = bundle();
const outputs = VARIANTS.map((v) => ({ ...v, html: render(b, v) }));

for (const o of outputs) {
  const bytes = Buffer.byteLength(o.html, 'utf8');
  const gz = zlib.gzipSync(o.html).length;
  o.bytes = bytes;
  if (bytes > SIZE_LIMIT) {
    (CHECK ? fail : warn)(`${o.file} is ${(bytes / 1024).toFixed(0)} KB, limit is ${SIZE_LIMIT / 1024} KB`);
  }
  if (!DRY) {
    if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR || ROOT, o.file), o.html, 'utf8');
  }
  log(`${DRY ? 'built (not written)' : 'wrote'} ${o.file.padEnd(14)} ${(bytes / 1024).toFixed(1).padStart(7)} KB  (${(gz / 1024).toFixed(1)} KB gzip)  lang=${o.lang}`);
}
log(`  css: ${b.css.length} files, js: ${b.js.length} files`);

const pwa = buildPwa(outputs);
if (pwa && !DRY) writePwa(pwa);
if (pwa) log(`${DRY ? 'built (not written)' : 'wrote'} ${SW_FILE} + ${MANIFEST_FILE}  cache version ${pwa.version}, precache ${pwa.precache.length} files`);

if (CHECK) {
  log('checking ...');
  checkSyntax(b.js, b.jsText);
  checkGlyphIcons(b.template, b.css, b.js);
  checkDarkTokens();
  const dicts = loadDictionaries(b.js);
  log(`  i18n: cs ${Object.keys(dicts.cs).length} keys, en ${Object.keys(dicts.en).length} keys`);
  checkDictionaries(dicts);
  checkTemplate(b.template, dicts);
  checkJsKeys(b.js, dicts);
  checkExternalUrls(b.template, b.css, b.js, outputs);
  checkPwa(pwa, b.template);
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`ERROR: ${e}`);
if (errors.length) {
  console.error(`\nbuild.mjs: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
log(`done in ${Date.now() - t0} ms${CHECK ? ` - all checks passed (${warnings.length} warning(s))` : ''}`);