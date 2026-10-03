import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, door, furn, makeProject, ctxOf, lossPx } from './_helpers.mjs';

const { model } = E;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);
const BIG = [room(1, 0, 0, 1000, 900)];
const plan = (extra = {}) => makeProject({ rooms: BIG, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// free-space part
// ---------------------------------------------------------------------------------------------------------------

test('free space: plateau within 1 m, then -10*n*log10(d)', () => {
  const p = plan();
  const c = ctxOf(p);
  const from = n(100, 100);
  close(model.rawSignal(c, from, n(150, 100), 5), -40, 1e-9, '0.5 m');
  close(model.rawSignal(c, from, n(200, 100), 5), -40, 1e-9, '1 m');
  close(model.rawSignal(c, from, n(300, 100), 5), -40 - 22 * Math.log10(2), 1e-9, '2 m');
  close(model.rawSignal(c, from, n(600, 100), 5), -40 - 22 * Math.log10(5), 1e-9, '5 m');
});

test('free space: signal falls monotonically with distance', () => {
  const c = ctxOf(plan());
  let prev = Infinity;
  for (let d = 100; d <= 900; d += 25) {
    const s = model.rawSignal(c, n(100, 450), n(100 + d, 450), 5);
    assert.ok(s <= prev + 1e-12, `d=${d}`);
    prev = s;
  }
});

test('bands: 2.4 > 5 > 6 GHz, differences follow 20*log10(f/5)', () => {
  const c = ctxOf(plan());
  const a = n(100, 100);
  const b = n(500, 100);
  const s24 = model.rawSignal(c, a, b, 2.4);
  const s5 = model.rawSignal(c, a, b, 5);
  const s6 = model.rawSignal(c, a, b, 6);
  assert.ok(s24 > s5 && s5 > s6);
  close(s24 - s5, -20 * Math.log10(2.4 / 5), 1e-9);
  close(s5 - s6, 20 * Math.log10(6 / 5), 1e-9);
});

test('model parameters: nearSignal shifts, distance exponent n scales the decay', () => {
  const p = plan({ model: { nearSignal: -30, n: 3 } });
  const c = ctxOf(p);
  close(model.rawSignal(c, n(100, 100), n(300, 100), 5), -30 - 30 * Math.log10(2), 1e-9);
});

test('signal() adds the offset and clamps to [-110, -20]', () => {
  const c = ctxOf(plan({ model: { nearSignal: -25, n: 1.6 } }));
  assert.equal(model.signal(c, n(100, 100), n(110, 100), 2.4, 10), -20, 'upper clamp');
  assert.equal(model.signal(c, n(100, 100), n(110, 100), 5, -200), -110, 'lower clamp');
  close(model.signal(c, n(100, 100), n(500, 100), 5, 3), model.rawSignal(c, n(100, 100), n(500, 100), 5) + 3, 1e-9);
});

test('rawSignal: nodePower is added', () => {
  const c = ctxOf(plan());
  const a = model.rawSignal(c, n(100, 100), n(400, 100), 5);
  const b = model.rawSignal(c, n(100, 100), n(400, 100), 5, { nodePower: -4 });
  close(b - a, -4);
});

// ---------------------------------------------------------------------------------------------------------------
// walls
// ---------------------------------------------------------------------------------------------------------------

test('wall: explicit loss, default loss from the model, missing wall', () => {
  const p = plan({ walls: [wall('w1', 500, 100, 500, 800, 5)] });
  close(lossPx(p, 300, 400, 700, 400), 5);
  const q = plan({ walls: [wall('w1', 500, 100, 500, 800)], model: { wallLoss: 11 } });
  close(lossPx(q, 300, 400, 700, 400), 11, 1e-9, 'follows model.wallLoss');
  close(lossPx(p, 300, 850, 700, 850), 0, 1e-9, 'ray passes below the wall end');
  close(lossPx(p, 300, 400, 450, 400), 0, 1e-9, 'ray stops before the wall');
});

test('wall: loss is symmetric (a->b == b->a) for random rays', () => {
  const p = plan({ walls: [wall('w1', 500, 100, 500, 800, 5), wall('w2', 200, 500, 800, 500, 7), wall('w3', 100, 100, 900, 800, 3)] });
  const c = ctxOf(p);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 400; k++) {
    const a = n(rnd() * 1000, rnd() * 900);
    const b = n(rnd() * 1000, rnd() * 900);
    close(model.obstacleLoss(c, a, b), model.obstacleLoss(c, b, a), 1e-9);
  }
});

test('corner: a ray through the corner of two walls counts the stronger wall once', () => {
  // corner at (500,500); horizontal wall 6 dB going right, vertical wall 10 dB going down
  const p = plan({ walls: [wall('h', 500, 500, 800, 500, 6), wall('v', 500, 500, 500, 800, 10)] });
  // diagonal through the corner point from the inside of the L to the outside
  close(lossPx(p, 650, 650, 350, 350), 10, 1e-9, 'through the corner: MAX, not the sum');
  // passing only the horizontal wall (to the right of the corner), only the vertical one (below), neither
  close(lossPx(p, 600, 600, 600, 400), 6);
  close(lossPx(p, 600, 600, 400, 600), 10);
  close(lossPx(p, 450, 450, 350, 350), 0);
});

test('T-junction: a ray through the junction is counted once', () => {
  const p = plan({ walls: [wall('top', 300, 500, 700, 500, 8), wall('stem', 500, 500, 500, 800, 8)] });
  close(lossPx(p, 480, 700, 520, 300), 8);
  // and a ray that crosses stem and top wall far from each other counts both
  close(lossPx(p, 400, 700, 600, 300), 16 - 8, 1e-9, 'crosses top only (stem x=500 reached at y=500)');
  close(lossPx(p, 300, 700, 700, 400), 16, 1e-9, 'crosses stem at y~550 and top wall at x~633: two separate walls');
});

test('duplicate / overlapping walls count once (MAX), real double walls count twice', () => {
  const dup = plan({ walls: [wall('a', 500, 100, 500, 800, 8), wall('b', 500, 100, 500, 800, 8)] });
  close(lossPx(dup, 300, 400, 700, 400), 8);
  const dupDiff = plan({ walls: [wall('a', 500, 100, 500, 800, 5), wall('b', 500.8, 100, 500.8, 800, 8)] });
  close(lossPx(dupDiff, 300, 400, 700, 400), 8, 1e-9, '0.8 px apart -> same cluster -> MAX');
  const partial = plan({ walls: [wall('a', 500, 100, 500, 800, 5), wall('b', 500, 300, 500, 500, 9)] });
  close(lossPx(partial, 300, 400, 700, 400), 9, 1e-9);
  close(lossPx(partial, 300, 200, 700, 200), 5, 1e-9);
  const dbl = plan({ walls: [wall('a', 500, 100, 500, 800, 5), wall('b', 510, 100, 510, 800, 8)] });
  close(lossPx(dbl, 300, 400, 700, 400), 13, 1e-9, '10 px apart is a real double wall');
});

test('a ray running along a wall counts as a single crossing', () => {
  const p = plan({ walls: [wall('a', 300, 500, 600, 500, 8)] });
  close(lossPx(p, 100, 500, 900, 500), 8);
  close(lossPx(p, 100, 500.4, 900, 500.4), 8, 1e-9, 'within the collinear tolerance');
  close(lossPx(p, 100, 505, 900, 505), 0, 1e-9, 'parallel but 5 px away');
  close(lossPx(p, 350, 500, 550, 500), 8, 1e-9, 'ray entirely inside the wall');
});

test('walls are extended by 1.5 px: gaps up to ~3 px at corners and junctions are closed', () => {
  // a long wall with a 2.9 px gap in the middle
  const closed = plan({ walls: [wall('a', 100, 500, 498.55, 500, 8), wall('b', 501.45, 500, 900, 500, 8)] });
  for (const x of [498.7, 500, 501.3]) close(lossPx(closed, x - 40, 300, x + 40, 700), 8, 1e-9, `x=${x}`);
  // a clearly open gap of 6 px stays open
  const open = plan({ walls: [wall('a', 100, 500, 497, 500, 8), wall('b', 503, 500, 900, 500, 8)] });
  close(lossPx(open, 500, 300, 500, 700), 0, 1e-9);
});

test('walls with zero length are ignored', () => {
  const p = plan({ walls: [wall('z', 500, 500, 500, 500, 20)] });
  close(lossPx(p, 300, 500, 700, 500), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// doors
// ---------------------------------------------------------------------------------------------------------------

test('door: closed door loss inside its span, wall loss outside, open doorway = 0', () => {
  const walls = [wall('w', 500, 100, 500, 800, 8)];
  const closedDoor = plan({ walls, doors: [door('d', 'w', 500, 400, 500, 480, 3)] });
  close(lossPx(closedDoor, 300, 440, 700, 440), 3, 1e-9, 'through the door');
  close(lossPx(closedDoor, 300, 300, 700, 300), 8, 1e-9, 'through the wall');
  close(lossPx(closedDoor, 300, 482, 700, 482), 3, 1e-9, 'within 3 px of the door end still counts as the door');
  close(lossPx(closedDoor, 300, 490, 700, 490), 8, 1e-9, '10 px away is the wall');
  const open = plan({ walls, doors: [door('d', 'w', 500, 400, 500, 480, 0)] });
  close(lossPx(open, 300, 440, 700, 440), 0, 1e-9);
  // oblique ray through the doorway
  close(lossPx(open, 300, 380, 700, 500), 0, 1e-9, 'crosses x=500 at y=440');
  // a door only works on its own wall
  const other = plan({ walls: [...walls, wall('x', 100, 440, 400, 440, 4)], doors: [door('d', 'w', 500, 400, 500, 480, 0)] });
  close(lossPx(other, 450, 440, 700, 440), 0, 1e-9);
});

test('door adjacent to a perpendicular wall does not create double counting', () => {
  // wall with a doorway right next to a T-junction
  const p = plan({
    walls: [wall('w', 500, 100, 500, 800, 8), wall('t', 500, 300, 800, 300, 8)],
    doors: [door('d', 'w', 500, 310, 500, 390, 0)],
  });
  close(lossPx(p, 300, 350, 700, 350), 0, 1e-9);
});

// ---------------------------------------------------------------------------------------------------------------
// furniture
// ---------------------------------------------------------------------------------------------------------------

test('furniture: full loss once per piece, ignored when it does not block', () => {
  const f = [furn('f', 400, 400, 600, 450, 5)];
  const p = plan({ furniture: f });
  close(lossPx(p, 500, 300, 500, 600), 5, 1e-9, 'vertical ray through the piece');
  close(lossPx(p, 300, 420, 700, 420), 5, 1e-9, 'horizontal ray through its length');
  close(lossPx(p, 300, 300, 700, 300), 0, 1e-9, 'misses');
  const free = plan({ furniture: [furn('f', 400, 400, 600, 450, 5, false)] });
  close(lossPx(free, 500, 300, 500, 600), 0);
  const zero = plan({ furniture: [furn('f', 400, 400, 600, 450, 0)] });
  close(lossPx(zero, 500, 300, 500, 600), 0);
  close(lossPx(p, 500, 300, 500, 425), 5, 1e-9, 'ray ending inside counts');
  close(lossPx(p, 500, 425, 500, 700), 5, 1e-9, 'ray starting inside counts');
});

test('furniture: concave piece is counted once even when the ray crosses two arms', () => {
  const U = {
    id: 'u',
    type: 'furniture',
    name: 'u',
    points: [n(400, 400), n(500, 400), n(500, 500), n(550, 500), n(550, 400), n(650, 400), n(650, 600), n(400, 600)],
    loss: 6,
    kind: 'custom',
    blocksSignal: true,
  };
  const p = plan({ furniture: [U] });
  close(lossPx(p, 300, 450, 700, 450), 6, 1e-9, 'crosses both arms of the U');
  close(lossPx(p, 525, 300, 525, 450), 0, 1e-9, 'enters the notch only');
});

test('furniture: grazing a corner gives a proportional (soft) loss, never more than the full loss', () => {
  const p = plan({ furniture: [furn('f', 400, 400, 600, 450, 6)] });
  const soft = 0.15 / 0.01; // 15 px of chord for the full loss at 1 px = 1 cm
  // rays on the lines x+y=c clip the top-left corner (400,400): chord = sqrt(2)*(c-800)
  let prev = 0;
  for (let c = 796; c <= 840; c++) {
    const l = lossPx(p, c - 300, 300, 300, c - 300);
    const chord = Math.max(0, Math.SQRT2 * (c - 800));
    close(l, 6 * Math.min(1, chord / soft), 2e-3, `c=${c}`); // points are stored with 6 decimals (0.0005 px)
    assert.ok(l >= prev - 1e-9, 'monotone');
    assert.ok(l - prev <= 0.6, `no jump (${l - prev})`);
    prev = l;
  }
  assert.equal(prev, 6, 'long chords get the full loss');
});

// ---------------------------------------------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------------------------------------------

test('ctx.version: depends on geometry and parameters, not on router positions', () => {
  const base = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], router: [100, 100] });
  const v0 = ctxOf(base).version;
  assert.equal(ctxOf(base).version, v0, 'stable');
  const moved = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], router: [300, 300] });
  assert.equal(ctxOf(moved).version, v0, 'router position is not part of the geometry');
  assert.notEqual(ctxOf(plan({ walls: [wall('w', 502, 100, 500, 800, 8)] })).version, v0, 'wall moved');
  assert.notEqual(ctxOf(plan({ walls: [wall('w', 500, 100, 500, 800, 9)] })).version, v0, 'wall loss');
  assert.notEqual(ctxOf(plan({ walls: [wall('w', 500, 100, 500, 800, 8)], model: { n: 2.5 } })).version, v0, 'model');
  assert.notEqual(ctxOf(plan({ walls: [wall('w', 500, 100, 500, 800, 8)], mpp: 0.011 })).version, v0, 'scale');
  assert.equal(ctxOf(base).roomsVersion, ctxOf(plan({ walls: [] })).roomsVersion, 'roomsVersion ignores walls');
});

