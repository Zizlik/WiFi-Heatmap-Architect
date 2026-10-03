import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, rectPts } from './_helpers.mjs';

const { geom, units } = E;
const { W, H } = E.CANVAS;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);

test('dist / distM use canvas pixels (non-square canvas)', () => {
  close(geom.dist({ x: 0, y: 0 }, { x: 1, y: 0 }), W);
  close(geom.dist({ x: 0, y: 0 }, { x: 0, y: 1 }), H);
  close(geom.dist(n(10, 10), n(13, 14)), 5);
  close(geom.distM(n(0, 0), n(300, 400), 0.01), 5);
});

test('pointInPolygon: rectangle, concave L-shape, edge cases', () => {
  const rect = rectPts(100, 100, 300, 200);
  assert.equal(geom.pointInPolygon(n(200, 150), rect), true);
  assert.equal(geom.pointInPolygon(n(50, 150), rect), false);
  assert.equal(geom.pointInPolygon(n(200, 250), rect), false);
  const L = [n(0, 0), n(200, 0), n(200, 100), n(100, 100), n(100, 200), n(0, 200)];
  assert.equal(geom.pointInPolygon(n(50, 150), L), true);
  assert.equal(geom.pointInPolygon(n(150, 150), L), false, 'in the notch of the L');
  assert.equal(geom.pointInPolygon(n(150, 50), L), true);
});

test('polygonArea / centroid', () => {
  const rect = rectPts(0, 0, 540, 471); // quarter of the canvas
  close(geom.polygonArea(rect), 0.25);
  const c = geom.polygonCentroid(rect);
  close(c.x, 270 / W);
  close(c.y, 235.5 / H);
  // clockwise and counter-clockwise give the same positive area
  close(geom.polygonArea([...rect].reverse()), 0.25);
  // degenerate polygon falls back to the vertex average
  const d = geom.polygonCentroid([n(10, 10), n(20, 20), n(30, 30)]);
  close(d.x, 20 / W, 1e-9);
  close(d.y, 20 / H, 1e-9);
});

test('labelPoint is inside the polygon, also for L and C shaped rooms', () => {
  const shapes = [
    rectPts(100, 100, 500, 300),
    [n(0, 0), n(300, 0), n(300, 60), n(60, 60), n(60, 240), n(300, 240), n(300, 300), n(0, 300)], // C
    [n(0, 0), n(400, 0), n(400, 100), n(100, 100), n(100, 400), n(0, 400)], // L
  ];
  for (const s of shapes) {
    const p = geom.labelPoint(s);
    assert.equal(geom.pointInPolygon(p, s), true, JSON.stringify(p));
    // and clearly away from the outline (more than 10 px for these shapes)
    assert.ok(geom.signedDistPx(p, s) > 10, `distance ${geom.signedDistPx(p, s)}`);
  }
});

test('segIntersection', () => {
  const x = geom.segIntersection(n(0, 0), n(100, 100), n(0, 100), n(100, 0));
  assert.ok(x);
  close(x.t, 0.5);
  close(x.u, 0.5);
  close(x.x * W, 50, 1e-6);
  close(x.y * H, 50, 1e-6);
  assert.equal(geom.segIntersection(n(0, 0), n(100, 0), n(0, 10), n(100, 10)), null, 'parallel');
  assert.equal(geom.segIntersection(n(0, 0), n(100, 0), n(0, 0), n(100, 0)), null, 'collinear');
  assert.equal(geom.segIntersection(n(0, 0), n(10, 10), n(20, 0), n(0, 20)) !== null, true);
  assert.equal(geom.segIntersection(n(0, 0), n(10, 10), n(50, 0), n(50, 100)), null, 'lines cross, segments do not');
  const touch = geom.segIntersection(n(0, 0), n(100, 0), n(100, 0), n(100, 100));
  assert.ok(touch, 'touching ends count');
});

test('closestOnSegment returns px distance', () => {
  const r = geom.closestOnSegment(n(50, 30), n(0, 0), n(100, 0));
  close(r.d, 30);
  close(r.t, 0.5);
  close(r.x * W, 50);
  const end = geom.closestOnSegment(n(150, 0), n(0, 0), n(100, 0));
  close(end.t, 1);
  close(end.d, 50);
  const degenerate = geom.closestOnSegment(n(10, 10), n(5, 5), n(5, 5));
  close(degenerate.d, Math.hypot(5, 5));
});

