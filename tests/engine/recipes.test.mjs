// Executes the recipes of src/ENGINE-API.md section 2, so the documentation cannot rot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, readPrivatePlan, rawPayloadOf } from './_load.mjs';

const WH = globalThis.WH;
const P = E.project;

test('recipe 2.1: today vs trial in a few lines', () => {
  const project = P.create({ template: 'demo', lang: 'cs' });
  project.net.router = P.nearestFloor(project.plan, { x: 0.5, y: 0.45 });
  const cache = {};
  const a = E.analysis.run(project, { cell: 4, cache });
  assert.ok(a.stats.trial.coverage > a.stats.today.coverage);
  assert.equal(a.delta.coverage, a.stats.trial.coverage - a.stats.today.coverage);
  const img = E.raster.colorize(a.grid, a.trial, { palette: project.view.palette });
  assert.equal(img.data.length, img.width * img.height * 4);
  assert.equal(img.width, 270);
  assert.equal(img.height, 236);
  const diffImg = E.raster.colorize(a.grid, a.diff, { mode: 'diff' });
  assert.equal(diffImg.data.length, img.data.length);
  assert.ok(a.perRoom.trial instanceof Map && a.perRoom.trial.size === 7);

  // ... and by hand
  const ctx = E.model.createContext(project);
  const grid = E.raster.grid(ctx, { cell: 4 });
  const offs = E.model.offsets(ctx, project);
  const today = E.raster.field(ctx, grid, E.model.fieldParams(project, 'today', { offsets: offs }));
  const trial = E.raster.field(ctx, grid, E.model.fieldParams(project, 'trial', { offsets: offs }));
  const s = E.raster.stats(grid, trial, null, project.model.threshold, project.goal.excluded);
  assert.ok(s.coverage > E.raster.stats(grid, today, null, project.model.threshold, project.goal.excluded).coverage);
  // the by-hand numbers equal analysis.run with aa 1
  const a1 = E.analysis.run(project, { cell: 4, aa: 1 });
  assert.equal(a1.stats.trial.coverage, s.coverage);
});

test('recipe 2.2: drag loop with reused buffers and one cache per quality', () => {
  const project = P.create({ template: 'demo', lang: 'en' });
  const ctx = E.model.createContext(project);
  const offsets = E.model.offsets(ctx, project);
  const grid8 = E.raster.grid(ctx, { cell: 8 });
  const buf = new Float32Array(grid8.cols * grid8.rows);
  const cacheFast = {};
  const cacheFull = {};
  const times = [];
  let todayFast = null;
  for (let k = 0; k < 20; k++) {
    project.net.router = P.nearestFloor(project.plan, { x: 0.3 + k * 0.01, y: 0.4 });
    const t0 = performance.now();
    const a = E.analysis.run(project, { cell: 8, aa: 1, ctx, offsets, cache: cacheFast, reuse: { trial: buf } });
    times.push(performance.now() - t0);
    assert.equal(a.trial, buf);
    if (todayFast) assert.equal(a.today, todayFast, 'today is not recomputed while dragging');
    todayFast = a.today;
  }
  times.sort((x, y) => x - y);
  assert.ok(times[10] < 33, `median drag frame ${times[10].toFixed(1)} ms`);
  const full = E.analysis.run(project, { cell: 4, ctx, offsets, cache: cacheFull });
  assert.equal(full.grid.cell, 4);
});

test('recipe 2.3: hover tooltip', () => {
  const project = P.create({ template: 'demo', lang: 'cs' });
  project.net.router = P.nearestFloor(project.plan, { x: 0.45, y: 0.4 });
  const ctx = E.model.createContext(project);
  const offs = E.model.offsets(ctx, project);
  const a = E.analysis.run(project, { cell: 4, ctx, offsets: offs });
  const p = { x: 0.3, y: 0.3 };
  const room = P.roomAt(project.plan, p);
  assert.equal(room.name, 'Ložnice');
  const st = E.model.fieldParams(project, 'trial', { offsets: offs });
  const d = E.model.pointSignalDetail(ctx, p, st);
  assert.ok(['excellent', 'veryGood', 'good', 'weak', 'veryWeak', 'unusable'].includes(E.units.qualityOf(d.combined).key));
  assert.ok(Math.abs(E.raster.sample(a.grid, a.trial, p) - d.combined) < 1.5, 'field and tooltip agree');
  assert.equal(P.roomAt(project.plan, { x: 0.02, y: 0.02 }), null);
});

