import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, door, furn, makeProject, ctxOf, busyPlan, rng } from './_helpers.mjs';
import { legacyWallLoss } from './_legacy.mjs';

const { model, raster, project: P } = E;
const { W, H } = E.CANVAS;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);

function params(p, which = 'trial', band = 5, offsets) {
  return model.fieldParams(p, which, { band, offsets });
}
/** The exact ray tracer without diffraction softening: the tests of the tracer itself use it. */
const HARD = { soften: 0 };

// ---------------------------------------------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------------------------------------------

test('grid: 270 x 236 cells at cell=4, 135 x 118 at cell=8, floor cells match roomAt', () => {
  const b = busyPlan();
  const p = makeProject({ rooms: b.rooms, walls: b.walls, router: [550, 450] });
  const c = ctxOf(p);
  const g = raster.grid(c, { cell: 4 });
  assert.equal(g.cols, 270);
  assert.equal(g.rows, 236);
  assert.equal(g.cell, 4);
  assert.equal(g.room.length, 270 * 236);
  const g8 = raster.grid(c, { cell: 8 });
  assert.equal(g8.cols, 135);
  assert.equal(g8.rows, 118);
  assert.equal(raster.grid(c).cols, 270, 'default cell is 4');
  // the flat spans 900 x 690 px
  assert.ok(Math.abs(g.count * 16 - 900 * 690) < 900 * 4 * 2 + 690 * 4 * 2, `area ${g.count * 16}`);
  assert.equal(g.areaPx, g.count * 16);
  // consistency with the exact point-in-polygon rule
  const r = rng(11);
  let mismatches = 0;
  for (let k = 0; k < 4000; k++) {
    const i = Math.floor(r() * g.cols * g.rows);
    const rm = P.roomAt(p.plan, { x: g.cx[i], y: g.cy[i] });
    if ((rm ? rm.roomId : 0) !== g.room[i]) mismatches++;
  }
  assert.equal(mismatches, 0);
  // idx / roomCells bookkeeping
  assert.equal(g.idx.length, g.count);
  let sum = 0;
  for (const id of g.roomIds) sum += g.roomCells.get(id).length;
  assert.equal(sum, g.count);
  assert.deepEqual(g.roomIds, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (let m = 1; m < g.idx.length; m++) assert.ok(g.idx[m] > g.idx[m - 1], 'idx ascending');
  // normalized centres
  close(g.cx[0], 2 / W, 1e-6);
  close(g.cy[g.cols], 6 / H, 1e-6);
});

test('grid: L-shaped room and overlapping rooms (last one wins)', () => {
  const L = { id: 'room-1', type: 'room', roomId: 1, name: 'L', color: '#8eadd2', points: [n(100, 100), n(500, 100), n(500, 300), n(300, 300), n(300, 500), n(100, 500)] };
  const over = room(2, 400, 200, 700, 400);
  const p = makeProject({ rooms: [L, over] });
  const g = raster.grid(ctxOf(p));
  const at = (x, y) => g.room[Math.floor(y / 4) * g.cols + Math.floor(x / 4)];
  assert.equal(at(200, 200), 1);
  assert.equal(at(450, 350), 2);
  assert.equal(at(450, 250), 2, 'overlap belongs to the later room');
  assert.equal(at(450, 150), 1);
  assert.equal(at(400, 450), 0, 'notch of the L is not floor');
  assert.equal(at(50, 50), 0);
});

test('grid cache is keyed on the room outlines and cell size only', () => {
  const p1 = makeProject({ rooms: [room(1, 100, 100, 500, 400)], walls: [wall('w', 300, 100, 300, 400, 8)], router: [200, 200] });
  const p2 = makeProject({ rooms: [room(1, 100, 100, 500, 400)], walls: [wall('w', 320, 100, 320, 400, 9)], router: [250, 250], model: { n: 3 } });
  const g1 = raster.grid(ctxOf(p1), { cell: 4 });
  assert.equal(raster.grid(ctxOf(p2), { cell: 4 }), g1, 'same rooms -> same cached grid');
  assert.notEqual(raster.grid(ctxOf(p2), { cell: 8 }), g1);
  const p3 = makeProject({ rooms: [room(1, 100, 100, 510, 400)] });
  assert.notEqual(raster.grid(ctxOf(p3), { cell: 4 }), g1);
});

test('grid without rooms is empty but valid', () => {
  const p = makeProject({});
  const g = raster.grid(ctxOf(p));
  assert.equal(g.count, 0);
  assert.equal(g.idx.length, 0);
  const f = raster.field(ctxOf(p), g, { band: 5, router: { x: 0.5, y: 0.5 }, offsets: {} });
  assert.equal(f.length, g.cols * g.rows);
  assert.ok(f.every(Number.isNaN));
  assert.deepEqual(raster.stats(g, f, null, -67), { coverage: 0, mean: -110, median: -110, p10: -110, n: 0 });
});

// ---------------------------------------------------------------------------------------------------------------
// field
// ---------------------------------------------------------------------------------------------------------------

test('field (soften 0): NaN outside rooms, equals model.signal at the cell centres, reuses a buffer', () => {
  const b = busyPlan();
  const p = makeProject({ rooms: b.rooms, walls: b.walls, furniture: b.furniture, router: [550, 450], baseline: [550, 450] });
  const c = ctxOf(p);
  const g = raster.grid(c);
  const st = { ...params(p, 'trial', 5, { '2.4': 0, '5': -3.5, '6': 0 }), ...HARD };
  const f = raster.field(c, g, st);
  assert.ok(f instanceof Float32Array);
  assert.equal(f.length, g.cols * g.rows);
  let outsideNaN = 0;
  for (let i = 0; i < f.length; i++) if (!g.room[i] && Number.isNaN(f[i])) outsideNaN++;
  assert.equal(outsideNaN, f.length - g.count);
  const r = rng(5);
  for (let k = 0; k < 300; k++) {
    const i = g.idx[Math.floor(r() * g.idx.length)];
    const row = Math.floor(i / g.cols);
    const col = i - row * g.cols;
    const expected = model.signal(c, p.net.router, n(g.colPx[col], g.rowPx[row]), 5, -3.5);
    close(f[i], expected, 2e-4);
  }
  assert.ok(f[g.idx[0]] >= -110 && f[g.idx[0]] <= -20);
  const buf = new Float32Array(g.cols * g.rows);
  assert.equal(raster.field(c, g, st, buf), buf, 'reuse returns the same buffer');
  assert.deepEqual(Array.from(buf.slice(0, 5000)), Array.from(f.slice(0, 5000)).map((v) => v), 'same contents');
  assert.throws(() => raster.field(c, g, { router: p.net.router }), RangeError);
});

test('field: a second node can only improve the signal and marks where it wins', () => {
  const b = busyPlan();
  const p = makeProject({
    rooms: b.rooms,
    walls: b.walls,
    router: [200, 200],
    node: { mode: 'ap_cable', pos: n(880, 680), bands: { '2.4': true, '5': true, '6': false }, power: 0, backhaulBand: 5, backhaulThreshold: -67 },
  });
  p.nodes[0].pos = n(880, 680);
  const c = ctxOf(p);
  const g = raster.grid(c);
  const solo = raster.field(c, g, params(p, 'today', 5));
  const withNode = raster.fieldEx(c, g, params(p, 'trial', 5));
  let wins = 0;
  for (const i of g.idx) {
    assert.ok(withNode.field[i] >= solo[i] - 1e-6);
    if (withNode.nodeWins[i]) {
      wins++;
      assert.ok(withNode.field[i] > solo[i]);
    }
  }
  assert.ok(wins > g.count * 0.1, `node wins ${wins}`);
  // 6 GHz: node does not serve it -> identical fields, no nodeWins array
  const f6 = raster.fieldEx(c, g, params(p, 'trial', 6));
  assert.equal(f6.nodeWins, null);
});

// ---------------------------------------------------------------------------------------------------------------
// artifacts: smoothness and robustness against imperfect corners (the core complaint about the legacy app)
// ---------------------------------------------------------------------------------------------------------------

/** Largest |difference| between 4-neighbour floor cells; whether that pair straddles a wall; how many pairs jump > 3 dB without a wall between them. */
function maxNeighbourJump(ctx, g, f) {
  let max = 0;
  let worst = { where: null, straddles: false };
  let pairs = 0;
  let big = 0;
  let huge = 0;
  for (const i of g.idx) {
    const row = Math.floor(i / g.cols);
    const col = i - row * g.cols;
    for (const j of [i + 1, i + g.cols]) {
      if (j >= f.length || !g.room[j]) continue;
      if (j === i + 1 && col === g.cols - 1) continue;
      const d = Math.abs(f[i] - f[j]);
      pairs++;
      if (d > 3 || d > max) {
        const rj = Math.floor(j / g.cols);
        const cj = j - rj * g.cols;
        const straddles = E.model.traceLoss(ctx, g.colPx[col], g.rowPx[row], g.colPx[cj], g.rowPx[rj]) > 0.5;
        if (d > 3 && !straddles) big++; // a big jump that is not explained by a wall between the two cells
        if (d > 6 && !straddles) huge++;
        if (d > max) {
          max = d;
          worst = { where: [col, row, j - i === 1 ? 'x' : 'y'], straddles };
        }
      }
    }
  }
  worst.pairs = pairs;
  worst.big = big;
  worst.huge = huge;
  return { max, worst };
}

const WALL_LOSS = 8;
function rectPlanRaw({ gap = 0 } = {}) {
  const b = busyPlan({ gap });
  return { rooms: b.rooms, walls: b.walls };
}

test('artifacts (tracer, soften 0): neighbouring cells never jump by more than a wall + decay step + 1 dB (2 walls when they straddle one)', () => {
  const stats = { pairs: 0, big: 0, huge: 0 };
  for (const aa of [1, 2]) {
    for (const gap of [0, 1, 1.3, -1.5]) {
      const { rooms, walls } = rectPlanRaw({ gap });
      for (const router of [[250, 215], [550, 450], [851, 677], [405, 332]]) {
        const p = makeProject({ rooms, walls, router });
        const c = ctxOf(p);
        const g = raster.grid(c);
        const f = raster.field(c, g, { ...params(p), aa, ...HARD });
        const decayStep = 10 * p.model.n * Math.log10(1 + 4 * p.scale.mpp); // worst case: 1 m from the router
        const { max, worst } = maxNeighbourJump(c, g, f);
        // A pair that straddles a real wall may differ by that wall, plus one more wall where the ray also slides past a
        // junction ("one obstacle" <-> "two walls"); pairs that do not straddle a wall: one wall at most. With aa=1 two
        // junctions that happen to line up with the router can flip at once (this plan is perfectly symmetric).
        const bound = (aa === 1 || worst.straddles ? 2 : 1) * WALL_LOSS + decayStep + 1;
        assert.ok(max <= bound + 1e-9, `aa=${aa} gap=${gap} router=${router} jump ${max.toFixed(2)} dB (limit ${bound.toFixed(1)}) at ${worst.where}`);
        if (aa === 2) {
          stats.pairs += worst.pairs;
          stats.big += worst.big;
          stats.huge += worst.huge;
        }
      }
    }
  }
  // The shadow lines that radiate from wall junctions (a ray squeezing past a corner) are real but thin; after
  // anti-aliasing at most ~1 % of the neighbour pairs differ by > 3 dB without a wall in between and almost none by > 6 dB.
  console.log(`  [artifacts] aa=2: ${stats.big} of ${stats.pairs} neighbour pairs jump > 3 dB (${stats.huge} > 6 dB) without a wall in between`);
  assert.ok(stats.big / stats.pairs < 0.02, `${stats.big} of ${stats.pairs} pairs jump > 3 dB`);
  assert.ok(stats.huge / stats.pairs < 0.001, `${stats.huge} of ${stats.pairs} pairs jump > 6 dB`);
});

test('artifacts (tracer, soften 0): imperfect corners (gaps up to 2.6 px, overshoots) give the same heat map as perfect ones', () => {
  const perfect = rectPlanRaw({ gap: 0 });
  const pp = makeProject({ ...perfect, router: [550, 450] });
  const cp = ctxOf(pp);
  const g = raster.grid(cp);
  const fp = raster.field(cp, g, { ...params(pp), ...HARD });
  for (const gap of [0.8, 1.3, -1.5, -3]) {
    const sloppy = rectPlanRaw({ gap });
    const ps = makeProject({ ...sloppy, router: [550, 450] });
    const cs = ctxOf(ps);
    const fs = raster.field(cs, g, { ...params(ps), ...HARD });
    let bad = 0;
    let max = 0;
    for (const i of g.idx) {
      const d = Math.abs(fp[i] - fs[i]);
      if (d > 0.5) bad++;
      if (d > max) max = d;
    }
    // overshoots poke out of the building by up to 3 px and may touch a ray there; allow a tiny fraction of cells
    assert.ok(bad / g.count < 0.002, `gap=${gap}: ${bad} of ${g.count} cells differ by more than 0.5 dB (max ${max.toFixed(1)})`);
  }
});

test('artifacts: the legacy tracer leaks through the same imperfect corners (regression guard for the test itself)', () => {
  const router = [550, 450];
  const fieldWith = (gap, legacy) => {
    const p = makeProject({ ...rectPlanRaw({ gap }), router });
    const c = ctxOf(p);
    const g = raster.grid(c);
    if (!legacy) return { g, f: raster.field(c, g, { ...params(p), ...HARD }) };
    const f = new Float32Array(g.cols * g.rows).fill(NaN);
    for (const i of g.idx) {
      const row = Math.floor(i / g.cols);
      const col = i - row * g.cols;
      const to = { x: g.colPx[col] / W, y: g.rowPx[row] / H };
      const dm = Math.hypot((to.x - p.net.router.x) * W, (to.y - p.net.router.y) * H) * p.scale.mpp;
      f[i] = Math.max(-110, Math.min(-20, -40 - 22 * Math.log10(Math.max(1, dm)) - legacyWallLoss(p.plan.walls, p.model.wallLoss, p.net.router, to)));
    }
    return { g, f };
  };
  const count = (a, b, g) => g.idx.reduce((k, i) => k + (Math.abs(a[i] - b[i]) > 0.5 ? 1 : 0), 0);
  const o0 = fieldWith(0, true);
  const o1 = fieldWith(1.3, true);
  const n0 = fieldWith(0, false);
  const n1 = fieldWith(1.3, false);
  const legacyDiff = count(o0.f, o1.f, o0.g);
  const newDiff = count(n0.f, n1.f, n0.g);
  assert.ok(legacyDiff > 100, `the legacy tracer should show the leak (${legacyDiff} cells differ)`);
  assert.equal(newDiff, 0);
});

test('artifacts: a router in a closed room covers it strictly better than any neighbouring room', () => {
  const { rooms, walls } = rectPlanRaw({ gap: 0 });
  const p = makeProject({ rooms, walls, router: [550, 445], model: { threshold: -55 } });
  const c = ctxOf(p);
  const g = raster.grid(c);
  const f = raster.field(c, g, params(p));
  const per = raster.perRoom(g, f, p.model.threshold);
  const centre = per.get(5);
  for (const other of [2, 4, 6, 8]) {
    const o = per.get(other);
    assert.ok(centre.mean > o.mean + 5, `mean room5 ${centre.mean.toFixed(1)} vs room${other} ${o.mean.toFixed(1)}`);
    assert.ok(centre.coverage > o.coverage, `coverage room5 ${centre.coverage} vs room${other} ${o.coverage}`);
    assert.ok(centre.p10 > o.p10);
  }
  // diagonal neighbours are weaker than edge neighbours (two walls vs one)
  assert.ok(per.get(2).mean > per.get(1).mean);
});

test('artifacts: signal never gets better behind a closed wall at the same distance (exact and softened)', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls: [wall('w', 600, 100, 600, 800, 8)], router: [300, 450] });
  const c = ctxOf(p);
  const g = raster.grid(c);
  for (const extra of [HARD, {}]) {
    const f = raster.field(c, g, { ...params(p), ...extra });
    const at = (x, y) => f[Math.floor(y / 4) * g.cols + Math.floor(x / 4)];
    for (const y of [150, 300, 450, 600, 750]) {
      // the step across the wall itself: the right side is 8 dB lower. The wall runs INSIDE the room, so the softening
      // must keep it a sharp step.
      const before = at(596, y);
      const after = at(604, y);
      assert.ok(before - after > 7 && before - after < 9.5, `soften=${extra.soften}: drop at y=${y}: ${(before - after).toFixed(2)}`);
    }
  }
});

