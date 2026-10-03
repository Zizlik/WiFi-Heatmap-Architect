/* Floor-plan editor (SPEC 1.5) - shared core.
 * WH.editor is the private namespace of the editor files in src/js/40-editor (10-core, 20-check, 30-render, 40-tools,
 * 50-inspector, 60-view); the view registers itself as WH.views 'editor' in 60-view.js.
 * This file: state + tiny event hub, editor prefs, geometry helpers, snapping, hit testing and every plan operation.
 * All document changes go through WH.store.commit (one undo step) or begin/live/end (drags). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});

  const W = 1080;
  const H = 942;
  const MAX = 250;
  const NONE = new Set();
  const LIST = { room: 'rooms', wall: 'walls', door: 'doors', furniture: 'furniture' };
  const KINDS = ['rooms', 'walls', 'doors', 'furniture'];
  const t = (k, p) => WH.i18n.t(k, p);
  const eng = () => WH.engine;
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const P = (x, y) => ({ x: r6(c01(x)), y: r6(c01(y)) });
  const dpx = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);

  /** Furniture presets of the F tool: kind (+ own 5 GHz loss when it differs from the kind's table), default size (m)
   *  for keyboard insertion. */
  const PRESETS = [
    { key: 'bed', icon: 'bed', kind: 'bed', size: [1.6, 2] },
    { key: 'sofa', icon: 'sofa', kind: 'bed', size: [2, 0.9] },
    { key: 'wardrobe', icon: 'box', kind: 'wood', size: [1.2, 0.6] },
    { key: 'books', icon: 'books', kind: 'books', size: [1, 0.35] },
    { key: 'appliance', icon: 'fridge', kind: 'appliance', size: [0.6, 0.6] },
    { key: 'table', icon: 'table', kind: 'custom', loss: 1, size: [1.4, 0.8] },
    { key: 'metal', icon: 'box', kind: 'metal', size: [1, 0.5] },
    { key: 'custom', icon: 'edit', kind: 'custom', loss: 3, size: [1, 1] },
  ];

  // ---------------------------------------------------------------------------------------------------------------
  // band-dependent obstacle loss (SPEC 7.1): a stored loss is the 5 GHz reference, presets are per-band tables
  // (WH.engine.model.MATERIALS / FURNITURE_KINDS as {'2.4','5','6'}); model.lossBands() is what the model really uses
  // ---------------------------------------------------------------------------------------------------------------
  const row = (o) => [o['2.4'], o['5'], o['6']];
  /** {key: [2.4, 5, 6]} of the wall materials ('wall') or the furniture kinds ('furn'); 'custom' is no preset. */
  function table(kind) {
    const src = eng().model[kind === 'wall' ? 'MATERIALS' : 'FURNITURE_KINDS'] || {};
    const out = {};
    for (const k of Object.keys(src)) if (src[k]) out[k] = row(src[k]);
    return out;
  }
  /** [2.4, 5, 6] GHz values of a stored (5 GHz reference) loss. */
  const r4 = (x) => Math.round(x * 1e4) / 1e4;   // same rounding as model.lossBands (no 5.2000000000000002)
  const triple = (v) => { const k = eng().model.BAND_FACTOR; return [r4(v * k['2.4']), v, r4(v * k['6'])]; };
  /** [2.4, 5, 6] GHz loss of a wall / door / furniture piece as the model uses it (furniture: as if it blocked). */
  const bands = (o) => row(eng().model.lossBands(o.type === 'furniture' ? Object.assign({}, o, { blocksSignal: true }) : o, proj()));
  /** "7 / 11 / 13 dB", "5,2 / 8 / 9,2 dB" (a decimal only where it is not a whole number). */
  function fmtBands(v) {
    const n = (x) => WH.util.fmt(x, Math.abs(x - Math.round(x)) < 0.05 ? 0 : 1);
    return `${v.map(n).join(' / ')}${NB()}dB`;
  }
  const presetLoss = (pr) => (pr.loss !== undefined ? pr.loss : table('furn')[pr.kind][1]);

  // ---------------------------------------------------------------------------------------------------------------
  // state & events
  // ---------------------------------------------------------------------------------------------------------------
  const S = {
    tool: 'select',   // select | rect | poly | wall | door | furniture | scale
    sel: null,        // selected object id
    hover: null,      // hovered object id (select tool)
    hoverHandle: null,
    draft: null,      // drawing in progress (see 40-tools.js)
    cur: null,        // snapped cursor {x,y,kind,a,b} of the drawing tools
    doorPreview: null,
    flash: null,      // {key, params, kind} temporary hint-line message
    issues: [],
    focus: null,      // plan-check issue shown on the stage
    ignored: new Set(),
    vp: null,
    visible: false,
    kbdTool: false,   // the tool was picked with the keyboard (hint line then mentions Enter)
  };
  const subs = {};
  const on = (ev, fn) => { (subs[ev] = subs[ev] || []).push(fn); };
  function emit(ev, arg) {
    for (const fn of subs[ev] || []) { try { fn(arg); } catch (e) { console.error(`[editor] ${ev}:`, e); } }
  }

  // render scheduling (one rAF; the renderer lives in 30-render.js)
  const dirty = { world: false, view: false, overlay: false };
  let raf = 0;
  function req(kind) {
    dirty[kind || 'overlay'] = true;
    if (!raf) raf = requestAnimationFrame(flush);
  }
  function flush() {
    raf = 0;
    const R = ED.render;
    if (!S.visible || !R || !R.ready()) return; // stays dirty until the view is shown again
    const d = Object.assign({}, dirty);
    dirty.world = dirty.view = dirty.overlay = false;
    try {
      if (d.world) R.world();
      if (d.world || d.view) R.view();
      R.overlay();
    } catch (e) { console.error('[editor] render failed:', e); }
  }
  function renderAll() { dirty.world = dirty.view = true; req('overlay'); }

  // ---------------------------------------------------------------------------------------------------------------
  // prefs (UI conveniences, not undoable)
  // ---------------------------------------------------------------------------------------------------------------
  const PREF = {
    snap: [true, (v) => typeof v === 'boolean'],
    bg: [true, (v) => typeof v === 'boolean'],
    bgOpacity: [null, (v) => v === null || (typeof v === 'number' && v >= 0.05 && v <= 1)], // null = automatic
    autoWalls: [true, (v) => typeof v === 'boolean'],
    wallMat: ['default', (v) => v === 'default' || !!(eng() && table('wall')[v])],
    door: ['open', (v) => v === 'open' || v === 'closed'],
    doorW: [0.9, (v) => typeof v === 'number' && v >= 0.3 && v <= 3],
    preset: ['wardrobe', (v) => PRESETS.some((p) => p.key === v)],
  };
  function pref(k) {
    const d = PREF[k];
    const v = WH.store ? WH.store.getPref(`editor.${k}`, d[0]) : d[0];
    return d[1](v) ? v : d[0];
  }
  /** Tracing background opacity: the user's choice, else strong while tracing an empty plan and faint once rooms
   *  exist (room labels must stay legible over the picture's own text and door swings). */
  function bgAlpha() {
    const v = pref('bgOpacity');
    if (v !== null) return v;
    const pl = plan();
    return pl && pl.rooms.length ? 0.2 : 0.6;
  }
  function setPref(k, v) {
    WH.store.setPref(`editor.${k}`, v);
    emit('prefs', k);
    req(k === 'bg' || k === 'bgOpacity' ? 'world' : 'overlay');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // project access & geometry helpers
  // ---------------------------------------------------------------------------------------------------------------
  const proj = () => (WH.store ? WH.store.project : null);
  const plan = () => { const p = proj(); return p && p.plan ? p.plan : null; };
  function mpp() { const p = proj(); const v = p && p.scale && p.scale.mpp; return v > 0 ? v : 0.012; }
  function find(id, pl) {
    pl = pl || plan();
    if (!pl || !id) return null;
    for (const k of KINDS) for (const o of pl[k] || []) if (o.id === id) return o;
    return null;
  }
  const ptsOf = (o) => (o.points ? o.points : [o.a, o.b]);
  function bboxOf(pts) {
    let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }
  const numOf = (id) => { const m = /(\d+)$/.exec(String(id)); return m ? m[1] : ''; };
  const cut50 = (s) => Array.from(String(s)).slice(0, 50).join('');
  const NB = () => WH.util.NBSP;
  /** Metres for a canvas-px length: 2 decimals under 1 m ("0,90 m"), else 1 ("3,4 m"). */
  function fmtM(px, unit) {
    const m = px * mpp();
    return WH.util.fmt(m, m < 1 ? 2 : 1) + (unit === false ? '' : `${NB()}m`);
  }
  const areaM2 = (pts) => eng().geom.polygonAreaPx(pts) * mpp() * mpp();
  const fmtArea = (pts) => `${WH.util.fmt(areaM2(pts), 1)}${NB()}m²`;
  /** Effective attenuation of a wall at 5 GHz (dB), the reference value stored in plans. */
  const wallLoss = (w) => bands(w)[1];

  // ---------------------------------------------------------------------------------------------------------------
  // snapping: existing vertices > wall lines / room edges > grid (Alt or opts.free disables everything)
  // ---------------------------------------------------------------------------------------------------------------
  const scale = () => (S.vp ? S.vp.view.scale : 1);

  function snap(p, o) {
    o = o || {};
    const pl = plan();
    const raw = { x: c01(p.x), y: c01(p.y) };
    if (o.free || !pl) return { x: r6(raw.x), y: r6(raw.y), kind: 'none' };
    const tol = (o.tolPx || 8) / scale();
    const ex = o.exclude || NONE;
    let best = null;
    let bd = tol;
    const vtx = (q) => { const d = dpx(raw, q); if (d <= bd) { bd = d; best = q; } };
    for (const r of pl.rooms) if (!ex.has(r.id)) for (const q of r.points) vtx(q);
    for (const f of pl.furniture) if (!ex.has(f.id)) for (const q of f.points) vtx(q);
    for (const w of pl.walls) if (!ex.has(w.id)) { vtx(w.a); vtx(w.b); }
    for (const q of o.extra || []) vtx(q);
    if (best) return { x: best.x, y: best.y, kind: 'vertex' };
    if (o.edges !== false) {
      const G = eng().geom;
      let eb = null;
      bd = tol;
      const edge = (a, b) => { const c = G.closestOnSegment(raw, a, b); if (c.d <= bd) { bd = c.d; eb = { x: c.x, y: c.y, a, b }; } };
      for (const w of pl.walls) if (!ex.has(w.id)) edge(w.a, w.b);
      for (const r of pl.rooms) {
        if (ex.has(r.id)) continue;
        const n = r.points.length;
        for (let i = 0; i < n; i += 1) edge(r.points[i], r.points[(i + 1) % n]);
      }
      if (eb) return { x: r6(eb.x), y: r6(eb.y), kind: 'edge', a: eb.a, b: eb.b };
    }
    if (pref('snap')) { const s = eng().geom.snapGrid(raw, 0.01); return { x: s.x, y: s.y, kind: 'grid' }; }
    return { x: r6(raw.x), y: r6(raw.y), kind: 'none' };
  }

  /** Shift: keep the direction from `a` to `p` at a multiple of 45 degrees (in canvas px). */
  function constrain45(a, p) {
    const dx = (p.x - a.x) * W;
    const dy = (p.y - a.y) * H;
    const len = Math.hypot(dx, dy);
    if (!len) return { x: p.x, y: p.y, kind: p.kind };
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return Object.assign(P(a.x + (Math.cos(ang) * len) / W, a.y + (Math.sin(ang) * len) / H), { kind: 'angle' });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // hit testing (forgiving: >= 10 screen px for thin walls and doors)
  // ---------------------------------------------------------------------------------------------------------------
  function hitTest(p, o) {
    const pl = plan();
    if (!pl) return null;
    const G = eng().geom;
    const tol = ((o && o.touch) ? 16 : 10) / scale();
    let best = null;
    let bd = tol;
    for (const d of pl.doors) { const c = G.closestOnSegment(p, d.a, d.b); if (c.d <= bd) { bd = c.d; best = d; } }
    if (best) return best;
    bd = tol;
    for (const w of pl.walls) { const c = G.closestOnSegment(p, w.a, w.b); if (c.d <= bd) { bd = c.d; best = w; } }
    if (best) return best;
    for (let i = pl.furniture.length - 1; i >= 0; i -= 1) if (G.pointInPolygon(p, pl.furniture[i].points)) return pl.furniture[i];
    for (let i = pl.rooms.length - 1; i >= 0; i -= 1) if (G.pointInPolygon(p, pl.rooms[i].points)) return pl.rooms[i];
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // selection & messages
  // ---------------------------------------------------------------------------------------------------------------
  function select(id) {
    if (id && !find(id)) id = null;
    if (S.sel === id) return;
    S.sel = id;
    if (S.focus && !(id && S.focus.ids.includes(id))) S.focus = null;
    emit('sel', id);
    req('overlay');
  }

  let flashTimer = 0;
  /** Temporary message in the hint line (kind: warn | info | ok). */
  function flash(key, params, kind) {
    S.flash = { key, params, kind: kind || 'warn' };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { S.flash = null; emit('hint'); }, 3200);
    emit('hint');
  }
  function toastLimit() { WH.ui.toast({ i18n: 'editor.msg.limit' }, { kind: 'warn' }); }

  // ---------------------------------------------------------------------------------------------------------------
  // operations (every one is a single undo step)
  // ---------------------------------------------------------------------------------------------------------------
  function commit(label, fn, topics) {
    if (!proj()) return false;
    return WH.store.commit(label, (p) => fn(p.plan, p), topics || ['plan']);
  }

  function wallProps(mat) {
    const T = table('wall');
    return mat && T[mat] ? { material: mat, loss: T[mat][1] } : {};
  }

  /** Clean a freshly drawn outline (dedupe, drop collinear points, round); null when it is not a valid polygon. */
  function cleanPoly(pts) {
    const G = eng().geom;
    const out = G.simplify(pts.map((q) => P(q.x, q.y)), 0.75).map((q) => P(q.x, q.y));
    return G.validatePolygon(out) ? out : null;
  }

  /** Append walls for the uncovered edges of `rooms` (mutates pl); returns the number added. */
  function wallsAround(pl, rooms) {
    const mat = pref('wallMat');
    const neu = eng().project.autoWalls({ rooms, walls: pl.walls, doors: [], furniture: [] }, { defaultMaterial: mat === 'default' ? undefined : mat, lang: WH.i18n.lang });
    let n = 0;
    for (const w of neu) {
      if (pl.walls.length >= MAX) break;
      w.id = eng().project.nextId(pl, 'wall');
      w.name = t('editor.newWall', { n: numOf(w.id) });
      Object.assign(w, wallProps(mat));
      pl.walls.push(w);
      n += 1;
    }
    return n;
  }

  function addRoom(pts) {
    const pl = plan();
    if (!pl) return null;
    const clean = cleanPoly(pts);
    if (!clean) { flash('editor.msg.invalid'); return null; }
    if (pl.rooms.length >= MAX || eng().project.nextRoomId(pl) === null) { toastLimit(); return null; }
    let id = null;
    commit('editor.undo.addRoom', (p) => {
      const rid = eng().project.nextRoomId(p);
      const C = eng().project.ROOM_COLORS;
      id = eng().project.nextId(p, 'room');
      const room = { id, type: 'room', roomId: rid, name: t('editor.newRoom', { n: rid }), points: clean, color: C[(rid - 1) % C.length] };
      p.rooms.push(room);
      if (pref('autoWalls')) wallsAround(p, [room]);
    });
    if (id) select(id);
    return id;
  }

  function addFurniture(pts, presetKey) {
    const pl = plan();
    if (!pl) return null;
    const clean = cleanPoly(pts);
    if (!clean) { flash('editor.msg.small'); return null; }
    if (pl.furniture.length >= MAX) { toastLimit(); return null; }
    const pr = PRESETS.find((x) => x.key === presetKey) || PRESETS[0];
    let id = null;
    commit('editor.undo.addFurniture', (p) => {
      id = eng().project.nextId(p, 'furniture');
      p.furniture.push({ id, type: 'furniture', name: t(`editor.preset.${pr.key}`), points: clean, loss: presetLoss(pr), kind: pr.kind, blocksSignal: true });
    });
    if (id) select(id);
    return id;
  }

  function addWall(a, b) {
    const pl = plan();
    if (!pl || dpx(a, b) < 4) return null;
    if (pl.walls.length >= MAX) { toastLimit(); return null; }
    let id = null;
    commit('editor.undo.addWall', (p) => {
      id = eng().project.nextId(p, 'wall');
      p.walls.push(Object.assign({ id, type: 'wall', name: t('editor.newWall', { n: numOf(id) }), a: P(a.x, a.y), b: P(b.x, b.y) }, wallProps(pref('wallMat'))));
    });
    if (id) select(id);
    return id;
  }

  function addDoor(wallId, at) {
    const pl = plan();
    if (!pl || !pl.walls.some((w) => w.id === wallId)) return null;
    if (pl.doors.length >= MAX) { toastLimit(); return null; }
    let id = null;
    commit('editor.undo.addDoor', (p) => {
      const d = eng().edit.makeDoor(p, wallId, at, { widthM: pref('doorW'), mpp: mpp(), loss: pref('door') === 'closed' ? 3 : 0, lang: WH.i18n.lang });
      d.name = t('editor.newDoor', { n: numOf(d.id) });
      p.doors.push(d);
      id = d.id;
    });
    if (id) select(id);
    return id;
  }

  function remove(id) {
    const o = find(id);
    if (!o) return false;
    const name = o.name;
    const ok = commit('editor.undo.delete', (p) => { eng().edit.removeObject(p, id); });
    if (ok) {
      if (S.sel === id) select(null);
      WH.ui.toast({ text: t('editor.msg.deleted', { name }), action: { i18n: 'ui.undo', fn: () => { if (WH.store.canUndo()) WH.store.undo(); } } }, { kind: 'info', ms: 6000 });
    }
    return ok;
  }

  /** Move an object (and a wall's doors) by (dx, dy) normalized; mutates `o` (and pl.doors). */
  function shift(o, dx, dy, pl) {
    if (o.points) o.points = o.points.map((q) => P(q.x + dx, q.y + dy));
    else { o.a = P(o.a.x + dx, o.a.y + dy); o.b = P(o.b.x + dx, o.b.y + dy); }
    if (o.type === 'wall' && pl) for (const d of pl.doors) if (d.wallId === o.id) { d.a = P(d.a.x + dx, d.a.y + dy); d.b = P(d.b.x + dx, d.b.y + dy); }
  }

  /** Largest (dx, dy) <= requested that keeps all points of `pts` inside the canvas. */
  function clampDelta(pts, dx, dy) {
    const bb = bboxOf(pts);
    return { dx: Math.min(Math.max(dx, -bb.minX), 1 - bb.maxX), dy: Math.min(Math.max(dy, -bb.minY), 1 - bb.maxY) };
  }

  function duplicate(id) {
    const o = find(id);
    if (!o) return null;
    if (o.type === 'door') { flash('editor.msg.noDupDoor', null, 'info'); return null; }
    const pl = plan();
    if (pl[LIST[o.type]].length >= MAX || (o.type === 'room' && eng().project.nextRoomId(pl) === null)) { toastLimit(); return null; }
    const off = 0.3 / mpp();
    const bb = bboxOf(ptsOf(o));
    const dx = (bb.maxX + off / W > 1 ? -off : off) / W;
    const dy = (bb.maxY + off / H > 1 ? -off : off) / H;
    let nid = null;
    commit('editor.undo.duplicate', (p) => {
      const c = JSON.parse(JSON.stringify(o));
      c.id = eng().project.nextId(p, o.type);
      c.name = cut50(t('editor.copyName', { name: o.name }));
      if (o.type === 'room') {
        c.roomId = eng().project.nextRoomId(p);
        const C = eng().project.ROOM_COLORS;
        c.color = C[(c.roomId - 1) % C.length];
      }
      shift(c, dx, dy, null);
      p[LIST[o.type]].push(c);
      if (o.type === 'wall') {
        for (const d of p.doors.filter((x) => x.wallId === o.id)) {
          if (p.doors.length >= MAX) break;
          const dc = JSON.parse(JSON.stringify(d));
          dc.id = eng().project.nextId(p, 'door');
          dc.wallId = c.id;
          dc.a = P(d.a.x + dx, d.a.y + dy);
          dc.b = P(d.b.x + dx, d.b.y + dy);
          p.doors.push(dc);
        }
      }
      nid = c.id;
    });
    if (nid) select(nid);
    return nid;
  }

  /** Property edit of one object: fn(obj, plan) mutates it; returning false aborts. */
  function edit(id, fn) {
    return commit('editor.undo.edit', (p) => { const o = find(id, p); if (!o) return false; return fn(o, p); });
  }

  function setMpp(v) {
    if (!(v > 0)) return false;
    const val = Number(Math.min(0.2, Math.max(0.0005, v)).toPrecision(10));
    const ok = WH.store.commit('editor.undo.scale', (p) => { p.scale.mpp = val; }, ['scale']);
    if (ok) WH.ui.toast(t('editor.scale.done', { px: WH.util.fmt(1 / val, 0) }), { kind: 'ok' });
    return ok;
  }

  function autoWallsAll() {
    const pl = plan();
    if (!pl || !pl.rooms.length) { WH.ui.toast({ i18n: 'editor.autoWalls.noRooms' }, { kind: 'info' }); return 0; }
    let n = 0;
    commit('editor.undo.autoWalls', (p) => { n = wallsAround(p, p.rooms); if (!n) return false; });
    WH.ui.toast(n ? t('editor.autoWalls.done', { n }) : t('editor.autoWalls.none'), { kind: n ? 'ok' : 'info' });
    return n;
  }

  function recolor() {
    const C = eng().project.ROOM_COLORS;
    commit('editor.undo.colors', (p) => { p.rooms.forEach((r, i) => { r.color = C[i % C.length]; }); });
  }

  async function newProject(template) {
    const cur = proj();
    const pl = cur && cur.plan;
    const trivial = !pl || (!pl.rooms.length && !pl.walls.length && !pl.furniture.length && !pl.background);
    if (!trivial && !(await WH.ui.confirm({ title: t('file.replace.t'), body: t('file.replace.b'), ok: t('file.replace.ok') }))) return;
    let p;
    try { p = eng().project.create({ template, lang: WH.i18n.lang }); } catch (e) {
      console.error('[editor] create failed:', e);
      WH.ui.toast({ i18n: 'io.err.generic' }, { kind: 'error' });
      return;
    }
    if (!p.name) p.name = t('io.defaultName');
    WH.store.replace(p, template === 'demo' ? 'file.demo' : 'file.new');
    WH.bus.emit('project:created', { template });
    WH.ui.toast({ i18n: template === 'demo' ? 'file.demoLoaded' : 'file.newCreated' }, { kind: 'ok' });
  }

  /** Undo / redo with the same feedback as the global shortcuts. */
  function history(back) {
    const st = WH.store;
    if (st.gestureOpen) st.end();
    if (back ? !st.canUndo() : !st.canRedo()) { WH.ui.toast({ i18n: back ? 'keys.nothingToUndo' : 'keys.nothingToRedo' }, { ms: 1500 }); return; }
    const lab = st.labels()[back ? 'undo' : 'redo'];
    if (back) st.undo(); else st.redo();
    const txt = lab && WH.i18n.has(lab) ? t(lab) : lab;
    WH.ui.toast(txt ? t(back ? 'keys.undone' : 'keys.redone', { label: txt }) : t(back ? 'ui.undo' : 'keys.redo'), { ms: 1800 });
  }

  /** Normalized box to show the whole plan (or the canvas when the plan is empty). */
  function planBox() {
    const pl = plan();
    if (!pl || (!pl.rooms.length && !pl.walls.length && !pl.furniture.length)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const b = eng().project.planBounds(pl);
    const px = Math.max(0.02, (b.maxX - b.minX) * 0.04);
    const py = Math.max(0.02, (b.maxY - b.minY) * 0.04);
    return { minX: Math.max(0, b.minX - px), minY: Math.max(0, b.minY - py), maxX: Math.min(1, b.maxX + px), maxY: Math.min(1, b.maxY + py) };
  }

  /** Zoom/pan so that the normalized box is comfortably visible (never closer than ~4 m across). */
  function zoomTo(box) {
    if (!S.vp || !box) return;
    const minW = Math.min(1, 4 / mpp() / W);
    const minH = Math.min(1, 4 / mpp() / H);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const w = Math.max(box.maxX - box.minX, minW) * 1.3;
    const h = Math.max(box.maxY - box.minY, minH) * 1.3;
    S.vp.fit({ minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 }, { animate: true });
  }

  /** Pan just enough to bring an object into view (used by the object list). */
  function reveal(id) {
    const o = find(id);
    if (!o || !S.vp) return;
    const bb = bboxOf(ptsOf(o));
    const a = S.vp.toScreen({ x: bb.minX, y: bb.minY });
    const b = S.vp.toScreen({ x: bb.maxX, y: bb.maxY });
    const sz = S.vp.size;
    if (b.x - a.x > sz.w || b.y - a.y > sz.h) { zoomTo(bb); return; }
    let dx = 0;
    let dy = 0;
    const m = 40;
    if (a.x < m) dx = m - a.x; else if (b.x > sz.w - m) dx = sz.w - m - b.x;
    if (a.y < m) dy = m - a.y; else if (b.y > sz.h - m) dy = sz.h - m - b.y;
    if (dx || dy) S.vp.panBy(dx, dy, { animate: true });
  }

  Object.assign(ED, {
    W, H, MAX, LIST, KINDS, PRESETS, S, on, emit, req, renderAll, t, eng, r6, c01, P, dpx,
    pref, setPref, bgAlpha, proj, plan, mpp, find, ptsOf, bboxOf, numOf, cut50, fmtM, fmtArea, areaM2, wallLoss, scale,
    table, triple, bands, fmtBands, presetLoss,
    snap, constrain45, hitTest, select, flash, commit, wallProps, cleanPoly, wallsAround,
    addRoom, addFurniture, addWall, addDoor, remove, shift, clampDelta, duplicate, edit, setMpp, autoWallsAll, recolor,
    newProject, history, planBox, zoomTo, reveal,
  });
})();
