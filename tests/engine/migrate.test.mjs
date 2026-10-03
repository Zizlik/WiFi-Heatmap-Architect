import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { E, FIXTURES } from './_load.mjs';
import { assertValidProject } from './_validate.mjs';

const P = E.project;
const oldDemo = () => JSON.parse(readFileSync(path.join(FIXTURES, 'old-demo-payload.json'), 'utf8'));
const store = (obj) => (key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null);

function fullStore() {
  const plan = oldDemo().plan;
  return {
    'wifi-floor-v5': JSON.stringify({ ed: plan, appliedPlan: plan }),
    'wifi-floor-network-v1': JSON.stringify({ width: 9, router: { x: 0.3, y: 0.3 }, original: { x: 0.48, y: 0.63 }, optic: { x: 0.1, y: 0.62 } }),
    'wifi-speed-v1': JSON.stringify({
      original: { x: 0.48, y: 0.63 },
      points: [
        { x: 0.3, y: 0.3, value: -55, name: 'Obývák', band: 5, download: 200, upload: 50, device: 'Telefon', speedScenario: 'none' },
        { x: 0.6, y: 0.4, value: -70, name: 'Kuchyň', band: 2.4, download: null, upload: null, device: '' },
        { x: 5, y: 0.4, value: -70, name: 'mimo', band: 5 },
      ],
      settings: { speedDevice: 'Notebook', targetDown: 80, targetUp: 20, speedReserve: 25, wanDown: 500, wanUp: 100, wanPort: 1000, ontPort: null, wanLink: null, cableCategory: 'cat6', cableLength: 10 },
    }),
    'wifi-flow-v1': JSON.stringify({ speed: true, goal: 2, band: 2.4, step: 4 }),
  };
}

test('migrateLegacyStorage: all four old keys become one project', () => {
  const p = P.migrateLegacyStorage(store(fullStore()), { lang: 'cs' });
  assert.ok(p);
  assertValidProject(p, 'migrated');
  assert.equal(p.plan.rooms.length, 4);
  assert.equal(p.plan.walls.length, 10);
  assert.deepEqual(p.net.router, { x: 0.3, y: 0.3 });
  assert.deepEqual(p.net.baseline, { x: 0.48, y: 0.63 });
  assert.deepEqual(p.net.optic, { x: 0.1, y: 0.62 });
  assert.ok(Math.abs(P.widthFromMpp(p.plan, p.scale.mpp) - 9) < 1e-6);
  assert.equal(p.goal.device, 'Notebook');
  assert.equal(p.goal.targetDown, 80);
  assert.equal(p.goal.targetUp, 20);
  assert.equal(p.goal.reserve, 25);
  assert.equal(p.goal.mode, 'speed');
  assert.equal(p.goal.room, 2);
  assert.equal(p.view.band, 2.4);
  assert.deepEqual({ d: p.net.wanDown, u: p.net.wanUp, wp: p.net.wanPort, op: p.net.ontPort, c: p.net.cableCategory, l: p.net.cableLength }, { d: 500, u: 100, wp: 1000, op: null, c: 'cat6', l: 10 });
  // measurements belong to the baseline they were taken at: kept here, outside points dropped, device defaulted
  assert.equal(p.measurements.length, 2);
  assert.equal(p.measurements[0].download, 200);
  assert.equal(p.measurements[0].device, 'Telefon');
  assert.equal(p.measurements[1].device, 'Notebook');
  assert.equal(p.measurements[1].download, null);
  assert.ok(p.measurements.every((m) => typeof m.id === 'string' && m.id));
});

test('migrateLegacyStorage: speed measurements of another baseline are dropped', () => {
  const s = fullStore();
  const sp = JSON.parse(s['wifi-speed-v1']);
  sp.original = { x: 0.2, y: 0.2 };
  s['wifi-speed-v1'] = JSON.stringify(sp);
  const p = P.migrateLegacyStorage(store(s));
  assert.equal(p.measurements.length, 0);
  assert.equal(p.goal.device, 'Notebook', 'settings still migrate');
});

test('migrateLegacyStorage: measurements follow the original the OLD app stored, even when it is snapped here', () => {
  // an original the new floor test puts just off the floor (old and new outline rules may disagree on edges): the
  // baseline gets snapped a few px, but the points were taken at the stored original -> they are kept
  const s = fullStore();
  const raw = { x: 0.079, y: 0.63 };
  s['wifi-floor-network-v1'] = JSON.stringify({ ...JSON.parse(s['wifi-floor-network-v1']), original: raw });
  s['wifi-speed-v1'] = JSON.stringify({ ...JSON.parse(s['wifi-speed-v1']), original: raw });
  const p = P.migrateLegacyStorage(store(s));
  assertValidProject(p, 'snapped original');
  assert.notDeepEqual(p.net.baseline, raw, 'the baseline was snapped onto the floor');
  assert.equal(p.measurements.length, 2);
  // a 6-decimal rounding of the stored original still matches; a real move does not
  s['wifi-speed-v1'] = JSON.stringify({ ...JSON.parse(s['wifi-speed-v1']), original: { x: raw.x + 4e-7, y: raw.y } });
  assert.equal(P.migrateLegacyStorage(store(s)).measurements.length, 2);
  s['wifi-speed-v1'] = JSON.stringify({ ...JSON.parse(s['wifi-speed-v1']), original: { x: raw.x + 0.01, y: raw.y } });
  assert.equal(P.migrateLegacyStorage(store(s)).measurements.length, 0);
});

