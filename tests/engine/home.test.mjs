// SPEC 9: speed.homeSummary - "Propustnost bytu" (whole-home throughput).
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';

const M = E.model;
const P = E.project;
const S = E.speed;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

function setup({ fit } = {}) {
  let p = P.create({ template: 'demo', lang: 'cs' });
  const bl = p.net.baseline;
  p.measurements = [
    { id: 'a', x: bl.x + 0.02, y: bl.y, band: 5, value: -45, name: 'u routeru', download: 480, upload: 300, device: 'Telefon', t: 1 },
    { id: 'b', x: 0.8, y: 0.3, band: 5, value: -72, name: 'daleko', download: 60, upload: 20, device: 'Telefon', t: 2 },
    { id: 'c', x: 0.5, y: 0.5, band: 5, value: -60, name: 'mezi', download: 200, upload: 90, device: 'Telefon', t: 3 },
  ];
  if (fit) p.model.fit = fit;
  p = P.sanitize(p);
  const ctx = M.createContext(p);
  const grid = E.raster.grid(ctx, { cell: 4 });
  const offsets = M.offsets(ctx, p);
  const params = M.fieldParams(p, 'today', { offsets });
  const curve = S.buildCurve(S.fillSignals(ctx, p.measurements, { baseline: bl, offsets }), { band: 5, device: 'Telefon' });
  return { p, ctx, grid, params, curve };
}

test('homeSummary: share meeting the target, per-room medians, weakest spot and room', () => {
  const { p, ctx, grid, params, curve } = setup();
  assert.ok(curve);
  const limits = { wanDown: 1000, wanUp: 1000, reserve: 0 };
  const target = { targetDown: 100, targetUp: 50 };
  const h = S.homeSummary(ctx, grid, params, curve, limits, target);
  assert.equal(h.supported, true);
  assert.equal(h.reason, null);
  const sf = S.fieldSpeed(ctx, grid, params, curve, limits);
  const all = S.stats(grid, sf, { roomIds: null, targetDown: 100, targetUp: 50 });
  close(h.areaMeetingTarget, all.coverage, 1e-9, 'area meeting the target');
  close(h.known, all.known, 1e-9);
  assert.equal(h.medianDown, all.medianDown);
  assert.equal(h.perRoom.length, p.plan.rooms.length);
  assert.deepEqual(
    h.perRoom.map((r) => r.roomId),
    p.plan.rooms.map((r) => r.roomId).sort((a, b) => a - b),
  );
  for (const r of h.perRoom) {
    const s = S.stats(grid, sf, { roomIds: [r.roomId], targetDown: 100, targetUp: 50 });
    assert.equal(r.medianDown, s.medianDown);
    assert.equal(r.medianUp, s.medianUp);
    close(r.meets, s.coverage, 1e-9);
    assert.ok(r.meets >= 0 && r.meets <= 100);
  }
  // the weakest spot is the floor cell with the lowest signal
  const field = E.raster.field(ctx, grid, params);
  let min = Infinity;
  for (const i of grid.idx) min = Math.min(min, field[i]);
  assert.equal(h.weakest.signal, min);
  const wi = grid.idx.find((i) => field[i] === min);
  assert.equal(h.weakest.roomId, grid.room[wi]);
  close(h.weakest.x, grid.cx[wi], 1e-6);
  close(h.weakest.y, grid.cy[wi], 1e-6);
  assert.ok(h.weakest.down === null || h.weakest.down <= h.medianDown);
  // the weakest room has the lowest median download (unknown = lowest)
  const rank = (v) => (v === null ? -1 : v);
  for (const r of h.perRoom) assert.ok(rank(h.weakestRoom.medianDown) <= rank(r.medianDown));
  assert.deepEqual(h.target, { down: 100, up: 50 });
  // the signal field can be handed in (a.today) - same answer, no recomputation
  assert.deepEqual(S.homeSummary(ctx, grid, params, curve, limits, target, field), h);
});

