import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { E, FIXTURES, readPrivatePlan, rawPayloadOf } from './_load.mjs';
import { assertValidProject, assertWellFormedXml } from './_validate.mjs';
import { legacyLoadSvg, legacySafePlan, legacyCleanFloorSettings } from './_legacy.mjs';

const P = E.project;
const clone = (o) => JSON.parse(JSON.stringify(o));

function throwsKey(fn, key, label = '') {
  try {
    fn();
  } catch (e) {
    assert.equal(e.message, key, `${label}: expected ${key}, got ${e.message}`);
    return;
  }
  assert.fail(`${label}: expected a throw of ${key}`);
}

function richProject() {
  const p = P.create({ template: 'demo', lang: 'cs' });
  p.name = 'Můj <byt> & "dům" \'2\'';
  p.plan.rooms[0].name = 'Obývák <&> "x" \'y\'';
  p.plan.furniture[0].name = 'Sedačka 😀 ž';
  p.plan.walls[0].name = 'Zeď & <co>';
  p.measurements = [
    { id: 'm1', x: 0.5, y: 0.7, band: 5, value: -62.5, name: 'Chodba "A"', download: 300, upload: 100, device: 'Telefon', t: 1700000000123 },
    { id: 'm2', x: 0.3, y: 0.3, band: 2.4, value: -70, name: 'Obývák', download: null, upload: null, device: 'Notebook', t: 0 },
  ];
  p.goal.room = 2;
  p.goal.excluded = [6];
  p.node = { mode: 'mesh_cable', pos: { x: 0.3, y: 0.3 }, bands: { '2.4': true, '5': true, '6': false }, power: 2, backhaulBand: 5, backhaulThreshold: -66 };
  p.net.router = { x: 0.4, y: 0.3 };
  p.net.wanDown = 500;
  p.view.palette = 'cb';
  return P.sanitize(p);
}

const projects = () => {
  const list = [
    ['demo cs', P.create({ template: 'demo', lang: 'cs' })],
    ['demo en', P.create({ template: 'demo', lang: 'en' })],
    ['blank', P.create({ template: 'blank', lang: 'cs' })],
    ['rich', richProject()],
    ['old demo', P.sanitize(JSON.parse(readFileSync(path.join(FIXTURES, 'old-demo-payload.json'), 'utf8')))],
  ];
  const real = readPrivatePlan();
  if (real !== null) list.push(['private plan', P.parseSvgText(real).project]);
  return list;
};

test('serialize: JSON with the legacy keys first and the v3 extras', () => {
  const p = richProject();
  const data = JSON.parse(P.serialize(p));
  assert.deepEqual(Object.keys(data), ['format', 'plan', 'width', 'router', 'original', 'optic', 'app', 'v', 'project']);
  assert.equal(data.format, 'wifi-floor-v2');
  assert.equal(data.app, 'wifi-heatmap-architect');
  assert.equal(data.v, 3);
  assert.deepEqual(data.router, p.net.router);
  assert.deepEqual(data.original, p.net.baseline);
  assert.deepEqual(data.optic, p.net.optic);
  assert.ok(data.width >= 6 && data.width <= 25);
  assert.deepEqual(Object.keys(data.project), ['name', 'scale', 'net', 'node', 'model', 'goal', 'measurements', 'view']);
  assert.equal(data.project.plan, undefined, 'the plan is stored once');
  assert.deepEqual(data.plan, p.plan);
  // background can be left out (e.g. for the agent export)
  const withBg = clone(p);
  withBg.plan.background = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(JSON.parse(P.serialize(withBg)).plan.background, withBg.plan.background);
  assert.equal(JSON.parse(P.serialize(withBg, { withBackground: false })).plan.background, null);
  assert.equal(withBg.plan.background, 'data:image/png;base64,iVBORw0KGgo=', 'input untouched');
  // coordinates are written with at most 6 decimals (compact, still lossless for sanitized data)
  assert.ok(!/\.\d{7,}/.test(P.serialize(p)));
  // an invalid outline is refused instead of writing a file that cannot be read back
  const bad = clone(p);
  bad.plan.rooms[0].points = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.1, y: 0.3 }];
  throwsKey(() => P.serialize(bad), 'err.plan.polygon');
  throwsKey(() => P.buildSvg(bad), 'err.plan.polygon');
});

