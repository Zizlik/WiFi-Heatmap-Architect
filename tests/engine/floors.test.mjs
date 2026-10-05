// SPEC 14.3: floors - data, migration, helpers, files (the old app opens the active floor), the cross-floor physics
// (3-D distance, ceiling loss, the target floor's walls half-weighted), per-floor contexts / analysis / what-if /
// calibration / spots, "Celý dům", the optimizer with the router floor fixed, the two-storey demo house.
// Holes in a slab (stairwells = furniture kind opening) skip the ceiling loss where the path crosses them; stairs and open
// galleries are not modelled (documented).
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, makeProject, mkNode, rectPts, rng } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';
import { legacyLoadSvg } from './_legacy.mjs';

const { W, H } = E.CANVAS;
const P = E.project;
const M = E.model;
const R = E.raster;
const S = E.speed;
const A = E.analysis;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (eps ${eps})`);
const HARD = { soften: 0 };

/** One open 9 x 5 m room (0.01 m/px), the router at (300, 450); a second identical floor above (concrete, 2.7 m). */
function house({ wallsUp = [], wallsDown = [], ceiling, nodesUp = [], view } = {}) {
  const p = makeProject({ rooms: [room(1, 100, 200, 1000, 700, 'Dole')], walls: wallsDown, router: [300, 450], view: view || { band: 5 } });
  const up = P.addFloor(p, { copyFrom: 'floor-1' });
  const F = p.floors.find((f) => f.id === up);
  F.plan.walls = wallsUp;
  F.plan.rooms[0].name = 'Nahoře';
  F.nodes = nodesUp;
  // the slab between the floors is the ceiling of the lower floor
  if (ceiling) P.setCeiling(p, 'floor-1', ceiling);
  return P.sanitize(p);
}
const at = (x, y) => n(x, y);

test('data: an old file is one floor; floors are sanitized (levels, ceilings, the active floor, ids across floors)', () => {
  const one = makeProject({ rooms: [room(1, 100, 100, 600, 500)], router: [300, 300] });
  assert.deepEqual(one.floors, [{ id: 'floor-1', name: 'Přízemí', level: 0, ceiling: { material: 'concrete', lossDb: 15, heightM: 2.7 }, plan: null, nodes: null, measurements: null, goal: null }]);
  assert.equal(one.net.routerFloor, 'floor-1');
  assert.equal(one.net.opticFloor, 'floor-1');
  assert.equal(one.view.floor, 'floor-1');
  assert.equal(P.sanitize({ plan: { rooms: [] } }, { lang: 'en' }).floors[0].name, 'Ground floor');
  // a messy building: duplicate levels, garbage ceilings, the active floor by view.floor, measurement ids clash
  const plan2 = { rooms: [room(1, 100, 100, 600, 500)] };
  const raw = {
    plan: { rooms: [room(1, 100, 100, 600, 500)] },
    project: {
      net: { router: n(300, 300), routerFloor: 'b', opticFloor: 'zzz' },
      measurements: [{ id: 'm1', x: 0.3, y: 0.3, band: 5, value: -60 }],
      goal: { allowedRoom: 1, room: 1, excluded: [1] },
      view: { floor: 'a' },
      floors: [
        { id: 'a', level: 1, plan: null, ceiling: { material: 'wood', lossDb: 'x', heightM: 99 } },
        { id: 'b', level: 1, name: 'Sklep?', plan: plan2, measurements: [{ id: 'm1', x: 0.3, y: 0.3, band: 5, value: -70 }], goal: { room: 7, excluded: [1, 9] }, ceiling: { material: 'plasma', lossDb: 12 } },
        { id: 'a', level: -9, plan: plan2 },
      ],
    },
  };
  const p = P.sanitize(raw);
  assertValidProject(p, 'messy');
  assert.deepEqual(
    p.floors.map((f) => [f.id, f.level, f.name, f.plan === null]),
    [
      ['floor-1', -3, '3. suterén', false],
      ['a', 1, '1. patro', true],
      ['b', 2, 'Sklep?', false],
    ],
    'sorted by level, a repeated level moves up, a duplicate id renamed',
  );
  assert.deepEqual(p.floors[1].ceiling, { material: 'wood', lossDb: 8, heightM: 6 });
  assert.deepEqual(p.floors[2].ceiling, { material: 'custom', lossDb: 12, heightM: 2.7 });
  assert.equal(p.view.floor, 'a');
  assert.equal(p.net.routerFloor, 'b');
  assert.equal(p.net.opticFloor, 'b', 'an unknown inlet floor -> the router floor');
  assert.deepEqual(p.floors[2].goal, { room: 'all', excluded: [1] });
  assert.equal(p.goal.allowedRoom, 1, 'allowedRoom checked against the router floor');
  assert.equal(p.floors[2].measurements[0].id !== p.measurements[0].id, true, 'measurement ids unique in the building');
  // a non-active floor without a plan: strict refuses, non-strict drops it
  const broken = { plan: { rooms: [] }, project: { floors: [{ id: 'x', plan: null }, { id: 'y', plan: 'nope' }] } };
  assert.throws(() => P.sanitize(broken), (e) => e.message === 'err.plan.invalid');
  assert.deepEqual(P.sanitize(broken, { strict: false }).floors.map((f) => f.id), ['x']);
  // at most 9 floors (the active one always kept)
  const tooMany = { plan: { rooms: [] }, project: { view: { floor: 'f11' }, floors: Array.from({ length: 12 }, (_, k) => ({ id: `f${k}`, level: k, plan: k === 11 ? null : { rooms: [] } })) } };
  const tm = P.sanitize(tooMany, { strict: false });
  assert.equal(tm.floors.length, 9);
  assert.equal(tm.view.floor, 'f11');
});

test('helpers: add / duplicate / switch / view / rename / ceiling / move / remove floors', () => {
  const p = makeProject({ rooms: [room(1, 100, 100, 600, 500, 'Obývák'), room(2, 600, 100, 900, 500, 'Balkon')], router: [300, 300], goal: { excluded: [2] } });
  p.plan.background = 'data:image/png;base64,iVBORw0KGgo=';
  p.nodes.push(mkNode({ pos: n(700, 300) }));
  p.measurements.push({ id: 'm1', x: 0.3, y: 0.3, band: 5, value: -55, name: 'x', download: null, upload: null, device: 'Telefon', t: 0 });
  const up = P.duplicateFloor(p, 'floor-1');
  assert.equal(up, 'floor-2');
  const F2 = P.floorOf(p, up);
  assert.deepEqual([F2.name, F2.level, F2.active], ['1. patro', 1, false]);
  assert.deepEqual(F2.plan.rooms.map((r) => r.name), ['Obývák', 'Balkon']);
  assert.equal(F2.plan.background, null, 'the tracing image is not copied');
  assert.deepEqual([F2.nodes, F2.measurements, F2.goal], [[], [], { room: 'all', excluded: [2] }]);
  const down = P.addFloor(p, { above: false, lang: 'en' });
  assert.deepEqual([P.floorOf(p, down).name, P.floorOf(p, down).level], ['Basement', -1]);
  assertValidProject(p, 'three floors');
  // the view of floor 2 = the project switched to floor 2
  const view = P.atFloor(p, up);
  const sw = P.clone(p);
  assert.equal(P.switchFloor(sw, up), true);
  for (const k of ['plan', 'nodes', 'measurements', 'floors', 'view']) assert.deepEqual(view[k], sw[k], k);
  assert.deepEqual([view.goal.room, view.goal.excluded], [sw.goal.room, sw.goal.excluded]);
  assert.equal(P.activeFloorId(sw), up);
  assert.equal(sw.view.floor, up);
  assertValidProject(sw, 'switched');
  // and back: exactly the original
  P.switchFloor(sw, 'floor-1');
  assert.deepEqual(sw, p);
  assert.equal(P.atFloor(p, 'floor-1'), p);
  assert.equal(P.atFloor(p, 'nope'), p);
  assert.equal(P.switchFloor(sw, 'nope'), false);
  // rename / ceiling
  P.renameFloor(p, up, '  Podkroví ');
  assert.equal(P.floorOf(p, up).name, 'Podkroví');
  P.renameFloor(p, up, '');
  assert.equal(P.floorOf(p, up).name, '1. patro');
  P.setCeiling(p, 'floor-1', { material: 'wood' });
  assert.deepEqual(P.floorOf(p, 'floor-1').ceiling, { material: 'wood', lossDb: 8, heightM: 2.7 });
  P.setCeiling(p, 'floor-1', { lossDb: 11, heightM: 3 });
  assert.deepEqual(P.floorOf(p, 'floor-1').ceiling, { material: 'custom', lossDb: 11, heightM: 3 });
  P.setCeiling(p, 'floor-1', { material: 'reinforced_concrete' });
  assert.equal(P.floorOf(p, 'floor-1').ceiling.lossDb, 20);
  // the slabs between floors
  assert.deepEqual(P.floorGap(p, down, up), { levels: 2, heightM: 2.7 + 3, lossDb: 15 + 20 });
  assert.deepEqual(P.floorGap(p, up, up), { levels: 0, heightM: 0, lossDb: 0 });
  // reorder: swap levels (default names follow)
  assert.equal(P.moveFloor(p, down, +1), true);
  assert.deepEqual(
    p.floors.map((f) => [f.id, f.level, f.name]),
    [
      ['floor-1', -1, 'Suterén'],
      [down, 0, 'Ground floor'],
      [up, 1, '1. patro'],
    ],
  );
  assert.equal(P.moveFloor(p, up, +1), false, 'already the highest');
  assertValidProject(p, 'reordered');
  // remove the router's floor: the router moves to the new active floor; the last floor stays
  const q = P.clone(p);
  q.floors.find((f) => f.id === up).nodes.push(mkNode({ id: 'node-up', pos: n(300, 300), uplink: 'node-1' }));
  assert.equal(P.removeFloor(q, 'floor-1'), true);
  assert.equal(P.activeFloorId(q), down);
  assert.equal(q.net.routerFloor, down);
  assert.ok(P.floorMaskAt(q.plan, q.net.router) || !q.plan.rooms.length);
  assert.equal(P.floorOf(q, up).nodes[0].uplink, 'router', 'its node was removed with the floor');
  assertValidProject(P.sanitize(q), 'removed');
  assert.equal(P.removeFloor(q, down), true);
  assert.equal(P.removeFloor(q, up), false, 'never the last floor');
  // MAX_FLOORS
  const r = makeProject({ rooms: [room(1, 100, 100, 600, 500)] });
  for (let k = 0; k < 8; k++) assert.ok(P.addFloor(r));
  assert.equal(P.addFloor(r), null);
  assert.equal(r.floors.length, 9);
});

test('files: two floors round trip (JSON + SVG); the OLD app and older builds open the active floor', () => {
  const p = house({ nodesUp: [mkNode({ id: 'node-up', mode: 'mesh_wifi', pos: n(500, 450) })] });
  p.measurements.push({ id: 'm1', x: 0.3, y: 0.5, band: 5, value: -50, name: 'x', download: null, upload: null, device: 'Telefon', t: 0 });
  P.floorOf(p, 'floor-2').measurements.push({ id: 'm2', x: 0.6, y: 0.5, band: 5, value: -70, name: 'y', download: null, upload: null, device: 'Telefon', t: 0 });
  assertValidProject(p, 'house');
  assert.deepEqual(P.sanitize(P.serialize(p)), p);
  const svg = P.buildSvg(p);
  assert.deepEqual(P.parseSvgText(svg).project, p);
  // the old app: the active floor's plan, the router, the width
  const old = legacyLoadSvg(svg);
  assert.equal(old.plan.rooms.length, 1);
  assert.equal(old.plan.rooms[0].name, 'Dole');
  // switched to the upper floor: that floor is what the old app sees; the router stays where it is
  const q = P.clone(p);
  P.switchFloor(q, 'floor-2');
  const svg2 = P.buildSvg(q);
  assert.equal(legacyLoadSvg(svg2).plan.rooms[0].name, 'Nahoře');
  assert.ok(!svg2.includes('>R</text>'), 'no router marker on a floor without the router');
  const data = JSON.parse(P.serialize(q));
  assert.deepEqual(data.project.measurements.map((m) => m.id), ['m2'], 'older builds read the active floor measurements');
  assert.equal(data.project.node.mode, 'mesh_wifi', 'and its first node');
  assert.deepEqual(P.sanitize(svg2 && data), q);
});

test('physics: a source on another floor - 3-D distance, the ceiling loss per band, the target floor walls half-weighted', () => {
  const p = house();
  const c1 = M.createContext(p);
  const c2 = M.createContext(p, { floor: 'floor-2' });
  assert.equal(c1.floor, 'floor-1');
  assert.equal(c2.floor, 'floor-2');
  assert.notEqual(c1.version, c2.version, 'the same plan on another floor is another context');
  assert.equal(M.floorContext(c1, 'floor-2').floor, 'floor-2');
  assert.equal(M.floorContext(c1, 'floor-1'), c1);
  const st = M.fieldParams(p, 'trial');
  assert.equal(st.router.floor, 'floor-1');
  const base5 = M.bandBase(c1, 5);
  for (const [x, y] of [
    [300, 450],
    [520, 300],
    [950, 650],
  ]) {
    const q = at(x, y);
    const dh = Math.hypot((x - 300) * 1, (y - 450) * 1) * 0.01;
    const d3 = Math.sqrt(dh * dh + 2.7 * 2.7);
    // (coordinates are stored with 6 decimals: a few micrometres)
    close(M.distance3(c2, st.router, q), d3, 1e-4);
    close(M.signal(c2, st.router, q, 5), base5 - 22 * Math.log10(Math.max(1, d3)) - 15, 1e-4, '5 GHz upstairs');
    close(M.signal(c2, st.router, q, 2.4), M.bandBase(c1, 2.4) - 22 * Math.log10(Math.max(1, d3)) - 15 * 0.65, 1e-4, '2.4 GHz: the band factor');
    close(M.signal(c1, st.router, q, 5), base5 - 22 * Math.log10(Math.max(1, dh)), 1e-4, 'downstairs: as always');
    close(M.softSignal(c2, st.router, q, 5), M.signal(c2, st.router, q, 5), 1e-6, 'nothing to soften in an open room');
  }
  // a wall upstairs on the way counts half; a wall downstairs (the source floor) does not count upstairs
  const q = at(800, 450);
  const withUp = house({ wallsUp: [wall('wu', 600, 200, 600, 700, 10)] });
  const withDown = house({ wallsDown: [wall('wd', 600, 200, 600, 700, 10)] });
  const sUp = M.signal(M.createContext(withUp, { floor: 'floor-2' }), M.fieldParams(withUp, 'trial').router, q, 5);
  const sDown = M.signal(M.createContext(withDown, { floor: 'floor-2' }), M.fieldParams(withDown, 'trial').router, q, 5);
  const sNone = M.signal(c2, st.router, q, 5);
  close(sNone - sUp, 5, 1e-6, 'the 10 dB wall upstairs: half');
  close(sDown, sNone, 1e-9, 'the wall downstairs is not on the path upstairs');
  assert.equal(M.wallCount(M.createContext(withUp, { floor: 'floor-2' }), M.fieldParams(withUp, 'trial').router, q), 2, 'the ceiling + the wall');
  // the ceiling material
  const wood = house({ ceiling: { material: 'wood' } });
  close(M.signal(M.createContext(wood, { floor: 'floor-2' }), st.router, q, 5) - sNone, 7, 1e-6, 'concrete 15 -> wood 8 dB');
  // the raster = the point model, cell by cell (exact rays) and up to the softening (default)
  const g = R.grid(c2, { cell: 8 });
  const f = R.field(c2, g, { ...st, ...HARD });
  for (const i of g.idx.filter((_, k) => k % 37 === 0)) close(f[i], M.signal(c2, st.router, { x: g.cx[i], y: g.cy[i] }, 5), 1e-3);
  const fs = R.field(c2, g, st);
  for (const i of g.idx.filter((_, k) => k % 41 === 0)) close(fs[i], M.softSignal(c2, st.router, { x: g.cx[i], y: g.cy[i] }, 5), 0.3);
  // a single-floor project keeps exactly its old context version (no floor information hashed)
  const one = makeProject({ rooms: [room(1, 100, 200, 1000, 700)], router: [300, 450] });
  const legacy = { ...one };
  delete legacy.floors;
  assert.equal(M.createContext(one).version, M.createContext(legacy).version);
});

test('the upper floor is weaker by the ceiling; a node upstairs restores it (signal, coverage, what-if, Celý dům)', () => {
  const p = house();
  const down = A.run(p, { cell: 8 });
  const up = A.run(p, { cell: 8, floor: 'floor-2' });
  assert.equal(up.floor, 'floor-2');
  assert.ok(up.stats.today.mean < down.stats.today.mean - 14, `mean ${up.stats.today.mean} vs ${down.stats.today.mean}`);
  assert.ok(up.stats.today.coverage < down.stats.today.coverage - 20, `coverage ${up.stats.today.coverage} vs ${down.stats.today.coverage}`);
  // a node upstairs (wired AP)
  const pn = house({ nodesUp: [mkNode({ id: 'node-up', pos: n(800, 450) })] });
  const upN = A.run(pn, { cell: 8, floor: 'floor-2' });
  const downN = A.run(pn, { cell: 8 });
  assert.ok(upN.stats.trial.coverage > up.stats.trial.coverage + 20, `node upstairs: ${upN.stats.trial.coverage} vs ${up.stats.trial.coverage}`);
  assert.ok(upN.nodes[0].onFloor && !downN.nodes[0].onFloor);
  assert.ok(upN.nodes[0].share > 50 && downN.nodes[0].share < upN.nodes[0].share, 'it serves mostly its own floor');
  assert.equal(upN.stats.today.coverage, up.stats.today.coverage, 'today = the router alone');
  // the same through the view and through a switch
  const sw = P.clone(pn);
  P.switchFloor(sw, 'floor-2');
  assert.deepEqual(A.run(sw, { cell: 8 }).stats, upN.stats);
  assert.deepEqual(A.run(P.atFloor(pn, 'floor-2'), { cell: 8 }).stats, upN.stats);
  // what-if: measurements upstairs gain, measured with the router alone
  const ms = [at(700, 300), at(900, 600)].map((q, k) => ({ id: `u${k}`, x: q.x, y: q.y, band: 5, value: -72, name: 'u', download: null, upload: null, device: 'Telefon', t: 0 }));
  pn.floors.find((f) => f.id === 'floor-2').measurements = ms;
  const ctx2 = M.createContext(pn, { floor: 'floor-2' });
  const wi = A.predictAtMeasurements(ctx2, pn, { offsets: { '2.4': 0, '5': 0, '6': 0 } });
  assert.deepEqual(wi.map((e) => [e.id, e.source, e.sourceId]), [['u0', 'node', 'node-up'], ['u1', 'node', 'node-up']]);
  assert.ok(wi.every((e) => e.delta > 10 && e.onFloor));
  close(wi[0].modelToday, M.softSignal(ctx2, M.fieldParams(pn, 'today').router, wi[0], 5), 1e-9, 'today: the router downstairs');
  assert.deepEqual(A.predictAtMeasurements(M.createContext(pn), pn), [], 'downstairs has no measurements');
  // "Celý dům": per floor + the pooled total
  const b = A.building(pn, { cell: 8, cache: {} });
  assert.deepEqual(b.floors.map((f) => [f.id, f.active]), [['floor-1', true], ['floor-2', false]]);
  assert.deepEqual(b.floors[1].stats.trial, A.run(pn, { cell: 8, floor: 'floor-2' }).stats.trial, 'the same calibrated analysis');
  close(b.total.trial.coverage, (b.floors[0].stats.trial.coverage * b.floors[0].cells + b.floors[1].stats.trial.coverage * b.floors[1].cells) / (b.floors[0].cells + b.floors[1].cells), 1e-6);
  close(b.delta.coverage, b.total.trial.coverage - b.total.today.coverage, 1e-12);
  close(b.floors[0].areaM2, 45, 1e-3);
  // a node on the ground floor reaches the upper floor through the ceiling too
  const pd = P.sanitize({ ...house(), nodes: [mkNode({ id: 'node-down', pos: n(850, 450) })] });
  const upD = A.run(pd, { cell: 8, floor: 'floor-2' });
  assert.ok(upD.stats.trial.mean > up.stats.trial.mean + 1.5, `a node downstairs: ${upD.stats.trial.mean} vs ${up.stats.trial.mean}`);
  assert.ok(upD.nodes[0].share > 20 && !upD.nodes[0].onFloor);
});

test('a wireless node upstairs: its uplink through the ceiling; calibration pooled over the floors; the fit on the router floor', () => {
  const p = house({ nodesUp: [mkNode({ id: 'mesh', mode: 'mesh_wifi', pos: n(320, 460) })] });
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial');
  const c2 = M.floorContext(ctx, 'floor-2');
  close(M.backhaulSignal(ctx, st, 0), M.softSignal(c2, st.router, { x: st.nodes[0].pos.x, y: st.nodes[0].pos.y }, 5, 0), 1e-12, 'traced on the node floor');
  // nearly straight above the router: the uplink is the ceiling and 2.7 m
  close(M.backhaulSignal(ctx, st, 0), M.bandBase(ctx, 5) - 22 * Math.log10(Math.hypot(0.2236, 2.7)) - 15, 0.05);
  // calibration: points on both floors measured 4 dB above the model -> one offset of +4 for the whole building
  const mk = (c, q, k, fl) => ({ id: `${fl}${k}`, x: q.x, y: q.y, band: 5, value: Math.round((M.softSignal(c, st.router, q, 5) + 4) * 100) / 100, name: 'c', download: null, upload: null, device: 'Telefon', t: 0 });
  const downQ = [at(500, 300), at(700, 500), at(900, 650)];
  const upQ = [at(450, 350), at(800, 600)];
  const q = P.clone(p);
  q.measurements = downQ.map((x, k) => mk(ctx, x, k, 'd'));
  q.floors.find((f) => f.id === 'floor-2').measurements = upQ.map((x, k) => mk(c2, x, k, 'u'));
  const cq = M.createContext(q);
  const cal = M.calibrateAll(cq, q);
  assert.equal(cal['5'].n, 5);
  close(cal['5'].offset, 4, 0.01);
  assert.deepEqual([...new Set(cal['5'].used.map((u) => u.floor))].sort(), ['floor-1', 'floor-2']);
  close(M.offsets(M.createContext(q, { floor: 'floor-2' }), q)['5'], M.offsets(cq, q)['5'], 1e-9, 'the same offsets on every floor');
  // the fit learns from the router floor only
  const fit = M.fitProject(q, { band: 5, at: 1 });
  assert.equal(fit.count, 3);
  assert.equal(M.fitStale(q), false);
  q.floors.find((f) => f.id === 'floor-2').measurements.pop();
  assert.equal(M.fitStale({ ...q, model: { ...q.model, fit } }), false, 'upstairs points do not stale it');
  q.measurements.pop();
  assert.equal(M.fitStale({ ...q, model: { ...q.model, fit } }), true);
  // the speed curves come from every floor
  const sp = P.clone(p);
  sp.floors.find((f) => f.id === 'floor-2').measurements = [
    { id: 's1', x: 0.4, y: 0.5, band: 5, value: -50, name: 's', download: 400, upload: 100, device: 'Telefon', t: 0 },
    { id: 's2', x: 0.8, y: 0.5, band: 5, value: -70, name: 's', download: 60, upload: 20, device: 'Telefon', t: 0 },
  ];
  const curves = S.projectCurves(M.createContext(sp), sp);
  assert.ok(curves['5'] && curves['5'].count === 2, 'measured upstairs, used everywhere');
});

test('suggestSpots and the optimizer: spots on the context floor; the router floor fixed, the building or one floor counts', async () => {
  const p = house();
  const c2 = M.createContext(p, { floor: 'floor-2' });
  const spots = A.suggestSpots(c2, p, { band: 5, count: 4 });
  assert.equal(spots.length, 4);
  for (const s of spots) {
    assert.ok(P.roomAt(P.floorOf(p, 'floor-2').plan, s), 'on the upper floor');
    assert.ok(s.distance >= 2.7 - 1e-9, `3-D distance ${s.distance}`);
    assert.ok(s.walls >= 1, 'the ceiling counts');
  }
  // the optimizer: the router stays downstairs
  const pn = house({ nodesUp: [mkNode({ id: 'node-up', pos: n(800, 450) })] });
  const r = await E.optimize.findProject(pn, { cell: 8 });
  assert.equal(r.scope, 'building', 'whole building by default');
  assert.equal(r.floor, 'floor-1');
  assert.ok(P.roomAt(pn.plan, r.pos));
  assert.deepEqual(r.perFloor.map((f) => f.id), ['floor-1', 'floor-2']);
  assert.ok(r.after.coverage >= r.before.coverage - 0.5);
  // from the upper floor with scope 'floor': only the upper floor counts, the router still moves downstairs
  const sw = P.clone(pn);
  P.switchFloor(sw, 'floor-2');
  const rf = await E.optimize.findProject(sw, { cell: 8, scope: 'floor' });
  assert.equal(rf.floor, 'floor-1');
  assert.deepEqual(rf.perFloor.map((f) => f.id), ['floor-2']);
  assert.ok(P.roomAt(P.floorOf(sw, 'floor-1').plan, rf.pos));
  // the router under the node's opposite end is best for the upper floor alone: it moves away from the node
  assert.ok(rf.pos.x < r.pos.x + 0.05 || rf.after.coverage >= rf.before.coverage);
});

test('the two-storey demo house: valid, verified scale, the mesh upstairs restores the upper floor', () => {
  for (const lang of ['cs', 'en']) {
    const p = P.create({ template: 'house2', lang });
    assertValidProject(p, `house2 ${lang}`);
    assert.equal(p.name, lang === 'cs' ? 'Dům se dvěma patry' : 'Two-storey house');
    assert.deepEqual(p.floors.map((f) => [f.name, f.level]), lang === 'cs' ? [['Přízemí', 0], ['1. patro', 1]] : [['Ground floor', 0], ['1st floor', 1]]);
    assert.equal(p.scale.verified, true);
    close(P.buildingArea(p).areaM2, 144, 0.01);
    assert.deepEqual(P.scaleIssues(p), []);
    assert.equal(P.allNodes(p).length, 1);
    assert.equal(P.allNodes(p)[0].floor, 'floor-2');
  }
  const p = P.create({ template: 'house2', lang: 'cs' });
  p.view.band = 5;
  const up = A.run(p, { cell: 4, floor: 'floor-2', curves: null });
  const down = A.run(p, { cell: 4 });
  assert.ok(up.stats.today.coverage < down.stats.today.coverage - 25, `5 GHz upstairs ${up.stats.today.coverage} vs downstairs ${down.stats.today.coverage}`);
  assert.ok(up.stats.trial.coverage > up.stats.today.coverage + 25, `the mesh node: ${up.stats.today.coverage} -> ${up.stats.trial.coverage}`);
  assert.ok(up.nodes[0].backhaul > -70 && !up.nodes[0].weakBackhaul, `its uplink ${up.nodes[0].backhaul}`);
  assert.ok(Math.abs(down.delta.coverage) < 5, 'the ground floor hardly changes');
  const b = A.building(p, { cell: 8 });
  assert.ok(b.delta.coverage > 10, `Celý dům +${b.delta.coverage}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// holes in a slab (stairwell): furniture kind 'opening'