// ---------------------------------------------------------------------------------------------------------------
// calibration
// ---------------------------------------------------------------------------------------------------------------

function meas(c, base, pts, shift, extra = {}) {
  return pts.map(([x, y], i) => ({
    id: `m${i}`,
    ...n(x, y),
    band: 5,
    value: Math.round((model.rawSignal(c, base, n(x, y), 5) + shift[i % shift.length]) * 100) / 100,
    name: `p${i}`,
    download: null,
    upload: null,
    device: 'Phone',
    t: 0,
    ...extra,
  }));
}

test('calibrate: offset = median residual, rms = spread around it', () => {
  const p = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], baseline: [200, 400], router: [200, 400] });
  const c = ctxOf(p);
  const pts = [[300, 300], [700, 400], [800, 600], [350, 700], [650, 250]];
  const ms = meas(c, p.net.baseline, pts, [-6, -5, -7, -6, -6]);
  const r = model.calibrate(c, ms, 5, { device: 'Phone', baseline: p.net.baseline });
  close(r.offset, -6, 0.011);
  assert.equal(r.n, 5);
  assert.equal(r.fallback, false);
  close(r.rms, Math.sqrt((0 + 1 + 1 + 0 + 0) / 5), 0.02);
  assert.equal(r.used.length, 5);
  assert.ok(r.used.every((u) => Number.isFinite(u.residual) && Number.isFinite(u.predicted)));
  assert.equal(r.suspicious, false);
  // an outlier does not move a median calibration much
  const withOutlier = [...ms, ...meas(c, p.net.baseline, [[900, 800]], [15], { id: 'out' })];
  assert.ok(Math.abs(model.calibrate(c, withOutlier, 5, { device: 'Phone', baseline: p.net.baseline }).offset - -6) <= 0.51);
});

