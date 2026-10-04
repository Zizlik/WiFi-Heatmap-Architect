// WH.devinfo.fromHash / toHash: the helper's one-shot hand-over '#wifi=<base64url(UTF-8 JSON)>' (SPEC 8.2).
// The helper scripts (PowerShell / Python) build the hash themselves; these tests pin the format they must produce:
//   JSON {v:1, os:'windows'|'macos'|'linux', at?:epoch ms, wifi:{ssid, bssid, band, channel, signalPct, rssiDbm,
//         rxRate, txRate, radio, security, state}, raw?:'<command output>'}  ->  UTF-8  ->  base64url (padding optional;
//   the standard alphabet with + / = is accepted too, so [Convert]::ToBase64String works unchanged).
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
const D = globalThis.WH.devinfo;
const fx = (name) => readFileSync(path.join(here, 'fixtures', name), 'utf8');

const WIFI = { ssid: 'Doma u Nováků 🏠', bssid: '74:83:C2:1A:2B:3C', band: 5, channel: 36, signalPct: 92, rssiDbm: -49, rxRate: 1201, txRate: 1201, radio: '802.11ax', security: 'WPA2-Personal', state: 'connected' };
const payload = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');

test('round trip: toHash -> fromHash keeps every field (UTF-8 SSID with diacritics and emoji)', () => {
  const parsed = D.parse(fx('win-cs-11.txt'));
  const h = D.toHash({ ...parsed, at: 1759500000000 });
  assert.match(h, /^#wifi=[A-Za-z0-9_-]+$/);
  const r = D.fromHash(h);
  assert.equal(r.ok, true);
  assert.equal(r.os, 'windows');
  assert.equal(r.source, 'helper');
  assert.equal(r.at, 1759500000000);
  assert.deepEqual(r.connected, parsed.connected);
  const u = D.fromHash(D.toHash({ os: 'linux', wifi: WIFI }));
  assert.equal(u.connected.ssid, 'Doma u Nováků 🏠');
  assert.equal(u.connected.bssid, '74:83:c2:1a:2b:3c');
  assert.equal(u.connected.wifiGen, 'Wi-Fi 6');
  assert.equal(D._b64.decode(D._b64.encode('žluťoučký kůň 🐎')), 'žluťoučký kůň 🐎');
});

test('what the helpers produce: Python urlsafe_b64encode (no padding), PowerShell ToBase64String (+ / =), URL-encoded', () => {
  const obj = { v: 1, os: 'windows', at: 1759500000000, wifi: WIFI };
  const std = payload(obj).toString('base64'); // PowerShell: [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  const url = payload(obj).toString('base64url'); // Python: base64.urlsafe_b64encode(...).rstrip(b'=')
  assert.ok(/[+/=]/.test(std) || std !== url);
  for (const h of [`#wifi=${url}`, `#wifi=${std}`, `wifi=${url}`, `#foo=1&wifi=${url}`, `#wifi=${encodeURIComponent(std)}`, url, `${url}==`, `#wifi=${url.slice(0, 40)}\n${url.slice(40)}`]) {
    const r = D.fromHash(h);
    assert.equal(r.ok, true, h.slice(0, 30));
    assert.equal(r.connected.ssid, 'Doma u Nováků 🏠');
    assert.equal(r.connected.rssiDbm, -49);
    assert.equal(r.connected.band, 5);
  }
  // ISO timestamps are accepted too
  assert.equal(D.fromHash(`#wifi=${payload({ ...obj, at: '2026-10-03T12:00:00Z' }).toString('base64url')}`).at, Date.parse('2026-10-03T12:00:00Z'));
});

test('raw command text in the hash is parsed with the same rules and fills missing fields', () => {
  const r = D.fromHash(`#wifi=${payload({ v: 1, os: 'macos', raw: fx('mac-wdutil.txt') }).toString('base64url')}`);
  assert.equal(r.ok, true);
  assert.equal(r.connected.ssid, 'Domov 5G');
  assert.equal(r.connected.channel, 36);
  const both = D.fromHash(`#wifi=${payload({ v: 1, os: 'windows', wifi: { ssid: 'Přednost', rssiDbm: -50 }, raw: fx('win-en-11.txt') }).toString('base64url')}`);
  assert.equal(both.connected.ssid, 'Přednost', 'the parsed wifi object wins');
  assert.equal(both.connected.rxRate, 1201, 'gaps come from the raw text');
  // toHash drops the raw text when it does not fit
  const big = D.toHash({ os: 'windows', connected: D.parse(fx('win-en-11.txt')).connected, raw: 'x'.repeat(20000) });
  assert.ok(big && big.length <= D.LIMITS.HASH_MAX + 6);
  assert.equal(D.fromHash(big).connected.ssid, 'Domov 5G');
  assert.equal(D.toHash(null), null);
  assert.equal(D.toHash({ os: 'windows' }), null);
});

test('rejects what is not a valid hand-over (size, encoding, JSON, schema) without throwing', () => {
  const enc = (o) => `#wifi=${payload(o).toString('base64url')}`;
  const cases = [
    ['', 'devinfo.hash.none'],
    ['#', 'devinfo.hash.none'],
    ['#wifi=', 'devinfo.hash.none'],
    ['#plan&x=1', 'devinfo.hash.none'],
    [`#wifi=${'A'.repeat(D.LIMITS.HASH_MAX + 1)}`, 'devinfo.hash.tooBig'],
    ['#wifi=!!!not-base64!!!', 'devinfo.hash.invalid'],
    ['#wifi=A', 'devinfo.hash.invalid'],
    [`#wifi=${Buffer.from('not json').toString('base64url')}`, 'devinfo.hash.invalid'],
    [`#wifi=${Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString('base64url')}`, 'devinfo.hash.invalid'],
    [`#wifi=${Buffer.from([0xc3, 0x28]).toString('base64url')}`, 'devinfo.hash.invalid'],
    [enc([1, 2, 3]), 'devinfo.hash.invalid'],
    [enc('string'), 'devinfo.hash.invalid'],
    [enc({ v: 1, os: 'windows' }), 'devinfo.hash.invalid'],
    [enc({ v: 99, wifi: WIFI }), 'devinfo.hash.invalid'],
    [enc({ v: 1, wifi: [WIFI] }), 'devinfo.hash.invalid'],
  ];
  for (const [h, err] of cases) {
    const r = D.fromHash(h);
    assert.equal(r.ok, false, h.slice(0, 40));
    assert.equal(r.error, err, h.slice(0, 40));
    assert.equal(r.connected, null);
  }
  assert.equal(D.fromHash(null).error, 'devinfo.hash.none');
  assert.equal(D.fromHash(42).error, 'devinfo.hash.none');
});

test('schema validation: each field is checked on its own; prototype pollution does nothing', () => {
  const enc = (o) => `#wifi=${Buffer.from(o, 'utf8').toString('base64url')}`;
  const r = D.fromHash(enc('{"v":1,"os":"amiga","wifi":{"ssid":"' + 'S'.repeat(300) + '","bssid":"zz","band":7,"channel":999,"rssiDbm":"strong","signalPct":101,"rxRate":-3,"txRate":1e9,"radio":"802.11zz","security":{"a":1},"state":"connected","__proto__":{"polluted":1}},"__proto__":{"polluted":2}}'));
  assert.equal(r.ok, true);
  assert.equal(r.os, null);
  const c = r.connected;
  assert.equal([...c.ssid].length, 64);
  for (const k of ['bssid', 'band', 'channel', 'rssiDbm', 'signalPct', 'rxRate', 'txRate', 'radio', 'security']) assert.equal(c[k], null, k);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  // a disconnected hand-over is not a connection
  const off = D.fromHash(`#wifi=${payload({ v: 1, os: 'windows', wifi: { state: 'disconnected', ssid: 'x' } }).toString('base64url')}`);
  assert.equal(off.ok, true);
  assert.equal(off.connected, null);
  assert.ok(off.warnings.includes('devinfo.warn.notConnected'));
});
