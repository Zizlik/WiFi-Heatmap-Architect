/* WiFi Heatmap Architect - engine.speed: empirical speed model (a port of the legacy semantics).
 *
 * There is NO default conversion from dBm to Mb/s. The user measures real speed tests (download + upload) at a few
 * places with a known signal; a monotone curve through them is the only basis of any speed estimate:
 *   - per signal value the median of the tests is taken, in log1p space, per direction,
 *   - isotonic regression (pool adjacent violators) makes the curve non-decreasing,
 *   - weaker than the weakest test -> unknown (null); stronger than the strongest -> clamped to the best test.
 * Needs >= 2 distinct signal values at least 5 dB apart, with download AND upload on every used test, same band and
 * same device. A second node makes speed unsupported (the legacy rule).
 * Speed-test points without a measured signal (value null, SPEC 6.2) take part through fillSignals(): they get the
 * model's predicted signal at their spot (router at the baseline, softened like the map, calibrated).
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { clamp, isNum, median, round } = E.util;
  const units = E.units;
  const model = E.model;

  const validRate = (v) => isNum(v) && v >= 0 && v <= 10000;

  /**
   * Measurements ready for buildCurve() / diagnose(): a point without a measured signal (value null - a speed test
   * taken where the phone could not read dBm) gets the model's predicted signal at that spot for its band, with the
   * router at the baseline (where every measurement is taken), softened like the map and shifted by that band's
   * calibration offset - i.e. exactly what the calibrated "today" map shows there. Such copies carry
   * predictedSignal:true. Points with a measured value are passed through as the same objects. Pure; ≈ 0.1 ms per
   * filled point, so callers that run per frame should cache the result.
   * @param {object} ctx model.createContext(project)
   * @param {Array<object>} measurements project.measurements
   * @param {{baseline:{x:number,y:number}, offsets?:{'2.4':number,'5':number,'6':number}, soften?:number}} opts
   * @returns {Array<object>}
   */
  function fillSignals(ctx, measurements, opts) {
    const o = opts || {};
    return (measurements || []).map((m) => {
      if (!m || isNum(m.value) || !ctx || !o.baseline) return m;
      const b = units.normBand(m.band);
      if (b === null || !isNum(m.x) || !isNum(m.y)) return m;
      const v = model.softSignal(ctx, o.baseline, { x: m.x, y: m.y }, b, model.offsetFor(o.offsets, b), o.soften);
      return Number.isFinite(v) ? { ...m, value: round(v, 2), predictedSignal: true } : m;
    });
  }

  /**
   * Median per distinct signal value in log1p space, then isotonic (non-decreasing) regression.
   * @param {Array<{value:number}>} points
   * @param {'download'|'upload'} key
   * @returns {Array<{x:number,y:number}>} nodes sorted by x (signal dBm), y = log1p(rate)
   */
  function monotoneSpeed(points, key) {
    const groups = [];
    for (const p of [...points].sort((a, b) => a.value - b.value)) {
      let g = groups[groups.length - 1];
      if (!g || g.x !== p.value) {
        g = { x: p.value, values: [] };
        groups.push(g);
      }
      g.values.push(p[key]);
    }
    const nodes = groups.map((g) => ({ x: g.x, y: Math.log1p(median(g.values)) }));
    const blocks = [];
    nodes.forEach((n, i) => {
      blocks.push({ a: i, b: i, total: n.y, n: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1];
        const a = blocks[blocks.length - 2];
        if (a.total / a.n <= b.total / b.n) break;
        blocks.splice(-2, 2, { a: a.a, b: b.b, total: a.total + b.total, n: a.n + b.n });
      }
    });
    for (const b of blocks) for (let i = b.a; i <= b.b; i++) nodes[i].y = b.total / b.n;
    return nodes;
  }

  function usable(measurements, band, device) {
    const b = units.normBand(band);
    const key = device ? model.profileKey(device) : null;
    return (measurements || []).filter(
      (m) => units.normBand(m.band) === b && (key === null || model.profileKey(m.device) === key) && isNum(m.value) && validRate(m.download) && validRate(m.upload),
    );
  }

  /**
   * Why (not) a curve can be built - drives the "add another test" hints.
   * @returns {{count:number, distinct:number, spread:number, ok:boolean, needs:'none'|'tests'|'spread'}}
   *   needs: 'tests' = fewer than two distinct signal values, 'spread' = values less than 5 dB apart, 'none' = ok
   */
  function diagnose(measurements, opts) {
    const o = opts || {};
    const ps = usable(measurements, o.band, o.device);
    const distinct = [...new Set(ps.map((p) => p.value))].sort((a, b) => a - b);
    const spread = distinct.length ? distinct[distinct.length - 1] - distinct[0] : 0;
    const ok = distinct.length >= 2 && spread >= 5;
    return { count: ps.length, distinct: distinct.length, spread, ok, needs: ok ? 'none' : distinct.length < 2 ? 'tests' : 'spread' };
  }

  /**
   * Build the speed curve for one band and device.
   * @param {Array<object>} measurements project.measurements
   * @param {{band:number, device?:string}} opts device omitted = all devices
   * @returns {{band:number, device:string|null, download:Array<{x,y}>, upload:Array<{x,y}>, min:number, max:number, count:number}|null}
   *   min/max = weakest/strongest measured signal in dBm; null when the data does not suffice.
   */
  function buildCurve(measurements, opts) {
    const o = opts || {};
    const ps = usable(measurements, o.band, o.device);
    const distinct = [...new Set(ps.map((p) => p.value))].sort((a, b) => a - b);
    if (distinct.length < 2 || distinct[distinct.length - 1] - distinct[0] < 5) return null;
    return {
      band: units.normBand(o.band),
      device: o.device || null,
      download: monotoneSpeed(ps, 'download'),
      upload: monotoneSpeed(ps, 'upload'),
      min: distinct[0],
      max: distinct[distinct.length - 1],
      count: ps.length,
    };
  }

  function rateAt(signal, nodes) {
    if (signal < nodes[0].x) return null;
    const last = nodes[nodes.length - 1];
    if (signal >= last.x) return Math.expm1(last.y);
    for (let i = 1; i < nodes.length; i++) {
      if (signal <= nodes[i].x) {
        const a = nodes[i - 1];
        const b = nodes[i];
        const t = (signal - a.x) / (b.x - a.x);
        return Math.expm1(a.y + t * (b.y - a.y));
      }
    }
    return null;
  }

  /**
   * Raw interpolated rate (Mb/s) at a signal level. Stronger than the strongest test is clamped to it.
   * @returns {{down:number, up:number, extrapolated:boolean}|null} null when weaker than the weakest test;
   *          extrapolated = signal is stronger than anything measured (value is the best measured result)
   */
  function rate(curve, signal) {
    if (!curve) return null;
    const down = rateAt(signal, curve.download);
    const up = rateAt(signal, curve.upload);
    if (down === null || up === null) return null;
    return { down, up, extrapolated: signal > curve.max };
  }

  /** Ceiling in Mb/s from WAN port / ONT port / negotiated link (smallest given), Infinity when none is known. */
  function linkLimit(opts) {
    const o = opts || {};
    return Math.min(isNum(o.wanPort) ? o.wanPort : Infinity, isNum(o.ontPort) ? o.ontPort : Infinity, isNum(o.wanLink) ? o.wanLink : Infinity);
  }

  /**
   * Expected speed at a signal level after the internet plan / cable ceilings and the planning reserve.
   * @param {object} curve buildCurve()
   * @param {number} signal dBm
   * @param {{wanDown?:number|null, wanUp?:number|null, linkLimit?:number, reserve?:number}} [limits] reserve in percent (0..80)
   * @returns {{down:number, up:number, extrapolated:boolean}|null}
   */
  function predict(curve, signal, limits) {
    const r = rate(curve, signal);
    if (!r) return null;
    const l = limits || {};
    const keep = 1 - clamp(isNum(l.reserve) ? l.reserve : 0, 0, 100) / 100;
    const link = isNum(l.linkLimit) ? l.linkLimit : Infinity;
    return {
      down: Math.min(r.down, isNum(l.wanDown) ? l.wanDown : Infinity, link) * keep,
      up: Math.min(r.up, isNum(l.wanUp) ? l.wanUp : Infinity, link) * keep,
      extrapolated: r.extrapolated,
    };
  }

  /** Normalize raw limits {wanDown,wanUp,wanPort,ontPort,wanLink,reserve} into predict()'s argument. */
  function toLimits(limits) {
    const l = limits || {};
    return { wanDown: l.wanDown, wanUp: l.wanUp, reserve: l.reserve, linkLimit: isNum(l.linkLimit) ? l.linkLimit : linkLimit(l) };
  }

  /**
   * Predicted speed for every grid cell (router only; with a second node active speed is unsupported).
   * @param {object} ctx
   * @param {object} g raster.grid()
   * @param {object} params raster.field() params (band, router, node, offsets)
   * @param {object|null} curve buildCurve()
   * @param {{wanDown?,wanUp?,wanPort?,ontPort?,wanLink?,reserve?}} [limits]
   * @param {Float32Array} [signalField] already computed router-only signal field to reuse
   * @returns {{down:Float32Array, up:Float32Array, known:Uint8Array, supported:boolean, reason:null|'node'|'curve'}}
   *   known[i]=1 where the curve covers the cell; down/up in Mb/s after limits and reserve (0 where unknown).
   */
  function fieldSpeed(ctx, g, params, curve, limits, signalField) {
    const n = g.cols * g.rows;
    const out = { down: new Float32Array(n), up: new Float32Array(n), known: new Uint8Array(n), supported: true, reason: null };
    if (params.node && params.node.mode !== 'none') {
      out.supported = false;
      out.reason = 'node';
      return out;
    }
    if (!curve) {
      out.supported = false;
      out.reason = 'curve';
      return out;
    }
    const sig = signalField || E.raster.field(ctx, g, { ...params, node: null });
    const lim = toLimits(limits);
    const idx = g.idx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const s = predict(curve, sig[i], lim);
      if (s) {
        out.known[i] = 1;
        out.down[i] = s.down;
        out.up[i] = s.up;
      }
    }
    return out;
  }

  /**
   * Per-cell goal ratio min(down/targetDown, up/targetUp): NaN outside rooms, -1 where unknown. Feed to
   * raster.colorize(..., {mode:'speed'}); >= 1 means the target is met.
   */
  function ratioField(g, sf, targetDown, targetUp) {
    const out = new Float32Array(g.cols * g.rows).fill(NaN);
    for (let m = 0; m < g.idx.length; m++) {
      const i = g.idx[m];
      out[i] = sf.known[i] ? Math.min(sf.down[i] / targetDown, sf.up[i] / targetUp) : -1;
    }
    return out;
  }

  /**
   * Statistics of a speed field over rooms (legacy speedStatistics).
   * @param {object} g grid
   * @param {{down,up,known}} sf fieldSpeed() result
   * @param {{roomIds?:number[]|null, excluded?:number[], targetDown:number, targetUp:number}} opts
   * @returns {{known:number, coverage:number, medianDown:number|null, medianUp:number|null, p10Down:number|null, p10Up:number|null, n:number}}
   *   known = % of the selected floor covered by the curve; coverage = % that meets BOTH targets; p10 = weak tail
   *   (null when that tail is unknown). Percentages are of all selected cells.
   */
  function stats(g, sf, opts) {
    const o = opts || {};
    const ex = o.excluded && o.excluded.length ? new Set(o.excluded) : null;
    const ids = o.roomIds === null || o.roomIds === undefined ? g.roomIds.filter((id) => !ex || !ex.has(id)) : [].concat(o.roomIds);
    const dl = [];
    const ul = [];
    let known = 0;
    let ok = 0;
    for (const id of ids) {
      const cells = g.roomCells.get(id);
      if (!cells) continue;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        if (sf.known[i]) {
          known++;
          dl.push(sf.down[i]);
          ul.push(sf.up[i]);
          if (sf.down[i] >= o.targetDown && sf.up[i] >= o.targetUp) ok++;
        } else {
          dl.push(-1);
          ul.push(-1);
        }
      }
    }
    const n = dl.length;
    if (!n) return { known: 0, coverage: 0, medianDown: null, medianUp: null, p10Down: null, p10Up: null, n: 0 };
    dl.sort((a, b) => a - b);
    ul.sort((a, b) => a - b);
    const at = (v, f) => {
      const x = v[Math.floor((v.length - 1) * f)];
      return x < 0 ? null : x;
    };
    return { known: (100 * known) / n, coverage: (100 * ok) / n, medianDown: at(dl, 0.5), medianUp: at(ul, 0.5), p10Down: at(dl, 0.1), p10Up: at(ul, 0.1), n };
  }

  /**
   * Score of one room's goal ratios (legacy speedCandidateScore term): pass-rate*10 + min(p10,2) + 0.1*mean(min(r,2)).
   * @param {ArrayLike<number>} ratios min(down/targetDown, up/targetUp) per sample (0 = unknown/too weak)
   */
  function scoreRatios(ratios) {
    const n = ratios.length;
    if (!n) return 0;
    const s = Float64Array.from(ratios).sort();
    let pass = 0;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      if (s[i] >= 1) pass++;
      mean += Math.min(s[i], 2);
    }
    return (pass / n) * 10 + Math.min(s[Math.floor((n - 1) * 0.1)], 2) + (mean / n) * 0.1;
  }

  E.speed = { validRate, monotoneSpeed, fillSignals, diagnose, buildCurve, rate, predict, linkLimit, toLimits, fieldSpeed, ratioField, stats, scoreRatios };
})();
