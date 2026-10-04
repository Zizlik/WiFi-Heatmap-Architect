// SPEC 8: the optional measurement extras `wifi` {ssid, bssid, channel, band, rxRate, txRate, radio, security} and
// `deviceInfo` {os, model, browser, connType} - sanitize, serialize, file round trips, migration, hostile input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { E, ROOT } from './_load.mjs';
import { assertValidProject, assertWellFormedXml } from './_validate.mjs';

const P = E.project;

function withMeasurements(list) {
  const p = P.create({ template: 'demo', lang: 'cs' });
  p.measurements = list;
  return P.sanitize(p);
}
const meas = (extra) => ({ id: 'm1', x: 0.3, y: 0.3, band: 5, value: -60, name: 'Kuchyň', download: 300, upload: 80, device: 'Telefon', t: 1700000000000, ...extra });

test('wifi + deviceInfo are kept, cleaned and validated; empty extras disappear', () => {
  const s = withMeasurements([
    meas({
      wifi: { ssid: '  Doma u Nováků  ', bssid: '74-83-C2-1A-2B-3C', channel: 36, band: '5 GHz', rxRate: 1201, txRate: 866.7, radio: '802.11ax', security: 'WPA2-Personal', extra: 'dropped' },
      deviceInfo: { os: 'Windows 11', model: 'ThinkPad X1', browser: 'Edge 129', connType: 'wifi', ip: '10.0.0.1' },
    }),
  ]);
  const m = s.measurements[0];
  assert.deepEqual(m.wifi, { ssid: 'Doma u Nováků', bssid: '74:83:c2:1a:2b:3c', channel: 36, band: 5, rxRate: 1201, txRate: 866.7, radio: '802.11ax', security: 'WPA2-Personal' });
  assert.deepEqual(m.deviceInfo, { os: 'Windows 11', model: 'ThinkPad X1', browser: 'Edge 129', connType: 'wifi' });
  assertValidProject(s, 'extras');
  // hostile / wrong values: each field on its own
  const h = withMeasurements([
    meas({
      wifi: { ssid: 'x'.repeat(200) + '\u0000', bssid: 'zz:zz', channel: 999, band: 7, rxRate: -5, txRate: 'fast', radio: { a: 1 }, security: 'W'.repeat(100) },
      deviceInfo: { os: 42, model: null, browser: ['x'], connType: 'satellite' },
    }),
  ]).measurements[0];
  assert.equal(h.wifi.ssid.length, 64);
  assert.equal(h.wifi.bssid, null);
  assert.equal(h.wifi.channel, null);
  assert.equal(h.wifi.band, null);
  assert.equal(h.wifi.rxRate, 0);
  assert.equal(h.wifi.txRate, null);
  assert.equal(h.wifi.radio, null);
  assert.equal(h.wifi.security.length, 40);
  assert.deepEqual(h.deviceInfo, { os: '42', model: null, browser: null, connType: null });
  // nothing usable -> no key at all
  const e = withMeasurements([meas({ wifi: { ssid: '', bssid: 'nope', channel: 0 }, deviceInfo: { connType: 'nope' } }), meas({ id: 'm2', wifi: 'text', deviceInfo: [1, 2] })]);
  for (const q of e.measurements) {
    assert.equal('wifi' in q, false);
    assert.equal('deviceInfo' in q, false);
  }
  // every connection type of navigator.connection is accepted
  for (const t of P.CONN_TYPES) assert.equal(withMeasurements([meas({ deviceInfo: { connType: t } })]).measurements[0].deviceInfo.connType, t);
  // MAC formats
  assert.equal(P.macOf('AABBCCDDEEFF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(P.macOf('aa-bb-cc-dd-ee-ff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(P.macOf('aa:bb:cc:dd:ee'), null);
});

test('older measurements keep their exact shape; extras round-trip through serialize and the SVG file', () => {
  const plain = withMeasurements([meas({})]).measurements[0];
  assert.deepEqual(Object.keys(plain), ['id', 'x', 'y', 'band', 'value', 'name', 'download', 'upload', 'device', 't']);
  const s = withMeasurements([
    meas({ wifi: { ssid: 'Síť "<&>"', bssid: 'aa:bb:cc:dd:ee:ff', channel: 37, band: 6, rxRate: 2402, txRate: 2402, radio: '802.11ax', security: 'WPA3-Personal' }, deviceInfo: { os: 'Android 15', model: 'Pixel 8', browser: 'Chrome', connType: 'wifi' } }),
    meas({ id: 'm2', value: null, wifi: { ssid: 'jen SSID' } }),
    meas({ id: 'm3' }),
  ]);
  assert.deepEqual(P.sanitize(JSON.parse(P.serialize(s))), s);
  const svg = P.buildSvg(s);
  assertWellFormedXml(svg);
  assert.deepEqual(P.parseSvgText(svg).project, s);
  assert.deepEqual(P.sanitize(s), s, 'idempotent');
  assert.deepEqual(s.measurements[1].wifi, { ssid: 'jen SSID', bssid: null, channel: null, band: null, rxRate: null, txRate: null, radio: null, security: null });
  assert.equal('wifi' in s.measurements[2], false);
  // prototype pollution through the extras does nothing
  const evil = JSON.parse('{"wifi":{"__proto__":{"polluted":1},"ssid":"a"},"deviceInfo":{"__proto__":{"polluted":2},"os":"b"}}');
  const q = withMeasurements([meas(evil)]).measurements[0];
  assert.equal({}.polluted, undefined);
  assert.equal(q.wifi.ssid, 'a');
  assert.equal(q.deviceInfo.os, 'b');
});

test('the Wi-Fi details parser output (WH.devinfo.toWifi) is a valid measurement.wifi as is', () => {
  const file = path.join(ROOT, 'src/js/36-devinfo/10-parse.js');
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
  const D = globalThis.WH.devinfo;
  for (const fx of ['win-cs-11.txt', 'win-cs-6e.txt', 'mac-system-profiler.txt', 'linux-iw-wifi7.txt', 'linux-nmcli.txt', 'win-en-11-mlo.txt', 'mlo-two-links']) {
    // 'mlo-two-links': the real Wi-Fi 7 output with a second (6 GHz) link added - wifi.links of SPEC 13
    const text =
      fx === 'mlo-two-links'
        ? readFileSync(path.join(ROOT, 'tests/devinfo/fixtures', 'win-en-11-mlo.txt'), 'utf8').replace(/(\n\s+LinkID: 0[^\r\n]*)/, '$1\n        LinkID: 1, Local: 02:11:22:33:44:57, AP: aa:bb:cc:11:22:34, RSSI: -58, Channel: 37, Band: 6 GHz, BW: 160')
        : readFileSync(path.join(ROOT, 'tests/devinfo/fixtures', fx), 'utf8');
    const c = D.parse(text).connected;
    if (fx.includes('mlo')) assert.ok(Array.isArray(c.links) && c.links.length === (fx === 'mlo-two-links' ? 2 : 1), fx);
    const w = D.toWifi(c);
    assert.ok(w, fx);
    assert.deepEqual(P.cleanWifi(w), w, fx);
    const s = withMeasurements([meas({ band: w.band || 5, wifi: w })]);
    assert.deepEqual(s.measurements[0].wifi, w, fx);
  }
});