// ---------------------------------------------------------------------------------------------------------------------

const opening = (id, x0, y0, x1, y1) => ({ id, type: 'furniture', name: 'Schodiště', points: rectPts(x0, y0, x1, y1), loss: 0, kind: 'opening', blocksSignal: false });
/** house() + an opening drawn on `floorId` (the slab between the floors does not care which of the two). */
function houseWithHole(floorId, box) {
  const p = house();
  const plan = floorId === 'floor-1' ? p.plan : p.floors.find((f) => f.id === floorId).plan;
  plan.furniture.push(opening('op1', ...box));
  return P.sanitize(p);
}
const upCtx = (p) => M.createContext(p, { floor: 'floor-2' });

test('slab opening: no ceiling loss where the path crosses the hole, full loss elsewhere (drawn on either floor)', () => {
  const none = house();
  const base = upCtx(none);
  const st = M.fieldParams(none, 'trial').router; // (300, 450) downstairs
  const through = at(500, 450); // the path crosses the slab at x = 400: inside the hole
  const around = at(800, 450); // ... at x = 550: outside
  for (const floorId of ['floor-2', 'floor-1']) {
    const p = houseWithHole(floorId, [350, 400, 450, 500]);
    const c2 = upCtx(p);
    assert.notEqual(c2.version, base.version, 'a hole changes the context version');
    close(M.signal(c2, st, through, 5) - M.signal(base, st, through, 5), 15, 1e-6, `${floorId}: 15 dB back through the hole at 5 GHz`);
    close(M.signal(c2, st, through, 2.4) - M.signal(base, st, through, 2.4), 15 * 0.65, 1e-6, `${floorId}: band-scaled at 2.4 GHz`);
    close(M.signal(c2, st, through, 6) - M.signal(base, st, through, 6), 15 * 1.15, 1e-6, `${floorId}: band-scaled at 6 GHz`);
    close(M.signal(c2, st, around, 5), M.signal(base, st, around, 5), 1e-9, `${floorId}: the full ceiling loss outside the hole`);
    close(M.obstacleLoss(c2, st, through, 5), 0, 1e-9, 'the point model agrees');
  }
});