test('bbox', () => {
  assert.equal(geom.bbox([]), null);
  assert.deepEqual(geom.bbox([{ x: 0.2, y: 0.9 }, { x: 0.5, y: 0.1 }]), { minX: 0.2, minY: 0.1, maxX: 0.5, maxY: 0.9 });
});

test('validatePolygon: accepts good outlines, rejects bad ones', () => {
  assert.equal(geom.validatePolygon(rectPts(100, 100, 300, 200)), true);
  assert.equal(geom.validatePolygon([n(0, 0), n(300, 0), n(300, 60), n(60, 60), n(60, 240), n(300, 240), n(300, 300), n(0, 300)]), true, 'concave is fine');
  assert.equal(geom.validatePolygon([n(0, 0), n(100, 100), n(100, 0), n(0, 100)]), false, 'bow-tie');
  assert.equal(geom.validatePolygon([n(0, 0), n(100, 0)]), false, 'two points');
  assert.equal(geom.validatePolygon([n(0, 0), n(100, 0), n(200, 0)]), false, 'zero area');
  assert.equal(geom.validatePolygon([n(0, 0), n(1, 0), n(0, 1)]), false, 'sub-pixel area');
  assert.equal(geom.validatePolygon(null), false);
  assert.equal(geom.validatePolygon('x'), false);
  assert.equal(geom.validatePolygon([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), false);
  assert.equal(geom.validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, null]), false);
  const many = Array.from({ length: 201 }, (_, i) => ({ x: 0.5 + 0.4 * Math.cos((i / 201) * 2 * Math.PI), y: 0.5 + 0.4 * Math.sin((i / 201) * 2 * Math.PI) }));
  assert.equal(geom.validatePolygon(many), false, '201 vertices');
  assert.equal(geom.validatePolygon(many.slice(0, 200)), true, '200 vertices');
});

test('snapGrid snaps to 1 % by default and clamps', () => {
  const p = geom.snapGrid({ x: 0.1234, y: 0.5678 });
  close(p.x, 0.12);
  close(p.y, 0.57);
  const q = geom.snapGrid({ x: 1.2, y: -0.3 }, 0.05);
  close(q.x, 1);
  close(q.y, 0);
});

test('simplify drops duplicates and collinear points', () => {
  const s = geom.simplify([n(0, 0), n(0, 0), n(100, 0), n(200, 0), n(200, 100), n(0, 100)]);
  assert.equal(s.length, 4);
});

test('units: pct/dBm', () => {
  assert.equal(units.pctToDbm(100), -50);
  assert.equal(units.pctToDbm(0), -100);
  assert.equal(units.pctToDbm(60), -70);
  assert.equal(units.dbmToPct(-70), 60);
  assert.equal(units.dbmToPct(-120), 0);
  assert.equal(units.dbmToPct(-20), 100);
});

test('units: qualityOf cut-offs (SPEC 1.8)', () => {
  const k = (d) => units.qualityOf(d).key;
  assert.equal(k(-30), 'excellent');
  assert.equal(k(-50), 'excellent');
  assert.equal(k(-50.01), 'veryGood');
  assert.equal(k(-60), 'veryGood');
  assert.equal(k(-60.01), 'good');
  assert.equal(k(-67), 'good');
  assert.equal(k(-67.01), 'weak');
  assert.equal(k(-75), 'weak');
  assert.equal(k(-75.01), 'veryWeak');
  assert.equal(k(-85), 'veryWeak');
  assert.equal(k(-85.01), 'unusable');
  assert.equal(k(-110), 'unusable');
  assert.equal(k(NaN), 'unusable');
  assert.equal(units.qualityIndex(-55), 1);
});

test('units: number formatting', () => {
  assert.equal(units.formatMbps(null), '—');
  assert.equal(units.formatMbps(NaN), '—');
  assert.equal(units.formatMbps(120.4, 'en'), '120');
  assert.equal(units.formatMbps(3.46, 'en'), '3.5');
  assert.equal(units.formatMbps(3.46, 'cs'), '3,5');
  assert.match(units.formatMbps(1234, 'cs'), /^1\s234$/);
  assert.equal(units.formatDbm(-67, 'en'), '−67 dBm');
  assert.equal(units.formatDbm(-67.4, 'cs'), '−67 dBm');
  assert.equal(units.normBand('2,4'), 2.4);
  assert.equal(units.normBand('5'), 5);
  assert.equal(units.normBand(7), null);
  assert.equal(units.bandKey(5), '5');
  assert.equal(units.bandLabel(2.4, 'cs'), '2,4');
  assert.equal(units.bandLabel(2.4, 'en'), '2.4');
});
