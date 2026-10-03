// Loads the engine exactly as shipped: every src/js/10-engine/*.js file, in lexical order, evaluated in this process'
// global scope (the same way the browser bundle runs them). Tests import { WH, E } from './_load.mjs'.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const ENGINE_DIR = path.join(ROOT, 'src/js/10-engine');
export const FIXTURES = path.join(here, 'fixtures');

/** Minimal stand-in for WH.i18n (the real one is loaded before the engine in the browser). */
function stubI18n() {
  const dict = { cs: {}, en: {} };
  return {
    lang: 'cs',
    dict,
    add(lang, d) {
      Object.assign(dict[lang], d);
    },
    t(key) {
      return dict[this.lang][key] ?? dict[this.lang === 'cs' ? 'en' : 'cs'][key] ?? key;
    },
  };
}

function load() {
  if (globalThis.WH && globalThis.WH.engine) return globalThis.WH;
  globalThis.WH = { i18n: stubI18n() };
  const files = readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
  for (const f of files) {
    const file = path.join(ENGINE_DIR, f);
    vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
  }
  return globalThis.WH;
}

export const WH = load();
export const E = WH.engine;
export const engineFiles = () =>
  readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

/**
 * Optional private fixture: a real floor-plan SVG saved by the app (old or new format) that is NOT part of the
 * repository. Point the environment variable WH_PRIVATE_PLAN at it to run the extra real-plan tests:
 *   WH_PRIVATE_PLAN=/path/to/plan.svg node tests/engine/run-all.mjs
 * Returns the file's text, or null (the tests then skip) when the variable is unset or the file cannot be read.
 * The tests derive every expectation from the file itself, so nothing about the plan lives in the sources.
 */
export function readPrivatePlan() {
  const file = process.env.WH_PRIVATE_PLAN;
  if (!file) return null;
  try {
    return readFileSync(path.resolve(file), 'utf8');
  } catch {
    return null;
  }
}

/** The raw JSON payload of an app SVG (<metadata id="wifi-plan-data">), XML entities decoded, or null. */
export function rawPayloadOf(svgText) {
  const m = /<metadata\b[^>]*\bid\s*=\s*["']wifi-plan-data["'][^>]*>([\s\S]*?)<\/metadata>/i.exec(svgText || '');
  if (!m) return null;
  const txt = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
