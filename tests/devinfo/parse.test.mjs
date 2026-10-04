// WH.devinfo.parse (src/js/36-devinfo/10-parse.js): Wi-Fi details out of the text of OS commands (SPEC 8).
// Fixtures are hand-written from the documented formats: Windows `netsh wlan show interfaces` (English + Czech, two
// adapters, disconnected, Wi-Fi 6E, Wi-Fi 7, CRLF, odd spacing), macOS `system_profiler SPAirPortDataType` (text and
// -json) and `wdutil info`, Linux `nmcli ... dev wifi` (our -f order, the default columns, terse) and `iw dev link`.
// win-en-11-mlo.txt is a real Windows 11 Wi-Fi 7 (multi-link) output with every name and address replaced.
//   node --test tests/devinfo/parse.test.mjs      (also run by tests/engine/run-all.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const FILE = path.join(ROOT, 'src/js/36-devinfo/10-parse.js');
const STRINGS = path.join(ROOT, 'src/js/36-devinfo/strings-parse.js');
globalThis.WH = globalThis.WH || {};
vm.runInThisContext(readFileSync(FILE, 'utf8'), { filename: FILE });
const D = globalThis.WH.devinfo;
const fx = (name) => readFileSync(path.join(here, 'fixtures', name), 'utf8');
const pick = (c, keys) => Object.fromEntries(keys.map((k) => [k, c[k]]));
const KEYS = ['state', 'ssid', 'bssid', 'band', 'channel', 'freqMHz', 'signalPct', 'rssiDbm', 'rssiFromPct', 'rxRate', 'txRate', 'radio', 'wifiGen', 'security'];

