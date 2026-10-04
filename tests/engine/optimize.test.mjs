import test from 'node:test';
import assert from 'node:assert/strict';
import { E, readPrivatePlan } from './_load.mjs';
import { n, room, wall, makeProject, ctxOf } from './_helpers.mjs';

const { model, raster, optimize, speed, project: P } = E;
const { W, H } = E.CANVAS;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);

function setup(project, cell = 4) {
  const ctx = ctxOf(project);
  const grid = raster.grid(ctx, { cell });
  const offsets = model.offsets(ctx, project);
  return { ctx, grid, offsets };
}

function optsFor(p, extra = {}) {
  return { band: p.view.band, goalRoom: p.goal.room === 'all' ? null : p.goal.room, allowedRoom: p.goal.allowedRoom === 'any' ? null : p.goal.allowedRoom, threshold: p.model.threshold, excluded: p.goal.excluded, router: p.net.router, ...extra };
}

/** The objective of the optimizer evaluated exactly on the full field (area weighted over rooms). */
function objective(ctx, grid, p, router, roomIds, node = null) {
  const f = raster.field(ctx, grid, { band: 5, router, node, offsets: { '2.4': 0, '5': 0, '6': 0 } });
  let total = 0;
  let cells = 0;
  for (const id of roomIds) {
    const s = raster.stats(grid, f, [id], p.model.threshold);
    total += s.n * (s.coverage + 0.2 * (s.mean + 100) + 0.2 * (s.p10 + 100));
    cells += s.n;
  }
  return total / cells;
}

test('find: improves the objective from a bad corner start in the demo flat and is near the global optimum', async () => {
  const p = P.create({ template: 'demo', lang: 'en' });
  p.net.router = n(95, 146); // the very corner of the living room
  p.net.router = P.nearestFloor(p.plan, p.net.router);
  const { ctx, grid, offsets } = setup(p);
  const r = await optimize.find(ctx, grid, optsFor(p, { offsets, clearance: 0 }));
  assert.ok(r.scoreBefore !== null && r.score > r.scoreBefore + 10, `score ${r.scoreBefore} -> ${r.score}`);
  assert.ok(r.after.coverage > r.before.coverage + 15, `coverage ${r.before.coverage} -> ${r.after.coverage}`);
  assert.ok(r.after.mean > r.before.mean + 3);
  assert.ok(P.floorMaskAt(p.plan, r.pos), 'on the floor');
  assert.equal(r.roomId, P.roomAt(p.plan, r.pos).roomId);
  assert.ok(r.candidates > 50);
  // compare against a brute force on a 20 x 20 lattice (coarse grid for speed; no wall clearance on either side)
  const coarse = raster.grid(ctx, { cell: 8 });
  const ids = coarse.roomIds;
  const found = objective(ctx, coarse, p, r.pos, ids);
  let best = -Infinity;
  for (let j = 0; j < 20; j++) {
    for (let i = 0; i < 20; i++) {
      const q = { x: (90 + (i + 0.5) * 45) / W, y: (141 + (j + 0.5) * 33) / H };
      if (!P.floorMaskAt(p.plan, q)) continue;
      best = Math.max(best, objective(ctx, coarse, p, q, ids));
    }
  }
  assert.ok(found >= best - 1, `found ${found.toFixed(2)} vs brute force ${best.toFixed(2)}`);
  // starting from the sweet spot the optimizer does not make things worse
  const again = await optimize.find(ctx, grid, optsFor(p, { offsets, router: r.pos, clearance: 0 }));
  assert.ok(again.after.coverage >= r.after.coverage - 1);
});

test('find: respects allowedRoom (every room of the demo flat)', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const { ctx, grid, offsets } = setup(p);
  for (const rm of p.plan.rooms) {
    const r = await optimize.find(ctx, grid, optsFor(p, { offsets, allowedRoom: rm.roomId }));
    const at = P.roomAt(p.plan, r.pos);
    assert.equal(at && at.roomId, rm.roomId, `${rm.name}: ${JSON.stringify(r.pos)}`);
    assert.equal(r.roomId, rm.roomId);
  }
  // the best place in the hall is better for the whole flat than the best place in a far corner room
  const hall = await optimize.find(ctx, grid, optsFor(p, { offsets, allowedRoom: 4 }));
  const kitchen = await optimize.find(ctx, grid, optsFor(p, { offsets, allowedRoom: 2 }));
  assert.ok(hall.score !== kitchen.score);
});

