// docs/jak-to-pocita.md quotes the material and furniture tables of the model: they are generated from the code and this
// test fails when the page and the code drift apart. After changing a table:  UPDATE_DOCS=1 node tests/engine/docs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { E, ROOT } from './_load.mjs';

const FILE = path.join(ROOT, 'docs', 'jak-to-pocita.md');
const num = (v) => String(v).replace('.', ',');
const rows = (table) => Object.keys(table).filter((k) => table[k]).map((k) => `| \`${k}\` | ${num(table[k]['2.4'])} | ${num(table[k]['5'])} | ${num(table[k]['6'])} |`);
const block = (head, table) => [`| ${head} | 2,4 GHz | 5 GHz | 6 GHz |`, '|---|---|---|---|', ...rows(table)].join('\n');

const read = () => readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout (Windows) must not make the check vacuous

function regenerate(text) {
  const swap = (name, body) => {
    const re = new RegExp(`(<!-- ${name}:start -->\\n)[\\s\\S]*?(\\n<!-- ${name}:end -->)`);
    assert.match(text, re, `docs/jak-to-pocita.md: the <!-- ${name}:start/end --> markers are missing`);
    return text.replace(re, (_, a, b) => `${a}${body}${b}`);
  };
  text = swap('materials', block('Materiál', E.model.MATERIALS));
  text = swap('furniture', block('Druh', E.model.FURNITURE_KINDS));
  return text;
}

test('docs/jak-to-pocita.md: the material and furniture tables are the ones in the code', () => {
  const now = read();
  const fresh = regenerate(now);
  if (process.env.UPDATE_DOCS === '1') {
    if (fresh !== now) writeFileSync(FILE, fresh);
    return;
  }
  assert.equal(fresh, now, 'the tables in docs/jak-to-pocita.md are out of date: run  UPDATE_DOCS=1 node tests/engine/docs.test.mjs');
});

test('docs/jak-to-pocita.md: the quoted defaults match the model', () => {
  const text = read();
  const d = E.project.defaults ? E.project.defaults().model : null;
  assert.ok(d, 'project.defaults().model exists');
  assert.ok(text.includes(`| \`nearSignal\` | ${num(d.nearSignal).replace('-', '−')} dBm`), 'nearSignal');
  assert.ok(text.includes(`| \`n\` | ${num(d.n)} |`), 'n');
  assert.ok(text.includes(`je v aplikaci ${num(d.threshold).replace('-', '−')} dBm a silnější`), 'threshold');
  assert.ok(text.includes('0,65 (2,4 GHz) a 1,15 (6 GHz)') && E.model.BAND_FACTOR['2.4'] === 0.65 && E.model.BAND_FACTOR['6'] === 1.15, 'band factors');
  assert.ok(text.includes('beton 15, železobeton 20, dřevo 8') && E.project.CEILING_MATERIALS.concrete === 15 && E.project.CEILING_MATERIALS.reinforced_concrete === 20 && E.project.CEILING_MATERIALS.wood === 8, 'ceilings');
  assert.ok(text.includes('6 GHz od −70 dBm, jinak 5 GHz od −72 dBm') && E.project.STEER_DEFAULT.six === -70 && E.project.STEER_DEFAULT.five === -72, 'steering thresholds');
  assert.ok(text.includes('rozptyl 4 dB, nejistota\n   n 0,6 a násobku 0,35') && E.model.FIT.SIGMA0 === 4 && E.model.FIT.TAU_N === 0.6 && E.model.FIT.TAU_W === 0.35, 'fit prior');
  assert.ok(text.includes('o víc než 0,3 dB') && E.model.FIT.GATE_DB === 0.3, 'gate');
  assert.ok(text.includes('měření dál než 12 dB') && E.model.OUTLIER_DB === 12, 'outliers');
});
