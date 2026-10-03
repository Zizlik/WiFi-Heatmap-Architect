import test from 'node:test';
import assert from 'node:assert/strict';
import { E, readPrivatePlan } from './_load.mjs';
import { n, room, wall, makeProject, busyPlan, rng } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const P = E.project;
const { W, H } = E.CANVAS;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const px = (p) => [p.x * W, p.y * H];
const len = (w) => Math.hypot((w.b.x - w.a.x) * W, (w.b.y - w.a.y) * H);

// ---------------------------------------------------------------------------------------------------------------
// auto walls
// ---------------------------------------------------------------------------------------------------------------

test('autoWalls: one room gets four walls on its edges, ids are unique', () => {
  const plan = { rooms: [room(1, 100, 100, 400, 300)], walls: [], doors: [], furniture: [], background: null };
  const w = P.autoWalls(plan);
  assert.equal(w.length, 4);
  assert.deepEqual(w.map((x) => x.id), ['wall-1', 'wall-2', 'wall-3', 'wall-4']);
  assert.ok(w.every((x) => x.type === 'wall' && typeof x.name === 'string' && x.name && x.material === undefined && x.loss === undefined));
  assert.deepEqual(w[0].a, plan.rooms[0].points[0]);
  assert.deepEqual(w[0].b, plan.rooms[0].points[1]);
  assert.deepEqual(w[3].b, plan.rooms[0].points[0]);
  assert.deepEqual(plan.walls, [], 'non destructive');
  const brick = P.autoWalls(plan, { defaultMaterial: 'brick' });
  assert.ok(brick.every((x) => x.material === 'brick' && x.loss === 11), 'the 5 GHz value of the brick table (SPEC 7.1)');
  const unknown = P.autoWalls(plan, { defaultMaterial: 'cheese' });
  assert.ok(unknown.every((x) => x.material === undefined));
  assert.equal(P.autoWalls(plan, { defaultMaterial: 'default' })[0].loss, undefined);
  // ids avoid existing ones
  plan.walls = [{ id: 'wall-1', type: 'wall', name: 'x', a: n(0, 0), b: n(1, 1) }, { id: 'wall-3', type: 'wall', name: 'y', a: n(2, 2), b: n(3, 3) }];
  plan.rooms[0].id = 'wall-2';
  const ids = P.autoWalls(plan).map((x) => x.id);
  assert.equal(new Set([...ids, 'wall-1', 'wall-3', 'wall-2']).size, ids.length + 3);
  // language of the default name
  assert.equal(P.autoWalls({ ...plan, walls: [] }, { lang: 'en' })[0].name, 'Wall');
  assert.equal(P.autoWalls({ ...plan, walls: [] }, { lang: 'cs' })[0].name, 'Zeď');
});

test('autoWalls: a shared edge between neighbouring rooms is added once', () => {
  const plan = { rooms: [room(1, 100, 100, 400, 300), room(2, 400, 100, 700, 300)], walls: [], doors: [], furniture: [], background: null };
  const w = P.autoWalls(plan);
  assert.equal(w.length, 7);
  const onShared = w.filter((x) => Math.abs(x.a.x * W - 400) < 0.01 && Math.abs(x.b.x * W - 400) < 0.01);
  assert.equal(onShared.length, 1);
});

test('autoWalls: existing collinear walls (3 px tolerance) cover an edge; partial cover adds the rest', () => {
  const base = () => ({ rooms: [room(1, 100, 100, 400, 300)], walls: [], doors: [], furniture: [], background: null });
  let plan = base();
  plan.walls = [{ id: 'w', type: 'wall', name: 'w', a: n(100, 100), b: n(400, 100) }];
  assert.equal(P.autoWalls(plan).length, 3, 'top edge covered');
  plan.walls = [{ id: 'w', type: 'wall', name: 'w', a: n(60, 101.5), b: n(450, 101.5) }];
  assert.equal(P.autoWalls(plan).length, 3, '1.5 px off and longer than the edge');
  plan.walls = [{ id: 'w', type: 'wall', name: 'w', a: n(100, 102.9), b: n(400, 102.9) }];
  assert.equal(P.autoWalls(plan).length, 3, '2.9 px off still counts as the same wall');
  plan.walls = [{ id: 'w', type: 'wall', name: 'w', a: n(100, 104.5), b: n(400, 104.5) }];
  assert.equal(P.autoWalls(plan).length, 4, '4.5 px off is a different wall');
  plan.walls = [{ id: 'w', type: 'wall', name: 'w', a: n(250, 60), b: n(250, 140) }];
  assert.equal(P.autoWalls(plan).length, 4, 'a crossing wall does not cover anything');
  // half of the top edge is covered: only the other half is added
  plan.walls = [{ id: 'w', type: 'wall', name: 'w', a: n(100, 100), b: n(250, 100) }];
  const w = P.autoWalls(plan);
  assert.equal(w.length, 4);
  const top = w.find((x) => Math.abs(px(x.a)[1] - 100) < 0.01 && Math.abs(px(x.b)[1] - 100) < 0.01);
  close(px(top.a)[0], 250, 0.01);
  close(px(top.b)[0], 400, 0.01);
  // two walls that together cover the edge with a hole in the middle
  plan.walls = [{ id: 'a', type: 'wall', name: 'a', a: n(100, 100), b: n(200, 100) }, { id: 'b', type: 'wall', name: 'b', a: n(300, 100), b: n(400, 100) }];
  const gap = P.autoWalls(plan).filter((x) => Math.abs(px(x.a)[1] - 100) < 0.01 && Math.abs(px(x.b)[1] - 100) < 0.01);
  assert.equal(gap.length, 1);
  close(len(gap[0]), 100, 0.01);
  // gaps shorter than the tolerance are not worth a wall
  plan.walls = [{ id: 'a', type: 'wall', name: 'a', a: n(100, 100), b: n(250, 100) }, { id: 'b', type: 'wall', name: 'b', a: n(252, 100), b: n(400, 100) }];
  assert.equal(P.autoWalls(plan).length, 3);
});

