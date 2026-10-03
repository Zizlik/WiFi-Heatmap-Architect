// Speed-test points without a measured signal (SPEC 6.2): a phone browser cannot read dBm, so a measurement may carry
// only download + upload (value null). Sanitize / file round trips / calibration / speed curve must handle them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { E, FIXTURES } from './_load.mjs';
import { assertValidProject } from './_validate.mjs';

const P = E.project;
const clone = (o) => JSON.parse(JSON.stringify(o));
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);

function demo() {
  return P.create({ template: 'demo', lang: 'cs' });
}
/** A spot on the floor of room #i of the demo (its label point). */
const spot = (p, i) => E.geom.labelPoint(p.plan.rooms[i].points);

test('sanitize keeps a speed-only point (value null with download AND upload) and drops incomplete ones', () => {
  const p = demo();
  const a = spot(p, 0);
  p.measurements = [
    { id: 'ok', ...a, band: 5, value: null, name: 'Obývák', download: 245.4, upload: 38.2, device: 'Telefon', t: 1, ping: 12.345, jitter: 1.5, source: 'cloudflare' },
    { id: 'noUp', ...a, band: 5, value: null, name: 'x', download: 200, upload: null, device: 'Telefon', t: 1 },
    { id: 'noDown', ...a, band: 5, name: 'x', upload: 20, device: 'Telefon', t: 1 },
    { id: 'nan', ...a, band: 5, value: NaN, name: 'x', download: 'fast', upload: 20, device: 'Telefon', t: 1 },
    { id: 'measured', ...a, band: 2.4, value: -61, name: 'Kuchyň', download: null, upload: null, device: 'Telefon', t: 2 },
  ];
  const s = P.sanitize(p);
  assertValidProject(s, 'speed-only');
  assert.deepEqual(s.measurements.map((m) => m.id), ['ok', 'measured']);
  const m = s.measurements[0];
  assert.equal(m.value, null);
  assert.equal(m.download, 245.4);
  assert.equal(m.upload, 38.2);
  assert.equal(m.ping, 12.35, 'ping rounded to 0.01 ms');
  assert.equal(m.jitter, 1.5);
  assert.equal(m.source, 'cloudflare');
  // a classic measurement keeps exactly its old shape (no extra keys)
  assert.deepEqual(Object.keys(s.measurements[1]), ['id', 'x', 'y', 'band', 'value', 'name', 'download', 'upload', 'device', 't']);
  assert.deepEqual(P.sanitize(s), s, 'idempotent');
  // strict mode drops such points instead of throwing
  assert.doesNotThrow(() => P.sanitize(p, { strict: true }));
});

test('sanitize: ping / jitter / source are optional, clamped and validated', () => {
  const p = demo();
  const a = spot(p, 1);
  p.measurements = [
    { id: 'a', ...a, band: 5, value: -60, name: 'a', download: 100, upload: 20, device: 'D', t: 0, ping: -5, jitter: 1e9, source: 'speedtest.net' },
    { id: 'b', ...a, band: 5, value: -60, name: 'b', download: 100, upload: 20, device: 'D', t: 0, ping: 'x', jitter: null, source: 'cloudflare' },
  ];
  const s = P.sanitize(p);
  assertValidProject(s, 'extras');
  assert.equal(s.measurements[0].ping, 0);
  assert.equal(s.measurements[0].jitter, 10000);
  assert.ok(!('source' in s.measurements[0]), 'unknown source dropped');
  assert.ok(!('ping' in s.measurements[1]) && !('jitter' in s.measurements[1]));
  assert.equal(s.measurements[1].source, 'cloudflare');
});

test('file round trips keep speed-only points (serialize, buildSvg -> parseSvgText, JSON string)', () => {
  const p = demo();
  p.measurements = [
    { id: 'm1', ...spot(p, 0), band: 5, value: null, name: 'Bez signálu "A"', download: 245, upload: 38, device: 'Telefon', t: 1700000000000, ping: 11.2, jitter: 0.8, source: 'cloudflare' },
    { id: 'm2', ...spot(p, 2), band: 5, value: -71.5, name: 'Se signálem', download: 80, upload: 20, device: 'Telefon', t: 1700000000001 },
  ];
  const s = P.sanitize(p);
  const back = P.parseSvgText(P.buildSvg(s, { lang: 'cs' })).project;
  assert.deepEqual(back, s);
  assert.deepEqual(P.sanitize(P.serialize(s)), s);
  assert.deepEqual(P.sanitize(JSON.parse(P.serialize(s)), { strict: false }), s);
  const json = JSON.parse(P.serialize(s));
  assert.equal(json.project.measurements[0].value, null, 'null survives JSON (not dropped, not NaN)');
});

