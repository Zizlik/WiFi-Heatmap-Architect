// SPEC 9: analysis.suggestSpots - the numbered pins of the "first measurement" wizard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { busyPlan, makeProject, room, wall } from './_helpers.mjs';

const { W, H } = E.CANVAS;
const M = E.model;
const P = E.project;
const G = E.geom;

const demo = () => P.create({ template: 'demo', lang: 'cs' });
const busy = () => makeProject({ ...busyPlan(), router: [250, 200], baseline: [250, 200] });

/** Every rule of SPEC 9 for a list of spots. */
function checkSpots(p, spots, { band = p.view.band, minGap = 1.5, wallClear = 0.3 } = {}) {
  const ctx = M.createContext(p);
  const mpp = p.scale.mpp;
  const router = p.net.baseline;
  const offs = M.offsets(ctx, p);
  for (const s of spots) {
    const r = P.roomAt(p.plan, s);
    assert.ok(r && r.roomId === s.roomId, `spot ${s.kind} lies in room ${s.roomId}`);
    for (const w of p.plan.walls) {
      const d = G.pointSegDistPx(s.x * W, s.y * H, w.a.x * W, w.a.y * H, w.b.x * W, w.b.y * H) * mpp;
      assert.ok(d >= wallClear - 1e-6, `${s.kind}: ${d.toFixed(2)} m from wall ${w.id}`);
    }
    for (const f of p.plan.furniture) assert.ok(!G.pointInPolygon(s, f.points), `${s.kind} inside furniture ${f.id}`);
    assert.ok(G.distM(router, s, mpp) >= 0.8 - 1e-9, `${s.kind} too close to the router`);
    assert.equal(s.distance, Math.round(G.distM(router, s, mpp) * 100) / 100);
    assert.equal(s.walls, M.wallCount(ctx, router, s));
    if (band === 'auto') {
      // SPEC 13: the number of the band a steering client uses at the spot (router at the baseline, no node)
      const st = M.steeredSignal(ctx, s, { band: 'auto', bands: M.routerBandList(p), steer: M.steerOf(p), router, node: null, offsets: offs });
      assert.equal(s.band, st.band);
      assert.equal(s.predicted, Math.round(st.signal * 10) / 10);
    } else {
      assert.equal(s.band, band);
      assert.equal(s.predicted, Math.round(M.softSignal(ctx, router, s, band, M.offsetFor(offs, band)) * 10) / 10);
    }
    assert.ok(E.analysis.SPOT_KINDS.includes(s.kind));
  }
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) assert.ok(G.distM(spots[i], spots[j], mpp) >= minGap - 1e-9, `spots ${i} and ${j} are ${G.distM(spots[i], spots[j], mpp).toFixed(2)} m apart`);
  // walking order
  const order = spots.map((s) => E.analysis.SPOT_KINDS.indexOf(s.kind));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
}

test('demo flat: 5 spots, one of every kind, each kind as SPEC 9 describes it', () => {
  const p = demo();
  const ctx = M.createContext(p);
  const spots = E.analysis.suggestSpots(ctx, p, { band: 5 });
  assert.equal(spots.length, 5);
  assert.deepEqual(
    spots.map((s) => s.kind),
    ['near', 'sameRoom', 'oneWall', 'twoWalls', 'far'],
  );
  checkSpots(p, spots, { band: 5 });
  const by = Object.fromEntries(spots.map((s) => [s.kind, s]));
  const home = P.roomAt(p.plan, p.net.baseline).roomId;
  assert.ok(by.near.distance >= 1 && by.near.distance <= 2 && by.near.walls === 0, 'near: 1-2 m, no wall');
  assert.ok(by.sameRoom.walls === 0 && by.sameRoom.distance >= 2, 'sameRoom: no wall, far side');
  assert.equal(by.oneWall.walls, 1);
  assert.ok(by.twoWalls.walls >= 2);
  // far: in the room whose predicted signal is the weakest (median over the room)
  const grid = E.raster.grid(ctx, { cell: 8 });
  const field = E.raster.field(ctx, grid, M.fieldParams(p, 'today', { band: 5, offsets: M.offsets(ctx, p) }));
  const per = E.raster.perRoom(grid, field, p.model.threshold);
  const weakest = [...per].sort((a, b) => a[1].median - b[1].median)[0][0];
  assert.equal(by.far.roomId, weakest);
  assert.ok(by.near.predicted > by.far.predicted);
  assert.ok(by.sameRoom.roomId === home || by.sameRoom.walls === 0);
});

