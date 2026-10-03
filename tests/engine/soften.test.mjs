// Diffraction softening (the `soften` field parameter), smoothed range lines and the analysis cache.
// The heat map shows free space minus a Gaussian-blurred obstacle loss that never mixes rooms or crosses walls; these
// tests pin down what that must and must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, readPrivatePlan } from './_load.mjs';
import { n, room, wall, door, furn, makeProject, ctxOf, rng } from './_helpers.mjs';

const { model, raster, project: P } = E;
const { W, H } = E.CANVAS;
const HARD = { soften: 0 };

const realProject = () => {
  const svg = readPrivatePlan();
  return svg === null ? null : P.parseSvgText(svg).project;
};
const demoProject = () => P.create({ template: 'demo', lang: 'cs' });
const plans = () => [['demo', demoProject()], ['real', realProject()]].filter(([, p]) => p);
/** A few router positions per plan: today's place, the middle, two far corners. */
const routerSpots = (p) => [p.net.baseline, ...[[0.5, 0.49], [0.2, 0.2], [0.85, 0.8]].map(([x, y]) => P.nearestFloor(p.plan, { x, y }))];
const cellXY = (g, i) => {
  const r = (i / g.cols) | 0;
  return [g.colPx[i - r * g.cols], g.rowPx[r]];
};

/**
 * Same-room 4-neighbour pairs of a field. A pair "straddles a wall" when a wall (or closed door) of >= BARRIER_DB lies
 * between the two cell centres - those steps are real and must stay; every other pair is "free".
 */
function pairJumps(ctx, g, f) {
  let maxFree = 0;
  let overFree = 0;
  let maxWall = 0;
  let where = null;
  for (const i of g.idx) {
    const r = (i / g.cols) | 0;
    const c = i - r * g.cols;
    for (const j of [c + 1 < g.cols ? i + 1 : -1, i + g.cols]) {
      if (j < 0 || j >= f.length || g.room[j] !== g.room[i]) continue;
      const d = Math.abs(f[i] - f[j]);
      if (d > 1) {
        const [x0, y0] = cellXY(g, i);
        const [x1, y1] = cellXY(g, j);
        if (model.wallBlocks(ctx, x0, y0, x1, y1)) {
          if (d > maxWall) maxWall = d;
          continue;
        }
      }
      if (d > 6) overFree++;
      if (d > maxFree) {
        maxFree = d;
        where = cellXY(g, i);
      }
    }
  }
  return { maxFree, overFree, maxWall, where };
}

// ---------------------------------------------------------------------------------------------------------------
// no wedges
// ---------------------------------------------------------------------------------------------------------------

test('soften: no > 6 dB jumps between same-room neighbours anywhere on the demo (and an optional private real plan; the exact rays have hundreds)', () => {
  let hardOver = 0;
  const report = [];
  for (const [name, p] of plans()) {
    const ctx = ctxOf(p);
    const node = { mode: 'ap_cable', pos: P.nearestFloor(p.plan, { x: 0.8, y: 0.3 }), bands: { '2.4': true, '5': true, '6': true }, power: 0 };
    for (const [cell, aa] of [[4, 2], [8, 1]]) {
      const g = raster.grid(ctx, { cell });
      for (const router of routerSpots(p)) {
        for (const nd of [null, node]) {
          for (const band of [2.4, 5]) {
            const st = { band, router, node: nd, offsets: {}, aa };
            const soft = pairJumps(ctx, g, raster.field(ctx, g, st));
            assert.equal(soft.overFree, 0, `${name} cell ${cell} band ${band} router ${JSON.stringify(router)} node ${!!nd}: ${soft.overFree} pairs > 6 dB, max ${soft.maxFree.toFixed(2)} at ${soft.where}`);
            report.push(soft.maxFree);
            if (band === 5 && !nd) hardOver += pairJumps(ctx, g, raster.field(ctx, g, { ...st, ...HARD })).overFree;
          }
        }
      }
    }
  }
  console.log(`  [soften] worst same-room jump without a wall: ${Math.max(...report).toFixed(2)} dB (exact rays: ${hardOver} pairs > 6 dB)`);
  assert.ok(hardOver > 100, `the exact field should show the wedges this test guards against (${hardOver})`);
});

