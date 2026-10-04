/* WiFi Heatmap Architect - engine.model: the propagation model (SPEC sections 3.3 and 7.1).
 *
 *   signal(a->b, band) = nearSignal - 20*log10(band/5) + bandPower[band] - 10*n*log10(max(1, distM))
 *                        - obstacleLoss(band) + offset,   clamped to [-110, -20] dBm.
 *
 * Obstacle losses depend on the band (SPEC 7.1): every loss stored in a plan is the 5 GHz reference; wall materials and
 * furniture kinds use per-band tables (E.project.MATERIALS / FURNITURE_BANDS, e.g. brick 7 / 11 / 13 dB), every other
 * number is scaled by BAND_FACTOR (2.4 GHz x 0.65, 6 GHz x 1.15). So every stored number keeps its 5 GHz meaning (a wall
 * that still carries an OLD preset number, e.g. brick 8, is that preset and gets its new table), while 2.4 GHz now
 * really reaches further through walls and 6 GHz less far. The context keeps one loss array per band;
 * createContext() returns the 5 GHz view and forBand() the others - every function taking a band resolves it itself.
 *
 * obstacleLoss is where the legacy app produced wedge / stair-step artifacts. Fixes implemented here:
 *   - every wall is extended by 1.5 px at both ends (closes small gaps at corners and T-junctions),
 *   - crossings of one ray that lie closer than 2.5 px along the ray (corners, T-junctions, duplicate overlapping
 *     walls, doubled-up thick walls) form a cluster and only the MAX loss of the cluster counts (beyond 2.5 px the
 *     merge fades out smoothly up to 4.5 px, so the field has no wall-sized step where a ray slides past a junction),
 *   - a ray running along a wall (collinear overlap) counts as one crossing,
 *   - a crossing inside a door's span (distance to the door segment < 3 px) uses the door's loss,
 *   - furniture adds its loss once per piece; chords shorter than 15 cm (a ray grazing a corner) get a proportional
 *     part, so furniture shadows have soft edges instead of razor-sharp, resolution dependent ones.
 * All of this runs in canvas pixels on precomputed typed arrays; the hot path allocates nothing.
 *
 * Diffraction softening ("soften", metres, default SOFTEN = 0.4): a ray model casts razor-sharp shadows - straight
 * wedges radiating from the router through door openings and past wall ends and furniture. Real Wi-Fi diffracts and
 * multipath fills such shadows within a few tens of centimetres, and to a user the wedges look like rendering bugs. So
 * what the app SHOWS is the free-space term minus a Gaussian-blurred obstacle loss:
 *     soft(p) = nearSignal - 20*log10(band/5) - 10*n*log10(max(1, distM)) - G_sigma[obstacleLoss](p) + offset
 * where the blur only mixes floor points that are not separated by a wall or a closed door (walls stay sharp steps;
 * an open doorway stays continuous). The raster does this with a masked separable box-Gaussian (raster.field); single
 * points (tooltip, calibration, backhaul) use a deterministic 128-point Gaussian stencil here (softSignal), which
 * agrees with the raster to a few tenths of a dB.
 * rawSignal / signal / obstacleLoss / traceLoss stay the exact, unsoftened ray physics.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { clamp, isNum } = E.util;
  const units = E.units;
  const geom = E.geom;

  const WALL_EXT = 1.5; // px, wall extension at both ends
  const MERGE_NEAR = 2.5; // px along the ray: crossings closer than this are one obstacle (MAX), as in SPEC 3.3
  const MERGE_FAR = 4.5; // px: crossings farther apart than this always add up; in between the merge fades out (smoothstep)
  const DOOR_TOL = 3; // px, distance of a crossing to a door segment
  const COLLINEAR_TOL = 0.75; // px, "ray runs inside the wall"
  const FURN_SOFT_M = 0.15; // metres of chord inside a piece of furniture needed for its full loss
  const MIN_SIGNAL = -110;
  const MAX_SIGNAL = -20;
  const WIRELESS = ['mesh_wifi', 'repeater'];
  // m, default sigma of the diffraction softening (0 = off). 0.4 m ~ the first Fresnel zone radius sqrt(lambda*d)
  // 2-3 m behind an obstacle at 5 GHz; tuned visually on a real user plan (0.3-0.35 still leave diagonal streaks behind
  // doorways, 0.5 washes out door beams)
  const SOFTEN = 0.4;
  const SOFTEN_MAX = 2; // m
  const BARRIER_DB = 0.5; // a wall (or the door in it) with at least this loss stops the softening: walls stay sharp
  const SOFT_N = 128; // samples of the point stencil

  // ---- band-dependent obstacle loss (SPEC 7.1) -------------------------------------------------------------------
  // Every loss stored in a plan is the 5 GHz reference. Presets (wall material, furniture kind) use their per-band
  // tables (E.project.MATERIALS / FURNITURE_BANDS); every other number is scaled by BAND_FACTOR (2.4: 0.65, 6: 1.15).
  // The context holds one loss array per band; createContext returns the 5 GHz view, forBand(ctx, band) the others
  // (same geometry, same scratch buffers, same version - only the loss arrays differ).
  const PJ = E.project;
  const BAND_FACTOR = PJ.BAND_FACTOR;
  const FACT = [BAND_FACTOR['2.4'], BAND_FACTOR['5'], BAND_FACTOR['6']];
  const BAND_OF = [2.4, 5, 6];

  /** 0 | 1 | 2 for 2.4 | 5 | 6 GHz (numbers or strings), -1 otherwise. */
  function bandIndex(band) {
    const b = units.normBand(band);
    return b === 5 ? 1 : b === 2.4 ? 0 : b === 6 ? 2 : -1;
  }
  const own = (table, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null);
  const rowOf = (T) => [T['2.4'], T['5'], T['6']];
  /** A stored 5 GHz loss scaled to the three bands (4 decimals; 5 GHz is the stored number itself, bit for bit). */
  const scaled = (L) => [E.util.round(L * FACT[0], 4), L * FACT[1], E.util.round(L * FACT[2], 4)];

  /**
   * [2.4, 5, 6] GHz loss of a wall: a preset material uses its table when the stored loss is missing, equals the
   * table's 5 GHz value or equals the OLD app's preset number; anything else (custom, edited numbers) is the stored loss
   * x BAND_FACTOR; a wall without loss follows model.wallLoss x BAND_FACTOR.
   */
  function wallBands(w, wallLoss) {
    const T = own(PJ.MATERIALS, w.material);
    const L = isNum(w.loss) ? clamp(w.loss, 0, 30) : null;
    if (T && (L === null || L === T['5'] || L === PJ.LEGACY_WALL_MATERIALS[w.material])) return rowOf(T);
    return scaled(L !== null ? L : isNum(wallLoss) ? clamp(wallLoss, 0, 30) : 8);
  }
  /** [2.4, 5, 6] GHz loss of a door: stored loss x BAND_FACTOR (0 = open doorway at every band). */
  function doorBands(d) {
    return scaled(clamp(Number(d.loss) || 0, 0, 30));
  }
  /** [2.4, 5, 6] GHz loss of furniture: 0 when it does not block; preset kinds use their table; custom x BAND_FACTOR. */
  function furnitureBands(f) {
    if (f.blocksSignal === false) return [0, 0, 0];
    const T = own(PJ.FURNITURE_BANDS, f.kind);
    const raw = Number(f.loss);
    const has = Number.isFinite(raw);
    const L = has ? clamp(raw, 0, 30) : 0;
    if (T && (!has || L === T['5'])) return rowOf(T);
    return scaled(L);
  }
  const typeOf = (o) => o.type || (Array.isArray(o.points) ? 'furniture' : o.wallId !== undefined ? 'door' : o.a && o.b ? 'wall' : '');

  function bandsOf(obj, project) {
    if (!obj || typeof obj !== 'object') return [0, 0, 0];
    const type = typeOf(obj);
    if (type === 'wall') return wallBands(obj, project && project.model ? project.model.wallLoss : undefined);
    if (type === 'door') return doorBands(obj);
    if (type === 'furniture') return furnitureBands(obj);
    return [0, 0, 0];
  }

  /**
   * The loss in dB the model really uses for a wall / door / furniture object at a band (SPEC 7.1) - for inspectors and
   * tooltips. band: 2.4 | 5 | 6 (anything else = 5); project: needed for walls without their own loss (model.wallLoss).
   */
  function obstacleLossFor(obj, band, project) {
    const k = bandIndex(band);
    return bandsOf(obj, project)[k < 0 ? 1 : k];
  }

  /** {'2.4':dB,'5':dB,'6':dB} the model uses for an object (see obstacleLossFor). */
  function lossBands(obj, project) {
    const b = bandsOf(obj, project);
    return { '2.4': b[0], '5': b[1], '6': b[2] };
  }

  /**
   * The preset whose per-band table applies to the object: a wall's material key or a furniture kind, or null when
   * the object uses a custom number (scaled by BAND_FACTOR) or the model's default wall loss.
   */
  function presetOf(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const type = typeOf(obj);
    if (type === 'wall') {
      const T = own(PJ.MATERIALS, obj.material);
      const L = isNum(obj.loss) ? clamp(obj.loss, 0, 30) : null;
      return T && (L === null || L === T['5'] || L === PJ.LEGACY_WALL_MATERIALS[obj.material]) ? obj.material : null;
    }
    if (type === 'furniture') {
      const T = own(PJ.FURNITURE_BANDS, obj.kind);
      const raw = Number(obj.loss);
      return T && (!Number.isFinite(raw) || clamp(raw, 0, 30) === T['5']) ? obj.kind : null;
    }
    return null;
  }

  // Point stencil: SOFT_N equally weighted points distributed like a 2D standard normal (Rayleigh-quantile radii on a
  // golden-angle spiral). Equal weights + no rows/columns -> a shadow edge sweeping over the stencil changes the mean
  // by at most one sample (< 1 % of the step) at a time, so tooltips do not jump.
  const SOFT_UX = new Float64Array(SOFT_N);
  const SOFT_UY = new Float64Array(SOFT_N);
  for (let k = 0; k < SOFT_N; k++) {
    const rho = Math.sqrt(-2 * Math.log(1 - (k + 0.5) / SOFT_N));
    const th = k * Math.PI * (3 - Math.sqrt(5));
    SOFT_UX[k] = rho * Math.cos(th);
    SOFT_UY[k] = rho * Math.sin(th);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // context
  // ---------------------------------------------------------------------------------------------------------------

  /** Tiny double 32-bit hash (16 hex chars) used for ctx.version. */
  class Hasher {
    constructor() {
      this.a = 0x811c9dc5 | 0;
      this.b = 0x1b873593 | 0;
    }
    add(x) {
      const i = x | 0;
      this.a = Math.imul(this.a ^ i, 16777619);
      this.b = Math.imul((this.b + i + 0x9e3779b9) | 0, 0x85ebca6b) ^ (this.b >>> 13);
    }
    /** px values are hashed with 1/1000 px resolution. */
    px(v) {
      this.add(Math.round(v * 1000));
    }
    hex() {
      return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
    }
  }

  // ---- calibration fit (SPEC 9) -----------------------------------------------------------------------------------
  // project.model.fit (written by model.fitProject after the "first measurement" wizard) replaces the path-loss
  // exponent n and multiplies EVERY obstacle loss (walls, doors, furniture; after the band factors) by wallFactor. It
  // lives in the context, so the raster, the optimizer, contours, tooltips, calibration and the speed model all use the
  // same fitted physics without passing anything around. It is active while the calibration switch is on.
  const FIT_N_MIN = 1.6;
  const FIT_N_MAX = 4;
  const FIT_WF_MIN = 0.5;
  const FIT_WF_MAX = 2;

  /**
   * The fit a context should use: opts.fit === false -> none; opts.fit = {n, wallFactor, byBand?} -> that one (even
   * with the calibration switched off; for before/after previews); otherwise project.model.fit while
   * project.view.calibrate is not false. Returns {n, wallFactor, offsets:{'2.4','5','6': dB|null}} or null.
   */
  function activeFit(project, opts) {
    const o = opts || {};
    if (o.fit === false || o.fit === null) return null;
    let f = o.fit;
    if (f === undefined) {
      if (project.view && project.view.calibrate === false) return null;
      f = project.model ? project.model.fit : null;
    }
    if (!f || typeof f !== 'object' || !isNum(f.n) || !isNum(f.wallFactor)) return null;
    const by = f.byBand && typeof f.byBand === 'object' ? f.byBand : {};
    const off = (k) => (by[k] && typeof by[k] === 'object' && isNum(by[k].offset) ? by[k].offset : null);
    return {
      n: clamp(f.n, FIT_N_MIN, FIT_N_MAX),
      wallFactor: clamp(f.wallFactor, FIT_WF_MIN, FIT_WF_MAX),
      offsets: { '2.4': off('2.4'), '5': off('5'), '6': off('6') },
    };
  }

  /**
   * Precompute everything the physics needs from a project. Cheap (O(walls + furniture)); rebuild it whenever the plan
   * or the model parameters change. `ctx.version` is a hash of geometry + parameters (use it as cache key),
   * `ctx.roomsVersion` hashes only the room outlines (the raster grid is cached on it).
   * A calibration fit (project.model.fit, SPEC 9) is part of the context while project.view.calibrate is on: ctx.p.n is
   * then the fitted exponent (ctx.p.baseN = project.model.n), ctx.wf the obstacle-loss multiplier (1 without a fit) and
   * ctx.fit = {n, wallFactor, offsets} (null without one) - so rebuild the context when view.calibrate changes too.
   * @param {object} project
   * @param {{fit?:false|object}} [opts] fit:false = ignore project.model.fit (the default model, e.g. for "before");
   *        fit:{n, wallFactor, byBand?} = use that fit
   * @returns {object} Ctx (opaque; read-only for callers except documented fields: version, roomsVersion, mpp, p, wf, fit)
   */
  function createContext(projectIn, opts) {
    // SPEC 14.3: the context of one floor (default: the active one) - a view with that floor's content at the top level
    const project = opts && opts.floor !== undefined && opts.floor !== null && PJ.atFloor ? PJ.atFloor(projectIn, opts.floor) : projectIn;
    const plan = project.plan;
    const mp = project.model;
    const mpp = project.scale.mpp;
    const bpRaw = mp.bandPower && typeof mp.bandPower === 'object' ? mp.bandPower : {};
    const bp = (k) => (isNum(bpRaw[k]) ? clamp(bpRaw[k], PJ.BAND_POWER_MIN, PJ.BAND_POWER_MAX) : 0);
    const fit = activeFit(project, opts);
    const p = {
      nearSignal: mp.nearSignal,
      n: fit ? fit.n : mp.n,
      wallLoss: mp.wallLoss,
      threshold: mp.threshold,
      rangeThreshold: mp.rangeThreshold,
      bandPower: { '2.4': bp('2.4'), '5': bp('5'), '6': bp('6') },
      baseN: mp.n,
      // band steering (SPEC 13): what the band 'auto' means for the point functions (signal / softSignal)
      routerBands: routerBandList(project),
      steer: steerOf(project),
    };

    // ---- rooms (px polygons, for rasterization) ----
    const rooms = [];
    const hr = new Hasher();
    const usable = (pts) => Array.isArray(pts) && pts.length >= 3 && pts.every((q) => q && isNum(q.x) && isNum(q.y));
    for (const r of plan.rooms) {
      if (!usable(r.points)) continue; // half-edited objects must not crash the model
      const n = r.points.length;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        x[i] = r.points[i].x * W;
        y[i] = r.points[i].y * H;
        hr.px(x[i]);
        hr.px(y[i]);
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
      }
      hr.add(r.roomId);
      rooms.push({ id: r.roomId, n, x, y, minX, minY, maxX, maxY });
    }
    const roomsVersion = hr.hex();

    // ---- walls (extended, direction vectors) ----
    const hv = new Hasher();
    hv.add(roomsVersion.length);
    for (const ch of roomsVersion) hv.add(ch.charCodeAt(0));
    const wallList = [];
    for (const w of plan.walls) {
      if (!w || !w.a || !w.b || !isNum(w.a.x) || !isNum(w.a.y) || !isNum(w.b.x) || !isNum(w.b.y)) continue;
      const ax = w.a.x * W;
      const ay = w.a.y * H;
      const bx = w.b.x * W;
      const by = w.b.y * H;
      const len = Math.hypot(bx - ax, by - ay);
      if (!(len >= 0.5)) continue; // degenerate wall: nothing to block
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      wallList.push({ id: w.id, ax: ax - ux * WALL_EXT, ay: ay - uy * WALL_EXT, bx: bx + ux * WALL_EXT, by: by + uy * WALL_EXT, loss: wallBands(w, mp.wallLoss) });
    }
    const nW = wallList.length;
    const wallIndexById = new Map();
    wallList.forEach((w, i) => {
      if (!wallIndexById.has(w.id)) wallIndexById.set(w.id, i);
    });
    const w = {
      n: nW,
      ax: new Float64Array(nW),
      ay: new Float64Array(nW),
      sx: new Float64Array(nW),
      sy: new Float64Array(nW),
      sl2: new Float64Array(nW),
      minX: new Float64Array(nW),
      maxX: new Float64Array(nW),
      minY: new Float64Array(nW),
      maxY: new Float64Array(nW),
      d0: new Int32Array(nW), // first door index (CSR layout), doors of wall i are d0[i] .. d1[i]-1
      d1: new Int32Array(nW),
    };
    // loss per band: lossW[k][i] = loss of wall i at band BAND_OF[k] (same for doors / furniture)
    const lossW = [new Float64Array(nW), new Float64Array(nW), new Float64Array(nW)];
    wallList.forEach((o, i) => {
      w.ax[i] = o.ax;
      w.ay[i] = o.ay;
      w.sx[i] = o.bx - o.ax;
      w.sy[i] = o.by - o.ay;
      w.sl2[i] = w.sx[i] * w.sx[i] + w.sy[i] * w.sy[i];
      w.minX[i] = Math.min(o.ax, o.bx) - 0.5;
      w.maxX[i] = Math.max(o.ax, o.bx) + 0.5;
      w.minY[i] = Math.min(o.ay, o.by) - 0.5;
      w.maxY[i] = Math.max(o.ay, o.by) + 0.5;
      hv.px(o.ax);
      hv.px(o.ay);
      hv.px(o.bx);
      hv.px(o.by);
      for (let b = 0; b < 3; b++) {
        lossW[b][i] = o.loss[b];
        hv.px(o.loss[b] * 10);
      }
    });

    // ---- doors, grouped by wall ----
    const perWall = Array.from({ length: nW }, () => []);
    for (const d of plan.doors) {
      const wi = d && d.a && d.b ? wallIndexById.get(d.wallId) : undefined;
      if (wi === undefined || !isNum(d.a.x) || !isNum(d.a.y) || !isNum(d.b.x) || !isNum(d.b.y)) continue;
      perWall[wi].push([d.a.x * W, d.a.y * H, d.b.x * W, d.b.y * H, doorBands(d)]);
    }
    const nD = perWall.reduce((s, a) => s + a.length, 0);
    const d = { n: nD, ax: new Float64Array(nD), ay: new Float64Array(nD), bx: new Float64Array(nD), by: new Float64Array(nD) };
    const lossD = [new Float64Array(nD), new Float64Array(nD), new Float64Array(nD)];
    let k = 0;
    for (let i = 0; i < nW; i++) {
      w.d0[i] = k;
      for (const [ax, ay, bx, by, loss] of perWall[i]) {
        d.ax[k] = ax;
        d.ay[k] = ay;
        d.bx[k] = bx;
        d.by[k] = by;
        hv.px(ax);
        hv.px(ay);
        hv.px(bx);
        hv.px(by);
        for (let b = 0; b < 3; b++) {
          lossD[b][k] = loss[b];
          hv.px(loss[b] * 10);
        }
        k++;
      }
      w.d1[i] = k;
    }

    // ---- furniture that blocks the signal (at any band) ----
    const fl = [];
    for (const o of plan.furniture) {
      if (!o || !usable(o.points)) continue;
      const loss = furnitureBands(o);
      if (loss[0] > 0 || loss[1] > 0 || loss[2] > 0) fl.push({ o, loss, pts: tracerRing(o.points) });
    }
    let nPts = 0;
    for (const it of fl) nPts += it.pts.length;
    const f = {
      n: fl.length,
      off: new Int32Array(fl.length),
      cnt: new Int32Array(fl.length),
      x: new Float64Array(nPts),
      y: new Float64Array(nPts),
      minX: new Float64Array(fl.length),
      maxX: new Float64Array(fl.length),
      minY: new Float64Array(fl.length),
      maxY: new Float64Array(fl.length),
      maxEdges: 0,
    };
    const lossF = [new Float64Array(fl.length), new Float64Array(fl.length), new Float64Array(fl.length)];
    let at = 0;
    fl.forEach(({ loss, pts }, i) => {
      f.off[i] = at;
      f.cnt[i] = pts.length;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const q of pts) {
        const x = q.x;
        const y = q.y;
        f.x[at] = x;
        f.y[at] = y;
        at++;
        hv.px(x);
        hv.px(y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      for (let b = 0; b < 3; b++) {
        lossF[b][i] = loss[b];
        hv.px(loss[b] * 10);
      }
      f.minX[i] = minX;
      f.maxX[i] = maxX;
      f.minY[i] = minY;
      f.maxY[i] = maxY;
      if (pts.length > f.maxEdges) f.maxEdges = pts.length;
    });

    hv.add(Math.round(mpp * 1e9));
    hv.add(Math.round(p.nearSignal * 100));
    hv.add(Math.round(p.n * 100));
    hv.add(Math.round(p.wallLoss * 100));
    for (const key of ['2.4', '5', '6']) hv.add(Math.round(p.bandPower[key] * 100));
    hv.add(nW);
    hv.add(nD);
    hv.add(f.n);
    if (fit) {
      // only with a fit, so the version of every unfitted context stays what it always was
      hv.add(0x5f17);
      hv.add(Math.round(fit.n * 1e6));
      hv.add(Math.round(fit.wallFactor * 1e6));
    }
    // SPEC 14.3: which floor this is and how the other floors stand to it (only with several floors, so the version
    // of every single-floor context stays what it always was)
    const floorId = PJ.activeFloorId ? PJ.activeFloorId(project) : null;
    const floorList = Array.isArray(project.floors) ? project.floors.filter((x) => x && typeof x === 'object') : [];
    const vert = new Map();
    let level = 0;
    for (const fl of floorList) if (fl.id === floorId && isNum(fl.level)) level = fl.level;
    if (floorList.length > 1) {
      const hashText = (txt) => {
        hv.add(txt.length);
        for (const ch of txt) hv.add(ch.charCodeAt(0));
      };
      hv.add(0x0f1);
      hashText(String(floorId));
      for (const fl of floorList) {
        if (fl.id === floorId) continue;
        const g = PJ.floorGap(project, fl.id, floorId);
        const ceil = scaled(g.lossDb);
        vert.set(fl.id, { levels: g.levels, heightM: g.heightM, lossDb: g.lossDb, dz2: g.heightM * g.heightM, ceil, wallW: CROSS_WALL_WEIGHT });
        hashText(String(fl.id));
        hv.add(g.levels);
        hv.px(g.heightM * 1000);
        hv.px(g.lossDb * 10);
      }
    }

    const src = {
      version: hv.hex(),
      roomsVersion,
      mpp,
      p,
      rooms,
      w,
      d,
      f,
      soft: clamp(FURN_SOFT_M / mpp, 3, 60), // px of chord for the full furniture loss
      // scratch buffers of the tracer (single threaded, non re-entrant by design; shared by the band views)
      sS: new Float64Array(nW + 1),
      sL: new Float64Array(nW + 1),
      sT: new Float64Array(f.maxEdges + 4),
      lossW,
      lossD,
      lossF,
      wf: fit ? fit.wallFactor : 1,
      fit,
      floor: floorId,
      level,
      vert,
      routerFloor: project.net && typeof project.net.routerFloor === 'string' ? project.net.routerFloor : null,
    };
    const ctx = bandView(src, 1);
    VIEWS.set(p, [null, ctx, null]);
    SIBLINGS.set(p, { project: projectIn, opts: opts || {}, map: new Map() });
    return ctx;
  }

  // the contexts of the other floors of a context's project (SPEC 14.3), created on demand and kept with the context
  const SIBLINGS = new WeakMap();
  /** Walls of the floor a signal arrives on count half along the horizontal path when it comes through a ceiling. */
  const CROSS_WALL_WEIGHT = 0.5;

  /**
   * The context of another floor of the same project (same fit option), cached on `ctx`; `ctx` itself for its own floor
   * or when the project has no such floor. Returned at 5 GHz like createContext().
   * @param {object} ctx
   * @param {string|null} floorId
   * @returns {object}
   */
  function floorContext(ctx, floorId) {
    if (!ctx || !ctx.p) return ctx;
    const base = (VIEWS.get(ctx.p) || [])[1] || ctx;
    if (floorId === undefined || floorId === null || floorId === ctx.floor) return base;
    const sib = SIBLINGS.get(ctx.p);
    if (!sib || !ctx.vert || !ctx.vert.has(floorId)) return base;
    let c = sib.map.get(floorId);
    if (!c) {
      c = createContext(sib.project, { ...sib.opts, floor: floorId });
      sib.map.set(floorId, c);
    }
    return c;
  }

  /**
   * How a source on floor `fid` stands to the context's floor: null = the same floor (or unknown), else
   * {levels, heightM, lossDb (5 GHz ref), dz2 (m²), ceil:[2.4, 5, 6 GHz dB], wallW}.
   */
  function vertOf(ctx, fid) {
    if (fid === undefined || fid === null || !ctx || fid === ctx.floor || !ctx.vert) return null;
    return ctx.vert.get(fid) || null;
  }

  /** A router / baseline point with its floor: one without a `floor` key is on the context's router floor. */
  function asRouter(ctx, pt) {
    if (!pt || pt.floor !== undefined || !ctx || ctx.routerFloor === null || ctx.routerFloor === undefined) return pt;
    return { x: pt.x, y: pt.y, floor: ctx.routerFloor };
  }

  /**
   * 3-D distance in metres between a source (`from`, possibly on another floor: from.floor) and a place on the
   * context's floor.
   */
  function distance3(ctx, from, to) {
    const dh = Math.hypot((to.x - from.x) * W, (to.y - from.y) * H) * ctx.mpp;
    const V = vertOf(ctx, from && from.floor);
    return V ? Math.sqrt(dh * dh + V.dz2) : dh;
  }

  // the band views of a context, keyed by its parameter object `p` (one per createContext, shared by its band views; a
  // WeakMap instead of a property keeps the context free of reference cycles, e.g. for JSON.stringify)
  const VIEWS = new WeakMap();
  const RING_SIMPLIFY_MIN = 16; // furniture outlines with more vertices are simplified for the tracer
  const RING_TOL_PX = 0.25; // ... to within a quarter of a canvas pixel (~3 mm)

  /**
   * A furniture outline in canvas px as the tracer uses it. Up to RING_SIMPLIFY_MIN vertices: exact. Above (a round
   * table drawn with 200 points): Douglas-Peucker to RING_TOL_PX - every ray otherwise tests every edge; a 200-gon becomes
   * ~20 edges, the shadow moves by less than a third of a pixel.
   */
  function tracerRing(points) {
    const n = points.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = points[i].x * W;
      ys[i] = points[i].y * H;
    }
    const all = () => Array.from(xs, (x, i) => ({ x, y: ys[i] }));
    if (n <= RING_SIMPLIFY_MIN) return all();
    let far = 0;
    let best = -1;
    for (let i = 1; i < n; i++) {
      const d = (xs[i] - xs[0]) * (xs[i] - xs[0]) + (ys[i] - ys[0]) * (ys[i] - ys[0]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[far] = 1;
    const stack = [0, far, far, n]; // index n is vertex 0 again (closed ring)
    while (stack.length) {
      const b = stack.pop();
      const a = stack.pop();
      if (b - a < 2) continue;
      const bx = xs[b % n];
      const by = ys[b % n];
      let maxD = -1;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = geom.pointSegDistPx(xs[i], ys[i], xs[a], ys[a], bx, by);
        if (d > maxD) {
          maxD = d;
          idx = i;
        }
      }
      if (maxD > RING_TOL_PX) {
        keep[idx] = 1;
        stack.push(a, idx, idx, b);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: xs[i], y: ys[i] });
    return out.length >= 3 ? out : all();
  }

  /**
   * The context as seen at band BAND_OF[k]: shares everything with the others (geometry, rooms, version, scratch
   * buffers) except the loss arrays wl / dl / fl. Always built by this one literal, so every view has
   * the same hidden class (the tracer's property loads stay monomorphic).
   */
  function bandView(src, k) {
    return {
      version: src.version,
      roomsVersion: src.roomsVersion,
      mpp: src.mpp,
      p: src.p,
      rooms: src.rooms,
      w: src.w,
      d: src.d,
      f: src.f,
      soft: src.soft,
      sS: src.sS,
      sL: src.sL,
      sT: src.sT,
      lossW: src.lossW,
      lossD: src.lossD,
      lossF: src.lossF,
      wf: src.wf,
      fit: src.fit,
      floor: src.floor,
      level: src.level,
      vert: src.vert,
      routerFloor: src.routerFloor,
      band: BAND_OF[k],
      wl: src.lossW[k],
      dl: src.lossD[k],
      fl: src.lossF[k],
    };
  }

  /**
   * The context for a band (2.4 | 5 | 6): same geometry and version, that band's obstacle losses. createContext()
   * returns the 5 GHz context; every model / raster / optimize function that takes a band resolves it itself, so
   * callers only need this for the low-level px helpers (traceLoss, crossLoss). Unknown band -> ctx unchanged.
   */
  function forBand(ctx, band) {
    const k = bandIndex(band);
    const views = k < 0 || !ctx || !ctx.p ? null : VIEWS.get(ctx.p);
    if (!views) return ctx;
    return views[k] || (views[k] = bandView(ctx, k));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // ray tracing
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Obstacle loss in dB along the straight ray (ax,ay)->(bx,by), CANVAS PIXELS. Hot path of everything.
   * @returns {number} dB >= 0
   */
  function traceLoss(ctx, ax, ay, bx, by) {
    const rx = bx - ax;
    const ry = by - ay;
    const rl2 = rx * rx + ry * ry;
    if (rl2 < 1e-6) return 0;
    const rl = Math.sqrt(rl2);
    const minX = ax < bx ? ax : bx;
    const maxX = ax < bx ? bx : ax;
    const minY = ay < by ? ay : by;
    const maxY = ay < by ? by : ay;
    let loss = 0;

    // ---- walls ----
    const w = ctx.w;
    const nW = w.n;
    if (nW) {
      const S = ctx.sS;
      const L = ctx.sL;
      const WL = ctx.wl;
      let nc = 0;
      for (let i = 0; i < nW; i++) {
        if (w.maxX[i] < minX || w.minX[i] > maxX || w.maxY[i] < minY || w.minY[i] > maxY) continue;
        const sx = w.sx[i];
        const sy = w.sy[i];
        const ex = w.ax[i] - ax;
        const ey = w.ay[i] - ay;
        const den = rx * sy - ry * sx;
        let pos;
        let l = WL[i];
        if (den * den > 1e-18 * rl2 * w.sl2[i]) {
          // regular crossing
          const inv = 1 / den;
          const t = (ex * sy - ey * sx) * inv;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          const u = (ex * ry - ey * rx) * inv;
          if (u < 0 || u > 1) continue;
          pos = t * rl;
          const d1 = w.d1[i];
          if (d1 > w.d0[i]) {
            // door lookup: crossing point vs door segments of this wall
            const cx = ax + t * rx;
            const cy = ay + t * ry;
            const dd = ctx.d;
            for (let k = w.d0[i]; k < d1; k++) {
              if (geom.pointSegDistPx(cx, cy, dd.ax[k], dd.ay[k], dd.bx[k], dd.by[k]) < DOOR_TOL) {
                l = ctx.dl[k];
                break;
              }
            }
          }
        } else {
          // parallel: only matters when the ray runs inside the wall
          const cr = ex * ry - ey * rx; // = perpendicular distance * rl
          if (cr * cr > COLLINEAR_TOL * COLLINEAR_TOL * rl2) continue;
          const ta = (ex * rx + ey * ry) / rl;
          const tb = ta + (sx * rx + sy * ry) / rl;
          const lo = Math.max(ta < tb ? ta : tb, 0);
          const hi = Math.min(ta < tb ? tb : ta, rl);
          if (hi - lo < 0.5) continue;
          pos = (lo + hi) / 2;
        }
        S[nc] = pos;
        L[nc] = l;
        nc++;
      }
      if (nc) {
        // insertion sort by position along the ray (nc is tiny)
        for (let i = 1; i < nc; i++) {
          const s = S[i];
          const l = L[i];
          let j = i - 1;
          while (j >= 0 && S[j] > s) {
            S[j + 1] = S[j];
            L[j + 1] = L[j];
            j--;
          }
          S[j + 1] = s;
          L[j + 1] = l;
        }
        // Crossings that lie close together along the ray (corners, T-junctions, duplicate or doubled walls) are one
        // obstacle: only the strongest of them counts. The merge is soft so the field stays continuous: crossings
        // closer than MERGE_NEAR px merge completely (plain MAX), farther than MERGE_FAR px they add up, in between
        // the weight follows a smoothstep. For two crossings the result is  max + min * (1 - w)  with merge weight w.
        let total = L[0];
        let cur = L[0];
        for (let i = 1; i < nc; i++) {
          const gap = S[i] - S[i - 1];
          let mw = 1; // merge weight: 1 = same obstacle, 0 = separate obstacles
          if (gap >= MERGE_FAR) mw = 0;
          else if (gap > MERGE_NEAR) {
            const u = (gap - MERGE_NEAR) / (MERGE_FAR - MERGE_NEAR);
            mw = 1 - u * u * (3 - 2 * u);
          }
          const l = L[i];
          total += l - mw * (l < cur ? l : cur);
          cur = mw * (l > cur ? l : cur) + (1 - mw) * l;
        }
        loss += total;
      }
    }

    // ---- furniture ----
    const f = ctx.f;
    const nF = f.n;
    if (nF) {
      const T = ctx.sT;
      const soft = ctx.soft;
      const ix = rx !== 0 ? 1 / rx : 0;
      const iy = ry !== 0 ? 1 / ry : 0;
      for (let i = 0; i < nF; i++) {
        if (f.maxX[i] < minX || f.minX[i] > maxX || f.maxY[i] < minY || f.minY[i] > maxY) continue;
        const cnt = f.cnt[i];
        if (cnt > 6) {
          // many-sided piece: first make sure the ray really crosses its bounding box (slab test, boxes grown by a
          // hair so a grazing ray is never dropped) - a long ray's bounding box overlaps many boxes it never enters
          let t0 = 0;
          let t1 = 1;
          if (rx !== 0) {
            let ta = (f.minX[i] - 1e-6 - ax) * ix;
            let tb = (f.maxX[i] + 1e-6 - ax) * ix;
            if (ta > tb) {
              const tt = ta;
              ta = tb;
              tb = tt;
            }
            if (ta > t0) t0 = ta;
            if (tb < t1) t1 = tb;
          }
          if (ry !== 0) {
            let ta = (f.minY[i] - 1e-6 - ay) * iy;
            let tb = (f.maxY[i] + 1e-6 - ay) * iy;
            if (ta > tb) {
              const tt = ta;
              ta = tb;
              tb = tt;
            }
            if (ta > t0) t0 = ta;
            if (tb < t1) t1 = tb;
          }
          if (t0 > t1) continue;
        }
        const off = f.off[i];
        let nt = 0;
        T[nt++] = 0;
        T[nt++] = 1;
        let px = f.x[off + cnt - 1];
        let py = f.y[off + cnt - 1];
        for (let k = 0; k < cnt; k++) {
          const qx = f.x[off + k];
          const qy = f.y[off + k];
          const sx = qx - px;
          const sy = qy - py;
          const den = rx * sy - ry * sx;
          if (den !== 0) {
            const ex = px - ax;
            const ey = py - ay;
            const inv = 1 / den;
            const t = (ex * sy - ey * sx) * inv;
            if (t > 0 && t < 1) {
              const u = (ex * ry - ey * rx) * inv;
              if (u >= 0 && u <= 1) T[nt++] = t;
            }
          }
          px = qx;
          py = qy;
        }
        // sort the (few) parameters
        for (let a = 1; a < nt; a++) {
          const v = T[a];
          let j = a - 1;
          while (j >= 0 && T[j] > v) {
            T[j + 1] = T[j];
            j--;
          }
          T[j + 1] = v;
        }
        // chord = total length of the sub-segments whose midpoint lies inside the polygon
        let chord = 0;
        for (let a = 1; a < nt; a++) {
          const t0 = T[a - 1];
          const t1 = T[a];
          if (t1 - t0 < 1e-9) continue;
          const tm = (t0 + t1) / 2;
          if (inside(f, off, cnt, ax + rx * tm, ay + ry * tm)) chord += (t1 - t0) * rl;
        }
        if (chord > 0) loss += ctx.fl[i] * (chord >= soft ? 1 : chord / soft);
      }
    }
    // calibration fit (SPEC 9): every obstacle loss x wallFactor (exactly x 1 without a fit, so bit for bit unchanged)
    return loss * ctx.wf;
  }

  /** Even-odd inside test on the flat furniture arrays. */
  function inside(f, off, cnt, x, y) {
    let c = false;
    let j = off + cnt - 1;
    for (let i = off; i < off + cnt; j = i++) {
      const yi = f.y[i];
      const yj = f.y[j];
      if (yi > y !== yj > y && x < ((f.x[j] - f.x[i]) * (y - yi)) / (yj - yi) + f.x[i]) c = !c;
    }
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // softening helpers (px)
  // ---------------------------------------------------------------------------------------------------------------

  /** Resolve a `soften` parameter (metres): undefined/null/not a number -> SOFTEN, clamped to 0..SOFTEN_MAX. */
  function softenOf(v) {
    return isNum(v) ? clamp(v, 0, SOFTEN_MAX) : SOFTEN;
  }

  /**
   * Loss of wall `i` where it crosses the segment (ax,ay)->(bx,by), door aware; -1 when it does not cross. A crossing
   * counts when it lies after the start and up to and including the end of the segment; walls parallel to the
   * segment never cross. (The extended wall, as the tracer sees it.)
   */
  function crossLoss(ctx, i, ax, ay, bx, by) {
    const w = ctx.w;
    const rx = bx - ax;
    const ry = by - ay;
    const sx = w.sx[i];
    const sy = w.sy[i];
    const den = rx * sy - ry * sx;
    if (den * den <= 1e-18 * (rx * rx + ry * ry) * w.sl2[i]) return -1;
    const ex = w.ax[i] - ax;
    const ey = w.ay[i] - ay;
    const inv = 1 / den;
    const t = (ex * sy - ey * sx) * inv;
    if (t <= 0 || t > 1) return -1;
    const u = (ex * ry - ey * rx) * inv;
    if (u < 0 || u > 1) return -1;
    return wallLossAt(ctx, i, ax + t * rx, ay + t * ry);
  }

  /** Loss of wall i at a crossing point (px) at the context's band: the door's loss inside a door span, else the wall's. */
  function wallLossAt(ctx, i, cx, cy) {
    const w = ctx.w;
    const dd = ctx.d;
    for (let k = w.d0[i]; k < w.d1[i]; k++) {
      if (geom.pointSegDistPx(cx, cy, dd.ax[k], dd.ay[k], dd.bx[k], dd.by[k]) < DOOR_TOL) return ctx.dl[k];
    }
    return ctx.wl[i];
  }

  /**
   * True when a wall (or a closed door) of >= BARRIER_DB lies between two px points: the softening never crosses it.
   * Decided on the 5 GHz reference losses whatever the band of `ctx`, so the softening mask (and raster's cached blur
   * plan) is the same for every band.
   */
  function wallBlocks(ctx, ax, ay, bx, by) {
    const views = VIEWS.get(ctx.p);
    const ref = views ? views[1] : ctx;
    const w = ref.w;
    const minX = ax < bx ? ax : bx;
    const maxX = ax < bx ? bx : ax;
    const minY = ay < by ? ay : by;
    const maxY = ay < by ? by : ay;
    for (let i = 0; i < w.n; i++) {
      if (w.maxX[i] < minX || w.minX[i] > maxX || w.maxY[i] < minY || w.minY[i] > maxY) continue;
      if (crossLoss(ref, i, ax, ay, bx, by) >= BARRIER_DB) return true;
    }
    return false;
  }

  /**
   * How many walls (or closed doors) the straight line a -> b (normalized points) passes through: crossings whose loss
   * there is at least BARRIER_DB (an open doorway does not count); crossings closer than MERGE_NEAR px along the line
   * (a corner, a T-junction, a doubled wall) count once; a line running along a wall does not cross it. Decided on the
   * 5 GHz reference losses, so the answer is the same for every band and with or without a calibration fit.
   */
  function wallCount(ctx, a, b) {
    const views = VIEWS.get(ctx.p);
    const ref = views ? views[1] : ctx;
    const w = ref.w;
    const ax = a.x * W;
    const ay = a.y * H;
    const bx = b.x * W;
    const by = b.y * H;
    const rx = bx - ax;
    const ry = by - ay;
    const rl2 = rx * rx + ry * ry;
    if (rl2 < 1e-6) {
      const V0 = vertOf(ctx, a.floor);
      return V0 ? V0.levels : 0;
    }
    const rl = Math.sqrt(rl2);
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    const at = [];
    for (let i = 0; i < w.n; i++) {
      if (w.maxX[i] < minX || w.minX[i] > maxX || w.maxY[i] < minY || w.minY[i] > maxY) continue;
      const sx = w.sx[i];
      const sy = w.sy[i];
      const den = rx * sy - ry * sx;
      if (den * den <= 1e-18 * rl2 * w.sl2[i]) continue;
      const ex = w.ax[i] - ax;
      const ey = w.ay[i] - ay;
      const inv = 1 / den;
      const t = (ex * sy - ey * sx) * inv;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const u = (ex * ry - ey * rx) * inv;
      if (u < 0 || u > 1) continue;
      if (wallLossAt(ref, i, ax + t * rx, ay + t * ry) < BARRIER_DB) continue;
      at.push(t * rl);
    }
    at.sort((p, q) => p - q);
    let count = 0;
    let last = -Infinity;
    for (const s of at) {
      if (s - last >= MERGE_NEAR) count++;
      last = s;
    }
    // SPEC 14.3: from another floor every ceiling crossed counts as one more obstacle
    const V = vertOf(ctx, a.floor);
    return V ? count + V.levels : count;
  }

  /** Room id at a px point using the exact polygons (last room wins, like raster.grid); 0 = outside every room. */
  function roomAtPx(ctx, x, y) {
    for (let r = ctx.rooms.length - 1; r >= 0; r--) {
      const rm = ctx.rooms[r];
      if (x < rm.minX || x > rm.maxX || y < rm.minY || y > rm.maxY) continue;
      let c = false;
      for (let i = 0, j = rm.n - 1; i < rm.n; j = i++) {
        if (rm.y[i] > y !== rm.y[j] > y && x < ((rm.x[j] - rm.x[i]) * (y - rm.y[i])) / (rm.y[j] - rm.y[i]) + rm.x[i]) c = !c;
      }
      if (c) return rm.id;
    }
    return 0;
  }

  /**
   * Softened obstacle loss (dB) at the px point (x,y) for a source at (sx,sy): the mean of traceLoss over the Gaussian
   * stencil of sigma `sigmaPx` around (x,y), using only stencil points on the floor that are not behind a wall (or
   * closed door) as seen from (x,y) - the same rule as the raster. sigmaPx <= 0 or a point off the floor -> the exact
   * traceLoss.
   */
  function softLossPx(ctx, sx, sy, x, y, sigmaPx) {
    if (!(sigmaPx > 0)) return traceLoss(ctx, sx, sy, x, y);
    if (!roomAtPx(ctx, x, y)) return traceLoss(ctx, sx, sy, x, y);
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < SOFT_N; k++) {
      const qx = x + sigmaPx * SOFT_UX[k];
      const qy = y + sigmaPx * SOFT_UY[k];
      if (!roomAtPx(ctx, qx, qy) || wallBlocks(ctx, x, y, qx, qy)) continue;
      sum += traceLoss(ctx, sx, sy, qx, qy);
      cnt++;
    }
    return cnt ? sum / cnt : traceLoss(ctx, sx, sy, x, y);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // signal functions (normalized points)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Constant part of the signal for a band: nearSignal - 20*log10(band/5) + model.bandPower[band] (the per-band
   * transmit power difference, SPEC 7.1; 0 by default).
   */
  function bandBase(ctx, band) {
    const bp = ctx.p.bandPower;
    const extra = bp ? bp[units.bandKey(band)] : 0;
    return ctx.p.nearSignal - 20 * Math.log10(band / 5) + (extra || 0);
  }

  /**
   * Obstacle loss in dB between two NORMALIZED points, exact rays, at `band` (default: the band of ctx - 5 GHz for
   * the context createContext() returns).
   */
  function obstacleLoss(ctx, a, b, band) {
    const c = band === undefined ? ctx : forBand(ctx, band);
    const L = traceLoss(c, a.x * W, a.y * H, b.x * W, b.y * H);
    // SPEC 14.3: from another floor (a.floor) the walls of this floor count half, plus the ceilings crossed
    const V = vertOf(c, a.floor);
    return V ? V.wallW * L + V.ceil[bandIndexOf(c)] * c.wf : L;
  }

  /** 0 / 1 / 2 of the band view of a context (5 GHz for an unknown band). */
  const bandIndexOf = (c) => {
    const k = bandIndex(c.band);
    return k < 0 ? 1 : k;
  };

  /**
   * Uncalibrated, unclamped signal in dBm.
   * @param {object} ctx
   * @param {{x:number,y:number}} from transmitter (normalized)
   * @param {{x:number,y:number}} to receiver (normalized)
   * @param {number} band 2.4 | 5 | 6
   * @param {{nodePower?:number}} [opts] nodePower: dB added (transmit power of a second node)
   */
  function rawSignal(ctx, from, to, band, opts) {
    const c = forBand(ctx, band);
    const ax = from.x * W;
    const ay = from.y * H;
    const bx = to.x * W;
    const by = to.y * H;
    const extra = opts && isNum(opts.nodePower) ? opts.nodePower : 0;
    const V = vertOf(c, from.floor);
    if (V) {
      // SPEC 14.3: a source on another floor - 3-D distance, the ceilings crossed, this floor's walls half
      const dh = Math.hypot(bx - ax, by - ay) * c.mpp;
      const dm = Math.sqrt(dh * dh + V.dz2);
      return bandBase(c, band) - 10 * c.p.n * Math.log10(dm < 1 ? 1 : dm) - (V.wallW * traceLoss(c, ax, ay, bx, by) + V.ceil[bandIndexOf(c)] * c.wf) + extra;
    }
    const dm = Math.hypot(bx - ax, by - ay) * c.mpp;
    return bandBase(c, band) - 10 * c.p.n * Math.log10(dm < 1 ? 1 : dm) - traceLoss(c, ax, ay, bx, by) + extra;
  }

  /**
   * Calibrated signal clamped to [-110, -20] dBm: rawSignal + offset. Exact ray physics (no softening).
   * band 'auto' (SPEC 13): the router's signal on the band a steering client uses at `to` (the context's router bands
   * and thresholds; offset = a number for every band or an offsets map).
   */
  function signal(ctx, from, to, band, offset) {
    if (units.normBandMode(band) === 'auto') return autoPoint(ctx, from, to, offset, 0);
    return clamp(rawSignal(ctx, from, to, band) + (offset || 0), MIN_SIGNAL, MAX_SIGNAL);
  }

  /** signal() / softSignal() for the band 'auto': every router band of ctx, then the steering rule. */
  function autoPoint(ctx, from, to, offset, soften) {
    const bands = (ctx && ctx.p && ctx.p.routerBands) || routerBandList(null);
    const sig = {};
    for (const b of bands) {
      const off = isNum(offset) ? offset : offsetFor(offset, b);
      sig[units.bandKey(b)] = softSignal(ctx, from, to, b, off, soften);
    }
    const pick = steerBand(sig, bands, ctx && ctx.p && ctx.p.steer);
    return pick === null ? NaN : sig[units.bandKey(pick)];
  }

  /**
   * Softened obstacle loss in dB between two NORMALIZED points; soften in metres (default SOFTEN, 0 = exact); band
   * as in obstacleLoss (default: the band of ctx).
   */
  function softObstacleLoss(ctx, a, b, soften, band) {
    const c = band === undefined ? ctx : forBand(ctx, band);
    const L = softLossPx(c, a.x * W, a.y * H, b.x * W, b.y * H, softenOf(soften) / c.mpp);
    const V = vertOf(c, a.floor);
    return V ? V.wallW * L + V.ceil[bandIndexOf(c)] * c.wf : L;
  }

  /** rawSignal with the softened obstacle loss (uncalibrated, unclamped). */
  function softRawSignal(ctx, from, to, band, soften) {
    const s = softenOf(soften);
    if (!(s > 0)) return rawSignal(ctx, from, to, band);
    const c = forBand(ctx, band);
    const ax = from.x * W;
    const ay = from.y * H;
    const bx = to.x * W;
    const by = to.y * H;
    const dh = Math.hypot(bx - ax, by - ay) * c.mpp;
    const V = vertOf(c, from.floor);
    if (V) {
      const dm = Math.sqrt(dh * dh + V.dz2);
      return bandBase(c, band) - 10 * c.p.n * Math.log10(dm < 1 ? 1 : dm) - (V.wallW * softLossPx(c, ax, ay, bx, by, s / c.mpp) + V.ceil[bandIndexOf(c)] * c.wf);
    }
    return bandBase(c, band) - 10 * c.p.n * Math.log10(dh < 1 ? 1 : dh) - softLossPx(c, ax, ay, bx, by, s / c.mpp);
  }

  /**
   * The signal as the heat map shows it at one point: softened (see the file header), + offset, clamped to
   * [-110, -20] dBm. soften in metres (default SOFTEN; 0 -> identical to signal()). Agrees with raster.sample() of a
   * raster.field() with the same soften to a few tenths of a dB.
   */
  function softSignal(ctx, from, to, band, offset, soften) {
    if (units.normBandMode(band) === 'auto') return autoPoint(ctx, from, to, offset, soften);
    const s = softenOf(soften);
    if (!(s > 0)) return signal(ctx, from, to, band, offset);
    return clamp(softRawSignal(ctx, from, to, band, s) + (offset || 0), MIN_SIGNAL, MAX_SIGNAL);
  }

  /** Offset (dB) for a band out of an offsets map {'2.4':dB,'5':dB,'6':dB}; 0 when missing. */
  function offsetFor(offsets, band) {
    if (!offsets) return 0;
    const v = offsets[units.bandKey(band)];
    return isNum(v) ? v : 0;
  }

  /** Is this node transmitting on this band? `node` as built by nodeList() / nodeParams() (switched off: never). */
  function nodeActive(node, band) {
    return !!(node && node.mode !== 'none' && node.enabled !== false && node.pos && node.bands && node.bands[units.bandKey(band)]);
  }

  /** True for scenarios with a wireless uplink (mesh over Wi-Fi, repeater). */
  function isWirelessNode(node) {
    return !!(node && WIRELESS.includes(node.mode));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // band steering (SPEC 13): which band a steering client (band steering, Wi-Fi 7 MLO) uses at a place
  // ---------------------------------------------------------------------------------------------------------------

  /** Default thresholds of the steering rule (dBm): 6 GHz from -70, else 5 GHz from -72, else 2.4 GHz. */
  const STEER = PJ.STEER_DEFAULT;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /**
   * The bands the router sends, ascending: from a project (net.routerBands), a routerBands map {'2.4':bool,...} or a
   * list of bands. Nothing usable (or no band on) -> the default [2.4, 5].
   * @returns {number[]}
   */
  function routerBandList(src) {
    let list;
    if (Array.isArray(src)) list = src.map((b) => units.normBand(b));
    else {
      const map = isObj(src) && isObj(src.net) ? src.net.routerBands : src;
      list = isObj(map) ? E.BANDS.filter((b) => map[units.bandKey(b)] === true) : [];
    }
    const out = E.BANDS.filter((b) => list.includes(b));
    return out.length ? out : E.BANDS.filter((b) => PJ.ROUTER_BANDS_DEFAULT[units.bandKey(b)]);
  }

  /** The steering thresholds {six, five} (dBm) of a project (model.steer) or a {six, five} object; garbage -> defaults. */
  function steerOf(src) {
    const st = isObj(src) && isObj(src.model) ? src.model.steer : src;
    const one = (v, def) => (isNum(v) ? clamp(v, PJ.STEER_MIN, PJ.STEER_MAX) : def);
    return { six: one(isObj(st) ? st.six : undefined, STEER.six), five: one(isObj(st) ? st.five : undefined, STEER.five) };
  }

  /**
   * THE steering rule (SPEC 13): 6 GHz when the router sends it and its signal >= steer.six, else 5 GHz when sent and
   * >= steer.five, else 2.4 GHz when sent, else (a router without 2.4 GHz) the strongest band it sends.
   * @param {{'2.4'?:number,'5'?:number,'6'?:number}} sig signal per band (missing / NaN = the band is not there)
   * @param {Array|object} bands the router's bands (routerBandList() input)
   * @param {{six:number, five:number}} [steer] thresholds (steerOf() input)
   * @returns {2.4|5|6|null} null only when no band of the router has a signal
   */
  function steerBand(sig, bands, steer) {
    const list = routerBandList(bands);
    const st = steerOf(steer);
    const at = (b) => {
      const v = isObj(sig) ? sig[units.bandKey(b)] : undefined;
      return isNum(v) ? v : null;
    };
    const has = (b) => list.includes(b) && at(b) !== null;
    if (has(6) && at(6) >= st.six) return 6;
    if (has(5) && at(5) >= st.five) return 5;
    if (has(2.4)) return 2.4;
    let best = null;
    for (const b of list) if (at(b) !== null && (best === null || at(b) > at(best))) best = b;
    return best;
  }

  /** True for the band mode 'auto' or a state / params object whose band is 'auto'. */
  function isAuto(v) {
    return units.normBandMode(isObj(v) ? (v.band !== undefined ? v.band : v.targetBand) : v) === 'auto';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // nodes (SPEC 14.2): any number of access points / mesh nodes / repeaters, each on its floor, with an uplink chain
  // ---------------------------------------------------------------------------------------------------------------

  const EMPTY = Object.freeze([]);
  const NODE_KIND_LIST = ['ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater'];

  /**
   * Every node that can serve, as field params, in building order (floors by level, then each floor's list; the order of
   * the raster's winner indices): enabled, a known mode, a position, and an uplink chain that reaches the router through
   * enabled nodes (a node behind a switched-off node has no internet and is left out).
   * @param {object} project
   * @returns {Array<{id:string, name:string, index:number, floor:string|null, mode:string, pos:{x:number,y:number,floor:string|null},
   *   power:number, bands:object, backhaulBand:number, backhaulThreshold:number, maxMbps:number|null, uplink:string,
   *   uplinkIndex:number}>} uplinkIndex = -1 for the router, else the index of the uplink node in this list
   */
  function nodeList(project) {
    if (!project || typeof project !== 'object') return [];
    let entries;
    if (Array.isArray(project.nodes) || Array.isArray(project.floors)) entries = PJ.allNodes(project);
    else if (isObj(project.node) && NODE_KIND_LIST.includes(project.node.mode)) entries = [{ node: { ...project.node, id: 'node-1', name: '', uplink: 'router', enabled: true }, floor: null }];
    else entries = [];
    const usable = (e) => e.node.enabled !== false && NODE_KIND_LIST.includes(e.node.mode) && e.node.pos && isNum(e.node.pos.x) && isNum(e.node.pos.y);
    const byId = new Map();
    for (const e of entries) if (!byId.has(e.node.id)) byId.set(e.node.id, e);
    // does the chain reach the router through usable nodes? (cycles and missing nodes: no)
    const ok = new Map();
    const reaches = (e) => {
      const seen = new Set();
      let cur = e;
      for (;;) {
        if (ok.has(cur.node.id)) return ok.get(cur.node.id);
        if (!usable(cur) || seen.has(cur.node.id)) return false;
        seen.add(cur.node.id);
        const up = cur.node.uplink;
        if (up === undefined || up === null || up === 'router') return true;
        const next = byId.get(up);
        if (!next) return false;
        cur = next;
      }
    };
    for (const e of entries) ok.set(e.node.id, reaches(e));
    const list = entries.filter((e) => ok.get(e.node.id));
    const index = new Map(list.map((e, i) => [e.node.id, i]));
    return list.map((e, i) => {
      const n = e.node;
      const up = n.uplink && n.uplink !== 'router' && index.has(n.uplink) ? n.uplink : 'router';
      return {
        id: n.id,
        name: typeof n.name === 'string' ? n.name : '',
        index: i,
        floor: e.floor === undefined ? null : e.floor,
        mode: n.mode,
        pos: { x: n.pos.x, y: n.pos.y, floor: e.floor === undefined ? null : e.floor },
        power: isNum(n.power) ? n.power : 0,
        bands: { ...(isObj(n.bands) ? n.bands : {}) },
        backhaulBand: n.backhaulBand,
        backhaulThreshold: n.backhaulThreshold,
        maxMbps: isNum(n.maxMbps) && n.maxMbps > 0 ? n.maxMbps : null,
        uplink: up,
        uplinkIndex: up === 'router' ? -1 : index.get(up),
      };
    });
  }

  /**
   * The first serving node (compat with the single-node API), or null.
   * @returns {object|null} see nodeList
   */
  function nodeParams(project) {
    return nodeList(project)[0] || null;
  }

  /**
   * The nodes of a state / params object (SPEC 14.2): state.nodes. A caller that sets the legacy single `node` itself
   * (an own enumerable key, e.g. {...state, node: X} or {...state, node: null}) gets exactly that one (or none) - the
   * `node` fieldParams() puts into a state is a non-enumerable mirror of nodes[0], so a spread never carries it.
   */
  function stateNodes(state) {
    if (!state || typeof state !== 'object') return EMPTY;
    if (Object.prototype.propertyIsEnumerable.call(state, 'node')) return state.node && state.node.mode !== 'none' && state.node.pos ? [state.node] : EMPTY;
    return Array.isArray(state.nodes) ? state.nodes : EMPTY;
  }

  /** Index (in `nodes`) of the uplink node of `nd`, -1 for the router. */
  function uplinkIndexOf(nodes, nd) {
    if (Number.isInteger(nd.uplinkIndex) && nd.uplinkIndex >= 0 && nd.uplinkIndex < nodes.length && nodes[nd.uplinkIndex] !== nd) return nd.uplinkIndex;
    if (nd.uplink && nd.uplink !== 'router') {
      const k = nodes.findIndex((x) => x && x.id === nd.uplink && x !== nd);
      if (k >= 0) return k;
    }
    return -1;
  }

  /**
   * Field/combined-signal parameters ("state") for the model, built from a project.
   * which = 'trial' (router at net.router + every serving node) or 'today' (router at net.baseline, no node: the
   * measurements were taken in that situation).
   * @param {object} project
   * @param {'trial'|'today'} [which='trial']
   * @param {{band?:number|'auto', offsets?:object, soften?:number}} [opts] band default view.band; offsets from
   *        offsets(); default all 0. soften (metres) is copied into the state only when given (the default SOFTEN
   *        applies everywhere otherwise)
   * @returns {{band:number|'auto', router:{x,y,floor?}, baseline:{x,y,floor?}, nodes:object[], node:object|null,
   *            offsets:object, soften?:number, bands?:number[], steer?:{six:number, five:number}}} router / baseline carry
   *            net.routerFloor (SPEC 14.3); nodes = nodeList() ([] for 'today'), node = nodes[0] (compat); bands / steer
   *            only in the band mode 'auto' (SPEC 13)
   */
  function fieldParams(project, which, opts) {
    const o = opts || {};
    const today = which === 'today';
    const band = units.normBandMode(o.band) || units.normBandMode(project.view && project.view.band) || 5;
    const rf = project.net && typeof project.net.routerFloor === 'string' ? project.net.routerFloor : undefined;
    const withFloor = (q) => (rf === undefined ? { ...q } : { x: q.x, y: q.y, floor: rf });
    const nodes = today ? [] : nodeList(project);
    const st = {
      band,
      router: withFloor(today ? project.net.baseline : project.net.router),
      nodes,
      offsets: o.offsets || { '2.4': 0, '5': 0, '6': 0 },
      baseline: withFloor(project.net.baseline),
    };
    // compat: the first node as the old single `node` - non-enumerable, so {...state, node: X} stays a legacy override
    Object.defineProperty(st, 'node', { value: nodes[0] || null, enumerable: false, writable: true, configurable: true });
    if (band === 'auto') {
      // band mode Auto (SPEC 13): every place on the band a steering client would use there
      st.bands = routerBandList(project);
      st.steer = steerOf(project);
    }
    if (o.soften !== undefined) st.soften = softenOf(o.soften);
    return st;
  }

  /**
   * Router and every node serving `band` at p, softened like the heat map: {router, nodes:(dBm|null)[], best, winner}
   * (winner 0 = router, k = nodes[k-1]; the router wins ties).
   */
  function sourcesAt(ctx, p, band, state) {
    const off = offsetFor(state.offsets, band);
    const router = softSignal(ctx, asRouter(ctx, state.router), p, band, off, state.soften);
    const nodes = stateNodes(state);
    const per = new Array(nodes.length).fill(null);
    let best = router;
    let winner = 0;
    let strongest = -1;
    for (let k = 0; k < nodes.length; k++) {
      const nd = nodes[k];
      if (!nodeActive(nd, band)) continue;
      const v = softSignal(ctx, nd.pos, p, band, off + (nd.power || 0), state.soften);
      per[k] = v;
      if (strongest < 0 || v > per[strongest]) strongest = k;
      if (v > best) {
        best = v;
        winner = k + 1;
      }
    }
    return { router, nodes: per, best, winner, strongest };
  }

  /**
   * Strongest signal at p from the router and every node serving this band (SPEC 14.2) - softened like the heat
   * map (state.soften, default SOFTEN; 0 = exact rays). A node on another floor comes through the ceiling (SPEC 14.3).
   * @param {object} ctx
   * @param {{x,y}} p normalized
   * @param {number} band
   * @param {object} state as produced by fieldParams()
   */
  function combinedSignal(ctx, p, band, state) {
    if (units.normBandMode(band) === 'auto') return steeredSignal(ctx, p, { ...state, band: 'auto' }).signal;
    return sourcesAt(ctx, p, band, state).best;
  }

  /**
   * Signal of a node's wireless uplink (SPEC 14.2): from its uplink - the router, or the uplink node (whose power is
   * added) - to the node, on the node's backhaul band, traced on the node's floor (SPEC 14.3), softened, calibrated.
   * Compare with node.backhaulThreshold. null without such a node.
   * @param {object} ctx
   * @param {object} state fieldParams() result
   * @param {number} [index=0] index into state.nodes
   */
  function backhaulSignal(ctx, state, index) {
    const nodes = stateNodes(state);
    const k = Number.isInteger(index) ? index : 0;
    const nd = nodes[k];
    if (!nd || nd.mode === 'none' || !nd.pos || !state.router) return null;
    const bb = nd.backhaulBand || 5;
    const ui = uplinkIndexOf(nodes, nd);
    const src = ui >= 0 ? nodes[ui].pos : asRouter(ctx, state.router);
    const extra = ui >= 0 ? nodes[ui].power || 0 : 0;
    const c = nd.pos.floor !== undefined && nd.pos.floor !== null && nd.pos.floor !== ctx.floor ? floorContext(ctx, nd.pos.floor) : ctx;
    return softSignal(c, src, { x: nd.pos.x, y: nd.pos.y }, bb, offsetFor(state.offsets, bb) + extra, state.soften);
  }

  /** backhaulSignal() of every node of the state (same order). */
  function backhaulSignals(ctx, state) {
    return stateNodes(state).map((_, k) => backhaulSignal(ctx, state, k));
  }

  /**
   * The signal a band-steering client gets at p (SPEC 13): the combined signal (router + every node serving that
   * band, softened, calibrated) of every band the router sends, and the band the steering rule picks there. A state
   * with one band gives that band.
   * @param {object} ctx
   * @param {{x,y}} p normalized
   * @param {object} state fieldParams() result
   * @returns {{band:2.4|5|6|null, signal:number|null, byBand:{'2.4':number|null,'5':number|null,'6':number|null},
   *            nodeWins:boolean, winner:number}} winner (SPEC 14.2) = 0 router / k = state.nodes[k-1] on the picked band
   */
  function steeredSignal(ctx, p, state) {
    const auto = isAuto(state);
    const one = units.normBand(state && state.band);
    const bands = auto ? routerBandList(state.bands) : one === null ? [] : [one];
    const byBand = { '2.4': null, '5': null, '6': null };
    const wins = { '2.4': 0, '5': 0, '6': 0 };
    for (const b of bands) {
      const k = units.bandKey(b);
      const r = sourcesAt(ctx, p, b, state);
      byBand[k] = r.best;
      wins[k] = r.winner;
    }
    const band = auto ? steerBand(byBand, bands, state.steer) : bands.length ? bands[0] : null;
    const k = band === null ? null : units.bandKey(band);
    const winner = k === null ? 0 : wins[k];
    return { band, signal: k === null ? null : byBand[k], byBand, nodeWins: winner > 0, winner };
  }

  /**
   * Everything a tooltip needs at point p - softened exactly like the heat map (state.soften, default SOFTEN), so the
   * number matches the colour under the pointer.
   * @param {object} ctx
   * @param {{x,y}} p normalized
   * @param {object} state fieldParams() result (needs band, router, nodes / node, offsets, baseline; optional soften)
   * @returns {{band:number, router:number, node:number|null, nodes:(number|null)[], nodeIndex:number, nodeId:string|null,
   *            winner:number, combined:number, baseline:number|null, bestSource:'router'|'node', backhaul:number|null,
   *            weakBackhaul:boolean, byBand?:object, baselineBand?:number|null, steered?:true}}
   *          band = the band of the numbers; router = trial router only; nodes = every node alone (null: off for this
   *          band); node / nodeIndex / nodeId = the strongest node (null / -1 / null without one); winner = 0 router,
   *          k = state.nodes[k-1]; combined = the strongest of all; baseline = today's router alone (null when
   *          state.baseline missing); backhaul / weakBackhaul = of the strongest node.
   *          Band mode 'auto' (SPEC 13): band = the band a steering client uses at p in the trial, byBand = the trial's
   *          combined signal per band, baseline / baselineBand = what a steering client gets there today.
   */
  function pointSignalDetail(ctx, p, state) {
    if (isAuto(state)) {
      // band mode Auto (SPEC 13): the numbers of the band a steering client uses here in the trial; the baseline is
      // what a steering client gets here TODAY (on its own band), so combined - baseline is the change it notices
      const st = steeredSignal(ctx, p, state);
      const d = detailOn(ctx, p, state, st.band === null ? 5 : st.band);
      d.byBand = st.byBand;
      d.steered = true;
      d.baselineBand = null;
      d.baseline = null;
      if (state.baseline) {
        const t = steeredSignal(ctx, p, { band: 'auto', bands: state.bands, steer: state.steer, router: state.baseline, nodes: [], node: null, offsets: state.offsets, soften: state.soften });
        d.baseline = t.signal;
        d.baselineBand = t.band;
      }
      return d;
    }
    return detailOn(ctx, p, state, state.band);
  }

  /** pointSignalDetail() on one band. */
  function detailOn(ctx, p, state, band) {
    const off = offsetFor(state.offsets, band);
    const sf = state.soften;
    const r = sourcesAt(ctx, p, band, state);
    const nodes = stateNodes(state);
    const baseline = state.baseline ? softSignal(ctx, asRouter(ctx, state.baseline), p, band, off, sf) : null;
    const k = r.strongest;
    const nd = k >= 0 ? nodes[k] : null;
    const backhaul = nd ? backhaulSignal(ctx, state, k) : nodes.length ? backhaulSignal(ctx, state, 0) : null;
    const winNode = r.winner > 0 ? nodes[r.winner - 1] : null;
    const winBackhaul = winNode ? (r.winner - 1 === k ? backhaul : backhaulSignal(ctx, state, r.winner - 1)) : null;
    return {
      band: units.normBand(band),
      router: r.router,
      node: k >= 0 ? r.nodes[k] : null,
      nodes: r.nodes,
      nodeIndex: k,
      nodeId: nd ? nd.id || null : null,
      winner: r.winner,
      combined: r.best,
      baseline,
      bestSource: r.winner > 0 ? 'node' : 'router',
      backhaul,
      weakBackhaul: !!(winNode && isWirelessNode(winNode) && winBackhaul !== null && winBackhaul < winNode.backhaulThreshold),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // calibration
  // ---------------------------------------------------------------------------------------------------------------

  const profileKey = (s) => String(s === undefined || s === null ? '' : s).trim().toLowerCase();

  /** dB: a measurement farther than this from the fitted model is an outlier (flagged, not used; SPEC 9). */
  const OUTLIER_DB = 12;
  const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /**
   * Robust offset of a set of residuals (dB) - the rule of the FITTED model (SPEC 9), shared by calibrate() and
   * fitCalibration() so the stored fit and the live calibration agree:
   *   >= 4 values: the mean, after dropping - one at a time - the value farthest from the mean while it is more than
   *               OUTLIER_DB away (at most a quarter of the values, at least one);
   *   3 values:    the median; a value more than OUTLIER_DB from it is dropped (the offset is then the mean of the others);
   *   1-2 values:  the median (nothing can be told apart).
   * The result does not depend on the order of the values: sums run in `keys` order (e.g. measurement ids), ties of the
   * "farthest" value go to the smaller key.
   * @param {number[]} res residuals
   * @param {string[]} [keys] one per residual (default: the index)
   * @returns {{offset:number, rms:number, outliers:number[]}} rms of the kept values around the offset; outliers =
   *          indices into res
   */
  function robustOffset(res, keys, weights) {
    const m = res.length;
    if (!m) return { offset: 0, rms: 0, outliers: [] };
    const k = keys || res.map((_, i) => String(i).padStart(6, '0'));
    const order = res.map((_, i) => i).sort((a, b) => cmpKey(k[a], k[b]) || a - b);
    // optional weights (SPEC 13: points of an inferred band count less); all 1 = exactly the unweighted rule
    const wt = Array.isArray(weights) && weights.length === m && weights.some((v) => v !== 1) ? weights.map((v) => (isNum(v) && v > 0 ? v : 1)) : null;
    const wOf = (i) => (wt ? wt[i] : 1);
    const alive = new Uint8Array(m).fill(1);
    const outliers = [];
    const meanAlive = () => {
      let s = 0;
      let c = 0;
      for (const i of order) {
        if (!alive[i]) continue;
        s += wOf(i) * res[i];
        c += wOf(i);
      }
      return s / c;
    };
    const farthest = (centre) => {
      let worst = -1;
      let wd = OUTLIER_DB;
      for (const i of order) {
        if (!alive[i]) continue;
        const d = Math.abs(res[i] - centre);
        if (d > wd) {
          wd = d;
          worst = i;
        }
      }
      return worst;
    };
    let offset;
    if (m >= 4) {
      const cap = Math.max(1, Math.floor(m / 4));
      for (;;) {
        offset = meanAlive();
        if (outliers.length >= cap) break;
        const worst = farthest(offset);
        if (worst < 0) break;
        alive[worst] = 0;
        outliers.push(worst);
      }
    } else {
      offset = wt
        ? weightedMedian(
            order.map((i) => res[i]),
            order.map((i) => wt[i]),
          )
        : E.util.median(order.map((i) => res[i]));
      if (m === 3) {
        const worst = farthest(offset);
        if (worst >= 0) {
          alive[worst] = 0;
          outliers.push(worst);
          offset = meanAlive();
        }
      }
    }
    let ss = 0;
    let c = 0;
    for (const i of order) {
      if (!alive[i]) continue;
      ss += wOf(i) * (res[i] - offset) * (res[i] - offset);
      c += wOf(i);
    }
    return { offset, rms: Math.sqrt(ss / c), outliers: outliers.sort((a, b) => a - b) };
  }

  /**
   * Weighted median: the value where the cumulative weight (values sorted) reaches half of the total; exactly half ->
   * the mean of the two neighbours, so equal weights give the plain median.
   * @param {number[]} values
   * @param {number[]} weights positive, one per value
   * @returns {number} 0 for no values
   */
  function weightedMedian(values, weights) {
    const n = values.length;
    if (!n) return 0;
    const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
    let total = 0;
    for (let i = 0; i < n; i++) total += weights[i];
    const half = total / 2;
    let cum = 0;
    for (let j = 0; j < n; j++) {
      cum += weights[idx[j]];
      if (Math.abs(cum - half) <= 1e-9 * total) return j + 1 < n ? (values[idx[j]] + values[idx[j + 1]]) / 2 : values[idx[j]];
      if (cum > half) return values[idx[j]];
    }
    return values[idx[n - 1]];
  }

  /**
   * Calibration offset for one band: median of (measured - prediction(baseline -> point)) over the measurements of
   * that band (all taken with the router at the baseline). rms = sqrt(mean((residual - offset)^2)). The prediction is
   * the uncalibrated, unclamped signal softened like the heat map (opts.soften, default SOFTEN; 0 = rawSignal), so a
   * calibrated map reproduces a measurement where it was taken; the offset is added after the softening.
   * Measurements of `opts.device` are preferred; if that device has none on the band, all devices are used.
   * Speed-test points without a measured signal (value null, SPEC 6.2) never take part: calibrating the model with
   * its own prediction would be circular.
   * With a calibration fit in the context (ctx.fit, SPEC 9) the prediction uses the fitted n / wallFactor and the
   * offset follows robustOffset(): the mean with > 12 dB outliers dropped from 4 points on (flagged in used[] and
   * listed in `outliers`), the median below - and with no point on that band the fit's stored offset of the band
   * (the router's strength does not depend on where it stands). Without a fit: exactly the plain median as always.
   * @param {object} ctx
   * @param {Array<object>} measurements project.measurements
   * @param {number} band
   * @param {{device?:string, baseline:{x,y}, soften?:number}} opts
   * @returns {{offset:number, rms:number, n:number, fallback:boolean, suspicious:boolean,
   *            used:Array<{id,x,y,measured:number,predicted:number,residual:number,outlier?:true}>,
   *            fitted?:true, outliers?:string[]}}
   *          suspicious: |offset| > 20 dB (wrong band, scale or walls - tell the user); fitted/outliers only with a fit
   */
  function calibrate(ctx, measurements, band, opts) {
    return calibrateGroups([{ ctx, list: measurements }], band, opts);
  }

  /**
   * calibrate() over measurement groups that live on different floors (SPEC 14.3): [{ctx (that floor's context), list,
   * floor?}] - every point is predicted on its own floor (the router on its floor), ONE offset for all of them (the
   * router's strength). used[i].floor tells the floor when a group carries one.
   */
  function calibrateGroups(groups, band, opts) {
    const o = opts || {};
    const b = units.normBand(band);
    // odd data (null entries, NaN positions) never throws: such points simply do not calibrate
    const all = [];
    for (const g of groups) {
      for (const m of Array.isArray(g.list) ? g.list : []) {
        if (m && typeof m === 'object' && units.normBand(m.band) === b && isNum(m.value) && isNum(m.x) && isNum(m.y)) all.push({ m, c: g.ctx, floor: g.floor });
      }
    }
    let list = all;
    let fallback = false;
    if (o.device) {
      const key = profileKey(o.device);
      const own = all.filter((e) => profileKey(e.m.device) === key);
      if (own.length) list = own;
      else if (all.length) fallback = true;
    }
    const ctx = groups.length ? groups[0].ctx : null;
    const fit = ctx && ctx.fit;
    if (!list.length || !o.baseline) {
      const stored = fit && b !== null ? fit.offsets[units.bandKey(b)] : null;
      if (isNum(stored)) return { offset: stored, rms: 0, n: 0, fallback: false, suspicious: Math.abs(stored) > 20, used: [], fitted: true, outliers: [] };
      return { offset: 0, rms: 0, n: 0, fallback: false, suspicious: false, used: [] };
    }
    const used = list.map(({ m, c, floor }) => {
      const predicted = softRawSignal(c, asRouter(c, o.baseline), m, b, o.soften);
      const u = { id: m.id, x: m.x, y: m.y, measured: m.value, predicted, residual: m.value - predicted };
      if (floor !== undefined) u.floor = floor;
      if (m.bandInferred === true) u.inferred = true;
      return u;
    });
    // SPEC 13: a point whose band was inferred (the user did not know it) counts with INFERRED_WEIGHT
    const weights = used.some((u) => u.inferred) ? used.map((u) => (u.inferred ? INFERRED_WEIGHT : 1)) : null;
    if (fit) {
      const r = robustOffset(
        used.map((u) => u.residual),
        used.map((u) => String(u.id)),
        weights,
      );
      for (const i of r.outliers) used[i].outlier = true;
      return { offset: r.offset, rms: r.rms, n: used.length, fallback, suspicious: Math.abs(r.offset) > 20, used, fitted: true, outliers: r.outliers.map((i) => used[i].id) };
    }
    if (weights) {
      const offset = weightedMedian(
        used.map((u) => u.residual),
        weights,
      );
      let ss = 0;
      let sw = 0;
      used.forEach((u, i) => {
        ss += weights[i] * (u.residual - offset) * (u.residual - offset);
        sw += weights[i];
      });
      return { offset, rms: Math.sqrt(ss / sw), n: used.length, fallback, suspicious: Math.abs(offset) > 20, used };
    }
    const offset = E.util.median(used.map((u) => u.residual));
    let ss = 0;
    for (const u of used) ss += (u.residual - offset) * (u.residual - offset);
    return { offset, rms: Math.sqrt(ss / used.length), n: used.length, fallback, suspicious: Math.abs(offset) > 20, used };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // measurements without a known band (SPEC 13: "Nevím (automaticky)" stores band null)
  // ---------------------------------------------------------------------------------------------------------------

  /** Weight of a point whose band was inferred, in calibrate() and in a fit's offsets. */
  const INFERRED_WEIGHT = 0.5;
  const unknownBand = (m) => isObj(m) && (m.band === null || units.normBandMode(m.band) === 'auto');

  /** The project as seen from the context's floor (SPEC 14.3): its measurements / plan at the top level. */
  function viewFor(ctx, project) {
    return ctx && ctx.floor !== null && ctx.floor !== undefined && PJ.atFloor ? PJ.atFloor(project, ctx.floor) : project;
  }

  /**
   * The measurement groups of every floor (SPEC 14.3) for pooled calibration: [{ctx, list, floor}], one per floor with
   * measurements (the context's own floor first); one group without floors. resolve = infer unknown bands (each on
   * its own floor) with the offsets known() returns.
   */
  function floorGroups(ctx, project, soften, resolve, known) {
    const many = Array.isArray(project.floors) && project.floors.filter(isObj).length > 1 && ctx && ctx.floor !== null && ctx.floor !== undefined;
    const one = (c, pf, floor) => {
      const list = Array.isArray(pf.measurements) ? pf.measurements : [];
      const out = { ctx: c, list: resolve && list.some(unknownBand) ? resolveOn(c, pf, { offsets: known ? known() : null, soften }) : list };
      if (floor !== undefined) out.floor = floor;
      return out;
    };
    if (!many) return [one(ctx, viewFor(ctx, project))];
    const ids = [ctx.floor].concat(
      project.floors
        .filter(isObj)
        .map((f) => f.id)
        .filter((id) => id !== ctx.floor),
    );
    const groups = [];
    for (const id of ids) {
      const pf = PJ.atFloor(project, id);
      if (!Array.isArray(pf.measurements) || !pf.measurements.length) continue;
      groups.push(one(floorContext(ctx, id), pf, id));
    }
    return groups.length ? groups : [one(ctx, viewFor(ctx, project), ctx.floor)];
  }

  /**
   * The band a steering client most likely used at p TODAY (router at net.baseline - on its floor -, no node): the
   * steering rule on the (calibrated, softened) signals of the router's bands there. p lies on the context's floor.
   * @param {object} ctx
   * @param {object} project
   * @param {{x,y}} p
   * @param {{offsets?:object, soften?:number}} [opts] offsets default: the calibration of the known-band points
   * @returns {{band:2.4|5|6|null, signals:{'2.4':number|null,'5':number|null,'6':number|null}}}
   */
  function inferBand(ctx, project, p, opts) {
    const o = opts || {};
    const bl = project && project.net && project.net.baseline;
    if (!ctx || !bl || !isNum(bl.x) || !isNum(bl.y) || !p || !isNum(p.x) || !isNum(p.y)) return { band: null, signals: { '2.4': null, '5': null, '6': null } };
    const offsets = o.offsets || knownOffsets(ctx, project, o.soften);
    const st = steeredSignal(ctx, { x: p.x, y: p.y }, { band: 'auto', bands: routerBandList(project), steer: steerOf(project), router: asRouter(ctx, bl), nodes: [], node: null, offsets, soften: o.soften });
    return { band: st.band, signals: st.byBand };
  }

  /** Calibration offsets of the measurements whose band is known, pooled over every floor (the basis of the band guess). */
  function knownOffsets(ctx, project, soften) {
    const out = { '2.4': 0, '5': 0, '6': 0 };
    const device = project.goal ? project.goal.device : undefined;
    const baseline = project.net ? project.net.baseline : undefined;
    const groups = floorGroups(ctx, project, soften, false);
    for (const b of E.BANDS) out[units.bandKey(b)] = calibrateGroups(groups, b, { device, baseline, soften }).offset;
    return out;
  }

  /** resolveBands() of the measurements of the project (view) pf on the context of its floor. */
  function resolveOn(ctx, pf, o) {
    const list = Array.isArray(pf.measurements) ? pf.measurements : [];
    if (!list.some(unknownBand)) return list.slice();
    let offsets = o.offsets || null;
    return list.map((m) => {
      if (!unknownBand(m) || !isNum(m.x) || !isNum(m.y)) return m;
      if (!offsets) offsets = knownOffsets(ctx, pf, o.soften);
      const r = inferBand(ctx, pf, m, { offsets, soften: o.soften });
      return r.band === null ? m : { ...m, band: r.band, bandInferred: true };
    });
  }

  /**
   * The measurements of the context's floor (SPEC 14.3) with every unknown band (null) inferred (SPEC 13): such a point
   * becomes a copy {...m, band, bandInferred:true}; every other entry is the same object. Same order and length. Points
   * that cannot be inferred (no position / baseline) stay as they are.
   * @param {object} ctx
   * @param {object} project
   * @param {{offsets?:object, soften?:number}} [opts] offsets default: the calibration of the known-band points
   *        (whatever view.calibrate says - they only serve the guess)
   * @returns {Array<object>}
   */
  function resolveBands(ctx, project, opts) {
    if (!project || !Array.isArray(project.measurements)) return [];
    return resolveOn(ctx, viewFor(ctx, project), opts || {});
  }

  /**
   * calibrate() for the three bands using the measurements of EVERY floor (SPEC 14.3: each predicted on its own floor,
   * one offset per band = the router's strength), net.baseline and goal.device.
   * @param {object} ctx
   * @param {object} project
   * @param {{soften?:number}} [opts] soften in metres (default SOFTEN) - use the same value as for the fields
   * @returns {{'2.4':object,'5':object,'6':object}}
   */
  function calibrateAll(ctx, project, opts) {
    const out = {};
    const soften = opts && opts.soften;
    const device = project.goal ? project.goal.device : undefined;
    const baseline = project.net ? project.net.baseline : undefined;
    // points without a known band take part on their inferred band, with a lower weight (SPEC 13)
    let known = null;
    const knownOnce = () => known || (known = knownOffsets(ctx, project, soften));
    const groups = floorGroups(ctx, project, soften, true, knownOnce);
    for (const b of E.BANDS) out[units.bandKey(b)] = calibrateGroups(groups, b, { device, baseline, soften });
    return out;
  }

  /**
   * Calibration offsets {'2.4':dB,'5':dB,'6':dB} to hand to field()/combinedSignal() - the same on every floor (SPEC
   * 14.3). All zero when the user switched calibration off (project.view.calibrate === false).
   * @param {object} ctx
   * @param {object} project
   * @param {{soften?:number}} [opts] as calibrateAll
   */
  function offsets(ctx, project, opts) {
    const out = { '2.4': 0, '5': 0, '6': 0 };
    if (project.view && project.view.calibrate === false) return out;
    const cal = calibrateAll(ctx, project, opts);
    for (const k of Object.keys(out)) out[k] = cal[k].offset;
    return out;
  }

  E.model = {
    createContext,
    forBand,
    bandIndex,
    obstacleLossFor,
    lossBands,
    presetOf,
    BAND_FACTOR,
    MATERIALS: PJ.MATERIALS,
    FURNITURE_KINDS: PJ.FURNITURE_BANDS,
    LEGACY_MATERIALS: PJ.LEGACY_WALL_MATERIALS,
    traceLoss,
    obstacleLoss,
    rawSignal,
    signal,
    softObstacleLoss,
    softRawSignal,
    softSignal,
    softenOf,
    wallBlocks,
    crossLoss,
    roomAtPx,
    bandBase,
    offsetFor,
    nodeActive,
    isWirelessNode,
    nodeParams,
    nodeList,
    stateNodes,
    uplinkIndexOf,
    backhaulSignals,
    floorContext,
    distance3,
    asRouter,
    vertOf,
    calibrateGroups,
    CROSS_WALL_WEIGHT,
    fieldParams,
    combinedSignal,
    steeredSignal,
    backhaulSignal,
    pointSignalDetail,
    routerBandList,
    steerOf,
    steerBand,
    isAuto,
    inferBand,
    resolveBands,
    weightedMedian,
    calibrate,
    calibrateAll,
    offsets,
    profileKey,
    robustOffset,
    activeFit,
    wallCount,
    MIN_SIGNAL,
    MAX_SIGNAL,
    SOFTEN,
    SOFTEN_MAX,
    BARRIER_DB,
    OUTLIER_DB,
    INFERRED_WEIGHT,
    STEER,
    FIT_BOUNDS: Object.freeze({ n: Object.freeze([FIT_N_MIN, FIT_N_MAX]), wallFactor: Object.freeze([FIT_WF_MIN, FIT_WF_MAX]) }),
  };
})();
