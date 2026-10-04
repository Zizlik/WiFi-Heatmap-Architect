// SPEC 10 (stage 7): the what-if at the measured points (analysis.predictAtMeasurements / summarizePredictions /
// whatIfActive) and speed through a second node (speed.nodeLink / predictVia / pointSpeed / fieldSpeed / homeSummary,
// optimize speed mode, node.maxMbps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, door, makeProject } from './_helpers.mjs';

const M = E.model;
const P = E.project;
const S = E.speed;
const A = E.analysis;
const R = E.raster;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (eps ${eps})`);

// A row of three 3 x 3 m rooms (mpp 0.01: 1 px = 1 cm), 10 dB walls between them, router "today" in the left room.
//   room 1: x 100-400   room 2: x 400-700   room 3: x 700-1000   (y 300-600)
function rowPlan(extra = {}) {
  return makeProject({
    rooms: [room(1, 100, 300, 400, 600, 'Vlevo'), room(2, 400, 300, 700, 600, 'Uprostřed'), room(3, 700, 300, 1000, 600, 'Vpravo')],
    walls: [
      wall('wn', 100, 300, 1000, 300, 12),
      wall('we', 1000, 300, 1000, 600, 12),
      wall('ws', 1000, 600, 100, 600, 12),
      wall('ww', 100, 600, 100, 300, 12),
      wall('w12', 400, 300, 400, 600, 10),
      wall('w23', 700, 300, 700, 600, 10),
    ],
    router: [180, 450],
    baseline: [180, 450],
    goal: { device: 'Telefon' },
    // SPEC 10 semantics: every point keeps its band (the 5 GHz view; the band mode Auto has its own tests in steer.test.mjs)
    view: { band: 5 },
    ...extra,
  });
}

// a fixed speed curve (device "Telefon", 5 GHz): 600 / 200 Mb/s at -40 dBm down to 4 / 2 Mb/s at -82 dBm
let mid = 0;
const sm = (value, down, up, band = 5) => ({ id: `c${++mid}`, x: 0.5, y: 0.5, band, value, name: 'c', download: down, upload: up, device: 'Telefon', t: 0 });
const CURVE_MEAS = [sm(-40, 600, 200), sm(-50, 450, 150), sm(-60, 220, 80), sm(-67, 90, 35), sm(-75, 25, 10), sm(-82, 4, 2)];
const CURVE = S.buildCurve(CURVE_MEAS, { band: 5, device: 'Telefon' });
const CURVE24 = S.buildCurve(CURVE_MEAS.map((m) => ({ ...m, band: 2.4, download: m.download / 2, upload: m.upload / 2 })), { band: 2.4, device: 'Telefon' });
const meas = (id, px, py, value, down = null, up = null, band = 5) => ({ id, x: n(px, py).x, y: n(px, py).y, band, value, name: id, download: down, upload: up, device: 'Telefon', t: 1 });
const node = (mode, px, py, more = {}) => ({ mode, pos: n(px, py), bands: { '2.4': true, '5': true, '6': false }, power: 0, backhaulBand: 5, backhaulThreshold: -67, ...more });
const run = (p, o = {}) => A.predictAtMeasurements(M.createContext(p), p, { curves: { 5: CURVE, '2.4': CURVE24 }, ...o });

test('setup: the synthetic curve exists', () => {
  assert.ok(CURVE && CURVE24);
});

test('nothing changed: delta 0, predicted = measured, speed = measured', () => {
  const p = rowPlan({ measurements: [meas('far', 900, 450, -78, 20, 8), meas('near', 300, 450, -50, 400, 140)] });
  assert.equal(A.whatIfActive(p), false);
  const r = run(p);
  assert.equal(r.length, 2);
  for (const e of r) {
    assert.equal(e.reason, null);
    assert.equal(e.delta, 0);
    assert.equal(e.changed, false);
    assert.equal(e.source, 'router');
    assert.equal(e.predicted, e.measured);
    assert.equal(e.modelNew, e.modelToday);
    assert.equal(e.nodeNew, null);
    assert.equal(e.speed.predDown, e.speed.measuredDown);
    assert.equal(e.speed.predUp, e.speed.measuredUp);
    assert.equal(e.speed.anchored, true);
  }
  const s = A.summarizePredictions(r);
  assert.deepEqual({ c: s.count, ch: s.changed, i: s.improved, w: s.worsened, u: s.unchanged }, { c: 2, ch: false, i: 0, w: 0, u: 2 });
});

test('moving the router closer to a far point: positive delta there, predicted = measured + delta, model = the map', () => {
  const p0 = rowPlan({ measurements: [meas('far', 900, 450, -80, 10, 4), meas('home', 250, 450, -48, 450, 150)] });
  const p = P.sanitize({ ...p0, net: { ...p0.net, router: n(560, 450) } });
  assert.equal(A.whatIfActive(p), true);
  const ctx = M.createContext(p);
  const offs = M.offsets(ctx, p);
  const r = A.predictAtMeasurements(ctx, p, { offsets: offs, curves: { 5: CURVE } });
  const far = r.find((e) => e.id === 'far');
  const home = r.find((e) => e.id === 'home');
  assert.ok(far.delta > 8, `far point gains ${far.delta}`);
  assert.ok(home.delta < -3, `the router's old room loses ${home.delta}`);
  close(far.predicted, far.measured + far.delta, 1e-9);
  assert.equal(far.changed, true);
  // today / new are exactly what the planner's tooltip (pointSignalDetail) and the map show
  const d = M.pointSignalDetail(ctx, { x: far.x, y: far.y }, M.fieldParams(p, 'trial', { offsets: offs }));
  close(far.modelNew, d.combined, 1e-9);
  close(far.modelToday, d.baseline, 1e-9);
  const a = A.run(p, { cell: 4, ctx, offsets: offs });
  close(R.sample(a.grid, a.trial, { x: far.x, y: far.y }), far.modelNew, 0.6, 'raster trial');
  close(R.sample(a.grid, a.today, { x: far.x, y: far.y }), far.modelToday, 0.6, 'raster today');
  // the anchored speed rises with the signal and stays below the best test
  assert.ok(far.speed.anchored && far.speed.predDown > far.speed.measuredDown, `${far.speed.measuredDown} -> ${far.speed.predDown}`);
  assert.ok(far.speed.predDown <= 600 + 1e-9);
  assert.ok(home.speed.predDown < home.speed.measuredDown);
  const s = A.summarizePredictions(r);
  assert.equal(s.best.id, 'far');
  assert.equal(s.worst.id, 'home');
  assert.equal(s.improved, 1);
  assert.equal(s.worsened, 1);
  assert.equal(s.rooms[0].roomId, 3, 'best room first');
  assert.equal(s.speed.improved, 1);
  assert.equal(s.speed.worsened, 1);
});

