/* WiFi Heatmap Architect - engine.speed: empirical speed model (a port of the legacy semantics).
 *
 * There is NO default conversion from dBm to Mb/s. The user measures real speed tests (download + upload) at a few
 * places with a known signal; a monotone curve through them is the only basis of any speed estimate:
 *   - per signal value the median of the tests is taken, in log1p space, per direction,
 *   - isotonic regression (pool adjacent violators) makes the curve non-decreasing,
 *   - weaker than the weakest test -> unknown (null); stronger than the strongest -> clamped to the best test.
 * Needs >= 2 distinct signal values at least 5 dB apart, with download AND upload on every used test, same band and
 * same device.
 * Second node (SPEC 10, stage 7 - lifts the legacy "speed unsupported with a node" rule): where the node is the stronger
 * source its client signal goes through the same curve, capped by the node's uplink (wireless mesh: curve(backhaul
 * signal) x 0.6, repeater x 0.5 - half-duplex on one radio; wired: no uplink cap), by node.maxMbps and by the plan /
 * link ceilings. One rule (predictVia) serves the map, the tooltip, the summary, the optimizer and the what-if.
 * Speed-test points without a measured signal (value null, SPEC 6.2) take part through fillSignals(): they get the
 * model's predicted signal at their spot (router at the baseline, softened like the map, calibrated).
 * Band steering (SPEC 13): the map / tooltip / summary / optimizer take one curve or a curves map (buildCurves); in the
 * band mode Auto every place uses the curve of its steered band, else the nearest band's (curveFor, flagged approx).
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { clamp, isNum, median, round } = E.util;
  const units = E.units;
  const model = E.model;

  const validRate = (v) => isNum(v) && v >= 0 && v <= 10000;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validNodes = (a) => Array.isArray(a) && a.length > 0 && a.every((n) => n && isNum(n.x) && isNum(n.y));
  /** A curve as buildCurve() makes it (anything else - null, a hand-made {} - counts as "no curve", never throws). */
  const validCurve = (c) => isObj(c) && validNodes(c.download) && validNodes(c.upload);

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
    return (Array.isArray(measurements) ? measurements : []).map((m) => {
      if (!isObj(m) || isNum(m.value) || !ctx || !o.baseline) return m;
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
    return (Array.isArray(measurements) ? measurements : []).filter(
      (m) => isObj(m) && units.normBand(m.band) === b && (key === null || model.profileKey(m.device) === key) && isNum(m.value) && validRate(m.download) && validRate(m.upload),
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

  /**
   * buildCurve() for every band (SPEC 13: the band mode Auto needs the curve of each band).
   * @param {Array<object>} measurements best model.resolveBands() + fillSignals() output (inferred / speed-only points count)
   * @param {{device?:string}} [opts]
   * @returns {{'2.4':object|null, '5':object|null, '6':object|null}}
   */
  function buildCurves(measurements, opts) {
    const device = opts && opts.device;
    const out = {};
    for (const b of E.BANDS) out[units.bandKey(b)] = buildCurve(measurements, { band: b, device });
    return out;
  }

  /** Which band's curve stands in when a band has none (SPEC 13: the nearest band first). */
  const CURVE_ORDER = Object.freeze({ 2.4: Object.freeze([2.4, 5, 6]), 5: Object.freeze([5, 6, 2.4]), 6: Object.freeze([6, 5, 2.4]) });

  /**
   * The speed curve to use for a band: its own, else the nearest band's (CURVE_ORDER) flagged approx (SPEC 13).
   * @param {object|null} curves a curves map {'2.4','5','6'} (buildCurves) OR one curve (buildCurve; then used for
   *        every band, approx when its band differs)
   * @param {number} band
   * @returns {{curve:object, band:number|null, approx:boolean}|null} null when no curve can stand in
   */
  function curveFor(curves, band) {
    const b = units.normBand(band);
    if (b === null) return null;
    if (validCurve(curves)) {
      const cb = units.normBand(curves.band);
      return { curve: curves, band: cb === null ? b : cb, approx: cb !== null && cb !== b };
    }
    if (!isObj(curves)) return null;
    for (const c of CURVE_ORDER[units.bandKey(b)]) {
      const cv = curves[units.bandKey(c)];
      if (validCurve(cv)) return { curve: cv, band: c, approx: c !== b };
    }
    return null;
  }

  /** curveFor() of the bands a field covers: [2.4, 5, 6] in the band mode Auto, [band] otherwise. */
  function curveTable(curve, params) {
    if (model.isAuto(params)) return E.BANDS.map((b) => curveFor(curve, b));
    return [curveFor(curve, params.band !== undefined ? params.band : params.targetBand)];
  }

  /** Is the node on for this field (in Auto: on some band the router sends)? */
  function nodeOnFor(params) {
    if (!params || !params.node) return false;
    if (model.isAuto(params)) return model.routerBandList(params.bands).some((b) => model.nodeActive(params.node, b));
    return model.nodeActive(params.node, units.normBand(params.band !== undefined ? params.band : params.targetBand));
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

  /** rate() without the curve check - hot loops check the curve once. NaN signal -> null. */
  function rateCore(curve, signal) {
    const down = rateAt(signal, curve.download);
    if (down === null) return null;
    const up = rateAt(signal, curve.upload);
    if (up === null) return null;
    return { down, up, extrapolated: signal > curve.max };
  }

  /**
   * Raw interpolated rate (Mb/s) at a signal level. Stronger than the strongest test is clamped to it.
   * @returns {{down:number, up:number, extrapolated:boolean}|null} null when weaker than the weakest test (or no valid
   *          curve / no number); extrapolated = signal is stronger than anything measured (value is the best measured result)
   */
  function rate(curve, signal) {
    if (!validCurve(curve) || !isNum(signal)) return null;
    return rateCore(curve, signal);
  }

  /** Ceiling in Mb/s from WAN port / ONT port / negotiated link (smallest given), Infinity when none is known. */
  function linkLimit(opts) {
    const o = opts || {};
    return Math.min(isNum(o.wanPort) ? o.wanPort : Infinity, isNum(o.ontPort) ? o.ontPort : Infinity, isNum(o.wanLink) ? o.wanLink : Infinity);
  }

  /**
   * Expected speed at a signal level after the internet plan / cable ceilings and the planning reserve (router only;
   * predictVia() is the same with a second node's link and tells what binds).
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

  /** Normalize raw limits {wanDown,wanUp,wanPort,ontPort,wanLink,reserve} into predict()'s argument. Idempotent. */
  function toLimits(limits) {
    const l = limits || {};
    return { wanDown: l.wanDown, wanUp: l.wanUp, reserve: l.reserve, linkLimit: isNum(l.linkLimit) ? l.linkLimit : linkLimit(l) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // second node (SPEC 10): the node's uplink and the one speed rule shared by map, tooltip, summary, optimizer, what-if
  // ---------------------------------------------------------------------------------------------------------------

  /** Share of the Wi-Fi rate of the plan / link ceiling from which the internet plan, not the Wi-Fi, is the limit. */
  const PLAN_NEAR = 0.85;
  /** Uplink throughput factor of the wireless node kinds: a repeater relays on the same radio (half-duplex). */
  const BACKHAUL_FACTOR = Object.freeze({ mesh_wifi: 0.6, repeater: 0.5 });
  /** fieldSpeed().limitedBy codes -> names (0 = the Wi-Fi signal itself). */
  const LIMIT_KINDS = Object.freeze([null, 'plan', 'link', 'backhaul', 'device']);
  const LIMIT_CODE = Object.freeze({ plan: 1, link: 2, backhaul: 3, device: 4 });

  /**
   * The binding ceiling of one direction. Hard caps bind when they are below the Wi-Fi rate (the smallest one; equal
   * ones in the order backhaul, device, link, plan). When none is below it, the plan / link still count as the limit
   * once the Wi-Fi gives PLAN_NEAR (85 %) of them - internet speed tests saturate just below the plan (homeSummary's rule).
   */
  function bind(wifi, backhaul, device, link, plan) {
    let v = wifi;
    let by = null;
    let cap = null;
    const take = (kind, c) => {
      if (isNum(c) && c >= 0 && c < v) {
        v = c;
        by = kind;
        cap = c;
      }
    };
    take('backhaul', backhaul);
    take('device', device);
    take('link', link);
    take('plan', plan);
    if (by === null) {
      const near = (kind, c) => {
        if (isNum(c) && c > 0 && wifi >= PLAN_NEAR * c && (cap === null || c < cap)) {
          by = kind;
          cap = c;
        }
      };
      near('link', link);
      near('plan', plan);
    }
    return { v, by, cap };
  }

  /** predictVia() on a rate already looked up; `l` = toLimits(...). null when the node's wireless link is unknown. */
  function viaCore(r, l, link) {
    let bhD = null;
    let bhU = null;
    let dev = null;
    if (link) {
      if (link.wireless) {
        if (!link.known) return null;
        bhD = link.down;
        bhU = link.up;
      }
      dev = link.maxMbps;
    }
    const lk = isNum(l.linkLimit) ? l.linkLimit : null;
    const d = bind(r.down, bhD, dev, lk, l.wanDown);
    const u = bind(r.up, bhU, dev, lk, l.wanUp);
    const keep = 1 - clamp(isNum(l.reserve) ? l.reserve : 0, 0, 100) / 100;
    return { down: d.v * keep, up: u.v * keep, wifiDown: r.down, wifiUp: r.up, extrapolated: r.extrapolated, limitedBy: d.by, limitedByUp: u.by, capDown: d.cap, capUp: u.cap };
  }

  /**
   * THE speed rule (SPEC 10): the curve at `signal`, then the ceilings - the node's wireless uplink and its maxMbps when
   * `link` is given (the node serves this place), the WAN / ONT / negotiated link, the internet plan - then the reserve.
   * @param {object} curve buildCurve()
   * @param {number} signal dBm of the serving source (router or node)
   * @param {{wanDown?,wanUp?,wanPort?,ontPort?,wanLink?,linkLimit?,reserve?}} [limits] raw or toLimits()
   * @param {object|null} [link] nodeLink() when the node serves this place
   * @returns {{down:number, up:number, wifiDown:number, wifiUp:number, extrapolated:boolean,
   *   limitedBy:null|'plan'|'link'|'backhaul'|'device', limitedByUp:null|'plan'|'link'|'backhaul'|'device',
   *   capDown:number|null, capUp:number|null}|null} capX = the binding ceiling in Mb/s (before the reserve);
   *   null when the curve cannot say (no curve, weaker than the weakest test) or the node's wireless link is unknown
   */
  function predictVia(curve, signal, limits, link) {
    const r = rate(curve, signal);
    if (!r) return null;
    return viaCore(r, toLimits(limits), link || null);
  }

  /**
   * The ceilings of predictVia() applied to a rate you already have (e.g. a measured speed scaled by the curve - the
   * what-if anchors predictions to the user's own numbers): {down, up} in Mb/s -> the Via shape. `limits` as predictVia
   * (its reserve applies too). null when the node's wireless link is unknown.
   */
  function applyCeilings(r, limits, link) {
    if (!r || !isNum(r.down) || !isNum(r.up)) return null;
    return viaCore({ down: r.down, up: r.up, extrapolated: !!r.extrapolated }, toLimits(limits), link || null);
  }

  /** nodeLink() from an already known uplink signal (the optimizer traces it itself). */
  function linkFromSignal(node, sig, curve, backhaulCurve) {
    const wireless = model.isWirelessNode(node);
    const maxMbps = isNum(node.maxMbps) && node.maxMbps > 0 ? node.maxMbps : null;
    const out = {
      mode: node.mode,
      wireless,
      band: units.normBand(node.backhaulBand) || 5,
      signal: null,
      weak: false,
      factor: null,
      down: null,
      up: null,
      known: true,
      reason: null,
      approx: false,
      maxMbps,
      capDown: maxMbps,
      capUp: maxMbps,
    };
    if (!wireless) return out;
    out.factor = BACKHAUL_FACTOR[node.mode] || 0.5;
    out.signal = isNum(sig) ? sig : null;
    out.weak = out.signal !== null && isNum(node.backhaulThreshold) && out.signal < node.backhaulThreshold;
    let cb = validCurve(backhaulCurve) ? backhaulCurve : null;
    if (!cb && validCurve(curve)) {
      cb = curve;
      out.approx = units.normBand(curve.band) !== out.band;
    }
    if (!cb) {
      out.known = false;
      out.reason = 'curve';
      return out;
    }
    const r = out.signal === null ? null : rateCore(cb, out.signal);
    if (!r) {
      out.known = false;
      out.reason = 'weak';
      return out;
    }
    out.down = r.down * out.factor;
    out.up = r.up * out.factor;
    out.capDown = maxMbps === null ? out.down : Math.min(out.down, maxMbps);
    out.capUp = maxMbps === null ? out.up : Math.min(out.up, maxMbps);
    return out;
  }

  /**
   * The second node's uplink to the router (SPEC 10). Wireless mesh / repeater: the backhaul signal router -> node on
   * node.backhaulBand (softened like the map, calibrated: model.backhaulSignal) through the curve x BACKHAUL_FACTOR.
   * Wired AP / mesh: no uplink cap. node.maxMbps is the device's own ceiling either way.
   * @param {object} ctx
   * @param {object} state model.fieldParams(project, 'trial', {offsets}) (router, node, offsets, soften)
   * @param {object|null} curve the client curve (buildCurve); used for the uplink when no backhaulCurve is given
   * @param {{backhaulCurve?:object|null}} [opts] a curve of the backhaul band
   * @returns {{mode:string, wireless:boolean, band:number, signal:number|null, weak:boolean, factor:number|null,
   *   down:number|null, up:number|null, known:boolean, reason:null|'curve'|'weak', approx:boolean, maxMbps:number|null,
   *   capDown:number|null, capUp:number|null}|null} null without a node. down/up = the uplink's Mb/s (null: wired, or
   *   unknown -> known:false); capX = min(uplink, maxMbps) = the node-side ceiling (null = none)
   */
  function nodeLink(ctx, state, curve, opts) {
    const node = state && state.node;
    if (!node || node.mode === 'none' || !node.pos || !isNum(node.pos.x) || !isNum(node.pos.y)) return null;
    let sig = null;
    if (model.isWirelessNode(node) && ctx && state.router && isNum(state.router.x) && isNum(state.router.y)) {
      const v = model.backhaulSignal(ctx, state);
      sig = isNum(v) ? v : null;
    }
    // a curves map (SPEC 13): the backhaul band's curve, else the nearest band's (flagged approx by linkFromSignal)
    let c = curve;
    if (!validCurve(curve) && isObj(curve)) {
      const pick = curveFor(curve, units.normBand(node.backhaulBand) || 5);
      c = pick ? pick.curve : null;
    }
    return linkFromSignal(node, sig, c, opts && opts.backhaulCurve);
  }

  /**
   * What the Speed map shows at one point (the tooltip): the stronger source at p, the curve, the node's link, the
   * ceilings and the reserve of `limits` - the same rule as fieldSpeed.
   * @param {object} ctx
   * @param {{x:number,y:number}} p normalized
   * @param {object} state model.fieldParams(project, 'trial', {offsets}) (band mode 'auto' too)
   * @param {object|null} curve one curve or a curves map {'2.4','5','6'} (SPEC 13: the curve of the band used at p,
   *        else the nearest band's - approx)
   * @param {object} [limits] as fieldSpeed (incl. reserve)
   * @param {{backhaulCurve?:object, link?:object|null}} [opts] link: a nodeLink() you already have
   * @returns {{known:boolean, down:number|null, up:number|null, limitedBy:string|null, limitedByUp:string|null,
   *   capDown:number|null, capUp:number|null, extrapolated:boolean, source:'router'|'node', signal:number|null,
   *   link:object|null, band:number|null, curveBand:number|null, approx:boolean,
   *   reason:null|'params'|'curve'|'weak'|'backhaul'}} band = the band of the signal (in Auto: the steered band),
   *   curveBand = the band of the curve used (approx when it differs)
   */
  function pointSpeed(ctx, p, state, curve, limits, opts) {
    const o = opts || {};
    const out = { known: false, down: null, up: null, limitedBy: null, limitedByUp: null, capDown: null, capUp: null, extrapolated: false, source: 'router', signal: null, link: null, band: null, curveBand: null, approx: false, reason: null };
    if (!ctx || !p || !isNum(p.x) || !isNum(p.y) || !state || !state.router || units.normBandMode(state.band) === null) {
      out.reason = 'params';
      return out;
    }
    const d = model.pointSignalDetail(ctx, p, state);
    out.signal = d.combined;
    out.source = d.bestSource;
    out.band = d.band;
    if (d.bestSource === 'node') out.link = o.link !== undefined ? o.link : nodeLink(ctx, state, curve, o);
    const cf = curveFor(curve, d.band);
    if (!cf) {
      out.reason = 'curve';
      return out;
    }
    out.curveBand = cf.band;
    out.approx = cf.approx;
    const r = rateCore(cf.curve, d.combined);
    if (!r) {
      out.reason = 'weak';
      return out;
    }
    const v = viaCore(r, toLimits(limits), out.link);
    if (!v) {
      out.reason = 'backhaul';
      out.limitedBy = 'backhaul';
      out.limitedByUp = 'backhaul';
      return out;
    }
    out.known = true;
    out.down = v.down;
    out.up = v.up;
    out.limitedBy = v.limitedBy;
    out.limitedByUp = v.limitedByUp;
    out.capDown = v.capDown;
    out.capUp = v.capUp;
    out.extrapolated = v.extrapolated;
    return out;
  }

  /**
   * Predicted speed for every grid cell - router-served cells through the curve, node-served cells (the second node is
   * the stronger source: the field's nodeWins) through the node's link as well (SPEC 10). Never throws on odd input.
   * @param {object} ctx
   * @param {object} g raster.grid()
   * @param {object} params raster.field() params (band, router, node, offsets, soften, aa; band mode 'auto' too)
   * @param {object|null} curve buildCurve(), or a curves map {'2.4','5','6'} (buildCurves): every cell uses the curve
   *   of its band (in Auto: the steered band), else the nearest band's (SPEC 13, flagged in `approx`)
   * @param {{wanDown?,wanUp?,wanPort?,ontPort?,wanLink?,reserve?}} [limits]
   * @param {Float32Array} [signalField] the signal field of `params` (a.trial) to reuse
   * @param {{nodeWins?:Uint8Array, bands?:Uint8Array, backhaulCurve?:object|null}} [opts] nodeWins / bands of that
   *   field (default: what raster.fieldEx remembered for the array, else recomputed); backhaulCurve as nodeLink
   * @returns {{down:Float32Array, up:Float32Array, known:Uint8Array, limitedBy:Uint8Array, source:Uint8Array|null,
   *   link:object|null, signal:Float32Array|null, bands:Uint8Array|null, approx:Uint8Array|null, approxAny:boolean,
   *   supported:boolean, reason:null|'curve'|'params'}}
   *   known[i]=1 where the speed is known; down/up in Mb/s after the ceilings and the reserve (0 where unknown);
   *   limitedBy[i] = index into LIMIT_KINDS (3 also on node cells whose wireless link is unknown); source = nodeWins
   *   (1 = the node serves the cell; null without an active node); link = nodeLink() (also without a curve);
   *   signal = the signal field used (read-only); bands = the band of every cell in Auto (raster.fieldEx), else null;
   *   approx[i] = 1 where a curve of another band stood in (null when nowhere)
   */
  function fieldSpeed(ctx, g, params, curve, limits, signalField, opts) {
    const o = opts || {};
    const n = g && isNum(g.cols) && isNum(g.rows) && g.idx ? g.cols * g.rows : 0;
    const out = { down: new Float32Array(n), up: new Float32Array(n), known: new Uint8Array(n), limitedBy: new Uint8Array(n), source: null, link: null, signal: null, bands: null, approx: null, approxAny: false, supported: true, reason: null };
    const auto = !!params && model.isAuto(params);
    const band = !params ? null : auto ? 'auto' : units.normBand(params.band !== undefined ? params.band : params.targetBand);
    if (!n || !ctx || !params || !params.router || !isNum(params.router.x) || !isNum(params.router.y) || band === null) {
      out.supported = false;
      out.reason = 'params';
      return out;
    }
    const nodeOn = nodeOnFor(params);
    if (nodeOn) out.link = nodeLink(ctx, params, curve, o);
    const tbl = curveTable(curve, params);
    if (!tbl.some(Boolean)) {
      out.supported = false;
      out.reason = 'curve';
      return out;
    }
    let sig = signalField && signalField.length === n ? signalField : null;
    let wins = null;
    let bands = null;
    if (nodeOn || auto) {
      if (nodeOn) wins = o.nodeWins && o.nodeWins.length === n ? o.nodeWins : sig ? E.raster.nodeWinsOf(sig, params) : null;
      if (auto) bands = o.bands && o.bands.length === n ? o.bands : sig ? E.raster.bandsOf(sig, params) : null;
      if (!sig || (nodeOn && !wins) || (auto && !bands)) {
        const fx = E.raster.fieldEx(ctx, g, params);
        if (!sig) sig = fx.field;
        if (nodeOn && !wins) wins = fx.nodeWins;
        if (auto && !bands) bands = fx.bands;
      }
    } else if (!sig) sig = E.raster.field(ctx, g, { ...params, node: null });
    out.signal = sig;
    out.source = wins || null;
    out.bands = bands || null;
    const approx = tbl.some((c) => c && c.approx) ? new Uint8Array(n) : null;
    const lim = toLimits(limits);
    const link = out.link;
    const idx = g.idx;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const cf = tbl[bands ? bands[i] : 0];
      if (!cf) continue;
      const r = rateCore(cf.curve, sig[i]);
      if (!r) continue;
      if (approx && cf.approx) {
        approx[i] = 1;
        out.approxAny = true;
      }
      const v = viaCore(r, lim, wins && wins[i] === 1 ? link : null);
      if (!v) {
        out.limitedBy[i] = LIMIT_CODE.backhaul;
        continue;
      }
      out.known[i] = 1;
      out.down[i] = v.down;
      out.up[i] = v.up;
      out.limitedBy[i] = v.limitedBy ? LIMIT_CODE[v.limitedBy] : 0;
    }
    out.approx = out.approxAny ? approx : null;
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

  /**
   * "Propustnost bytu" (SPEC 9): what the whole home gets - share of the floor that meets the speed target, median
   * download / upload per room, the weakest spot and room, and whether the internet plan (or the WAN / ONT / link
   * ceiling) rather than the Wi-Fi limits the speed. Uses the (calibrated / fitted) signal field of `params`; with a
   * second node its served area goes through the node's link (SPEC 10, the same rule as fieldSpeed). Never throws.
   * @param {object} ctx
   * @param {object} g raster.grid()
   * @param {object} params raster.field() params - usually model.fieldParams(project, 'today'|'trial', {offsets})
   * @param {object|null} curve buildCurve() (from fillSignals(...) so speed-only points count), or a curves map
   *   (buildCurves; SPEC 13: every cell uses its band's curve, else the nearest band's)
   * @param {{wanDown?,wanUp?,wanPort?,ontPort?,wanLink?,reserve?}} [limits] as fieldSpeed
   * @param {{targetDown:number, targetUp:number, roomIds?:number[]|null, excluded?:number[]}} target
   *        roomIds null/omitted = the whole home minus `excluded`
   * @param {Float32Array} [signalField] the signal field of params if you already have it (a.today / a.trial)
   * @param {{nodeWins?:Uint8Array, backhaulCurve?:object|null}} [opts] as fieldSpeed
   * @returns {{supported:boolean, reason:null|'curve'|'params', areaMeetingTarget:number, known:number,
   *   medianDown:number|null, medianUp:number|null, p10Down:number|null, p10Up:number|null,
   *   perRoom:Array<{roomId:number, medianDown:number|null, medianUp:number|null, meets:number, known:number, n:number}>,
   *   weakest:{roomId:number, x:number, y:number, signal:number, down:number|null, up:number|null}|null,
   *   weakestRoom:{roomId:number, medianDown:number|null, medianUp:number|null, meets:number}|null,
   *   limitedByPlan:boolean, planLimitedShare:number, planCap:{down:number|null, up:number|null},
   *   limitedShare:{plan:number, link:number, backhaul:number, device:number}, nodeShare:number, link:object|null,
   *   bandShare:{'2.4':number,'5':number,'6':number}|null, approxShare:number, target:{down:number, up:number}}}
   *   Percentages (areaMeetingTarget = cells meeting BOTH targets, known, meets, planLimitedShare) are of the selected
   *   floor area. A median is null when more than half of the area is weaker than the weakest speed test (unknown).
   *   weakest = the floor cell with the weakest signal (its down/up null when unknown); weakestRoom = lowest median
   *   download (unknown counts as lowest). planLimitedShare = % of the area where the Wi-Fi alone would give at least
   *   85 % of the plan / link ceiling in some direction; limitedByPlan = that holds for at least half of the area whose
   *   speed is known (where the curve says nothing the Wi-Fi is too weak to tell); on node-served cells "the Wi-Fi
   *   alone" includes the node's link and ceiling. limitedShare = % of the area whose download is bound by that
   *   ceiling (fieldSpeed's limitedBy), nodeShare = % of the area the second node serves, link = nodeLink().
   *   Band mode Auto (SPEC 13): bandShare = % of the area on each band (null for one band), approxShare = % of the area
   *   whose speed came from a curve of another band.
   */
  function homeSummary(ctx, g, params, curve, limits, target, signalField, opts) {
    const t = target || {};
    const td = isNum(t.targetDown) && t.targetDown > 0 ? t.targetDown : 50;
    const tu = isNum(t.targetUp) && t.targetUp > 0 ? t.targetUp : 50;
    const ex = t.excluded && t.excluded.length ? new Set(t.excluded) : null;
    const okGrid = !!(g && Array.isArray(g.roomIds) && g.roomCells && g.idx);
    const ids = !okGrid ? [] : t.roomIds === null || t.roomIds === undefined ? g.roomIds.filter((id) => !ex || !ex.has(id)) : [].concat(t.roomIds).filter((id) => g.roomCells.has(id));
    const lim = toLimits(limits);
    const capDown = Math.min(isNum(lim.wanDown) ? lim.wanDown : Infinity, lim.linkLimit);
    const capUp = Math.min(isNum(lim.wanUp) ? lim.wanUp : Infinity, lim.linkLimit);
    const planCap = { down: Number.isFinite(capDown) ? capDown : null, up: Number.isFinite(capUp) ? capUp : null };
    const base = {
      supported: false,
      reason: null,
      areaMeetingTarget: 0,
      known: 0,
      medianDown: null,
      medianUp: null,
      p10Down: null,
      p10Up: null,
      perRoom: [],
      weakest: null,
      weakestRoom: null,
      limitedByPlan: false,
      planLimitedShare: 0,
      planCap,
      limitedShare: { plan: 0, link: 0, backhaul: 0, device: 0 },
      nodeShare: 0,
      link: null,
      bandShare: null,
      approxShare: 0,
      target: { down: td, up: tu },
    };
    if (!okGrid) return { ...base, reason: 'params' };
    const sf = fieldSpeed(ctx, g, params, curve, limits, signalField, opts);
    base.link = sf.link;
    if (!sf.supported) return { ...base, reason: sf.reason };
    const sig = sf.signal;
    const wins = sf.source;
    const link = sf.link;
    const tbl = curveTable(curve, params);
    const bandsArr = sf.bands;
    let approxCells = 0;
    const all = stats(g, sf, { roomIds: ids, targetDown: td, targetUp: tu });
    const perRoom = ids
      .slice()
      .sort((a, b) => a - b)
      .map((id) => {
        const s = stats(g, sf, { roomIds: [id], targetDown: td, targetUp: tu });
        return { roomId: id, medianDown: s.medianDown, medianUp: s.medianUp, meets: s.coverage, known: s.known, n: s.n };
      })
      .filter((r) => r.n > 0);
    // the weakest spot (lowest signal) and the share of the area where the plan, not the Wi-Fi, is the bottleneck
    let weakest = null;
    let cells = 0;
    let knownCells = 0;
    let planLimited = 0;
    let nodeCells = 0;
    const bound = [0, 0, 0, 0, 0];
    for (const id of ids) {
      const list = g.roomCells.get(id);
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const s = sig[i];
        if (!Number.isFinite(s)) continue;
        cells++;
        if (!weakest || s < weakest.signal) weakest = { i, signal: s };
        if (sf.known[i]) knownCells++;
        bound[sf.limitedBy[i]]++;
        const viaNode = !!(wins && wins[i] === 1);
        if (viaNode) nodeCells++;
        if (sf.approx && sf.approx[i]) approxCells++;
        if (sf.known[i] && (planCap.down !== null || planCap.up !== null)) {
          // the Wi-Fi alone (incl. the node's link and ceiling where the node serves): no plan / link / reserve
          const cf = tbl[bandsArr ? bandsArr[i] : 0];
          const raw = cf ? rateCore(cf.curve, s) : null;
          const r = raw && viaCore(raw, {}, viaNode ? link : null);
          if (r && ((planCap.down !== null && r.down >= PLAN_NEAR * planCap.down) || (planCap.up !== null && r.up >= PLAN_NEAR * planCap.up))) planLimited++;
        }
      }
    }
    const rank = (v) => (v === null ? -1 : v);
    const wr = perRoom.slice().sort((a, b) => rank(a.medianDown) - rank(b.medianDown) || a.meets - b.meets || a.roomId - b.roomId)[0] || null;
    const share = cells ? (100 * planLimited) / cells : 0;
    const pct = (k) => (cells ? (100 * k) / cells : 0);
    return {
      ...base,
      supported: true,
      areaMeetingTarget: all.coverage,
      known: all.known,
      medianDown: all.medianDown,
      medianUp: all.medianUp,
      p10Down: all.p10Down,
      p10Up: all.p10Up,
      perRoom,
      weakest: weakest
        ? {
            roomId: g.room[weakest.i],
            x: round(g.cx[weakest.i], 6),
            y: round(g.cy[weakest.i], 6),
            signal: weakest.signal,
            down: sf.known[weakest.i] ? sf.down[weakest.i] : null,
            up: sf.known[weakest.i] ? sf.up[weakest.i] : null,
          }
        : null,
      weakestRoom: wr ? { roomId: wr.roomId, medianDown: wr.medianDown, medianUp: wr.medianUp, meets: wr.meets } : null,
      limitedByPlan: knownCells > 0 && planLimited >= 0.5 * knownCells,
      planLimitedShare: share,
      limitedShare: { plan: pct(bound[1]), link: pct(bound[2]), backhaul: pct(bound[3]), device: pct(bound[4]) },
      nodeShare: pct(nodeCells),
      bandShare: bandsArr ? E.raster.bandShare(g, bandsArr, ids) : null,
      approxShare: pct(approxCells),
    };
  }

  E.speed = {
    validRate,
    validCurve,
    monotoneSpeed,
    fillSignals,
    diagnose,
    buildCurve,
    buildCurves,
    curveFor,
    rate,
    predict,
    predictVia,
    applyCeilings,
    linkLimit,
    toLimits,
    nodeLink,
    linkFromSignal,
    pointSpeed,
    fieldSpeed,
    ratioField,
    stats,
    scoreRatios,
    homeSummary,
    PLAN_NEAR,
    BACKHAUL_FACTOR,
    LIMIT_KINDS,
    CURVE_ORDER,
  };
})();