test('autoWalls: idempotent, L-shaped rooms, tiny edges, 3x3 plan with existing walls', () => {
  const L = { id: 'room-1', type: 'room', roomId: 1, name: 'L', color: '#8eadd2', points: [n(100, 100), n(500, 100), n(500, 300), n(300, 300), n(300, 500), n(100, 500)] };
  const plan = { rooms: [L], walls: [], doors: [], furniture: [], background: null };
  const w = P.autoWalls(plan);
  assert.equal(w.length, 6);
  plan.walls = w;
  assert.deepEqual(P.autoWalls(plan), [], 'a second run adds nothing');
  const tiny = { rooms: [{ ...L, points: [n(100, 100), n(500, 100), n(500, 101.5), n(500, 300), n(100, 300)] }], walls: [], doors: [], furniture: [], background: null };
  assert.equal(P.autoWalls(tiny).length, 4, 'the 1.5 px edge is ignored');
  const b = busyPlan();
  assert.deepEqual(P.autoWalls({ rooms: b.rooms, walls: b.walls, doors: [], furniture: [], background: null }), []);
  const noRooms = { rooms: [], walls: [], doors: [], furniture: [] };
  assert.deepEqual(P.autoWalls(noRooms), []);
});

test('autoWalls on an optional private real plan (WH_PRIVATE_PLAN) produces valid walls and converges', () => {
  const svg = readPrivatePlan();
  if (svg === null) return;
  const p = P.parseSvgText(svg).project;
  const add = P.autoWalls(p.plan, { defaultMaterial: 'drywall' });
  const q = clone(p);
  q.plan.walls.push(...add);
  assertValidProject(P.sanitize(q), 'private plan + auto walls');
  assert.deepEqual(P.autoWalls(q.plan), []);
  assert.ok(add.length < 40, `${add.length} new walls`);
});

// ---------------------------------------------------------------------------------------------------------------
// roomAt / floorMaskAt / nearestFloor
// ---------------------------------------------------------------------------------------------------------------

test('roomAt / floorMaskAt', () => {
  const plan = { rooms: [room(1, 100, 100, 500, 400), room(2, 300, 200, 700, 500)], walls: [], doors: [], furniture: [] };
  assert.equal(P.roomAt(plan, n(150, 150)).roomId, 1);
  assert.equal(P.roomAt(plan, n(650, 450)).roomId, 2);
  assert.equal(P.roomAt(plan, n(400, 300)).roomId, 2, 'overlap: the last room wins (same as the raster grid)');
  assert.equal(P.roomAt(plan, n(50, 50)), null);
  assert.equal(P.floorMaskAt(plan, n(150, 150)), true);
  assert.equal(P.floorMaskAt(plan, n(800, 800)), false);
  assert.equal(P.roomAt(plan, null), null);
  assert.equal(P.roomAt(plan, { x: NaN, y: 0 }), null);
  assert.equal(P.roomAt({ rooms: [] }, n(1, 1)), null);
  assert.equal(P.roomAt(null, n(1, 1)), null);
});

