/* Planner (Wi-Fi view) 2/3: the map stage - viewport, floating toolbars, legend, DOM markers (drag + keyboard),
 * hover tooltip, tools (router / measure), measurement popover, "find the best place", PNG export, shortcuts and the
 * WH.views registration. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const S = PL.S;
  const W = PL.W;
  const H = PL.H;
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const store = () => WH.store;
  let st = null; // DOM refs, set by mount()

  // marker kinds: where the position lives in the project and how it is constrained
  const KIND = {
    router: { get: (p) => p.net.router, set: (p, q) => { p.net.router = q; }, topic: 'net', floor: true, undo: 'planner.undo.router' },
    today: { get: (p) => p.net.baseline, set: (p, q) => { p.net.baseline = q; }, topic: 'net', floor: true, undo: 'planner.undo.today' },
    inlet: { get: (p) => p.net.optic, set: (p, q) => { p.net.optic = q; }, topic: 'net', floor: false, undo: 'planner.undo.inlet' },
    node: { get: (p) => p.node.pos, set: (p, q) => { p.node.pos = q; }, topic: 'node', floor: true, undo: 'planner.undo.node' },
    meas: {
      get: (p, id) => p.measurements.find((m) => m.id === id) || null,
      set: (p, q, id) => { const m = p.measurements.find((x) => x.id === id); if (m) { m.x = q.x; m.y = q.y; } },
      topic: 'measurements', floor: true, undo: 'planner.undo.measMove',
    },
  };
  function snapPos(kind, q) {
    const c = { x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) };
    return PL.pt(KIND[kind].floor ? WH.engine.project.nearestFloor(PL.P().plan, c) : c);
  }
  PL.snapPos = snapPos;

  // ---------------------------------------------------------------------------------------------------------------
  // fitting: the plan bounds plus room for the floating toolbars
  // ---------------------------------------------------------------------------------------------------------------
  function fitBox() {
    const b = WH.engine.project.planBounds(PL.P().plan);
    if (!st) return b;
    const sw = st.el.clientWidth;
    const sh = st.el.clientHeight;
    const pad = Math.min(40, Math.min(sw, sh) * 0.05);
    let top = Math.max(st.tl.offsetTop + st.tl.offsetHeight, st.tr.offsetTop + st.tr.offsetHeight) + 14;
    // the speed-view banner sits under the top row: the plan starts below it (also while a popover covers it). Its
    // text changes with the state ("click the map" while the measure tool is on is one line shorter): reserve the
    // tallest height seen while it is up, so pressing "Add measurement" never makes the plan jump under the pointer
    if (!st.sbSlot.hidden) {
      st.sbMax = Math.max(st.sbMax || 0, st.sbSlot.offsetHeight);
      top = Math.max(top, st.sbSlot.offsetTop + st.sbMax + 14);
    } else st.sbMax = 0;
    // the zoom column sits in the corner: only the tools and the legend reserve height at the bottom
    const sr = st.el.getBoundingClientRect();
    let bot = sr.bottom - Math.min(st.legend.getBoundingClientRect().top, st.tools.getBoundingClientRect().top) + 14;
    // measuring mode: only its own two bars take room
    const mi = PL.mm && PL.mm.insets && PL.mm.insets();
    if (mi) { top = mi.top + 14; bot = mi.bottom + 14; }
    const bw = (b.maxX - b.minX) * W;
    const bh = (b.maxY - b.minY) * H;
    const s = Math.min((sh - top - bot) / bh, (sw - 2 * Math.max(pad, 16)) / bw);
    if (!(s > 0.02) || !Number.isFinite(s)) return b;
    const T = Math.max(0, top - pad) / s / H;
    const B = Math.max(0, bot - pad) / s / H;
    const X = Math.max(0, 16 - pad) / s / W;
    return { minX: b.minX - X, maxX: b.maxX + X, minY: b.minY - T, maxY: b.maxY + B };
  }
  // The view follows the plan (re-fit after plan edits / chrome size changes) until the user pans or zooms himself.
  let userNav = false;
  let fitKey = '';
  const boundsKey = () => JSON.stringify(WH.engine.project.planBounds(PL.P().plan));
  PL.fit = (animate) => {
    if (!st) return;
    userNav = false;
    fitKey = boundsKey();
    st.vp.fit(fitBox(), { animate: !!animate });
  };
  const autoFit = () => { if (st && !userNav) PL.fit(false); };

  /** Client px -> normalized point (WH.viewport maps from the stage's padding box = the canvas origin). */
  const toWorld = (cx, cy) => st.vp.toWorld(cx, cy);
  /** Normalized point -> client px (inverse of toWorld). */
  PL.toClient = (q) => st.vp.toClient(q);
  /** Pan the map by screen px (e.g. to keep a point above the measurement sheet); the view then stays where it is. */
  PL.panBy = (dx, dy) => { if (!st) return; userNav = true; st.vp.panBy(dx, dy, { animate: true }); };
  /** Snapshot / restore of the map view (the measurement sheet puts the map back where it was when it closes). */
  PL.viewState = () => (st ? { view: { ...st.vp.view }, userNav } : null);
  PL.setViewState = (s) => {
    if (!st || !s) return;
    if (!s.userNav) { PL.fit(true); return; }
    st.vp.setView(s.view, true);
    userNav = true;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // view state helpers
  // ---------------------------------------------------------------------------------------------------------------
  const setView = (patch) => store().update((p) => { Object.assign(p.view, patch); }, ['view']);
  PL.setView = setView;
  const VIEWS = ['signal', 'speed', 'diff'];
  const BANDS = [2.4, 5, 6];

  function setTool(tool, quiet) {
    if (tool !== 'router' && tool !== 'measure') return;
    if (tool === 'router' && PL.mm && PL.mm.active) { PL.mm.exit(); return; }
    const prev = S.tool;
    S.tool = tool;
    if (tool === 'measure' && prev !== 'measure') PL.ensurePoints();
    if (st) {
      st.toolBtns.router.setAttribute('aria-pressed', String(tool === 'router'));
      st.toolBtns.measure.setAttribute('aria-pressed', String(tool === 'measure'));
      st.el.classList.toggle('is-measure', tool === 'measure');
    }
    if (tool === 'router') closePending();
    else if (!quiet && !store().getPref('planner.remindShown')) {
      store().setPref('planner.remindShown', true);
      S.remind = ui().toast({ i18n: 'planner.m.remind' }, { kind: 'info', ms: 9000 });
    }
    if (!quiet) ui().announce(t(tool === 'measure' ? 'planner.tool.measureOn' : 'planner.tool.routerOn'));
    paintToolbars();
    PL.notifySide();
  }
  PL.setTool = setTool;
  PL.notifySide = () => { if (PL.side && PL.side.schedule) PL.side.schedule(); };

  // ---------------------------------------------------------------------------------------------------------------
  // markers
  // ---------------------------------------------------------------------------------------------------------------
  let drag = null;
  let kbd = null;

  function markerEl(kind, id) {
    const cls = kind === 'today' ? 'ghost' : kind;
    const b = el(`button.pl-mk.pl-mk--${cls}`, { type: 'button', 'data-kind': kind });
    if (id) b.dataset.id = id;
    const dot = el('span.pl-mk__dot');
    if (kind === 'router') dot.append(el('span.pl-mk__txt', { 'data-i18n': 'planner.mk.routerLetter' }, t('planner.mk.routerLetter')));
    if (kind === 'node') dot.append(el('span.pl-mk__txt', '2'));
    if (kind === 'inlet') dot.append(ui().icon('globe', 16));
    b.append(dot);
    if (kind === 'today') b.append(el('span.pl-mk__label', { 'data-i18n': 'planner.mk.todayShort' }, t('planner.mk.todayShort')));
    // the value label (full / short text, see 15-whatif.js) and the numbered badge used when even the short text has
    // no room; the label is placed by layoutLabels() (right, left, above, below)
    if (kind === 'meas') { b._val = el('span.pl-mk__val'); b._no = el('span.pl-mk__no', { 'aria-hidden': 'true' }, el('span.pl-mk__nt')); b.append(b._val, b._no); }
    b.addEventListener('pointerdown', onMkDown);
    b.addEventListener('pointermove', onMkMove);
    b.addEventListener('pointerup', onMkUp);
    b.addEventListener('pointercancel', onMkUp);
    b.addEventListener('click', onMkClick);
    b.addEventListener('keydown', onMkKey);
    b.addEventListener('blur', () => endKbd());
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !drag) markerTip(b); });
    b.addEventListener('pointerleave', () => { if (!drag) hideTip(); });
    b.addEventListener('focus', () => { if (b.matches(':focus-visible')) markerTip(b); });
    return b;
  }

  function onMkDown(e) {
    if (e.button !== 0 || drag) return;
    const b = e.currentTarget;
    e.stopPropagation();
    e.preventDefault();
    try { b.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    const kind = b.dataset.kind;
    const id = b.dataset.id;
    const cur = KIND[kind].get(PL.P(), id);
    if (!cur) return;
    const w = toWorld(e.clientX, e.clientY);
    try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    drag = { b, kind, id, pid: e.pointerId, ox: cur.x - w.x, oy: cur.y - w.y, x0: e.clientX, y0: e.clientY, moved: false, began: false };
    hideTip();
  }
  function onMkMove(e) {
    if (!drag || e.pointerId !== drag.pid || drag.cancelled) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
    drag.moved = true;
    const k = KIND[drag.kind];
    if (!drag.began) { closePending(); beginGesture(drag.kind); drag.began = true; st.el.classList.add('is-dragging'); }
    const w = toWorld(e.clientX, e.clientY);
    const q = snapPos(drag.kind, { x: w.x + drag.ox, y: w.y + drag.oy });
    const id = drag.id;
    store().live((p) => k.set(p, q, id), [k.topic]);
  }
  function onMkUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    st.el.classList.remove('is-dragging');
    try { d.b.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (d.began && !d.cancelled) finishGesture(d.kind, d.id);
    if (d.moved) d.b.dataset.dragged = '1';
  }
  function onMkClick(e) {
    const b = e.currentTarget;
    if (b.dataset.dragged) { delete b.dataset.dragged; return; }
    const kind = b.dataset.kind;
    if (kind === 'today') ghostPopover(b);
    else if (kind === 'meas') { const m = KIND.meas.get(PL.P(), b.dataset.id); if (m) PL.openMeasure(m, m.id); }
  }
  function onMkKey(e) {
    const kind = e.currentTarget.dataset.kind;
    const d = ui().keys.arrowDelta(e, 0.25, 4);
    if (d) {
      e.preventDefault();
      e.stopPropagation();
      nudge(kind, e.currentTarget.dataset.id, d.dx, d.dy);
    } else if (kind === 'meas' && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      deleteMeas(e.currentTarget.dataset.id);
    }
  }

  /** Arrow-key nudge (metres); consecutive presses form one undo step. */
  function nudge(kind, id, dxm, dym) {
    const p = PL.P();
    const cur = KIND[kind].get(p, id);
    if (!cur || drag) return;
    const mpp = p.scale.mpp;
    const q = snapPos(kind, { x: cur.x + dxm / mpp / W, y: cur.y + dym / mpp / H });
    if (!kbd || kbd.kind !== kind || kbd.id !== id || !store().gestureOpen) {
      endKbd();
      beginGesture(kind);
      kbd = { kind, id, timer: 0 };
    }
    store().live((pr) => KIND[kind].set(pr, q, id), [KIND[kind].topic]);
    clearTimeout(kbd.timer);
    kbd.timer = setTimeout(endKbd, 700);
  }
  PL.nudge = nudge;
  function endKbd() {
    if (!kbd) return;
    const k = kbd;
    kbd = null;
    clearTimeout(k.timer);
    finishGesture(k.kind, k.id);
  }

  let gStart = null; // baseline when the current gesture began (moving it invalidates measurements)
  function beginGesture(kind) {
    gStart = { ...PL.P().net.baseline };
    store().begin(KIND[kind].undo);
  }

  async function finishGesture(kind, id) {
    const s = store();
    if (!s.gestureOpen) return;
    // a measurement dropped onto a wall line (or off the floor) steps inside its room (same undo step)
    if (kind === 'meas' && id) {
      const m = KIND.meas.get(s.project, id);
      if (m && PL.measOff(m)) { const q = PL.insidePoint(m, 0.25); s.live((p) => KIND.meas.set(p, q, id), ['measurements']); }
    }
    if (kind === 'today' && s.project.measurements.length && !PL.same(s.project.net.baseline, gStart)) {
      const ok = await ui().confirm({ title: t('planner.today.confirmT'), body: t('planner.today.confirmB', { n: s.project.measurements.length }), ok: t('planner.today.confirmOk'), danger: true });
      if (!s.gestureOpen) return;
      if (!ok) { s.cancel(); return; }
      s.live((p) => { p.measurements = []; }, ['measurements']);
    }
    s.end();
    if (kind === 'router') s.setPref('planner.movedOnce', true);
    if (kind === 'today') s.setPref('planner.baselineOk', true);
    afterMoveAnnounce(kind);
  }

  function afterMoveAnnounce(kind) {
    if (kind !== 'router') return;
    setTimeout(() => {
      const a = S.a;
      if (!a) return;
      ui().announce(t('planner.sr.router', { room: (PL.roomAt(PL.P().net.router) || {}).name || '', cov: WH.util.fmtPct(a.stats.trial.coverage) }));
    }, 300);
  }

  /**
   * Centre a text glyph (marker letter) by its INK box, not the font's line box: the canvas text metrics of the same
   * font give the ink extents, the span is shifted by the difference (font-metric independent; SPEC 7.2).
   */
  let gctx = null;
  function centerGlyph(span) {
    if (!span || !span.isConnected || !span.offsetWidth) return false;
    const cs = getComputedStyle(span);
    const K = 20;   // measure 20x larger: the canvas rounds ink extents to whole pixels
    gctx = gctx || document.createElement('canvas').getContext('2d');
    gctx.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * K}px ${cs.fontFamily}`;
    const m = gctx.measureText(span.textContent || '');
    if (!m || !Number.isFinite(m.actualBoundingBoxAscent)) return false;
    // where the browser put the baseline inside the span: a zero-size inline-block sits on it
    span.style.transform = '';
    const probe = document.createElement('i');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    span.append(probe);
    const sr = span.getBoundingClientRect();
    const base = probe.getBoundingClientRect().top - sr.top;
    probe.remove();
    const dx = sr.width / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 / K;
    const dy = sr.height / 2 - (base - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 / K);
    if (!(Math.abs(dx) < 4 && Math.abs(dy) < 4)) return false;
    span.style.transform = `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)`;
    span.dataset.glyph = span.textContent;
    return true;
  }
  PL.centerGlyph = centerGlyph;

  /** Position every marker over the canvas (called after each draw). */
  function place() {
    if (!st) return;
    const p = PL.P();
    const vp = st.vp;
    const has = p.plan.rooms.length > 0;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v) => (Math.round(v * dpr) / dpr).toFixed(2);   // whole device pixels: crisp ring and letter
    const pos = (b, q) => {
      if (!q) { b.hidden = true; return; }
      const s = vp.toScreen(q);
      b.style.transform = `translate(${snap(s.x)}px,${snap(s.y)}px) translate(-50%,-50%)`;
    };
    for (const k of ['router', 'node']) {
      const g = st.mk[k].querySelector('.pl-mk__txt');
      if (g && !st.mk[k].hidden && g.dataset.glyph !== g.textContent) centerGlyph(g);
    }
    const M = st.mk;
    M.router.hidden = !has;
    M.today.hidden = !has || !PL.moved();
    M.node.hidden = !has || p.node.mode === 'none';
    M.inlet.hidden = !has;
    pos(M.router, p.net.router);
    pos(M.today, p.net.baseline);
    pos(M.node, p.node.pos);
    pos(M.inlet, p.net.optic);
    // phones / zoomed out: the inlet disc overlapped today's dashed ring, its "Today" label and the router disc - push
    // it just clear (on screen only, so all of them stay visible and grabbable; the router may stand right at the
    // inlet, a real and common place: the inlet then sits beside it like a cluster)
    if (has && p.net.optic) {
      const o = vp.toScreen(p.net.optic);
      const R_IN = 13 + 3;                                    // inlet disc radius + a small gap
      const obst = [];                                        // {c, r} discs and {l, t, r, b} boxes, host px
      if (PL.moved()) {
        const c = vp.toScreen(p.net.baseline);
        obst.push({ c, r: 14 });
        const lab = M.today.querySelector('.pl-mk__label');
        const lw = (lab && lab.offsetWidth) || 40;
        obst.push({ l: c.x - lw / 2, r: c.x + lw / 2, t: c.y + 17, b: c.y + 35 });   // the label below the ring (CSS)
      }
      obst.push({ c: vp.toScreen(p.net.router), r: 17 });
      let x = o.x;
      let y = o.y;
      for (let it = 0; it < 3; it++) {
        for (const ob of obst) {
          if (ob.c) {
            const need = ob.r + R_IN;
            const dx = x - ob.c.x;
            const dy = y - ob.c.y;
            const d = Math.hypot(dx, dy);
            if (d >= need) continue;
            if (d > 0.5) { x = ob.c.x + (dx / d) * need; y = ob.c.y + (dy / d) * need; } else x = ob.c.x + need;
          } else {
            const l = ob.l - R_IN, r = ob.r + R_IN, t = ob.t - R_IN, b = ob.b + R_IN;
            if (x <= l || x >= r || y <= t || y >= b) continue;
            const m = Math.min(x - l, r - x, y - t, b - y);   // leave through the nearest side
            if (m === x - l) x = l; else if (m === r - x) x = r; else if (m === y - t) y = t; else y = b;
          }
        }
      }
      if (x !== o.x || y !== o.y) M.inlet.style.transform = `translate(${snap(x)}px,${snap(y)}px) translate(-50%,-50%)`;
    }
    // measurement dots (keyed by id). Label (15-whatif.js): the measured dBm, "↓ 245 / ↑ 38" in the Speed view (and for
    // speed-only points), "−72 → −58 (+14)" / "↓120 → ≈310" while the router is moved or a second node is on. Every dot
    // keeps a label: crowded ones get the short form, then a numbered badge (the list in the sidebar has the numbers).
    const seen = new Set();
    const pal = p.view.palette;
    const dots = [];
    const view = p.view.layer;
    // layer "Body měření" off: no dots on the map (the list in the sidebar stays); a row clicked there still shows its
    // own dot for a moment (S.peek, PL.showMeas)
    const showPts = p.view.points !== false;
    p.measurements.forEach((m, i) => {
      seen.add(m.id);
      let b = st.meas.get(m.id);
      if (!b) { b = markerEl('meas', m.id); st.meas.set(m.id, b); st.layer.append(b); }
      const sig = Number.isFinite(m.value);
      const lab = PL.wi.label(m, i, view);
      const key = `${lab.key}|${m.value}|${m.band}|${pal}|${p.view.band}|${m.name}|${WH.i18n.lang}`;
      if (b._key !== key) {
        b._key = key;
        if (sig) { const c = WH.engine.raster.signalColor(m.value, pal); b.firstChild.style.background = `rgb(${c[0]},${c[1]},${c[2]})`; } else b.firstChild.style.background = '';
        b.classList.toggle('is-nosig', !sig);
        b.classList.toggle('is-other', PL.bands.isOther(m));
        PL.wi.fill(b._val, lab);
        b._no.firstChild.textContent = String(lab.no);
        b._size = null;
        const aria = sig
          ? t('planner.mk.measAria', { name: m.name, v: WH.util.dbm(m.value), band: PL.bands.info(m).text })
          : t('planner.mk.measAriaSpeed', { name: m.name, d: PL.mbps(m.download), u: PL.mbps(m.upload), band: PL.bands.info(m).text });
        b.setAttribute('aria-label', PL.wi.active() && lab.tone ? `${aria} ${lab.text}` : aria);
      }
      b.hidden = !has || !(showPts || S.peek === m.id);
      pos(b, m);
      // on a wall line / off the floor (SPEC 10): a warning ring on the dot, the list offers "Posunout dovnitř"
      const offKey = `${m.x},${m.y},${S.planVer},${p.scale.mpp}`;
      if (b._offKey !== offKey) { b._offKey = offKey; b.classList.toggle('is-off', has && PL.measOff(m)); }
      if (!b.hidden) dots.push({ b, m, i, s: vp.toScreen(m), tone: lab.tone, d: lab.tone ? Math.abs((PL.wi.row(m.id) || {}).delta || 0) : 0 });
    });
    for (const [id, b] of st.meas) if (!seen.has(id)) { b.remove(); st.meas.delete(id); }
    layoutLabels(dots);
    if (tipOwner && tipOwner !== 'map' && (tipOwner.hidden || !tipOwner.isConnected)) hideTip();
    if (S.pending) {
      pos(S.pending.anchor, S.pending.at);
      if (S.pending.h) S.pending.h.reposition();
    }
  }

  /**
   * Place the value labels of the measurement dots (SPEC 10): each label tries right, left, above, below of its dot -
   * full text first, then the short form ("+14", "−63", "↓245") - and takes the first spot that stays inside the stage
   * and clear of the other dots, labels, markers and the floating controls. When even the short form has no room the dot
   * shows its number (the sidebar list has the same numbers). Labels are DOM over the canvas, so they always sit above
   * the range lines; their solid background + halo keeps them legible on any colour.
   */
  let ctrlCache = { at: 0, key: '', rects: [] };
  function controlRects() {
    const now = performance.now();
    const key = `${st.el.clientWidth}x${st.el.clientHeight}|${st.sbSlot.hidden}|${!!(PL.mm && PL.mm.active)}|${st.prog.hidden}`;
    if (key === ctrlCache.key && now - ctrlCache.at < 400) return ctrlCache.rects;
    const sr = st.el.getBoundingClientRect();
    const ox = sr.left + st.el.clientLeft;
    const oy = sr.top + st.el.clientTop;
    const rects = [...st.el.querySelectorAll(':scope > .stage__slot > *, :scope > .pl-bottom > *, :scope > .pl-progress')]
      .filter((n) => n.offsetWidth && !n.closest('[hidden]') && getComputedStyle(n).visibility !== 'hidden')
      .map((n) => { const r = n.getBoundingClientRect(); return { l: r.left - ox - 4, t: r.top - oy - 4, r: r.right - ox + 4, b: r.bottom - oy + 4 }; });
    ctrlCache = { at: now, key, rects };
    return rects;
  }
  const GAP = 10;   // dot radius + a little air
  function layoutLabels(dots) {
    if (!dots.length) { if (S.badges) { S.badges = 0; PL.notifySide(); } return; }
    const W0 = st.el.clientWidth;
    const H0 = st.el.clientHeight;
    for (const d of dots) {
      const b = d.b;
      if (!b._size) {
        // measured once per content change: both lengths (CSS shows one of them through data-lv)
        b.dataset.lv = '0';
        const w0 = b._val.offsetWidth;
        const h = b._val.offsetHeight || 18;
        b.dataset.lv = '1';
        b._size = { w: [w0, b._val.offsetWidth], h };
        delete b.dataset.lv;
      }
    }
    const hit = (r, list, own) => list.some((o) => (!own || o.own !== own) && r.l < o.r && r.r > o.l && r.t < o.b && r.b > o.t);
    const obst = dots.map((d) => ({ l: d.s.x - 9, t: d.s.y - 9, r: d.s.x + 9, b: d.s.y + 9, own: d.b }));
    for (const k of ['router', 'node', 'inlet', 'today']) {
      const mk = st.mk[k];
      if (mk.hidden) continue;
      const q = k === 'router' ? PL.P().net.router : k === 'node' ? PL.P().node.pos : k === 'inlet' ? PL.P().net.optic : PL.P().net.baseline;
      const c = st.vp.toScreen(q);
      const r = k === 'router' ? 19 : 16;
      obst.push({ l: c.x - r, t: c.y - r, r: c.x + r, b: c.y + r + (k === 'today' ? 20 : 0) });
    }
    // the numbered pins of the "Prvotní měření" guide (28-calib-wizard.js) while it is open
    const cs = PL.calib && PL.calib.isOpen && PL.calib.isOpen() ? PL.calib.state() : null;
    if (cs && cs.step === 'measure') {
      for (const s of cs.spots) {
        if (s.state === 'done') continue;
        const c = st.vp.toScreen({ x: Number.isFinite(s.ax) ? s.ax : s.x, y: Number.isFinite(s.ay) ? s.ay : s.y });
        obst.push({ l: c.x - 17, t: c.y - 17, r: c.x + 17, b: c.y + 17 });
      }
    }
    const ctrls = controlRects();
    // the room names drawn on the canvas (10-core drawScene): a label first looks for a spot that leaves them readable
    const names = S.roomLabs || [];
    const placed = [];
    const zoomedOut = st.vp.view.scale / (st.vp.fitScale || 1) < 0.75;
    // the biggest changes get the room first; otherwise the list order
    const order = dots.slice().sort((a, b) => b.d - a.d || a.i - b.i);
    let badges = 0;
    // beside the dot, above / below it, then diagonally off one of its corners
    const SIDES = ['r', 'l', 't', 'b', 'tr', 'tl', 'br', 'bl'];
    const offset = (s, ww, h) => {
      if (s === 'r') return [GAP, -h / 2];
      if (s === 'l') return [-GAP - ww, -h / 2];
      if (s === 't') return [-ww / 2, -GAP - h + 2];
      if (s === 'b') return [-ww / 2, GAP - 2];
      return [s[1] === 'r' ? 7 : -7 - ww, s[0] === 't' ? -6 - h : 6];
    };
    for (const d of order) {
      const b = d.b;
      const { w, h } = b._size;
      const sides = SIDES.slice();
      if (b._side && b._side !== 'r' && sides.includes(b._side)) sides.unshift(sides.splice(sides.indexOf(b._side), 1)[0]);   // stable while dragging
      let pick = null;
      // full text clear of the room names, the short form clear of them, then (crowded small maps, phones) the
      // full / short text over a name - a room name stays readable before a label keeps its long form
      const lvs = zoomedOut ? [1] : [0, 1];
      find: for (const soft of names.length ? [true, false] : [false]) {
        for (const lv of lvs) {
          const ww = w[lv];
          for (const s of sides) {
            const [dx, dy] = offset(s, ww, h);
            const r = { l: d.s.x + dx, t: d.s.y + dy, r: d.s.x + dx + ww, b: d.s.y + dy + h };
            if (r.l < 4 || r.t < 4 || r.r > W0 - 4 || r.b > H0 - 4) continue;
            if (hit(r, obst, b) || hit(r, placed) || hit(r, ctrls) || (soft && hit(r, names))) continue;
            pick = { lv, s, dx, dy, r };
            break find;
          }
        }
      }
      if (pick) {
        placed.push(pick.r);
        b.dataset.lv = String(pick.lv);
        b._side = pick.s;
        b._val.style.transform = `translate(${Math.round(pick.dx)}px,${Math.round(pick.dy)}px)`;
        b._lr = { l: pick.dx, t: pick.dy, r: pick.dx + w[pick.lv], b: pick.dy + h };
      } else {
        // no room at all: the dot's number (top right of the dot), the full text stays in its tooltip and the list
        b.dataset.lv = '2';
        b._lr = { l: 2, t: -20, r: 18, b: -4 };
        const g = b._no.firstChild;
        if (g.dataset.glyph !== g.textContent) centerGlyph(g);
        badges += 1;
      }
    }
    if (S.badges !== badges) { S.badges = badges; PL.notifySide(); }
  }

  function markerLabels() {
    if (!st || !S.a) return;
    const p = PL.P();
    const a = S.a;
    const sig = (q) => { const v = WH.engine.raster.sample(a.grid, a.trial, q); return Number.isFinite(v) ? WH.util.dbm(v) : '—'; };
    const room = (q) => (PL.roomAt(q) || {}).name || t('planner.tip.outside');
    st.mk.router.setAttribute('aria-label', t('planner.mk.routerAria', { room: room(p.net.router), v: sig(p.net.router) }));
    st.mk.today.setAttribute('aria-label', t('planner.mk.todayAria', { room: room(p.net.baseline) }));
    st.mk.node.setAttribute('aria-label', t('planner.mk.nodeAria', { room: room(p.node.pos) }));
    st.mk.inlet.setAttribute('aria-label', t('planner.mk.inletAria'));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // tooltip
  // ---------------------------------------------------------------------------------------------------------------
  let tipTimer = 0;
  let tipOwner = null; // 'map' or the marker element the tooltip describes
  function hideTip() { if (st) st.tip.hidden = true; tipOwner = null; clearTimeout(tipTimer); }
  function showTipAt(nodes, x, y) {
    const tip = st.tip;
    tip.replaceChildren(...nodes.filter(Boolean));
    tip.hidden = false;
    const b = st.el.getBoundingClientRect();
    const r = { left: b.left + st.el.clientLeft, top: b.top + st.el.clientTop, width: st.el.clientWidth, height: st.el.clientHeight };
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const px = x - r.left;
    const py = y - r.top;
    // the four corners around the pointer; the first one inside the stage and clear of the floating controls wins
    const ctrls = [...st.el.querySelectorAll('.toolbar, .legend, .pl-sb, .pl-progress')].filter((n) => n.offsetWidth && !n.closest('[hidden]'))
      .map((n) => { const b2 = n.getBoundingClientRect(); return { l: b2.left - r.left, t: b2.top - r.top, r: b2.right - r.left, b: b2.bottom - r.top }; });
    const fits = (lx, ly) => lx >= 8 && ly >= 8 && lx + w <= r.width - 8 && ly + h <= r.height - 8;
    const clear = (lx, ly) => !ctrls.some((c) => lx < c.r && lx + w > c.l && ly < c.b && ly + h > c.t);
    const opts = [[px + 16, py + 16], [px - 16 - w, py + 16], [px + 16, py - 16 - h], [px - 16 - w, py - 16 - h]];
    let pick = opts.find(([a, b2]) => fits(a, b2) && clear(a, b2)) || opts.find(([a, b2]) => fits(a, b2));
    if (!pick) {
      let lx = px + 16;
      let ly = py + 16;
      if (lx + w > r.width - 8) lx = px - 16 - w;
      if (ly + h > r.height - 8) ly = py - 16 - h;
      pick = [lx, ly];
    }
    tip.style.transform = `translate(${Math.round(Math.max(8, pick[0]))}px,${Math.round(Math.max(8, pick[1]))}px)`;
  }
  const line = (...k) => el('div', ...k);
  /** "↓ 420  ↑ 130 Mb/s" - each arrow sticks to its number. */
  const speedLine = (d, u) => line({ class: 'pl-tip__speed' }, el('span.pl-sp', ui().icon('download', 16), el('b.num', PL.mbps(d))), el('span.pl-sp', ui().icon('upload', 16), el('b.num', PL.mbps(u))), el('span', t('planner.mbps')));

  function pointTip(p, cx, cy) {
    const pr = PL.P();
    const E = WH.engine;
    const room = E.project.roomAt(pr.plan, p);
    if (!room || !S.ctx || !S.offs) { hideTip(); return; }
    const d = E.model.pointSignalDetail(S.ctx, p, E.model.fieldParams(pr, 'trial', { offsets: S.offs }));
    const nodeOn = pr.node.mode !== 'none';
    const auto = E.model.isAuto(pr.view.band);
    const out = [
      el('div.pl-tip__title', room.name),
      line(el('i.pl-sw', { style: { background: PL.qVar(d.combined) } }), el('b.num', WH.util.dbm(d.combined)), el('span.pl-tip__dot', '·'), el('span', PL.qWord(d.combined)),
        // Auto (SPEC 13): the band a steering device would use here
        auto && d.band ? el('span.pl-tip__dot', '·') : null, auto && d.band ? el('span', PL.bands.ghz(d.band)) : null),
    ];
    if ((PL.moved() || nodeOn) && Number.isFinite(d.baseline)) out.push(line({ class: 'text-muted' }, t('planner.tip.delta', { d: PL.db(d.combined - d.baseline) })));
    // what the walls on the way cost on this band (2.4 GHz gets through more easily, SPEC 7.1)
    const wl = PL.pathLoss(pr.net.router, p, auto ? d.band : pr.view.band);
    if (Number.isFinite(wl) && wl >= 0.5) out.push(line({ class: 'text-muted' }, t('planner.tip.walls', { d: WH.util.fmt(wl, 0) })));
    if (nodeOn && d.node !== null) out.push(line({ class: 'text-muted' }, t(d.bestSource === 'node' ? 'planner.tip.fromNode' : 'planner.tip.fromRouter')));
    if (d.weakBackhaul) out.push(line({ class: 'pl-tip__warn' }, t('planner.tip.weakBackhaul')));
    if (S.sp) {
      const sp = S.sp;
      if (!sp.curve) out.push(line({ class: 'text-muted' }, t('planner.tip.speedNone')));
      else {
        // the same rule as the Speed map (SPEC 10): the stronger source, the node's link and ceiling, the plan
        const ps = E.speed.pointSpeed(S.ctx, p, E.model.fieldParams(pr, 'trial', { offsets: S.offs }), sp.curve, PL.speedLimits(pr), { backhaulCurve: sp.bhCurve || undefined, link: sp.link || undefined });
        if (ps.known) out.push(speedLine(ps.down, ps.up));
        else out.push(line({ class: 'text-muted' }, t(ps.reason === 'backhaul' ? 'planner.tip.speedBh' : 'planner.tip.speedWeak')));
        const k = ps.known && ps.limitedBy ? ps.limitedBy : null;
        if (k) out.push(line({ class: 'pl-tip__cap' }, ui().icon('lock', 16), el('span', PL.wi.capText({ k, v: ps.capDown }))));
        // the map's speeds keep the planning reserve, the ceilings are the raw numbers: say why they differ
        if (ps.known && pr.goal.reserve > 0) out.push(line({ class: 'text-muted text-xs' }, t('planner.tip.reserve', { r: WH.util.fmtPct(pr.goal.reserve) })));
      }
    }
    showTipAt(out, cx, cy);
    tipOwner = 'map';
  }

  function markerTip(b) {
    const kind = b.dataset.kind;
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (kind !== 'meas') {
      showTipAt([el('div.pl-tip__title', t(`planner.mk.${kind}`)), line({ class: 'text-muted' }, t(`planner.mk.${kind}Tip`))], cx, cy);
      tipOwner = b;
      return;
    }
    const pr = PL.P();
    const m = KIND.meas.get(pr, b.dataset.id);
    if (!m) return;
    const sig = Number.isFinite(m.value);
    const bi = PL.bands.info(m);
    const out = [el('div.pl-tip__title', m.name), line(sig ? el('b.num', WH.util.dbm(m.value)) : el('span', t('planner.m.sigEstimated')), el('span.pl-tip__dot', '·'), el('span', bi.text))];
    if (bi.kind === 'none') out.push(line({ class: 'pl-tip__warn' }, t('planner.bd.unverified')));
    if (S.ctx && S.offs && bi.band) {
      const model = WH.engine.model.softSignal(S.ctx, pr.net.baseline, m, bi.band, WH.engine.model.offsetFor(S.offs, bi.band));
      out.push(line({ class: 'text-muted' }, sig ? t('planner.tip.model', { v: WH.util.dbm(model), d: PL.db(m.value - model) }) : t('planner.tip.modelOnly', { v: WH.util.dbm(model) })));
    }
    if (m.download !== null || m.upload !== null) out.push(speedLine(m.download, m.upload));
    if (Number.isFinite(m.ping)) out.push(line({ class: 'text-muted' }, t('planner.m.pingJitter', { p: WH.util.fmt(m.ping, 0), j: WH.util.fmt(Number.isFinite(m.jitter) ? m.jitter : 0, 0) })));
    if (m.device) out.push(line({ class: 'text-muted' }, PL.icon(PL.dev.iconOf(m.device), 16), PL.dev.label(m.device)));
    if (m.wifi && PL.wifiLine) { const wl = PL.wifiLine(m.wifi); if (wl) out.push(line({ class: 'text-muted' }, PL.icon('wifi', 16), wl)); }
    // SPEC 10: what the moved router / the second node would do here (measured, model today / new, predicted, the limit)
    out.push(...PL.wi.tip(m));
    if (PL.measOff(m)) out.push(line({ class: 'pl-tip__warn' }, t('planner.wi.off')));
    showTipAt(out, cx, cy);
    tipOwner = b;
  }
  /** Show one measurement on the map: its tooltip at the dot and a short pulse (the what-if list in the sidebar). */
  PL.showMeas = (id) => {
    let b = st && st.meas.get(id);
    if (!b) return;
    // layer "Body měření" off: this one dot comes up for the pulse, then hides again
    if (b.hidden && PL.P().view.points === false && PL.P().plan.rooms.length) {
      clearTimeout(S.peekTimer);
      S.peek = id;
      place();
      S.peekTimer = setTimeout(() => { S.peek = null; if (tipOwner === b) hideTip(); place(); }, 3300);
      b = st.meas.get(id);
    }
    if (!b || b.hidden) return;
    const r = b.getBoundingClientRect();
    const sr = st.el.getBoundingClientRect();
    if (r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom) { PL.panBy(sr.left + sr.width / 2 - (r.left + r.width / 2), sr.top + sr.height / 2 - (r.top + r.height / 2)); }
    requestAnimationFrame(() => {
      markerTip(b);
      b.classList.remove('is-pulse');
      void b.offsetWidth;
      b.classList.add('is-pulse');
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => { if (tipOwner === b) hideTip(); b.classList.remove('is-pulse'); }, 3200);
    });
  };

  // ---------------------------------------------------------------------------------------------------------------
  // actions: move router, back to today, mark as today, measurements
  // ---------------------------------------------------------------------------------------------------------------
  function moveRouterTo(p) {
    const q = snapPos('router', p);
    store().commit('planner.undo.router', (pr) => { pr.net.router = q; }, ['net']);
    store().setPref('planner.movedOnce', true);
    afterMoveAnnounce('router');
  }
  function backToToday() {
    if (!PL.moved()) { ui().toast({ i18n: 'planner.router.alreadyToday' }, { ms: 2200 }); return; }
    store().commit('planner.undo.back', (p) => { p.net.router = { ...p.net.baseline }; }, ['net']);
  }
  PL.backToToday = backToToday;
  async function markToday() {
    const p = PL.P();
    if (!PL.moved()) { store().setPref('planner.baselineOk', PL.posKey(p.net.baseline)); ui().toast({ i18n: 'planner.router.markedSame' }, { kind: 'ok', ms: 2500 }); return; }
    const n = p.measurements.length;
    if (n && !(await ui().confirm({ title: t('planner.today.confirmT'), body: t('planner.today.confirmB', { n }), ok: t('planner.today.confirmOk'), danger: true }))) return;
    if (!store().commit('planner.undo.markToday', (pr) => { pr.net.baseline = { ...pr.net.router }; pr.measurements = []; }, ['net', 'measurements'])) return;
    // remember WHICH position was confirmed: after an undo the checklist step is open again
    store().setPref('planner.baselineOk', PL.posKey(PL.P().net.baseline));
    ui().toast({ i18n: 'planner.router.marked', action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.markToday') store().undo(); } } }, { kind: 'ok' });
  }
  PL.markToday = markToday;

  function ghostPopover(b) {
    const h = ui().popover(b, el('div.stack.gap-2',
      el('p.text-sm.text-ink2', t('planner.mk.todayTip')),
      ui().button({ i18n: 'planner.router.backHere', icon: 'undo', kbd: 'D', variant: 'primary', size: 'sm', onClick: () => { h.close(); backToToday(); } })),
    { title: { i18n: 'planner.mk.today' }, placement: 'bottom', align: 'center', width: 260 });
  }

  function deleteMeas(id) {
    const m = KIND.meas.get(PL.P(), id);
    if (!m) return;
    closePending();
    store().commit('planner.undo.measDel', (p) => { p.measurements = p.measurements.filter((x) => x.id !== id); }, ['measurements']);
    ui().toast({ text: t('planner.m.deleted', { name: m.name }), action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.measDel') store().undo(); } } }, { kind: 'info' });
    const a = document.activeElement;
    if (st && (!a || a === document.body || a.classList.contains('pl-mk'))) st.canvas.focus({ preventScroll: true });
  }
  PL.deleteMeas = deleteMeas;

  function closePending() { if (S.pending && S.pending.h) S.pending.h.close(); }
  PL.closePending = closePending;

  // the measurement form (popover / phone bottom sheet) lives in 25-measure.js: PL.openMeasure(at, id)

  // ---------------------------------------------------------------------------------------------------------------
  // find the best place
  // ---------------------------------------------------------------------------------------------------------------
  /** What the optimizer's answer depends on (band, goal, second node, plan): a found best spot is only "the best" while
   *  this stays the same. */
  function optKey() { const q = PL.P(); return [q.view.band, JSON.stringify(q.goal), JSON.stringify(q.node), q.plan.rooms.length, S.planVer].join('|'); }
  /** The router stands where "Find the best spot" put it (and nothing it depends on changed since). */
  PL.atBest = () => !!(S.best && PL.same(PL.P().net.router, S.best.pos) && S.best.key === optKey());

  async function findBest() {
    if (S.opt || !st) return;
    const p = PL.P();
    const E = WH.engine;
    if (!p.plan.rooms.length) { ui().toast({ i18n: 'planner.noplan.t' }, { kind: 'warn' }); return; }
    const ctx = E.model.createContext(p);
    PL.ensureCtx(p);
    const grid = E.raster.grid(ctx, { cell: 4 });
    const g = p.goal;
    let speed = null;
    if (p.view.layer === 'speed' && S.sp && S.sp.curve && p.node.mode === 'none') {
      speed = { curve: S.sp.curve, targetDown: g.targetDown, targetUp: g.targetUp, limits: PL.speedLimits(p), reserve: g.reserve };
    }
    const sig = optKey;
    const before = sig();
    const ac = new AbortController();
    S.opt = ac;
    // under the top toolbars (and under the speed banner when it is there) - never over them
    const below = [st.tl, st.tr, st.sbSlot.hidden ? null : st.sbSlot].filter(Boolean).reduce((m, n) => Math.max(m, n.offsetTop + n.offsetHeight), 0);
    st.prog.style.top = `${below + 8}px`;
    st.prog.hidden = false;
    st.progBar.setValue(0);
    st.el.classList.add('stage--loading');
    PL.notifySide();
    let r = null;
    try {
      r = await E.optimize.find(ctx, grid, {
        // Auto (SPEC 13): the router's own bands + steering thresholds, so a 6 GHz router is searched on 6 GHz too
        band: p.view.band, bands: E.model.routerBandList(p), steer: E.model.steerOf(p),
        goalRoom: g.room === 'all' ? null : g.room, allowedRoom: g.allowedRoom === 'any' ? null : g.allowedRoom,
        threshold: p.model.threshold, excluded: g.excluded, router: { ...p.net.router }, node: E.model.nodeParams(p), offsets: { ...S.offs }, speed,
      }, { onProgress: (f) => st.progBar.setValue(f), signal: ac.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') ui().toast({ i18n: 'planner.opt.cancelled' }, { ms: 2200 });
      else {
        // an engine refusal (err.*) is an explained situation, anything else a bug: both get the specific toast
        const known = !!(e && /^err\./.test(e.message));
        PL.report(e, 'planner.optimize', { bug: !known, toast: { i18n: known ? e.message : 'planner.opt.failed' } });
      }
    } finally {
      S.opt = null;
      if (st) { st.prog.hidden = true; st.el.classList.remove('stage--loading'); }
      PL.notifySide();
    }
    if (!r) return;
    if (sig() !== before) { ui().toast({ i18n: 'planner.opt.stale' }, { kind: 'warn' }); return; }
    const cur = PL.P().net.router;
    const gain = r.before ? r.after.coverage - r.before.coverage : 1;
    if (r.before && gain < 0.5 && r.after.mean - r.before.mean < 0.5) {
      S.best = { pos: { ...cur }, key: before };
      ui().toast({ i18n: 'planner.opt.already' }, { kind: 'ok' });
      PL.notifySide();
      return;
    }
    S.best = { pos: PL.pt(r.pos), key: before };
    store().commit('planner.undo.optimize', (pr) => { pr.net.router = PL.pt(r.pos); }, ['net']);
    store().setPref('planner.movedOnce', true);
    const room = PL.roomName(r.roomId) || t('planner.tip.outside');
    const pct = WH.util.fmtPct;
    ui().toast({
      text: t('planner.opt.found', { room, a: pct(r.before ? r.before.coverage : 0), b: pct(r.after.coverage) }) + (speed ? ' ' + t('planner.opt.bySpeed') : ''),
      action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.optimize') store().undo(); } },
    }, { kind: 'ok' });
    if (!PL.same(cur, r.pos)) afterMoveAnnounce('router');
  }
  PL.findBest = findBest;

  // ---------------------------------------------------------------------------------------------------------------
  // legend (DOM) - the same spec is drawn into the PNG export
  // ---------------------------------------------------------------------------------------------------------------
  const sigPos = (d) => (d <= -45 ? Math.max(0, (d + 85) / 50) : 0.8 + Math.min(1, (d + 45) / 15) * 0.2);
  function legendSpec() {
    const p = PL.P();
    const v = p.view;
    const g = p.goal;
    if (S.mode === 'diff') {
      return { cls: 'legend--diff', title: t('planner.legend.diff'), hint: 'diffView', stops: ['--diff-neg', '--diff-zero', '--diff-pos'], words: [['planner.legend.worse', 0], ['planner.legend.same', 0.5], ['planner.legend.better', 1]], ticks: [[0, PL.db(-10)], [0.5, '0'], [1, PL.db(10)]] };
    }
    if (S.mode === 'speed') {
      // SPEC 10: what the hatch means ("omezí propojení s routerem (≈ 300 Mb/s)")
      let cap = '';
      if (S.capHatch && S.sp && S.sp.capKind) {
        const l = S.sp.link || {};
        const v = S.sp.capKind === 'device' ? p.node.maxMbps : Number.isFinite(l.capDown) ? l.capDown : l.down;
        cap = t('planner.legend.cap', { what: PL.wi.capNoun({ k: S.sp.capKind, v: Number.isFinite(v) ? v : null }) });
      }
      return { cls: 'pl-legend--speed', title: t('planner.legend.speed', { d: PL.mbps(g.targetDown), u: PL.mbps(g.targetUp) }), hint: 'speedView', stops: ['--heat-1', '--heat-3', '--heat-5', '--heat-6'], words: [['planner.legend.below', 0], ['planner.legend.meets', 1]], ticks: [0, 50, 100, 150].map((n, i) => [i / 3, WH.util.fmtPct(n)]), unknown: true, cap };
    }
    const cb = v.palette === 'cb';
    return {
      cls: cb ? 'legend--cb' : '', title: t('planner.legend.signal', { b: PL.bandText(v.band) }), hint: 'dbm',
      stops: [1, 2, 3, 4, 5, 6].map((i) => (cb ? `--heat-cb-${i}` : `--heat-${i}`)),
      // each word sits over its own part of the scale (weak -75..-67, good -67..-50), so the "good from" marker
      // falls between "Weak" and "Good"
      words: [['planner.legend.bad', 0], ['planner.q.weak', sigPos(-71)], ['planner.q.good', sigPos(-58.5)], ['planner.q.excellent', 1]],
      ticks: [-85, -75, -65, -55, -45, -30].map((d) => [sigPos(d), WH.util.fmt(d, 0)]),
      marker: sigPos(p.model.threshold), thr: t('planner.legend.thr', { v: WH.util.dbm(p.model.threshold) }),
    };
  }
  PL.legendSpec = legendSpec;

  /** Auto: [[band, % of the target floor]] of the trial scenario (the bands the router sends, 6 -> 2.4), else null. */
  function zoneShare() {
    const a = S.a;
    const p = PL.P();
    if (!a || !WH.engine.model.isAuto(p.view.band) || !a.bandShare || !a.bandShare.trial) return null;
    const sh = a.bandShare.trial;
    const out = [6, 5, 2.4].filter((b) => Number.isFinite(sh[WH.engine.units.bandKey(b)]) && WH.engine.model.routerBandList(p).includes(b)).map((b) => [b, Math.round(sh[WH.engine.units.bandKey(b)])]);
    return out.length > 1 ? out : null;
  }
  let legendKey = '';
  function renderLegend() {
    if (!st) return;
    const L = legendSpec();
    const p = PL.P();
    const rb = WH.engine.model.routerBandList(p);
    const key = JSON.stringify(L) + p.view.ranges + p.model.rangeThreshold + WH.i18n.lang + JSON.stringify(zoneShare()) + rb.join(',');
    if (key === legendKey) return;
    legendKey = key;
    const box = st.legend;
    box.className = 'legend pl-legend ' + L.cls;
    const bar = el('div.legend__bar', L.marker !== undefined ? el('i.legend__marker', { style: { left: `${(L.marker * 100).toFixed(1)}%` } }) : null);
    const ticks = el('div.legend__ticks.pl-ticks', L.ticks.map(([pos, txt]) => el('span', { style: { left: `${(pos * 100).toFixed(2)}%` } }, txt)));
    const parts = [
      el('div.legend__title.pl-legend__head', el('span', L.title), ui().hint(L.hint), L.thr ? el('span.pl-legend__thr', L.thr) : null),
      bar,
      el('div.legend__words.pl-words', L.words.map(([k, pos]) => el('span', { style: { left: `${(pos * 100).toFixed(2)}%` } }, t(k)))),
      ticks,
    ];
    if (L.unknown) parts.push(el('div.pl-legend__extra', el('i.pl-sw.pl-sw--unknown'), t('planner.legend.unknown')));
    if (L.cap) parts.push(el('div.pl-legend__extra.pl-legend__cap', el('i.pl-sw.pl-sw--cap'), el('span', L.cap)));
    // Auto (SPEC 13): where a steering device would be on which band ("Kde budeš na 6 / 5 / 2,4 GHz")
    const zs = zoneShare();
    if (zs) {
      const list = rb.slice().reverse().map((b) => PL.band(b)).join(' / ');
      parts.push(el('div.pl-legend__extra.pl-legend__zones', el('span.text-muted', t('planner.legend.zones', { list })),
        zs.map(([b, v]) => el('span.pl-zone', el('i.pl-zone__sw', { style: { background: `var(${PL.BAND_VAR[b]})` } }), `${PL.band(b)}${WH.util.NBSP}${t('planner.ghz')} ${WH.util.fmtPct(v)}`)), ui().hint('steer')));
    }
    if (p.view.ranges && S.mode !== 'speed') {
      parts.push(el('div.pl-legend__extra.pl-legend__ranges', rb.map((b) => el('span', el(`i.pl-dash.pl-dash--b${String(b).replace('.', '')}`, { style: { borderColor: `var(${PL.BAND_VAR[b]})` } }), PL.band(b))), el('span.text-muted', t('planner.legend.rangeAt', { v: WH.util.dbm(p.model.rangeThreshold) })), ui().hint('rangeThreshold')));
    }
    box.replaceChildren(...parts);
  }
  PL.renderLegend = renderLegend;

  function paintToolbars() {
    if (!st) return;
    const v = PL.P().view;
    st.views.setValue(v.layer, true);
    // SPEC 13: Auto only while the router sends ≥ 2 bands; how many measurements each band has (a count on its button)
    const autoOk = PL.bands.autoOk(PL.P());
    const ab = st.bands.button('auto');
    ab.hidden = !autoOk;
    st.bands.setDisabled('auto', !autoOk);
    st.bands.setValue(v.band, true);
    PL.bands.paintCounts(st.bands);
    // a dot on Vrstvy while the map hides a layer it shows by default (SPEC 10.2) - e.g. the measurement dots stay hidden
    // after a reload; layers switched ON (range lines, dBm numbers) are visible on the map anyway
    st.layersBtn.classList.toggle('is-on', !v.walls || !v.furniture || !v.labels || v.points === false || v.whatif === false);
    if (layersPop) layersPop.sync();
    const p = PL.P();
    st.noplan.hidden = p.plan.rooms.length > 0;
    paintBanner(p, v);
  }
  PL.paintChrome = paintToolbars;

  /**
   * Speed view without a usable speed curve (SPEC 7.3): a slim banner under the top toolbars - progress "1 / 2",
   * why two places are needed, "Add measurement", "Back to Signal" and x.  It never blocks the map; x hides it until
   * the count changes or the view is entered again; a measurement popover / sheet covers it (space kept, no re-fit).
   */
  function paintBanner(p, v) {
    const sp = S.sp;
    const show = v.layer === 'speed' && !!sp && !sp.ratio && p.plan.rooms.length > 0;
    let key = '';
    if (show) {
      // (a second node no longer makes the speed unknown - SPEC 10 - so the banner is only about the speed tests)
      const d = sp.diag || { count: 0, needs: 'tests' };
      key = [d.needs, d.count, v.band, p.goal.device].join('|');
      st.sb._dkey = key;
      const ck = [key, WH.i18n.lang, S.tool, S.measVer].join('|');
      if (st.sb._key !== ck) {
        st.sb._key = ck;
        const n = Math.min(2, d.count || 0);
        st.sbSteps.replaceChildren(...[0, 1].map((i) => el('i' + (i < n ? '.is-on' : ''))));
        st.sbCount.textContent = `${n} / 2`;
        st.sbTitle.textContent = t('planner.sb.title');
        // the sentence in two lengths: phones show the short one (container query), the "?" explains the rest
        let k = 'planner.sb.why';
        if (S.tool === 'measure' && !PL.isPhone()) k = 'planner.sb.clickMap';
        else if (d.needs === 'spread') k = 'planner.sb.spread';
        else {
          const dev = String(p.goal.device || '').toLowerCase();
          const other = p.measurements.some((m) => (v.band === 'auto' || PL.bands.info(m).band === v.band) && m.download !== null && m.upload !== null && String(m.device || '').toLowerCase() !== dev);
          if (other && n < 2) k = 'planner.sb.otherDev';
        }
        const prm = { device: PL.dev.label(p.goal.device), band: PL.bandText(v.band) };
        st.sbSub.replaceChildren(el('span.pl-sb__long', t(k, prm)), el('span.pl-sb__short', t(WH.i18n.has(k + 'Short') ? k + 'Short' : k, prm)));
      }
    }
    if (show && S.sbHidden !== undefined && S.sbHidden !== key) S.sbHidden = undefined;
    const vis = show && S.sbHidden !== key && !(PL.mm && PL.mm.active);
    if (st.sbSlot.hidden !== !vis) st.sbSlot.hidden = !vis;
    st.sbSlot.classList.toggle('is-covered', vis && !!S.pending);
    if (vis) {
      const top = Math.max(st.tl.offsetTop + st.tl.offsetHeight, st.tr.offsetTop + st.tr.offsetHeight) + 8;
      if (st.sbSlot._top !== top) { st.sbSlot._top = top; st.sbSlot.style.top = `${top}px`; }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------------------------------------------------
  async function exportPng() {
    const p = PL.P();
    if (!p.plan.rooms.length) { ui().toast({ i18n: 'planner.noplan.t' }, { kind: 'warn' }); return undefined; }
    const wasVisible = S.visible;
    S.visible = true;
    if (S.q !== 'full' || !S.a) PL.computeNow();
    S.visible = wasVisible;
    const a = S.a;
    const b = WH.engine.project.planBounds(p.plan);
    const m = 0.03;
    const x0 = (b.minX - m) * W;
    const y0 = (b.minY - m) * H;
    const bw = (b.maxX - b.minX + 2 * m) * W;
    const bh = (b.maxY - b.minY + 2 * m) * H;
    const scale = Math.max(0.6, Math.min(1.4, 900 / bw));
    const head = 64;
    const foot = 92;
    const w = Math.round(Math.max(560, bw * scale));
    const h = Math.round(head + bh * scale + foot);
    const dpr = 2;
    const cv = document.createElement('canvas');
    cv.width = w * dpr;
    cv.height = h * dpr;
    const c = cv.getContext('2d');
    const tx = (w - bw * scale) / 2 - x0 * scale;
    const ty = head - y0 * scale;
    const col = PL.col;
    const roomLabs = [];
    PL.drawScene(c, { s: scale, tx, ty, dpr, w, h, z: 1.25, bg: col('--stage-bg'), roomLabs });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fam = PL.font();
    const sc = (q) => [q.x * W * scale + tx, q.y * H * scale + ty];
    // value labels like on screen: right / left / above / below of the dot, clear of the other labels, dots, markers
    // and room names - the full text first, then the short one ("+14", "↓245"), else the full text to the right
    const taken = [...roomLabs];
    const box = (q, r) => { const [x, y] = sc(q); return { l: x - r, t: y - r, r: x + r, b: y + r }; };
    // the layers as on screen: "Body měření" off = no dots, "Předpověď u bodů" off = the measured values only (wi.label)
    const pts = p.view.points !== false ? p.measurements : [];
    for (const ms of pts) taken.push(box(ms, 8));
    taken.push(box(p.net.router, 16), box(p.net.optic, 10));
    if (p.node.mode !== 'none') taken.push(box(p.node.pos, 15));
    if (PL.moved()) taken.push(box(p.net.baseline, 13));
    const hits = (a) => a.l < 2 || a.t < head || a.r > w - 2 || a.b > h - foot || taken.some((b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t);
    const spot = (txt, x, y) => {
      const tw = c.measureText(txt).width;
      const hh = 8;
      for (const [lx, cy] of [[x + 9, y], [x - 9 - tw, y], [x - tw / 2, y - 10 - hh], [x - tw / 2, y + 10 + hh]]) {
        const r = { l: lx - 2, t: cy - hh, r: lx + tw + 2, b: cy + hh };
        if (!hits(r)) return { x: lx, y: cy, r };
      }
      return null;
    };
    const disc = (q, r, fill, txt, dashed, ink) => {
      const [x, y] = sc(q);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.setLineDash(dashed ? [3, 3] : []);
      if (fill) { c.fillStyle = fill; c.fill(); }
      c.lineWidth = dashed ? 2 : 3;
      c.strokeStyle = dashed ? col('--ink-2') : col('--map-marker-ring');
      c.stroke();
      c.setLineDash([]);
      if (txt) { c.fillStyle = ink; c.font = `800 ${Math.round(r * 0.95)}px ${fam}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, x, y + 0.5); }
    };
    for (const ms of pts) {
      const i = p.measurements.indexOf(ms);
      const sig = Number.isFinite(ms.value);
      disc(ms, 6, sig ? `rgb(${WH.engine.raster.signalColor(ms.value, p.view.palette)})` : col('--pl-unknown'), '');
      const [x, y] = sc(ms);
      // the same words as on screen ("−72 → −58 (+14)" while the scenario differs from today)
      const lab = PL.wi.label(ms, i, S.mode === 'speed' ? 'speed' : p.view.layer);
      const label = lab.text.replace(/^—$/, '');
      if (!label) continue;
      c.font = `700 11px ${fam}`;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      const short = lab.shortText && lab.shortText !== label ? lab.shortText : '';
      let at = spot(label, x, y);
      let txt = label;
      if (!at && short) { at = spot(short, x, y); txt = short; }
      if (!at) at = { x: x + 9, y, r: null };
      if (at.r) taken.push(at.r);
      c.lineWidth = 3;
      c.strokeStyle = col('--map-halo');
      c.strokeText(txt, at.x, at.y);
      c.fillStyle = col('--map-label');
      c.fillText(txt, at.x, at.y);
    }
    disc(p.net.optic, 9, col('--pl-inlet'), '');
    if (PL.moved()) {
      disc(p.net.baseline, 12, '', '', true);
      const [x, y] = sc(p.net.baseline);
      c.font = `700 11px ${fam}`;
      c.textAlign = 'center';
      c.lineWidth = 3;
      c.strokeStyle = col('--map-halo');
      c.strokeText(t('planner.mk.todayShort'), x, y + 24);
      c.fillStyle = col('--ink-2');
      c.fillText(t('planner.mk.todayShort'), x, y + 24);
    }
    if (p.node.mode !== 'none') disc(p.node.pos, 14, col('--pl-node'), '2', false, col('--pl-node-ink'));
    disc(p.net.router, 15, col('--danger'), t('planner.mk.routerLetter'), false, col('--on-danger'));
    // title + date
    const target = p.goal.room === 'all' ? t('planner.res.all') : PL.roomName(p.goal.room);
    const st2 = a ? a.stats : null;
    let title = '';
    if (S.mode === 'speed' && S.sp && S.sp.stats) title = t('planner.export.speed', { b: PL.bandText(p.view.band), target, v: WH.util.fmtPct(S.sp.stats.coverage) });
    else if (st2) title = t(S.mode === 'diff' ? 'planner.export.diff' : 'planner.export.title', { b: PL.bandText(p.view.band), target, v: WH.util.fmtPct(st2.trial.coverage), a: WH.util.fmtPct(st2.today.coverage) });
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = col('--ink');
    c.font = `700 20px ${fam}`;
    c.fillText(title, 20, 34);
    c.font = `500 13px ${fam}`;
    c.fillStyle = col('--muted');
    c.fillText(`${p.name} · ${new Date().toLocaleDateString(WH.i18n.locale)} · ${t('shell.estimate')}`, 20, 54);
    // legend
    const L = legendSpec();
    const lx = 20;
    const lw = Math.min(420, w - 40);
    const ly = h - foot + 30;
    c.font = `700 12px ${fam}`;
    c.fillStyle = col('--ink');
    c.fillText(L.title, lx, ly - 10);
    const grad = c.createLinearGradient(lx, 0, lx + lw, 0);
    L.stops.forEach((v, i) => grad.addColorStop(i / (L.stops.length - 1), col(v)));
    c.fillStyle = grad;
    c.beginPath();
    if (c.roundRect) c.roundRect(lx, ly, lw, 10, 5); else c.rect(lx, ly, lw, 10);
    c.fill();
    if (L.marker !== undefined) { c.fillStyle = col('--ink'); c.fillRect(lx + L.marker * lw - 1, ly - 4, 2, 18); }
    c.font = `600 11px ${fam}`;
    c.fillStyle = col('--ink-2');
    L.words.forEach(([k, pos]) => { c.textAlign = pos <= 0 ? 'left' : pos >= 1 ? 'right' : 'center'; c.fillText(t(k), lx + lw * pos, ly + 26); });
    c.fillStyle = col('--muted');
    L.ticks.forEach(([pos, txt]) => { c.textAlign = pos <= 0 ? 'left' : pos >= 1 ? 'right' : 'center'; c.fillText(txt, lx + pos * lw, ly + 41); });
    return new Promise((res, rej) => cv.toBlob((blob) => (blob ? res(blob) : rej(new Error('toBlob'))), 'image/png'));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // mount
  // ---------------------------------------------------------------------------------------------------------------
  function toolButton(tool, icon, key, kbdKey) {
    const b = ui().button({ icon, i18n: key, kbd: kbdKey, variant: 'ghost', tip: key + '.tip', pressed: S.tool === tool, onClick: () => setTool(tool) });
    b.classList.add('pl-tool');
    b.setAttribute('data-i18n-aria', key);
    b.setAttribute('aria-label', t(key));
    return b;
  }

  let layersPop = null;   // the open "Vrstvy" popover {h, sync}: follows L / P and every change while it is open
  function openLayers(btn) {
    const v = PL.P().view;
    const sws = {};
    const sw = (key, prop, hint, k) => {
      const s = ui().switch({ checked: !!v[prop], i18n: key, hint, onChange: (on) => setView({ [prop]: on }) });
      s.dataset.layer = prop;
      if (k) s.append(el('span.pl-kbdchip', ui().kbd(k)));   // the "?" stays next to the words, the key goes to the right edge
      sws[prop] = s;
      return s;
    };
    // why "Předpověď u bodů" is greyed: in its "?" (data-hint-note) and, for screen readers, on the switch itself
    const why = el('span.sr-only', { id: WH.util.uid('pl-why') });
    const content = el('div.stack.gap-3.pl-layers',
      el('div.row.fw-700', el('span', t('planner.layers.title')), ui().hint('layers')),
      sw('planner.layers.ranges', 'ranges', 'ranges', 'L'),
      sw('planner.layers.walls', 'walls'),
      sw('planner.layers.furniture', 'furniture'),
      sw('planner.layers.labels', 'labels'),
      sw('planner.layers.values', 'values'),
      sw('planner.layers.points', 'points', 'layerPoints'),
      sw('planner.layers.whatif', 'whatif', 'layerWhatIf', 'P'),
      why);
    const sync = () => {
      const q = PL.P().view;
      for (const [prop, s] of Object.entries(sws)) s.setChecked(!!q[prop]);
      const r = PL.wi.layerWhy();
      const w = sws.whatif;
      w.input.disabled = !!r;
      w.classList.toggle('is-disabled', !!r);
      const hb = w.querySelector('.hint');
      if (hb) { if (r) hb.dataset.hintNote = `planner.layers.why.${r}`; else delete hb.dataset.hintNote; }
      why.textContent = r ? t(`planner.layers.why.${r}`) : '';
      if (r) w.input.setAttribute('aria-describedby', why.id); else w.input.removeAttribute('aria-describedby');
    };
    sync();
    const h = ui().popover(btn, content, { placement: 'top', align: 'start', width: 312, onClose: () => { if (layersPop && layersPop.h === h) layersPop = null; } });
    layersPop = { h, sync };
  }

  let wiToast = null;
  /** P: the layer "Předpověď u bodů" on / off with a short toast (+ why it has nothing to show right now). */
  function toggleWhatIf() {
    const on = PL.P().view.whatif === false;
    setView({ whatif: on });
    const r = on ? PL.wi.layerWhy() : null;
    if (wiToast) wiToast.close();
    wiToast = ui().toast({ text: t(on ? 'planner.layers.whatifOn' : 'planner.layers.whatifOff') + (r ? `. ${t(`planner.layers.why.${r}`)}` : '') }, { kind: 'info', ms: r ? 5000 : 2200 });
  }
  PL.toggleWhatIf = toggleWhatIf;
  /** Measuring with the dots hidden would put every new point out of sight: the layer "Body měření" comes back on. */
  PL.ensurePoints = () => {
    if (!st || PL.P().view.points !== false) return;
    setView({ points: true });
    ui().toast({ i18n: 'planner.layers.pointsBack' }, { kind: 'info', ms: 4000 });
  };

  function mount(root) {
    const U = WH.util;
    const vstage = el('div.stage.pl-stage#pl-stage');
    const canvas = el('canvas.stage__canvas', { tabindex: '0', role: 'application', 'data-i18n-aria': 'planner.map.aria', 'aria-label': t('planner.map.aria') });
    const layer = el('div.stage__layer.pl-layer');
    // top-left: view switch
    const views = ui().segmented(VIEWS.map((v) => ({ value: v, icon: { signal: 'signal', speed: 'speed', diff: 'contrast' }[v], i18n: `planner.view.${v}`, tip: `planner.view.${v}.tip`, kbd: 'V' })), {
      value: PL.P().view.layer, aria: 'planner.view.aria', onChange: (v) => setView({ layer: v }),
    });
    views.classList.add('pl-views');
    VIEWS.forEach((v) => { const b = views.button(v); b.setAttribute('data-i18n-aria', `planner.view.${v}.tip`); b.setAttribute('aria-label', t(`planner.view.${v}.tip`)); });
    const diffLabel = views.button('diff').querySelector('span');
    diffLabel.classList.add('pl-long');
    diffLabel.after(el('span.pl-short', { 'data-i18n': 'planner.view.diffShort' }, t('planner.view.diffShort')));
    const tl = el('div.stage__slot.stage__tl', el('div.toolbar', views, ui().hint('viewSwitch')));
    // top-right: band switch
    // SPEC 13: 2,4 · 5 · 6 · Auto (Auto while the router sends ≥ 2 bands; each band shows its measurement count)
    const bands = ui().segmented([...BANDS.map((b) => ({ value: b, label: PL.band(b), tip: `planner.band.tip${String(b).replace('.', '')}`, kbd: 'B' })), { value: 'auto', i18n: 'planner.bd.auto', tip: 'planner.bd.autoTip', kbd: 'B' }], {
      value: PL.P().view.band, aria: 'planner.band.aria', onChange: (b) => setView({ band: b }),
    });
    bands.classList.add('pl-bands');
    BANDS.forEach((b) => { const k = `planner.band.tip${String(b).replace('.', '')}`; const btn = bands.button(b); btn.setAttribute('aria-label', t(k)); });
    bands.button('auto').classList.add('pl-bands__auto');
    // the unit belongs to the numbers: "2,4 · 5 · 6 GHz · Auto" (not "Auto GHz"); decorative - every button's label says GHz
    bands.button('auto').before(el('span.toolbar__label.pl-bands__unit', { 'data-i18n': 'planner.ghz', 'aria-hidden': 'true' }, t('planner.ghz')));
    const tr = el('div.stage__slot.stage__tr', el('div.toolbar', bands, ui().hint('band')));
    // bottom: tools | legend | zoom
    const toolBtns = { router: toolButton('router', 'router', 'planner.tool.router', 'R'), measure: toolButton('measure', 'measure', 'planner.tool.measure', 'M') };
    const layersBtn = ui().button({ icon: 'layers', i18n: 'planner.tool.layers', variant: 'ghost', tip: 'planner.tool.layers.tip', onClick: () => openLayers(layersBtn) });
    layersBtn.classList.add('pl-tool');
    layersBtn.setAttribute('aria-haspopup', 'dialog');
    layersBtn.setAttribute('data-i18n-aria', 'planner.tool.layers');
    layersBtn.setAttribute('aria-label', t('planner.tool.layers'));
    const legend = el('div.legend.pl-legend');
    const zoom = el('div.toolbar.toolbar--vertical.pl-zoom',
      ui().iconButton({ icon: 'zoom-in', tip: 'keys.zoomIn', kbd: '+', onClick: () => { userNav = true; st.vp.zoomBy(1.25, undefined, undefined, { animate: true }); } }),
      ui().iconButton({ icon: 'zoom-out', tip: 'keys.zoomOut', kbd: '-', onClick: () => { userNav = true; st.vp.zoomBy(0.8, undefined, undefined, { animate: true }); } }),
      ui().iconButton({ icon: 'fit', tip: 'keys.zoomFit', kbd: '0', onClick: () => PL.fit(true) }));
    // phones: one tap into the measuring mode (25-measure.js)
    const mmBtn = PL.mm && PL.mm.button ? PL.mm.button() : null;
    const tools = el('div.toolbar.pl-tools', { role: 'toolbar', 'data-i18n-aria': 'planner.tools.aria', 'aria-label': t('planner.tools.aria') }, toolBtns.router, toolBtns.measure, mmBtn, el('span.toolbar__sep'), layersBtn);
    const bottom = el('div.pl-bottom', tools, legend, zoom);
    const tip = el('div.pl-tip', { hidden: true, 'aria-hidden': 'true' });
    // empty plan
    const noplan = el('div.stage__state.pl-noplan', { hidden: true },
      el('span.icon-badge', ui().icon('plan', 24)),
      el('div.empty-state__title', { 'data-i18n': 'planner.noplan.t' }, t('planner.noplan.t')),
      el('p.text-sm', { 'data-i18n': 'planner.noplan.b' }, t('planner.noplan.b')),
      ui().button({ i18n: 'planner.noplan.go', icon: 'plan', kbd: '1', variant: 'primary', onClick: () => WH.views.go('editor') }));
    // speed view without a speed curve: slim, dismissible banner under the top toolbars (SPEC 7.3)
    const sbTitle = el('span.pl-sb__t');
    const sbSteps = el('span.pl-sb__steps', { 'aria-hidden': 'true' });
    const sbCount = el('b.pl-sb__n.num');
    const sbSub = el('div.pl-sb__b');
    const sbAdd = ui().button({ i18n: 'planner.m.add', icon: 'plus', kbd: 'M', variant: 'primary', size: 'sm', onClick: () => { if (PL.isPhone()) PL.mm.enter(); else setTool('measure'); } });
    const sbBack = ui().button({ i18n: 'planner.sb.back', icon: 'signal', size: 'sm', onClick: () => { setView({ layer: 'signal' }); ui().announce(t('planner.view.signal.tip')); } });
    const sbClose = ui().iconButton({ icon: 'x', tip: 'planner.sb.hide', size: 'sm', onClick: () => { S.sbHidden = st.sb._dkey; paintToolbars(); try { st.canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } });
    sbClose.classList.add('pl-sb__x');
    const sb = el('div.pl-sb',
      el('span.pl-sb__ico', ui().icon('speed', 20)),
      el('div.pl-sb__text', { role: 'status' }, el('div.pl-sb__head', sbTitle, sbSteps, sbCount), sbSub),
      el('div.pl-sb__acts', sbAdd, sbBack, ui().hint('speedView')), sbClose);
    const sbSlot = el('div.stage__slot.pl-sbslot', { hidden: true }, sb);
    // optimizer progress
    const progBar = ui().progress({ value: 0 });
    const prog = el('div.pl-progress', { hidden: true, role: 'status' },
      el('div.row', ui().icon('sparkles', 18), el('span.grow.fw-600', { 'data-i18n': 'planner.opt.running' }, t('planner.opt.running')),
        ui().button({ i18n: 'ui.cancel', size: 'sm', variant: 'ghost', onClick: () => { if (S.opt) S.opt.abort(); } })), progBar);
    vstage.append(canvas, layer, tl, tr, sbSlot, bottom, noplan, prog, tip);
    const side = el('aside.sidebar.pl-side', { 'data-i18n-aria': 'planner.side.aria', 'aria-label': t('planner.side.aria') });
    root.append(el('div.layout.pl-layout', vstage, side));

    const mk = { router: markerEl('router'), today: markerEl('today'), node: markerEl('node'), inlet: markerEl('inlet') };
    layer.append(mk.inlet, mk.today, mk.node, mk.router);
    st = { el: vstage, canvas, layer, tl, tr, bottom, tools, legend, tip, views, bands, toolBtns, layersBtn, noplan, sbSlot, sb, sbTitle, sbSteps, sbCount, sbSub, sbAdd, sbBack, prog, progBar, mk, meas: new Map(), place };
    st.vp = WH.viewport(vstage, { onChange: () => { if (st.vp.panning) userNav = true; hideTip(); PL.requestDraw(); }, fitBox, dblClickFit: false });
    const touches = new Set();
    vstage.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { touches.add(e.pointerId); if (touches.size > 1) userNav = true; } });
    for (const ev of ['pointerup', 'pointercancel']) vstage.addEventListener(ev, (e) => touches.delete(e.pointerId));
    vstage.addEventListener('wheel', (e) => { if (!e.target.closest('.toolbar, .legend, .pop-panel, .menu, .popover, [data-no-wheel]')) userNav = true; }, { passive: true });
    WH.bus.on('viewport:zoom', () => { if (S.visible) userNav = true; });
    WH.bus.on('viewport:fit', () => { if (S.visible) { userNav = false; fitKey = boundsKey(); } });
    if (typeof ResizeObserver === 'function') {
      let ro = 0;
      // a toolbar / the banner changed size: banner position, the plan fit and the toasts (they avoid stage controls)
      const obs = new ResizeObserver(() => { if (!ro) ro = requestAnimationFrame(() => { ro = 0; if (S.visible) { paintToolbars(); autoFit(); if (ui().placeToasts) ui().placeToasts(); } }); });
      [tl, tr, legend, tools, sbSlot].forEach((n) => obs.observe(n));
    }
    PL.stage = st;
    PL.root = root;
    if (PL.mm && PL.mm.mount) PL.mm.mount(st);
    setTool(S.tool, true);

    // canvas interaction: hover tooltip, click = tool action, double-click on empty space = fit
    // (the viewport captures the pointer on the stage, so click / dblclick arrive with the stage as target)
    let lastType = 'mouse';
    let downOnMap = false;
    let hoverRaf = 0;
    let hoverEv = null;
    const fromMap = (e) => downOnMap && (e.target === vstage || e.target === canvas);
    canvas.addEventListener('pointerdown', (e) => { lastType = e.pointerType || 'mouse'; downOnMap = true; hideTip(); });
    vstage.addEventListener('pointerdown', (e) => { if (e.target !== canvas) downOnMap = false; }, true);
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || e.buttons || drag || st.vp.panning) { if (e.buttons) hideTip(); return; }
      hoverEv = e;
      if (!hoverRaf) hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const ev = hoverEv;
        if (!ev || !S.visible) return;
        const w = toWorld(ev.clientX, ev.clientY);
        const room = PL.roomAt(w);
        canvas.style.cursor = room ? (S.tool === 'measure' ? 'crosshair' : 'pointer') : '';
        pointTip(w, ev.clientX, ev.clientY);
      });
    });
    canvas.addEventListener('pointerleave', () => { hoverEv = null; hideTip(); });
    vstage.addEventListener('click', (e) => {
      if (!fromMap(e)) return;
      let w = toWorld(e.clientX, e.clientY);
      let room = PL.roomAt(w);
      if (!room && PL.P().plan.rooms.length) {
        // a tap on the thick outer wall line / just outside the flat counts for the room behind it (SPEC 10: a point
        // never stays on the wall line - measPoint steps it inside)
        const f = WH.engine.project.nearestFloor(PL.P().plan, w);
        if (f && Math.hypot((f.x - w.x) * W, (f.y - w.y) * H) * st.vp.view.scale <= 12) { w = PL.measPoint(f); room = PL.roomAt(w); }
      }
      if (!room) return;
      // "Prvotní měření" guide (28-calib-wizard.js): a tap near a suggested-spot pin selects it / places "my own spot"
      if (PL.calib && PL.calib.mapClick && PL.calib.mapClick(w)) return;
      if (S.tool === 'measure') {
        // the phone sheet stays open: a tap elsewhere moves a new point (a mistap), or switches to a new one
        const pend = S.pending;
        if (pend && pend.kind === 'sheet' && pend.isNew) { pend.moveTo(w); return; }
        if (pend && pend.kind === 'sheet' && pend.busy()) return;
        PL.openMeasure(w);
        return;
      }
      moveRouterTo(w);
      if (lastType === 'touch') {
        requestAnimationFrame(() => { pointTip(w, e.clientX, e.clientY); clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 2600); });
      }
    });
    vstage.addEventListener('dblclick', (e) => { if (fromMap(e) && !PL.roomAt(toWorld(e.clientX, e.clientY))) PL.fit(true); });

    // store, language, theme
    let lastView = JSON.stringify(PL.P().view);
    store().on('*', (e) => {
      const tp = new Set(e.topics);
      if (tp.size === 1 && (tp.has('prefs') || tp.has('history'))) { PL.notifySide(); return; }
      const replaced = tp.has('project:replaced');
      if (replaced || tp.has('plan')) S.planVer += 1;
      if (replaced || tp.has('plan') || tp.has('scale') || tp.has('model')) S.geomDirty = true;
      if (replaced || tp.has('measurements')) S.measVer += 1;
      if (replaced) {
        if (PL.mm && PL.mm.active) PL.mm.exit();
        S.cacheF = {};
        S.cacheC = {};
        if (S.opt) S.opt.abort();
        closePending();
        if (drag) drag.cancelled = true;
        setTool('router', true);
        userNav = false;
        requestAnimationFrame(() => PL.fit(false));
      }
      const view = JSON.stringify(PL.P().view);
      const onlyView = e.topics.every((x) => x === 'view' || x === 'history' || x === 'meta' || x === 'prefs');
      const a = JSON.parse(lastView);
      lastView = view;
      // the engine context carries the measured model fit (model.fit) only while calibration is on: undo, the agent tools
      // or any other path that flips view.calibrate needs a fresh context
      if (a.calibrate !== PL.P().view.calibrate) S.geomDirty = true;
      if (a.layer !== 'speed' && PL.P().view.layer === 'speed') S.sbHidden = undefined;   // banner x lasts until the view is entered again
      if (!S.visible) { S.stale = true; return; }
      if (tipOwner === 'map') hideTip();
      if (!onlyView || replaced) PL.invalidate(e.source !== 'live');
      else {
        const b = PL.P().view;
        if (a.band !== b.band || a.calibrate !== b.calibrate) PL.invalidate(true);
        else if (a.layer !== b.layer || a.palette !== b.palette || a.ranges !== b.ranges) PL.derive();
        else PL.requestDraw();
      }
      paintToolbars();
      renderLegend();
      if (e.source !== 'live') PL.notifySide();
    });
    PL.on((q) => {
      paintToolbars();
      if (q !== 'coarse') { renderLegend(); markerLabels(); }
    });
    WH.bus.on('lang:changed', () => {
      if (!st) return;
      BANDS.forEach((b) => { const btn = st.bands.button(b); const s = btn && btn.querySelector('span'); if (s) s.textContent = PL.band(b); });
      for (const b of st.meas.values()) b._key = '';
      renderLegend();
      paintToolbars();
      markerLabels();
      PL.requestDraw();
      if (PL.side) PL.side.render();
    });
    WH.bus.on('theme:changed', () => { PL.resetPatterns(); PL.requestDraw(); });

    registerKeys();
    if (PL.side) PL.side.mount(side);
    renderLegend();
    paintToolbars();
  }

  let keysDone = false;
  function registerKeys() {
    if (keysDone || !(WH.ui && WH.ui.keys)) return;
    keysDone = true;
    const K = (key, i18n, run, extra) => ui().keys.register(Object.assign({ mode: 'planner', key, i18n, run }, extra || {}));
    const busy = () => !!drag;
    K('r', 'planner.keys.router', () => setTool('router'), { order: 1 });
    K('m', 'planner.keys.measure', () => setTool(S.tool === 'measure' ? 'router' : 'measure'), { order: 2 });
    K('b', 'planner.keys.band', () => {
      if (busy()) return;
      const cyc = PL.bands.autoOk(PL.P()) ? [...BANDS, 'auto'] : BANDS;
      const v = PL.P().view.band;
      setView({ band: cyc[(cyc.indexOf(v) + 1) % cyc.length] });
      ui().announce(PL.bandText(PL.P().view.band));
    }, { order: 3 });
    K('v', 'planner.keys.view', () => { const v = PL.P().view.layer; const n = VIEWS[(VIEWS.indexOf(v) + 1) % 3]; setView({ layer: n }); ui().announce(t(`planner.view.${n}.tip`)); }, { order: 4 });
    K('l', 'planner.keys.ranges', () => { const on = !PL.P().view.ranges; setView({ ranges: on }); ui().announce(t(on ? 'planner.layers.rangesOn' : 'planner.layers.rangesOff')); }, { order: 5 });
    K('p', 'planner.keys.whatif', () => { if (!busy()) toggleWhatIf(); }, { order: 5.5 });
    K('f', 'planner.keys.find', () => { findBest(); }, { order: 6 });
    K('d', 'planner.keys.today', () => { if (!busy()) backToToday(); }, { order: 7 });
    K(['arrowleft', 'arrowright', 'arrowup', 'arrowdown'], 'planner.keys.arrows', (e) => {
      const d = ui().keys.arrowDelta(e, 0.25, 4);
      if (d) nudge('router', undefined, d.dx, d.dy);
    }, { repeat: true, anyShift: true, order: 8, when: () => !!st && document.activeElement === st.canvas && PL.P().plan.rooms.length > 0 });
    K('enter', 'planner.keys.enter', () => {
      if (S.pending) { S.pending.submit(); return true; }
      const r = st.el.getBoundingClientRect();
      PL.openMeasure(toWorld(r.left + r.width / 2, r.top + r.height / 2));
      return true;
    }, {
      allowTyping: true, order: 9,
      when: () => {
        const a = document.activeElement;
        if (S.pending) return !(a && (a.tagName === 'BUTTON' || a.tagName === 'SELECT'));
        return !!st && S.tool === 'measure' && a === st.canvas;
      },
    });
    K('escape', 'planner.keys.esc', () => {
      if (drag) { drag.cancelled = true; store().cancel(); st.el.classList.remove('is-dragging'); return true; }
      if (S.opt) { S.opt.abort(); return true; }
      if (S.pending && S.pending.kind === 'sheet') { if (S.pending.busy()) return true; closePending(); return true; }
      if (PL.mm && PL.mm.active) { PL.mm.exit(); return true; }
      if (S.tool === 'measure') { setTool('router'); return true; }
      return false;
    }, { order: 10, when: () => !!drag || !!S.opt || S.tool === 'measure' || !!(PL.mm && PL.mm.active) });
  }

  /** Markers or measurements that ended up off the floor after plan edits go back onto it (not undoable). */
  function snapCheck() {
    const p = PL.P();
    if (!p || !p.plan.rooms.length) return;
    const E = WH.engine.project;
    const off = (q) => q && !E.floorMaskAt(p.plan, q);
    // measurements are not moved silently: the list flags them with an undoable "Posunout dovnitř" (SPEC 10)
    const bad = off(p.net.router) || off(p.net.baseline) || off(p.node.pos);
    if (!bad) return;
    const fix = (q) => (off(q) ? PL.pt(E.nearestFloor(p.plan, q)) : q);
    store().update((pr) => {
      pr.net.router = fix(pr.net.router);
      pr.net.baseline = fix(pr.net.baseline);
      pr.node.pos = fix(pr.node.pos);
    }, ['net', 'node'], { quiet: true });
    ui().toast({ i18n: 'planner.snapped' }, { kind: 'info' });
  }

  const impl = {
    mount,
    show() {
      S.visible = true;
      S.sbHidden = undefined;
      snapCheck();
      st.vp.resize();
      if (!userNav && boundsKey() !== fitKey) PL.fit(false);
      if (S.stale || !S.a) PL.computeNow();
      else PL.requestDraw();
      paintToolbars();
      renderLegend();
      PL.notifySide();
    },
    hide() {
      if (PL.mm && PL.mm.active) PL.mm.exit();
      S.visible = false;
      if (S.opt) S.opt.abort();
      closePending();
      hideTip();
      endKbd();
      if (drag) { drag.cancelled = true; if (store().gestureOpen) store().cancel(); drag = null; st.el.classList.remove('is-dragging'); }
    },
    resize() { if (st) { st.vp.resize(); PL.requestDraw(); } },
    exportPng,
    tourSteps() {
      return [
        { target: () => (st && !st.mk.router.hidden ? st.mk.router : '#pl-stage'), title: 'planner.tour.map.t', body: 'planner.tour.map.b', placement: 'right', padding: 10 },
        { target: '[data-card="pl-result"]', title: 'planner.tour.result.t', body: 'planner.tour.result.b', placement: 'left' },
        { target: '#pl-find', title: 'planner.tour.find.t', body: 'planner.tour.find.b', placement: 'left', optional: true },
        { target: '[data-card="pl-meas"]', title: 'planner.tour.meas.t', body: 'planner.tour.meas.b', placement: 'left', optional: true },
      ];
    },
  };
  PL.impl = impl;
  if (WH.views && typeof WH.views.register === 'function') WH.views.register('planner', impl);
  // listed in the cheat sheet from the start; they only fire while the (then mounted) Wi-Fi view is shown
  registerKeys();
})();
