/* WiFi Heatmap Architect - engine.analysis: "today vs trial" in one call.
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
   * @param {{cell?:number, band?:number, aa?:number, soften?:number, ctx?:object, offsets?:object, cache?:object,
   *          reuse?:{today?:Float32Array, trial?:Float32Array}}} [opts]
   *   cell: grid cell size in px (4 = full quality, 8 = coarse for dragging); band defaults to project.view.band;
   *   aa: anti-aliasing factor of the fields (default 2 for cell <= 4, else 1; see raster.fieldEx);
   *   soften: diffraction softening in metres (default model.SOFTEN = 0.4, 0 = exact rays; see raster.fieldEx). When
   *   you let analysis compute the offsets they are calibrated with the same soften;
   *   ctx / offsets: pass already computed ones to skip recomputation; reuse: buffers to fill (no allocation);
   *   cache: an object you keep between calls ({}), the unchanged "today" field AND its statistics (stats.today,
   *   perRoom.today) are then computed only once per baseline / geometry / parameters / goal - the returned `today`
   *   array and today's stats objects are shared with the cache, treat them as read-only.
   * @returns {{ctx:object, grid:object, band:number, offsets:object, threshold:number, soften:number,
   *   params:{today:object, trial:object}, today:Float32Array, trial:Float32Array, diff:Float32Array,
   *   nodeWins:Uint8Array|null, backhaul:number|null, weakBackhaul:boolean, targetRooms:number[]|null,
   *   stats:{today:object, trial:object}, perRoom:{today:Map, trial:Map}, delta:{coverage:number, mean:number}}}
   *   stats objects: {coverage, mean, median, p10, n}; delta = trial - today (percentage points / dB);
   *   targetRooms null = whole flat (all rooms except goal.excluded).
   */
  function run(project, opts) {
    const o = opts || {};
    const ctx = o.ctx || model.createContext(project);
    const grid = raster.grid(ctx, { cell: o.cell || 4 });
    const band = units.normBand(o.band) || project.view.band;
    const soften = model.softenOf(o.soften);
    const offsets = o.offsets || model.offsets(ctx, project, { soften });
    const aa = o.aa !== undefined ? o.aa : grid.cell <= 4 ? 2 : 1;
    const params = {
      today: { ...model.fieldParams(project, 'today', { band, offsets, soften }), aa },
      trial: { ...model.fieldParams(project, 'trial', { band, offsets, soften }), aa },
    };
    const reuse = o.reuse || {};
    const cache = o.cache || null;
    // "today" does not change while the router is dragged: with a caller-owned cache object it is computed once per
    // (geometry, parameters, baseline, band, offsets, grid, aa, soften)
    const key = cache
      ? [ctx.version, grid.cell, aa, soften, band, params.today.router.x, params.today.router.y, model.offsetFor(offsets, band)].join('|')
      : null;
    let today;
    if (key && cache.key === key && cache.today && cache.today.length === grid.cols * grid.rows) today = cache.today;
    else {
      today = raster.field(ctx, grid, params.today, reuse.today);
      if (key) {
        cache.key = key;
        cache.today = today;
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
      tr = { field: copy, nodeWins: null };
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
    };
  }

  E.analysis = { run };
})();