test('calibrate: per band, device preference with fallback to all devices, empty -> zero', () => {
  const p = plan({ baseline: [200, 400], router: [200, 400] });
  const c = ctxOf(p);
  const phone = meas(c, p.net.baseline, [[300, 300], [600, 500]], [-4], { device: 'Phone' });
  const laptop = meas(c, p.net.baseline, [[350, 350], [650, 450]], [-10], { device: 'Laptop', id: 'L' }).map((m, i) => ({ ...m, id: `L${i}` }));
  const all = [...phone, ...laptop];
  const o = { baseline: p.net.baseline };
  close(model.calibrate(c, all, 5, { ...o, device: 'phone' }).offset, -4, 0.011, 'case-insensitive device match');
  close(model.calibrate(c, all, 5, { ...o, device: ' Laptop ' }).offset, -10, 0.011);
  const fb = model.calibrate(c, all, 5, { ...o, device: 'Tablet' });
  assert.equal(fb.fallback, true);
  assert.equal(fb.n, 4);
  close(fb.offset, -7, 0.011, 'median of -4,-4,-10,-10');
  const none = model.calibrate(c, all, 2.4, { ...o, device: 'Phone' });
  assert.deepEqual({ offset: none.offset, rms: none.rms, n: none.n, used: none.used.length }, { offset: 0, rms: 0, n: 0, used: 0 });
  assert.equal(model.calibrate(c, [], 5, o).offset, 0);
});