test('soften: a wedge behind a free-standing wall end becomes a penumbra of a few tens of cm, the same at cell 4 and 8', () => {
  // one room, a 12 dB wall stub hanging from the top wall; the router left of it casts a shadow edge from the stub's end
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls: [wall('stub', 550, 100, 550, 450, 12)], router: [300, 600] });
  const ctx = ctxOf(p);
  const st = { band: 5, router: p.net.router, offsets: {} };
  // walk along the vertical line x = 800 through the shadow edge: the ray router (300,600) -> stub end (550,451.5, the
  // wall is extended by 1.5 px) crosses it at y ~ 303. The edge is oblique, so a vertical step dy is dy*cosA across it.
  const cosA = 250 / Math.hypot(250, 600 - 451.5);
  const profile = (cell, extra) => {
    const g = raster.grid(ctx, { cell });
    const f = raster.field(ctx, g, { ...st, ...extra });
    const out = [];
    // field - (exact signal + exact loss) = -(softened loss): 0 in the light, -12 in full shadow, the ramp = the penumbra
    for (let y = 104; y < 500; y += 2) out.push([y, raster.sample(g, f, n(800, y)) - model.signal(ctx, p.net.router, n(800, y), 5, 0) - model.traceLoss(ctx, 300, 600, 800, y)]);
    return out;
  };
  const width = (prof) => {
    // 10 % .. 90 % transition of the 12 dB step, measured across the edge, in metres
    const lo = prof.find(([, v]) => v > -12 * 0.9);
    const hi = prof.find(([, v]) => v > -12 * 0.1);
    return (hi[0] - lo[0]) * cosA * p.scale.mpp;
  };
  const hard = width(profile(4, HARD));
  const soft4 = width(profile(4, {}));
  const soft8 = width(profile(8, {}));
  assert.ok(hard <= 0.1, `exact rays: razor-sharp edge (${hard.toFixed(2)} m)`);
  // a Gaussian of sigma s turns a step into a 10-90 % ramp of 2.56 s (s = 0.4 m -> ~1 m)
  const expect = 2.56 * model.SOFTEN;
  assert.ok(Math.abs(soft4 - expect) < 0.15 * expect, `cell 4 penumbra ${soft4.toFixed(2)} m, expected ~${expect.toFixed(2)}`);
  assert.ok(Math.abs(soft8 - soft4) < 0.15, `cell 8 penumbra ${soft8.toFixed(2)} m vs cell 4 ${soft4.toFixed(2)} m (same physical sigma)`);
  // the penumbra scales with the parameter and disappears with soften 0
  const half = width(profile(4, { soften: model.SOFTEN / 2 }));
  assert.ok(Math.abs(half - soft4 / 2) < 0.15 * soft4, `soften ${model.SOFTEN / 2}: ${half.toFixed(2)} m`);
  // and the stub itself stays a sharp 12 dB step where it is (y < 450)
  const g = raster.grid(ctx, { cell: 4 });
  const f = raster.field(ctx, g, st);
  for (const y of [150, 250, 350]) {
    const step = raster.sample(g, f, n(546, y)) - raster.sample(g, f, n(554, y));
    assert.ok(step > 11 && step < 13.5, `step across the stub at y=${y}: ${step.toFixed(2)} dB`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// walls stay sharp
// ---------------------------------------------------------------------------------------------------------------

test('soften: walls between rooms stay perfectly sharp; a loss that is constant per room is not changed at all', () => {
  // two rooms split by a 12 dB wall (plus a closed door in it); no other obstacle: the loss is 0 in A and 12 in B
  const p = makeProject({
    rooms: [room(1, 100, 100, 500, 700), room(2, 500, 100, 900, 700)],
    walls: [wall('w', 500, 100, 500, 700, 12)],
    doors: [door('d', 'w', 500, 380, 500, 460, 12)],
    router: [250, 400],
  });
  const ctx = ctxOf(p);
  for (const cell of [4, 8]) {
    const g = raster.grid(ctx, { cell });
    const hard = raster.field(ctx, g, { band: 5, router: p.net.router, offsets: {}, ...HARD });
    const soft = raster.field(ctx, g, { band: 5, router: p.net.router, offsets: {} });
    let max = 0;
    for (const i of g.idx) max = Math.max(max, Math.abs(hard[i] - soft[i]));
    assert.ok(max < 1e-4, `cell ${cell}: softening changed a piecewise constant loss by ${max}`);
  }
  // the same with the step inside ONE room (a wall across the whole room): still untouched
  const q = makeProject({ rooms: [room(1, 100, 100, 900, 700)], walls: [wall('w', 500, 100, 500, 700, 12)], router: [250, 400] });
  const cq = ctxOf(q);
  const g = raster.grid(cq, { cell: 4 });
  const hard = raster.field(cq, g, { band: 5, router: q.net.router, offsets: {}, ...HARD });
  const soft = raster.field(cq, g, { band: 5, router: q.net.router, offsets: {} });
  let max = 0;
  for (const i of g.idx) max = Math.max(max, Math.abs(hard[i] - soft[i]));
  assert.ok(max < 1e-4, `in-room wall: changed by ${max}`);
  // ... while an open doorway in that wall lets the softening through (the beam edges get soft)
  const o = makeProject({ rooms: [room(1, 100, 100, 900, 700)], walls: [wall('w', 500, 100, 500, 700, 12)], doors: [door('d', 'w', 500, 360, 500, 440, 0)], router: [250, 400] });
  const co = ctxOf(o);
  const fo = raster.field(co, g, { band: 5, router: o.net.router, offsets: {}, aa: 2 });
  const jumps = pairJumps(co, g, fo);
  assert.ok(jumps.maxFree < 4, `beam through the doorway: worst free jump ${jumps.maxFree.toFixed(2)} dB`);
  assert.ok(jumps.maxWall > 10, `the wall next to the doorway is still a ${jumps.maxWall.toFixed(1)} dB step`);
});

test('soften: an optional private real plan keeps its wall steps (rooms never mix; walls inside a room stay steps)', () => {
  const p = realProject();
  if (!p) return;
  p.net.router = P.nearestFloor(p.plan, { x: 0.5, y: 0.5 });
  const ctx = ctxOf(p);
  const g = raster.grid(ctx, { cell: 4 });
  const hard = raster.field(ctx, g, { ...model.fieldParams(p, 'trial'), aa: 2, ...HARD });
  const soft = raster.field(ctx, g, { ...model.fieldParams(p, 'trial'), aa: 2 });
  // across every wall between two rooms the step keeps its size (within the blur of each side)
  let pairs = 0;
  let sum = 0;
  for (const i of g.idx) {
    const j = i + 1;
    if (!g.room[j] || g.room[j] === g.room[i]) continue;
    const [x0, y0] = cellXY(g, i);
    const [x1, y1] = cellXY(g, j);
    if (!model.wallBlocks(ctx, x0, y0, x1, y1)) continue;
    const dh = hard[i] - hard[j];
    const ds = soft[i] - soft[j];
    if (Math.abs(dh) < 6) continue;
    pairs++;
    sum += Math.abs(ds) / Math.abs(dh);
  }
  assert.ok(pairs > 50, `${pairs} wall pairs`);
  assert.ok(sum / pairs > 0.8, `wall steps keep ${((100 * sum) / pairs).toFixed(0)} % of their size on average`);
  // the field never leaks between rooms: per room, the soft mean equals the exact mean within half a dB
  const ph = raster.perRoom(g, hard, -67);
  const ps = raster.perRoom(g, soft, -67);
  for (const [id, s] of ps) assert.ok(Math.abs(s.mean - ph.get(id).mean) < 0.5, `room ${id}: mean ${ph.get(id).mean.toFixed(2)} -> ${s.mean.toFixed(2)}`);
});

// ---------------------------------------------------------------------------------------------------------------
// numbers: coverage, calibration, node
// ---------------------------------------------------------------------------------------------------------------

test('soften: coverage stays within a few percentage points of the exact rays, the mean within a few tenths of a dB', () => {
  const rows = [];
  for (const [name, p] of plans()) {
    const ctx = ctxOf(p);
    const g = raster.grid(ctx, { cell: 4 });
    for (const router of routerSpots(p)) {
      for (const band of [2.4, 5, 6]) {
        const st = { band, router, offsets: {}, aa: 2 };
        const h = raster.stats(g, raster.field(ctx, g, { ...st, ...HARD }), null, p.model.threshold);
        const s = raster.stats(g, raster.field(ctx, g, st), null, p.model.threshold);
        rows.push(Math.abs(s.coverage - h.coverage));
        // (how far coverage moves depends on how much floor lies just above / below the threshold next to a shadow
        // edge; with the band-dependent wall losses of SPEC 7.1 the worst case is the demo at 2.4 GHz, ~4 pp)
        assert.ok(Math.abs(s.coverage - h.coverage) <= 4.5, `${name} band ${band}: coverage ${h.coverage.toFixed(1)} -> ${s.coverage.toFixed(1)} %`);
        assert.ok(Math.abs(s.mean - h.mean) <= 0.3, `${name} band ${band}: mean ${h.mean.toFixed(2)} -> ${s.mean.toFixed(2)}`);
        // the blur moves loss from shadows into the light next to them and back: the median and the weak tail move a
        // little in either direction, never by a whole wall (the 6 GHz tables have 13-18 dB walls on these plans: up to
        // ~2.3 dB for the median of a real plan)
        assert.ok(Math.abs(s.median - h.median) <= 3, `${name} band ${band}: median ${h.median.toFixed(1)} -> ${s.median.toFixed(1)}`);
        assert.ok(Math.abs(s.p10 - h.p10) <= 3, `${name} band ${band}: weak tail ${h.p10.toFixed(1)} -> ${s.p10.toFixed(1)}`);
      }
    }
  }
  rows.sort((a, b) => a - b);
  console.log(`  [soften] |coverage change|: median ${rows[rows.length >> 1].toFixed(2)} pp, max ${rows[rows.length - 1].toFixed(2)} pp over ${rows.length} cases`);
});

test('soften: calibration stays exact - the offset is added after the softening and a calibrated map reproduces a measurement', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls: [wall('stub', 550, 100, 550, 450, 12)], furniture: [furn('f', 700, 500, 760, 560, 8)], router: [300, 600], baseline: [300, 600] });
  const ctx = ctxOf(p);
  for (const cell of [4, 8]) {
    const g = raster.grid(ctx, { cell });
    const node = { mode: 'ap_cable', pos: n(850, 300), bands: { '2.4': true, '5': true, '6': true }, power: 2 };
    for (const nd of [null, node]) {
      const f0 = raster.field(ctx, g, { band: 5, router: p.net.router, node: nd, offsets: { '5': 0 } });
      const f7 = raster.field(ctx, g, { band: 5, router: p.net.router, node: nd, offsets: { '5': 7 } });
      for (const i of g.idx) if (f0[i] < -27 && f0[i] > -110) assert.ok(Math.abs(f7[i] - f0[i] - 7) < 1e-4, `cell ${cell}: offset shift ${f7[i] - f0[i]}`);
    }
  }
  // one measurement right in the penumbra of the stub (its shadow edge crosses x = 800 at y ~ 303), 3 dB above the
  // model: exact-ray calibration cannot match it there
  const at = n(800, 290);
  const soft = model.softRawSignal(ctx, p.net.baseline, at, 5);
  const hard = model.rawSignal(ctx, p.net.baseline, at, 5);
  assert.ok(Math.abs(soft - hard) > 2, `the spot is in the penumbra (soft ${soft.toFixed(1)}, exact ${hard.toFixed(1)})`);
  p.measurements = [{ id: 'm1', ...at, band: 5, value: Math.round((soft + 3) * 100) / 100, name: 'm', download: null, upload: null, device: p.goal.device, t: 0 }];
  const offs = model.offsets(ctx, p);
  assert.ok(Math.abs(offs['5'] - 3) < 0.011, `offset ${offs['5']}`);
  const cal = model.calibrate(ctx, p.measurements, 5, { baseline: p.net.baseline });
  assert.ok(cal.rms < 1e-9 && Math.abs(cal.used[0].predicted - soft) < 1e-9);
  const m = p.measurements[0];
  assert.ok(Math.abs(model.softSignal(ctx, p.net.baseline, m, 5, offs['5']) - m.value) < 0.011, 'the point model reproduces it exactly');
  for (const cell of [4, 8]) {
    const a = E.analysis.run(p, { cell, ctx });
    const v = raster.sample(a.grid, a.today, m);
    assert.ok(Math.abs(v - m.value) < 0.5, `cell ${cell}: map ${v.toFixed(2)} vs measured ${m.value}`);
  }
  // calibrating with the exact rays instead would leave a visible error on the map there
  const hardOffs = model.offsets(ctx, p, HARD);
  const a = E.analysis.run(p, { cell: 4, ctx, offsets: hardOffs });
  assert.ok(Math.abs(raster.sample(a.grid, a.today, m) - m.value) > 1.5);
});

