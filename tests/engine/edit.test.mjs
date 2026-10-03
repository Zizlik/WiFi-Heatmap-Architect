import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, furn } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const { edit, geom, project: P } = E;
const { W, H } = E.CANVAS;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);
const planOf = () => ({
  rooms: [room(1, 100, 100, 600, 400)],
  walls: [wall('w1', 100, 100, 600, 100), wall('w2', 600, 100, 600, 400, 8), wall('w3', 100, 300, 300, 300)],
  doors: [],
  furniture: [furn('f1', 200, 150, 300, 200)],
});
const len = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);

test('nearestWall: closest wall within the pick distance', () => {
  const plan = planOf();
  const hit = edit.nearestWall(plan, n(350, 104));
  assert.equal(hit.wall.id, 'w1');
  close(hit.d, 4, 1e-3);
  close(hit.t, 0.5, 1e-3);
  close(hit.y * H, 100, 1e-3);
  assert.equal(edit.nearestWall(plan, n(350, 250)), null);
  assert.equal(edit.nearestWall(plan, n(350, 250), { maxPx: 200 }).wall.id, 'w3');
  assert.equal(edit.nearestWall(plan, n(350, 104), { exclude: 'w1' }), null);
  assert.equal(edit.nearestWall({ walls: [] }, n(1, 1)), null);
  assert.equal(edit.nearestWall({}, n(1, 1)), null);
});

test('makeDoor: 0.9 m wide, centred on the click, clamped inside the wall, lies on the wall', () => {
  const plan = planOf();
  const d = edit.makeDoor(plan, 'w1', n(350, 105), { mpp: 0.01 });
  assert.equal(d.type, 'door');
  assert.equal(d.wallId, 'w1');
  assert.equal(d.loss, 0);
  assert.match(d.id, /^door-\d+$/);
  close(len(d.a, d.b), 90, 0.01);
  close(((d.a.x + d.b.x) * W) / 2, 350, 0.01);
  close(d.a.y * H, 100, 0.01);
  assert.equal(d.name, 'Dveře');
  // click near the start of the wall: the door is pushed inside
  const near = edit.makeDoor(plan, 'w1', n(101, 100), { mpp: 0.01 });
  close(near.a.x * W, 100, 0.01);
  close(len(near.a, near.b), 90, 0.01);
  const farEnd = edit.makeDoor(plan, 'w1', n(1000, 100), { mpp: 0.01 });
  assert.ok(farEnd.b.x * W <= 600.01);
  close(len(farEnd.a, farEnd.b), 90, 0.01);
  // custom width / loss / name, short walls get an 80 % door, door ids are unique
  const wide = edit.makeDoor(plan, 'w1', n(350, 100), { mpp: 0.01, widthM: 2, loss: 3, name: 'Garage' });
  close(len(wide.a, wide.b), 200, 0.01);
  assert.equal(wide.loss, 3);
  assert.equal(wide.name, 'Garage');
  const short = edit.makeDoor({ ...plan, walls: [wall('s', 100, 100, 140, 100)] }, 's', n(120, 100), { mpp: 0.01 });
  close(len(short.a, short.b), 32, 0.01);
  plan.doors.push(d);
  assert.notEqual(edit.makeDoor(plan, 'w1', n(200, 100)).id, d.id);
  assert.throws(() => edit.makeDoor(plan, 'nope', n(1, 1)), (e) => e.message === 'err.plan.door');
  // an oblique wall
  const oblique = { ...plan, walls: [wall('o', 100, 100, 400, 300)] };
  const od = edit.makeDoor(oblique, 'o', n(250, 200), { mpp: 0.01 });
  close(len(od.a, od.b), 90, 0.05);
  close(geom.closestOnSegment(od.a, oblique.walls[0].a, oblique.walls[0].b).d, 0, 0.01);
  close(geom.closestOnSegment(od.b, oblique.walls[0].a, oblique.walls[0].b).d, 0, 0.01);
  // a door built here survives the loaders
  const project = P.create({ template: 'blank' });
  project.plan = { rooms: plan.rooms, walls: plan.walls, doors: [d], furniture: [], background: null };
  assertValidProject(P.sanitize(project), 'with door');
});

test('fitDoors: doors follow their wall when it moves or changes length', () => {
  const plan = planOf();
  const d = edit.makeDoor(plan, 'w2', n(600, 250), { mpp: 0.01 });
  plan.doors.push(d);
  const old = { a: { ...plan.walls[1].a }, b: { ...plan.walls[1].b } };
  const ta = geom.closestOnSegment(d.a, old.a, old.b).t;
  const tb = geom.closestOnSegment(d.b, old.a, old.b).t;
  // move the wall 40 px to the right and stretch it
  plan.walls[1].a = n(640, 100);
  plan.walls[1].b = n(660, 500);
  assert.equal(edit.fitDoors(plan, 'w2', old), 1);
  const w = plan.walls[1];
  for (const [k, t] of [
    ['a', ta],
    ['b', tb],
  ]) {
    close(d[k].x, w.a.x + (w.b.x - w.a.x) * t, 1e-5);
    close(d[k].y, w.a.y + (w.b.y - w.a.y) * t, 1e-5);
    close(geom.closestOnSegment(d[k], w.a, w.b).d, 0, 0.01);
  }
  assert.equal(edit.fitDoors(plan, 'ghost', old), 0);
});

test('removeObject: deleting a wall deletes its doors; unknown ids do nothing', () => {
  const plan = planOf();
  plan.doors.push(edit.makeDoor(plan, 'w2', n(600, 250)));
  const first = plan.doors[0].id;
  plan.doors.push(edit.makeDoor(plan, 'w1', n(300, 100)));
  const second = plan.doors[1].id;
  assert.notEqual(first, second);
  assert.deepEqual(edit.removeObject(plan, 'w2'), ['w2', first]);
  assert.deepEqual(plan.walls.map((w) => w.id), ['w1', 'w3']);
  assert.deepEqual(plan.doors.map((x) => x.id), [second]);
  assert.deepEqual(edit.removeObject(plan, second), [second]);
  assert.deepEqual(edit.removeObject(plan, 'f1'), ['f1']);
  assert.deepEqual(edit.removeObject(plan, 'room-1'), ['room-1']);
  assert.deepEqual(edit.removeObject(plan, 'nothing'), []);
  assert.equal(plan.rooms.length + plan.furniture.length + plan.doors.length, 0);
});

test('snapPoint: vertex first, then grid', () => {
  const plan = planOf();
  const v = edit.snapPoint(plan, n(103, 102));
  assert.equal(v.kind, 'vertex');
  close(v.x * W, 100, 1e-3);
  close(v.y * H, 100, 1e-3);
  const g = edit.snapPoint(plan, n(447, 253));
  assert.equal(g.kind, 'grid');
  close(g.x, 0.41, 1e-9);
  close(g.y, 0.27, 1e-9);
  const none = edit.snapPoint(plan, n(447, 253), { grid: false });
  assert.deepEqual({ k: none.kind, x: none.x }, { k: 'none', x: n(447, 253).x });
  assert.equal(edit.snapPoint(plan, n(103, 102), { vertexPx: 2 }).kind, 'grid');
  assert.equal(edit.snapPoint(plan, n(103, 102), { exclude: 'room-1' }).kind, 'vertex', 'the wall ends are still there');
  const only = edit.snapPoint({ rooms: [room(1, 100, 100, 200, 200)], walls: [] }, n(103, 102), { exclude: 'room-1', grid: false });
  assert.equal(only.kind, 'none');
});
