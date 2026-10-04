// SPEC 13 (stage 7b): band steering / Wi-Fi 7 MLO - net.routerBands, model.steer, the band mode 'auto' in every field /
// statistics / optimizer / contour / what-if / speed path, measurements without a known band (band null, inferred with
// the steering rule, lower calibration weight) and the measurement's Wi-Fi 7 multi-link `wifi.links`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, makeProject } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const M = E.model;
const P = E.project;
const R = E.raster;
const S = E.speed;
const A = E.analysis;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (eps ${eps})`);
const ZERO = { '2.4': 0, '5': 0, '6': 0 };

// A row of three 3 x 3 m rooms (1 px = 1 cm), 10 dB walls between them, router in the left room: 5 GHz is strong in
// the left room, weak behind two walls - so a steering client uses 5 GHz near the router and 2.4 GHz far away.
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
    ...extra,
  });
}
const demo = () => P.create({ template: 'demo', lang: 'cs' });
let mid = 0;
const meas = (px, py, band, value, down = null, up = null, extra = {}) => ({ id: `s${++mid}`, x: n(px, py).x, y: n(px, py).y, band, value, name: 'm', download: down, upload: up, device: 'Telefon', t: 1, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------------------------------------------

test('steerBand: 6 GHz from -70, else 5 GHz from -72, else 2.4 GHz - only bands the router sends', () => {
  const all = [2.4, 5, 6];
  const st = { six: -70, five: -72 };
  const at = (s24, s5, s6, bands = all, steer = st) => M.steerBand({ '2.4': s24, 5: s5, 6: s6 }, bands, steer);
  assert.equal(at(-40, -60, -70), 6, '6 GHz exactly at its threshold');
  assert.equal(at(-40, -60, -70.01), 5);
  assert.equal(at(-40, -72, -80), 5, '5 GHz exactly at its threshold');
  assert.equal(at(-40, -72.01, -80), 2.4);
  assert.equal(at(-95, -80, -90), 2.4, 'a weak 2.4 GHz is still the fallback (the rule, not the strongest)');
  assert.equal(at(-40, -60, -50, [2.4, 5]), 5, 'no 6 GHz on this router');
  assert.equal(at(-40, -80, -50, { '2.4': true, 5: false, 6: true }), 6, 'a routerBands map works too');
  // a router without 2.4 GHz: the strongest band it sends
  assert.equal(at(-40, -80, -85, [5, 6]), 5);
  assert.equal(at(-40, -88, -75, [5, 6]), 6);
  assert.equal(at(-40, -80, -80, [5, 6]), 5, 'tie -> the lower band');
  // missing / NaN signals = the band is not there
  assert.equal(M.steerBand({ 5: -60 }, all, st), 5);
  assert.equal(M.steerBand({ 5: NaN, '2.4': -70 }, all, st), 2.4);
  assert.equal(M.steerBand({}, all, st), null);
  assert.equal(M.steerBand(null, all, st), null);
  // custom thresholds
  assert.equal(at(-40, -60, -66, all, { six: -65, five: -72 }), 5);
  assert.equal(at(-40, -60, -66, all, { six: -67, five: -72 }), 6);
  assert.equal(at(-40, -75, -90, all, { six: -70, five: -76 }), 5);
  // garbage thresholds -> defaults; garbage band lists -> the default router (2.4 + 5)
  assert.equal(at(-40, -71, -69, all, { six: 'x', five: null }), 6);
  assert.deepEqual(M.steerOf(null), { six: -70, five: -72 });
  assert.deepEqual(M.steerOf({ six: -10, five: -200 }), { six: -50, five: -90 }, 'clamped to -90..-50');
  assert.deepEqual(M.steerOf(demo()), { six: -70, five: -72 });
  assert.deepEqual(M.routerBandList(null), [2.4, 5]);
  assert.deepEqual(M.routerBandList([6, '5', 7, 6]), [5, 6]);
  assert.deepEqual(M.routerBandList({ '2.4': false, 5: false, 6: false }), [2.4, 5]);
  assert.deepEqual(M.routerBandList(demo()), [2.4, 5]);
  assert.deepEqual(M.STEER, { six: -70, five: -72 });
  assert.equal(E.units.normBandMode(' Auto '), 'auto');
  assert.equal(E.units.normBandMode('2,4'), 2.4);
  assert.equal(E.units.normBandMode('automatic'), null);
  assert.equal(M.isAuto('auto') && M.isAuto({ band: 'AUTO' }) && !M.isAuto(5) && !M.isAuto({ band: 5 }), true);
});

// ---------------------------------------------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------------------------------------------

test('data: routerBands, steer, view.band auto, band null and wifi.links are sanitized, serialized and round-trip', () => {
  const p = demo();
  assert.equal(p.view.band, 'auto');
  p.net.routerBands = { '2.4': true, 5: true, 6: true };
  p.model.steer = { six: -66, five: -74.5 };
  p.measurements = [
    { id: 'a', x: 0.5, y: 0.6, band: null, value: -60, name: 'Nevím', download: 100, upload: 30, device: 'Telefon', t: 1 },
    { id: 'b', x: 0.5, y: 0.6, band: 'auto', value: -61, name: 'auto', download: null, upload: null, device: 'Telefon', t: 2 },
    { id: 'c', x: 0.5, y: 0.6, value: -62, name: 'no band', download: null, upload: null, device: 'Telefon', t: 3 },
    { id: 'd', x: 0.5, y: 0.6, band: 'x', value: -63, name: 'bad band', download: null, upload: null, device: 'Telefon', t: 4 },
    {
      id: 'e', x: 0.45, y: 0.6, band: 5, value: -70, name: 'MLO', download: null, upload: null, device: 'PC', t: 5,
      wifi: {
        ssid: 'Doma', bssid: null, channel: 100, band: 5, rxRate: 103.2, txRate: 216.2, radio: '802.11be', security: null,
        links: [{ band: 5, channel: 100, rssiDbm: -70, widthMHz: 80 }, { band: '6', channel: 37, rssiDbm: -58, widthMHz: 160 }, { band: 2.4 }, null, { band: 9, channel: 0 }, { rssiDbm: -300, widthMHz: 30 }, { channel: 1 }, { channel: 6 }],
      },
    },
  ];
  const s = P.sanitize(p);
  assertValidProject(s, 'steer data');
  assert.deepEqual(s.net.routerBands, { '2.4': true, 5: true, 6: true });
  assert.deepEqual(s.model.steer, { six: -66, five: -74.5 });
  assert.deepEqual(s.measurements.map((m) => [m.id, m.band]), [['a', null], ['b', null], ['e', 5]], 'null / auto kept as null, a missing or invalid band still drops the point');
  assert.deepEqual(s.measurements[2].wifi.links, [
    { band: 6, channel: 37, rssiDbm: -58, widthMHz: 160 },
    { band: 5, channel: 100, rssiDbm: -70, widthMHz: 80 },
    { band: null, channel: null, rssiDbm: -110, widthMHz: null },
    { band: 2.4, channel: null, rssiDbm: null, widthMHz: null },
  ], 'strongest first, validated, at most 4');
  // files and localStorage
  assert.deepEqual(P.sanitize(JSON.parse(P.serialize(s))), s);
  const svg = P.parseSvgText(P.buildSvg(s));
  assert.deepEqual(svg.project, s);
  assert.deepEqual(P.sanitize(s), s, 'idempotent');
  // a view band of the file is kept; without one: Auto for two or more router bands, else that band
  const one = P.sanitize({ ...s, net: { ...s.net, routerBands: { '2.4': false, 5: true, 6: false } }, view: { ...s.view, band: undefined } });
  assert.equal(one.view.band, 5);
  const two = P.sanitize({ ...s, view: { ...s.view, band: undefined } });
  assert.equal(two.view.band, 'auto');
  assert.equal(P.sanitize({ ...s, view: { ...s.view, band: 2.4 } }).view.band, 2.4);
  // older files (no routerBands / steer) get the defaults; their records keep their exact shape
  const old = JSON.parse(P.serialize(s));
  delete old.project.net.routerBands;
  delete old.project.model.steer;
  delete old.project.measurements[2].wifi.links;
  const o = P.sanitize(old);
  assert.deepEqual(o.net.routerBands, { '2.4': true, 5: true, 6: false });
  assert.deepEqual(o.model.steer, { six: -70, five: -72 });
  assert.equal('links' in o.measurements[2].wifi, false);
  // cleanLinks on its own
  assert.equal(P.cleanLinks([]), null);
  assert.equal(P.cleanLinks('x'), null);
  assert.equal(P.cleanLinks([{ widthMHz: 80 }]), null, 'a width alone is not a link');
});

// ---------------------------------------------------------------------------------------------------------------
// point model + raster
// ---------------------------------------------------------------------------------------------------------------

test('fieldParams / steeredSignal / pointSignalDetail in the band mode Auto', () => {
  const p = rowPlan({ view: { band: 'auto' } });
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial');
  assert.equal(st.band, 'auto');
  assert.deepEqual(st.bands, [2.4, 5]);
  assert.deepEqual(st.steer, { six: -70, five: -72 });
  assert.equal('bands' in M.fieldParams(p, 'trial', { band: 5 }), false, 'a single band has no steering fields');
  for (const [px, want] of [
    [300, 5],
    [900, 2.4],
  ]) {
    const q = n(px, 450);
    const s = M.steeredSignal(ctx, q, st);
    assert.equal(s.band, want, `x ${px}`);
    assert.equal(s.byBand['6'], null, 'the router does not send 6 GHz');
    close(s.byBand['5'], M.combinedSignal(ctx, q, 5, st), 1e-12);
    close(s.byBand['2.4'], M.combinedSignal(ctx, q, 2.4, st), 1e-12);
    close(s.signal, s.byBand[String(want)], 0);
    close(M.combinedSignal(ctx, q, 'auto', st), s.signal, 0);
    const d = M.pointSignalDetail(ctx, q, st);
    assert.equal(d.band, want);
    assert.equal(d.steered, true);
    close(d.combined, s.signal, 1e-12);
    assert.equal(d.baselineBand, want, 'nothing moved: today = trial');
    close(d.baseline, d.combined, 1e-12);
  }
  // the router-only point functions take 'auto' too (the context's router bands and thresholds, ctx.p.routerBands /
  // ctx.p.steer): = the steered signal of the router alone; an offsets map applies per band
  const today = M.fieldParams(p, 'today', { offsets: { '2.4': -3, 5: 2, 6: 0 } });
  assert.deepEqual(ctx.p.routerBands, [2.4, 5]);
  for (const px of [300, 600, 900]) {
    const q = n(px, 450);
    close(M.softSignal(ctx, p.net.baseline, q, 'auto', today.offsets), M.steeredSignal(ctx, q, today).signal, 1e-12, `soft ${px}`);
    const ex = M.steeredSignal(ctx, q, { ...today, soften: 0 });
    close(M.signal(ctx, p.net.baseline, q, 'auto', today.offsets), ex.signal, 1e-12, `exact ${px}`);
  }
  // a single-band state reports its band, a single-band router in Auto is that band
  assert.equal(M.pointSignalDetail(ctx, n(300, 450), M.fieldParams(p, 'trial', { band: 2.4 })).band, 2.4);
  const p5 = P.sanitize({ ...p, net: { ...p.net, routerBands: { '2.4': false, 5: true, 6: false } } });
  assert.equal(M.steeredSignal(ctx, n(900, 450), M.fieldParams(p5, 'trial')).band, 5);
  // moving the router into the right room: a steering client there switches from 2.4 to 5 GHz
  const moved = P.sanitize({ ...p, net: { ...p.net, router: n(850, 450) } });
  const dm = M.pointSignalDetail(ctx, n(900, 450), M.fieldParams(moved, 'trial'));
  assert.equal(dm.band, 5);
  assert.equal(dm.baselineBand, 2.4);
});

test('raster: the Auto field is, cell by cell, the field of the band the rule picks; bands, shares, zones, edges, contours', () => {
  const p = demo();
  p.net.routerBands = { '2.4': true, 5: true, 6: true };
  p.node = { ...p.node, mode: 'ap_cable', bands: { '2.4': true, 5: true, 6: false } };
  const q = P.sanitize(p);
  const ctx = M.createContext(q);
  const g = R.grid(ctx, { cell: 8 });
  const offs = { '2.4': -2, 5: 1, 6: 3 };
  const st = M.fieldParams(q, 'trial', { offsets: offs });
  assert.deepEqual(st.bands, [2.4, 5, 6]);
  const fx = R.fieldEx(ctx, g, st);
  const per = [2.4, 5, 6].map((b) => R.fieldEx(ctx, g, { ...M.fieldParams(q, 'trial', { band: b, offsets: offs }) }));
  const counts = [0, 0, 0];
  for (const i of g.idx) {
    const v = per.map((r) => r.field[i]);
    const k = v[2] >= -70 ? 2 : v[1] >= -72 ? 1 : 0;
    assert.equal(fx.bands[i], k, `cell ${i}`);
    assert.equal(fx.field[i], v[k]);
    assert.equal(fx.nodeWins[i], per[k].nodeWins ? per[k].nodeWins[i] : 0);
    counts[k]++;
  }
  assert.ok(counts.every((c) => c > 0), `every band used somewhere: ${counts}`);
  assert.equal(R.bandsOf(fx.field, st), fx.bands);
  assert.equal(R.bandsOf(fx.field, { ...st, steer: { six: -60, five: -72 } }), undefined, 'other thresholds: not this field');
  assert.equal(R.nodeWinsOf(fx.field, st), fx.nodeWins);
  assert.equal(R.field(ctx, g, st).length, g.cols * g.rows);
  // shares
  const sh = R.bandShare(g, fx.bands);
  close(sh['2.4'] + sh['5'] + sh['6'], 100, 1e-9);
  close(sh['6'], (100 * counts[2]) / g.idx.length, 1e-9);
  const room1 = R.bandShare(g, fx.bands, [1]);
  close(room1['2.4'] + room1['5'] + room1['6'], 100, 1e-9);
  assert.deepEqual(R.bandShare(g, null), { '2.4': 0, 5: 0, 6: 0 });
  // stricter thresholds push clients down to 2.4 GHz
  const strict = R.fieldEx(ctx, g, { ...st, steer: { six: -55, five: -60 } });
  assert.ok(R.bandShare(g, strict.bands)['2.4'] > sh['2.4']);
  // zones: the caller's colours, alpha, bleed into the rim; edges between the zones
  const z = R.bandZones(g, fx.bands, { '2.4': '#ff0000', 5: [0, 255, 0], 6: '#00f' }, { alpha: 0.5, bleed: false });
  const i6 = g.idx.find((i) => fx.bands[i] === 2);
  const i24 = g.idx.find((i) => fx.bands[i] === 0);
  assert.deepEqual(Array.from(z.data.slice(i6 * 4, i6 * 4 + 4)), [0, 0, 255, 128]);
  assert.deepEqual(Array.from(z.data.slice(i24 * 4, i24 * 4 + 4)), [255, 0, 0, 128]);
  assert.equal(z.data[g.rim[0] * 4 + 3], 0, 'no bleed asked');
  const zb = R.bandZones(g, fx.bands, { 5: '#0f0' });
  assert.equal(zb.data[i24 * 4 + 3], 0, 'a band without a colour stays transparent');
  assert.equal(R.bandZones(g, null, {}).data.some((v) => v), false);
  const edges = R.bandEdges(g, fx.bands);
  assert.ok(edges.length >= 2 && edges.every((ch) => ch.length >= 2 && ch.every((pt) => pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1)));
  assert.deepEqual(R.bandEdges(g, new Uint8Array(g.cols * g.rows).fill(1)), [], 'one zone: no edge');
  // range lines of the steered field: by default exactly those of the field handed in
  const cAuto = R.contours(ctx, { ...st, threshold: -67 });
  const g9 = R.grid(ctx, { cell: 9 });
  assert.deepEqual(cAuto, R.contours(ctx, { band: 5, router: st.router, threshold: -67, grid: g9, field: R.field(ctx, g9, { ...st, aa: 1, soften: M.SOFTEN }) }));
  assert.ok(R.contours(ctx, { ...st, threshold: -67, soften: 0, res: [60, 52] }).length > 0, 'the exact lattice works in Auto too');
  assert.throws(() => R.contours(ctx, { band: 'x', router: st.router, threshold: -67 }), RangeError);
});

test('raster: a one-band router in Auto is exactly that band; Auto never mutates its params; the scratch survives other sizes', () => {
  const p = rowPlan({ view: { band: 'auto' }, node: { mode: 'repeater', pos: n(560, 450), bands: { '2.4': true, 5: true, 6: false }, power: 0, backhaulBand: 5, backhaulThreshold: -67 } });
  const ctx = M.createContext(p);
  const g = R.grid(ctx, { cell: 4 });
  const only5 = P.sanitize({ ...p, net: { ...p.net, routerBands: { '2.4': false, 5: true, 6: false } } });
  const st = M.fieldParams(only5, 'trial');
  const frozen = JSON.stringify(st);
  const a = R.fieldEx(ctx, g, { ...st, aa: 2 });
  assert.equal(JSON.stringify(st), frozen);
  const b = R.fieldEx(ctx, g, { ...M.fieldParams(only5, 'trial', { band: 5 }), aa: 2 });
  assert.deepEqual(Array.from(a.field), Array.from(b.field));
  assert.deepEqual(Array.from(a.nodeWins), Array.from(b.nodeWins));
  assert.ok(g.idx.every((i) => a.bands[i] === 1));
  // interleaving grid sizes and a reused output buffer give the same numbers
  const stAuto = M.fieldParams(p, 'trial');
  const ref = R.field(ctx, g, stAuto);
  R.field(ctx, R.grid(ctx, { cell: 8 }), stAuto);
  const buf = new Float32Array(g.cols * g.rows).fill(7);
  assert.equal(R.field(ctx, g, stAuto, buf), buf);
  assert.deepEqual(Array.from(buf), Array.from(ref));
});

// ---------------------------------------------------------------------------------------------------------------
// statistics, analysis, optimizer
// ---------------------------------------------------------------------------------------------------------------

test('analysis.run in Auto: steered fields, bands and shares; the cache knows the thresholds', () => {
  const p = demo();
  const cache = {};
  const a = A.run(p, { cell: 8, cache });
  assert.equal(a.band, 'auto');
  assert.ok(a.bands.today && a.bands.trial);
  assert.deepEqual(Array.from(a.bands.trial), Array.from(a.bands.today), 'nothing moved');
  assert.notEqual(a.bands.trial, a.bands.today, 'independent copies');
  close(a.bandShare.today['2.4'] + a.bandShare.today['5'], 100, 1e-9);
  assert.ok(a.bandShare.today['2.4'] > 5 && a.bandShare.today['5'] > 30, JSON.stringify(a.bandShare.today));
  // the trial copy is known to the raster: speed.fieldSpeed(…, a.trial) needs nothing extra
  assert.equal(R.bandsOf(a.trial, a.params.trial), a.bands.trial);
  // Auto lies between the bands: every place good on 5 GHz is good in Auto (it stays on 5 GHz there), but a client
  // keeps a -71 dBm 5 GHz link where 2.4 GHz would read -60 dBm - steering prefers the faster band, not the louder one
  const one5 = A.run(p, { cell: 8, band: 5 });
  const one24 = A.run(p, { cell: 8, band: 2.4 });
  for (const one of [one5, one24]) {
    assert.equal(one.bands.today, null);
    assert.equal(one.bandShare, null);
  }
  assert.ok(a.stats.today.coverage >= one5.stats.today.coverage - 1e-9, `5 GHz ${one5.stats.today.coverage} vs auto ${a.stats.today.coverage}`);
  assert.ok(a.stats.today.coverage <= one24.stats.today.coverage + 1e-9, `2.4 GHz ${one24.stats.today.coverage} vs auto ${a.stats.today.coverage}`);
  // the router moves: today from the cache, new bands for the trial
  p.net.router = P.nearestFloor(p.plan, { x: 0.55, y: 0.45 });
  const b = A.run(p, { cell: 8, cache });
  assert.equal(b.today, a.today);
  assert.ok(b.bandShare.trial['5'] > a.bandShare.trial['5']);
  // other thresholds or router bands invalidate today
  p.model.steer = { six: -70, five: -60 };
  const c = A.run(p, { cell: 8, cache });
  assert.notEqual(c.today, a.today);
  assert.ok(c.bandShare.today['2.4'] > a.bandShare.today['2.4']);
  p.net.routerBands = { '2.4': true, 5: true, 6: true };
  assert.notEqual(A.run(p, { cell: 8, cache }).today, c.today);
});

test('optimize.find in Auto: steered samples, before / after = the Auto analysis, deterministic', async () => {
  const p = demo();
  const a = A.run(p, { cell: 4 });
  const opts = { band: 'auto', bands: a.params.trial.bands, steer: a.params.trial.steer, goalRoom: null, allowedRoom: null, threshold: p.model.threshold, excluded: p.goal.excluded, router: p.net.router, offsets: a.offsets };
  const r = await E.optimize.find(a.ctx, a.grid, opts);
  close(r.before.coverage, a.stats.trial.coverage, 1e-9, 'before = the Auto map');
  assert.ok(r.after.coverage >= r.before.coverage);
  const at = A.run({ ...p, net: { ...p.net, router: r.pos } }, { cell: 4 });
  close(r.after.coverage, at.stats.trial.coverage, 1e-9, 'after = the Auto map at the answer');
  const r2 = await E.optimize.find(a.ctx, a.grid, opts);
  assert.deepEqual(r2.pos, r.pos);
  // speed mode with a curves map (5 GHz curve only: 2.4 GHz places use it as the nearest band)
  const mk = (v, d, u) => ({ id: `c${v}`, x: 0.5, y: 0.5, band: 5, value: v, name: 'c', download: d, upload: u, device: 'Telefon', t: 0 });
  const curves = S.buildCurves([mk(-40, 600, 200), mk(-55, 300, 100), mk(-70, 60, 20), mk(-85, 3, 1)], { device: 'Telefon' });
  assert.equal(curves['2.4'], null);
  const rs = await E.optimize.find(a.ctx, a.grid, { ...opts, speed: { curve: curves, targetDown: 50, targetUp: 20, limits: {} } });
  assert.ok(rs.pos && rs.after);
  await assert.rejects(E.optimize.find(a.ctx, a.grid, { ...opts, speed: { curve: { 5: null }, targetDown: 50, targetUp: 20, limits: {} } }), /err\.opt\.noCurve/);
});

// ---------------------------------------------------------------------------------------------------------------
// speed
// ---------------------------------------------------------------------------------------------------------------

test('speed: per-band curves, the nearest band stands in (approx), map = rule = tooltip in Auto', () => {
  const mk = (band, v, d, u) => ({ id: `c${band}${v}`, x: 0.5, y: 0.5, band, value: v, name: 'c', download: d, upload: u, device: 'Telefon', t: 0 });
  const list = [mk(5, -40, 600, 200), mk(5, -55, 300, 100), mk(5, -70, 60, 20), mk(5, -85, 3, 1), mk(2.4, -40, 150, 60), mk(2.4, -60, 90, 30), mk(2.4, -80, 10, 4)];
  const curves = S.buildCurves(list, { device: 'Telefon' });
  assert.ok(curves['5'] && curves['2.4'] && curves['6'] === null);
  assert.deepEqual(S.CURVE_ORDER['6'], [6, 5, 2.4]);
  assert.deepEqual(S.CURVE_ORDER['5'], [5, 6, 2.4]);
  assert.deepEqual(S.CURVE_ORDER['2.4'], [2.4, 5, 6]);
  assert.deepEqual(S.curveFor(curves, 6), { curve: curves['5'], band: 5, approx: true });
  assert.deepEqual(S.curveFor(curves, 2.4), { curve: curves['2.4'], band: 2.4, approx: false });
  assert.deepEqual(S.curveFor({ 6: curves['5'] }, 2.4), { curve: curves['5'], band: 6, approx: true }, 'the order, not the curve band');
  assert.deepEqual(S.curveFor(curves['5'], 2.4), { curve: curves['5'], band: 5, approx: true }, 'one curve serves every band');
  assert.equal(S.curveFor({}, 5), null);
  assert.equal(S.curveFor(curves, 'x'), null);
  assert.equal(S.curveFor(null, 5), null);

  const p = rowPlan({ view: { band: 'auto' }, model: { steer: { six: -70, five: -72 } } });
  const ctx = M.createContext(p);
  const g = R.grid(ctx, { cell: 8 });
  const st = M.fieldParams(p, 'trial');
  const lim = { wanDown: 500, wanUp: 100, reserve: 10 };
  const fx = R.fieldEx(ctx, g, st);
  const sf = S.fieldSpeed(ctx, g, st, curves, lim, fx.field);
  assert.equal(sf.supported, true);
  assert.equal(sf.bands, fx.bands);
  assert.equal(sf.approx, null, 'both bands used have their own curve');
  let n24 = 0;
  for (const i of g.idx) {
    const band = fx.bands[i] === 0 ? 2.4 : 5;
    if (band === 2.4) n24++;
    const v = S.predictVia(curves[String(band)], fx.field[i], lim);
    if (!v) assert.equal(sf.known[i], 0);
    else {
      close(sf.down[i], v.down, 1e-3);
      close(sf.up[i], v.up, 1e-3);
    }
  }
  assert.ok(n24 > 0);
  // without the 2.4 GHz curve its places borrow the 5 GHz one (flagged), nothing else changes
  const only5 = { 5: curves['5'] };
  const sf5 = S.fieldSpeed(ctx, g, st, only5, lim);
  assert.equal(sf5.approxAny, true);
  for (const i of g.idx) assert.equal(sf5.approx[i] === 1, fx.bands[i] === 0 && sf5.known[i] === 1);
  // one curve for a single band: the old behaviour, no approx flag
  const st5 = M.fieldParams(p, 'trial', { band: 5 });
  const one = S.fieldSpeed(ctx, g, st5, curves['5'], lim);
  assert.equal(one.bands, null);
  assert.equal(one.approx, null);
  assert.deepEqual(Array.from(one.down), Array.from(S.fieldSpeed(ctx, g, st5, curves, lim).down), 'a map = its band\'s curve');
  // no curve for any band -> unsupported, never throws
  assert.equal(S.fieldSpeed(ctx, g, st, { '2.4': null }, lim).reason, 'curve');
  assert.equal(S.fieldSpeed(ctx, g, { ...st, band: 'nope' }, curves, lim).reason, 'params');
  // the tooltip = the map at a cell centre
  for (const px of [300, 900]) {
    const q = n(px, 450);
    const t = S.pointSpeed(ctx, q, st, curves, lim);
    assert.equal(t.band, px === 300 ? 5 : 2.4);
    assert.equal(t.curveBand, t.band);
    assert.equal(t.approx, false);
    const u = S.pointSpeed(ctx, q, st, only5, lim);
    assert.equal(u.approx, t.band === 2.4);
    assert.equal(u.curveBand, 5);
  }
  // the summary: band shares and the approximated share
  const h = S.homeSummary(ctx, g, st, only5, lim, { targetDown: 50, targetUp: 10 }, fx.field);
  assert.equal(h.supported, true);
  close(h.bandShare['2.4'] + h.bandShare['5'], 100, 1e-9);
  assert.ok(h.approxShare > 0 && h.approxShare <= h.bandShare['2.4'] + 1e-9);
  const h5 = S.homeSummary(ctx, g, st5, curves['5'], lim, { targetDown: 50, targetUp: 10 });
  assert.equal(h5.bandShare, null);
  assert.equal(h5.approxShare, 0);
});

test('speed: the node in Auto - its link uses the backhaul band\'s curve from a curves map', () => {
  const mk = (band, v, d, u) => ({ id: `c${band}${v}`, x: 0.5, y: 0.5, band, value: v, name: 'c', download: d, upload: u, device: 'Telefon', t: 0 });
  const curves = S.buildCurves([mk(5, -40, 600, 200), mk(5, -70, 60, 20), mk(2.4, -40, 150, 60), mk(2.4, -80, 10, 4)], { device: 'Telefon' });
  const p = rowPlan({ view: { band: 'auto' }, node: { mode: 'repeater', pos: n(560, 450), bands: { '2.4': true, 5: true, 6: false }, power: 0, backhaulBand: 2.4, backhaulThreshold: -80 } });
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial');
  const link = S.nodeLink(ctx, st, curves);
  assert.equal(link.band, 2.4);
  assert.equal(link.approx, false, 'its own band has a curve');
  close(link.down, S.rate(curves['2.4'], link.signal).down * 0.5, 1e-9);
  const g = R.grid(ctx, { cell: 8 });
  const sf = S.fieldSpeed(ctx, g, st, curves, {});
  assert.deepEqual(sf.link, link);
  assert.ok(sf.source && g.idx.some((i) => sf.source[i] === 1), 'the node serves some cells');
});

// ---------------------------------------------------------------------------------------------------------------
// measurements without a known band
// ---------------------------------------------------------------------------------------------------------------

test('inferBand / resolveBands: the steering rule on today\'s signals; known bands untouched', () => {
  const p = rowPlan({ measurements: [meas(300, 450, null, -50), meas(900, 450, null, -80), meas(600, 450, 5, -66), meas(850, 450, null, null, 50, 10)] });
  const ctx = M.createContext(p);
  const near = M.inferBand(ctx, p, n(300, 450));
  assert.equal(near.band, 5);
  assert.equal(near.signals['6'], null);
  assert.equal(M.inferBand(ctx, p, n(900, 450)).band, 2.4);
  // the rule itself on the returned signals
  for (const px of [150, 380, 500, 650, 800, 950]) {
    const r = M.inferBand(ctx, p, n(px, 450));
    assert.equal(r.band, M.steerBand(r.signals, [2.4, 5], M.STEER), `x ${px}`);
  }
  const list = M.resolveBands(ctx, p);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((m) => [m.band, m.bandInferred === true]), [[5, true], [2.4, true], [5, false], [2.4, true]]);
  assert.equal(list[2], p.measurements[2], 'known-band points are the same objects');
  assert.equal(p.measurements[0].band, null, 'never mutates');
  // offsets shift the guess (a much stronger 5 GHz puts the far point on 5 GHz)
  assert.equal(M.resolveBands(ctx, p, { offsets: { '2.4': 0, 5: 25, 6: 0 } })[1].band, 5);
  // odd input never throws
  assert.deepEqual(M.inferBand(ctx, p, null), { band: null, signals: { '2.4': null, 5: null, 6: null } });
  assert.deepEqual(M.inferBand(null, p, n(1, 1)).band, null);
  assert.deepEqual(M.resolveBands(ctx, { measurements: [null, 5, { band: null, x: 'a' }] }), [null, 5, { band: null, x: 'a' }]);
  assert.deepEqual(M.resolveBands(ctx, {}), []);
  // a project without null bands: a plain copy of the list
  const plain = rowPlan({ measurements: [meas(300, 450, 5, -50)] });
  assert.deepEqual(M.resolveBands(ctx, plain), plain.measurements);
});

test('calibration: inferred-band points count with half the weight; calibrateAll / offsets / fitProject resolve them', () => {
  // three known 5 GHz points 4 dB above the model and two "Nevím" points (inferred 5 GHz) 10 dB below
  const p0 = rowPlan();
  const ctx = M.createContext(p0);
  const bl = p0.net.baseline;
  const at = (px, d, band) => {
    const q = n(px, 450);
    return meas(px, 450, band, Math.round((M.softRawSignal(ctx, bl, q, 5) + d) * 100) / 100);
  };
  const known = [at(260, 4, 5), at(300, 4, 5), at(340, 4, 5)];
  const unknown = [at(280, -10, null), at(320, -10, null)];
  const p = P.sanitize({ ...p0, measurements: [...known, ...unknown] });
  assert.ok(M.resolveBands(ctx, p).every((m) => m.band === 5));
  const cal = M.calibrateAll(ctx, p)['5'];
  assert.equal(cal.n, 5);
  assert.equal(cal.used.filter((u) => u.inferred).length, 2);
  // weights 1,1,1,0.5,0.5 (total 4): the weighted median is the known +4 dB (unweighted it would be +4 too, but with
  // a third unknown point it would flip) - check the rule directly
  close(cal.offset, 4, 0.02);
  assert.equal(M.weightedMedian([1, 2, 3, 4], [1, 1, 1, 1]), 2.5, 'equal weights = the plain median');
  assert.equal(M.weightedMedian([-10, -10, -10, 4, 4], [0.5, 0.5, 0.5, 1, 1]), 4, 'three half points lose against two full ones');
  assert.equal(M.weightedMedian([-10, -10, -10, 4, 4], [1, 1, 1, 1, 1]), -10);
  assert.equal(M.weightedMedian([], []), 0);
  const three = P.sanitize({ ...p, measurements: [known[0], known[1], at(280, -10, null), at(320, -10, null), at(360, -10, null)] });
  close(M.calibrateAll(ctx, three)['5'].offset, 4, 0.02, 'two known beat three inferred');
  assert.equal(M.INFERRED_WEIGHT, 0.5);
  close(M.offsets(ctx, three)['5'], M.calibrateAll(ctx, three)['5'].offset, 0);
  // robustOffset with weights; weights of 1 = exactly the unweighted rule
  const res = [1, 2, 3, 40];
  assert.deepEqual(M.robustOffset(res, null, [1, 1, 1, 1]), M.robustOffset(res));
  const rw = M.robustOffset([0, 0, 10, 10], null, [1, 1, 0.5, 0.5]);
  close(rw.offset, 10 / 3, 1e-9, 'weighted mean');
  // a fit: inferred points shape nothing, their offset weight is lower, the signature watches them
  const fitP = P.sanitize({ ...p, view: { ...p.view, band: 5 } });
  const fit = M.fitProject(fitP, { band: 5, at: 1 });
  assert.ok(fit && fit.byBand['5']);
  assert.equal(fit.byBand['5'].count + fit.byBand['5'].outliers.length, 5);
  assert.equal(M.fitStale(P.sanitize({ ...fitP, model: { ...fitP.model, fit } })), false);
  const moved = P.sanitize({ ...fitP, model: { ...fitP.model, fit }, measurements: [...fitP.measurements.slice(0, 4), { ...fitP.measurements[4], value: -40 }] });
  assert.equal(M.fitStale(moved), true, 'a changed "Nevím" point makes the fit stale');
});

// ---------------------------------------------------------------------------------------------------------------
// what-if
// ---------------------------------------------------------------------------------------------------------------

test('predictAtMeasurements: inferred bands; steering of the new scenario only when the rule picks another band', () => {
  const mk = (band, v, d, u) => ({ id: `c${band}${v}`, x: 0.12, y: 0.4, band, value: v, name: 'c', download: d, upload: u, device: 'Telefon', t: 0 });
  const curveList = [mk(5, -40, 600, 200), mk(5, -55, 300, 100), mk(5, -70, 60, 20), mk(5, -85, 3, 1), mk(2.4, -40, 150, 60), mk(2.4, -60, 90, 30), mk(2.4, -85, 6, 2)];
  const curves = S.buildCurves(curveList, { device: 'Telefon' });
  const far24 = meas(900, 450, 2.4, -70, 40, 12);
  const farUnknown = meas(880, 450, null, -71, 35, 10);
  const near5 = meas(300, 450, 5, -50, 400, 120);
  const p = rowPlan({ view: { band: 'auto' }, measurements: [far24, farUnknown, near5] });
  const ctx = M.createContext(p);
  // nothing changed: no switch, delta 0
  const r0 = A.predictAtMeasurements(ctx, p, { curves });
  assert.deepEqual(r0.map((e) => [e.band, e.bandInferred, e.bandNew, e.steered, e.delta]), [[2.4, false, 2.4, true, 0], [2.4, true, 2.4, true, 0], [5, false, 5, true, 0]]);
  assert.ok(r0.every((e) => !e.changed && e.speed.predDown === e.speed.measuredDown));
  // a wired AP in the right room: the far clients switch to 5 GHz
  const pn = P.sanitize({ ...p, node: { mode: 'ap_cable', pos: n(850, 450), bands: { '2.4': true, 5: true, 6: false }, power: 0, backhaulBand: 5, backhaulThreshold: -67 } });
  const r = A.predictAtMeasurements(ctx, pn, { curves });
  const e = r[0];
  assert.equal(e.bandNew, 5);
  assert.equal(e.source, 'node');
  assert.equal(e.changed, true);
  const offs = M.offsets(ctx, pn);
  close(e.modelToday, M.softSignal(ctx, pn.net.baseline, { x: e.x, y: e.y }, 2.4, offs['2.4']), 1e-9, 'today on the measured band');
  close(e.modelNew, M.softSignal(ctx, pn.node.pos, { x: e.x, y: e.y }, 5, offs['5']), 1e-9, 'new on the steered band');
  close(e.delta, e.modelNew - e.modelToday, 1e-12);
  // = the planner's tooltip in Auto
  const d = M.pointSignalDetail(ctx, { x: e.x, y: e.y }, M.fieldParams(pn, 'trial', { offsets: offs }));
  assert.equal(d.band, 5);
  close(d.combined, e.modelNew, 1e-9);
  // the anchored speed: measured x curve5(new) / curve2.4(today)
  const want = Math.min((40 * S.rate(curves['5'], e.predicted).down) / S.rate(curves['2.4'], e.measured).down, Math.max(40, S.rate(curves['5'], curves['5'].max).down));
  close(e.speed.predDown, want, 1e-6);
  assert.ok(e.speed.predDown > 40);
  assert.equal(r[1].bandInferred, true);
  assert.equal(r[1].bandNew, 5);
  // steer:false keeps every point on its band (SPEC 10 semantics); a numeric band filters (inferred ones included)
  const r1 = A.predictAtMeasurements(ctx, pn, { curves, steer: false });
  assert.ok(r1.every((x) => x.bandNew === x.band && x.steered === false));
  assert.deepEqual(A.predictAtMeasurements(ctx, pn, { curves, band: 2.4 }).map((x) => x.id), [far24.id, farUnknown.id]);
  assert.ok(A.predictAtMeasurements(ctx, pn, { curves, band: 2.4 }).every((x) => x.steered === false));
  assert.deepEqual(A.predictAtMeasurements(ctx, pn, { curves, band: 'auto' }), r);
  // a 5 GHz view does not steer by default
  const p5 = P.sanitize({ ...pn, view: { ...pn.view, band: 5 } });
  assert.ok(A.predictAtMeasurements(ctx, p5, { curves }).every((x) => !x.steered && x.bandNew === x.band));
  // with steering a band without its own curve borrows the nearest one (approx)
  const r5 = A.predictAtMeasurements(ctx, pn, { curves: { 5: curves['5'], '2.4': null } });
  assert.equal(r5[0].speed.approx, true);
  assert.ok(r5[0].speed.predDown > 0);
  // summarizePredictions still works on steered entries
  const s = A.summarizePredictions(r);
  assert.equal(s.count, 3);
  assert.ok(s.best.bandNew === 5);
});

test('Auto is fast enough: steered field cell 8 < 40 ms, cell 4 < 150 ms on the demo (both bands + node)', () => {
  const p = demo();
  p.node = { ...p.node, mode: 'mesh_wifi' };
  const q = P.sanitize(p);
  const ctx = M.createContext(q);
  const st = M.fieldParams(q, 'trial');
  const time = (cell) => {
    const g = R.grid(ctx, { cell });
    R.field(ctx, g, st);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      R.field(ctx, g, { ...st, aa: cell <= 4 ? 2 : 1 });
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const t8 = time(8);
  const t4 = time(4);
  assert.ok(t8 < 40, `cell 8: ${t8.toFixed(1)} ms`);
  assert.ok(t4 < 150, `cell 4: ${t4.toFixed(1)} ms`);
});