test('soften: with a second node every source is softened separately; nodeWins is decided on the softened values', () => {
  for (const [, p] of plans()) {
    const ctx = ctxOf(p);
    const node = { mode: 'mesh_wifi', pos: P.nearestFloor(p.plan, { x: 0.8, y: 0.3 }), bands: { '2.4': true, '5': true, '6': true }, power: 3 };
    const router = P.nearestFloor(p.plan, { x: 0.3, y: 0.6 });
    for (const [cell, aa] of [[4, 2], [8, 1]]) {
      const g = raster.grid(ctx, { cell });
      const offsets = { '5': -2 };
      const ex = raster.fieldEx(ctx, g, { band: 5, router, node, offsets, aa });
      const fr = raster.field(ctx, g, { band: 5, router, offsets, aa });
      const fn = raster.field(ctx, g, { band: 5, router: node.pos, offsets: { '5': -2 + 3 }, aa });
      let wins = 0;
      for (const i of g.idx) {
        assert.equal(ex.field[i], Math.max(fr[i], fn[i]));
        assert.equal(ex.nodeWins[i], fn[i] > fr[i] ? 1 : 0);
        wins += ex.nodeWins[i];
      }
      assert.ok(wins > g.count * 0.1 && wins < g.count * 0.9, `node wins ${wins} of ${g.count}`);
      // the tooltip agrees on who wins away from the boundary between the two areas
      const st = { band: 5, router, node, offsets, baseline: router };
      let agree = 0;
      let tried = 0;
      for (let k = 0; k < g.idx.length; k += 97) {
        const i = g.idx[k];
        if (Math.abs(fn[i] - fr[i]) < 1.5) continue;
        const [x, y] = cellXY(g, i);
        const d = model.pointSignalDetail(ctx, n(x, y), st);
        tried++;
        if ((d.bestSource === 'node') === (ex.nodeWins[i] === 1)) agree++;
      }
      assert.ok(agree >= tried * 0.98, `bestSource agrees with nodeWins in ${agree} of ${tried} cells`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// point model (tooltip, backhaul) vs raster
// ---------------------------------------------------------------------------------------------------------------

test('soften: the point model (tooltip) agrees with the softened raster; soften 0 is the exact ray model', () => {
  for (const [name, p] of plans()) {
    p.net.router = P.nearestFloor(p.plan, { x: 0.5, y: 0.49 });
    const ctx = ctxOf(p);
    const g = raster.grid(ctx, { cell: 4 });
    const st = model.fieldParams(p, 'trial', { band: 5 });
    const f = raster.field(ctx, g, { ...st, aa: 2 });
    const r = rng(17);
    const errs = [];
    for (let k = 0; k < 400; k++) {
      const i = g.idx[Math.floor(r() * g.idx.length)];
      const [x, y] = cellXY(g, i);
      const q = n(x + (r() - 0.5) * 4, y + (r() - 0.5) * 4);
      let wd = Infinity;
      for (let w = 0; w < ctx.w.n; w++) wd = Math.min(wd, E.geom.pointSegDistPx(q.x * W, q.y * H, ctx.w.ax[w], ctx.w.ay[w], ctx.w.ax[w] + ctx.w.sx[w], ctx.w.ay[w] + ctx.w.sy[w]));
      if (wd < 6) continue; // bilinear sampling of the raster straddles the wall there
      const s = raster.sample(g, f, q);
      if (!Number.isFinite(s)) continue;
      errs.push(Math.abs(model.pointSignalDetail(ctx, q, st).combined - s));
      if (k < 40) {
        const d0 = model.pointSignalDetail(ctx, q, { ...st, soften: 0 });
        assert.equal(d0.router, model.signal(ctx, st.router, q, 5, 0), 'soften 0 = exact');
        assert.equal(model.softSignal(ctx, st.router, q, 5, -3, 0), model.signal(ctx, st.router, q, 5, -3));
      }
    }
    errs.sort((a, b) => a - b);
    const med = errs[errs.length >> 1];
    const p95 = errs[Math.floor(errs.length * 0.95)];
    console.log(`  [soften] ${name}: tooltip vs map median ${med.toFixed(3)} dB, p95 ${p95.toFixed(3)} dB, max ${errs[errs.length - 1].toFixed(2)} dB`);
    assert.ok(med < 0.15 && p95 < 0.8, `${name}: median ${med}, p95 ${p95}`);
  }
});

test('soften: the point stencil never reaches through a wall or into another room', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 500, 700), room(2, 500, 100, 900, 700)], walls: [wall('w', 500, 100, 500, 700, 12), wall('in', 300, 100, 300, 500, 20)], router: [200, 400] });
  const ctx = ctxOf(p);
  // right next to the room boundary / the in-room wall the softened value equals the exact one (constant loss per side)
  for (const [x, y] of [[505, 300], [495, 300], [305, 300], [295, 300], [305, 120]]) {
    const q = n(x, y);
    assert.ok(Math.abs(model.softSignal(ctx, p.net.router, q, 5, 0) - model.signal(ctx, p.net.router, q, 5, 0)) < 1e-9, `${x},${y}`);
  }
  assert.equal(model.wallBlocks(ctx, 290, 300, 310, 300), true);
  assert.equal(model.wallBlocks(ctx, 290, 600, 310, 600), false, 'below the end of the in-room wall');
  assert.equal(model.roomAtPx(ctx, 499, 300), 1);
  assert.equal(model.roomAtPx(ctx, 501, 300), 2);
  assert.equal(model.roomAtPx(ctx, 50, 50), 0);
  // off the floor: no stencil, the exact value
  const off = n(1000, 900);
  assert.equal(model.softSignal(ctx, p.net.router, off, 5, 0), model.signal(ctx, p.net.router, off, 5, 0));
});