test('anchoring: predDown = measured x curve(sig_new) / curve(sig_today) (raw curve rates), before the ceilings', () => {
  const p0 = rowPlan({ measurements: [meas('far', 900, 450, -78, 30, 9)] });
  const p = P.sanitize({ ...p0, net: { ...p0.net, router: n(600, 450) } });
  const [e] = run(p);
  const rn = S.rate(CURVE, e.predicted);
  const rt = S.rate(CURVE, e.measured);
  close(e.speed.predDown, Math.min((30 * rn.down) / rt.down, Math.max(30, 600)), 1e-9);
  close(e.speed.predUp, Math.min((9 * rn.up) / rt.up, Math.max(9, 200)), 1e-9);
  assert.equal(e.speed.limitedBy, null);
  // a speed-only point (no dBm): predicted = modelNew, today's signal = modelToday
  const p2 = P.sanitize({ ...p, measurements: [meas('so', 900, 450, null, 30, 9)] });
  const [f] = run(p2);
  assert.equal(f.measured, null);
  assert.equal(f.predicted, f.modelNew);
  const rt2 = S.rate(CURVE, f.modelToday);
  if (rt2) close(f.speed.predDown, Math.min((30 * S.rate(CURVE, f.modelNew).down) / rt2.down, 600), 1e-9);
  // a point without a speed test: the model at the predicted signal (not anchored), no reserve
  const p3 = P.sanitize({ ...p, measurements: [meas('sig', 900, 450, -70)], goal: { ...p.goal, reserve: 50 } });
  const [g] = run(p3);
  assert.equal(g.speed.anchored, false);
  close(g.speed.predDown, S.rate(CURVE, g.predicted).down, 1e-9);
});

