/* Planner (Wi-Fi view) 2c: "Prvotní měření" - the guided first-measurement calibration (SPEC 9).
 *   - wizard: (1) the router stands where the red R is -> (2) the band the device is on -> (3) walk to the 4-6 spots of
 *     engine.analysis.suggestSpots (numbered pins on the map, the next one pulses) and press "Změřit vše" at each
 *     (planner.measureAll with its live checklist, saved automatically) -> the result in plain words.
 *     Desktop: a panel at the top of the sidebar; phones: a one-handed bottom sheet over the measuring mode. Progress
 *     (step, band, spots) lives in prefs, so closing the guide or reloading the page resumes where the user left off.
 *   - fit: engine.model.fitProject -> project.model.fit (router strength per band; with enough points also the wall
 *     factor and the distance decay). While a fit exists it follows the measurements (a quiet store.update right after
 *     the change, so the undo step of a measurement restores the matching fit with it); "Vrátit výchozí model" clears it
 *     (undoable).
 *   - sections for the Result card (the fit in plain words, whole-home throughput from engine.speed.homeSummary) and a
 *     throughput chip on the map in the Speed view.
 * Only UI lives here; the numbers come from the engine. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const C = (PL.calib = PL.calib || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const store = () => WH.store;
  const P = () => WH.store.project;
  const W = 1080;
  const H = 942;
  const BANDS = [2.4, 5, 6];
  const PREF = 'planner.calib';
  const N_SPOTS = 5;
  const KINDS = ['near', 'sameRoom', 'oneWall', 'twoWalls', 'far', 'own'];
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const bk = (b) => WH.engine.units.bandKey(b);
  const hasSig = (m) => fin(m.value);
  const reduced = () => !!(WH.util.prefersReducedMotion && WH.util.prefersReducedMotion());
  /** Cheap stable string hash (state keys; not security). */
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const distM = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) * P().scale.mpp;
  const at = (s) => ({ x: fin(s.ax) ? s.ax : s.x, y: fin(s.ay) ? s.ay : s.y });   // where a spot is (to be) measured

  // ---------------------------------------------------------------------------------------------------------------
  // layout: side panel (desktop: the sidebar column is next to the map) or bottom sheet (phones / narrow windows)
  // ---------------------------------------------------------------------------------------------------------------
  const SIDE_MQ = '(min-width: 900px) and (min-height: 560px)';
  const isSheet = () => !(typeof matchMedia === 'function' && matchMedia(SIDE_MQ).matches);

  // ---------------------------------------------------------------------------------------------------------------
  // state (prefs): {v, open, step:'router'|'band'|'measure'|'done', band, cur, spots:[...], key, fin, spotBand, bandTouched}
  //   spot = {id, x, y, kind, state:'todo'|'done'|'skipped', mid (measurement id) | null, ax, ay (where it is measured)}
  // ---------------------------------------------------------------------------------------------------------------
  let state = null;
  /** The plan + today's router position the spots were made for (another plan / baseline starts over). */
  function planKey(p) {
    const rooms = p.plan.rooms.map((r) => r.roomId + ':' + r.points.map((q) => q.x.toFixed(4) + ',' + q.y.toFixed(4)).join(' ')).join('|');
    return hash(rooms + '#' + p.scale.mpp + '#' + PL.posKey(p.net.baseline));
  }
  function load() {
    const s = store().getPref(PREF);
    if (!s || typeof s !== 'object' || s.v !== 1 || !Array.isArray(s.spots)) return null;
    const U = WH.engine.units;
    const ok = (q) => q && fin(q.x) && fin(q.y) && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1;
    const spots = s.spots.filter(ok).slice(0, 16).map((q, i) => ({
      id: typeof q.id === 'string' ? q.id.slice(0, 20) : 's' + (i + 1), x: q.x, y: q.y,
      kind: KINDS.includes(q.kind) ? q.kind : 'spot',
      state: ['todo', 'done', 'skipped'].includes(q.state) ? q.state : 'todo',
      mid: typeof q.mid === 'string' ? q.mid.slice(0, 80) : null,
      ax: fin(q.ax) ? q.ax : null, ay: fin(q.ay) ? q.ay : null,
    }));
    return {
      v: 1, open: !!s.open, step: ['router', 'band', 'measure', 'done'].includes(s.step) ? s.step : 'router', band: U.normBand(s.band) || 5,
      cur: Number.isInteger(s.cur) ? s.cur : 0, spots, key: String(s.key || ''), fin: !!s.fin,
      spotBand: U.normBand(s.spotBand) || null, bandTouched: !!s.bandTouched,
    };
  }
  /** Store the progress - only when it changed: every saved pref is a store event, and the entry buttons re-read the
   *  progress on store events (an unconditional save there would call itself forever). */
  function save() {
    if (!state) return;
    // a deep copy: the spots are changed in place, a shared array would always compare equal to itself
    const json = JSON.stringify(state);
    let same = false;
    try { same = JSON.stringify(store().getPref(PREF, null)) === json; } catch (e) { same = false; }
    if (!same) store().setPref(PREF, JSON.parse(json));
  }
  function fresh(p) { return { v: 1, open: false, step: 'router', band: WH.engine.units.normBand(p.view.band) || 5, cur: 0, spots: [], key: planKey(p), fin: false, spotBand: null, bandTouched: false }; }
  /** The saved progress still fits the project (same plan + baseline), else it starts over. A measurement that is gone
   *  (deleted, undone) puts its spot back on the list. */
  function validate() {
    const p = P();
    if (!p) return;
    if (!state) state = load();
    if (!state) return;
    if (state.key !== planKey(p)) { const o = state.open; state = fresh(p); state.open = o; save(); return; }
    const ids = new Set(p.measurements.map((m) => m.id));
    let changed = false;
    state.spots.forEach((s, i) => {
      if (s.state === 'done' && s.mid && !ids.has(s.mid)) {
        // undone / deleted: that spot is the one to measure (again)
        if (!changed) state.cur = i;
        s.state = 'todo';
        s.mid = null;
        changed = true;
      }
    });
    // a measurement of the finished guide was undone: back to measuring that spot (finishing early stays finished)
    if (changed && state.step === 'done') state.step = 'measure';
    if ((state.cur >= state.spots.length || state.cur < 0) && state.cur !== 0) { state.cur = 0; changed = true; }
    if (changed) save();
  }
  const counts = () => {
    const sp = state ? state.spots : [];
    return { n: sp.length, done: sp.filter((s) => s.state === 'done').length, todo: sp.filter((s) => s.state === 'todo').length };
  };
  /** Progress worth resuming: {done, n, fin} once spots exist. */
  C.progress = () => { validate(); const c = counts(); return state && state.step !== 'router' && c.n ? { done: c.done, n: c.n, fin: state.fin } : null; };
  C.finished = () => { validate(); return !!(state && state.fin); };
  C.isOpen = () => !!(state && state.open && panel && panel.root.isConnected);
  C.state = () => state;

  // ---------------------------------------------------------------------------------------------------------------
  // suggested spots: engine.analysis.suggestSpots (walking order near, sameRoom, oneWall, twoWalls, far)
  // ---------------------------------------------------------------------------------------------------------------
  function makeSpots(p, band) {
    const A = WH.engine.analysis;
    let list = [];
    if (A && typeof A.suggestSpots === 'function') {
      try { list = A.suggestSpots(PL.ensureCtx(p), p, { band, count: N_SPOTS, offsets: PL.S.offs || undefined }) || []; } catch (e) { PL.report(e, 'wizard.spots', { bug: true }); list = []; }
    }
    const spots = list.filter((s) => s && fin(s.x) && fin(s.y)).map((s, i) => ({ id: 's' + (i + 1), x: s.x, y: s.y, kind: KINDS.includes(s.kind) ? s.kind : 'spot', state: 'todo', mid: null, ax: null, ay: null }));
    for (let i = 0; i < spots.length; i++) spots[i] = offLabel(p, spots[i], spots);
    // a spot that was measured already (same band, within 1.2 m) counts as done
    const used = new Set();
    for (const s of spots) {
      const m = p.measurements.find((x) => !used.has(x.id) && x.band === band && distM(x, s) <= 1.2);
      if (m) { used.add(m.id); s.state = 'done'; s.mid = m.id; s.ax = m.x; s.ay = m.y; }
    }
    return spots;
  }

  /** A spot at (or near) a room's visual centre sits right where the map writes the room's name (the weakest-room spot
   *  usually; in a narrow hall the near one too). Move such a pin 0.6-1.2 m aside (same room, >= 0.3 m from walls, not in
   *  furniture, apart from the other pins) so both stay legible; the user measures wherever he actually stands anyway. */
  function offLabel(p, s, all) {
    const E = WH.engine;
    const G = E.geom;
    const room = E.project.roomAt(p.plan, s);
    if (!room) return s;
    const lp = G.labelPoint(room.points);
    if (distM(lp, s) >= 0.55) return s;
    const mpp = p.scale.mpp;
    const clear = 0.3 / mpp;
    const walls = p.plan.walls.filter((w) => w && w.a && w.b);
    const D = Math.SQRT1_2;
    // below / above / beside the name first, then the diagonals; a little further when a narrow room (a hall) needs it
    for (const m of [0.8, 0.6, 1.0, 1.2]) {
      const step = m / mpp;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [D, D], [-D, D], [D, -D], [-D, -D]]) {
        const q = { x: PL.r6(s.x + (dx * step) / W), y: PL.r6(s.y + (dy * step) / H) };
        if (E.project.roomAt(p.plan, q) !== room || G.signedDistPx(q, room.points) < clear || distM(lp, q) < 0.55) continue;
        if (p.plan.furniture.some((f) => Array.isArray(f.points) && f.points.length > 2 && G.pointInPolygon(q, f.points))) continue;
        if (walls.some((w) => G.pointSegDistPx(q.x * W, q.y * H, w.a.x * W, w.a.y * H, w.b.x * W, w.b.y * H) < clear)) continue;
        if (all.some((o) => o !== s && distM(o, q) < 1.2)) continue;
        return { ...s, x: q.x, y: q.y };
      }
    }
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the fit (engine.model.fitProject) and what it means in plain words
  // ---------------------------------------------------------------------------------------------------------------
  let base = { key: '', ctx: null };
  /** Context of the DEFAULT model (the fit ignored): "how far off was the map before". */
  function baseCtx(p) {
    const key = hash(JSON.stringify([p.plan.rooms, p.plan.walls, p.plan.doors, p.plan.furniture, p.scale, { ...p.model, fit: null }]));
    if (key !== base.key || !base.ctx) base = { key, ctx: WH.engine.model.createContext(p, { fit: false }) };
    return base.ctx;
  }
  /** Bands with >= 2 measured signals (what a fit is made from). */
  const fitBands = (p) => BANDS.filter((b) => p.measurements.filter((m) => m.band === b && hasSig(m)).length >= 2);
  /** A fresh fit of the measurements (the object to store), null when there is too little, undefined without the API. */
  function computeFit(p) {
    const M = WH.engine.model;
    if (typeof M.fitProject !== 'function') return undefined;
    if (!fitBands(p).length) return null;
    try { return M.fitProject(p) || null; } catch (e) { PL.report(e, 'wizard.fit', { bug: true }); return undefined; }
  }
  const fitSig = (f) => (f ? JSON.stringify({ ...f, at: 0 }) : 'null');
  let syncKey = '';
  let selfUpdate = false;
  let syncQueued = false;
  /** What the fit depends on: geometry, scale, baseline, the measured signals, the device, the model parameters. */
  function depKey(p) {
    const ms = p.measurements.filter(hasSig).map((m) => [m.id, m.x, m.y, m.band, m.value, m.device]);
    return hash(JSON.stringify([p.plan.rooms, p.plan.walls, p.plan.doors, p.plan.furniture, p.scale, p.net.baseline, ms, p.goal.device, { ...p.model, fit: null }]));
  }
  /**
   * Keep project.model.fit in step with what it was made from - only while a fit exists, or while the guide is measuring
   * (its measurements make the first fit). Not an undo step of its own: it belongs to the change that caused it, and
   * undoing that change restores the old fit together with it (snapshots).
   */
  function syncFit(force) {
    const p = P();
    if (!p || store().gestureOpen) return;
    const active = !!(state && C.isOpen() && state.step === 'measure' && state.key === planKey(p));
    if (!p.model.fit && !active && !force) { syncKey = ''; return; }
    const k = depKey(p);
    if (!force && k === syncKey) return;
    syncKey = k;
    const f = computeFit(p);
    if (f === undefined) return;
    if (fitSig(f) === fitSig(p.model.fit || null)) return;
    selfUpdate = true;
    PL.S.geomDirty = true;
    try { store().update((pr) => { if (f) pr.model.fit = f; else delete pr.model.fit; }, ['model'], { quiet: true }); } finally { selfUpdate = false; }
  }
  const queueSync = () => { if (syncQueued) return; syncQueued = true; queueMicrotask(() => { syncQueued = false; syncFit(false); }); };

  /** "Upravit model podle měření" (Result card; undoable). */
  function applyFit() {
    const f = computeFit(P());
    if (!f) { ui().toast({ i18n: 'planner.cw.needSig' }, { kind: 'warn' }); return; }
    PL.S.geomDirty = true;
    if (store().commit('planner.undo.fit', (pr) => { pr.model.fit = f; if (pr.view.calibrate === false) pr.view.calibrate = true; }, ['model'])) {
      syncKey = depKey(P());
      ui().toast({ i18n: 'planner.cw.applyDone', action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.fit') { PL.S.geomDirty = true; store().undo(); } } } }, { kind: 'ok' });
    }
  }
  C.applyFit = applyFit;
  /** "Vrátit výchozí model": clears project.model.fit (undoable). */
  function resetFit() {
    PL.S.geomDirty = true;
    if (store().commit('planner.undo.fitReset', (pr) => { delete pr.model.fit; }, ['model'])) {
      syncKey = depKey(P());
      ui().toast({ i18n: 'planner.cw.resetDone', action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.fitReset') { PL.S.geomDirty = true; store().undo(); } } } }, { kind: 'ok' });
    }
  }
  C.resetFit = resetFit;

  /** RMS of (measured - default model, no calibration at all) over the points a band's fit used: "before" for fits
   *  stored without the engine's own before.looRms. */
  let beforeCache = { key: '', v: {} };
  function rmsBefore(p, band) {
    const f = p.model.fit;
    const e = f && f.byBand && f.byBand[bk(band)];
    const key = depKey(p) + fitSig(f);
    if (beforeCache.key !== key) beforeCache = { key, v: {} };
    if (beforeCache.v[band] !== undefined) return beforeCache.v[band];
    const M = WH.engine.model;
    const out = new Set(e && Array.isArray(e.outliers) ? e.outliers.map(String) : []);
    const all = p.measurements.filter((m) => m.band === band && hasSig(m) && !out.has(String(m.id)));
    const dev = M.profileKey(p.goal.device);
    const own = all.filter((m) => M.profileKey(m.device) === dev);
    const list = own.length ? own : all;
    let v = NaN;
    if (list.length) {
      const ctx = baseCtx(p);
      let ss = 0;
      for (const m of list) { const r = m.value - M.softRawSignal(ctx, p.net.baseline, m, band); ss += r * r; }
      v = Math.sqrt(ss / list.length);
    }
    beforeCache.v[band] = v;
    return v;
  }

  /** The stored fit per band: [{band, offset, loo, count, full}] (full = the band took part in the n / wall fit). */
  function fitRows(p) {
    const f = p.model.fit;
    if (!f || !f.byBand) return [];
    return BANDS.map((b) => {
      const x = f.byBand[bk(b)];
      if (!x || !fin(x.offset)) return null;
      // before = the engine's like-for-like number: the default model (plain median offset) on the same points, left out one by one
      const before = x.before && fin(x.before.looRms) ? x.before.looRms : NaN;
      return { band: b, offset: x.offset, loo: fin(x.looRms) ? x.looRms : fin(x.rms) && x.count > 1 ? x.rms : NaN, before, count: fin(x.count) ? x.count : 0, full: fin(x.n) };
    }).filter(Boolean);
  }
  /** Measurements far (> 12 dB) from the tuned model: the fit's outliers + what the live calibration flags now. */
  function outliers(p) {
    const f = p.model.fit;
    const ids = new Set();
    if (f && f.byBand) for (const x of Object.values(f.byBand)) if (x && Array.isArray(x.outliers)) x.outliers.forEach((id) => ids.add(String(id)));
    const cal = PL.S.cal || {};
    const dev = new Map();
    for (const k of Object.keys(cal)) {
      const c = cal[k];
      if (!c || !Array.isArray(c.used)) continue;
      for (const u of c.used) { dev.set(String(u.id), u.residual - c.offset); if (u.outlier) ids.add(String(u.id)); }
    }
    return p.measurements.filter((m) => ids.has(String(m.id))).map((m) => ({ m, d: dev.has(String(m.id)) ? dev.get(String(m.id)) : NaN }))
      .sort((a, b) => Math.abs(b.d || 0) - Math.abs(a.d || 0));
  }

  /** Plain-language lines for the fit {lines:[{k, text}], next} (k: str | walls | decay | acc | method), or null. */
  function fitText(p) {
    const rows = fitRows(p);
    if (!rows.length) return null;
    const f = p.model.fit;
    const multi = rows.length > 1;
    const pre = (r) => (multi ? t('planner.cw.band', { b: PL.band(r.band) }) + ': ' : '');
    const lines = [];
    for (const r of rows) {
      const o = Math.round(r.offset);
      const d = WH.util.fmt(Math.abs(o), 0) + WH.util.NBSP + 'dB';
      lines.push({ k: 'str', text: pre(r) + t(o >= 1 ? 'planner.cw.str.up' : o <= -1 ? 'planner.cw.str.down' : 'planner.cw.str.same', { d }) });
    }
    const full = f.method === 'offset+n+walls' && rows.some((r) => r.full);
    const fitted = f.fitted || {};
    if (full && fitted.wallFactor && fin(f.wallFactor)) {
      const pct = Math.round((f.wallFactor - 1) * 100);
      lines.push({ k: 'walls', text: t(pct >= 8 ? 'planner.cw.walls.more' : pct <= -8 ? 'planner.cw.walls.less' : 'planner.cw.walls.same', { p: WH.util.fmtPct(Math.abs(pct)) }) });
    }
    if (full && fitted.n && fin(f.n) && Math.abs(f.n - p.model.n) >= 0.2) lines.push({ k: 'decay', text: t(f.n > p.model.n ? 'planner.cw.decay.faster' : 'planner.cw.decay.slower') });
    // accuracy: the leave-one-out error says something from 3 points on; "before" only when it really was worse
    for (const r of rows) {
      if (!fin(r.loo) || r.count < 3) continue;
      const a = Math.max(1, Math.round(r.loo));
      const b0 = fin(r.before) ? r.before : rmsBefore(p, r.band);
      const b = fin(b0) ? Math.max(1, Math.round(b0)) : NaN;
      lines.push({ k: 'acc', text: pre(r) + (fin(b) && b > a ? t('planner.cw.acc', { a: WH.util.fmt(a, 0), b: WH.util.fmt(b, 0) }) : t('planner.cw.accOnly', { a: WH.util.fmt(a, 0) })) });
    }
    const n = rows.reduce((s, r) => s + r.count, 0);
    lines.push({ k: 'method', text: t(full ? 'planner.cw.method.full' : 'planner.cw.method.offset', { n }) });
    // what to do next
    let next;
    const out = outliers(p);
    const loo = Math.max(0, ...rows.map((r) => (fin(r.loo) ? r.loo : 0)));
    if (p.view.calibrate === false) next = t('planner.cw.next.off');
    else if (out.length) next = t('planner.cw.next.outlier', { name: out[0].m.name, d: fin(out[0].d) ? PL.db(out[0].d) : '> 12' + WH.util.NBSP + 'dB' });
    else if (loo > 6) next = t('planner.cw.next.rough');
    else if (!full) next = t('planner.cw.next.more', { n: Math.max(1, 4 - Math.max(...rows.map((r) => r.count))) });
    else next = t('planner.cw.next.good');
    return { lines, next, full };
  }
  C.fitText = fitText;

  // ---------------------------------------------------------------------------------------------------------------
  // whole-home throughput (engine.speed.homeSummary on the analysis the map shows)
  // ---------------------------------------------------------------------------------------------------------------
  let tpCache = { key: '', v: null };
  /** {coverage, today?, rooms:[{id,name,down,up}], weak:{x,y,room,down,up}|null, planShare|null, planKnown, count, band}
   *  for the band on the map, or null (no speed curve / a second node / no analysis yet). */
  function homeData() {
    const p = P();
    const S = PL.S;
    const a = S.a;
    const E = WH.engine;
    if (!p || !a || !p.plan.rooms.length || typeof E.speed.homeSummary !== 'function') return null;
    if (S.q === 'coarse') return tpCache.v;   // while dragging: the last full-quality numbers
    const g = p.goal;
    const lim = PL.speedLimits(p);
    const key = [S.offsKey, a.ctx.version, a.band, a.params.trial.router.x, a.params.trial.router.y, a.params.today.router.x, a.params.today.router.y, p.node.mode,
      g.targetDown, g.targetUp, g.device, JSON.stringify(lim), g.room, g.excluded.join(','), a.grid.cell, a.trial.length].join('|');
    if (key === tpCache.key) return tpCache.v;
    tpCache = { key, v: null };
    if (p.node.mode !== 'none') return null;
    let meas;
    try { meas = PL.filledMeasurements(); } catch (e) { return null; }
    // Auto (SPEC 13): the per-band curves, every place on the band a steering device would use
    const curve = PL.speedCurve(a.band, meas).curve;
    if (!curve) return null;
    const auto = E.model.isAuto(a.band);
    const target = { targetDown: g.targetDown, targetUp: g.targetUp, roomIds: a.targetRooms, excluded: g.excluded };
    let r;
    try { r = E.speed.homeSummary(a.ctx, a.grid, a.params.trial, curve, lim, target, a.trial); } catch (e) { PL.report(e, 'wizard.throughput', { bug: true }); return null; }
    if (!r || !r.supported) return null;
    const v = {
      coverage: r.areaMeetingTarget,
      rooms: r.perRoom.map((x) => ({ id: x.roomId, name: PL.roomName(x.roomId), down: x.medianDown, up: x.medianUp })),
      weak: r.weakest ? { x: r.weakest.x, y: r.weakest.y, room: PL.roomName(r.weakest.roomId), down: r.weakest.down, up: r.weakest.up } : null,
      planKnown: r.planCap.down !== null || r.planCap.up !== null,
      planShare: r.planLimitedShare,
      // the plan itself is slower than the target: no Wi-Fi can meet it (say that instead of "0 %" alone)
      planBelow: (r.planCap.down !== null && r.planCap.down < g.targetDown) || (r.planCap.up !== null && r.planCap.up < g.targetUp),
      planCap: r.planCap,
      // typical speed of the whole home: which direction keeps the target out of reach
      medDown: r.medianDown, medUp: r.medianUp, tDown: g.targetDown, tUp: g.targetUp,
      count: (!auto && curve.count) || meas.filter((m) => (auto || m.band === a.band) && fin(m.download) && fin(m.upload)).length,
      band: a.band,
    };
    if (PL.moved()) {
      try { const r0 = E.speed.homeSummary(a.ctx, a.grid, a.params.today, curve, lim, target, a.today); if (r0 && r0.supported) v.today = r0.areaMeetingTarget; } catch (e) { /* the trial numbers stay */ }
    }
    tpCache.v = v;
    return v;
  }
  C.homeData = homeData;
  const weakText = (w) => t('planner.tp.weakShown', { room: w.room || t('planner.tp.unknownRoom'), d: fin(w.down) ? PL.mbps(w.down) : '—', u: fin(w.up) ? PL.mbps(w.up) : '—' });

  /** Pan the map so a point is in the middle of the visible map and ring it for a moment. */
  function showSpot(q, label) {
    const st = PL.stage;
    if (!st || !q) return;
    if (isSheet() && !(PL.mm && PL.mm.active)) {
      const r0 = st.el.getBoundingClientRect();
      if (r0.top < 0 || r0.top > 120) window.scrollBy({ top: r0.top - 64, behavior: reduced() ? 'auto' : 'smooth' });
    }
    requestAnimationFrame(() => {
      const r = st.el.getBoundingClientRect();
      const c = PL.toClient(q);
      const dx = r.left + r.width / 2 - c.x;
      const dy = r.top + r.height / 2 - c.y;
      if (Math.abs(dx) > 40 || Math.abs(dy) > 40) PL.panBy(dx, dy);
      ring(q);
      if (label) ui().announce(label);
    });
  }
  C.showSpot = showSpot;
  let ringEl = null;
  let ringTimer = 0;
  function ring(q) {
    const st = PL.stage;
    if (!st) return;
    if (!ringEl) ringEl = el('div.pl-cring', { 'aria-hidden': 'true' });
    ringEl._q = q;
    st.layer.append(ringEl);
    ringEl.classList.remove('is-on');
    void ringEl.offsetWidth;
    ringEl.classList.add('is-on');
    placeRing();
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => { if (ringEl) ringEl.remove(); }, 4200);
  }
  function placeRing() {
    if (!ringEl || !ringEl.isConnected || !PL.stage) return;
    const s = PL.stage.vp.toScreen(ringEl._q);
    ringEl.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px) translate(-50%,-50%)`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sections for the sidebar (Result card) and the guide's last step - each element has .sync(q)
  // ---------------------------------------------------------------------------------------------------------------
  /** The tuned model in plain words, the "from measurements / default model" toggle and "back to the default model". */
  C.resultSection = function resultSection(opts) {
    const o = opts || {};
    const lines = el('ul.pl-fit__lines');
    const next = el('p.pl-fit__next');
    const cmp = ui().segmented([{ value: 'fit', i18n: 'planner.cw.cmp.fit' }, { value: 'def', i18n: 'planner.cw.cmp.def' }], {
      value: P().view.calibrate === false ? 'def' : 'fit', size: 'sm', aria: 'planner.cw.cmp.aria',
      onChange: (v) => { PL.S.geomDirty = true; PL.setView({ calibrate: v === 'fit' }); },
    });
    const reset = ui().button({ i18n: 'planner.cw.reset', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: resetFit });
    const apply = ui().button({ i18n: 'planner.cw.apply', icon: 'sparkles', size: 'sm', variant: 'soft', onClick: applyFit });
    const body = el('div.pl-fit__body', lines, el('div.pl-fit__nextbox', el('span.pl-fit__nextt', t('planner.cw.nextT')), next),
      el('div.pl-fit__cmp', el('span.pl-fit__cmpl', t('planner.cw.cmp')), cmp), el('div.cluster.pl-fit__acts', reset));
    const head = o.inWizard ? null : el('div.pl-cap.pl-fit__cap', el('span', t('planner.cw.sec')), ui().hint('calibration'));
    const root = el('div.pl-fit' + (o.inWizard ? '.pl-fit--wizard' : ''), head, body, apply);
    let key = '';
    root.sync = (q) => {
      const p = P();
      const has = !!p.model.fit;
      const canApply = !has && typeof WH.engine.model.fitProject === 'function' && fitBands(p).length > 0;
      if (q === 'coarse' && key) return;
      const k = [has ? fitSig(p.model.fit) : '', canApply, p.view.calibrate, WH.i18n.lang, PL.S.offsKey].join('|');
      if (k === key) return;
      key = k;
      const ft = has ? fitText(p) : null;
      root.hidden = !ft && !canApply && !o.inWizard;
      body.hidden = !ft;
      apply.hidden = !canApply;
      cmp.setValue(p.view.calibrate === false ? 'def' : 'fit', true);
      if (!ft) { lines.replaceChildren(); next.textContent = ''; return; }
      const ico = { str: 'router', walls: 'wall', decay: 'signal', acc: 'target', method: 'info' };
      lines.replaceChildren(...ft.lines.map((x) => el('li.pl-fit__line.pl-fit__line--' + x.k, el('span.pl-fit__ico', ui().icon(ico[x.k] || 'info', 16)), el('span', x.text))));
      next.textContent = ft.next;
    };
    return root;
  };

  /** "Propustnost bytu": share of the floor meeting the target, typical speed per room, the weakest spot, the plan. */
  C.throughputSection = function throughputSection() {
    const lead = el('p.pl-tp__lead');
    const today = el('p.pl-tp__today.text-sm.text-muted');
    const rooms = el('div.pl-tp__rooms');
    const weak = el('button.pl-tp__weak', { type: 'button' });
    const note = el('p.pl-tp__note');
    const block = el('p.pl-tp__block.text-sm');
    const basis = el('p.pl-tp__basis');
    const root = el('div.pl-tp', { hidden: true },
      el('div.pl-cap', el('span', t('planner.tp.title')), ui().hint('homeSpeed')), lead, today, weak,
      block, el('div.pl-tp__sub', t('planner.tp.rooms')), rooms, note, basis);
    weak.addEventListener('click', () => { if (weak._v) showSpot(weak._v, weakText(weak._v)); });
    let key = '';
    root.sync = () => {
      const p = P();
      const v = homeData();
      root.hidden = !v;
      if (!v) { key = ''; return; }
      const k = JSON.stringify([v, WH.i18n.lang, p.goal.targetDown, p.goal.targetUp, p.view.calibrate, !!p.model.fit]);
      if (k === key) return;
      key = k;
      const pct = WH.util.fmtPct;
      lead.textContent = t('planner.tp.lead', { d: PL.mbps(p.goal.targetDown), u: PL.mbps(p.goal.targetUp), v: pct(v.coverage) });
      today.hidden = !fin(v.today);
      if (fin(v.today)) today.textContent = t('planner.tp.today', { v: pct(v.today) });
      const sp = (d, u) => el('span.pl-tp__sp', el('span.pl-sp', ui().icon('download', 16), el('b.num', PL.mbps(d))), el('span.pl-sp', ui().icon('upload', 16), el('b.num', PL.mbps(u))));
      rooms.replaceChildren(...v.rooms.map((r) => el('div.pl-tp__room', el('span.pl-tp__name', r.name), sp(r.down, r.up))));
      weak.hidden = !v.weak;
      weak._v = v.weak;
      if (v.weak) {
        const room = v.weak.room || t('planner.tp.unknownRoom');
        const below = !fin(v.weak.down) || !fin(v.weak.up);
        weak.replaceChildren(el('span.pl-tp__wico', ui().icon('target', 16)), el('span.pl-tp__wt', el('span.pl-tp__wl', t('planner.tp.weak')), el('span.pl-tp__wr', room)),
          below ? el('span.pl-tp__below', t('planner.tp.weakUnknown')) : sp(v.weak.down, v.weak.up));
        weak.setAttribute('aria-label', t('planner.tp.weakAria', { room, d: fin(v.weak.down) ? PL.mbps(v.weak.down) : '—', u: fin(v.weak.up) ? PL.mbps(v.weak.up) : '—' }));
      }
      note.textContent = v.planBelow ? t('planner.tp.planBelow', { d: fin(v.planCap.down) ? PL.mbps(v.planCap.down) : '—', u: fin(v.planCap.up) ? PL.mbps(v.planCap.up) : '—' })
        : v.planKnown ? (fin(v.planShare) && v.planShare >= 10 ? t('planner.tp.planLimit', { v: pct(v.planShare) }) : '') : t('planner.tp.planUnknown');
      note.hidden = !note.textContent;
      // most of the home misses the target although one direction would be fine: say which one holds it back
      let bk = '';
      if (!v.planBelow && fin(v.coverage) && v.coverage < 50) {
        const dOk = fin(v.medDown) && v.medDown >= v.tDown;
        const uOk = fin(v.medUp) && v.medUp >= v.tUp;
        if (dOk && fin(v.medUp) && !uOk) bk = t('planner.tp.upBlocks', { v: PL.mbps(v.medUp), t: PL.mbps(v.tUp) });
        else if (uOk && fin(v.medDown) && !dOk) bk = t('planner.tp.downBlocks', { v: PL.mbps(v.medDown), t: PL.mbps(v.tDown) });
      }
      block.textContent = bk;
      block.hidden = !bk;
      basis.textContent = t('planner.tp.basis', { n: v.count || 0, b: PL.bandText(v.band) }) + (p.model.fit && p.view.calibrate !== false ? ' ' + t('planner.tp.fitted') : '');
    };
    return root;
  };

  const entryLabel = (idle) => { const pr = C.progress(); return pr && !pr.fin ? t('planner.cw.resume', { d: pr.done, n: pr.n }) : t(idle || 'planner.cw.open'); };
  const relabel = (b, idle) => { const lab = b.querySelector('.btn__label'); const s = entryLabel(idle); if (lab && lab.textContent !== s) { lab.removeAttribute('data-i18n'); lab.textContent = s; } };
  /** Measurements card: one line + the button that opens (or resumes) the guide. */
  C.cta = function cta() {
    const btn = ui().button({ i18n: 'planner.cw.open', icon: 'target', variant: 'primary', onClick: () => open({ from: btn }) });
    btn.classList.add('pl-cw-ctabtn');
    const root = el('div.pl-cw-cta', el('div.row.gap-1', btn, ui().hint('calibWizard')), el('p.pl-cw-cta__t', t('planner.cw.cta')));
    root.sync = () => { relabel(btn); btn.setAttribute('aria-expanded', String(C.isOpen())); };
    return root;
  };
  const entries = new Set();
  /** A ready entry button for other modules (phone measuring mode, help): "Prvotní měření" / "Pokračovat (3 / 5)".
   *  o: ui.button options + before() (e.g. close the panel the button sits in; the guide then opens a moment later). */
  C.entryButton = function entryButton(o) {
    const before = o && typeof o.before === 'function' ? o.before : null;
    const idle = o && typeof o.idle === 'string' ? o.idle : null;   // label while nothing is in progress (default "Prvotní měření")
    const go = () => { if (before) { before(); setTimeout(() => open({ from: null }), 80); } else open({ from: b }); };
    const b = ui().button(Object.assign({ i18n: idle || 'planner.cw.open', icon: 'target', variant: 'ghost' }, o || {}, { before: undefined, idle: undefined, onClick: go }));
    b.classList.add('pl-cw-entry');
    b.sync = () => relabel(b, idle);
    b.sync();
    entries.add(b);
    return b;
  };
  /** A ready block for the Help panel (like planner.cmdTips): what the guide does + the button that starts / resumes it.
   *  close() (optional) closes the panel the block sits in before the guide opens. */
  C.helpBlock = function helpBlock(close) {
    const b = C.entryButton({ variant: 'primary', size: 'sm', icon: 'play', idle: 'planner.cw.startGuide', before: typeof close === 'function' ? close : () => {} });
    return el('div.card.card--soft.p-3.stack.pl-cw-help', { style: { '--gap': '8px' } },
      el('div', el('b', t('planner.cw.title')), el('div.text-sm.text-muted', t('planner.cw.cta'))), el('div.cluster', b, ui().hint('calibWizard')));
  };
  /** Getting-started item: {done, label (resume text or null)} */
  C.startItem = () => {
    const p = P();
    const pr = C.progress();
    return { done: !!p.model.fit || C.finished() || p.measurements.length > 0, label: pr && !pr.fin && pr.done ? t('planner.cw.resume', { d: pr.done, n: pr.n }) : null };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // the panel
  // ---------------------------------------------------------------------------------------------------------------
  let panel = null;     // {root, head, title, stepEl, body, foot}
  let slot = null;      // persistent container at the top of the sidebar (desktop)
  let run = null;       // {id, i, ac, chk} while measureAll runs for a spot (chk stays after a failed run)
  let lastSaved = null; // {text, id, label} the latest spot the guide saved (a line of feedback + its undo above the next one)
  let picking = false;  // "my own spot": the next map click places it
  let enteredMm = false;
  let opener = null;
  let renderKey = '';
  let pinsOn = false;
  let sigInput = null;  // the optional dBm field (kept across renders while the same spot is current)
  const busy = () => !!(run && run.ac);

  /** The sidebar asks for its first child (the guide lives there on desktop). */
  C.sideSlot = () => { if (!slot) slot = el('div.pl-cw-slot'); return slot; };

  function ensurePanel() {
    if (panel) return panel;
    const titleId = WH.util.uid('pl-cw-t');
    const title = el('h2.pl-cw__title', { id: titleId, tabindex: '-1' });
    const stepEl = el('span.pl-cw__step');
    const close = ui().iconButton({ icon: 'x', tip: 'planner.cw.close', kbd: 'Esc', onClick: () => closePanel(true) });
    const head = el('div.pl-cw__head', el('span.pl-cw__ico', ui().icon('target', 20)), el('div.pl-cw__ht', title, stepEl), ui().hint('calibWizard'), close);
    const body = el('div.pl-cw__body', { 'data-no-wheel': '' });
    const foot = el('div.pl-cw__foot');
    const root = el('section.pl-cw', { role: 'region', 'aria-labelledby': titleId }, el('div.pl-cw__grip', { 'aria-hidden': 'true' }), head, body, foot);
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (busy()) { run.ac.abort(); return; }
      if (picking) { picking = false; render(true); return; }
      closePanel(true);
    });
    panel = { root, head, title, stepEl, body, foot };
    return panel;
  }

  /** Put the panel where the layout wants it (sidebar slot / fixed sheet). */
  function mountPanel() {
    const pn = ensurePanel();
    const sheet = isSheet();
    pn.root.classList.toggle('pl-cw--sheet', sheet);
    pn.root.classList.toggle('pl-cw--side', !sheet);
    // toasts never cover the sheet (phones) / the pinned action row of the side panel (desktop)
    pn.root.toggleAttribute('data-toast-avoid', sheet);
    pn.foot.toggleAttribute('data-toast-avoid', !sheet);
    // desktop: the title row with its close button stays visible too (a toast then sits right below it)
    pn.head.toggleAttribute('data-toast-avoid', !sheet);
    const host = sheet ? PL.root || document.body : C.sideSlot();
    if (pn.root.parentNode !== host) host.append(pn.root);
    document.body.classList.toggle('pl-cw-sheet', sheet);
    const side = document.querySelector('#view-planner .pl-side');
    if (side) side.classList.toggle('is-cw', !sheet);
  }

  function open(o) {
    const opts = o || {};
    if (WH.views && WH.views.current !== 'planner') {
      WH.views.go('planner');
      requestAnimationFrame(() => open({ ...opts, from: null }));
      return;
    }
    const p = P();
    if (!p.plan.rooms.length) { ui().toast({ i18n: 'planner.noplan.t' }, { kind: 'warn' }); return; }
    validate();
    if (!state || opts.restart) state = fresh(p);
    state.open = true;
    save();
    // the measured spots of the guide are dots on the map: the layer "Body měření" comes back on (20-stage)
    if (PL.ensurePoints) PL.ensurePoints();
    opener = opts.from || null;
    if (PL.closePending) PL.closePending();
    mountPanel();
    render(true);
    if (!isSheet()) { const side = document.querySelector('#view-planner .pl-side'); if (side) side.scrollTop = 0; }
    requestAnimationFrame(() => { try { panel.title.focus({ preventScroll: !isSheet() }); } catch (e) { /* ignore */ } });
    ui().announce(t('planner.cw.opened'));
    afterStep();
    if (PL.notifySide) PL.notifySide();
  }
  C.open = open;

  function closePanel(byUser) {
    if (!state) return;
    if (busy()) run.ac.abort();
    state.open = false;
    picking = false;
    save();
    if (panel && panel.root.isConnected) panel.root.remove();
    document.body.classList.remove('pl-cw-sheet');
    if (ui().placeToasts) ui().placeToasts();
    const side = document.querySelector('#view-planner .pl-side');
    if (side) side.classList.remove('is-cw');
    if (enteredMm && PL.mm && PL.mm.active) PL.mm.exit();
    enteredMm = false;
    placePins();
    paintEntries();
    if (PL.notifySide) PL.notifySide();
    if (byUser) {
      ui().announce(t('planner.cw.closed'));
      const back = opener && opener.isConnected && opener.offsetParent ? opener : PL.stage && PL.stage.canvas;
      try { if (back) back.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  C.close = () => closePanel(true);

  function go(step) {
    state.step = step;
    if (step === 'done') state.fin = true;
    picking = false;
    save();
    render(true);
    afterStep();
    requestAnimationFrame(() => { try { panel.title.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
  }
  /** Side effects of a step: the guide's band on the map; phones measure in the measuring mode (full map, screen on). */
  function afterStep() {
    if (!state || !C.isOpen()) return;
    if (state.step === 'measure') {
      if (P().view.band !== state.band) PL.setView({ band: state.band });
      if (isSheet() && PL.mm && !PL.mm.active && typeof PL.mm.enter === 'function') {
        PL.mm.enter();
        enteredMm = !!PL.mm.active;
        // the measuring mode re-fits the plan for its own bars on the next frame: fit it above the sheet after that
        // (every pin is then in view - no extra panning while that view change animates)
        requestAnimationFrame(() => requestAnimationFrame(fitAbove));
      } else if (isSheet()) requestAnimationFrame(fitAbove);
    } else if (state.step === 'done' && enteredMm && PL.mm && PL.mm.active) { PL.mm.exit(); enteredMm = false; }
    placePins();
  }

  const spotRoom = (s) => (PL.roomAt(at(s)) || {}).name || t('planner.tip.outside');
  /** "na druhé straně místnosti s routerem" only when it is that room (the engine may pick a spot through an open door). */
  const kindText = (s) => {
    let k = KINDS.includes(s.kind) ? s.kind : 'spot';
    if (k === 'sameRoom' && PL.roomAt(at(s)) !== PL.roomAt(P().net.baseline)) k = 'open';
    return t('planner.cw.k.' + k);
  };
  const spotLabel = (s, i) => t('planner.cw.pin', { i: i + 1, room: spotRoom(s), kind: kindText(s) });
  const measOf = (s) => (s.mid ? P().measurements.find((m) => m.id === s.mid) || null : null);
  const speedOnly = (s) => { const m = measOf(s); return !!m && !hasSig(m); };

  /** (Re)build the panel's content for the current step - only when something it shows changed. */
  function render(force) {
    if (!panel || !state || !C.isOpen()) return;
    const p = P();
    const c = counts();
    const key = JSON.stringify([state.step, state.cur, state.band, state.spots.map((s) => s.state + (s.mid || '') + (speedOnly(s) ? 'v' : '') + (fin(s.ax) ? 'a' : '')), PL.moved(), p.node.mode,
      run && run.id, busy(), lastSaved && lastSaved.text, picking, WH.i18n.lang, fitSig(p.model.fit), p.view.calibrate, isSheet(), p.measurements.filter((m) => m.wifi && m.wifi.band).length]);
    if (!force && key === renderKey) return;
    renderKey = key;
    const pn = panel;
    const a = document.activeElement;
    const fid = a && pn.root.contains(a) ? (a === pn.title ? 'title' : a.dataset.f || null) : null;
    pn.title.textContent = t('planner.cw.title');
    const stepNo = { router: 1, band: 2, measure: 3, done: 3 }[state.step];
    pn.stepEl.textContent = state.step === 'measure' || state.step === 'done' ? t('planner.cw.m.progress', { d: c.done, n: c.n }) : t('planner.cw.step', { i: stepNo });
    const parts = { router: stepRouter, band: stepBand, measure: stepMeasure, done: stepDone }[state.step](p, c);
    pn.body.replaceChildren(...parts.body.filter(Boolean));
    pn.foot.replaceChildren(...parts.foot.filter(Boolean));
    pn.root.dataset.step = state.step;
    if (fid === 'title') { try { pn.title.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } else if (fid) {
      const n = pn.root.querySelector(`[data-f="${CSS.escape(fid)}"]`);
      try { (n && !n.disabled && !n.closest('[hidden]') ? n : pn.title).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    placePins();
    paintEntries();
    centreNums();
    // toasts already on screen step aside from the panel (it opens / changes height without a resize or scroll)
    if (ui().placeToasts) ui().placeToasts();
  }
  /** Spot numbers in the panel (a closed list has no layout yet: done again when it opens). */
  function centreNums() {
    if (!panel) return;
    panel.root.querySelectorAll('.pl-cw__num[data-n]').forEach((n) => digit(n, n.dataset.n));
  }
  /**
   * A digit in a round holder, centred by the ink the browser really draws (SPEC 1.8.1 / 7.2: <= 0.5 px at DPR 2).
   * HTML text is painted on a baseline the layout rounds (and font hinting moves small digits by up to 0.6 px against
   * the font metrics), so the digit is SVG text instead: its ink box is measured once per font / size / DPR by
   * rasterising it on a canvas at device resolution, and the baseline is put on a whole device pixel - measured in
   * headless Chrome at DPR 1 and 2, every digit 1-9 in 24-32 px holders lands within half a device pixel.
   */
  const inks = new Map();
  let gcv = null;
  function inkOf(txt, font, fs, dpr) {
    const key = [txt, font, fs, dpr].join('|');
    let k = inks.get(key);
    if (k) return k;
    const f = fs * dpr;
    const S2 = Math.ceil(f * 2.2 + 8);
    gcv = gcv || document.createElement('canvas');
    gcv.width = S2;
    gcv.height = S2;
    const g = gcv.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, S2, S2);
    g.font = font.replace('{fs}', `${f}px`);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#000';
    const bx = 4;
    const by = Math.round(f * 1.4);
    g.fillText(txt, bx, by);
    const d = g.getImageData(0, 0, S2, S2).data;
    let x0 = S2;
    let x1 = -1;
    let y0 = S2;
    let y1 = -1;
    for (let y = 0; y < S2; y++) for (let x = 0; x < S2; x++) if (d[(y * S2 + x) * 4 + 3] > 90) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    k = x1 < 0 ? { cx: 0, cy: -fs * 0.35 } : { cx: ((x0 + x1 + 1) / 2 - bx) / dpr, cy: ((y0 + y1 + 1) / 2 - by) / dpr };
    inks.set(key, k);
    return k;
  }
  function digit(host, txt) {
    if (!host || !host.isConnected) return;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const cs = getComputedStyle(host);
    const key = [txt, w, h, cs.font, dpr].join('|');
    if (host._dk === key) return;
    host._dk = key;
    const k = inkOf(txt, `${cs.fontStyle} ${cs.fontWeight} {fs} ${cs.fontFamily}`, parseFloat(cs.fontSize), dpr);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const svg = WH.util.svgEl('svg', { class: 'pl-digit', width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', focusable: 'false' });
    svg.style.left = `${-bl}px`;
    svg.style.top = `${-bt}px`;
    const text = WH.util.svgEl('text', { x: (Math.round((w / 2 - k.cx) * dpr * 4) / (dpr * 4)).toFixed(3), y: (Math.round((h / 2 - k.cy) * dpr) / dpr).toFixed(3), fill: 'currentColor' });
    text.textContent = txt;
    svg.append(text);
    host.replaceChildren(svg);
  }
  const tag = (n, f) => { n.dataset.f = f; return n; };
  const btn = (o, f) => tag(ui().button(o), f);

  function stepRouter(p) {
    const body = [el('h3.pl-cw__h', t('planner.cw.r.t')), el('p.pl-cw__p', t('planner.cw.r.b'))];
    const foot = [];
    if (PL.moved()) {
      body.push(el('div.notice.notice--warn', ui().icon('warning', 18), el('span', t('planner.cw.r.moved', { d: PL.m(PL.distM(p.net.router, p.net.baseline)) }))));
      foot.push(btn({ i18n: 'planner.cw.r.here', icon: 'pin', variant: 'primary', onClick: async () => { try { await PL.markToday(); } catch (e) { PL.report(e, 'wizard.markToday', { bug: true }); } if (!PL.moved()) go('band'); } }, 'here'));
      foot.push(btn({ i18n: 'planner.cw.r.back', icon: 'undo', onClick: () => { PL.backToToday(); render(true); } }, 'back'));
    } else {
      body.push(el('p.pl-cw__p.text-muted', t('planner.cw.r.no')));
      foot.push(btn({ i18n: 'planner.cw.r.yes', icon: 'check', variant: 'primary', onClick: () => { store().setPref('planner.baselineOk', PL.posKey(P().net.baseline)); go('band'); } }, 'yes'));
    }
    if (p.node.mode !== 'none') body.push(el('div.notice', ui().icon('info', 18), el('span', t('planner.cw.r.node'))));
    return { body, foot };
  }

  /** The band of the latest measurement that carries Wi-Fi details (SPEC 8), if any. */
  function wifiBand(p) {
    for (let i = p.measurements.length - 1; i >= 0; i--) {
      const m = p.measurements[i];
      const b = m.wifi && WH.engine.units.normBand(m.wifi.band);
      if (b) return { band: b, name: m.name };
    }
    return null;
  }
  function stepBand(p) {
    const wb = wifiBand(p);
    if (!state.bandTouched && wb && state.band !== wb.band) { state.band = wb.band; save(); }
    const seg = ui().segmented(BANDS.map((b) => ({ value: b, label: `${PL.band(b)} ${t('planner.ghz')}` })), {
      value: state.band, aria: 'planner.band.aria', block: true,
      onChange: (b) => { state.band = b; state.bandTouched = true; save(); PL.setView({ band: b }); },
    });
    seg.classList.add('pl-cw__bands');
    for (const b of BANDS) tag(seg.button(b), 'band' + String(b).replace('.', ''));
    const body = [el('h3.pl-cw__h', t('planner.cw.b.t')), el('p.pl-cw__p', t('planner.cw.b.b')), seg,
      el('p.pl-cw__p.text-muted', wb ? t('planner.cw.b.fromWifi', { name: wb.name, b: PL.band(wb.band) }) : t('planner.cw.b.unknown'))];
    const foot = [
      btn({ i18n: 'planner.cw.b.go', icon: 'arrow-right', variant: 'primary', onClick: () => startMeasuring() }, 'go'),
      btn({ i18n: 'planner.cw.back', variant: 'ghost', onClick: () => go('router') }, 'bk'),
    ];
    return { body, foot };
  }
  function startMeasuring() {
    const p = P();
    if (!state.spots.length || state.spotBand !== state.band) {
      // keep what was measured already, new suggestions for the rest
      const keep = state.spots.filter((s) => s.state === 'done');
      const add = makeSpots(p, state.band).filter((s) => keep.every((k) => distM(at(k), s) >= 1.2));
      state.spots = keep.concat(add).map((s, i) => ({ ...s, id: 's' + (i + 1) }));
      state.spotBand = state.band;
    }
    state.cur = Math.max(0, state.spots.findIndex((s) => s.state === 'todo'));
    go(state.spots.some((s) => s.state === 'todo') || !state.spots.length ? 'measure' : 'done');
  }

  function stepMeasure(p, c) {
    const body = [];
    const foot = [];
    const sp = state.spots;
    const cur = sp[state.cur] && sp[state.cur].state !== 'done' ? state.cur : sp.findIndex((s) => s.state === 'todo');
    if (cur >= 0 && cur !== state.cur) { state.cur = cur; save(); }
    body.push(el('ol.pl-cw__dots', { 'aria-hidden': 'true' }, sp.map((s, i) => el('li.pl-cw__dot' + (s.state === 'done' ? '.is-done' : s.state === 'skipped' ? '.is-skipped' : i === cur ? '.is-cur' : '')))));
    if (lastSaved) body.push(savedNotice());
    if (!sp.length) body.push(el('p.pl-cw__p', t('planner.cw.m.noSpots')));
    if (picking) {
      body.push(el('div.notice.notice--info.pl-cw__pick', ui().icon('pin', 18), el('div.stack.gap-1', el('span.fw-600', t('planner.cw.m.pick')), el('span.text-xs', t('planner.cw.m.pickKey')))));
      foot.push(btn({ i18n: 'planner.cw.m.cancel', variant: 'ghost', onClick: () => { picking = false; render(true); } }, 'pcancel'));
      return { body, foot };
    }
    if (cur >= 0) {
      const s = sp[cur];
      body.push(el('div.pl-cw__cur', el('span.pl-cw__num', { 'data-n': String(cur + 1), 'aria-hidden': 'true' }), el('div.pl-cw__curt', el('div.fw-700', spotRoom(s)), el('div.text-sm.pl-cw__kind', kindText(s)))));
      body.push(el('p.pl-cw__p', busy() ? t('planner.cw.m.running', { i: cur + 1 }) : fin(s.ax) ? t('planner.cw.m.walkHere', { i: cur + 1 }) : t('planner.cw.m.walk', { i: cur + 1 })));
      // the signal, when the device cannot hand it over (phones: WiFiman); optional - "Změřit vše" also measures without
      if (!busy()) {
        if (!sigInput || sigInput._spot !== s.id) {
          sigInput = el('input.input.input--num.pl-cw__sig', { type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '8', placeholder: t('planner.m.ph'), 'data-f': 'sig' });
          sigInput._spot = s.id;
          sigInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); measureSpot(state.cur); } });
        }
        const f = ui().field({ i18n: 'planner.cw.m.sig', hint: 'whereSignal', unit: 'planner.m.dbm', control: sigInput, inline: true });
        f.classList.add('pl-cw__sigf');
        body.push(f);
      }
    } else if (sp.length) body.push(el('p.pl-cw__p', t('planner.cw.m.allDone')));
    if (run && run.chk) body.push(run.chk);
    // a spot measured without a signal: the fit cannot use it
    const so = sp.findIndex((s) => s.state === 'done' && speedOnly(s));
    if (so >= 0 && !busy()) {
      body.push(el('div.notice.notice--warn', ui().icon('warning', 18), el('div.stack.gap-1', el('span', t('planner.cw.m.speedOnly', { i: so + 1 })),
        el('div', btn({ i18n: 'planner.cw.m.addSig', icon: 'edit', size: 'sm', variant: 'ghost', onClick: () => { const m = measOf(sp[so]); if (m) PL.openMeasure(m, m.id); } }, 'addsig')))));
    }
    if (!busy()) body.push(el('p.pl-cw__tip', ui().icon('lightbulb', 16), el('span', t(PL.isPhone && PL.isPhone() ? 'planner.cw.m.tipPhone' : 'planner.cw.m.tipPc'))));
    // every spot (the keyboard path to each pin)
    const list = el('ol.pl-cw__list', sp.map((s, i) => {
      const stt = s.state === 'done' ? (speedOnly(s) ? 'speedOnly' : 'done') : s.state === 'skipped' ? 'skipped' : i === cur ? 'next' : '';
      const label = spotLabel(s, i);
      const b = el('button.pl-cw__item' + (i === cur ? '.is-cur' : ''), { type: 'button', 'aria-current': i === cur ? 'step' : null, disabled: busy() || null, onclick: () => pick(i),
        'aria-label': stt ? t('planner.cw.pinState', { label, state: t('planner.cw.st.' + stt) }) : label },
        el('span.pl-cw__num.pl-cw__num--sm' + (s.state === 'done' ? '.is-done' : s.state === 'skipped' ? '.is-skipped' : ''), s.state === 'done' ? ui().icon('check', 16) : { 'data-n': String(i + 1) }),
        el('span.pl-cw__itt', el('span.pl-cw__itr', spotRoom(s)), el('span.pl-cw__itk', kindText(s))),
        stt ? el('span.pl-cw__its', t('planner.cw.st.' + stt)) : null);
      b.dataset.f = 'it' + s.id;
      return el('li', b);
    }));
    const det = el('details.disclosure.pl-cw__all', el('summary', el('span', t('planner.cw.m.list')), el('span.badge.badge--count', el('span.badge__text', String(sp.length)))), el('div.disclosure__body', list));
    if (!isSheet() || state.listOpen) det.open = true;
    det.addEventListener('toggle', () => { if (isSheet()) state.listOpen = det.open; if (det.open) centreNums(); });
    if (sp.length && !busy()) body.push(det);
    if (!busy()) {
      const all = btn({ i18n: 'planner.cw.m.all', icon: 'play', variant: 'primary', size: 'lg', onClick: () => measureSpot(state.cur) }, 'all');
      all.classList.add('pl-cw__go');
      all.disabled = cur < 0;
      foot.push(all);
      foot.push(el('div.pl-cw__row',
        btn({ i18n: 'planner.cw.m.skip', icon: 'chevron-right', size: 'sm', variant: 'ghost', disabled: cur < 0, onClick: () => skip(state.cur) }, 'skip'),
        btn({ i18n: 'planner.cw.m.own', icon: 'plus', size: 'sm', variant: 'ghost', onClick: () => { picking = true; render(true); } }, 'own'),
        el('span.grow'),
        btn({ i18n: 'planner.cw.m.finish', icon: 'check', size: 'sm', variant: c.done >= 2 ? 'soft' : 'ghost', disabled: c.done < 1, onClick: () => go('done') }, 'fin')));
    }
    return { body, foot };
  }

  function stepDone(p) {
    const body = [lastSaved ? savedNotice() : null, el('h3.pl-cw__h', t('planner.cw.d.t'))];
    const sec = C.resultSection({ inWizard: true });
    sec.sync('full');
    body.push(el('p.pl-cw__p', t(p.model.fit ? 'planner.cw.d.b' : 'planner.cw.needSig')));
    body.push(sec);
    const tp = C.throughputSection();
    tp.sync('full');
    body.push(tp);
    const foot = [
      btn({ i18n: 'planner.cw.d.close', icon: 'check', variant: 'primary', onClick: () => closePanel(true) }, 'close'),
      btn({ i18n: 'planner.cw.d.more', icon: 'plus', variant: 'ghost', onClick: () => { state.step = 'measure'; picking = true; save(); render(true); afterStep(); } }, 'more'),
    ];
    return { body, foot };
  }

  function paintEntries() { for (const b of entries) { if (!b.isConnected) entries.delete(b); else b.sync(); } }

  // ---------------------------------------------------------------------------------------------------------------
  // spots: select, skip, add own, measure
  // ---------------------------------------------------------------------------------------------------------------
  function select(i, announce) {
    const s = state && state.spots[i];
    if (!s) return;
    if (s.state === 'skipped') s.state = 'todo';
    state.cur = i;
    if (run && !run.ac) run = null;   // a finished failed run belongs to the spot it was for
    save();
    render(true);
    revealCur();
    if (announce) ui().announce(t('planner.cw.m.selected', { i: i + 1, label: spotRoom(s) + ', ' + kindText(s) }));
  }
  /** List / pin: choose a spot (a measured one is shown on the map instead). */
  function pick(i) {
    const s = state && state.spots[i];
    if (!s || busy()) return;
    if (s.state === 'done') { const m = measOf(s); if (m) showSpot(m, spotLabel(s, i)); return; }
    select(i, true);
  }
  function skip(i) {
    const s = state && state.spots[i];
    if (!s || busy()) return;
    s.state = 'skipped';
    run = null;
    advance(i);
  }
  /** The next spot still to measure after i (wrapping), or the result when none is left. */
  function advance(i) {
    const sp = state.spots;
    let j = -1;
    for (let k = 1; k <= sp.length; k++) { const n = (i + k) % sp.length; if (sp[n].state === 'todo') { j = n; break; } }
    if (j < 0) { save(); go('done'); return; }
    state.cur = j;
    save();
    render(true);
    revealCur();
  }
  function addOwn(q) {
    const pt = PL.measPoint ? PL.measPoint(q) : PL.pt(q);
    const id = 's' + (Math.max(0, ...state.spots.map((s) => Number(String(s.id).slice(1)) || 0)) + 1);
    state.spots.push({ id, x: pt.x, y: pt.y, kind: 'own', state: 'todo', mid: null, ax: pt.x, ay: pt.y });
    state.cur = state.spots.length - 1;
    picking = false;
    run = null;
    if (state.step !== 'measure') state.step = 'measure';
    save();
    render(true);
    afterStep();
    ui().announce(t('planner.cw.m.added', { i: state.spots.length }));
  }

  const parseDbm = (s) => {
    const v = String(s || '').replace(/[−–]/g, '-').replace(',', '.').replace(/[^\d.+-]/g, '');
    const n = v && v !== '-' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return null;
    const d = n > 0 ? -n : n;
    return d >= -100 && d <= -20 ? d : null;
  };

  /** "Změřit vše" at spot i: planner.measureAll with the live checklist in the panel; saved automatically. */
  async function measureSpot(i) {
    const s = state && state.spots[i];
    if (!s || busy() || s.state === 'done') return;
    const q = at(s);
    if (typeof PL.measureAll !== 'function') { PL.openMeasure(q); return; }   // older build: the form (the listener assigns it)
    const value = sigInput && sigInput._spot === s.id ? parseDbm(sigInput.value) : null;
    const ac = new AbortController();
    const chk = PL.mallChecklist ? PL.mallChecklist({ onCancel: () => ac.abort(), onHow: () => { if (PL.openDevInfo) PL.openDevInfo(); }, onLayout: () => revealCur() }) : null;
    if (chk) chk.classList.add('pl-cw__chk');
    run = { id: s.id, i, ac, chk };
    lastSaved = null;
    render(true);
    if (chk && chk.focusCancel) requestAnimationFrame(() => chk.focusCancel());
    let res = null;
    try {
      res = await PL.measureAll({
        // SPEC 13: the band of the measurement comes from the Wi-Fi details or the user's answer (asked in the checklist),
        // never from the guide's band - that one only chose the spots
        point: q, band: state.band, bandChoice: PL.isPhone() ? PL.bands.choice.get() : null, chooseBand: chk && chk.chooseBand ? (c) => chk.chooseBand(c) : undefined,
        source: 'wizard', value: value === null ? undefined : value,
        consent: chk && chk.askConsent ? () => chk.askConsent() : undefined,
        onStep: (st) => { if (chk) chk.update(st); },
      }, ac.signal);
    } catch (e) {
      if (!(e && e.name === 'AbortError')) {
        PL.report(e, 'wizard.measure', { bug: true, toast: { text: t('planner.mall.err', { msg: String((e && e.message) || e).slice(0, 120) }) }, ms: 9000 });
      }
    }
    if (!state || !run || run.ac !== ac) return;
    const m = res && res.measurement;
    if (chk && chk.finish) chk.finish();
    if (m) {
      run = null;
      sigInput = null;
      if (!state.spots.some((x) => x.mid === m.id)) attribute(m.id, { id: s.id }); else render(true);
      savedToast(m, i);
    } else {
      // cancelled: back to the spot; nothing saved for another reason: the finished checklist says why
      run = res && res.cancelled ? null : { id: s.id, i, ac: null, chk };
      render(true);
      requestAnimationFrame(() => { const b = panel && panel.root.querySelector('[data-f="all"]'); try { if (b) b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    }
  }
  function savedToast(m, i) {
    // the band it was saved for comes first (SPEC 13); another band than the guide's is said, not hidden
    const bi = PL.bands.info(m);
    const parts = [bi.text];
    if (hasSig(m)) parts.push(WH.util.dbm(m.value));
    if (fin(m.download) && fin(m.upload)) parts.push(`${PL.mbps(m.download)} / ${PL.mbps(m.upload)} ${t('planner.mbps')}`);
    let text = t('planner.cw.m.savedToast', { i: i + 1, s: parts.filter(Boolean).join(' · ') });
    if (bi.band && bi.band !== state.band) text += ' ' + t('planner.cw.m.otherBand', { b: PL.band(bi.band) });
    // no toast: the guide's own panel says it (with "Zpět") right where the user looks - a toast stack over the panel
    // used to hide the next spot while it was being measured
    lastSaved = { text, id: m.id, label: store().labels().undo };
    render(true);
  }
  /** "Bod 3 uložený: −62 dBm · 265 / 87 Mb/s  [Zpět]" */
  function savedNotice() {
    const ls = lastSaved;
    const undo = btn({ i18n: 'ui.undo', icon: 'undo', size: 'sm', variant: 'ghost', onClick: () => {
      if (store().labels().undo === ls.label && PL.P().measurements.some((x) => x.id === ls.id)) store().undo();
      lastSaved = null;
      render(true);
    } }, 'undo');
    undo.classList.add('pl-cw__undo');
    return el('div.notice.notice--ok.pl-cw__saved', ui().icon('check-circle', 18), el('span.grow', ls.text), undo);
  }

  /** A measurement was saved: which spot does it belong to? (the running spot, the current one nearby, the nearest one) */
  function attribute(id, hint) {
    const p = P();
    const m = p.measurements.find((x) => x.id === id);
    if (!m || !state) return;
    const sp = state.spots;
    let i = hint ? sp.findIndex((s) => s.id === hint.id) : -1;
    if (i < 0) {
      const cur = sp[state.cur];
      if (cur && cur.state !== 'done' && distM(at(cur), m) <= 3) i = state.cur;
    }
    if (i < 0) {
      let bd = 2;
      sp.forEach((s, k) => { if (s.state !== 'done') { const d = distM(at(s), m); if (d <= bd) { bd = d; i = k; } } });
    }
    if (i < 0) {
      sp.push({ id: 's' + (sp.length + 1), x: m.x, y: m.y, kind: 'own', state: 'todo', mid: null, ax: m.x, ay: m.y });
      i = sp.length - 1;
    }
    const s = sp[i];
    s.state = 'done';
    s.mid = m.id;
    s.ax = m.x;
    s.ay = m.y;
    const next = sp.findIndex((x, k) => k !== i && x.state === 'todo');
    ui().announce(next >= 0 ? t('planner.cw.m.saved', { i: i + 1, j: next + 1 }) : t('planner.cw.m.savedLast', { i: i + 1 }));
    advance(i);
  }

  /** Map click (from the stage): while measuring, a tap near a pin selects it and becomes the exact place to measure;
   *  in "my own spot" mode it places the spot. Returns true when the click was used here. */
  C.mapClick = function mapClick(w) {
    if (!state || !C.isOpen() || state.step !== 'measure' || (PL.S && PL.S.pending) || busy()) return false;
    if (picking) { addOwn(w); return true; }
    let best = -1;
    let bd = 2.5;
    state.spots.forEach((s, k) => { if (s.state !== 'done') { const d = distM(s, w); if (d <= bd) { bd = d; best = k; } } });
    if (best >= 0) {
      // like every new measurement point: inside the room under the tap, never on a wall line (SPEC 10)
      const q = PL.measPoint ? PL.measPoint(w) : PL.snapPos ? PL.snapPos('meas', w) : PL.pt(w);
      state.spots[best].ax = q.x;
      state.spots[best].ay = q.y;
      select(best, true);
      return true;
    }
    ui().toast({ text: t('planner.cw.m.notSpot'), action: { i18n: 'planner.cw.m.addHere', fn: () => addOwn(w) } }, { kind: 'info', ms: 6000 });
    return true;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // pins on the map (DOM buttons in the stage's marker layer; positioned on every view change)
  // ---------------------------------------------------------------------------------------------------------------
  const pins = new Map();
  function pinEl(s) {
    const b = el('button.pl-cpin', { type: 'button' }, el('span.pl-cpin__dot'));
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = state ? state.spots.findIndex((x) => x.id === b.dataset.id) : -1;
      if (i >= 0) pick(i);
    });
    b.dataset.id = s.id;
    return b;
  }
  function placePins() {
    const st = PL.stage;
    const show = !!(st && state && C.isOpen() && state.step === 'measure' && PL.S.visible && P().plan.rooms.length);
    pinsOn = show;
    if (!show) { for (const b of pins.values()) b.hidden = true; placeRing(); return; }
    const vp = st.vp;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v) => (Math.round(v * dpr) / dpr).toFixed(2);
    const seen = new Set();
    state.spots.forEach((s, i) => {
      seen.add(s.id);
      let b = pins.get(s.id);
      if (!b) { b = pinEl(s); pins.set(s.id, b); }
      if (b.parentNode !== st.layer) st.layer.append(b);
      // a measured spot is shown by its measurement dot
      const done = s.state === 'done' && !!measOf(s);
      b.hidden = done;
      if (done) return;
      const sc = vp.toScreen(at(s));
      b.style.transform = `translate(${snap(sc.x)}px,${snap(sc.y)}px) translate(-50%,-50%)`;
      const cur = i === state.cur && s.state === 'todo';
      b.classList.toggle('is-next', cur);
      b.classList.toggle('is-skipped', s.state === 'skipped');
      b.disabled = busy();
      digit(b.firstChild, String(i + 1));   // centred by its ink; redrawn when the size changes (the next pin is bigger)
      const label = spotLabel(s, i);
      b.setAttribute('aria-label', cur ? t('planner.cw.pinState', { label, state: t('planner.cw.st.next') }) : s.state === 'skipped' ? t('planner.cw.pinState', { label, state: t('planner.cw.st.skipped') }) : label);
      if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    for (const [id, b] of pins) if (!seen.has(id)) { b.remove(); pins.delete(id); }
    placeRing();
  }
  C.placePins = placePins;

  /** Phones: fit the whole plan into the band of the map the guide's sheet leaves free (below the measuring mode's top
   *  bar, above the sheet), so every pin can be seen and tapped. */
  function fitAbove() {
    const st = PL.stage;
    if (!isSheet() || !st || !panel || !panel.root.isConnected || !PL.setViewState) return;
    const b = WH.engine.project.planBounds(P().plan);
    const sr = st.el.getBoundingClientRect();
    const sw = st.el.clientWidth;
    const sh = st.el.clientHeight;
    const top = (PL.mm && PL.mm.active && PL.mm.topInset ? PL.mm.topInset() : 64) + 16;
    const bot = Math.max(0, sr.bottom - panel.root.getBoundingClientRect().top) + 16;
    const bw = (b.maxX - b.minX) * W;
    const bh = (b.maxY - b.minY) * H;
    const s = Math.min((sh - top - bot) / bh, (sw - 24) / bw);
    if (!(s > 0.02) || !Number.isFinite(s)) return;
    const tx = (sw - bw * s) / 2 - b.minX * W * s;
    const ty = top + (sh - top - bot - bh * s) / 2 - b.minY * H * s;
    PL.setViewState({ view: { scale: s, tx, ty }, userNav: true });
  }

  /** Phones: keep the current pin visible between the top chrome and the guide's sheet. */
  function revealCur() {
    if (!isSheet() || !state || !C.isOpen() || state.step !== 'measure') return;
    requestAnimationFrame(() => {
      const st = PL.stage;
      const s = state && state.spots[state.cur];
      if (!st || !s || !panel || !panel.root.isConnected) return;
      const sr = st.el.getBoundingClientRect();
      const top = sr.top + (PL.mm && PL.mm.active && PL.mm.topInset ? PL.mm.topInset() : 56) + 30;
      const bottom = Math.min(sr.bottom, panel.root.getBoundingClientRect().top) - 34;
      const c = PL.toClient(at(s));
      let dx = 0;
      let dy = 0;
      if (c.y < top || c.y > bottom) dy = (bottom > top ? (top + bottom) / 2 : top) - c.y;
      if (c.x < sr.left + 28 || c.x > sr.right - 28) dx = (sr.left + sr.right) / 2 - c.x;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) PL.panBy(dx, dy);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // throughput chip on the map (Speed view): between the two top toolbars, only when there is room for it
  // ---------------------------------------------------------------------------------------------------------------
  let chip = null;
  function ensureChip(st) {
    if (chip) return chip;
    const txt = el('span.pl-tpchip__t');
    const sp = el('span.pl-tpchip__sp');
    const weakBtn = ui().iconButton({ icon: 'target', tip: 'planner.tp.weak', size: 'sm', onClick: () => { const v = homeData(); if (v && v.weak) showSpot(v.weak, weakText(v.weak)); } });
    const bar = el('div.toolbar.pl-tpchip__bar', { role: 'status' }, el('span.pl-tpchip__ico', ui().icon('speed', 18)), txt, sp, weakBtn, ui().hint('homeSpeed'));
    const slotEl = el('div.stage__slot.stage__tc.pl-tpchip', { hidden: true }, bar);
    st.el.append(slotEl);
    chip = { slot: slotEl, bar, txt, sp, weakBtn, key: '' };
    return chip;
  }
  function paintChip() {
    const st = PL.stage;
    if (!st) return;
    const ch = ensureChip(st);
    const p = P();
    const v = p.view.layer === 'speed' && !(PL.mm && PL.mm.active) && PL.S.visible ? homeData() : null;
    if (!v) { ch.slot.hidden = true; return; }
    const k = JSON.stringify([v.coverage, v.rooms, v.weak, WH.i18n.lang, p.goal.targetDown, p.goal.targetUp]);
    if (k !== ch.key) {
      ch.key = k;
      const pct = WH.util.fmtPct(v.coverage);
      ch.txt.textContent = t('planner.tp.chip', { v: pct });
      ch.bar.setAttribute('aria-label', t('planner.tp.chipAria', { d: PL.mbps(p.goal.targetDown), u: PL.mbps(p.goal.targetUp), v: pct }));
      ch.weakBtn.hidden = !v.weak;
    }
    // centred in the gap between the two top toolbars (it never covers them); hidden when the gap is too narrow
    ch.slot.hidden = false;
    ch.slot.style.visibility = 'hidden';
    const tl = st.tl.firstElementChild || st.tl;
    const tr = st.tr.firstElementChild || st.tr;
    const sr = st.el.getBoundingClientRect();
    const x0 = sr.left + st.el.clientLeft;
    const left = tl.getBoundingClientRect().right - x0 + 10;
    const right = tr.getBoundingClientRect().left - x0 - 10;
    ch.slot.style.left = `${Math.round(left)}px`;
    ch.slot.style.right = `${Math.round(st.el.clientWidth - right)}px`;
    const w = ch.bar.offsetWidth;
    ch.slot.style.visibility = '';
    ch.slot.hidden = !(right - left >= w);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // wiring (called by the sidebar's mount, i.e. once the Wi-Fi view exists)
  // ---------------------------------------------------------------------------------------------------------------
  let mounted = false;
  let known = new Set();
  let lastCal = null;
  C.mount = function mount() {
    if (mounted || !PL.stage) return;
    mounted = true;
    const st = PL.stage;
    known = new Set(P().measurements.map((m) => m.id));
    lastCal = P().view.calibrate !== false;
    state = load();
    validate();
    syncKey = '';
    queueSync();
    st.vp.subscribe(() => { if (pinsOn) placePins(); else placeRing(); });
    PL.on((q) => {
      if (q === 'coarse') return;
      placePins();
      paintChip();
      if (C.isOpen() && state.step === 'done') render(false);
    });
    store().on('*', (e) => {
      const tp = new Set(e.topics);
      // the tuned model lives in the engine context while the calibration switch is on: rebuild it when that flips
      const cal = P().view.calibrate !== false;
      if (cal !== lastCal) { lastCal = cal; PL.S.geomDirty = true; if (PL.invalidate) PL.invalidate(true); }
      if (tp.has('project:replaced')) {
        known = new Set(P().measurements.map((m) => m.id));
        if (run && run.ac) run.ac.abort();
        run = null;
        lastSaved = null;
        picking = false;
        validate();
        if (C.isOpen()) render(true);
        syncKey = '';
        queueSync();
        return;
      }
      if (e.source === 'live') return;
      // measurements added / removed: the spots follow them (a measurement taken any other way counts for a spot too)
      if (tp.has('measurements')) {
        const now = P().measurements;
        const added = now.filter((m) => !known.has(m.id));
        known = new Set(now.map((m) => m.id));
        if (e.source === 'undo') lastSaved = null;
        validate();
        if (state && C.isOpen() && state.step === 'measure' && state.key === planKey(P()) && e.source !== 'undo') {
          for (const m of added) if (!state.spots.some((s) => s.mid === m.id)) attribute(m.id, run && run.ac ? { id: run.id } : null);
        }
      } else if (tp.has('net')) validate();
      if (!selfUpdate && (tp.has('measurements') || tp.has('plan') || tp.has('scale') || tp.has('net') || tp.has('model') || tp.has('goal') || tp.has('history'))) queueSync();
      if (C.isOpen()) render(false);
      paintEntries();
      if (tp.has('view')) paintChip();
    });
    WH.bus.on('lang:changed', () => { if (C.isOpen()) render(true); placePins(); if (chip) { chip.key = ''; paintChip(); } paintEntries(); });
    WH.bus.on('view:changed', () => placePins());
    if (typeof matchMedia === 'function') {
      const mq = matchMedia(SIDE_MQ);
      const re = () => { if (C.isOpen()) { if (!isSheet() && enteredMm && PL.mm && PL.mm.active) { PL.mm.exit(); enteredMm = false; } mountPanel(); render(true); afterStep(); } };
      if (mq.addEventListener) mq.addEventListener('change', re); else if (mq.addListener) mq.addListener(re);
    }
    if (typeof ResizeObserver === 'function') {
      let ro = 0;
      new ResizeObserver(() => { if (!ro) ro = requestAnimationFrame(() => { ro = 0; paintChip(); }); }).observe(st.el);
    }
    // planner keys: Esc closes the guide (after the planner's own uses of Esc), Enter on the map places "my own spot"
    if (WH.ui && WH.ui.keys) {
      WH.ui.keys.register({ mode: 'planner', key: 'escape', i18n: 'planner.cw.close', hidden: true, when: () => C.isOpen() && !(PL.S && PL.S.pending),
        run: () => { if (busy()) run.ac.abort(); else if (picking) { picking = false; render(true); } else closePanel(true); } });
      WH.ui.keys.register({ mode: 'planner', key: 'enter', i18n: 'planner.cw.m.own', hidden: true,
        when: () => picking && C.isOpen() && document.activeElement === st.canvas && !(PL.S && PL.S.pending),
        run: () => { const r = st.el.getBoundingClientRect(); addOwn(st.vp.toWorld(r.left + r.width / 2, r.top + r.height / 2)); } });
    }
    // the guide was open when the page was left: open it again (resume)
    if (state && state.open && P().plan.rooms.length) requestAnimationFrame(() => { if (state && state.open && !C.isOpen()) open(); });
  };
  /** The sidebar rebuilt its content (language switch): keep the guide in its slot. */
  C.afterSideRender = () => { if (C.isOpen() && !isSheet()) mountPanel(); };
})();
