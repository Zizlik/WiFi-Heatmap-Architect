/* WiFi Heatmap Architect - engine.project: data model, validation, file formats, floor helpers.
 *
 * Project (v3), see SPEC section 3.1:
 *   { v:3, name, plan:{rooms,walls,doors,furniture,background}, scale:{mpp}, net, node, model, goal, measurements, view }
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
      scale: { mpp: 0.012 },
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
      },
      node: {
        mode: 'none',
        pos: { x: 0.4, y: 0.4 },
        bands: { '2.4': true, '5': true, '6': false },
        power: 0,
        backhaulBand: 5,
        backhaulThreshold: -67,
      },
      model: { nearSignal: -40, n: 2.2, wallLoss: 8, threshold: -67, rangeThreshold: -60, bandPower: { '2.4': 0, '5': 0, '6': 0 } },
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
      view: { band: 5, layer: 'signal', ranges: false, walls: true, furniture: true, labels: true, values: false, calibrate: true, palette: 'default' },
    };
  }

  /**
   * New project from a template.
   * @param {{template?:'demo'|'blank', lang?:'cs'|'en'}} [opts]
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
    return sanitize(E.demo.build(lang), { lang });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sanitize
  // ---------------------------------------------------------------------------------------------------------------

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
    let slices = {}; // v3 slices: scale, net, node, model, goal, measurements, view, name
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

    // ---- plan ---------------------------------------------------------------------------------------------------
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

    // ---- settings -----------------------------------------------------------------------------------------------
    const d = defaults(lang);
    const rb = roomsBBox(plan);

    // scale
    let mpp;
    if (isObj(slices.scale) && isNum(slices.scale.mpp) && slices.scale.mpp > 0) mpp = clamp(slices.scale.mpp, 0.0005, 0.2);
    else {
      const wm = isNum(legacy.width) && legacy.width >= 6 && legacy.width <= 25 ? legacy.width : 12;
      mpp = deriveMpp(plan, wm);
    }
    mpp = Number(mpp.toPrecision(10));

    // net
    const sn = isObj(slices.net) ? slices.net : {};
    const floorCentre = rb ? geom.labelPoint(plan.rooms[0].points) : { x: 0.5, y: 0.5 };
    const snap = (p) => (plan.rooms.length ? nearestFloor(plan, p) : p);
    const routerRaw = softPoint(sn.router) || softPoint(legacy.router) || floorCentre;
    const baselineRaw = softPoint(sn.baseline) || softPoint(legacy.original) || routerRaw;
    const router = roundPt(snap(routerRaw));
    const baseline = roundPt(snap(baselineRaw));
    const optic = softPoint(sn.optic) || softPoint(legacy.optic) || (rb ? { x: round(clamp(rb.minX + 0.02, 0, 1)), y: round((rb.minY + rb.maxY) / 2) } : d.net.optic);
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
    };

    // node
    const sd = isObj(slices.node) ? slices.node : {};
    const sb = isObj(sd.bands) ? sd.bands : {};
    const bands = {
      '2.4': typeof sb['2.4'] === 'boolean' ? sb['2.4'] : d.node.bands['2.4'],
      '5': typeof sb['5'] === 'boolean' ? sb['5'] : d.node.bands['5'],
      '6': typeof sb['6'] === 'boolean' ? sb['6'] : d.node.bands['6'],
    };
    let backhaulBand = units.normBand(sd.backhaulBand) || 5;
    if (!bands[String(backhaulBand)]) {
      const first = E.BANDS.find((b) => bands[String(b)]);
      if (first) backhaulBand = first;
    }
    const nodeMode = NODE_MODES.includes(sd.mode) ? sd.mode : 'none';
    let nodePos = softPoint(sd.pos);
    if (!nodePos) nodePos = farthestRoomCentre(plan, router) || d.node.pos;
    const node = {
      mode: nodeMode,
      pos: roundPt(snap(nodePos)),
      bands,
      power: num(sd.power, -10, 6, 0),
      backhaulBand,
      backhaulThreshold: num(sd.backhaulThreshold, -80, -55, -67),
    };

    // model
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
    };

    // goal
    const sg = isObj(slices.goal) ? slices.goal : {};
    const hasRoom = (id) => Number.isInteger(id) && roomIds.has(id);
    const excluded = [];
    if (Array.isArray(sg.excluded)) {
      for (const id of sg.excluded.slice(0, MAX_ITEMS)) if (hasRoom(id) && !excluded.includes(id)) excluded.push(id);
    }
    const goal = {
      room: hasRoom(sg.room) ? sg.room : 'all',
      allowedRoom: hasRoom(sg.allowedRoom) ? sg.allowedRoom : 'any',
      excluded,
      mode: sg.mode === 'speed' ? 'speed' : 'signal',
      targetDown: num(sg.targetDown, 1, 10000, 50),
      targetUp: num(sg.targetUp, 1, 10000, 50),
      reserve: num(sg.reserve, 0, 80, 30),
      device: cleanText(sg.device, 50) || d.goal.device,
    };

    // measurements
    const measurements = [];
    const mids = new Set();
    const rawMeas = Array.isArray(slices.measurements) ? slices.measurements.slice(0, MAX_MEASUREMENTS) : [];
    for (const m of rawMeas) {
      if (!isObj(m)) continue;
      // a measurement far off the map is dropped (clamping it to the edge would invent a position)
      const p = isNum(m.x) && isNum(m.y) && m.x >= -POINT_TOLERANCE && m.x <= 1 + POINT_TOLERANCE && m.y >= -POINT_TOLERANCE && m.y <= 1 + POINT_TOLERANCE ? softPoint(m) : null;
      const band = units.normBand(m.band);
      if (!p || band === null) continue;
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
        device: cleanText(m.device, 50) || goal.device,
        t: isNum(m.t) && m.t >= 0 ? Math.floor(m.t) : 0,
      };
      // optional extras of the built-in speed test (only present when known, so older records keep their shape)
      const ping = numOrNull(m.ping, 0, 10000);
      const jitter = numOrNull(m.jitter, 0, 10000);
      if (ping !== null) rec.ping = round(ping, 2);
      if (jitter !== null) rec.jitter = round(jitter, 2);
      if (m.source === 'cloudflare') rec.source = 'cloudflare';
      measurements.push(rec);
    }

    // view
    const sv = isObj(slices.view) ? slices.view : {};
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    const view = {
      band: units.normBand(sv.band) || 5,
      layer: LAYERS.includes(sv.layer) ? sv.layer : 'signal',
      ranges: bool(sv.ranges, false),
      walls: bool(sv.walls, true),
      furniture: bool(sv.furniture, true),
      labels: bool(sv.labels, true),
      values: bool(sv.values, false),
      calibrate: bool(sv.calibrate, true),
      palette: PALETTES.includes(sv.palette) ? sv.palette : 'default',
    };

    const project = {
      v: SCHEMA_VERSION,
      name: cleanText(slices.name, 80) || cleanText(src.name, 80) || t('engine.project.name', lang),
      plan,
      scale: { mpp },
      net,
      node,
      model,
      goal,
      measurements,
      view,
    };
    return { project, warnings, svgBackground };
  }

  function roundPt(p) {
    return { x: round(p.x), y: round(p.y) };
  }

  /** Visual centre of the room whose centre is farthest from `from` - a sensible default for a second access point. */
  function farthestRoomCentre(plan, from) {
    let best = null;
    let bestD = -1;
    for (const r of plan.rooms) {
      const c = geom.labelPoint(r.points);
      const d = geom.dist(c, from);
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
    for (const k of ['rooms', 'furniture']) {
      const list = project.plan[k];
      if (Array.isArray(list)) for (const o of list) if (isObj(o) && !geom.validatePolygon(o.points)) throw fail('err.plan.polygon');
    }
    return sanitize(project, { strict: false });
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
        node: project.node,
        model: project.model,
        goal: project.goal,
        measurements: project.measurements,
        view: project.view,
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
      if (geom.dist(project.net.baseline, project.net.router) > 2) s += marker(project.net.baseline, '#c2410c', t('engine.svg.todayLetter', lang), true);
      s += marker(project.net.router, '#dc2626', 'R', false);
      s += marker(project.net.optic, '#2563eb', 'I', false);
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

  /** Deep copy of a project; the (large) background data URL is shared by reference. */
  function clone(project) {
    const bg = project.plan.background;
    const copy = JSON.parse(JSON.stringify({ ...project, plan: { ...project.plan, background: null } }));
    copy.plan.background = bg;
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
    ROOM_COLORS,
    MAX_ITEMS,
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
  };
})();
