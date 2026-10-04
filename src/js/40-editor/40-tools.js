/* Floor-plan editor - tools & pointer interaction.
 * select (move bodies, drag handles, double-click an edge = new vertex, Alt+click a vertex = remove it), rect, poly, wall
 * (chained), door, furniture, scale.  Clicks are click-click (mouse, touch taps) or press-drag-release.  Pinch / middle
 * button / Space+drag belong to WH.viewport: a second finger aborts the current gesture.
 * Drags are one store gesture (begin / live / end = one undo step); Esc or pointercancel restores the start state. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});
  const W = 1080;
  const H = 942;
  const TOOLS = ['select', 'rect', 'poly', 'wall', 'door', 'furniture', 'scale'];
  const DRAFT = { rect: 'rect', furniture: 'rect', poly: 'poly', wall: 'wall', scale: 'scale' };
  const t = (k, p) => WH.i18n.t(k, p);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  let stage = null;
  let svg = null;
  let press = null;
  let lastSel = { id: null, t: 0 };
  let lastClick = { t: 0, x: 0, y: 0 };
  let lastDownHandled = false;
  const ptrs = new Set();
  let nudgeOpen = false;
  let nudgeTimer = 0;
  let scalePop = null;

  const S = () => ED.S;
  const toWorld = (e) => S().vp.toWorld(e.clientX, e.clientY);
  /** Client px -> stage px in the viewport's own frame (padding box), the frame of the overlay handles (vp.toScreen). */
  function stagePt(e) {
    const c = S().vp.toClient({ x: 0, y: 0 });
    const o = S().vp.toScreen({ x: 0, y: 0 });
    return { x: e.clientX - c.x + o.x, y: e.clientY - c.y + o.y };
  }
  const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

  // ---------------------------------------------------------------------------------------------------------------
  // tool & draft state
  // ---------------------------------------------------------------------------------------------------------------
  function freshDraft(tool) { return DRAFT[tool] ? { kind: DRAFT[tool], a: null, b: null, pts: [], asking: false } : null; }
  function draftBusy() { const d = S().draft; return !!(d && (d.a || d.pts.length)); }
  function resetDraft() {
    const s = S();
    s.draft = freshDraft(s.tool);
    s.closeHover = false;
    s.polyBad = false;
    ED.emit('draft');
    ED.req();
  }

  function setTool(name, o) {
    if (!TOOLS.includes(name)) return;
    endInteraction();
    const s = S();
    s.tool = name;
    s.kbdTool = !!(o && o.kbd);
    s.flash = null;
    s.hover = null;
    s.hoverHandle = null;
    s.cur = null;
    s.doorPreview = null;
    s.draft = freshDraft(name);
    if (stage) { stage.dataset.tool = name; stage.dataset.cursor = ''; }
    ED.emit('tool', name);
    ED.req();
  }

  /** Abort whatever is in progress: pointer gesture, nudging, scale question, draft. */
  function endInteraction() {
    abortPress();
    endNudge();
    if (scalePop) scalePop.close();
    if (draftBusy()) resetDraft();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------------------------
  function handleAt(sp, touch) {
    let best = null;
    let bd = Infinity;
    for (const h of ED.render.handles()) {
      const r = (h.kind === 'm' ? 9 : 11) + (touch ? 7 : 0);
      const d = Math.hypot(h.x - sp.x, h.y - sp.y);
      if (d <= r && (d < bd || (best && best.kind === 'm' && h.kind !== 'm' && d <= bd + 2))) { bd = d; best = h; }
    }
    return best;
  }
  const sameHandle = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.i === b.i);

  function markerAt(sp) {
    const pr = ED.proj();
    if (!pr || !pr.net || !pr.plan.rooms.length) return null;
    for (const k of ['router', 'baseline', 'optic']) {
      const p = pr.net[k];
      if (!p || !ED.onActiveFloor(k === 'optic' ? pr.net.opticFloor : pr.net.routerFloor)) continue;
      const q = ED.render.scr(p);
      if (Math.hypot(q.x - sp.x, q.y - sp.y) <= 13) return k;
    }
    return null;
  }

  function capture(e) { try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
  function release(e) { try { if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } }

  /** Does the segment a-b cross any non-adjacent edge of the open polyline pts (last point = a)? */
  function crossesPolyline(pts, b) {
    const G = WH.engine.geom;
    const a = pts[pts.length - 1];
    for (let i = 0; i + 2 < pts.length; i += 1) {
      const x = G.segIntersection(pts[i], pts[i + 1], a, b);
      if (x && x.u > 1e-6 && x.u < 1 - 1e-6) return true;
    }
    return false;
  }

  function squareFrom(a, p) {
    const dx = (p.x - a.x) * W;
    const dy = (p.y - a.y) * H;
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    return Object.assign(ED.P(a.x + (Math.sign(dx) || 1) * s / W, a.y + (Math.sign(dy) || 1) * s / H), { kind: 'angle' });
  }

  function doorPreviewAt(raw) {
    const s = S();
    const pl = ED.plan();
    s.cur = null;
    s.doorPreview = null;
    s.doorWall = null;
    s.doorAt = raw;
    if (!pl || !pl.walls.length) return;
    const nw = WH.engine.edit.nearestWall(pl, raw, { maxPx: 14 / ED.scale() });
    if (!nw) return;
    try {
      s.doorPreview = WH.engine.edit.makeDoor(pl, nw.wall.id, raw, { widthM: ED.pref('doorW'), mpp: ED.mpp() });
      s.doorWall = nw.wall.id;
    } catch (err) { s.doorPreview = null; }
  }

  function doorEnds() {
    const pl = ED.plan();
    const out = [];
    if (pl) for (const d of pl.doors) out.push(d.a, d.b);
    return out;
  }

  /** Snapped cursor of the drawing tools (+ Shift constraint, polygon closing / crossing state). */
  function cursorFrom(e) {
    const s = S();
    const raw = toWorld(e);
    if (s.tool === 'door') { doorPreviewAt(raw); return; }
    const d = s.draft;
    if (!d || d.asking) return;
    const first = d.kind === 'poly' && d.pts.length ? d.pts[0] : null;
    // the scale tool also snaps to door ends ("a door is 80 cm wide" is the most common known length)
    const extra = first ? [first] : d.kind === 'scale' ? doorEnds() : null;
    let c = ED.snap(raw, { free: e.altKey, extra, tolPx: d.kind === 'scale' ? 10 : 8 });
    const anchor = d.kind === 'poly' ? d.pts[d.pts.length - 1] : d.a;
    if (e.shiftKey && anchor) c = d.kind === 'rect' ? squareFrom(anchor, c) : ED.constrain45(anchor, c);
    s.cur = c;
    if (d.kind === 'poly') {
      const q = ED.render.scr(first || c);
      const sp = stagePt(e);
      s.closeHover = !!first && d.pts.length >= 3 && Math.hypot(q.x - sp.x, q.y - sp.y) <= (isTouch(e) ? 18 : 11);
      s.polyBad = !s.closeHover && d.pts.length >= 2 && crossesPolyline(d.pts, c);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // pointer handlers
  // ---------------------------------------------------------------------------------------------------------------
  function onDown(e) {
    const s = S();
    if (!s.vp || !ED.plan()) return;
    endNudge();
    if (e.pointerType === 'mouse' && e.button !== 0) {
      if (e.button === 2 && draftBusy()) { e.preventDefault(); rightClick(); }
      return;
    }
    if (stage.classList.contains('is-pan-ready')) return; // Space held: the viewport pans
    ptrs.add(e.pointerId);
    if (ptrs.size > 1) { abortPress(); ED.req(); return; } // second finger: pinch-zoom
    try { svg.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    if (s.flash) { s.flash = null; ED.emit('hint'); } // a new action supersedes the last message
    press = { id: e.pointerId, cx: e.clientX, cy: e.clientY, p: toWorld(e), sp: stagePt(e), moved: false, touch: isTouch(e), act: null };
    lastDownHandled = true;
    if (s.tool === 'select') { downSelect(e); lastDownHandled = !press || press.act !== 'empty'; return; }
    e.preventDefault();
    capture(e);
    press.act = 'draw';
    cursorFrom(e);
    press.start = s.cur ? { x: s.cur.x, y: s.cur.y } : null;
    ED.req();
  }

  function downSelect(e) {
    const s = S();
    const h = handleAt(press.sp, press.touch);
    if (h) {
      e.preventDefault();
      capture(e);
      press.act = 'handle';
      press.h = h;
      press.obj = s.sel;
      press.altRemove = e.altKey && h.kind === 'v'; // Alt+click (no drag) removes the vertex
      return;
    }
    const hit = ED.hitTest(press.p, { touch: press.touch });
    if (hit) {
      e.preventDefault();
      capture(e);
      // remembered for a double-click on a room edge that coincides with a wall (its first click selects the wall)
      if (hit.id !== s.sel) lastSel = { id: s.sel, t: Date.now() };
      ED.select(hit.id);
      press.act = 'move';
      press.obj = hit.id;
      return;
    }
    if (markerAt(press.sp)) {
      e.preventDefault();
      press = null;
      ED.flash('editor.msg.markers', null, 'info');
      return;
    }
    press.act = 'empty'; // the viewport pans; a plain click deselects (see onUp)
  }

  function onMove(e) {
    const s = S();
    if (!s.vp) return;
    if (press && e.pointerId === press.id) {
      if (!press.moved) {
        if (Math.hypot(e.clientX - press.cx, e.clientY - press.cy) < (press.touch ? 8 : 4)) {
          if (press.act === 'draw') { cursorFrom(e); ED.req(); }
          return;
        }
        press.moved = true;
        if (!startDrag()) return;
      }
      dragTo(e);
      return;
    }
    if (ptrs.size) return;
    hoverAt(e);
  }

  function hoverAt(e) {
    const s = S();
    if (s.tool !== 'select') { cursorFrom(e); ED.req(); return; }
    const sp = stagePt(e);
    const h = handleAt(sp, isTouch(e));
    const hit = h ? null : ED.hitTest(toWorld(e));
    const id = hit ? hit.id : null;
    if (id !== s.hover || !sameHandle(h, s.hoverHandle)) { s.hover = id; s.hoverHandle = h; ED.req(); }
    stage.dataset.cursor = h ? (h.kind === 'm' ? 'add' : 'grab') : hit ? 'move' : markerAt(sp) ? 'help' : '';
  }

  function onLeave() {
    const s = S();
    if (press) return;
    if (s.hover || s.hoverHandle || s.cur || s.doorPreview) {
      s.hover = null;
      s.hoverHandle = null;
      s.cur = null;
      s.doorPreview = null;
      ED.req();
    }
  }

  /** Own double-click detection (a default-prevented pointerdown suppresses the native dblclick in some browsers). */
  function isDouble(e, pr) {
    const now = Date.now();
    const dbl = !pr.moved && now - lastClick.t < 450 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < (pr.touch ? 14 : 6);
    lastClick = dbl || pr.moved ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
    return dbl;
  }

  /** pointerup / pointercancel are watched on the window: a press on empty space is captured by the viewport on the
   *  stage element, so its release never reaches the svg. */
  function onUp(e) {
    ptrs.delete(e.pointerId);
    if (!press || e.pointerId !== press.id) return;
    const pr = press;
    press = null;
    release(e);
    if (!pr.moved && Math.hypot(e.clientX - pr.cx, e.clientY - pr.cy) >= (pr.touch ? 8 : 4)) pr.moved = true;
    const s = S();
    s.drag = null;
    if (isDouble(e, pr) && doubleClick(stagePt(e))) { ED.req(); return; }
    if (pr.act === 'handle' && pr.altRemove && !pr.moved) { removeVertex(pr.h.i); ED.req(); return; }
    if (pr.act === 'move' || pr.act === 'handle') {
      if (pr.moved && WH.store.gestureOpen) WH.store.end();
      if (pr.invalid) ED.flash('editor.msg.invalid');
      ED.req();
      return;
    }
    if (pr.act === 'empty') { if (!pr.moved) ED.select(null); return; }
    if (pr.act === 'draw') {
      cursorFrom(e);
      drawClick(pr, e);
      ED.emit('draft');
      ED.req();
    }
  }

  function onCancel(e) {
    ptrs.delete(e.pointerId);
    if (press && e.pointerId === press.id) { abortPress(); ED.req(); }
  }

  function onLost(e) {
    ptrs.delete(e.pointerId);
    if (press && e.pointerId === press.id && press.act !== 'empty') {
      const pr = press;
      press = null;
      S().drag = null;
      if (pr.moved && (pr.act === 'move' || pr.act === 'handle') && WH.store.gestureOpen) WH.store.end();
      ED.req();
    }
  }

  function abortPress() {
    if (!press) return;
    const pr = press;
    press = null;
    S().drag = null;
    if (pr.moved && (pr.act === 'move' || pr.act === 'handle') && WH.store.gestureOpen) WH.store.cancel();
    if (pr.dragDraw) resetDraft();
  }

  function rightClick() {
    const s = S();
    if (s.tool === 'poly' && s.draft.pts.length >= 3) finishPoly();
    else resetDraft();
  }

  /** Double-click: finish a polygon, stop a wall chain, or insert a vertex on an edge of the selected room / furniture. */
  function doubleClick(sp) {
    const s = S();
    if (s.tool === 'poly' && draftBusy()) { finishPoly(); return true; }
    if (s.tool === 'wall') { if (draftBusy()) resetDraft(); return true; }
    if (s.tool !== 'select') return false;
    // the selected object, or the one selected right before the first click (a room edge usually lies on a wall)
    for (const id of [s.sel, Date.now() - lastSel.t < 1500 ? lastSel.id : null]) {
      const o = id && ED.find(id);
      if (o && o.points && insertVertexAt(sp, o)) { ED.select(o.id); return true; }
    }
    return false;
  }

  /** Native dblclick: only keep the viewport's "double-click empty space = fit" in the select tool. */
  function onDbl(e) {
    if (S().tool !== 'select' || lastDownHandled) e.preventDefault();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // drags (select tool)
  // ---------------------------------------------------------------------------------------------------------------
  const copyPt = (p) => ({ x: p.x, y: p.y });
  function geomOf(o) { return o.points ? { points: o.points.map(copyPt) } : { a: copyPt(o.a), b: copyPt(o.b) }; }

  function startDrag() {
    const s = S();
    if (press.act === 'draw') {
      const d = s.draft;
      if (d && (d.kind === 'rect' || d.kind === 'wall' || d.kind === 'scale') && !d.a && press.start) { d.a = press.start; press.dragDraw = true; }
      return true;
    }
    if (press.act !== 'move' && press.act !== 'handle') return false;
    const o = ED.find(press.obj);
    if (!o) return false;
    const pl = ED.plan();
    const G = WH.engine.geom;
    press.orig = geomOf(o);
    press.ex = new Set([o.id]);
    press.doors = [];
    if (o.type === 'wall') {
      for (const d of pl.doors) {
        if (d.wallId !== o.id) continue;
        press.ex.add(d.id);
        press.doors.push({ id: d.id, a: copyPt(d.a), b: copyPt(d.b), ta: G.closestOnSegment(d.a, o.a, o.b).t, tb: G.closestOnSegment(d.b, o.a, o.b).t });
      }
    }
    if (press.act === 'move') {
      WH.store.begin('editor.undo.move');
      let best = null;
      for (const q of ED.ptsOf(o)) if (!best || ED.dpx(q, press.p) < ED.dpx(best, press.p)) best = q;
      press.anchor = copyPt(best);
      return true;
    }
    if (press.h.kind === 'm') {
      const i = press.h.i;
      const a = o.points[i];
      const b = o.points[(i + 1) % o.points.length];
      const mid = ED.P((a.x + b.x) / 2, (a.y + b.y) / 2);
      WH.store.begin('editor.undo.vertex');
      WH.store.live((p) => { const ob = ED.find(o.id, p.plan); if (ob) ob.points.splice(i + 1, 0, mid); }, ['plan']);
      press.h = { kind: 'v', i: i + 1 };
      press.orig = geomOf(ED.find(o.id));
    } else {
      WH.store.begin('editor.undo.reshape');
    }
    return true;
  }

  function dragTo(e) {
    const s = S();
    if (press.act === 'draw') { cursorFrom(e); ED.req(); return; }
    const o = ED.find(press.obj);
    if (!o) return;
    const p = toWorld(e);
    if (press.act === 'move') {
      if (o.type === 'door') slideDoor(o, p, press.orig);
      else moveBody(o, p, e);
    } else dragHandle(o, p, e);
    s.drag = s.drag || {};
    ED.req();
  }

  function moveBody(o, p, e) {
    const tgt = { x: press.anchor.x + (p.x - press.p.x), y: press.anchor.y + (p.y - press.p.y) };
    const sn = ED.snap(tgt, { free: e.altKey, exclude: press.ex });
    const orig = press.orig.points || [press.orig.a, press.orig.b];
    const c = ED.clampDelta(orig, sn.x - press.anchor.x, sn.y - press.anchor.y);
    WH.store.live((pr) => {
      const ob = ED.find(o.id, pr.plan);
      if (!ob) return false;
      if (ob.points) ob.points = press.orig.points.map((q) => ED.P(q.x + c.dx, q.y + c.dy));
      else { ob.a = ED.P(press.orig.a.x + c.dx, press.orig.a.y + c.dy); ob.b = ED.P(press.orig.b.x + c.dx, press.orig.b.y + c.dy); }
      for (const dd of press.doors) {
        const door = ED.find(dd.id, pr.plan);
        if (door) { door.a = ED.P(dd.a.x + c.dx, dd.a.y + c.dy); door.b = ED.P(dd.b.x + c.dx, dd.b.y + c.dy); }
      }
    }, ['plan']);
    S().drag = { at: p, label: null };
  }

  /** Slide a door along its wall (keeps its width). */
  function slideDoor(d, p, orig) {
    const w = ED.find(d.wallId);
    if (!w || ED.dpx(w.a, w.b) < 1) return;
    const G = WH.engine.geom;
    const ta = G.closestOnSegment(orig.a, w.a, w.b).t;
    const tb = G.closestOnSegment(orig.b, w.a, w.b).t;
    let dt = G.closestOnSegment(p, w.a, w.b).t - G.closestOnSegment(press.p, w.a, w.b).t;
    dt = clamp(dt, -Math.min(ta, tb), 1 - Math.max(ta, tb));
    const at = (k) => ED.P(w.a.x + (w.b.x - w.a.x) * k, w.a.y + (w.b.y - w.a.y) * k);
    WH.store.live((pr) => { const door = ED.find(d.id, pr.plan); if (door) { door.a = at(ta + dt); door.b = at(tb + dt); } }, ['plan']);
    S().drag = { at: p, label: null };
  }

  function dragHandle(o, p, e) {
    const h = press.h;
    const free = e.altKey;
    const G = WH.engine.geom;
    if (o.points) {
      const sn = ED.snap(p, { free, exclude: press.ex });
      const pts = o.points.slice();
      pts[h.i] = { x: sn.x, y: sn.y };
      if (!G.validatePolygon(pts)) { press.invalid = true; return; }
      press.invalid = false;
      WH.store.live((pr) => { const ob = ED.find(o.id, pr.plan); if (ob) ob.points = pts; }, ['plan']);
      S().drag = { at: sn, label: o.type === 'room' ? ED.fmtArea(pts) : null };
      return;
    }
    if (o.type === 'wall') {
      const other = h.kind === 'a' ? o.b : o.a;
      let sn = ED.snap(p, { free, exclude: press.ex });
      if (e.shiftKey) sn = ED.constrain45(other, sn);
      if (ED.dpx(sn, other) < 4) return;
      const na = h.kind === 'a' ? ED.P(sn.x, sn.y) : other;
      const nb = h.kind === 'a' ? other : ED.P(sn.x, sn.y);
      const at = (k) => ED.P(na.x + (nb.x - na.x) * k, na.y + (nb.y - na.y) * k);
      WH.store.live((pr) => {
        const w = ED.find(o.id, pr.plan);
        if (!w) return false;
        w.a = na;
        w.b = nb;
        for (const dd of press.doors) { const door = ED.find(dd.id, pr.plan); if (door) { door.a = at(dd.ta); door.b = at(dd.tb); } }
      }, ['plan']);
      S().drag = { at: sn, label: ED.fmtM(ED.dpx(na, nb)) };
      return;
    }
    // door end: slides along its wall, keeps >= 8 px and stays on its side
    const w = ED.find(o.wallId);
    if (!w) return;
    const len = ED.dpx(w.a, w.b);
    if (len < 10) return;
    const tOther = G.closestOnSegment(h.kind === 'a' ? press.orig.b : press.orig.a, w.a, w.b).t;
    const tMine = G.closestOnSegment(h.kind === 'a' ? press.orig.a : press.orig.b, w.a, w.b).t;
    const minT = 8 / len;
    let nt = G.closestOnSegment(p, w.a, w.b).t;
    nt = tMine <= tOther ? clamp(nt, 0, tOther - minT) : clamp(nt, tOther + minT, 1);
    const np = ED.P(w.a.x + (w.b.x - w.a.x) * nt, w.a.y + (w.b.y - w.a.y) * nt);
    WH.store.live((pr) => { const d = ED.find(o.id, pr.plan); if (d) d[h.kind] = np; }, ['plan']);
    const cur = ED.find(o.id);
    S().drag = { at: np, label: cur ? ED.fmtM(ED.dpx(cur.a, cur.b)) : null };
  }

  function removeVertex(i) {
    const s = S();
    const o = ED.find(s.sel);
    if (!o || !o.points) return;
    if (o.points.length <= 3) { ED.flash('editor.msg.min3'); return; }
    const pts = o.points.filter((q, k) => k !== i);
    if (!WH.engine.geom.validatePolygon(pts)) { ED.flash('editor.msg.invalid'); return; }
    WH.store.commit('editor.undo.vertex', (p) => { const ob = ED.find(o.id, p.plan); if (ob) ob.points = pts; }, ['plan']);
    s.hoverHandle = null;
  }

  /** Double-click on an edge of a room / furniture inserts a vertex there. */
  function insertVertexAt(sp, o) {
    if (!o || !o.points || o.points.length >= 200) return false;
    const sc = o.points.map(ED.render.scr);
    let best = -1;
    let bd = 12;
    let bt = 0;
    for (let i = 0; i < sc.length; i += 1) {
      const a = sc[i];
      const b = sc[(i + 1) % sc.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const k = clamp(((sp.x - a.x) * dx + (sp.y - a.y) * dy) / l2, 0, 1);
      const d = Math.hypot(a.x + dx * k - sp.x, a.y + dy * k - sp.y);
      if (d < bd && k > 0.02 && k < 0.98) { bd = d; best = i; bt = k; }
    }
    if (best < 0) return false;
    const a = o.points[best];
    const b = o.points[(best + 1) % o.points.length];
    const np = ED.P(a.x + (b.x - a.x) * bt, a.y + (b.y - a.y) * bt);
    const pts = o.points.slice();
    pts.splice(best + 1, 0, np);
    if (!WH.engine.geom.validatePolygon(pts)) return false;
    WH.store.commit('editor.undo.vertex', (p) => { const ob = ED.find(o.id, p.plan); if (ob) ob.points = pts; }, ['plan']);
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // drawing clicks
  // ---------------------------------------------------------------------------------------------------------------
  function drawClick(pr, e) {
    const s = S();
    const d = s.draft;
    const c = s.cur;
    switch (s.tool) {
      case 'rect':
      case 'furniture': {
        if (!c || !d) return;
        if (!d.a) { if (!pr.moved) d.a = { x: c.x, y: c.y }; return; }
        if (Math.abs(d.a.x - c.x) * W < 4 || Math.abs(d.a.y - c.y) * H < 4) {
          if (pr.dragDraw) { resetDraft(); ED.flash('editor.msg.small'); }
          return;
        }
        const pts = WH.engine.geom.rectPoints(d.a, c);
        resetDraft();
        if (s.tool === 'rect') ED.addRoom(pts); else ED.addFurniture(pts, ED.pref('preset'));
        return;
      }
      case 'poly': {
        if (!c || !d) return;
        if (s.closeHover && d.pts.length >= 3) { finishPoly(); return; }
        if (d.pts.length && ED.dpx(d.pts[d.pts.length - 1], c) < 3) return; // second click of a double-click
        if (d.pts.length >= 200) { ED.flash('editor.msg.maxPoints'); return; }
        d.pts.push({ x: c.x, y: c.y });
        return;
      }
      case 'wall': {
        if (!c || !d) return;
        if (!d.a) { if (!pr.moved) d.a = { x: c.x, y: c.y }; return; }
        if (ED.dpx(d.a, c) < 4) { if (!pr.dragDraw) resetDraft(); return; } // same spot again = stop the chain
        const id = ED.addWall(d.a, c);
        if (id && !pr.dragDraw) d.a = { x: c.x, y: c.y }; else resetDraft();
        return;
      }
      case 'scale': {
        if (!c || !d) return;
        if (!d.a) { if (!pr.moved) d.a = { x: c.x, y: c.y }; return; }
        if (ED.dpx(d.a, c) < 10) { ED.flash('editor.msg.scaleShort'); if (pr.dragDraw) resetDraft(); return; }
        d.b = { x: c.x, y: c.y };
        d.asking = true;
        askScale();
        return;
      }
      case 'door': {
        if (pr.moved) return;
        doorPreviewAt(toWorld(e));
        if (s.doorWall) ED.addDoor(s.doorWall, s.doorAt);
        else ED.flash(ED.plan().walls.length ? 'editor.msg.needWall' : 'editor.hint.doorNoWalls');
        return;
      }
      default:
    }
  }

  function finishPoly() {
    const d = S().draft;
    if (!d || d.kind !== 'poly') return false;
    if (d.pts.length < 3) { ED.flash('editor.msg.min3'); return true; }
    if (ED.addRoom(d.pts)) resetDraft();
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // scale: "how many metres is it?"
  // ---------------------------------------------------------------------------------------------------------------
  function askScale() {
    const d = S().draft;
    if (!d || !d.a || !d.b) return;
    const U = WH.util;
    const px = ED.dpx(d.a, d.b);
    const q = ED.render.scr(d.b);
    const anchor = U.el('div.ed-anchor', { style: { left: `${Math.round(q.x)}px`, top: `${Math.round(q.y)}px` } });
    stage.append(anchor);
    const input = WH.ui.numberInput({ value: Number((px * ED.mpp()).toFixed(2)), min: 0.1, max: 100, step: 0.01, ariaLabel: t('editor.scale.ask') });
    input.classList.add('ed-scale-input');
    const err = U.el('div.field__error', { hidden: true, role: 'alert' });
    const okBtn = WH.ui.button({ i18n: 'editor.scale.ok', variant: 'primary', size: 'sm' });
    let done = false;
    const submit = () => {
      const v = input.valueAsNumber;
      if (!(v >= 0.1 && v <= 100)) {
        err.textContent = t('editor.scale.bad');
        err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      done = true;
      ED.scaling.fromPoints(d.a, d.b, v);
      if (scalePop) scalePop.close();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    okBtn.addEventListener('click', submit);
    const body = [U.el('div.input-group', input, U.el('span.field__unit', 'm'), okBtn), err, U.el('p.ed-scale-note', t('editor.scale.note'))];
    scalePop = WH.ui.popover(anchor, body, {
      title: { i18n: 'editor.scale.ask' }, placement: 'bottom', align: 'center', width: 264, className: 'ed-scale-pop',
      onClose: () => {
        anchor.remove();
        scalePop = null;
        if (S().tool === 'scale') { if (done) setTool('select'); else resetDraft(); }
        ED.emit('draft');
      },
    });
    requestAnimationFrame(() => requestAnimationFrame(() => { try { if (input.isConnected) input.select(); } catch (e) { /* ignore */ } }));
    ED.emit('draft');
    ED.req();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // keyboard actions (registered in 60-view.js)
  // ---------------------------------------------------------------------------------------------------------------
  function stageCenter() {
    const vp = S().vp;
    const sz = vp.size;
    const c = vp.toClient({ x: 0, y: 0 });
    const o = vp.toScreen({ x: 0, y: 0 });
    return vp.toWorld(c.x - o.x + sz.w / 2, c.y - o.y + sz.h / 2);
  }

  /** Default-sized shape of the active tool in the middle of the view (keyboard users, touch users). */
  function insertDefault() {
    const s = S();
    if (!s.vp || !ED.plan()) return false;
    const c = stageCenter();
    const m = ED.mpp();
    const box = (wm, hm) => {
      const hw = Math.min(0.45, wm / m / 2 / W);
      const hh = Math.min(0.45, hm / m / 2 / H);
      const cx = clamp(c.x, hw, 1 - hw);
      const cy = clamp(c.y, hh, 1 - hh);
      return WH.engine.geom.rectPoints({ x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy + hh });
    };
    switch (s.tool) {
      case 'rect':
      case 'poly': return !!ED.addRoom(box(3, 3));
      case 'furniture': {
        const pr = ED.PRESETS.find((x) => x.key === ED.pref('preset')) || ED.PRESETS[0];
        return !!ED.addFurniture(box(pr.size[0], pr.size[1]), pr.key);
      }
      case 'wall': {
        const hw = Math.min(0.45, 1.5 / m / W);
        const cx = clamp(c.x, hw, 1 - hw);
        return !!ED.addWall({ x: cx - hw, y: c.y }, { x: cx + hw, y: c.y });
      }
      case 'door': {
        const w = s.sel && ED.find(s.sel);
        if (w && w.type === 'wall') return !!ED.addDoor(w.id, { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 });
        ED.flash('editor.msg.selectWall', null, 'info');
        return true;
      }
      case 'scale': ED.flash('editor.hint.scale1', null, 'info'); return true;
      default: return false;
    }
  }

  function enter() {
    const s = S();
    if (s.tool === 'poly' && s.draft && s.draft.pts.length) return finishPoly();
    return insertDefault();
  }

  function backspaceOrDelete(e) {
    const s = S();
    if (s.tool === 'poly' && s.draft && s.draft.pts.length && e.key === 'Backspace') {
      s.draft.pts.pop();
      ED.emit('draft');
      ED.req();
      return true;
    }
    if (s.sel) { ED.remove(s.sel); return true; }
    return false;
  }

  function endNudge() {
    clearTimeout(nudgeTimer);
    if (!nudgeOpen) return;
    nudgeOpen = false;
    if (WH.store.gestureOpen) WH.store.end();
  }

  /** Arrow keys: 5 cm (Shift = 20 cm); consecutive presses are one undo step. */
  function nudge(e) {
    const s = S();
    const o = s.sel && ED.find(s.sel);
    if (!o || press) return false;
    const d = WH.ui.keys.arrowDelta(e, 0.05 / ED.mpp(), 4);
    if (!d) return false;
    if (!nudgeOpen || !WH.store.gestureOpen) { WH.store.begin('editor.undo.nudge'); nudgeOpen = true; }
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(endNudge, 700);
    const dx = d.dx / W;
    const dy = d.dy / H;
    WH.store.live((pr) => {
      const ob = ED.find(o.id, pr.plan);
      if (!ob) return false;
      if (ob.type === 'door') {
        const w = ED.find(ob.wallId, pr.plan);
        const len = w ? ED.dpx(w.a, w.b) : 0;
        if (!w || len < 1) return false;
        const ux = ((w.b.x - w.a.x) * W) / len;
        const uy = ((w.b.y - w.a.y) * H) / len;
        const G = WH.engine.geom;
        const ta = G.closestOnSegment(ob.a, w.a, w.b).t;
        const tb = G.closestOnSegment(ob.b, w.a, w.b).t;
        const dt = clamp((d.dx * ux + d.dy * uy) / len, -Math.min(ta, tb), 1 - Math.max(ta, tb));
        const at = (k) => ED.P(w.a.x + (w.b.x - w.a.x) * k, w.a.y + (w.b.y - w.a.y) * k);
        ob.a = at(ta + dt);
        ob.b = at(tb + dt);
        return undefined;
      }
      const c = ED.clampDelta(ED.ptsOf(ob), dx, dy);
      ED.shift(ob, c.dx, c.dy, pr.plan);
      return undefined;
    }, ['plan']);
    return true;
  }

  function canEscape() {
    const s = S();
    return !!(press || draftBusy() || s.tool !== 'select' || s.sel || s.focus);
  }
  function escape() {
    const s = S();
    if (press) { abortPress(); ED.req(); return; }
    if (draftBusy()) { resetDraft(); return; }
    if (s.tool !== 'select') { setTool('select'); return; }
    if (s.sel) { ED.select(null); return; }
    if (s.focus) { s.focus = null; ED.emit('focus'); ED.req(); }
  }

  // ---------------------------------------------------------------------------------------------------------------
  function attach(stageEl, svgEl) {
    stage = stageEl;
    svg = svgEl;
    stage.dataset.tool = S().tool;
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    svg.addEventListener('lostpointercapture', onLost);
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('dblclick', onDbl);
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    // any other key ends a run of arrow-key nudges first, so Ctrl+Z right after nudging undoes it
    window.addEventListener('keydown', (e) => { if (nudgeOpen && !/^Arrow/.test(e.key) && e.key !== 'Shift') endNudge(); }, true);
    window.addEventListener('blur', () => { endNudge(); });
  }

  ED.tools = {
    TOOLS, attach, setTool, endInteraction, resetDraft, draftBusy, enter, insertDefault, backspaceOrDelete, nudge, endNudge,
    canEscape, escape, finishPoly,
  };
})();
