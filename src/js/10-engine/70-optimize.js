/* WiFi Heatmap Architect - engine.optimize: "find the best place for the router".
 *
 * Deterministic search, cooperative with the UI thread:
 *   1. candidate positions on a lattice (~0.5 m apart) over the allowed floor, plus the current router position,
 *   2. every candidate is scored on a regular sub-sample of the target rooms (a few hundred points),
 *   3. the best three are refined on finer local lattices (0.125 m, then ~3 cm),
 *   4. (signal mode, softening on) the refined three + the current position are ranked again on the softened full grid,
 *   5. before / after statistics are computed exactly on the full grid (softened, as analysis.run).
 * Signal score (per room, area weighted across rooms):  coverage% + 0.2*(mean+100) + 0.2*(p10+100).
 * Speed score (per room): the legacy pass-rate based score (speed.scoreRatios), area weighted as well.
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
   *   band: 2.4|5|6 (required)
   *   goalRoom: roomId to optimize for, or null = whole flat (all rooms except `excluded`)
   *   allowedRoom: roomId the router may be placed in, or null = anywhere on the floor
   *   threshold: dBm for "good signal" (default ctx.p.threshold)
   *   node: second node params (model.nodeParams) or null; offsets: calibration offsets map; excluded: roomIds
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
   *   speed: {curve, targetDown, targetUp, limits, reserve?} -> optimize for speed targets instead of signal
   * @param {{onProgress?:(fraction:number)=>void, signal?:AbortSignal}} [ctl]
   * @returns {Promise<{pos:{x:number,y:number}, roomId:number, score:number, scoreBefore:number|null,
   *   before:{coverage:number,mean:number,median:number,p10:number}|null,
   *   after:{coverage:number,mean:number,median:number,p10:number}, candidates:number}>}
   *   Rejects with Error('err.opt.noFloor' | 'err.opt.speedNode' | 'err.opt.noCurve') or an AbortError.
   */
  async function find(ctx, g, opts, ctl) {
    const o = opts || {};
    const c = ctl || {};
    const band = units.normBand(o.band);
    if (band === null) throw new RangeError('optimize.find: band is required');
    // the search traces rays itself: use the obstacle losses of the band (SPEC 7.1)
    ctx = model.forBand(ctx, band);
    if (c.signal && c.signal.aborted) throw abortError();
    if (!g.count) throw fail('err.opt.noFloor');

    const threshold = isNum(o.threshold) ? o.threshold : ctx.p.threshold;
    const speedMode = !!o.speed;
    const node = model.nodeActive(o.node, band) ? o.node : null;
    if (speedMode && o.node && o.node.mode !== 'none') throw fail('err.opt.speedNode');
    if (speedMode && !o.speed.curve) throw fail('err.opt.noCurve');

    // ---- target rooms and allowed rooms ----
    const known = new Set(g.roomIds);
    let targetIds = o.goalRoom !== null && o.goalRoom !== undefined && known.has(o.goalRoom) ? [o.goalRoom] : g.roomIds.filter((id) => !(o.excluded || []).includes(id));
    if (!targetIds.length) targetIds = g.roomIds.slice();
    const allowed = o.allowedRoom !== null && o.allowedRoom !== undefined && known.has(o.allowedRoom) ? o.allowedRoom : 0;

    // ---- regular sub-sample of every target room ----
    const cells = targetIds.map((id) => g.roomCells.get(id));
    const totalCells = cells.reduce((s, a) => s + a.length, 0);
    const kBase = Math.max(1, Math.ceil(Math.sqrt(totalCells / MAX_SAMPLES)));
    // every room keeps a minimum of samples, but never so many that the total explodes (250 rooms x 24 = 6000 samples
    // made a 250-object plan take 40 s); flats with up to ~100 rooms keep the full 24
    const minPerRoom = clamp(Math.floor((2 * MAX_SAMPLES) / targetIds.length), 4, MIN_PER_ROOM);
    const sx = [];
    const sy = [];
    const groupStart = [0];
    const groupWeight = [];
    targetIds.forEach((id, gi) => {
      const list = cells[gi];
      let picked = [];
      for (let k = kBase; k >= 1; k--) {
        const off = k >> 1;
        picked = [];
        for (let m = 0; m < list.length; m++) {
          const i = list[m];
          const r = (i / g.cols) | 0;
          const col = i - r * g.cols;
          if (col % k === off % k && r % k === off % k) picked.push(i);
        }
        if (picked.length >= Math.min(list.length, minPerRoom)) break;
      }
      if (!picked.length) picked = [list[0]];
      for (const i of picked) {
        const r = (i / g.cols) | 0;
        sx.push(g.colPx[i - r * g.cols]);
        sy.push(g.rowPx[r]);
      }
      groupStart.push(sx.length);
      groupWeight.push(list.length / totalCells);
    });
    const nS = sx.length;
    const SX = Float64Array.from(sx);
    const SY = Float64Array.from(sy);

    // ---- per-sample precomputation ----
    const off = model.offsetFor(o.offsets, band);
    const base = model.bandBase(ctx, band);
    const kk = 10 * ctx.p.n;
    const mpp = ctx.mpp;
    const nodeSig = new Float64Array(nS).fill(-Infinity);
    if (node) {
      const nxp = node.pos.x * W;
      const nyp = node.pos.y * H;
      for (let j = 0; j < nS; j++) {
        const dm = Math.hypot(SX[j] - nxp, SY[j] - nyp) * mpp;
        nodeSig[j] = clamp(base - kk * Math.log10(dm < 1 ? 1 : dm) - model.traceLoss(ctx, nxp, nyp, SX[j], SY[j]) + off + (node.power || 0), -110, -20);
      }
    }
    const vals = new Float64Array(nS);
    let speedLim = null;
    let tDown = 1;
    let tUp = 1;
    if (speedMode) {
      speedLim = speed.toLimits({ ...o.speed.limits, reserve: o.speed.reserve !== undefined ? o.speed.reserve : o.speed.limits && o.speed.limits.reserve });
      tDown = o.speed.targetDown;
      tUp = o.speed.targetUp;
    }

    /** Score of a router at px position (x,y) over the samples. Allocation free apart from a typed-array sort. */
    function score(x, y) {
      let total = 0;
      for (let gi = 0; gi < groupWeight.length; gi++) {
        const a = groupStart[gi];
        const b = groupStart[gi + 1];
        const cnt = b - a;
        let good = 0;
        let sum = 0;
        for (let j = a; j < b; j++) {
          const dm = Math.hypot(SX[j] - x, SY[j] - y) * mpp;
          let s = base - kk * Math.log10(dm < 1 ? 1 : dm) - model.traceLoss(ctx, x, y, SX[j], SY[j]) + off;
          s = s < -110 ? -110 : s > -20 ? -20 : s;
          if (nodeSig[j] > s) s = nodeSig[j];
          if (speedMode) {
            const p = speed.predict(o.speed.curve, s, speedLim);
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

    // ---- candidate lattice ----
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

      // ---- exact before / after on the full grid (the field the map shows: softened unless soften is 0) ----
      const aaF = o.aa !== undefined ? o.aa : g.cell <= 4 ? 2 : 1;
      const norm = (x, y) => ({ x: Number((x / W).toFixed(6)), y: Number((y / H).toFixed(6)) });
      const fieldAt = (router) => raster.field(ctx, g, { band, router, node, offsets: o.offsets, aa: aaF, soften: o.soften });
      const summary = (f) => {
        const st = raster.stats(g, f, targetIds, threshold);
        return { coverage: st.coverage, mean: st.mean, median: st.median, p10: st.p10 };
      };
      let pos = norm(best.x, best.y);
      let afterField = null;
      if (!speedMode && model.softenOf(o.soften) > 0) {
        // The search ranks with the exact rays on a sub-sample (fast); the numbers the user sees come from the
        // softened full grid. Rank the refined finalists (and the current position, when it is an allowed answer) by
        // the same score on the softened full grid, so the result is never worse than staying put in the UI's numbers.
        const fullScore = (f) => {
          let total = 0;
          targetIds.forEach((id, gi) => {
            const st = raster.stats(g, f, [id], threshold);
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
          const f = fieldAt(p);
          const fs = fullScore(f);
          if (!top1 || fs > top1.fs + 1e-9) top1 = { p, f, fs, it };
          await tick();
        }
        if (top1) {
          pos = top1.p;
          afterField = top1.f;
          best = { s: top1.it.s === -Infinity ? score(top1.it.x, top1.it.y) : top1.it.s, x: top1.it.x, y: top1.it.y };
        }
      }
      if (c.signal && c.signal.aborted) throw abortError();
      const after = summary(afterField || fieldAt(pos));
      const samePlace = hasRouter && pos.x === o.router.x && pos.y === o.router.y;
      const before = hasRouter ? (samePlace ? { ...after } : summary(fieldAt(o.router))) : null;
      const scoreBefore = hasRouter ? score(o.router.x * W, o.router.y * H) : null;
      if (c.onProgress) c.onProgress(1);
      return { pos, roomId: roomAtPx(ctx, best.x, best.y), score: best.s, scoreBefore, before, after, candidates: cand.length };
    } finally {
      yielder.close();
    }
  }

  E.optimize = { find, roomAtPx };
})();