test('a wired AP next to a point: large delta, the node serves it, only plan / link / maxMbps can cap it', () => {
  const p = rowPlan({ measurements: [meas('far', 900, 450, -80, 8, 3)], node: node('ap_cable', 870, 420) });
  const [e] = run(p);
  assert.equal(e.source, 'node');
  assert.ok(e.delta > 20, `delta ${e.delta}`);
  assert.ok(e.nodeNew > e.routerNew);
  close(e.routerNew, e.modelToday, 1e-9, 'the router did not move');
  assert.ok(e.speed.predDown > 300, `wired AP: ${e.speed.predDown}`);
  assert.equal(e.speed.limitedBy, null);
  // node.maxMbps = the device's ceiling
  const pc = P.sanitize({ ...p, node: { ...p.node, maxMbps: 150 } });
  const [c] = run(pc);
  close(c.speed.predDown, 150, 1e-9);
  assert.equal(c.speed.limitedBy, 'device');
  assert.equal(c.speed.capDown, 150);
  // the plan
  const pp = P.sanitize({ ...p, net: { ...p.net, wanDown: 100, wanUp: 50 } });
  const [q] = run(pp);
  close(q.speed.predDown, 100, 1e-9);
  assert.equal(q.speed.limitedBy, 'plan');
  assert.equal(q.speed.limitedByUp, 'plan');
  // the WAN port / link
  const pl = P.sanitize({ ...p, net: { ...p.net, wanPort: 100 } });
  const [l] = run(pl);
  close(l.speed.predDown, 100, 1e-9);
  assert.equal(l.speed.limitedBy, 'link');
  // the plan also counts as the limit when the Wi-Fi reaches 85 % of it
  const pn = P.sanitize({ ...p, net: { ...p.net, wanDown: Math.round(e.speed.predDown * 1.1) } });
  const [nq] = run(pn);
  close(nq.speed.predDown, e.speed.predDown, 1e-9, 'not capped');
  assert.equal(nq.speed.limitedBy, 'plan');
});

test('a repeater far from the router behind 2 walls: strong signal near it, but the speed is capped by its link', () => {
  const p = rowPlan({ measurements: [meas('far', 900, 450, -80, 8, 3), meas('home', 250, 450, -48, 450, 150)], node: node('repeater', 880, 450) });
  const ctx = M.createContext(p);
  const offs = { '2.4': 0, '5': 0, '6': 0 }; // uncalibrated: the uplink (-78.6 dBm) stays inside the curve
  const st = M.fieldParams(p, 'trial', { offsets: offs });
  assert.equal(M.wallCount(ctx, st.router, st.node.pos), 2);
  const link = S.nodeLink(ctx, st, CURVE);
  assert.equal(link.wireless, true);
  assert.equal(link.factor, 0.5);
  close(link.signal, M.backhaulSignal(ctx, st), 1e-12);
  close(link.down, S.rate(CURVE, link.signal).down * 0.5, 1e-9);
  const r = A.predictAtMeasurements(ctx, p, { offsets: offs, curves: { 5: CURVE } });
  const far = r.find((e) => e.id === 'far');
  assert.equal(far.source, 'node');
  assert.ok(far.nodeNew > -50, `strong client signal near the repeater: ${far.nodeNew}`);
  assert.equal(far.speed.limitedBy, 'backhaul');
  close(far.speed.predDown, link.down, 1e-9, 'capped by the uplink');
  close(far.speed.capDown, link.down, 1e-9);
  assert.ok(far.speed.predDown < S.rate(CURVE, far.nodeNew).down / 2, 'far below what the signal alone would give');
  // the router's own room is unchanged (router-served)
  const home = r.find((e) => e.id === 'home');
  assert.equal(home.source, 'router');
  assert.equal(home.delta, 0);
  assert.equal(home.speed.predDown, 450);
  // wireless mesh: the same with 0.6
  const pm = P.sanitize({ ...p, node: { ...p.node, mode: 'mesh_wifi' } });
  const lm = S.nodeLink(ctx, M.fieldParams(pm, 'trial', { offsets: offs }), CURVE);
  close(lm.down / link.down, 0.6 / 0.5, 1e-9);
  // a repeater one wall closer (better uplink): a ceiling below the uplink binds as the device
  const pd = P.sanitize({ ...p, node: { ...p.node, pos: n(660, 450), maxMbps: 20 } });
  const ld = S.nodeLink(ctx, M.fieldParams(pd, 'trial', { offsets: offs }), CURVE);
  assert.ok(ld.down > 20, `uplink ${ld.down}`);
  const md = A.predictAtMeasurements(ctx, P.sanitize({ ...pd, measurements: [meas('mid', 620, 450, -75, 25, 10)] }), { offsets: offs, curves: { 5: CURVE } })[0];
  assert.equal(md.source, 'node');
  close(md.speed.predDown, 20, 1e-9);
  assert.equal(md.speed.limitedBy, 'device');
  assert.equal(md.speed.capDown, 20);
  const s = A.summarizePredictions(r);
  assert.equal(s.speed.limited.backhaul, 1);
});

