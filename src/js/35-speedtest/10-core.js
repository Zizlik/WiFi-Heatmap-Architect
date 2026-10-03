/* WH.speedtest (1/2) - the built-in internet speed test (SPEC 6.1): measurement core, no DOM.
 *
 * Method modelled on Cloudflare's open-source speed test client @cloudflare/speedtest (MIT licence, Copyright (c)
 * Cloudflare, Inc., github.com/cloudflare/speedtest) and re-implemented here (no code copied), against the same public
 * endpoints of speed.cloudflare.com:
 *   1. latency - a warm-up request, then N small requests (__down?bytes=0). ping = Resource Timing requestStart ->
 *      responseStart minus the server's own processing time (Server-Timing cfSpeed*); result = median, jitter = mean
 *      |difference| of consecutive pings.
 *   2. download ramp 100 kB -> 1 MB -> 10 MB -> 25 MB, one request at a time. A size is repeated `minPerSize` times
 *      before the next one; the ramp stops growing once a size proves to take >= 1 s, and stops altogether before the
 *      phase's time budget or data cap would be exceeded (rampNext / rampRecord - robust to the server stalls and the
 *      HTTP 429 refusals seen live, see there). Throughput per request = bits / (responseStart -> responseEnd).
 *   3. upload ramp 100 kB -> 1 MB -> 10 MB, the same rules. Throughput = bits / upload time (see uploadMs()).
 *   result = 90th percentile of the requests of >= 1 MB that lasted >= 10 ms (fallback: all requests).
 *   Modes: quick (~6 s, <= 32 MB of test data) and full (~15 s, <= 60 MB); the caps let 10 MB uploads happen even in
 *   the quick mode (on a fast line 1 MB uploads are dominated by overhead).
 *
 * What the browser really gets cross-origin (verified live from a file:// page and over http, Chrome 2026): the
 * endpoints send Timing-Allow-Origin: *, so Resource Timing entries carry full detail (requestStart, responseStart,
 * responseEnd, transferSize, nextHopProtocol) and serverTiming [cfSpeedEdge, cfSpeedWorker, cfL4]. For a small GET
 * the server time is 20-40 ms of a 35-55 ms TTFB (the rest ~= the TCP RTT), so it must be subtracted from the ping.
 * For an UPLOAD cfSpeedWorker includes reading the request body (10 MB: worker 191 ms of a 206 ms TTFB) - subtracting
 * it would report several Gb/s - so only the idle server time of the latency phase is taken off, see uploadMs().
 *
 * Privacy: the only host contacted is speed.cloudflare.com, only while a test the user started runs; requests carry
 * no cookies/credentials (and, being CORS requests, only the page's origin, never its path); the test data are zeros.
 * Cloudflare's response headers about the client (city, ASN, coordinates ...) are never read - only Resource Timing
 * and the Server-Timing header.
 * Transport: XMLHttpRequest (see xhrSend() for why not fetch()).
 *
 *   WH.speedtest.run({mode:'quick'|'full', onProgress({phase:'ping'|'down'|'up', value, fraction})}, signal) -> Promise<Result>
 *   WH.speedtest.isAvailable() -> bool (false only when the browser says it is offline)
 *   Result = {down, up (Mb/s), ping, jitter (ms), at (epoch ms), mode, ms (duration), bytes:{down,up}, samples:{down,up}}
 *   Errors: Error whose .message/.code is an i18n key 'speedtest.err.<kind>' (.kind = offline|blocked|timeout|busy|server);
 *           cancelling through `signal` rejects with an error whose name is 'AbortError'.
 *   WH.speedtest.math = the pure helpers (unit tested in tests/speedtest).
 */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const ST = (g.WH.speedtest = g.WH.speedtest || {});

  const DOWN_URL = 'https://speed.cloudflare.com/__down';
  const UP_URL = 'https://speed.cloudflare.com/__up';
  const MB = 1e6;

  const SIZES = Object.freeze({ down: Object.freeze([1e5, 1e6, 1e7, 2.5e7]), up: Object.freeze([1e5, 1e6, 1e7]) });
  const MODES = Object.freeze({
    quick: Object.freeze({
      pings: 10, pingBudget: 1500,
      down: Object.freeze({ budget: 2600, cap: 20 * MB, minPerSize: 1 }),
      up: Object.freeze({ budget: 2200, cap: 12 * MB, minPerSize: 1 }),
    }),
    full: Object.freeze({
      pings: 20, pingBudget: 3000,
      down: Object.freeze({ budget: 7000, cap: 37.5 * MB, minPerSize: 2 }),
      up: Object.freeze({ budget: 5500, cap: 22.5 * MB, minPerSize: 2 }),
    }),
  });
  const FINISH_MS = 1000; // a request this long stops the ramp from growing (bandwidthFinishRequestDuration)
  const MIN_MS = 10; // shorter transfers are too coarse to count (bandwidthMinRequestDuration)
  const MIN_USEFUL = 1e6; // requests of at least 1 MB carry the result
  const MAX_REQUESTS = 40; // per direction
  const PING_TIMEOUT = 8000;
  const SLACK_MS = 4000; // a transfer may overrun the phase budget by this much before it counts as a timeout
  /** Share of the progress bar per phase. */
  const SHARE = Object.freeze({ ping: 0.1, down: 0.48, up: 0.42 });

  // -----------------------------------------------------------------------------------------------------------------
  // pure maths (unit tested)
  // -----------------------------------------------------------------------------------------------------------------
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);

  /** p-quantile (0..1) with linear interpolation between order statistics; NaN for no finite value. */
  function percentile(values, p) {
    const v = (values || []).filter(fin).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const i = (v.length - 1) * Math.min(1, Math.max(0, p));
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  }
  const median = (values) => percentile(values, 0.5);

  /** Jitter = mean absolute difference of consecutive pings (in the order they were taken); 0 for < 2 pings. */
  function jitter(pings) {
    const v = (pings || []).filter(fin);
    if (v.length < 2) return 0;
    let s = 0;
    for (let i = 1; i < v.length; i++) s += Math.abs(v[i] - v[i - 1]);
    return s / (v.length - 1);
  }

  /** Mb/s from bytes and milliseconds. */
  const mbps = (bytes, ms) => (ms > 0 && bytes >= 0 ? (bytes * 8) / ms / 1000 : NaN);

  /**
   * Server processing time (ms) from Server-Timing: cfRequestDuration if present, else the sum of the cfSpeed*
   * metrics (edge + worker). Accepts PerformanceServerTiming entries [{name, duration}] or the raw header string.
   */
  function serverTime(st) {
    let list = [];
    if (Array.isArray(st)) list = st.map((x) => ({ name: String(x && x.name), dur: Number(x && x.duration) }));
    else if (typeof st === 'string') {
      for (const part of st.split(',')) {
        const m = /^\s*([A-Za-z][\w-]*)\s*(?:;|$)/.exec(part);
        const d = /;\s*dur\s*=\s*"?([0-9.]+)/i.exec(part);
        if (m) list.push({ name: m[1], dur: d ? Number(d[1]) : 0 });
      }
    }
    const req = list.find((x) => /^cfReq(?:uest)?Dur(?:ation)?$/i.test(x.name) && x.dur > 0.01);
    if (req) return req.dur;
    let sum = 0;
    for (const x of list) if (/^cfSpeed/i.test(x.name) && fin(x.dur) && x.dur > 0) sum += x.dur;
    return sum;
  }

  /** One latency sample: time to first byte minus the server's processing time (raw TTFB when that makes no sense). */
  function pingMs(ttfb, server) {
    if (!fin(ttfb) || ttfb < 0) return NaN;
    const p = fin(server) && server > 0 ? ttfb - server : ttfb;
    return p >= 1 ? p : ttfb;
  }

  /**
   * Upload time of one POST from Resource Timing. requestStart -> responseStart (= TTFB) covers sending the body, the
   * server's processing and one round trip. The server's own time is taken off, but at most the processing time an
   * idle request needed (median of the latency phase) - the request's own cfSpeedWorker includes reading the body.
   * Never more than half of the TTFB is removed, which bounds the error on small, overhead-dominated requests.
   * @param {number} ttfb ms
   * @param {number} reqServer this request's Server-Timing total (ms, 0 = unknown)
   * @param {number} idleServer median server time of the latency requests (ms, 0 = unknown)
   */
  function uploadMs(ttfb, reqServer, idleServer) {
    if (!fin(ttfb) || ttfb <= 0) return NaN;
    const rs = fin(reqServer) && reqServer > 0 ? reqServer : 0;
    const is = fin(idleServer) && idleServer > 0 ? idleServer : 0;
    return Math.max(ttfb - Math.min(rs, is), ttfb / 2);
  }

  /** Timing of a finished request from its Resource Timing entry (null fields when the entry is missing or opaque). */
  function timingOf(entry) {
    const ok = entry && fin(entry.requestStart) && entry.requestStart > 0 && fin(entry.responseStart) && entry.responseStart >= entry.requestStart;
    if (!ok) return { ttfb: NaN, payload: NaN, server: 0 };
    const payload = fin(entry.responseEnd) && entry.responseEnd >= entry.responseStart ? entry.responseEnd - entry.responseStart : NaN;
    const server = Array.isArray(entry.serverTiming) && entry.serverTiming.length ? serverTime(entry.serverTiming) : 0;
    return { ttfb: entry.responseStart - entry.requestStart, payload, server };
  }

  /**
   * Result of a direction: 90th percentile of the per-request throughputs of requests >= 1 MB that took >= 10 ms;
   * fallback all requests >= 10 ms, then all. NaN without samples.
   * @param {Array<{bytes:number, ms:number, mbps:number}>} samples
   */
  function bandwidth(samples) {
    const all = (samples || []).filter((s) => s && fin(s.mbps) && s.mbps > 0);
    const timed = all.filter((s) => s.ms >= MIN_MS);
    const big = timed.filter((s) => s.bytes >= MIN_USEFUL);
    const use = big.length ? big : timed.length ? timed : all;
    return use.length ? percentile(use.map((s) => s.mbps), 0.9) : NaN;
  }

  /** Fresh ramp state. */
  const rampStart = () => ({ idx: 0, atIdx: 0, best: Infinity, capped: false, used: 0, elapsed: 0, n: 0, rates: [], rate: 0, limit: Infinity });

  /**
   * Ramp state after the server refused a size (HTTP 429 "too many requests" / an error): sizes from that one up are
   * never asked for again in this phase. Measured live: after a few hundred MB of tests in an hour Cloudflare answers
   * 429 (Retry-After ~1 h, without CORS headers, so the page sees a network error and Chrome logs a CORS message) for
   * 10 MB+ requests while 1 MB ones still work - the test then simply stays smaller.
   */
  function rampRefused(st, cfg, bytes) {
    const i = cfg.sizes.indexOf(bytes);
    return { ...st, limit: Math.min(st.limit === undefined ? Infinity : st.limit, (i >= 0 ? i : st.idx) - 1), capped: true };
  }

  /**
   * Ramp state after a finished request. `ms` = how long the transfer itself took (download: first to last byte plus
   * one ping; upload: the corrected upload time) - it drives the "stop growing" rule and the time estimates.
   * Measured live, Cloudflare's worker sometimes holds a request for 0.3-1.3 s (even a 0-byte one), so a single slow
   * request must not decide anything: the ramp stops growing only when the FASTEST of at least two requests of the
   * current size took >= 1 s, and the speed estimate is the best of the last three requests. Download stalls before
   * the first byte are left out of `ms` anyway. `elapsed` = wall-clock ms since the phase began (keeps the budget honest).
   */
  function rampRecord(st, cfg, bytes, ms, elapsed) {
    const i = cfg.sizes.indexOf(bytes);
    const idx = i >= 0 ? i : st.idx;
    const same = idx === st.idx && st.n > 0;
    const atIdx = same ? st.atIdx + 1 : 1;
    const best = same ? Math.min(st.best, ms) : ms;
    const rates = (st.rates || []).concat(bytes / Math.max(1, ms)).slice(-3);
    return {
      idx,
      atIdx,
      best,
      capped: st.capped || (atIdx >= 2 && best >= (cfg.finishMs || FINISH_MS)),
      used: st.used + bytes,
      elapsed,
      n: st.n + 1,
      rates,
      rate: Math.max(...rates),
      limit: st.limit === undefined ? Infinity : st.limit,
    };
  }

  /**
   * Size of the next request (bytes) or 0 = the phase is over.
   * cfg = {sizes, budget (ms), cap (bytes), minPerSize, maxRequests?}. Rules: the first request is always the smallest
   * size; grow to the next size after `minPerSize` requests unless that size proved to take >= 1 s; a request must fit
   * the remaining time (estimated from the best recent rate) and the data cap - if the wanted size does not fit, a
   * smaller one >= 1 MB (never below the current size when that is < 1 MB) is tried instead.
   */
  function rampNext(st, cfg) {
    const sizes = cfg.sizes;
    if (st.n >= (cfg.maxRequests || MAX_REQUESTS)) return 0;
    if (!st.n) return sizes[0] <= cfg.cap ? sizes[0] : 0;
    if (st.elapsed >= cfg.budget) return 0;
    const limit = Math.min(sizes.length - 1, st.limit === undefined ? Infinity : st.limit);
    if (limit < 0) return 0;
    let want = Math.min(st.idx, limit);
    if (!st.capped && st.atIdx >= cfg.minPerSize && want < limit) want += 1;
    let floor = Math.min(st.idx, limit);
    while (floor > 0 && sizes[floor - 1] >= MIN_USEFUL) floor -= 1;
    const rate = st.rate > 0 ? st.rate : 0;
    for (let i = want; i >= floor; i--) {
      const b = sizes[i];
      if (st.used + b > cfg.cap) continue;
      if (rate && st.elapsed + b / rate > cfg.budget) continue;
      return b;
    }
    return 0;
  }

  // -----------------------------------------------------------------------------------------------------------------
  // network
  // -----------------------------------------------------------------------------------------------------------------
  function codeError(kind) {
    const e = new Error('speedtest.err.' + kind);
    e.code = e.message;
    e.kind = kind;
    return e;
  }
  function abortError() {
    const e = new Error('speedtest.cancelled');
    e.name = 'AbortError';
    return e;
  }

  const bodies = new Map();
  /** Upload body: zeros as text (text/plain is a CORS-safelisted type, so there is no preflight request). */
  function body(bytes) {
    if (!bodies.has(bytes)) bodies.set(bytes, '0'.repeat(bytes));
    return bodies.get(bytes);
  }

  let seq = 0;
  function urlFor(dir, bytes) {
    seq += 1;
    const r = `${Date.now().toString(36)}${seq.toString(36)}`;
    return dir === 'up' ? `${UP_URL}?r=${r}` : `${DOWN_URL}?bytes=${bytes}&r=${r}`;
  }

  /**
   * Browser transport: XMLHttpRequest. Verified live: reading a fetch() body stream (needed for a live download gauge)
   * makes Chrome report almost every download as cancelled (net::ERR_ABORTED in DevTools) although all bytes arrived;
   * XHR progress events do not, and give the same Resource Timing entries. No upload listener is attached, so a POST of
   * text stays a "simple" CORS request (no preflight). withCredentials stays false: no cookies are sent.
   * Resolves {ok, status, bytes, serverHeader, tHead, tEnd}; rejects with {network:true} or an AbortError.
   */
  function xhrSend(method, url, data, o, now) {
    return new Promise((resolve, reject) => {
      const x = new g.XMLHttpRequest();
      let tHead = 0;
      let settled = false;
      const onAbort = () => { try { x.abort(); } catch (e) { /* ignore */ } };
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        if (o.signal) o.signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      x.open(method, url, true);
      x.responseType = 'arraybuffer';
      x.onreadystatechange = () => { if (x.readyState >= 2 && !tHead) tHead = now(); };
      if (o.onProgress) x.onprogress = (e) => { if (!tHead) tHead = now(); o.onProgress(e.loaded, now() - tHead); };
      x.onload = () => {
        let st = '';
        try { st = x.getResponseHeader('server-timing') || ''; } catch (e) { st = ''; }
        const t = now();
        done(resolve, { ok: x.status >= 200 && x.status < 300, status: x.status, bytes: x.response ? x.response.byteLength : 0, serverHeader: st, tHead: tHead || t, tEnd: t });
      };
      x.onerror = () => done(reject, Object.assign(new Error('network'), { network: true }));
      x.ontimeout = x.onerror;
      x.onabort = () => done(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (o.signal) {
        if (o.signal.aborted) { done(reject, Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        o.signal.addEventListener('abort', onAbort);
      }
      try { x.send(data === undefined ? null : data); } catch (e) { done(reject, Object.assign(new Error('network'), { network: true })); }
    });
  }

  /** Browser environment (tests inject their own `send` etc.). */
  function browserEnv() {
    const perf = g.performance;
    const now = () => perf.now();
    return {
      send: (method, url, data, o) => xhrSend(method, url, data, o, now),
      now,
      entry: (u) => {
        try { const l = perf.getEntriesByName(u, 'resource'); return l.length ? l[l.length - 1] : null; } catch (e) { return null; }
      },
      clearTimings: () => { try { if (perf.clearResourceTimings) perf.clearResourceTimings(); } catch (e) { /* ignore */ } },
      online: () => !(g.navigator && g.navigator.onLine === false),
      setTimeout: (f, ms) => g.setTimeout(f, ms),
      clearTimeout: (id) => g.clearTimeout(id),
    };
  }

  const tick = (env) => new Promise((res) => env.setTimeout(res, 0));

  /**
   * One request. o = {signal, timeout, onChunk(bytesSoFar, msSinceHeaders)}.
   * Resolves {url, bytes, wall, wallHead, wallBody, entry, serverHeader}; rejects with codeError()/abortError().
   */
  async function request(env, dir, bytes, o) {
    const url = urlFor(dir, bytes);
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    if (o.signal) {
      if (o.signal.aborted) throw abortError();
      o.signal.addEventListener('abort', onAbort);
    }
    const timer = env.setTimeout(() => { timedOut = true; ac.abort(); }, o.timeout);
    const t0 = env.now();
    try {
      const r = await env.send(dir === 'up' ? 'POST' : 'GET', url, dir === 'up' ? body(bytes) : undefined, { signal: ac.signal, onProgress: o.onChunk || null });
      if (!r || !r.ok) throw codeError(r && r.status === 429 ? 'busy' : 'server');
      if (dir === 'down' && r.bytes < bytes) throw codeError('server');
      let entry = env.entry(url);
      if (!entry) { await tick(env); entry = env.entry(url); }
      return { url, bytes, wall: r.tEnd - t0, wallHead: r.tHead - t0, wallBody: r.tEnd - r.tHead, entry, serverHeader: r.serverHeader || '' };
    } catch (err) {
      if (o.signal && o.signal.aborted) throw abortError();
      if (timedOut) throw codeError('timeout');
      if (err && err.kind) throw err;
      throw codeError(env.online() ? 'blocked' : 'offline');
    } finally {
      env.clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Server time of a finished request: Resource Timing's serverTiming, else the Server-Timing header. */
  function serverOf(res, tm) {
    if (tm.server > 0) return tm.server;
    return res.serverHeader ? serverTime(res.serverHeader) : 0;
  }

  const round1 = (v) => Math.round(v * 10) / 10;

  /**
   * Run a test. Rejects with codeError('offline') right away when the browser is offline.
   * @param {{mode?:'quick'|'full', onProgress?:function, tune?:object}} [opts] tune overrides MODES fields and the
   *   timeouts {pingTimeout, slack} (tests)
   * @param {AbortSignal} [signal]
   * @param {object} [envOverride] send/now/entry/online/... replacements (tests)
   */
  async function run(opts, signal, envOverride) {
    const o = opts || {};
    // ST.testEnv: QA hook (a simulated network for UI tests that must not load Cloudflare); never set by the app
    const env = Object.assign(browserEnv(), ST.testEnv || {}, envOverride || {});
    const mode = MODES[o.mode] ? o.mode : 'quick';
    const M = Object.assign({}, MODES[mode], o.tune || {});
    const report = (p) => { if (typeof o.onProgress === 'function') { try { o.onProgress(p); } catch (e) { /* a broken listener must not stop the test */ } } };
    if (!env.online()) throw codeError('offline');
    if (signal && signal.aborted) throw abortError();
    env.clearTimings();
    const T0 = env.now();

    // 1. latency (+ one warm-up request that opens the connection)
    const pings = [];
    const servers = [];
    report({ phase: 'ping', value: NaN, fraction: 0 });
    for (let i = 0; i <= M.pings; i++) {
      const r = await request(env, 'down', 0, { signal, timeout: M.pingTimeout || PING_TIMEOUT });
      const tm = timingOf(r.entry);
      const srv = serverOf(r, tm);
      const p = fin(tm.ttfb) ? pingMs(tm.ttfb, srv) : r.wallHead;
      if (i === 0) continue;
      pings.push(p);
      if (srv > 0) servers.push(srv);
      report({ phase: 'ping', value: median(pings), fraction: SHARE.ping * (i / M.pings) });
      if (env.now() - T0 > M.pingBudget && pings.length >= 3) break;
    }
    const idleServer = servers.length ? median(servers) : 0;
    const ping0 = median(pings);

    // 2./3. download and upload ramps
    async function phase(dir, base) {
      const P = M[dir];
      const cfg = { sizes: SIZES[dir], budget: P.budget, cap: P.cap, minPerSize: P.minPerSize };
      const samples = [];
      let st = rampStart();
      const t0 = env.now();
      const frac = () => base + SHARE[dir] * Math.min(1, (env.now() - t0) / cfg.budget);
      report({ phase: dir, value: NaN, fraction: base });
      for (;;) {
        const bytes = rampNext(st, cfg);
        if (!bytes) break;
        const slack = M.slack || SLACK_MS;
        const timeout = Math.max(slack, cfg.budget - (env.now() - t0) + slack);
        let r;
        try {
          r = await request(env, dir, bytes, {
            signal, timeout,
            onChunk: dir === 'down' ? (got, ms) => { if (ms >= 40 && got >= 64e3) report({ phase: dir, value: mbps(got, ms), fraction: frac(), live: true }); } : null,
          });
        } catch (err) {
          if (err && err.kind === 'timeout' && samples.length) break; // keep what we have
          // the server refuses this size but smaller ones worked: go on without it. Cloudflare's 429 carries no CORS
          // header, so the browser only reports a network error ('blocked') - for a size above the smallest one that
          // already went through, that is what it means.
          const refused = err && (err.kind === 'busy' || err.kind === 'server' || (err.kind === 'blocked' && bytes > cfg.sizes[0]));
          if (refused && samples.length) { st = rampRefused(st, cfg, bytes); continue; }
          throw err;
        }
        const tm = timingOf(r.entry);
        let ms;
        // without Resource Timing (no Timing-Allow-Origin, old browsers) the wall clock is the fallback
        if (dir === 'down') ms = fin(tm.payload) && tm.payload > 0 ? tm.payload : r.wallBody > 0 ? r.wallBody : r.wall;
        else ms = fin(tm.ttfb) ? uploadMs(tm.ttfb, serverOf(r, tm), idleServer) : r.wallHead > 0 ? r.wallHead : r.wall;
        samples.push({ bytes, ms, mbps: mbps(bytes, ms), wall: r.wall });
        // ramp decisions on the transfer time (+ one ping for the request itself), not on server stalls
        const eff = dir === 'down' && fin(tm.payload) && tm.payload > 0 ? ms + (fin(ping0) ? ping0 : 0) : ms;
        st = rampRecord(st, cfg, bytes, Math.min(r.wall, eff), env.now() - t0);
        report({ phase: dir, value: bandwidth(samples), fraction: frac() });
      }
      return { value: bandwidth(samples), n: samples.length, used: st.used };
    }
    const down = await phase('down', SHARE.ping);
    const up = await phase('up', SHARE.ping + SHARE.down);
    if (!fin(down.value) || !fin(up.value)) throw codeError('timeout');
    const res = {
      down: round1(down.value), up: round1(up.value), ping: round1(median(pings)), jitter: round1(jitter(pings)),
      at: Date.now(), mode, ms: Math.round(env.now() - T0),
      bytes: { down: down.used, up: up.used }, samples: { down: down.n, up: up.n },
    };
    report({ phase: 'done', value: res.down, fraction: 1 });
    return res;
  }

  /** False only when the browser reports it is offline (file:// pages can run the test: origin "null" is allowed). */
  function isAvailable() {
    return typeof g.XMLHttpRequest === 'function' && !(g.navigator && g.navigator.onLine === false);
  }

  /** i18n key for any error a run() rejected with ('' for a cancellation). */
  function errorKey(err) {
    if (err && err.name === 'AbortError') return '';
    return err && err.kind ? 'speedtest.err.' + err.kind : 'speedtest.err.blocked';
  }

  /** Mobile data warning: true when the browser says the connection is cellular (Chrome on Android only). */
  function onCellular() {
    const c = g.navigator && g.navigator.connection;
    return !!(c && c.type === 'cellular');
  }

  Object.assign(ST, {
    run, isAvailable, errorKey, onCellular, MODES, SIZES, xhrSend,
    math: { percentile, median, jitter, mbps, serverTime, pingMs, uploadMs, timingOf, bandwidth, rampStart, rampRecord, rampRefused, rampNext, FINISH_MS, MIN_MS, MIN_USEFUL, MAX_REQUESTS },
  });
})();