// ---------------------------------------------------------------------------------------------------------------
// parameters, determinism, plumbing
// ---------------------------------------------------------------------------------------------------------------

test('soften: parameter handling, determinism and plumbing through fieldParams / analysis.run / optimize / speed', async () => {
  const p = demoProject();
  p.net.router = P.nearestFloor(p.plan, { x: 0.47, y: 0.5 });
  const ctx = ctxOf(p);
  const g = raster.grid(ctx, { cell: 4 });
  const st = model.fieldParams(p, 'trial');
  assert.equal('soften' in st, false, 'fieldParams adds soften only when asked');
  assert.equal(model.fieldParams(p, 'trial', { soften: 0.25 }).soften, 0.25);
  assert.equal(model.SOFTEN, 0.4);
  const f1 = raster.field(ctx, g, st);
  assert.deepEqual(raster.field(ctx, g, st), f1, 'deterministic');
  assert.deepEqual(raster.field(ctx, g, { ...st, soften: model.SOFTEN }), f1, 'default = SOFTEN');
  assert.deepEqual(raster.field(ctx, g, { ...st, soften: 'x' }), f1, 'garbage -> default');
  const hard = raster.field(ctx, g, { ...st, soften: 0 });
  assert.deepEqual(raster.field(ctx, g, { ...st, soften: -1 }), hard, 'negative -> 0 (off)');
  assert.notDeepEqual(f1, hard);
  assert.deepEqual(raster.field(ctx, g, { ...st, soften: 9 }), raster.field(ctx, g, { ...st, soften: model.SOFTEN_MAX }), 'clamped to SOFTEN_MAX');
  // a buffer is reused and the result does not depend on what was in it
  const buf = new Float32Array(g.cols * g.rows).fill(-1);
  assert.equal(raster.field(ctx, g, st, buf), buf);
  assert.deepEqual(buf, f1);
  // the same physical sigma at cell 4 and cell 8: both fields agree away from walls
  const g8 = raster.grid(ctx, { cell: 8 });
  const f8 = raster.field(ctx, g8, st);
  const r = rng(3);
  const errs = [];
  for (let k = 0; k < 400; k++) {
    const i = g.idx[Math.floor(r() * g.idx.length)];
    const [x, y] = cellXY(g, i);
    let wd = Infinity;
    for (let w = 0; w < ctx.w.n; w++) wd = Math.min(wd, E.geom.pointSegDistPx(x, y, ctx.w.ax[w], ctx.w.ay[w], ctx.w.ax[w] + ctx.w.sx[w], ctx.w.ay[w] + ctx.w.sy[w]));
    if (wd < 12) continue;
    errs.push(Math.abs(raster.sample(g, f1, n(x, y)) - raster.sample(g8, f8, n(x, y))));
  }
  errs.sort((a, b) => a - b);
  assert.ok(errs[errs.length >> 1] < 0.3, `cell 4 vs 8 median ${errs[errs.length >> 1]}`);
  // analysis.run: default soften, explicit 0 = exact, the value is reported and in the params
  const a = E.analysis.run(p, { cell: 4 });
  assert.equal(a.soften, model.SOFTEN);
  assert.equal(a.params.trial.soften, model.SOFTEN);
  assert.deepEqual(a.trial, raster.field(ctx, g, { ...st, aa: 2 }));
  const a0 = E.analysis.run(p, { cell: 4, soften: 0 });
  assert.deepEqual(a0.trial, raster.field(ctx, g, { ...st, aa: 2, soften: 0 }));
  // optimize: exact before/after on the softened field by default, on the exact one with soften 0
  const opts = { band: 5, goalRoom: null, allowedRoom: null, threshold: p.model.threshold, router: p.net.router, offsets: { '2.4': 0, '5': 0, '6': 0 } };
  const o = await E.optimize.find(ctx, g, opts);
  assert.equal(o.before.coverage, a.stats.trial.coverage);
  const o0 = await E.optimize.find(ctx, g, { ...opts, soften: 0 });
  assert.equal(o0.before.coverage, a0.stats.trial.coverage);
  // speed: fieldSpeed uses the softened field unless told otherwise
  let id = 0;
  const m = (value, down, up) => ({ id: `s${++id}`, x: 0.5, y: 0.5, band: 5, value, name: 'x', download: down, upload: up, device: 'Telefon', t: 0 });
  const curve = E.speed.buildCurve([m(-40, 600, 200), m(-55, 300, 100), m(-70, 50, 20), m(-82, 4, 2)], { band: 5, device: 'Telefon' });
  const sf = E.speed.fieldSpeed(ctx, g, st, curve, {});
  const sfSignal = E.speed.fieldSpeed(ctx, g, st, curve, {}, raster.field(ctx, g, st));
  assert.deepEqual(sf.down, sfSignal.down);
});