test('homeSummary: plan limit detection, rooms / excluded, unsupported cases', () => {
  const { p, ctx, grid, params, curve } = setup();
  const target = { targetDown: 100, targetUp: 50 };
  const free = S.homeSummary(ctx, grid, params, curve, { reserve: 0 }, target);
  assert.equal(free.limitedByPlan, false);
  assert.equal(free.planLimitedShare, 0);
  assert.deepEqual(free.planCap, { down: null, up: null });
  // a 50/10 plan: the Wi-Fi gives more than that almost everywhere it is known
  const slow = S.homeSummary(ctx, grid, params, curve, { wanDown: 50, wanUp: 10, reserve: 0 }, target);
  assert.equal(slow.limitedByPlan, true);
  assert.ok(slow.known > 0 && slow.known < 100, `known ${slow.known}`);
  close(slow.planLimitedShare, slow.known, 1e-9, 'every cell with a known speed is limited by the plan');
  // a plan just above what the Wi-Fi gives near the router: limited only near it
  const fast = S.homeSummary(ctx, grid, params, curve, { wanDown: 500, wanUp: 320, reserve: 0 }, target);
  assert.ok(fast.planLimitedShare > 0 && fast.planLimitedShare < fast.known / 2, `share ${fast.planLimitedShare}`);
  assert.equal(fast.limitedByPlan, false);
  assert.deepEqual(slow.planCap, { down: 50, up: 10 });
  assert.equal(slow.areaMeetingTarget, 0, 'a 50 Mb/s plan never meets 100 Mb/s');
  // a WAN port limit counts like the plan
  assert.equal(S.homeSummary(ctx, grid, params, curve, { wanPort: 100, reserve: 0 }, target).planCap.down, 100);
  // rooms
  const ids = p.plan.rooms.map((r) => r.roomId);
  const one = S.homeSummary(ctx, grid, params, curve, {}, { ...target, roomIds: [ids[0]] });
  assert.deepEqual(
    one.perRoom.map((r) => r.roomId),
    [ids[0]],
  );
  assert.equal(one.weakest.roomId, ids[0]);
  const ex = S.homeSummary(ctx, grid, params, curve, {}, { ...target, excluded: [ids[1]] });
  assert.ok(!ex.perRoom.some((r) => r.roomId === ids[1]));
  // unsupported
  const none = S.homeSummary(ctx, grid, params, null, {}, target);
  assert.equal(none.supported, false);
  assert.equal(none.reason, 'curve');
  assert.deepEqual(none.perRoom, []);
  assert.equal(none.weakest, null);
  // a second node is supported since SPEC 10 (its area goes through the node's link)
  const far = P.nearestFloor(p.plan, { x: 0.8, y: 0.3 });
  const node = S.homeSummary(ctx, grid, { ...params, node: { mode: 'ap_cable', pos: far, power: 0, bands: { '2.4': true, 5: true, 6: false } } }, curve, {}, target);
  assert.equal(node.supported, true);
  assert.equal(node.reason, null);
  assert.ok(node.nodeShare > 0 && node.link && node.link.wireless === false);
  // odd input: a reason, never an exception
  assert.equal(S.homeSummary(ctx, null, params, curve, {}, target).reason, 'params');
  assert.equal(S.homeSummary(ctx, grid, null, curve, {}, target).reason, 'params');
  assert.equal(S.homeSummary(ctx, grid, params, { download: [] }, {}, target).reason, 'curve');
  // defaults of the target
  assert.deepEqual(S.homeSummary(ctx, grid, params, curve, {}, null).target, { down: 50, up: 50 });
});

test('homeSummary uses the calibrated / fitted signal (one source of truth)', () => {
  const a = setup();
  const b = setup({ fit: { n: 3.2, wallFactor: 1.5, byBand: {}, method: 'offset+n+walls', count: 5, at: 1, fitted: { n: true, wallFactor: true } } });
  const t = { targetDown: 100, targetUp: 50 };
  const ha = S.homeSummary(a.ctx, a.grid, a.params, a.curve, {}, t);
  const hb = S.homeSummary(b.ctx, b.grid, b.params, b.curve, {}, t);
  assert.ok(hb.weakest.signal < ha.weakest.signal, 'a steeper decay and stronger walls make the weakest spot weaker');
});