/** Expected `connected` (subset of fields) + os / source / warnings per fixture. */
const EXPECT = {
  'win-en-11.txt': { os: 'windows', source: 'netsh', n: 1, warnings: [], c: { state: 'connected', ssid: 'Domov 5G', bssid: '74:83:c2:1a:2b:3c', band: 5, channel: 36, freqMHz: 5180, signalPct: 92, rssiDbm: -49, rssiFromPct: false, rxRate: 1201, txRate: 1201, radio: '802.11ax', wifiGen: 'Wi-Fi 6', security: 'WPA2-Personal' } },
  'win-cs-11.txt': { os: 'windows', source: 'netsh', n: 1, warnings: [], c: { state: 'connected', ssid: 'Doma u Nováků', bssid: '74:83:c2:1a:2b:3c', band: 5, channel: 44, freqMHz: 5220, signalPct: 81, rssiDbm: -61, rssiFromPct: false, rxRate: 866.7, txRate: 780, radio: '802.11ac', wifiGen: 'Wi-Fi 5', security: 'WPA2-Personal' } },
  'win-en-10-two-adapters.txt': { os: 'windows', source: 'netsh', n: 2, warnings: ['devinfo.warn.rssiFromPct'], c: { state: 'connected', ssid: 'Kocourkov', bssid: 'f0:9f:c2:44:55:66', band: 2.4, channel: 6, freqMHz: 2437, signalPct: 70, rssiDbm: -65, rssiFromPct: true, rxRate: 144.4, txRate: 144.4, radio: '802.11n', wifiGen: 'Wi-Fi 4', security: 'WPA2-Personal' } },
  'win-cs-6e.txt': { os: 'windows', source: 'netsh', n: 1, warnings: [], c: { state: 'connected', ssid: 'Chalupa_6E', bssid: '9c:05:d6:aa:bb:cc', band: 6, channel: 37, freqMHz: 6135, signalPct: 84, rssiDbm: -58, rssiFromPct: false, rxRate: 2402, txRate: 2402, radio: '802.11ax', wifiGen: 'Wi-Fi 6E', security: 'WPA3-Personal' } },
  'win-en-wifi7-crlf.txt': { os: 'windows', source: 'netsh', n: 1, warnings: [], c: { state: 'connected', ssid: 'UniFi-BE', bssid: '0c:ea:14:01:02:03', band: 6, channel: 37, freqMHz: 6135, signalPct: 99, rssiDbm: -41, rssiFromPct: false, rxRate: 2882, txRate: 2882, radio: '802.11be', wifiGen: 'Wi-Fi 7', security: 'WPA3-Personal' } },
  'win-en-11-mlo.txt': { os: 'windows', source: 'netsh', n: 1, warnings: [], c: { state: 'connected', ssid: 'MojeWiFi', bssid: 'aa:bb:cc:11:22:33', band: 5, channel: 100, freqMHz: 5500, signalPct: 67, rssiDbm: -70, rssiFromPct: false, rxRate: 103.2, txRate: 216.2, radio: '802.11be', wifiGen: 'Wi-Fi 7', security: 'WPA3-Personal (H2E)' } },
  'win-cs-disconnected.txt': { os: 'windows', source: 'netsh', n: 1, warnings: ['devinfo.warn.notConnected'], c: null },
  'mac-system-profiler.txt': { os: 'macos', source: 'system_profiler', n: 2, warnings: [], c: { state: 'connected', ssid: 'Domov 5G', bssid: null, band: 5, channel: 36, freqMHz: 5180, signalPct: 88, rssiDbm: -56, rssiFromPct: false, rxRate: null, txRate: 864, radio: '802.11ax', wifiGen: 'Wi-Fi 6', security: 'WPA2 Personal' } },
  'mac-system-profiler-6e.txt': { os: 'macos', source: 'system_profiler', n: 1, warnings: [], c: { state: 'connected', ssid: 'Chalupa_6E', bssid: null, band: 6, channel: 37, freqMHz: 6135, signalPct: 80, rssiDbm: -60, rssiFromPct: false, rxRate: null, txRate: 1729, radio: '802.11ax', wifiGen: 'Wi-Fi 6E', security: 'WPA3 Personal' } },
  'mac-system-profiler.json': { os: 'macos', source: 'system_profiler', n: 2, warnings: [], c: { state: 'connected', ssid: 'Kocourkov', bssid: null, band: 2.4, channel: 6, freqMHz: 2437, signalPct: 74, rssiDbm: -63, rssiFromPct: false, rxRate: null, txRate: 144, radio: '802.11n', wifiGen: 'Wi-Fi 4', security: 'WPA2 Personal' } },
  'mac-wdutil.txt': { os: 'macos', source: 'wdutil', n: 1, warnings: [], c: { state: 'connected', ssid: 'Domov 5G', bssid: '74:83:c2:1a:2b:3c', band: 5, channel: 36, freqMHz: 5180, signalPct: 86, rssiDbm: -57, rssiFromPct: false, rxRate: null, txRate: 864, radio: '802.11ax', wifiGen: 'Wi-Fi 6', security: 'WPA2 Personal' } },
  'linux-nmcli.txt': { os: 'linux', source: 'nmcli', n: 5, warnings: ['devinfo.warn.rssiFromPct'], c: { state: 'connected', ssid: 'Domov 5G', bssid: '74:83:c2:1a:2b:3c', band: 5, channel: 36, freqMHz: 5180, signalPct: 74, rssiDbm: -56, rssiFromPct: true, rxRate: null, txRate: null, radio: null, wifiGen: null, security: 'WPA2' } },
  'linux-nmcli-default.txt': { os: 'linux', source: 'nmcli', n: 3, warnings: ['devinfo.warn.rssiFromPct'], c: { state: 'connected', ssid: 'Domov 5G', bssid: '74:83:c2:1a:2b:3c', band: 5, channel: 36, freqMHz: 5180, signalPct: 74, rssiDbm: -56, rssiFromPct: true, rxRate: null, txRate: null, radio: null, wifiGen: null, security: 'WPA2' } },
  'linux-iw.txt': { os: 'linux', source: 'iw', n: 1, warnings: [], c: { state: 'connected', ssid: 'Domov 5G', bssid: '74:83:c2:1a:2b:3c', band: 5, channel: 36, freqMHz: 5180, signalPct: 92, rssiDbm: -54, rssiFromPct: false, rxRate: 1200.9, txRate: 960.7, radio: '802.11ax', wifiGen: 'Wi-Fi 6', security: null } },
  'linux-iw-wifi7.txt': { os: 'linux', source: 'iw', n: 1, warnings: [], c: { state: 'connected', ssid: 'UniFi-BE', bssid: '0c:ea:14:01:02:03', band: 6, channel: 37, freqMHz: 6135, signalPct: 100, rssiDbm: -47, rssiFromPct: false, rxRate: 2882.3, txRate: 2161.8, radio: '802.11be', wifiGen: 'Wi-Fi 7', security: null } },
  'linux-iw-24-old.txt': { os: 'linux', source: 'iw', n: 1, warnings: [], c: { state: 'connected', ssid: 'Kocourkov', bssid: 'f0:9f:c2:44:55:66', band: 2.4, channel: 6, freqMHz: 2437, signalPct: 68, rssiDbm: -66, rssiFromPct: false, rxRate: null, txRate: 72.2, radio: '802.11n', wifiGen: 'Wi-Fi 4', security: null } },
  'linux-iw-not-connected.txt': { os: 'linux', source: 'iw', n: 1, warnings: ['devinfo.warn.notConnected'], c: null },
};