test('optimize: the final pick is made on the softened full grid - never worse than staying put in the numbers shown', async () => {
  for (const [name, p] of plans()) {
    const ctx = ctxOf(p);
    const g = raster.grid(ctx, { cell: 8 });
    // the optimizer's objective on a full field: per room coverage + 0.2 (mean + 100) + 0.2 (p10 + 100), area weighted
    const objective = (f) => {
      let total = 0;
      for (const id of g.roomIds) {
        const s = raster.stats(g, f, [id], p.model.threshold);
        total += (g.roomCells.get(id).length / g.count) * (s.coverage + 0.2 * (s.mean + 100) + 0.2 * (s.p10 + 100));
      }
      return total;
    };
    const wallDistM = (q) => {
      let d = Infinity;
      for (let w = 0; w < ctx.w.n; w++) d = Math.min(d, E.geom.pointSegDistPx(q.x * W, q.y * H, ctx.w.ax[w], ctx.w.ay[w], ctx.w.ax[w] + ctx.w.sx[w], ctx.w.ay[w] + ctx.w.sy[w]));
      return d * p.scale.mpp;
    };
    const field = (router) => raster.field(ctx, g, { band: 5, router, offsets: {}, aa: 1 });
    let checked = 0;
    for (const start of routerSpots(p)) {
      const r = await E.optimize.find(ctx, g, { band: 5, goalRoom: null, allowedRoom: null, threshold: p.model.threshold, router: start, offsets: {} });
      // before / after are exactly the softened numbers of those positions
      assert.equal(r.after.coverage, raster.stats(g, field(r.pos), null, p.model.threshold).coverage);
      assert.equal(r.before.coverage, raster.stats(g, field(start), null, p.model.threshold).coverage);
      if (wallDistM(start) < 0.2) continue; // too close to a wall (e.g. in a doorway): not an allowed answer itself
      checked++;
      assert.ok(objective(field(r.pos)) >= objective(field(start)) - 1e-9, `${name}: the answer is worse than the start ${JSON.stringify(start)}`);
      // asking again from the answer never makes it worse
      const again = await E.optimize.find(ctx, g, { band: 5, goalRoom: null, allowedRoom: null, threshold: p.model.threshold, router: r.pos, offsets: {} });
      assert.ok(objective(field(again.pos)) >= objective(field(r.pos)) - 1e-9, `${name}: asking again got worse`);
    }
    assert.ok(checked >= 2, `${name}: ${checked} starts checked`);
  }
});