test('nodeLink: wired / no curve / too weak / another band / an explicit backhaul curve / no node', () => {
  const p = rowPlan({ node: node('mesh_cable', 880, 450, { maxMbps: 500 }) });
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial');
  const w = S.nodeLink(ctx, st, CURVE);
  assert.deepEqual({ wl: w.wireless, s: w.signal, d: w.down, k: w.known, c: w.capDown, f: w.factor }, { wl: false, s: null, d: null, k: true, c: 500, f: null });
  const pr = P.sanitize({ ...p, node: { ...p.node, mode: 'repeater', maxMbps: null } });
  const sr = M.fieldParams(pr, 'trial');
  const nc = S.nodeLink(ctx, sr, null);
  assert.equal(nc.known, false);
  assert.equal(nc.reason, 'curve');
  assert.ok(Number.isFinite(nc.signal), 'the backhaul quality in dBm is known without a curve');
  assert.equal(nc.weak, nc.signal < -67);
  const narrow = S.buildCurve([sm(-40, 600, 200), sm(-50, 450, 150)], { band: 5, device: 'Telefon' });
  const weak = S.nodeLink(ctx, sr, narrow);
  assert.equal(weak.known, false);
  assert.equal(weak.reason, 'weak');
  const ap = S.nodeLink(ctx, sr, CURVE24);
  assert.equal(ap.approx, true, '2.4 GHz curve for a 5 GHz backhaul');
  const ex = S.nodeLink(ctx, sr, CURVE24, { backhaulCurve: CURVE });
  assert.equal(ex.approx, false);
  close(ex.down, S.rate(CURVE, ex.signal).down * 0.5, 1e-9);
  assert.equal(S.nodeLink(ctx, M.fieldParams(rowPlan(), 'trial'), CURVE), null);
  assert.equal(S.nodeLink(ctx, null, CURVE), null);
  // a link that cannot be estimated makes node-served points unknown, with the reason
  const pw = P.sanitize({ ...pr, measurements: [meas('far', 900, 450, -80, 8, 3)] });
  const [e] = A.predictAtMeasurements(ctx, pw, { curves: { 5: narrow } });
  assert.ok(e.nodeNew > -50, 'the client next to the repeater is inside the narrow curve ...');
  assert.equal(e.speed.reason, 'backhaul', '... but its uplink is not');
  const [f] = A.predictAtMeasurements(ctx, pw, { curves: { 5: CURVE }, backhaulCurve: narrow });
  assert.equal(f.speed.reason, 'backhaul');
  assert.equal(f.speed.predDown, null);
  assert.equal(f.speed.limitedBy, 'backhaul');
});

test('one rule: fieldSpeed cells = predictVia(sig, link when the node serves) exactly; the map agrees with the points', () => {
  const p = rowPlan({ node: node('repeater', 880, 450, { maxMbps: 300 }), net: undefined });
  p.net.wanDown = 500;
  p.net.wanUp = 100;
  const ctx = M.createContext(p);
  const a = A.run(p, { cell: 4, ctx });
  const limits = { wanDown: 500, wanUp: 100, reserve: 0 };
  const sf = S.fieldSpeed(ctx, a.grid, a.params.trial, CURVE, limits, a.trial);
  assert.equal(sf.supported, true);
  assert.equal(sf.source, a.nodeWins, 'the nodeWins fieldEx remembered for a.trial');
  const link = S.nodeLink(ctx, a.params.trial, CURVE);
  let nodeCells = 0;
  const kinds = new Set();
  for (const i of a.grid.idx) {
    const via = a.nodeWins[i] === 1;
    if (via) nodeCells++;
    const v = S.predictVia(CURVE, a.trial[i], limits, via ? link : null);
    if (!v) {
      assert.equal(sf.known[i], 0);
      continue;
    }
    assert.equal(sf.known[i], 1);
    close(sf.down[i], v.down, 1e-3);
    close(sf.up[i], v.up, 1e-3);
    assert.equal(S.LIMIT_KINDS[sf.limitedBy[i]], v.limitedBy);
    kinds.add(v.limitedBy);
  }
  assert.ok(nodeCells > 100 && kinds.has('backhaul') && kinds.has(null), [...kinds].join(','));
  // nodeWins handed in / recomputed: the same result
  const sf2 = S.fieldSpeed(ctx, a.grid, a.params.trial, CURVE, limits, a.trial.slice());
  assert.deepEqual([...sf2.known], [...sf.known]);
  assert.deepEqual([...sf2.limitedBy], [...sf.limitedBy]);
  const sf3 = S.fieldSpeed(ctx, a.grid, a.params.trial, CURVE, limits, null, { nodeWins: a.nodeWins });
  close(Math.max(...sf3.down.map((v, i) => Math.abs(v - sf.down[i]))), 0, 1, 'without the signal field: recomputed (aa 1)');
  // the map vs the points: a measurement whose value equals today's model has predicted = modelNew, and no speed
  // test -> the model at that signal: the same as the map's cell (softened point vs grid, < 0.6 dB apart)
  const pts = [];
  for (const [x, y] of [[150, 350], [300, 550], [450, 400], [550, 500], [650, 350], [750, 520], [820, 380], [950, 560], [900, 330], [980, 450]]) {
    const q = n(x, y);
    const today = M.softSignal(ctx, p.net.baseline, q, 5, 0);
    pts.push({ id: `p${x}`, x: q.x, y: q.y, band: 5, value: Math.round(today * 100) / 100, name: 'p', download: null, upload: null, device: 'Telefon', t: 0 });
  }
  const pm = P.sanitize({ ...p, measurements: pts });
  const r = A.predictAtMeasurements(ctx, pm, { curves: { 5: CURVE }, limits: { wanDown: 500, wanUp: 100 } });
  let agree = 0;
  for (const e of r) {
    const ps = S.pointSpeed(ctx, { x: e.x, y: e.y }, a.params.trial, CURVE, limits);
    assert.equal(ps.source, e.source, 'tooltip and what-if use the same source');
    if (ps.known) close(ps.down, e.speed.predDown, Math.max(2, 0.08 * ps.down), `pointSpeed vs what-if at ${e.id}`);
    const cellDown = R.sample(a.grid, sf.down, { x: e.x, y: e.y }, { nearest: true });
    if (e.speed.predDown !== null && Math.abs(cellDown - e.speed.predDown) <= Math.max(3, 0.12 * e.speed.predDown)) agree++;
  }
  assert.ok(agree >= 8, `map vs points agree at ${agree}/10`);
});