function check(name, text, label = name) {
  const e = EXPECT[name];
  const r = D.parse(text);
  assert.equal(r.os, e.os, `${label}: os`);
  assert.equal(r.source, e.source, `${label}: source`);
  assert.equal(r.interfaces.length, e.n, `${label}: interfaces`);
  assert.deepEqual(r.warnings, e.warnings, `${label}: warnings`);
  if (e.c === null) assert.equal(r.connected, null, `${label}: not connected`);
  else assert.deepEqual(pick(r.connected, KEYS), e.c, `${label}: connected`);
  return r;
}

test('every fixture parses to the expected connection', () => {
  const files = readdirSync(path.join(here, 'fixtures')).sort();
  assert.deepEqual(files, Object.keys(EXPECT).sort(), 'every fixture has an expectation');
  for (const f of files) check(f, fx(f));
});

test('line endings, BOM, NBSP, tabs and trailing spaces do not matter', () => {
  for (const f of Object.keys(EXPECT)) {
    const lf = fx(f).replace(/\r\n?/g, '\n');
    check(f, lf, `${f} LF`);
    check(f, lf.replace(/\n/g, '\r\n'), `${f} CRLF`);
    check(f, lf.replace(/\n/g, '\r'), `${f} CR`);
    check(f, '\ufeff' + lf, `${f} BOM`);
    if (!f.endsWith('.json') && !f.startsWith('linux-nmcli')) check(f, lf.replace(/\n/g, '   \n'), `${f} trailing spaces`);
    if (f.startsWith('win-')) check(f, lf.replace(/ : /g, '\t:\t'), `${f} tabs`);
  }
});

test('Czech netsh output with diacritics broken by `| clip` (CP852 read as CP1250) still parses', () => {
  // the CP852 byte of each letter, read back as Windows-1250
  const cp852as1250 = { 'á': '\u00a0', 'í': '\u02c7', 'é': '\u201a', 'ě': '\u0158', 'ř': '\u00fd', 'ů': '\u2026', 'ý': '\u011b', 'č': '\u017a', 'š': '\u00e7', 'ž': '\u00a7', 'ú': '\u0141', 'Š': '\u00e6' };
  const garble = (s) => s.replace(/[áíéěřůýčšžúŠ]/g, (c) => cp852as1250[c]);
  for (const f of ['win-cs-11.txt', 'win-cs-6e.txt', 'win-cs-disconnected.txt']) {
    const g = garble(fx(f));
    assert.notEqual(g, fx(f));
    const r = D.parse(g);
    const e = EXPECT[f];
    assert.equal(r.os, 'windows', f);
    if (e.c === null) assert.equal(r.connected, null);
    else {
      // the SSID itself is garbled the same way (it was typed with diacritics), everything else is exact
      const c = pick(r.connected, KEYS);
      assert.deepEqual({ ...c, ssid: null }, { ...e.c, ssid: null }, f);
      assert.equal(c.ssid, garble(e.c.ssid).replace(/ /g, ' '), 'NBSP becomes a space');
    }
  }
});

