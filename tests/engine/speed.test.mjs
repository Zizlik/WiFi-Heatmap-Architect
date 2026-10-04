import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, makeProject, ctxOf } from './_helpers.mjs';

const { speed, raster, model } = E;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);

let id = 0;
const m = (value, download, upload, extra = {}) => ({ id: `s${++id}`, x: 0.5, y: 0.5, band: 5, value, name: 'x', download, upload, device: 'Phone', t: 0, ...extra });

const MEAS = [m(-45, 400, 100), m(-45, 420, 110), m(-55, 250, 80), m(-65, 120, 60), m(-65, 100, 50), m(-75, 20, 10)];

test('monotoneSpeed: median per signal value in log1p space, then isotonic regression', () => {
  const nodes = speed.monotoneSpeed(MEAS, 'download');
  assert.deepEqual(nodes.map((q) => q.x), [-75, -65, -55, -45]);
  close(nodes[0].y, Math.log1p(20));
  close(nodes[1].y, Math.log1p(110), 1e-12, 'median of 120 and 100');
  close(nodes[3].y, Math.log1p(410), 1e-12);
  for (let i = 1; i < nodes.length; i++) assert.ok(nodes[i].y >= nodes[i - 1].y);
  // a violation (stronger signal measured slower) is pooled
  const bad = speed.monotoneSpeed([m(-70, 100, 10), m(-60, 40, 10), m(-50, 200, 10)], 'download');
  close(bad[0].y, bad[1].y, 1e-12);
  close(bad[0].y, (Math.log1p(100) + Math.log1p(40)) / 2, 1e-12);
  assert.ok(bad[2].y > bad[1].y);
  // fully reversed data collapses into one flat level
  const flat = speed.monotoneSpeed([m(-70, 300, 1), m(-60, 200, 1), m(-50, 100, 1)], 'download');
  assert.ok(flat.every((q) => Math.abs(q.y - flat[0].y) < 1e-12));
});

test('buildCurve: needs two signal values at least 5 dB apart with download and upload', () => {
  assert.ok(speed.buildCurve(MEAS, { band: 5, device: 'Phone' }));
  const c = speed.buildCurve(MEAS, { band: 5, device: 'phone' });
  assert.equal(c.min, -75);
  assert.equal(c.max, -45);
  assert.equal(c.count, 6);
  assert.equal(speed.buildCurve([m(-60, 100, 10), m(-60, 90, 9)], { band: 5 }), null, 'one signal value');
  assert.equal(speed.buildCurve([m(-60, 100, 10), m(-57, 90, 9)], { band: 5 }), null, 'only 3 dB apart');
  assert.ok(speed.buildCurve([m(-60, 100, 10), m(-55, 90, 9)], { band: 5 }), 'exactly 5 dB is enough');
  assert.equal(speed.buildCurve([m(-60, 100, null), m(-50, 90, 9)], { band: 5 }), null, 'upload missing');
  assert.equal(speed.buildCurve([m(-60, null, 10), m(-50, 90, 9)], { band: 5 }), null, 'download missing');
  assert.equal(speed.buildCurve(MEAS, { band: 2.4 }), null, 'other band');
  assert.equal(speed.buildCurve(MEAS, { band: 5, device: 'Laptop' }), null, 'other device');
  assert.ok(speed.buildCurve(MEAS, { band: 5 }), 'no device filter -> all devices');
  assert.equal(speed.buildCurve([m(-60, 100, 20000), m(-50, 90, 9)], { band: 5 }), null, 'invalid rate');
  assert.equal(speed.buildCurve([], { band: 5 }), null);
});

test('diagnose tells what is missing', () => {
  assert.deepEqual(
    (({ needs, ok, distinct, count }) => ({ needs, ok, distinct, count }))(speed.diagnose([], { band: 5 })),
    { needs: 'tests', ok: false, distinct: 0, count: 0 },
  );
  assert.equal(speed.diagnose([m(-60, 1, 1), m(-58, 1, 1)], { band: 5 }).needs, 'spread');
  assert.equal(speed.diagnose(MEAS, { band: 5, device: 'Phone' }).needs, 'none');
  close(speed.diagnose(MEAS, { band: 5 }).spread, 30);
});