test('pointSpeed = the map at a cell centre (tooltip), with the reserve of the limits; reasons instead of throws', () => {
  const p = rowPlan({ node: node('mesh_wifi', 880, 450) });
  const ctx = M.createContext(p);
  const a = A.run(p, { cell: 4, ctx });
  const limits = { reserve: 30 };
  const sf = S.fieldSpeed(ctx, a.grid, a.params.trial, CURVE, limits, a.trial);
  let n2 = 0;
  for (let k = 0; k < a.grid.idx.length; k += 97) {
    const i = a.grid.idx[k];
    const q = { x: a.grid.cx[i], y: a.grid.cy[i] };
    const ps = S.pointSpeed(ctx, q, a.params.trial, CURVE, limits);
    if (!ps.known || !sf.known[i]) continue;
    n2++;
    close(ps.down, sf.down[i], Math.max(3, 0.1 * sf.down[i]));
  }
  assert.ok(n2 > 50);
  assert.equal(S.pointSpeed(ctx, null, a.params.trial, CURVE, limits).reason, 'params');
  assert.equal(S.pointSpeed(ctx, n(500, 450), a.params.trial, null, limits).reason, 'curve');
  assert.equal(S.pointSpeed(ctx, n(500, 450), { ...a.params.trial, band: 9 }, CURVE, limits).reason, 'params');
});

test('homeSummary with a node = speed.stats of fieldSpeed; shares of the binding limits and of the node area', () => {
  const p = rowPlan({ node: node('repeater', 880, 450, { maxMbps: 300 }) });
  const ctx = M.createContext(p);
  const a = A.run(p, { cell: 4, ctx });
  const limits = { wanDown: 1000, wanUp: 1000, reserve: 0 };
  const t = { targetDown: 50, targetUp: 20 };
  const h = S.homeSummary(ctx, a.grid, a.params.trial, CURVE, limits, t, a.trial);
  assert.equal(h.supported, true);
  const sf = S.fieldSpeed(ctx, a.grid, a.params.trial, CURVE, limits, a.trial);
  const st = S.stats(a.grid, sf, { roomIds: null, targetDown: 50, targetUp: 20 });
  close(h.areaMeetingTarget, st.coverage, 1e-9);
  const count = (code) => a.grid.idx.reduce((c, i) => c + (sf.limitedBy[i] === code ? 1 : 0), 0);
  close(h.limitedShare.backhaul, (100 * count(3)) / a.grid.count, 1e-9);
  close(h.nodeShare, (100 * a.grid.idx.reduce((c, i) => c + a.nodeWins[i], 0)) / a.grid.count, 1e-9);
  assert.ok(h.limitedShare.backhaul > 10, `backhaul binds on ${h.limitedShare.backhaul} %`);
  assert.equal(h.link.mode, 'repeater');
  // the repeater does not help the far room's speed beyond its link
  const far = h.perRoom.find((r) => r.roomId === 3);
  assert.ok(far.medianDown <= h.link.down + 1e-6);
});