test('Windows: several adapters, two connected ones, no Wi-Fi at all, unknown language keeps going', () => {
  const two = fx('win-en-11.txt').replace('There is 1 interface', 'There are 2 interfaces') + fx('win-en-11.txt').split('\n').slice(3, 25).join('\n').replace('Name                   : Wi-Fi', 'Name                   : Wi-Fi 2').replace('Signal                 : 92%', 'Signal                 : 40%').replace('Rssi                   : -49', 'Rssi                   : -80');
  const r = D.parse(two);
  assert.equal(r.interfaces.length, 2);
  assert.equal(r.connected.name, 'Wi-Fi', 'the stronger one');
  assert.deepEqual(r.warnings, ['devinfo.warn.multiple']);
  const disc = D.parse(fx('win-en-10-two-adapters.txt'));
  assert.equal(disc.interfaces[1].state, 'disconnected');
  assert.equal(disc.interfaces[1].ssid, null);
  assert.equal(disc.interfaces[1].radio, null, '"Radio status" is not the radio type');
  for (const t of ['There is no wireless interface on the system.', 'V systému není žádné bezdrátové rozhraní.', 'The Wireless AutoConfig Service (wlansvc) is not running.']) {
    const n = D.parse(t);
    assert.equal(n.os, 'windows', t);
    assert.deepEqual(n.warnings, ['devinfo.warn.noWifi'], t);
  }
  // Windows 11 24H2+ with Location off: only a hint text, in any language (the settings URI is constant)
  const loc = 'Network shell commands need location permission to access WLAN information. Turn on Location services on the Location page in Privacy & security settings.\n\nHere is the URI for the Location page in the Settings app:\nms-settings:privacy-location\nTo open the Location page in the Settings app, hold down the Ctrl key and select the link, or run the following command:\nstart ms-settings:privacy-location\n\nFunction WlanQueryInterface returns error 5:\nAccess is denied.\n';
  for (const t of [loc, 'Příkazy síťového prostředí potřebují oprávnění k poloze pro přístup k informacím o síti WLAN.\nms-settings:privacy-location\n']) {
    const l = D.parse(t);
    assert.equal(l.os, 'windows');
    assert.equal(l.connected, null);
    assert.deepEqual(l.warnings, ['devinfo.warn.location']);
  }
  // Wi-Fi 7 multi-link: no Channel / Band / Rssi lines, one "LinkID" line per link - the strongest link counts
  const mlo = fx('win-en-11-mlo.txt').replace(/(\n\s+LinkID: 0[^\r\n]*)/, '$1\n        LinkID: 1, Local: 02:11:22:33:44:57, AP: aa:bb:cc:11:22:34, RSSI: -58, Channel: 37, Band: 6 GHz, BW: 160');
  assert.notEqual(mlo, fx('win-en-11-mlo.txt'));
  const two2 = D.parse(mlo);
  assert.deepEqual(pick(two2.connected, ['band', 'channel', 'rssiDbm', 'widthMHz', 'wifiGen']), { band: 6, channel: 37, rssiDbm: -58, widthMHz: 160, wifiGen: 'Wi-Fi 7' });
  // SPEC 13: every link is recorded (strongest first); the measurement keeps them in wifi.links
  assert.deepEqual(two2.connected.links, [
    { band: 6, channel: 37, rssiDbm: -58, widthMHz: 160 },
    { band: 5, channel: 100, rssiDbm: -70, widthMHz: 80 },
  ]);
  assert.deepEqual(D.toWifi(two2.connected).links, two2.connected.links);
  assert.deepEqual(D.parse(fx('win-en-11-mlo.txt')).connected.links, [{ band: 5, channel: 100, rssiDbm: -70, widthMHz: 80 }], 'the real one-link output');
  assert.equal(D.parse(fx('win-en-11.txt')).connected.links, null, 'no link lines: no links');
  assert.equal('links' in D.toWifi(D.parse(fx('win-en-11.txt')).connected), false, 'older shape kept');
  // the same through the helper (raw text) and as a helper JSON object; garbage links are dropped one by one
  assert.deepEqual(D.fromObject({ v: 1, os: 'windows', raw: mlo }).connected.links, two2.connected.links);
  const hj = D.fromObject({ v: 1, os: 'windows', wifi: { ssid: 'X', state: 'connected', band: 6, links: [{ band: '5 GHz', channel: '100', rssi: -70, width: 80 }, { band: 6, channel: 37, rssiDbm: -58, widthMHz: 160 }, { band: 9, channel: 999, rssiDbm: 5 }, 'x', null, { widthMHz: 80 }] } });
  assert.deepEqual(hj.connected.links, [
    { band: 6, channel: 37, rssiDbm: -58, widthMHz: 160 },
    { band: 5, channel: 100, rssiDbm: -70, widthMHz: 80 },
  ]);
  assert.equal(D.linksOf('nope'), null);
  assert.equal(D.linksOf(Array.from({ length: 9 }, (_, i) => ({ channel: i + 1, rssiDbm: -60 - i }))).length, D.LIMITS.MAX_LINKS);
  // German labels
  const de = '    Name                   : WLAN\n    Status                 : Verbunden\n    SSID                   : Zuhause\n    BSSID                  : 11:22:33:44:55:66\n    Funktyp                : 802.11ac\n    Authentifizierung      : WPA2-Personal\n    Kanal                  : 100\n    Empfangsrate (MBit/s)  : 433,3\n    Übertragungsrate (MBit/s) : 433,3\n    Signal                 : 60%\n';
  const g = D.parse(de);
  assert.deepEqual(pick(g.connected, ['ssid', 'band', 'channel', 'rxRate', 'txRate', 'radio', 'rssiDbm', 'security']), { ssid: 'Zuhause', band: 5, channel: 100, rxRate: 433.3, txRate: 433.3, radio: '802.11ac', rssiDbm: -70, security: 'WPA2-Personal' });
});