test('buildSvg: well-formed 1080x942 SVG with escaped metadata that round-trips through parseSvgText + sanitize', () => {
  for (const [name, p] of projects()) {
    for (const lang of ['cs', 'en']) {
      const svg = P.buildSvg(p, { lang });
      assertWellFormedXml(svg);
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1080" height="942" viewBox="0 0 1080 942">/, name);
      assert.ok(svg.includes('<metadata id="wifi-plan-data">'), name);
      assert.ok(!svg.includes('</script'), 'never emit </script');
      const r = P.parseSvgText(svg);
      assert.equal(r.hasData, true);
      assertValidProject(r.project, `${name} round trip`);
      assert.deepEqual(r.project, P.sanitize(p), `${name}: buildSvg -> parseSvgText equals sanitize(project)`);
      assert.deepEqual(P.sanitize(r.project), r.project);
    }
  }
});

test('buildSvg: language and markers options, size', () => {
  const p = P.create({ template: 'demo', lang: 'cs' });
  const cs = P.buildSvg(p, { lang: 'cs' });
  const en = P.buildSvg(p, { lang: 'en' });
  assert.match(cs, /<title>Půdorys pro Wi-Fi<\/title>/);
  assert.match(en, /<title>Floor plan for Wi-Fi<\/title>/);
  assert.ok(cs.includes('Obývák s kuchyní'));
  assert.ok(cs.length < 60000, `demo svg is ${cs.length} bytes`);
  // today marker only when it differs from the trial position
  assert.ok(!/stroke-dasharray="5 4"/.test(cs));
  const moved = clone(p);
  moved.net.router = { x: 0.3, y: 0.3 };
  assert.ok(/stroke-dasharray="5 4"/.test(P.buildSvg(P.sanitize(moved))));
  const nomark = P.buildSvg(P.sanitize(moved), { markers: false });
  assert.ok(!/stroke-dasharray="5 4"/.test(nomark));
  assert.equal(P.parseSvgText(nomark).project.net.router.x, P.sanitize(moved).net.router.x);
  // the visual contains the room names as text
  assert.ok(cs.includes('>Ložnice</text>'));
  // withBackground:false drops the image from the metadata
  const bg = clone(p);
  bg.plan.background = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(P.parseSvgText(P.buildSvg(P.sanitize(bg))).project.plan.background, bg.plan.background);
  assert.equal(P.parseSvgText(P.buildSvg(P.sanitize(bg), { withBackground: false })).project.plan.background, null);
});

test('buildSvg escapes hostile text', () => {
  const p = richProject();
  p.plan.rooms[1].name = '</metadata><script>alert(1)</script>';
  p.plan.rooms[2].name = ']]> & &amp; &#x41; "q" \'a\'';
  const svg = P.buildSvg(P.sanitize(p));
  assertWellFormedXml(svg);
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('</metadata><script'));
  const back = P.parseSvgText(svg).project;
  assert.equal(back.plan.rooms[1].name, '</metadata><script>alert(1)</script>');
  assert.equal(back.plan.rooms[2].name, ']]> & &amp; &#x41; "q" \'a\'');
});

