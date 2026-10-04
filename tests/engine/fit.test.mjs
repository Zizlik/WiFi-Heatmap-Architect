// SPEC 9: the "first measurement" calibration fit (model.fitCalibration / fitProject / fitStale), the robust offset
// rule shared with model.calibrate, and the fit being honoured everywhere (context -> raster, analysis, optimizer,
// contours, speed) as ONE source of truth. Synthetic ground truth: measurements generated from a known n / wallFactor /
// offset (+ deterministic noise) must be recovered; few points must stay near the defaults; outliers are rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { rng, busyPlan, makeProject } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const { W, H } = E.CANVAS;
const M = E.model;
const P = E.project;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (eps ${eps})`);

const demo = () => P.create({ template: 'demo', lang: 'cs' });
const busy = () => makeProject({ ...busyPlan(), router: [250, 200], baseline: [250, 200] });

/** Gaussian-ish noise (Irwin-Hall of 12 uniforms) from a seeded generator. */
const noise = (r) => {
  let u = 0;
  for (let i = 0; i < 12; i++) u += r();
  return u - 6;
};

/**
 * N measurements on random floor points of band `band`, generated from the truth {n, w, off} with the SAME softened
 * decomposition the fit uses (bandBase - n*10log10(d) - w*L + off), plus `sigma` dB of noise. Values kept in -98..-22.
 */
function generate(p, { N, band = 5, truth, sigma = 0, seed = 1, minD = 0.7 }) {
  const ctx = M.createContext(p, { fit: false });
  const bl = p.net.baseline;
  const r = rng(seed);
  const out = [];
  for (let tries = 0; out.length < N && tries < 20000; tries++) {
    const q = { x: 0.03 + r() * 0.94, y: 0.03 + r() * 0.94 };
    if (!P.floorMaskAt(p.plan, q)) continue;
    const dm = Math.hypot((q.x - bl.x) * W, (q.y - bl.y) * H) * ctx.mpp;
    if (dm < minD) continue;
    const L = M.softObstacleLoss(ctx, bl, q, undefined, band);
    const v = M.bandBase(M.forBand(ctx, band), band) - truth.n * 10 * Math.log10(Math.max(1, dm)) - truth.w * L + truth.off + sigma * noise(r);
    if (v < -98 || v > -22) continue;
    out.push({ id: `m${String(out.length).padStart(3, '0')}`, x: q.x, y: q.y, band, value: v, name: 'x', download: null, upload: null, device: 'Telefon', t: 1 });
  }
  return out;
}

const fitOf = (p, ms, opts = {}) => M.fitCalibration(M.createContext(p, { fit: false }), ms, { baseline: p.net.baseline, ...opts });

// ---------------------------------------------------------------------------------------------------------------------
// ground truth
// ---------------------------------------------------------------------------------------------------------------------

test('fit recovers a known n / wallFactor / offset from 25 noisy points (demo + busy plan, 5 and 2.4 GHz)', () => {
  const truth = { n: 2.8, w: 1.3, off: 4 };
  for (const [label, p] of [
    ['demo', demo()],
    ['busy', busy()],
  ]) {
    for (const band of [5, 2.4]) {
      for (const seed of [3, 17]) {
        const ms = generate(p, { N: 25, band, truth, sigma: 1.5, seed });
        assert.equal(ms.length, 25);
        const f = fitOf(p, ms, { band });
        const b = f.byBand[E.units.bandKey(band)];
        const tag = `${label} ${band} GHz seed ${seed}`;
        assert.equal(f.method, 'offset+n+walls', tag);
        assert.deepEqual(f.fitted, { n: true, wallFactor: true }, tag);
        close(f.n, truth.n, 0.4, `${tag} n`);
        close(f.wallFactor, truth.w, 0.15, `${tag} wallFactor`);
        close(b.offset, truth.off, 3, `${tag} offset`);
        assert.equal(b.n, f.n);
        assert.equal(b.count, 25);
        assert.deepEqual(b.outliers, []);
        assert.ok(b.rms < 2.2 && b.looRms < 2.6, `${tag} rms ${b.rms} loo ${b.looRms}`);
        assert.ok(b.looRms < b.before.looRms, `${tag}: the fitted model predicts better than the default one (${b.looRms} vs ${b.before.looRms})`);
        assert.ok(f.prior.sigma > 1 && f.prior.sigma < 3, `${tag}: estimated scatter ${f.prior.sigma}`);
      }
    }
  }
});

test('noise-free data with many points: n, wallFactor and offset come out almost exactly', () => {
  const p = demo();
  for (const truth of [
    { n: 2.6, w: 1.2, off: 3 },
    { n: 1.9, w: 0.75, off: -4 },
  ]) {
    const ms = generate(p, { N: 40, truth, seed: 5 });
    const f = fitOf(p, ms);
    close(f.n, truth.n, 0.06, 'n');
    close(f.wallFactor, truth.w, 0.03, 'wallFactor');
    close(f.byBand['5'].offset, truth.off, 0.4, 'offset');
    assert.ok(f.byBand['5'].rms < 0.3);
  }
});

test('few points (4-5, 4 dB noise) generated from the defaults stay near the defaults; wild truths are pulled in', () => {
  const p = demo();
  let maxN = 0;
  let maxW = 0;
  for (let seed = 1; seed <= 20; seed++) {
    for (const N of [4, 5]) {
      const f = fitOf(p, generate(p, { N, truth: { n: 2.2, w: 1, off: 0 }, sigma: 4, seed: seed * 31 + N }));
      maxN = Math.max(maxN, Math.abs(f.n - 2.2));
      maxW = Math.max(maxW, Math.abs(f.wallFactor - 1));
    }
  }
  assert.ok(maxN <= 0.6, `n moved up to ${maxN}`);
  // (0.45 on the old 6-room demo; the stage-7 showcase flat has more walls of more kinds between the hall router and
  // the rooms, so one of these 40 noisy 4-5 point draws reaches 0.48 - still well inside the ridge's pull)
  assert.ok(maxW <= 0.5, `wallFactor moved up to ${maxW}`);
  // a wild truth seen through 5 noisy points: the ridge keeps the fit between the defaults and the truth
  for (let seed = 1; seed <= 10; seed++) {
    const f = fitOf(p, generate(p, { N: 5, truth: { n: 3.6, w: 1.9, off: 6 }, sigma: 4, seed: 900 + seed }));
    assert.ok(f.n >= 2.2 - 0.3 && f.n < 3.6, `n ${f.n}`);
    assert.ok(f.wallFactor < 1.9, `wallFactor ${f.wallFactor}`);
  }
});

test('bounds n 1.6..4 and wallFactor 0.5..2 hold for any input (fuzz), results stay finite', () => {
  const p = busy();
  const r = rng(77);
  for (let k = 0; k < 60; k++) {
    const N = 1 + Math.floor(r() * 14);
    const ms = [];
    for (let i = 0; i < N; i++) {
      let q;
      do q = { x: r(), y: r() };
      while (!P.floorMaskAt(p.plan, q));
      ms.push({ id: `f${i}`, x: q.x, y: q.y, band: [2.4, 5, 6][Math.floor(r() * 3)], value: -100 + r() * 80 });
    }
    const f = fitOf(p, ms, k % 3 ? {} : { prior: { lambdaN: 0, lambdaW: 0 } });
    assert.ok(f.n >= 1.6 && f.n <= 4 && f.wallFactor >= 0.5 && f.wallFactor <= 2, `${f.n} ${f.wallFactor}`);
    for (const b of Object.values(f.byBand)) {
      assert.ok(Number.isFinite(b.offset) && Number.isFinite(b.rms));
      assert.ok(b.looRms === null || Number.isFinite(b.looRms));
      assert.ok(b.outliers.length <= Math.max(1, Math.floor(b.total / 4)));
    }
  }
  // extreme truths hit the bounds instead of running away
  const hi = fitOf(p, generate(p, { N: 30, truth: { n: 5.5, w: 3, off: 10 }, seed: 8 }));
  close(hi.n, 4, 1e-9, 'n at the upper bound');
  const lo = fitOf(p, generate(p, { N: 30, truth: { n: 1.2, w: 0.2, off: -10 }, seed: 9 }));
  assert.ok(lo.n >= 1.6 && lo.wallFactor >= 0.5);
  close(lo.wallFactor, 0.5, 1e-9, 'wallFactor at the lower bound');
});

test('outliers (> 12 dB) are flagged and excluded; the fit does not move', () => {
  const p = demo();
  const truth = { n: 2.6, w: 1.2, off: 2 };
  const good = generate(p, { N: 12, truth, sigma: 1, seed: 21 });
  const bad = { ...good[5], id: 'zz-outlier', x: good[5].x, y: good[5].y, value: good[5].value + 25 };
  const clean = fitOf(p, good);
  const dirty = fitOf(p, [...good, bad]);
  assert.deepEqual(dirty.byBand['5'].outliers, ['zz-outlier']);
  assert.equal(dirty.byBand['5'].count, 12);
  assert.equal(dirty.byBand['5'].total, 13);
  assert.equal(dirty.count, 12);
  assert.equal(dirty.total, 13);
  close(dirty.n, clean.n, 0.02, 'n');
  close(dirty.wallFactor, clean.wallFactor, 0.01, 'wallFactor');
  close(dirty.byBand['5'].offset, clean.byBand['5'].offset, 0.3, 'offset');
  // two outliers in 13: both go (cap = a quarter of the points)
  const bad2 = { ...good[2], id: 'zz-outlier-2', value: good[2].value - 20 };
  assert.deepEqual(fitOf(p, [...good, bad, bad2]).byBand['5'].outliers.sort(), ['zz-outlier', 'zz-outlier-2']);
});

test('fewer than 4 points: offset only = the plain median calibration (the fallback), 3-point outlier rule', () => {
  const p = demo();
  const ms = generate(p, { N: 3, truth: { n: 2.2, w: 1, off: 5 }, sigma: 2, seed: 4 });
  const ctx = M.createContext(p, { fit: false });
  for (const k of [1, 2, 3]) {
    const f = fitOf(p, ms.slice(0, k));
    assert.equal(f.method, 'offset');
    assert.deepEqual(f.fitted, { n: false, wallFactor: false });
    assert.equal(f.n, p.model.n);
    assert.equal(f.wallFactor, 1);
    const legacy = M.calibrate(ctx, ms.slice(0, k), 5, { baseline: p.net.baseline });
    close(f.byBand['5'].offset, legacy.offset, 1e-9, `${k} points`);
    assert.equal(f.byBand['5'].looRms === null, k === 1);
    assert.equal(f.byBand['5'].method, 'offset');
    assert.equal('n' in f.byBand['5'], false);
  }
  // 3 points, one 20 dB off: flagged, the offset is the mean of the other two
  const odd = [ms[0], ms[1], { ...ms[2], value: ms[2].value + 20 }];
  const f = fitOf(p, odd);
  assert.deepEqual(f.byBand['5'].outliers, [ms[2].id]);
  const res = odd.slice(0, 2).map((m) => m.value - M.softRawSignal(ctx, p.net.baseline, m, 5));
  close(f.byBand['5'].offset, (res[0] + res[1]) / 2, 1e-9);
});

test('n / wallFactor are only fitted when the points span distances / walls', () => {
  const p = makeProject({ rooms: [{ id: 'room-1', type: 'room', roomId: 1, name: 'R', points: [{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.05 }, { x: 0.95, y: 0.95 }, { x: 0.05, y: 0.95 }], color: '#8eadd2' }], router: [540, 471], baseline: [540, 471] });
  // one open room, no walls: every L is 0 -> wallFactor cannot be told, n can
  const ms = generate(p, { N: 8, truth: { n: 3, w: 1, off: 0 }, sigma: 0.5, seed: 2 });
  const f = fitOf(p, ms);
  assert.deepEqual(f.fitted, { n: true, wallFactor: false });
  assert.equal(f.wallFactor, 1);
  assert.equal(f.method, 'offset+n+walls');
  assert.ok(f.n > p.model.n + 0.2 && f.n < 3, `n ${f.n} moves towards the truth (3), held back by the prior`);
  // all points at about the same distance: n cannot be told either
  const bl = p.net.baseline;
  const ring = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI;
    const q = { x: bl.x + (3 / p.scale.mpp / W) * Math.cos(a), y: bl.y + (3 / p.scale.mpp / H) * Math.sin(a) };
    ring.push({ id: `r${i}`, x: q.x, y: q.y, band: 5, value: -70 + (i % 2) });
  }
  const g = fitOf(p, ring);
  assert.deepEqual(g.fitted, { n: false, wallFactor: false });
  assert.equal(g.method, 'offset');
  assert.equal(g.n, p.model.n);
});

test('deterministic and independent of the order of the measurements; a fitted context fits the same', () => {
  const p = busy();
  const ms = [...generate(p, { N: 9, truth: { n: 2.7, w: 1.25, off: 3 }, sigma: 2, seed: 41 }), ...generate(p, { N: 5, band: 2.4, truth: { n: 2.7, w: 1.25, off: 1 }, sigma: 2, seed: 42 }).map((m) => ({ ...m, id: `b${m.id}` }))];
  const a = fitOf(p, ms);
  const b = fitOf(p, ms.slice().reverse());
  const r = rng(5);
  const c = fitOf(
    p,
    ms
      .map((m) => [r(), m])
      .sort((x, y) => x[0] - y[0])
      .map((x) => x[1]),
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(a, fitOf(p, ms));
  assert.deepEqual(Object.keys(a.byBand).sort(), ['2.4', '5']);
  // shared shape, per-band offsets
  assert.equal(a.byBand['5'].n, a.n);
  assert.equal(a.byBand['2.4'].n, a.n);
  // the same fit from a context that already carries a (different) fit
  const fitted = M.createContext(p, { fit: { n: 3.3, wallFactor: 1.7 } });
  const d = M.fitCalibration(fitted, ms, { baseline: p.net.baseline });
  close(d.n, a.n, 1e-9);
  close(d.wallFactor, a.wallFactor, 1e-9);
  close(d.byBand['5'].offset, a.byBand['5'].offset, 1e-9);
  // band option + device preference (like calibrate: own device first, all devices when it has none)
  const only5 = fitOf(p, ms, { band: 5 });
  assert.deepEqual(Object.keys(only5.byBand), ['5']);
  const other = ms.map((m, i) => (i < 3 ? { ...m, device: 'Notebook' } : m));
  assert.equal(fitOf(p, other, { band: 5, device: 'notebook' }).byBand['5'].total, 3);
  assert.equal(fitOf(p, other, { band: 2.4, device: 'Notebook' }).byBand['2.4'].fallback, true);
  // nothing to fit
  const none = fitOf(p, []);
  assert.deepEqual(none.byBand, {});
  assert.equal(none.total, 0);
  assert.equal(fitOf(p, [{ id: 's', x: 0.3, y: 0.3, band: 5, value: null, download: 100, upload: 20 }]).total, 0, 'speed-only points never calibrate');
  assert.throws(() => M.fitCalibration(M.createContext(p), ms, {}), RangeError);
});

// ---------------------------------------------------------------------------------------------------------------------
// robust offset rule (shared by calibrate on a fitted context)
// ---------------------------------------------------------------------------------------------------------------------

test('robustOffset: mean with > 12 dB outliers dropped from 4 values on, median below, order independent', () => {
  const R = M.robustOffset;
  assert.deepEqual(R([]), { offset: 0, rms: 0, outliers: [] });
  close(R([3]).offset, 3, 0);
  close(R([1, 4]).offset, 2.5, 1e-12);
  close(R([1, 2, 40]).offset, 1.5, 1e-12, '3 values: the odd one is dropped');
  assert.deepEqual(R([1, 2, 40]).outliers, [2]);
  close(R([0, 1, 2, 3]).offset, 1.5, 1e-12);
  const r = R([0, 1, 2, 3, 30, 1, 2, 0]);
  assert.deepEqual(r.outliers, [4]);
  close(r.offset, 9 / 7, 1e-12);
  // at most a quarter of the values (at least one)
  assert.equal(R([0, 40, -40, 1, 2]).outliers.length, 1);
  assert.equal(R([0, 40, -40, 1, 2, 3, 1, 0]).outliers.length, 2);
  // order independence when the keys travel with the values
  const vals = [5, -3, 2.2, 17, 0.5, -1, 4.4, 30];
  const keys = vals.map((_, i) => `k${i}`);
  const a = R(vals, keys);
  const idx = [7, 2, 5, 0, 3, 6, 1, 4];
  const b = R(
    idx.map((i) => vals[i]),
    idx.map((i) => keys[i]),
  );
  assert.equal(a.offset, b.offset);
  assert.equal(a.rms, b.rms);
  assert.deepEqual(a.outliers.map((i) => keys[i]).sort(), b.outliers.map((i) => idx[i]).map((i) => keys[i]).sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// project.model.fit: sanitize / serialize / round trip / staleness
// ---------------------------------------------------------------------------------------------------------------------

/** Demo project with 7 measurements on 5 GHz generated from a known truth. */
function measuredDemo(truth = { n: 2.7, w: 1.3, off: 4 }) {
  const p = demo();
  p.measurements = generate(p, { N: 7, truth, sigma: 1, seed: 12 }).map((m) => ({ ...m, value: Math.round(m.value * 100) / 100 }));
  return P.sanitize(p);
}

test('fitProject: the object to store (sanitized), round trips through files, fitStale tracks the measurements', () => {
  const p = measuredDemo();
  const fit = M.fitProject(p, { band: 5, at: 1759500000000 });
  assert.ok(fit);
  assert.deepEqual(P.cleanFit(fit), fit, 'already in the stored shape');
  assert.equal(fit.at, 1759500000000);
  assert.equal(fit.method, 'offset+n+walls');
  assert.deepEqual(Object.keys(fit.byBand), ['5']);
  assert.equal(fit.byBand['5'].count, 7);
  assert.ok(typeof fit.sig === 'string' && fit.sig.length > 4);
  assert.ok(fit.byBand['5'].before && Number.isFinite(fit.byBand['5'].before.rms));
  const q = P.clone(p);
  q.model.fit = fit;
  const s = P.sanitize(q);
  assertValidProject(s, 'with fit');
  assert.deepEqual(s.model.fit, fit);
  assert.deepEqual(P.sanitize(JSON.parse(P.serialize(s))), s, 'serialize round trip');
  assert.deepEqual(P.parseSvgText(P.buildSvg(s)).project, s, 'SVG round trip');
  assert.deepEqual(P.sanitize(s), s, 'idempotent');
  // staleness
  assert.equal(M.fitStale(s), false);
  const added = P.clone(s);
  added.measurements.push({ ...added.measurements[0], id: 'new', value: -70 });
  assert.equal(M.fitStale(P.sanitize(added)), true);
  const other = P.clone(s);
  other.measurements.push({ ...other.measurements[0], id: 'b24', band: 2.4 });
  assert.equal(M.fitStale(P.sanitize(other)), false, 'a measurement of another band does not touch a 5 GHz fit');
  assert.equal(M.fitStale(p), false, 'no fit, nothing stale');
  // no usable measurement -> nothing to store
  assert.equal(M.fitProject(demo()), null);
  // the stored fit is computed from the DEFAULT model even when a fit is active
  close(M.fitProject(s, { band: 5, at: 1 }).n, fit.n, 1e-6);
});

test('sanitize of model.fit: garbage is dropped, numbers are clamped, older files keep their exact model shape', () => {
  const base = demo();
  const with_ = (fit) => {
    const q = P.clone(base);
    q.model.fit = fit;
    return P.sanitize(q).model;
  };
  assert.equal('fit' in base.model, false);
  assert.equal('fit' in with_(null), false);
  assert.equal('fit' in with_('x'), false);
  assert.equal('fit' in with_({ n: 'a', wallFactor: 1 }), false);
  assert.equal('fit' in with_({ n: 2.5 }), false);
  const m = with_({ n: 9, wallFactor: -3, method: 'magic', count: 2.5, at: -1, fitted: { n: 'yes' }, sig: 'NOT VALID!', byBand: { 5: { offset: 99, rms: -1, looRms: 'x', count: 3, outliers: ['a', 7, { x: 1 }, '', 'b\u0000c'], n: 0.2, before: { offset: 1, rms: 2, looRms: null } }, 7: { offset: 1 }, '2.4': { rms: 1 } } });
  assert.deepEqual(m.fit, {
    n: 4,
    wallFactor: 0.5,
    method: 'offset',
    count: 0,
    at: 0,
    fitted: { n: false, wallFactor: false },
    byBand: { 5: { offset: 40, rms: 0, looRms: null, count: 3, outliers: ['a', '7', 'b c'], n: 1.6, before: { offset: 1, rms: 2, looRms: null } } },
  });
  const proto = with_(JSON.parse('{"n":2.4,"wallFactor":1.1,"__proto__":{"polluted":1},"byBand":{"__proto__":{"offset":3}}}'));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(proto.fit.byBand, {});
});

// ---------------------------------------------------------------------------------------------------------------------
// the fit is honoured everywhere: context, raster, analysis, optimizer, contours, speed
// ---------------------------------------------------------------------------------------------------------------------

test('createContext applies project.model.fit while calibration is on (ctx.p.n, ctx.wf, version), not when off', () => {
  const p = measuredDemo();
  const fit = M.fitProject(p, { band: 5, at: 1 });
  const q = P.sanitize({ ...p, model: { ...p.model, fit } });
  const base = M.createContext(p);
  const ctx = M.createContext(q);
  assert.equal(base.fit, null);
  assert.equal(base.wf, 1);
  assert.equal(base.p.n, p.model.n);
  assert.equal(ctx.p.n, fit.n);
  assert.equal(ctx.p.baseN, p.model.n);
  assert.equal(ctx.wf, fit.wallFactor);
  assert.deepEqual(ctx.fit, { n: fit.n, wallFactor: fit.wallFactor, offsets: { '2.4': null, '5': fit.byBand['5'].offset, '6': null } });
  assert.notEqual(ctx.version, base.version);
  assert.equal(ctx.roomsVersion, base.roomsVersion);
  // every band view carries the fit
  for (const b of [2.4, 6]) {
    assert.equal(M.forBand(ctx, b).wf, fit.wallFactor);
    assert.equal(M.forBand(ctx, b).p.n, fit.n);
  }
  // switched off, or explicitly ignored: exactly the default model (same version as before the fit existed)
  const off = P.sanitize({ ...q, view: { ...q.view, calibrate: false } });
  assert.equal(M.createContext(off).version, M.createContext(P.sanitize({ ...p, view: { ...p.view, calibrate: false } })).version);
  assert.equal(M.createContext(off).fit, null);
  assert.equal(M.createContext(q, { fit: false }).version, base.version);
  // obstacle losses x wallFactor (all bands), the free-space part uses the fitted n
  const a = p.net.baseline;
  const b = { x: 0.85, y: 0.3 };
  for (const band of [2.4, 5, 6]) {
    close(M.obstacleLoss(ctx, a, b, band), fit.wallFactor * M.obstacleLoss(base, a, b, band), 1e-9, `loss ${band}`);
    close(M.softObstacleLoss(ctx, a, b, undefined, band), fit.wallFactor * M.softObstacleLoss(base, a, b, undefined, band), 1e-9, `soft loss ${band}`);
  }
  const dm = Math.hypot((b.x - a.x) * W, (b.y - a.y) * H) * ctx.mpp;
  close(M.rawSignal(ctx, a, b, 5) - M.rawSignal(base, a, b, 5), -(fit.n - p.model.n) * 10 * Math.log10(dm) - (fit.wallFactor - 1) * M.obstacleLoss(base, a, b, 5), 1e-9);
  // the wall mask of the softening does not change with the fit
  assert.equal(M.wallBlocks(ctx, 100, 100, 900, 800), M.wallBlocks(base, 100, 100, 900, 800));
});

test('live calibration on a fitted context reproduces the stored offsets; with no points the stored offset stays', () => {
  const p = measuredDemo();
  const fit = M.fitProject(p, { band: 5, at: 1 });
  const q = P.sanitize({ ...p, model: { ...p.model, fit } });
  const ctx = M.createContext(q);
  const cal = M.calibrateAll(ctx, q);
  assert.equal(cal['5'].fitted, true);
  close(cal['5'].offset, fit.byBand['5'].offset, 1e-5, 'live = stored');
  close(cal['5'].rms, fit.byBand['5'].rms, 1e-5);
  assert.deepEqual(cal['5'].outliers, fit.byBand['5'].outliers);
  assert.deepEqual(M.offsets(ctx, q), { '2.4': 0, '5': cal['5'].offset, '6': 0 });
  // the baseline moved -> measurements cleared: the router strength of the fit survives
  const moved = P.sanitize({ ...q, measurements: [] });
  const c2 = M.calibrateAll(M.createContext(moved), moved);
  assert.equal(c2['5'].offset, fit.byBand['5'].offset);
  assert.equal(c2['5'].n, 0);
  assert.equal(c2['2.4'].offset, 0);
  // without a fit the plain median is unchanged (legacy calibration)
  const legacy = M.calibrateAll(M.createContext(p), p);
  assert.equal(legacy['5'].fitted, undefined);
  close(legacy['5'].offset, E.util.median(legacy['5'].used.map((u) => u.residual)), 1e-12);
  // outliers flagged in used[] on a fitted context
  const bad = P.clone(q);
  bad.measurements.push({ ...bad.measurements[0], id: 'zz', value: bad.measurements[0].value + 30 });
  const c3 = M.calibrate(M.createContext(P.sanitize(bad)), P.sanitize(bad).measurements, 5, { baseline: q.net.baseline, device: q.goal.device });
  assert.deepEqual(c3.outliers, ['zz']);
  assert.equal(c3.used.find((u) => u.id === 'zz').outlier, true);
});

test('one source of truth: raster, analysis, contours, optimizer and the speed model all use the fitted physics', async () => {
  const p = measuredDemo();
  p.view.band = 5; // the 5 GHz map: the fit below is made of 5 GHz points
  const fit = M.fitProject(p, { band: 5, at: 1 });
  const q = P.sanitize({ ...p, model: { ...p.model, fit } });
  const off = P.sanitize({ ...q, view: { ...q.view, calibrate: false } });
  const ctxF = M.createContext(q);
  const ctx0 = M.createContext(p, { fit: false });
  const grid = E.raster.grid(ctxF, { cell: 8 });
  const params = { ...M.fieldParams(q, 'today', { offsets: { '2.4': 0, '5': 0, '6': 0 } }), aa: 1 };
  const fF = E.raster.field(ctxF, grid, params);
  const f0 = E.raster.field(ctx0, grid, params);
  // field_fit = base - n_fit D - wf * blurredLoss, with blurredLoss recovered from the default field (linear in the losses)
  const base = M.bandBase(ctx0, 5);
  const bl = q.net.baseline;
  let checked = 0;
  for (const i of grid.idx) {
    if (f0[i] <= -109 || fF[i] <= -109 || f0[i] >= -21 || fF[i] >= -21) continue;
    const dm = Math.hypot(grid.cx[i] * W - bl.x * W, grid.cy[i] * H - bl.y * H) * ctx0.mpp;
    const D = 10 * Math.log10(Math.max(1, dm));
    const blurL = base - p.model.n * D - f0[i];
    close(fF[i], base - fit.n * D - fit.wallFactor * blurL, 2e-3, `cell ${i}`);
    checked++;
  }
  assert.ok(checked > 1000, `${checked} cells`);
  // analysis.run builds the fitted context itself; with calibration off it is the default model again
  const a = E.analysis.run(q, { cell: 8 });
  assert.equal(a.ctx.version, ctxF.version);
  assert.deepEqual(Array.from(a.today), Array.from(E.raster.field(ctxF, grid, { ...M.fieldParams(q, 'today', { offsets: a.offsets }), aa: 1 })));
  const a0 = E.analysis.run(off, { cell: 8 });
  assert.equal(a0.ctx.version, M.createContext(off).version);
  assert.notEqual(a.stats.today.mean, a0.stats.today.mean);
  // contours follow the fitted field
  const cF = E.raster.contours(ctxF, { band: 5, router: bl, threshold: -67 });
  const c0 = E.raster.contours(ctx0, { band: 5, router: bl, threshold: -67 });
  assert.notDeepEqual(cF, c0);
  // the optimizer's numbers are the fitted analysis numbers
  const grid4 = E.raster.grid(ctxF, { cell: 4 });
  const r = await E.optimize.find(ctxF, grid4, { band: 5, threshold: q.model.threshold, excluded: q.goal.excluded, router: q.net.router, node: null, offsets: a.offsets });
  const at = E.analysis.run({ ...q, net: { ...q.net, router: r.pos } }, { cell: 4 });
  close(r.after.coverage, at.stats.trial.coverage, 0.5, 'optimizer after = analysis');
  // speed-only points get the fitted prediction
  const sp = [{ id: 's1', x: 0.8, y: 0.3, band: 5, value: null, download: 100, upload: 30, device: 'Telefon', t: 1 }];
  const filled = E.speed.fillSignals(ctxF, sp, { baseline: bl, offsets: a.offsets });
  close(filled[0].value, Math.round(M.softSignal(ctxF, bl, sp[0], 5, a.offsets['5']) * 100) / 100, 1e-9);
  assert.notEqual(filled[0].value, E.speed.fillSignals(ctx0, sp, { baseline: bl, offsets: a.offsets })[0].value);
});

test('fit cost: 20 measurements fit in well under 100 ms', () => {
  const p = busy();
  const ms = generate(p, { N: 20, truth: { n: 2.5, w: 1.1, off: 0 }, sigma: 2, seed: 99 });
  const ctx = M.createContext(p);
  M.fitCalibration(ctx, ms, { baseline: p.net.baseline });
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) M.fitCalibration(ctx, ms, { baseline: p.net.baseline });
  const dt = (performance.now() - t0) / 3;
  assert.ok(dt < 100, `${dt.toFixed(1)} ms`);
});