test('macOS: hidden (redacted) SSID, not connected, other networks never win', () => {
  const red = D.parse(fx('mac-system-profiler.txt').replace('            Domov 5G:', '            <redacted>:'));
  assert.equal(red.connected.ssid, null);
  assert.equal(red.connected.rssiDbm, -56);
  assert.ok(red.warnings.includes('devinfo.warn.ssidHidden'));
  // Wi-Fi on but not connected: only "Other Local Wi-Fi Networks" - none of them is "connected"
  const lines = fx('mac-system-profiler.txt').split('\n');
  const a = lines.findIndex((l) => l.includes('Current Network Information'));
  const b = lines.findIndex((l) => l.includes('Other Local Wi-Fi Networks'));
  const off = [...lines.slice(0, a), ...lines.slice(b)].join('\n').replace('Status: Connected', 'Status: On');
  const r = D.parse(off);
  assert.equal(r.os, 'macos');
  assert.equal(r.connected, null);
  assert.deepEqual(r.warnings, ['devinfo.warn.notConnected']);
  // wdutil with redacted SSID / BSSID (no sudo)
  const w = D.parse(fx('mac-wdutil.txt').replace('SSID                 : Domov 5G', 'SSID                 : <redacted>').replace('BSSID                : 74:83:c2:1a:2b:3c', 'BSSID                : <redacted>'));
  assert.equal(w.connected.ssid, null);
  assert.equal(w.connected.bssid, null);
  assert.equal(w.connected.channel, 36);
  assert.ok(w.warnings.includes('devinfo.warn.ssidHidden'));
});

test('Linux nmcli: terse mode, hidden networks, SSIDs with spaces and diacritics', () => {
  const r = D.parse(fx('linux-nmcli.txt'));
  assert.deepEqual(
    r.interfaces.map((e) => [e.ssid, e.state, e.band, e.channel, e.signalPct, e.maxRate]),
    [
      ['Soused', 'visible', 2.4, 6, 45, 130],
      ['Domov 5G', 'connected', 5, 36, 74, 540],
      ['Domov', 'visible', 2.4, 1, 70, 195],
      ['Kavárna U Lípy', 'visible', 5, 149, 38, 270],
      [null, 'visible', 5, 44, 30, 270],
    ],
  );
  assert.equal(r.interfaces[0].security, 'WPA1 WPA2');
  // SIGNAL is NetworkManager's quality (-100..-40 dBm -> 0..100), not the Windows percentage
  assert.deepEqual(r.interfaces.map((e) => e.rssiDbm), [-73, -56, -58, -77, -82]);
  const terse = '*:Domov 5G:74\\:83\\:C2\\:1A\\:2B\\:3C:36:5180 MHz:540 Mbit/s:74:WPA2\n:Soused:F0\\:9F\\:C2\\:44\\:55\\:66:6:2437 MHz:130 Mbit/s:45:WPA1 WPA2\n';
  const t = D.parse(terse);
  assert.equal(t.source, 'nmcli');
  assert.deepEqual(pick(t.connected, KEYS), EXPECT['linux-nmcli.txt'].c);
  assert.equal(t.interfaces[1].ssid, 'Soused');
  // no network in use
  const none = D.parse(fx('linux-nmcli.txt').replace('*       Domov 5G', '        Domov 5G'));
  assert.equal(none.connected, null);
  assert.deepEqual(none.warnings, ['devinfo.warn.notConnected']);
});