test('soften: performance - the softened field is not slower than the exact one', (t) => {
  const p = realProject() || demoProject();
  p.net.router = P.nearestFloor(p.plan, { x: 0.5, y: 0.49 });
  const ctx = ctxOf(p);
  const time = (fn, k = 7) => {
    fn();
    const ts = [];
    for (let i = 0; i < k; i++) {
      const t0 = performance.now();
      fn();
      ts.push(performance.now() - t0);
    }
    return ts.sort((a, b) => a - b)[k >> 1];
  };
  const st = model.fieldParams(p, 'trial');
  const g4 = raster.grid(ctx, { cell: 4 });
  const g8 = raster.grid(ctx, { cell: 8 });
  const buf8 = new Float32Array(g8.cols * g8.rows);
  const r = {
    hard8: time(() => raster.field(ctx, g8, { ...st, ...HARD }, buf8)),
    soft8: time(() => raster.field(ctx, g8, st, buf8)),
    hard4aa2: time(() => raster.field(ctx, g4, { ...st, aa: 2, ...HARD })),
    soft4aa2: time(() => raster.field(ctx, g4, { ...st, aa: 2 })),
  };
  const msg = Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ');
  t.diagnostic(msg);
  console.log(`  [perf] ${msg}`);
  // generous bounds (shared CI machines); the interesting numbers are in the log line above
  assert.ok(r.soft8 < r.hard8 * 1.6 + 1, msg);
  assert.ok(r.soft4aa2 < r.hard4aa2 * 1.2, msg);
});

// ---------------------------------------------------------------------------------------------------------------
// contours on the softened field, Chaikin smoothing
// ---------------------------------------------------------------------------------------------------------------

test('contours: traced on the softened field - the range lines follow the colours', () => {
  for (const [name, p] of plans()) {
    p.net.router = P.nearestFloor(p.plan, { x: 0.5, y: 0.49 });
    const ctx = ctxOf(p);
    const thr = p.model.rangeThreshold;
    const opts = { band: 5, router: p.net.router, offsets: {}, threshold: thr };
    const chains = raster.contours(ctx, opts);
    assert.ok(chains.length >= 1);
    assert.deepEqual(raster.contours(ctx, opts), chains, 'deterministic');
    // compare with the softened full-quality field the planner draws
    const g = raster.grid(ctx, { cell: 4 });
    const f = raster.field(ctx, g, { band: 5, router: p.net.router, offsets: {}, aa: 2 });
    let checked = 0;
    let bad = 0;
    for (const ch of chains) {
      for (const q of ch) {
        // only points well inside a room (the lines extend a little beyond the outlines and are clipped when drawn)
        const id = model.roomAtPx(ctx, q.x * W, q.y * H);
        if (!id) continue;
        let inner = true;
        for (const [dx, dy] of [[-12, 0], [12, 0], [0, -12], [0, 12]]) if (model.roomAtPx(ctx, q.x * W + dx, q.y * H + dy) !== id || model.wallBlocks(ctx, q.x * W, q.y * H, q.x * W + dx, q.y * H + dy)) inner = false;
        if (!inner) continue;
        checked++;
        if (Math.abs(raster.sample(g, f, q) - thr) > 1) bad++;
      }
    }
    assert.ok(checked > 100, `${name}: ${checked} points checked`);
    assert.ok(bad <= checked * 0.02, `${name}: ${bad} of ${checked} line points are more than 1 dB off the iso-value`);
    // the lines stay at the floor: nothing farther than ~2 lattice cells outside the rooms
    for (const ch of chains) {
      for (const q of ch) {
        if (model.roomAtPx(ctx, q.x * W, q.y * H)) continue;
        assert.equal(P.floorMaskAt(p.plan, P.nearestFloor(p.plan, q)), true);
        const nf = P.nearestFloor(p.plan, q);
        assert.ok(Math.hypot((nf.x - q.x) * W, (nf.y - q.y) * H) < 2.5 * 9 + 16, `${name}: point ${q.x},${q.y} far outside the floor`);
      }
    }
  }
});

