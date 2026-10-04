// SPEC 14.3: floors - data, migration, helpers, files (the old app opens the active floor), the cross-floor physics
// (3-D distance, ceiling loss, the target floor's walls half-weighted), per-floor contexts / analysis / what-if /
// calibration / spots, "Celý dům", the optimizer with the router floor fixed, the two-storey demo house.
// Not modelled (documented): stairs, open galleries and holes in a slab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, makeProject, mkNode } from './_helpers.mjs';
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