test('old app compatibility: files written by the new engine pass the OLD loader (safePlan + cleanFloorSettings)', () => {
  for (const [name, p] of projects()) {
    const svg = P.buildSvg(p);
    const { plan, settings, data } = legacyLoadSvg(svg);
    // top-level keys the old app reads are present and valid
    assert.equal(data.format, 'wifi-floor-v2', name);
    for (const k of ['plan', 'width', 'router', 'original', 'optic']) assert.ok(k in data, `${name}: ${k}`);
    assert.ok(Number.isFinite(settings.width) && settings.width >= 6 && settings.width <= 25, `${name}: width ${settings.width}`);
    assert.deepEqual(settings.router, p.net.router, name);
    assert.deepEqual(settings.original, p.net.baseline, name);
    assert.deepEqual(settings.optic, p.net.optic, name);
    // the old loader keeps every object
    assert.equal(plan.rooms.length, p.plan.rooms.length, name);
    assert.equal(plan.walls.length, p.plan.walls.length, name);
    assert.equal(plan.doors.length, p.plan.doors.length, name);
    assert.equal(plan.furniture.length, p.plan.furniture.length, name);
    assert.equal(plan.background, p.plan.background, name);
    plan.rooms.forEach((r, i) => {
      assert.deepEqual(r.points, p.plan.rooms[i].points, name);
      assert.equal(r.roomId, p.plan.rooms[i].roomId, name);
      assert.equal(r.color, p.plan.rooms[i].color, name);
      assert.equal(r.name, E.util.cleanText(p.plan.rooms[i].name, 50), name);
    });
    plan.walls.forEach((w, i) => {
      assert.equal(w.loss, p.plan.walls[i].loss, name);
      assert.equal(w.material, p.plan.walls[i].material, name);
    });
    plan.doors.forEach((d, i) => assert.equal(d.wallId, p.plan.doors[i].wallId, name));
    plan.furniture.forEach((f, i) => {
      assert.equal(f.loss, p.plan.furniture[i].loss, name);
      assert.equal(f.kind, p.plan.furniture[i].kind, name);
      assert.equal(f.blocksSignal, p.plan.furniture[i].blocksSignal, name);
    });
    // the width the old app derives from the file reproduces the new scale
    if (p.plan.rooms.length) {
      const w = settings.width;
      const bb = P.planBounds(p.plan);
      const mpp = w / ((bb.maxX - bb.minX) * 1080);
      const real = p.scale.mpp;
      const widthM = P.widthFromMpp(p.plan, real);
      if (widthM >= 6 && widthM <= 25) assert.ok(Math.abs(mpp / real - 1) < 1e-3, `${name}: old app scale ${mpp} vs ${real}`);
    }
  }
});

test('old app compatibility: the legacy validators themselves (sanity of the ports)', () => {
  assert.throws(() => legacySafePlan({ rooms: [], walls: [], doors: [] }));
  assert.throws(() => legacySafePlan({ rooms: [{ id: 'a', roomId: 1, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }] }], walls: [], doors: [], furniture: [] }));
  assert.deepEqual(legacyCleanFloorSettings({ width: 30, router: { x: 2, y: 0 }, optic: { x: 0.1, y: 0.2 } }), { optic: { x: 0.1, y: 0.2 } });
});

test('old app compatibility: an optional private real plan (WH_PRIVATE_PLAN) loads in the old loader AND the new one with the same geometry', () => {
  const svg = readPrivatePlan();
  if (svg === null) return;
  const old = legacyLoadSvg(svg);
  const neo = P.parseSvgText(svg).project;
  assert.equal(old.plan.rooms.length, neo.plan.rooms.length);
  old.plan.rooms.forEach((r, i) => assert.deepEqual(r.points, neo.plan.rooms[i].points));
  old.plan.walls.forEach((w, i) => {
    assert.deepEqual(w.a, neo.plan.walls[i].a);
    assert.deepEqual(w.b, neo.plan.walls[i].b);
  });
  const raw = rawPayloadOf(svg);
  if (raw && Number.isFinite(raw.width) && raw.width >= 6 && raw.width <= 25) assert.equal(old.settings.width, raw.width);
  assert.deepEqual(old.settings.original, neo.net.baseline);
});

// ---------------------------------------------------------------------------------------------------------------
// parseSvgText
// ---------------------------------------------------------------------------------------------------------------