test('contours: chains are smoothed (Chaikin), closed loops stay closed, smooth:0 gives the raw polylines', () => {
  const p = realProject() || demoProject();
  p.net.router = P.nearestFloor(p.plan, { x: 0.5, y: 0.49 });
  const ctx = ctxOf(p);
  const opts = { band: 5, router: p.net.router, offsets: {}, threshold: p.model.rangeThreshold };
  const raw = raster.contours(ctx, { ...opts, smooth: 0 });
  const smooth = raster.contours(ctx, opts);
  assert.equal(smooth.length, raw.length);
  // sharpest turn along a chain (degrees)
  const maxTurn = (ch) => {
    let m = 0;
    for (let k = 1; k + 1 < ch.length; k++) {
      const ax = (ch[k].x - ch[k - 1].x) * W;
      const ay = (ch[k].y - ch[k - 1].y) * H;
      const bx = (ch[k + 1].x - ch[k].x) * W;
      const by = (ch[k + 1].y - ch[k].y) * H;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      m = Math.max(m, (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180) / Math.PI);
    }
    return m;
  };
  let rawTurn = 0;
  let smoothTurn = 0;
  smooth.forEach((ch, k) => {
    const r = raw[k];
    const closed = r[0].x === r[r.length - 1].x && r[0].y === r[r.length - 1].y;
    assert.equal(ch[0].x === ch[ch.length - 1].x && ch[0].y === ch[ch.length - 1].y, closed, 'closed stays closed, open stays open');
    // every Chaikin pass doubles the points of a loop (m unique points -> 2m) and of an open chain (2 kept end points +
    // 2 per segment); two passes: 4x - of the chain without its marching-squares stubs (a few % of the points)
    assert.ok(ch.length <= (closed ? (r.length - 1) * 4 + 1 : r.length * 4), `${ch.length} points from ${r.length}`);
    assert.ok(ch.length >= r.length * 3, `${ch.length} points from ${r.length}: only stubs are dropped`);
    if (!closed) {
      assert.deepEqual(ch[0], r[0], 'open chains keep their end points');
      assert.deepEqual(ch[ch.length - 1], r[r.length - 1]);
    }
    rawTurn = Math.max(rawTurn, maxTurn(r));
    smoothTurn = Math.max(smoothTurn, maxTurn(ch));
    // every smoothed point stays within half a lattice cell (9 px) of the raw polyline
    for (const q of ch) {
      let d = Infinity;
      for (let i = 1; i < r.length; i++) d = Math.min(d, E.geom.pointSegDistPx(q.x * W, q.y * H, r[i - 1].x * W, r[i - 1].y * H, r[i].x * W, r[i].y * H));
      assert.ok(d < 4.5, `smoothed point ${d.toFixed(2)} px from the raw line`);
    }
  });
  console.log(`  [contours] sharpest turn of a range line: ${rawTurn.toFixed(0)} deg raw -> ${smoothTurn.toFixed(0)} deg smoothed`);
  assert.ok(smoothTurn < rawTurn / 2 && smoothTurn < 35, `sharpest turn ${rawTurn.toFixed(0)} deg -> ${smoothTurn.toFixed(0)} deg`);
  // the same on the demo and on a field handed in (planner path), and on the exact lattice (soften 0)
  const demo = demoProject();
  demo.net.router = P.nearestFloor(demo.plan, { x: 0.5, y: 0.49 });
  const cd = ctxOf(demo);
  const gd = raster.grid(cd, { cell: 4 });
  const fd = raster.field(cd, gd, { band: 5, router: demo.net.router, offsets: {}, aa: 2 });
  for (const o of [{ band: 5, router: demo.net.router, offsets: {}, threshold: demo.model.rangeThreshold }, { band: 5, router: demo.net.router, threshold: demo.model.rangeThreshold, grid: gd, field: fd }, { band: 5, router: demo.net.router, offsets: {}, threshold: demo.model.rangeThreshold, soften: 0 }]) {
    const rawD = raster.contours(cd, { ...o, smooth: 0 });
    const smD = raster.contours(cd, o);
    const a = Math.max(...rawD.map(maxTurn));
    const b = Math.max(...smD.map(maxTurn));
    // the exact field has real corners (wedge tips, wall steps): there the smoothing only rounds them off
    const ok = o.soften === 0 ? b < a * 0.75 : b < 35 && b < a;
    assert.ok(ok, `demo ${o.grid ? 'given field' : o.soften === 0 ? 'exact' : 'default'}: sharpest turn ${a.toFixed(0)} -> ${b.toFixed(0)} deg`);
  }
  // chaikin itself
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }];
  const c1 = raster.chaikin(sq, 1);
  assert.equal(c1.length, 9);
  assert.deepEqual(c1[0], { x: 0.25, y: 0 });
  assert.deepEqual(c1[c1.length - 1], c1[0]);
  const line = raster.chaikin([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], 2);
  assert.deepEqual(line[0], { x: 0, y: 0 });
  assert.deepEqual(line[line.length - 1], { x: 1, y: 1 });
  assert.deepEqual(raster.chaikin([{ x: 0, y: 0 }, { x: 1, y: 1 }], 2).length, 2, 'two-point chains are left alone');
});

test('contours: a given grid + field is traced as is (exactly the colours); open lines end at the floor', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls: [wall('stub', 550, 100, 550, 450, 12)], router: [200, 200] });
  const ctx = ctxOf(p);
  const g = raster.grid(ctx, { cell: 4 });
  const f = raster.field(ctx, g, { band: 5, router: p.net.router, offsets: {}, aa: 2 });
  const copy = f.slice();
  const chains = raster.contours(ctx, { band: 5, router: p.net.router, threshold: -58, grid: g, field: f, smooth: 0 });
  assert.deepEqual(f, copy, 'the caller\'s field is not modified');
  assert.ok(chains.length >= 1);
  let open = 0;
  for (const ch of chains) {
    const closed = ch[0].x === ch[ch.length - 1].x && ch[0].y === ch[ch.length - 1].y;
    if (!closed) open++;
    for (const q of ch) {
      if (!P.floorMaskAt(p.plan, q)) continue;
      if (Math.abs(q.x * W - 550) < 8 && q.y * H < 455) continue; // along the wall step
      assert.ok(Math.abs(raster.sample(g, f, q) + 58) < 0.6, `${raster.sample(g, f, q)} at ${q.x * W},${q.y * H}`);
    }
  }
  assert.ok(open >= 1, 'the weak router\'s range line leaves the room: open chains ending at the outline');
  // the same through the default path (its own coarser grid) is close to it
  const own = raster.contours(ctx, { band: 5, router: p.net.router, offset: 0, threshold: -58 });
  assert.ok(own.length >= 1);
});

// ---------------------------------------------------------------------------------------------------------------
// analysis.run: today's statistics are cached with today's field
// ---------------------------------------------------------------------------------------------------------------

