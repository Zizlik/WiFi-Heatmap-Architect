import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { E, FIXTURES, readPrivatePlan, rawPayloadOf } from './_load.mjs';
import { n, room, wall, door, furn, makeProject, rng } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const P = E.project;
const { W, H } = E.CANVAS;
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b} (eps ${eps})`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const oldDemo = () => JSON.parse(readFileSync(path.join(FIXTURES, 'old-demo-payload.json'), 'utf8'));

function throwsKey(fn, key, label = '') {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Error, `${label}: not an Error: ${e}`);
    assert.equal(e.message, key, `${label}: expected ${key}, got ${e.message}`);
    assert.equal(e.code, key);
    return;
  }
  assert.fail(`${label}: expected a throw of ${key}`);
}

// ---------------------------------------------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------------------------------------------

test('create(demo): a valid, nicely proportioned flat in the requested language', () => {
  const cs = P.create({ template: 'demo', lang: 'cs' });
  const en = P.create({ template: 'demo', lang: 'en' });
  assertValidProject(cs, 'demo cs');
  assertValidProject(en, 'demo en');
  assert.equal(cs.plan.rooms.length, 6);
  assert.deepEqual(cs.plan.rooms.map((r) => r.name), ['Obývací pokoj', 'Kuchyň', 'Ložnice', 'Chodba', 'Koupelna', 'Pracovna']);
  assert.deepEqual(en.plan.rooms.map((r) => r.name), ['Living room', 'Kitchen', 'Bedroom', 'Hall', 'Bathroom', 'Office']);
  assert.equal(cs.goal.device, 'Telefon');
  assert.equal(en.goal.device, 'Phone');
  assert.equal(cs.scale.mpp, 0.01);
  close(P.widthFromMpp(cs.plan, cs.scale.mpp), 9, 0.005, 'the flat is 9 m wide');
  assert.ok(cs.plan.walls.length >= 10 && cs.plan.doors.length >= 4 && cs.plan.furniture.length >= 10);
  assert.ok(cs.plan.walls.every((w) => w.material && w.loss >= 3), 'every demo wall has a material');
  assert.ok(new Set(cs.plan.walls.map((w) => w.material)).size >= 2, 'brick and drywall');
  assert.ok(cs.plan.doors.some((d) => d.loss === 0) && cs.plan.doors.some((d) => d.loss > 0), 'open doorways and closed doors');
  // today == trial at the start, inside the hall, and the internet inlet sits in the hall too
  assert.deepEqual(cs.net.router, cs.net.baseline);
  assert.equal(P.roomAt(cs.plan, cs.net.router).name, 'Chodba');
  assert.equal(P.roomAt(cs.plan, cs.net.optic).name, 'Chodba');
  assert.equal(cs.measurements.length, 0);
  assert.equal(cs.view.band, 5);
  // default language follows WH.i18n.lang (cs in the test stub)
  assert.equal(P.create({ template: 'demo' }).plan.rooms[0].name, 'Obývací pokoj');
  // fresh object every time
  assert.notEqual(P.create({ template: 'demo' }), P.create({ template: 'demo' }));
});

test('create(blank) / defaults()', () => {
  const b = P.create({ template: 'blank', lang: 'en' });
  assertValidProject(b, 'blank');
  assert.equal(b.plan.rooms.length, 0);
  assert.equal(b.name, 'My flat');
  assert.equal(b.goal.device, 'Phone');
  assert.ok(b.scale.mpp > 0);
  const d1 = P.defaults();
  d1.model.n = 3;
  assert.equal(P.defaults().model.n, 2.2, 'defaults() returns fresh objects');
  assert.deepEqual(Object.keys(P.defaults()).sort(), ['goal', 'measurements', 'model', 'net', 'node', 'scale', 'view']);
  assert.equal(P.SCHEMA_VERSION, 3);
  assert.equal(P.create({ template: 'nonsense' }).plan.rooms.length, 6, 'unknown template falls back to the demo flat');
});

// ---------------------------------------------------------------------------------------------------------------
// accepted inputs
// ---------------------------------------------------------------------------------------------------------------

test('sanitize: an optional private real plan (WH_PRIVATE_PLAN) via parseSvgText -> sanitize keeps what the file says', () => {
  const svg = readPrivatePlan();
  if (svg === null) return; // not part of the repository: skipped unless WH_PRIVATE_PLAN points at a plan
  const raw = rawPayloadOf(svg);
  assert.ok(raw && raw.plan, 'the file carries our metadata');
  const r = P.parseSvgText(svg);
  assert.equal(r.hasData, true);
  const p = r.project;
  assertValidProject(p, 'private plan');
  // every object of a valid file survives, in order, with its name
  for (const k of ['rooms', 'walls', 'doors', 'furniture']) assert.equal(p.plan[k].length, (raw.plan[k] || []).length, k);
  assert.deepEqual(p.plan.rooms.map((x) => x.name), raw.plan.rooms.map((x) => x.name));
  p.plan.furniture.forEach((f, i) => assert.equal(f.points.length, raw.plan.furniture[i].points.length, `furniture ${i} keeps its outline`));
  // a raster tracing background is kept as it is; an old SVG one is handed to the DOM for rasterising
  const bg = raw.plan.background;
  if (typeof bg === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(bg)) { assert.equal(p.plan.background, bg); assert.equal(r.svgBackground, null); }
  if (typeof bg === 'string' && /^data:image\/svg\+xml/.test(bg)) assert.ok(r.svgBackground);
  // scale: an old file's width (m) over the rooms' bounding box
  if (!(raw.project && raw.project.scale) && Number.isFinite(raw.width) && raw.width >= 6 && raw.width <= 25) close(P.widthFromMpp(p.plan, p.scale.mpp), raw.width, 1e-6);
  // markers on the floor stay where the file put them: trial = router, today = original (or router)
  if (!(raw.project && raw.project.net) && raw.router && P.floorMaskAt(p.plan, raw.router)) {
    close(p.net.router.x, raw.router.x, 1e-6);
    close(p.net.router.y, raw.router.y, 1e-6);
    const orig = raw.original || raw.router;
    if (P.floorMaskAt(p.plan, orig)) { close(p.net.baseline.x, orig.x, 1e-6); close(p.net.baseline.y, orig.y, 1e-6); }
  }
  // SPEC 7.1: a wall with an OLD preset number is that preset, stored as the new table's 5 GHz value; walls without a
  // material follow model.wallLoss; custom numbers are kept
  p.plan.walls.forEach((w, i) => {
    const rw = raw.plan.walls[i];
    assert.equal(w.name, rw.name, `wall ${i} name`);
    if (!rw.material) assert.equal(w.loss, undefined, `wall ${i}: no material -> model.wallLoss`);
    else if (rw.material in P.LEGACY_WALL_MATERIALS && rw.loss === P.LEGACY_WALL_MATERIALS[rw.material]) assert.equal(w.loss, E.model.MATERIALS[rw.material]['5'], `wall ${i}: legacy preset`);
  });
  // defaults of a freshly imported legacy file (SPEC 3.1): 5 GHz, whole flat, no node
  if (!raw.project) {
    assert.equal(p.view.band, 5);
    assert.equal(p.goal.room, 'all');
    assert.equal(p.node.mode, 'none');
    assert.equal(p.measurements.length, 0);
  }
  // all markers sit on the floor
  assert.ok(P.floorMaskAt(p.plan, p.net.router));
  assert.ok(P.floorMaskAt(p.plan, p.net.baseline));
});

test('sanitize: the old demo payload shape (plan + width + router/original/optic)', () => {
  const raw = oldDemo();
  const p = P.sanitize(raw);
  assertValidProject(p, 'old demo');
  assert.deepEqual(p.plan.rooms.map((r) => r.name), ['Living room', 'Kitchen', 'Office', 'Hall']);
  assert.equal(p.plan.walls.length, 10);
  assert.equal(p.plan.doors.length, 4);
  assert.equal(p.plan.furniture.length, 3);
  assert.equal(p.plan.walls[7].material, 'drywall');
  assert.equal(p.plan.walls[7].loss, 4, 'old preset 3 -> the drywall table (3 / 4 / 5 dB), stored as its 5 GHz value');
  // width 12 m over the rooms' box (0.08 .. 0.92 of the canvas width)
  close(p.scale.mpp, 12 / (0.84 * W), 1e-8);
  close(P.widthFromMpp(p.plan, p.scale.mpp), 12, 1e-6);
  assert.deepEqual(p.net.router, { x: 0.48, y: 0.63 });
  assert.deepEqual(p.net.baseline, p.net.router);
  assert.deepEqual(p.net.optic, { x: 0.1, y: 0.62 });
  // the old demo had no wall corners that matter for the data, but ids and room numbers are intact
  assert.deepEqual(p.plan.rooms.map((r) => r.roomId), [1, 2, 3, 4]);
  // baseline falls back to router when `original` is missing; and trial/today differ when both are given
  const r2 = clone(raw);
  delete r2.original;
  assert.deepEqual(P.sanitize(r2).net.baseline, { x: 0.48, y: 0.63 });
  const r3 = clone(raw);
  r3.router = { x: 0.3, y: 0.3 };
  const p3 = P.sanitize(r3);
  assert.deepEqual(p3.net.router, { x: 0.3, y: 0.3 });
  assert.deepEqual(p3.net.baseline, { x: 0.48, y: 0.63 });
  // invalid width -> 12 m default; valid width is used
  const r4 = clone(raw);
  r4.width = 5;
  close(P.widthFromMpp(P.sanitize(r4).plan, P.sanitize(r4).scale.mpp), 12, 1e-6);
  r4.width = 20;
  close(P.widthFromMpp(P.sanitize(r4).plan, P.sanitize(r4).scale.mpp), 20, 1e-6);
});

test('sanitize: bare plans, legacy localStorage objects and JSON strings', () => {
  const raw = oldDemo();
  const bare = P.sanitize(raw.plan);
  assertValidProject(bare, 'bare plan');
  assert.equal(bare.plan.rooms.length, 4);
  const v5 = P.sanitize({ ed: raw.plan, appliedPlan: raw.plan });
  assertValidProject(v5, 'v5');
  const v5ed = P.sanitize({ ed: { ...raw.plan, importedSettings: { width: 9, router: { x: 0.3, y: 0.2 }, optic: { x: 0.2, y: 0.2 } } } });
  assert.deepEqual(v5ed.net.optic, { x: 0.2, y: 0.2 });
  close(P.widthFromMpp(v5ed.plan, v5ed.scale.mpp), 9, 1e-6);
  const fromString = P.sanitize(JSON.stringify(raw));
  assert.deepEqual(fromString, P.sanitize(raw));
  // the old VECTORS shape: numeric room ids, no walls/doors/furniture
  const vectors = P.sanitize({
    rooms: [
      { id: 1, name: 'Living room', points: [{ x: 0.08, y: 0.12 }, { x: 0.55, y: 0.12 }, { x: 0.55, y: 0.56 }, { x: 0.08, y: 0.56 }], color: '#8eadd2', label: { x: 0.3, y: 0.3 } },
      { id: 2, name: 'Kitchen', points: [{ x: 0.55, y: 0.12 }, { x: 0.92, y: 0.12 }, { x: 0.92, y: 0.56 }, { x: 0.55, y: 0.56 }], color: '#deb879' },
    ],
  });
  assertValidProject(vectors, 'vectors');
  assert.deepEqual(vectors.plan.rooms.map((r) => r.roomId), [1, 2]);
  assert.deepEqual(vectors.plan.rooms.map((r) => r.id), ['room-1', 'room-2']);
});

test('sanitize: v3 projects are idempotent and keep every slice', () => {
  const p = P.create({ template: 'demo', lang: 'en' });
  p.measurements = [
    { id: 'm1', x: 0.5, y: 0.7, band: 5, value: -62.5, name: 'Hall', download: 300, upload: 100, device: 'Phone', t: 1700000000000 },
    { id: 'm2', x: 0.3, y: 0.3, band: 2.4, value: -70, name: 'Living', download: null, upload: null, device: 'Laptop', t: 0 },
  ];
  p.goal = { room: 2, allowedRoom: 4, excluded: [5, 6], mode: 'speed', targetDown: 120, targetUp: 40, reserve: 25, device: 'Laptop' };
  p.node = { mode: 'mesh_wifi', pos: { x: 0.3, y: 0.3 }, bands: { '2.4': true, '5': false, '6': true }, power: -3, backhaulBand: 6, backhaulThreshold: -70 };
  p.model = { nearSignal: -38, n: 2.6, wallLoss: 10, threshold: -65, rangeThreshold: -58, bandPower: { '2.4': -3, '5': 0, '6': 1.5 } };
  p.net.wanDown = 500;
  p.net.wanUp = 100;
  p.net.wanPort = 1000;
  p.net.ontPort = 2500;
  p.net.wanLink = 1000;
  p.net.cableCategory = 'cat6';
  p.net.cableLength = 12.5;
  p.view = { band: 6, layer: 'diff', ranges: true, walls: false, furniture: false, labels: false, values: true, calibrate: false, palette: 'cb' };
  const s = P.sanitize(p);
  assertValidProject(s, 'v3');
  assert.deepEqual(s, p);
  assert.deepEqual(P.sanitize(s), s, 'idempotent');
  assert.deepEqual(P.sanitize(JSON.parse(JSON.stringify(s))), s);
  // sanitize does not modify its input
  const before = JSON.stringify(p);
  P.sanitize(p);
  assert.equal(JSON.stringify(p), before);
});

test('sanitize: clamps values, repairs references, snaps markers onto the floor', () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const raw = clone(p);
  raw.model = { nearSignal: -5, n: 9, wallLoss: 99, threshold: -10, rangeThreshold: 'x', bandPower: { '2.4': -50, '5': 'loud', '6': 9 } };
  raw.net.router = { x: 2, y: -1 }; // far outside
  raw.net.baseline = { x: 0.02, y: 0.02 }; // outside the flat
  raw.net.wanDown = 99999;
  raw.net.wanPort = 777;
  raw.net.cableLength = 1000;
  raw.net.cableCategory = 'cat9';
  raw.node = { mode: 'teleport', pos: { x: 0.01, y: 0.99 }, bands: { '5': false, '2.4': false, '6': true }, power: 50, backhaulBand: 5, backhaulThreshold: 0 };
  raw.goal = { room: 99, allowedRoom: 'kitchen', excluded: [1, 1, 77, 'x'], mode: 'fast', targetDown: 0, targetUp: 1e9, reserve: 200, device: '  '.repeat(5) };
  raw.view = { band: 4, layer: 'x', palette: 'neon', ranges: 'yes' };
  raw.measurements = [{ id: 'a', x: 0.5, y: 0.5, band: '5', value: 0, name: 'x'.repeat(200), download: -5, upload: 1e6, device: 'D'.repeat(100) }, { x: 'a', y: 0, band: 5, value: -50 }, { x: 0.5, y: 0.5, band: 7, value: -50 }, null, 7];
  const s = P.sanitize(raw);
  assertValidProject(s, 'clamped');
  assert.deepEqual(s.model, { nearSignal: -25, n: 4, wallLoss: 20, threshold: -55, rangeThreshold: -60, bandPower: { '2.4': -10, '5': 0, '6': 6 } });
  assert.ok(P.floorMaskAt(s.plan, s.net.router) && P.floorMaskAt(s.plan, s.net.baseline) && P.floorMaskAt(s.plan, s.node.pos));
  assert.equal(s.net.wanDown, 10000);
  assert.equal(s.net.wanPort, null);
  assert.equal(s.net.cableLength, null);
  assert.equal(s.net.cableCategory, 'unknown');
  assert.equal(s.node.mode, 'none');
  assert.equal(s.node.power, 6);
  assert.equal(s.node.backhaulThreshold, -55);
  assert.equal(s.node.backhaulBand, 6, 'backhaul moved to a band the node serves');
  assert.deepEqual(s.goal.excluded, [1]);
  assert.equal(s.goal.room, 'all');
  assert.equal(s.goal.allowedRoom, 'any');
  assert.equal(s.goal.mode, 'signal');
  assert.equal(s.goal.targetDown, 1);
  assert.equal(s.goal.targetUp, 10000);
  assert.equal(s.goal.reserve, 80);
  assert.equal(s.goal.device, 'Telefon');
  assert.equal(s.view.band, 5);
  assert.equal(s.view.layer, 'signal');
  assert.equal(s.view.palette, 'default');
  assert.equal(s.view.ranges, false);
  assert.equal(s.measurements.length, 1);
  const m = s.measurements[0];
  assert.equal(m.band, 5);
  assert.equal(m.value, -20);
  assert.equal(m.name.length, 50);
  assert.equal(m.download, 0);
  assert.equal(m.upload, 10000);
  assert.equal(m.device.length, 50);
});

test('sanitize: names are cleaned (control characters, length, emoji safe)', () => {
  const raw = clone(P.create({ template: 'demo', lang: 'cs' }));
  raw.plan.rooms[0].name = '  Obývák\u0000\u0007\n\tvelký  ';
  raw.plan.rooms[1].name = 'x'.repeat(80);
  raw.plan.rooms[2].name = '😀'.repeat(60);
  raw.plan.rooms[3].name = '   ';
  raw.plan.rooms[4].name = 42;
  raw.plan.rooms[5].name = '\ud800lone';
  raw.name = '<script>alert(1)</script>';
  const s = P.sanitize(raw);
  assertValidProject(s, 'names');
  assert.equal(s.plan.rooms[0].name, 'Obývák velký');
  assert.equal(s.plan.rooms[1].name.length, 50);
  assert.equal([...s.plan.rooms[2].name].length, 50);
  assert.equal(s.plan.rooms[3].name, 'Místnost 4');
  assert.equal(s.plan.rooms[4].name, '42');
  assert.equal(s.plan.rooms[5].name, 'lone');
  assert.equal(s.name, '<script>alert(1)</script>', 'text is data; it is escaped on output');
});

test('sanitize: tolerates points a hair outside [0,1] (clamped), rounds to 6 decimals', () => {
  const raw = oldDemo();
  raw.plan.rooms[0].points[0] = { x: -0.0004, y: 0.123456789 };
  raw.plan.rooms[0].points[1] = { x: 0.55, y: 0.12 };
  const p = P.sanitize(raw);
  assert.equal(p.plan.rooms[0].points[0].x, 0);
  assert.equal(p.plan.rooms[0].points[0].y, 0.123457);
});

test('sanitize: svg data-URL backgrounds are reported, never kept', () => {
  const raw = oldDemo();
  const svgBg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  raw.plan.background = svgBg;
  const r = P.sanitizeDetailed(raw);
  assert.equal(r.project.plan.background, null);
  assert.equal(r.svgBackground, svgBg);
  raw.plan.background = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(P.sanitize(raw).plan.background, 'data:image/png;base64,iVBORw0KGgo=');
  for (const bad of ['http://evil.example/x.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+', 'data:image/png;base64,@@@', 123, {}, 'data:image/png;base64,' + 'A'.repeat(7000001)]) {
    raw.plan.background = bad;
    assert.equal(P.sanitize(raw).plan.background, null, String(bad).slice(0, 30));
  }
});

test('sanitize(strict:false) drops what it cannot use instead of throwing', () => {
  const raw = oldDemo();
  raw.plan.rooms.push({ id: 'room-9', type: 'room', roomId: 9, name: 'Bow-tie', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.2, y: 0.1 }, { x: 0.1, y: 0.2 }] });
  raw.plan.doors.push({ id: 'door-x', type: 'door', name: 'orphan', a: { x: 0.5, y: 0.5 }, b: { x: 0.6, y: 0.5 }, wallId: 'nope', loss: 0 });
  raw.plan.walls.push({ id: 'wall-1', type: 'wall', name: 'duplicate id', a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } });
  raw.plan.walls.push({ id: 'wall-77', type: 'wall', name: 'off map', a: { x: 5, y: 0.1 }, b: { x: 0.2, y: 0.2 } });
  raw.plan.furniture.push('garbage');
  throwsKey(() => P.sanitize(raw), 'err.plan.polygon', 'strict');
  const r = P.sanitizeDetailed(raw, { strict: false });
  assertValidProject(r.project, 'lenient');
  assert.equal(r.project.plan.rooms.length, 4, 'bow-tie dropped');
  assert.equal(r.project.plan.doors.length, 4, 'orphan door dropped');
  assert.ok(r.warnings.length >= 4, r.warnings.join('; '));
  // duplicate ids are renamed, not lost
  assert.equal(r.project.plan.walls.length, 12);
});

// ---------------------------------------------------------------------------------------------------------------
// rejected inputs
// ---------------------------------------------------------------------------------------------------------------

test('sanitize rejects garbage with i18n error keys', () => {
  const ok = oldDemo;
  throwsKey(() => P.sanitize(null), 'err.plan.invalid', 'null');
  throwsKey(() => P.sanitize(undefined), 'err.plan.invalid', 'undefined');
  throwsKey(() => P.sanitize(42), 'err.plan.invalid', 'number');
  throwsKey(() => P.sanitize([]), 'err.plan.invalid', 'array');
  throwsKey(() => P.sanitize('not json'), 'err.plan.invalid', 'text');
  throwsKey(() => P.sanitize('{"rooms":'), 'err.plan.invalid', 'truncated json');
  throwsKey(() => P.sanitize({}), 'err.plan.invalid', 'empty object');
  throwsKey(() => P.sanitize({ plan: 5 }), 'err.plan.invalid', 'plan is a number');
  throwsKey(() => P.sanitize({ plan: {} }), 'err.plan.invalid', 'plan without rooms');
  throwsKey(() => P.sanitize({ plan: { rooms: 'x' } }), 'err.plan.invalid', 'rooms is a string');
  throwsKey(() => P.sanitize({ ...ok(), format: 'wifi-floor-v9' }), 'err.plan.format', 'format');
  throwsKey(() => P.sanitize({ format: 'other', rooms: [] }), 'err.plan.format', 'format 2');
  // limits
  let raw = ok();
  raw.plan.rooms = Array.from({ length: 251 }, (_, i) => ({ id: `r${i}`, roomId: (i % 250) + 1, name: 'x', points: raw.plan.rooms[0].points }));
  throwsKey(() => P.sanitize(raw), 'err.plan.tooMany', '251 rooms');
  raw = ok();
  raw.plan.walls = new Array(1e7); // would take forever to iterate; must be rejected by length
  const t0 = performance.now();
  throwsKey(() => P.sanitize(raw), 'err.plan.tooMany', 'huge sparse array');
  assert.ok(performance.now() - t0 < 200);
  // ids
  raw = ok();
  raw.plan.walls[1].id = raw.plan.walls[0].id;
  throwsKey(() => P.sanitize(raw), 'err.plan.duplicateId', 'duplicate wall id');
  raw = ok();
  raw.plan.furniture[0].id = raw.plan.rooms[0].id;
  throwsKey(() => P.sanitize(raw), 'err.plan.duplicateId', 'id shared by room and furniture');
  // points
  for (const bad of [{ x: 1.5, y: 0.5 }, { x: -0.5, y: 0.5 }, { x: 0.5, y: 2 }, { x: NaN, y: 0.5 }, { x: '0.5', y: 0.5 }, { x: null, y: 0.5 }, { x: Infinity, y: 0 }, null, 'p', [0.5, 0.5]]) {
    raw = ok();
    raw.plan.walls[0].a = bad;
    throwsKey(() => P.sanitize(raw), 'err.plan.point', `bad wall point ${JSON.stringify(bad)}`);
    raw = ok();
    raw.plan.rooms[0].points[1] = bad;
    throwsKey(() => P.sanitize(raw), 'err.plan.point', `bad room point ${JSON.stringify(bad)}`);
  }
  // polygons
  raw = ok();
  raw.plan.rooms[0].points = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.1, y: 0.3 }];
  throwsKey(() => P.sanitize(raw), 'err.plan.polygon', 'bow-tie room');
  raw = ok();
  raw.plan.rooms[0].points = raw.plan.rooms[0].points.slice(0, 2);
  throwsKey(() => P.sanitize(raw), 'err.plan.polygon', 'two points');
  raw = ok();
  raw.plan.furniture[0].points = Array.from({ length: 201 }, (_, i) => ({ x: 0.5 + 0.4 * Math.cos((i / 201) * 6.2831), y: 0.5 + 0.4 * Math.sin((i / 201) * 6.2831) }));
  throwsKey(() => P.sanitize(raw), 'err.plan.polygon', '201 points');
  raw = ok();
  raw.plan.rooms[0].points = 'abc';
  throwsKey(() => P.sanitize(raw), 'err.plan.polygon', 'points is not an array');
  // room numbers
  for (const bad of [0, 251, 1.5, '3', -1, NaN]) {
    raw = ok();
    raw.plan.rooms[1].roomId = bad;
    throwsKey(() => P.sanitize(raw), 'err.plan.roomId', `roomId ${bad}`);
  }
  raw = ok();
  raw.plan.rooms[1].roomId = raw.plan.rooms[0].roomId;
  throwsKey(() => P.sanitize(raw), 'err.plan.roomId', 'duplicate roomId');
  // doors
  raw = ok();
  raw.plan.doors[0].wallId = 'wall-404';
  throwsKey(() => P.sanitize(raw), 'err.plan.door', 'door without wall');
  raw = ok();
  delete raw.plan.doors[0].wallId;
  throwsKey(() => P.sanitize(raw), 'err.plan.door', 'door without wallId');
  // array members that are not objects
  raw = ok();
  raw.plan.walls[2] = 'wall';
  throwsKey(() => P.sanitize(raw), 'err.plan.invalid', 'non-object wall');
});

test('sanitize is safe against prototype pollution and inherited properties', () => {
  const raw = JSON.parse(
    '{"format":"wifi-floor-v2","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted2":1}},"plan":{"__proto__":{"polluted3":1},"rooms":[{"id":"r","roomId":1,"name":"x","__proto__":{"polluted4":1},"points":[{"x":0.1,"y":0.1},{"x":0.5,"y":0.1},{"x":0.5,"y":0.5},{"x":0.1,"y":0.5}]}],"walls":[],"doors":[],"furniture":[]},"project":{"__proto__":{"polluted5":1},"model":{"__proto__":{"n":3}}}}',
  );
  const p = P.sanitize(raw);
  assertValidProject(p, 'pollution');
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  assert.equal({}.polluted3, undefined);
  assert.equal({}.polluted4, undefined);
  assert.equal({}.polluted5, undefined);
  assert.equal(p.model.n, 2.2);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.ok(!Object.keys(p.plan.rooms[0]).includes('__proto__'));
});

test('sanitize fuzz: random corruption either yields a fully valid project or an err.* Error', () => {
  const r = rng(2026);
  const base = P.create({ template: 'demo', lang: 'cs' });
  base.measurements = [{ id: 'm1', x: 0.5, y: 0.7, band: 5, value: -62.5, name: 'Hall', download: 300, upload: 100, device: 'Phone', t: 1 }];
  const paths = [];
  (function walk(o, prefix) {
    if (o !== null && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], [...prefix, k]);
    else paths.push(prefix);
  })(base, []);
  const junk = [null, undefined, NaN, Infinity, -Infinity, -1, 0, 1e308, 'x', '', '😀', true, false, [], {}, [1, 2, 3], { x: 1 }, { x: 'a', y: null }, '__proto__', 0.5, -0.5, 1.0000001, 251, 1e-300];
  let accepted = 0;
  let rejected = 0;
  const keys = new Set();
  for (let iter = 0; iter < 1500; iter++) {
    const raw = clone(base);
    const hits = 1 + Math.floor(r() * 3);
    for (let h = 0; h < hits; h++) {
      const path2 = paths[Math.floor(r() * paths.length)];
      let o = raw;
      for (let k = 0; k < path2.length - 1; k++) o = o[path2[k]];
      if (o === undefined || o === null) continue;
      const last = path2[path2.length - 1];
      const choice = r();
      if (choice < 0.1) delete o[last];
      else o[last] = junk[Math.floor(r() * junk.length)];
    }
    for (const strict of [true, false]) {
      try {
        const p = P.sanitize(JSON.parse(JSON.stringify(raw, (k, v) => (v === undefined ? null : v))), { strict });
        assertValidProject(p, `fuzz ${iter} strict=${strict}`);
        // whatever survived is stable: idempotent, and a file round trip gives the very same project
        assert.deepEqual(P.sanitize(p), p, `fuzz ${iter}: idempotent`);
        if (accepted % 6 === 0) assert.deepEqual(P.parseSvgText(P.buildSvg(p)).project, p, `fuzz ${iter}: file round trip`);
        accepted++;
      } catch (e) {
        assert.ok(e instanceof Error && e.message.startsWith('err.'), `fuzz ${iter}: unexpected ${e && e.stack}`);
        keys.add(e.message);
        rejected++;
      }
    }
  }
  assert.ok(accepted > 300 && rejected > 100, `accepted ${accepted}, rejected ${rejected}`);
  assert.ok(keys.size >= 4, [...keys].join());
});

test('sanitize: very long strings, deep nesting and big arrays are cheap', () => {
  const raw = oldDemo();
  raw.plan.rooms[0].name = 'x'.repeat(5e6);
  const t0 = performance.now();
  const p = P.sanitize(raw);
  assert.equal(p.plan.rooms[0].name.length, 50);
  let deep = {};
  const root = deep;
  for (let i = 0; i < 20000; i++) deep = deep.a = {};
  raw.plan.walls[0].extra = root; // never read
  P.sanitize(raw);
  raw.plan.walls[0].extra = undefined;
  raw.project = { measurements: Array.from({ length: 100000 }, (_, i) => ({ x: 0.5, y: 0.5, band: 5, value: -60 - (i % 10), name: 'm' })) };
  const q = P.sanitize(raw);
  assert.equal(q.measurements.length, 500, 'measurements are capped at 500');
  assert.ok(performance.now() - t0 < 1500, `${performance.now() - t0} ms`);
});

test('error keys: every thrown key has a cs and en string', () => {
  for (const k of E.text.errorKeys) {
    assert.ok(E.text.dict.cs[k] && E.text.dict.en[k], k);
    assert.notEqual(E.text.t(k, 'cs'), k);
    assert.notEqual(E.text.t(k, 'en'), E.text.t(k, 'cs'), `${k} is translated`);
  }
  assert.ok(E.text.errorKeys.includes('err.plan.invalid'));
  void n;
  void room;
  void wall;
  void door;
  void furn;
  void makeProject;
  void H;
});