const wrap = (inner, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"${extra}>${inner}</svg>`;

test('parseSvgText: plain SVG without our data is just an image', () => {
  const r = P.parseSvgText(wrap('<rect width="10" height="10"/>'));
  assert.deepEqual(r, { project: null, hasData: false, svgBackground: null, warnings: [] });
  const r2 = P.parseSvgText('<?xml version="1.0"?>\n' + wrap('<metadata id="something-else">{}</metadata>'));
  assert.equal(r2.hasData, false);
});

test('parseSvgText: entity decoding, CDATA, attribute variants', () => {
  const p = P.create({ template: 'blank', lang: 'cs' });
  p.name = 'a & b';
  const json = P.serialize(p);
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const meta of [
    `<metadata id="wifi-plan-data">${esc}</metadata>`,
    `<metadata  id='wifi-plan-data' >${esc}</metadata >`,
    `<metadata data-x="1" id="wifi-plan-data">${esc}</metadata>`,
    `<metadata id="wifi-plan-data"><![CDATA[${json}]]></metadata>`,
    `<metadata id="wifi-plan-data">\n  ${esc}\n</metadata>`,
    `<metadata id="wifi-plan-data">${json.replace(/"/g, '&#34;').replace(/a & b/, 'a &#38; b').replace(/&(?!#)/g, '&#x26;')}</metadata>`,
  ]) {
    const r = P.parseSvgText(wrap(meta));
    assert.equal(r.hasData, true, meta.slice(0, 50));
    assert.equal(r.project.name, 'a & b', meta.slice(0, 50));
  }
});

test('parseSvgText: errors', () => {
  const good = P.buildSvg(P.create({ template: 'blank' }));
  throwsKey(() => P.parseSvgText(null), 'err.svg.invalid');
  throwsKey(() => P.parseSvgText(''), 'err.svg.invalid');
  throwsKey(() => P.parseSvgText('<html><body>hello</body></html>'), 'err.svg.invalid');
  throwsKey(() => P.parseSvgText('<!DOCTYPE svg [<!ENTITY x "y">]>' + good), 'err.svg.dtd');
  throwsKey(() => P.parseSvgText('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://x/y.dtd">' + good), 'err.svg.dtd');
  throwsKey(() => P.parseSvgText(wrap('<metadata id="wifi-plan-data">{not json</metadata>')), 'err.svg.badData');
  throwsKey(() => P.parseSvgText(wrap('<metadata id="wifi-plan-data">[1,2]</metadata>')), 'err.svg.badData');
  throwsKey(() => P.parseSvgText(wrap('<metadata id="wifi-plan-data">{&quot;format&quot;:&quot;nope&quot;}</metadata>')), 'err.plan.format');
  throwsKey(() => P.parseSvgText(wrap('<metadata id="wifi-plan-data">{&quot;format&quot;:&quot;wifi-floor-v2&quot;}</metadata>')), 'err.plan.invalid');
  throwsKey(() => P.parseSvgText(good + ' '.repeat(8000001)), 'err.svg.tooBig');
  // a 7.9 MB file is fine for the size check
  assert.doesNotThrow(() => P.parseSvgText(good + '<!--' + 'x'.repeat(7.9e6) + '-->'));
});

test('parseSvgText: legacy SVG background is reported for rasterization', () => {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'old-demo-payload.json'), 'utf8'));
  const svgBg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  raw.plan.background = svgBg;
  const text = JSON.stringify(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const r = P.parseSvgText(wrap(`<metadata id="wifi-plan-data">${text}</metadata>`));
  assert.equal(r.project.plan.background, null);
  assert.equal(r.svgBackground, svgBg);
});

test('clone: deep copy, background shared by reference', () => {
  const p = P.create({ template: 'demo' });
  p.plan.background = 'data:image/png;base64,' + 'A'.repeat(1000);
  const c = P.clone(p);
  assert.deepEqual(c, p);
  assert.notEqual(c.plan.rooms, p.plan.rooms);
  assert.notEqual(c.net, p.net);
  assert.equal(c.plan.background, p.plan.background);
  c.plan.rooms[0].name = 'changed';
  assert.notEqual(p.plan.rooms[0].name, 'changed');
});
