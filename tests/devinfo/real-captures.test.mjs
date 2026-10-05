// WH.devinfo.parse against REAL command outputs we did not write ourselves: tests/devinfo/fixtures/heatmapper/ (copied
// from hnykda/wifi-heatmapper, MIT - see the README there): Windows in de / en / es / fr / it, location denied, macOS
// 10.15 / 12 / 15 (system_profiler, wdutil incl. a radio that is on but not associated), Linux iw / nmcli.
//   node --test tests/devinfo/real-captures.test.mjs      (also run by tests/engine/run-all.mjs)
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
const fx = (name) => readFileSync(path.join(here, 'fixtures', 'heatmapper', name), 'utf8');
const pick = (c, keys) => Object.fromEntries(keys.map((k) => [k, c[k]]));

/** [fixture, expected os/source, expected connection subset | null + warning] */
const CONNECTED = [
  ['win-netsh-interfaces-en.txt', 'windows', 'netsh', { ssid: 'SSID-1', band: 5, channel: 44, signalPct: 42, rxRate: 103 }],
  ['win-netsh-interfaces-de.txt', 'windows', 'netsh', { ssid: 'SSID-1', band: 5, channel: 116, signalPct: 43, rxRate: 300 }],
  ['win-netsh-interfaces-es.txt', 'windows', 'netsh', { ssid: 'SSID-1', band: 2.4, channel: 11, signalPct: 81, rxRate: 69 }],
  // French prints the BSSID as "Point d'accès d'identificateur SSID (Service Set Identifier)" and the rates as "Réception (Mbits/s)"
  ['win-netsh-interfaces-fr.txt', 'windows', 'netsh', { state: 'connected', ssid: 'SSID-1', bssid: 'fe:dc:ba:09:87:02', band: 2.4, channel: 11, signalPct: 80, rxRate: 103, txRate: 206 }],
  // Italian: "Stato: connessa", "Canale", "Segnale", "Velocità ricezione (Mbps)"
  ['win-netsh-interfaces-it.txt', 'windows', 'netsh', { state: 'connected', ssid: 'SSID-1', bssid: 'fe:dc:ba:09:87:02', band: 2.4, channel: 4, signalPct: 85, rxRate: 130, txRate: 130, radio: '802.11n' }],
  ['mac-sp_10.15.7.json', 'macos', 'system_profiler', { ssid: 'SSID-6', band: 2.4, channel: 6 }],
  ['mac-sp_12.7.2-AP.json', 'macos', 'system_profiler', { ssid: 'SSID-4', band: 5, channel: 149 }],
  ['mac-sp_15.5.json', 'macos', 'system_profiler', { ssid: 'SSID-2', band: 2.4, channel: 6 }],
  ['mac-sp_15.5-on-iPhone.json', 'macos', 'system_profiler', { ssid: 'SSID-1', band: 5, channel: 149 }],
  // macOS 12 wdutil: "Channel : 144 (40 MHz, DFS)" - no band prefix, the band follows from the channel number
  ['macOS12-wdutil-2.4GHz-en.txt', 'macos', 'wdutil', { ssid: 'SomeSSID-2.4', band: 2.4, channel: 1, rssiDbm: -55 }],
  ['macOS12-wdutil-5GHz-en.txt', 'macos', 'wdutil', { ssid: 'SomeSSID-5', band: 5, channel: 144, rssiDbm: -61, widthMHz: 40 }],
  ['macOS15-wdutil-5GHz-en.txt', 'macos', 'wdutil', { ssid: null, band: 5, channel: 44, rssiDbm: -79 }],
  ['linux-iw-dev-wlp1s0-link.txt', 'linux', 'iw', { ssid: 'SSID-1', band: 2.4, channel: 1, rssiDbm: -51 }],
  ['linux-nmcli-dev-wifi-list.txt', 'linux', 'nmcli', { ssid: 'SSID-3', band: 2.4, channel: 1 }],
];

for (const [name, os, source, want] of CONNECTED) {
  test(`${name}: parsed as ${os}/${source} with the right connection`, () => {
    const r = D.parse(fx(name));
    assert.equal(r.os, os);
    assert.equal(r.source, source);
    assert.ok(r.connected, 'a connection is found');
    assert.deepEqual(pick(r.connected, Object.keys(want)), want);
  });
}

test('macOS wdutil of a radio that is on but NOT associated is "not connected", never a 0 dBm "connection"', () => {
  const r = D.parse(fx('mac-wdutil-nosignal-en.txt'));
  assert.equal(r.source, 'wdutil');
  assert.equal(r.connected, null);
  assert.ok(r.warnings.includes('devinfo.warn.notConnected'));
  const e = r.interfaces[0];
  assert.equal(e.state, 'disconnected');
  assert.equal(e.ssid, null);
  assert.equal(e.rssiDbm, null);
  assert.equal(e.channel, null, 'the scan channel is not a connection');
});

test('system_profiler without an association, with Wi-Fi off, or no Wi-Fi at all: not connected', () => {
  for (const name of ['mac-sp_12.7.2-no-AP.json', 'mac-sp_15.5-wifi-disabled.json']) {
    const r = D.parse(fx(name));
    assert.equal(r.connected, null, name);
    assert.ok(r.warnings.includes('devinfo.warn.notConnected'), name);
  }
});

test('Windows 11 24H2 with Location off: asks for the Location setting instead of failing silently', () => {
  const r = D.parse(fx('win-netsh-interfaces-location-denied-en.txt'));
  assert.equal(r.connected, null);
  assert.ok(r.warnings.includes('devinfo.warn.location'));
});

test('macOS 15 wdutil redacts the SSID: the signal and channel are still read and the user is told', () => {
  const r = D.parse(fx('macOS15-wdutil-2.4GHz-en.txt'));
  assert.equal(r.connected.ssid, null);
  assert.equal(r.connected.rssiDbm, -63);
  assert.equal(r.connected.band, 2.4);
  assert.ok(r.warnings.includes('devinfo.warn.ssidHidden'));
});

test('terse nmcli with no row in use: not connected (a blank first column is not a connection)', () => {
  const r = D.parse(fx('linux-single-line.txt'));
  assert.equal(r.connected, null);
});