test('recipe 2.4: find the best place', async () => {
  const project = P.create({ template: 'demo', lang: 'cs' });
  const ctx = E.model.createContext(project);
  const grid = E.raster.grid(ctx, { cell: 4 });
  const offs = E.model.offsets(ctx, project);
  const ac = new AbortController();
  const seen = [];
  const r = await E.optimize.find(
    ctx,
    grid,
    {
      band: project.view.band,
      goalRoom: project.goal.room === 'all' ? null : project.goal.room,
      allowedRoom: project.goal.allowedRoom === 'any' ? null : project.goal.allowedRoom,
      threshold: project.model.threshold,
      excluded: project.goal.excluded,
      router: project.net.router,
      node: E.model.nodeParams(project),
      offsets: offs,
    },
    { onProgress: (f) => seen.push(f), signal: ac.signal },
  );
  assert.ok(r.after.coverage > r.before.coverage);
  assert.ok(P.floorMaskAt(project.plan, r.pos));
  assert.ok(seen.length > 0);
});

test('recipe 2.5: files', () => {
  const project = P.create({ template: 'demo', lang: 'cs' });
  const svg = P.buildSvg(project, { lang: 'cs' });
  const r = P.parseSvgText(svg);
  assert.equal(r.hasData, true);
  assert.equal(r.svgBackground, null);
  const stored = P.serialize(project);
  assert.deepEqual(P.sanitize(stored), project);
  const real = readPrivatePlan();
  if (real !== null) assert.equal(P.parseSvgText(real).project.plan.rooms.length, rawPayloadOf(real).plan.rooms.length);
  const mem = {};
  assert.equal(P.migrateLegacyStorage((k) => (k in mem ? mem[k] : null)), null);
  assert.equal(P.parseSvgText('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>').hasData, false);
});

test('recipe 2.6: measurements, calibration, speed', () => {
  const project = P.create({ template: 'demo', lang: 'cs' });
  // the 5 GHz map (in the default band mode Auto the far rooms would show their 2.4 GHz signal, SPEC 13)
  project.view.band = 5;
  const ctx = E.model.createContext(project);
  const grid = E.raster.grid(ctx, { cell: 4 });
  const base = project.net.baseline;
  const add = (x, y, value, download, upload) => {
    // synthetic measurements: what the (softened) map predicts at that spot, 4 dB weaker
    const raw = E.model.softRawSignal(ctx, base, { x, y }, 5);
    project.measurements.push({ id: 'm-' + project.measurements.length.toString(36), x, y, band: 5, value: Math.round((raw - 4 + (value || 0)) * 10) / 10, name: 'm', download, upload, device: project.goal.device, t: Date.now() });
  };
  add(0.5, 0.74, 0, 420, 120);
  add(0.4, 0.55, 0, 300, 100);
  add(0.3, 0.3, 0, 120, 50);
  add(0.7, 0.25, 0, 60, 25);
  const offs = E.model.offsets(ctx, project);
  assert.ok(Math.abs(offs['5'] - -4) < 0.06);
  const cal = E.model.calibrateAll(ctx, project);
  assert.equal(cal['5'].n, 4);
  assert.ok(cal['5'].rms < 0.1);
  // the calibrated map reproduces the measurements where they were taken (the offset is added after the softening)
  const a = E.analysis.run(project, { cell: 4, ctx, offsets: offs });
  for (const m of project.measurements) assert.ok(Math.abs(E.raster.sample(a.grid, a.today, m) - m.value) < 0.6, `${E.raster.sample(a.grid, a.today, m)} vs ${m.value}`);
  const curve = E.speed.buildCurve(project.measurements, { band: 5, device: project.goal.device });
  assert.ok(curve);
  const net = project.net;
  const goal = project.goal;
  const sf = E.speed.fieldSpeed(ctx, grid, E.model.fieldParams(project, 'trial', { offsets: offs }), curve, { wanDown: net.wanDown, wanUp: net.wanUp, wanPort: net.wanPort, ontPort: net.ontPort, wanLink: net.wanLink, reserve: goal.reserve });
  assert.equal(sf.supported, true);
  const ratio = E.speed.ratioField(grid, sf, goal.targetDown, goal.targetUp);
  const img = E.raster.colorize(grid, ratio, { mode: 'speed' });
  assert.equal(img.width, grid.cols);
  // the project with measurements survives a file round trip
  assert.deepEqual(P.parseSvgText(P.buildSvg(project)).project, P.sanitize(project));
  void WH;
});

