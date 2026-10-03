// SPEC 7.1: band-dependent obstacle loss, per-band presets, model.bandPower.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, readPrivatePlan, rawPayloadOf } from './_load.mjs';
import { n, room, wall, door, furn, makeProject, ctxOf } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const { model, raster, project: P } = E;
const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);
const BIG = [room(1, 0, 0, 1000, 900)];
const plan = (extra = {}) => makeProject({ rooms: BIG, ...extra });
const presetWall = (id, ax, ay, bx, by, material, loss) => ({ ...wall(id, ax, ay, bx, by), material, ...(loss === undefined ? {} : { loss }) });

/** 32-bit FNV + murmur-ish hash of the raw float bits of a field: equal hashes = bit-identical fields. */
function hashF32(a) {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x1b873593 | 0;
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 16777619);
    h2 = Math.imul((h2 + u[i]) | 0, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------------------------

test('band constants: factor, wall and furniture tables (SPEC 7.1), frozen, shared with project', () => {
  assert.deepEqual({ ...model.BAND_FACTOR }, { '2.4': 0.65, '5': 1, '6': 1.15 });
  const T = (a, b, c) => ({ '2.4': a, '5': b, '6': c });
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(model.MATERIALS), {
    drywall: T(3, 4, 5),
    wood: T(3, 5, 6),
    glass: T(2, 4, 5),
    brick: T(7, 11, 13),
    masonry: T(7, 11, 13),
    solid_guess: T(10, 15, 18),
    concrete: T(12, 18, 21),
    reinforced_concrete: T(17, 26, 30),
    metal: T(25, 30, 32),
  });
  assert.deepEqual(plain(model.FURNITURE_KINDS), { bed: T(1, 1, 1), wood: T(2, 3, 4), books: T(3, 5, 6), appliance: T(6, 8, 9), metal: T(10, 12, 13), custom: null });
  for (const o of [model.BAND_FACTOR, model.MATERIALS, model.MATERIALS.brick, model.FURNITURE_KINDS, model.FURNITURE_KINDS.bed]) assert.ok(Object.isFrozen(o));
  assert.equal(model.MATERIALS, P.MATERIALS);
  // the number a preset stores in wall.loss / furniture.loss is the table's 5 GHz value
  for (const [k, row] of Object.entries(model.MATERIALS)) assert.equal(P.WALL_MATERIALS[k], row['5'], k);
  for (const [k, row] of Object.entries(model.FURNITURE_KINDS)) if (row) assert.equal(P.FURNITURE_KINDS[k], row['5'], k);
  // every table: 2.4 <= 5 <= 6 (higher frequencies never penetrate better)
  for (const row of [...Object.values(model.MATERIALS), ...Object.values(model.FURNITURE_KINDS).filter(Boolean)]) assert.ok(row['2.4'] <= row['5'] && row['5'] <= row['6']);
  assert.deepEqual({ ...model.LEGACY_MATERIALS }, { drywall: 3, brick: 8, concrete: 12, reinforced_concrete: 18, glass: 3, wood: 3, metal: 25, masonry: 8, solid_guess: 12 });
});

// ---------------------------------------------------------------------------------------------------------------
// obstacleLossFor / lossBands / presetOf
// ---------------------------------------------------------------------------------------------------------------