test('slab opening: the other direction (source upstairs, receiver downstairs) sees the same hole', () => {
  const p = houseWithHole('floor-2', [350, 400, 450, 500]);
  const none = house();
  const from = { ...at(500, 450), floor: 'floor-2' }; // the path to (300, 450) crosses the slab at x = 400
  const down = at(300, 450);
  const a = M.signal(M.createContext(p), from, down, 5);
  const b = M.signal(M.createContext(none), from, down, 5);
  close(a - b, 15, 1e-6, 'mid x = 400 is inside the hole');
});

test('slab opening: two slabs - a hole in one of them removes only that slab (crossings at 1/4 and 3/4 of the way)', () => {
  const p = house();
  const top = P.addFloor(p, { copyFrom: 'floor-2' });
  const q = P.sanitize(p);
  const clean = P.sanitize(q);
  // x = 450 -> the path (300 -> 900, y 450) crosses slab 1 at x = 450 and slab 2 at x = 750
  q.floors.find((f) => f.id === 'floor-2').plan.furniture.push(opening('op1', 400, 400, 500, 500));
  const withHole = P.sanitize(q);
  const topCtx = (pp) => M.createContext(pp, { floor: top });
  const st = { ...n(300, 450), floor: 'floor-1' };
  const to = at(900, 450);
  const d3 = Math.sqrt(6 * 6 + 5.4 * 5.4);
  const b = M.signal(topCtx(clean), st, to, 5);
  close(b, M.bandBase(topCtx(clean), 5) - 22 * Math.log10(d3) - 30, 1e-4, 'two ceilings: 30 dB');
  close(M.signal(topCtx(withHole), st, to, 5) - b, 15, 1e-6, 'one of the two slabs is open');
});