test('recipe 2.9: what-if at the measured points (router moved, then a repeater in the bedroom)', () => {
  const project = P.create({ template: 'demo', lang: 'cs' });
  const ctx0 = E.model.createContext(project);
  const bl = project.net.baseline;
  // three measured points (signal + speed test) where the (uncalibrated) map says, 3 dB weaker
  const spots = [
    ['Ložnice', { x: 0.2, y: 0.4 }, 60, 20],
    ['Obývák', { x: 0.75, y: 0.45 }, 110, 40],
    ['Předsíň', P.nearestFloor(project.plan, { x: bl.x + 0.03, y: bl.y }), 450, 160],
  ];
  project.measurements = spots.map(([name, q, down, up], i) => ({
    id: `w${i}`, x: q.x, y: q.y, band: 5, value: Math.round((E.model.softSignal(ctx0, bl, q, 5, 0) - 3) * 10) / 10, name, download: down, upload: up, device: 'Telefon', t: 1,
  }));
  const label = (e) => `${Math.round(e.measured ?? e.modelToday)} → ${Math.round(e.predicted)} (${e.delta >= 0 ? '+' : ''}${Math.round(e.delta)})`;
  assert.equal(E.analysis.whatIfActive(project), false);
  // 1) the router moved into the hall's corridor (3.0 m / 4.8 m on the showcase flat)
  project.net.router = P.nearestFloor(project.plan, { x: (120 + 3.0 * 80) / 1080, y: (231 + 4.8 * 80) / 942 });
  assert.equal(P.roomAt(project.plan, project.net.router).name, 'Předsíň');
  let ctx = E.model.createContext(project);
  let offs = E.model.offsets(ctx, project);
  assert.ok(Math.abs(offs['5'] - -3) < 0.2, `calibrated ${offs['5']}`);
  assert.equal(E.analysis.whatIfActive(project), true);
  let list = E.analysis.predictAtMeasurements(ctx, project, { offsets: offs });
  assert.equal(list.length, 3);
  for (const e of list) {
    assert.equal(e.reason, null);
    assert.match(label(e), /^-\d+ → -\d+ \([+-]\d+\)$/);
    assert.ok(e.speed && e.speed.anchored);
  }
  const bed = list[0];
  assert.ok(bed.delta > 0, `the bedroom gains ${bed.delta}`);
  // 2) a repeater in the bedroom on top: strong there, but its link to the router caps the speed
  project.nodes = [{ ...E.project.newNode(project, { mode: 'repeater', pos: { x: 0.303704, y: 0.550955 } }), maxMbps: 300 }];
  ctx = E.model.createContext(project);
  offs = E.model.offsets(ctx, project);
  list = E.analysis.predictAtMeasurements(ctx, project, { offsets: offs });
  const bed2 = list[0];
  assert.equal(bed2.source, 'node');
  assert.ok(bed2.delta > bed.delta);
  assert.ok(['backhaul', 'device', 'plan', null].includes(bed2.speed.limitedBy));
  const s = E.analysis.summarizePredictions(list);
  assert.equal(s.best.id, 'w0');
  assert.equal(s.rooms[0].roomId, P.roomAt(project.plan, list[0]).roomId);
  const curve = E.speed.buildCurve(E.speed.fillSignals(ctx, project.measurements, { baseline: bl, offsets: offs }), { band: 5, device: 'Telefon' });
  const link = E.speed.nodeLink(ctx, E.model.fieldParams(project, 'trial', { offsets: offs }), curve);
  assert.equal(link.wireless, true);
  assert.ok(Number.isFinite(link.signal));
  if (bed2.speed.limitedBy === 'backhaul') assert.ok(Math.abs(bed2.speed.capDown - link.down) < 1e-9);
});
