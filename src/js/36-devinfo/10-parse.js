/* WiFi Heatmap Architect - WH.devinfo: Wi-Fi details out of the text of OS commands (SPEC 8 / 8.1 / 8.2).
 *
 * A web page cannot read the SSID, BSSID, signal (dBm), channel, band or link rate on any OS - the user runs a command
 * (or the local helper does) and pastes its output; this file turns that text into numbers. Pure and DOM-free (no
 * navigator, no network, no storage), so it runs under Node for the tests and in the browser.
 *
 *   WH.devinfo.parse(text) -> {os, source, interfaces[], connected|null, warnings[]}
 *     Windows   `netsh wlan show interfaces`             (English, Czech, Slovak, German labels; also text that went
 *                                                          through `| clip` with broken diacritics)
 *     macOS     `system_profiler SPAirPortDataType`      (text and -json), `sudo wdutil info`
 *     Linux     `nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi` (also plain `nmcli dev wifi`, -t),
 *               `iw dev <if> link`
 *     helper    the JSON of the local helper (also embedded in its clipboard summary)
 *   WH.devinfo.fromHash('#wifi=<base64url JSON>') / toHash(obj) - the helper's one-shot hand-over (SPEC 8.2)
 *   WH.devinfo.toWifi(connected) -> the measurement's `wifi` object {ssid, bssid, channel, band, rxRate, txRate, radio,
 *                                   security, links? (Wi-Fi 7 MLO)}
 *
 * An interface / connection (and `connected`) is
 *   {name, description, state:'connected'|'disconnected'|'visible'|string|null, ssid, bssid, band:2.4|5|6|null,
 *    channel, freqMHz, widthMHz, signalPct (0..100), rssiDbm, rssiFromPct, noiseDbm, rxRate, txRate, maxRate (Mb/s),
 *    radio ('802.11ax'), wifiGen ('Wi-Fi 6E'), security, links}
 * links = every Wi-Fi 7 multi-link (MLO) link [{band, channel, rssiDbm, widthMHz}], strongest first, or null (SPEC 13);
 * the strongest link is the primary one: it gives band / channel / rssiDbm / widthMHz when the adapter lines do not.
 * (null where unknown). Band: explicit text ("5 GHz", "Pásmo 6 GHz", "(6GHz, 160MHz)", "6g37/160") first, then the
 * frequency (5925-7125 MHz = 6 GHz), then the channel (1-14 = 2.4, 32-177 = 5). dBm: the RSSI when the output has it
 * (Windows Wi-Fi 7 prints it on its "LinkID: ..., RSSI: -70, Channel: 100, Band: 5 GHz" line), else from the percentage
 * (rssiFromPct): Windows signal % / 2 - 100, nmcli quality 0.6 * q - 100 (NetworkManager maps -100..-40 dBm onto
 * 0..100). Warnings are i18n keys (devinfo.warn.*, strings in strings-parse.js).
 */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const D = (g.WH.devinfo = g.WH.devinfo || {});

  const MAX_TEXT = 300000; // characters of pasted text that are looked at
  const MAX_IF = 16;
  const MAX_NETWORKS = 200;
  const HASH_MAX = 12000; // characters of the base64url payload in #wifi=
  const RAW_MAX = 6000; // characters of raw command text carried in a hash
  const SSID_MAX = 64;

  const COMMANDS = Object.freeze({
    windows: Object.freeze({ show: 'netsh wlan show interfaces', cmd: 'netsh wlan show interfaces | clip', powershell: 'netsh wlan show interfaces | Set-Clipboard' }),
    macos: Object.freeze({ show: 'system_profiler SPAirPortDataType', copy: 'system_profiler SPAirPortDataType | pbcopy', json: 'system_profiler SPAirPortDataType -json | pbcopy', wdutil: 'sudo wdutil info | pbcopy' }),
    linux: Object.freeze({
      show: 'nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi',
      xclip: 'nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi | xclip -selection clipboard',
      wlcopy: 'nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi | wl-copy',
      iw: 'iw dev wlan0 link',
    }),
  });

  // ---------------------------------------------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------------------------------------------
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const r1 = (v) => Math.round(v * 10) / 10;

  /** Lower case, no diacritics, single spaces: "Rychlost příjmu (Mb/s)" -> "rychlost prijmu (mb/s)". */
  function keyOf(s) {
    return String(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Text without control characters, trimmed, <= max code points; '' -> null. */
  function textOf(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .trim();
    if (!s) return null;
    const cps = [...s];
    return cps.length > max ? cps.slice(0, max).join('').trim() : s;
  }

  /** First number in a text: "1 201" -> 1201, "866,7" -> 866.7, "92 %" -> 92, "-54 dBm" -> -54; null when none. */
  function numOf(v) {
    if (isNum(v)) return v;
    if (typeof v !== 'string') return null;
    const s = v.replace(/(\d)[\s\u00a0\u202f'](?=\d{3}(?:\D|$))/g, '$1');
    const m = /[-\u2212]?\d+(?:[.,]\d+)?/.exec(s);
    if (!m) return null;
    const n = Number(m[0].replace('\u2212', '-').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  const MAC_FIND = /\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i;
  /** 'aa:bb:cc:dd:ee:ff' out of a text, or null. */
  function macOf(v) {
    if (typeof v !== 'string') return null;
    const m = MAC_FIND.exec(v.replace(/\\:/g, ':'));
    return m ? m[1].toLowerCase().replace(/-/g, ':') : null;
  }

  /** 2.4 | 5 | 6 from a text such as "5 GHz", "2,4 GHz", "(6GHz, 160MHz)", "Pásmo 6 GHz"; null otherwise. */
  function bandFromText(v) {
    if (isNum(v)) return v === 2.4 || v === 5 || v === 6 ? v : null;
    if (typeof v !== 'string') return null;
    const m = /(?:^|[^\d.,])(2[.,]4|5|6)\s*G(?:hz)?\b/i.exec(v);
    if (!m) return null;
    return m[1] === '5' ? 5 : m[1] === '6' ? 6 : 2.4;
  }

  /** Band of a centre frequency in MHz (2400-2500, 4900-5924, 5925-7125). */
  function bandFromFreq(f) {
    if (!isNum(f)) return null;
    if (f >= 2400 && f <= 2500) return 2.4;
    if (f >= 4900 && f < 5925) return 5;
    if (f >= 5925 && f <= 7125) return 6;
    return null;
  }

  /** Band of a channel number when nothing else is known: 1-14 = 2.4 GHz, 32-177 = 5 GHz. */
  function bandFromChannel(ch) {
    if (!Number.isInteger(ch)) return null;
    if (ch >= 1 && ch <= 14) return 2.4;
    if (ch >= 32 && ch <= 177) return 5;
    return null;
  }

  /** Centre frequency (MHz) of a channel on a band. */
  function freqOf(ch, band) {
    if (!Number.isInteger(ch)) return null;
    if (band === 2.4) return ch === 14 ? 2484 : ch >= 1 && ch <= 13 ? 2407 + 5 * ch : null;
    if (band === 5) return ch >= 32 && ch <= 177 ? 5000 + 5 * ch : null;
    if (band === 6) return ch >= 1 && ch <= 233 ? (ch === 2 ? 5935 : 5950 + 5 * ch) : null;
    return null;
  }

  /** Channel of a centre frequency (MHz). */
  function channelOf(f) {
    if (!isNum(f)) return null;
    const b = bandFromFreq(f);
    const ch = b === 2.4 ? (Math.round(f) === 2484 ? 14 : Math.round((f - 2407) / 5)) : b === 5 ? Math.round((f - 5000) / 5) : b === 6 ? (Math.round(f) === 5935 ? 2 : Math.round((f - 5950) / 5)) : null;
    return Number.isInteger(ch) && ch > 0 ? ch : null;
  }

  /** '802.11ax' from "802.11ax", "11ax", "802.11 ax", "IEEE 802.11be"...; null otherwise. */
  function radioOf(v) {
    if (typeof v !== 'string') return null;
    const m = /(?:802\.11\s*|\b11)(be|ax|ac|ad|ah|n|g|b|a)\b/i.exec(v);
    return m ? `802.11${m[1].toLowerCase()}` : null;
  }

  /** Marketing generation of a radio type on a band: 802.11ax -> Wi-Fi 6 (Wi-Fi 6E on 6 GHz), 802.11be -> Wi-Fi 7. */
  function wifiGen(radio, band) {
    const r = radioOf(radio || '');
    if (!r) return null;
    const k = r.slice(6);
    if (k === 'be') return 'Wi-Fi 7';
    if (k === 'ax') return band === 6 ? 'Wi-Fi 6E' : 'Wi-Fi 6';
    if (k === 'ac') return 'Wi-Fi 5';
    if (k === 'n') return 'Wi-Fi 4';
    if (k === 'g') return 'Wi-Fi 3';
    if (k === 'a') return 'Wi-Fi 2';
    if (k === 'b') return 'Wi-Fi 1';
    return null;
  }

  /** Radio type from iw's bitrate flags: EHT -> 802.11be, HE -> ax, VHT -> ac, MCS -> n. */
  function radioFromIw(v) {
    if (typeof v !== 'string') return null;
    if (/\bEHT-/i.test(v)) return '802.11be';
    if (/\bHE-/i.test(v)) return '802.11ax';
    if (/\bVHT-/i.test(v)) return '802.11ac';
    if (/\bMCS\b/i.test(v)) return '802.11n';
    return null;
  }

  /** Normalized connection state. */
  function stateOf(v) {
    const k = keyOf(v || '');
    if (!k) return null;
    if (/odpoj|disconn|getrennt|deconn|desconect/.test(k)) return 'disconnected';
    if (/ipojen|^connected|verbunden|^connect|conectado|^associated|^running/.test(k)) return 'connected';
    return textOf(k, 30);
  }

  /** A Wi-Fi network name, or null for "", "--", hidden or redacted names (sets ctx.redacted). */
  function ssidOf(v, flags) {
    const s = textOf(v, SSID_MAX);
    if (!s || s === '--') return null;
    if (/^<\s*(redacted|hidden|private)\s*>$/i.test(s)) {
      if (flags) flags.redacted = true;
      return null;
    }
    return s;
  }

  /** "WPA2-Personal" / "spairport_security_mode_wpa2_personal" -> readable text (<= 40). */
  function securityOf(v) {
    let s = textOf(v, 80);
    if (!s) return null;
    s = s.replace(/^spairport_security_mode_/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (/^none$/i.test(s)) s = 'Open';
    s = s.replace(/\b(wpa\d?|wep|sae|owe|psk|tkip|ccmp|gcmp)\b/gi, (w) => w.toUpperCase()).replace(/\b(personal|enterprise|transition|open)\b/gi, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    return textOf(s, 40);
  }

  function blank() {
    return {
      name: null,
      description: null,
      state: null,
      ssid: null,
      bssid: null,
      band: null,
      channel: null,
      freqMHz: null,
      widthMHz: null,
      signalPct: null,
      rssiDbm: null,
      rssiFromPct: false,
      noiseDbm: null,
      rxRate: null,
      txRate: null,
      maxRate: null,
      radio: null,
      wifiGen: null,
      security: null,
      links: null,
    };
  }

  const rate = (v) => {
    const n = numOf(v);
    return n !== null && n >= 0 && n <= 100000 ? r1(n) : null;
  };
  const dbm = (v) => {
    const n = numOf(v);
    return n !== null && n <= 0 && n >= -120 ? Math.round(n) : null;
  };
  const pct = (v) => {
    const n = numOf(v);
    return n !== null && n >= 0 && n <= 100 ? Math.round(n) : null;
  };
  const chan = (v) => {
    const n = numOf(v);
    return n !== null && Number.isInteger(n) && n >= 1 && n <= 233 ? n : null;
  };

  /**
   * Fill the derived fields of an entry: band (explicit > frequency > channel), frequency <-> channel, dBm from % (or
   * % from dBm), radio type and Wi-Fi generation. Returns the same object.
   */
  function finish(e) {
    if (e.band === null && e.freqMHz !== null) e.band = bandFromFreq(e.freqMHz);
    if (e.channel === null && e.freqMHz !== null) e.channel = channelOf(e.freqMHz);
    if (e.band === null) e.band = bandFromChannel(e.channel);
    if (e.freqMHz === null) e.freqMHz = freqOf(e.channel, e.band);
    if (e.rssiDbm === null && e.signalPct !== null) {
      e.rssiDbm = Math.round(e.signalPct / 2 - 100);
      e.rssiFromPct = true;
    }
    if (e.signalPct === null && e.rssiDbm !== null) e.signalPct = Math.round(clamp(2 * (e.rssiDbm + 100), 0, 100));
    e.radio = radioOf(e.radio || '') || null;
    e.wifiGen = wifiGen(e.radio, e.band);
    return e;
  }

  /** The entry the user is connected with: connected state first (strongest wins), else one with SSID + signal. */
  function pickConnected(list, warnings) {
    const on = list.filter((e) => e.state === 'connected');
    const pool = on.length ? on : list.filter((e) => e.state === null && e.ssid && (e.rssiDbm !== null || e.bssid));
    if (!pool.length) return null;
    if (pool.length > 1) warnings.push('devinfo.warn.multiple');
    return pool.slice().sort((a, b) => (b.rssiDbm === null ? -999 : b.rssiDbm) - (a.rssiDbm === null ? -999 : a.rssiDbm))[0];
  }

  /** "key : value" lines (first colon; the key itself never has one). */
  function kvLines(lines) {
    const out = [];
    for (const line of lines) {
      const m = /^\s*([^:]{1,80}?)\s*:\s?(.*)$/.exec(line);
      if (m) out.push({ key: keyOf(m[1]), raw: m[1].trim(), value: m[2].trim() });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Windows: netsh wlan show interfaces
  // ---------------------------------------------------------------------------------------------------------------
  // Keys after keyOf(); ".{1,4}" stands for a letter with diacritics that may arrive broken through `| clip`.
  const WIN_FIELDS = [
    ['name', /^(name|n.{1,4}zev|n.{1,4}zov|nom|nombre)$/],
    ['description', /^(description|popis|beschreibung|descripci.{1,3}n)$/],
    ['state', /^(state|stav|status|.{1,3}tat|estado)$/],
    ['ssid', /^ssid$/],
    ['bssid', /bssid/],
    ['band', /^(band|p.{1,4}smo|frequenzband|bande|banda)$/],
    ['channel', /^(channel|kan.{1,4}l|canal)$/],
    ['rx', /(receive rate|rychlost p.{1,6}jmu|r.{1,3}chlos.{1,3} pr.{1,3}jmu|empfangsrate|vitesse de r.{1,3}ception|velocidad de recepci)/],
    ['tx', /(transmit rate|rychlost odes|r.{1,3}chlos.{1,3} odos|bertragungsrate|vitesse de transmission|velocidad de transmisi)/],
    ['radio', /(radio type|typ radi|funktyp|type de radio|tipo de radio)/],
    ['auth', /^(authentication|ov.{1,4}.ov.{1,4}n.{1,4}|ov.{1,4}ov.{1,4}n.{1,4}|overenie|authentifizierung|authentification|autenticaci.{1,3}n)$/],
    ['signal', /^(signal|sign.{1,4}l|se.{1,3}al)$/],
    ['rssi', /^rssi$/],
  ];
  const winField = (key) => {
    for (const [f, re] of WIN_FIELDS) if (re.test(key)) return f;
    return null;
  };
  const WIN_NO_WIFI = /no wireless interface|wlansvc|bezdr.{1,4}tov.{1,4} rozhran|kein drahtlos/i;
  // Windows 11 24H2+: with Location turned off netsh prints only this (the settings URI is the same in every language)
  const WIN_LOCATION = /ms-settings:privacy-location|location permission|opr.{1,4}vn.{1,4}n.{1,4} k poloze/i;

  function looksWindows(kv) {
    let hits = 0;
    const seen = new Set();
    for (const r of kv) {
      const f = winField(r.key);
      if (f && !seen.has(f)) {
        seen.add(f);
        hits++;
      }
    }
    return (seen.has('ssid') || seen.has('name') || seen.has('state')) && hits >= 3;
  }

  /**
   * Wi-Fi 7 (multi-link): netsh prints "MLD AP BSSID" and one indented line per link instead of Channel / Band / Rssi:
   *   "LinkID: 0, Local: 02:11:22:33:44:56, AP: aa:bb:cc:11:22:33, RSSI: -70, Channel: 100, Band: 5 GHz, BW: 80"
   * -> {ap, rssi, channel, band, width} of the strongest link (the primary one), or null. With `all` every link is
   * pushed there too (SPEC 13: the measurement records each MLO link).
   */
  function mldLink(values, all) {
    let best = null;
    for (const v of values || []) {
      const s = String(v);
      const get = (re) => {
        const m = re.exec(s);
        return m ? m[1] : null;
      };
      const l = {
        ap: macOf(get(/\bap\s*:\s*([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i) || ''),
        rssi: dbm(get(/\brssi\s*:\s*([^,\s]+)/i)),
        channel: chan(get(/\b(?:channel|kan.{1,4}l|kanal|canal)\s*:\s*(\d{1,3})\b/i)),
        band: bandFromText(get(/\b(?:band|p.{1,4}smo|bande|banda)\s*:\s*([^,]+)/i) || ''),
        width: numOf(get(/\b(?:bw|bandwidth)\s*:\s*(\d{2,3})\b/i)),
      };
      if (l.rssi === null && l.channel === null && l.band === null) continue;
      if (l.band === null && l.channel !== null) l.band = bandFromChannel(l.channel);
      if (all && all.length < MAX_LINKS) all.push(l);
      if (!best || (l.rssi !== null && (best.rssi === null || l.rssi > best.rssi))) best = l;
    }
    return best;
  }

  /** At most this many multi-link (MLO) links are reported per connection. */
  const MAX_LINKS = 4;
  const WIDTHS = [20, 40, 80, 160, 320];

  /**
   * The links of a multi-link (Wi-Fi 7 MLO) connection, strongest first (unknown signal last, input order on ties):
   * [{band, channel, rssiDbm, widthMHz}], or null when there are none. Input: mldLink() links or {band, channel,
   * rssiDbm|rssi, widthMHz|width} objects (the helper's JSON) - every field validated.
   */
  function linksOf(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const l of list.slice(0, 16)) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) continue;
      const b = isNum(l.band) ? l.band : bandFromText(String(l.band || ''));
      const ch = isNum(l.channel) ? chan(l.channel) : chan(typeof l.channel === 'string' ? l.channel : '');
      const r = isNum(l.rssiDbm) ? dbm(l.rssiDbm) : isNum(l.rssi) ? dbm(l.rssi) : null;
      const w = isNum(l.widthMHz) ? l.widthMHz : isNum(l.width) ? l.width : null;
      const e = { band: b === 2.4 || b === 5 || b === 6 ? b : bandFromChannel(ch), channel: ch, rssiDbm: r, widthMHz: WIDTHS.includes(w) ? w : null };
      if (e.band !== null || e.channel !== null || e.rssiDbm !== null) out.push(e);
    }
    const rank = (e) => (e.rssiDbm === null ? -Infinity : e.rssiDbm);
    const sorted = out.map((e, i) => ({ e, i })).sort((a, b) => rank(b.e) - rank(a.e) || a.i - b.i).map((x) => x.e);
    return sorted.length ? sorted.slice(0, MAX_LINKS) : null;
  }

  function parseWindows(kv, res) {
    const blocks = [];
    let cur = null;
    for (const r of kv) {
      if (/^linkid\b/.test(r.key)) {
        if (cur) (cur.links = cur.links || []).push(r.value);
        continue;
      }
      const f = winField(r.key);
      if (!f) continue;
      if (f === 'name' || !cur) {
        if (blocks.length >= MAX_IF) break;
        cur = {};
        blocks.push(cur);
      }
      if (cur[f] === undefined) cur[f] = r.value;
    }
    const flags = {};
    for (const b of blocks) {
      const e = blank();
      e.name = textOf(b.name, 60);
      e.description = textOf(b.description, 80);
      e.state = b.state !== undefined ? stateOf(b.state) : null;
      e.ssid = ssidOf(b.ssid, flags);
      e.bssid = macOf(b.bssid);
      e.band = bandFromText(b.band);
      e.channel = chan(b.channel);
      e.rxRate = rate(b.rx);
      e.txRate = rate(b.tx);
      e.radio = b.radio || null;
      e.security = securityOf(b.auth);
      e.signalPct = pct(b.signal);
      e.rssiDbm = dbm(b.rssi);
      const all = [];
      const link = mldLink(b.links, all);
      e.links = linksOf(all);
      if (link) {
        if (e.band === null) e.band = link.band;
        if (e.channel === null) e.channel = link.channel;
        if (e.rssiDbm === null) e.rssiDbm = link.rssi;
        if (e.widthMHz === null && [20, 40, 80, 160, 320].includes(link.width)) e.widthMHz = link.width;
        if (e.bssid === null) e.bssid = link.ap;
      }
      // a disconnected adapter still lists its name and state only
      if (e.state === 'disconnected') {
        e.ssid = null;
        e.bssid = null;
      }
      res.interfaces.push(finish(e));
    }
    if (flags.redacted) res.warnings.push('devinfo.warn.ssidHidden');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // macOS: system_profiler SPAirPortDataType (text), -json, wdutil info
  // ---------------------------------------------------------------------------------------------------------------
  const SIG_NOISE = /(-\d+)\s*dBm\s*\/\s*(-\d+)\s*dBm/i;
  const MAC_CHANNEL = /^(\d+)\s*\(\s*(2|5|6)\s*GHz\s*(?:,\s*(\d+)\s*MHz)?/i;

  function macChannel(e, v) {
    if (isNum(v)) {
      e.channel = chan(v);
      return;
    }
    if (typeof v !== 'string') return;
    const m = MAC_CHANNEL.exec(v.trim());
    if (m) {
      e.channel = chan(m[1]);
      e.band = m[2] === '2' ? 2.4 : Number(m[2]);
      if (m[3]) e.widthMHz = Number(m[3]);
    } else {
      e.channel = chan(v);
      e.band = bandFromText(v);
    }
  }

  function parseMacText(lines, res) {
    const rows = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      const indent = /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;
      const t = l.trim();
      if (t.endsWith(':')) rows.push({ indent, key: t.slice(0, -1).trim(), value: '', header: true });
      else {
        const m = /^(.*?):\s*(.*)$/.exec(t);
        if (m) rows.push({ indent, key: m[1].trim(), value: m[2].trim(), header: false });
      }
    }
    const kids = (i) => {
      const out = [];
      for (let j = i + 1; j < rows.length && rows[j].indent > rows[i].indent; j++) out.push(j);
      return out;
    };
    const flags = {};
    for (let i = 0; i < rows.length && res.interfaces.length < MAX_IF; i++) {
      const r = rows[i];
      if (!r.header || !/^[a-z]{2,6}\d{1,2}$/i.test(r.key)) continue;
      const inner = kids(i);
      if (!inner.length) continue;
      const e = blank();
      e.name = r.key;
      let currentHdr = -1;
      let firstNetHdr = -1;
      for (const j of inner) {
        const q = rows[j];
        const k = keyOf(q.key);
        if (q.indent === rows[inner[0]].indent && !q.header) {
          if (/^(status|stav)$/.test(k)) e.state = stateOf(q.value);
          else if (/card type|typ karty/.test(k)) e.description = textOf(q.value, 80);
        }
        if (q.header && currentHdr < 0 && /current network|aktualn/.test(k)) currentHdr = j;
        if (q.header && firstNetHdr < 0 && j > i && rows.slice(j + 1, j + 8).some((x) => SIG_NOISE.test(x.value))) firstNetHdr = j;
      }
      // the network block: the first header below "Current Network Information" (any language: the first network
      // block when the interface says it is connected)
      let net = -1;
      if (currentHdr >= 0) net = currentHdr + 1 < rows.length && rows[currentHdr + 1].header && rows[currentHdr + 1].indent > rows[currentHdr].indent ? currentHdr + 1 : -1;
      else if (e.state === 'connected' && firstNetHdr >= 0) net = firstNetHdr;
      if (net >= 0) {
        e.ssid = ssidOf(rows[net].key, flags);
        for (const j of kids(net)) {
          const q = rows[j];
          const k = keyOf(q.key);
          const sn = SIG_NOISE.exec(q.value);
          if (sn) {
            e.rssiDbm = dbm(sn[1]);
            e.noiseDbm = dbm(sn[2]);
          } else if (/phy/.test(k) || /^802\.11\w+$/i.test(q.value)) e.radio = q.value;
          else if (/channel|kanal/.test(k) || MAC_CHANNEL.test(q.value)) macChannel(e, q.value);
          else if (/secur|zabezp/.test(k)) e.security = securityOf(q.value);
          else if (/transmit rate|tx rate|rychlost|rate/.test(k) && !/mcs/.test(k)) e.txRate = rate(q.value);
          else if (/bssid/.test(k)) e.bssid = macOf(q.value);
        }
        if (e.state === null) e.state = 'connected';
      }
      res.interfaces.push(finish(e));
    }
    if (flags.redacted) res.warnings.push('devinfo.warn.ssidHidden');
  }

  function parseMacJson(data, res) {
    const top = Array.isArray(data.SPAirPortDataType) ? data.SPAirPortDataType : [];
    const flags = {};
    for (const item of top) {
      const list = item && Array.isArray(item.spairport_airport_interfaces) ? item.spairport_airport_interfaces : [];
      for (const it of list) {
        if (!it || typeof it !== 'object' || res.interfaces.length >= MAX_IF) continue;
        const e = blank();
        e.name = textOf(it._name, 20);
        e.description = textOf(it.spairport_card_type || it.spairport_wireless_card_type, 80);
        const st = typeof it.spairport_status_information === 'string' ? it.spairport_status_information.replace(/^spairport_status_/, '') : null;
        e.state = st ? stateOf(st) : null;
        const cur = it.spairport_current_network_information;
        if (cur && typeof cur === 'object') {
          e.ssid = ssidOf(cur._name, flags);
          macChannel(e, cur.spairport_network_channel);
          e.radio = typeof cur.spairport_network_phymode === 'string' ? cur.spairport_network_phymode : null;
          e.txRate = rate(cur.spairport_network_rate);
          e.security = securityOf(cur.spairport_security_mode);
          e.bssid = macOf(cur.spairport_network_bssid);
          const sn = SIG_NOISE.exec(String(cur.spairport_signal_noise || ''));
          if (sn) {
            e.rssiDbm = dbm(sn[1]);
            e.noiseDbm = dbm(sn[2]);
          }
          if (e.state === null) e.state = 'connected';
        }
        res.interfaces.push(finish(e));
      }
    }
    if (flags.redacted) res.warnings.push('devinfo.warn.ssidHidden');
  }

  const WD_CHANNEL = /^(2|5|6)g(\d+)(?:\/(\d+))?/i;
  function looksWdutil(kv) {
    return kv.some((r) => /^tx rate$/.test(r.key)) && kv.some((r) => /^(op mode|rssi|noise|cca)$/.test(r.key) || WD_CHANNEL.test(r.value));
  }

  function parseWdutil(kv, res) {
    const e = blank();
    const flags = {};
    const once = new Set();
    const first = (k) => {
      if (once.has(k)) return false;
      once.add(k);
      return true;
    };
    for (const r of kv) {
      const k = r.key;
      const v = r.value;
      if (k === 'ssid' && first(k)) e.ssid = ssidOf(v, flags);
      else if (k === 'bssid' && first(k)) {
        e.bssid = macOf(v);
        if (!e.bssid && /redacted/i.test(v)) flags.redacted = true;
      } else if (k === 'rssi' && first(k)) e.rssiDbm = dbm(v);
      else if (k === 'noise' && first(k)) e.noiseDbm = dbm(v);
      else if (k === 'tx rate' && first(k)) e.txRate = rate(v);
      else if (k === 'security' && first(k)) e.security = securityOf(v);
      else if (k === 'phy mode' && first(k)) e.radio = v;
      else if (k === 'interface name' && first(k)) e.name = textOf(v, 20);
      else if (k === 'channel' && WD_CHANNEL.test(v) && first(k)) {
        const m = WD_CHANNEL.exec(v);
        e.band = m[1] === '2' ? 2.4 : Number(m[1]);
        e.channel = chan(m[2]);
        if (m[3]) e.widthMHz = Number(m[3]);
      } else if (k === 'power' && first(k) && /^off/i.test(v)) e.state = 'disconnected';
    }
    if (e.state === null) e.state = e.ssid || e.bssid || e.rssiDbm !== null ? 'connected' : 'disconnected';
    if (flags.redacted) res.warnings.push('devinfo.warn.ssidHidden');
    res.interfaces.push(finish(e));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Linux: iw dev <if> link, nmcli dev wifi
  // ---------------------------------------------------------------------------------------------------------------
  const IW_CONNECTED = /^\s*Connected to ([0-9a-f]{2}(?::[0-9a-f]{2}){5})(?:\s*\(on ([\w.-]+)\))?/im;
  const IW_NOT = /^\s*Not connected\.?\s*$/im;

  function parseIw(text, lines, res) {
    const c = IW_CONNECTED.exec(text);
    const e = blank();
    if (!c) {
      e.state = 'disconnected';
      res.interfaces.push(e);
      return;
    }
    e.state = 'connected';
    e.bssid = macOf(c[1]);
    e.name = c[2] || null;
    for (const l of lines) {
      const m = /^\s*([a-z][a-z ]*?):\s*(.*)$/i.exec(l);
      if (!m) continue;
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === 'ssid') e.ssid = ssidOf(v);
      else if (k === 'freq') e.freqMHz = numOf(v) !== null ? Math.round(numOf(v)) : null;
      else if (k === 'signal') e.rssiDbm = dbm(v);
      else if (k === 'rx bitrate' || k === 'tx bitrate') {
        if (k === 'rx bitrate') e.rxRate = rate(v);
        else e.txRate = rate(v);
        e.radio = e.radio || radioFromIw(v);
        const w = /(\d+)\s*MHz/i.exec(v);
        if (w && e.widthMHz === null) e.widthMHz = Number(w[1]);
      }
    }
    res.interfaces.push(finish(e));
  }

  const NM_FREQ = /(\d{4})\s*MHz/i;
  const NM_RATE = /(\d+(?:[.,]\d+)?)\s*(?:Mbit\/s|Mb\/s|Mbps|MBit\/s)/i;
  const NM_MODE = /\s(?:Infra|Ad-Hoc|Mesh)\b/;

  function looksNmcli(lines) {
    return lines.filter((l) => MAC_FIND.test(l.replace(/\\:/g, ':')) && (NM_FREQ.test(l) || NM_RATE.test(l))).length > 0;
  }

  /** One nmcli row (tabular or terse) -> entry, or null when it is not a network row. */
  function nmRow(line) {
    let l = line;
    if (/\\:/.test(l)) {
      // terse mode (-t): fields separated by ':' with literal colons escaped as '\:'
      const parts = [];
      let cur = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && line[i + 1] === ':') {
          cur += ':';
          i++;
        } else if (ch === ':') {
          parts.push(cur);
          cur = '';
        } else cur += ch;
      }
      parts.push(cur);
      l = parts.map((p) => (p === '' ? ' ' : p)).join('  ');
    }
    const mac = MAC_FIND.exec(l);
    if (!mac) return null;
    const e = blank();
    const inUse = /^\s*\*/.test(l);
    const before = l.slice(0, mac.index).replace(/^\s*\*?/, '');
    let after = l.slice(mac.index + mac[0].length);
    e.bssid = macOf(mac[1]);
    // SSID: before the BSSID (our -f order), else right after it (plain `nmcli dev wifi`: BSSID SSID MODE CHAN ...)
    let ssidText = before.trim();
    if (!ssidText) {
      const stop = after.search(NM_MODE);
      const chanAt = after.search(/\s{2,}\d{1,3}\s{2,}/);
      const end = stop >= 0 ? stop : chanAt >= 0 ? chanAt : -1;
      if (end > 0) {
        ssidText = after.slice(0, end).trim();
        after = after.slice(end);
      }
    }
    e.ssid = ssidOf(ssidText);
    const fq = NM_FREQ.exec(after);
    if (fq) e.freqMHz = Number(fq[1]);
    const rt = NM_RATE.exec(after);
    if (rt) e.maxRate = rate(rt[1]);
    // channel: the integer right before the frequency (our order) or after the mode (default order)
    const head = fq ? after.slice(0, fq.index) : rt ? after.slice(0, rt.index) : after;
    const ints = head.match(/(?:^|\s)(\d{1,3})(?=\s|$)/g);
    if (ints && ints.length) e.channel = chan(ints[ints.length - 1].trim());
    // signal: the first stand-alone integer 0..100 after the rate
    const tail = rt ? after.slice(rt.index + rt[0].length) : fq ? after.slice(fq.index + fq[0].length) : after;
    const sm = /(?:^|\s)(\d{1,3})(?=\s|$)/.exec(tail);
    if (sm) e.signalPct = pct(sm[1]);
    // security: what is left after the signal (and the bars, if any)
    if (sm) {
      const sec = tail
        .slice(sm.index + sm[0].length)
        .replace(/[\u2580-\u259f_*]{2,}|[\u2581-\u2588]+/g, ' ')
        .trim();
      e.security = sec && sec !== '--' ? securityOf(sec) : sec === '--' ? 'Open' : null;
    }
    e.state = inUse ? 'connected' : 'visible';
    // nmcli SIGNAL is NetworkManager's quality: -100..-40 dBm mapped linearly onto 0..100 (dBm = 0.6 * q - 100), not
    // the Windows percentage (% / 2 - 100)
    if (e.signalPct !== null) {
      e.rssiDbm = Math.round(0.6 * e.signalPct - 100);
      e.rssiFromPct = true;
    }
    return finish(e);
  }

  function parseNmcli(lines, res) {
    for (const l of lines) {
      if (res.interfaces.length >= MAX_NETWORKS) {
        res.warnings.push('devinfo.warn.truncated');
        break;
      }
      const e = nmRow(l);
      if (e) res.interfaces.push(e);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the helper's JSON (server /wifi answer, clipboard summary, #wifi= hash)
  // ---------------------------------------------------------------------------------------------------------------
  const OSES = ['windows', 'macos', 'linux'];
  /** The helper's `error` codes (pomocnik/*: Get-WifiError / payload()) -> warnings. */
  const HELPER_ERRORS = { location: 'devinfo.warn.location', 'not-connected': 'devinfo.warn.notConnected', 'no-wifi': 'devinfo.warn.noWifi' };
  const HELPER_ERRORS_ANY = ['devinfo.warn.location', 'devinfo.warn.notConnected', 'devinfo.warn.noWifi', 'devinfo.warn.unknown', 'devinfo.warn.empty'];

  /** A connection object from untrusted JSON -> a clean entry (every field validated), or null when empty. */
  function entryOf(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const e = blank();
    e.name = textOf(o.name, 60);
    e.description = textOf(o.description, 80);
    e.state = typeof o.state === 'string' ? stateOf(o.state) : null;
    e.ssid = ssidOf(o.ssid);
    e.bssid = macOf(typeof o.bssid === 'string' ? o.bssid : '');
    const b = isNum(o.band) ? o.band : bandFromText(String(o.band || ''));
    e.band = b === 2.4 || b === 5 || b === 6 ? b : null;
    e.channel = isNum(o.channel) ? chan(o.channel) : chan(typeof o.channel === 'string' ? o.channel : '');
    e.freqMHz = isNum(o.freqMHz) && o.freqMHz >= 2400 && o.freqMHz <= 7125 ? Math.round(o.freqMHz) : null;
    e.widthMHz = isNum(o.widthMHz) && [20, 40, 80, 160, 320].includes(o.widthMHz) ? o.widthMHz : null;
    e.signalPct = isNum(o.signalPct) ? pct(o.signalPct) : null;
    e.rssiDbm = isNum(o.rssiDbm) ? dbm(o.rssiDbm) : null;
    e.noiseDbm = isNum(o.noiseDbm) ? dbm(o.noiseDbm) : null;
    e.rxRate = isNum(o.rxRate) ? rate(o.rxRate) : null;
    e.txRate = isNum(o.txRate) ? rate(o.txRate) : null;
    e.maxRate = isNum(o.maxRate) ? rate(o.maxRate) : null;
    e.radio = typeof o.radio === 'string' ? o.radio : null;
    e.security = securityOf(o.security);
    e.links = linksOf(o.links);
    finish(e);
    const useful = ['ssid', 'bssid', 'band', 'channel', 'rssiDbm', 'rxRate', 'txRate', 'radio'].some((k) => e[k] !== null);
    return useful || e.state ? e : null;
  }

  /**
   * The helper's JSON {v:1, os, at?, wifi:{...}, interfaces?:[...], raw?} (also a parse() result) -> parse() result
   * shape (+ at). Fields are validated one by one; the raw text, when present, is parsed too and fills the gaps.
   */
  function fromObject(obj) {
    const res = { os: null, source: 'helper', interfaces: [], connected: null, warnings: [] };
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      res.warnings.push('devinfo.warn.unknown');
      return res;
    }
    res.os = OSES.includes(obj.os) ? obj.os : null;
    const at = isNum(obj.at) ? obj.at : typeof obj.at === 'string' ? Date.parse(obj.at) : NaN;
    if (Number.isFinite(at) && at > 0) res.at = Math.floor(at);
    const list = Array.isArray(obj.interfaces) ? obj.interfaces.slice(0, MAX_NETWORKS) : [];
    for (const it of list) {
      const e = entryOf(it);
      if (e) res.interfaces.push(e);
    }
    let main = entryOf(obj.wifi || obj.connected);
    let rawWarnings = null;
    if (typeof obj.raw === 'string' && obj.raw.trim()) {
      const p = parseText(obj.raw.slice(0, MAX_TEXT));
      if (!res.os) res.os = p.os;
      if (!res.interfaces.length) res.interfaces = p.interfaces;
      if (!main) {
        main = p.connected;
        rawWarnings = p.warnings;
      } else if (p.connected) {
        const c = p.connected;
        if (main.rssiDbm === null && c.rssiDbm !== null) main.rssiFromPct = c.rssiFromPct;
        for (const k of Object.keys(main)) if (main[k] === null && c[k] !== null) main[k] = c[k];
        finish(main);
      }
      if (!main) rawWarnings = p.warnings;
    }
    if (main && main.state === null) main.state = 'connected';
    if (main && main.state === 'connected') res.connected = main;
    else if (!main) res.connected = pickConnected(res.interfaces, res.warnings);
    if (main && !res.interfaces.length) res.interfaces.push(main);
    if (rawWarnings) res.warnings.push(...rawWarnings);
    else if (res.connected) {
      if (res.connected.rssiDbm === null) res.warnings.push('devinfo.warn.noSignal');
      else if (res.connected.rssiFromPct) res.warnings.push('devinfo.warn.rssiFromPct');
    }
    if (!res.connected && !res.warnings.some((k) => HELPER_ERRORS_ANY.includes(k))) {
      // the helper says why (its `error` code), else: an adapter without a connection / nothing usable
      const code = typeof obj.error === 'string' && Object.prototype.hasOwnProperty.call(HELPER_ERRORS, obj.error) ? HELPER_ERRORS[obj.error] : null;
      res.warnings.push(code || (res.interfaces.length ? 'devinfo.warn.notConnected' : 'devinfo.warn.unknown'));
    }
    return res;
  }

  /** The first {...} block of a text that parses as JSON (the helper's clipboard: summary lines + JSON), or null. */
  function embeddedJson(text) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      const v = JSON.parse(text.slice(a, b + 1));
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // parse
  // ---------------------------------------------------------------------------------------------------------------

  function parseText(input) {
    const res = { os: null, source: null, interfaces: [], connected: null, warnings: [] };
    if (typeof input !== 'string' || !input.trim()) {
      res.warnings.push('devinfo.warn.empty');
      return res;
    }
    let text = input.replace(/^\ufeff/, '');
    if (text.length > MAX_TEXT) {
      text = text.slice(0, MAX_TEXT);
      res.warnings.push('devinfo.warn.truncated');
    }
    text = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    const lines = text.split('\n');
    const trimmed = text.trim();

    // JSON: system_profiler -json, or the helper's own JSON (possibly inside its clipboard summary)
    const json = embeddedJson(trimmed);
    if (json && Array.isArray(json.SPAirPortDataType)) {
      res.os = 'macos';
      res.source = 'system_profiler';
      parseMacJson(json, res);
    } else if (json && (json.wifi || json.connected || json.raw || json.v === 1)) {
      const r = fromObject(json);
      r.warnings = res.warnings.concat(r.warnings);
      return r;
    } else {
      const kv = kvLines(lines);
      if (IW_CONNECTED.test(text) || IW_NOT.test(text)) {
        res.os = 'linux';
        res.source = 'iw';
        parseIw(text, lines, res);
      } else if (looksWdutil(kv)) {
        res.os = 'macos';
        res.source = 'wdutil';
        parseWdutil(kv, res);
      } else if (SIG_NOISE.test(text) || /supported phy modes|current network information|spairport/i.test(text)) {
        res.os = 'macos';
        res.source = 'system_profiler';
        parseMacText(lines, res);
      } else if (looksNmcli(lines)) {
        res.os = 'linux';
        res.source = 'nmcli';
        parseNmcli(lines, res);
      } else if (WIN_LOCATION.test(keyOf(text)) && !kv.some((r) => r.key === 'ssid')) {
        res.os = 'windows';
        res.source = 'netsh';
        res.warnings.push('devinfo.warn.location');
        return res;
      } else if (looksWindows(kv)) {
        res.os = 'windows';
        res.source = 'netsh';
        parseWindows(kv, res);
      } else if (WIN_NO_WIFI.test(keyOf(text))) {
        res.os = 'windows';
        res.source = 'netsh';
        res.warnings.push('devinfo.warn.noWifi');
        return res;
      } else {
        res.warnings.push('devinfo.warn.unknown');
        return res;
      }
    }
    res.connected = pickConnected(res.interfaces, res.warnings);
    if (!res.interfaces.length) res.warnings.push('devinfo.warn.noWifi');
    else if (!res.connected) res.warnings.push('devinfo.warn.notConnected');
    else {
      if (res.connected.rssiDbm === null) res.warnings.push('devinfo.warn.noSignal');
      else if (res.connected.rssiFromPct) res.warnings.push('devinfo.warn.rssiFromPct');
    }
    return res;
  }

  /**
   * Wi-Fi details from pasted command output (see the file header for the supported commands).
   * @param {string} text
   * @returns {{os:'windows'|'macos'|'linux'|null, source:'netsh'|'system_profiler'|'wdutil'|'nmcli'|'iw'|'helper'|null,
   *   interfaces:Array<object>, connected:object|null, warnings:string[]}} warnings are i18n keys (devinfo.warn.*),
   *   without duplicates
   */
  function parse(text) {
    const r = parseText(text);
    r.warnings = [...new Set(r.warnings)];
    return r;
  }

  /**
   * The measurement's `wifi` object (SPEC 8) from a connection, or null: {ssid, bssid, channel, band, rxRate, txRate,
   * radio, security} + links (Wi-Fi 7 MLO, SPEC 13: [{band, channel, rssiDbm, widthMHz}], only when there are any).
   */
  function toWifi(c) {
    if (!c || typeof c !== 'object') return null;
    const w = {
      ssid: c.ssid || null,
      bssid: c.bssid || null,
      channel: Number.isInteger(c.channel) ? c.channel : null,
      band: c.band === 2.4 || c.band === 5 || c.band === 6 ? c.band : null,
      rxRate: isNum(c.rxRate) ? c.rxRate : null,
      txRate: isNum(c.txRate) ? c.txRate : null,
      radio: c.radio || null,
      security: c.security || null,
    };
    const links = linksOf(c.links);
    if (links) w.links = links;
    return Object.values(w).some((v) => v !== null) ? w : null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // #wifi=<base64url JSON> (the helper's one-shot mode, SPEC 8.2) - the hash never leaves the browser
  // ---------------------------------------------------------------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B64_INDEX = (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    t[43] = 62; // '+' (standard alphabet, e.g. PowerShell's [Convert]::ToBase64String)
    t[47] = 63; // '/'
    return t;
  })();

  function utf8Bytes(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /** Strict UTF-8 decoder (throws on malformed input). */
  function utf8Text(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i];
      let c;
      let n;
      if (b < 0x80) {
        c = b;
        n = 0;
      } else if (b >= 0xc2 && b < 0xe0) {
        c = b & 31;
        n = 1;
      } else if (b >= 0xe0 && b < 0xf0) {
        c = b & 15;
        n = 2;
      } else if (b >= 0xf0 && b < 0xf5) {
        c = b & 7;
        n = 3;
      } else throw new Error('utf8');
      if (i + n >= bytes.length) throw new Error('utf8');
      for (let k = 1; k <= n; k++) {
        const x = bytes[i + k];
        if (x === undefined || (x & 0xc0) !== 0x80) throw new Error('utf8');
        c = (c << 6) | (x & 63);
      }
      if ((n === 2 && c < 0x800) || (n === 3 && (c < 0x10000 || c > 0x10ffff)) || (c >= 0xd800 && c <= 0xdfff)) throw new Error('utf8');
      s += String.fromCodePoint(c);
      i += n + 1;
    }
    return s;
  }

  function b64urlEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      s += B64[a >> 2] + B64[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)];
      if (b !== undefined) s += B64[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)];
      if (c !== undefined) s += B64[c & 63];
    }
    return s;
  }

  function b64Decode(str) {
    const s = str.replace(/[\s=]+$/g, '').replace(/\s+/g, '');
    if (s.length % 4 === 1) throw new Error('b64');
    const out = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      const v = code < 128 ? B64_INDEX[code] : -1;
      if (v < 0) throw new Error('b64');
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 255);
      }
    }
    return out;
  }

  /** The payload of '#wifi=...' / 'wifi=...' / '...&wifi=...' / a bare payload; null when there is no wifi= part. */
  function hashPayload(str) {
    let s = String(str).trim();
    if (s.startsWith('#')) s = s.slice(1);
    const m = /(?:^|[&?#])wifi=([^&#]*)/.exec(s);
    if (m) s = m[1];
    else if (/[=&]/.test(s.replace(/=+$/, ''))) return null;
    try {
      s = decodeURIComponent(s);
    } catch (e) {
      /* keep it as it is */
    }
    return s;
  }

  /**
   * Read the helper's one-shot hand-over: '#wifi=<base64url(UTF-8 JSON)>' (standard base64 and padding accepted).
   * The JSON is {v:1, os, at?, wifi:{ssid, bssid, band, channel, signalPct, rssiDbm, rxRate, txRate, radio, security,
   * state, ...}, raw?: '<command output>'}; every field is validated, unknown keys are ignored.
   * @param {string} str location.hash (or any string with wifi=...)
   * @returns {{ok:boolean, error?:'devinfo.hash.none'|'devinfo.hash.tooBig'|'devinfo.hash.invalid', os, source,
   *   interfaces, connected, warnings, at?}}
   */
  function fromHash(str) {
    const fail = (error) => ({ ok: false, error, os: null, source: null, interfaces: [], connected: null, warnings: [] });
    if (typeof str !== 'string' || !str.trim()) return fail('devinfo.hash.none');
    const payload = hashPayload(str);
    if (payload === null || !payload) return fail('devinfo.hash.none');
    if (payload.length > HASH_MAX) return fail('devinfo.hash.tooBig');
    let obj;
    try {
      obj = JSON.parse(utf8Text(b64Decode(payload)));
    } catch (e) {
      return fail('devinfo.hash.invalid');
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('devinfo.hash.invalid');
    if (obj.v !== undefined && !(Number.isInteger(obj.v) && obj.v >= 1 && obj.v <= 9)) return fail('devinfo.hash.invalid');
    const hasWifi = obj.wifi && typeof obj.wifi === 'object' && !Array.isArray(obj.wifi);
    if (!hasWifi && typeof obj.raw !== 'string') return fail('devinfo.hash.invalid');
    const r = fromObject(obj);
    r.warnings = [...new Set(r.warnings)];
    return { ok: true, ...r };
  }

  /**
   * Build '#wifi=<base64url JSON>' from a parse() / fromHash() result or {os, connected|wifi, raw?, at?} - what the
   * helper produces (here for tests and for links). The raw text is dropped when the hash would exceed the limit.
   * @returns {string|null} null when there is nothing to hand over or it does not fit
   */
  function toHash(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const c = entryOf(obj.connected || obj.wifi);
    if (!c && typeof obj.raw !== 'string') return null;
    const wifi = {};
    if (c) for (const [k, v] of Object.entries(c)) if (v !== null && v !== false) wifi[k] = v;
    const payload = { v: 1, os: OSES.includes(obj.os) ? obj.os : null, at: isNum(obj.at) ? Math.floor(obj.at) : undefined, wifi };
    if (typeof obj.raw === 'string' && obj.raw.trim()) payload.raw = obj.raw.slice(0, RAW_MAX);
    let enc = b64urlEncode(utf8Bytes(JSON.stringify(payload)));
    if (enc.length > HASH_MAX && payload.raw) {
      delete payload.raw;
      enc = b64urlEncode(utf8Bytes(JSON.stringify(payload)));
    }
    return enc.length > HASH_MAX ? null : `#wifi=${enc}`;
  }

  Object.assign(D, {
    parse,
    fromObject,
    fromHash,
    toHash,
    toWifi,
    linksOf,
    wifiGen,
    radioOf,
    bandFromText,
    bandFromFreq,
    bandFromChannel,
    freqOf,
    channelOf,
    pctToDbm: (p) => (isNum(p) ? p / 2 - 100 : null),
    COMMANDS,
    WARNINGS: Object.freeze(['devinfo.warn.empty', 'devinfo.warn.unknown', 'devinfo.warn.noWifi', 'devinfo.warn.location', 'devinfo.warn.notConnected', 'devinfo.warn.multiple', 'devinfo.warn.ssidHidden', 'devinfo.warn.rssiFromPct', 'devinfo.warn.noSignal', 'devinfo.warn.truncated']),
    HASH_ERRORS: Object.freeze(['devinfo.hash.none', 'devinfo.hash.tooBig', 'devinfo.hash.invalid']),
    LIMITS: Object.freeze({ MAX_TEXT, HASH_MAX, RAW_MAX, SSID_MAX, MAX_LINKS }),
    _b64: { encode: (s) => b64urlEncode(utf8Bytes(s)), decode: (s) => utf8Text(b64Decode(s)) },
  });
})();
