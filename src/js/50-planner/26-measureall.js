/* Planner: one-click "Změřit vše" (SPEC 8.1) + the client of the optional local Wi-Fi helper (SPEC 8.1 / 8.2).
 *
 *   WH.planner.measureAll({point:{x,y}, band?, name?, source?:'wizard'|'manual', device?, value?, wifi?, wifiSource?,
 *                          onStep?(step, steps), consent?() -> Promise<bool>, toast?}, signal?)
 *     -> Promise<{measurement|null, steps:[{key:'device'|'wifi'|'speed'|'save', state:'ok'|'skipped'|'failed', info}],
 *                 data, cancelled}>
 *     (1) device (WH.devinfo.detect), (2) Wi-Fi details: the helper if it runs, else details pasted / handed over by a
 *     helper link (WH.planner.wifiPending), else skipped, (3) the quick speed test (the one-time consent is asked through
 *     `consent`, default a small confirm dialog), (4) saves the measurement (undoable, label planner.undo.measAll).
 *     A failing step never loses the others; cancelling (signal) saves nothing and resolves with cancelled:true.
 *     Band (SPEC 13) = the Wi-Fi details' band when known, else `bandChoice` (the user's explicit 2.4|5|6|'auto' =
 *     "Nevím", stored as band null), else the Wi-Fi step waits for `chooseBand({reason, code, handheld, wifi, signal})`
 *     -> Promise<{band} | {wifi, source} | null (cancel)> (the checklist's .chooseBand: connect the helper, paste the
 *     command output, or pick the band); without a chooser nothing is saved. Never the map's band. `band` is only a
 *     hint ("the device is on another band than you picked"). Signal = the details' dBm, else `value`.
 *     Emits bus 'planner:measured' {measurement, steps, source} after a save.
 *   WH.planner.helperStatus({timeout=300, signal, ask, onAsk}) -> Promise<{connected, os?, version?, blocked?}>
 *     GET 127.0.0.1:47823/health, only when called (one retry after a timeout); on an https page whose Local Network
 *     Access permission is undecided only with {ask:true} (blocked:'prompt' otherwise; 'denied' when refused)
 *   WH.planner.helperPermission() -> Promise<'granted'|'prompt'|'denied'|null>   (null: the browser does not ask)
 *   WH.planner.helperWifi(signal?) -> Promise<wifi>  GET /wifi of the helper, parsed by WH.devinfo (error .code on failure)
 *   WH.planner.normWifi(any) -> wifi|null   the connection entry of WH.devinfo.parse ({ssid, bssid, band, channel,
 *                                          signalPct, rssiDbm, rxRate, txRate, radio, wifiGen, security, ...})
 *   WH.planner.wifiDbm(w) / wifiLine(w, {signal}) / wifiFound(w) / wifiRecord(w) / deviceRecord(d) / measSummary(m)
 *   WH.planner.wifiPending {get(), set(wifi, source), clear()}   details waiting for the next measurement (15 min)
 *   WH.planner.mallChecklist({onCancel, onHow, onLayout, noCancel}) -> element (.update(step|steps), .askConsent(),
 *                                          .chooseBand(ctx), .cancel(), .reset(), .finish())   the live checklist (the
 *                                          wizard reuses it)
 *
 * The helper is the only way a web page gets SSID / dBm / channel without copy-paste: it must be started by the user
 * (a web page cannot start programs) and listens on the loopback address only. Nothing else is contacted here. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const DI = (WH.devinfo = WH.devinfo || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const store = () => WH.store;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const KEYS = ['device', 'wifi', 'speed', 'save'];

  // ---------------------------------------------------------------------------------------------------------------
  // the local helper (127.0.0.1:47823, started by the user)
  // ---------------------------------------------------------------------------------------------------------------
  const HELPER = 'http://127.0.0.1:47823';
  const PROBE_MS = 300;
  const RETRY_MS = 1500;   // one more try when the first probe timed out (a busy computer; a refusal is never retried)
  const ASK_MS = 30000;    // the browser's "may this page talk to apps on this device?" question is open
  const WIFI_MS = 9000;
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  // PL.helperTestPort: QA hook (another loopback port for a fake helper); never set by the app, loopback only
  const helperOrigin = () => { const p = PL.helperTestPort; return Number.isInteger(p) && p > 1024 && p < 65536 ? HELPER.replace(/:\d+$/, `:${p}`) : HELPER; };

  /** GET a helper path -> parsed JSON ({raw:text} when it is not JSON). Rejects on timeout (.timeout) / refusal / abort;
   *  a refusal by the browser's Local Network Access check carries .denied. */
  async function getHelper(path, ms, signal) {
    if (signal && signal.aborted) throw abortError();
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms);
    // SPEC 10.1: a page from the internet tells Chrome (142+) that the request goes to this computer, so the browser asks
    // its "local network" question instead of refusing; other browsers ignore the option, file:// / http pages skip it
    const lna = typeof location !== 'undefined' && location.protocol === 'https:' ? { targetAddressSpace: 'loopback' } : {};
    try {
      const r = await fetch(helperOrigin() + path, { method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal, ...lna });
      if (!r.ok) throw Object.assign(new Error(`helper ${r.status}`), { code: 'http' });
      const txt = await r.text();
      try { return JSON.parse(txt); } catch (e) { return { raw: txt }; }
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      if (timedOut) throw Object.assign(new Error('helper: timeout'), { timeout: true });
      if (e && /address space|local network|loopback|permission/i.test(String(e.message))) e.denied = true;
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Chrome / Edge "Local Network Access" (142+): a page served from the internet (GitHub Pages) needs the user's one-time
   * permission before it may reach 127.0.0.1, and asking means a browser prompt. -> 'granted' | 'prompt' | 'denied', or
   * null where nothing is asked (pages from disk or from localhost, browsers without the permission).
   */
  async function lnaStatus() {
    if (typeof location === 'undefined' || location.protocol !== 'https:') return null;
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : null;
    if (!perms || typeof perms.query !== 'function') return null;
    for (const name of ['loopback-network', 'local-network-access']) {
      try { const s = await perms.query({ name }); if (s && typeof s.state === 'string') return s; } catch (e) { /* unknown here */ }
    }
    return null;
  }
  const lnaState = async () => { try { const s = await lnaStatus(); return s ? s.state : null; } catch (e) { return null; } };
  PL.helperPermission = lnaState;

  /** One GET /health -> {ok, j} or {ok:false, reason:'timeout'|'denied'|'error'|'off'|'abort'}. */
  async function probe(ms, signal) {
    try { return { ok: true, j: await getHelper('/health', ms, signal) }; } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, reason: 'abort' };
      return { ok: false, reason: e && e.timeout ? 'timeout' : e && e.denied ? 'denied' : e && e.code === 'http' ? 'error' : 'off' };
    }
  }

  /**
   * Is the helper running? Probes /health with a short timeout - only when called (a user action), never in the background.
   * o = {timeout, signal, ask, onAsk()}. On an https page whose permission is still undecided it does NOT probe unless
   * o.ask (the "Připojit pomocníka" button): nobody should meet a browser prompt for a helper they never started.
   * -> {connected, os?, version?, blocked?:'prompt'|'denied', reason?:'off'|'timeout'|'denied'|'prompt'|'error'}
   * Never rejects (an AbortError only when `signal` aborts): every failure comes back as a reason the UI can explain.
   */
  PL.helperStatus = async function helperStatus(o) {
    o = o || {};
    const ms = fin(o.timeout) ? Math.max(100, Math.min(20000, o.timeout)) : PROBE_MS;
    let ps = null;
    try { ps = await lnaStatus(); } catch (e) { ps = null; }
    const lna = ps ? ps.state : null;
    const known = !!(store() && store().getPref('planner.helperOk', false));
    const aborted = () => !!(o.signal && o.signal.aborted);
    let res;
    let r = null;
    if (lna === 'denied') res = { connected: false, blocked: 'denied', reason: 'denied' };
    else if (lna === 'prompt' && !o.ask && !known) res = { connected: false, blocked: 'prompt', reason: 'prompt' };
    else if (lna === 'prompt') {
      if (typeof o.onAsk === 'function') { try { o.onAsk(); } catch (e) { /* ignore */ } }
      // the browser's question stays open while the user reads it: wait for the answer (up to 30 s). When the permission
      // flips (answered in the prompt, or in the site settings) the waiting request is dropped and asked again at once.
      const ac = new AbortController();
      const outer = () => ac.abort();
      let flipped = '';
      const onChange = () => { if (ps.state !== 'prompt') { flipped = ps.state; ac.abort(); } };
      if (o.signal) o.signal.addEventListener('abort', outer);
      try { ps.addEventListener('change', onChange); } catch (e) { /* no events */ }
      r = await probe(ASK_MS, ac.signal);
      try { ps.removeEventListener('change', onChange); } catch (e) { /* ignore */ }
      if (o.signal) o.signal.removeEventListener('abort', outer);
      if (aborted()) throw abortError();
      if (!r.ok && flipped === 'granted') r = await probe(Math.max(ms, RETRY_MS), o.signal);
      if (!r.ok && flipped === 'denied') r = { ok: false, reason: 'denied' };
    } else {
      // a probe that times out (a busy computer) is retried once; a refused connection is not
      r = await probe(ms, o.signal);
      if (!r.ok && r.reason === 'timeout') r = await probe(Math.max(ms, RETRY_MS), o.signal);
    }
    if (aborted()) throw abortError();
    if (r) {
      if (r.ok) {
        res = { connected: true };
        const j = r.j;
        if (j && typeof j.os === 'string') res.os = j.os.slice(0, 40);
        if (j && (typeof j.version === 'string' || fin(j.version))) res.version = String(j.version).slice(0, 20);
        if (lna && !known) store().setPref('planner.helperOk', true);
      } else {
        res = { connected: false, reason: r.reason === 'abort' ? 'timeout' : r.reason };
        const now = lna ? await lnaState() : null;
        if (now === 'denied' || now === 'prompt') { res.blocked = now; res.reason = now; }
      }
    }
    PL.helperStatus.last = Object.assign({ at: Date.now() }, res);
    return res;
  };

  /**
   * The Wi-Fi details the helper reads right now (the parser's connection entry), or a rejection whose `.code` says why
   * ('location' = Windows 11 wants the Location setting on, 'not-connected', 'no-wifi', or a devinfo.warn.* key).
   */
  PL.helperWifi = async function helperWifi(signal) {
    const j = await getHelper('/wifi', WIFI_MS, signal);
    const r = typeof DI.fromObject === 'function' ? DI.fromObject(j) : null;
    const w = r && usable(r.connected) ? r.connected : null;
    if (!w) {
      const e = new Error('helper: no Wi-Fi details');
      // the helper's own error code, else what the parser says - "I can't read this text" means the helper sent
      // something else than a command output (an old / foreign program on the port): say that, not "copy the output"
      const warn = r && r.warnings && r.warnings[0] ? r.warnings[0] : '';
      e.code = j && typeof j.error === 'string' && j.error ? j.error : !warn || warn === 'devinfo.warn.unknown' || warn === 'devinfo.warn.empty' ? 'bad-data' : warn;
      throw e;
    }
    return w;
  };
  /** i18n key explaining a helper / parser problem code. */
  PL.wifiProblemKey = (code) => {
    if (code === 'location') return 'planner.di.err.location';
    if (code === 'not-connected') return 'devinfo.warn.notConnected';
    if (code === 'no-wifi') return 'devinfo.warn.noWifi';
    if (code === 'bad-data') return 'planner.mall.wifi.badData';
    if (typeof code === 'string' && /^devinfo\.(warn|hash)\./.test(code) && WH.i18n.has(code)) return code;
    return 'planner.mall.wifi.fail';
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Wi-Fi details: one shape (the connection entry of WH.devinfo.parse) for pasted text, the helper and the #wifi= link
  // ---------------------------------------------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const usable = (c) => !!(c && typeof c === 'object' && (c.ssid || fin(c.rssiDbm) || fin(c.signalPct) || fin(c.channel) || c.band));

  /**
   * Any source of Wi-Fi details -> the parser's connection entry {ssid, bssid, band, channel, signalPct, rssiDbm, rxRate,
   * txRate, maxRate, radio ('802.11ax'), wifiGen ('Wi-Fi 6'), security, ...} or null: a parse() / fromHash() result, the
   * helper's JSON ({v, os, wifi?, raw?} - raw command output is parsed by the app's own parser), an entry, or a stored
   * measurement.wifi. Every field is validated by WH.devinfo (36-devinfo).
   */
  function normWifi(src) {
    if (!src || typeof src !== 'object') return null;
    let c = null;
    if (Array.isArray(src.interfaces) || Array.isArray(src.warnings)) c = src.connected;
    else if (typeof DI.fromObject === 'function') {
      const helperJson = (src.wifi && typeof src.wifi === 'object') || typeof src.raw === 'string' || src.v !== undefined;
      c = DI.fromObject(helperJson ? src : { wifi: src }).connected;
    }
    return usable(c) ? c : null;
  }
  PL.normWifi = normWifi;

  /** Signal in dBm from Wi-Fi details: RSSI, else Windows' percentage (dBm ≈ % / 2 − 100); null when unknown. */
  PL.wifiDbm = (w) => {
    if (!w) return null;
    if (fin(w.rssiDbm)) return clamp(Math.round(w.rssiDbm), -100, -20);
    if (fin(w.signalPct)) return clamp(Math.round(WH.engine.units.pctToDbm(w.signalPct)), -100, -20);
    return null;
  };
  const linkRate = (w) => (fin(w.rxRate) || fin(w.txRate) ? Math.max(fin(w.rxRate) ? w.rxRate : 0, fin(w.txRate) ? w.txRate : 0) : null);

  /** "„Doma“ · kanál 36 · 5 GHz · linka 1 201 Mb/s" (+ the signal with {signal:true}, without the band with {noBand:true})
   *  - the measurement list line. */
  PL.wifiLine = (w, o) => {
    if (!w) return '';
    const parts = [];
    if (w.ssid) parts.push(t('planner.di.f.ssidQ', { s: w.ssid }));
    if (o && o.signal) { const d = PL.wifiDbm(w); if (d !== null) parts.push(WH.util.dbm(d)); }
    if (fin(w.channel)) parts.push(t('planner.di.f.ch', { c: w.channel }));
    if (w.band && !(o && o.noBand)) parts.push(`${PL.band(w.band)}${WH.util.NBSP}${t('planner.ghz')}`);
    const r = linkRate(w);
    if (r !== null) parts.push(t('planner.di.f.link', { r: PL.mbps(r) }));
    return parts.join(' · ');
  };
  /** "Našel jsem: Wi-Fi „…“, 5 GHz, kanál 36, signál −54 dBm, linka 1 201 Mb/s". */
  PL.wifiFound = (w) => {
    const parts = [];
    if (w.ssid) parts.push(t('planner.di.f.wifi', { s: w.ssid }));
    if (w.band) parts.push(`${PL.band(w.band)}${WH.util.NBSP}${t('planner.ghz')}`);
    if (fin(w.channel)) parts.push(t('planner.di.f.ch', { c: w.channel }));
    const d = PL.wifiDbm(w);
    if (d !== null) parts.push(t((w.rssiFromPct || !fin(w.rssiDbm)) && fin(w.signalPct) ? 'planner.di.f.sigPct' : 'planner.di.f.sig', { v: WH.util.dbm(d), p: w.signalPct }));
    const r = linkRate(w);
    if (r !== null) parts.push(t('planner.di.f.link', { r: PL.mbps(r) }));
    return t('planner.di.found', { s: parts.join(', ') });
  };
  /** What a measurement stores (SPEC 8: {ssid≤64, bssid, channel, band, rxRate, txRate, radio, security}, null = unknown). */
  PL.wifiRecord = (w) => (typeof DI.toWifi === 'function' ? DI.toWifi(w) : null);
  /** The detection a measurement keeps ({os "Windows 11", model, browser, connType}; no network estimates - they are
   *  only the browser's rough guess). */
  PL.deviceRecord = (d) => {
    const s = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    return { os: s([d.os, d.osVersion].filter(Boolean).join(' '), 40), model: s(d.model, 50), browser: s(d.browser, 40), connType: s(d.connType, 20) };
  };

  // details waiting for the next measurement (pasted in "Info o zařízení" or handed over by a helper link)
  const FRESH_MS = 15 * 60 * 1000;
  const pend = { w: null, src: '', at: 0 };
  PL.wifiPending = {
    get() { return pend.w && Date.now() - pend.at < FRESH_MS ? { wifi: pend.w, source: pend.src, at: pend.at } : null; },
    set(w, src) { const n = normWifi(w); if (!n) return; pend.w = n; pend.src = src || 'paste'; pend.at = Date.now(); },
    clear() { pend.w = null; pend.src = ''; pend.at = 0; },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // measureAll
  // ---------------------------------------------------------------------------------------------------------------
  const roundRate = (v) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const norm = (s) => clean(s).toLowerCase();
  const defaultConsent = () => ui().confirm({ title: 'speedtest.consent.t', body: 'speedtest.consent.b', ok: t('speedtest.consent.ok'), cancel: t('speedtest.consent.cancel') });

  PL.measureAll = async function measureAll(opts, signal) {
    const o = opts || {};
    if (!o.point || !fin(o.point.x) || !fin(o.point.y)) throw new RangeError('measureAll: point {x,y} is required');
    const steps = KEYS.map((key) => ({ key, state: 'pending', info: null }));
    const step = (k) => steps.find((s) => s.key === k);
    const emit = (k) => { if (typeof o.onStep === 'function') { try { o.onStep(step(k), steps); } catch (e) { PL.report(e, 'measure.step', { bug: true }); } } };
    const set = (k, state, info) => { const s = step(k); s.state = state; if (info !== undefined) s.info = info; emit(k); };
    const aborted = () => !!(signal && signal.aborted);
    const data = { device: null, wifi: null, wifiSource: null, speed: null, band: null, value: null };
    const out = { measurement: null, steps, data, cancelled: false };
    const cancelled = () => {
      out.cancelled = true;
      for (const s of steps) if (s.state === 'pending' || s.state === 'running') { s.state = 'skipped'; s.info = Object.assign({}, s.info, { reason: 'cancelled' }); emit(s.key); }
      return out;
    };

    // 1. this device
    set('device', 'running', null);
    try { data.device = await DI.detect(); set('device', 'ok', data.device); } catch (e) { PL.report(e, 'measure.device'); set('device', 'failed', { error: String((e && e.message) || e) }); }
    if (aborted()) return cancelled();

    // 2. Wi-Fi details: helper > details handed in (form / pending) > skipped
    set('wifi', 'running', { phase: 'probe' });
    const handheld = !!(data.device && PL.isHandheldOs && PL.isHandheldOs(data.device.osKey));
    let w = null;
    let src = null;
    let helperFailed = false;
    let helperCode = '';
    let blocked = '';
    let hsReason = '';
    if (!handheld && o.helper !== false) {
      // one probe per measurement, and only because the user pressed the button (SPEC 10.1)
      let hs = { connected: false };
      try { hs = await PL.helperStatus({ signal, onAsk: () => set('wifi', 'running', { phase: 'ask' }) }); } catch (e) { if (aborted()) return cancelled(); PL.report(e, 'measure.helper'); hs = { connected: false, reason: 'error' }; }
      if (aborted()) return cancelled();
      blocked = hs.blocked || '';
      hsReason = hs.reason || '';
      if (hs.connected) {
        set('wifi', 'running', { phase: 'helper' });
        try { w = await PL.helperWifi(signal); src = 'helper'; } catch (e) { if (aborted()) return cancelled(); helperFailed = true; helperCode = (e && e.code) || ''; PL.report(e, 'measure.helperWifi'); }
      }
    }
    let fromPending = false;
    if (!w && o.wifi) { w = normWifi(o.wifi); src = w ? o.wifiSource || 'paste' : null; }
    if (!w) { const pd = PL.wifiPending.get(); if (pd) { w = pd.wifi; src = pd.source; fromPending = true; } }
    const U = WH.engine.units;
    const askedBand = U.normBand(o.band);
    // SPEC 13: the band comes from the Wi-Fi details, else from the user's explicit answer (2,4 / 5 / 6 / Nevím) - never
    // silently from the map. Without it the step waits for the answer (o.chooseBand: connect the helper, paste the
    // command output, or pick the band by hand); without a way to ask nothing is saved.
    const why = handheld ? 'phone' : helperFailed ? 'helper' : blocked === 'denied' || hsReason === 'denied' ? 'denied' : blocked ? 'ask' : hsReason === 'timeout' ? 'slow' : 'noHelper';
    let band = null;
    let bandBy = null;
    const fromChoice = (v) => {
      if (v === 'auto') { band = null; bandBy = 'auto'; return true; }
      const b = U.normBand(v);
      if (b) { band = b; bandBy = 'user'; return true; }
      return false;
    };
    if (w && U.normBand(w.band)) { band = U.normBand(w.band); bandBy = 'wifi'; } else fromChoice(o.bandChoice);
    let noBand = false;
    if (!bandBy) {
      let reason = w ? 'noBandInDetails' : why;
      let code = helperCode;
      for (;;) {
        if (typeof o.chooseBand !== 'function') { noBand = true; break; }
        set('wifi', 'running', { phase: 'band', reason, code, wifi: w, source: src, handheld });
        let ans = null;
        try {
          ans = await new Promise((resolve, reject) => {
            const onAbort = () => resolve(null);
            if (signal) { if (signal.aborted) { resolve(null); return; } signal.addEventListener('abort', onAbort, { once: true }); }
            Promise.resolve().then(() => o.chooseBand({ reason, code, handheld, wifi: w, signal }))
              .then(resolve, reject)
              .finally(() => { if (signal) signal.removeEventListener('abort', onAbort); });
          });
        } catch (e) { PL.report(e, 'measure.chooseBand'); ans = null; }
        if (aborted() || !ans) return cancelled();
        if (ans.wifi) {
          const n = normWifi(ans.wifi);
          if (n) {
            w = n;
            src = ans.source || 'paste';
            fromPending = false;
            if (U.normBand(n.band)) { band = U.normBand(n.band); bandBy = 'wifi'; break; }
            reason = 'noBandInDetails';
            code = '';
            continue;
          }
          reason = 'badPaste';
          continue;
        }
        // a phone's answer is kept for this session (it cannot be detected); a PC asks again next time (the helper may run then)
        if (fromChoice(ans.band)) { if (handheld) PL.bands.choice.set(ans.band); break; }
      }
    }
    if (w) {
      data.wifi = w;
      data.wifiSource = src;
    }
    if (bandBy) set('wifi', w ? 'ok' : 'skipped', { wifi: w, source: src, band, bandBy, bandChanged: !!(bandBy === 'wifi' && askedBand && band !== askedBand), helperFailed, reason: w ? null : why, code: helperCode });
    else set('wifi', 'failed', { reason: 'noBand', code: helperCode, why });
    if (noBand) {
      // nobody could be asked (a caller without a chooser): keep what is known, save nothing (SPEC 13)
      set('speed', 'skipped', { reason: 'noBand' });
      set('save', 'failed', { reason: 'noBand' });
      return out;
    }
    data.band = band;
    data.bandBy = bandBy;
    const wd = PL.wifiDbm(w);
    data.value = wd !== null ? wd : fin(o.value) ? clamp(o.value, -100, -20) : null;

    // 3. the quick speed test (consent once)
    const ST = WH.speedtest;
    if (o.speed === false) set('speed', 'skipped', { reason: 'off' });
    else if (!ST || typeof ST.run !== 'function') set('speed', 'failed', { error: 'speedtest.err.blocked' });
    else if (!ST.isAvailable()) set('speed', 'failed', { error: 'speedtest.err.offline' });
    else {
      let ok = !!store().getPref('speedtest.consent', false);
      if (!ok) {
        set('speed', 'running', { phase: 'consent' });
        // the question never blocks a cancel: an abort answers it with "no"
        const asked = new Promise((resolve) => {
          const onAbort = () => resolve(false);
          if (signal) { if (signal.aborted) { resolve(false); return; } signal.addEventListener('abort', onAbort, { once: true }); }
          Promise.resolve().then(() => (typeof o.consent === 'function' ? o.consent() : defaultConsent()))
            .then((v) => resolve(!!v), () => resolve(false))
            .finally(() => { if (signal) signal.removeEventListener('abort', onAbort); });
        });
        ok = await asked;
        if (aborted()) return cancelled();
        if (ok) store().setPref('speedtest.consent', true);
      }
      if (!ok) set('speed', 'skipped', { reason: 'consent' });
      else {
        set('speed', 'running', { phase: 'ping', value: NaN, fraction: 0 });
        try {
          const r = await ST.run({
            mode: 'quick',
            onProgress: (pr) => {
              if (!pr || pr.phase === 'done') return;
              const s = step('speed');
              s.info = { phase: pr.phase, value: fin(pr.value) ? pr.value : s.info && s.info.phase === pr.phase ? s.info.value : NaN, fraction: pr.fraction || 0 };
              emit('speed');
            },
          }, signal);
          data.speed = r;
          set('speed', 'ok', { result: r });
        } catch (e) {
          if (aborted() || (e && e.name === 'AbortError')) return cancelled();
          PL.report(e, 'measure.speedtest');
          set('speed', 'failed', { error: (ST.errorKey && ST.errorKey(e)) || 'speedtest.err.blocked' });
        }
      }
    }
    if (aborted()) return cancelled();

    // 3b. a second read after the speed test (~20 s later, helper only): average the signal (mW) and notice when the device
    // roamed to another access point / band meanwhile - such a point mixes two places and the user should know
    if (src === 'helper' && w && data.speed && o.recheck !== false) {
      let w2 = null;
      try { w2 = await PL.helperWifi(signal); } catch (e) { if (aborted()) return cancelled(); }
      if (w2) {
        const mr = DI.mergeReads(w, w2);
        data.reads = mr;
        if (mr.roamed) { data.roamed = mr.changed; } else if (mr.dbm !== null && fin(data.value)) {
          data.value = clamp(mr.dbm, -100, -20);
          if (mr.spread !== null && mr.spread > 6) data.unstable = Math.round(mr.spread);
        }
      }
    }
    if (aborted()) return cancelled();

    // 4. save what was measured
    set('save', 'running', null);
    const sp = data.speed;
    const p = PL.P();
    if (data.value === null && !sp) { set('save', 'failed', { reason: 'nothing' }); return out; }
    if (p.measurements.length >= 500) { set('save', 'failed', { reason: 'tooMany' }); return out; }
    const c = { x: clamp(o.point.x, 0, 1), y: clamp(o.point.y, 0, 1) };
    const q = PL.pt(WH.engine.project.nearestFloor(p.plan, c));
    const room = WH.engine.project.roomAt(p.plan, q);
    const presetName = data.device && PL.dev && data.device.presetDevice ? PL.dev.valueFor(data.device.presetDevice) : '';
    const device = clean(o.device) || clean(presetName) || p.goal.device;
    const rec = {
      id: WH.util.uid('m'), x: q.x, y: q.y, band, value: data.value === null ? null : Math.round(data.value * 10) / 10,
      name: clean(o.name) || (room ? room.name : t('planner.m.defName', { n: p.measurements.length + 1 })),
      download: sp ? roundRate(sp.down) : null, upload: sp ? roundRate(sp.up) : null, device, t: Date.now(),
    };
    if (sp) {
      if (fin(sp.ping)) rec.ping = Math.round(sp.ping * 100) / 100;
      if (fin(sp.jitter)) rec.jitter = Math.round(sp.jitter * 100) / 100;
      rec.source = 'cloudflare';
    }
    let wrec = w ? PL.wifiRecord(w) : null;
    // SPEC 13: the user's own answer is stored as the band of the Wi-Fi this point was measured on; "Nevím" = band null
    if (bandBy === 'user') wrec = PL.bands.withBand(wrec, band);
    else if (bandBy === 'auto' && wrec && wrec.band !== null) wrec = PL.bands.withBand(wrec, null);
    if (wrec) rec.wifi = wrec;
    if (data.device) rec.deviceInfo = PL.deviceRecord(data.device);
    // the first device that measures becomes the device the map is calibrated / the speed curve is built for (a goal
    // device without a single measurement would leave the speed map empty)
    const goalOff = !p.measurements.some((m) => norm(m.device) === norm(p.goal.device)) && norm(device) !== norm(p.goal.device);
    try {
      store().commit('planner.undo.measAll', (pr) => {
        pr.measurements.push(rec);
        if (goalOff) pr.goal.device = device;
      }, goalOff ? ['measurements', 'goal'] : ['measurements']);
    } catch (e) { PL.report(e, 'measure.save', { bug: true }); set('save', 'failed', { reason: 'rejected' }); return out; }
    const saved = PL.P().measurements.find((m) => m.id === rec.id) || null;
    if (!saved) { set('save', 'failed', { reason: 'rejected' }); return out; }
    if (fromPending || src === 'paste' || src === 'link') PL.wifiPending.clear();
    out.measurement = saved;
    out.goalChanged = goalOff;
    set('save', 'ok', { measurement: saved, name: saved.name, goalChanged: goalOff });
    WH.bus.emit('planner:measured', { measurement: saved, steps, source: o.source || 'manual' });
    // SPEC 13: the map follows the measured band (the guide keeps its own band: its spots belong to it)
    let switched = '';
    if (o.source !== 'wizard') { try { switched = PL.bands.afterSave(saved); } catch (e) { PL.report(e, 'measure.afterSave', { bug: true }); } }
    out.switched = switched;
    out.roamed = data.roamed || null;
    if (o.toast !== false && o.source !== 'wizard') toastSaved(saved, switched, w);
    if (o.toast !== false && data.roamed) ui().toast({ i18n: 'planner.mall.roamed', action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.measAll' && PL.P().measurements.some((x) => x.id === saved.id)) store().undo(); } } }, { kind: 'warn', ms: 14000 });
    else if (o.toast !== false && data.unstable) ui().toast({ i18n: 'planner.mall.unstable', params: { d: data.unstable } }, { kind: 'info', ms: 9000 });
    return out;
  };

  /** One line about a saved measurement: "−54 dBm · ↓ 245 / ↑ 38 Mb/s". */
  PL.measSummary = (m) => {
    const parts = [];
    if (fin(m.value)) parts.push(WH.util.dbm(m.value));
    if (fin(m.download) && fin(m.upload)) parts.push(`↓ ${PL.mbps(m.download)} / ↑ ${PL.mbps(m.upload)}${WH.util.NBSP}${t('planner.mbps')}`);
    return parts.join(' · ');
  };
  /** "Uloženo · Zpět": the saved measurement with an undo. */
  function toastSaved(m, switched, wifi) {
    // one plain sentence about the channel when it is worth knowing (DFS, overlapping 2.4 GHz channel, 40 MHz on 2.4 GHz)
    let ch = '';
    try { const h = WH.engine.channels.hint(wifi); if (h) ch = t('planner.mall.ch.' + h.key, { c: h.channel }); } catch (e) { PL.report(e, 'measure.channelHint'); }
    ui().toast({
      text: [t('planner.mall.saved', { name: m.name, s: PL.bands.line(m) + (fin(m.download) && fin(m.upload) ? ` · ↓ ${PL.mbps(m.download)} / ↑ ${PL.mbps(m.upload)}${WH.util.NBSP}${t('planner.mbps')}` : '') }), switched, ch].filter(Boolean).join(' '),
      action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.measAll' && PL.P().measurements.some((x) => x.id === m.id)) store().undo(); } },
    }, { kind: 'ok' });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the live checklist (measurement form; reusable by the calibration wizard)
  // ---------------------------------------------------------------------------------------------------------------
  const STATE_ICON = { pending: 'circle', ok: 'check-circle', skipped: 'minus', failed: 'alert-circle', wait: 'help' };
  const STEP_ICON = { device: 'monitor', wifi: 'wifi', speed: 'speed', save: 'save' };

  /** o = {onCancel(), onHow() ("how to get the Wi-Fi details" link)} */
  PL.mallChecklist = function mallChecklist(o) {
    o = o || {};
    const rows = {};
    const list = el('ol.pl-mall__steps');
    for (const k of KEYS) {
      const ico = el('span.pl-mall__ico');
      const kind = el('span.pl-mall__kind', ui().icon(k === 'device' ? 'monitor' : STEP_ICON[k], 16));
      const lbl = el('span.pl-mall__lbl', { 'data-i18n': `planner.mall.step.${k}` }, t(`planner.mall.step.${k}`));
      const info = el('span.pl-mall__info');
      const extra = el('div.pl-mall__extra');
      const li = el('li.pl-mall__step', { dataset: { key: k, state: 'pending' } }, ico, el('div.pl-mall__txt', el('div.pl-mall__head', kind, lbl), info, extra));
      rows[k] = { li, ico, kind, info, extra, state: '', bar: null };
      list.append(li);
      paintIcon(rows[k], 'pending');
    }
    const live = el('div.sr-only', { 'aria-live': 'polite' });
    const cancel = ui().button({ i18n: 'ui.cancel', icon: 'x', size: 'sm', variant: 'secondary', onClick: () => root.cancel() });
    cancel.classList.add('pl-mall__cancel');
    // {noCancel:true}: the host shows its own Cancel (the measurement form puts it in its footer) and calls .cancel()
    const acts = el('div.pl-mall__acts', { hidden: !!o.noCancel }, cancel);
    const root = el('div.pl-mall', { role: 'group', 'aria-label': t('planner.mall.go') }, list, acts, live);
    let consentDone = null;
    let raf = 0;
    let queued = null;
    let connecting = false;

    let bandAsk = null;   // {resolve, ctx} while the Wi-Fi row waits for the band (SPEC 13)

    /** The Wi-Fi row after a skip: connect the helper right here (SPEC 10.1: never a silent skip) + "how to get them". */
    function wifiActions(i) {
      const box = el('div.stack.gap-2');
      const btns = [];
      if (i.reason !== 'phone') {
        const ask = i.reason === 'ask' || i.reason === 'askTimeout';
        const b = ui().button({ i18n: ask ? 'planner.di.helper.ask' : 'planner.di.helper.retry', icon: ask ? 'wifi' : 'refresh', size: 'sm', variant: ask ? 'soft' : 'ghost', onClick: () => connect() });
        b.classList.add('pl-mall__connect');
        // denied: the steps to allow it again are below; "Zkusit znovu" then works without reloading the page
        btns.push(b);
      }
      if (typeof o.onHow === 'function') {
        const how = ui().button({ i18n: 'planner.mall.wifi.how', icon: 'info', size: 'sm', variant: 'ghost', onClick: () => o.onHow() });
        how.classList.add('pl-mall__how');
        btns.push(how);
      }
      if (btns.length) box.append(el('div.cluster', btns));
      if (i.reason === 'denied') box.append(el('div.notice.notice--warn.pl-di__note', ui().icon('lock', 18), el('span', t('planner.di.helper.denied'))));
      return box;
    }

    /** "5 GHz" / "5 GHz (+6 GHz MLO)" of a step's info ({band, wifi}). */
    function bandText(i) {
      const U = WH.engine.units;
      const b = U.normBand(i.band);
      if (!b) return '';
      const links = i.wifi && Array.isArray(i.wifi.links) ? i.wifi.links : [];
      const others = [...new Set(links.map((l) => l && U.normBand(l.band)).filter((x) => x && x !== b))];
      return others.length ? t('planner.bd.mlo', { b: PL.band(b), o: others.map((x) => PL.band(x)).join(' + ') }) : PL.bands.ghz(b);
    }
    /** Why the band is not known yet - the exact problem and its fix (SPEC 13). */
    function whyKey(c) {
      switch (c.reason) {
        case 'phone': return 'planner.bd.why.phone';
        case 'denied': return 'planner.di.helper.denied';
        case 'ask': return 'planner.bd.why.ask';
        case 'askTimeout': return 'planner.mall.wifi.askTimeout';
        case 'slow': return 'planner.bd.why.slow';
        case 'helper': return c.code === 'bad-data' ? 'planner.mall.wifi.badData' : PL.wifiProblemKey(c.code);
        case 'noBandInDetails': return 'planner.bd.why.noBand';
        case 'badPaste': return 'planner.bd.why.badPaste';
        default: return 'planner.bd.why.off';
      }
    }
    /** The band question in the Wi-Fi row: connect / retry the helper, paste the command output, or pick the band. */
    function paintBandAsk(c) {
      const r = rows.wifi;
      const lay = () => { if (typeof o.onLayout === 'function') o.onLayout(); };
      paintIcon(r, 'wait');
      r.info.textContent = t(c.handheld ? 'planner.bd.need.phone' : 'planner.bd.need.pc');
      const answer = (v) => { if (bandAsk) bandAsk.resolve(v); };
      const picker = PL.bands.picker({ value: c.handheld ? PL.bands.choice.get() : null, onPick: (v) => answer({ band: v }), onLayout: lay, how: !!c.handheld });
      const warn = c.reason === 'denied' || c.reason === 'helper' || c.reason === 'badPaste';
      const note = el(`div.notice${warn ? '.notice--warn' : ''}.pl-di__note.pl-bd__why`, ui().icon(c.reason === 'denied' ? 'lock' : c.reason === 'phone' ? 'phone' : 'info', 18), el('span', t(whyKey(c))));
      if (c.handheld) {
        r.extra.replaceChildren(el('div.stack.gap-2.pl-bd__ask', note, picker));
        say(t('planner.bd.need.phone'));
        lay();
        requestAnimationFrame(() => picker.focus());
        return;
      }
      // desktop: the helper first; only an explicit choice continues without it
      const manual = el('div.pl-bd__manual', { hidden: true }, el('p.text-sm', t('planner.bd.manualLead')), picker);
      const paste = pastePanel(answer, lay);
      const ask = c.reason === 'ask' || c.reason === 'askTimeout';
      const conn = ui().button({ i18n: ask ? 'planner.di.helper.ask' : 'planner.di.helper.retry', icon: ask ? 'wifi' : 'refresh', size: 'sm', variant: 'primary', onClick: () => connect() });
      conn.classList.add('pl-mall__connect');
      const pasteBtn = ui().button({ i18n: 'planner.bd.paste', icon: 'terminal', size: 'sm', variant: 'soft' });
      const manBtn = ui().button({ i18n: 'planner.bd.manual', icon: 'edit', size: 'sm', variant: 'ghost' });
      const toggle = (box, btn, other, otherBtn) => {
        box.hidden = !box.hidden;
        btn.setAttribute('aria-expanded', String(!box.hidden));
        other.hidden = true;
        otherBtn.setAttribute('aria-expanded', 'false');
        lay();
        // the opened panel is below the buttons: bring it into the popover's / sheet's scroll view
        if (!box.hidden) requestAnimationFrame(() => { try { box.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old browsers */ } });
      };
      pasteBtn.addEventListener('click', () => toggle(paste, pasteBtn, manual, manBtn));
      manBtn.addEventListener('click', () => { toggle(manual, manBtn, paste, pasteBtn); if (!manual.hidden) requestAnimationFrame(() => picker.focus()); });
      pasteBtn.setAttribute('aria-expanded', 'false');
      manBtn.setAttribute('aria-expanded', 'false');
      const how = typeof o.onHow === 'function' ? ui().button({ i18n: 'planner.mall.wifi.how', icon: 'info', size: 'sm', variant: 'ghost', onClick: () => o.onHow() }) : null;
      if (how) how.classList.add('pl-mall__how');
      r.extra.replaceChildren(el('div.stack.gap-2.pl-bd__ask', note, el('div.cluster.pl-bd__acts', conn, pasteBtn, manBtn, how), paste, manual));
      say(`${t('planner.bd.need.pc')} ${t(whyKey(c))}`);
      lay();
      requestAnimationFrame(() => { try { conn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    }
    /** "Vložit výpis": the command for this computer (Copy) + a box for its output -> the band from the parser. */
    function pastePanel(answer, lay) {
      const ta = el('textarea.input.pl-bd__ta', { rows: '3', spellcheck: 'false', autocomplete: 'off', placeholder: t('planner.bd.pastePh'), 'aria-label': t('planner.bd.pasteAria') });
      const err = el('p.field__error.pl-bd__err', { hidden: true, role: 'alert' });
      const fail = (k) => { err.hidden = false; err.textContent = t(k); lay(); try { ta.focus(); } catch (e) { /* ignore */ } };
      const use = () => {
        const txt = ta.value.trim();
        if (!txt) { fail('planner.bd.why.empty'); return; }
        let res = null;
        try { res = typeof DI.parse === 'function' ? DI.parse(txt) : null; } catch (e) { PL.report(e, 'measure.parsePaste'); res = null; }
        const n = res && normWifi(res);
        if (!n) {
          const wk = res && res.warnings && res.warnings.find((k) => k !== 'devinfo.warn.unknown' && WH.i18n.has(k));
          fail(wk || 'planner.bd.why.badPaste');
          return;
        }
        answer({ wifi: n, source: 'paste' });
      };
      const useBtn = ui().button({ i18n: 'planner.bd.pasteUse', icon: 'check', size: 'sm', variant: 'primary', onClick: use });
      // "Vložit ze schránky" reads the clipboard where the browser allows it (the click is the user's gesture)
      const canRead = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function';
      const clip = canRead ? ui().button({ i18n: 'planner.bd.pasteClip', icon: 'copy', size: 'sm', variant: 'ghost', onClick: async () => {
        let v = '';
        try { v = await navigator.clipboard.readText(); } catch (e) { PL.report(e, 'measure.clipboard'); v = ''; }
        if (v) { ta.value = v; use(); } else fail('planner.bd.pasteCtrlV');
      } }) : null;
      ta.addEventListener('input', () => { if (!err.hidden) { err.hidden = true; lay(); } });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); use(); } });
      const tips = PL.cmdTips ? PL.cmdTips({}) : null;
      return el('div.pl-bd__paste.stack.gap-2', { hidden: true }, tips, ta, err, el('div.cluster', useBtn, clip));
    }
    /** Called by measureAll (o.chooseBand) while the band is unknown: resolves {band} | {wifi, source} | null (cancel). */
    root.chooseBand = (c) => new Promise((resolve) => {
      c = c || {};
      if (bandAsk) bandAsk.resolve(null);
      const me = { ctx: c, resolve: (v) => { if (bandAsk !== me) return; bandAsk = null; resolve(v); } };
      bandAsk = me;
      if (c.signal) c.signal.addEventListener('abort', () => me.resolve(null), { once: true });
      paintBandAsk(c);
    });

    /** "Připojit pomocníka" / "Zkusit znovu" in the Wi-Fi row: ask the browser (inline explainer while its question is
     *  open, up to 30 s), read the details and hand them on: to a waiting band question, else to the host (o.onWifi;
     *  default: kept for the next measurement). */
    async function connect() {
      if (connecting) return;
      const r = rows.wifi;
      connecting = true;
      paintIcon(r, 'running');
      r.info.textContent = t('planner.mall.wifi.probe');
      r.extra.replaceChildren();
      const lay = () => { if (typeof o.onLayout === 'function') o.onLayout(); };
      lay();
      let res = null;
      let w = null;
      let code = '';
      try {
        res = await PL.helperStatus({
          ask: true, timeout: 4000,
          onAsk: () => {
            r.info.textContent = t('planner.mall.wifi.asking');
            r.extra.replaceChildren(el('div.notice.pl-di__note.pl-mall__ask', ui().icon('lock', 18), el('span', t('planner.di.helper.asking'))));
            say(t('planner.di.helper.asking'));
            lay();
          },
        });
        if (res.connected) {
          r.info.textContent = t('planner.mall.wifi.reading');
          w = await PL.helperWifi();
        }
      } catch (e) { code = (e && e.code) || 'error'; PL.report(e, 'measure.helperConnect'); }
      connecting = false;
      const why = code || (res && res.connected) ? 'helper' : !res ? 'noHelper' : res.reason === 'denied' ? 'denied' : res.reason === 'prompt' ? 'askTimeout' : res.reason === 'timeout' ? 'slow' : 'noHelper';
      if (bandAsk) {
        // the measurement waits for its band: the details answer it (measureAll asks again when they carry no band)
        if (w) bandAsk.resolve({ wifi: w, source: 'helper' });
        else paintBandAsk(Object.assign({}, bandAsk.ctx, { reason: why, code }));
        lay();
        return;
      }
      if (w) {
        try { if (typeof o.onWifi === 'function') o.onWifi(w, 'helper'); else { PL.wifiPending.set(w, 'helper'); ui().toast({ text: t('planner.di.usedNext', { s: PL.wifiLine(w, { signal: true }) }) }, { kind: 'ok' }); } } catch (e) { PL.report(e, 'measure.onWifi', { bug: true }); }
        paint({ key: 'wifi', state: 'ok', info: { wifi: w, source: 'helper' } });
      } else if (why === 'helper') paint({ key: 'wifi', state: 'failed', info: { reason: 'helper', code } });
      else paint({ key: 'wifi', state: 'skipped', info: { reason: why } });
      lay();
    }

    function paintIcon(r, state) {
      if (r.state === state) return;
      r.state = state;
      r.li.dataset.state = state;
      r.ico.replaceChildren(state === 'running' ? el('span.spinner.pl-spin', { 'aria-hidden': 'true' }) : ui().icon(STATE_ICON[state] || 'circle', 18));
    }
    const say = (txt) => { live.textContent = ''; setTimeout(() => { live.textContent = txt; }, 30); };

    /** Why the Wi-Fi details are missing (the skipped row; a helper error names its fix). */
    function skipKey(i) {
      if (i.reason === 'helper') return i.code === 'bad-data' ? 'planner.mall.wifi.badData' : PL.wifiProblemKey(i.code);
      return { phone: 'planner.mall.wifi.skipPhone', ask: 'planner.mall.wifi.skipAsk', askTimeout: 'planner.mall.wifi.askTimeout', denied: 'planner.mall.wifi.skipDenied', slow: 'planner.mall.wifi.skipSlow' }[i.reason] || 'planner.mall.wifi.skipPc';
    }
    function infoText(s) {
      const i = s.info || {};
      switch (s.key) {
        case 'device':
          if (s.state === 'running') return t('planner.mall.dev.run');
          if (s.state === 'ok') {
            if (PL.dev && PL.dev.PRESETS && i.presetDevice) { const pr = PL.dev.PRESETS.find((x) => x.id === i.presetDevice); if (pr) rows.device.kind.replaceChildren(ui().icon(pr.icon, 16)); }
            return i.label || t('planner.di.unknown');
          }
          return s.state === 'failed' ? t('planner.mall.dev.fail') : '';
        case 'wifi':
          if (s.state === 'running') return t(i.phase === 'band' ? (i.handheld ? 'planner.bd.need.phone' : 'planner.bd.need.pc') : i.phase === 'helper' ? 'planner.mall.wifi.reading' : i.phase === 'ask' ? 'planner.di.helper.asking' : 'planner.mall.wifi.probe');
          if (s.state === 'ok') {
            // the band itself is shown in bold in front of this line (paint)
            const ln = PL.wifiLine(i.wifi, { signal: true, noBand: !!i.bandBy });
            return `${ln ? ln + ' ' : ''}(${t(`planner.mall.src.${i.source === 'helper' ? 'helper' : i.source === 'link' ? 'link' : i.source === 'saved' ? 'saved' : 'paste'}`)})`;
          }
          if (s.state === 'skipped' && i.reason === 'cancelled') return t('planner.mall.cancelled');
          // no Wi-Fi details, the band from the user (SPEC 13): say that - and on a computer also WHY the details are
          // missing (helper off / permission / its error), so the user knows what "Zkusit znovu" would fix
          if (s.state === 'skipped' && (i.bandBy === 'user' || i.bandBy === 'auto')) {
            const by = t(i.bandBy === 'user' ? 'planner.bd.byUser' : 'planner.bd.byAuto');
            return i.reason && i.reason !== 'phone' ? `${by} · ${t(skipKey(i))}` : by;
          }
          if (s.state === 'failed' && i.reason === 'noBand') return t('planner.bd.saveNoBand');
          if (s.state === 'skipped') return t(skipKey(i));
          return s.state === 'failed' ? t(PL.wifiProblemKey(i.code)) : '';
        case 'speed':
          if (s.state === 'running') {
            if (i.phase === 'consent') return t('planner.mall.speed.consent');
            const ph = i.phase === 'down' || i.phase === 'up' ? i.phase : 'ping';
            const v = fin(i.value) ? (ph === 'ping' ? `${WH.util.fmt(i.value, 0)}${WH.util.NBSP}ms` : `${PL.mbps(i.value)}${WH.util.NBSP}${t('planner.mbps')}`) : '';
            return `${t('speedtest.phase.' + ph)}${v ? ' · ' + v : ''}`;
          }
          if (s.state === 'ok') { const r = i.result; return `↓ ${PL.mbps(r.down)} / ↑ ${PL.mbps(r.up)}${WH.util.NBSP}${t('planner.mbps')}${fin(r.ping) ? ' · ' + t('planner.m.ping', { v: WH.util.fmt(r.ping, 0) }) : ''}`; }
          if (s.state === 'skipped') return t(i.reason === 'cancelled' ? 'planner.mall.cancelled' : 'planner.mall.speed.skipped');
          return s.state === 'failed' ? t(i.error || 'speedtest.err.blocked') : '';
        case 'save':
          if (s.state === 'running') return t('planner.mall.save.run');
          if (s.state === 'ok') return t('planner.mall.save.ok', { name: i.name || '' });
          if (s.state === 'skipped') return t('planner.mall.save.cancelled');
          if (s.state === 'failed') return t(i.reason === 'nothing' ? 'planner.mall.save.nothing' : i.reason === 'tooMany' ? 'planner.m.tooMany' : i.reason === 'noBand' ? 'planner.bd.saveNoBand' : 'planner.mall.save.fail');
          return '';
        default: return '';
      }
    }

    function paint(s) {
      const r = rows[s.key];
      if (!r) return;
      const was = r.state;
      paintIcon(r, s.state);
      r.info.textContent = infoText(s);
      // extras: "Připojit pomocníka" / "Zkusit znovu" + the "how to get them" link, the speed progress bar
      if (s.key === 'wifi' && !connecting) {
        const i = s.info || {};
        // SPEC 13: the band this measurement is saved for, prominent ("5 GHz (+6 GHz MLO)" / "5 GHz" / "Nevím")
        if (i.bandBy && (s.state === 'ok' || s.state === 'skipped')) {
          const txt = i.bandBy === 'auto' ? t('planner.bd.dontKnowLong') : bandText(i);
          r.info.prepend(el('b.pl-bd__got', txt), r.info.textContent ? ' · ' : '');
        }
        // no Wi-Fi details yet (also when the band came from the user's answer): connect the helper / "Jak je získat"
        // can still add them to this measurement afterwards
        const need = (s.state === 'skipped' || s.state === 'failed') && i.reason !== 'cancelled' && i.reason !== 'noBand' && (!i.bandBy || !i.wifi);
        if (need) r.extra.replaceChildren(wifiActions(i));
        else r.extra.replaceChildren();
        if (s.state === 'ok' && i.bandChanged) r.extra.replaceChildren(el('div.pl-mall__note.text-xs', t('planner.mall.bandDiff', { b: PL.band(i.band) })));
      }
      if (s.key === 'speed') {
        const running = s.state === 'running' && (s.info || {}).phase !== 'consent';
        if (running) {
          if (!r.bar) { r.bar = ui().progress({ value: 0 }); r.bar.setAttribute('aria-label', t('speedtest.gauge.aria')); r.extra.replaceChildren(r.bar); }
          r.bar.setValue((s.info && s.info.fraction) || 0);
        } else if (r.bar) { r.bar.remove(); r.bar = null; }
      }
      if (was !== s.state && s.state !== 'pending') say(`${t(`planner.mall.step.${s.key}`)}: ${r.info.textContent}`);
    }

    root.update = (s) => {
      if (Array.isArray(s)) { s.forEach(paint); return; }
      if (!s) return;
      // live speed values: at most one paint per frame
      if (s.key === 'speed' && s.state === 'running' && rows.speed.state === 'running') {
        queued = s;
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (queued) paint(queued); queued = null; });
        return;
      }
      paint(s);
    };
    /** The one-time speed-test consent, inline in the speed row. */
    root.askConsent = () => new Promise((resolve) => {
      const r = rows.speed;
      const okB = ui().button({ i18n: 'speedtest.consent.ok', icon: 'play', size: 'sm', variant: 'primary', onClick: () => done(true) });
      const noB = ui().button({ i18n: 'planner.mall.speed.skip', size: 'sm', variant: 'ghost', onClick: () => done(false) });
      const cell = WH.speedtest && WH.speedtest.onCellular && WH.speedtest.onCellular() ? el('div.notice.notice--warn.pl-di__note', ui().icon('warning', 18), el('span', t('speedtest.cellular'))) : null;
      r.extra.replaceChildren(el('div.pl-mall__consent', el('p.text-sm', t('speedtest.consent.b')), cell, el('div.cluster', okB, noB)));
      requestAnimationFrame(() => { try { okB.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
      if (typeof o.onLayout === 'function') o.onLayout();
      function done(v) {
        if (!consentDone) return;
        consentDone = null;
        r.extra.replaceChildren();
        resolve(v);
        if (typeof o.onLayout === 'function') o.onLayout();
      }
      consentDone = done;
    });
    root.cancel = () => { if (consentDone) consentDone(false); if (bandAsk) bandAsk.resolve(null); if (typeof o.onCancel === 'function') o.onCancel(); };
    root.finish = () => { cancel.hidden = true; acts.hidden = true; if (raf) cancelAnimationFrame(raf); raf = 0; };
    root.reset = () => {
      if (bandAsk) bandAsk.resolve(null);
      acts.hidden = !!o.noCancel;
      cancel.hidden = false;
      for (const k of KEYS) { const r = rows[k]; r.info.textContent = ''; r.extra.replaceChildren(); r.bar = null; paintIcon(r, 'pending'); }
      if (rows.device) rows.device.kind.replaceChildren(ui().icon('monitor', 16));
    };
    root.focusCancel = () => { if (!acts.hidden) { try { cancel.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } };
    return root;
  };
})();