test('optimizer speed mode with a second node: runs, uses the link, never refuses', async () => {
  const p = rowPlan({ node: node('repeater', 880, 450) });
  const ctx = M.createContext(p);
  const grid = R.grid(ctx, { cell: 8 });
  const nodeP = M.nodeParams(p);
  const opts = (np) => ({ band: 5, router: p.net.router, node: np, offsets: { '2.4': 0, '5': 0, '6': 0 }, speed: { curve: CURVE, targetDown: 60, targetUp: 20, limits: {}, reserve: 0 } });
  const r = await E.optimize.find(ctx, grid, opts(nodeP));
  assert.ok(r.pos && Number.isFinite(r.score));
  // a tiny ceiling on the node makes its area fail the target: the best score drops
  const r10 = await E.optimize.find(ctx, grid, opts({ ...nodeP, maxMbps: 10 }));
  assert.ok(r10.score < r.score, `${r10.score} < ${r.score}`);
  // a wired AP has no uplink cap: at least as good as the repeater
  const rw = await E.optimize.find(ctx, grid, opts({ ...nodeP, mode: 'ap_cable' }));
  assert.ok(rw.score >= r.score - 1e-9);
});

test('band, calibration and the fit: the same for today and new', () => {
  const ms = [meas('a5', 900, 450, -79, 10, 4, 5), meas('a24', 900, 450, -66, 10, 4, 2.4)];
  const p = rowPlan({ measurements: ms, node: node('ap_cable', 870, 420, { bands: { '2.4': false, '5': true, '6': false } }) });
  const ctx = M.createContext(p);
  const r = A.predictAtMeasurements(ctx, p, { offsets: { '2.4': 0, '5': 0, '6': 0 } });
  const e5 = r.find((e) => e.id === 'a5');
  const e24 = r.find((e) => e.id === 'a24');
  assert.equal(e5.source, 'node');
  assert.equal(e24.nodeNew, null, 'the node does not serve 2.4 GHz');
  assert.equal(e24.delta, 0);
  close(e24.modelToday, M.softSignal(ctx, p.net.baseline, { x: e24.x, y: e24.y }, 2.4, 0), 1e-12, 'its own band');
  // only one band
  assert.deepEqual(A.predictAtMeasurements(ctx, p, { band: 2.4 }).map((e) => e.id), ['a24']);
  // an offset moves today and new alike: delta unchanged (away from the clamps)
  const r6 = A.predictAtMeasurements(ctx, p, { offsets: { '2.4': 0, '5': 6, '6': 0 } }).find((e) => e.id === 'a5');
  close(r6.modelToday, e5.modelToday + 6, 1e-9);
  close(r6.delta, e5.delta, 1e-9);
  // the default offsets are the planner's (model.offsets)
  const rd = A.predictAtMeasurements(ctx, p).find((e) => e.id === 'a5');
  close(rd.modelToday, M.softSignal(ctx, p.net.baseline, { x: e5.x, y: e5.y }, 5, M.offsets(ctx, p)['5']), 1e-9);
  // a fitted context: both sides use the fitted physics
  const pf = P.sanitize({ ...p, model: { ...p.model, fit: { n: 3, wallFactor: 1.5, method: 'offset+n+walls', count: 5, at: 1, fitted: { n: true, wallFactor: true }, byBand: { 5: { offset: 2, rms: 1, looRms: 2, count: 5, outliers: [] } } } } });
  const cf = M.createContext(pf);
  const ef = A.predictAtMeasurements(cf, pf, { offsets: { '2.4': 0, '5': 0, '6': 0 } }).find((e) => e.id === 'a5');
  close(ef.modelToday, M.softSignal(cf, pf.net.baseline, { x: e5.x, y: e5.y }, 5, 0), 1e-9);
  assert.ok(ef.modelToday < e5.modelToday - 3, 'steeper decay and stronger walls');
});