test('rate: null below the weakest test, interpolation in log1p space, clamped above the strongest', () => {
  const c = speed.buildCurve(MEAS, { band: 5, device: 'Phone' });
  assert.equal(speed.rate(c, -75.01), null);
  assert.equal(speed.rate(null, -60), null);
  const w = speed.rate(c, -75);
  close(w.down, 20, 1e-9);
  close(w.up, 10, 1e-9);
  assert.equal(w.extrapolated, false);
  const mid = speed.rate(c, -70);
  const expected = Math.expm1((Math.log1p(20) + Math.log1p(110)) / 2);
  close(mid.down, expected, 1e-9);
  const top = speed.rate(c, -20);
  close(top.down, 410, 1e-9, 'clamped to the best test, never extrapolated upwards');
  assert.equal(top.extrapolated, true);
  assert.equal(speed.rate(c, -45).extrapolated, false);
  // monotone in the signal
  let prev = -1;
  for (let s = -75; s <= -30; s += 0.5) {
    const r = speed.rate(c, s);
    assert.ok(r.down >= prev - 1e-9);
    prev = r.down;
  }
});

test('predict: internet plan, link limit and reserve', () => {
  const c = speed.buildCurve(MEAS, { band: 5, device: 'Phone' });
  const free = speed.predict(c, -45, {});
  close(free.down, 410, 1e-9);
  const reserve = speed.predict(c, -45, { reserve: 30 });
  close(reserve.down, 410 * 0.7, 1e-9);
  close(reserve.up, 105 * 0.7, 1e-9);
  const wan = speed.predict(c, -45, { wanDown: 100, wanUp: 20, reserve: 0 });
  assert.deepEqual({ d: wan.down, u: wan.up }, { d: 100, u: 20 });
  const link = speed.predict(c, -45, { linkLimit: 50, wanDown: 100, reserve: 50 });
  assert.deepEqual({ d: link.down, u: link.up }, { d: 25, u: 25 });
  assert.equal(speed.predict(c, -90, {}), null);
  assert.deepEqual(speed.predict(c, -60), speed.predict(c, -60, {}), 'limits are optional');
  assert.equal(speed.linkLimit({}), Infinity);
  assert.equal(speed.linkLimit({ wanPort: 1000, ontPort: 100, wanLink: null }), 100);
  assert.equal(speed.linkLimit({ wanPort: 1000, ontPort: 2500, wanLink: 1000 }), 1000);
  // toLimits derives the link limit from the ports
  assert.equal(speed.toLimits({ wanPort: 1000, ontPort: 100, reserve: 10 }).linkLimit, 100);
});

function speedProject() {
  return makeProject({
    rooms: [room(1, 100, 100, 600, 500), room(2, 600, 100, 900, 500)],
    walls: [wall('w', 600, 100, 600, 500, 8)],
    router: [200, 300],
    baseline: [200, 300],
    measurements: [],
  });
}

