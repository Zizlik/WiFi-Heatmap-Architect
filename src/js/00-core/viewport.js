/* WH.viewport - pan & zoom for a map stage.
 *
 *   const vp = WH.viewport(hostEl, { onChange(view){ ... }, canPan(e){ ... }, dblClickFit: true });
 *   // WH.viewport.create(...) is an alias.
 *
 * World space = canvas pixels (0..W, 0..H, default 1080 x 942 = WH.engine.CANVAS); public points are NORMALIZED 0..1.
 * view = { scale, tx, ty }:  host-relative screen px = world px * scale + (tx, ty), measured from the host's PADDING box
 *   (inside its border) - exactly where an absolutely positioned child with inset:0 (canvas/svg/marker layer) starts, so
 *   views need no border compensation of their own.
 *   - SVG host:    <g transform="translate(tx ty) scale(s)"> -> use vp.svgTransform()
 *   - canvas host: ctx.setTransform(s*dpr, 0, 0, s*dpr, tx*dpr, ty*dpr)  -> use vp.matrix()
 *
 * Interaction: drag on EMPTY space (see canPan), middle button, Space+drag; wheel / ctrl+wheel / trackpad pinch zoom around
 * the cursor; two-finger touch pinch + pan; double-click on empty space fits (dblClickFit). Keys +, - and 0 arrive through
 * WH.bus 'viewport:zoom' {factor} / 'viewport:fit' (emitted by the global shortcuts) and are honoured only by a viewport
 * whose host is currently visible.  Animations are short and disabled for prefers-reduced-motion. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};

  const DRAG_THRESHOLD = 4; // px before a press on empty space turns into a pan (keeps plain clicks/double-clicks working)
  const DEFAULT_IGNORE = '.toolbar, .legend, .pop-panel, .menu, .popover, .stage__hint, [data-no-wheel]';
  const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="menuitem"], [contenteditable="true"], .stage__slot > *';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function createViewport(host, opts) {
    opts = opts || {};
    const canvasInfo = g.WH.engine && g.WH.engine.CANVAS;
    const world = opts.world || (canvasInfo ? { w: canvasInfo.W, h: canvasInfo.H } : { w: 1080, h: 942 });
    const view = { scale: 1, tx: 0, ty: 0 };
    const listeners = new Set();
    if (typeof opts.onChange === 'function') listeners.add(opts.onChange);

    let size = { w: 0, h: 0 };         // measured by onResize() below (the first measurement triggers the initial fit)
    let enabled = true;
    let fitted = true;                // until the user pans/zooms, a resize re-fits
    let fitBox = null;                // last box passed to fit()
    let anim = 0;
    const pointers = new Map();       // pointerId -> {x,y}
    let pan = null;                   // {id, x0, y0, tx0, ty0, moved}
    let pinch = null;                 // {d0, s0, wx, wy}
    let spaceDown = false;
    let hovering = false;
    let swallowClick = false;
    const offs = [];

    const ignoreSel = opts.ignoreSelector || DEFAULT_IGNORE;

    // -------------------------------------------------------------------------------------------------------------
    // geometry helpers
    // -------------------------------------------------------------------------------------------------------------
    const baseFit = () => (size.w > 0 && size.h > 0 ? Math.min(size.w / world.w, size.h / world.h) : 1);
    const minScale = () => (opts.minScale !== undefined ? opts.minScale : baseFit() * 0.5);
    const maxScale = () => (opts.maxScale !== undefined ? opts.maxScale : Math.max(baseFit() * 16, 4));

    function constrain(v) {
      v.scale = clamp(v.scale, minScale(), Math.max(minScale(), maxScale()));
      if (size.w > 0 && size.h > 0) {
        // keep a sizeable part of the world on screen so the user can never lose the plan
        const mw = Math.min(160, size.w * 0.35);
        const mh = Math.min(160, size.h * 0.35);
        const W = world.w * v.scale;
        const H = world.h * v.scale;
        const loX = mw - W; const hiX = size.w - mw;
        const loY = mh - H; const hiY = size.h - mh;
        v.tx = loX > hiX ? (loX + hiX) / 2 : clamp(v.tx, loX, hiX);
        v.ty = loY > hiY ? (loY + hiY) / 2 : clamp(v.ty, loY, hiY);
      }
      return v;
    }

    function notify() {
      for (const fn of Array.from(listeners)) {
        try { fn(view); } catch (e) { console.error('[WH.viewport] onChange failed:', e); }
      }
    }

    function cancelAnim() {
      if (anim) { cancelAnimationFrame(anim); anim = 0; }
    }

    function setView(next, animate, silent) {
      const target = constrain({ scale: next.scale !== undefined ? next.scale : view.scale, tx: next.tx !== undefined ? next.tx : view.tx, ty: next.ty !== undefined ? next.ty : view.ty });
      cancelAnim();
      if (!animate || reduced() || typeof requestAnimationFrame !== 'function') {
        view.scale = target.scale; view.tx = target.tx; view.ty = target.ty;
        if (!silent) notify();
        return;
      }
      const from = { scale: view.scale, tx: view.tx, ty: view.ty };
      const t0 = performance.now();
      const dur = 170;
      const frame = (now) => {
        const k = clamp((now - t0) / dur, 0, 1);
        const e = 1 - Math.pow(1 - k, 3);
        view.scale = from.scale * Math.pow(target.scale / from.scale, e); // zoom feels linear in log space
        view.tx = from.tx + (target.tx - from.tx) * e;
        view.ty = from.ty + (target.ty - from.ty) * e;
        notify();
        anim = k < 1 ? requestAnimationFrame(frame) : 0;
      };
      anim = requestAnimationFrame(frame);
    }

    /** Fit a normalized box {minX,minY,maxX,maxY} (default: the whole canvas) into the host. */
    function fit(box, o) {
      o = o || {};
      fitted = true;
      fitBox = box || null;
      if (!(size.w > 0 && size.h > 0)) return; // hidden: will fit as soon as it gets a size
      const b = box || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const bw = (b.maxX - b.minX) * world.w;
      const bh = (b.maxY - b.minY) * world.h;
      if (!(bw > 0 && bh > 0)) { fit(null, o); return; }
      const pad = o.padding !== undefined ? o.padding : Math.min(40, Math.min(size.w, size.h) * 0.05);
      const scale = clamp(Math.min((size.w - 2 * pad) / bw, (size.h - 2 * pad) / bh), minScale(), maxScale());
      const cx = ((b.minX + b.maxX) / 2) * world.w;
      const cy = ((b.minY + b.maxY) / 2) * world.h;
      setView({ scale, tx: size.w / 2 - cx * scale, ty: size.h / 2 - cy * scale }, o.animate !== false && o.animate !== 0 && !o.silent, !!o.silent);
      fitted = true;
    }

    /** Multiply the zoom by f around host-relative point (cx, cy) (default: the centre). */
    function zoomBy(f, cx, cy, o) {
      if (!(f > 0)) return;
      const px = cx !== undefined ? cx : size.w / 2;
      const py = cy !== undefined ? cy : size.h / 2;
      const s = clamp(view.scale * f, minScale(), maxScale());
      const k = s / view.scale;
      fitted = false;
      setView({ scale: s, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k }, !!(o && o.animate));
    }

    function panBy(dx, dy, o) {
      fitted = false;
      setView({ tx: view.tx + dx, ty: view.ty + dy }, !!(o && o.animate));
    }

    // coordinate conversions ------------------------------------------------------------------------------------------
    // "Host-relative px" are measured from the host's PADDING box (inside its border): that is where children with
    // position:absolute; inset:0 (the stage canvas / svg / marker layer) start, and host.clientWidth/clientHeight (the
    // size used for fitting) are padding-box sizes too.  Using the border box (getBoundingClientRect alone) would put
    // the pointer 1 px off on a stage with a 1 px border.  Every client <-> view conversion goes through rect().
    function rect() {
      const r = host.getBoundingClientRect();
      return { left: r.left + (host.clientLeft || 0), top: r.top + (host.clientTop || 0) };
    }
    /** client px -> normalized world point {x,y} (0..1). */
    function toWorld(clientX, clientY) {
      const r = rect();
      return { x: (clientX - r.left - view.tx) / (view.scale * world.w), y: (clientY - r.top - view.ty) / (view.scale * world.h) };
    }
    /** client px -> world (canvas) px. */
    function toWorldPx(clientX, clientY) {
      const r = rect();
      return { x: (clientX - r.left - view.tx) / view.scale, y: (clientY - r.top - view.ty) / view.scale };
    }
    /** normalized point -> host-relative px. */
    function toScreen(p) { return { x: view.tx + p.x * world.w * view.scale, y: view.ty + p.y * world.h * view.scale }; }
    /** normalized point -> client px. */
    function toClient(p) { const r = rect(); const s = toScreen(p); return { x: r.left + s.x, y: r.top + s.y }; }

    // -------------------------------------------------------------------------------------------------------------
    // input
    // -------------------------------------------------------------------------------------------------------------
    function isEmpty(e) {
      const t = e.target;
      // A press on a real control (a button in a stage slot, the editor's "Done" button, a card in an empty state...)
      // never starts a pan: capturing the pointer would retarget the following click to the host and the control
      // would never see it. Checked before the view's own canPan so no view can get this wrong.
      if (t && t !== host && t.closest && t.closest(INTERACTIVE)) return false;
      if (typeof opts.canPan === 'function') return !!opts.canPan(e);
      if (!t || t === host) return true;
      if (t.hasAttribute && t.hasAttribute('data-pan')) return true;
      if (t.closest && t.closest('[data-pan]')) return true;
      const tag = (t.tagName || '').toLowerCase();
      return tag === 'canvas' || (tag === 'svg' && t.parentNode === host);
    }

    function setCursor() {
      host.classList.toggle('is-pan-ready', enabled && spaceDown);
      host.classList.toggle('is-panning', !!(pan && pan.moved));
    }

    function onPointerDown(e) {
      if (!enabled) return;
      if (e.target && e.target.closest && e.target.closest(ignoreSel)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        const r = rect();
        const mx = (a.x + b.x) / 2 - r.left;
        const my = (a.y + b.y) / 2 - r.top;
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: view.scale, wx: (mx - view.tx) / view.scale, wy: (my - view.ty) / view.scale };
        pan = null;
        cancelAnim();
        try { host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }
      if (pointers.size > 2) return;
      const wantsPan = e.button === 1 || (e.button === 0 && spaceDown) || (e.button === 0 && !e.defaultPrevented && isEmpty(e));
      if (!wantsPan) return;
      if (e.button === 1 || spaceDown) e.preventDefault();
      cancelAnim();
      pan = { id: e.pointerId, x0: e.clientX, y0: e.clientY, tx0: view.tx, ty0: view.ty, moved: false, forced: e.button === 1 || spaceDown };
      try { host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    function onPointerMove(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = Array.from(pointers.values());
        const r = rect();
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2 - r.left;
        const my = (a.y + b.y) / 2 - r.top;
        const s = clamp(pinch.s0 * (d / pinch.d0), minScale(), maxScale());
        fitted = false;
        setView({ scale: s, tx: mx - pinch.wx * s, ty: my - pinch.wy * s }, false);
        return;
      }
      if (!pan || e.pointerId !== pan.id) return;
      const dx = e.clientX - pan.x0;
      const dy = e.clientY - pan.y0;
      if (!pan.moved) {
        if (Math.hypot(dx, dy) < (pan.forced ? 1 : DRAG_THRESHOLD)) return;
        pan.moved = true;
        setCursor();
      }
      fitted = false;
      setView({ tx: pan.tx0 + dx, ty: pan.ty0 + dy }, false);
    }

    function endPointer(e) {
      pointers.delete(e.pointerId);
      try { host.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (pan && pan.id === e.pointerId) {
        if (pan.moved) {
          swallowClick = true; // the click that follows the button release must not select/deselect things
          setTimeout(() => { swallowClick = false; }, 0);
        }
        pan = null;
        setCursor();
      }
      if (pointers.size < 2) pinch = null;
    }

    function onWheel(e) {
      if (!enabled) return;
      if (e.target && e.target.closest && e.target.closest(ignoreSel)) return;
      e.preventDefault();
      cancelAnim();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
      const k = e.ctrlKey ? 0.012 : 0.0016;
      const f = clamp(Math.exp(-dy * k), 0.6, 1.7);
      const r = rect();
      zoomBy(f, e.clientX - r.left, e.clientY - r.top);
    }

    function onClickCapture(e) {
      if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
    }

    function onDblClick(e) {
      if (!enabled || !opts.dblClickFit) return;
      if (e.target && e.target.closest && e.target.closest(ignoreSel)) return;
      if (isEmpty(e)) fit(typeof opts.fitBox === 'function' ? opts.fitBox() : (opts.fitBox || fitBox));
    }

    function visible() { return host.isConnected && host.offsetWidth > 0 && host.offsetHeight > 0; }

    function onKeyDown(e) {
      if (e.code !== 'Space' || !enabled || !hovering) return;
      if (g.WH.util && g.WH.util.isTyping(e)) return;
      if (e.target && e.target.tagName === 'BUTTON') return;
      spaceDown = true;
      e.preventDefault();
      setCursor();
    }
    function onKeyUp(e) {
      if (e.code === 'Space' && spaceDown) { spaceDown = false; setCursor(); }
    }

    host.classList.add('vp-host');
    host.style.touchAction = 'none';
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', endPointer);
    host.addEventListener('pointercancel', endPointer);
    host.addEventListener('lostpointercapture', endPointer);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('click', onClickCapture, true);
    host.addEventListener('dblclick', onDblClick);
    host.addEventListener('pointerenter', () => { hovering = true; });
    host.addEventListener('pointerleave', () => { hovering = false; if (spaceDown && !pan) { spaceDown = false; setCursor(); } });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onKeyUp.bind(null, { code: 'Space' }));

    // global shortcuts (+ - 0) -> whichever viewport is visible
    if (g.WH.bus && opts.keyboard !== false) {
      offs.push(g.WH.bus.on('viewport:zoom', (p) => { if (enabled && visible()) zoomBy((p && p.factor) || 1.25, undefined, undefined, { animate: true }); }));
      offs.push(g.WH.bus.on('viewport:fit', () => { if (enabled && visible()) fit(typeof opts.fitBox === 'function' ? opts.fitBox() : (opts.fitBox || null)); }));
    }

    // keep the view sane when the host is resized (including becoming visible for the first time)
    function onResize() {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === size.w && h === size.h) return;
      const first = !(size.w > 0 && size.h > 0);
      const prev = size;
      size = { w, h };
      if (!(w > 0 && h > 0)) return;
      if (fitted || first) {
        fit(typeof opts.fitBox === 'function' ? opts.fitBox() : (opts.fitBox || fitBox), { animate: false });
      } else {
        // keep the centre of the view stable
        const k = prev.w > 0 ? 1 : 0;
        setView({ tx: view.tx + (w - prev.w) / 2 * k, ty: view.ty + (h - prev.h) / 2 * k }, false);
      }
    }
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(onResize);
      ro.observe(host);
    } else {
      window.addEventListener('resize', onResize);
    }
    // First measurement happens synchronously but silently (a creator still sitting in its own constructor must not get
    // an onChange call before it owns the viewport object); later size changes notify normally.
    if (host.clientWidth > 0 && host.clientHeight > 0) {
      size = { w: host.clientWidth, h: host.clientHeight };
      fit(null, { animate: false, silent: true });
    }

    function destroy() {
      cancelAnim();
      if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', endPointer);
      host.removeEventListener('pointercancel', endPointer);
      host.removeEventListener('lostpointercapture', endPointer);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('click', onClickCapture, true);
      host.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      offs.forEach((off) => off());
      listeners.clear();
      host.classList.remove('vp-host', 'is-pan-ready', 'is-panning');
    }

    return {
      view, world, host,
      fit, zoomBy, panBy, setView: (v, animate) => { fitted = false; setView(v, animate); },
      toWorld, toWorldPx, toScreen, toClient,
      /** `<g transform>` value for SVG hosts. */
      svgTransform: () => `translate(${view.tx} ${view.ty}) scale(${view.scale})`,
      /** [a,b,c,d,e,f] for ctx.setTransform (multiply by devicePixelRatio yourself). */
      matrix: () => [view.scale, 0, 0, view.scale, view.tx, view.ty],
      setEnabled(b) {
        enabled = !!b;
        if (!enabled) { pan = null; pinch = null; pointers.clear(); spaceDown = false; setCursor(); }
      },
      get enabled() { return enabled; },
      get panning() { return !!(pan && pan.moved); },
      get fitScale() { return baseFit(); },
      get size() { return { w: size.w, h: size.h }; },
      /** Re-measure the host (call after layout changes ResizeObserver cannot see). */
      resize: onResize,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      destroy,
    };
  }

  createViewport.create = createViewport;
  g.WH.viewport = createViewport;
})();