test('deterministic, input order kept, never throws on odd data (reasons instead)', () => {
  const p = rowPlan({ measurements: [meas('a', 900, 450, -79, 10, 4), meas('b', 300, 450, null, 300, 90)], node: node('repeater', 880, 450) });
  const ctx = M.createContext(p);
  const a1 = JSON.stringify(A.predictAtMeasurements(ctx, p));
  const a2 = JSON.stringify(A.predictAtMeasurements(M.createContext(p), P.sanitize(JSON.parse(JSON.stringify(p)))));
  assert.equal(a1, a2);
  assert.deepEqual(JSON.parse(a1).map((e) => e.id), ['a', 'b']);
  // odd data straight into the engine (not through sanitize)
  const odd = {
    ...p,
    measurements: [
      null,
      42,
      [1, 2],
      { id: 'noband', x: 0.5, y: 0.5, value: -60 },
      { id: 'nan', x: NaN, y: 0.5, band: 5, value: -60 },
      { id: 'str', x: '0.5', y: 0.5, band: 5, value: -60 },
      { id: 'off', x: n(1050, 450).x, y: n(1050, 450).y, band: 5, value: -60, download: 100, upload: 30 },
      { id: 'nul', x: n(900, 450).x, y: n(900, 450).y, band: 5, value: null, download: null, upload: null },
      { id: 'neg', x: n(900, 450).x, y: n(900, 450).y, band: 5, value: -60, download: -5, upload: 1e9 },
    ],
  };
  const r = A.predictAtMeasurements(ctx, odd);
  assert.equal(r.length, 9);
  assert.deepEqual(r.map((e) => e.reason), ['invalid', 'invalid', 'invalid', 'band', 'position', 'position', null, null, null]);
  const off = r[6];
  assert.equal(off.onFloor, false);
  assert.equal(off.roomId, 0);
  assert.ok(off.inside && P.floorMaskAt(p.plan, off.inside), 'a floor point to move it to');
  assert.ok(Number.isFinite(off.delta), 'still predicted');
  assert.equal(r[7].speed === null || r[7].speed.measuredDown === null, true);
  assert.ok(r[8].speed === null || r[8].speed.measuredDown === null, 'invalid rates are ignored');
  const r8 = A.predictAtMeasurements(ctx, odd, { curves: { 5: CURVE } })[8];
  assert.deepEqual([r8.speed.measuredDown, r8.speed.measuredUp, r8.speed.anchored], [null, null, false]);
  // no curve anywhere: dBm only, unchanged points keep their speed
  const nc = A.predictAtMeasurements(ctx, p, { curves: { 5: null } });
  assert.equal(nc[0].speed.reason, 'curve');
  assert.equal(nc[0].speed.predDown, null);
  // a broken curve, odd projects
  assert.doesNotThrow(() => A.predictAtMeasurements(ctx, p, { curves: { 5: { download: 'x' } } }));
  assert.deepEqual(A.predictAtMeasurements(ctx, { ...p, measurements: 'x' }), []);
  assert.deepEqual(A.predictAtMeasurements(ctx, null), []);
  assert.deepEqual(A.predictAtMeasurements(null, p), []);
  assert.deepEqual(A.predictAtMeasurements({}, p), [], 'not a model context');
  // a broken router / baseline marker: every entry says 'position', no NaN anywhere
  for (const net of [{ ...p.net, router: { x: NaN, y: 0.5 } }, { ...p.net, baseline: { x: 0.5, y: 'a' } }, { ...p.net, baseline: null }]) {
    const rr = A.predictAtMeasurements(ctx, { ...p, net });
    assert.deepEqual(rr.map((e) => [e.reason, e.delta, e.predicted]), [['position', null, null], ['position', null, null]]);
  }
  // a broken node (NaN position / power) is no node; an infinite power is ignored, never NaN
  for (const nd of [{ mode: 'ap_cable', pos: { x: NaN, y: 0.4 }, power: 'x' }, { ...node('repeater', 880, 450), power: Infinity }]) {
    const rr = A.predictAtMeasurements(ctx, { ...p, node: nd });
    assert.ok(rr.every((e) => e.reason === null && Number.isFinite(e.delta) && Number.isFinite(e.predicted)), JSON.stringify(nd));
  }
  // a half-built project (no view / goal / rooms array) still gives entries, no exception
  const bare = { net: p.net, plan: { walls: [] }, measurements: [meas('b1', 900, 450, -70)] };
  const rb = A.predictAtMeasurements(ctx, bare);
  assert.equal(rb.length, 1);
  assert.equal(rb[0].reason, null);
  assert.equal(rb[0].onFloor, false);
  assert.equal(rb[0].inside, null, 'no rooms: nothing to move it into');
  assert.doesNotThrow(() => A.summarizePredictions(null));
  assert.equal(A.summarizePredictions([null, { reason: 'band' }]).count, 0);
  assert.equal(A.whatIfActive(null), false);
  // fieldSpeed / homeSummary / curve helpers with odd measurement lists
  assert.doesNotThrow(() => S.buildCurve([null, 3, { band: 5 }], { band: 5 }));
  assert.doesNotThrow(() => S.fillSignals(ctx, [null, 'x', { band: 5, value: null }], { baseline: p.net.baseline }));
  assert.doesNotThrow(() => M.calibrate(ctx, [null, { band: 5, value: -60, x: NaN, y: 1 }], 5, { baseline: p.net.baseline }));
  assert.equal(S.rate({ download: [], upload: [] }, -50), null);
  assert.equal(S.rate(CURVE, NaN), null);
});

