// Robustness of the file formats: hostile / huge input in linear time, files that always load again, no NaN or
// "undefined" in anything we write, 250-object plans end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, readPrivatePlan } from './_load.mjs';
import { assertValidProject, assertWellFormedXml } from './_validate.mjs';
import { legacyLoadSvg } from './_legacy.mjs';

const P = E.project;
const { W, H } = E.CANVAS;
const nn = (x, y) => ({ x: x / W, y: y / H });
const clone = (o) => JSON.parse(JSON.stringify(o));
const BAD_TEXT = /NaN|undefined|Infinity|\[object Object\]/;

/** Every file we write: no NaN / undefined / Infinity anywhere (attributes, text, metadata). */
function assertCleanSvg(svg, label) {
  assertWellFormedXml(svg);
  const text = svg.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, 'data:…'); // base64 may spell "NaN" by chance
  const m = BAD_TEXT.exec(text);
  assert.equal(m, null, `${label}: "${m && text.slice(Math.max(0, m.index - 60), m.index + 20)}"`);
}

/** A plan with 250 rooms, 250 walls, 250 doors, 250 furniture (pts-gons) and 500 measurements. */
function bigPlan(pts = 8) {
  const rooms = [];
  const walls = [];
  const doors = [];
  const furniture = [];
  const cw = 40;
  const ch = 86;
  let id = 1;
  for (let j = 0; j < 10; j++) {
    for (let i = 0; i < 25; i++) {
      const x0 = 40 + i * cw;
      const y0 = 40 + j * ch;
      rooms.push({ id: `room-${id}`, type: 'room', roomId: id, name: `Místnost ${id}`, points: [nn(x0, y0), nn(x0 + cw, y0), nn(x0 + cw, y0 + ch), nn(x0, y0 + ch)], color: '#8eadd2' });
      id++;
    }
  }
  for (let i = 0; i <= 25 && walls.length < 250; i++) {
    for (let j = 0; j < 10 && walls.length < 250; j++) {
      const x = 40 + i * cw;
      walls.push({ id: `wall-${walls.length + 1}`, type: 'wall', name: 'Zeď', a: nn(x, 40 + j * ch), b: nn(x, 40 + (j + 1) * ch), material: ['brick', 'drywall', 'custom', 'concrete'][j % 4], loss: [11, 4, 6.5, 18][j % 4] });
    }
  }
  walls.forEach((w, k) => {
    const x = w.a.x * W;
    const ay = w.a.y * H;
    doors.push({ id: `door-${k + 1}`, type: 'door', name: 'Dveře', a: nn(x, ay + 20), b: nn(x, ay + 50), wallId: w.id, loss: k % 2 ? 3 : 0 });
  });
  rooms.forEach((r, k) => {
    const cx = ((r.points[0].x + r.points[1].x) / 2) * W;
    const cy = ((r.points[0].y + r.points[2].y) / 2) * H;
    const ring = [];
    for (let q = 0; q < pts; q++) ring.push(nn(cx + 12 * Math.cos((q / pts) * 2 * Math.PI), cy + 20 * Math.sin((q / pts) * 2 * Math.PI)));
    furniture.push({ id: `furniture-${k + 1}`, type: 'furniture', name: 'Kus', points: ring, loss: 5, kind: k % 2 ? 'books' : 'custom', blocksSignal: k % 5 !== 0 });
  });
  const measurements = [];
  for (let k = 0; k < 500; k++) {
    const r = rooms[k % 250];
    measurements.push({ id: `m${k}`, x: r.points[0].x + 5 / W, y: r.points[0].y + 5 / H, band: [2.4, 5, 6][k % 3], value: k % 7 ? -60 - (k % 30) : null, name: `m${k}`, download: 100 + k, upload: 20 + k, device: 'Telefon', t: k });
  }
  return { v: 3, name: 'big', plan: { rooms, walls, doors, furniture, background: null }, scale: { mpp: 0.012 }, net: { router: nn(500, 450), baseline: nn(500, 450) }, measurements };
}

// ---------------------------------------------------------------------------------------------------------------
// hostile input: always linear time
// ---------------------------------------------------------------------------------------------------------------

