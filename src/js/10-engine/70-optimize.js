/* WiFi Heatmap Architect - engine.optimize: "find the best place for the router".
 *
 * Deterministic search, cooperative with the UI thread:
 *   1. candidate positions on a lattice (~0.5 m apart) over the allowed floor, plus the current router position,
 *   2. every candidate is scored on a regular sub-sample of the target rooms (a few hundred points),
 *   3. the best three are refined on finer local lattices (0.125 m, then ~3 cm),
 *   4. (signal mode, softening on) the refined three + the current position are ranked again on the softened full grid,
 *   5. before / after statistics are computed exactly on the full grid (softened, as analysis.run).
 * Signal score (per room, area weighted across rooms):  coverage% + 0.2*(mean+100) + 0.2*(p10+100).
 * Speed score (per room): the legacy pass-rate based score (speed.scoreRatios), area weighted as well. With a second
 * node (SPEC 10) node-served samples go through the node's link - whose wireless uplink depends on where the router is,
 * so it is traced again for every candidate position.
 * The work yields to the event loop every ~12 ms, reports progress and stops on an AbortSignal.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { clamp, isNum, fail } = E.util;
  const units = E.units;
  const model = E.model;
  const raster = E.raster;
  const speed = E.speed;

  const MAX_SAMPLES = 1200; // sub-sample size over the whole target
  const MIN_PER_ROOM = 24;
  const SLICE_MS = 12; // work per slice before yielding to the event loop

  function abortError() {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }

  /** Room id at a px point using the exact polygons (last room wins, like raster.grid); 0 = outside. */
  const roomAtPx = model.roomAtPx;

  /**
   * Find the best router position.
   * @param {object} ctx model.createContext()
   * @param {object} g raster.grid() (cell 4 gives exact before/after numbers; cell 8 is fine and 4x cheaper)
   * @param {object} opts
   *   band: 2.4|5|6|'auto' (required; 'auto' = band mode Auto, SPEC 13: with bands = the router's bands and steer =
   *     the thresholds, as model.fieldParams puts them into the state - every sample on its steered band)
   *   goalRoom: roomId to optimize for, or null = whole flat (all rooms except `excluded`)
   *   allowedRoom: roomId the router may be placed in, or null = anywhere on the floor
   *   threshold: dBm for "good signal" (default ctx.p.threshold)
   *   nodes: the nodes (model.nodeList / fieldParams().nodes; SPEC 14.2 - they stay where they are; the legacy single
   *     `node` still works); offsets: calibration offsets map; excluded: roomIds
   *   floors (SPEC 14.3): [{ctx, grid, goalRoom, excluded}] = the floors whose places count (area weighted). When given,
   *     ONLY these count (list the router's floor too if it should); ctx / g are then just the router's floor, where the
   *     candidates lie (allowedRoom is a room of it). Omitted: the router floor's goalRoom / excluded, as before
   *   router: current router position {x,y} - used for the `before` numbers and as an extra candidate
   *   aa: anti-aliasing of the exact before/after numbers (default 2 for cell <= 4, else 1) - the same default as
   *     analysis.run, so the numbers agree with the ones the UI shows
   *   clearance: metres the router must keep from every wall (default 0.2; a router "in a doorway" is not a plan);
   *     dropped to 0 automatically when no spot satisfies it (tiny rooms)
   *   soften: diffraction softening in metres of the exact before/after numbers (default model.SOFTEN, as
   *     analysis.run and raster.field). The search ranks candidates with the exact ray model on the sub-sample (fast;
   *     softening changes coverage by only ~1 percentage point); in signal mode the three refined finalists and the
   *     current position (when it is an allowed candidate) are then ranked again on the softened full grid, so the
   *     answer is never worse than staying put in the numbers the UI shows
   *   speed: {curve (one curve or a curves map, SPEC 13), targetDown, targetUp, limits, reserve?, backhaulCurve?} ->
   *     optimize for speed targets instead of
   *     signal; works with a second node too (speed.predictVia through its link; backhaulCurve = a curve of the node's
   *     backhaul band, default curve)
   * @param {{onProgress?:(fraction:number)=>void, signal?:AbortSignal}} [ctl]
   * @returns {Promise<{pos:{x:number,y:number}, roomId:number, score:number, scoreBefore:number|null,
   *   before:{coverage:number,mean:number,median:number,p10:number}|null,
   *   after:{coverage:number,mean:number,median:number,p10:number}, candidates:number}>}
   *   Rejects with Error('err.opt.noFloor' | 'err.opt.noCurve') or an AbortError ('err.opt.speedNode' is no longer
   *   thrown: speed through a second node is modelled since SPEC 10).
   */
  async function find(ctx, g, opts, ctl) {
    const o = opts || {};
    const c = ctl || {};
    // band mode Auto (SPEC 13): every sample takes the band a steering client would use there
    const auto = model.isAuto(o);
    const band = auto ? 'auto' : units.normBand(o.band);
    if (band === null) throw new RangeError('optimize.find: band is required');
    const bandList = auto ? model.routerBandList(o.bands) : [band];
    const steer = model.steerOf(o.steer);
    const ctx0 = ctx;
    // the search traces rays itself: use the obstacle losses of each band (SPEC 7.1)
    const ctxB = bandList.map((b) => model.forBand(ctx0, b));
    ctx = ctxB[0];
    if (c.signal && c.signal.aborted) throw abortError();
    if (!g.count) throw fail('err.opt.noFloor');

    const threshold = isNum(o.threshold) ? o.threshold : ctx.p.threshold;
    const speedMode = !!o.speed;
    // every node (SPEC 14.2) stays where it is; only the ones serving a band of the search matter for the signal
    const allNodes = model.stateNodes(o);
    const nodes = allNodes.filter((nd) => bandList.some((b) => model.nodeActive(nd, b)));
    // one curve or a curves map (SPEC 13): the curve of each band, else the nearest band's
    const curveB = speedMode ? bandList.map((b) => speed.curveFor(o.speed.curve, b)) : [];
    if (speedMode && !curveB.some(Boolean)) throw fail('err.opt.noCurve');

    // ---- the floors whose places count (SPEC 14.3): opts.floors, else the router's floor ----
    // the router is placed on ctx's floor; a place on another floor sees it through the ceiling
    const routerFloor = ctx0.floor === undefined ? null : ctx0.floor;
    const given = Array.isArray(o.floors) ? o.floors.filter((f) => f && f.ctx && f.grid && f.grid.count && f.grid.roomCells) : [];
    const floors = (given.length ? given : [{ ctx: ctx0, grid: g, goalRoom: o.goalRoom, excluded: o.excluded }]).map((f) => {
      const fctx = f.ctx;
      const V = fctx === ctx0 || fctx.floor === routerFloor ? null : model.vertOf(fctx, routerFloor);
      const known = new Set(f.grid.roomIds);
      const ex = Array.isArray(f.excluded) ? f.excluded : [];
      let ids = f.goalRoom !== null && f.goalRoom !== undefined && known.has(f.goalRoom) ? [f.goalRoom] : f.grid.roomIds.filter((id) => !ex.includes(id));
      if (!ids.length) ids = f.grid.roomIds.slice();
      return {
        ctx: fctx,
        grid: f.grid,
        ctxB: bandList.map((b) => model.forBand(fctx, b)),
        V,
        dz2: V ? V.dz2 : 0,
        wallW: V ? V.wallW : 1,
        ceilB: bandList.map((b) => (V ? V.ceil[model.bandIndex(b)] * fctx.wf : 0)),
        targetIds: ids,
      };
    });
    const allowedKnown = new Set(g.roomIds);
    const allowed = o.allowedRoom !== null && o.allowedRoom !== undefined && allowedKnown.has(o.allowedRoom) ? o.allowedRoom : 0;

    // ---- regular sub-sample of every target room (of every floor) ----
    let totalCells = 0;
    for (const fl of floors) for (const id of fl.targetIds) totalCells += fl.grid.roomCells.get(id).length;
    const nGroups = floors.reduce((s, fl) => s + fl.targetIds.length, 0);
    const kBaseOf = (fl) => Math.max(1, Math.ceil(Math.sqrt(totalCells / MAX_SAMPLES)));
    // every room keeps a minimum of samples, but never so many that the total explodes (250 rooms x 24 = 6000 samples
    // made a 250-object plan take 40 s); flats with up to ~100 rooms keep the full 24
    const minPerRoom = clamp(Math.floor((2 * MAX_SAMPLES) / nGroups), 4, MIN_PER_ROOM);
    const sx = [];
    const sy = [];
    const sf = []; // the floor (index into floors) of every sample
    const groupStart = [0];
    const groupWeight = [];
    const groupRef = []; // [floor index, room id]
    floors.forEach((fl, fi) => {
      const gg = fl.grid;
      const kBase = kBaseOf(fl);
      for (const id of fl.targetIds) {
        const list = gg.roomCells.get(id);
        let picked = [];
        for (let k = kBase; k >= 1; k--) {
          const off = k >> 1;
          picked = [];
          for (let m = 0; m < list.length; m++) {
            const i = list[m];
            const r = (i / gg.cols) | 0;
            const col = i - r * gg.cols;
            if (col % k === off % k && r % k === off % k) picked.push(i);
          }
          if (picked.length >= Math.min(list.length, minPerRoom)) break;
        }
        if (!picked.length) picked = [list[0]];
        for (const i of picked) {
          const r = (i / gg.cols) | 0;
          sx.push(gg.colPx[i - r * gg.cols]);
          sy.push(gg.rowPx[r]);
          sf.push(fi);
        }
        groupStart.push(sx.length);
        groupWeight.push(list.length / totalCells);
        groupRef.push([fi, id]);
      }
    });
    const nS = sx.length;
    const SX = Float64Array.from(sx);
    const SY = Float64Array.from(sy);
    const SF = Int32Array.from(sf);

    // ---- per-sample precomputation (per band) ----
    const nB = bandList.length;
    const offB = bandList.map((b) => model.offsetFor(o.offsets, b));
    const baseB = bandList.map((b, q) => model.bandBase(ctxB[q], b));
    const idxB = bandList.map((b) => model.bandIndex(b));
    const kk = 10 * ctx.p.n;
    const mpp = ctx.mpp;
    /** Exact signal of a source at px (x, y) on floor `fromFloor` at sample j, band q (clamped). */
    const sigAt = (q, x, y, fromFloor, off, j) => {
      const fl = floors[SF[j]];
      const fc = fl.ctxB[q];
      const V = fromFloor === routerFloor ? fl.V : model.vertOf(fc, fromFloor);
      let dm = Math.hypot(SX[j] - x, SY[j] - y) * mpp;
      let L = model.traceLoss(fc, x, y, SX[j], SY[j]);
      if (V) {
        dm = Math.sqrt(dm * dm + V.dz2);
        L = V.wallW * L + V.ceil[idxB[q]] * fc.wf;
      }
      return clamp(baseB[q] - kk * Math.log10(dm < 1 ? 1 : dm) - L + off, -110, -20);
    };
    // the strongest node per sample and band, and which one (index into allNodes + 1)
    const nodeSigB = bandList.map(() => new Float64Array(nS).fill(-Infinity));
    const nodeWinB = bandList.map(() => new Uint8Array(nS));
    bandList.forEach((b, q) => {
      for (const nd of nodes) {
        if (!model.nodeActive(nd, b)) continue;
        const k = allNodes.indexOf(nd) + 1;
        const nf = nd.pos.floor === undefined ? null : nd.pos.floor;
        for (let j = 0; j < nS; j++) {
          const v = sigAt(q, nd.pos.x * W, nd.pos.y * H, nf === null ? routerFloor : nf, offB[q] + (nd.power || 0), j);
          if (v > nodeSigB[q][j]) {
            nodeSigB[q][j] = v;
            nodeWinB[q][j] = k;
          }
        }
      }
    });
    const per = new Float64Array(3);
    const viaB = new Uint8Array(3);
    const vals = new Float64Array(nS);
    let speedLim = null;
    let tDown = 1;
    let tUp = 1;
    // speed through the nodes (SPEC 10 / 14.2): their uplink chains (exact rays like the rest of the search) change with
    // every candidate router position
    let linksAt = null;
    if (speedMode) {
      speedLim = speed.toLimits({ ...o.speed.limits, reserve: o.speed.reserve !== undefined ? o.speed.reserve : o.speed.limits && o.speed.limits.reserve });
      tDown = o.speed.targetDown;
      tUp = o.speed.targetUp;
      if (nodes.length) {
        const curveOf = (nd) => {
          if (speed.validCurve(o.speed.curve)) return o.speed.curve;
          const pick = speed.curveFor(o.speed.curve, units.normBand(nd.backhaulBand) || 5);
          return pick ? pick.curve : null;
        };
        const bCurve = o.speed.backhaulCurve;
        // the backhaul of a node whose uplink is another node does not depend on the router: traced once
        const fixed = allNodes.map((nd, k) => {
          if (!model.isWirelessNode(nd)) return null;
          const ui = model.uplinkIndexOf(allNodes, nd);
          if (ui < 0) return undefined; // from the router: per candidate
          const v = model.backhaulSignal(ctx0, { router: o.router || { x: 0.5, y: 0.5 }, nodes: allNodes, offsets: o.offsets, soften: 0 }, k);
          return isNum(v) ? v : null;
        });
        const bhAt = (nd, x, y) => {
          const bb = units.normBand(nd.backhaulBand) || 5;
          const nf = nd.pos.floor === undefined || nd.pos.floor === null ? routerFloor : nd.pos.floor;
          const nctx = model.forBand(nf === routerFloor ? ctx0 : model.floorContext(ctx0, nf), bb);
          const V = model.vertOf(nctx, routerFloor);
          const nxp = nd.pos.x * W;
          const nyp = nd.pos.y * H;
          let dm = Math.hypot(nxp - x, nyp - y) * mpp;
          let L = model.traceLoss(nctx, x, y, nxp, nyp);
          if (V) {
            dm = Math.sqrt(dm * dm + V.dz2);
            L = V.wallW * L + V.ceil[model.bandIndex(bb)] * nctx.wf;
          }
          return clamp(model.bandBase(nctx, bb) - kk * Math.log10(dm < 1 ? 1 : dm) - L + model.offsetFor(o.offsets, bb), -110, -20);
        };
        linksAt = (x, y) => {
          const out = new Array(allNodes.length).fill(null);
          const busy = new Set();
          const linkOf = (k) => {
            if (out[k]) return out[k];
            const nd = allNodes[k];
            const ui = model.uplinkIndexOf(allNodes, nd);
            let up = null;
            if (ui >= 0 && !busy.has(k)) {
              busy.add(k);
              up = linkOf(ui);
              busy.delete(k);
            }
            const sig = !model.isWirelessNode(nd) ? null : fixed[k] === undefined ? bhAt(nd, x, y) : fixed[k];
            out[k] = speed.linkFromSignal(nd, sig, curveOf(nd), bCurve, up);
            return out[k];
          };
          for (let k = 0; k < allNodes.length; k++) linkOf(k);
          return out;
        };
      }
    }

    /** Score of a router at px position (x,y) on the router floor over the samples. Allocation free apart from a typed-array sort. */
    function score(x, y) {
      let total = 0;
      const links = linksAt ? linksAt(x, y) : null;
      for (let gi = 0; gi < groupWeight.length; gi++) {
        const a = groupStart[gi];
        const b = groupStart[gi + 1];
        const cnt = b - a;
        const fl = floors[groupRef[gi][0]];
        let good = 0;
        let sum = 0;
        for (let j = a; j < b; j++) {
          let dm = Math.hypot(SX[j] - x, SY[j] - y) * mpp;
          if (fl.V) dm = Math.sqrt(dm * dm + fl.dz2);
          const fs = Math.log10(dm < 1 ? 1 : dm);
          let q = 0;
          per.fill(NaN);
          for (let t = 0; t < nB; t++) {
            let L = model.traceLoss(fl.ctxB[t], x, y, SX[j], SY[j]);
            if (fl.V) L = fl.wallW * L + fl.ceilB[t];
            let st = baseB[t] - kk * fs - L + offB[t];
            st = st < -110 ? -110 : st > -20 ? -20 : st;
            viaB[idxB[t]] = nodeSigB[t][j] > st ? 1 : 0;
            per[idxB[t]] = viaB[idxB[t]] ? nodeSigB[t][j] : st;
          }
          if (nB > 1) {
            // the steering rule (model.steerBand) on this sample's bands
            const k = per[2] === per[2] && per[2] >= steer.six ? 2 : per[1] === per[1] && per[1] >= steer.five ? 1 : per[0] === per[0] ? 0 : per[1] === per[1] && !(per[2] > per[1]) ? 1 : 2;
            q = idxB.indexOf(k);
          }
          const s = per[idxB[q]];
          const viaNode = viaB[idxB[q]] === 1;
          if (speedMode) {
            const cf = curveB[q];
            const link = viaNode && links ? links[nodeWinB[q][j] - 1] : null;
            const p = cf ? speed.predictVia(cf.curve, s, speedLim, link) : null;
            vals[j - a] = p ? Math.min(p.down / tDown, p.up / tUp) : 0;
          } else {
            vals[j - a] = s;
            sum += s;
            if (s >= threshold) good++;
          }
        }
        let gs;
        if (speedMode) gs = speed.scoreRatios(vals.subarray(0, cnt));
        else {
          const v = vals.subarray(0, cnt);
          v.sort();
          gs = (100 * good) / cnt + 0.2 * (sum / cnt + 100) + 0.2 * (v[Math.floor((cnt - 1) * 0.1)] + 100);
        }
        total += groupWeight[gi] * gs;
      }
      return total;
    }

    // ---- candidate lattice (on the router's floor) ----
    const stepPx = Math.max(8, 0.5 / mpp);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const rm of ctx.rooms) {
      if (allowed && rm.id !== allowed) continue;
      minX = Math.min(minX, rm.minX);
      minY = Math.min(minY, rm.minY);
      maxX = Math.max(maxX, rm.maxX);
      maxY = Math.max(maxY, rm.maxY);
    }
    let clearPx = clamp((isNum(o.clearance) ? o.clearance : 0.2) / mpp, 0, 60);
    const wallDist = (x, y) => {
      const w = ctx.w;
      let best = Infinity;
      for (let i = 0; i < w.n; i++) {
        const d = E.geom.pointSegDistPx(x, y, w.ax[i], w.ay[i], w.ax[i] + w.sx[i], w.ay[i] + w.sy[i]);
        if (d < best) best = d;
      }
      return best;
    };
    const okAt = (x, y) => {
      const id = roomAtPx(ctx, x, y);
      return id !== 0 && (!allowed || id === allowed) && (clearPx <= 0 || wallDist(x, y) >= clearPx);
    };
    const cand = [];
    const seen = new Set();
    const addCand = (x, y) => {
      const key = `${Math.round(x * 10)}:${Math.round(y * 10)}`;
      if (seen.has(key) || !okAt(x, y)) return false;
      seen.add(key);
      cand.push([x, y]);
      return true;
    };
    const hasRouter = !!(o.router && isNum(o.router.x) && isNum(o.router.y));
    // the current position competes too (as candidate 0) when it is an allowed answer
    let routerIsCand = hasRouter && addCand(o.router.x * W, o.router.y * H);
    const lattice = () => {
      for (let y = minY + stepPx / 2; y <= maxY; y += stepPx) for (let x = minX + stepPx / 2; x <= maxX; x += stepPx) addCand(x, y);
    };
    lattice();
    if (cand.length < 3 && clearPx > 0) {
      // no room for the clearance (tiny rooms): forget it rather than refuse to answer
      clearPx = 0;
      seen.clear();
      cand.length = 0;
      routerIsCand = hasRouter && addCand(o.router.x * W, o.router.y * H);
      lattice();
    }
    if (cand.length < 3) {
      // tiny room: fall back to its floor cells (every 3rd) so there is always something to choose from
      const ids = allowed ? [allowed] : g.roomIds;
      for (const id of ids) {
        const list = g.roomCells.get(id);
        for (let m = 0; m < list.length; m += 3) {
          const i = list[m];
          const r = (i / g.cols) | 0;
          addCand(g.colPx[i - r * g.cols], g.rowPx[r]);
        }
      }
    }
    if (!cand.length) throw fail('err.opt.noFloor');

    // ---- cooperative loop ----
    const yielder = E.util.makeYielder();
    let sliceStart = E.util.now();
    const totalWork = cand.length + 3 * 130;
    let done = 0;
    const tick = async () => {
      if (E.util.now() - sliceStart < SLICE_MS) return;
      if (c.onProgress) c.onProgress(Math.min(0.99, done / totalWork));
      await yielder.yield();
      if (c.signal && c.signal.aborted) throw abortError();
      sliceStart = E.util.now();
    };

    try {
      const scored = [];
      let best = null;
      for (let k = 0; k < cand.length; k++) {
        const s = score(cand[k][0], cand[k][1]);
        scored.push({ s, k });
        if (!best || s > best.s) best = { s, x: cand[k][0], y: cand[k][1] };
        done++;
        await tick();
      }

      // refine the three best coarse candidates
      scored.sort((a, b) => b.s - a.s || a.k - b.k);
      const top = scored.slice(0, 3);
      const finals = []; // refined finalists {x, y, s} (exact-ray sub-sample score)
      for (const t of top) {
        let cx = cand[t.k][0];
        let cy = cand[t.k][1];
        let cs = t.s;
        for (const [step, radius] of [
          [stepPx / 4, 4],
          [stepPx / 16, 3],
        ]) {
          let bx = cx;
          let by = cy;
          for (let j = -radius; j <= radius; j++) {
            for (let i = -radius; i <= radius; i++) {
              if (!i && !j) continue;
              const x = cx + i * step;
              const y = cy + j * step;
              if (!okAt(x, y)) continue;
              const s = score(x, y);
              if (s > cs) {
                cs = s;
                bx = x;
                by = y;
              }
              done++;
              await tick();
            }
          }
          cx = bx;
          cy = by;
        }
        finals.push({ x: cx, y: cy, s: cs });
        if (cs > best.s) best = { s: cs, x: cx, y: cy };
      }
      if (c.signal && c.signal.aborted) throw abortError();

      // ---- exact before / after on the full grids (the fields the map shows: softened unless soften is 0) ----
      const aaF = o.aa !== undefined ? o.aa : g.cell <= 4 ? 2 : 1;
      const norm = (x, y) => ({ x: Number((x / W).toFixed(6)), y: Number((y / H).toFixed(6)) });
      const withFloor = (p) => (routerFloor === null ? p : { x: p.x, y: p.y, floor: routerFloor });
      const fieldsAt = (router) =>
        floors.map((fl) =>
          raster.field(
            fl.ctx,
            fl.grid,
            auto
              ? { band: 'auto', bands: bandList, steer, router: withFloor(router), nodes, offsets: o.offsets, aa: aaF, soften: o.soften }
              : { band, router: withFloor(router), nodes, offsets: o.offsets, aa: aaF, soften: o.soften },
          ),
        );
      const summary = (fs) => {
        const st = raster.statsMany(
          floors.map((fl, fi) => ({ grid: fl.grid, field: fs[fi], roomIds: fl.targetIds })),
          threshold,
        );
        return { coverage: st.coverage, mean: st.mean, median: st.median, p10: st.p10 };
      };
      let pos = norm(best.x, best.y);
      let afterFields = null;
      if (!speedMode && model.softenOf(o.soften) > 0) {
        // The search ranks with the exact rays on a sub-sample (fast); the numbers the user sees come from the
        // softened full grid. Rank the refined finalists (and the current position, when it is an allowed answer) by
        // the same score on the softened full grid, so the result is never worse than staying put in the UI's numbers.
        const fullScore = (fs) => {
          let total = 0;
          groupRef.forEach(([fi, id], gi) => {
            const st = raster.stats(floors[fi].grid, fs[fi], [id], threshold);
            total += groupWeight[gi] * (st.coverage + 0.2 * (st.mean + 100) + 0.2 * (st.p10 + 100));
          });
          return total;
        };
        const list = finals.slice().sort((a, b) => b.s - a.s);
        if (routerIsCand) list.push({ x: o.router.x * W, y: o.router.y * H, s: -Infinity });
        let top1 = null;
        const done1 = new Set();
        for (const it of list) {
          const p = norm(it.x, it.y);
          const key = `${p.x}:${p.y}`;
          if (done1.has(key)) continue;
          done1.add(key);
          const fs = fieldsAt(p);
          const sc = fullScore(fs);
          if (!top1 || sc > top1.fs + 1e-9) top1 = { p, f: fs, fs: sc, it };
          await tick();
        }
        if (top1) {
          pos = top1.p;
          afterFields = top1.f;
          best = { s: top1.it.s === -Infinity ? score(top1.it.x, top1.it.y) : top1.it.s, x: top1.it.x, y: top1.it.y };
        }
      }
      if (c.signal && c.signal.aborted) throw abortError();
      const after = summary(afterFields || fieldsAt(pos));
      const samePlace = hasRouter && pos.x === o.router.x && pos.y === o.router.y;
      const before = hasRouter ? (samePlace ? { ...after } : summary(fieldsAt(o.router))) : null;
      const scoreBefore = hasRouter ? score(o.router.x * W, o.router.y * H) : null;
      if (c.onProgress) c.onProgress(1);
      return { pos, roomId: roomAtPx(ctx, best.x, best.y), floor: routerFloor, score: best.s, scoreBefore, before, after, candidates: cand.length };
    } finally {
      yielder.close();
    }
  }

  /**
   * "Find the best place" for a whole project in one call (SPEC 14.3): the router stays on net.routerFloor (only its
   * position there is searched), the nodes stay where they are, the places that count are
   *   scope 'floor' (default while goal.room is a room): the ACTIVE floor's goal room / whole floor minus its excluded rooms,
   *   scope 'building' (default otherwise when there are several floors): every floor minus its excluded rooms.
   * @param {object} project
   * @param {{cell?:number, band?:number|'auto', scope?:'floor'|'building', offsets?:object, soften?:number,
   *          clearance?:number, speed?:object, aa?:number}} [opts] cell default 4; band default view.band; offsets
   *          default model.offsets (the planner should pass its own); speed as find()
   * @param {{onProgress?:Function, signal?:AbortSignal}} [ctl]
   * @returns {Promise<object>} find()'s result + perFloor: [{id, before, after}] (the counted places of each floor)
   */
  async function findProject(project, opts, ctl) {
    const o = opts || {};
    const PJ = E.project;
    const cell = isNum(o.cell) ? o.cell : 4;
    const rf = project.net && typeof project.net.routerFloor === 'string' ? project.net.routerFloor : null;
    const act = PJ.activeFloorId(project);
    const ctxActive = model.createContext(project);
    const ctxR = rf !== null && rf !== act ? model.floorContext(ctxActive, rf) : ctxActive;
    const gR = raster.grid(ctxR, { cell });
    const offsets = o.offsets || model.offsets(ctxActive, project, { soften: o.soften });
    const band = units.normBandMode(o.band) || units.normBandMode(project.view && project.view.band) || 5;
    const st = model.fieldParams(project, 'trial', { band, offsets });
    const floorIds = Array.isArray(project.floors) && project.floors.length ? project.floors.map((f) => f.id) : [null];
    const scope = o.scope === 'floor' || o.scope === 'building' ? o.scope : floorIds.length > 1 && project.goal.room === 'all' ? 'building' : 'floor';
    const ids = scope === 'building' ? floorIds : [act];
    const floors = ids.map((id) => {
      const fctx = id === null || id === act ? ctxActive : model.floorContext(ctxActive, id);
      const F = id === null ? { goal: { room: project.goal.room, excluded: project.goal.excluded } } : PJ.floorOf(project, id);
      return { id, ctx: fctx, grid: raster.grid(fctx, { cell }), goalRoom: scope === 'floor' && F.goal.room !== 'all' ? F.goal.room : null, excluded: F.goal.excluded };
    });
    const usable = floors.filter((f) => f.grid.count);
    const res = await find(
      ctxR,
      gR,
      {
        band,
        bands: st.bands,
        steer: st.steer,
        threshold: project.model.threshold,
        allowedRoom: project.goal.allowedRoom === 'any' ? null : project.goal.allowedRoom,
        router: project.net.router,
        nodes: st.nodes,
        offsets,
        soften: o.soften,
        clearance: o.clearance,
        aa: o.aa,
        speed: o.speed,
        floors: usable.map((f) => ({ ctx: f.ctx, grid: f.grid, goalRoom: f.goalRoom, excluded: f.excluded })),
      },
      ctl,
    );
    // the counted places of each floor, before / after
    const perFloor = usable.map((f) => {
      const tid = f.goalRoom !== null ? [f.goalRoom] : null;
      const at = (router) => {
        const fld = raster.field(f.ctx, f.grid, { ...st, router: rf === null ? { ...router } : { x: router.x, y: router.y, floor: rf }, aa: f.grid.cell <= 4 ? 2 : 1, soften: o.soften });
        const s = raster.stats(f.grid, fld, tid, project.model.threshold, f.excluded);
        return { coverage: s.coverage, mean: s.mean, median: s.median, p10: s.p10 };
      };
      return { id: f.id, before: at(project.net.router), after: at(res.pos) };
    });
    return { ...res, perFloor, scope };
  }

  E.optimize = { find, findProject, roomAtPx };
})();