test('analysis.run: cache keeps today\'s stats/perRoom (no re-sort while the router moves) and invalidates them correctly', () => {
  const p = demoProject();
  const ctx = ctxOf(p);
  const offsets = model.offsets(ctx, p);
  const cache = {};
  const calls = { stats: 0, perRoom: 0 };
  const orig = { stats: raster.stats, perRoom: raster.perRoom };
  raster.stats = (...a) => (calls.stats++, orig.stats(...a));
  raster.perRoom = (...a) => (calls.perRoom++, orig.perRoom(...a));
  try {
    const a = E.analysis.run(p, { cell: 8, ctx, offsets, cache });
    assert.deepEqual(calls, { stats: 1, perRoom: 1 }, 'trial == today: computed once');
    assert.notEqual(a.stats.trial, a.stats.today);
    assert.deepEqual(a.stats.trial, a.stats.today);
    assert.notEqual(a.perRoom.trial, a.perRoom.today);
    assert.deepEqual(a.perRoom.trial, a.perRoom.today);
    const frames = [];
    for (let k = 0; k < 5; k++) {
      p.net.router = P.nearestFloor(p.plan, { x: 0.3 + k * 0.08, y: 0.45 });
      frames.push(E.analysis.run(p, { cell: 8, ctx, offsets, cache }));
    }
    assert.deepEqual(calls, { stats: 6, perRoom: 6 }, 'only the trial statistics are computed while dragging');
    for (const b of frames) {
      assert.equal(b.stats.today, a.stats.today, 'same cached object');
      assert.equal(b.perRoom.today, a.perRoom.today);
    }
    // the cached numbers are exactly the uncached ones
    const fresh = E.analysis.run(p, { cell: 8, ctx, offsets });
    assert.deepEqual(fresh.stats.today, frames[4].stats.today);
    assert.deepEqual(fresh.perRoom.today, frames[4].perRoom.today);
    assert.deepEqual(fresh.stats.trial, frames[4].stats.trial);
    // goal / threshold / exclusions / baseline / soften changes invalidate them
    const before = frames[4].stats.today;
    p.model.threshold = -60;
    const t1 = E.analysis.run(p, { cell: 8, ctx, offsets, cache });
    assert.notEqual(t1.stats.today, before);
    assert.ok(t1.stats.today.coverage < before.coverage);
    p.goal.excluded = [2];
    const t2 = E.analysis.run(p, { cell: 8, ctx, offsets, cache });
    assert.notEqual(t2.stats.today, t1.stats.today);
    assert.equal(t2.today, t1.today, 'the field itself is still cached');
    p.goal.room = 3;
    const t3 = E.analysis.run(p, { cell: 8, ctx, offsets, cache });
    assert.equal(t3.stats.today.n, t3.grid.roomCells.get(3).length);
    const t4 = E.analysis.run(p, { cell: 8, ctx, offsets, cache, soften: 0 });
    assert.notEqual(t4.today, t3.today);
    p.net.baseline = { ...p.net.router };
    const t5 = E.analysis.run(p, { cell: 8, ctx, offsets, cache, soften: 0 });
    assert.notEqual(t5.today, t4.today);
    assert.deepEqual(t5.stats.today, E.analysis.run(p, { cell: 8, ctx, offsets, soften: 0 }).stats.today);
  } finally {
    raster.stats = orig.stats;
    raster.perRoom = orig.perRoom;
  }
});

test('stats: median / p10 by selection are exactly the sorted values (ties, clamped fields, tiny rooms)', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 600, 500), room(2, 600, 100, 1000, 500), room(3, 100, 500, 108, 508)], router: [300, 300] });
  const ctx = ctxOf(p);
  const g = raster.grid(ctx, { cell: 4 });
  const r = rng(5);
  const sorted = (vals) => Float32Array.from(vals).sort();
  const expectOf = (vals, thr) => {
    const s = sorted(vals);
    const k = s.length;
    return { median: s[Math.floor((k - 1) * 0.5)], p10: s[Math.floor((k - 1) * 0.1)], coverage: (100 * vals.filter((v) => v >= thr).length) / k };
  };
  const gens = [
    () => -110 + r() * 90, // continuous
    () => -110 + Math.floor(r() * 6) * 10, // few distinct values, many ties
    () => -110, // constant (fully clamped)
    () => (r() < 0.5 ? -110 : -20), // two values
  ];
  for (const gen of gens) {
    const f = new Float32Array(g.cols * g.rows).fill(NaN);
    for (const i of g.idx) f[i] = gen();
    for (const ids of [null, [1], [2], [3], [1, 3]]) {
      const cells = (ids || g.roomIds).flatMap((id) => Array.from(g.roomCells.get(id) || []));
      const want = expectOf(cells.map((i) => f[i]), -67);
      const got = raster.stats(g, f, ids, -67);
      assert.equal(got.median, want.median);
      assert.equal(got.p10, want.p10);
      assert.equal(got.coverage, want.coverage);
      assert.equal(got.n, cells.length);
    }
    for (const [id, s] of raster.perRoom(g, f, -67)) {
      const want = expectOf(Array.from(g.roomCells.get(id)).map((i) => f[i]), -67);
      assert.equal(s.median, want.median);
      assert.equal(s.p10, want.p10);
    }
    assert.ok(f.every((v, i) => (g.room[i] ? v === v : v !== v)), 'the field itself is not reordered');
  }
  // sorted, reverse sorted and organ-pipe inputs (quickselect worst cases) in rooms of very different sizes
  for (const make of [(k) => k, (k) => -k, (k, len) => Math.min(k, len - k), (k) => (k * 7919) % 13]) {
    const f = new Float32Array(g.cols * g.rows).fill(NaN);
    for (const id of g.roomIds) {
      const cells = g.roomCells.get(id);
      cells.forEach((i, k) => (f[i] = -110 + (90 * make(k, cells.length)) / cells.length));
    }
    for (const id of g.roomIds) {
      const want = expectOf(Array.from(g.roomCells.get(id)).map((i) => f[i]), -67);
      const got = raster.stats(g, f, [id], -67);
      assert.equal(got.median, want.median, `room ${id} (${g.roomCells.get(id).length} cells)`);
      assert.equal(got.p10, want.p10, `room ${id}`);
    }
  }
  assert.ok(g.roomCells.get(3).length <= 4, 'a tiny room is part of the test');
});
