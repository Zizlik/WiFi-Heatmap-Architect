/* Planner (Wi-Fi view) 1/3: shared state, the compute pipeline (coarse while dragging, full quality when settled)
 * and the canvas scene renderer used for the screen and for the PNG export.  Everything lives in WH.planner. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const W = 1080;
  const H = 942;
  PL.W = W;
  PL.H = H;
  const S = (PL.S = {
    visible: false, tool: 'router', ctx: null, geomDirty: true, offs: null, cal: null, offsKey: '', measVer: 0, planVer: 0,
    a: null, q: null, sp: null, mode: 'signal', dim: false, heat: null, heatCell: 4, hatch: null, cont: null, contKey: '',
    cacheF: {}, cacheC: {}, bufC: null, rgba: {}, frame: null, stale: true,
  });
  const t = (k, p) => WH.i18n.t(k, p);
  PL.t = t;
  const subs = new Set();
  PL.on = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  const notify = (q) => subs.forEach((fn) => { try { fn(q); } catch (e) { console.error('[planner]', e); } });

  // ---------------------------------------------------------------------------------------------------------------
  // small helpers shared by all planner files
  // ---------------------------------------------------------------------------------------------------------------
  PL.P = () => WH.store.project;
  PL.same = (a, b) => !!a && !!b && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  PL.moved = () => !PL.same(PL.P().net.router, PL.P().net.baseline);
  /** Stable text key of a position (what the "today's position is confirmed" pref remembers). */
  PL.posKey = (q) => `${PL.r6(q.x)},${PL.r6(q.y)}`;
  /** Today's position was confirmed by the user - for THIS baseline (old prefs stored plain `true`). */
  PL.baselineOk = () => { const v = WH.store.getPref('planner.baselineOk'); return v === true || v === PL.posKey(PL.P().net.baseline); };
  PL.distM = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) * PL.P().scale.mpp;
  PL.r6 = (v) => Math.round(v * 1e6) / 1e6;
  PL.pt = (q) => ({ x: PL.r6(q.x), y: PL.r6(q.y) });
  PL.roomAt = (p) => WH.engine.project.roomAt(PL.P().plan, p);
  PL.roomName = (id) => { const r = PL.P().plan.rooms.find((x) => x.roomId === id); return r ? r.name : ''; };
  PL.qKey = (dbm) => WH.engine.units.qualityOf(dbm).key;
  PL.qWord = (dbm) => t('planner.q.' + PL.qKey(dbm));
  PL.qVar = (dbm) => `var(--q-${PL.qKey(dbm)})`;
  /** "+6" / "−6" / "0" (rounded, never "−0"). */
  PL.signed = (n, d = 0) => { const k = 10 ** d; const r = Math.round(n * k) / k || 0; return (r > 0 ? '+' : '') + WH.util.fmt(r, d); };
  PL.db = (n) => PL.signed(n) + WH.util.NBSP + 'dB';
  PL.m = (n, d = 1) => WH.util.fmt(n, d) + WH.util.NBSP + 'm';
  PL.band = (b) => t(b === 2.4 ? 'planner.band.b24' : 'planner.band.b' + b);
  PL.mbps = (n) => WH.engine.units.formatMbps(n, WH.i18n.lang);
  /**
   * Obstacle loss (dB) between a and b on a band - softened like the map, band-dependent wall losses (SPEC 7.1);
   * NaN when the engine has no per-band API yet.
   */
  PL.pathLoss = (a, b, band) => {
    const M = WH.engine.model;
    if (!S.ctx || typeof M.forBand !== 'function') return NaN;
    try { return M.softObstacleLoss(S.ctx, a, b, undefined, band); } catch (e) { return NaN; }
  };
  PL.speedLimits = (p) => ({ wanDown: p.net.wanDown, wanUp: p.net.wanUp, wanPort: p.net.wanPort, ontPort: p.net.ontPort, wanLink: p.net.wanLink, reserve: p.goal.reserve });
  const col = (n) => WH.ui.cssVar(n);
  PL.col = col;
  /** Band factor of obstacle losses (SPEC 7.1: stored losses are the 5 GHz values): the engine's table, else the SPEC one. */
  PL.bandK = (b) => {
    const M = (WH.engine && WH.engine.model) || {};
    const tab = M.BAND_FACTOR || M.BAND_FACTORS || M.BAND_K || M.BAND_LOSS;
    const k = WH.engine.units.bandKey(b);
    const v = tab && (typeof tab === 'function' ? tab(b) : tab[k] !== undefined ? tab[k] : tab[b]);
    return Number.isFinite(v) ? v : { 2.4: 0.65, 5: 1, 6: 1.15 }[k] || 1;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // compute
  // ---------------------------------------------------------------------------------------------------------------
  /** Engine context + calibration offsets, rebuilt only when their inputs changed. */
  function ensureCtx(p) {
    const E = WH.engine;
    if (S.geomDirty || !S.ctx) { S.ctx = E.model.createContext(p); S.geomDirty = false; }
    const key = [S.ctx.version, p.net.baseline.x, p.net.baseline.y, S.measVer, p.measurements.length, p.goal.device, p.view.calibrate].join('|');
    if (key !== S.offsKey) {
      S.cal = E.model.calibrateAll(S.ctx, p);
      S.offs = { '2.4': 0, '5': 0, '6': 0 };
      if (p.view.calibrate !== false) for (const k of Object.keys(S.offs)) S.offs[k] = S.cal[k].offset;
      S.offsKey = key;
    }
    return S.ctx;
  }
  PL.ensureCtx = ensureCtx;

  /**
   * The measurements with a signal for every point: speed-test points without a measured signal (value null) get the
   * calibrated model's prediction at their spot (router at the baseline), flagged predictedSignal. Cached on the same
   * key as the calibration (geometry, baseline, measurements, device, calibration switch).
   */
  PL.filledMeasurements = () => {
    const p = PL.P();
    const ctx = ensureCtx(p);
    if (S.fillKey !== S.offsKey || !S.filled) {
      S.filled = WH.engine.speed.fillSignals(ctx, p.measurements, { baseline: p.net.baseline, offsets: S.offs });
      S.fillKey = S.offsKey;
    }
    return S.filled;
  };

  /**
   * Drag-frame analysis (cell 8, aa 1).  Same result shape as engine.analysis.run, but "today" together with its
   * statistics is cached across frames (analysis.run re-sorts today's cells for stats/perRoom on every call, which
   * is ~35 % of a frame on a real plan).
   */
  function runCoarse(p, ctx) {
    const E = WH.engine;
    const M = E.model;
    const R = E.raster;
    const grid = R.grid(ctx, { cell: 8 });
    const band = p.view.band;
    const params = {
      today: { ...M.fieldParams(p, 'today', { band, offsets: S.offs }), aa: 1 },
      trial: { ...M.fieldParams(p, 'trial', { band, offsets: S.offs }), aa: 1 },
    };
    const thr = p.model.threshold;
    const target = p.goal.room === 'all' ? null : [p.goal.room];
    const ex = p.goal.excluded;
    const key = [ctx.version, band, params.today.router.x, params.today.router.y, M.offsetFor(S.offs, band), thr, p.goal.room, ex.join(',')].join('|');
    let c = S.cacheC;
    if (c.key !== key) {
      const f = R.field(ctx, grid, params.today);
      c = S.cacheC = { key, today: f, stats: R.stats(grid, f, target, thr, ex), per: R.perRoom(grid, f, thr) };
    }
    const n = grid.cols * grid.rows;
    if (!S.bufC || S.bufC.length !== n) S.bufC = new Float32Array(n);
    const node = params.trial.node;
    let tr;
    if (!node && PL.same(params.trial.router, params.today.router)) { S.bufC.set(c.today); tr = { field: S.bufC, nodeWins: null }; }
    else tr = R.fieldEx(ctx, grid, params.trial, S.bufC);
    const q = quickStats(grid, tr.field, thr, target, ex);
    const backhaul = M.backhaulSignal(ctx, params.trial);
    return {
      ctx, grid, band, offsets: S.offs, threshold: thr, params, today: c.today, trial: tr.field, diff: R.diff(tr.field, c.today),
      nodeWins: tr.nodeWins, backhaul, weakBackhaul: !!(node && M.isWirelessNode(node) && backhaul !== null && backhaul < node.backhaulThreshold),
      targetRooms: target, stats: { today: c.stats, trial: q.stats }, perRoom: { today: c.per, trial: q.per },
      delta: { coverage: q.stats.coverage - c.stats.coverage, mean: q.stats.mean - c.stats.mean },
    };
  }

  /**
   * One pass over a drag-frame field: exact coverage + mean per room and for the target, median / p10 of the target
   * from a 0.25 dB histogram (raster.stats sorts every cell, too slow for 60 fps on big plans).  Per-room median/p10
   * are not needed while dragging and are left NaN.
   */
  const hist = new Uint32Array(361);
  function quickStats(g, f, thr, target, ex) {
    const want = target ? new Set(target) : null;
    const skip = ex && ex.length ? new Set(ex) : null;
    const per = new Map();
    hist.fill(0);
    let n = 0;
    let good = 0;
    let sum = 0;
    for (const id of g.roomIds) {
      const cells = g.roomCells.get(id);
      const inT = want ? want.has(id) : !(skip && skip.has(id));
      let c = 0;
      let gd = 0;
      let s = 0;
      for (let k = 0; k < cells.length; k++) {
        const v = f[cells[k]];
        if (v !== v) continue;
        c++;
        s += v;
        if (v >= thr) gd++;
        if (inT) hist[v <= -110 ? 0 : v >= -20 ? 360 : ((v + 110) * 4) | 0]++;
      }
      per.set(id, { coverage: c ? (100 * gd) / c : 0, mean: c ? s / c : -110, median: NaN, p10: NaN, n: c });
      if (inT) { n += c; good += gd; sum += s; }
    }
    const at = (fr) => {
      const k = Math.floor((n - 1) * fr) + 1;
      let acc = 0;
      for (let i = 0; i < 361; i++) { acc += hist[i]; if (acc >= k) return -110 + i / 4; }
      return -110;
    };
    const stats = n ? { coverage: (100 * good) / n, mean: sum / n, median: at(0.5), p10: at(0.1), n } : { coverage: 0, mean: -110, median: -110, p10: -110, n: 0 };
    return { stats, per };
  }

  function analyze(q) {
    const p = PL.P();
    if (!p) return;
    const t0 = performance.now();
    try {
      const ctx = ensureCtx(p);
      S.a = q === 'coarse' ? runCoarse(p, ctx) : WH.engine.analysis.run(p, { cell: 4, aa: 2, ctx, offsets: S.offs, cache: S.cacheF });
      S.q = q;
      const t1 = performance.now();
      derive(true);
      const t2 = performance.now();
      PL.draw();
      S.frame = { q, compute: t2 - t0, analysis: t1 - t0, draw: performance.now() - t2, total: performance.now() - t0 };
    } catch (e) {
      console.error('[planner] computation failed', e);
      return;
    }
    notify(q);
  }

  /** Everything that follows from the analysis without new fields: speed, colours, hatch, range lines. */
  function derive(noDraw) {
    const p = PL.P();
    const a = S.a;
    if (!a || !p) return;
    const E = WH.engine;
    const v = p.view;
    const g = a.grid;
    let sp = null;
    if (v.layer === 'speed') {
      const o = { band: a.band, device: p.goal.device };
      const meas = PL.filledMeasurements();
      const curve = E.speed.buildCurve(meas, o);
      const sf = E.speed.fieldSpeed(a.ctx, g, a.params.trial, curve, PL.speedLimits(p), a.trial);
      sp = { curve, reason: sf.reason, diag: E.speed.diagnose(meas, o) };
      if (sf.supported) {
        const gl = p.goal;
        sp.ratio = E.speed.ratioField(g, sf, gl.targetDown, gl.targetUp);
        sp.stats = E.speed.stats(g, sf, { roomIds: a.targetRooms, excluded: gl.excluded, targetDown: gl.targetDown, targetUp: gl.targetUp });
      }
    }
    S.sp = sp;
    const mode = sp ? (sp.ratio ? 'speed' : 'signal') : v.layer === 'diff' ? 'diff' : 'signal';
    S.mode = mode;
    S.dim = !!sp && !sp.ratio;
    const field = mode === 'speed' ? sp.ratio : mode === 'diff' ? a.diff : a.trial;
    const n = g.cols * g.rows * 4;
    const img = E.raster.colorize(g, field, { palette: v.palette, mode, target: S.rgba[n] || (S.rgba[n] = new Uint8ClampedArray(n)) });
    let cv = S.heat;
    if (!cv || cv.width !== g.cols || cv.height !== g.rows) {
      cv = document.createElement('canvas');
      cv.width = g.cols;
      cv.height = g.rows;
    }
    cv.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    S.heat = cv;
    S.heatCell = g.cell;
    // hatch where the second node wins but its wireless uplink is weak
    S.hatch = null;
    if (a.weakBackhaul && a.nodeWins && mode !== 'speed') {
      const path = new Path2D();
      let any = false;
      const c = g.cell;
      for (let r = 0; r < g.rows; r++) {
        let s = -1;
        for (let k = 0; k <= g.cols; k++) {
          const on = k < g.cols && a.nodeWins[r * g.cols + k] === 1;
          if (on && s < 0) s = k;
          else if (!on && s >= 0) { path.rect(s * c, r * c, (k - s) * c, c); any = true; s = -1; }
        }
      }
      if (any) S.hatch = path;
    }
    // range lines: one dashed iso-line per band at model.rangeThreshold (lower resolution while dragging)
    S.cont = null;
    if (v.ranges) {
      const st = a.params.trial;
      const key = [a.ctx.version, st.router.x, st.router.y, JSON.stringify(st.node), JSON.stringify(S.offs), p.model.rangeThreshold, S.q].join('|');
      if (key !== S.contKey) {
        const res = S.q === 'coarse' ? [60, 52] : [120, 104];
        S.contAll = {};
        for (const b of E.BANDS) S.contAll[b] = E.raster.contours(a.ctx, { band: b, router: st.router, node: st.node, offsets: S.offs, threshold: p.model.rangeThreshold, res });
        S.contKey = key;
      }
      S.cont = S.contAll;
    }
    if (!noDraw) { PL.draw(); notify('derive'); }
  }
  PL.derive = derive;

  let raf = 0;
  let fullTimer = 0;
  /** Something changed: coarse picture on the next frame, full quality 120 ms after the last change. */
  PL.invalidate = (discrete) => {
    if (!S.visible) { S.stale = true; return; }
    if (discrete) {
      // a one-off change (button, select, undo): go straight to full quality on the next frame
      clearTimeout(fullTimer);
      fullTimer = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; analyze('full'); });
      return;
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; analyze('coarse'); });
    clearTimeout(fullTimer);
    fullTimer = setTimeout(() => {
      fullTimer = 0;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      analyze('full');
    }, 120);
  };
  PL.computeNow = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    clearTimeout(fullTimer);
    fullTimer = 0;
    S.stale = false;
    analyze('full');
  };
  PL.analyze = analyze;

  // ---------------------------------------------------------------------------------------------------------------
  // geometry for drawing (cached per plan version)
  // ---------------------------------------------------------------------------------------------------------------
  let geoKey = '';
  let geo = null;
  const labelCache = new Map();

  function chord(pts, x, y, horiz) {
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      const ay = horiz ? a.y * H : a.x * W;
      const by = horiz ? b.y * H : b.x * W;
      const v = horiz ? y : x;
      if (ay > v !== by > v) {
        const ax = horiz ? a.x * W : a.y * H;
        const bx = horiz ? b.x * W : b.y * H;
        xs.push(ax + ((v - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((m, n) => m - n);
    const u = horiz ? x : y;
    for (let i = 0; i + 1 < xs.length; i += 2) if (u >= xs[i] && u <= xs[i + 1]) return xs[i + 1] - xs[i];
    return 0;
  }

  function geometry(p) {
    const key = S.planVer + '|' + p.model.wallLoss;
    if (geo && key === geoKey) return geo;
    const plan = p.plan;
    const G = WH.engine.geom;
    const ok = (q) => q && Number.isFinite(q.x) && Number.isFinite(q.y);
    const rooms = new Path2D();
    const labels = [];
    const seen = new Set();
    for (const r of plan.rooms) {
      const pts = r.points;
      if (!Array.isArray(pts) || pts.length < 3 || !pts.every(ok)) continue;
      let area = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      const seq = area < 0 ? pts.slice().reverse() : pts; // same orientation everywhere: nonzero fill = union
      seq.forEach((q, i) => (i ? rooms.lineTo(q.x * W, q.y * H) : rooms.moveTo(q.x * W, q.y * H)));
      rooms.closePath();
      // the label anchor (pole of inaccessibility) is the expensive part: cache it per outline
      const sig = pts.map((q) => q.x + ',' + q.y).join(';');
      let L = labelCache.get(sig);
      if (!L) {
        const lp = G.labelPoint(pts);
        const x = lp.x * W;
        const y = lp.y * H;
        L = { x, y, cw: chord(pts, x, y, true), ch: chord(pts, x, y, false) };
        labelCache.set(sig, L);
      }
      seen.add(sig);
      labels.push({ id: r.roomId, name: r.name, x: L.x, y: L.y, cw: L.cw, ch: L.ch, pts });
    }
    const walls = [new Path2D(), new Path2D(), new Path2D()];
    const doors = [];
    const byWall = new Map();
    for (const d of plan.doors) if (d && ok(d.a) && ok(d.b)) (byWall.get(d.wallId) || byWall.set(d.wallId, []).get(d.wallId)).push(d);
    for (const w of plan.walls) {
      if (!w || !ok(w.a) || !ok(w.b)) continue;
      const ax = w.a.x * W;
      const ay = w.a.y * H;
      const dx = w.b.x * W - ax;
      const dy = w.b.y * H - ay;
      const l2 = dx * dx + dy * dy;
      if (l2 < 0.25) continue;
      const M = WH.engine.model;
      const loss = typeof M.obstacleLossFor === 'function' ? M.obstacleLossFor(w, 5, p) : Number.isFinite(w.loss) ? w.loss : p.model.wallLoss;
      // same classes as the editor's wall weights (5 GHz scale): drywall / glass / wood | brick, masonry | concrete and up
      const path = walls[loss <= 5 ? 0 : loss <= 16 ? 1 : 2];
      const len = Math.sqrt(l2);
      const iv = [];
      for (const d of byWall.get(w.id) || []) {
        const ta = ((d.a.x * W - ax) * dx + (d.a.y * H - ay) * dy) / l2;
        const tb = ((d.b.x * W - ax) * dx + (d.b.y * H - ay) * dy) / l2;
        const s = Math.max(0, Math.min(ta, tb));
        const e = Math.min(1, Math.max(ta, tb));
        if (e <= s) continue;
        iv.push([s, e]);
        doors.push({ ax: ax + dx * s, ay: ay + dy * s, bx: ax + dx * e, by: ay + dy * e, nx: -dy / len, ny: dx / len, closed: Number(d.loss) > 0 });
      }
      iv.sort((m, n) => m[0] - n[0]);
      let t0 = 0;
      const seg = (s, e) => { path.moveTo(ax + dx * s, ay + dy * s); path.lineTo(ax + dx * e, ay + dy * e); };
      for (const [s, e] of iv) { if (s > t0) seg(t0, s); t0 = Math.max(t0, e); }
      if (t0 < 1) seg(t0, 1);
    }
    let furn = null;
    for (const f of plan.furniture) {
      if (!f || !Array.isArray(f.points) || f.points.length < 3 || !f.points.every(ok)) continue;
      furn = furn || new Path2D();
      f.points.forEach((q, i) => (i ? furn.lineTo(q.x * W, q.y * H) : furn.moveTo(q.x * W, q.y * H)));
      furn.closePath();
    }
    for (const k of [...labelCache.keys()]) if (!seen.has(k)) labelCache.delete(k);
    geo = { rooms, labels, walls, doors, furn, hasRooms: labels.length > 0 };
    geoKey = key;
    return geo;
  }
  PL.geometry = geometry;

  // ---------------------------------------------------------------------------------------------------------------
  // patterns (cached per theme and device-pixel ratio)
  // ---------------------------------------------------------------------------------------------------------------
  const patCache = new Map();
  PL.resetPatterns = () => patCache.clear();
  function pattern(c, colour, step, width, dpr) {
    const key = colour + step + width + dpr;
    let cv = patCache.get(key);
    if (!cv) {
      const n = Math.max(2, Math.round(step * dpr));
      cv = document.createElement('canvas');
      cv.width = n;
      cv.height = n;
      const g = cv.getContext('2d');
      g.strokeStyle = colour;
      g.lineWidth = width * dpr;
      g.beginPath();
      g.moveTo(-1, n + 1); g.lineTo(n + 1, -1);
      g.moveTo(-1, 1); g.lineTo(1, -1);
      g.moveTo(n - 1, n + 1); g.lineTo(n + 1, n - 1);
      g.stroke();
      patCache.set(key, cv);
    }
    return c.createPattern(cv, 'repeat');
  }

  let fontFam = '';
  const font = () => fontFam || (fontFam = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif');
  PL.font = font;
  PL.BAND_VAR = { 2.4: '--pl-range-24', 5: '--pl-range-5', 6: '--pl-range-6' };
  /** Dash pattern of each band's range line (CSS px): long dashes, short dashes, dots - told apart without colour too. */
  PL.BAND_DASH = { 2.4: [12, 5], 5: [6, 4], 6: [0.5, 4.5] };

  // ---------------------------------------------------------------------------------------------------------------
  // the canvas under the plan (SPEC 7.5): a world-space dot grid like a design tool and the plan as a sheet with a
  // faint shadow.  Rendered into one cached layer that only changes with the view (pan / zoom / resize), the plan
  // outline or the theme - while the router is dragged it is a single drawImage.
  // ---------------------------------------------------------------------------------------------------------------
  const dark = () => !!(WH.ui.theme && WH.ui.theme.effective && WH.ui.theme.effective() === 'dark');
  /** Shell token, else the SPEC 7.5 value (the tokens may not exist in every build). */
  const tok = (name, light, darkV) => col(name) || (dark() ? darkV : light);
  /** Dot spacing levels in metres (1-2-5 steps); every 5th dot in both directions is a "major" dot. */
  const DOT_LEVELS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  PL.dotLevel = (pxPerMetre) => DOT_LEVELS.find((l) => l * pxPerMetre >= 14) || DOT_LEVELS[DOT_LEVELS.length - 1];
  let back = null;
  let backKey = '';
  function backdrop(o, G, p) {
    const bw = Math.round(o.w * o.dpr);
    const bh = Math.round(o.h * o.dpr);
    const dot = tok('--stage-dot', 'rgba(19,35,58,.13)', 'rgba(231,238,250,.10)');
    const major = tok('--stage-dot-major', 'rgba(19,35,58,.21)', 'rgba(231,238,250,.16)');
    const shadow = tok('--stage-sheet-shadow', 'rgba(19,35,58,.16)', 'rgba(0,0,0,.5)');
    const room = col('--map-room');
    const key = [bw, bh, o.dpr, o.s, o.tx, o.ty, p.scale.mpp, S.planVer, dot, major, shadow, room].join('|');
    if (back && key === backKey) return back;
    if (!back) back = document.createElement('canvas');
    if (back.width !== bw || back.height !== bh) { back.width = bw; back.height = bh; }
    const c = back.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, bw, bh);
    // dots: CSS px spacing between ~14 and ~35 at any zoom, snapped to device pixels (crisp, no moire)
    const pxM = o.s / p.scale.mpp;
    const L = PL.dotLevel(pxM);
    const sp = L * pxM;
    const dpr = o.dpr;
    const dMin = Math.max(1, Math.round(1.25 * dpr));
    const dMaj = Math.max(2, Math.round(1.75 * dpr));
    const i0 = Math.ceil(-o.tx / sp - 0.5);
    const i1 = Math.floor((o.w - o.tx) / sp + 0.5);
    const j0 = Math.ceil(-o.ty / sp - 0.5);
    const j1 = Math.floor((o.h - o.ty) / sp + 0.5);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) < 40000) {
      const minor = new Path2D();
      const big = new Path2D();
      for (let j = j0; j <= j1; j++) {
        const y = Math.round((o.ty + j * sp) * dpr);
        for (let i = i0; i <= i1; i++) {
          const x = Math.round((o.tx + i * sp) * dpr);
          if (i % 5 === 0 && j % 5 === 0) big.rect(x - (dMaj >> 1), y - (dMaj >> 1), dMaj, dMaj);
          else minor.rect(x - (dMin >> 1), y - (dMin >> 1), dMin, dMin);
        }
      }
      c.fillStyle = dot;
      c.fill(minor);
      c.fillStyle = major;
      c.fill(big);
    }
    // the plan as a sheet lying on the canvas
    if (G.hasRooms) {
      c.setTransform(o.s * dpr, 0, 0, o.s * dpr, o.tx * dpr, o.ty * dpr);
      c.shadowColor = shadow;
      c.shadowBlur = 18 * dpr;
      c.shadowOffsetY = 4 * dpr;
      c.fillStyle = room;
      c.fill(G.rooms);
      c.shadowColor = 'transparent';
    }
    backKey = key;
    return back;
  }

  /**
   * Draw the map.  o = {s, tx, ty, dpr, w, h, z (zoom relative to "fit"), bg?}; s/tx/ty map world px to CSS px.
   */
  function drawScene(c, o) {
    const p = PL.P();
    const v = p.view;
    const s = o.s;
    const k = s * o.dpr;
    c.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
    c.clearRect(0, 0, o.w, o.h);
    if (o.bg) { c.fillStyle = o.bg; c.fillRect(0, 0, o.w, o.h); }
    const G = geometry(p);
    // screen: dot grid + plan sheet from the cached layer; the PNG export keeps a plain background
    const bd = o.bg ? null : backdrop(o, G, p);
    if (bd) { c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(bd, 0, 0); }
    if (!G.hasRooms && !p.plan.walls.length) return;
    c.setTransform(k, 0, 0, k, o.tx * o.dpr, o.ty * o.dpr);
    const px = 1 / s;
    const zf = Math.min(2, Math.max(0.8, Math.sqrt(o.z || 1)));
    if (!bd) { c.fillStyle = col('--map-room'); c.fill(G.rooms); }
    const a = S.a;
    if (a && S.heat && G.hasRooms) {
      c.save();
      c.clip(G.rooms);
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.globalAlpha = S.dim ? 0.28 : 1;
      c.drawImage(S.heat, 0, 0, S.heat.width * S.heatCell, S.heat.height * S.heatCell);
      c.globalAlpha = 1;
      if (S.hatch) {
        c.save();
        c.clip(S.hatch);
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = pattern(c, col('--map-wall'), 7, 1.6, o.dpr);
        c.globalAlpha = 0.6;
        c.fillRect(0, 0, o.w * o.dpr, o.h * o.dpr);
        c.restore();
      }
      if (S.cont) {
        c.lineJoin = 'round';
        c.lineCap = 'round';
        for (const b of WH.engine.BANDS) {
          const path = new Path2D();
          for (const ch of S.cont[b] || []) ch.forEach((q, i) => (i ? path.lineTo(q.x * W, q.y * H) : path.moveTo(q.x * W, q.y * H)));
          c.setLineDash([]);
          c.strokeStyle = col('--map-halo');
          c.lineWidth = 4 * px;
          c.globalAlpha = 0.7;
          c.stroke(path);
          c.globalAlpha = 1;
          c.setLineDash(PL.BAND_DASH[b].map((v) => v * px));
          c.strokeStyle = col(PL.BAND_VAR[b]);
          c.lineWidth = 2 * px;
          c.stroke(path);
        }
        c.setLineDash([]);
      }
      c.restore();
    }
    c.lineWidth = px;
    c.strokeStyle = col('--map-room-line');
    c.stroke(G.rooms);
    if (v.furniture && G.furn) {
      const pat = pattern(c, col('--map-furniture'), 6, 1, o.dpr);
      if (pat.setTransform) pat.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
      c.fillStyle = pat;
      c.globalAlpha = 0.5;
      c.fill(G.furn);
      c.globalAlpha = 0.85;
      c.strokeStyle = col('--map-furniture');
      c.lineWidth = px;
      c.stroke(G.furn);
      c.globalAlpha = 1;
    }
    if (v.walls) {
      c.lineCap = 'round';
      c.strokeStyle = col('--map-wall');
      [2, 3.2, 4.6].forEach((wd, i) => { c.lineWidth = wd * zf * px; c.stroke(G.walls[i]); });
      if (G.doors.length) {
        const L = 5.5 * zf * px;
        const ticks = new Path2D();
        const shut = new Path2D();
        for (const d of G.doors) {
          for (const [x, y] of [[d.ax, d.ay], [d.bx, d.by]]) { ticks.moveTo(x - d.nx * L, y - d.ny * L); ticks.lineTo(x + d.nx * L, y + d.ny * L); }
          if (d.closed) { shut.moveTo(d.ax, d.ay); shut.lineTo(d.bx, d.by); }
        }
        c.strokeStyle = col('--accent');
        c.lineWidth = 2.2 * px;
        c.stroke(ticks);
        c.setLineDash([3 * px, 3 * px]);
        c.lineWidth = 1.4 * px;
        c.stroke(shut);
        c.setLineDash([]);
      }
    }
    if ((v.labels || v.values) && G.labels.length) {
      c.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      const fam = font();
      const per = v.values && a ? a.perRoom.trial : null;
      const base = Math.min(16, 13.5 * zf);
      const obst = markerRects(p, s, o);
      for (const L of G.labels) {
        const x = L.x * s + o.tx;
        const y = L.y * s + o.ty;
        if (x < -80 || y < -40 || x > o.w + 80 || y > o.h + 40) continue;
        const lines = [];
        if (v.labels) lines.push([L.name, 600]);
        const st = per && per.get(L.id);
        if (st && st.n) lines.push([WH.util.dbm(st.mean), 700]);
        if (!lines.length) continue;
        c.font = `600 ${base}px ${fam}`;
        let tw = 1;
        for (const [txt] of lines) tw = Math.max(tw, c.measureText(txt).width);
        const fs = Math.min(base, (base * (L.cw * s - 10)) / tw, (L.ch * s - 6) / (lines.length * 1.25));
        if (!(fs >= 9)) continue;
        const lh = fs * 1.25;
        const cy = clearOf(obst, L, x, y, (tw * fs) / base + 6, lines.length * lh, s, o);
        lines.forEach(([txt, wt], i) => {
          const yy = cy + (i - (lines.length - 1) / 2) * lh;
          c.font = `${wt} ${i ? fs * 0.92 : fs}px ${fam}`;
          c.lineWidth = 3.5;
          c.strokeStyle = col('--map-halo');
          c.strokeText(txt, x, yy);
          c.fillStyle = col('--map-label');
          c.fillText(txt, x, yy);
        });
      }
    }
  }
  PL.drawScene = drawScene;

  /** Screen rectangles (CSS px) of the DOM markers drawn over the map - router, today's ghost (+ its caption), inlet,
   *  second node, measurement dots and their value labels - so room names can step out of their way. */
  function markerRects(p, s, o) {
    const out = [];
    if (!p.plan.rooms.length) return out;
    const sc = (q) => ({ x: q.x * W * s + o.tx, y: q.y * H * s + o.ty });
    const disc = (q, r, capH) => { if (!q) return; const c = sc(q); out.push({ l: c.x - r, t: c.y - r, r: c.x + r, b: c.y + r + (capH || 0) }); };
    disc(p.net.router, 20);
    if (PL.moved()) disc(p.net.baseline, 17, 18);
    disc(p.net.optic, 16);
    if (p.node.mode !== 'none') disc(p.node.pos, 17);
    const st = PL.stage;
    for (const m of p.measurements) {
      const c = sc(m);
      out.push({ l: c.x - 10, t: c.y - 10, r: c.x + 10, b: c.y + 10 });
      const b = st && st.meas && st.meas.get(m.id);
      if (b && b._lw && !b.hidden && m.band === p.view.band) {
        const flip = b.classList.contains('is-flip');
        out.push({ l: flip ? c.x - 10 - b._lw : c.x + 10, t: c.y - 10, r: flip ? c.x - 10 : c.x + 10 + b._lw, b: c.y + 10 });
      }
    }
    return out;
  }

  /** Vertical position (CSS px) for a room label of size w x h centred at (x, y): y itself when no marker covers it,
   *  else the nearest spot just above / below the covering markers that is still inside the room and clear of every
   *  marker; y when there is none (the marker then simply sits on the name, as before). */
  function clearOf(obst, L, x, y, w, h, s, o) {
    if (!obst.length) return y;
    const hits = (cy) => obst.filter((r) => r.l < x + w / 2 && r.r > x - w / 2 && r.t < cy + h / 2 && r.b > cy - h / 2);
    const first = hits(y);
    if (!first.length) return y;
    const G = WH.engine.geom;
    const inside = (cy) => [[x - w / 2, cy - h / 2], [x + w / 2, cy - h / 2], [x - w / 2, cy + h / 2], [x + w / 2, cy + h / 2]]
      .every(([sx, sy]) => G.pointInPolygon({ x: (sx - o.tx) / s / W, y: (sy - o.ty) / s / H }, L.pts));
    const cand = [];
    for (const r of obst) { cand.push(r.b + h / 2 + 3, r.t - h / 2 - 3); }
    cand.sort((m, n) => Math.abs(m - y) - Math.abs(n - y));
    for (const cy of cand) {
      if (Math.abs(cy - y) > Math.max(60, h * 3)) break;
      if (!hits(cy).length && inside(cy)) return cy;
    }
    return y;
  }

  let drawRaf = 0;
  PL.requestDraw = () => { if (!drawRaf) drawRaf = requestAnimationFrame(() => { drawRaf = 0; PL.draw(); }); };
  /** Draw the stage canvas now (HiDPI aware) and re-place the DOM markers. */
  PL.draw = () => {
    const st = PL.stage;
    if (!st || !S.visible) return;
    const cv = st.canvas;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const vw = st.vp.view;
    try {
      drawScene(cv.getContext('2d'), { s: vw.scale, tx: vw.tx, ty: vw.ty, dpr, w, h, z: vw.scale / (st.vp.fitScale || 1) });
    } catch (e) { console.error('[planner] drawing failed', e); }
    st.place();
  };
})();