test('calibrate flags absurd offsets as suspicious', () => {
  const p = plan({ baseline: [200, 400], router: [200, 400] });
  const c = ctxOf(p);
  const ms = meas(c, p.net.baseline, [[300, 300], [600, 500]], [-35]);
  assert.equal(model.calibrate(c, ms, 5, { baseline: p.net.baseline }).suspicious, true);
});

test('offsets()/calibrateAll honour view.calibrate and project device', () => {
  const p = plan({ baseline: [200, 400], router: [200, 400], goal: { device: 'Phone' } });
  const c = ctxOf(p);
  p.measurements = meas(c, p.net.baseline, [[300, 300], [600, 500]], [-5]);
  const o = model.offsets(c, p);
  close(o['5'], -5, 0.011);
  assert.equal(o['2.4'], 0);
  p.view.calibrate = false;
  assert.deepEqual(model.offsets(c, p), { '2.4': 0, '5': 0, '6': 0 });
  assert.deepEqual(Object.keys(model.calibrateAll(c, p)).sort(), ['2.4', '5', '6']);
});

test('calibration makes the model reproduce the measurements', () => {
  const p = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], baseline: [200, 400], router: [200, 400] });
  const c = ctxOf(p);
  p.measurements = meas(c, p.net.baseline, [[300, 300], [700, 400], [800, 600]], [-6]);
  const off = model.offsets(c, p);
  for (const m of p.measurements) close(model.signal(c, p.net.baseline, m, 5, off['5']), m.value, 0.011);
});

