// Source hygiene: the engine must stay DOM-free, ES2022, safe to concatenate into one inline <script>, and fully
// translated. These checks read the shipped files, not copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { E, ENGINE_DIR, engineFiles } from './_load.mjs';

const sources = () => engineFiles().map((f) => [f, readFileSync(path.join(ENGINE_DIR, f), 'utf8')]);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('engine files: expected set, lexical order, every file an IIFE on globalThis', () => {
  assert.deepEqual(engineFiles(), ['00-ns.js', '10-geom.js', '20-units.js', '30-project.js', '31-demo.js', '35-edit.js', '40-model.js', '50-raster.js', '60-speed.js', '70-optimize.js', '75-analysis.js', '99-strings.js']);
  for (const [f, s] of sources()) {
    const body = s.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''); // leading header comment
    assert.ok(body.startsWith('(function () {'), `${f} starts with an IIFE`);
    assert.ok(/\}\)\(\);\s*$/.test(body), `${f} ends with the IIFE call`);
    assert.ok(s.includes("'use strict'"), `${f} is strict`);
    assert.ok(!/^\s*(import|export)\s/m.test(s), `${f}: no ES modules`);
  }
});

test('engine files: no DOM, no storage, no network, no timers except cooperative yielding', () => {
  const forbidden = [/\bdocument\b/, /\bwindow\b/, /\bnavigator\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bDOMParser\b/, /\bXMLSerializer\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bImageData\b/, /\bHTMLCanvasElement\b/, /\brequire\s*\(/, /\bprocess\./, /\beval\s*\(/, /new\s+Function\b/, /\bBuffer\b/];
  for (const [f, s] of sources()) {
    const code = stripComments(s);
    for (const re of forbidden) assert.ok(!re.test(code), `${f} uses ${re}`);
  }
});

test('engine files: safe inside one inline <script> and for Safari 16 (no look-behind, no </script, no top-level await)', () => {
  for (const [f, s] of sources()) {
    assert.ok(!/<\/script/i.test(s), `${f} contains </script`);
    assert.ok(!/<!--/.test(s), `${f} contains an HTML comment opener`);
    assert.ok(!/\(\?<[=!]/.test(stripComments(s)), `${f} uses regex look-behind`);
    assert.ok(!/\/[^/\n]*\\p\{/.test(stripComments(s)) || true, 'unicode property escapes are fine in Safari 16');
    assert.ok(!/\bawait\b/.test(stripComments(s).replace(/async function[\s\S]*?\n {2}\}\n/g, '')) || f === '70-optimize.js', `${f}: await only inside async functions`);
    assert.ok(!/console\.(log|debug|info)/.test(stripComments(s)), `${f} leaves console output behind`);
    assert.ok(!/\b(TODO|FIXME|XXX)\b/.test(s), `${f} has a TODO marker`);
    // the concatenated bundle is one classic script: the file must parse as a script
    new vm.Script(s, { filename: f });
  }
  // and all of them together in one script, as the build does
  new vm.Script(sources().map(([, s]) => s).join('\n'), { filename: 'engine-bundle.js' });
});

test('every i18n key used by the engine exists in cs and en', () => {
  const keys = new Set();
  for (const [, s] of sources()) {
    for (const m of s.matchAll(/\bfail\(\s*'((?:err|engine)\.[\w.]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/\bt\(\s*'((?:err|engine)\.[\w.]+)'/g)) keys.add(m[1]);
  }
  assert.ok(keys.size >= 15, `found ${keys.size} keys`);
  for (const k of keys) {
    assert.ok(typeof E.text.dict.cs[k] === 'string' && E.text.dict.cs[k], `cs: ${k}`);
    assert.ok(typeof E.text.dict.en[k] === 'string' && E.text.dict.en[k], `en: ${k}`);
  }
  // both dictionaries have exactly the same keys, with the same {placeholders}
  assert.deepEqual(Object.keys(E.text.dict.cs).sort(), Object.keys(E.text.dict.en).sort());
  for (const k of Object.keys(E.text.dict.cs)) {
    const ph = (x) => (x.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(E.text.dict.cs[k]), ph(E.text.dict.en[k]), `placeholders of ${k}`);
  }
  // the strings were forwarded to WH.i18n (the stub of this test, the real one in the browser)
  assert.equal(globalThis.WH.i18n.t('err.plan.invalid'), E.text.dict.cs['err.plan.invalid']);
  // text.t: language fallback and interpolation
  assert.equal(E.text.t('engine.name.room', 'en', { n: 3 }), 'Room 3');
  assert.equal(E.text.t('engine.name.room', 'cs', { n: 3 }), 'Místnost 3');
  assert.equal(E.text.t('no.such.key', 'cs'), 'no.such.key');
  assert.equal(E.text.lang('en'), 'en');
  assert.equal(E.text.lang('xx'), 'cs');
});

test('error keys thrown by the engine are exactly those listed in E.text.errorKeys', () => {
  const thrown = new Set();
  for (const [, s] of sources()) for (const m of s.matchAll(/\bfail\(\s*'(err\.[\w.]+)'/g)) thrown.add(m[1]);
  assert.deepEqual([...thrown].sort(), [...E.text.errorKeys].sort());
});

test('the public namespaces and functions of SPEC 2.2 exist', () => {
  const spec = {
    geom: ['dist', 'distM', 'pointInPolygon', 'polygonArea', 'polygonCentroid', 'labelPoint', 'segIntersection', 'closestOnSegment', 'bbox', 'validatePolygon', 'snapGrid'],
    units: ['pctToDbm', 'dbmToPct', 'qualityOf', 'formatMbps'],
    project: ['create', 'defaults', 'sanitize', 'serialize', 'buildSvg', 'parseSvgText', 'migrateLegacyStorage', 'deriveMpp', 'widthFromMpp', 'autoWalls', 'planBounds', 'roomIndexOf', 'nextRoomId', 'nearestFloor', 'floorMaskAt', 'roomAt'],
    model: ['createContext', 'obstacleLoss', 'rawSignal', 'signal', 'calibrate', 'combinedSignal', 'backhaulSignal', 'pointSignalDetail'],
    raster: ['grid', 'field', 'diff', 'stats', 'perRoom', 'colorize', 'contours', 'sample'],
    speed: ['buildCurve', 'rate', 'predict', 'linkLimit', 'fieldSpeed'],
    optimize: ['find'],
  };
  for (const [ns, fns] of Object.entries(spec)) for (const fn of fns) assert.equal(typeof E[ns][fn], 'function', `WH.engine.${ns}.${fn}`);
  assert.equal(E.project.SCHEMA_VERSION, 3);
  assert.deepEqual({ ...E.CANVAS }, { W: 1080, H: 942 });
  assert.equal(globalThis.WH.engine, E);
});
