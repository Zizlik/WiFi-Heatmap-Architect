// engine.channels: the EU DFS table and the one-line channel hint shown after a measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';

const C = E.channels;

test('DFS: 5 GHz channels 52-64 and 100-144 need radar detection, 36-48 and 149+ do not (edge touching is not DFS)', () => {
  for (const ch of [36, 40, 44, 48, 149, 153, 157, 161, 165]) assert.equal(C.isDfs(5, ch), false, 'ch ' + ch);
  for (const ch of [52, 56, 60, 64, 100, 104, 116, 120, 132, 136, 140, 144]) assert.equal(C.isDfs(5, ch), true, 'ch ' + ch);
});

test('DFS: only 5 GHz, only real channel numbers', () => {
  assert.equal(C.isDfs(2.4, 52), false);
  assert.equal(C.isDfs(6, 100), false);
  assert.equal(C.isDfs(5, null), false);
  assert.equal(C.isDfs(5, 52.5), false);
  assert.equal(C.isDfs(5, 8), false);
});

test('hint: DFS on 5 GHz', () => {
  assert.deepEqual(C.hint({ band: 5, channel: 100 }), { key: 'dfs', channel: 100 });
  assert.equal(C.hint({ band: 5, channel: 36 }), null);
});

test('hint: 2.4 GHz channels 1, 6, 11 are fine, others overlap; 40 MHz is flagged first', () => {
  for (const ch of [1, 6, 11]) assert.equal(C.hint({ band: 2.4, channel: ch }), null);
  assert.deepEqual(C.hint({ band: 2.4, channel: 4 }), { key: 'off', channel: 4 });
  assert.deepEqual(C.hint({ band: 2.4, channel: 13 }), { key: 'off', channel: 13 });
  assert.deepEqual(C.hint({ band: 2.4, channel: 1, widthMHz: 40 }), { key: 'wide', channel: 1 });
  assert.equal(C.hint({ band: 2.4, channel: 6, widthMHz: 20 }), null);
});

test('hint: nothing for 6 GHz, unknown or garbage input', () => {
  assert.equal(C.hint({ band: 6, channel: 37 }), null);
  assert.equal(C.hint({ band: null, channel: 100 }), null);
  assert.equal(C.hint({ band: 5 }), null);
  assert.equal(C.hint(null), null);
  assert.equal(C.hint('x'), null);
});