test('legacy storage: a stored speed point without a signal value but with both speeds survives the migration', () => {
  const plan = JSON.parse(readFileSync(path.join(FIXTURES, 'old-demo-payload.json'), 'utf8')).plan;
  const original = { x: 0.48, y: 0.63 };
  const mem = {
    'wifi-floor-v5': JSON.stringify({ ed: plan, appliedPlan: plan }),
    'wifi-floor-network-v1': JSON.stringify({ width: 9, router: { x: 0.3, y: 0.3 }, original, optic: { x: 0.1, y: 0.62 } }),
    'wifi-speed-v1': JSON.stringify({
      original,
      points: [
        { x: 0.3, y: 0.3, value: null, name: 'Jen rychlost', band: 5, download: 300, upload: 40, device: 'Telefon' },
        { x: 0.3, y: 0.3, name: 'Bez odesílání', band: 5, download: 300, device: 'Telefon' },
        { x: 0.6, y: 0.4, value: -70, name: 'Kuchyň', band: 5, download: null, upload: null, device: 'Telefon' },
      ],
    }),
  };
  const m = P.migrateLegacyStorage((k) => (k in mem ? mem[k] : null), { lang: 'cs' });
  assert.ok(m, 'migrated');
  assertValidProject(m, 'migrated');
  assert.deepEqual(m.measurements.map((q) => [q.name, q.value]), [['Jen rychlost', null], ['Kuchyň', -70]]);
});

test('calibration ignores speed-only points', () => {
  const p = P.sanitize(demo());
  const ctx = E.model.createContext(p);
  const base = p.net.baseline;
  const measured = [0, 2, 4].map((i, k) => {
    const q = spot(p, i);
    return { id: 'c' + k, ...q, band: 5, value: Math.round((E.model.softRawSignal(ctx, base, q, 5) - 5) * 100) / 100, name: 'c', download: null, upload: null, device: p.goal.device, t: 0 };
  });
  const speedOnly = [1, 3].map((i, k) => ({ id: 's' + k, ...spot(p, i), band: 5, value: null, name: 's', download: 100 + k, upload: 20, device: p.goal.device, t: 0 }));
  const a = E.model.calibrate(ctx, measured, 5, { baseline: base, device: p.goal.device });
  const b = E.model.calibrate(ctx, [...speedOnly, ...measured], 5, { baseline: base, device: p.goal.device });
  assert.equal(b.n, 3);
  close(b.offset, a.offset, 1e-12);
  close(b.offset, -5, 0.02);
  assert.deepEqual(b.used.map((u) => u.id), ['c0', 'c1', 'c2']);
  // only speed-only points on a band: no calibration at all
  const c = E.model.calibrate(ctx, speedOnly, 5, { baseline: base });
  assert.deepEqual([c.n, c.offset], [0, 0]);
  p.measurements = [...speedOnly, ...measured];
  const off = E.model.offsets(ctx, p);
  close(off['5'], a.offset, 1e-12);
});