test('fieldSpeed / ratioField / stats', () => {
  const p = speedProject();
  const c = ctxOf(p);
  const g = raster.grid(c);
  const st = model.fieldParams(p, 'today', { band: 5 });
  // the weakest test was at -58 dBm: everything weaker than that has no basis for an estimate
  const curve = speed.buildCurve([m(-45, 400, 100), m(-50, 330, 90), m(-58, 120, 40)], { band: 5, device: 'Phone' });
  const sf = speed.fieldSpeed(c, g, st, curve, { reserve: 0, wanDown: 300 });
  assert.equal(sf.supported, true);
  assert.equal(sf.down.length, g.cols * g.rows);
  let known = 0;
  const sig = raster.field(c, g, st);
  for (const i of g.idx) {
    if (sf.known[i]) {
      known++;
      assert.ok(sf.down[i] <= 300 + 1e-4, 'wan limit');
      assert.ok(sig[i] >= -58 - 1e-4, 'only where the curve exists');
    } else {
      assert.ok(sig[i] < -58 + 1e-4);
      assert.equal(sf.down[i], 0);
    }
  }
  assert.ok(known > 0 && known < g.count, `${known} known cells`);
  // better signal -> not slower
  const order = Array.from(g.idx).filter((i) => sf.known[i]).sort((a, b) => sig[a] - sig[b]);
  for (let k = 1; k < order.length; k++) assert.ok(sf.down[order[k]] >= sf.down[order[k - 1]] - 1e-3);

  const ratio = speed.ratioField(g, sf, 100, 50);
  for (const i of g.idx) {
    if (!sf.known[i]) assert.equal(ratio[i], -1);
    else close(ratio[i], Math.min(sf.down[i] / 100, sf.up[i] / 50), 1e-4);
  }
  assert.ok(Number.isNaN(ratio[0]));
  const s = speed.stats(g, sf, { roomIds: null, targetDown: 100, targetUp: 50 });
  assert.equal(s.n, g.count);
  close(s.known, (100 * known) / g.count, 1e-9);
  assert.ok(s.coverage > 0 && s.coverage <= s.known);
  assert.ok(s.medianDown === null || s.medianDown > 0);
  const room2 = speed.stats(g, sf, { roomIds: [2], targetDown: 100, targetUp: 50 });
  assert.ok(room2.known < s.known, 'the far room has less known area');
  const nothing = speed.stats(g, sf, { roomIds: [], targetDown: 1, targetUp: 1 });
  assert.equal(nothing.n, 0);
  // the colour image marks unknown cells grey
  const img = raster.colorize(g, ratio, { mode: 'speed', bleed: false });
  const unknown = Array.from(g.idx).find((i) => !sf.known[i]);
  assert.deepEqual(Array.from(img.data.slice(unknown * 4, unknown * 4 + 3)), [113, 126, 148]);
});

test('fieldSpeed: a second node is supported now (SPEC 10); unsupported only without a curve / params, never throws', () => {
  const p = speedProject();
  const c = ctxOf(p);
  const g = raster.grid(c);
  const curve = speed.buildCurve(MEAS, { band: 5, device: 'Phone' });
  const node = { mode: 'ap_cable', pos: n(700, 300), power: 0, bands: { '2.4': true, '5': true, '6': false } };
  const withNode = speed.fieldSpeed(c, g, { ...model.fieldParams(p, 'today', { band: 5 }), node }, curve, {});
  assert.deepEqual({ s: withNode.supported, r: withNode.reason, k: withNode.known.some(Boolean) }, { s: true, r: null, k: true });
  assert.ok(withNode.source && withNode.source.some(Boolean), 'the node serves some cells');
  assert.equal(withNode.link.wireless, false);
  const noCurve = speed.fieldSpeed(c, g, model.fieldParams(p, 'today', { band: 5 }), null, {});
  assert.deepEqual({ s: noCurve.supported, r: noCurve.reason }, { s: false, r: 'curve' });
  // the old 'node' reason is gone; odd input gives a reason instead of an exception
  for (const [label, args] of [
    ['no grid', [c, null, model.fieldParams(p, 'today', { band: 5 }), curve, {}]],
    ['no params', [c, g, null, curve, {}]],
    ['no router', [c, g, { band: 5 }, curve, {}]],
    ['bad band', [c, g, { ...model.fieldParams(p, 'today'), band: 7 }, curve, {}]],
    ['broken curve', [c, g, model.fieldParams(p, 'today', { band: 5 }), { download: 'x' }, {}]],
    ['empty curve', [c, g, model.fieldParams(p, 'today', { band: 5 }), {}, null]],
  ]) {
    const r = speed.fieldSpeed(...args);
    assert.equal(r.supported, false, label);
    assert.ok(['params', 'curve'].includes(r.reason), `${label}: ${r.reason}`);
  }
});

test('scoreRatios: pass rate dominates, then the weak tail, then the mean', () => {
  const good = speed.scoreRatios([1.2, 1.5, 2, 3]);
  const mixed = speed.scoreRatios([0.2, 0.9, 1.5, 3]);
  const bad = speed.scoreRatios([0, 0, 0, 0]);
  assert.ok(good > mixed && mixed > bad);
  close(bad, 0);
  assert.equal(speed.scoreRatios([]), 0);
  // exact legacy formula
  const r = [0.5, 1, 1.5, 2.5];
  const pass = 3 / 4;
  const p10 = 0.5;
  const mean = (0.5 + 1 + 1.5 + 2) / 4;
  close(speed.scoreRatios(r), pass * 10 + Math.min(p10, 2) + mean * 0.1, 1e-12);
});
