/* WiFi Heatmap Architect - engine.raster: floor grid, signal field, statistics, colours, contour lines.
 *
 * The grid always covers the whole 1080 x 942 canvas with square cells of `cell` px (default 4 -> 270 x 236 cells).
 * Cell (col c, row r) has index i = r*cols + c and its centre at px ((c+0.5)*cell, (r+0.5)*cell) (clamped to the
 * canvas). Fields are Float32Array(cols*rows) of dBm with NaN for cells outside every room.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { clamp, isNum } = E.util;
  const units = E.units;
  const model = E.model;

  // ---------------------------------------------------------------------------------------------------------------
  // grid
  // ---------------------------------------------------------------------------------------------------------------

  const GRID_CACHE_MAX = 8;
  const gridCache = new Map();

  /**
   * Rasterize the rooms of a context. Cached on (ctx.roomsVersion, cell), so rebuilding the context after a slider
   * move or a router drag is free. The returned object is shared: never mutate it.
   * @param {object} ctx
   * @param {{cell?:number}} [opts] cell size in px, integer 1..64 (default 4; 8 = coarse mode for dragging)
   * @returns {{cols:number,rows:number,cell:number,cx:Float32Array,cy:Float32Array,colPx:Float64Array,rowPx:Float64Array,
   *   room:Uint16Array,idx:Int32Array,rim:Int32Array,roomCells:Map<number,Int32Array>,roomIds:number[],areaPx:number,count:number}}
   *   cx/cy: normalized centre of every cell index; room: roomId or 0 per cell; idx: indices of floor cells (ascending);
   *   roomCells: roomId -> Int32Array of its cell indices; areaPx: floor area in px^2; rim: non-floor cells touching the floor.
   */
  function grid(ctx, opts) {
    let cell = opts && isNum(opts.cell) ? Math.round(opts.cell) : 4;
    cell = clamp(cell, 1, 64);
    const key = `${ctx.roomsVersion}:${cell}`;
    const hit = gridCache.get(key);
    if (hit) {
      gridCache.delete(key); // LRU refresh
      gridCache.set(key, hit);
      return hit;
    }
    const g = buildGrid(ctx, cell);
    gridCache.set(key, g);
    if (gridCache.size > GRID_CACHE_MAX) gridCache.delete(gridCache.keys().next().value);
    return g;
  }

  function buildGrid(ctx, cell) {
    const cols = Math.ceil(W / cell);
    const rows = Math.ceil(H / cell);
    const n = cols * rows;
    const colPx = new Float64Array(cols);
    const rowPx = new Float64Array(rows);
    for (let c = 0; c < cols; c++) colPx[c] = Math.min((c + 0.5) * cell, W);
    for (let r = 0; r < rows; r++) rowPx[r] = Math.min((r + 0.5) * cell, H);

    const room = new Uint16Array(n);
    // scanline fill using exactly the same even-odd rule as geom.pointInPolygon, evaluated at the cell centres
    for (const rm of ctx.rooms) {
      const xs = new Float64Array(rm.n + 1);
      const r0 = Math.max(0, Math.floor(rm.minY / cell - 0.5) - 1);
      const r1 = Math.min(rows - 1, Math.ceil(rm.maxY / cell - 0.5) + 1);
      for (let r = r0; r <= r1; r++) {
        const y = rowPx[r];
        let nx = 0;
        for (let i = 0, j = rm.n - 1; i < rm.n; j = i++) {
          const yi = rm.y[i];
          const yj = rm.y[j];
          if (yi > y !== yj > y) xs[nx++] = ((rm.x[j] - rm.x[i]) * (y - yi)) / (yj - yi) + rm.x[i];
        }
        if (nx < 2) continue;
        // sort the few crossings
        for (let a = 1; a < nx; a++) {
          const v = xs[a];
          let b = a - 1;
          while (b >= 0 && xs[b] > v) {
            xs[b + 1] = xs[b];
            b--;
          }
          xs[b + 1] = v;
        }
        for (let a = 0; a + 1 < nx; a += 2) {
          const xa = xs[a];
          const xb = xs[a + 1];
          let c = Math.max(0, Math.ceil(xa / cell - 0.5) - 1);
          while (c < cols && colPx[c] < xa) c++;
          const base = r * cols;
          for (; c < cols && colPx[c] < xb; c++) room[base + c] = rm.id;
        }
      }
    }

    // floor index list, per room lists
    let count = 0;
    const perRoom = new Map();
    for (let i = 0; i < n; i++) {
      const id = room[i];
      if (id) {
        count++;
        perRoom.set(id, (perRoom.get(id) || 0) + 1);
      }
    }
    const idx = new Int32Array(count);
    const roomCells = new Map();
    for (const [id, c] of perRoom) roomCells.set(id, new Int32Array(c));
    const fill = new Map();
    let k = 0;
    for (let i = 0; i < n; i++) {
      const id = room[i];
      if (!id) continue;
      idx[k++] = i;
      const f = fill.get(id) || 0;
      roomCells.get(id)[f] = i;
      fill.set(id, f + 1);
    }
    const roomIds = [...roomCells.keys()].sort((a, b) => a - b);

    // normalized centres per cell + the rim of non-floor cells that touch the floor (used by colorize bleed)
    const cx = new Float32Array(n);
    const cy = new Float32Array(n);
    for (let r = 0; r < rows; r++) {
      const ny = rowPx[r] / H;
      for (let c = 0; c < cols; c++) {
        cx[r * cols + c] = colPx[c] / W;
        cy[r * cols + c] = ny;
      }
    }
    const rimList = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (room[i]) continue;
        let touch = false;
        for (let dr = -1; dr <= 1 && !touch; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            if (room[rr * cols + cc]) {
              touch = true;
              break;
            }
          }
        }
        if (touch) rimList.push(i);
      }
    }
    return {
      cols,
      rows,
      cell,
      cx,
      cy,
      colPx,
      rowPx,
      room,
      idx,
      rim: Int32Array.from(rimList),
      roomCells,
      roomIds,
      areaPx: count * cell * cell,
      count,
    };
  }

  /** Area of one grid cell in square metres. */
  function cellAreaM2(ctx, g) {
    return g.cell * g.cell * ctx.mpp * ctx.mpp;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // field
  // ---------------------------------------------------------------------------------------------------------------

  /** Everything needed to evaluate the signal at a px point for one set of field params. */
  function prepare(ctx, params) {
    const band = units.normBand(params.band !== undefined ? params.band : params.targetBand);
    if (band === null || !params.router) throw new RangeError('raster.field: band and router are required');
    const off = model.offsetFor(params.offsets, band);
    const node = model.nodeActive(params.node, band) ? params.node : null;
    return {
      band,
      rx: params.router.x * W,
      ry: params.router.y * H,
      off,
      base: model.bandBase(ctx, band),
      k: 10 * ctx.p.n,
      mpp: ctx.mpp,
      node,
      nx: node ? node.pos.x * W : 0,
      ny: node ? node.pos.y * H : 0,
      noff: node ? off + (node.power || 0) : 0,
      win: false,
    };
  }

  /** Signal (dBm, clamped) at one px point; sets P.win when the node is the stronger source. */
  function evalPx(ctx, P, x, y) {
    let dx = x - P.rx;
    let dy = y - P.ry;
    let dm = Math.sqrt(dx * dx + dy * dy) * P.mpp;
    let s = P.base - P.k * Math.log10(dm < 1 ? 1 : dm) - model.traceLoss(ctx, P.rx, P.ry, x, y) + P.off;
    s = s < -110 ? -110 : s > -20 ? -20 : s;
    P.win = false;
    if (P.node) {
      dx = x - P.nx;
      dy = y - P.ny;
      dm = Math.sqrt(dx * dx + dy * dy) * P.mpp;
      let s2 = P.base - P.k * Math.log10(dm < 1 ? 1 : dm) - model.traceLoss(ctx, P.nx, P.ny, x, y) + P.noff;
      s2 = s2 < -110 ? -110 : s2 > -20 ? -20 : s2;
      if (s2 > s) {
        s = s2;
        P.win = true;
      }
    }
    return s;
  }

  function fieldPlain(ctx, g, params, reuse) {
    const P = prepare(ctx, params);
    const n = g.cols * g.rows;
    const out = reuse && reuse.length === n ? reuse : new Float32Array(n);
    out.fill(NaN);
    const nodeWins = P.node ? new Uint8Array(n) : null;
    const idx = g.idx;
    const cols = g.cols;
    const colPx = g.colPx;
    const rowPx = g.rowPx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const r = (i / cols) | 0;
      out[i] = evalPx(ctx, P, colPx[i - r * cols], rowPx[r]);
      if (P.win) nodeWins[i] = 1;
    }
    return { field: out, nodeWins };
  }

  /** A cell is refined when it differs from a same-room 4-neighbour by more than this many dB. */
  const AA_EDGE_DB = 0.4;

  /**
   * Adaptive anti-aliasing. Every cell is first sampled at its centre; cells that differ from a neighbour of the same
   * room by more than AA_EDGE_DB (wedge and shadow edges, wall steps, steep decay near the router) are re-evaluated as
   * the average of aa x aa sub-samples (only sub-samples that lie in the same room). Smooth regions keep their centre
   * sample, which equals the sub-sample average there, so the result is the same as supersampling every cell at a
   * fraction of the cost (about 1.3x a plain field instead of aa^2 x).
   */
  function fieldAA(ctx, g, params, reuse, aa) {
    const base = fieldPlain(ctx, g, params, reuse);
    const out = base.field;
    const nodeWins = base.nodeWins;
    const cols = g.cols;
    const rows = g.rows;
    const idx = g.idx;
    const flag = new Uint8Array(cols * rows);
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const r = (i / cols) | 0;
      const c = i - r * cols;
      const id = g.room[i];
      const v = out[i];
      if (c + 1 < cols && g.room[i + 1] === id && Math.abs(out[i + 1] - v) > AA_EDGE_DB) flag[i] = flag[i + 1] = 1;
      if (r + 1 < rows && g.room[i + cols] === id && Math.abs(out[i + cols] - v) > AA_EDGE_DB) flag[i] = flag[i + cols] = 1;
    }
    const fine = grid(ctx, { cell: g.cell / aa });
    const P = prepare(ctx, params);
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      if (!flag[i]) continue;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      const id = g.room[i];
      let sum = 0;
      let cnt = 0;
      let wins = 0;
      for (let a = 0; a < aa; a++) {
        const fr = r * aa + a;
        if (fr >= fine.rows) break;
        for (let b = 0; b < aa; b++) {
          const fc = c * aa + b;
          if (fc >= fine.cols) break;
          if (fine.room[fr * fine.cols + fc] !== id) continue;
          sum += evalPx(ctx, P, fine.colPx[fc], fine.rowPx[fr]);
          cnt++;
          if (P.win) wins++;
        }
      }
      if (!cnt) continue; // sliver of a room: keep the centre sample
      out[i] = sum / cnt;
      if (nodeWins) nodeWins[i] = wins * 2 >= cnt ? 1 : 0;
    }
    return { field: out, nodeWins };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // diffraction softening (see model.js header): masked separable box-Gaussian of the obstacle loss
  // ---------------------------------------------------------------------------------------------------------------

  const BLUR_CACHE_MAX = 6;
  const blurCache = new Map();
  const SOFT_ITERS = 4; // iterations of (row pass + column pass); their variances halve from one to the next

  /**
   * Where the softening may mix neighbouring cells, cached on (ctx.version, cell): two neighbours are linked when both
   * are floor cells and no wall (or closed door) of >= model.BARRIER_DB crosses the segment between their centres.
   * Walls - between rooms or inside one - therefore stay sharp steps, while an open doorway or a room boundary
   * without a wall stays as continuous as the exact field is there (masking by room id instead would draw an
   * invisible wall into every doorway). The links are stored as maximal runs along rows (stride 1) and columns
   * (stride cols).
   *   hS/hL, vS/vL: Int32Array start index / length of every run longer than one cell,
   *   edge: Int32Array floor cells next to a wall (the only cells anti-aliasing still refines when softening).
   */
  function blurPlan(ctx, g) {
    const key = `${ctx.version}:${g.cell}`;
    const hit = blurCache.get(key);
    if (hit && hit.g === g) {
      blurCache.delete(key);
      blurCache.set(key, hit);
      return hit;
    }
    const plan = buildBlurPlan(ctx, g);
    blurCache.set(key, plan);
    if (blurCache.size > BLUR_CACHE_MAX) blurCache.delete(blurCache.keys().next().value);
    return plan;
  }

  function buildBlurPlan(ctx, g) {
    const { cols, rows, cell, colPx, rowPx, room } = g;
    const n = cols * rows;
    // bar bit 1: wall between cell i and i+1; bit 2: between i and i+cols
    const bar = new Uint8Array(n);
    // barriers are decided on the 5 GHz reference losses (as model.wallBlocks), so one plan serves every band
    ctx = model.forBand(ctx, 5);
    const w = ctx.w;
    const B = model.BARRIER_DB;
    const lastIndexBelow = (arr, len, v) => {
      // largest k with arr[k] < v (arr ascending), -1 if none
      let k = clamp(Math.ceil(v / cell - 0.5) - 1, -1, len - 1);
      while (k + 1 < len && arr[k + 1] < v) k++;
      while (k >= 0 && arr[k] >= v) k--;
      return k;
    };
    for (let k = 0; k < w.n; k++) {
      const ax = w.ax[k];
      const ay = w.ay[k];
      const sx = w.sx[k];
      const sy = w.sy[k];
      // pairs along a row: the wall crosses the row's centre line y between two cell centres
      if (Math.abs(sy) > 1e-9) {
        const r0 = Math.max(0, Math.floor(w.minY[k] / cell - 0.5));
        const r1 = Math.min(rows - 1, Math.ceil(w.maxY[k] / cell - 0.5));
        for (let r = r0; r <= r1; r++) {
          const u = (rowPx[r] - ay) / sy;
          if (u < 0 || u > 1) continue;
          const x = ax + u * sx;
          const c = lastIndexBelow(colPx, cols, x);
          if (c < 0 || c + 1 >= cols) continue;
          const i = r * cols + c;
          if (!(bar[i] & 1) && model.crossLoss(ctx, k, colPx[c], rowPx[r], colPx[c + 1], rowPx[r]) >= B) bar[i] |= 1;
        }
      }
      // pairs along a column
      if (Math.abs(sx) > 1e-9) {
        const c0 = Math.max(0, Math.floor(w.minX[k] / cell - 0.5));
        const c1 = Math.min(cols - 1, Math.ceil(w.maxX[k] / cell - 0.5));
        for (let c = c0; c <= c1; c++) {
          const u = (colPx[c] - ax) / sx;
          if (u < 0 || u > 1) continue;
          const y = ay + u * sy;
          const r = lastIndexBelow(rowPx, rows, y);
          if (r < 0 || r + 1 >= rows) continue;
          const i = r * cols + c;
          if (!(bar[i] & 2) && model.crossLoss(ctx, k, colPx[c], rowPx[r], colPx[c], rowPx[r + 1]) >= B) bar[i] |= 2;
        }
      }
    }
    const hS = [];
    const hL = [];
    const vS = [];
    const vL = [];
    const edge = [];
    let maxLen = 1;
    for (let r = 0; r < rows; r++) {
      let c = 0;
      while (c < cols) {
        let i = r * cols + c;
        if (!room[i]) {
          c++;
          continue;
        }
        const start = i;
        while (c + 1 < cols && room[i + 1] && !(bar[i] & 1)) {
          c++;
          i++;
        }
        const len = i - start + 1;
        if (len > 1) {
          hS.push(start);
          hL.push(len);
          if (len > maxLen) maxLen = len;
        }
        if (c + 1 < cols && room[i + 1] && bar[i] & 1) edge.push(i, i + 1);
        c++;
      }
    }
    for (let c = 0; c < cols; c++) {
      let r = 0;
      while (r < rows) {
        let i = r * cols + c;
        if (!room[i]) {
          r++;
          continue;
        }
        const start = i;
        while (r + 1 < rows && room[i + cols] && !(bar[i] & 2)) {
          r++;
          i += cols;
        }
        const len = (i - start) / cols + 1;
        if (len > 1) {
          vS.push(start);
          vL.push(len);
          if (len > maxLen) maxLen = len;
        }
        if (r + 1 < rows && room[i + cols] && bar[i] & 2) edge.push(i, i + cols);
        r++;
      }
    }
    edge.sort((a, b) => a - b);
    const edgeU = edge.filter((v, k) => k === 0 || v !== edge[k - 1]);
    return { g, cols, bar, hS: Int32Array.from(hS), hL: Int32Array.from(hL), vS: Int32Array.from(vS), vL: Int32Array.from(vL), edge: Int32Array.from(edgeU), maxLen };
  }

  /**
   * Box radii (cells) of the SOFT_ITERS softening iterations for a Gaussian of sigma `s` cells, largest first: the
   * variances follow 8:4:2:1 (a box of radius r has variance r(r+1)/3) and add up to s^2 as closely as integers allow.
   * Why decreasing boxes and alternating pass order (see blurRuns) instead of three equal boxes: the blur may cross an
   * open doorway but not the wall beside it, so a column pass carries the values through the doorway in the doorway's
   * columns only. If the LAST pass is a big column pass, that leaves a rectangle with hard vertical edges on the far
   * side of every doorway (clearly visible). With large passes first and small ones last, every hard edge one pass
   * creates is blurred by the following passes, and the result matches a true wall-masked 2D Gaussian (the visibility
   * stencil of model.softLossPx) to ~0.15 dB rms on a real plan - the same as three equal boxes - without the
   * rectangles. All radii are 0 below ~0.6 cells (no softening).
   */
  function boxRadii(s) {
    const V = s > 0 ? s * s : 0;
    const out = [];
    let wsum = 0;
    for (let i = 0; i < SOFT_ITERS; i++) wsum += Math.pow(0.5, i);
    let acc = 0;
    let target = 0;
    for (let i = 0; i < SOFT_ITERS; i++) {
      target += (V * Math.pow(0.5, i)) / wsum;
      const want = Math.max(0, target - acc);
      const r0 = Math.round((Math.sqrt(1 + 12 * want) - 1) / 2);
      let best = 0;
      let err = Infinity;
      for (let r = Math.max(0, r0 - 1); r <= r0 + 1; r++) {
        const e = Math.abs(acc + (r * (r + 1)) / 3 - target);
        if (e < err) {
          err = e;
          best = r;
        }
      }
      acc += (best * (best + 1)) / 3;
      out.push(best);
    }
    return out;
  }

  let prefix = new Float64Array(0);

  /** One normalized box pass of radius r over every run (the window shrinks at the run ends). In place. */
  function boxPass(v, S, L, stride, r) {
    const P = prefix;
    for (let q = 0; q < S.length; q++) {
      const s0 = S[q];
      const len = L[q];
      let acc = 0;
      P[0] = 0;
      for (let k = 0, i = s0; k < len; k++, i += stride) {
        acc += v[i];
        P[k + 1] = acc;
      }
      for (let k = 0, i = s0; k < len; k++, i += stride) {
        const lo = k > r ? k - r : 0;
        const hi = k + r < len ? k + r : len - 1;
        v[i] = (P[hi + 1] - P[lo]) / (hi - lo + 1);
      }
    }
  }

  /** The iterations of blurRuns in one order: iteration k starts with the rows when (k + first) is even. In place. */
  function blurOrder(plan, v, radii, first) {
    for (let k = 0; k < radii.length; k++) {
      const r = radii[k];
      if (!r) continue;
      if ((k + first) % 2 === 0) {
        boxPass(v, plan.hS, plan.hL, 1, r);
        boxPass(v, plan.vS, plan.vL, plan.cols, r);
      } else {
        boxPass(v, plan.vS, plan.vL, plan.cols, r);
        boxPass(v, plan.hS, plan.hL, 1, r);
      }
    }
  }

  let softT = new Float32Array(0);

  /**
   * Masked box-Gaussian of a per-cell array (floor cells only) in place. Iteration k is a row pass and a column pass
   * of radius radii[k] with alternating order (rows first, columns first, ...); the result is the mean of that
   * sequence and its mirror (columns first, rows first, ...). A single order is anisotropic at doorways: whichever
   * direction comes last leaves a slightly harder edge beyond doorways in walls of one orientation (synthetic doorway,
   * steepest step along the wall beyond the door: 0.6 dB in one orientation and 2.9 dB in the other; the mirrored mean
   * gives 1.7 dB in both, the exact wall-masked Gaussian 2.1 dB). Costs a second blur (~0.3 ms at cell 8 on the
   * real plan).
   */
  function blurRuns(plan, v, radii) {
    if (prefix.length < plan.maxLen + 1) prefix = new Float64Array(plan.maxLen + 1);
    const idx = plan.g.idx;
    const n = plan.g.cols * plan.g.rows;
    if (softT.length < n) softT = new Float32Array(n);
    const t = softT;
    for (let m = 0; m < idx.length; m++) t[idx[m]] = v[idx[m]];
    blurOrder(plan, v, radii, 0);
    blurOrder(plan, t, radii, 1);
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      v[i] = 0.5 * (v[i] + t[i]);
    }
  }

  /** Sigma of the softening in cells of grid g for field params (0 = off). */
  function softSigmaCells(ctx, g, params) {
    const s = model.softenOf(params.soften);
    return s > 0 ? s / (ctx.mpp * g.cell) : 0;
  }

  /**
   * Obstacle loss of every floor cell for a source at px (sx,sy), written into L. With aa > 1 the cells along a wall
   * inside their own room (plan.edge) get the mean loss of their same-room sub-samples (an anti-aliased wall step);
   * every other edge is blurred anyway, so it needs no refinement.
   */
  function lossField(ctx, g, sx, sy, L, aa, plan) {
    const idx = g.idx;
    const cols = g.cols;
    const colPx = g.colPx;
    const rowPx = g.rowPx;
    const trace = model.traceLoss;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const r = (i / cols) | 0;
      L[i] = trace(ctx, sx, sy, colPx[i - r * cols], rowPx[r]);
    }
    if (aa > 1 && aa <= 4 && g.cell % aa === 0 && plan.edge.length) {
      const fine = grid(ctx, { cell: g.cell / aa });
      const edge = plan.edge;
      for (let m = 0; m < edge.length; m++) {
        const i = edge[m];
        const r = (i / cols) | 0;
        const c = i - r * cols;
        const id = g.room[i];
        let sum = 0;
        let cnt = 0;
        for (let a = 0; a < aa; a++) {
          const fr = r * aa + a;
          if (fr >= fine.rows) break;
          for (let b = 0; b < aa; b++) {
            const fc = c * aa + b;
            if (fc >= fine.cols) break;
            if (fine.room[fr * fine.cols + fc] !== id) continue;
            sum += trace(ctx, sx, sy, fine.colPx[fc], fine.rowPx[fr]);
            cnt++;
          }
        }
        if (cnt) L[i] = sum / cnt;
      }
    }
  }

  let softA = new Float32Array(0);
  let softB = new Float32Array(0);

  /**
   * Softened field: per source, the obstacle loss of every cell is blurred (masked box-Gaussian, sigma in cells), then
   * signal = free space - blurred loss + offset (+ node power), clamped. With a second node both sources are softened
   * separately and the stronger one wins per cell; nodeWins is decided on the softened values (so the hatch matches
   * the colours and pointSignalDetail().bestSource).
   */
  function fieldSoft(ctx, g, params, reuse, aa, radii) {
    const P = prepare(ctx, params);
    const n = g.cols * g.rows;
    const out = reuse && reuse.length === n ? reuse : new Float32Array(n);
    out.fill(NaN);
    const nodeWins = P.node ? new Uint8Array(n) : null;
    if (!g.count) return { field: out, nodeWins };
    const plan = blurPlan(ctx, g);
    // scratch buffers are only indexed below n, so the largest grid's buffers serve every cell size (no reallocation
    // when the planner alternates between cell 8 drag frames, cell 4 settled frames and the contour grid)
    if (softA.length < n) softA = new Float32Array(n);
    lossField(ctx, g, P.rx, P.ry, softA, aa, plan);
    blurRuns(plan, softA, radii);
    if (P.node) {
      if (softB.length < n) softB = new Float32Array(n);
      lossField(ctx, g, P.nx, P.ny, softB, aa, plan);
      blurRuns(plan, softB, radii);
    }
    const idx = g.idx;
    const cols = g.cols;
    const colPx = g.colPx;
    const rowPx = g.rowPx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const r = (i / cols) | 0;
      const x = colPx[i - r * cols];
      const y = rowPx[r];
      let dx = x - P.rx;
      let dy = y - P.ry;
      let dm = Math.sqrt(dx * dx + dy * dy) * P.mpp;
      let s = P.base - P.k * Math.log10(dm < 1 ? 1 : dm) - softA[i] + P.off;
      s = s < -110 ? -110 : s > -20 ? -20 : s;
      if (P.node) {
        dx = x - P.nx;
        dy = y - P.ny;
        dm = Math.sqrt(dx * dx + dy * dy) * P.mpp;
        let s2 = P.base - P.k * Math.log10(dm < 1 ? 1 : dm) - softB[i] + P.noff;
        s2 = s2 < -110 ? -110 : s2 > -20 ? -20 : s2;
        if (s2 > s) {
          s = s2;
          nodeWins[i] = 1;
        }
      }
      out[i] = s;
    }
    return { field: out, nodeWins };
  }

  /**
   * Signal field with details. Same as field() but also reports where the second node is the stronger source.
   * @param {object} ctx
   * @param {object} g grid()
   * @param {object} params {band, router:{x,y}, node?:object|null, offsets?:{'2.4','5','6'}, aa?:1|2|3, soften?:number}
   *        (see model.fieldParams). `targetBand` is accepted as an alias of `band`.
   *        soften = diffraction softening in METRES (default model.SOFTEN = 0.4; 0 = exact rays, the old behaviour):
   *        the obstacle loss is blurred with a Gaussian of that sigma over the floor - never across a wall or a closed
   *        door (>= model.BARRIER_DB), so walls stay sharp steps while an open doorway stays continuous - and the
   *        free-space term and the offset are added afterwards (see model.js header). The same physical sigma at every
   *        cell size.
   *        aa = anti-aliasing factor: 1 (default) samples every cell once at its centre, 2 re-samples edge cells as the
   *        average of 2x2 same-room sub-samples (grid.cell must be divisible by aa, else ignored). Without softening the
   *        edge cells are those on wedge / shadow / wall edges (~1.3-2x the cost); with softening only the cells along
   *        a wall inside their own room (everything else is blurred anyway; ~no extra cost).
   * @param {Float32Array} [reuse] optional buffer of cols*rows to fill instead of allocating (drag loop)
   * @returns {{field:Float32Array, nodeWins:Uint8Array|null, bands:Uint8Array|null}} nodeWins[i]=1 where the node beats
   *   the router. Band mode Auto (SPEC 13: params.band 'auto' with bands / steer as model.fieldParams puts them): every
   *   router band is computed and each cell takes the band of the steering rule (model.steerBand); bands[i] = 0 / 1 / 2
   *   for 2.4 / 5 / 6 GHz (255 off the floor), null for a single band.
   */
  function fieldEx(ctx, g, params, reuse) {
    if (model.isAuto(params)) {
      const res = fieldAuto(ctx, g, params, reuse);
      remember(res, params);
      return res;
    }
    // the obstacle losses of the field's band (SPEC 7.1); everything below works on that band's view of the context
    ctx = model.forBand(ctx, params.band !== undefined ? params.band : params.targetBand);
    const aa = Math.floor(params.aa || 1);
    const sigma = softSigmaCells(ctx, g, params);
    let res = null;
    if (sigma > 0) {
      const radii = boxRadii(sigma);
      if (radii.some((r) => r > 0)) res = fieldSoft(ctx, g, params, reuse, aa, radii);
    }
    if (!res) res = aa > 1 && aa <= 4 && g.cell % aa === 0 ? fieldAA(ctx, g, params, reuse, aa) : fieldPlain(ctx, g, params, reuse);
    res.bands = null;
    remember(res, params);
    return res;
  }

  // ---- band mode Auto (SPEC 13) ----------------------------------------------------------------------------------
  // Every band the router sends is computed as its own field (softened, calibrated, the node where it serves that
  // band); then every cell takes the band of the steering rule (model.steerBand). Per-band scratch fields are kept per
  // grid size, so a drag loop that alternates cell 8 / cell 4 does not reallocate.
  const autoScratch = new Map();
  const NO_BAND = 255;

  /** The steering rule on the three per-band values of one place (NaN = the band is not sent): 0/1/2, -1 = none. */
  function pickBandIdx(v0, v1, v2, st) {
    if (v2 === v2 && v2 >= st.six) return 2;
    if (v1 === v1 && v1 >= st.five) return 1;
    if (v0 === v0) return 0;
    if (v1 === v1 && (v2 !== v2 || v1 >= v2)) return 1;
    return v2 === v2 ? 2 : -1;
  }

  function fieldAuto(ctx, g, params, reuse) {
    const bands = model.routerBandList(params.bands);
    const st = model.steerOf(params.steer);
    const n = g.cols * g.rows;
    let bufs = autoScratch.get(n);
    if (!bufs) {
      if (autoScratch.size > 4) autoScratch.clear();
      bufs = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      autoScratch.set(n, bufs);
    }
    const per = [null, null, null];
    for (const b of bands) {
      const bi = model.bandIndex(b);
      const one = { ...params, band: b };
      delete one.targetBand;
      delete one.bands;
      delete one.steer;
      const r = fieldEx(ctx, g, one, bufs[bi]);
      per[bi] = { f: r.field, wins: r.nodeWins };
    }
    const out = reuse && reuse.length === n ? reuse : new Float32Array(n);
    out.fill(NaN);
    const bandIdx = new Uint8Array(n).fill(NO_BAND);
    const nodeWins = per.some((x) => x && x.wins) ? new Uint8Array(n) : null;
    const f0 = per[0] && per[0].f;
    const f1 = per[1] && per[1].f;
    const f2 = per[2] && per[2].f;
    const idx = g.idx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const k = pickBandIdx(f0 ? f0[i] : NaN, f1 ? f1[i] : NaN, f2 ? f2[i] : NaN, st);
      if (k < 0) continue;
      out[i] = per[k].f[i];
      bandIdx[i] = k;
      if (nodeWins && per[k].wins && per[k].wins[i]) nodeWins[i] = 1;
    }
    return { field: out, nodeWins, bands: bandIdx };
  }

  // Which cells of a field array the second node serves (SPEC 10): speed.fieldSpeed / homeSummary need the source of
  // every cell. fieldEx remembers it per output array (a WeakMap, nothing is kept alive), together with the source
  // positions, so a caller that hands in `a.trial` (or a reused drag buffer) needs nothing extra - and a stale entry
  // (the same buffer refilled by other code) is never used: the positions must match. In the band mode Auto (SPEC 13)
  // the band of every cell is remembered the same way (the key then also holds the bands, thresholds and offsets).
  const winsOf = new WeakMap();
  const srcKey = (params) => {
    const n = params.node;
    if (model.isAuto(params)) {
      const bands = model.routerBandList(params.bands);
      const st = model.steerOf(params.steer);
      const on = !!(n && n.mode !== 'none' && n.pos);
      const nodeBands = on ? bands.map((b) => (model.nodeActive(n, b) ? 1 : 0)).join('') : '';
      const offs = bands.map((b) => model.offsetFor(params.offsets, b)).join(',');
      return ['auto', bands.join(','), st.six, st.five, offs, params.router.x, params.router.y, on ? n.pos.x : '', on ? n.pos.y : '', on ? n.power || 0 : '', nodeBands].join('|');
    }
    const b = units.normBand(params.band !== undefined ? params.band : params.targetBand);
    const on = model.nodeActive(n, b);
    return [b, params.router.x, params.router.y, on ? n.pos.x : '', on ? n.pos.y : '', on ? n.power || 0 : ''].join('|');
  };
  function remember(res, params) {
    try {
      winsOf.set(res.field, { key: srcKey(params), nodeWins: res.nodeWins, bands: res.bands || null });
    } catch (e) {
      /* not an object key: nothing to remember */
    }
  }

  /**
   * Tell the raster that `f` holds the field of `params` with these nodeWins / bands (e.g. an independent copy of a
   * field computed by fieldEx), so nodeWinsOf / bandsOf - and speed.fieldSpeed / homeSummary - find them.
   * @param {Float32Array} f
   * @param {object} params the params the field was computed with
   * @param {{nodeWins?:Uint8Array|null, bands?:Uint8Array|null}} [extra]
   */
  function adoptField(f, params, extra) {
    if (!f || typeof f !== 'object' || !params || !params.router) return;
    const x = extra || {};
    remember({ field: f, nodeWins: x.nodeWins || null, bands: x.bands || null }, params);
  }

  /**
   * The per-cell band (SPEC 13, band mode Auto) of a field array computed by field()/fieldEx() with these params:
   * Uint8Array (0 = 2.4, 1 = 5, 2 = 6 GHz, 255 off the floor), null for a single-band field, undefined when the array
   * was not (or no longer) computed for them.
   */
  function bandsOf(f, params) {
    if (!f || typeof f !== 'object' || !params || !params.router) return undefined;
    const hit = winsOf.get(f);
    if (!hit) return undefined;
    return hit.key === srcKey(params) ? hit.bands : undefined;
  }

  /**
   * Share of the floor on each band (SPEC 13, the band-zone legend "kde budeš na 6 / 5 / 2,4 GHz").
   * @param {object} g grid()
   * @param {Uint8Array|null} bands fieldEx().bands / bandsOf()
   * @param {number[]|number|null} [roomIds] null = whole flat minus `excluded`
   * @param {number[]} [excluded]
   * @returns {{'2.4':number,'5':number,'6':number}} percent of the selected floor cells (0 each without bands)
   */
  function bandShare(g, bands, roomIds, excluded) {
    const out = { '2.4': 0, '5': 0, '6': 0 };
    if (!g || !g.roomCells || !bands || bands.length !== g.cols * g.rows) return out;
    const cnt = [0, 0, 0];
    let total = 0;
    for (const id of selectRooms(g, roomIds, excluded)) {
      const cells = g.roomCells.get(id);
      if (!cells) continue;
      for (let k = 0; k < cells.length; k++) {
        const b = bands[cells[k]];
        if (b > 2) continue;
        cnt[b]++;
        total++;
      }
    }
    if (total) {
      out['2.4'] = (100 * cnt[0]) / total;
      out['5'] = (100 * cnt[1]) / total;
      out['6'] = (100 * cnt[2]) / total;
    }
    return out;
  }

  /** '#rrggbb' / '#rgb' / [r,g,b] -> [r,g,b] or null. */
  function rgbOf(c) {
    if (Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((v) => isNum(v))) return c.slice(0, 3).map((v) => clamp(Math.round(v), 0, 255));
    if (typeof c !== 'string') return null;
    let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c.trim());
    if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
    return null;
  }

  /**
   * The optional band-zone overlay (SPEC 13): one pixel per grid cell in the colour of the band a steering client uses
   * there - colours come from the caller (the UI reads them from its CSS tokens). Same conventions as colorize().
   * @param {object} g grid()
   * @param {Uint8Array} bands fieldEx().bands
   * @param {{'2.4'?:string|number[], '5'?:string|number[], '6'?:string|number[]}} colors '#rrggbb' or [r,g,b]; a band
   *        without a colour stays transparent
   * @param {{alpha?:number, bleed?:boolean, target?:Uint8ClampedArray}} [opts] alpha default 0.22
   * @returns {{width:number,height:number,data:Uint8ClampedArray}}
   */
  function bandZones(g, bands, colors, opts) {
    const o = opts || {};
    const n = g.cols * g.rows;
    const data = o.target && o.target.length === n * 4 ? o.target : new Uint8ClampedArray(n * 4);
    if (data === o.target) data.fill(0);
    if (!bands || bands.length !== n) return { width: g.cols, height: g.rows, data };
    const a255 = Math.round(clamp(o.alpha === undefined ? 0.22 : Number(o.alpha) || 0, 0, 1) * 255);
    const c = colors || {};
    const rgb = [rgbOf(c['2.4']), rgbOf(c['5']), rgbOf(c['6'])];
    const idx = g.idx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const b = bands[i];
      const col = b <= 2 ? rgb[b] : null;
      if (!col) continue;
      const j = i * 4;
      data[j] = col[0];
      data[j + 1] = col[1];
      data[j + 2] = col[2];
      data[j + 3] = a255;
    }
    if (o.bleed !== false) bleedRim(g, data);
    return { width: g.cols, height: g.rows, data };
  }

  /**
   * Borders between the band zones (SPEC 13) as smoothed chains of normalized points (like contours): one set per
   * pair of neighbouring bands that occur. Traced on the band rank of every cell, so a border runs midway between
   * cells of different bands.
   * @param {object} g grid()
   * @param {Uint8Array} bands fieldEx().bands
   * @param {{smooth?:number}} [opts] Chaikin iterations (default 2, 0..4)
   * @returns {Array<Array<{x:number,y:number}>>}
   */
  function bandEdges(g, bands, opts) {
    if (!g || !bands || bands.length !== g.cols * g.rows) return [];
    const iters = opts && opts.smooth !== undefined ? clamp(Math.floor(Number(opts.smooth)) || 0, 0, 4) : 2;
    const present = [0, 1, 2].filter((b) => g.idx.some((i) => bands[i] === b));
    if (present.length < 2) return [];
    const rank = new Float32Array(bands.length).fill(NaN);
    for (let m = 0; m < g.idx.length; m++) {
      const i = g.idx[m];
      const r = present.indexOf(bands[i]);
      if (r >= 0) rank[i] = r;
    }
    const out = [];
    for (let level = 0; level < present.length - 1; level++) {
      const lat = latticeFromField(g, rank, level + 0.5);
      for (const ch of march(lat)) out.push(iters ? chaikin(thinChain(ch, 0.5 * lat.spacing), iters) : ch);
    }
    return out;
  }

  /**
   * nodeWins of a field array computed by field()/fieldEx() with these params (null = the node serves nowhere), or
   * undefined when this array was not (or no longer) computed for them.
   */
  function nodeWinsOf(f, params) {
    if (!f || typeof f !== 'object' || !params || !params.router) return undefined;
    const hit = winsOf.get(f);
    if (!hit) return undefined;
    return hit.key === srcKey(params) ? hit.nodeWins : undefined;
  }

  /**
   * dBm per grid cell for one router (and optionally one second node). NaN outside the rooms.
   * @param {object} ctx
   * @param {object} g grid()
   * @param {{band:number, router:{x,y}, node?:object|null, offsets?:object, aa?:number}} params use
   *        model.fieldParams(project, 'trial'|'today', {offsets}); see fieldEx for `aa`
   * @param {Float32Array} [reuse] optional output buffer (length cols*rows)
   * @returns {Float32Array}
   */
  function field(ctx, g, params, reuse) {
    return fieldEx(ctx, g, params, reuse).field;
  }

  /**
   * Display smoothing: binomial 3x3 blur of a field that never mixes cells of different rooms (so walls between rooms
   * stay crisp). Softens the stair-steps along wedge edges; use it for drawing only - statistics should use the raw field.
   * @param {object} g grid()
   * @param {Float32Array} f field
   * @param {{passes?:number}} [opts] passes (default 1)
   * @returns {Float32Array} new field
   */
  function smooth(g, f, opts) {
    const passes = Math.max(1, Math.min(4, (opts && opts.passes) || 1));
    const cols = g.cols;
    const rows = g.rows;
    let src = f;
    for (let p = 0; p < passes; p++) {
      const out = new Float32Array(src.length).fill(NaN);
      for (let m = 0; m < g.idx.length; m++) {
        const i = g.idx[m];
        const r = (i / cols) | 0;
        const c = i - r * cols;
        const id = g.room[i];
        let sum = 0;
        let wsum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const k = rr * cols + cc;
            const v = src[k];
            if (g.room[k] !== id || v !== v) continue;
            const w = (dr ? 1 : 2) * (dc ? 1 : 2);
            sum += v * w;
            wsum += w;
          }
        }
        out[i] = wsum ? sum / wsum : src[i];
      }
      src = out;
    }
    return src;
  }

  /** a - b per cell (positive = a is stronger). NaN where either is NaN. */
  function diff(a, b) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // statistics
  // ---------------------------------------------------------------------------------------------------------------

  let scratch = new Float32Array(0);

  /**
   * The k-th smallest value of v[lo..hi] (inclusive; no NaN), by quickselect with a median-of-three pivot and Hoare
   * partitioning (fine with many equal values, e.g. a field clamped at -110). Reorders v[lo..hi] so that everything left
   * of k is <= v[k] <= everything right of it. Exactly the value a sort would put at index k, in O(n) instead of
   * O(n log n): stats() needs only the median and the 10th percentile, and runs on every drag frame.
   */
  function selectK(v, lo, hi, k) {
    while (hi > lo) {
      const a = v[lo];
      const b = v[(lo + hi) >> 1];
      const c = v[hi];
      const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (v[i] < pivot) i++;
        while (v[j] > pivot) j--;
        if (i <= j) {
          const t = v[i];
          v[i] = v[j];
          v[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return v[k];
    }
    return v[k];
  }

  function summarize(buf, count, threshold) {
    if (!count) return { coverage: 0, mean: -110, median: -110, p10: -110, n: 0 };
    const v = buf.subarray(0, count);
    let sum = 0;
    let good = 0;
    for (let i = 0; i < count; i++) {
      sum += v[i];
      if (v[i] >= threshold) good++;
    }
    const kMed = Math.floor((count - 1) * 0.5);
    const median = selectK(v, 0, count - 1, kMed);
    // v[0..kMed] now holds the kMed+1 smallest values, so the 10th percentile is selected among them
    const p10 = selectK(v, 0, kMed, Math.floor((count - 1) * 0.1));
    return { coverage: (100 * good) / count, mean: sum / count, median, p10, n: count };
  }

  /** Resolve the room selection to a list of room ids. null/undefined = all rooms that are not excluded. */
  function selectRooms(g, roomIds, excluded) {
    if (roomIds === null || roomIds === undefined || roomIds === 'all') {
      const ex = excluded && excluded.length ? new Set(excluded) : null;
      return g.roomIds.filter((id) => !ex || !ex.has(id));
    }
    return Array.isArray(roomIds) ? roomIds : [roomIds];
  }

  function gatherInto(g, f, ids) {
    let total = 0;
    for (const id of ids) {
      const c = g.roomCells.get(id);
      if (c) total += c.length;
    }
    if (scratch.length < total) scratch = new Float32Array(Math.max(total, scratch.length * 2));
    let n = 0;
    for (const id of ids) {
      const c = g.roomCells.get(id);
      if (!c) continue;
      for (let i = 0; i < c.length; i++) {
        const v = f[c[i]];
        if (v === v) scratch[n++] = v; // skips NaN
      }
    }
    return n;
  }

  /**
   * Area-weighted statistics of a field over a set of rooms (every grid cell has the same area, so this is simply
   * the pool of all their cells).
   * @param {object} g grid()
   * @param {Float32Array} f field
   * @param {number[]|number|null} roomIds rooms to include; null = whole flat (all rooms except `excluded`)
   * @param {number} threshold dBm counted as "good signal"
   * @param {number[]} [excluded] room ids left out of the "whole flat" selection
   * @returns {{coverage:number, mean:number, median:number, p10:number, n:number}} coverage in percent of the floor
   *   area with signal >= threshold; mean/median/p10 in dBm (p10 = weak tail, 10th percentile); n = number of cells.
   *   Empty selection -> coverage 0 and -110 dBm.
   */
  function stats(g, f, roomIds, threshold, excluded) {
    const ids = selectRooms(g, roomIds, excluded);
    const n = gatherInto(g, f, ids);
    return summarize(scratch, n, threshold);
  }

  /**
   * stats() for every room that has floor cells.
   * @returns {Map<number,{coverage:number,mean:number,median:number,p10:number,n:number}>}
   */
  function perRoom(g, f, threshold) {
    const out = new Map();
    for (const id of g.roomIds) {
      const n = gatherInto(g, f, [id]);
      out.set(id, summarize(scratch, n, threshold));
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sampling
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Value of a field at a normalized point (bilinear between the four nearest cell centres; cells outside the rooms
   * are ignored and the weights renormalized). NaN when the point is not near any floor cell.
   * @param {object} g grid()
   * @param {Float32Array} f field
   * @param {{x,y}} p normalized
   * @param {{nearest?:boolean}} [opts] nearest=true -> value of the cell containing p
   */
  function sample(g, f, p, opts) {
    const fx = (p.x * W) / g.cell - 0.5;
    const fy = (p.y * H) / g.cell - 0.5;
    if (opts && opts.nearest) {
      const c = clamp(Math.floor(fx + 0.5), 0, g.cols - 1);
      const r = clamp(Math.floor(fy + 0.5), 0, g.rows - 1);
      return f[r * g.cols + c];
    }
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const tx = fx - c0;
    const ty = fy - r0;
    let sum = 0;
    let wsum = 0;
    for (let dr = 0; dr <= 1; dr++) {
      const r = r0 + dr;
      if (r < 0 || r >= g.rows) continue;
      for (let dc = 0; dc <= 1; dc++) {
        const c = c0 + dc;
        if (c < 0 || c >= g.cols) continue;
        const v = f[r * g.cols + c];
        if (v !== v) continue;
        const w = (dc ? tx : 1 - tx) * (dr ? ty : 1 - ty);
        sum += v * w;
        wsum += w;
      }
    }
    return wsum > 1e-9 ? sum / wsum : NaN;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // colours
  // ---------------------------------------------------------------------------------------------------------------

  const STOPS = {
    default: [
      [-85, [228, 60, 46]],
      [-75, [238, 109, 48]],
      [-65, [239, 181, 76]],
      [-55, [183, 186, 71]],
      [-45, [114, 183, 85]],
      [-30, [100, 174, 181]],
    ],
    cb: [
      [-85, [68, 1, 84]],
      [-75, [59, 82, 139]],
      [-65, [33, 145, 140]],
      [-55, [94, 201, 98]],
      [-45, [189, 223, 38]],
      [-30, [253, 231, 37]],
    ],
  };
  const DIFF_RED = [214, 69, 65];
  const DIFF_NEUTRAL = [170, 178, 190];
  const DIFF_GREEN = [46, 160, 110];
  const SPEED_UNKNOWN = [113, 126, 148];

  /** Piecewise linear colour of a dBm value for a palette ('default' | 'cb'): [r,g,b]. */
  function signalColor(dbm, palette) {
    const stops = STOPS[palette] || STOPS.default;
    if (dbm <= stops[0][0]) return stops[0][1].slice();
    for (let i = 1; i < stops.length; i++) {
      if (dbm <= stops[i][0]) {
        const [a, c] = stops[i - 1];
        const [b, d] = stops[i];
        const t = (dbm - a) / (b - a);
        return c.map((x, j) => Math.round(x + (d[j] - x) * t));
      }
    }
    return stops[stops.length - 1][1].slice();
  }

  const lutCache = {};
  function signalLut(palette) {
    const key = STOPS[palette] ? palette : 'default';
    if (!lutCache[key]) {
      const lut = new Uint8Array(361 * 3); // -110 .. -20 dBm in 0.25 dB steps
      for (let i = 0; i < 361; i++) {
        const c = signalColor(-110 + i * 0.25, key);
        lut[i * 3] = c[0];
        lut[i * 3 + 1] = c[1];
        lut[i * 3 + 2] = c[2];
      }
      lutCache[key] = lut;
    }
    return lutCache[key];
  }

  function lerp3(a, b, t, out) {
    out[0] = Math.round(a[0] + (b[0] - a[0]) * t);
    out[1] = Math.round(a[1] + (b[1] - a[1]) * t);
    out[2] = Math.round(a[2] + (b[2] - a[2]) * t);
  }

  /** Colour of a speed ratio (min(down/targetDown, up/targetUp)): red < 0.5 < amber < 1 <= green .. teal at 1.5. */
  function speedColor(r, out) {
    const RED = [228, 60, 46];
    const AMBER = [239, 181, 76];
    const GREEN = [114, 183, 85];
    const TEAL = [100, 174, 181];
    if (r < 0.5) lerp3(RED, AMBER, r * 2, out);
    else if (r < 1) lerp3(AMBER, GREEN, (r - 0.5) * 2, out);
    else lerp3(GREEN, TEAL, clamp((r - 1) / 0.5, 0, 1), out);
  }

  /**
   * Turn a field into an RGBA image (one pixel per grid cell) - feed it to `new ImageData(data, width, height)`.
   * mode 'signal': field in dBm. mode 'diff': field in dB difference (red <= -10, grey 0, green >= +10, low alpha near
   * 0). mode 'speed': field is a ratio from speed.ratioField (< 0 = unknown -> grey, NaN = outside).
   * Cells outside the rooms are transparent, except the 1-cell rim around the floor when `bleed` is true (default),
   * which repeats the edge colour so that smooth up-scaling stays solid up to the room outline - clip the image to the
   * room polygons when drawing.
   * @param {object} g grid()
   * @param {Float32Array} f field
   * @param {{palette?:'default'|'cb', mode?:'signal'|'diff'|'speed', alpha?:number, bleed?:boolean, target?:Uint8ClampedArray}} [opts]
   * @returns {{width:number,height:number,data:Uint8ClampedArray}}
   */
  function colorize(g, f, opts) {
    const o = opts || {};
    const mode = o.mode || 'signal';
    const alpha = o.alpha === undefined ? 1 : clamp(o.alpha, 0, 1);
    const a255 = Math.round(alpha * 255);
    const n = g.cols * g.rows;
    const data = o.target && o.target.length === n * 4 ? o.target : new Uint8ClampedArray(n * 4);
    if (data === o.target) data.fill(0);
    const lut = signalLut(o.palette);
    const tmp = [0, 0, 0];
    const idx = g.idx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const v = f[i];
      const j = i * 4;
      if (v !== v) continue; // NaN inside a room: leave transparent
      if (mode === 'diff') {
        if (v <= 0) lerp3(DIFF_NEUTRAL, DIFF_RED, Math.min(1, -v / 10), tmp);
        else lerp3(DIFF_NEUTRAL, DIFF_GREEN, Math.min(1, v / 10), tmp);
        data[j] = tmp[0];
        data[j + 1] = tmp[1];
        data[j + 2] = tmp[2];
        data[j + 3] = Math.round(a255 * (0.35 + 0.65 * Math.min(1, Math.abs(v) / 6)));
      } else if (mode === 'speed') {
        if (v < 0) {
          data[j] = SPEED_UNKNOWN[0];
          data[j + 1] = SPEED_UNKNOWN[1];
          data[j + 2] = SPEED_UNKNOWN[2];
          data[j + 3] = Math.round(a255 * 0.85);
        } else {
          speedColor(v, tmp);
          data[j] = tmp[0];
          data[j + 1] = tmp[1];
          data[j + 2] = tmp[2];
          data[j + 3] = a255;
        }
      } else {
        const li = Math.round((clamp(v, -110, -20) + 110) * 4) * 3;
        data[j] = lut[li];
        data[j + 1] = lut[li + 1];
        data[j + 2] = lut[li + 2];
        data[j + 3] = a255;
      }
    }
    if (o.bleed !== false) bleedRim(g, data);
    return { width: g.cols, height: g.rows, data };
  }

  /** Repeat the edge colour into the 1-cell rim around the floor (mean of the opaque floor neighbours). In place. */
  function bleedRim(g, data) {
    const rim = g.rim;
    const cols = g.cols;
    const rows = g.rows;
    for (let m = 0; m < rim.length; m++) {
      const i = rim[m];
      const r = (i / cols) | 0;
      const c = i - r * cols;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let cnt = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const k = rr * cols + cc;
          if (!g.room[k]) continue;
          const q = k * 4;
          if (data[q + 3] === 0) continue;
          sr += data[q];
          sg += data[q + 1];
          sb += data[q + 2];
          sa += data[q + 3];
          cnt++;
        }
      }
      if (cnt) {
        const j = i * 4;
        data[j] = sr / cnt;
        data[j + 1] = sg / cnt;
        data[j + 2] = sb / cnt;
        data[j + 3] = sa / cnt;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // contour lines (range lines)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Lattice for marching squares from a grid field: nodes = cell centres, value = field - threshold, NaN off the floor
   * except two rings of cells around it that get the mean of their valid neighbours, so the lines reach the room
   * outlines (they end up to ~2 cells outside them: clip to the rooms when drawing).
   */
  function latticeFromField(g, f, threshold) {
    const cols = g.cols;
    const rows = g.rows;
    let v = new Float32Array(cols * rows);
    for (let i = 0; i < v.length; i++) v[i] = g.room[i] ? f[i] - threshold : NaN;
    for (let ring = 0; ring < 2; ring++) {
      const src = v;
      v = src.slice();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (src[i] === src[i]) continue;
          let sum = 0;
          let cnt = 0;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              if (cc < 0 || cc >= cols) continue;
              const q = src[rr * cols + cc];
              if (q === q) {
                sum += q;
                cnt++;
              }
            }
          }
          if (cnt) v[i] = sum / cnt;
        }
      }
    }
    const X = new Float64Array(cols);
    const Y = new Float64Array(rows);
    for (let c = 0; c < cols; c++) X[c] = g.colPx[c] / W;
    for (let r = 0; r < rows; r++) Y[r] = g.rowPx[r] / H;
    return { nx: cols - 1, ny: rows - 1, v, X, Y, spacing: g.cell };
  }

  /** The exact (unsoftened) lattice over the whole canvas: (nx+1) x (ny+1) nodes from the canvas corners. */
  function latticeExact(ctx, band, opts, nx, ny) {
    ctx = model.forBand(ctx, band);
    const off = isNum(opts.offset) ? opts.offset : model.offsetFor(opts.offsets, band);
    const base = model.bandBase(ctx, band);
    const k = 10 * ctx.p.n;
    const rx = opts.router.x * W;
    const ry = opts.router.y * H;
    const node = model.nodeActive(opts.node, band) ? opts.node : null;
    const sx = node ? node.pos.x * W : 0;
    const sy = node ? node.pos.y * H : 0;
    const noff = node ? off + (node.power || 0) : 0;
    const stride = nx + 1;
    const v = new Float32Array(stride * (ny + 1));
    for (let j = 0; j <= ny; j++) {
      const y = (j / ny) * H;
      for (let i = 0; i <= nx; i++) {
        const x = (i / nx) * W;
        let dm = Math.hypot(x - rx, y - ry) * ctx.mpp;
        let s = clamp(base - k * Math.log10(dm < 1 ? 1 : dm) - model.traceLoss(ctx, rx, ry, x, y) + off, -110, -20);
        if (node) {
          dm = Math.hypot(x - sx, y - sy) * ctx.mpp;
          const s2 = clamp(base - k * Math.log10(dm < 1 ? 1 : dm) - model.traceLoss(ctx, sx, sy, x, y) + noff, -110, -20);
          if (s2 > s) s = s2;
        }
        v[j * stride + i] = s - opts.threshold;
      }
    }
    const X = new Float64Array(nx + 1);
    const Y = new Float64Array(ny + 1);
    for (let i = 0; i <= nx; i++) X[i] = i / nx;
    for (let j = 0; j <= ny; j++) Y[j] = j / ny;
    return { nx, ny, v, X, Y, spacing: Math.min(W / nx, H / ny) };
  }

  /** latticeExact() in the band mode Auto (SPEC 13): every router band traced, the steering rule per node. */
  function latticeExactAuto(ctx, opts, nx, ny) {
    const st = model.steerOf(opts.steer);
    const lats = [null, null, null];
    for (const b of model.routerBandList(opts.bands)) lats[model.bandIndex(b)] = latticeExact(ctx, b, { ...opts, offset: undefined, threshold: 0 }, nx, ny);
    const first = lats.find(Boolean);
    const v = new Float32Array(first.v.length);
    for (let i = 0; i < v.length; i++) {
      const k = pickBandIdx(lats[0] ? lats[0].v[i] : NaN, lats[1] ? lats[1].v[i] : NaN, lats[2] ? lats[2].v[i] : NaN, st);
      v[i] = k < 0 ? NaN : lats[k].v[i] - opts.threshold;
    }
    return { ...first, v };
  }

  /**
   * Marching squares (linear interpolation, ambiguous saddles resolved by the cell centre, squares with a NaN corner
   * skipped) assembled into polylines of normalized points; a closed loop repeats its first point at the end.
   */
  function march(lat) {
    const { nx, ny, v, X, Y } = lat;
    const stride = nx + 1;
    // edges get canonical ids so neighbouring cells agree exactly: horizontal edge (i,j)-(i+1,j) = 2*(j*stride+i),
    // vertical edge (i,j)-(i,j+1) = 2*(j*stride+i)+1
    const segA = [];
    const segB = [];
    const edgeSegs = new Map();
    const addSeg = (ea, eb) => {
      const s = segA.length;
      segA.push(ea);
      segB.push(eb);
      for (const e of [ea, eb]) {
        const l = edgeSegs.get(e);
        if (l) l.push(s);
        else edgeSegs.set(e, [s]);
      }
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * stride + i;
        const v00 = v[a];
        const v10 = v[a + 1];
        const v11 = v[a + stride + 1];
        const v01 = v[a + stride];
        if (v00 !== v00 || v10 !== v10 || v11 !== v11 || v01 !== v01) continue;
        const in00 = v00 >= 0;
        const in10 = v10 >= 0;
        const in11 = v11 >= 0;
        const in01 = v01 >= 0;
        if (in00 === in10 && in10 === in11 && in11 === in01) continue;
        const hits = [];
        if (in00 !== in10) hits.push(2 * a); // top
        if (in10 !== in11) hits.push(2 * (a + 1) + 1); // right
        if (in11 !== in01) hits.push(2 * (a + stride)); // bottom
        if (in01 !== in00) hits.push(2 * a + 1); // left
        if (hits.length === 2) addSeg(hits[0], hits[1]);
        else if (hits.length === 4) {
          const centre = (v00 + v10 + v11 + v01) / 4 >= 0;
          if (centre === in00) {
            addSeg(hits[0], hits[1]);
            addSeg(hits[2], hits[3]);
          } else {
            addSeg(hits[0], hits[3]);
            addSeg(hits[1], hits[2]);
          }
        }
      }
    }
    const pointCache = new Map();
    const edgePoint = (e) => {
      let p = pointCache.get(e);
      if (p) return p;
      const vert = e & 1;
      const node0 = e >> 1;
      const i0 = node0 % stride;
      const j0 = (node0 - i0) / stride;
      const i1 = vert ? i0 : i0 + 1;
      const j1 = vert ? j0 + 1 : j0;
      const va = v[node0];
      const vb = v[j1 * stride + i1];
      const t = va / (va - vb);
      p = { x: X[i0] + (X[i1] - X[i0]) * t, y: Y[j0] + (Y[j1] - Y[j0]) * t };
      pointCache.set(e, p);
      return p;
    };

    const used = new Uint8Array(segA.length);
    const chains = [];
    const walk = (startEdge, startSeg) => {
      const chain = [edgePoint(startEdge)];
      let e = startEdge;
      let s = startSeg;
      while (s !== undefined && !used[s]) {
        used[s] = 1;
        const nextE = segA[s] === e ? segB[s] : segA[s];
        chain.push(edgePoint(nextE));
        e = nextE;
        s = (edgeSegs.get(e) || []).find((q) => !used[q]);
      }
      return chain;
    };
    // open chains start at edges with a single segment (border of the lattice or of the valid region)
    for (const [e, list] of edgeSegs) {
      if (list.length === 1 && !used[list[0]]) {
        const ch = walk(e, list[0]);
        if (ch.length > 1) chains.push(ch);
      }
    }
    // everything left is a closed loop
    for (let s = 0; s < segA.length; s++) {
      if (used[s]) continue;
      const ch = walk(segA[s], s);
      if (ch.length > 1) chains.push(ch);
    }
    return chains;
  }

  /**
   * Chaikin corner cutting, `iters` times: every segment is replaced by its 1/4 and 3/4 points. Open chains keep their
   * end points; closed loops (first point == last point) stay closed. Each pass doubles the number of points, moves the
   * line by far less than a lattice cell and removes the marching-squares zigzag.
   */
  function chaikin(ch, iters) {
    if (!iters || ch.length < 3) return ch;
    const first = ch[0];
    const last = ch[ch.length - 1];
    const closed = first.x === last.x && first.y === last.y;
    let pts = closed ? ch.slice(0, -1) : ch;
    if (closed && pts.length < 3) return ch;
    for (let it = 0; it < iters; it++) {
      const m = pts.length;
      const out = [];
      if (!closed) out.push({ x: pts[0].x, y: pts[0].y });
      const segs = closed ? m : m - 1;
      for (let k = 0; k < segs; k++) {
        const a = pts[k];
        const b = pts[k + 1 < m ? k + 1 : 0];
        out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
      }
      if (!closed) out.push({ x: pts[m - 1].x, y: pts[m - 1].y });
      pts = out;
    }
    if (closed) pts.push({ x: pts[0].x, y: pts[0].y });
    return pts;
  }

  /**
   * Drop the interior points of a chain that lie closer than minPx (canvas px) to the previous kept point. Marching
   * squares makes such stubs (down to 0.005 px) wherever the line passes next to a lattice node; Chaikin keeps their
   * sharp turn because it cuts proportionally to the segment lengths. End points stay; a closed loop stays closed and
   * keeps at least 3 distinct points (else it is returned unchanged).
   */
  function thinChain(ch, minPx) {
    if (ch.length < 3 || !(minPx > 0)) return ch;
    const far = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) >= minPx;
    const last = ch[ch.length - 1];
    const closed = ch[0].x === last.x && ch[0].y === last.y;
    const out = [ch[0]];
    for (let k = 1; k < ch.length - 1; k++) if (far(ch[k], out[out.length - 1])) out.push(ch[k]);
    if (out.length > 1 && !far(out[out.length - 1], last)) out.pop();
    out.push(last);
    if (closed && out.length < 4) return ch;
    return out;
  }

  /**
   * Iso-lines of "signal = threshold" (range lines), smoothed.
   * By default they are traced on the SOFTENED field of a grid whose cell is about W/res[0] px (the same field
   * raster.field draws, so the lines follow the colours) - inside the rooms and up to ~2 cells beyond the outlines
   * (clip to the rooms when drawing). With `grid` + `field` the lines are traced on that field instead (e.g. the
   * analysis' trial field: exactly the colours, nothing recomputed). soften: 0 (or a plan without rooms) traces the
   * exact, unsoftened model over the whole canvas on a (res[0]+1) x (res[1]+1) lattice, as before.
   * @param {object} ctx
   * @param {{band:number|'auto', bands?:number[], steer?:object, router:{x,y}, node?:object|null, offset?:number,
   *          offsets?:object, threshold:number, res?:[number,number], soften?:number, smooth?:number, grid?:object,
   *          field?:Float32Array}} opts band 'auto' (SPEC 13): the range lines of the steered field (bands / steer as
   *          model.fieldParams puts them; every band with its own offset from offsets)
   *        offset (dB, this band) or offsets map; the node's power is added for the node source. smooth = Chaikin
   *        iterations (default 2, 0 = raw marching-squares polylines, max 4); before smoothing, points closer than
   *        half a lattice cell to their predecessor are dropped (marching-squares stubs). Smoothed lines stay within
   *        half a lattice cell of the raw ones.
   * @returns {Array<Array<{x:number,y:number}>>} chains of normalized points; a closed loop repeats its first point at the end
   */
  function contours(ctx, opts) {
    const auto = model.isAuto(opts);
    const band = auto ? 'auto' : units.normBand(opts.band);
    if (band === null || !opts.router) throw new RangeError('raster.contours: band and router are required');
    const iters = opts.smooth === undefined ? 2 : clamp(Math.floor(Number(opts.smooth)) || 0, 0, 4);
    let lat;
    if (opts.grid && opts.field && opts.field.length === opts.grid.cols * opts.grid.rows) {
      lat = latticeFromField(opts.grid, opts.field, opts.threshold);
    } else {
      const nx = clamp(Math.floor((opts.res && opts.res[0]) || 120), 4, 400);
      const ny = clamp(Math.floor((opts.res && opts.res[1]) || 104), 4, 400);
      const soften = model.softenOf(opts.soften);
      if (soften > 0 && ctx.rooms.length) {
        const g = grid(ctx, { cell: clamp(Math.round(W / nx), 2, 64) });
        let params;
        if (auto) {
          // band mode Auto (SPEC 13): the steered field, every band with its own offset
          params = { band: 'auto', bands: opts.bands, steer: opts.steer, router: opts.router, node: opts.node || null, offsets: opts.offsets, soften, aa: 1 };
        } else {
          const off = isNum(opts.offset) ? opts.offset : model.offsetFor(opts.offsets, band);
          const offsets = { '2.4': 0, '5': 0, '6': 0 };
          offsets[units.bandKey(band)] = off;
          params = { band, router: opts.router, node: opts.node || null, offsets, soften, aa: 1 };
        }
        lat = latticeFromField(g, field(ctx, g, params), opts.threshold);
      } else lat = auto ? latticeExactAuto(ctx, opts, nx, ny) : latticeExact(ctx, band, opts, nx, ny);
    }
    const chains = march(lat);
    if (!iters) return chains;
    const minPx = 0.5 * lat.spacing;
    return chains.map((ch) => chaikin(thinChain(ch, minPx), iters));
  }

  E.raster = {
    grid,
    cellAreaM2,
    field,
    fieldEx,
    nodeWinsOf,
    bandsOf,
    adoptField,
    bandShare,
    bandZones,
    bandEdges,
    diff,
    smooth,
    stats,
    perRoom,
    sample,
    colorize,
    signalColor,
    contours,
    chaikin,
    blurPlan,
    boxRadii,
    STOPS,
  };
})();
