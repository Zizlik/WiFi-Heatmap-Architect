/* WiFi Heatmap Architect - engine.analysis: "today vs trial" in one call, the calibration wizard's suggested spots
 * (SPEC 9) and the what-if at the measured points (SPEC 10: predictAtMeasurements / summarizePredictions).
 *
 * Convenience layer over model + raster so that the planner view needs a handful of lines:
 *
 *   const a = WH.engine.analysis.run(project, { cell: 4 });
 *   a.stats.today.coverage, a.stats.trial.coverage, a.diff (Float32Array), a.today / a.trial (dBm fields)
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const model = E.model;
  const raster = E.raster;
  const units = E.units;

  const copyStats = (s) => ({ coverage: s.coverage, mean: s.mean, median: s.median, p10: s.p10, n: s.n });
  const copyPer = (m) => new Map([...m].map(([id, s]) => [id, copyStats(s)]));

  /**
   * Compute the signal fields for "today" (router at net.baseline, no second node) and "trial" (router at net.router
   * plus the second node), their difference, and statistics for the project's goal.
   * @param {object} project sanitized Project
   * @param {{cell?:number, band?:number|'auto', aa?:number, soften?:number, ctx?:object, offsets?:object, cache?:object,
   *          reuse?:{today?:Float32Array, trial?:Float32Array}}} [opts]
   *   cell: grid cell size in px (4 = full quality, 8 = coarse for dragging); band defaults to project.view.band
   *   ('auto' = band mode Auto, SPEC 13: every cell on the band a steering client uses there);
   *   aa: anti-aliasing factor of the fields (default 2 for cell <= 4, else 1; see raster.fieldEx);
   *   soften: diffraction softening in metres (default model.SOFTEN = 0.4, 0 = exact rays; see raster.fieldEx). When
   *   you let analysis compute the offsets they are calibrated with the same soften;
   *   ctx / offsets: pass already computed ones to skip recomputation; reuse: buffers to fill (no allocation);
   *   cache: an object you keep between calls ({}), the unchanged "today" field AND its statistics (stats.today,
   *   perRoom.today) are then computed only once per baseline / geometry / parameters / goal - the returned `today`
   *   array and today's stats objects are shared with the cache, treat them as read-only.
   * @returns {{ctx:object, grid:object, band:number|'auto', offsets:object, threshold:number, soften:number,
   *   params:{today:object, trial:object}, today:Float32Array, trial:Float32Array, diff:Float32Array,
   *   nodeWins:Uint8Array|null, backhaul:number|null, weakBackhaul:boolean, targetRooms:number[]|null,
   *   stats:{today:object, trial:object}, perRoom:{today:Map, trial:Map}, delta:{coverage:number, mean:number},
   *   bands:{today:Uint8Array|null, trial:Uint8Array|null}, bandShare:{today:object, trial:object}|null}}
   *   stats objects: {coverage, mean, median, p10, n}; delta = trial - today (percentage points / dB);
   *   targetRooms null = whole flat (all rooms except goal.excluded); bands = the band of every cell in the band mode
   *   Auto (raster.fieldEx; null for one band), bandShare = raster.bandShare of the goal's rooms (null for one band).
   */
  function run(project, opts) {
    const o = opts || {};
    const ctx = o.ctx || model.createContext(project);
    const grid = raster.grid(ctx, { cell: o.cell || 4 });
    const band = units.normBandMode(o.band) || units.normBandMode(project.view.band) || 5;
    const soften = model.softenOf(o.soften);
    const offsets = o.offsets || model.offsets(ctx, project, { soften });
    const aa = o.aa !== undefined ? o.aa : grid.cell <= 4 ? 2 : 1;
    const params = {
      today: { ...model.fieldParams(project, 'today', { band, offsets, soften }), aa },
      trial: { ...model.fieldParams(project, 'trial', { band, offsets, soften }), aa },
    };
    const auto = band === 'auto';
    const reuse = o.reuse || {};
    const cache = o.cache || null;
    // "today" does not change while the router is dragged: with a caller-owned cache object it is computed once per
    // (geometry, parameters, baseline, band, offsets, grid, aa, soften); band mode Auto (SPEC 13) adds the router's
    // bands, the steering thresholds and every band's offset
    const bandKeyPart = auto
      ? [params.today.bands.join(','), params.today.steer.six, params.today.steer.five, params.today.bands.map((b) => model.offsetFor(offsets, b)).join(',')].join('/')
      : model.offsetFor(offsets, band);
    const key = cache ? [ctx.version, grid.cell, aa, soften, band, params.today.router.x, params.today.router.y, bandKeyPart].join('|') : null;
    let today;
    let todayBands = null;
    if (key && cache.key === key && cache.today && cache.today.length === grid.cols * grid.rows) {
      today = cache.today;
      todayBands = cache.todayBands || null;
    } else {
      const fx = raster.fieldEx(ctx, grid, params.today, reuse.today);
      today = fx.field;
      todayBands = fx.bands || null;
      if (key) {
        cache.key = key;
        cache.today = today;
        cache.todayBands = todayBands;
        cache.statsKey = null;
      }
    }
    const sameRouter = params.trial.router.x === params.today.router.x && params.trial.router.y === params.today.router.y;
    const trialIsToday = sameRouter && !params.trial.node;
    let tr;
    if (trialIsToday) {
      // trial == today (nothing moved, no second node): compute once, hand out an independent copy
      let copy = today.slice();
      if (reuse.trial && reuse.trial.length === today.length) {
        reuse.trial.set(today);
        copy = reuse.trial;
      }
      tr = { field: copy, nodeWins: null, bands: todayBands ? todayBands.slice() : null };
      // the copy is the trial field: speed.fieldSpeed(…, a.trial) finds its bands like those of a computed field
      raster.adoptField(copy, params.trial, { nodeWins: null, bands: tr.bands });
    } else tr = raster.fieldEx(ctx, grid, params.trial, reuse.trial);
    const threshold = project.model.threshold;
    const targetRooms = project.goal.room === 'all' ? null : [project.goal.room];
    const excluded = project.goal.excluded;
    // today's statistics (two sorts of every floor cell) are cached next to today's field
    const statsKey = key ? [key, threshold, project.goal.room, excluded.join(',')].join('|') : null;
    let todayStats;
    let todayPer;
    if (statsKey && cache.statsKey === statsKey && cache.stats && cache.perRoom) {
      todayStats = cache.stats;
      todayPer = cache.perRoom;
    } else {
      todayStats = raster.stats(grid, today, targetRooms, threshold, excluded);
      todayPer = raster.perRoom(grid, today, threshold);
      if (statsKey) {
        cache.statsKey = statsKey;
        cache.stats = todayStats;
        cache.perRoom = todayPer;
      }
    }
    const stats = {
      today: todayStats,
      trial: trialIsToday ? copyStats(todayStats) : raster.stats(grid, tr.field, targetRooms, threshold, excluded),
    };
    const backhaul = model.backhaulSignal(ctx, params.trial);
    const node = params.trial.node;
    return {
      ctx,
      grid,
      band,
      offsets,
      threshold,
      soften,
      params,
      today,
      trial: tr.field,
      diff: raster.diff(tr.field, today),
      nodeWins: tr.nodeWins,
      backhaul,
      weakBackhaul: !!(node && model.isWirelessNode(node) && backhaul !== null && backhaul < node.backhaulThreshold),
      targetRooms,
      stats,
      perRoom: { today: todayPer, trial: trialIsToday ? copyPer(todayPer) : raster.perRoom(grid, tr.field, threshold) },
      delta: { coverage: stats.trial.coverage - stats.today.coverage, mean: stats.trial.mean - stats.today.mean },
      bands: { today: todayBands, trial: tr.bands || null },
      bandShare: auto ? { today: raster.bandShare(grid, todayBands, targetRooms, excluded), trial: raster.bandShare(grid, tr.bands, targetRooms, excluded) } : null,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // suggested measuring spots for the "first measurement" wizard (SPEC 9)
  // ---------------------------------------------------------------------------------------------------------------

  const { W, H } = E.CANVAS;
  const geom = E.geom;
  const { clamp, isNum, round, median } = E.util;
  /** Walking order of the wizard's pins (and of the result). */
  const SPOT_KINDS = Object.freeze(['near', 'sameRoom', 'oneWall', 'twoWalls', 'far']);
  // what is picked first when fewer spots are asked for: the near one and the weakest place matter most for the fit
  const SPOT_PRIORITY = ['near', 'far', 'oneWall', 'twoWalls', 'sameRoom'];
  const SPOT_RELAX = [
    { wall: 0.3, inside: 0.2 },
    { wall: 0.15, inside: 0.1 },
    { wall: 0, inside: 0.02 },
  ];

  /** Floor points on a lattice (<= ~3000), at least `wall` m from every wall, `inside` m inside their room, not in furniture. */
  function spotCandidates(ctx, project, router, sigAt, relax) {
    const plan = project.plan;
    const mpp = ctx.mpp;
    const bb = E.project.planBounds(plan);
    const areaPx = Math.max(1, (bb.maxX - bb.minX) * W * (bb.maxY - bb.minY) * H);
    const step = Math.max(0.25 / mpp, Math.sqrt(areaPx / 3000));
    const walls = plan.walls.filter((w) => w && w.a && w.b && isNum(w.a.x) && isNum(w.a.y) && isNum(w.b.x) && isNum(w.b.y)).map((w) => [w.a.x * W, w.a.y * H, w.b.x * W, w.b.y * H]);
    const furniture = plan.furniture.filter((f) => f && Array.isArray(f.points) && f.points.length >= 3);
    const wallPx = relax.wall / mpp;
    const insidePx = relax.inside / mpp;
    const out = [];
    for (let y = bb.minY * H + step / 2; y < bb.maxY * H; y += step) {
      for (let x = bb.minX * W + step / 2; x < bb.maxX * W; x += step) {
        const p = { x: round(x / W), y: round(y / H) };
        const room = E.project.roomAt(plan, p);
        if (!room || geom.signedDistPx(p, room.points) < insidePx) continue;
        let wd = Infinity;
        for (const s of walls) {
          const d = geom.pointSegDistPx(x, y, s[0], s[1], s[2], s[3]);
          if (d < wd) wd = d;
        }
        if (wd < wallPx) continue;
        if (furniture.some((f) => geom.pointInPolygon(p, f.points))) continue;
        out.push({
          p,
          roomId: room.roomId,
          d: geom.distM(router, p, mpp),
          walls: model.wallCount(ctx, router, p),
          sig: sigAt(p), // exact rays: only used to rank
          clear: Math.min(wd, 1e6) * mpp,
          i: out.length,
        });
      }
    }
    return out;
  }

  /**
   * 4-6 spots to measure for the calibration wizard (SPEC 9), chosen to span the model: ~1-2 m from the router
   * ('near'), the far side of the router's room ('sameRoom'), behind one wall ('oneWall'), behind two or more walls
   * ('twoWalls') and in the weakest room ('far'). Spots lie inside rooms, >= 0.3 m from every wall (relaxed only when
   * a plan has no room for that), not inside furniture, >= `minGap` (1.5 m) from each other and >= 0.8 m from the
   * router. Deterministic. The router is net.baseline (measurements are always taken there).
   * @param {object} ctx model.createContext(project)
   * @param {object} project
   * @param {{band?:2.4|5|6|'auto', count?:number, minGap?:number, offsets?:object, router?:{x,y}}} [opts] count 1..8
   *        (default 5; with fewer the priority is near, far, oneWall, twoWalls, sameRoom; more are spread out by
   *        farthest-point sampling); band default view.band ('auto' = SPEC 13: the band a steering client uses at
   *        every spot); offsets default model.offsets(ctx, project)
   * @returns {Array<{x:number, y:number, roomId:number, kind:'near'|'sameRoom'|'oneWall'|'twoWalls'|'far',
   *          predicted:number, band:2.4|5|6|null, distance:number, walls:number}>} in walking order (SPOT_KINDS, then
   *          distance); predicted = what the (calibrated) map shows there in dBm, softened (0.1 dB); band = the band
   *          of that number; distance in m from the router; walls = walls / closed doors on the straight line. [] for
   *          a plan without rooms.
   */
  function suggestSpots(ctx, project, opts) {
    const o = opts || {};
    const plan = project.plan;
    if (!plan || !plan.rooms || !plan.rooms.length) return [];
    const band = units.normBandMode(o.band) || units.normBandMode(project.view.band) || 5;
    const count = clamp(Math.round(isNum(o.count) ? o.count : 5), 1, 8);
    const minGap = isNum(o.minGap) && o.minGap >= 0 ? o.minGap : 1.5;
    const router = o.router && isNum(o.router.x) && isNum(o.router.y) ? o.router : project.net.baseline;
    const offsets = o.offsets || model.offsets(ctx, project);
    const off = model.offsetFor(offsets, band);
    const mpp = ctx.mpp;
    // band mode Auto (SPEC 13): a spot's signal is the one of the band a steering client uses there (router only)
    const auto = band === 'auto';
    const bands = auto ? model.routerBandList(project) : [band];
    const steer = model.steerOf(project);
    const sigAt = (p) => {
      if (!auto) return model.signal(ctx, router, p, band, off);
      const sig = {};
      for (const b of bands) sig[units.bandKey(b)] = model.signal(ctx, router, p, b, model.offsetFor(offsets, b));
      return sig[units.bandKey(model.steerBand(sig, bands, steer))];
    };
    const state = { band: auto ? 'auto' : band, bands, steer, router, node: null, offsets };
    let cands = [];
    for (const relax of SPOT_RELAX) {
      cands = spotCandidates(ctx, project, router, sigAt, relax);
      if (cands.length >= count * 4) break;
    }
    if (!cands.length) return [];
    const home = E.project.roomAt(plan, router);
    const homeId = home ? home.roomId : 0;
    const chosen = [];
    const free = (c) => c.d >= 0.8 && chosen.every((s) => geom.distM(s.p, c.p, mpp) >= minGap - 1e-9);
    const take = (kind, list, score) => {
      let best = null;
      let bs = Infinity;
      for (const c of list) {
        if (!free(c)) continue;
        const s = score(c);
        if (s < bs - 1e-9) {
          bs = s;
          best = c;
        }
      }
      if (best) chosen.push({ ...best, kind });
      return best;
    };
    const pickers = {
      near: () =>
        take('near', cands.filter((c) => c.walls === 0 && c.d >= 1 && c.d <= 2), (c) => Math.abs(c.d - 1.5) - 0.01 * Math.min(c.clear, 1)) ||
        take('near', cands.filter((c) => c.walls === 0 && c.d <= 3), (c) => Math.abs(c.d - 1.5) - 0.01 * Math.min(c.clear, 1)),
      far: () => {
        // the weakest room (lowest median of the predicted signal), measured near its visual centre
        const byRoom = new Map();
        for (const c of cands) {
          if (!byRoom.has(c.roomId)) byRoom.set(c.roomId, []);
          byRoom.get(c.roomId).push(c.sig);
        }
        const rooms = [...byRoom.keys()].sort((a, b) => median(byRoom.get(a)) - median(byRoom.get(b)) || a - b);
        for (const id of rooms) {
          const room = plan.rooms.find((r) => r.roomId === id);
          const lp = geom.labelPoint(room.points);
          if (take('far', cands.filter((c) => c.roomId === id), (c) => geom.dist(c.p, lp))) return true;
        }
        return false;
      },
      oneWall: () => {
        const list = cands.filter((c) => c.walls === 1);
        const dT = clamp(median(list.map((c) => c.d)), 2, 5);
        return take('oneWall', list, (c) => Math.abs(c.d - dT) - 0.01 * Math.min(c.clear, 1));
      },
      twoWalls: () => {
        const list = cands.filter((c) => c.walls >= 2);
        const dT = median(list.map((c) => c.d));
        return take('twoWalls', list, (c) => Math.abs(c.d - dT) + 2 * (c.walls - 2) - 0.01 * Math.min(c.clear, 1));
      },
      sameRoom: () =>
        take('sameRoom', cands.filter((c) => c.walls === 0 && c.roomId === homeId && c.d >= 2), (c) => -c.d) ||
        take('sameRoom', cands.filter((c) => c.walls === 0 && c.d >= 2), (c) => -c.d),
    };
    for (const kind of SPOT_PRIORITY) {
      if (chosen.length >= count) break;
      pickers[kind]();
    }
    // more spots than kinds (or kinds the plan cannot offer): spread out over the floor (farthest-point sampling)
    while (chosen.length < count) {
      const kindOf = (c) => (c.walls === 0 ? 'sameRoom' : c.walls === 1 ? 'oneWall' : 'twoWalls');
      const gap = (c) => Math.min(c.d, ...chosen.map((s) => geom.distM(s.p, c.p, mpp)));
      let best = null;
      let bs = -Infinity;
      for (const c of cands) {
        if (!free(c)) continue;
        const g = gap(c);
        if (g > bs + 1e-9) {
          bs = g;
          best = c;
        }
      }
      if (!best) break;
      chosen.push({ ...best, kind: kindOf(best) });
    }
    chosen.sort((a, b) => SPOT_KINDS.indexOf(a.kind) - SPOT_KINDS.indexOf(b.kind) || a.d - b.d || a.i - b.i);
    return chosen.map((c) => {
      const st = auto ? model.steeredSignal(ctx, c.p, state) : null;
      return {
        x: c.p.x,
        y: c.p.y,
        roomId: c.roomId,
        kind: c.kind,
        predicted: round(st ? st.signal : model.softSignal(ctx, router, c.p, band, off), 1),
        band: st ? st.band : band,
        distance: round(c.d, 2),
        walls: c.walls,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // what-if at the measured points (SPEC 10): "how much would my measured values rise or fall?"
  // ---------------------------------------------------------------------------------------------------------------

  const speedM = E.speed;
  /** dB: a point counts as improved / worsened in summarizePredictions() from this change on. */
  const WHATIF_DB = 1;
  /** A point's scenario "changed" from this |delta| on (or when the node serves it). */
  const CHANGE_DB = 0.05;

  /**
   * Is a what-if active: the trial router moved away from today's place (> 1 canvas px) or a second node is on?
   * @param {object} project
   * @returns {boolean}
   */
  function whatIfActive(project) {
    if (!project || !project.net) return false;
    if (model.nodeParams(project)) return true;
    const r = project.net.router;
    const b = project.net.baseline;
    if (!r || !b || !isNum(r.x) || !isNum(r.y) || !isNum(b.x) || !isNum(b.y)) return false;
    return Math.hypot((r.x - b.x) * W, (r.y - b.y) * H) > 1;
  }

  const emptyEntry = (m, i) => ({
    id: m && (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : `#${i}`,
    name: m && typeof m.name === 'string' ? m.name : '',
    band: m ? units.normBand(m.band) : null,
    bandInferred: false,
    bandNew: null,
    steered: false,
    x: m && isNum(m.x) ? m.x : null,
    y: m && isNum(m.y) ? m.y : null,
    roomId: 0,
    onFloor: false,
    inside: null,
    measured: m && isNum(m.value) ? m.value : null,
    modelToday: null,
    modelNew: null,
    routerNew: null,
    nodeNew: null,
    delta: null,
    predicted: null,
    source: 'router',
    changed: false,
    speed: null,
    reason: null,
  });

  /**
   * Predicted change at every measured point (SPEC 10). Today = the router at net.baseline WITHOUT the second node (the
   * measurements were taken like that); new = the trial router net.router + the current node scenario. Both on the
   * measurement's own band, with the same calibration offsets and the same (fitted) model `ctx`, softened like the map.
   * SPEC 13: a point without a known band (band null, "Nevím") is predicted on its inferred band (bandInferred); with
   * steering (opts.steer, default on in the band mode Auto) the new scenario is taken on the band a steering client
   * would use there then (bandNew; the nearest band's speed curve stands in for a band without one, speed.approx).
   * predicted = measured + delta (the user's real number anchors the prediction), or modelNew for a speed-only point.
   * Speed: the curve of the point's band through speed.predictVia (node link, node.maxMbps, link and plan ceilings, NO
   * reserve), anchored to a measured speed: measured x curve(sig_new) / curve(sig_today). Deterministic; never throws
   * on odd measurement data (an entry gets `reason` instead).
   * @param {object} ctx model.createContext(project) (the planner's: fit applied while calibrating)
   * @param {object} project
   * @param {{offsets?:object, band?:2.4|5|6|'auto', steer?:boolean, soften?:number, curves?:object,
   *          backhaulCurve?:object|null, limits?:{wanDown?,wanUp?,wanPort?,ontPort?,wanLink?}}} [opts] see ENGINE-API 7.7
   *          and 7.9 (band 'auto' = every point + steering)
   * @returns {Array<object>} one entry per measurement (in project order; only `band`'s when given)
   */
  function predictAtMeasurements(ctx, project, opts) {
    const o = opts || {};
    // no usable context (model.createContext) or project: nothing to predict (never throws)
    if (!ctx || !ctx.p || !ctx.p.bandPower || !isNum(ctx.mpp) || !project || !project.net || !project.plan) return [];
    const list = Array.isArray(project.measurements) ? project.measurements : [];
    if (!list.length) return [];
    const net = project.net;
    const plan = project.plan;
    const hasRooms = Array.isArray(plan.rooms) && plan.rooms.length > 0;
    const okPt = (q) => !!(q && isNum(q.x) && isNum(q.y));
    // a broken marker counts as missing: every entry then gets reason 'position'
    const baseline = okPt(net.baseline) ? net.baseline : null;
    const router = okPt(net.router) ? net.router : null;
    const node = model.nodeParams(project);
    const soften = o.soften;
    const offsets = o.offsets || model.offsets(ctx, project, { soften });
    const bandOpt = o.band === undefined || o.band === null ? null : units.normBandMode(o.band);
    const onlyBand = bandOpt === 'auto' ? null : bandOpt;
    // SPEC 13: a steering client may switch band in the new scenario - on by default in the band mode Auto
    const steerNew = o.steer !== undefined ? !!o.steer : bandOpt === 'auto' || (bandOpt === null && units.normBandMode(project.view && project.view.band) === 'auto');
    const routerBands = model.routerBandList(project);
    const steer = model.steerOf(project);
    const limSrc = o.limits || net;
    // expected speeds comparable with measured ones: the plan / link ceilings, no planning reserve
    const lim = speedM.toLimits({ wanDown: limSrc.wanDown, wanUp: limSrc.wanUp, wanPort: limSrc.wanPort, ontPort: limSrc.ontPort, wanLink: limSrc.wanLink, reserve: 0 });
    const goalDevice = project.goal && project.goal.device;
    // points without a known band (SPEC 13: "Nevím") are predicted on their inferred band
    const resolved = baseline ? model.resolveBands(ctx, project, { soften }) : list;

    // speed curves per (band, device), built lazily from the filled measurements (speed-only points count)
    let filled = null;
    const fill = () => filled || (filled = speedM.fillSignals(ctx, resolved, { baseline, offsets, soften }));
    const built = new Map();
    const build = (band, device) => {
      const key = `${units.bandKey(band)}|${model.profileKey(device)}`;
      if (!built.has(key)) built.set(key, speedM.buildCurve(fill(), { band, device }));
      return built.get(key);
    };
    const ownCurve = (band, device) => {
      const k = units.bandKey(band);
      if (o.curves && Object.prototype.hasOwnProperty.call(o.curves, k)) return speedM.validCurve(o.curves[k]) ? o.curves[k] : null;
      return (device ? build(band, device) : null) || build(band, goalDevice);
    };
    // the curve of a band; with steering (Auto) the nearest band's stands in (flagged approx), as on the Speed map
    const curveFor = (band, device) => {
      const own = ownCurve(band, device);
      if (own || !steerNew) return { curve: own, approx: false };
      for (const b of speedM.CURVE_ORDER[units.bandKey(band)]) {
        const c = b === band ? null : ownCurve(b, device);
        if (c) return { curve: c, approx: true };
      }
      return { curve: null, approx: false };
    };
    // the node's uplink: its signal once, the link per client curve (the backhaul band's own curve when there is one)
    const nodeOnSomeBand = !!node;
    let bhSig = null;
    if (nodeOnSomeBand && model.isWirelessNode(node) && router && baseline) {
      const v = model.backhaulSignal(ctx, { router, node, offsets, soften });
      bhSig = isNum(v) ? v : null;
    }
    let bCurve;
    const backhaulCurve = () => {
      if (bCurve === undefined) bCurve = o.backhaulCurve !== undefined ? (speedM.validCurve(o.backhaulCurve) ? o.backhaulCurve : null) : node ? ownCurve(units.normBand(node.backhaulBand) || 5, goalDevice) : null;
      return bCurve;
    };
    const links = new Map();
    const linkFor = (curve) => {
      if (!links.has(curve)) links.set(curve, speedM.linkFromSignal(node, bhSig, curve, backhaulCurve()));
      return links.get(curve);
    };

    const out = [];
    list.forEach((m, i) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        if (onlyBand === null) out.push({ ...emptyEntry(null, i), reason: 'invalid' });
        return;
      }
      const r = resolved[i] && typeof resolved[i] === 'object' ? resolved[i] : m;
      const e = emptyEntry(r, i);
      e.bandInferred = r.bandInferred === true;
      e.bandNew = e.band;
      e.steered = steerNew;
      if (onlyBand !== null && e.band !== onlyBand) return;
      out.push(e);
      if (e.band === null) {
        e.reason = 'band';
        return;
      }
      if (e.x === null || e.y === null || !baseline || !router) {
        e.reason = 'position';
        return;
      }
      const p = { x: e.x, y: e.y };
      const room = hasRooms ? E.project.roomAt(plan, p) : null;
      e.roomId = room ? room.roomId : 0;
      e.onFloor = !!room;
      if (!room && hasRooms) e.inside = E.project.nearestFloor(plan, p);
      const band = e.band;
      const today = model.softSignal(ctx, baseline, p, band, model.offsetFor(offsets, band), soften);
      // the new scenario on the point's band - or, with steering, on the band a steering client would use then
      const newOn = (b) => {
        const off = model.offsetFor(offsets, b);
        const rN = model.softSignal(ctx, router, p, b, off, soften);
        const nN = model.nodeActive(node, b) ? model.softSignal(ctx, node.pos, p, b, off + (node.power || 0), soften) : null;
        return { rN, nN, best: nN !== null && nN > rN ? nN : rN };
      };
      let bandNew = band;
      let nw = null;
      if (steerNew && routerBands.length > 1) {
        // the client switches band only when the steering rule picks another band in the new scenario than today
        // (the measured band is what it really does today; an unchanged scenario never moves it)
        const per = {};
        const sigNew = {};
        const sigToday = {};
        for (const b of routerBands) {
          const k = units.bandKey(b);
          per[k] = newOn(b);
          sigNew[k] = per[k].best;
          sigToday[k] = b === band ? today : model.softSignal(ctx, baseline, p, b, model.offsetFor(offsets, b), soften);
        }
        const pick = model.steerBand(sigNew, routerBands, steer);
        if (pick !== null && pick !== model.steerBand(sigToday, routerBands, steer)) {
          bandNew = pick;
          nw = per[units.bandKey(pick)];
        }
      }
      if (!nw) nw = newOn(band);
      const viaNode = nw.nN !== null && nw.nN > nw.rN;
      e.bandNew = bandNew;
      e.modelToday = today;
      e.routerNew = nw.rN;
      e.nodeNew = nw.nN;
      e.modelNew = viaNode ? nw.nN : nw.rN;
      e.source = viaNode ? 'node' : 'router';
      e.delta = e.modelNew - today;
      e.predicted = e.measured !== null ? clamp(e.measured + e.delta, model.MIN_SIGNAL, model.MAX_SIGNAL) : e.modelNew;
      e.changed = Math.abs(e.delta) >= CHANGE_DB || viaNode || bandNew !== band;
      const cToday = curveFor(band, m.device);
      const cNew = bandNew === band ? cToday : curveFor(bandNew, m.device);
      e.speed = speedAt(e, m, cToday, cNew, viaNode ? linkFor : null, lim);
    });
    return out;
  }

  /**
   * The speed part of a what-if entry (see predictAtMeasurements). cToday / cNew = {curve, approx} of the point's band
   * today and of the band of the new scenario (the same unless a steering client switches band).
   */
  function speedAt(e, m, cToday, cNew, linkFor, lim) {
    const md = speedM.validRate(m.download) ? m.download : null;
    const mu = speedM.validRate(m.upload) ? m.upload : null;
    const curveT = cToday.curve;
    const curve = cToday.curve && cNew.curve ? cNew.curve : null;
    if (md === null && mu === null && !curve) return null;
    const sp = { measuredDown: md, measuredUp: mu, todayDown: null, todayUp: null, predDown: null, predUp: null, anchored: false, limitedBy: null, limitedByUp: null, capDown: null, capUp: null, reason: null, approx: !!(cToday.approx || cNew.approx) };
    const link = linkFor ? linkFor(curve) : null;
    if (link && link.wireless && link.approx) sp.approx = true;
    const keep = () => {
      // nothing changes at this point: it keeps its measured speed
      sp.predDown = md;
      sp.predUp = mu;
      sp.anchored = true;
    };
    if (!curve) {
      sp.reason = 'curve';
      if (!e.changed && (md !== null || mu !== null)) keep();
      return sp;
    }
    const sigToday = e.measured !== null ? e.measured : e.modelToday;
    const today = speedM.predictVia(curveT, sigToday, lim, null);
    if (today) {
      sp.todayDown = today.down;
      sp.todayUp = today.up;
    }
    if (!e.changed && (md !== null || mu !== null)) {
      keep();
      if (today) {
        sp.limitedBy = md !== null ? today.limitedBy : null;
        sp.limitedByUp = mu !== null ? today.limitedByUp : null;
        sp.capDown = sp.limitedBy ? today.capDown : null;
        sp.capUp = sp.limitedByUp ? today.capUp : null;
      }
      return sp;
    }
    const rNew = speedM.rate(curve, e.predicted);
    if (!rNew) {
      sp.reason = 'weak';
      return sp;
    }
    if (link && link.wireless && !link.known) {
      sp.reason = 'backhaul';
      sp.limitedBy = 'backhaul';
      sp.limitedByUp = 'backhaul';
      return sp;
    }
    // anchor each direction to the measured speed: measured x curve(new) / curve(today), never above the better of the
    // measured value and the best test of the curve; the ceilings (node link, node.maxMbps, link, plan) come after
    const rToday = speedM.rate(curveT, sigToday);
    const best = speedM.rate(curve, curve.max);
    const anchor = (meas, num, den, top) => (meas !== null && isNum(den) && den > 0 ? Math.min((meas * num) / den, Math.max(meas, top)) : null);
    const aD = anchor(md, rNew.down, rToday && rToday.down, best ? best.down : rNew.down);
    const aU = anchor(mu, rNew.up, rToday && rToday.up, best ? best.up : rNew.up);
    const v = speedM.applyCeilings({ down: aD !== null ? aD : rNew.down, up: aU !== null ? aU : rNew.up }, lim, link);
    if (!v) {
      sp.reason = 'backhaul';
      return sp;
    }
    sp.anchored = aD !== null || aU !== null;
    sp.predDown = v.down;
    sp.predUp = v.up;
    sp.limitedBy = v.limitedBy;
    sp.limitedByUp = v.limitedByUp;
    sp.capDown = v.capDown;
    sp.capUp = v.capUp;
    return sp;
  }

  /**
   * Plain-words summary of predictAtMeasurements() for the "Co by se změnilo v tvých bodech" card.
   * @param {Array<object>} list predictAtMeasurements() result
   * @param {{minDb?:number}} [opts] minDb (default WHATIF_DB = 1): from this |delta| a point counts as improved / worsened
   * @returns {{count:number, changed:boolean, improved:number, worsened:number, unchanged:number, meanDelta:number|null,
   *   best:object|null, worst:object|null, rooms:Array<{roomId:number, count:number, meanDelta:number, maxDelta:number,
   *   minDelta:number}>, speed:{count:number, improved:number, worsened:number,
   *   limited:{plan:number, link:number, backhaul:number, device:number}}}}
   *   entries with a `reason` are skipped; rooms best first (meanDelta, then roomId); speed: entries with a measured and
   *   a predicted download (improved / worsened = more than 5 % up / down), limited = entries whose predicted download
   *   is bound by that ceiling
   */
  function summarizePredictions(list, opts) {
    const minDb = opts && isNum(opts.minDb) && opts.minDb >= 0 ? opts.minDb : WHATIF_DB;
    const ok = (Array.isArray(list) ? list : []).filter((e) => e && !e.reason && isNum(e.delta));
    const out = {
      count: ok.length,
      changed: ok.some((e) => e.changed),
      improved: 0,
      worsened: 0,
      unchanged: 0,
      meanDelta: null,
      best: null,
      worst: null,
      rooms: [],
      speed: { count: 0, improved: 0, worsened: 0, limited: { plan: 0, link: 0, backhaul: 0, device: 0 } },
    };
    if (!ok.length) return out;
    let sum = 0;
    const rooms = new Map();
    for (const e of ok) {
      sum += e.delta;
      if (e.delta >= minDb) out.improved++;
      else if (e.delta <= -minDb) out.worsened++;
      else out.unchanged++;
      if (!out.best || e.delta > out.best.delta) out.best = e;
      if (!out.worst || e.delta < out.worst.delta) out.worst = e;
      let r = rooms.get(e.roomId);
      if (!r) rooms.set(e.roomId, (r = { roomId: e.roomId, count: 0, sum: 0, maxDelta: -Infinity, minDelta: Infinity }));
      r.count++;
      r.sum += e.delta;
      if (e.delta > r.maxDelta) r.maxDelta = e.delta;
      if (e.delta < r.minDelta) r.minDelta = e.delta;
      const s = e.speed;
      if (s) {
        if (s.limitedBy && Object.prototype.hasOwnProperty.call(out.speed.limited, s.limitedBy) && isNum(s.predDown)) out.speed.limited[s.limitedBy]++;
        if (isNum(s.predDown) && isNum(s.measuredDown)) {
          out.speed.count++;
          if (s.predDown > s.measuredDown * 1.05) out.speed.improved++;
          else if (s.predDown < s.measuredDown * 0.95) out.speed.worsened++;
        }
      }
    }
    out.meanDelta = sum / ok.length;
    out.rooms = [...rooms.values()]
      .map((r) => ({ roomId: r.roomId, count: r.count, meanDelta: r.sum / r.count, maxDelta: r.maxDelta, minDelta: r.minDelta }))
      .sort((a, b) => b.meanDelta - a.meanDelta || a.roomId - b.roomId);
    return out;
  }

  E.analysis = { run, suggestSpots, SPOT_KINDS, predictAtMeasurements, summarizePredictions, whatIfActive, WHATIF_DB };
})();