test('artifacts: the heat map is symmetric for a symmetric plan', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls: [wall('w', 550, 100, 550, 800, 8)], furniture: [furn('f1', 200, 200, 300, 260, 5), furn('f2', 800, 200, 900, 260, 5)], router: [550, 450] });
  const c = ctxOf(p);
  const g = raster.grid(c);
  for (const extra of [HARD, {}]) {
    const f = raster.field(c, g, { ...params(p), ...extra });
    // plan spans x 100..1000, mirror axis x=550 (cell index: 550/4 = 137.5 -> mirror col c <-> 274 - c ... use centres)
    let worst = 0;
    for (const i of g.idx) {
      const row = Math.floor(i / g.cols);
      const col = i - row * g.cols;
      const mirrorX = 1100 - g.colPx[col];
      const mc = Math.round(mirrorX / 4 - 0.5);
      const j = row * g.cols + mc;
      if (!g.room[j]) continue;
      const d = Math.abs(f[i] - f[j]);
      if (d > worst) worst = d;
    }
    assert.ok(worst < 1.2, `soften=${extra.soften}: mirror difference ${worst}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------------------------------------------

test('performance: field() on a 270x236 grid with ~20 walls and ~20 furniture is below 150 ms', (t) => {
  const b = busyPlan();
  const extra = [wall('x1', 150, 215, 300, 215, 3), wall('x2', 850, 677, 950, 677, 3), wall('x3', 550, 400, 550, 500, 3), wall('x4', 450, 600, 650, 600, 3)];
  const p = makeProject({ rooms: b.rooms, walls: [...b.walls, ...extra], furniture: b.furniture, router: [550, 450] });
  assert.ok(p.plan.walls.length >= 20 && p.plan.furniture.length >= 20);
  const c = ctxOf(p);
  const g = raster.grid(c, { cell: 4 });
  assert.equal(g.cols * g.rows, 270 * 236);
  const st = { ...params(p), ...HARD };
  const buf = new Float32Array(g.cols * g.rows);
  raster.field(c, g, st, buf); // warm up the JIT
  const times = [];
  for (let k = 0; k < 7; k++) {
    const t0 = performance.now();
    raster.field(c, g, st, buf);
    times.push(performance.now() - t0);
  }
  times.sort((a, b2) => a - b2);
  const median = times[3];
  const coarse = raster.grid(c, { cell: 8 });
  const t1 = performance.now();
  raster.field(c, coarse, st);
  const coarseMs = performance.now() - t1;
  const t2 = performance.now();
  const cold = model.createContext(p);
  const grid2 = raster.grid(cold, { cell: 4 });
  const ctxMs = performance.now() - t2;
  const softSt = params(p);
  raster.field(c, g, softSt, buf);
  const t3 = performance.now();
  raster.field(c, g, softSt, buf);
  const softMs = performance.now() - t3;
  console.log(`  [perf] softened field cell=4 ${softMs.toFixed(1)} ms`);
  assert.ok(softMs < 150, `softened ${softMs} ms`);
  t.diagnostic(`field cell=4: median ${median.toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times[6].toFixed(1)}), cell=8: ${coarseMs.toFixed(1)} ms, ctx+cached grid: ${ctxMs.toFixed(2)} ms, ${g.count} floor cells`);
  console.log(`  [perf] field cell=4 median ${median.toFixed(1)} ms, cell=8 ${coarseMs.toFixed(1)} ms`);
  assert.ok(median < 150, `median ${median} ms`);
  assert.ok(coarseMs < 150);
  assert.equal(grid2, g, 'grid served from cache');
});

// ---------------------------------------------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------------------------------------------

function twoRoomGrid() {
  const p = makeProject({ rooms: [room(1, 100, 100, 500, 300), room(2, 500, 100, 600, 300), room(3, 100, 400, 300, 500)], router: [200, 200] });
  const c = ctxOf(p);
  return { p, c, g: raster.grid(c) };
}

test('stats: area weighted coverage, mean, median and p10; excluded rooms; explicit rooms', () => {
  const { g } = twoRoomGrid();
  const a = g.roomCells.get(1).length;
  const b = g.roomCells.get(2).length;
  const cc = g.roomCells.get(3).length;
  assert.ok(a > b && a > cc);
  const f = new Float32Array(g.cols * g.rows).fill(NaN);
  for (const i of g.roomCells.get(1)) f[i] = -50;
  for (const i of g.roomCells.get(2)) f[i] = -90;
  for (const i of g.roomCells.get(3)) f[i] = -60;
  const all = raster.stats(g, f, null, -67);
  close(all.coverage, (100 * (a + cc)) / (a + b + cc), 1e-9);
  assert.equal(all.n, a + b + cc);
  close(all.mean, (-50 * a - 90 * b - 60 * cc) / (a + b + cc), 1e-4);
  const ex = raster.stats(g, f, null, -67, [2]);
  close(ex.coverage, 100);
  assert.equal(ex.n, a + cc);
  const only2 = raster.stats(g, f, [2], -67);
  assert.deepEqual({ c: only2.coverage, m: only2.mean, n: only2.n }, { c: 0, m: -90, n: b });
  assert.equal(raster.stats(g, f, 3, -67).mean, -60, 'a single id is accepted');
  assert.equal(raster.stats(g, f, [], -67).n, 0);
  assert.equal(raster.stats(g, f, [99], -67).n, 0);
  // percentiles on a ramp
  const ramp = new Float32Array(g.cols * g.rows).fill(NaN);
  const cells = g.roomCells.get(1);
  cells.forEach((i, k) => (ramp[i] = -100 + (k / (cells.length - 1)) * 60)); // -100 .. -40
  const s = raster.stats(g, ramp, [1], -70);
  close(s.median, -70, 0.05);
  close(s.p10, -94, 0.05);
  close(s.coverage, 50, 0.1);
});

test('perRoom returns stats for each room with floor', () => {
  const { g } = twoRoomGrid();
  const f = new Float32Array(g.cols * g.rows).fill(NaN);
  for (const id of g.roomIds) for (const i of g.roomCells.get(id)) f[i] = -40 - id * 10;
  const m = raster.perRoom(g, f, -55);
  assert.deepEqual([...m.keys()], [1, 2, 3]);
  assert.equal(m.get(1).mean, -50);
  assert.equal(m.get(1).coverage, 100);
  assert.equal(m.get(2).coverage, 0);
  assert.equal(m.get(3).n, g.roomCells.get(3).length);
});

test('diff = a - b with NaN preserved', () => {
  const a = Float32Array.from([-50, -60, NaN, -70]);
  const b = Float32Array.from([-60, -55, -40, NaN]);
  const d = raster.diff(a, b);
  assert.equal(d[0], 10);
  assert.equal(d[1], -5);
  assert.ok(Number.isNaN(d[2]) && Number.isNaN(d[3]));
});

// ---------------------------------------------------------------------------------------------------------------
// sampling / smoothing
// ---------------------------------------------------------------------------------------------------------------

test('sample: exact at cell centres, bilinear between, NaN far outside, nearest option', () => {
  const { g } = twoRoomGrid();
  const f = new Float32Array(g.cols * g.rows).fill(NaN);
  for (const i of g.idx) {
    const row = Math.floor(i / g.cols);
    const col = i - row * g.cols;
    f[i] = -80 + col * 0.1; // linear in x
  }
  const i = g.roomCells.get(1)[500];
  const row = Math.floor(i / g.cols);
  const col = i - row * g.cols;
  const centre = { x: g.colPx[col] / W, y: g.rowPx[row] / H };
  close(raster.sample(g, f, centre), f[i], 1e-4);
  const mid = { x: (g.colPx[col] + 2) / W, y: g.rowPx[row] / H }; // half a cell to the right
  close(raster.sample(g, f, mid), (f[i] + f[i + 1]) / 2, 1e-4);
  assert.ok(Number.isNaN(raster.sample(g, f, { x: 0.9, y: 0.9 })));
  close(raster.sample(g, f, { x: (g.colPx[col] + 1) / W, y: g.rowPx[row] / H }, { nearest: true }), f[i], 1e-6);
  // near a room edge only valid neighbours are used (no NaN leaks in)
  const edgeCell = g.roomCells.get(2)[0];
  const er = Math.floor(edgeCell / g.cols);
  const ec = edgeCell - er * g.cols;
  assert.ok(Number.isFinite(raster.sample(g, f, { x: (g.colPx[ec] - 1.5) / W, y: g.rowPx[er] / H })));
});

test('smooth: removes cell noise inside a room but never mixes rooms', () => {
  const { g } = twoRoomGrid();
  const f = new Float32Array(g.cols * g.rows).fill(NaN);
  const r = rng(3);
  for (const id of [1, 2, 3]) for (const i of g.roomCells.get(id)) f[i] = (id === 1 ? -50 : id === 2 ? -90 : -70) + (r() - 0.5) * 6;
  const s = raster.smooth(g, f, { passes: 2 });
  const variance = (arr, id) => {
    const v = Array.from(g.roomCells.get(id), (i) => arr[i]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length;
  };
  assert.ok(variance(s, 1) < variance(f, 1) / 4);
  const mean1 = raster.stats(g, s, [1], -67).mean;
  const mean2 = raster.stats(g, s, [2], -67).mean;
  close(mean1, -50, 0.2);
  close(mean2, -90, 0.2);
  assert.ok(s.every((v, i) => (g.room[i] ? Number.isFinite(v) : Number.isNaN(v))));
});

// ---------------------------------------------------------------------------------------------------------------
// colours
// ---------------------------------------------------------------------------------------------------------------

test('colorize: image size, transparency outside rooms, palettes, bleed, diff and speed modes', () => {
  const { p, c, g } = twoRoomGrid();
  const f = raster.field(c, g, params(p));
  const img = raster.colorize(g, f, { bleed: false });
  assert.equal(img.width, g.cols);
  assert.equal(img.height, g.rows);
  assert.ok(img.data instanceof Uint8ClampedArray);
  assert.equal(img.data.length, g.cols * g.rows * 4);
  const outside = 0;
  const inside = g.idx[10];
  assert.equal(img.data[outside * 4 + 3], 0);
  assert.equal(img.data[inside * 4 + 3], 255);
  const half = raster.colorize(g, f, { alpha: 0.5, bleed: false });
  assert.equal(half.data[inside * 4 + 3], 128);
  // palettes differ; colour stops are hit exactly
  assert.deepEqual(raster.signalColor(-85, 'default'), [228, 60, 46]);
  assert.deepEqual(raster.signalColor(-30, 'default'), [100, 174, 181]);
  assert.deepEqual(raster.signalColor(-90, 'default'), [228, 60, 46], 'clamped');
  assert.deepEqual(raster.signalColor(-85, 'cb'), [68, 1, 84]);
  assert.deepEqual(raster.signalColor(-30, 'cb'), [253, 231, 37]);
  const mid = raster.signalColor(-70, 'default');
  assert.ok(mid[0] >= 238 && mid[0] <= 239 && mid[1] > 100 && mid[1] < 181);
  const cb = raster.colorize(g, f, { palette: 'cb', bleed: false });
  assert.notDeepEqual(Array.from(cb.data.slice(inside * 4, inside * 4 + 3)), Array.from(img.data.slice(inside * 4, inside * 4 + 3)));
  // dBm in the image equals the stop colour
  const flat = new Float32Array(g.cols * g.rows).fill(NaN);
  for (const i of g.idx) flat[i] = -65;
  const fc = raster.colorize(g, flat, { bleed: false });
  assert.deepEqual(Array.from(fc.data.slice(inside * 4, inside * 4 + 3)), [239, 181, 76]);
  // bleed: rim cells get the neighbouring colour (opaque), cells farther away stay transparent
  const bl = raster.colorize(g, flat);
  assert.ok(g.rim.length > 0);
  const rimCell = g.rim[0];
  assert.equal(bl.data[rimCell * 4 + 3], 255);
  assert.deepEqual(Array.from(bl.data.slice(rimCell * 4, rimCell * 4 + 3)), [239, 181, 76]);
  assert.equal(bl.data[0 + 3], 0);
  // diff mode
  const d = new Float32Array(g.cols * g.rows).fill(NaN);
  const ids = Array.from(g.idx.slice(0, 3));
  d[ids[0]] = -12;
  d[ids[1]] = 0;
  d[ids[2]] = 12;
  const dc = raster.colorize(g, d, { mode: 'diff', bleed: false });
  assert.deepEqual(Array.from(dc.data.slice(ids[0] * 4, ids[0] * 4 + 3)), [214, 69, 65]);
  assert.deepEqual(Array.from(dc.data.slice(ids[1] * 4, ids[1] * 4 + 3)), [170, 178, 190]);
  assert.deepEqual(Array.from(dc.data.slice(ids[2] * 4, ids[2] * 4 + 3)), [46, 160, 110]);
  assert.ok(dc.data[ids[1] * 4 + 3] < dc.data[ids[0] * 4 + 3], 'neutral is more transparent');
  // speed mode: unknown = grey, ratio colours, NaN transparent
  const sp = new Float32Array(g.cols * g.rows).fill(NaN);
  sp[ids[0]] = -1;
  sp[ids[1]] = 0.25;
  sp[ids[2]] = 2;
  const sc = raster.colorize(g, sp, { mode: 'speed', bleed: false });
  assert.deepEqual(Array.from(sc.data.slice(ids[0] * 4, ids[0] * 4 + 3)), [113, 126, 148]);
  assert.deepEqual(Array.from(sc.data.slice(ids[2] * 4, ids[2] * 4 + 3)), [100, 174, 181]);
  assert.equal(sc.data[g.idx[50] * 4 + 3], 0, 'NaN stays transparent');
  // target buffer is reused
  const target = new Uint8ClampedArray(g.cols * g.rows * 4);
  assert.equal(raster.colorize(g, flat, { target, bleed: false }).data, target);
});

// ---------------------------------------------------------------------------------------------------------------
// contours
// ---------------------------------------------------------------------------------------------------------------

test('contours: open room -> one closed circle of the right radius', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], router: [540, 471] });
  const c = ctxOf(p);
  const chains = raster.contours(c, { band: 5, router: p.net.router, offset: 0, threshold: -50 });
  assert.equal(chains.length, 1);
  const ch = chains[0];
  assert.ok(ch.length > 40);
  assert.deepEqual(ch[0], ch[ch.length - 1], 'closed loop repeats its first point');
  const expected = Math.pow(10, 10 / 22) * 100; // px, from -40 - 22*log10(d) = -50
  for (const q of ch) {
    const d = Math.hypot(q.x * W - p.net.router.x * W, q.y * H - p.net.router.y * H);
    assert.ok(Math.abs(d - expected) < 3, `radius ${d.toFixed(1)} vs ${expected.toFixed(1)}`);
  }
});

test('contours: walls cut the range line; an offset and a node change it; results are deterministic', () => {
  const walls = [wall('w', 600, 0, 600, 942, 12)];
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls, router: [350, 450] });
  const c = ctxOf(p);
  const base = { band: 5, router: p.net.router, offset: 0, threshold: -52 };
  const a = raster.contours(c, base);
  assert.ok(a.length >= 1);
  assert.deepEqual(raster.contours(c, base), a);
  const farSide = (chains) => chains.some((ch) => ch.some((q) => q.x * W > 800));
  const stronger = raster.contours(c, { ...base, offset: 8 });
  assert.notDeepEqual(stronger, a);
  // every point of every chain is on the iso-line (within the interpolation error)
  for (const ch of a) {
    for (const q of ch) {
      if (q.x <= 0.0001 || q.y <= 0.0001 || q.x >= 0.9999 || q.y >= 0.9999) continue;
      if (Math.abs(q.x * W - 600) < 12) continue; // the field is discontinuous at the wall: interpolation is meaningless there
      const s = model.signal(c, p.net.router, q, 5, 0);
      assert.ok(Math.abs(s + 52) < 4.5, `iso-line value ${s.toFixed(1)} at ${q.x.toFixed(3)},${q.y.toFixed(3)}`);
    }
  }
  // a node on the far side adds lines on that side
  const node = { mode: 'ap_cable', pos: n(850, 450), bands: { '2.4': true, '5': true, '6': true }, power: 0 };
  const withNode = raster.contours(c, { ...base, node });
  assert.equal(farSide(a), false, 'the 12 dB wall keeps the router range on its side');
  assert.equal(farSide(withNode), true, 'the node adds range lines on the far side');
  // a band the node does not serve is ignored
  assert.deepEqual(raster.contours(c, { ...base, node: { ...node, bands: { '2.4': true, '5': false, '6': false } } }), a);
  assert.throws(() => raster.contours(c, { router: p.net.router, threshold: -60 }), RangeError);
});

test('contours (soften 0 = exact lattice over the whole canvas): a weak router leaves open lines that run off the canvas', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], router: [200, 200] });
  const chains = raster.contours(ctxOf(p), { band: 5, router: p.net.router, offset: 0, threshold: -62, res: [60, 52], soften: 0 });
  assert.ok(chains.length >= 1);
  assert.notDeepEqual(chains[0][0], chains[0][chains[0].length - 1], 'open chain');
});

// ---------------------------------------------------------------------------------------------------------------
// analysis helper (today vs trial in a few lines)
// ---------------------------------------------------------------------------------------------------------------

test('analysis.run: today vs trial', () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  p.view.band = 5; // the 5 GHz map (the demo opens in the band mode Auto, SPEC 13 - see steer.test.mjs)
  const a0 = E.analysis.run(p, { cell: 4 });
  assert.equal(a0.today.length, a0.trial.length);
  assert.deepEqual(Array.from(a0.diff.slice(0, 2000)).filter((v) => v !== 0 && !Number.isNaN(v)), [], 'trial == today at the start');
  assert.equal(a0.delta.coverage, 0);
  // move the router to the middle of the flat: coverage must improve
  p.net.router = { x: 0.5, y: 0.45 };
  const a1 = E.analysis.run(p, { cell: 8 });
  assert.equal(a1.grid.cell, 8);
  assert.ok(a1.stats.trial.coverage > a1.stats.today.coverage + 10, `${a1.stats.today.coverage} -> ${a1.stats.trial.coverage}`);
  assert.ok(a1.delta.coverage > 10 && a1.delta.mean > 0);
  assert.equal(a1.params.today.node, null);
  assert.equal(a1.targetRooms, null);
  assert.equal(a1.perRoom.trial.size, 7);
  // a single room as the goal
  p.goal.room = 3;
  const a2 = E.analysis.run(p, { cell: 8 });
  assert.deepEqual(a2.targetRooms, [3]);
  assert.equal(a2.stats.trial.n, a2.grid.roomCells.get(3).length);
});

test('analysis.run: cache keeps "today" while the router moves; trial is an independent copy when nothing moved', () => {
  const p = P.create({ template: 'demo', lang: 'en' });
  const cache = {};
  const a = E.analysis.run(p, { cell: 8, cache });
  assert.notEqual(a.today, a.trial, 'separate arrays even though the values are equal');
  assert.deepEqual(Array.from(a.today.slice(0, 3000)), Array.from(a.trial.slice(0, 3000)));
  a.trial[a.grid.idx[0]] = -1; // mutating trial must not touch today
  assert.notEqual(a.today[a.grid.idx[0]], -1);
  p.net.router = { x: 0.45, y: 0.4 };
  const b = E.analysis.run(p, { cell: 8, cache });
  assert.equal(b.today, a.today, 'today served from the cache');
  assert.ok(b.delta.coverage > 5);
  // any change of the geometry, the baseline, the band or the grid invalidates it
  p.net.baseline = { x: 0.45, y: 0.4 };
  assert.notEqual(E.analysis.run(p, { cell: 8, cache }).today, a.today);
  assert.notEqual(E.analysis.run(p, { cell: 8, band: 2.4, cache }).today, a.today);
  const c = E.analysis.run(p, { cell: 4, cache });
  assert.equal(c.grid.cell, 4);
  const q = P.clone(p);
  q.plan.walls[0].loss = 20;
  assert.notEqual(E.analysis.run(q, { cell: 4, cache }).today, c.today);
  // reuse buffers are honoured
  const reuse = { today: new Float32Array(c.grid.cols * c.grid.rows), trial: new Float32Array(c.grid.cols * c.grid.rows) };
  const r = E.analysis.run(P.create({ template: 'demo' }), { cell: 4, reuse });
  assert.equal(r.today, reuse.today);
  assert.equal(r.trial, reuse.trial);
});

test('field aa:2 (soften 0) equals exhaustive 2x2 supersampling (same-room sub-samples) almost everywhere and is closer than aa:1', () => {
  const b = busyPlan();
  const p = makeProject({ rooms: b.rooms, walls: b.walls, furniture: b.furniture, router: [551, 447] });
  const c = ctxOf(p);
  const g = raster.grid(c, { cell: 4 });
  const fine = raster.grid(c, { cell: 2 });
  const st = { ...params(p), ...HARD };
  const ff = raster.field(c, fine, st);
  const ref = new Float32Array(g.cols * g.rows).fill(NaN);
  for (const i of g.idx) {
    const r = Math.floor(i / g.cols);
    const col = i - r * g.cols;
    let s = 0;
    let n2 = 0;
    for (let a = 0; a < 2; a++) {
      for (let k = 0; k < 2; k++) {
        const fr = r * 2 + a;
        const fc = col * 2 + k;
        if (fr >= fine.rows || fc >= fine.cols) continue;
        const j = fr * fine.cols + fc;
        if (fine.room[j] !== g.room[i]) continue;
        s += ff[j];
        n2++;
      }
    }
    ref[i] = n2 ? s / n2 : NaN;
  }
  const aa2 = raster.field(c, g, { ...st, aa: 2 });
  const aa1 = raster.field(c, g, st);
  let err2 = 0;
  let err1 = 0;
  let max2 = 0;
  let cnt = 0;
  for (const i of g.idx) {
    if (!Number.isFinite(ref[i])) continue;
    err2 += Math.abs(aa2[i] - ref[i]);
    err1 += Math.abs(aa1[i] - ref[i]);
    max2 = Math.max(max2, Math.abs(aa2[i] - ref[i]));
    cnt++;
  }
  assert.ok(err2 / cnt < 0.01, `mean error ${err2 / cnt}`);
  assert.ok(err2 < err1 / 10, `aa:2 error ${err2 / cnt} vs aa:1 ${err1 / cnt}`);
  assert.ok(max2 < 4, `max error ${max2}`);
  // values stay inside the model range, floor cells only
  for (const i of g.idx) assert.ok(aa2[i] >= -110 && aa2[i] <= -20);
  assert.ok(Number.isNaN(aa2[0]));
  // aa that does not divide the cell is ignored (plain field), aa:1 is plain
  assert.deepEqual(Array.from(raster.field(c, g, { ...st, aa: 3 }).slice(0, 4000)), Array.from(aa1.slice(0, 4000)));
  // with a second node: nodeWins stays consistent with the field
  const withNode = { ...st, node: { mode: 'ap_cable', pos: n(880, 680), power: 0, bands: { '2.4': true, '5': true, '6': false } }, aa: 2 };
  const ex = raster.fieldEx(c, g, withNode);
  assert.ok(ex.nodeWins);
  const solo = raster.field(c, g, { ...st, aa: 2 });
  let wins = 0;
  let gain = 0;
  for (const i of g.idx) {
    gain += ex.field[i] - solo[i];
    if (ex.nodeWins[i]) wins++;
  }
  // (cell by cell the two anti-aliased fields may refine different cells, so only the aggregate is compared)
  assert.ok(gain / g.count > 1, `mean gain ${gain / g.count}`);
  assert.ok(wins > g.count * 0.05);
});