test('summarizePredictions: counts, mean, best / worst, rooms, speed counts', () => {
  const e = (id, roomId, delta, speed = null, extra = {}) => ({ id, roomId, delta, changed: delta !== 0, speed, reason: null, ...extra });
  const list = [
    e('a', 1, 14, { measuredDown: 100, predDown: 300, limitedBy: 'backhaul' }),
    e('b', 1, 6),
    e('c', 2, 0.4),
    e('d', 3, -3, { measuredDown: 200, predDown: 150, limitedBy: null }),
    e('x', 2, 50, null, { reason: 'position' }),
  ];
  const s = A.summarizePredictions(list);
  assert.equal(s.count, 4);
  assert.deepEqual([s.improved, s.worsened, s.unchanged], [2, 1, 1]);
  close(s.meanDelta, (14 + 6 + 0.4 - 3) / 4, 1e-12);
  assert.equal(s.best.id, 'a');
  assert.equal(s.worst.id, 'd');
  assert.deepEqual(s.rooms.map((r) => r.roomId), [1, 2, 3]);
  close(s.rooms[0].meanDelta, 10, 1e-12);
  assert.deepEqual(s.speed, { count: 2, improved: 1, worsened: 1, limited: { plan: 0, link: 0, backhaul: 1, device: 0 } });
  assert.equal(A.summarizePredictions(list, { minDb: 10 }).improved, 1);
});

test('node.maxMbps: null by default, 10-10000, sanitized, serialized, round trips (SVG too), in nodeParams', () => {
  const d = P.create({ template: 'demo', lang: 'cs' });
  assert.equal(d.node.maxMbps, null);
  assert.equal(P.defaults().node.maxMbps, null);
  const cases = [[300, 300], [5, 10], [99999, 10000], [299.6, 300], ['300', null], [NaN, null], [null, null], [undefined, null], [-1, null], [0, null], [Infinity, null]];
  for (const [inp, want] of cases) {
    const raw = JSON.parse(JSON.stringify(d));
    raw.node.maxMbps = inp;
    if (inp === undefined) delete raw.node.maxMbps;
    assert.equal(P.sanitize(raw).node.maxMbps, want, `maxMbps ${inp}`);
  }
  const p = P.sanitize({ ...d, node: { ...d.node, mode: 'repeater', maxMbps: 300 } });
  assert.equal(P.sanitize(P.serialize(p)).node.maxMbps, 300);
  assert.deepEqual(P.sanitize(P.serialize(p)), P.sanitize(p));
  assert.deepEqual(P.parseSvgText(P.buildSvg(p)).project.node, p.node);
  assert.equal(M.nodeParams(p).maxMbps, 300);
  assert.equal(M.nodeParams({ ...p, node: { ...p.node, maxMbps: null } }).maxMbps, null);
  // older files (no key) load with null
  const old = JSON.parse(P.serialize(d));
  delete old.project.node.maxMbps;
  assert.equal(P.sanitize(old).node.maxMbps, null);
});

test('whatIfActive: router moved (> 1 px) or a node on', () => {
  const p = rowPlan();
  assert.equal(A.whatIfActive(p), false);
  assert.equal(A.whatIfActive(P.sanitize({ ...p, net: { ...p.net, router: n(180.5, 450) } })), false);
  assert.equal(A.whatIfActive(P.sanitize({ ...p, net: { ...p.net, router: n(190, 450) } })), true);
  assert.equal(A.whatIfActive(P.sanitize({ ...p, node: node('ap_cable', 880, 450) })), true);
});

test('the what-if is fast (demo, 30 measurements, repeater, curves built: < 120 ms)', () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const ms = [];
  for (let k = 0; ms.length < 30; k++) {
    const q = { x: 0.1 + ((k * 0.137) % 0.8), y: 0.1 + ((k * 0.291) % 0.8) };
    if (!P.floorMaskAt(p.plan, q)) continue;
    ms.push({ id: `m${k}`, x: q.x, y: q.y, band: 5, value: k % 3 ? -50 - (k % 30) : null, name: 'x', download: 20 + 10 * (k % 30), upload: 10 + 3 * (k % 30), device: 'Telefon', t: k });
  }
  const pr = P.sanitize({ ...p, measurements: ms, node: { ...p.node, mode: 'repeater', maxMbps: 300 } });
  const ctx = M.createContext(pr);
  const offs = M.offsets(ctx, pr);
  A.predictAtMeasurements(ctx, pr, { offsets: offs });
  const t0 = performance.now();
  const r = A.predictAtMeasurements(ctx, pr, { offsets: offs });
  const dt = performance.now() - t0;
  assert.equal(r.length, 30);
  assert.ok(dt < 120, `${dt.toFixed(1)} ms`);
});
