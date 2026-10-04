// SPEC 14.1: the scale must be verified, never silently assumed - scale state + migration, the plan's area, scale from an
// area / two points / a width, setScale / confirmScale, the sanity checks (scaleIssues).
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, door, makeProject } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const P = E.project;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (eps ${eps})`);

// three rooms: 500 x 400 px, 300 x 400 px, 200 x 100 px (balcony) - at 0.01 m/px: 20 m², 12 m², 2 m²
function flat(mpp = 0.01, extra = {}) {
  return makeProject({
    rooms: [room(1, 100, 100, 600, 500, 'Obývák'), room(2, 600, 100, 900, 500, 'Ložnice'), room(3, 100, 500, 300, 600, 'Balkon')],
    walls: [wall('w1', 600, 100, 600, 500, 8)],
    doors: [door('d1', 'w1', 600, 250, 600, 340, 3)],
    mpp,
    goal: { excluded: [3] },
    ...extra,
  });
}

test('scale state: sanitized, verified only when a file says so, migration of older files, round trips', () => {
  // a v3 file of an older build: mpp but no verified flag -> import, not verified (the one-time banner asks)
  const old = P.sanitize({ plan: { rooms: [room(1, 100, 100, 600, 500)] }, project: { scale: { mpp: 0.0123 } } });
  assert.deepEqual(old.scale, { mpp: 0.0123, verified: false, method: 'import', ref: null });
  // the OLD app's payload with a width: import, not verified, mpp from the width
  const legacy = P.sanitize({ format: 'wifi-floor-v2', plan: { rooms: [room(1, 100, 100, 600, 500)] }, width: 10 });
  assert.equal(legacy.scale.method, 'import');
  assert.equal(legacy.scale.verified, false);
  close(P.widthFromMpp(legacy.plan, legacy.scale.mpp), 10, 1e-4);
  // a bare plan without any width: the default guess
  const bare = P.sanitize({ rooms: [room(1, 100, 100, 600, 500)] });
  assert.deepEqual([bare.scale.method, bare.scale.verified], ['default', false]);
  // verified + method + ref are kept; refs are validated per method
  const ok = P.sanitize({ plan: { rooms: [] }, scale: { mpp: 0.01, verified: true, method: 'two-points', ref: { a: { x: 0.1, y: 0.2 }, b: { x: 0.5, y: 0.2 }, metres: 4.32 } } });
  assert.deepEqual(ok.scale, { mpp: 0.01, verified: true, method: 'two-points', ref: { a: { x: 0.1, y: 0.2 }, b: { x: 0.5, y: 0.2 }, metres: 4.32 } });
  const area = P.sanitize({ plan: { rooms: [] }, scale: { mpp: 0.01, verified: true, method: 'area', ref: { areaM2: 58, roomId: 3 } } });
  assert.deepEqual(area.scale.ref, { areaM2: 58, roomId: 3 });
  for (const ref of [{ areaM2: -1 }, 'x', { a: null }, [], { metres: 0 }]) {
    const s = P.sanitize({ plan: { rooms: [] }, scale: { mpp: 0.01, verified: true, method: 'area', ref } });
    assert.equal(s.scale.ref, null, JSON.stringify(ref));
  }
  // "verified" without an mpp of its own is not a verified scale; garbage methods fall back
  assert.equal(P.sanitize({ plan: { rooms: [] }, scale: { verified: true } }).scale.verified, false);
  assert.equal(P.sanitize({ plan: { rooms: [] }, scale: { mpp: 0.01, verified: 'yes', method: 'magic' } }).scale.verified, false);
  assert.equal(P.sanitize({ plan: { rooms: [] }, scale: { mpp: 0.01, method: 'magic' } }).scale.method, 'import');
  // round trips: JSON, SVG; idempotent
  const p = flat();
  P.setScale(p, { mpp: 0.0111, method: 'area', ref: { areaM2: 39.5 } });
  assertValidProject(p, 'scaled');
  assert.deepEqual(P.sanitize(P.serialize(p)).scale, p.scale);
  assert.deepEqual(P.parseSvgText(P.buildSvg(p)).project.scale, p.scale);
  assert.deepEqual(P.sanitize(P.sanitize(p)), P.sanitize(p));
  // the old app still reads the width of the active floor (it ignores the extra keys)
  const data = JSON.parse(P.serialize(p));
  close(data.width, P.widthFromMpp(p.plan, 0.0111), 1e-3);
});

test('planArea: m² of every room, the counted area (minus excluded), largest / smallest; a project or a plan', () => {
  const p = flat();
  const a = P.planArea(p);
  assert.deepEqual(
    a.rooms.map((r) => [r.roomId, Math.round(r.areaM2 * 1000) / 1000, r.excluded]),
    [
      [1, 20, false],
      [2, 12, false],
      [3, 2, true],
    ],
  );
  close(a.areaM2, 32, 1e-4, 'without the balcony');
  close(a.allM2, 34, 1e-4);
  assert.equal(a.largest.roomId, 1);
  assert.equal(a.smallest.roomId, 2, 'excluded rooms are not the smallest');
  // the plan form: explicit mpp / excluded
  close(P.planArea(p.plan, 0.02).areaM2, 4 * 34, 1e-4);
  close(P.planArea(p.plan, 0.01, { excluded: [1] }).areaM2, 14, 1e-4);
  // nothing usable: zeros, never NaN
  assert.deepEqual(P.planArea({ rooms: [] }, 0.01), { areaM2: 0, allM2: 0, rooms: [], largest: null, smallest: null });
  assert.equal(P.planArea(p.plan).areaM2, 0, 'no mpp, no area');
  const broken = { rooms: [{ roomId: 1, points: [{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] };
  assert.equal(P.planArea(broken, 0.01).areaM2, 0);
});

test('the user story: a 58 m² flat drawn at random (the model thought ~100 m²) - type the area, the scale follows', () => {
  // drawn so that at the default 0.012 m/px it would be about 100 m² ...
  const p = flat(0.012);
  const before = P.planArea(p);
  const mpp = P.scaleFromArea(p.plan, 58, { excluded: p.goal.excluded });
  assert.ok(mpp > 0);
  assert.equal(P.setScale(p, { mpp, method: 'area', ref: { areaM2: 58 } }), true);
  const after = P.planArea(p);
  close(after.areaM2, 58, 1e-6, 'the flat now has 58 m²');
  // uniform: every room keeps its share, the coordinates do not move
  after.rooms.forEach((r, i) => close(r.areaM2 / after.allM2, before.rooms[i].areaM2 / before.allM2, 1e-12));
  assert.deepEqual(p.scale, { mpp, verified: true, method: 'area', ref: { areaM2: 58 } });
  // one room's area ("Tahle místnost má 14 m²")
  const m2 = P.scaleFromArea(p.plan, 14, { roomId: 2 });
  close(P.planArea(p.plan, m2).rooms.find((r) => r.roomId === 2).areaM2, 14, 1e-6);
  // two points / one wall ("Tahle zeď měří 4,2 m") and the width
  close(P.scaleFromLength(n(100, 100), n(500, 100), 4), 0.01, 1e-12);
  close(P.scaleFromLength(p.plan.walls[0].a, p.plan.walls[0].b, 4.2), 4.2 / 400, 1e-7);
  close(P.widthFromMpp(p.plan, P.scaleFromWidth(p.plan, 9.6)), 9.6, 1e-6);
  // unusable inputs: null, the scale stays as it was
  for (const bad of [0, -5, NaN, '58', null]) assert.equal(P.scaleFromArea(p.plan, bad), null, String(bad));
  assert.equal(P.scaleFromArea({ rooms: [] }, 58), null);
  assert.equal(P.scaleFromArea(p.plan, 1e9), null, 'beyond the mpp range');
  assert.equal(P.scaleFromLength(n(100, 100), n(100.5, 100), 2), null, 'two points closer than a pixel');
  assert.equal(P.scaleFromLength(n(100, 100), n(500, 100), 0), null);
  const kept = JSON.stringify(p.scale);
  assert.equal(P.setScale(p, { mpp: 5 }), false);
  assert.equal(P.setScale(p, {}), false);
  assert.equal(JSON.stringify(p.scale), kept);
  // confirming a scale as it is ("Sedí")
  const q = flat();
  assert.equal(q.scale.verified, false);
  assert.equal(P.confirmScale(q), true);
  assert.equal(q.scale.verified, true);
  assertValidProject(q, 'confirmed');
});

test('scaleIssues: unverified, the flat area, rooms and doors out of range - each with its numbers', () => {
  const ok = flat(0.0125);
  P.confirmScale(ok);
  // 31 + 18.75 m² flat, 0.9 m door (90 px x 0.0125 = 1.125 m)
  assert.deepEqual(P.scaleIssues(ok), []);
  const fresh = flat(0.0125);
  assert.deepEqual(P.scaleIssues(fresh), [{ code: 'unverified' }]);
  // far too small: 0.004 m/px -> 3.3 + 1.9 m², rooms < 1.5 m² only for the second one ... and a 36 cm door
  const small = flat(0.004);
  P.confirmScale(small);
  const s = P.scaleIssues(small);
  assert.deepEqual(
    s.map((i) => i.code),
    ['areaSmall', 'doorNarrow'],
  );
  close(s[0].value, 5.12, 1e-4);
  assert.equal(s[0].limit, 15);
  assert.equal(s[1].doorId, 'd1');
  close(s[1].value, 0.36, 1e-4);
  const tiny = flat(0.003);
  P.confirmScale(tiny);
  assert.deepEqual(
    P.scaleIssues(tiny).map((i) => [i.code, i.roomId || i.doorId || null]),
    [
      ['areaSmall', null],
      ['roomSmall', 2],
      ['doorNarrow', 'd1'],
    ],
  );
  // far too big: 0.05 m/px -> 500 + 300 m², a 4.5 m "door"
  const big = flat(0.05);
  P.confirmScale(big);
  assert.deepEqual(
    P.scaleIssues(big).map((i) => [i.code, i.roomId || i.doorId || null, i.floor === undefined ? '-' : i.floor]),
    [
      ['areaLarge', null, '-'],
      ['roomLarge', 1, 'floor-1'],
      ['roomLarge', 2, 'floor-1'],
      ['doorWide', 'd1', 'floor-1'],
    ],
  );
  // the excluded balcony is never a "room too small"; custom limits
  const lim = P.scaleIssues(ok, { limits: { roomMin: 25 } });
  assert.deepEqual(
    lim.map((i) => [i.code, i.roomId]),
    [['roomSmall', 2]],
  );
  // a door of exactly 60 cm is fine (to the centimetre)
  const d60 = makeProject({ rooms: [room(1, 100, 100, 700, 700)], walls: [wall('w', 400, 100, 400, 700, 8)], doors: [door('d', 'w', 400, 300, 400, 360, 3)], mpp: 0.01 });
  P.confirmScale(d60);
  assert.deepEqual(P.scaleIssues(d60), []);
  // no rooms: only "unverified" can be said
  assert.deepEqual(P.scaleIssues(P.create({ template: 'blank' })), [{ code: 'unverified' }]);
  // the showcase flat and the two-storey house are fine
  assert.deepEqual(P.scaleIssues(P.create({ template: 'demo' })), []);
  assert.deepEqual(P.scaleIssues(P.create({ template: 'house2' })), []);
});

test('scale of a building: one scale for every floor; the area check sums the floors, room checks name the floor', () => {
  const p = flat(0.0125);
  P.confirmScale(p);
  const up = P.duplicateFloor(p, 'floor-1');
  const b = P.buildingArea(p);
  assert.deepEqual(
    b.floors.map((f) => f.id),
    ['floor-1', up],
  );
  close(b.areaM2, 2 * P.planArea(p).areaM2, 1e-4, 'two identical floors');
  // the duplicated floor keeps the excluded balcony
  close(b.floors[1].areaM2, b.floors[0].areaM2, 1e-4);
  // a tiny room on the upper floor only
  const F = P.floorOf(p, up);
  F.plan.rooms.push(room(9, 950, 100, 1000, 150, 'Šatna'));
  const issues = P.scaleIssues(p);
  assert.deepEqual(
    issues.map((i) => [i.code, i.floor, i.roomId]),
    [['roomSmall', up, 9]],
  );
});