test('the helper JSON (alone or inside its clipboard summary) is read and validated', () => {
  const obj = { v: 1, os: 'windows', at: 1759500000000, wifi: { ssid: 'Domov 5G', bssid: '74:83:C2:1A:2B:3C', band: 5, channel: 36, signalPct: 92, rssiDbm: -49, rxRate: 1201, txRate: 1201, radio: '802.11ax', security: 'WPA2-Personal', state: 'connected' } };
  for (const text of [JSON.stringify(obj), `Wi-Fi: Domov 5G · 5 GHz · kanál 36 · signál −49 dBm · linka 1201 Mb/s\n${JSON.stringify(obj, null, 2)}\n`]) {
    const r = D.parse(text);
    assert.equal(r.os, 'windows');
    assert.equal(r.source, 'helper');
    assert.equal(r.at, 1759500000000);
    assert.deepEqual(pick(r.connected, KEYS), EXPECT['win-en-11.txt'].c);
  }
  // raw text only: parsed with the same rules
  const raw = D.parse(JSON.stringify({ v: 1, os: 'linux', raw: fx('linux-iw.txt') }));
  assert.deepEqual(pick(raw.connected, KEYS), EXPECT['linux-iw.txt'].c);
  // what the helpers (pomocnik/) really send: {app, v, os, at (ISO), source, raw, error, hostname}
  const helper = (raw, error) => ({ app: 'wifi-heatmap-helper', v: 1, os: 'windows', at: '2026-10-03T12:00:00Z', source: 'netsh wlan show interfaces', raw, error, hostname: null });
  const ok = D.fromObject(helper(fx('win-en-10-two-adapters.txt'), null));
  assert.equal(ok.connected.ssid, 'Kocourkov');
  assert.deepEqual(ok.warnings, ['devinfo.warn.rssiFromPct'], 'the warnings of the raw text travel along');
  assert.equal(ok.at, Date.parse('2026-10-03T12:00:00Z'));
  const loc = D.fromObject(helper('Network shell commands need location permission to access WLAN information.\nms-settings:privacy-location\n', 'location'));
  assert.equal(loc.connected, null);
  assert.deepEqual(loc.warnings, ['devinfo.warn.location']);
  assert.deepEqual(D.fromObject(helper('', 'no-wifi')).warnings, ['devinfo.warn.noWifi']);
  assert.deepEqual(D.fromObject(helper(fx('win-cs-disconnected.txt'), 'not-connected')).warnings, ['devinfo.warn.notConnected']);
  assert.deepEqual(D.fromObject(helper('', 'constructor')).warnings, ['devinfo.warn.unknown'], 'unknown error codes are ignored safely');
  // a wifi object with gaps: the raw text fills them, a % signal stays marked as estimated
  const gap = D.fromObject({ v: 1, os: 'windows', wifi: { ssid: 'Jiný název' }, raw: fx('win-en-10-two-adapters.txt') });
  assert.equal(gap.connected.ssid, 'Jiný název');
  assert.equal(gap.connected.rssiDbm, -65);
  assert.equal(gap.connected.rssiFromPct, true);
  assert.equal(gap.connected.wifiGen, 'Wi-Fi 4');
  assert.deepEqual(gap.warnings, ['devinfo.warn.rssiFromPct']);
  // wrong types are dropped field by field
  const bad = D.fromObject({ os: 'beos', wifi: { ssid: { x: 1 }, bssid: 'nope', band: 7, channel: 999, rssiDbm: 30, signalPct: 300, rxRate: -1, radio: 5, security: ['x'], state: 'connected' } });
  assert.equal(bad.os, null);
  assert.deepEqual(pick(bad.connected, ['ssid', 'bssid', 'band', 'channel', 'rssiDbm', 'signalPct', 'rxRate', 'radio', 'security']), { ssid: null, bssid: null, band: null, channel: null, rssiDbm: null, signalPct: null, rxRate: null, radio: null, security: null });
});

