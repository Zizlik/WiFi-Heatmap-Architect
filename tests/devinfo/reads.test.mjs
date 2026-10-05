// WH.devinfo.mergeReads: two Wi-Fi reads around a measurement -> roaming detection + the mW-mean signal.
//   node --test tests/devinfo/reads.test.mjs      (also run by tests/engine/run-all.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(here, '../../src/js/36-devinfo/10-parse.js');
globalThis.WH = globalThis.WH || {};
vm.runInThisContext(readFileSync(FILE, 'utf8'), { filename: FILE });
const { mergeReads } = globalThis.WH.devinfo;

const A = { bssid: '74:83:C2:1A:2B:3C', band: 5, channel: 36, rssiDbm: -60 };

test('the same access point and band: no roaming, mW mean of the signals', () => {
  const r = mergeReads(A, { ...A, bssid: '74:83:c2:1a:2b:3c', rssiDbm: -60 });
  assert.equal(r.roamed, false);
  assert.deepEqual(r.changed, []);
  assert.ok(Math.abs(r.dbm - -60) < 1e-9);
  assert.equal(r.spread, 0);
});

test('mean is taken in mW, not in dB (-50 and -70 dBm -> about -53 dBm, not -60)', () => {
  const r = mergeReads({ ...A, rssiDbm: -50 }, { ...A, rssiDbm: -70 });
  assert.ok(Math.abs(r.dbm - -52.97) < 0.01, String(r.dbm));
  assert.equal(r.spread, 20);
});

test('another BSSID, band or channel = roamed; no averaged signal', () => {
  assert.deepEqual(mergeReads(A, { ...A, bssid: '74:83:c2:aa:bb:cc' }).changed, ['bssid']);
  assert.deepEqual(mergeReads(A, { ...A, band: 2.4, channel: 6 }).changed, ['band', 'channel']);
  const r = mergeReads(A, { ...A, channel: 44 });
  assert.equal(r.roamed, true);
  assert.equal(r.dbm, null);
  assert.equal(r.spread, 0);
});

test('missing fields never count as a change', () => {
  const r = mergeReads(A, { bssid: null, band: null, channel: null, rssiDbm: -62 });
  assert.equal(r.roamed, false);
  assert.ok(r.dbm < -60 && r.dbm > -62);
});

test('Windows percentage is used when there is no dBm; one signal alone is returned as is', () => {
  const r = mergeReads({ ...A, rssiDbm: null, signalPct: 80 }, { ...A, rssiDbm: null, signalPct: 80 });
  assert.ok(Math.abs(r.dbm - -60) < 1e-9);
  assert.equal(mergeReads(A, { ...A, rssiDbm: null }).dbm, -60);
  assert.equal(mergeReads(null, A).roamed, false);
  assert.equal(mergeReads(null, A).dbm, null);
});

test('Wi-Fi 7 MLO: the same connection whose strongest link moved to another band is not a roam; the saved band is averaged', () => {
  const links1 = [{ band: 5, channel: 36, rssiDbm: -60, widthMHz: 80 }, { band: 6, channel: 37, rssiDbm: -62, widthMHz: 160 }];
  const links2 = [{ band: 6, channel: 37, rssiDbm: -61, widthMHz: 160 }, { band: 5, channel: 36, rssiDbm: -63, widthMHz: 80 }];
  const a = { bssid: 'aa:bb:cc:11:22:33', band: 5, channel: 36, rssiDbm: -60, links: links1 };
  const b = { bssid: 'aa:bb:cc:11:22:33', band: 6, channel: 37, rssiDbm: -61, links: links2 };
  const r = mergeReads(a, b);
  assert.equal(r.roamed, false);
  assert.ok(Math.abs(r.dbm - 10 * Math.log10((Math.pow(10, -6) + Math.pow(10, -6.3)) / 2)) < 1e-9, 'the 5 GHz link of both reads');
  assert.equal(r.spread, 3);
  // the 5 GHz link is gone in read 2: that is a real change
  const c = { ...b, links: [{ band: 6, channel: 37, rssiDbm: -61 }, { band: 2.4, channel: 6, rssiDbm: -50 }] };
  assert.equal(mergeReads(a, c).roamed, true);
  // another MLD AP: a roam whatever the links say
  assert.deepEqual(mergeReads(a, { ...b, bssid: 'aa:bb:cc:99:99:99' }).changed.includes('bssid'), true);
});