test('obstacleLossFor: presets use the table, everything else is the stored 5 GHz value x factor', () => {
  const pr = makeProject({ rooms: BIG, model: { wallLoss: 10 } });
  const L = (o, b) => model.obstacleLossFor(o, b, pr);
  const W = (material, loss) => ({ type: 'wall', a: n(1, 1), b: n(2, 2), ...(material ? { material } : {}), ...(loss === undefined ? {} : { loss }) });
  // preset with the new 5 GHz number, with the OLD preset number (legacy files), without a number
  for (const w of [W('brick', 11), W('brick', 8), W('brick')]) assert.deepEqual([L(w, 2.4), L(w, 5), L(w, 6)], [7, 11, 13], JSON.stringify(w));
  assert.deepEqual([L(W('metal', 30), 2.4), L(W('metal', 25), 6)], [25, 32]);
  assert.deepEqual([L(W('reinforced_concrete', 18), 2.4), L(W('reinforced_concrete', 18), 5)], [17, 26], 'old reinforced 18 -> table');
  assert.deepEqual([L(W('concrete', 18), 2.4), L(W('concrete', 18), 6)], [12, 21], 'new concrete 18 is the concrete preset, not legacy reinforced');
  // edited number on a preset material, custom, a number without material: scaled
  for (const w of [W('brick', 9), W('custom', 9), { type: 'wall', a: n(1, 1), b: n(2, 2), loss: 9 }]) {
    assert.deepEqual([L(w, 2.4), L(w, 5), L(w, 6)], [5.85, 9, 10.35], JSON.stringify(w));
  }
  // no loss of its own -> model.wallLoss (here 10) x factor; without a project the default 8
  assert.deepEqual([L(W(), 2.4), L(W(), 5), L(W(), 6)], [6.5, 10, 11.5]);
  assert.deepEqual([model.obstacleLossFor(W(), 2.4), model.obstacleLossFor(W(), 5)], [5.2, 8]);
  // doors: scaled, an open doorway stays 0
  const d = (loss) => ({ type: 'door', a: n(1, 1), b: n(2, 2), wallId: 'w', loss });
  assert.deepEqual([L(d(3), 2.4), L(d(3), 5), L(d(3), 6)], [1.95, 3, 3.45]);
  assert.deepEqual([L(d(0), 2.4), L(d(0), 6)], [0, 0]);
  // furniture: preset kind with its 5 GHz number -> table; custom / edited -> scaled; not blocking -> 0
  const F = (kind, loss, blocksSignal = true) => ({ type: 'furniture', points: [n(1, 1), n(9, 1), n(9, 9)], kind, loss, blocksSignal });
  assert.deepEqual([L(F('books', 5), 2.4), L(F('books', 5), 5), L(F('books', 5), 6)], [3, 5, 6]);
  assert.deepEqual([L(F('bed', 1), 2.4), L(F('bed', 1), 6)], [1, 1]);
  assert.deepEqual([L(F('appliance', 8), 2.4), L(F('metal', 12), 6)], [6, 13]);
  assert.deepEqual([L(F('custom', 6), 2.4), L(F('custom', 6), 6)], [3.9, 6.9]);
  assert.deepEqual([L(F('books', 7), 2.4), L(F('books', 7), 5)], [4.55, 7], 'edited number on a preset kind');
  assert.equal(L(F('metal', 12, false), 5), 0, 'does not block');
  // type inferred when missing, unknown band = 5 GHz, garbage = 0
  assert.equal(model.obstacleLossFor({ a: n(1, 1), b: n(2, 2), material: 'brick', loss: 11 }, '2,4'), 7);
  assert.equal(model.obstacleLossFor({ points: [n(1, 1), n(9, 1), n(9, 9)], kind: 'wood', loss: 3 }, 6), 4);
  assert.equal(model.obstacleLossFor(W('brick', 11), 7), 11);
  assert.equal(model.obstacleLossFor(null, 5), 0);
  assert.equal(model.obstacleLossFor({ type: 'room', points: [] }, 5), 0);
  assert.deepEqual(model.lossBands(W('glass', 4), pr), { '2.4': 2, '5': 4, '6': 5 });
  assert.deepEqual(model.lossBands(d(2), pr), { '2.4': 1.3, '5': 2, '6': 2.3 });
});