test('garbage never throws; empty, unknown and huge inputs give warnings', () => {
  assert.deepEqual(D.parse('').warnings, ['devinfo.warn.empty']);
  assert.deepEqual(D.parse('   \n ').warnings, ['devinfo.warn.empty']);
  assert.deepEqual(D.parse(null).warnings, ['devinfo.warn.empty']);
  assert.deepEqual(D.parse(42).warnings, ['devinfo.warn.empty']);
  assert.deepEqual(D.parse('hello world\nfoo: bar\n').warnings, ['devinfo.warn.unknown']);
  assert.deepEqual(D.parse('{"a":1}').warnings, ['devinfo.warn.unknown']);
  const huge = fx('win-en-11.txt') + 'x'.repeat(400000);
  const h = D.parse(huge);
  assert.ok(h.warnings.includes('devinfo.warn.truncated'));
  assert.equal(h.connected.ssid, 'Domov 5G');
  // random junk and mutated fixtures (deterministic)
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const alphabet = ' :\n\t%-.,/*()[]{}"\'\\0123456789abcdefABCDEFxyzGHzMHzdBmMbit/sSSIDBSSIDSignálKanál';
  for (let k = 0; k < 300; k++) {
    let t = '';
    const n = Math.floor(rnd() * 400);
    for (let i = 0; i < n; i++) t += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = D.parse(t);
    assert.ok(Array.isArray(r.interfaces) && Array.isArray(r.warnings));
  }
  for (const f of Object.keys(EXPECT)) {
    const src = fx(f);
    for (let k = 0; k < 20; k++) {
      const a = Math.floor(rnd() * src.length);
      const b = a + Math.floor(rnd() * 80);
      const r = D.parse(src.slice(0, a) + src.slice(b));
      if (r.connected) {
        const c = r.connected;
        assert.ok(c.band === null || [2.4, 5, 6].includes(c.band));
        assert.ok(c.rssiDbm === null || (c.rssiDbm <= 0 && c.rssiDbm >= -120));
        assert.ok(c.signalPct === null || (c.signalPct >= 0 && c.signalPct <= 100));
        assert.ok(c.ssid === null || [...c.ssid].length <= 64);
      }
    }
  }
});

test('band / channel / frequency / generation helpers', () => {
  assert.equal(D.bandFromChannel(1), 2.4);
  assert.equal(D.bandFromChannel(14), 2.4);
  assert.equal(D.bandFromChannel(32), 5);
  assert.equal(D.bandFromChannel(177), 5);
  assert.equal(D.bandFromChannel(15), null);
  assert.equal(D.bandFromChannel(233), null, '6 GHz channels need the frequency or an explicit band');
  assert.equal(D.bandFromFreq(2412), 2.4);
  assert.equal(D.bandFromFreq(5180), 5);
  assert.equal(D.bandFromFreq(5885), 5);
  assert.equal(D.bandFromFreq(5925), 6);
  assert.equal(D.bandFromFreq(5935), 6);
  assert.equal(D.bandFromFreq(7125), 6);
  assert.equal(D.bandFromFreq(7200), null);
  for (const [t, b] of [['5 GHz', 5], ['2,4 GHz', 2.4], ['2.4GHz', 2.4], ['(6GHz, 160MHz)', 6], ['Pásmo 6 GHz', 6], ['36 (5GHz, 80MHz)', 5], ['nothing', null], ['25 GHz', null]]) assert.equal(D.bandFromText(t), b, t);
  for (const [ch, b, f] of [[1, 2.4, 2412], [13, 2.4, 2472], [14, 2.4, 2484], [36, 5, 5180], [165, 5, 5825], [1, 6, 5955], [2, 6, 5935], [37, 6, 6135], [233, 6, 7115]]) {
    assert.equal(D.freqOf(ch, b), f, `${ch} @ ${b}`);
    assert.equal(D.channelOf(f), ch, `${f} MHz`);
  }
  for (const [r, b, g] of [['802.11ax', 5, 'Wi-Fi 6'], ['802.11ax', 6, 'Wi-Fi 6E'], ['802.11ax', 2.4, 'Wi-Fi 6'], ['802.11be', 6, 'Wi-Fi 7'], ['802.11be', 5, 'Wi-Fi 7'], ['802.11ac', 5, 'Wi-Fi 5'], ['802.11n', 2.4, 'Wi-Fi 4'], ['11ax', 5, 'Wi-Fi 6'], ['802.11g', 2.4, 'Wi-Fi 3'], ['bogus', 5, null]]) assert.equal(D.wifiGen(r, b), g, `${r} ${b}`);
  assert.equal(D.radioOf('PHY Mode 11be'), '802.11be');
  assert.equal(D.pctToDbm(92), -54);
  assert.equal(D.pctToDbm(null), null);
});