test('parseSvgText: hostile 8 MB inputs are handled in linear time (no regex backtracking blow-up)', () => {
  const good = P.buildSvg(P.create({ template: 'demo', lang: 'cs' }));
  const meta = /<metadata id="wifi-plan-data">[\s\S]*?<\/metadata>/.exec(good)[0];
  const N = 7.9e6;
  const cases = {
    // before: 800 kB of this took 33 s (quadratic and worse), 8 MB would have frozen the tab
    'many <metadata without >': '<svg>' + '<metadata '.repeat(N / 10),
    'many opening tags, no closing tag': '<svg>' + '<metadata id="wifi-plan-data">'.repeat(N / 30),
    'id attributes without >': '<svg><metadata ' + ' id="wifi-plan-data"'.repeat(N / 20),
    'endless attribute': '<svg><metadata ' + 'x'.repeat(N) + ' id="wifi-plan-data">{}</metadata>',
    'closing tags without >': '<svg><metadata id="wifi-plan-data">{}' + '</metadata      '.repeat(N / 16),
    'only <': '<svg>' + '<'.repeat(N),
    'entity soup': '<svg><metadata id="wifi-plan-data">' + '&#x'.repeat(N / 3) + '</metadata>',
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now();
    try {
      P.parseSvgText(text);
    } catch (e) {
      assert.ok(/^err\./.test(e.message), `${name}: ${e.message}`);
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)} ms`);
  }
  // decoys before the real block: the first metadata with our id still wins
  const decoyed = '<svg xmlns="http://www.w3.org/2000/svg">' + '<metadata id="x">a</metadata>'.repeat(100000) + meta + '</svg>';
  const t0 = performance.now();
  const r = P.parseSvgText(decoyed);
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(r.project.plan.rooms.length, 6);
  // an id that only ends with our name is not ours (word boundary of the old regex: data-id="wifi-plan-data")
  assert.equal(P.parseSvgText(`<svg><metadata data-id="wifi-plan-data">${'{}'}</metadata></svg>`).hasData, false);
});

test('sanitize: absurd JSON (deep nesting, huge arrays, prototype keys, wrong types) is refused or repaired quickly', () => {
  const deep = '['.repeat(100000) + ']'.repeat(100000);
  for (const s of [deep, '{"plan":' + deep + '}']) {
    try {
      P.sanitize(s);
    } catch (e) {
      assert.ok(/^err\./.test(e.message), e.message);
    }
  }
  const huge = { format: 'wifi-floor-v2', plan: { rooms: new Array(100000).fill(0).map((_, i) => ({ id: `r${i}` })), walls: [], doors: [], furniture: [] } };
  assert.throws(() => P.sanitize(huge), /err\.plan\.tooMany/);
  const t0 = performance.now();
  const lenient = P.sanitize(huge, { strict: false });
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(lenient.plan.rooms.length, 0);
  const proto = JSON.parse('{"plan":{"rooms":[],"walls":[{"id":"w","a":{"x":0.1,"y":0.1},"b":{"x":0.2,"y":0.2},"material":"__proto__","loss":5}],"doors":[],"furniture":[{"id":"f","points":[{"x":0.1,"y":0.1},{"x":0.3,"y":0.1},{"x":0.3,"y":0.3}],"kind":"__proto__","loss":"7"}]},"__proto__":{"polluted":1},"project":{"model":{"bandPower":{"__proto__":{"x":1},"2.4":"3"}}}}');
  const s = P.sanitize(proto);
  assert.equal(s.plan.walls[0].material, 'custom');
  assert.equal(s.plan.furniture[0].kind, 'custom');
  assert.equal(s.plan.furniture[0].loss, 7, 'numeric string accepted as before');
  assert.deepEqual(s.model.bandPower, { '2.4': 0, '5': 0, '6': 0 });
  assert.equal({}.polluted, undefined);
  assertValidProject(s);
});

// ---------------------------------------------------------------------------------------------------------------
// what we write always loads again
// ---------------------------------------------------------------------------------------------------------------

test('serialize / buildSvg of a half-edited live project still write a file that loads (and has no NaN/undefined)', () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const live = clone(p);
  live.plan.walls.push({ id: 'broken', type: 'wall', name: 'x', a: { x: NaN, y: 0.2 }, b: { x: 0.5, y: 0.5 } }); // NaN coordinate
  live.plan.doors.push({ id: 'orphan', type: 'door', name: 'd', a: { x: 0.1, y: 0.1 }, b: { x: 0.12, y: 0.1 }, wallId: 'gone', loss: 3 });
  live.plan.walls.push({ ...live.plan.walls[0] }); // duplicate id
  delete live.plan.rooms[0].color;
  live.plan.rooms[1].name = undefined;
  live.measurements.push({ id: 'm', x: 0.5, y: 0.5, band: 5, value: undefined, download: 5, upload: undefined });
  live.model.bandPower = { '2.4': NaN };
  const svg = P.buildSvg(live, { lang: 'cs' });
  assertCleanSvg(svg, 'live');
  const back = P.parseSvgText(svg).project;
  assertValidProject(back, 'reloaded');
  assert.equal(back.plan.walls.length, p.plan.walls.length + 1, 'NaN wall dropped, duplicate renamed');
  assert.equal(back.plan.doors.length, p.plan.doors.length, 'orphan door dropped');
  assert.equal(back.measurements.length, 0, 'unusable measurement dropped');
  assert.deepEqual(JSON.parse(P.serialize(live)), JSON.parse(P.serialize(back)), 'serialize writes the same repaired project');
  // the old app reads it as well
  const old = legacyLoadSvg(svg);
  assert.equal(old.plan.walls.length, back.plan.walls.length);
  // an invalid outline is still refused (the user must fix it; dropping a room silently would be worse)
  const bad = clone(p);
  bad.plan.furniture[0].points = [bad.plan.furniture[0].points[0]];
  assert.throws(() => P.buildSvg(bad), /err\.plan\.polygon/);
  assert.throws(() => P.serialize({ plan: null }), /err\.plan\.invalid/);
});

test('round trip of every slice incl. bandPower, speed-only measurements, custom / preset / legacy obstacles', () => {
  const p = P.create({ template: 'demo', lang: 'en' });
  p.model.bandPower = { '2.4': -3, '5': 0.5, '6': 6 };
  p.plan.walls[0] = { ...p.plan.walls[0], material: 'custom', loss: 9.5 };
  p.plan.walls[1] = { ...p.plan.walls[1], material: 'brick', loss: 8 }; // legacy number -> 11 on load
  delete p.plan.walls[2].material;
  delete p.plan.walls[2].loss;
  p.plan.furniture[0] = { ...p.plan.furniture[0], kind: 'metal', loss: 12, blocksSignal: false };
  p.measurements = [
    { id: 'a', x: 0.5, y: 0.7, band: 5, value: -62.5, name: 'Hall "A" & <b>', download: 300, upload: 100, device: 'Phone', t: 1700000000123 },
    { id: 'b', x: 0.3, y: 0.3, band: 2.4, value: null, name: 'Speed only', download: 41.2, upload: 9.8, device: 'Raspberry Pi', t: 5, ping: 12.5, jitter: 1.25, source: 'cloudflare' },
    { id: 'c', x: 0.6, y: 0.4, band: 6, value: -71, name: 'Signal only', download: null, upload: null, device: 'Laptop', t: 6 },
  ];
  const s = P.sanitize(p);
  assert.equal(s.plan.walls[1].loss, 11);
  assert.equal(s.measurements[1].value, null);
  for (const lang of ['cs', 'en']) {
    const svg = P.buildSvg(s, { lang });
    assertCleanSvg(svg, lang);
    const back = P.parseSvgText(svg).project;
    assert.deepEqual(back, s);
    assert.deepEqual(P.sanitize(JSON.parse(P.serialize(back))), s, 'serialize -> sanitize');
    assert.deepEqual(P.sanitize(JSON.stringify(back), { strict: false }), s, 'localStorage path (JSON string, lenient)');
  }
  // the model reads the round-tripped project exactly like the original
  const c1 = E.model.createContext(s);
  const c2 = E.model.createContext(P.parseSvgText(P.buildSvg(s)).project);
  assert.equal(c1.version, c2.version);
});

test('fuzz: random projects survive sanitize -> buildSvg -> parseSvgText unchanged, the model reads them identically', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const mats = [...Object.keys(E.model.MATERIALS), 'custom', 'nonsense', undefined];
  const kinds = [...Object.keys(E.model.FURNITURE_KINDS), 'sofa', undefined];
  for (let k = 0; k < 120; k++) {
    const rooms = [];
    const walls = [];
    const doors = [];
    const furniture = [];
    const nr = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < nr; i++) {
      const x0 = 50 + i * 160;
      const y0 = 60 + rnd() * 200;
      rooms.push({ id: `r${i}`, roomId: i + 1, name: rnd() < 0.2 ? '' : `R <${i}> & "x"`, points: [nn(x0, y0), nn(x0 + 150, y0), nn(x0 + 150, y0 + 300 + rnd() * 200), nn(x0, y0 + 300)], color: rnd() < 0.5 ? '#123abc' : 'red' });
      const m = pick(mats);
      const legacy = m && E.model.LEGACY_MATERIALS[m];
      walls.push({ id: `w${i}`, a: nn(x0, y0), b: nn(x0, y0 + 300), ...(m !== undefined ? { material: m } : {}), ...(rnd() < 0.7 ? { loss: rnd() < 0.3 && legacy ? legacy : Math.round(rnd() * 300) / 10 } : {}) });
      if (rnd() < 0.5) doors.push({ id: `d${i}`, wallId: `w${i}`, a: nn(x0, y0 + 100), b: nn(x0, y0 + 180), loss: pick([0, 3, 7.5, '2', null]) });
      if (rnd() < 0.7) furniture.push({ id: `f${i}`, points: [nn(x0 + 20, y0 + 20), nn(x0 + 60, y0 + 20), nn(x0 + 60, y0 + 60), nn(x0 + 20, y0 + 60)], kind: pick(kinds), loss: rnd() < 0.8 ? Math.round(rnd() * 150) / 10 : undefined, blocksSignal: rnd() < 0.8 });
    }
    const raw = {
      plan: { rooms, walls, doors, furniture },
      scale: { mpp: 0.005 + rnd() * 0.02 },
      model: { nearSignal: -40 - rnd() * 10, n: 2 + rnd(), wallLoss: rnd() * 25, bandPower: { '2.4': rnd() * 20 - 12, '5': rnd() < 0.5 ? 0 : 'x', '6': rnd() * 8 } },
      measurements: Array.from({ length: Math.floor(rnd() * 6) }, (_, j) => ({ id: `m${j}`, x: rooms[0].points[0].x + 0.01, y: rooms[0].points[0].y + 0.01, band: pick([2.4, 5, 6, '2,4', 7]), value: pick([-60, null, -120, 'x']), download: pick([null, 50, 20000]), upload: pick([null, 10]), device: pick(['Telefon', '', 'Raspberry Pi']) })),
    };
    const p = P.sanitize(raw, { strict: false });
    assertValidProject(p, `fuzz ${k}`);
    const svg = P.buildSvg(p, { lang: k % 2 ? 'en' : 'cs' });
    assertCleanSvg(svg, `fuzz ${k}`);
    const back = P.parseSvgText(svg).project;
    assert.deepEqual(back, p, `fuzz ${k}`);
    const c1 = E.model.createContext(p);
    const c2 = E.model.createContext(back);
    assert.equal(c1.version, c2.version, `fuzz ${k}`);
    for (const band of [2.4, 5, 6]) {
      const a = nn(30, 30);
      const b = nn(1000, 900);
      assert.equal(E.model.rawSignal(c1, a, b, band), E.model.rawSignal(c2, a, b, band));
      for (const o of [...p.plan.walls, ...p.plan.doors, ...p.plan.furniture]) {
        const l = E.model.obstacleLossFor(o, band, p);
        assert.ok(Number.isFinite(l) && l >= 0 && l <= 34.5, `fuzz ${k}: ${o.id} ${l}`);
      }
    }
  }
});

test('many-sided furniture: the tracer simplifies it to a quarter pixel and culls it by its box', () => {
  const ring = (n, cx, cy, r) => Array.from({ length: n }, (_, q) => nn(cx + r * Math.cos((q / n) * 2 * Math.PI), cy + r * Math.sin((q / n) * 2 * Math.PI)));
  const mk = (n) => P.sanitize({ plan: { rooms: [{ id: 'r', roomId: 1, points: [nn(0, 0), nn(1000, 0), nn(1000, 900), nn(0, 900)] }], walls: [], doors: [], furniture: [{ id: 'f', points: ring(n, 500, 450, 40), kind: 'custom', loss: 6 }] }, scale: { mpp: 0.01 } });
  const fine = E.model.createContext(mk(200));
  assert.ok(fine.f.cnt[0] >= 8 && fine.f.cnt[0] <= 40, `200-gon traced with ${fine.f.cnt[0]} edges`);
  const exact = E.model.createContext(mk(12)); // <= 16 vertices: traced exactly as drawn
  assert.equal(exact.f.cnt[0], 12);
  // through the middle: the full loss at every band; well outside: nothing; across the rim: within a hair of the exact disc
  for (const band of [2.4, 5, 6]) {
    const full = E.model.obstacleLossFor({ type: 'furniture', kind: 'custom', loss: 6 }, band);
    assert.equal(E.model.obstacleLoss(fine, nn(300, 450), nn(700, 450), band), full);
    assert.equal(E.model.obstacleLoss(fine, nn(300, 300), nn(700, 300), band), 0);
  }
  // across the rim: the simplified outline lies inside the disc by at most a quarter pixel, so a chord at depth d below
  // the top is between the disc's chords at depth d - 0.25 and d (15 px of chord = the full loss at 1 cm per px)
  const lossAtDepth = (d) => (d <= 0 ? 0 : 6 * Math.min(1, (2 * Math.sqrt(Math.max(0, 2 * 40 * d - d * d))) / 15));
  for (let y = 405; y <= 416; y += 0.25) {
    const d = y - 410;
    const got = E.model.obstacleLoss(fine, nn(300, y), nn(700, y));
    assert.ok(got >= lossAtDepth(d - 0.26) - 1e-6 && got <= lossAtDepth(d) + 0.02, `y ${y}: ${got} not in [${lossAtDepth(d - 0.26)}, ${lossAtDepth(d)}]`);
  }
  // a ray whose bounding box overlaps the piece's box but passes beside the disc is culled and gets 0
  assert.equal(E.model.obstacleLoss(fine, nn(455, 400), nn(400, 455)), 0);
});

test('every built-in project (and an optional private real plan) exports without NaN / undefined, in both languages', () => {
  const list = [P.create({ template: 'demo', lang: 'cs' }), P.create({ template: 'demo', lang: 'en' }), P.create({ template: 'blank' })];
  const real = readPrivatePlan();
  if (real !== null) list.push(P.parseSvgText(real).project);
  for (const p of list) for (const lang of ['cs', 'en']) assertCleanSvg(P.buildSvg(p, { lang }), `${p.name} ${lang}`);
});

// ---------------------------------------------------------------------------------------------------------------
// 250 of everything
// ---------------------------------------------------------------------------------------------------------------

test('250-object plan: sanitize, SVG round trip, old loader, model, raster, calibration, speed, optimizer', async () => {
  const raw = bigPlan(8);
  const t = {};
  const time = (k, fn) => {
    const t0 = performance.now();
    const r = fn();
    t[k] = Math.round(performance.now() - t0);
    return r;
  };
  const p = time('sanitize', () => P.sanitize(raw));
  assertValidProject(p, 'big');
  assert.deepEqual([p.plan.rooms.length, p.plan.walls.length, p.plan.doors.length, p.plan.furniture.length, p.measurements.length], [250, 250, 250, 250, 500]);
  const svg = time('buildSvg', () => P.buildSvg(p));
  assertCleanSvg(svg, 'big');
  const back = time('parse', () => P.parseSvgText(svg).project);
  assert.deepEqual(back, p);
  assert.equal(legacyLoadSvg(svg).plan.rooms.length, 250, 'the old app opens it');
  const ctx = time('ctx', () => E.model.createContext(p));
  const g8 = E.raster.grid(ctx, { cell: 8 });
  for (const band of [2.4, 5, 6]) {
    const f = time(`field${band}`, () => E.raster.field(ctx, g8, E.model.fieldParams(p, 'trial', { band })));
    for (const i of g8.idx) assert.ok(Number.isFinite(f[i]) && f[i] >= -110 && f[i] <= -20);
  }
  const offsets = time('offsets', () => E.model.offsets(ctx, p));
  for (const k of ['2.4', '5', '6']) assert.ok(Number.isFinite(offsets[k]));
  const filled = time('fill', () => E.speed.fillSignals(ctx, p.measurements, { baseline: p.net.baseline, offsets }));
  assert.ok(filled.every((m) => Number.isFinite(m.value)));
  const a = time('analysis', () => E.analysis.run(p, { cell: 8, ctx, offsets }));
  assert.equal(a.perRoom.trial.size, 250);
  const r = await E.optimize.find(ctx, g8, { band: 5, goalRoom: null, allowedRoom: null, threshold: -67, router: p.net.router, offsets, node: null });
  assert.ok(E.project.floorMaskAt(p.plan, r.pos));
  console.log(`  [250 objects] ${Object.entries(t).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);
});
