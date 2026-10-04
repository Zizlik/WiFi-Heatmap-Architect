/* WiFi Heatmap Architect - engine.project: data model, validation, file formats, floor helpers.
 *
 * Project (v3), see SPEC section 3.1:
 *   { v:3, name, plan:{rooms,walls,doors,furniture,background}, scale:{mpp,verified,method,ref}, net, nodes, model, goal,
 *     measurements, view, floors }
 * SPEC 14: the ACTIVE floor's plan / nodes / measurements / goal.room / goal.excluded are the top level; every other floor
 * keeps its own inside floors[] (the active entry holds null there) - use the floor helpers (switchFloor, floorOf, atFloor ...).
 * All coordinates are normalized {x,y} over the fixed 1080 x 942 canvas.
 *
 * File formats:
 *   - SVG with <metadata id="wifi-plan-data"> holding JSON {format:'wifi-floor-v2', plan, width, router, original,
 *     optic [, app, v:3, project:{...}]}. The legacy keys stay so the OLD app can still open files written here.
 *   - raw v3 project objects (localStorage 'wifi-heatmap-v3').
 *   - legacy localStorage keys (wifi-floor-v5, wifi-floor-network-v1, wifi-speed-v1, wifi-flow-v1) via migrateLegacyStorage.
 *
 * Errors thrown are Error objects whose `message` (and `.code`) is an i18n key such as 'err.plan.invalid'; translate
 * with WH.i18n.t(err.message). The strings are registered by 99-strings.js.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const geom = E.geom;
  const { isNum, isObj, clamp, round, num, numOrNull, cleanText, fail } = E.util;
  const units = E.units;

  const SCHEMA_VERSION = 3;
  const MAX_ITEMS = 250;
  const MAX_MEASUREMENTS = 500;
  const MAX_BACKGROUND_CHARS = 7000000;
  const MAX_SVG_CHARS = 8000000;
  const POINT_TOLERANCE = 0.001; // accepted slack outside [0,1] before a point is "off the map"

  // Obstacle losses depend on the band (SPEC 7.1): every loss STORED in a plan (wall.loss, door.loss, furniture.loss,
  // model.wallLoss) is the 5 GHz reference value. Presets are per-band tables; everything else is scaled by BAND_FACTOR.
  // Sources: NIST 1997 building penetration measurements (brick 6/15/15, 102 mm concrete 15/22/25 dB at 2.4/5/6 GHz),
  // published penetration tables (gypsum 2-4/4-6/6-8, glass 1-3/3-5/5-7, wood 3-6/6-10/8-12, brick 8-12/12-18/15-22,
  // concrete 15-25/25-35/30-40 dB), OSTI 1813145 (drywall 3-4/3-5, brick/concrete 6-18/10-30, glass 2-3/6-8 dB).
  const bandRow = (a, b, c) => Object.freeze({ '2.4': a, '5': b, '6': c });
  /** Multiplier of a stored (5 GHz reference) loss per band. */
  const BAND_FACTOR = bandRow(0.65, 1, 1.15);
  /** Wall material presets: dB at 2.4 / 5 / 6 GHz (ordered from light to heavy). */
  const MATERIALS = Object.freeze({
    drywall: bandRow(3, 4, 5),
    wood: bandRow(3, 5, 6),
    glass: bandRow(2, 4, 5),
    brick: bandRow(7, 11, 13),
    masonry: bandRow(7, 11, 13),
    solid_guess: bandRow(10, 15, 18),
    concrete: bandRow(12, 18, 21),
    reinforced_concrete: bandRow(17, 26, 30),
    metal: bandRow(25, 30, 32),
  });
  /** Wall presets as the number stored in wall.loss (= the 5 GHz column of MATERIALS). */
  const WALL_MATERIALS = Object.freeze(Object.fromEntries(Object.keys(MATERIALS).map((k) => [k, MATERIALS[k]['5']])));
  /** The OLD app's single-number presets: a wall that still carries one of these is that preset (SPEC 7.1). */
  const LEGACY_WALL_MATERIALS = Object.freeze({ drywall: 3, brick: 8, concrete: 12, reinforced_concrete: 18, glass: 3, wood: 3, metal: 25, masonry: 8, solid_guess: 12 });
  const MATERIAL_KEYS = Object.freeze([...Object.keys(WALL_MATERIALS), 'custom']);
  /** Furniture presets as the number stored in furniture.loss (5 GHz; `custom` = default for a new custom piece). */
  const FURNITURE_KINDS = Object.freeze({ custom: 3, bed: 1, wood: 3, books: 5, appliance: 8, metal: 12 });
  /** Furniture presets per band (dB at 2.4 / 5 / 6 GHz); custom pieces scale their stored loss by BAND_FACTOR. */
  const FURNITURE_BANDS = Object.freeze({ bed: bandRow(1, 1, 1), wood: bandRow(2, 3, 4), books: bandRow(3, 5, 6), appliance: bandRow(6, 8, 9), metal: bandRow(10, 12, 13), custom: null });
  const BAND_POWER_MIN = -10;
  const BAND_POWER_MAX = 6;
  const WAN_RATES = Object.freeze([100, 1000, 2500, 5000, 10000]);
  const CABLE_CATEGORIES = Object.freeze(['unknown', 'cat5', 'cat5e', 'cat6', 'cat6a', 'cat7', 'cat8']);
  const NODE_MODES = Object.freeze(['none', 'ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater']);
  /** node.maxMbps range (SPEC 10): the second node's real ceiling in Mb/s, null = not known. */
  const NODE_MBPS_MIN = 10;
  const NODE_MBPS_MAX = 10000;
  /** Band steering (SPEC 13): model.steer thresholds in dBm and their defaults (6 GHz from -70, 5 GHz from -72). */
  const STEER_MIN = -90;
  const STEER_MAX = -50;
  const STEER_DEFAULT = Object.freeze({ six: -70, five: -72 });
  /** net.routerBands default: the bands a typical router sends (Wi-Fi 6E / 7 users tick 6 GHz). */
  const ROUTER_BANDS_DEFAULT = Object.freeze({ '2.4': true, '5': true, '6': false });
  /** Wi-Fi channel widths (MHz) a link may report. */
  const WIDTHS = Object.freeze([20, 40, 80, 160, 320]);
  /** At most this many Wi-Fi 7 multi-link (MLO) links are kept per measurement. */
  const MAX_LINKS = 4;
  // ---- SPEC 14: many nodes, floors, verified scale --------------------------------------------------------------
  /** At most this many access points / mesh nodes / repeaters in the whole building (besides the router). */
  const MAX_NODES = 8;
  /** Node kinds (SPEC 14.2); NODE_MODES keeps 'none' for older code that still asks "is there a node?". */
  const NODE_KINDS = Object.freeze(['ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater']);
  /** Default bands of a new / migrated node. */
  const NODE_BANDS_DEFAULT = Object.freeze({ '2.4': true, '5': true, '6': false });
  /** Floors: at most 9 (keyboard Alt+1..9), levels -3 (basements) .. 20, 0 = the ground floor. */
  const MAX_FLOORS = 9;
  const LEVEL_MIN = -3;
  const LEVEL_MAX = 20;
  /** Ceiling (the slab above a floor) presets in dB at 5 GHz (the band factors apply like for walls). */
  const CEILING_MATERIALS = Object.freeze({ concrete: 15, reinforced_concrete: 20, wood: 8 });
  const CEILING_KEYS = Object.freeze([...Object.keys(CEILING_MATERIALS), 'custom']);
  const CEILING_DEFAULT = Object.freeze({ material: 'concrete', lossDb: 15, heightM: 2.7 });
  /** How a scale was obtained (SPEC 14.1). */
  const SCALE_METHODS = Object.freeze(['two-points', 'area', 'width', 'import', 'default']);
  /** Sanity limits of SPEC 14.1 (m² / m): a flat of 15..400 m², rooms of 1.5..80 m², doors 0.6..1.6 m wide. */
  const SCALE_LIMITS = Object.freeze({ areaMin: 15, areaMax: 400, roomMin: 1.5, roomMax: 80, doorMin: 0.6, doorMax: 1.6 });
  const MPP_MIN = 0.0005;
  const MPP_MAX = 0.2;
  const LAYERS = Object.freeze(['signal', 'speed', 'diff']);
  const PALETTES = Object.freeze(['default', 'cb']);
  const ROOM_COLORS = Object.freeze(['#8eadd2', '#deb879', '#9e9ccb', '#97bbad', '#d79a9a', '#a8c686', '#c8a2c8', '#e6c27a']);

  const BG_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const SVG_BG_RE = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const DTD_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
  // The metadata block is located in LINEAR time (a single /<metadata\b[^>]*?\bid=...>([\s\S]*?)<\/metadata>/ regex
  // backtracks quadratically on hostile files: 800 kB of "<metadata " took 33 s, 8 MB would freeze the tab):
  // opening tags are matched with an attribute run that cannot cross the next "<" (so every character is scanned by at
  // most one attempt), the id is checked inside that bounded run, the closing tag is searched once.
  const META_OPEN_RE = /<metadata\b([^<>]{0,1000})>/gi;
  const META_ID_RE = /(?:^|\s)id\s*=\s*(["'])wifi-plan-data\1/i;
  const META_CLOSE_RE = /<\/metadata\s*>/gi;

  const t = (key, lang, params) => E.text.t(key, lang, params);

  // ---------------------------------------------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------------------------------------------

  /** Build a clean point {x,y} clamped into [0,1] and rounded to 6 decimals, or null when not finite. */
  function softPoint(p) {
    if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) return null;
    return { x: round(clamp(p.x, 0, 1)), y: round(clamp(p.y, 0, 1)) };
  }

  // ---- optional measurement extras (SPEC 8) and the calibration fit (SPEC 9) ----------------------------------------
  const CONN_TYPES = Object.freeze(['wifi', 'ethernet', 'cellular', 'bluetooth', 'wimax', 'other', 'none', 'unknown', 'mixed']);
  const FIT_METHODS = Object.freeze(['offset', 'offset+n+walls']);
  const MAC_RE = /^[0-9a-f]{2}(?:[:-]?[0-9a-f]{2}){5}$/i;
  const SIG_RE = /^[0-9a-z]{1,32}$/;
  const textOrNull = (v, max) => cleanText(v, max) || null;

  /** 'aa:bb:cc:dd:ee:ff' (lower case) from "AA-BB-CC-DD-EE-FF", "aabbccddeeff", ...; null otherwise. */
  function macOf(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!MAC_RE.test(s)) return null;
    const hex = s.replace(/[:-]/g, '').toLowerCase();
    return hex.match(/../g).join(':');
  }

  /**
   * Wi-Fi 7 multi-link (MLO) links of a measurement (SPEC 13): [{band, channel, rssiDbm, widthMHz}] (each field null
   * when unknown; links without any known field are dropped), strongest first (unknown signal last, input order kept
   * on ties), at most MAX_LINKS; null when nothing is left.
   */
  function cleanLinks(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const l of list.slice(0, 16)) {
      if (!isObj(l)) continue;
      const e = {
        band: units.normBand(l.band),
        channel: Number.isInteger(l.channel) && l.channel >= 1 && l.channel <= 233 ? l.channel : null,
        rssiDbm: isNum(l.rssiDbm) ? round(clamp(l.rssiDbm, -110, -20), 2) : null,
        widthMHz: WIDTHS.includes(l.widthMHz) ? l.widthMHz : null,
      };
      if (e.band !== null || e.channel !== null || e.rssiDbm !== null) out.push(e);
    }
    const rank = (e) => (e.rssiDbm === null ? -Infinity : e.rssiDbm);
    const sorted = out.map((e, i) => ({ e, i })).sort((a, b) => rank(b.e) - rank(a.e) || a.i - b.i).map((x) => x.e);
    return sorted.length ? sorted.slice(0, MAX_LINKS) : null;
  }

  /**
   * Measurement.wifi = {ssid<=64, bssid, channel, band, rxRate, txRate, radio, security} (every field null when
   * unknown) + optional links (Wi-Fi 7 MLO, SPEC 13; only when known), or null when nothing usable is left. Rates in
   * Mb/s (0..100000).
   */
  function cleanWifi(w) {
    if (!isObj(w)) return null;
    const out = {
      ssid: textOrNull(w.ssid, 64),
      bssid: macOf(w.bssid),
      channel: Number.isInteger(w.channel) && w.channel >= 1 && w.channel <= 233 ? w.channel : null,
      band: units.normBand(w.band),
      rxRate: numOrNull(w.rxRate, 0, 100000),
      txRate: numOrNull(w.txRate, 0, 100000),
      radio: textOrNull(w.radio, 24),
      security: textOrNull(w.security, 40),
    };
    const links = cleanLinks(w.links);
    if (links) out.links = links;
    return Object.values(out).some((v) => v !== null) ? out : null;
  }

  /** Measurement.deviceInfo = {os<=40, model<=50, browser<=40, connType: CONN_TYPES|null}, or null when empty. */
  function cleanDeviceInfo(d) {
    if (!isObj(d)) return null;
    const out = {
      os: textOrNull(d.os, 40),
      model: textOrNull(d.model, 50),
      browser: textOrNull(d.browser, 40),
      connType: typeof d.connType === 'string' && CONN_TYPES.includes(d.connType) ? d.connType : null,
    };
    return Object.values(out).some((v) => v !== null) ? out : null;
  }

  /** {rms, looRms|null} (+ offset) of a fit's "before" / per-band numbers. */
  const rmsOrNull = (v) => numOrNull(v, 0, 100);

  /**
   * project.model.fit (SPEC 9), see model.fitProject: {n 1.6..4, wallFactor 0.5..2, method, count, at, fitted:{n,wallFactor},
   * sig?, byBand:{'2.4'|'5'|'6': {offset -40..40, rms, looRms|null, count, outliers:id[], n?, before?:{offset,rms,looRms}}}}.
   * null when n / wallFactor are missing (the fit is then dropped as a whole).
   */
  function cleanFit(f) {
    if (!isObj(f) || !isNum(f.n) || !isNum(f.wallFactor)) return null;
    const byBand = {};
    const sb = isObj(f.byBand) ? f.byBand : {};
    for (const k of ['2.4', '5', '6']) {
      const b = sb[k];
      if (!isObj(b) || !isNum(b.offset)) continue;
      const e = {
        offset: num(b.offset, -40, 40, 0),
        rms: num(b.rms, 0, 100, 0),
        looRms: rmsOrNull(b.looRms),
        count: Number.isInteger(b.count) ? clamp(b.count, 0, MAX_MEASUREMENTS) : 0,
        outliers: Array.isArray(b.outliers)
          ? b.outliers
              .slice(0, MAX_MEASUREMENTS)
              .filter((id) => typeof id === 'string' || typeof id === 'number')
              .map((id) => cleanText(String(id), 80))
              .filter(Boolean)
          : [],
      };
      if (isNum(b.n)) e.n = num(b.n, 1.6, 4, 2.2);
      if (isObj(b.before) && isNum(b.before.offset)) e.before = { offset: num(b.before.offset, -40, 40, 0), rms: num(b.before.rms, 0, 100, 0), looRms: rmsOrNull(b.before.looRms) };
      byBand[k] = e;
    }
    const fitted = isObj(f.fitted) ? f.fitted : {};
    const out = {
      n: num(f.n, 1.6, 4, 2.2),
      wallFactor: num(f.wallFactor, 0.5, 2, 1),
      method: FIT_METHODS.includes(f.method) ? f.method : 'offset',
      count: Number.isInteger(f.count) ? clamp(f.count, 0, MAX_MEASUREMENTS) : 0,
      at: isNum(f.at) && f.at >= 0 ? Math.floor(f.at) : 0,
      fitted: { n: fitted.n === true, wallFactor: fitted.wallFactor === true },
      byBand,
    };
    if (typeof f.sig === 'string' && SIG_RE.test(f.sig)) out.sig = f.sig;
    return out;
  }

  /** All ids used in a plan (rooms, walls, doors, furniture). */
  function planIds(plan) {
    const s = new Set();
    for (const k of ['rooms', 'walls', 'doors', 'furniture']) for (const o of plan[k] || []) if (o && o.id !== undefined) s.add(o.id);
    return s;
  }

  /** First free id `${prefix}-${n}` that is not in `used`. Does not add it. */
  function freeId(prefix, used) {
    let n = 1;
    while (used.has(`${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  }

  /** nextId(plan, 'wall') -> 'wall-12' : an id unused anywhere in the plan. */
  function nextId(plan, prefix) {
    return freeId(prefix, planIds(plan));
  }

  /** Smallest unused integer room number 1..250, or null when all are taken. */
  function nextRoomId(plan) {
    const used = new Set((plan.rooms || []).map((r) => r.roomId));
    for (let i = 1; i <= MAX_ITEMS; i++) if (!used.has(i)) return i;
    return null;
  }

  /** Index of the room with that numeric roomId in plan.rooms, or -1. */
  function roomIndexOf(plan, roomId) {
    return (plan.rooms || []).findIndex((r) => r.roomId === roomId);
  }

  /** Bounding box (normalized) of all room polygons, or null for a plan without rooms. */
  function roomsBBox(plan) {
    let bb = null;
    for (const r of plan.rooms || []) {
      const b = geom.bbox(r.points);
      if (!b) continue;
      if (!bb) bb = { ...b };
      else {
        bb.minX = Math.min(bb.minX, b.minX);
        bb.minY = Math.min(bb.minY, b.minY);
        bb.maxX = Math.max(bb.maxX, b.maxX);
        bb.maxY = Math.max(bb.maxY, b.maxY);
      }
    }
    return bb;
  }

  /**
   * Bounds (normalized) of the plan: rooms, else every other geometry, else a default inset canvas.
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
   */
  function planBounds(plan) {
    const rb = roomsBBox(plan);
    if (rb) return rb;
    const pts = [];
    for (const f of plan.furniture || []) pts.push(...f.points);
    for (const w of plan.walls || []) pts.push(w.a, w.b);
    return geom.bbox(pts) || { minX: 0.05, minY: 0.05, maxX: 0.95, maxY: 0.95 };
  }

  /**
   * metres-per-pixel such that the bounding box of all rooms is `widthMeters` wide (the legacy "Skutecna sirka bytu").
   * Plans without rooms assume the room box would span 84 % of the canvas width.
   */
  function deriveMpp(plan, widthMeters) {
    const bb = roomsBBox(plan);
    const wNorm = bb && bb.maxX - bb.minX > 0.01 ? bb.maxX - bb.minX : 0.84;
    return Number(clamp(widthMeters / (wNorm * W), 0.0005, 0.2).toPrecision(10));
  }

  /** Real width in metres of the bounding box of all rooms for a given mpp (inverse of deriveMpp). */
  function widthFromMpp(plan, mpp) {
    const bb = roomsBBox(plan);
    const wNorm = bb && bb.maxX - bb.minX > 0.01 ? bb.maxX - bb.minX : 0.84;
    return wNorm * W * mpp;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // floor helpers (used by the UI to snap markers into rooms)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * The room containing normalized point p, or null. If rooms overlap the LAST one in plan.rooms wins (same rule as
   * the raster grid).
   */
  function roomAt(plan, p) {
    if (!plan || !plan.rooms || !p || !isNum(p.x) || !isNum(p.y)) return null;
    for (let i = plan.rooms.length - 1; i >= 0; i--) {
      const r = plan.rooms[i];
      if (r.points && r.points.length >= 3 && geom.pointInPolygon(p, r.points)) return r;
    }
    return null;
  }

  /** True when p lies on the floor (inside any room). */
  function floorMaskAt(plan, p) {
    return roomAt(plan, p) !== null;
  }

  /**
   * p if it is on the floor, else the nearest floor point (a hair inside the closest room outline).
   * Plans without rooms return p unchanged. Always returns a new object.
   */
  function nearestFloor(plan, p) {
    const src = p && isNum(p.x) && isNum(p.y) ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) } : { x: 0.5, y: 0.5 };
    if (!plan || !plan.rooms || !plan.rooms.length) return src;
    if (floorMaskAt(plan, src)) return src;
    let best = null;
    for (const r of plan.rooms) {
      const pts = r.points;
      if (!pts || pts.length < 3) continue;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const c = geom.closestOnSegment(src, a, b);
        if (!best || c.d < best.c.d) best = { c, a, b, room: r };
      }
    }
    if (!best) return src;
    const qx = best.c.x * W;
    const qy = best.c.y * H;
    const dx = (best.b.x - best.a.x) * W;
    const dy = (best.b.y - best.a.y) * H;
    const len = Math.hypot(dx, dy) || 1;
    const label = geom.labelPoint(best.room.points);
    const lx = label.x * W - qx;
    const ly = label.y * H - qy;
    const ll = Math.hypot(lx, ly) || 1;
    // try the two edge normals first, then the direction towards the visual centre of the room
    for (const eps of [2, 4, 8, 16]) {
      const dirs = [
        [-dy / len, dx / len],
        [dy / len, -dx / len],
        [lx / ll, ly / ll],
      ];
      for (const [ux, uy] of dirs) {
        const cand = { x: clamp((qx + ux * eps) / W, 0, 1), y: clamp((qy + uy * eps) / H, 0, 1) };
        if (floorMaskAt(plan, cand)) return cand;
      }
    }
    return label;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // defaults / create
  // ---------------------------------------------------------------------------------------------------------------

  function defaultDevice(lang) {
    return t('engine.device.default', lang);
  }

  /** Default slices of a project that do not depend on the plan. Fresh objects on every call. */
  function defaults(lang) {
    return {
      scale: { mpp: 0.012, verified: false, method: 'default', ref: null },
      net: {
        router: { x: 0.5, y: 0.5 },
        baseline: { x: 0.5, y: 0.5 },
        optic: { x: 0.1, y: 0.5 },
        wanDown: null,
        wanUp: null,
        wanPort: null,
        ontPort: null,
        wanLink: null,
        cableCategory: 'unknown',
        cableLength: null,
        routerBands: { ...ROUTER_BANDS_DEFAULT },
      },
      // access points / mesh nodes / repeaters of the active floor (SPEC 14.2; replaces the single `node`)
      nodes: [],
      model: { nearSignal: -40, n: 2.2, wallLoss: 8, threshold: -67, rangeThreshold: -60, bandPower: { '2.4': 0, '5': 0, '6': 0 }, steer: { ...STEER_DEFAULT } },
      goal: {
        room: 'all',
        allowedRoom: 'any',
        excluded: [],
        mode: 'signal',
        targetDown: 50,
        targetUp: 50,
        reserve: 30,
        device: defaultDevice(lang),
      },
      measurements: [],
      // band mode Auto (SPEC 13) by default: the default router sends two bands and clients steer between them
      view: { band: 'auto', layer: 'signal', ranges: false, walls: true, furniture: true, labels: true, values: false, points: true, whatif: true, sourceZones: true, calibrate: true, palette: 'default' },
    };
  }

  /**
   * New project from a template.
   * @param {{template?:'demo'|'house2'|'blank', lang?:'cs'|'en'}} [opts] 'house2' = the two-storey house (SPEC 14.3);
   *        an unknown template gives the demo flat
   * @returns {object} sanitized Project
   */
  function create(opts) {
    const o = opts || {};
    const lang = E.text.lang(o.lang);
    if (o.template === 'blank') {
      const d = defaults(lang);
      return sanitize({ v: SCHEMA_VERSION, name: t('engine.project.name', lang), plan: { rooms: [], walls: [], doors: [], furniture: [], background: null }, ...d }, { lang });
    }
    if (!E.demo || typeof E.demo.build !== 'function') throw fail('err.project.invalid');
    if (o.template === 'house2' && typeof E.demo.buildHouse2 === 'function') return sanitize(E.demo.buildHouse2(lang), { lang });
    return sanitize(E.demo.build(lang), { lang });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sanitize
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Validate + normalize one floor plan {rooms, walls, doors, furniture, background}. Ids are unique within the plan.
   * @param {object} planRaw
   * @param {{strict:boolean, lang:string, warn:(msg:string)=>void}} o
   * @returns {{plan:object, roomIds:Set<number>, svgBackground:string|null}}
   */
  function cleanPlan(planRaw, o) {
    const strict = o.strict;
    const lang = o.lang;
    const warn = o.warn;
    if (!isObj(planRaw) || !Array.isArray(planRaw.rooms)) throw fail('err.plan.invalid');
    const plan = { rooms: [], walls: [], doors: [], furniture: [], background: null };
    const used = new Set();
    const pt = (p) => {
      if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) {
        if (strict) throw fail('err.plan.point');
        return null;
      }
      if (p.x < -POINT_TOLERANCE || p.x > 1 + POINT_TOLERANCE || p.y < -POINT_TOLERANCE || p.y > 1 + POINT_TOLERANCE) {
        if (strict) throw fail('err.plan.point');
        warn('point clamped');
      }
      return { x: round(clamp(p.x, 0, 1)), y: round(clamp(p.y, 0, 1)) };
    };
    const polygon = (rawPts) => {
      if (!Array.isArray(rawPts) || rawPts.length < 3 || rawPts.length > 200) {
        if (strict) throw fail('err.plan.polygon');
        return null;
      }
      const out = [];
      for (const q of rawPts) {
        const p = pt(q);
        if (!p) return null;
        out.push(p);
      }
      if (!geom.validatePolygon(out)) {
        if (strict) throw fail('err.plan.polygon');
        return null;
      }
      return out;
    };
    const idOf = (rawId, prefix) => {
      let id = rawId === undefined || rawId === null ? '' : cleanText(String(rawId), 80);
      if (id && used.has(id)) {
        if (strict) throw fail('err.plan.duplicateId');
        warn('duplicate id renamed');
        id = '';
      }
      if (!id) id = freeId(prefix, used);
      used.add(id);
      return id;
    };
    const arrayOf = (key) => {
      const a = planRaw[key];
      if (a === undefined || a === null) return [];
      if (!Array.isArray(a)) throw fail('err.plan.invalid');
      if (a.length > MAX_ITEMS) {
        if (strict) throw fail('err.plan.tooMany');
        warn(`${key} truncated`);
        return a.slice(0, MAX_ITEMS);
      }
      return a;
    };
    const skip = (why) => {
      if (strict) throw fail('err.plan.invalid');
      warn(why);
    };

    const roomIds = new Set();
    arrayOf('rooms').forEach((r, i) => {
      if (!isObj(r)) return skip('room not an object');
      const points = polygon(r.points);
      if (!points) return warn('room dropped (polygon)');
      let roomId = r.roomId;
      if (roomId === undefined || roomId === null) roomId = Number.isInteger(r.id) ? r.id : undefined; // VECTORS shape
      if (roomId !== undefined && (!Number.isInteger(roomId) || roomId < 1 || roomId > MAX_ITEMS || roomIds.has(roomId))) {
        if (strict) throw fail('err.plan.roomId');
        roomId = undefined;
      }
      if (roomId === undefined) {
        for (let k = 1; k <= MAX_ITEMS && roomId === undefined; k++) if (!roomIds.has(k)) roomId = k;
        if (roomId === undefined) return warn('no free room number');
      }
      roomIds.add(roomId);
      plan.rooms.push({
        id: idOf(r.id !== undefined && typeof r.id !== 'number' ? r.id : `room-${roomId}`, 'room'),
        type: 'room',
        roomId,
        name: cleanText(r.name, 50) || t('engine.name.room', lang, { n: roomId }),
        points,
        color: typeof r.color === 'string' && COLOR_RE.test(r.color) ? r.color.toLowerCase() : ROOM_COLORS[i % ROOM_COLORS.length],
      });
    });

    arrayOf('walls').forEach((w) => {
      if (!isObj(w)) return skip('wall not an object');
      const a = pt(w.a);
      const b = pt(w.b);
      if (!a || !b) return warn('wall dropped (point)');
      const o2 = { id: idOf(w.id, 'wall'), type: 'wall', name: cleanText(w.name, 50) || t('engine.name.wall', lang), a, b };
      const material = typeof w.material === 'string' && MATERIAL_KEYS.includes(w.material) ? w.material : null;
      if (isNum(w.loss)) {
        o2.material = material || 'custom';
        let loss = round(clamp(w.loss, 0, 30));
        // SPEC 7.1: a wall that still carries the OLD app's preset number of its material IS that preset -> it gets the
        // new per-band table, stored as the table's 5 GHz value (so the editor shows the preset, not a custom number)
        if (material && material !== 'custom' && loss === LEGACY_WALL_MATERIALS[material]) loss = WALL_MATERIALS[material];
        o2.loss = loss;
      } else if (material && material !== 'custom') {
        o2.material = material;
        o2.loss = WALL_MATERIALS[material];
      }
      plan.walls.push(o2);
    });

    const wallIds = new Set(plan.walls.map((w) => w.id));
    arrayOf('doors').forEach((d) => {
      if (!isObj(d)) return skip('door not an object');
      const a = pt(d.a);
      const b = pt(d.b);
      if (!a || !b) return warn('door dropped (point)');
      const wallId = d.wallId === undefined || d.wallId === null ? '' : cleanText(String(d.wallId), 80);
      if (!wallIds.has(wallId)) {
        if (strict) throw fail('err.plan.door');
        return warn('door without wall dropped');
      }
      plan.doors.push({
        id: idOf(d.id, 'door'),
        type: 'door',
        name: cleanText(d.name, 50) || t('engine.name.door', lang),
        a,
        b,
        wallId,
        loss: round(clamp(Number(d.loss) || 0, 0, 30)),
      });
    });

    arrayOf('furniture').forEach((f) => {
      if (!isObj(f)) return skip('furniture not an object');
      const points = polygon(f.points);
      if (!points) return warn('furniture dropped (polygon)');
      const kind = typeof f.kind === 'string' && Object.prototype.hasOwnProperty.call(FURNITURE_KINDS, f.kind) ? f.kind : 'custom';
      plan.furniture.push({
        id: idOf(f.id, 'furniture'),
        type: 'furniture',
        name: cleanText(f.name, 50) || t('engine.name.furniture', lang),
        points,
        loss: round(isNum(f.loss) ? clamp(f.loss, 0, 30) : clamp(Number(f.loss) || FURNITURE_KINDS[kind], 0, 30)),
        kind,
        blocksSignal: f.blocksSignal !== false,
      });
    });

    let svgBackground = null;
    const bg = planRaw.background;
    if (typeof bg === 'string' && bg.length < MAX_BACKGROUND_CHARS) {
      if (BG_RE.test(bg)) plan.background = bg;
      else if (SVG_BG_RE.test(bg)) svgBackground = bg;
    }
    return { plan, roomIds, svgBackground };
  }

  /**
   * One measurement list (SPEC 3.1 / 6.2 / 8 / 13). `mids` = the ids already used in the building (kept unique across
   * floors); `device` = goal.device (default of a measurement without one).
   */
  function cleanMeasurements(rawList, device, lang, mids) {
    const measurements = [];
    const rawMeas = Array.isArray(rawList) ? rawList.slice(0, MAX_MEASUREMENTS) : [];
    for (const m of rawMeas) {
      if (!isObj(m)) continue;
      // a measurement far off the map is dropped (clamping it to the edge would invent a position)
      const p = isNum(m.x) && isNum(m.y) && m.x >= -POINT_TOLERANCE && m.x <= 1 + POINT_TOLERANCE && m.y >= -POINT_TOLERANCE && m.y <= 1 + POINT_TOLERANCE ? softPoint(m) : null;
      // band null = "Nevím (automaticky)" (SPEC 13: the engine infers it; 'auto' is stored as null); a missing or
      // invalid band still makes the measurement unusable (the old rule)
      const unknownBand = m.band === null || units.normBandMode(m.band) === 'auto';
      const band = unknownBand ? null : units.normBand(m.band);
      if (!p || (band === null && !unknownBand)) continue;
      const download = numOrNull(m.download, 0, 10000);
      const upload = numOrNull(m.upload, 0, 10000);
      // The signal is optional for a speed-test point (SPEC 6.2: a phone browser cannot read dBm): value null is kept
      // only when the point has both download and upload, anything else without a signal is unusable.
      const value = isNum(m.value) ? round(clamp(m.value, -100, -20), 2) : null;
      if (value === null && (download === null || upload === null)) continue;
      let id = typeof m.id === 'string' || typeof m.id === 'number' ? cleanText(String(m.id), 80) : '';
      if (!id || mids.has(id)) id = freeId('m', mids);
      mids.add(id);
      const rec = {
        id,
        x: p.x,
        y: p.y,
        band,
        value,
        name: cleanText(m.name, 50) || t('engine.name.measurement', lang, { n: measurements.length + 1 }),
        download,
        upload,
        device: cleanText(m.device, 50) || device,
        t: isNum(m.t) && m.t >= 0 ? Math.floor(m.t) : 0,
      };
      // optional extras of the built-in speed test (only present when known, so older records keep their shape)
      const ping = numOrNull(m.ping, 0, 10000);
      const jitter = numOrNull(m.jitter, 0, 10000);
      if (ping !== null) rec.ping = round(ping, 2);
      if (jitter !== null) rec.jitter = round(jitter, 2);
      if (m.source === 'cloudflare') rec.source = 'cloudflare';
      // optional Wi-Fi details and measuring-device info (SPEC 8; only when known, so older records keep their shape)
      const wifi = cleanWifi(m.wifi);
      if (wifi) rec.wifi = wifi;
      const info = cleanDeviceInfo(m.deviceInfo);
      if (info) rec.deviceInfo = info;
      measurements.push(rec);
    }
    return measurements;
  }

  /** Node bands {'2.4','5','6'} (missing flags = `def`) and a backhaul band the node serves (SPEC 10 / 14.2). */
  function cleanNodeBands(sb, def, backhaulRaw) {
    const src = isObj(sb) ? sb : {};
    const bands = {
      '2.4': typeof src['2.4'] === 'boolean' ? src['2.4'] : def['2.4'],
      '5': typeof src['5'] === 'boolean' ? src['5'] : def['5'],
      '6': typeof src['6'] === 'boolean' ? src['6'] : def['6'],
    };
    let backhaulBand = units.normBand(backhaulRaw) || 5;
    if (!bands[String(backhaulBand)]) {
      const first = E.BANDS.find((b) => bands[String(b)]);
      if (first) backhaulBand = first;
    }
    return { bands, backhaulBand };
  }

  /** The node's real throughput ceiling in whole Mb/s (SPEC 10 "Kolik zvládne"); null = unknown (also 0 / negative). */
  const nodeMbps = (v) => (isNum(v) && v > 0 ? Math.round(clamp(v, NODE_MBPS_MIN, NODE_MBPS_MAX)) : null);

  /**
   * One node of SPEC 14.2 ({id, name, mode, pos, bands, power, backhaulBand, backhaulThreshold, maxMbps, uplink,
   * enabled}); null when the mode is not an AP / mesh / repeater kind. `snap` puts the position onto its floor; `fallbackPos`
   * is used when the raw position is missing. Ids / uplinks are resolved by the caller (building wide).
   */
  function cleanNode(raw, snap, fallbackPos, lang) {
    if (!isObj(raw) || !NODE_KINDS.includes(raw.mode)) return null;
    const { bands, backhaulBand } = cleanNodeBands(raw.bands, NODE_BANDS_DEFAULT, raw.backhaulBand);
    const pos = softPoint(raw.pos) || fallbackPos || { x: 0.4, y: 0.4 };
    return {
      id: typeof raw.id === 'string' || typeof raw.id === 'number' ? cleanText(String(raw.id), 40) : '',
      name: cleanText(raw.name, 50),
      mode: raw.mode,
      pos: roundPt(snap(pos)),
      bands,
      power: num(raw.power, -10, 6, 0),
      backhaulBand,
      backhaulThreshold: num(raw.backhaulThreshold, -80, -55, -67),
      maxMbps: nodeMbps(raw.maxMbps),
      uplink: typeof raw.uplink === 'string' || typeof raw.uplink === 'number' ? cleanText(String(raw.uplink), 40) || 'router' : 'router',
      enabled: raw.enabled !== false,
    };
  }

  /** Floor.ceiling = {material, lossDb (5 GHz reference), heightM}; a preset with another number becomes 'custom'. */
  function cleanCeiling(raw) {
    const c = isObj(raw) ? raw : {};
    let material = typeof c.material === 'string' && CEILING_KEYS.includes(c.material) ? c.material : null;
    let lossDb = isNum(c.lossDb) ? round(clamp(c.lossDb, 0, 40), 2) : null;
    if (lossDb === null) lossDb = material && material !== 'custom' ? CEILING_MATERIALS[material] : CEILING_DEFAULT.lossDb;
    if (!material) material = lossDb === CEILING_DEFAULT.lossDb ? CEILING_DEFAULT.material : 'custom';
    else if (material !== 'custom' && lossDb !== CEILING_MATERIALS[material]) material = 'custom';
    return { material, lossDb, heightM: num(c.heightM, 2, 6, CEILING_DEFAULT.heightM) };
  }

  /**
   * project.scale (SPEC 14.1): {mpp, verified, method, ref}. A scale is verified only when the file says so AND carried
   * its own mpp; without a method an older file's scale is 'import' (it had an mpp or the old app's width) or 'default'.
   */
  function cleanScale(ss, mpp, hasMpp, fromFile) {
    const s = isObj(ss) ? ss : {};
    const method = SCALE_METHODS.includes(s.method) ? s.method : fromFile ? 'import' : 'default';
    return { mpp, verified: hasMpp && s.verified === true, method, ref: cleanScaleRef(method, s.ref) };
  }

  /** The reference a verified scale was derived from: two points + metres, an area (+ room), a width; else null. */
  function cleanScaleRef(method, r) {
    if (!isObj(r)) return null;
    if (method === 'two-points') {
      const a = softPoint(r.a);
      const b = softPoint(r.b);
      return a && b && isNum(r.metres) && r.metres > 0 ? { a, b, metres: round(clamp(r.metres, 0.01, 1000), 4) } : null;
    }
    if (method === 'area') {
      if (!isNum(r.areaM2) || r.areaM2 <= 0) return null;
      const out = { areaM2: round(clamp(r.areaM2, 0.1, 100000), 3) };
      if (Number.isInteger(r.roomId) && r.roomId >= 1 && r.roomId <= MAX_ITEMS) out.roomId = r.roomId;
      return out;
    }
    if (method === 'width') return isNum(r.metres) && r.metres > 0 ? { metres: round(clamp(r.metres, 0.1, 1000), 4) } : null;
    return null;
  }

  /**
   * Validate + normalize anything that looks like a plan/project. See sanitize().
   * @returns {{project:object, warnings:string[], svgBackground:string|null}}
   *   svgBackground: a legacy `data:image/svg+xml;base64,...` background that sanitize cannot keep (the IO layer must
   *   rasterize it to PNG and put it into project.plan.background), else null.
   */
  function sanitizeDetailed(raw, opts) {
    const o = opts || {};
    const strict = o.strict !== false;
    const lang = E.text.lang(o.lang);
    const warnings = [];
    const warn = (msg) => warnings.push(msg);

    let src = raw;
    if (typeof src === 'string') {
      try {
        src = JSON.parse(src);
      } catch (e) {
        throw fail('err.plan.invalid');
      }
    }
    if (!isObj(src)) throw fail('err.plan.invalid');
    if (src.format !== undefined && src.format !== 'wifi-floor-v2') throw fail('err.plan.format');

    // ---- locate the plan and the settings in the different payload shapes -------------------------------------
    let planRaw = null;
    let legacy = {}; // {width,router,original,optic}
    let slices = {}; // v3 slices: scale, net, nodes (node), model, goal, measurements, view, floors, name
    if (isObj(src.plan)) {
      planRaw = src.plan;
      legacy = src;
      slices = isObj(src.project) ? src.project : src;
    } else if (isObj(src.appliedPlan) || isObj(src.ed)) {
      // legacy localStorage 'wifi-floor-v5' = {ed, appliedPlan}
      planRaw = isObj(src.appliedPlan) ? src.appliedPlan : src.ed;
      legacy = isObj(planRaw.importedSettings) ? planRaw.importedSettings : {};
    } else if (Array.isArray(src.rooms)) {
      // bare plan (old demo USER_PLAN / VECTORS shape)
      planRaw = src;
      legacy = isObj(src.importedSettings) ? src.importedSettings : src;
    } else {
      throw fail('err.plan.invalid');
    }
    if (!Array.isArray(planRaw.rooms)) throw fail('err.plan.invalid');

    // ---- plan of the active floor (the top level of every file) -------------------------------------------------
    const planOpts = { strict, lang, warn };
    const main = cleanPlan(planRaw, planOpts);
    const svgBackground = main.svgBackground;
    const d = defaults(lang);
    const sv = isObj(slices.view) ? slices.view : {};

    // ---- floors (SPEC 14.3): the active floor's content is the top level; the others carry their own -------------
    const floorsRaw = Array.isArray(slices.floors) ? slices.floors.filter(isObj).slice(0, MAX_FLOORS * 2) : [];
    const idText = (v) => (typeof v === 'string' || typeof v === 'number' ? cleanText(String(v), 40) : '');
    const viewFloor = idText(sv.floor);
    let activeRaw = null;
    if (floorsRaw.length) activeRaw = (viewFloor && floorsRaw.find((f) => idText(f.id) === viewFloor)) || floorsRaw.find((f) => !isObj(f.plan)) || floorsRaw[0];
    const rawNodesActive = Array.isArray(slices.nodes) ? slices.nodes : isObj(slices.node) && NODE_KINDS.includes(slices.node.mode) ? [{ ...slices.node, id: 'node-1', uplink: 'router', enabled: true }] : [];
    const fids = new Set();
    let entries = [];
    (floorsRaw.length ? floorsRaw : [{}]).forEach((f, i) => {
      const active = floorsRaw.length ? f === activeRaw : true;
      let content;
      if (active) content = { plan: main.plan, roomIds: main.roomIds, rawMeas: slices.measurements, rawNodes: rawNodesActive, rawGoal: isObj(slices.goal) ? slices.goal : {} };
      else {
        if (!isObj(f.plan)) {
          if (strict) throw fail('err.plan.invalid');
          return warn('floor without a plan dropped');
        }
        let r;
        try {
          r = cleanPlan(f.plan, planOpts);
        } catch (e) {
          if (strict) throw e;
          return warn('floor dropped (plan)');
        }
        if (r.svgBackground) warn('svg background of another floor dropped');
        content = { plan: r.plan, roomIds: r.roomIds, rawMeas: f.measurements, rawNodes: Array.isArray(f.nodes) ? f.nodes : [], rawGoal: isObj(f.goal) ? f.goal : {} };
      }
      let id = idText(f.id);
      if (!id || fids.has(id)) id = freeId('floor', fids);
      fids.add(id);
      entries.push({ id, rawName: f.name, rawLevel: f.level, order: i, active, ceiling: cleanCeiling(f.ceiling), ...content });
    });
    // levels: integers, unique (a repeated level moves up to the next free one), sorted from the lowest floor
    entries.forEach((e, i) => {
      e.level = Number.isInteger(e.rawLevel) ? clamp(e.rawLevel, LEVEL_MIN, LEVEL_MAX) : i;
    });
    entries.sort((a, b) => a.level - b.level || a.order - b.order);
    for (let i = 1; i < entries.length; i++) if (entries[i].level <= entries[i - 1].level) entries[i].level = entries[i - 1].level + 1;
    if (entries.length > MAX_FLOORS || entries.some((e) => e.level > LEVEL_MAX)) {
      warn('floors truncated');
      const keep = entries.filter((e) => e.level <= LEVEL_MAX || e.active);
      entries = keep.filter((e, i) => e.active || keep.slice(0, i).filter((x) => !x.active).length < MAX_FLOORS - 1);
    }
    for (const e of entries) e.name = cleanText(e.rawName, 50) || floorName(e.level, lang);
    const floorById = new Map(entries.map((e) => [e.id, e]));
    const activeE = entries.find((e) => e.active);
    const snapOn = (e, p) => (e.plan.rooms.length ? nearestFloor(e.plan, p) : p);

    // ---- scale ----------------------------------------------------------------------------------------------------
    // one scale for the whole building (SPEC 14.3); SPEC 14.1: older files are not verified - 'import' when the file
    // carried a scale (mpp or the old app's width), the user confirms it once
    const ss = isObj(slices.scale) ? slices.scale : {};
    const hasMpp = isNum(ss.mpp) && ss.mpp > 0;
    const legacyWidth = isNum(legacy.width) && legacy.width >= 6 && legacy.width <= 25;
    let mpp;
    if (hasMpp) mpp = clamp(ss.mpp, MPP_MIN, MPP_MAX);
    else mpp = deriveMpp(activeE.plan, legacyWidth ? legacy.width : 12);
    mpp = Number(mpp.toPrecision(10));
    const scale = cleanScale(ss, mpp, hasMpp, hasMpp || legacyWidth);

    // ---- net (the router lives on net.routerFloor, the inlet on net.opticFloor) -----------------------------------
    const sn = isObj(slices.net) ? slices.net : {};
    const rf = floorById.get(idText(sn.routerFloor)) || activeE;
    const of = floorById.get(idText(sn.opticFloor)) || rf;
    const rbb = roomsBBox(rf.plan);
    const floorCentre = rbb ? geom.labelPoint(rf.plan.rooms[0].points) : { x: 0.5, y: 0.5 };
    const routerRaw = softPoint(sn.router) || softPoint(legacy.router) || floorCentre;
    const baselineRaw = softPoint(sn.baseline) || softPoint(legacy.original) || routerRaw;
    const router = roundPt(snapOn(rf, routerRaw));
    const baseline = roundPt(snapOn(rf, baselineRaw));
    const obb = roomsBBox(of.plan);
    const optic = softPoint(sn.optic) || softPoint(legacy.optic) || (obb ? { x: round(clamp(obb.minX + 0.02, 0, 1)), y: round((obb.minY + obb.maxY) / 2) } : d.net.optic);
    const net = {
      router,
      baseline,
      optic,
      wanDown: numOrNull(sn.wanDown, 0, 10000),
      wanUp: numOrNull(sn.wanUp, 0, 10000),
      wanPort: WAN_RATES.includes(sn.wanPort) ? sn.wanPort : null,
      ontPort: WAN_RATES.includes(sn.ontPort) ? sn.ontPort : null,
      wanLink: WAN_RATES.includes(sn.wanLink) ? sn.wanLink : null,
      cableCategory: CABLE_CATEGORIES.includes(sn.cableCategory) ? sn.cableCategory : 'unknown',
      cableLength: isNum(sn.cableLength) && sn.cableLength >= 0.1 && sn.cableLength <= 500 ? round(sn.cableLength) : null,
      // the bands the router sends (SPEC 13); every flag on its own, all off = not a router -> the default
      routerBands: cleanRouterBands(sn.routerBands),
      routerFloor: rf.id,
      opticFloor: of.id,
    };

    // ---- nodes (SPEC 14.2): <= MAX_NODES in the building, ids unique, uplinks valid and acyclic -------------------
    const nids = new Set();
    let nodeCount = 0;
    for (const e of entries) {
      e.nodes = [];
      for (const rn of Array.isArray(e.rawNodes) ? e.rawNodes : []) {
        const fallback = farthestRoomCentre(e.plan, e === rf ? router : { x: 0.5, y: 0.5 });
        const nd = cleanNode(rn, (p) => snapOn(e, p), fallback, lang);
        if (!nd) continue;
        if (nodeCount >= MAX_NODES) {
          warn('nodes truncated');
          break;
        }
        if (!nd.id || nids.has(nd.id) || nd.id === 'router') nd.id = freeId('node', nids);
        nids.add(nd.id);
        e.nodes.push(nd);
        nodeCount++;
      }
    }
    const allNodesList = entries.flatMap((e) => e.nodes);
    const nodeIndex = new Map(allNodesList.map((nd) => [nd.id, nd]));
    for (const nd of allNodesList) if (nd.uplink !== 'router' && (!nodeIndex.has(nd.uplink) || nd.uplink === nd.id)) nd.uplink = 'router';
    for (const nd of allNodesList) {
      // a cycle (A -> B -> A) is cut where it closes: that node uplinks to the router
      const seen = new Set([nd.id]);
      let cur = nd;
      while (cur.uplink !== 'router') {
        const next = nodeIndex.get(cur.uplink);
        if (seen.has(next.id)) {
          cur.uplink = 'router';
          break;
        }
        seen.add(next.id);
        cur = next;
      }
    }
    const usedNames = new Set();
    for (const nd of allNodesList) {
      if (!nd.name) nd.name = freeNodeName(usedNames, lang);
      usedNames.add(nd.name);
    }

    // ---- model ----------------------------------------------------------------------------------------------------
    const sm = isObj(slices.model) ? slices.model : {};
    const sbp = isObj(sm.bandPower) ? sm.bandPower : {};
    const model = {
      nearSignal: num(sm.nearSignal, -55, -25, -40),
      n: num(sm.n, 1.6, 4, 2.2),
      wallLoss: num(sm.wallLoss, 0, 20, 8),
      threshold: num(sm.threshold, -75, -55, -67),
      rangeThreshold: num(sm.rangeThreshold, -80, -45, -60),
      // per-band transmit power difference in dB (SPEC 7.1), added to that band's signal
      bandPower: {
        '2.4': num(sbp['2.4'], BAND_POWER_MIN, BAND_POWER_MAX, 0),
        '5': num(sbp['5'], BAND_POWER_MIN, BAND_POWER_MAX, 0),
        '6': num(sbp['6'], BAND_POWER_MIN, BAND_POWER_MAX, 0),
      },
      // band-steering thresholds (SPEC 13): a client uses 6 GHz from `six` dBm, else 5 GHz from `five`, else 2.4 GHz
      steer: {
        six: num(isObj(sm.steer) ? sm.steer.six : undefined, STEER_MIN, STEER_MAX, STEER_DEFAULT.six),
        five: num(isObj(sm.steer) ? sm.steer.five : undefined, STEER_MIN, STEER_MAX, STEER_DEFAULT.five),
      },
    };
    // calibration fit of the "first measurement" wizard (SPEC 9; only when present, older files keep their shape)
    const fit = cleanFit(sm.fit);
    if (fit) model.fit = fit;

    // ---- goal: room / excluded belong to each floor's plan, allowedRoom to the router floor's ----------------------
    const sg = isObj(slices.goal) ? slices.goal : {};
    const roomGoal = (rawGoal, ids) => {
      const has = (id) => Number.isInteger(id) && ids.has(id);
      const excluded = [];
      if (Array.isArray(rawGoal.excluded)) for (const id of rawGoal.excluded.slice(0, MAX_ITEMS)) if (has(id) && !excluded.includes(id)) excluded.push(id);
      return { room: has(rawGoal.room) ? rawGoal.room : 'all', excluded };
    };
    for (const e of entries) e.goal = roomGoal(e.rawGoal, e.roomIds);
    const goal = {
      room: activeE.goal.room,
      allowedRoom: Number.isInteger(sg.allowedRoom) && rf.roomIds.has(sg.allowedRoom) ? sg.allowedRoom : 'any',
      excluded: activeE.goal.excluded,
      mode: sg.mode === 'speed' ? 'speed' : 'signal',
      targetDown: num(sg.targetDown, 1, 10000, 50),
      targetUp: num(sg.targetUp, 1, 10000, 50),
      reserve: num(sg.reserve, 0, 80, 30),
      device: cleanText(sg.device, 50) || d.goal.device,
    };

    // ---- measurements (ids unique in the whole building; the active floor's keep theirs first) --------------------
    const mids = new Set();
    activeE.meas = cleanMeasurements(activeE.rawMeas, goal.device, lang, mids);
    for (const e of entries) if (!e.active) e.meas = cleanMeasurements(e.rawMeas, goal.device, lang, mids);

    // ---- view -----------------------------------------------------------------------------------------------------
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    const bandsOn = E.BANDS.filter((b) => net.routerBands[units.bandKey(b)]);
    const view = {
      // the file's own band (or Auto) is kept; without one: Auto when the router sends two or more bands (SPEC 13)
      band: units.normBandMode(sv.band) || (bandsOn.length > 1 ? 'auto' : bandsOn[0]),
      layer: LAYERS.includes(sv.layer) ? sv.layer : 'signal',
      ranges: bool(sv.ranges, false),
      walls: bool(sv.walls, true),
      furniture: bool(sv.furniture, true),
      labels: bool(sv.labels, true),
      values: bool(sv.values, false),
      // planner layers "Body měření" / "Předpověď u bodů" (the dots + their labels / the "→ predicted (+Δ)" part); older files: on
      points: bool(sv.points, true),
      whatif: bool(sv.whatif, true),
      // planner layer "Zdroj signálu" (SPEC 10.3: the border between the router's and the second node's zone); older files: on
      sourceZones: bool(sv.sourceZones, true),
      calibrate: bool(sv.calibrate, true),
      palette: PALETTES.includes(sv.palette) ? sv.palette : 'default',
      // the active floor (SPEC 14.3)
      floor: activeE.id,
    };

    const project = {
      v: SCHEMA_VERSION,
      name: cleanText(slices.name, 80) || cleanText(src.name, 80) || t('engine.project.name', lang),
      plan: activeE.plan,
      scale,
      net,
      nodes: activeE.nodes,
      model,
      goal,
      measurements: activeE.meas,
      view,
      floors: entries.map((e) => ({
        id: e.id,
        name: e.name,
        level: e.level,
        ceiling: e.ceiling,
        plan: e.active ? null : e.plan,
        nodes: e.active ? null : e.nodes,
        measurements: e.active ? null : e.meas,
        goal: e.active ? null : e.goal,
      })),
    };
    return { project, warnings, svgBackground };
  }

  function roundPt(p) {
    return { x: round(p.x), y: round(p.y) };
  }

  /** net.routerBands (SPEC 13): booleans per band (a missing flag = its default); no band on -> the default. */
  function cleanRouterBands(v) {
    const src = isObj(v) ? v : {};
    const out = {};
    for (const k of ['2.4', '5', '6']) out[k] = typeof src[k] === 'boolean' ? src[k] : ROUTER_BANDS_DEFAULT[k];
    return out['2.4'] || out['5'] || out['6'] ? out : { ...ROUTER_BANDS_DEFAULT };
  }

  /**
   * Visual centre of the room whose centre is farthest from `from` (and `others`) - a sensible default for a node;
   * rooms in `skipIds` (a balcony that does not count) only when there is nothing else.
   */
  function farthestRoomCentre(plan, from, others, skipIds) {
    let best = null;
    let bestD = -1;
    const skip = new Set(Array.isArray(skipIds) ? skipIds : []);
    const rooms = plan.rooms.some((r) => !skip.has(r.roomId)) ? plan.rooms.filter((r) => !skip.has(r.roomId)) : plan.rooms;
    const avoid = [from].concat(Array.isArray(others) ? others : []).filter((q) => q && isNum(q.x) && isNum(q.y));
    for (const r of rooms) {
      const c = geom.labelPoint(r.points);
      // nothing to keep away from: the biggest room
      const d = avoid.length ? Math.min(...avoid.map((q) => geom.dist(c, q))) : geom.polygonArea(r.points);
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Validate + normalize a project / legacy payload into a fresh, fully valid Project (strict: throws on garbage).
   * Accepts: v3 Project objects, SVG-metadata payloads (with or without the `project` sub-object), legacy
   * `wifi-floor-v2` payloads {plan,width,router,original,optic}, bare plans (old demo shape), old localStorage v5
   * objects {ed,appliedPlan}, or a JSON string of any of these.
   * @param {*} raw
   * @param {{strict?:boolean, lang?:'cs'|'en'}} [opts] strict=false drops unusable objects instead of throwing
   * @returns {object} Project
   * @throws {Error} message is an i18n key ('err.plan.invalid', 'err.plan.format', 'err.plan.tooMany', ...)
   */
  function sanitize(raw, opts) {
    return sanitizeDetailed(raw, opts).project;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // serialize / SVG
  // ---------------------------------------------------------------------------------------------------------------

  function replacer(key, v) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      if (Number.isInteger(v)) return v; // ids, timestamps, rates: never touch
      return key === 'mpp' ? Number(v.toPrecision(10)) : round(v, 6);
    }
    return v;
  }

  function legacyWidth(project) {
    return round(clamp(widthFromMpp(project.plan, project.scale.mpp), 6, 25), 4);
  }

  /**
   * The project exactly as a file gets it. An invalid room / furniture outline throws err.plan.polygon (better than a
   * file nobody can open); everything else goes through sanitize(strict:false): for a project from the store that is
   * a no-op (sanitize is idempotent), but a half-edited object (NaN coordinate, door whose wall is gone, duplicate id,
   * missing colour) is repaired or dropped instead of producing a file our own loader refuses or an SVG with "NaN" /
   * "undefined" in it.
   */
  function writable(project) {
    if (!isObj(project) || !isObj(project.plan)) throw fail('err.plan.invalid');
    // every floor's outlines (SPEC 14.3): the active floor's at the top level, the others inside project.floors
    const plans = [project.plan].concat(Array.isArray(project.floors) ? project.floors.map((f) => isObj(f) && isObj(f.plan) && f.plan) : []);
    for (const plan of plans) {
      if (!plan) continue;
      for (const k of ['rooms', 'furniture']) {
        const list = plan[k];
        if (Array.isArray(list)) for (const o of list) if (isObj(o) && !geom.validatePolygon(o.points)) throw fail('err.plan.polygon');
      }
    }
    return sanitize(project, { strict: false });
  }

  /**
   * The single `node` of older app versions (stage 7 - 3.2 read `project.node`): the active floor's first node in the old
   * shape, mode 'none' when there is none or it is switched off.
   */
  function legacyNode(project) {
    const n = Array.isArray(project.nodes) && project.nodes.length ? project.nodes[0] : null;
    if (n) return { mode: n.enabled === false ? 'none' : n.mode, pos: n.pos, bands: n.bands, power: n.power, backhaulBand: n.backhaulBand, backhaulThreshold: n.backhaulThreshold, maxMbps: n.maxMbps };
    const pos = (project.plan.rooms.length && farthestRoomCentre(project.plan, project.net.router)) || { x: 0.4, y: 0.4 };
    return { mode: 'none', pos: roundPt(project.plan.rooms.length ? nearestFloor(project.plan, pos) : pos), bands: { ...NODE_BANDS_DEFAULT }, power: 0, backhaulBand: 5, backhaulThreshold: -67, maxMbps: null };
  }

  /**
   * JSON for `<metadata id="wifi-plan-data">`:
   * {format:'wifi-floor-v2', plan, width, router, original, optic, app:'wifi-heatmap-architect', v:3, project:{...}}
   * The first six keys are exactly what the OLD app reads. Always loadable by parseSvgText / sanitize (see writable).
   * @param {object} project
   * @param {{withBackground?:boolean}} [opts] withBackground=false drops the tracing image (default true)
   * @throws {Error} 'err.plan.polygon' when a room/furniture outline is invalid
   */
  function serialize(project, opts) {
    return payloadJson(writable(project), !opts || opts.withBackground !== false);
  }

  function payloadJson(project, withBg) {
    const plan = withBg ? project.plan : { ...project.plan, background: null };
    const floors = withBg ? project.floors : project.floors.map((f) => (f.plan ? { ...f, plan: { ...f.plan, background: null } } : f));
    const payload = {
      format: 'wifi-floor-v2',
      plan,
      width: legacyWidth(project),
      router: project.net.router,
      original: project.net.baseline,
      optic: project.net.optic,
      app: 'wifi-heatmap-architect',
      v: SCHEMA_VERSION,
      project: {
        name: project.name,
        scale: project.scale,
        net: project.net,
        // older builds of this app (stage 7 .. 3.2) read the single node; this one reads nodes + floors (SPEC 14)
        node: legacyNode(project),
        nodes: project.nodes,
        model: project.model,
        goal: project.goal,
        measurements: project.measurements,
        view: project.view,
        floors,
      },
    };
    return JSON.stringify(payload, replacer);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  }
  const f2 = (n) => String(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0); // never print NaN into an attribute
  const ptsAttr = (pts) => pts.map((p) => `${f2(p.x * W)},${f2(p.y * H)}`).join(' ');

  const WALL_COLORS = { drywall: '#458fb8', glass: '#5aa9c9', wood: '#8b6b4a', metal: '#555f6e' };

  /**
   * Complete visual SVG (1080x942) of the plan + the metadata block; round-trips through parseSvgText + sanitize.
   * @param {object} project
   * @param {{lang?:'cs'|'en', markers?:boolean, withBackground?:boolean}} [opts]
   *   markers (default true) draws router / today / internet markers; withBackground (default true) keeps the tracing
   *   image inside the metadata (the picture itself is not drawn).
   */
  function buildSvg(raw, opts) {
    const o = opts || {};
    const lang = E.text.lang(o.lang);
    const project = writable(raw); // the picture and the data describe the same, valid project
    const data = payloadJson(project, o.withBackground !== false);
    const plan = project.plan;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
    s += `<title>${esc(t('engine.svg.title', lang))}</title><desc>${esc(t('engine.svg.desc', lang))}</desc>`;
    s += `<metadata id="wifi-plan-data">${esc(data)}</metadata>`;
    s += `<rect width="${W}" height="${H}" fill="#f4f7fb"/>`;
    for (const r of plan.rooms) {
      s += `<g data-type="room" data-name="${esc(r.name)}"><title>${esc(r.name)}</title><polygon points="${ptsAttr(r.points)}" fill="${esc(r.color)}" fill-opacity="0.55" stroke="#334766" stroke-width="1"/></g>`;
    }
    for (const f of plan.furniture) {
      s += `<g data-type="furniture" data-name="${esc(f.name)}"><title>${esc(f.name)}</title><polygon points="${ptsAttr(f.points)}" fill="#d9c75f" fill-opacity="${f.blocksSignal === false ? 0.2 : 0.55}" stroke="#a89a3c" stroke-width="1.5"/></g>`;
    }
    for (const w of plan.walls) {
      const heavy = (isNum(w.loss) ? w.loss : project.model.wallLoss) >= 10;
      const colour = WALL_COLORS[w.material] || '#334766';
      s += `<g data-type="wall" data-name="${esc(w.name)}"><title>${esc(w.name)}</title><line x1="${f2(w.a.x * W)}" y1="${f2(w.a.y * H)}" x2="${f2(w.b.x * W)}" y2="${f2(w.b.y * H)}" stroke="${colour}" stroke-width="${heavy ? 8 : 6}" stroke-linecap="square"/></g>`;
    }
    for (const d of plan.doors) {
      s += `<g data-type="door" data-name="${esc(d.name)}"><title>${esc(d.name)}</title><line x1="${f2(d.a.x * W)}" y1="${f2(d.a.y * H)}" x2="${f2(d.b.x * W)}" y2="${f2(d.b.y * H)}" stroke="#18a895" stroke-width="10"/></g>`;
    }
    // labels: rooms first, furniture only where the name fits inside the piece and collides with no other label
    const taken = [];
    const free = (c, w, h) => !taken.some((q) => Math.abs(q.x - c.x) < (q.w + w) / 2 && Math.abs(q.y - c.y) < (q.h + h) / 2);
    for (const r of plan.rooms) {
      const c = geom.labelPoint(r.points);
      const w = [...r.name].length * 12;
      taken.push({ x: c.x * W, y: c.y * H, w, h: 26 });
      s += `<text x="${f2(c.x * W)}" y="${f2(c.y * H)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#16243b" stroke="#f4f7fb" stroke-width="4" paint-order="stroke">${esc(r.name)}</text>`;
    }
    for (const f of plan.furniture) {
      const bb = geom.bbox(f.points);
      const w = [...f.name].length * 8;
      if (geom.polygonArea(f.points) <= 0.02 || (bb.maxX - bb.minX) * W < w + 10 || (bb.maxY - bb.minY) * H < 24) continue;
      const c = geom.labelPoint(f.points);
      if (!geom.pointInPolygon({ x: c.x - w / 2 / W, y: c.y }, f.points) || !geom.pointInPolygon({ x: c.x + w / 2 / W, y: c.y }, f.points) || !free({ x: c.x * W, y: c.y * H }, w, 18)) continue;
      taken.push({ x: c.x * W, y: c.y * H, w, h: 18 });
      s += `<text x="${f2(c.x * W)}" y="${f2(c.y * H)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#16243b" stroke="#f4f7fb" stroke-width="3" paint-order="stroke">${esc(f.name)}</text>`;
    }
    if (o.markers !== false) {
      const marker = (p, fill, label, dashed) => {
        const x = f2(p.x * W);
        const y = f2(p.y * H);
        return (
          `<circle cx="${x}" cy="${y}" r="13" fill="${dashed ? 'none' : fill}" stroke="${dashed ? fill : '#ffffff'}" stroke-width="3"${dashed ? ' stroke-dasharray="5 4"' : ''}/>` +
          `<text x="${x}" y="${f2(p.y * H + 5)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="${dashed ? fill : '#ffffff'}">${esc(label)}</text>`
        );
      };
      // the picture shows the active floor: the router / inlet only when they are on it (SPEC 14.3)
      const here = project.view.floor;
      if (project.net.routerFloor === here) {
        if (geom.dist(project.net.baseline, project.net.router) > 2) s += marker(project.net.baseline, '#c2410c', t('engine.svg.todayLetter', lang), true);
        s += marker(project.net.router, '#dc2626', 'R', false);
      }
      if (project.net.opticFloor === here) s += marker(project.net.optic, '#2563eb', 'I', false);
    }
    // scale bar: 1 m
    const px1m = 1 / project.scale.mpp;
    if (px1m >= 20 && px1m <= 400) {
      // in the bottom margin, label to the right of the bar, so it cannot run into a plan that fills the canvas
      s += `<g font-family="Arial, sans-serif" font-size="14" fill="#334766"><line x1="24" y1="${H - 14}" x2="${f2(24 + px1m)}" y2="${H - 14}" stroke="#334766" stroke-width="3"/><text x="${f2(24 + px1m + 8)}" y="${H - 9}">1 m</text></g>`;
    }
    s += '</svg>';
    return s;
  }

  const ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi;
  function decodeEntities(str) {
    return str.replace(ENTITY_RE, (m, e) => {
      const l = e.toLowerCase();
      if (l === 'amp') return '&';
      if (l === 'lt') return '<';
      if (l === 'gt') return '>';
      if (l === 'quot') return '"';
      if (l === 'apos') return "'";
      const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
      return String.fromCodePoint(cp);
    });
  }

  /**
   * Body of the first <metadata ... id="wifi-plan-data" ...> element (raw, still entity-encoded), or null. Linear time
   * (see META_OPEN_RE). Like the old single regex: the first opening tag with that id wins, its content runs to the
   * next </metadata>.
   */
  function metadataBody(text) {
    META_OPEN_RE.lastIndex = 0;
    let m;
    while ((m = META_OPEN_RE.exec(text))) {
      if (!META_ID_RE.test(m[1])) continue;
      const start = META_OPEN_RE.lastIndex;
      META_CLOSE_RE.lastIndex = start;
      const c = META_CLOSE_RE.exec(text);
      return c ? text.slice(start, c.index) : null; // no closing tag: no later opening tag has one either
    }
    return null;
  }

  /**
   * Extract the project from the text of an SVG file without a DOM parser (regex + entity decoding).
   * @param {string} svgText
   * @returns {{project:object|null, hasData:boolean, svgBackground:string|null, warnings:string[]}}
   *   hasData=false means "just an image" (no wifi-plan-data) -> the UI should offer it as a tracing background.
   * @throws {Error} 'err.svg.tooBig' | 'err.svg.dtd' | 'err.svg.invalid' | 'err.svg.badData' | 'err.plan.*'
   */
  function parseSvgText(svgText) {
    if (typeof svgText !== 'string') throw fail('err.svg.invalid');
    if (svgText.length > MAX_SVG_CHARS) throw fail('err.svg.tooBig');
    if (DTD_RE.test(svgText)) throw fail('err.svg.dtd');
    if (!/<svg[\s>]/i.test(svgText)) throw fail('err.svg.invalid');
    const raw = metadataBody(svgText);
    if (raw === null) return { project: null, hasData: false, svgBackground: null, warnings: [] };
    let body = raw.trim();
    const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(body);
    body = cdata ? cdata[1] : decodeEntities(body);
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw fail('err.svg.badData');
    }
    if (!isObj(data)) throw fail('err.svg.badData');
    if (data.format !== 'wifi-floor-v2') throw fail('err.plan.format');
    const r = sanitizeDetailed(data, { strict: true });
    return { project: r.project, hasData: true, svgBackground: r.svgBackground, warnings: r.warnings };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // legacy localStorage migration
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Best-effort import of the old app's localStorage (keys wifi-floor-v5, wifi-floor-network-v1, wifi-speed-v1,
   * wifi-flow-v1). Never throws.
   * @param {(key:string)=>string|null} getItem e.g. (k) => localStorage.getItem(k)
   * @param {{lang?:'cs'|'en'}} [opts]
   * @returns {object|null} Project, or null when there is nothing worth migrating
   */
  function migrateLegacyStorage(getItem, opts) {
    try {
      const read = (k) => {
        try {
          const s = getItem(k);
          if (typeof s !== 'string' || !s) return null;
          const v = JSON.parse(s);
          return isObj(v) ? v : null;
        } catch (e) {
          return null;
        }
      };
      const v5 = read('wifi-floor-v5');
      if (!v5) return null;
      const net = read('wifi-floor-network-v1') || {};
      const speed = read('wifi-speed-v1');
      const flow = read('wifi-flow-v1');
      let result = null;
      for (const planRaw of [v5.appliedPlan, v5.ed]) {
        if (!isObj(planRaw)) continue;
        try {
          const wrapper = {
            format: 'wifi-floor-v2',
            plan: planRaw,
            width: net.width !== undefined ? net.width : planRaw.importedSettings && planRaw.importedSettings.width,
            router: net.router || (planRaw.importedSettings && planRaw.importedSettings.router),
            original: net.original || (planRaw.importedSettings && planRaw.importedSettings.original),
            optic: net.optic || (planRaw.importedSettings && planRaw.importedSettings.optic),
          };
          result = sanitizeDetailed(wrapper, { strict: false, lang: opts && opts.lang }).project;
          break;
        } catch (e) {
          result = null;
        }
      }
      if (!result) return null;
      if (!result.plan.rooms.length && !result.plan.background) return null;

      // speed storage: settings + measurements (valid only for the baseline they were taken at)
      if (speed) {
        const s = isObj(speed.settings) ? speed.settings : {};
        const g = result.goal;
        if (typeof s.speedDevice === 'string') g.device = s.speedDevice;
        if (isNum(s.targetDown)) g.targetDown = s.targetDown;
        if (isNum(s.targetUp)) g.targetUp = s.targetUp;
        if (isNum(s.speedReserve)) g.reserve = s.speedReserve;
        const n = result.net;
        for (const k of ['wanDown', 'wanUp', 'wanPort', 'ontPort', 'wanLink', 'cableCategory', 'cableLength']) if (s[k] !== undefined) n[k] = s[k];
        const o = softPoint(speed.original);
        // the old app kept the points only for the very same "original" (|d| < 1e-6); compare with the stored original
        // as written by the old app and with the (snapped, 6-decimal) baseline it became here
        const rawOriginal = softPoint(net.original) || softPoint(v5.appliedPlan && v5.appliedPlan.importedSettings && v5.appliedPlan.importedSettings.original);
        const same = (a, b) => !!(a && b && Math.abs(a.x - b.x) < 2e-6 && Math.abs(a.y - b.y) < 2e-6);
        if (o && (same(o, result.net.baseline) || same(o, rawOriginal)) && Array.isArray(speed.points)) {
          // like the old app: only points on the floor, and only for the baseline they were taken at
          result.measurements = speed.points
            .slice(0, MAX_MEASUREMENTS)
            .filter((p) => isObj(p) && floorMaskAt(result.plan, p))
            .map((p) => ({ ...p, device: p.device || g.device }));
        }
      }
      if (flow) {
        if (units.normBand(flow.band)) result.view.band = units.normBand(flow.band);
        if (flow.speed === true) result.goal.mode = 'speed';
        if (Number.isInteger(flow.goal) && flow.goal > 0) result.goal.room = flow.goal;
      }
      return sanitize(result, { strict: false, lang: opts && opts.lang });
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // auto walls
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Walls for every room edge that is not yet covered by a collinear wall (3 px tolerance), shared edges between
   * neighbouring rooms are added once. Partially covered edges only get the missing piece. Non-destructive: returns
   * the new walls, the plan is not modified.
   * @param {object} plan
   * @param {{defaultMaterial?:string, lang?:'cs'|'en'}} [opts] defaultMaterial: key of WALL_MATERIALS or
   *        'default'/undefined (= follow model.wallLoss)
   * @returns {Array<object>} new wall objects (ids unique within the plan)
   */
  function autoWalls(plan, opts) {
    const o = opts || {};
    const TOL = 3;
    const lang = E.text.lang(o.lang);
    const material = o.defaultMaterial && Object.prototype.hasOwnProperty.call(WALL_MATERIALS, o.defaultMaterial) ? o.defaultMaterial : null;
    const used = planIds(plan);
    const cover = (plan.walls || []).map((w) => [w.a.x * W, w.a.y * H, w.b.x * W, w.b.y * H]);
    const out = [];
    for (const room of plan.rooms || []) {
      const pts = room.points;
      if (!pts || pts.length < 3) continue;
      for (let i = 0; i < pts.length; i++) {
        const A = pts[i];
        const B = pts[(i + 1) % pts.length];
        const ax = A.x * W;
        const ay = A.y * H;
        const len = Math.hypot(B.x * W - ax, B.y * H - ay);
        if (len < TOL) continue;
        const ux = (B.x * W - ax) / len;
        const uy = (B.y * H - ay) / len;
        const covered = [];
        for (const [wx1, wy1, wx2, wy2] of cover) {
          const d1 = Math.abs(ux * (wy1 - ay) - uy * (wx1 - ax));
          const d2 = Math.abs(ux * (wy2 - ay) - uy * (wx2 - ax));
          if (d1 > TOL || d2 > TOL) continue;
          const s1 = ux * (wx1 - ax) + uy * (wy1 - ay);
          const s2 = ux * (wx2 - ax) + uy * (wy2 - ay);
          const lo = Math.max(0, Math.min(s1, s2));
          const hi = Math.min(len, Math.max(s1, s2));
          if (hi > lo) covered.push([lo, hi]);
        }
        covered.sort((p, q) => p[0] - q[0]);
        const gaps = [];
        let cursor = 0;
        for (const [lo, hi] of covered) {
          if (lo - cursor > TOL) gaps.push([cursor, lo]);
          if (hi > cursor) cursor = hi;
        }
        if (len - cursor > TOL) gaps.push([cursor, len]);
        for (const [g0, g1] of gaps) {
          const whole = g0 <= 0 && g1 >= len;
          const a = whole ? { x: A.x, y: A.y } : { x: round((ax + ux * g0) / W), y: round((ay + uy * g0) / H) };
          const b = whole ? { x: B.x, y: B.y } : { x: round((ax + ux * g1) / W), y: round((ay + uy * g1) / H) };
          const id = freeId('wall', used);
          used.add(id);
          const wall = { id, type: 'wall', name: t('engine.name.wall', lang), a, b };
          if (material) {
            wall.material = material;
            wall.loss = WALL_MATERIALS[material];
          }
          out.push(wall);
          cover.push([a.x * W, a.y * H, b.x * W, b.y * H]);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // floors (SPEC 14.3). The ACTIVE floor's plan / nodes / measurements / goal.room / goal.excluded are the top level of
  // the project; every other floor keeps its own inside its `floors[]` entry, the active entry holds null there.
  // ---------------------------------------------------------------------------------------------------------------

  const arr = (v) => (Array.isArray(v) ? v : []);
  const floorsOf = (p) => (isObj(p) && Array.isArray(p.floors) ? p.floors.filter(isObj) : []);
  const byLevel = (a, b) => (isNum(a.level) ? a.level : 0) - (isNum(b.level) ? b.level : 0);

  /** English ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st ... */
  function ordinal(n) {
    const t10 = n % 100;
    const suf = t10 >= 11 && t10 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
    return `${n}${suf}`;
  }

  /**
   * Default name of a floor at a level: 'Přízemí', '1. patro', '2. patro', 'Suterén', '2. suterén' /
   * 'Ground floor', '1st floor', '2nd floor', 'Basement', 'Basement 2'.
   */
  function floorName(level, lang) {
    const l = Number.isInteger(level) ? level : 0;
    const lg = E.text.lang(lang);
    if (l === 0) return t('engine.floor.ground', lg);
    if (l > 0) return t('engine.floor.upper', lg, { n: lg === 'en' ? ordinal(l) : l });
    if (l === -1) return t('engine.floor.basement', lg);
    return t('engine.floor.basementN', lg, { n: -l });
  }

  /**
   * The id of the active floor: the floors[] entry whose content is the top level (plan null), else view.floor, else the
   * first floor; null for a project without floors (a hand-made object - it then behaves as one floor).
   * @param {object} p
   * @returns {string|null}
   */
  function activeFloorId(p) {
    const list = floorsOf(p);
    if (!list.length) return null;
    const hole = list.find((f) => f.plan === null || f.plan === undefined);
    if (hole) return hole.id;
    const v = isObj(p.view) ? p.view.floor : undefined;
    return list.some((f) => f.id === v) ? v : list[0].id;
  }

  /** {room, excluded} of the top level. */
  const topGoal = (p) => {
    const g = isObj(p.goal) ? p.goal : {};
    return { room: g.room !== undefined ? g.room : 'all', excluded: arr(g.excluded) };
  };

  /**
   * Everything of one floor, wherever it is stored (the top level for the active floor). Read-only.
   * @param {object} p project
   * @param {string} [id] floor id (default: the active floor)
   * @returns {{id:string|null, name:string, level:number, ceiling:object, index:number, active:boolean, plan:object,
   *   nodes:object[], measurements:object[], goal:{room:'all'|number, excluded:number[]}}|null} null for an unknown id
   */
  function floorOf(p, id) {
    if (!isObj(p) || !isObj(p.plan)) return null;
    const list = floorsOf(p);
    const act = activeFloorId(p);
    const want = id === undefined || id === null ? act : id;
    if (!list.length) {
      if (want !== act) return null;
      return { id: null, name: '', level: 0, ceiling: { ...CEILING_DEFAULT }, index: 0, active: true, plan: p.plan, nodes: arr(p.nodes), measurements: arr(p.measurements), goal: topGoal(p) };
    }
    const index = list.findIndex((f) => f.id === want);
    if (index < 0) return null;
    const f = list[index];
    const active = f.id === act;
    const fg = isObj(f.goal) ? f.goal : {};
    return {
      id: f.id,
      name: f.name,
      level: f.level,
      ceiling: isObj(f.ceiling) ? f.ceiling : { ...CEILING_DEFAULT },
      index,
      active,
      plan: active ? p.plan : isObj(f.plan) ? f.plan : { rooms: [], walls: [], doors: [], furniture: [], background: null },
      nodes: active ? arr(p.nodes) : arr(f.nodes),
      measurements: active ? arr(p.measurements) : arr(f.measurements),
      goal: active ? topGoal(p) : { room: fg.room !== undefined ? fg.room : 'all', excluded: arr(fg.excluded) },
    };
  }

  /**
   * A shallow, read-only VIEW of the project with floor `id` active (its content at the top level, the real active
   * floor's content moved into its floors[] entry). The project itself for the active / an unknown floor. Pass it to
   * any single-floor function (createContext, analysis.run, speed.homeSummary, ...). Never mutate it.
   * @param {object} p
   * @param {string} id
   * @returns {object}
   */
  function atFloor(p, id) {
    const act = activeFloorId(p);
    if (act === null || id === undefined || id === null || id === act) return p;
    const target = floorOf(p, id);
    if (!target) return p;
    const g = isObj(p.goal) ? p.goal : {};
    const tg = topGoal(p);
    const floors = p.floors.map((f) => {
      if (!isObj(f)) return f;
      if (f.id === act) return { ...f, plan: p.plan, nodes: arr(p.nodes), measurements: arr(p.measurements), goal: tg };
      if (f.id === id) return { ...f, plan: null, nodes: null, measurements: null, goal: null };
      return f;
    });
    return {
      ...p,
      plan: target.plan,
      nodes: target.nodes,
      measurements: target.measurements,
      goal: { ...g, room: target.goal.room, excluded: target.goal.excluded },
      floors,
      view: { ...(isObj(p.view) ? p.view : {}), floor: id },
    };
  }

  /**
   * Make floor `id` the active one - MUTATES the project (call inside a store mutator): the content moves between the
   * top level and the floors[] entries, view.floor follows. Undo-safe: the active floor is always the entry with null
   * content, so a snapshot restore of plan / nodes / measurements / goal / floors stays consistent.
   * @returns {boolean} true when `id` is (now) the active floor
   */
  function switchFloor(p, id) {
    const act = activeFloorId(p);
    if (act === null) return false;
    if (id === act) {
      if (isObj(p.view)) p.view.floor = id;
      return true;
    }
    const list = floorsOf(p);
    const A = list.find((f) => f.id === act);
    const B = list.find((f) => f.id === id);
    if (!A || !B) return false;
    const g = isObj(p.goal) ? p.goal : (p.goal = {});
    A.plan = p.plan;
    A.nodes = arr(p.nodes);
    A.measurements = arr(p.measurements);
    A.goal = topGoal(p);
    const bg = isObj(B.goal) ? B.goal : {};
    p.plan = isObj(B.plan) ? B.plan : { rooms: [], walls: [], doors: [], furniture: [], background: null };
    p.nodes = arr(B.nodes);
    p.measurements = arr(B.measurements);
    g.room = bg.room !== undefined ? bg.room : 'all';
    g.excluded = arr(bg.excluded);
    B.plan = null;
    B.nodes = null;
    B.measurements = null;
    B.goal = null;
    if (!isObj(p.view)) p.view = {};
    p.view.floor = id;
    return true;
  }

  /** A deep copy of a plan without its tracing image (for "Duplikovat půdorys do nového patra"). */
  function copyPlan(plan) {
    const c = JSON.parse(JSON.stringify({ ...plan, background: null }));
    for (const k of ['rooms', 'walls', 'doors', 'furniture']) c[k] = arr(c[k]);
    c.background = null;
    return c;
  }

  /**
   * Add a floor - MUTATES the project. Does not switch to it.
   * @param {object} p
   * @param {{name?:string, level?:number, above?:boolean, copyFrom?:string, lang?:'cs'|'en'}} [opts] level default = above
   *        the highest floor (below the lowest with above:false); a taken level -> the next free one in that direction;
   *        copyFrom = a floor id whose plan (rooms, walls, doors, furniture, excluded rooms) is copied
   * @returns {string|null} the new floor's id, null when MAX_FLOORS is reached or no level is free
   */
  function addFloor(p, opts) {
    const o = opts || {};
    const list = floorsOf(p);
    if (!list.length || list.length >= MAX_FLOORS || !Array.isArray(p.floors)) return null;
    const lang = E.text.lang(o.lang);
    const taken = new Set(list.map((f) => f.level));
    const up = o.above !== false;
    let level = Number.isInteger(o.level) ? clamp(o.level, LEVEL_MIN, LEVEL_MAX) : up ? Math.max(...taken) + 1 : Math.min(...taken) - 1;
    while (taken.has(level)) level += up ? 1 : -1;
    if (level > LEVEL_MAX || level < LEVEL_MIN) {
      level = null;
      for (let d = 0; d <= LEVEL_MAX - LEVEL_MIN && level === null; d++) {
        for (const cand of [Math.max(...taken) + 1 - d, Math.min(...taken) - 1 + d]) if (cand >= LEVEL_MIN && cand <= LEVEL_MAX && !taken.has(cand)) level = cand;
      }
      if (level === null) return null;
    }
    const src = o.copyFrom !== undefined ? floorOf(p, o.copyFrom) : null;
    const near = list.slice().sort((a, b) => Math.abs(a.level - level) - Math.abs(b.level - level) || a.level - b.level)[0];
    const ids = new Set(list.map((f) => f.id));
    const id = freeId('floor', ids);
    p.floors.push({
      id,
      name: cleanText(o.name, 50) || floorName(level, lang),
      level,
      ceiling: cleanCeiling(src ? src.ceiling : near.ceiling),
      plan: src ? copyPlan(src.plan) : { rooms: [], walls: [], doors: [], furniture: [], background: null },
      nodes: [],
      measurements: [],
      goal: { room: 'all', excluded: src ? src.goal.excluded.slice() : [] },
    });
    p.floors.sort(byLevel);
    return id;
  }

  /** "Duplikovat půdorys do nového patra": addFloor above the highest floor with a copy of floor `id`'s plan. MUTATES. */
  function duplicateFloor(p, id, opts) {
    if (!floorOf(p, id)) return null;
    return addFloor(p, { ...(opts || {}), copyFrom: id, above: true, level: undefined });
  }

  /** The visual centre of the first room of a plan (a marker that must go somewhere), else the canvas centre. */
  const planCentre = (plan) => (plan && plan.rooms && plan.rooms.length ? geom.labelPoint(plan.rooms[0].points) : { x: 0.5, y: 0.5 });
  const snapTo = (plan, q) => roundPt(plan && plan.rooms && plan.rooms.length ? nearestFloor(plan, q && isNum(q.x) && isNum(q.y) ? q : planCentre(plan)) : q && isNum(q.x) && isNum(q.y) ? q : planCentre(plan));

  /**
   * Remove a floor - MUTATES the project. Never the last one. The active floor -> the nearest other floor becomes
   * active first; the router / inlet on it move to the active floor (same place, snapped onto its rooms); nodes that
   * uplinked to its nodes uplink to the router.
   * @returns {boolean}
   */
  function removeFloor(p, id) {
    const list = floorsOf(p);
    const f = list.find((x) => x.id === id);
    if (!f || list.length < 2) return false;
    if (activeFloorId(p) === id) {
      const other = list.filter((x) => x.id !== id).sort((a, b) => Math.abs(a.level - f.level) - Math.abs(b.level - f.level) || a.level - b.level)[0];
      switchFloor(p, other.id);
    }
    const gone = new Set(arr(f.nodes).map((n) => n && n.id));
    p.floors.splice(p.floors.indexOf(f), 1);
    const act = activeFloorId(p);
    const net = isObj(p.net) ? p.net : null;
    if (net && net.routerFloor === id) {
      net.routerFloor = act;
      net.router = snapTo(p.plan, net.router);
      net.baseline = snapTo(p.plan, net.baseline);
      if (isObj(p.goal)) p.goal.allowedRoom = 'any';
    }
    if (net && net.opticFloor === id) net.opticFloor = net.routerFloor || act;
    for (const e of allNodes(p)) if (gone.has(e.node.uplink)) e.node.uplink = 'router';
    return true;
  }

  /**
   * Reorder: swap the level of floor `id` with the next floor up (dir +1) or down (-1) - MUTATES. Floors still named by
   * default ("Přízemí", "1. patro" ...) take the default name of their new level.
   * @returns {boolean}
   */
  function moveFloor(p, id, dir) {
    const list = floorsOf(p).slice().sort(byLevel);
    const i = list.findIndex((f) => f.id === id);
    const j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || !dir || j < 0 || j >= list.length) return false;
    const a = list[i];
    const b = list[j];
    const rename = (f, from, to) => {
      for (const lg of ['cs', 'en']) if (f.name === floorName(from, lg)) f.name = floorName(to, lg);
    };
    const la = a.level;
    const lb = b.level;
    rename(a, la, lb);
    rename(b, lb, la);
    a.level = lb;
    b.level = la;
    p.floors.sort(byLevel);
    return true;
  }

  /** Rename a floor - MUTATES. An empty name gives the default name of its level. */
  function renameFloor(p, id, name) {
    const f = floorsOf(p).find((x) => x.id === id);
    if (!f) return false;
    f.name = cleanText(name, 50) || floorName(f.level);
    return true;
  }

  /**
   * Change a floor's ceiling - MUTATES. {material, lossDb, heightM}: a preset material without lossDb takes its default
   * (concrete 15, reinforced 20, wood 8 dB), a number that differs from the preset makes it 'custom'.
   */
  function setCeiling(p, id, c) {
    const f = floorsOf(p).find((x) => x.id === id);
    if (!f || !isObj(c)) return false;
    const cur = cleanCeiling(f.ceiling);
    const material = c.material !== undefined ? c.material : cur.material;
    let lossDb = c.lossDb;
    if (lossDb === undefined) lossDb = c.material !== undefined && CEILING_MATERIALS[c.material] !== undefined ? CEILING_MATERIALS[c.material] : cur.lossDb;
    f.ceiling = cleanCeiling({ material, lossDb, heightM: c.heightM !== undefined ? c.heightM : cur.heightM });
    return true;
  }

  /**
   * The slabs between two floors: levels = |level difference|, heightM = the sum of the storey heights crossed,
   * lossDb = the sum of their ceiling losses (5 GHz reference). A level without a floor (a gap) counts with the defaults.
   * @returns {{levels:number, heightM:number, lossDb:number}}
   */
  function floorGap(p, fromId, toId) {
    const list = floorsOf(p);
    const fa = list.find((f) => f.id === fromId);
    const fb = list.find((f) => f.id === toId);
    if (!fa || !fb || fa === fb) return { levels: 0, heightM: 0, lossDb: 0 };
    const lo = Math.min(fa.level, fb.level);
    const hi = Math.max(fa.level, fb.level);
    let heightM = 0;
    let lossDb = 0;
    for (let L = lo; L < hi; L++) {
      const f = list.find((x) => x.level === L);
      const c = f && isObj(f.ceiling) ? f.ceiling : CEILING_DEFAULT;
      heightM += isNum(c.heightM) ? c.heightM : CEILING_DEFAULT.heightM;
      lossDb += isNum(c.lossDb) ? c.lossDb : CEILING_DEFAULT.lossDb;
    }
    return { levels: hi - lo, heightM, lossDb };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // nodes (SPEC 14.2)
  // ---------------------------------------------------------------------------------------------------------------

  /** The first free name 'AP n' (n >= 2: the router is the first access point). */
  function freeNodeName(used, lang) {
    for (let n = 2; ; n++) {
      const name = t('engine.node.name', lang, { n });
      if (!used.has(name)) return name;
    }
  }

  /**
   * Every node of the building in building order (floors by level, then each floor's list) - the order of the winner
   * indices of the raster and of model.nodeList.
   * @returns {Array<{node:object, floor:string|null, floorName:string, active:boolean, index:number}>}
   */
  function allNodes(p) {
    const out = [];
    if (!isObj(p)) return out;
    const list = floorsOf(p);
    if (!list.length) {
      for (const n of arr(p.nodes)) if (isObj(n)) out.push({ node: n, floor: null, floorName: '', active: true, index: out.length });
      return out;
    }
    const act = activeFloorId(p);
    for (const f of list.slice().sort(byLevel)) {
      const active = f.id === act;
      for (const n of active ? arr(p.nodes) : arr(f.nodes)) if (isObj(n)) out.push({ node: n, floor: f.id, floorName: f.name, active, index: out.length });
    }
    return out;
  }

  /** {node, floor} of a node id anywhere in the building, or null. */
  function nodeById(p, id) {
    const e = allNodes(p).find((x) => x.node.id === id);
    return e ? { node: e.node, floor: e.floor } : null;
  }

  /**
   * A complete new node, NOT added (push it into project.nodes, or use addNode for another floor).
   * @param {object} p
   * @param {{mode?:string, pos?:{x,y}, floor?:string, uplink?:string, lang?:'cs'|'en'}} [opts] mode default 'ap_cable';
   *        pos default = the visual centre of the room farthest from the router and the other nodes on that floor
   *        (floor default = the active floor); bands = the router's bands
   * @returns {object|null} Node, null when the building already has MAX_NODES nodes
   */
  function newNode(p, opts) {
    const o = opts || {};
    if (!isObj(p) || !isObj(p.plan)) return null;
    const lang = E.text.lang(o.lang);
    const all = allNodes(p);
    if (all.length >= MAX_NODES) return null;
    const ids = new Set(all.map((e) => e.node.id));
    const F = (o.floor !== undefined && floorOf(p, o.floor)) || floorOf(p);
    const plan = F.plan;
    const net = isObj(p.net) ? p.net : {};
    const routerHere = F.id === null || !net.routerFloor || net.routerFloor === F.id ? net.router : null;
    const others = all.filter((e) => e.floor === F.id).map((e) => e.node.pos);
    // not in a room that does not count (a balcony): the farthest of the others
    const pos = softPoint(o.pos) || (plan.rooms.length && farthestRoomCentre(plan, routerHere, others, F.goal.excluded)) || { x: 0.5, y: 0.5 };
    const { bands, backhaulBand } = cleanNodeBands(cleanRouterBands(net.routerBands), NODE_BANDS_DEFAULT, 5);
    return {
      id: freeId('node', ids),
      name: freeNodeName(new Set(all.map((e) => e.node.name)), lang),
      mode: NODE_KINDS.includes(o.mode) ? o.mode : 'ap_cable',
      pos: snapTo(plan, pos),
      bands,
      power: 0,
      backhaulBand,
      backhaulThreshold: -67,
      maxMbps: null,
      uplink: typeof o.uplink === 'string' && ids.has(o.uplink) ? o.uplink : 'router',
      enabled: true,
    };
  }

  /** The node list of a floor as stored (the top level for the active floor), created when missing. */
  function nodeListOf(p, floorId) {
    const act = activeFloorId(p);
    if (act === null || floorId === act || floorId === null || floorId === undefined) {
      if (!Array.isArray(p.nodes)) p.nodes = [];
      return p.nodes;
    }
    const f = floorsOf(p).find((x) => x.id === floorId);
    if (!f) return null;
    if (!Array.isArray(f.nodes)) f.nodes = [];
    return f.nodes;
  }

  /**
   * Add a node (newNode's result) to a floor - MUTATES. `floorId` default = the active floor. false when the building
   * is full (MAX_NODES), the id is taken or the floor unknown.
   */
  function addNode(p, node, floorId) {
    if (!isObj(node) || !node.id) return false;
    const all = allNodes(p);
    if (all.length >= MAX_NODES || all.some((e) => e.node.id === node.id)) return false;
    const list = nodeListOf(p, floorId);
    if (!list) return false;
    list.push(node);
    return true;
  }

  /** Remove a node - MUTATES; the nodes that uplinked to it take over its uplink. */
  function removeNode(p, id) {
    const e = allNodes(p).find((x) => x.node.id === id);
    if (!e) return false;
    const list = nodeListOf(p, e.floor);
    list.splice(list.indexOf(e.node), 1);
    for (const o of allNodes(p)) if (o.node.uplink === id) o.node.uplink = e.node.uplink && e.node.uplink !== o.node.id ? e.node.uplink : 'router';
    return true;
  }

  /** Move a node to another floor - MUTATES; the position (default: where it is) is snapped onto that floor's rooms. */
  function moveNodeToFloor(p, id, floorId, pos) {
    const e = allNodes(p).find((x) => x.node.id === id);
    const F = floorOf(p, floorId);
    if (!e || !F) return false;
    if (e.floor !== F.id) {
      const from = nodeListOf(p, e.floor);
      from.splice(from.indexOf(e.node), 1);
      nodeListOf(p, F.id).push(e.node);
    }
    e.node.pos = snapTo(F.plan, softPoint(pos) || e.node.pos);
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // scale (SPEC 14.1)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Floor area of a plan in m². `src` = a plan (then pass mpp) or a project (its active plan, scale.mpp, goal.excluded).
   * @param {object} src
   * @param {number} [mpp]
   * @param {{excluded?:number[]}} [opts] rooms that do not count (balcony; default for a project: goal.excluded)
   * @returns {{areaM2:number, allM2:number, rooms:Array<{roomId:number, name:string, areaM2:number, excluded:boolean}>,
   *   largest:object|null, smallest:object|null}} areaM2 = counted rooms, allM2 = every room; largest / smallest of the
   *   counted rooms
   */
  function planArea(src, mpp, opts) {
    const o = opts || {};
    let plan = src;
    let m = mpp;
    let excluded = o.excluded;
    if (isObj(src) && isObj(src.plan)) {
      plan = src.plan;
      if (!isNum(m)) m = isObj(src.scale) ? src.scale.mpp : undefined;
      if (excluded === undefined) excluded = isObj(src.goal) ? src.goal.excluded : undefined;
    }
    const ex = new Set(arr(excluded));
    const rooms = [];
    let areaM2 = 0;
    let allM2 = 0;
    const k = isNum(m) && m > 0 ? m * m : 0;
    for (const r of isObj(plan) ? arr(plan.rooms) : []) {
      if (!isObj(r) || !Array.isArray(r.points) || r.points.length < 3) continue;
      const a = geom.polygonAreaPx(r.points) * k;
      if (!Number.isFinite(a)) continue;
      const isEx = ex.has(r.roomId);
      rooms.push({ roomId: r.roomId, name: r.name, areaM2: a, excluded: isEx });
      allM2 += a;
      if (!isEx) areaM2 += a;
    }
    const counted = rooms.filter((r) => !r.excluded);
    const pick = (better) => (counted.length ? counted.reduce((b, r) => (better(r.areaM2, b.areaM2) ? r : b)) : null);
    return { areaM2, allM2, rooms, largest: pick((a, b) => a > b), smallest: pick((a, b) => a < b) };
  }

  /** planArea of every floor (each with its own excluded rooms) and their sum. */
  function buildingArea(p) {
    const mpp = isObj(p) && isObj(p.scale) ? p.scale.mpp : undefined;
    const list = floorsOf(p);
    const ids = list.length ? list.slice().sort(byLevel).map((f) => f.id) : [null];
    const floors = [];
    let areaM2 = 0;
    let allM2 = 0;
    for (const id of ids) {
      const F = floorOf(p, id);
      if (!F) continue;
      const a = planArea(F.plan, mpp, { excluded: F.goal.excluded });
      floors.push({ id: F.id, name: F.name, level: F.level, areaM2: a.areaM2, allM2: a.allM2 });
      areaM2 += a.areaM2;
      allM2 += a.allM2;
    }
    return { areaM2, allM2, floors };
  }

  const okMpp = (v) => (isNum(v) && v >= MPP_MIN && v <= MPP_MAX ? Number(v.toPrecision(10)) : null);

  /**
   * The mpp at which the counted rooms of a plan (or the one room `roomId`) have `areaM2` m² - "Plocha bytu v m²",
   * "Tahle místnost má 14 m²". Uniform scaling: the proportions never change.
   * @param {object} plan
   * @param {number} areaM2
   * @param {{excluded?:number[], roomId?:number}} [opts]
   * @returns {number|null} null without rooms, for an area <= 0 or an mpp outside 0.0005..0.2
   */
  function scaleFromArea(plan, areaM2, opts) {
    const o = opts || {};
    if (!isNum(areaM2) || areaM2 <= 0 || !isObj(plan)) return null;
    const ex = new Set(arr(o.excluded));
    let px = 0;
    for (const r of arr(plan.rooms)) {
      if (!isObj(r) || !Array.isArray(r.points) || r.points.length < 3) continue;
      if (o.roomId !== undefined && o.roomId !== null ? r.roomId !== o.roomId : ex.has(r.roomId)) continue;
      const a = geom.polygonAreaPx(r.points);
      if (Number.isFinite(a)) px += a;
    }
    return px > 0 ? okMpp(Math.sqrt(areaM2 / px)) : null;
  }

  /** The mpp at which two normalized points are `metres` apart (two points / one wall); null when unusable. */
  function scaleFromLength(a, b, metres) {
    if (!softPoint(a) || !softPoint(b) || !isNum(metres) || metres <= 0) return null;
    const d = geom.dist(a, b);
    return d >= 1 ? okMpp(metres / d) : null;
  }

  /** The mpp at which the rooms' bounding box is `metres` wide ("Šířka celého půdorysu"). */
  function scaleFromWidth(plan, metres) {
    return isNum(metres) && metres > 0 && isObj(plan) ? okMpp(deriveMpp(plan, metres)) : null;
  }

  /**
   * Set a verified scale - MUTATES: scale = {mpp, verified:true, method, ref}. false (nothing changed) for an unusable
   * mpp. method default: the current one (or 'two-points').
   */
  function setScale(p, s) {
    const o = isObj(s) ? s : {};
    const mpp = okMpp(o.mpp);
    if (!isObj(p) || mpp === null) return false;
    const cur = isObj(p.scale) ? p.scale.method : null;
    const method = SCALE_METHODS.includes(o.method) ? o.method : SCALE_METHODS.includes(cur) ? cur : 'two-points';
    p.scale = { mpp, verified: true, method, ref: cleanScaleRef(method, o.ref) };
    return true;
  }

  /** The user confirmed the scale as it is ("Sedí") - MUTATES. */
  function confirmScale(p) {
    if (!isObj(p) || !isObj(p.scale) || !okMpp(p.scale.mpp)) return false;
    p.scale.verified = true;
    return true;
  }

  /**
   * Sanity checks of the scale (SPEC 14.1), in this order: 'unverified'; 'areaSmall' / 'areaLarge' (the building's
   * counted area); then per floor (the active one first) 'roomSmall' / 'roomLarge' (counted rooms) and 'doorNarrow' /
   * 'doorWide'. Only 'unverified' for a plan without rooms.
   * @param {object} p
   * @param {{limits?:object}} [opts] overrides of SCALE_LIMITS
   * @returns {Array<{code:string, floor?:string|null, roomId?:number, doorId?:string, name?:string, value?:number, limit?:number}>}
   */
  function scaleIssues(p, opts) {
    const L = { ...SCALE_LIMITS, ...(opts && isObj(opts.limits) ? opts.limits : {}) };
    const out = [];
    if (!isObj(p) || !isObj(p.plan)) return out;
    if (!isObj(p.scale) || p.scale.verified !== true) out.push({ code: 'unverified' });
    const mpp = isObj(p.scale) ? p.scale.mpp : NaN;
    if (!isNum(mpp) || mpp <= 0) return out;
    const b = buildingArea(p);
    if (!(b.allM2 > 0)) return out;
    if (b.areaM2 < L.areaMin) out.push({ code: 'areaSmall', value: b.areaM2, limit: L.areaMin });
    else if (b.areaM2 > L.areaMax) out.push({ code: 'areaLarge', value: b.areaM2, limit: L.areaMax });
    const act = activeFloorId(p);
    const ids = [act].concat(b.floors.map((f) => f.id).filter((id) => id !== act));
    for (const id of ids) {
      const F = floorOf(p, id);
      if (!F) continue;
      for (const r of planArea(F.plan, mpp, { excluded: F.goal.excluded }).rooms) {
        if (r.excluded) continue;
        if (r.areaM2 < L.roomMin) out.push({ code: 'roomSmall', floor: F.id, roomId: r.roomId, name: r.name, value: r.areaM2, limit: L.roomMin });
        else if (r.areaM2 > L.roomMax) out.push({ code: 'roomLarge', floor: F.id, roomId: r.roomId, name: r.name, value: r.areaM2, limit: L.roomMax });
      }
      for (const d of arr(F.plan.doors)) {
        if (!isObj(d) || !softPoint(d.a) || !softPoint(d.b)) continue;
        // to the centimetre: a door drawn exactly 60 cm wide is not too narrow
        const w = round(geom.dist(d.a, d.b) * mpp, 2);
        if (w < L.doorMin) out.push({ code: 'doorNarrow', floor: F.id, doorId: d.id, name: d.name, value: w, limit: L.doorMin });
        else if (w > L.doorMax) out.push({ code: 'doorWide', floor: F.id, doorId: d.id, name: d.name, value: w, limit: L.doorMax });
      }
    }
    return out;
  }

  /** Deep copy of a project; the (large) background data URLs (every floor's) are shared by reference. */
  function clone(project) {
    const bg = project.plan.background;
    const fl = Array.isArray(project.floors) ? project.floors : null;
    const lite = { ...project, plan: { ...project.plan, background: null } };
    if (fl) lite.floors = fl.map((f) => (isObj(f) && isObj(f.plan) ? { ...f, plan: { ...f.plan, background: null } } : f));
    const copy = JSON.parse(JSON.stringify(lite));
    copy.plan.background = bg;
    if (fl) copy.floors.forEach((f, i) => {
      if (isObj(f) && isObj(f.plan)) f.plan.background = fl[i].plan.background || null;
    });
    return copy;
  }

  E.project = {
    SCHEMA_VERSION,
    BAND_FACTOR,
    MATERIALS,
    WALL_MATERIALS,
    LEGACY_WALL_MATERIALS,
    FURNITURE_KINDS,
    FURNITURE_BANDS,
    BAND_POWER_MIN,
    BAND_POWER_MAX,
    WAN_RATES,
    CABLE_CATEGORIES,
    NODE_MODES,
    NODE_MBPS_MIN,
    NODE_MBPS_MAX,
    STEER_MIN,
    STEER_MAX,
    STEER_DEFAULT,
    ROUTER_BANDS_DEFAULT,
    MAX_LINKS,
    MAX_NODES,
    NODE_KINDS,
    MAX_FLOORS,
    LEVEL_MIN,
    LEVEL_MAX,
    CEILING_MATERIALS,
    CEILING_DEFAULT,
    SCALE_METHODS,
    SCALE_LIMITS,
    ROOM_COLORS,
    MAX_ITEMS,
    CONN_TYPES,
    FIT_METHODS,
    cleanWifi,
    cleanLinks,
    cleanRouterBands,
    cleanDeviceInfo,
    cleanFit,
    macOf,
    create,
    defaults,
    sanitize,
    sanitizeDetailed,
    serialize,
    buildSvg,
    parseSvgText,
    migrateLegacyStorage,
    deriveMpp,
    widthFromMpp,
    autoWalls,
    planBounds,
    roomIndexOf,
    nextRoomId,
    nextId,
    roomAt,
    floorMaskAt,
    nearestFloor,
    clone,
    // SPEC 14: floors
    activeFloorId,
    floorOf,
    atFloor,
    switchFloor,
    addFloor,
    duplicateFloor,
    removeFloor,
    moveFloor,
    renameFloor,
    setCeiling,
    floorName,
    floorGap,
    cleanCeiling,
    // SPEC 14: nodes
    allNodes,
    nodeById,
    newNode,
    addNode,
    removeNode,
    moveNodeToFloor,
    // SPEC 14: scale
    planArea,
    buildingArea,
    scaleFromArea,
    scaleFromLength,
    scaleFromWidth,
    setScale,
    confirmScale,
    scaleIssues,
  };
})();