test('toWifi: the measurement object (SPEC 8)', () => {
  const c = D.parse(fx('win-cs-6e.txt')).connected;
  assert.deepEqual(D.toWifi(c), { ssid: 'Chalupa_6E', bssid: '9c:05:d6:aa:bb:cc', channel: 37, band: 6, rxRate: 2402, txRate: 2402, radio: '802.11ax', security: 'WPA3-Personal' });
  assert.equal(D.toWifi(null), null);
  assert.equal(D.toWifi({}), null);
});

test('commands offered to the user are the ones the parser reads', () => {
  assert.equal(D.COMMANDS.windows.cmd, 'netsh wlan show interfaces | clip');
  assert.equal(D.COMMANDS.windows.powershell, 'netsh wlan show interfaces | Set-Clipboard');
  assert.equal(D.COMMANDS.macos.copy, 'system_profiler SPAirPortDataType | pbcopy');
  assert.match(D.COMMANDS.linux.xclip, /^nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi \| xclip -selection clipboard$/);
  assert.ok(Object.isFrozen(D.COMMANDS) && Object.isFrozen(D.COMMANDS.windows));
});

test('strings: every warning / error key exists in cs and en with the same placeholders; the source emits only those', () => {
  const dicts = { cs: {}, en: {} };
  const sandbox = { WH: { i18n: { add: (l, d) => Object.assign(dicts[l], d) } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(STRINGS, 'utf8'), sandbox);
  const keys = [...D.WARNINGS, ...D.HASH_ERRORS];
  assert.deepEqual(Object.keys(dicts.cs).sort(), keys.slice().sort());
  assert.deepEqual(Object.keys(dicts.en).sort(), keys.slice().sort());
  for (const k of keys) assert.ok(dicts.cs[k] && dicts.en[k], k);
  const src = readFileSync(FILE, 'utf8');
  const used = new Set([...src.matchAll(/'(devinfo\.(?:warn|hash)\.\w+)'/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), keys.slice().sort());
});

test('source hygiene: pure (no DOM / network / storage), classic script, Safari-16 safe, ASCII code', () => {
  const src = readFileSync(FILE, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const re of [/\bdocument\b/, /\bwindow\b/, /\bnavigator\b/, /\blocalStorage\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\beval\s*\(/, /new\s+Function\b/, /\bBuffer\b/, /\bprocess\./, /console\.(log|debug|info)/]) assert.ok(!re.test(code), `uses ${re}`);
  assert.ok(!/\(\?<[=!]/.test(code), 'no regex look-behind (Safari < 16.4)');
  assert.ok(!/<\/script/i.test(src) && !/<!--/.test(src));
  assert.ok(!/[^\x00-\x7f]/.test(code), 'non-ASCII characters only in comments (escapes in code)');
  assert.ok(!/\r/.test(src), 'LF line endings');
  new vm.Script(src, { filename: FILE });
});