test('slab opening: the raster (exact and softened) = the point model, cell by cell; houses without a hole keep their version', () => {
  const p = houseWithHole('floor-2', [350, 400, 450, 500]);
  const c2 = upCtx(p);
  const st = M.fieldParams(p, 'trial');
  const g = R.grid(c2, { cell: 8 });
  const f = R.field(c2, g, { ...st, ...HARD });
  let checked = 0;
  for (const i of g.idx.filter((_, k) => k % 23 === 0)) {
    close(f[i], M.signal(c2, st.router, { x: g.cx[i], y: g.cy[i] }, 5), 1e-3);
    checked++;
  }
  assert.ok(checked > 10);
  const fs = R.field(c2, g, st);
  for (const i of g.idx.filter((_, k) => k % 29 === 0)) close(fs[i], M.softSignal(c2, st.router, { x: g.cx[i], y: g.cy[i] }, 5), 0.5);
  // the hole shows in the map: the cells above it are 15 dB stronger than without the hole, the others are the same
  const none = house();
  const cn = upCtx(none);
  const fn = R.field(cn, g, { ...M.fieldParams(none, 'trial'), ...HARD });
  const idx = (x, y) => g.idx.find((i) => Math.abs(g.cx[i] * W - x) < 6 && Math.abs(g.cy[i] * H - y) < 6);
  close(f[idx(500, 450)] - fn[idx(500, 450)], 15, 0.05, 'stronger through the stairwell');
  close(f[idx(800, 450)] - fn[idx(800, 450)], 0, 1e-6, 'unchanged outside it');
  assert.equal(upCtx(house()).version, upCtx(house({})).version);
});