test('fillSignals: speed-only points get the calibrated model signal at their spot (router at the baseline)', () => {
  const p = P.sanitize(demo());
  const ctx = E.model.createContext(p);
  const base = p.net.baseline;
  const q5 = spot(p, 1);
  const q24 = spot(p, 3);
  const measured = { id: 'm', ...spot(p, 0), band: 5, value: -55, name: 'm', download: 300, upload: 50, device: 'Telefon', t: 0 };
  const list = [
    measured,
    { id: 's5', ...q5, band: 5, value: null, name: 's', download: 120, upload: 30, device: 'Telefon', t: 0 },
    { id: 's24', ...q24, band: 2.4, value: null, name: 's', download: 40, upload: 10, device: 'Telefon', t: 0 },
  ];
  const offsets = { '2.4': -3, '5': 2, '6': 0 };
  const out = E.speed.fillSignals(ctx, list, { baseline: base, offsets });
  assert.equal(out.length, 3);
  assert.equal(out[0], measured, 'measured points are passed through as the same object');
  assert.equal(list[1].value, null, 'the input is not modified');
  assert.equal(out[1].predictedSignal, true);
  close(out[1].value, E.model.softSignal(ctx, base, q5, 5, 2), 0.006);
  close(out[2].value, E.model.softSignal(ctx, base, q24, 2.4, -3), 0.006);
  // what the calibrated "today" map shows at that spot
  const a = E.analysis.run(p, { cell: 4, ctx, offsets });
  close(out[1].value, E.raster.sample(a.grid, a.today, q5), 0.6);
  // without offsets = uncalibrated; without a baseline nothing is filled
  close(E.speed.fillSignals(ctx, list, { baseline: base })[1].value, E.model.softSignal(ctx, base, q5, 5, 0), 0.006);
  assert.equal(E.speed.fillSignals(ctx, list, {})[1].value, null);
  assert.deepEqual(E.speed.fillSignals(ctx, [], { baseline: base }), []);
  assert.deepEqual(E.speed.fillSignals(ctx, null, { baseline: base }), []);
});

test('speed curve from a measured point plus a speed-only point (predicted signal)', () => {
  const p = P.sanitize(demo());
  const ctx = E.model.createContext(p);
  const base = p.net.baseline;
  // the strongest and the weakest spot of the demo flat as the router at the baseline sees them
  const spots = p.plan.rooms.map((r) => E.geom.labelPoint(r.points)).map((q) => ({ q, s: E.model.softSignal(ctx, base, q, 5, 0) })).sort((x, y) => y.s - x.s);
  const strong = spots[0];
  const weak = spots[spots.length - 1];
  assert.ok(strong.s - weak.s >= 5, 'demo spread');
  const list = [
    { id: 'a', ...strong.q, band: 5, value: Math.round(strong.s * 10) / 10, name: 'a', download: 400, upload: 90, device: 'Telefon', t: 0 },
    { id: 'b', ...weak.q, band: 5, value: null, name: 'b', download: 60, upload: 15, device: 'Telefon', t: 0 },
  ];
  // without filling, the speed-only point does not count
  assert.equal(E.speed.buildCurve(list, { band: 5, device: 'Telefon' }), null);
  assert.equal(E.speed.diagnose(list, { band: 5, device: 'Telefon' }).count, 1);
  const filled = E.speed.fillSignals(ctx, list, { baseline: base, offsets: { '2.4': 0, '5': 0, '6': 0 } });
  const curve = E.speed.buildCurve(filled, { band: 5, device: 'Telefon' });
  assert.ok(curve, 'curve built');
  assert.equal(curve.count, 2);
  close(curve.min, weak.s, 0.01);
  assert.equal(E.speed.diagnose(filled, { band: 5, device: 'Telefon' }).needs, 'none');
  const r = E.speed.rate(curve, filled[1].value);
  close(r.down, 60, 1e-6);
  close(r.up, 15, 1e-6);
  // two speed-only points alone also give a curve (purely on the model's prediction)
  const only = E.speed.fillSignals(ctx, [{ ...list[0], value: null }, list[1]], { baseline: base });
  assert.ok(E.speed.buildCurve(only, { band: 5 }));
  // and the speed map uses it
  const grid = E.raster.grid(ctx, { cell: 8 });
  const sf = E.speed.fieldSpeed(ctx, grid, E.model.fieldParams(p, 'trial'), curve, {});
  assert.equal(sf.supported, true);
  assert.ok(sf.known.some((k) => k === 1));
});

test('a project mixing both kinds stays valid through the fuzz-ish corruptions of the value field', () => {
  const p = demo();
  const a = spot(p, 0);
  const base = { id: 'x', ...a, band: 5, name: 'x', download: 10, upload: 2, device: 'D', t: 0 };
  for (const value of [null, undefined, NaN, Infinity, '', 'x', [], {}, true, -50, -500, 5]) {
    const raw = clone(p);
    raw.measurements = [{ ...base, value }];
    const s = P.sanitize(raw);
    assertValidProject(s, `value ${String(value)}`);
    assert.equal(s.measurements.length, 1);
    const v = s.measurements[0].value;
    assert.ok(v === null || (v >= -100 && v <= -20), String(value));
    assert.equal(v === null, typeof value !== 'number' || !Number.isFinite(value), `value ${String(value)} -> ${v}`);
  }
});