// ---------------------------------------------------------------------------------------------------------------
// node / combined
// ---------------------------------------------------------------------------------------------------------------

test('combinedSignal = max(router, node); bands the node does not serve are ignored; backhaul', () => {
  const p = plan({
    walls: [wall('w', 500, 100, 500, 800, 8)],
    router: [150, 400],
    baseline: [150, 400],
    node: { mode: 'mesh_wifi', pos: n(800, 400), bands: { '2.4': true, '5': true, '6': false }, power: 2, backhaulBand: 5, backhaulThreshold: -67 },
  });
  const c = ctxOf(p);
  const st = model.fieldParams(p, 'trial', { band: 5 });
  assert.ok(st.node, 'node params present');
  const near = n(850, 400);
  const far = n(100, 400);
  const r = model.signal(c, st.router, near, 5, 0);
  const nd = model.signal(c, st.node.pos, near, 5, 2);
  close(model.combinedSignal(c, near, 5, st), Math.max(r, nd), 1e-9);
  assert.ok(nd > r, 'node wins next to it');
  close(model.combinedSignal(c, far, 5, st), model.signal(c, st.router, far, 5, 0), 1e-9);
  // 6 GHz is not served by the node
  const st6 = model.fieldParams(p, 'trial', { band: 6 });
  close(model.combinedSignal(c, near, 6, st6), model.signal(c, st6.router, near, 6, 0), 1e-9);
  // today never contains the node
  assert.equal(model.fieldParams(p, 'today', { band: 5 }).node, null);
  // backhaul: router -> node through the wall on the backhaul band
  close(model.backhaulSignal(c, st), model.signal(c, st.router, st.node.pos, 5, 0), 1e-9);
  assert.equal(model.backhaulSignal(c, { router: st.router, node: null }), null);
  // offsets are applied per band
  const stOff = { ...st, offsets: { '2.4': 0, '5': -3, '6': 0 } };
  close(model.combinedSignal(c, far, 5, stOff), model.combinedSignal(c, far, 5, st) - 3, 1e-9);
});