test('migrateLegacyStorage: old preset walls become the new tables, the rest of the plan is untouched', () => {
  const plan = oldDemo().plan;
  const p = P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ ed: plan, appliedPlan: plan }) }));
  plan.walls.forEach((w, i) => {
    const got = p.plan.walls[i];
    if (w.material && w.material !== 'custom' && w.loss === P.LEGACY_WALL_MATERIALS[w.material]) assert.equal(got.loss, P.WALL_MATERIALS[w.material], w.id);
    else assert.equal(got.loss, w.loss, w.id);
    assert.equal(got.material, w.material, w.id);
  });
});

test('migrateLegacyStorage: only the plan key is enough; the draft is the fallback', () => {
  const plan = oldDemo().plan;
  const only = P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ ed: plan }) }));
  assertValidProject(only, 'only plan');
  assert.equal(only.plan.rooms.length, 4);
  assert.equal(only.measurements.length, 0);
  // appliedPlan is broken: the draft `ed` is used instead
  const broken = P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ ed: plan, appliedPlan: { rooms: 'x' } }) }));
  assert.ok(broken && broken.plan.rooms.length === 4);
  // imported settings inside the draft are honoured
  const imp = P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ ed: { ...plan, importedSettings: { width: 8, optic: { x: 0.2, y: 0.2 } } } }) }));
  assert.deepEqual(imp.net.optic, { x: 0.2, y: 0.2 });
  // lenient: a damaged object does not sink the whole plan
  const dmg = JSON.parse(JSON.stringify(plan));
  dmg.doors.push({ id: 'x', type: 'door', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, wallId: 'missing' });
  dmg.rooms.push({ id: 'room-x', roomId: 9, name: 'bad', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });
  const lenient = P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ appliedPlan: dmg }) }));
  assertValidProject(lenient, 'lenient');
  assert.equal(lenient.plan.rooms.length, 4);
  assert.equal(lenient.plan.doors.length, 4);
});

test('migrateLegacyStorage: nothing to migrate -> null, never throws', () => {
  assert.equal(P.migrateLegacyStorage(store({})), null);
  assert.equal(P.migrateLegacyStorage(() => null), null);
  assert.equal(P.migrateLegacyStorage(() => undefined), null);
  assert.equal(P.migrateLegacyStorage(() => '{'), null);
  assert.equal(P.migrateLegacyStorage(() => 'null'), null);
  assert.equal(P.migrateLegacyStorage(() => '[]'), null);
  assert.equal(P.migrateLegacyStorage(() => 123), null);
  assert.equal(P.migrateLegacyStorage(() => {
    throw new Error('SecurityError: storage disabled');
  }), null);
  assert.equal(P.migrateLegacyStorage(), null);
  // a plan without rooms and without background is not worth migrating
  const empty = { rooms: [], walls: [], doors: [], furniture: [], background: null };
  assert.equal(P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ ed: empty, appliedPlan: empty }) })), null);
  // ... but a tracing image alone is
  const bg = { ...empty, background: 'data:image/png;base64,iVBORw0KGgo=' };
  const traced = P.migrateLegacyStorage(store({ 'wifi-floor-v5': JSON.stringify({ ed: bg }) }));
  assert.equal(traced.plan.background, bg.background);
  // garbage in the optional keys is ignored
  const s = fullStore();
  s['wifi-speed-v1'] = '{"settings": 5, "points": "x", "original": null}';
  s['wifi-flow-v1'] = 'oops';
  s['wifi-floor-network-v1'] = '[1,2,3]';
  const p = P.migrateLegacyStorage(store(s));
  assertValidProject(p, 'garbage in optional keys');
  assert.equal(p.measurements.length, 0);
});

test('migrateLegacyStorage: random garbage in every key never throws', () => {
  const junk = ['{}', '[]', 'null', '"x"', '5', '{"ed":{"rooms":5}}', '{"appliedPlan":null,"ed":null}', '{"settings":{"targetDown":"a","wanPort":3},"points":[null,1,{"x":0.5}],"original":{"x":0.48,"y":0.63}}', '{"band":9,"goal":-3,"speed":1}'];
  for (const a of junk) {
    for (const b of junk) {
      const out = P.migrateLegacyStorage((k) => (k === 'wifi-floor-v5' ? a : b));
      if (out) assertValidProject(out, `${a} / ${b}`);
    }
  }
});