test('nearestFloor: unchanged on the floor, otherwise the closest floor point, inside the room', () => {
  const b = busyPlan();
  const plan = { rooms: b.rooms, walls: [], doors: [], furniture: [] }; // rooms cover x 100..1000, y 100..790
  const inside = P.nearestFloor(plan, n(500, 400));
  assert.deepEqual(inside, n(500, 400));
  assert.notEqual(inside, n(500, 400));
  const r = rng(99);
  for (let k = 0; k < 500; k++) {
    const x = r() * W;
    const y = r() * H;
    const q = P.nearestFloor(plan, n(x, y));
    assert.ok(P.floorMaskAt(plan, q), `(${x.toFixed(1)}, ${y.toFixed(1)}) -> ${JSON.stringify(q)}`);
    const dx = Math.max(100 - x, 0, x - 1000);
    const dy = Math.max(100 - y, 0, y - 790);
    const truth = Math.hypot(dx, dy);
    const got = Math.hypot(x - q.x * W, y - q.y * H);
    assert.ok(got >= truth - 1e-6 && got <= truth + 3.5, `distance ${got.toFixed(2)} vs ${truth.toFixed(2)}`);
  }
  // clamps invalid input, handles plans without rooms
  assert.deepEqual(P.nearestFloor({ rooms: [] }, { x: 0.3, y: 0.4 }), { x: 0.3, y: 0.4 });
  assert.deepEqual(P.nearestFloor(plan, null), P.nearestFloor(plan, { x: 0.5, y: 0.5 }));
  const far = P.nearestFloor(plan, { x: 7, y: -3 });
  assert.ok(P.floorMaskAt(plan, far) && far.x <= 1 && far.y >= 0);
});

test('nearestFloor: L-shaped room (point in the notch), thin rooms and an optional private real plan', () => {
  const L = { id: 'room-1', type: 'room', roomId: 1, name: 'L', color: '#8eadd2', points: [n(100, 100), n(500, 100), n(500, 300), n(300, 300), n(300, 500), n(100, 500)] };
  const plan = { rooms: [L], walls: [], doors: [], furniture: [] };
  const q = P.nearestFloor(plan, n(400, 400));
  assert.ok(P.floorMaskAt(plan, q));
  // the notch corner is at (300,300): the nearest floor is on the notch's border
  assert.ok(Math.hypot(q.x * W - 400, q.y * H - 400) < 100 + 3.5, JSON.stringify(q));
  const thin = { rooms: [room(1, 100, 100, 104, 400)], walls: [], doors: [], furniture: [] };
  assert.ok(P.floorMaskAt(thin, P.nearestFloor(thin, n(500, 250))));
  const svg = readPrivatePlan();
  if (svg === null) return;
  const real = P.parseSvgText(svg).project.plan;
  const r = rng(5);
  for (let k = 0; k < 800; k++) {
    const p = P.nearestFloor(real, { x: r(), y: r() });
    assert.ok(P.floorMaskAt(real, p), JSON.stringify(p));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// scale helpers & misc
// ---------------------------------------------------------------------------------------------------------------

test('deriveMpp / widthFromMpp are inverses; bounds of the rooms define the width', () => {
  const plan = { rooms: [room(1, 100, 100, 500, 400), room(2, 500, 100, 1000, 400)], walls: [], doors: [], furniture: [] };
  const mpp = P.deriveMpp(plan, 9);
  close(mpp, 9 / 900, 1e-9);
  close(P.widthFromMpp(plan, mpp), 9, 1e-9);
  const bb = P.planBounds(plan);
  close(bb.minX * W, 100, 1e-3);
  close(bb.maxX * W, 1000, 1e-3);
  // no rooms: default 84 % of the canvas
  close(P.deriveMpp({ rooms: [] }, 12), 12 / (0.84 * W), 1e-9);
  // absurd inputs are clamped, not NaN
  assert.ok(P.deriveMpp(plan, 1e9) <= 0.2);
  assert.ok(P.deriveMpp(plan, 1e-9) >= 0.0005);
  // bounds without rooms use the other geometry, then a default box
  const onlyWalls = { rooms: [], walls: [{ a: n(200, 200), b: n(600, 500) }], furniture: [] };
  close(P.planBounds(onlyWalls).maxX * W, 600, 1e-3);
  assert.deepEqual(P.planBounds({ rooms: [], walls: [], furniture: [] }), { minX: 0.05, minY: 0.05, maxX: 0.95, maxY: 0.95 });
});

test('roomIndexOf / nextRoomId / nextId', () => {
  const plan = { rooms: [room(1, 0, 0, 10, 10), room(3, 20, 0, 30, 10)], walls: [wall('wall-1', 0, 0, 1, 1)], doors: [], furniture: [] };
  assert.equal(P.roomIndexOf(plan, 3), 1);
  assert.equal(P.roomIndexOf(plan, 2), -1);
  assert.equal(P.nextRoomId(plan), 2);
  plan.rooms = Array.from({ length: 250 }, (_, i) => ({ roomId: i + 1 }));
  assert.equal(P.nextRoomId(plan), null);
  const q = { rooms: [room(1, 0, 0, 10, 10)], walls: [wall('wall-2', 0, 0, 1, 1)], doors: [], furniture: [] };
  const id = P.nextId(q, 'wall');
  assert.match(id, /^wall-\d+$/);
  assert.notEqual(id, 'wall-2');
  assert.notEqual(P.nextId(q, 'door'), id);
  void makeProject;
  void H;
});
