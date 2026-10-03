// WH.speedtest core (src/js/35-speedtest/10-core.js): pure maths + the whole run() against a simulated network with a
// virtual clock (no real network).   node --test tests/speedtest/speedtest.test.mjs   (also run by tests/engine/run-all.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(here, '../../src/js/35-speedtest/10-core.js');
globalThis.WH = globalThis.WH || {};
vm.runInThisContext(readFileSync(FILE, 'utf8'), { filename: FILE });
const ST = globalThis.WH.speedtest;
const M = ST.math;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);

// ---------------------------------------------------------------------------------------------------------------------
// pure maths
// ---------------------------------------------------------------------------------------------------------------------
test('percentile: linear interpolation between order statistics, ignores non-finite values', () => {
  const v = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
  close(M.percentile(v, 0.9), 9.1, 1e-12);
  close(M.percentile(v, 0.5), 5.5, 1e-12);
  assert.equal(M.percentile(v, 0), 1);
  assert.equal(M.percentile(v, 1), 10);
  assert.equal(M.percentile([42], 0.9), 42);
  close(M.percentile([100, 200], 0.9), 190, 1e-12);
  assert.ok(Number.isNaN(M.percentile([], 0.9)));
  assert.ok(Number.isNaN(M.percentile([NaN, Infinity], 0.9)));
  assert.equal(M.percentile([3, NaN, 1, 2], 0.5), 2);
  assert.equal(M.percentile(v, 7), 10, 'p is clamped');
  assert.deepEqual(v, [10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 'input untouched');
  assert.equal(M.median([5, 1, 3]), 3);
});

test('jitter = mean absolute difference of consecutive pings', () => {
  close(M.jitter([10, 12, 11, 15]), (2 + 1 + 4) / 3, 1e-12);
  assert.equal(M.jitter([10]), 0);
  assert.equal(M.jitter([]), 0);
  assert.equal(M.jitter([7, 7, 7]), 0);
});

test('Mb/s from bytes and milliseconds', () => {
  close(M.mbps(25e6, 460), 434.78, 0.01);
  close(M.mbps(1e6, 8), 1000, 1e-9);
  assert.ok(Number.isNaN(M.mbps(1e6, 0)));
});

test('serverTime: cfRequestDuration, else the sum of cfSpeed* (entries or the raw header)', () => {
  // live header of speed.cloudflare.com (2026-10-03)
  const h = 'cfSpeedEdge;dur=8, cfSpeedWorker;dur=32, cfL4;desc="?proto=TCP&rtt=12120&min_rtt=10895&rtt_var=4961&sent=6&recv=7&lost=0&retrans=0"';
  assert.equal(M.serverTime(h), 40);
  assert.equal(M.serverTime([{ name: 'cfSpeedEdge', duration: 8 }, { name: 'cfSpeedWorker', duration: 32 }, { name: 'cfL4', duration: 0 }]), 40);
  assert.equal(M.serverTime('cfRequestDuration;dur=12.5, cfSpeedWorker;dur=30'), 12.5);
  assert.equal(M.serverTime([{ name: 'cfReqDur', duration: 3 }]), 3);
  assert.equal(M.serverTime(''), 0);
  assert.equal(M.serverTime(null), 0);
  assert.equal(M.serverTime('other;dur=99'), 0);
});

test('ping = TTFB minus server time (live samples), raw TTFB when the server time makes no sense', () => {
  // live: ttfb 54 / server 40, 40 / 25, 188 / 173 (a slow worker run), 37 / 24  -> all ~= the 11-13 ms TCP RTT
  assert.equal(M.pingMs(54, 40), 14);
  assert.equal(M.pingMs(40, 25), 15);
  assert.equal(M.pingMs(188, 173), 15);
  assert.equal(M.pingMs(20, 0), 20);
  assert.equal(M.pingMs(37, 40), 37, 'server time longer than the TTFB -> uncorrected');
  assert.ok(Number.isNaN(M.pingMs(NaN, 10)));
});

test('upload time correction: subtract at most the idle server time, never more than half of the TTFB', () => {
  // live 10 MB upload: TTFB 206 ms, its own server time 194 ms (cfSpeedWorker includes reading the body), idle 32 ms
  assert.equal(M.uploadMs(206, 194, 32), 174);
  close(M.mbps(1e7, M.uploadMs(206, 194, 32)), 459.8, 0.1);
  assert.equal(M.uploadMs(206, 10, 32), 196, 'own server time smaller than idle -> that one');
  assert.equal(M.uploadMs(49, 36, 32), 24.5, 'bounded at half the TTFB');
  assert.equal(M.uploadMs(120, 0, 30), 120, 'no server timing on the request -> raw TTFB');
  assert.equal(M.uploadMs(120, 50, 0), 120, 'no idle reference -> raw TTFB');
  assert.ok(Number.isNaN(M.uploadMs(0, 1, 1)));
});

test('timingOf: Resource Timing entry -> ttfb, payload, server; opaque entries give NaN', () => {
  const e = { requestStart: 838.3, responseStart: 904.3, responseEnd: 1363.8, serverTiming: [{ name: 'cfSpeedEdge', duration: 12 }, { name: 'cfSpeedWorker', duration: 41 }] };
  const t = M.timingOf(e);
  close(t.ttfb, 66, 1e-9);
  close(t.payload, 459.5, 1e-9);
  assert.equal(t.server, 53);
  const opaque = M.timingOf({ requestStart: 0, responseStart: 0, responseEnd: 500 });
  assert.ok(Number.isNaN(opaque.ttfb) && Number.isNaN(opaque.payload));
  assert.ok(Number.isNaN(M.timingOf(null).ttfb));
});

test('bandwidth: 90th percentile of >= 1 MB requests, fallback to all requests >= 10 ms, then all', () => {
  const s = (bytes, ms) => ({ bytes, ms, mbps: M.mbps(bytes, ms) });
  const mixed = [s(1e5, 40), s(1e6, 40), s(1e6, 30), s(1e7, 230), s(1e7, 210), s(2.5e7, 460)];
  const big = mixed.filter((x) => x.bytes >= 1e6).map((x) => x.mbps);
  close(M.bandwidth(mixed), M.percentile(big, 0.9), 1e-9);
  // only small requests (slow line): all of them
  const small = [s(1e5, 800), s(1e5, 700), s(1e5, 900)];
  close(M.bandwidth(small), M.percentile(small.map((x) => x.mbps), 0.9), 1e-9);
  // too short to time are ignored when there is anything else
  close(M.bandwidth([s(1e6, 2), s(1e5, 50)]), M.mbps(1e5, 50), 1e-9);
  close(M.bandwidth([s(1e6, 2)]), M.mbps(1e6, 2), 1e-9);
  assert.ok(Number.isNaN(M.bandwidth([])));
});

/** Drive the ramp against a line of `mbps` with `overhead` ms per request; returns the request sizes. */
function simulateRamp(cfg, mbps, overhead = 30) {
  let st = M.rampStart();
  let t = 0;
  const seq = [];
  for (;;) {
    const b = M.rampNext(st, cfg);
    if (!b) break;
    const wall = overhead + (b * 8) / mbps / 1000;
    t += wall;
    seq.push(b);
    st = M.rampRecord(st, cfg, b, wall, t);
    if (seq.length > 100) throw new Error('runaway');
  }
  return { seq, t, used: st.used };
}

test('ramp decisions: grows 100 kB -> 1 MB -> 10 MB -> 25 MB, respects time budget, data cap and the 1 s rule', () => {
  const quick = { sizes: ST.SIZES.down, ...ST.MODES.quick.down };
  const full = { sizes: ST.SIZES.down, ...ST.MODES.full.down };
  // first request is always the smallest
  assert.equal(M.rampNext(M.rampStart(), quick), 1e5);
  // 100 Mb/s: 100k, 1M, 10M (0.83 s) and then repeats sizes >= 1 MB while the time allows; 25 MB (2 s) never fits
  const a = simulateRamp(quick, 100);
  assert.deepEqual(a.seq.slice(0, 3), [1e5, 1e6, 1e7]);
  assert.ok(!a.seq.includes(2.5e7));
  assert.ok(a.t <= quick.budget + 1000, `time ${a.t}`);
  assert.ok(a.used <= quick.cap);
  // 1 Gb/s: the 20 MB cap ends the quick download early
  const b = simulateRamp(quick, 1000);
  assert.ok(b.used <= quick.cap, `used ${b.used}`);
  assert.ok(b.t < 1000);
  assert.deepEqual(b.seq.slice(0, 3), [1e5, 1e6, 1e7]);
  // full mode repeats every size twice before growing
  const c = simulateRamp(full, 300);
  assert.deepEqual(c.seq.slice(0, 6), [1e5, 1e5, 1e6, 1e6, 1e7, 1e7]);
  assert.ok(c.used <= full.cap && c.t <= full.budget + 1500);
  // 5 Mb/s: a 1 MB request takes ~1.6 s >= 1 s -> stop growing, stay at 1 MB / 100 kB
  const d = simulateRamp(full, 5);
  assert.ok(!d.seq.includes(1e7), d.seq.join());
  assert.ok(d.t <= full.budget + 2000);
  // 0.5 Mb/s: never leaves 100 kB
  const e = simulateRamp(quick, 0.5);
  assert.ok(e.seq.every((x) => x === 1e5));
  assert.ok(e.seq.length >= 1);
  // the "took >= 1 s" rule in isolation: one slow request (a server stall?) is not enough, two at a size are
  let st = M.rampRecord(M.rampStart(), quick, 1e5, 1200, 1200);
  assert.equal(st.capped, false);
  st = M.rampRecord(st, quick, 1e5, 1100, 2300);
  assert.equal(st.capped, true);
  assert.equal(M.rampNext(st, { ...quick, budget: 1e9 }), 1e5);
  // ... and a fast one among them keeps the ramp growing; the speed estimate is the best recent rate
  st = M.rampRecord(M.rampRecord(M.rampStart(), quick, 1e5, 1300, 1300), quick, 1e5, 30, 1330);
  assert.equal(st.capped, false);
  close(st.rate, 1e5 / 30, 1e-9);
  assert.equal(M.rampNext(st, quick), 1e6);
  // max requests
  st = { ...M.rampStart(), n: M.MAX_REQUESTS, rate: 1e9, rates: [1e9] };
  assert.equal(M.rampNext(st, quick), 0);
  // data cap smaller than the first request -> nothing
  assert.equal(M.rampNext(M.rampStart(), { ...quick, cap: 1000 }), 0);
});

test('ramp: when the wanted size does not fit, a smaller one >= 1 MB is used; never shrinks to 100 kB from >= 1 MB', () => {
  const cfg = { sizes: ST.SIZES.down, budget: 2600, cap: 20e6, minPerSize: 1 };
  // at 10 MB, 1 MB used of the cap... 11.1 MB used, 25 MB does not fit the cap, 10 MB does not either (21.1 MB) -> 1 MB
  let st = { idx: 2, atIdx: 1, capped: false, used: 11.1e6, elapsed: 500, n: 3, rate: 50000 };
  assert.equal(M.rampNext(st, cfg), 1e6);
  // used 19.5 MB: nothing >= 1 MB fits -> stop (no 100 kB filler)
  st = { ...st, used: 19.5e6 };
  assert.equal(M.rampNext(st, cfg), 0);
  // at 100 kB on a slow line, 100 kB is still allowed
  st = { idx: 0, atIdx: 3, capped: true, used: 3e5, elapsed: 500, n: 3, rate: 60 };
  assert.equal(M.rampNext(st, cfg), 1e5);
  // the budget: 1 MB at 60 B/ms would need 16 s -> stays at 100 kB; 100 kB needs 1.7 s -> does not fit after 1.5 s
  st = { idx: 0, atIdx: 1, capped: false, used: 1e5, elapsed: 1500, n: 1, rate: 60 };
  assert.equal(M.rampNext(st, cfg), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// run() against a simulated network
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Fake browser: a line with `down`/`up` Mb/s, `rtt` ms and `server` ms of processing per request (an upload's worker
 * time also includes reading the body, as measured live). A virtual clock advances by every transfer's duration.
 * Implements env.send(method, url, data, {signal, onProgress}) like the XHR transport.
 */
function fakeNet({ down = 100, up = 20, rtt = 12, server = 25, timing = true, online = true, fail = null, hang = null, stall = null } = {}) {
  let now = 0;
  let isOnline = online;
  const entries = new Map();
  const log = [];
  const env = {
    now: () => now,
    online: () => isOnline,
    entry: (u) => (timing ? entries.get(u) || null : null),
    clearTimings: () => entries.clear(),
    async send(method, u, data, o) {
      const url = new URL(u);
      const isUp = url.pathname === '/__up';
      const bytes = isUp ? data.length : Number(url.searchParams.get('bytes'));
      log.push({ u, method, bytes, data, o });
      if (fail) { const f = fail(u, bytes, isUp, log.length); if (f) { if (f.status) return { ok: false, status: f.status, bytes: 0, serverHeader: '', tHead: now, tEnd: now }; throw f.error; } }
      if (hang && hang(u, bytes, isUp)) {
        await new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      const start = now + 1;
      const extra = stall ? stall(log.length, bytes, isUp) || 0 : 0; // a worker stall before the first byte (seen live)
      const srv = server + extra + (isUp ? (bytes * 8) / up / 1000 * 0.9 : 0);
      const reqStart = start + 0.5;
      const sendMs = isUp ? (bytes * 8) / up / 1000 : 0;
      const respStart = reqStart + rtt + server + extra + sendMs;
      const respEnd = respStart + (isUp ? 0.3 : (bytes * 8) / down / 1000 + 0.3);
      const tHead = respStart + 0.2;
      // progress events every ~50 ms of the body
      if (o.onProgress && !isUp) for (let t = 50; t < respEnd - respStart; t += 50) { now = respStart + t; o.onProgress(Math.round((bytes * t) / (respEnd - respStart)), now - tHead); }
      now = respEnd + 0.5;
      entries.set(u, { requestStart: reqStart, responseStart: respStart, responseEnd: respEnd, transferSize: bytes + 300, serverTiming: [{ name: 'cfSpeedEdge', duration: 3 }, { name: 'cfSpeedWorker', duration: srv - 3 }] });
      return { ok: true, status: 200, bytes: isUp ? 0 : bytes, serverHeader: `cfSpeedEdge;dur=3, cfSpeedWorker;dur=${srv - 3}`, tHead, tEnd: now };
    },
  };
  return { env, log, clock: () => now, setOnline: (v) => { isOnline = v; } };
}

test('run (quick): measures the simulated line and stays within ~6 s and the data caps', async () => {
  const net = fakeNet({ down: 100, up: 20, rtt: 12, server: 25 });
  const phases = [];
  let last = 0;
  const res = await ST.run({ mode: 'quick', onProgress: (p) => { phases.push(p.phase); assert.ok(p.fraction >= last - 1e-9, 'fraction never goes back'); last = p.fraction; } }, undefined, net.env);
  close(res.down, 100, 4, `down ${res.down}`);
  close(res.up, 20, 2.5, `up ${res.up}`);
  close(res.ping, 12, 1, `ping ${res.ping}`);
  assert.equal(res.jitter, 0);
  assert.equal(res.mode, 'quick');
  assert.ok(res.ms <= 7000, `virtual duration ${res.ms} ms`);
  assert.ok(res.bytes.down <= ST.MODES.quick.down.cap && res.bytes.up <= ST.MODES.quick.up.cap);
  assert.ok(res.samples.down >= 3 && res.samples.up >= 2);
  assert.ok(typeof res.at === 'number' && res.at > 1.7e12);
  // phase order and the final progress
  const order = [...new Set(phases)];
  assert.deepEqual(order, ['ping', 'down', 'up', 'done']);
  assert.equal(last, 1);
  // 1 warm-up + 10 pings
  assert.equal(net.log.filter((r) => r.bytes === 0 && r.method === 'GET').length, 11);
});

test('run (full): longer, more samples, still bounded (~15 s, <= 60 MB)', async () => {
  const net = fakeNet({ down: 300, up: 50, rtt: 20, server: 25 });
  const res = await ST.run({ mode: 'full' }, undefined, net.env);
  close(res.down, 300, 12, `down ${res.down}`);
  close(res.up, 50, 6, `up ${res.up}`);
  close(res.ping, 20, 1, `ping ${res.ping}`);
  assert.ok(res.ms <= 16500, `virtual duration ${res.ms} ms`);
  assert.ok(res.bytes.down + res.bytes.up <= 60e6);
  assert.ok(res.samples.down > 6, `samples ${res.samples.down}`);
});

test('run: slow line (3 / 0.8 Mb/s) and a gigabit line give sensible numbers', async () => {
  const slow = await ST.run({ mode: 'quick' }, undefined, fakeNet({ down: 3, up: 0.8, rtt: 40, server: 25 }).env);
  close(slow.down, 3, 0.6, `slow down ${slow.down}`);
  close(slow.up, 0.8, 0.3, `slow up ${slow.up}`);
  const fast = await ST.run({ mode: 'quick' }, undefined, fakeNet({ down: 940, up: 900, rtt: 5, server: 20 }).env);
  close(fast.down, 940, 60, `fast down ${fast.down}`);
  assert.ok(fast.up > 600 && fast.up < 1100, `fast up ${fast.up}`);
  assert.ok(fast.ms < 3000);
});

test('run: Cloudflare worker stalls (0.3-1.3 s before the first byte, seen live) neither freeze the ramp nor skew the result', async () => {
  // every 4th request stalls 1.3 s on the server, including the first 100 kB download
  const net = fakeNet({ down: 200, up: 40, rtt: 12, server: 25, stall: (n) => (n % 4 === 0 ? 1300 : 0) });
  const res = await ST.run({ mode: 'full' }, undefined, net.env);
  const downs = net.log.filter((r) => r.method === 'GET' && r.bytes > 0).map((r) => r.bytes);
  assert.ok(downs.includes(1e7), `download ramp reached 10 MB: ${downs.join(',')}`);
  close(res.down, 200, 10, `down ${res.down}`);
  close(res.ping, 12, 1, `ping ${res.ping} (median, server time subtracted)`);
  assert.ok(res.up > 25 && res.up < 50, `up ${res.up}`);
});

test('run without Resource Timing (opaque entries): falls back to wall-clock times', async () => {
  const res = await ST.run({ mode: 'quick' }, undefined, fakeNet({ down: 100, up: 20, timing: false }).env);
  assert.ok(res.down > 70 && res.down < 110, `down ${res.down}`);
  assert.ok(res.up > 10 && res.up < 25, `up ${res.up}`);
  assert.ok(res.ping > 0);
});

test('requests: only the two Cloudflare endpoints, unique URLs, text upload bodies, live download progress', async () => {
  const net = fakeNet();
  let live = 0;
  await ST.run({ mode: 'quick', onProgress: (p) => { if (p.live) live++; } }, undefined, net.env);
  const urls = net.log.map((r) => r.u);
  assert.ok(urls.every((u) => u.startsWith('https://speed.cloudflare.com/__down?bytes=') || u.startsWith('https://speed.cloudflare.com/__up?r=')));
  assert.equal(new Set(urls).size, urls.length, 'every URL is unique');
  for (const r of net.log) {
    assert.ok(r.o.signal, 'abortable');
    if (r.method === 'POST') { assert.equal(typeof r.data, 'string'); assert.ok(/^0+$/.test(r.data.slice(0, 1000))); } else assert.equal(r.data, undefined);
  }
  assert.ok(live > 3, `live gauge updates during downloads: ${live}`);
});

/** A stand-in for the browser's XMLHttpRequest that records how xhrSend uses it. */
class FakeXHR {
  static last = null;
  constructor() {
    FakeXHR.last = this;
    this.headers = {};
    this.readyState = 0;
    this.withCredentials = false;
    this.upload = { set onprogress(v) { throw new Error('an upload listener would force a CORS preflight'); } };
    this.read = [];
  }
  open(m, u, a) { this.m = m; this.u = u; this.async = a; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  getResponseHeader(k) { this.read.push(k); return k === 'server-timing' ? 'cfSpeedEdge;dur=4, cfSpeedWorker;dur=20' : 'Brno'; }
  getAllResponseHeaders() { throw new Error('must not read all headers'); }
  abort() { if (this.onabort) this.onabort(); }
  send(data) { this.data = data; }
  respond(status, bytes) {
    this.readyState = 2;
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.onprogress) this.onprogress({ loaded: bytes / 2 });
    this.readyState = 4;
    this.status = status;
    this.response = { byteLength: bytes };
    this.onload();
  }
}

test('xhrSend: async XHR, arraybuffer, no credentials/headers/upload listeners, only Server-Timing read, abort and errors', async () => {
  const prev = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    let clock = 0;
    const now = () => (clock += 5);
    const prog = [];
    const p = ST.xhrSend('GET', 'https://speed.cloudflare.com/__down?bytes=1000', undefined, { onProgress: (b, ms) => prog.push([b, ms]) }, now);
    const x = FakeXHR.last;
    assert.deepEqual([x.m, x.u, x.async, x.responseType, x.withCredentials, x.data], ['GET', 'https://speed.cloudflare.com/__down?bytes=1000', true, 'arraybuffer', false, null]);
    assert.deepEqual(x.headers, {}, 'no request headers (keeps it a simple CORS request)');
    x.respond(200, 1000);
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 1000);
    assert.equal(r.serverHeader, 'cfSpeedEdge;dur=4, cfSpeedWorker;dur=20');
    assert.ok(r.tEnd >= r.tHead && r.tHead > 0);
    assert.deepEqual(prog.map((q) => q[0]), [500]);
    assert.deepEqual(x.read, ['server-timing'], 'never reads the geo headers');
    // upload body passes through, HTTP errors resolve with ok:false
    const pu = ST.xhrSend('POST', 'https://speed.cloudflare.com/__up?r=1', '000', {}, now);
    assert.equal(FakeXHR.last.data, '000');
    FakeXHR.last.respond(429, 0);
    const ru = await pu;
    assert.deepEqual([ru.ok, ru.status], [false, 429]);
    // network error / abort
    const pe = ST.xhrSend('GET', 'https://speed.cloudflare.com/__down?bytes=0', undefined, {}, now);
    FakeXHR.last.onerror();
    await assert.rejects(pe, (e) => e.network === true);
    const ac = new AbortController();
    const pa = ST.xhrSend('GET', 'https://speed.cloudflare.com/__down?bytes=0', undefined, { signal: ac.signal }, now);
    ac.abort();
    await assert.rejects(pa, (e) => e.name === 'AbortError');
    await assert.rejects(ST.xhrSend('GET', 'https://speed.cloudflare.com/__down?bytes=0', undefined, { signal: AbortSignal.abort() }, now), (e) => e.name === 'AbortError');
  } finally {
    globalThis.XMLHttpRequest = prev;
  }
});

test('errors: offline, blocked, busy, server error, timeout - mapped to i18n keys', async () => {
  const rejects = async (env, kind, opts) => {
    await assert.rejects(ST.run(opts || { mode: 'quick' }, undefined, env), (e) => e.kind === kind && e.message === 'speedtest.err.' + kind && ST.errorKey(e) === 'speedtest.err.' + kind);
  };
  // offline before anything is sent
  const off = fakeNet({ online: false });
  await rejects(off.env, 'offline');
  assert.equal(off.log.length, 0, 'no request when offline');
  // a network error while the browser claims to be online = blocked (firewall, ad blocker, DNS)
  await rejects(fakeNet({ fail: () => ({ error: new TypeError('Failed to fetch') }) }).env, 'blocked');
  // the same error after the connection dropped = offline
  const drop = fakeNet({ fail: (u, b, up, n) => (n > 3 ? (drop.setOnline(false), { error: new TypeError('Failed to fetch') }) : null) });
  await rejects(drop.env, 'offline');
  await rejects(fakeNet({ fail: () => ({ status: 429 }) }).env, 'busy');
  await rejects(fakeNet({ fail: (u, b, up) => (up ? { status: 503 } : null) }).env, 'server');
  // a request that never answers
  await rejects(fakeNet({ hang: () => true }).env, 'timeout', { mode: 'quick', tune: { pingTimeout: 40 } });
  assert.equal(ST.errorKey(new Error('weird')), 'speedtest.err.blocked');
});

test('HTTP 429 on big sizes (seen live after heavy use): the ramp stays below them instead of failing', async () => {
  const net = fakeNet({ down: 300, up: 60, fail: (u, bytes) => (bytes >= 1e7 ? { status: 429 } : null) });
  const res = await ST.run({ mode: 'full' }, undefined, net.env);
  const big = net.log.filter((r) => r.bytes >= 1e7);
  assert.equal(big.filter((r) => r.method === 'GET').length, 1, 'the refused 10 MB download is not asked for again');
  assert.equal(big.filter((r) => r.method === 'POST').length, 1, 'the refused 10 MB upload is not asked for again');
  assert.ok(res.down > 200 && res.up > 40, JSON.stringify(res));
  // the live variant: the 429 has no CORS header, the page only sees a network error
  const net2 = fakeNet({ down: 300, up: 60, fail: (u, bytes) => (bytes >= 1e7 ? { error: new TypeError('Failed to fetch') } : null) });
  const res2 = await ST.run({ mode: 'quick' }, undefined, net2.env);
  assert.ok(res2.down > 200 && res2.up > 40, JSON.stringify(res2));
  // refused right at the first request: a real error
  await assert.rejects(ST.run({ mode: 'quick' }, undefined, fakeNet({ fail: (u, bytes) => (bytes === 1e5 ? { status: 429 } : null) }).env), (e) => e.kind === 'busy');
  // the pure rule
  const cfg = { sizes: ST.SIZES.down, budget: 1e9, cap: 1e12, minPerSize: 1 };
  let st = M.rampRecord(M.rampRecord(M.rampStart(), cfg, 1e5, 20, 20), cfg, 1e6, 40, 60);
  st = M.rampRefused(st, cfg, 1e7);
  assert.equal(M.rampNext(st, cfg), 1e6);
  st = M.rampRefused(st, cfg, 1e6);
  assert.equal(M.rampNext(st, cfg), 1e5);
  st = M.rampRefused(st, cfg, 1e5);
  assert.equal(M.rampNext(st, cfg), 0);
});

test('a timeout after the first samples of a phase keeps the samples instead of failing', async () => {
  const net = fakeNet({ down: 100, up: 20, hang: (u, bytes, up) => !up && bytes >= 1e7 });
  const res = await ST.run({ mode: 'quick', tune: { slack: 30, down: { budget: 2600, cap: 20e6, minPerSize: 1 } } }, undefined, net.env);
  assert.ok(res.down > 70, `down ${res.down}`);
  assert.equal(res.samples.down, 2, '100 kB + 1 MB, then the 10 MB request timed out');
});

test('cancel: aborting the signal rejects with AbortError and stops sending requests', async () => {
  const ac = new AbortController();
  const net = fakeNet();
  let n = 0;
  const p = ST.run({ mode: 'full', onProgress: (q) => { if (q.phase === 'down' && ++n === 2) ac.abort(); } }, ac.signal, net.env);
  await assert.rejects(p, (e) => e.name === 'AbortError' && ST.errorKey(e) === '');
  const sent = net.log.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(net.log.length, sent, 'nothing after the abort');
  assert.ok(!net.log.some((r) => r.method === 'POST'), 'never reached the upload');
  // already aborted
  await assert.rejects(ST.run({}, AbortSignal.abort(), fakeNet().env), (e) => e.name === 'AbortError');
});

test('isAvailable / modes / attribution', () => {
  assert.equal(typeof ST.isAvailable(), 'boolean');
  assert.deepEqual(Object.keys(ST.MODES), ['quick', 'full']);
  assert.ok(ST.MODES.quick.down.cap + ST.MODES.quick.up.cap <= 32e6, 'quick <= ~30 MB');
  assert.ok(ST.MODES.full.down.cap + ST.MODES.full.up.cap <= 60e6, 'full <= ~60 MB');
  assert.deepEqual([...ST.SIZES.down], [1e5, 1e6, 1e7, 2.5e7]);
  assert.deepEqual([...ST.SIZES.up], [1e5, 1e6, 1e7]);
  const src = readFileSync(FILE, 'utf8');
  assert.ok(/@cloudflare\/speedtest \(MIT/.test(src), 'attribution comment');
  assert.ok(!/console\.(log|debug|info)/.test(src));
  assert.ok(!/cf-meta|getAllResponseHeaders|getResponseHeader\(\s*'(?!server-timing)/.test(src), 'reads no other response header');
  assert.ok(!/\bfetch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'XHR transport only');
  new vm.Script(src, { filename: '10-core.js' });
});