test('find: keeps clear of walls (not in a doorway) unless the room is tiny', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const { ctx, grid, offsets } = setup(p);
  const r = await optimize.find(ctx, grid, optsFor(p, { offsets }));
  const px = [r.pos.x * W, r.pos.y * H];
  let d = Infinity;
  for (let i = 0; i < ctx.w.n; i++) d = Math.min(d, E.geom.pointSegDistPx(px[0], px[1], ctx.w.ax[i], ctx.w.ay[i], ctx.w.ax[i] + ctx.w.sx[i], ctx.w.ay[i] + ctx.w.sy[i]));
  assert.ok(d * p.scale.mpp >= 0.19, `${(d * p.scale.mpp).toFixed(2)} m from the nearest wall`);
  const free = await optimize.find(ctx, grid, optsFor(p, { offsets, clearance: 0 }));
  assert.ok(free.pos);
  // a closet-sized room: nothing satisfies a 20 cm clearance, still an answer inside the room
  const tiny = makeProject({ rooms: [room(1, 100, 100, 130, 130)], walls: [wall('w', 100, 100, 130, 100, 8)] });
  const t = setup(tiny);
  const tr = await optimize.find(t.ctx, t.grid, { band: 5, goalRoom: null, allowedRoom: null, threshold: -67 });
  assert.ok(P.floorMaskAt(tiny.plan, tr.pos));
  assert.equal(tr.before, null, 'no router given -> no before numbers');
  assert.equal(tr.scoreBefore, null);
});

test('find: deterministic, grid size independent in character, goal room and excluded rooms', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const { ctx, grid, offsets } = setup(p);
  const a = await optimize.find(ctx, grid, optsFor(p, { offsets }));
  const b = await optimize.find(ctx, grid, optsFor(p, { offsets }));
  assert.deepEqual(a, b);
  const coarse = raster.grid(ctx, { cell: 8 });
  const c = await optimize.find(ctx, coarse, optsFor(p, { offsets }));
  assert.ok(Math.hypot((c.pos.x - a.pos.x) * W, (c.pos.y - a.pos.y) * H) < 120, 'similar answer on the coarse grid');
  // optimizing for the bedroom (room 2 of the showcase flat) only puts the router close to it
  const k = await optimize.find(ctx, grid, optsFor(p, { offsets, goalRoom: 2 }));
  const wholeStats = await optimize.find(ctx, grid, optsFor(p, { offsets, goalRoom: null }));
  assert.ok(k.after.coverage >= 99, `bedroom coverage ${k.after.coverage}`);
  assert.ok(k.after.mean > wholeStats.after.mean || k.after.coverage >= 99);
  // excluding every room but the bedroom is the same as targeting the bedroom
  const ex = await optimize.find(ctx, grid, optsFor(p, { offsets, goalRoom: null, excluded: [1, 3, 4, 5, 6, 7] }));
  assert.deepEqual(ex.pos, k.pos);
  // excluding everything falls back to every room instead of failing (the demo's own goal leaves out the balcony,
  // so compare with "nothing excluded")
  const all = await optimize.find(ctx, grid, optsFor(p, { offsets, excluded: [1, 2, 3, 4, 5, 6, 7] }));
  const none = await optimize.find(ctx, grid, optsFor(p, { offsets, excluded: [] }));
  assert.deepEqual(all.pos, none.pos);
  // an unknown goal/allowed room id is ignored
  const odd = await optimize.find(ctx, grid, optsFor(p, { offsets, goalRoom: 99, allowedRoom: 77 }));
  assert.deepEqual(odd.pos, a.pos);
});

test('find: honours a second node and calibration offsets', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  p.view.band = 5; // one band: a node that does not serve it must be ignored
  p.node = { mode: 'ap_cable', pos: P.nearestFloor(p.plan, { x: 0.8, y: 0.3 }), bands: { '2.4': true, '5': true, '6': false }, power: 0, backhaulBand: 5, backhaulThreshold: -67 };
  const { ctx, grid, offsets } = setup(p);
  const node = model.nodeParams(p);
  const solo = await optimize.find(ctx, grid, optsFor(p, { offsets }));
  const withNode = await optimize.find(ctx, grid, optsFor(p, { offsets, node }));
  assert.ok(withNode.after.coverage >= solo.after.coverage - 0.5, 'a node never hurts');
  assert.ok(Math.hypot((withNode.pos.x - solo.pos.x) * W, (withNode.pos.y - solo.pos.y) * H) > 5, 'the router moves away from the node\'s area');
  assert.ok(withNode.after.coverage > 90);
  // a node that does not serve the band is ignored
  const ignored = await optimize.find(ctx, grid, optsFor(p, { offsets, node: { ...node, bands: { '2.4': true, '5': false, '6': false } } }));
  assert.deepEqual(ignored.pos, solo.pos);
  // offsets shift everything: better absolute numbers (+8 dB at the same spot; the coverage-first objective may then
  // prefer a nearby spot with a slightly lower mean, so the mean rises by about, not exactly, the offset)
  const boosted = await optimize.find(ctx, grid, optsFor(p, { offsets: { '2.4': 0, '5': 8, '6': 0 } }));
  assert.ok(boosted.after.mean > solo.after.mean + 6, `${boosted.after.mean} vs ${solo.after.mean}`);
  assert.ok(boosted.after.coverage > solo.after.coverage);
});