test('presetOf: the preset whose table applies, null for custom numbers', () => {
  assert.equal(model.presetOf({ type: 'wall', material: 'brick', loss: 11 }), 'brick');
  assert.equal(model.presetOf({ type: 'wall', material: 'brick', loss: 8 }), 'brick', 'legacy number');
  assert.equal(model.presetOf({ type: 'wall', material: 'brick', loss: 9 }), null);
  assert.equal(model.presetOf({ type: 'wall', material: 'custom', loss: 11 }), null);
  assert.equal(model.presetOf({ type: 'wall' }), null, 'follows model.wallLoss');
  assert.equal(model.presetOf({ type: 'wall', material: '__proto__', loss: 1 }), null);
  assert.equal(model.presetOf({ type: 'furniture', kind: 'books', loss: 5 }), 'books');
  assert.equal(model.presetOf({ type: 'furniture', kind: 'books', loss: 4 }), null);
  assert.equal(model.presetOf({ type: 'furniture', kind: 'custom', loss: 3 }), null);
  assert.equal(model.presetOf({ type: 'door', loss: 3 }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// the physics per band
// ---------------------------------------------------------------------------------------------------------------

test('traceLoss per band: walls, doors and furniture use the band of the ray', () => {
  const p = plan({
    walls: [wall('c', 500, 100, 500, 800, 10), presetWall('b', 700, 100, 700, 800, 'brick', 11), wall('d', 300, 100, 300, 800, 8)],
    doors: [door('dd', 'd', 300, 400, 300, 480, 3)],
    furniture: [furn('f', 820, 400, 900, 480, 4), { ...furn('k', 120, 400, 200, 480), kind: 'books', loss: 5 }],
  });
  const c = ctxOf(p);
  const a = n(100, 440);
  const b = n(950, 440);
  // books 3/5/6 + door 3 x f + custom wall 10 x f + brick 7/11/13 + custom furniture 4 x f
  const expect = { 2.4: 3 + 1.95 + 6.5 + 7 + 2.6, 5: 5 + 3 + 10 + 11 + 4, 6: 6 + 3.45 + 11.5 + 13 + 4.6 };
  for (const band of [2.4, 5, 6]) {
    close(model.obstacleLoss(c, a, b, band), expect[band], 1e-9, `band ${band}`);
    close(model.obstacleLoss(model.forBand(c, band), a, b), expect[band], 1e-9, `forBand ${band}`);
    close(model.traceLoss(model.forBand(c, band), a.x * 1080, a.y * 942, b.x * 1080, b.y * 942), expect[band], 1e-9);
  }
  close(model.obstacleLoss(c, a, b), expect[5], 1e-9, 'the context of createContext is the 5 GHz one');
  // the signal: 20*log10(f/5) as before PLUS the band's obstacle losses
  for (const band of [2.4, 6]) {
    const d = model.rawSignal(c, a, b, band) - model.rawSignal(c, a, b, 5);
    close(d, -20 * Math.log10(band / 5) + expect[5] - expect[band], 1e-9, `band ${band}`);
  }
  // 2.4 GHz gains far more than the free-space 6.4 dB through these five obstacles
  assert.ok(model.rawSignal(c, a, b, 2.4) - model.rawSignal(c, a, b, 5) > 17);
  assert.ok(model.rawSignal(c, a, b, 5) - model.rawSignal(c, a, b, 6) > 5);
});

test('forBand: views share geometry and version, are cached, unknown bands leave the context alone', () => {
  const c = ctxOf(plan({ walls: [wall('w', 500, 100, 500, 800, 8)] }));
  assert.equal(c.band, 5);
  const c24 = model.forBand(c, 2.4);
  const c6 = model.forBand(c, '6');
  assert.equal(model.forBand(c, 2.4), c24, 'cached');
  assert.equal(model.forBand(c24, 5), c, 'back to the 5 GHz context');
  assert.equal(model.forBand(c6, '2,4'), c24);
  assert.equal(model.forBand(c, 7), c);
  assert.equal(model.forBand(c, undefined), c);
  for (const v of [c24, c6]) {
    assert.equal(v.version, c.version);
    assert.equal(v.roomsVersion, c.roomsVersion);
    assert.equal(v.w, c.w);
    assert.equal(v.rooms, c.rooms);
    assert.deepEqual(Object.keys(v), Object.keys(c), 'same shape');
  }
  assert.deepEqual([c24.wl[0], c.wl[0], c6.wl[0]], [5.2, 8, 9.2]);
  assert.doesNotThrow(() => JSON.stringify({ c, c24, c6 }), 'no reference cycles (the views live in a WeakMap)');
  // the softening barrier is decided on the 5 GHz reference: identical for every band
  for (const v of [c24, c, c6]) assert.equal(model.wallBlocks(v, 400, 400, 600, 400), true);
});

test('ctx.version reflects every band: a preset and a custom wall with the same 5 GHz loss differ', () => {
  const v = (walls, model2) => ctxOf(plan({ walls, ...(model2 ? { model: model2 } : {}) })).version;
  const brick = v([presetWall('w', 500, 100, 500, 800, 'brick', 11)]);
  const custom = v([wall('w', 500, 100, 500, 800, 11)]);
  assert.notEqual(brick, custom, '7/11/13 vs 7.15/11/12.65');
  assert.equal(v([presetWall('w', 500, 100, 500, 800, 'brick', 8)]), brick, 'legacy number = the same preset');
  assert.notEqual(v([], { bandPower: { '2.4': -3 } }), v([]), 'bandPower');
});

test('model.bandPower: added to that band only (router and node), sanitized, round-trips', () => {
  const base = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], router: [150, 400], baseline: [150, 400] });
  const boosted = plan({ walls: [wall('w', 500, 100, 500, 800, 8)], router: [150, 400], baseline: [150, 400], model: { bandPower: { '2.4': -3, '5': 2.5, '6': 0 } } });
  assert.deepEqual(boosted.model.bandPower, { '2.4': -3, '5': 2.5, '6': 0 });
  const c0 = ctxOf(base);
  const c1 = ctxOf(boosted);
  const a = n(150, 400);
  const b = n(800, 420);
  close(model.rawSignal(c1, a, b, 2.4) - model.rawSignal(c0, a, b, 2.4), -3);
  close(model.rawSignal(c1, a, b, 5) - model.rawSignal(c0, a, b, 5), 2.5);
  close(model.rawSignal(c1, a, b, 6) - model.rawSignal(c0, a, b, 6), 0);
  close(model.softSignal(c1, a, b, 5) - model.softSignal(c0, a, b, 5), 2.5, 1e-9, 'softened too');
  // the field (and so coverage) moves with it
  const g = raster.grid(c0, { cell: 8 });
  const f0 = raster.field(c0, g, model.fieldParams(base, 'trial', { band: 2.4 }));
  const f1 = raster.field(c1, g, model.fieldParams(boosted, 'trial', { band: 2.4 }));
  for (const i of g.idx) if (f0[i] > -105 && f0[i] < -25) close(f1[i] - f0[i], -3, 1e-4);
  // sanitize: defaults, clamping, garbage
  assert.deepEqual(P.create({ template: 'blank' }).model.bandPower, { '2.4': 0, '5': 0, '6': 0 });
  assert.deepEqual(P.sanitize({ ...base, model: { ...base.model, bandPower: { '2.4': -99, '5': 99, '6': 'x' } } }).model.bandPower, { '2.4': -10, '5': 6, '6': 0 });
  assert.deepEqual(P.sanitize({ ...base, model: { ...base.model, bandPower: [1, 2, 3] } }).model.bandPower, { '2.4': 0, '5': 0, '6': 0 });
  const back = P.parseSvgText(P.buildSvg(boosted)).project;
  assert.deepEqual(back.model.bandPower, boosted.model.bandPower);
  assertValidProject(back);
  // a context of an unsanitized project without bandPower works (0 everywhere)
  const raw = JSON.parse(JSON.stringify(base));
  delete raw.model.bandPower;
  close(model.rawSignal(model.createContext(raw), a, b, 5), model.rawSignal(c0, a, b, 5));
});

test('legacy walls: the OLD preset numbers become the new tables on load, other numbers keep their value', () => {
  const raw = {
    format: 'wifi-floor-v2',
    plan: {
      rooms: [{ id: 'r', roomId: 1, name: 'R', points: [n(0, 0), n(1000, 0), n(1000, 900), n(0, 900)], color: '#8eadd2' }],
      walls: [
        presetWall('a', 100, 100, 100, 800, 'drywall', 3),
        presetWall('b', 200, 100, 200, 800, 'reinforced_concrete', 18),
        presetWall('c', 300, 100, 300, 800, 'brick', 9),
        presetWall('d', 400, 100, 400, 800, 'custom', 8),
        presetWall('e', 500, 100, 500, 800, 'metal'),
        wall('f', 600, 100, 600, 800),
      ],
      doors: [],
      furniture: [],
    },
    width: 10,
  };
  const p = P.sanitize(raw);
  assert.deepEqual(p.plan.walls.map((w) => [w.material, w.loss]), [
    ['drywall', 4],
    ['reinforced_concrete', 26],
    ['brick', 9],
    ['custom', 8],
    ['metal', 30],
    [undefined, undefined],
  ]);
  assert.deepEqual(P.sanitize(p), p, 'idempotent');
  // what the model uses at 2.4 GHz
  assert.deepEqual(p.plan.walls.map((w) => model.obstacleLossFor(w, 2.4, p)), [3, 17, 5.85, 5.2, 25, 5.2]);
});

// ---------------------------------------------------------------------------------------------------------------
// raster / contours / calibration / speed / optimizer use the band's losses
// ---------------------------------------------------------------------------------------------------------------

test('raster.field per band = the exact point model per band; analysis.run follows the band', () => {
  const p = plan({
    walls: [presetWall('b', 500, 100, 500, 800, 'brick', 11), wall('c', 100, 500, 900, 500, 6)],
    doors: [door('d', 'b', 500, 300, 500, 380, 3)],
    furniture: [{ ...furn('k', 650, 600, 750, 700), kind: 'appliance', loss: 8 }],
    router: [250, 250],
    baseline: [250, 250],
  });
  const c = ctxOf(p);
  const g = raster.grid(c, { cell: 8 });
  for (const band of [2.4, 5, 6]) {
    const st = model.fieldParams(p, 'trial', { band });
    const f = raster.field(c, g, { ...st, soften: 0 });
    let worst = 0;
    for (const i of g.idx) worst = Math.max(worst, Math.abs(f[i] - model.signal(c, st.router, { x: g.cx[i], y: g.cy[i] }, band)));
    assert.ok(worst < 1e-4, `band ${band}: exact field vs point model ${worst}`);
    // softened field vs the softened point model (away from walls)
    const fs = raster.field(c, g, st);
    for (const q of [n(800, 250), n(300, 750), n(820, 800)]) close(raster.sample(g, fs, q), model.softSignal(c, st.router, q, band), 0.6, `band ${band} soft`);
    const a = E.analysis.run(p, { cell: 8, band, ctx: c });
    assert.deepEqual(Array.from(a.trial), Array.from(fs));
  }
  // 2.4 GHz through the walls: clearly better than 5 GHz, 6 GHz worse
  const cov = (band) => E.analysis.run(p, { cell: 8, band }).stats.trial.coverage;
  assert.ok(cov(2.4) > cov(5) + 10 && cov(5) > cov(6), `${cov(2.4)} / ${cov(5)} / ${cov(6)}`);
});

/**
 * Two projects whose physics are identical by construction: A seen at 2.4 GHz and B seen at 5 GHz, where B has the
 * 2.4 GHz losses of A as its 5 GHz numbers and nearSignal shifted by the 2.4 GHz free-space gain. Anything that traces
 * rays at the requested band must give the same answer for both.
 */
function twinProjects() {
  const geomA = {
    rooms: [room(1, 100, 100, 500, 450), room(2, 500, 100, 950, 450), room(3, 100, 450, 950, 850)],
    walls: [wall('v', 500, 100, 500, 450, 10), wall('h', 100, 450, 950, 450, 14), wall('o', 100, 100, 950, 100, 6)],
    doors: [door('d', 'h', 250, 450, 330, 450, 4)],
    router: [300, 250],
    baseline: [300, 250],
  };
  const A = makeProject({ ...geomA, model: { nearSignal: -40 } });
  const shift = -20 * Math.log10(2.4 / 5);
  const B = makeProject({
    ...geomA,
    walls: [wall('v', 500, 100, 500, 450, 6.5), wall('h', 100, 450, 950, 450, 9.1), wall('o', 100, 100, 950, 100, 3.9)],
    doors: [door('d', 'h', 250, 450, 330, 450, 2.6)],
    model: { nearSignal: -40 + shift },
  });
  return { A, B };
}

test('contours and calibration trace the requested band (twin projects: A at 2.4 GHz == B at 5 GHz)', () => {
  const { A, B } = twinProjects();
  const ca = ctxOf(A);
  const cb = ctxOf(B);
  for (const soften of [0, undefined]) {
    const la = raster.contours(ca, { band: 2.4, router: A.net.router, threshold: -62, soften });
    const lb = raster.contours(cb, { band: 5, router: B.net.router, threshold: -62, soften });
    assert.equal(la.length, lb.length, `soften ${soften}`);
    la.forEach((ch, k) => ch.forEach((q, j) => assert.ok(Math.abs(q.x - lb[k][j].x) < 1e-5 && Math.abs(q.y - lb[k][j].y) < 1e-5)));
    assert.notDeepEqual(la, raster.contours(ca, { band: 5, router: A.net.router, threshold: -62, soften }));
  }
  // calibration on 2.4 GHz measurements: the band's own prediction, so a constant shift is recovered exactly
  const pts = [n(800, 300), n(700, 700), n(200, 650), n(400, 200)];
  const ms = pts.map((q, i) => ({ id: `m${i}`, ...q, band: 2.4, value: Math.round((model.softRawSignal(ca, A.net.baseline, q, 2.4) - 4) * 100) / 100, name: 'm', download: null, upload: null, device: 'Telefon', t: 0 }));
  const cal = model.calibrate(ca, ms, 2.4, { baseline: A.net.baseline });
  close(cal.offset, -4, 0.006);
  assert.ok(cal.rms < 0.006);
  const twin = model.calibrate(cb, ms.map((m) => ({ ...m, band: 5 })), 5, { baseline: B.net.baseline });
  close(twin.offset, cal.offset, 1e-4);
  assert.equal(model.calibrate(ca, ms, 5, { baseline: A.net.baseline }).n, 0, 'other bands are not calibrated by them');
});

test('speed: a speed-only point gets the prediction of ITS band', () => {
  const { A } = twinProjects();
  const c = ctxOf(A);
  const q = n(800, 700);
  const offsets = { '2.4': -2, '5': 1, '6': 0 };
  const list = [2.4, 5, 6].map((band, i) => ({ id: `s${i}`, ...q, band, value: null, name: 's', download: 50, upload: 10, device: 'Telefon', t: 0 }));
  const out = E.speed.fillSignals(c, list, { baseline: A.net.baseline, offsets });
  out.forEach((m, i) => close(m.value, model.softSignal(c, A.net.baseline, q, list[i].band, offsets[String(list[i].band)]), 0.006));
  assert.ok(out[0].value - out[1].value > 6.4 + 3, '2.4 GHz is predicted stronger than the free-space difference alone (walls lose less)');
  assert.ok(out[2].value < out[1].value);
});

test('optimize.find searches with the band\'s losses (twin projects: A at 2.4 GHz == B at 5 GHz)', async () => {
  const { A, B } = twinProjects();
  const run = async (p, band) => {
    const ctx = ctxOf(p);
    const grid = raster.grid(ctx, { cell: 8 });
    return E.optimize.find(ctx, grid, { band, goalRoom: null, allowedRoom: null, threshold: -60, router: p.net.router, offsets: { '2.4': 0, '5': 0, '6': 0 }, node: null });
  };
  const ra = await run(A, 2.4);
  const rb = await run(B, 5);
  assert.deepEqual(ra.pos, rb.pos);
  close(ra.score, rb.score, 1e-3);
  close(ra.scoreBefore, rb.scoreBefore, 1e-3);
  close(ra.after.coverage, rb.after.coverage, 1e-6);
  close(ra.before.mean, rb.before.mean, 1e-3);
  const r5 = await run(A, 5);
  assert.ok(Math.abs(r5.scoreBefore - ra.scoreBefore) > 1, 'a different band really is different');
});

// ---------------------------------------------------------------------------------------------------------------
// optional private real plan (WH_PRIVATE_PLAN, see _load.mjs) - every expectation is derived from the file itself
// ---------------------------------------------------------------------------------------------------------------

test('private plan: stored numbers keep their 5 GHz meaning; 2.4 GHz reaches further, 6 GHz less', () => {
  const svg = readPrivatePlan();
  if (svg === null) return; // not part of the repository: skipped unless WH_PRIVATE_PLAN points at a plan
  const raw = rawPayloadOf(svg);
  const p = P.parseSvgText(svg).project;
  const fieldOf = (proj, band, cell) => {
    const ctx = ctxOf(proj);
    const g = raster.grid(ctx, { cell });
    return { g, f: raster.field(ctx, g, { ...model.fieldParams(proj, 'trial', { band }), aa: cell <= 4 ? 2 : 1 }) };
  };
  // (1) a wall that carried an OLD preset number (SPEC 7.1) is that preset now, stored as the new table's 5 GHz value
  const rawWalls = (raw && raw.plan && raw.plan.walls) || [];
  p.plan.walls.forEach((w, i) => {
    const rw = rawWalls[i];
    if (!rw || !rw.material || !(rw.material in P.LEGACY_WALL_MATERIALS) || rw.loss !== P.LEGACY_WALL_MATERIALS[rw.material]) return;
    assert.equal(w.material, rw.material, `wall ${i}: material kept`);
    assert.equal(w.loss, model.MATERIALS[rw.material]['5'], `wall ${i}: old ${rw.material} ${rw.loss} -> table value`);
  });
  // (2) the stored number IS the 5 GHz loss: the same walls as plain custom numbers give a bit-identical 5 GHz field
  const custom = JSON.parse(JSON.stringify(p));
  custom.plan.walls.forEach((w, i) => { if (w.material && w.material !== 'custom') Object.assign(w, { material: 'custom', loss: model.obstacleLossFor(p.plan.walls[i], 5, p) }); });
  for (const cell of [8, 4]) assert.equal(hashF32(fieldOf(custom, 5, cell).f), hashF32(fieldOf(p, 5, cell).f), `presets vs custom numbers, cell ${cell}`);
  // (3) coverage per band, whole flat, router where it is today: the lower band goes further through the walls
  const cov = {};
  for (const band of [2.4, 5, 6]) {
    const { g, f } = fieldOf(p, band, 8);
    cov[band] = raster.stats(g, f, null, p.model.threshold, []).coverage;
  }
  console.log(`  [bands] private plan coverage 2.4 / 5 / 6 GHz: ${cov[2.4].toFixed(1)} / ${cov[5].toFixed(1)} / ${cov[6].toFixed(1)} %`);
  assert.ok(cov[2.4] >= cov[5] && cov[5] >= cov[6], JSON.stringify(cov));
  if (p.plan.walls.length && cov[5] < 99) assert.ok(cov[2.4] > cov[5], `2.4 GHz ahead of 5 GHz: ${JSON.stringify(cov)}`);
});

test('demo: 2.4 GHz covers clearly more than 5 GHz, 6 GHz the least (today and at a good spot)', () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  for (const router of [p.net.baseline, P.nearestFloor(p.plan, { x: 0.5, y: 0.4 })]) {
    p.net.router = router;
    const cov = Object.fromEntries([2.4, 5, 6].map((band) => [band, E.analysis.run(p, { cell: 8, band }).stats.trial.coverage]));
    assert.ok(cov[2.4] > cov[5] + 10 && cov[5] > cov[6] + 3, JSON.stringify(cov));
  }
});