test('pointSignalDetail: router, node, combined, baseline, best source, weak backhaul', () => {
  const p = plan({
    walls: [wall('w', 500, 100, 500, 800, 20)],
    router: [150, 400],
    baseline: [100, 200],
    node: { mode: 'mesh_wifi', pos: n(900, 400), bands: { '2.4': true, '5': true, '6': false }, power: 0, backhaulBand: 5, backhaulThreshold: -55 },
  });
  const c = ctxOf(p);
  const st = model.fieldParams(p, 'trial', { band: 5 });
  const d = model.pointSignalDetail(c, n(850, 420), st);
  assert.equal(d.bestSource, 'node');
  assert.ok(d.node > d.router);
  close(d.combined, d.node);
  close(d.baseline, model.signal(c, p.net.baseline, n(850, 420), 5, 0), 1e-9);
  assert.equal(d.weakBackhaul, true, 'uplink through a 20 dB wall is below -55 dBm');
  const left = model.pointSignalDetail(c, n(120, 420), st);
  assert.equal(left.bestSource, 'router');
  assert.equal(left.weakBackhaul, false);
  // no node
  const solo = model.pointSignalDetail(c, n(300, 300), model.fieldParams(p, 'today', { band: 5 }));
  assert.equal(solo.node, null);
  assert.equal(solo.backhaul, null);
  close(solo.combined, solo.router);
});

test('createContext tolerates half-edited objects (missing points, NaN) without throwing', () => {
  const p = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], furniture: [furn('f', 400, 400, 600, 450, 5)], doors: [door('d', 'w', 500, 400, 500, 480, 0)] });
  const broken = JSON.parse(JSON.stringify(p));
  broken.plan.walls.push({ id: 'x1', type: 'wall', a: null, b: { x: 0.5, y: 0.5 } });
  broken.plan.walls.push({ id: 'x2', type: 'wall', a: { x: NaN, y: 0 }, b: { x: 0.5, y: 0.5 } });
  broken.plan.walls.push(null);
  broken.plan.doors.push({ id: 'dx', wallId: 'w', a: undefined, b: undefined });
  broken.plan.furniture.push({ id: 'fx', points: [{ x: 0.1, y: 0.1 }], loss: 5, blocksSignal: true });
  broken.plan.furniture.push({ id: 'fy', points: null, loss: 5 });
  broken.plan.rooms.push({ id: 'rx', roomId: 9, points: [{ x: 0.1 }, null, 5] });
  const c = model.createContext(broken);
  const good = ctxOf(p);
  assert.equal(c.w.n, good.w.n);
  assert.equal(c.f.n, good.f.n);
  assert.equal(c.rooms.length, 1);
  assert.equal(c.version, good.version, 'broken objects do not change the hash');
  close(model.obstacleLoss(c, n(300, 470), n(700, 470)), 0, 1e-9, 'the door still works');
  const g = E.raster.grid(c);
  assert.ok(g.count > 0);
});
