/* WH.diag - in-memory error diary for "Podrobnosti" / "Nahlásit problém" (SPEC 10, diagnostics).
 *
 * Keeps the last 20 errors of this page session (never stored, never sent anywhere):
 *   WH.diag.record(err, {kind, where, context, notify})  -> record | null   (any thrown value, an ErrorEvent-like object or text)
 *   WH.diag.caught(err, where)                           -> record          (a bug caught by a framework try/catch: bus/store/keys
 *                                                                             listeners, view mount ... - the console still gets it)
 *   WH.diag.list() / last() / get(id) / clear() / count()
 *   WH.diag.subscribe(fn(record)) -> off                  (90-app shows the friendly toast from here; re-entrancy safe)
 *   WH.diag.whereOf(stackOrFrame) -> "50-planner/25-measure.js:123 (save)"   (bundle line -> source file via WH_BUILD.files)
 *   WH.diag.scrub(text)                                   (privacy: no local paths, user names, MAC/BSSID, SSID, IPs, e-mails,
 *                                                          data: URLs - stacks and messages are scrubbed before they are kept;
 *                                                          record() also removes the user's own words found in the live
 *                                                          project: SSIDs/BSSIDs of measurements, room / measurement /
 *                                                          device / project names -> "[…]")
 *   WH.diag.build -> {v: 'abc123…', files: [[line, 'src/js/…'], …]}  (injected by build.mjs; {v:'dev'} when missing)
 *
 * Record: {id, t (ms), kind: 'error'|'rejection'|'caught'|'reported', name, message, where, stack (≤ 12 lines), context, count}.
 * Pure JS (no DOM): loads in Node too. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};

  const MAX = 20;
  const ring = [];
  const subs = new Set();
  let seq = 0;
  let notifying = false;

  const build = (() => {
    const b = g.WH_BUILD && typeof g.WH_BUILD === 'object' ? g.WH_BUILD : null;
    const files = b && Array.isArray(b.files) ? b.files.filter((f) => Array.isArray(f) && Number.isFinite(f[0]) && typeof f[1] === 'string') : [];
    return { v: b && typeof b.v === 'string' ? b.v : 'dev', files };
  })();

  // ---------------------------------------------------------------------------------------------------------------
  // privacy scrubbing: what is kept may be copied into a bug report, so nothing personal may survive
  // ---------------------------------------------------------------------------------------------------------------
  const RE = {
    url: /\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"<>]*/gi,
    encoded: /[^\s()'"<>]*%2F[^\s()'"<>]*/gi,       // a percent-encoded path ("file%3A%2F%2F%2FC%3A%2FUsers%2F…")
    dataUrl: /\bdata:[a-z0-9/+.-]*(?:;[a-z0-9=.-]+)*,[^\s)'"<>]{12,}/gi,
    winPath: /\b[A-Za-z]:\\[^\s'"<>)]*/g,
    nixHome: /\/(?:Users|home)\/[^\s'"<>/)]+/g,
    mac: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi,
    // a whole "SSID     : My Home 5G" / "SSID 1 : …" line of command output (names may contain spaces)
    ssidLine: /^([ \t]*b?ssid(?:[ \t]+\d+)?[ \t]*:[ \t]*)\S.*$/gim,
    // "SSID : x" (netsh), ssid=x, {"ssid":"x"} and free text such as SSID "x" (a quoted value right after the word)
    ssid: /(\bb?ssid\b["']?(?:\s*[:=]\s*|\s+(?=["'„])))(?!\[ssid\])("[^"\n]*"|'[^'\n]*'|„[^“\n]*“|[^\s,;}\]]+)/gi,
    ip: /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    email: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  };
  /** A URL reduced to what helps a developer: the file name (a page from disk would otherwise show the user's folders). */
  function shortUrl(u) {
    let s = String(u);
    if (/%[0-9a-f]{2}/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) { /* keep it encoded */ } }
    const clean = s.replace(/[?#].*$/, '');
    const m = /([^/\\]+)$/.exec(clean.replace(/[/\\]+$/, ''));
    return m ? m[1] : '';
  }
  /** The user's own words that may end up in an error text: network names / BSSIDs of measurements (and of Wi-Fi
   *  details waiting for the next measurement), names of rooms, measurements, devices and the project. Read from the
   *  live store when an error is recorded; strings shorter than 3 characters are left alone. */
  function privateWords() {
    const out = new Set();
    const add = (s) => { if (typeof s === 'string' && s.trim().length >= 3) out.add(s.trim()); };
    try {
      const p = g.WH.store && g.WH.store.project;
      if (p) {
        add(p.name);
        const plan = p.plan || {};
        for (const k of ['rooms', 'walls', 'doors', 'furniture']) for (const o of plan[k] || []) add(o && o.name);
        for (const m of p.measurements || []) {
          if (!m) continue;
          add(m.name);
          add(m.device);
          if (m.wifi) { add(m.wifi.ssid); add(m.wifi.bssid); }
        }
      }
      const pend = g.WH.planner && g.WH.planner.wifiPending && typeof g.WH.planner.wifiPending.get === 'function' ? g.WH.planner.wifiPending.get() : null;
      const pw = pend && (pend.wifi || pend);   // {wifi, source}
      if (pw) { add(pw.ssid); add(pw.bssid); }
    } catch (e) { /* the store may be half-initialised: scrub with the generic rules only */ }
    return [...out].sort((a, b) => b.length - a.length);
  }
  /** Private words of the record being made (see record()); scrub() removes them too. */
  let activeWords = [];

  function scrub(text) {
    if (text === null || text === undefined) return '';
    let s = String(text);
    for (const w of activeWords) s = s.split(w).join('[…]');
    return s
      .replace(RE.dataUrl, 'data:…')
      .replace(RE.encoded, (u) => shortUrl(u) || '[url]')
      .replace(RE.url, (u) => shortUrl(u) || '[url]')
      .replace(RE.winPath, '[path]')
      .replace(RE.nixHome, '/[user]')
      .replace(RE.mac, '[mac]')
      .replace(RE.ssidLine, '$1[ssid]')
      .replace(RE.ssid, '$1[ssid]')
      .replace(RE.ip, '[ip]')
      .replace(RE.email, '[email]');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // where: bundle line -> source file (build.mjs puts every file after a "/* ===== src/js/... ===== */" line and
  // records those lines in WH_BUILD.files, so the one inline script still names the module that failed)
  // ---------------------------------------------------------------------------------------------------------------
  function mapLine(line) {
    const files = build.files;
    if (!files.length || !Number.isFinite(line)) return null;
    let lo = 0;
    let hi = files.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (files[mid][0] <= line) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0) return null;
    const rel = line - files[hit][0];
    return rel >= 1 ? { file: files[hit][1].replace(/^src\/js\//, ''), line: rel } : null;
  }

  /** One stack frame -> {fn, file, line, col, mapped} (V8 "at fn (url:l:c)" / "at url:l:c", Firefox/Safari "fn@url:l:c"). */
  function parseFrame(s) {
    const str = String(s).trim();
    let m = /^at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/.exec(str);
    if (!m) m = /^(?:(.*?)@)?(.*?):(\d+):(\d+)$/.exec(str);
    if (!m) return null;
    const fn = (m[1] || '').replace(/^async\s+/, '').trim();
    const url = m[2] || '';
    const line = Number(m[3]);
    const col = Number(m[4]);
    const mapped = isPage(url) ? mapLine(line) : null;
    return { fn, file: mapped ? mapped.file : scrub(shortUrl(url)) || '?', line: mapped ? mapped.line : line, col, mapped: !!mapped };
  }
  /** The app page itself (index.html, index.cs.html, a folder URL "…/" served as index) - its inline script is the bundle. */
  function isPage(url) {
    const u = String(url || '').replace(/[?#].*$/, '');
    return !u || /\/$/.test(u) || /\.html?$/i.test(shortUrl(u));
  }
  const frameText = (f) => `${f.file}:${f.line}${f.col ? `:${f.col}` : ''}`;

  /** Rewrite a stack: frames mapped to source files, everything scrubbed, at most 12 lines. */
  function cleanStack(stack) {
    if (!stack) return '';
    const out = [];
    for (const raw of String(stack).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const f = parseFrame(line);
      if (f) out.push(`  at ${f.fn ? `${scrub(f.fn)} ` : ''}(${frameText(f)})`);
      else if (!out.length) out.push(scrub(line).slice(0, 300));   // the "TypeError: …" head line of V8 stacks
      if (out.length >= 12) break;
    }
    return out.join('\n');
  }

  /** "50-planner/25-measure.js:123 (save)" for the first frame of a stack (or a {filename, lineno, colno} triple). */
  function whereOf(src) {
    if (!src) return '';
    if (typeof src === 'object' && (src.filename || src.lineno)) {
      const mapped = isPage(src.filename) ? mapLine(Number(src.lineno)) : null;
      return mapped ? `${mapped.file}:${mapped.line}` : `${scrub(shortUrl(src.filename || '')) || '?'}:${src.lineno || 0}`;
    }
    // the first frame inside the app (a source file of the bundle) names the module; else the first frame at all
    let first = null;
    for (const raw of String(src).split(/\r?\n/)) {
      const f = parseFrame(raw);
      if (!f) continue;
      if (!first) first = f;
      if (f.mapped) { first = f; break; }
    }
    return first ? `${frameText(first).replace(/:\d+$/, '')}${first.fn ? ` (${scrub(first.fn)})` : ''}` : '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the diary
  // ---------------------------------------------------------------------------------------------------------------
  const KINDS = new Set(['error', 'rejection', 'caught', 'reported']);

  /** Normalise anything that was thrown (Error, DOMException, string, {message}, an ErrorEvent-like object). */
  function normalise(err) {
    if (err && typeof err === 'object') {
      const name = typeof err.name === 'string' && err.name ? err.name : (err.constructor && err.constructor.name) || 'Error';
      let message = typeof err.message === 'string' ? err.message : '';
      if (!message && typeof err.reason === 'string') message = err.reason;
      if (!message) { try { message = JSON.stringify(err).slice(0, 200); } catch (e) { message = String(err); } }
      return { name, message, stack: typeof err.stack === 'string' ? err.stack : '' };
    }
    return { name: typeof err, message: err === undefined ? 'undefined' : String(err), stack: '' };
  }

  /**
   * Keep one error. opts: {kind: 'error'|'rejection'|'caught'|'reported' (default 'reported'), where (text or a
   * {filename, lineno, colno} triple), context (short text: what the app was doing, e.g. 'measure.save'), notify
   * (default true: subscribers are told - 90-app decides whether a toast is due)}. Returns the record (a repeat of the
   * same error within 3 s only raises its count).
   */
  function record(err, opts) {
    activeWords = privateWords();
    try { return recordNow(err, opts || {}); } finally { activeWords = []; }
  }
  function recordNow(err, opts) {
    const n = normalise(err);
    const kind = KINDS.has(opts.kind) ? opts.kind : 'reported';
    const stack = cleanStack(n.stack);
    let where = '';
    if (opts.where && typeof opts.where === 'object') where = whereOf(opts.where);
    else if (typeof opts.where === 'string' && opts.where) where = scrub(opts.where).slice(0, 120);
    if (!where && n.stack) where = whereOf(n.stack);
    const context = opts.context ? scrub(typeof opts.context === 'string' ? opts.context : JSON.stringify(opts.context)).slice(0, 120) : '';
    const message = scrub(n.message).slice(0, 500);
    const now = Date.now();
    const prev = ring[ring.length - 1];
    if (prev && prev.message === message && prev.where === where && prev.kind === kind && now - prev.t < 3000) {
      prev.count += 1;
      prev.t = now;
      return prev;
    }
    seq += 1;
    const rec = { id: seq, t: now, kind, name: scrub(n.name).slice(0, 60), message, where, stack, context, count: 1 };
    ring.push(rec);
    while (ring.length > MAX) ring.shift();
    if (opts.notify !== false && !notifying) {
      notifying = true;
      try { for (const fn of Array.from(subs)) { try { fn(rec); } catch (e) { /* a broken subscriber must not loop back here */ } } } finally { notifying = false; }
    }
    return rec;
  }

  /** A bug caught by a try/catch of the framework (the caller has already logged it to the console). */
  function caught(err, where) { return record(err, { kind: 'caught', context: where }); }

  g.WH.diag = {
    MAX,
    build,
    record,
    caught,
    list: () => ring.slice().reverse(),           // newest first
    last: () => ring[ring.length - 1] || null,
    get: (id) => ring.find((r) => r.id === id) || null,
    count: () => ring.length,
    clear() { ring.length = 0; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    whereOf,
    cleanStack,
    scrub,
    mapLine,
  };
})();
