/* WiFi Heatmap Architect - engine.model.fitCalibration: the "first measurement" calibration (SPEC 9).
 *
 * The plain calibration (model.calibrate) shifts the whole map of a band by the median residual - it cannot tell a
 * router that is stronger than assumed from walls that block more (or less) than assumed. With a handful of points
 * that span distances and wall counts (the wizard suggests them: analysis.suggestSpots) we can:
 *
 *   measured_i = bandBase(b) + offset_b - n * D_i - wallFactor * L_i + noise
 *       D_i = 10*log10(max(1, distance_m))          (distance from the router at net.baseline)
 *       L_i = softened obstacle loss of the band     (what the map uses; band factors included)
 *
 * offset_b per band ("router strength") always; with >= 4 points of a band that span distances (a 2x distance ratio)
 * and/or wall losses (3 dB) also the SHARED path-loss exponent n (1.6..4) and obstacle-loss multiplier wallFactor
 * (0.5..2), by least squares on the dB residuals with a ridge prior towards the model's own values (n = model.n,
 * wallFactor = 1): MAP with an assumed 4 dB scatter, prior sd 0.6 for n and 0.35 for wallFactor - so 4-5 noisy points
 * move the shape only part of the way, 20+ points pin it down. Box constraints are solved exactly (the objective is a
 * convex quadratic in (n, wallFactor) once the offsets are profiled out). Points more than 12 dB off the fitted model
 * are rejected one at a time (worst first, at most a quarter of a band) and listed as outliers. The offsets of the
 * result come from model.robustOffset() at the final shape - the very rule model.calibrate() applies live to a fitted
 * context - so the stored fit and the live map agree. Leave-one-out RMS is the honest accuracy number.
 *
 * Pure, deterministic (the order of the measurements does not matter), ~0.1 ms per measurement (the softened loss).
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { clamp, isNum, median } = E.util;
  const units = E.units;
  const model = E.model;

  const [N_MIN, N_MAX] = model.FIT_BOUNDS.n;
  const [WF_MIN, WF_MAX] = model.FIT_BOUNDS.wallFactor;
  const SIGMA0 = 4; // dB: measurement scatter the prior assumes (worth NU0 pseudo-points)
  const NU0 = 6; // weight of SIGMA0 against the scatter seen in the data
  const SIG_MIN = 1; // dB: limits of the estimated scatter
  const SIG_MAX = 8;
  const TAU_N = 0.6; // prior standard deviation of n
  const TAU_W = 0.35; // prior standard deviation of wallFactor
  const MIN_SHAPE = 4; // points of one band before n / wallFactor are fitted
  const SPAN_D = 3; // spread of 10*log10(distance) (a 2x distance ratio) needed to fit n
  const SPAN_L = 3; // dB spread of the obstacle loss (about one wall) needed to fit wallFactor
  const FIT = Object.freeze({ SIGMA0, NU0, SIG_MIN, SIG_MAX, TAU_N, TAU_W, MIN_SHAPE, SPAN_D, SPAN_L, OUTLIER_DB: model.OUTLIER_DB });

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /**
   * The measurements of one band that calibrate (numeric value; `device` preferred like model.calibrate) as fit
   * points {id, key, y, D, L} sorted by id: y = measured - bandBase, D = 10 log10(max(1, d m)), L = softened obstacle
   * loss WITHOUT any fit of the context (so a fitted context can be refitted).
   */
  function pointsOf(ctx, measurements, band, o) {
    const all = (measurements || []).filter((m) => m && units.normBand(m.band) === band && isNum(m.value) && isNum(m.x) && isNum(m.y));
    let list = all;
    let fallback = false;
    if (o.device) {
      const key = model.profileKey(o.device);
      const own = all.filter((m) => model.profileKey(m.device) === key);
      if (own.length) list = own;
      else if (all.length) fallback = true;
    }
    const c = model.forBand(ctx, band);
    const base = model.bandBase(c, band);
    const bl = o.baseline;
    const wf = ctx.wf || 1;
    const pts = list.map((m) => {
      const dm = Math.hypot((m.x - bl.x) * W, (m.y - bl.y) * H) * ctx.mpp;
      const L = model.softObstacleLoss(ctx, bl, { x: m.x, y: m.y }, o.soften, band) / wf;
      // a point whose band was inferred (SPEC 13) counts less in the offset and never shapes n / wallFactor
      const inferred = m.bandInferred === true;
      return { id: m.id, key: String(m.id), y: m.value - base, D: 10 * Math.log10(dm < 1 ? 1 : dm), L, inferred, w: inferred ? model.INFERRED_WEIGHT : 1 };
    });
    pts.sort((a, b) => cmp(a.key, b.key));
    return { pts, fallback };
  }

  /** residual of a point for a shape: measured - (base - n D - w L) = y + n D + w L (the offset not yet subtracted). */
  const resid = (p, n, w) => p.y + n * p.D + w * p.L;

  /**
   * Ridge least squares for (n, wallFactor) with the offsets profiled out (centred per band), exactly constrained to
   * the box. groups: arrays of points (one per band, all >= MIN_SHAPE); fitN / fitW false keep the prior value.
   */
  function solveShape(groups, prior, fitN, fitW) {
    let Sdd = 0;
    let Sdl = 0;
    let Sll = 0;
    let Sdy = 0;
    let Sly = 0;
    let Syy = 0;
    for (const g of groups) {
      let my = 0;
      let md = 0;
      let ml = 0;
      for (const p of g) {
        my += p.y;
        md += p.D;
        ml += p.L;
      }
      my /= g.length;
      md /= g.length;
      ml /= g.length;
      for (const p of g) {
        const y = p.y - my;
        const d = p.D - md;
        const l = p.L - ml;
        Sdd += d * d;
        Sdl += d * l;
        Sll += l * l;
        Sdy += d * y;
        Sly += l * y;
        Syy += y * y;
      }
    }
    const lamN = prior.lambdaN;
    const lamW = prior.lambdaW;
    const n0 = prior.n;
    const w0 = prior.wallFactor;
    const J = (n, w) => Syy + n * n * Sdd + w * w * Sll + 2 * n * Sdy + 2 * w * Sly + 2 * n * w * Sdl + lamN * (n - n0) * (n - n0) + lamW * (w - w0) * (w - w0);
    const bestN = (w) => (Sdd + lamN > 1e-12 ? clamp((-Sdy - w * Sdl + lamN * n0) / (Sdd + lamN), N_MIN, N_MAX) : n0);
    const bestW = (n) => (Sll + lamW > 1e-12 ? clamp((-Sly - n * Sdl + lamW * w0) / (Sll + lamW), WF_MIN, WF_MAX) : w0);
    if (!fitN && !fitW) return { n: n0, w: w0 };
    if (!fitN) return { n: n0, w: bestW(n0) };
    if (!fitW) return { n: bestN(w0), w: w0 };
    const a = Sdd + lamN;
    const b = Sdl;
    const d = Sll + lamW;
    const det = a * d - b * b;
    if (det > 1e-9 * (a * d + 1e-12)) {
      const n = ((-Sdy + lamN * n0) * d - b * (-Sly + lamW * w0)) / det;
      const w = (a * (-Sly + lamW * w0) - b * (-Sdy + lamN * n0)) / det;
      if (n >= N_MIN && n <= N_MAX && w >= WF_MIN && w <= WF_MAX) return { n, w };
    }
    // the optimum lies on the boundary: best of the four edges (each a clamped 1-D optimum of a convex quadratic)
    const cands = [
      [N_MIN, bestW(N_MIN)],
      [N_MAX, bestW(N_MAX)],
      [bestN(WF_MIN), WF_MIN],
      [bestN(WF_MAX), WF_MAX],
    ];
    let best = cands[0];
    let bj = J(best[0], best[1]);
    for (let i = 1; i < cands.length; i++) {
      const j = J(cands[i][0], cands[i][1]);
      if (j < bj - 1e-12) {
        bj = j;
        best = cands[i];
      }
    }
    return { n: best[0], w: best[1] };
  }

  /** Spans of D and L over the alive points of the shape bands -> which shape parameters the data can tell. */
  function spans(groups) {
    let sd = 0;
    let sl = 0;
    for (const g of groups) {
      let d0 = Infinity;
      let d1 = -Infinity;
      let l0 = Infinity;
      let l1 = -Infinity;
      for (const p of g) {
        d0 = Math.min(d0, p.D);
        d1 = Math.max(d1, p.D);
        l0 = Math.min(l0, p.L);
        l1 = Math.max(l1, p.L);
      }
      sd = Math.max(sd, d1 - d0);
      sl = Math.max(sl, l1 - l0);
    }
    return { fitN: sd >= SPAN_D, fitW: sl >= SPAN_L };
  }

  /** Mean (>= 4 points of the band, the robust rule's estimator) or median of values. */
  const centre = (vals, many) => {
    if (!vals.length) return 0;
    if (!many) return median(vals);
    let s = 0;
    for (const v of vals) s += v;
    return s / vals.length;
  };
  const rmsOf = (errs) => (errs.length ? Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length) : null);

  /**
   * Strength of the ridge for these points: lambda = sigma^2 / tau^2 with the measurement scatter sigma estimated
   * from the data and the prior scatter together (sigma^2 = (nu0 sigma0^2 + SSR) / (nu0 + N - p), clamped 1..8 dB) -
   * a few points keep the 4 dB assumption (a strong pull towards the defaults), many consistent points earn a weak
   * one. A prior with fixed lambdas (opts.prior.lambdaN / lambdaW) is used as given.
   */
  function lambdas(groups, prior, fitN, fitW) {
    if (prior.fixed) return prior;
    const first = { ...prior, lambdaN: (prior.sigma0 * prior.sigma0) / (prior.tauN * prior.tauN), lambdaW: (prior.sigma0 * prior.sigma0) / (prior.tauW * prior.tauW) };
    const s = solveShape(groups, first, fitN, fitW);
    let ssr = 0;
    let cnt = 0;
    for (const g of groups) {
      let m = 0;
      for (const p of g) m += resid(p, s.n, s.w);
      m /= g.length;
      for (const p of g) ssr += (resid(p, s.n, s.w) - m) * (resid(p, s.n, s.w) - m);
      cnt += g.length;
    }
    const dof = Math.max(0, cnt - groups.length - (fitN ? 1 : 0) - (fitW ? 1 : 0));
    const sig2 = clamp((prior.nu0 * prior.sigma0 * prior.sigma0 + ssr) / (prior.nu0 + dof), SIG_MIN * SIG_MIN, SIG_MAX * SIG_MAX);
    return { ...prior, sigma: Math.sqrt(sig2), lambdaN: sig2 / (prior.tauN * prior.tauN), lambdaW: sig2 / (prior.tauW * prior.tauW) };
  }

  /**
   * Fit the calibration (SPEC 9).
   * @param {object} ctx model.createContext(project) - a fitted context is fine (its fit is ignored: the losses are
   *        divided by ctx.wf, the prior is ctx.p.baseN)
   * @param {Array<object>} measurements project.measurements (speed-only points without a value are ignored)
   * @param {{baseline:{x,y}, band?:2.4|5|6, device?:string, soften?:number,
   *          prior?:{n?, wallFactor?, sigma0?, tauN?, tauW?, nu0?, lambdaN?, lambdaW?}}} opts
   *        band: fit only that band (default: every band with points); device: preferred device like calibrate();
   *        prior: centre of the ridge (default model.n and 1) and its strength: lambda = sigma^2 / tau^2 with the scatter
   *        sigma estimated from the data and sigma0 (see lambdas(); defaults FIT.SIGMA0, TAU_N, TAU_W, NU0), or fixed
   *        lambdaN AND lambdaW
   * @returns {{byBand:Object<string,{offset:number, n?:number, rms:number, looRms:number|null, count:number, total:number,
   *            outliers:string[], method:'offset'|'offset+n+walls', fallback:boolean,
   *            before:{offset:number, rms:number, looRms:number|null}}>,
   *            n:number, wallFactor:number, count:number, total:number, method:'offset'|'offset+n+walls',
   *            fitted:{n:boolean, wallFactor:boolean}, prior:{n, wallFactor, sigma, lambdaN, lambdaW}}}
   *   count = points used (outliers excluded), total = points considered; rms = scatter of the used points around the
   *   fitted model, looRms = leave-one-out error (null with < 2 points); before = the same points with the default model
   *   (model.n, walls x 1) and the plain median offset - "it was off by ±9 dB, now ±3 dB".
   */
  function fitCalibration(ctx, measurements, opts) {
    const o = opts || {};
    if (!o.baseline || !isNum(o.baseline.x) || !isNum(o.baseline.y)) throw new RangeError('model.fitCalibration: baseline is required');
    const pr = o.prior || {};
    const baseN = isNum(ctx.p.baseN) ? ctx.p.baseN : ctx.p.n;
    const pos = (v, def) => (isNum(v) && v > 0 ? v : def);
    const fixed = isNum(pr.lambdaN) && pr.lambdaN >= 0 && isNum(pr.lambdaW) && pr.lambdaW >= 0;
    const prior = {
      n: clamp(isNum(pr.n) ? pr.n : baseN, N_MIN, N_MAX),
      wallFactor: clamp(isNum(pr.wallFactor) ? pr.wallFactor : 1, WF_MIN, WF_MAX),
      sigma0: pos(pr.sigma0, SIGMA0),
      tauN: pos(pr.tauN, TAU_N),
      tauW: pos(pr.tauW, TAU_W),
      nu0: isNum(pr.nu0) && pr.nu0 >= 0 ? pr.nu0 : NU0,
      fixed,
      lambdaN: fixed ? pr.lambdaN : null,
      lambdaW: fixed ? pr.lambdaW : null,
    };
    const want = o.band !== undefined && o.band !== null ? units.normBand(o.band) : null;
    const bands = want !== null ? [want] : o.band !== undefined && o.band !== null ? [] : E.BANDS.slice();
    const per = [];
    let total = 0;
    for (const b of bands) {
      const r = pointsOf(ctx, measurements, b, o);
      if (!r.pts.length) continue;
      per.push({ band: b, key: units.bandKey(b), pts: r.pts, fallback: r.fallback, alive: new Uint8Array(r.pts.length).fill(1), removed: 0 });
      total += r.pts.length;
    }
    const priorOut = (lam) => ({ n: prior.n, wallFactor: prior.wallFactor, sigma: lam && isNum(lam.sigma) ? lam.sigma : null, lambdaN: lam ? lam.lambdaN : null, lambdaW: lam ? lam.lambdaW : null });
    const empty = { byBand: {}, n: prior.n, wallFactor: prior.wallFactor, count: 0, total: 0, method: 'offset', fitted: { n: false, wallFactor: false }, prior: priorOut(null) };
    if (!total) return empty;

    const aliveOf = (e) => e.pts.filter((_, i) => e.alive[i]);
    const measuredOnly = (g) => g.filter((p) => !p.inferred);
    const shapeOf = () => {
      const groups = per.map((e) => measuredOnly(aliveOf(e))).filter((g) => g.length >= MIN_SHAPE);
      if (!groups.length) return { n: prior.n, w: prior.wallFactor, fitN: false, fitW: false, groups, lam: null };
      const sp = spans(groups);
      const lam = lambdas(groups, prior, sp.fitN, sp.fitW);
      const s = solveShape(groups, lam, sp.fitN, sp.fitW);
      return { n: s.n, w: s.w, fitN: sp.fitN, fitW: sp.fitW, groups, lam };
    };

    // ---- joint fit with outlier rejection (worst first, refit after each) ----
    let shape = shapeOf();
    for (let guard = 0; guard < total; guard++) {
      let worst = null;
      let wd = model.OUTLIER_DB;
      for (const e of per) {
        const m = e.pts.length;
        const cap = m >= 4 ? Math.max(1, Math.floor(m / 4)) : m === 3 ? 1 : 0;
        if (e.removed >= cap) continue;
        const live = aliveOf(e);
        const rs = live.map((p) => resid(p, shape.n, shape.w));
        const off = centre(rs, m >= MIN_SHAPE);
        e.pts.forEach((p, i) => {
          if (!e.alive[i]) return;
          const dev = Math.abs(resid(p, shape.n, shape.w) - off);
          if (dev > wd) {
            wd = dev;
            worst = { e, i };
          }
        });
      }
      if (!worst) break;
      worst.e.alive[worst.i] = 0;
      worst.e.removed++;
      shape = shapeOf();
    }
    const n = shape.n;
    const w = shape.w;

    // ---- final per-band numbers: the live rule (robustOffset) at the final shape ----
    const byBand = {};
    let count = 0;
    const shapeFitted = shape.fitN || shape.fitW;
    const finals = per.map((e) => {
      const rs = e.pts.map((p) => resid(p, n, w));
      const r = model.robustOffset(
        rs,
        e.pts.map((p) => p.key),
        e.pts.map((p) => p.w),
      );
      const out = new Set(r.outliers);
      const inl = e.pts.filter((_, i) => !out.has(i));
      return { e, r, out, inl, shp: measuredOnly(inl) };
    });
    const shapeGroups = finals.filter((f) => shapeFitted && f.shp.length >= MIN_SHAPE).map((f) => f.shp);
    for (const f of finals) {
      const { e, r, out, inl, shp } = f;
      const many = e.pts.length >= MIN_SHAPE;
      const inShape = shapeFitted && shp.length >= MIN_SHAPE;
      // leave-one-out: refit the shape without the point (same parameters fitted), then predict it
      const loo = [];
      if (inl.length >= 2) {
        for (let j = 0; j < inl.length; j++) {
          const rest = inl.filter((_, k) => k !== j);
          let nn = n;
          let ww = w;
          if (inShape) {
            const groups = shapeGroups.map((g) => (g === shp ? measuredOnly(rest) : g)).filter((g) => g.length);
            const s = solveShape(groups, shape.lam || prior, shape.fitN, shape.fitW);
            nn = s.n;
            ww = s.w;
          }
          const off = centre(
            rest.map((p) => resid(p, nn, ww)),
            many,
          );
          loo.push(resid(inl[j], nn, ww) - off);
        }
      }
      // the default model on the same points: n = model.n, walls x 1, plain median offset
      const n0 = clamp(baseN, N_MIN, N_MAX);
      const r0 = inl.map((p) => resid(p, n0, 1));
      const off0 = median(r0);
      const loo0 = [];
      if (r0.length >= 2) for (let j = 0; j < r0.length; j++) loo0.push(r0[j] - median(r0.filter((_, k) => k !== j)));
      const entry = {
        offset: r.offset,
        rms: r.rms,
        looRms: rmsOf(loo),
        count: inl.length,
        total: e.pts.length,
        outliers: e.pts.filter((_, i) => out.has(i)).map((p) => p.id),
        method: inShape ? 'offset+n+walls' : 'offset',
        fallback: e.fallback,
        before: { offset: off0, rms: rmsOf(r0.map((v) => v - off0)) || 0, looRms: rmsOf(loo0) },
      };
      if (inShape) entry.n = n;
      byBand[e.key] = entry;
      count += inl.length;
    }
    return {
      byBand,
      n,
      wallFactor: w,
      count,
      total,
      method: shapeFitted && shapeGroups.length ? 'offset+n+walls' : 'offset',
      fitted: { n: shape.fitN && shapeGroups.length > 0, wallFactor: shape.fitW && shapeGroups.length > 0 },
      prior: priorOut(shape.lam),
    };
  }

  /** Measurements a fit of these bands looks at (numeric value), as a short order-independent signature. */
  function fitSignature(project, bands) {
    const keys = new Set((bands || E.BANDS).map((b) => units.bandKey(b)));
    // points without a known band (SPEC 13) may land on any band: every signature watches them
    const unknown = (m) => m.band === null || units.normBandMode(m.band) === 'auto';
    const rows = (project.measurements || [])
      .filter((m) => m && isNum(m.value) && (unknown(m) || (units.normBand(m.band) !== null && keys.has(units.bandKey(m.band)))))
      .map((m) => [m.id, unknown(m) ? 'auto' : units.bandKey(m.band), m.value, m.x, m.y, model.profileKey(m.device)].join('|'))
      .sort();
    const bl = project.net && project.net.baseline ? `${project.net.baseline.x},${project.net.baseline.y}` : '';
    let a = 0x811c9dc5 | 0;
    let b = 0x1b873593 | 0;
    const text = `${bl}#${rows.join('\n')}`;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619);
      b = Math.imul((b + c + 0x9e3779b9) | 0, 0x85ebca6b) ^ (b >>> 13);
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }

  /**
   * fitCalibration() on a project, as the object to store in project.model.fit (already sanitized):
   *   store.commit('fit', (p) => { const f = WH.engine.model.fitProject(p, { band }); if (f) p.model.fit = f; }, ['model'])
   * Uses the DEFAULT model of the project (any existing fit is ignored), net.baseline, goal.device. null when there is
   * no measured signal to fit (nothing to store).
   * @param {object} project
   * @param {{band?:2.4|5|6, device?:string, soften?:number, prior?:object, at?:number}} [opts] at = timestamp (default now)
   * @returns {object|null} {n, wallFactor, method, count, at, fitted, sig, byBand:{...}} - see project.cleanFit
   */
  function fitProject(project, opts) {
    const o = opts || {};
    const ctx = model.createContext(project, { fit: false });
    const device = o.device !== undefined ? o.device : project.goal && project.goal.device;
    // points without a known band take part on their inferred band (SPEC 13; lower weight, no say in the shape)
    const list = model.resolveBands(ctx, project, { soften: o.soften });
    const r = fitCalibration(ctx, list, { band: o.band, baseline: project.net.baseline, device, soften: o.soften, prior: o.prior });
    if (!r.total) return null;
    const bands = Object.keys(r.byBand).map(Number);
    return E.project.cleanFit({ ...r, at: isNum(o.at) ? o.at : Date.now(), sig: fitSignature(project, bands) });
  }

  /**
   * True when the measurements of the bands a stored fit was made from changed since (added, removed, moved, other
   * values, other baseline) - offer "Přepočítat" / refit. False without a fit or without a signature.
   */
  function fitStale(project) {
    const f = project && project.model && project.model.fit;
    if (!f || typeof f.sig !== 'string' || !f.byBand) return false;
    const bands = Object.keys(f.byBand).map(Number);
    return fitSignature(project, bands) !== f.sig;
  }

  Object.assign(model, { fitCalibration, fitProject, fitStale, fitSignature, FIT });
})();