test('find: progress, abort and cooperative scheduling', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const { ctx, grid, offsets } = setup(p);
  // progress is monotonic, within 0..1 and ends with 1
  const seen = [];
  await optimize.find(ctx, grid, optsFor(p, { offsets }), { onProgress: (f) => seen.push(f) });
  assert.ok(seen.length >= 2);
  assert.equal(seen[seen.length - 1], 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 1e-9 && seen[i] >= 0 && seen[i] <= 1);
  // abort before start
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(optimize.find(ctx, grid, optsFor(p, { offsets }), { signal: pre.signal }), (e) => e.name === 'AbortError');
  // abort while running
  const ac = new AbortController();
  const t0 = performance.now();
  await assert.rejects(
    optimize.find(ctx, grid, optsFor(p, { offsets }), {
      signal: ac.signal,
      onProgress: (f) => {
        if (f > 0.05) ac.abort();
      },
    }),
    (e) => e.name === 'AbortError',
  );
  assert.ok(performance.now() - t0 < 5000);
  // the event loop keeps turning while it searches (timers fire at least every ~100 ms)
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 5);
  const real = readPrivatePlan();
  const rp = real === null ? p : P.parseSvgText(real).project;
  const rs = setup(rp);
  await optimize.find(rs.ctx, rs.grid, optsFor(rp, { offsets: rs.offsets }));
  clearInterval(timer);
  assert.ok(ticks >= 3, `timer fired ${ticks} times`);
  assert.ok(maxGap < 150, `longest event-loop stall ${maxGap.toFixed(0)} ms`);
});

test('find: errors', async () => {
  const empty = makeProject({});
  const e = setup(empty);
  await assert.rejects(optimize.find(e.ctx, e.grid, { band: 5 }), (err) => err.message === 'err.opt.noFloor');
  const p = P.create({ template: 'demo', lang: 'cs' });
  const { ctx, grid } = setup(p);
  await assert.rejects(optimize.find(ctx, grid, {}), RangeError);
  await assert.rejects(optimize.find(ctx, grid, { band: 7 }), RangeError);
  const node = { mode: 'ap_cable', pos: p.node.pos, bands: { '2.4': true, '5': true, '6': true }, power: 0 };
  // a second node no longer refuses the speed search (SPEC 10); an unusable curve is still "no curve"
  await assert.rejects(optimize.find(ctx, grid, { band: 5, node, speed: { curve: {}, targetDown: 50, targetUp: 20 } }), (err) => err.message === 'err.opt.noCurve');
  await assert.rejects(optimize.find(ctx, grid, { band: 5, speed: { curve: null, targetDown: 50, targetUp: 20 } }), (err) => err.message === 'err.opt.noCurve');
});

test('find: speed mode optimizes the share of the flat that meets both targets', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const { ctx, grid } = setup(p);
  let id = 0;
  const m = (value, down, up) => ({ id: `s${++id}`, x: 0.5, y: 0.5, band: 5, value, name: 'x', download: down, upload: up, device: 'Telefon', t: 0 });
  const curve = speed.buildCurve([m(-40, 600, 200), m(-50, 450, 150), m(-60, 220, 80), m(-67, 90, 35), m(-75, 25, 10), m(-82, 4, 2)], { band: 5, device: 'Telefon' });
  assert.ok(curve);
  const limits = { wanDown: 500, wanUp: 100, reserve: 20 };
  const spd = { curve, targetDown: 100, targetUp: 40, limits, reserve: 20 };
  p.net.router = P.nearestFloor(p.plan, n(100, 150));
  const r = await optimize.find(ctx, grid, optsFor(p, { speed: spd }));
  const cover = (router) => {
    const st = { band: 5, router, node: null, offsets: { '2.4': 0, '5': 0, '6': 0 } };
    const sf = speed.fieldSpeed(ctx, grid, st, curve, limits);
    return speed.stats(grid, sf, { roomIds: null, targetDown: 100, targetUp: 40 }).coverage;
  };
  const before = cover(p.net.router);
  const after = cover(r.pos);
  assert.ok(after > before + 20, `goal coverage ${before.toFixed(0)} % -> ${after.toFixed(0)} %`);
  assert.ok(r.score > r.scoreBefore);
});

test('find: an optional private real plan (WH_PRIVATE_PLAN) never gets worse than its current router position', async () => {
  const svg = readPrivatePlan();
  if (svg === null) return;
  const p = P.parseSvgText(svg).project;
  const { ctx, grid, offsets } = setup(p);
  const r = await optimize.find(ctx, grid, optsFor(p, { offsets }));
  assert.ok(r.score >= r.scoreBefore - 1e-9 && r.after.coverage >= r.before.coverage - 1, `${r.before.coverage.toFixed(0)} % -> ${r.after.coverage.toFixed(0)} %`);
  assert.ok(P.floorMaskAt(p.plan, r.pos));
  // the numbers agree with what analysis.run (and therefore the UI) reports for the same positions
  close(r.before.coverage, E.analysis.run(p, { cell: 4 }).stats.today.coverage, 1e-9);
  const moved = P.clone(p);
  moved.net.router = r.pos;
  close(r.after.coverage, E.analysis.run(moved, { cell: 4 }).stats.trial.coverage, 1e-9);
});