test('slab opening: the optimizer and the whole-building analysis run with slabs', async () => {
  const p = houseWithHole('floor-2', [350, 400, 450, 500]);
  const r = await E.optimize.findProject(p, { cell: 8 });
  assert.equal(r.scope, 'building');
  assert.ok(Number.isFinite(r.after.coverage) && r.after.coverage >= r.before.coverage - 0.5);
  const none = house();
  const rn = await E.optimize.findProject(none, { cell: 8 });
  assert.ok(r.before.coverage >= rn.before.coverage, 'the stairwell never makes the building worse');
});

test('slab opening: sanitize forces a neutral opening; JSON and SVG round trips keep it; floorSlabs reads it from either floor', () => {
  const p = house();
  p.plan.furniture.push({ ...opening('op1', 350, 400, 450, 500), loss: 12, blocksSignal: true });
  const s = P.sanitize(p);
  const f = s.plan.furniture.find((x) => x.id === 'op1');
  assert.deepEqual([f.kind, f.loss, f.blocksSignal], ['opening', 0, false]);
  const again = P.sanitize(P.serialize(s));
  assert.deepEqual(again.plan.furniture.find((x) => x.id === 'op1'), f);
  const viaSvg = P.parseSvgText(P.buildSvg(s));
  assert.ok(viaSvg.hasData);
  assert.deepEqual(viaSvg.project.plan.furniture.find((x) => x.id === 'op1').kind, 'opening');
  assertValidProject(s, 'opening');
  assert.deepEqual(P.floorSlabs(s, 'floor-1', 'floor-2').map((x) => [x.level, x.holes.length]), [[0, 1]]);
  assert.deepEqual(P.floorSlabs(s, 'floor-2', 'floor-1').map((x) => [x.level, x.holes.length]), [[0, 1]]);
  assert.deepEqual(P.floorSlabs(s, 'floor-1', 'floor-1'), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// the ceiling learnt from points on the other floor (model.suggestCeilings) + project.scaleCeilings
// ---------------------------------------------------------------------------------------------------------------------

const meas = (id, q, band, value) => ({ id, x: q.x, y: q.y, band, value, name: id, download: null, upload: null, device: 'Telefon', t: 1 });
const SPOTS_DOWN = [at(420, 300), at(600, 600), at(850, 350), at(500, 520)];
const SPOTS_UP = [at(350, 300), at(520, 450), at(700, 600), at(880, 350), at(450, 640), at(800, 480)];

/** A house with the real ceiling `trueDb`, measured with the router strength +3 dB; the measurements go into a house assuming 15 dB. */
function measuredHouse(trueDb, { down = true, noise = 0, assumed } = {}) {
  const truth = house({ ceiling: { material: 'custom', lossDb: trueDb } });
  const st = { ...n(300, 450), floor: 'floor-1' };
  const cDown = M.createContext(truth);
  const cUp = M.createContext(truth, { floor: 'floor-2' });
  const r = rng(11);
  const wob = () => (noise ? (r() - 0.5) * 2 * noise : 0);
  const p = house(assumed ? { ceiling: { material: 'custom', lossDb: assumed } } : {});
  if (down) p.measurements = SPOTS_DOWN.map((q, i) => meas(`d${i}`, q, 5, M.softRawSignal(cDown, st, q, 5) + 3 + wob()));
  p.floors.find((f) => f.id === 'floor-2').measurements = SPOTS_UP.map((q, i) => meas(`u${i}`, q, 5, M.softRawSignal(cUp, st, q, 5) + 3 + wob()));
  return P.sanitize(p);
}

test('suggestCeilings: points upstairs say the ceiling loses 25 dB, not 15 - the router strength is learnt downstairs', () => {
  const p = measuredHouse(25);
  assert.equal(p.measurements.length, 4);
  const s = M.suggestCeilings(p);
  assert.equal(s.length, 1);
  assert.equal(s[0].floor, 'floor-2');
  assert.equal(s[0].levels, 1);
  assert.equal(s[0].currentDb, 15);
  assert.equal(s[0].count, 6);
  close(s[0].suggestedDb, 25, 1.5, 'suggested');
  close(s[0].deltaDb, 10, 1.5, 'delta');
});

test('suggestCeilings: a correct ceiling, a missing router floor survey, a calibration switched off and a single floor suggest nothing', () => {
  assert.deepEqual(M.suggestCeilings(measuredHouse(15)), [], 'the assumed 15 dB is right');
  assert.deepEqual(M.suggestCeilings(measuredHouse(25, { down: false })), [], 'without points downstairs the offset and the ceiling cannot be told apart');
  const off = measuredHouse(25);
  off.view.calibrate = false;
  assert.deepEqual(M.suggestCeilings(off), []);
  assert.deepEqual(M.suggestCeilings(makeProject({ rooms: [room(1, 100, 200, 1000, 700)], router: [300, 450] })), []);
  // fewer than 3 points upstairs: nothing
  const few = measuredHouse(25);
  few.floors.find((f) => f.id === 'floor-2').measurements = few.floors.find((f) => f.id === 'floor-2').measurements.slice(0, 2);
  assert.deepEqual(M.suggestCeilings(few), []);
});

test('suggestCeilings: noise of +-4 dB around the right ceiling does not make a suggestion; a ceiling 12 dB off still does', () => {
  assert.deepEqual(M.suggestCeilings(measuredHouse(15, { noise: 4 })), []);
  const s = M.suggestCeilings(measuredHouse(27, { noise: 3 }));
  assert.equal(s.length, 1);
  close(s[0].suggestedDb, 27, 4, 'noisy but clear');
});

test('suggestCeilings: a weaker ceiling than assumed is found too, never below 0 dB', () => {
  const s = M.suggestCeilings(measuredHouse(6, { assumed: 20 }));
  assert.equal(s.length, 1);
  assert.equal(s[0].currentDb, 20);
  close(s[0].suggestedDb, 6, 1.5);
  assert.ok(s[0].deltaDb < 0);
});

test('scaleCeilings: the slabs between two floors keep their share of the new total; applying the suggestion makes the map agree', () => {
  const p = measuredHouse(25);
  const s = M.suggestCeilings(p)[0];
  assert.equal(P.scaleCeilings(p, s.floor, 'floor-1', s.suggestedDb), true);
  const gap = P.floorGap(p, 'floor-2', 'floor-1');
  close(gap.lossDb, s.suggestedDb, 0.11, 'the slab now loses the suggested dB');
  assert.equal(p.floors.find((f) => f.id === 'floor-1').ceiling.material, 'custom');
  assert.deepEqual(M.suggestCeilings(p), [], 'nothing left to suggest');
  // two slabs: 10 + 20 -> total 60 keeps the 1:2 share
  const q = house();
  const top = P.addFloor(q, { copyFrom: 'floor-2' });
  P.setCeiling(q, 'floor-1', { lossDb: 10 });
  P.setCeiling(q, 'floor-2', { lossDb: 20 });
  assert.equal(P.scaleCeilings(q, 'floor-1', top, 60), true);
  assert.deepEqual([q.floors.find((f) => f.id === 'floor-1').ceiling.lossDb, q.floors.find((f) => f.id === 'floor-2').ceiling.lossDb], [20, 40]);
  // refused: same floor, unknown floor, a total above 40 per slab, a negative total
  assert.equal(P.scaleCeilings(q, 'floor-1', 'floor-1', 10), false);
  assert.equal(P.scaleCeilings(q, 'floor-1', 'nope', 10), false);
  assert.equal(P.scaleCeilings(q, 'floor-1', 'floor-2', 41), false);
  assert.equal(P.scaleCeilings(q, 'floor-1', 'floor-2', -1), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// "where would one more AP help" / "how many APs do I need" (optimize.suggestNode / howMany)
// ---------------------------------------------------------------------------------------------------------------------

test('suggestNode: in a two-storey house the best extra AP goes upstairs (the weak floor), and it really helps', async () => {
  const p = house();
  const s = await E.optimize.suggestNode(p, { cell: 8 });
  assert.ok(s);
  assert.equal(s.floor, 'floor-2');
  assert.ok(P.roomAt(P.floorOf(p, 'floor-2').plan, s.pos), 'inside a room of that floor');
  assert.ok(s.gain > 5, `coverage gain ${s.gain}`);
  assert.ok(s.after.coverage > s.before.coverage);
  // nothing is changed in the project
  assert.equal(P.allNodes(p).length, 0);
  assert.equal(JSON.stringify(p), JSON.stringify(house()));
});

test('suggestNode: a single-floor flat with a weak far room gets an AP there; the router is not moved', async () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const router0 = { ...p.net.router };
  const s = await E.optimize.suggestNode(p, { cell: 8 });
  assert.ok(s && s.floor === 'floor-1');
  assert.ok(s.gain > 0 && s.after.coverage > s.before.coverage);
  assert.ok(P.roomAt(p.plan, s.pos));
  assert.deepEqual(p.net.router, router0);
});

test('howMany: stops at once when the goal is met, adds as many APs as needed otherwise, and never exceeds max', async () => {
  const p = house();
  const done = await E.optimize.howMany(p, { goal: 1, cell: 8 });
  assert.equal(done.steps.length, 0);
  assert.equal(done.reached, true);
  const r = await E.optimize.howMany(p, { goal: 95, cell: 8, max: 3 });
  assert.ok(r.steps.length >= 1 && r.steps.length <= 3);
  assert.ok(r.coverage > r.today);
  assert.equal(r.reached, r.coverage >= 95);
  assert.equal(r.steps[0].floor, 'floor-2');
  const capped = await E.optimize.howMany(p, { goal: 100, cell: 8, max: 1 });
  assert.ok(capped.steps.length <= 1);
});

test('howMany: applying the steps gives the coverage it promised', async () => {
  const p = house();
  const r = await E.optimize.howMany(p, { goal: 90, cell: 8 });
  const q = P.clone(p);
  for (const st of r.steps) {
    const nd = P.newNode(q, { mode: 'ap_cable', pos: st.pos, floor: st.floor });
    assert.ok(P.addNode(q, nd, st.floor));
  }
  const a = A.building(q, { cell: 8 });
  close(a.total.trial.coverage, r.coverage, 0.01, 'coverage with the added APs');
});

// ---------------------------------------------------------------------------------------------------------------------
// review fixes (v3.4): one slab per opening, the ceiling suggestion's guards, scaleCeilings limits, the AP search's goal room
// ---------------------------------------------------------------------------------------------------------------------

/** Three floors (L0 floor-1, L1 floor-2, L2 top), 15 dB slabs; an opening on `onFloor` at x 700..800 (y 400..500). */
function tower(onFloor) {
  const p = house();
  const top = P.addFloor(p, { copyFrom: 'floor-2' });
  const q = P.sanitize(p);
  const plan = onFloor === 'floor-1' ? q.plan : q.floors.find((f) => f.id === (onFloor === 'top' ? top : onFloor)).plan;
  plan.furniture.push(opening('op1', 700, 400, 800, 500));
  return { p: P.sanitize(q), top };
}

test('opening rule: a hole opens the slab BELOW the floor it is drawn on; on the lowest floor the slab above - one slab each', () => {
  // path floor-1 (300,450) -> top (900,450): slab 0 is crossed at x = 450, slab 1 at x = 750
  const st = { ...n(300, 450), floor: 'floor-1' };
  const to = at(900, 450);
  const clean = (() => { const p = house(); const top = P.addFloor(p, { copyFrom: 'floor-2' }); return { p: P.sanitize(p), top }; })();
  const sig = (t) => M.signal(M.createContext(t.p, { floor: t.top }), st, to, 5);
  const ref = sig(clean);
  // drawn on the middle floor: it is the hole in floor-2's floor (slab 0, crossed at 450): outside -> nothing changes
  close(sig(tower('floor-2')) - ref, 0, 1e-9, 'middle floor opening does not open the slab above it');
  // drawn on the top floor: the hole in the top floor's floor (slab 1, crossed at 750): inside -> one slab open
  close(sig(tower('top')) - ref, 15, 1e-6, 'top floor opening opens slab 1');
  // drawn on the lowest floor: the ceiling above it (slab 0, crossed at 450): outside -> nothing
  close(sig(tower('floor-1')) - ref, 0, 1e-9, 'ground floor opening belongs to slab 0 only');
  // floorSlabs says the same
  const t = tower('top');
  assert.deepEqual(P.floorSlabs(t.p, 'floor-1', t.top).map((s) => s.holes.length), [0, 1]);
  assert.deepEqual(P.floorSlabs(t.p, t.top, 'floor-1').map((s) => s.holes.length), [1, 0], 'from the source: top first');
});

test('opening: an unrelated piece of furniture does not change the context version; the optimizer reaches upstairs through the hole', async () => {
  const a = house();
  const b = house();
  b.floors.find((f) => f.id === 'floor-2').plan.furniture.push({ id: 'bed', type: 'furniture', name: 'bed', points: rectPts(500, 300, 600, 400), loss: 1, kind: 'bed', blocksSignal: true });
  // a bed upstairs matters for the upper floor's own context, never for the slab between the floors
  assert.equal(M.createContext(P.sanitize(a)).version, M.createContext(P.sanitize(b)).version);
  const withHole = houseWithHole('floor-2', [300, 380, 700, 520]);
  const none = house();
  const r1 = await E.optimize.findProject(withHole, { cell: 8 });
  const r0 = await E.optimize.findProject(none, { cell: 8 });
  const up1 = r1.perFloor.find((f) => f.id === 'floor-2').after.coverage;
  const up0 = r0.perFloor.find((f) => f.id === 'floor-2').after.coverage;
  assert.ok(up1 > up0, `the upper floor gains through the hole (${up0} -> ${up1})`);
});

test('suggestCeilings: points of another device than the one the router strength was learnt from are not read as a ceiling', () => {
  const p = measuredHouse(15);
  // the same upstairs points measured with another phone that reads 8 dB lower
  const up = p.floors.find((f) => f.id === 'floor-2');
  up.measurements = up.measurements.map((m) => ({ ...m, device: 'Starý tablet', value: m.value - 8 }));
  const q = P.sanitize(p);
  assert.equal(q.goal.device, 'Telefon');
  assert.deepEqual(M.suggestCeilings(q), [], 'a device difference is not a ceiling');
});

test('suggestCeilings: points whose path goes through a stairwell opening are left out', () => {
  const p = measuredHouse(25);
  // a huge opening right where every upstairs path crosses the slab: no point says anything about the slab
  p.floors.find((f) => f.id === 'floor-2').plan.furniture.push(opening('op1', 100, 200, 1000, 700));
  assert.deepEqual(M.suggestCeilings(P.sanitize(p)), []);
});

test('suggestCeilings: only the floors right next to the router floor', () => {
  const p = measuredHouse(25);
  const top = P.addFloor(p, { copyFrom: 'floor-2' });
  const q = P.sanitize(p);
  // move the measured points two levels up: nothing (the slabs would be shared with the floor between)
  const f2 = q.floors.find((f) => f.id === 'floor-2');
  q.floors.find((f) => f.id === top).measurements = f2.measurements.map((m) => ({ ...m, id: 't' + m.id }));
  f2.measurements = [];
  assert.deepEqual(M.suggestCeilings(P.sanitize(q)), []);
});

test('scaleCeilings: a slab never goes above 40 dB (the rest goes to the others); an unreachable total changes nothing', () => {
  const q = house();
  const top = P.addFloor(q, { copyFrom: 'floor-2' });
  P.setCeiling(q, 'floor-1', { lossDb: 30 });
  P.setCeiling(q, 'floor-2', { lossDb: 10 });
  assert.equal(P.scaleCeilings(q, 'floor-1', top, 70), true);
  assert.deepEqual([q.floors.find((f) => f.id === 'floor-1').ceiling.lossDb, q.floors.find((f) => f.id === 'floor-2').ceiling.lossDb], [40, 30], 'share 3:1 capped at 40, the rest to the other');
  close(P.floorGap(q, 'floor-1', top).lossDb, 70, 1e-9);
  const before = JSON.stringify(q.floors);
  assert.equal(P.scaleCeilings(q, 'floor-1', top, 81), false);
  assert.equal(JSON.stringify(q.floors), before, 'nothing changed');
});

test('suggestNode / howMany: the search counts the target room ("Cíl") like the gain does', async () => {
  // West (big) | Hall with the router | East (small) behind 30 dB walls; the goal is East
  const p = makeProject({
    rooms: [room(1, 100, 200, 500, 700, 'West'), room(2, 500, 200, 700, 700, 'Hall'), room(3, 700, 200, 900, 700, 'East')],
    walls: [wall('w1', 700, 200, 700, 700, 30), wall('w2', 500, 200, 500, 700, 30)],
    router: [600, 450],
    goal: { room: 3, excluded: [] },
    mpp: 0.04, // 4 cm per px: East is 8 m wide, far behind its wall
  });
  const s = await E.optimize.suggestNode(p, { cell: 8 });
  assert.ok(s, 'a suggestion');
  assert.equal(P.roomAt(p.plan, s.pos).name, 'East', 'the AP goes into the target room');
  assert.ok(s.gain > 20, `the target room gains (${s.gain})`);
});

test('howMany: the max cap binds on a building that needs more than one AP', async () => {
  const tall = makeProject({ rooms: [room(1, 100, 200, 1000, 700)], router: [300, 450], view: { band: 5 } });
  const f2 = P.addFloor(tall, { copyFrom: 'floor-1' });
  P.addFloor(tall, { copyFrom: f2 });
  P.setCeiling(tall, 'floor-1', { lossDb: 40 });
  P.setCeiling(tall, f2, { lossDb: 40 });
  const t = P.sanitize(tall);
  const one = await E.optimize.howMany(t, { goal: 99, cell: 8, max: 1 });
  assert.equal(one.steps.length, 1);
  assert.equal(one.reached, false);
  const more = await E.optimize.howMany(t, { goal: 99, cell: 8, max: 3 });
  assert.ok(more.steps.length >= 2, `needs at least two (${more.steps.length})`);
  assert.ok(more.coverage > one.coverage);
});