test('deterministic, honours count (priority subset / more spots), band and minGap', () => {
  const p = demo();
  const ctx = M.createContext(p);
  const a = E.analysis.suggestSpots(ctx, p, { band: 5 });
  assert.deepEqual(a, E.analysis.suggestSpots(M.createContext(p), p, { band: 5 }));
  const four = E.analysis.suggestSpots(ctx, p, { band: 5, count: 4 });
  assert.deepEqual(
    four.map((s) => s.kind),
    ['near', 'oneWall', 'twoWalls', 'far'],
    'with 4 spots the far side of the router room is left out',
  );
  checkSpots(p, four, { band: 5 });
  for (const count of [1, 2, 3, 6, 8]) {
    const s = E.analysis.suggestSpots(ctx, p, { band: 5, count });
    assert.equal(s.length, count);
    checkSpots(p, s, { band: 5 });
  }
  assert.equal(E.analysis.suggestSpots(ctx, p, { band: 5, count: 99 }).length, 8, 'count is clamped to 8');
  assert.equal(E.analysis.suggestSpots(ctx, p, { band: 5, count: 1 })[0].kind, 'near');
  // the band changes the predicted numbers (and possibly the weakest room), never the rules
  const b24 = E.analysis.suggestSpots(ctx, p, { band: 2.4 });
  checkSpots(p, b24, { band: 2.4 });
  assert.ok(b24.find((s) => s.kind === 'near').predicted > a.find((s) => s.kind === 'near').predicted);
  // a larger gap is respected
  checkSpots(p, E.analysis.suggestSpots(ctx, p, { band: 5, minGap: 2.5 }), { band: 5, minGap: 2.5 });
  // band defaults to the view band (the demo starts in the band mode Auto, SPEC 13)
  assert.equal(p.view.band, 'auto');
  const auto = E.analysis.suggestSpots(ctx, p);
  checkSpots(p, auto, { band: 'auto' });
  assert.deepEqual(auto, E.analysis.suggestSpots(ctx, p, { band: 'auto' }));
  assert.ok(auto.some((s) => s.band === 2.4) && auto.some((s) => s.band === 5), 'near spots on 5 GHz, the far ones on 2.4 GHz');
  assert.deepEqual(
    auto.map((s) => s.kind),
    a.map((s) => s.kind),
  );
  p.view.band = 5;
  assert.deepEqual(E.analysis.suggestSpots(ctx, p), a);
});

test('other plans: busy 3x3 rooms, one open room, a tiny flat, no rooms', () => {
  const b = busy();
  const sb = E.analysis.suggestSpots(M.createContext(b), b);
  assert.equal(sb.length, 5);
  checkSpots(b, sb);
  assert.ok(sb.some((s) => s.kind === 'near') && sb.some((s) => s.kind === 'far'));
  // one big open room without walls: no wall kinds exist, the spots spread out instead
  const open = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], router: [300, 300], baseline: [300, 300] });
  const so = E.analysis.suggestSpots(M.createContext(open), open);
  assert.equal(so.length, 5);
  checkSpots(open, so);
  assert.ok(so.every((s) => s.walls === 0));
  // a tiny flat (2 x 1.6 m, 0.3 m clearance impossible everywhere): the rules relax, spots still come back
  const tiny = makeProject({ rooms: [room(1, 100, 100, 300, 260)], walls: [wall('w1', 100, 100, 300, 100), wall('w2', 300, 100, 300, 260), wall('w3', 300, 260, 100, 260), wall('w4', 100, 260, 100, 100)], router: [130, 130], baseline: [130, 130], mpp: 0.01 });
  const st = E.analysis.suggestSpots(M.createContext(tiny), tiny, { count: 5, minGap: 0.5 });
  assert.ok(st.length >= 1);
  for (const s of st) assert.ok(P.roomAt(tiny.plan, s));
  // no rooms
  const blank = P.create({ template: 'blank' });
  assert.deepEqual(E.analysis.suggestSpots(M.createContext(blank), blank), []);
});

test('the predicted numbers use the calibrated / fitted model (the same as the map)', () => {
  const p = demo();
  const q = P.sanitize({ ...p, model: { ...p.model, fit: { n: 3, wallFactor: 1.4, byBand: { 5: { offset: 6, rms: 1, looRms: 1, count: 5, outliers: [] } }, method: 'offset+n+walls', count: 5, at: 1, fitted: { n: true, wallFactor: true } } } });
  const a = E.analysis.suggestSpots(M.createContext(p), p, { band: 5 });
  const b = E.analysis.suggestSpots(M.createContext(q), q, { band: 5 });
  checkSpots(q, b, { band: 5 });
  assert.notDeepEqual(
    a.map((s) => s.predicted),
    b.map((s) => s.predicted),
  );
});

test('suggestSpots is fast (< 150 ms on the demo and the busy plan)', () => {
  for (const p of [demo(), busy()]) {
    const ctx = M.createContext(p);
    E.analysis.suggestSpots(ctx, p);
    const t0 = performance.now();
    E.analysis.suggestSpots(ctx, p, { count: 6 });
    const dt = performance.now() - t0;
    assert.ok(dt < 150, `${dt.toFixed(1)} ms`);
  }
});
