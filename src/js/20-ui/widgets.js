/* WH.ui widgets: toast, confirm, dialog, popover, menu, segmented, switch, field helpers, card, buttons.
 * All label-like options accept either {i18n:'key'} or a string; a string that is a known i18n key is translated, so
 * language switches update already-built widgets (they carry data-i18n). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const ui = (g.WH.ui = g.WH.ui || {});

  const t = (k, p) => g.WH.i18n.t(k, p);
  const KEY_RE = /^[a-z][\w-]*(\.[\w-]+)+$/;
  const el = (...a) => g.WH.util.el(...a);
  /** A bug caught in a widget callback also goes to the error diary (WH.diag). */
  const caught = (e, where) => { try { if (g.WH.diag) g.WH.diag.caught(e, where); } catch (x) { /* ignore */ } };

  /** {key, text} for a definition that has `i18n` or a `label`-like property. */
  function textOf(def, prop) {
    if (def.i18n) return { key: def.i18n, text: t(def.i18n, def.params) };
    const v = def[prop === undefined ? 'label' : prop];
    if (v === undefined || v === null) return { key: null, text: '' };
    if (typeof v === 'string' && KEY_RE.test(v) && g.WH.i18n.has(v)) return { key: v, text: t(v, def.params) };
    return { key: null, text: String(v) };
  }

  /** <span data-i18n="key">text</span> (or a plain span). */
  function labelSpan(def, cls, prop) {
    const { key, text } = textOf(def, prop);
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (key) { s.setAttribute('data-i18n', key); if (def.params) s.setAttribute('data-i18n-params', JSON.stringify(def.params)); }
    s.textContent = text;
    return s;
  }

  const overlayRoot = () => document.getElementById('overlay-root') || document.body;

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function focusables(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE)).filter((n) => !n.closest('[inert]') && !n.closest('[hidden]') && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // overlay stack (modals + floating layers): one Esc / Tab handler
  // ---------------------------------------------------------------------------------------------------------------------
  const stack = [];
  let modalN = 0;

  window.addEventListener('keydown', (e) => {
    if (!stack.length) return;
    const top = stack[stack.length - 1];
    if (e.key === 'Escape' && top.escape !== false) {
      e.preventDefault();
      e.stopPropagation();
      top.close();
      return;
    }
    if (top.onKey && top.onKey(e) === true) return;
    if (e.key === 'Tab' && top.kind === 'modal') {
      const list = focusables(top.el);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !top.el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !top.el.contains(active))) { e.preventDefault(); first.focus(); }
    }
  }, true);

  function setBackgroundInert(on) {
    for (const id of ['app-header', 'app-main', 'welcome']) {
      const n = document.getElementById(id);
      if (!n) continue;
      if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert');
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // dialog
  // ---------------------------------------------------------------------------------------------------------------------
  /**
   * Modal dialog.  opts: {title, content (Node|string|array), wide, small, onClose, actions:[{label|i18n, variant, primary,
   * onClick(close), keep}], closeOnBackdrop=true, closeOnEsc=true, initialFocus (selector|Element), className}
   * Returns {el, body, close(), closed: Promise, setTitle(text)}.
   */
  function dialog(opts) {
    opts = opts || {};
    const prevFocus = document.activeElement;
    const titleId = g.WH.util.uid('dlg-title');
    const backdrop = el('div.modal-backdrop');
    const box = el('div.modal', { role: opts.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' });
    if (opts.wide) box.classList.add('modal--wide');
    if (opts.small) box.classList.add('modal--sm');
    if (opts.className) box.classList.add(...String(opts.className).split(/\s+/).filter(Boolean));
    const titleDef = typeof opts.title === 'object' && opts.title ? opts.title : { label: opts.title };
    const titleEl = labelSpan(titleDef, 'modal__title');
    titleEl.id = titleId;
    titleEl.setAttribute('role', 'heading');
    titleEl.setAttribute('aria-level', '2');
    const closeBtn = el('button.btn.btn--icon.btn--ghost', { type: 'button', 'data-tip': 'ui.close', 'data-kbd': 'Esc' }, ui.icon('x'));
    const head = el('div.modal__head', titleEl, closeBtn);
    const body = el('div.modal__body');
    const content = opts.content;
    if (typeof content === 'string') body.textContent = content;
    else if (content) body.append(...(Array.isArray(content) ? content : [content]));
    box.append(head, body);
    let resolveClosed;
    const closed = new Promise((r) => { resolveClosed = r; });
    let isClosed = false;
    const entry = { kind: 'modal', el: box, escape: opts.closeOnEsc !== false, close };

    function close(result) {
      if (isClosed) return;
      isClosed = true;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      modalN = Math.max(0, modalN - 1);
      backdrop.classList.add('is-leaving');
      backdrop.remove();
      const below = stack.filter((s) => s.kind === 'modal').pop();
      if (below) below.backdrop.removeAttribute('inert');
      else { setBackgroundInert(false); document.body.classList.remove('has-modal'); }
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      try { if (typeof opts.onClose === 'function') opts.onClose(result); } catch (e) { console.error(e); caught(e, 'dialog.onClose'); }
      resolveClosed(result);
      if (live.length) placeToasts();   // a drawer that lay over the side panel is gone
    }
    entry.backdrop = backdrop;

    if (Array.isArray(opts.actions) && opts.actions.length) {
      const foot = el('div.modal__foot');
      for (const a of opts.actions) {
        const b = ui.button({ label: a.label, i18n: a.i18n, params: a.params, variant: a.variant || (a.primary ? 'primary' : 'secondary'), icon: a.icon });
        if (a.autofocus) b.setAttribute('data-autofocus', '');
        b.addEventListener('click', () => {
          let keep = false;
          if (typeof a.onClick === 'function') keep = a.onClick(close) === false;
          if (!keep) close(a.result);
        });
        foot.append(b);
      }
      box.append(foot);
    }

    closeBtn.addEventListener('click', () => close());
    if (opts.closeOnBackdrop !== false) {
      let downOnBackdrop = false;
      backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop && downOnBackdrop) close(); });
    }

    // stack: the previous modal becomes inert
    const prevModal = stack.filter((s) => s.kind === 'modal').pop();
    if (prevModal) prevModal.backdrop.setAttribute('inert', ''); else setBackgroundInert(true);
    document.body.classList.add('has-modal');
    stack.push(entry);
    modalN += 1;
    backdrop.append(box);
    overlayRoot().append(backdrop);
    ui.enhance(box);

    // initial focus
    let target = null;
    if (opts.initialFocus) target = typeof opts.initialFocus === 'string' ? box.querySelector(opts.initialFocus) : opts.initialFocus;
    if (!target) target = box.querySelector('[data-autofocus]');
    if (!target) target = focusables(body)[0] || box;
    requestAnimationFrame(() => { try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    if (live.length) placeToasts();   // toasts already shown step aside from a side drawer

    return { el: box, body, close, closed, setTitle(text) { titleEl.removeAttribute('data-i18n'); titleEl.textContent = text; } };
  }

  /**
   * Confirmation dialog -> Promise<boolean>.
   *   WH.ui.confirm({title, body, ok, cancel, danger})   (strings or i18n keys; body may be a Node)
   */
  function confirm(o) {
    o = o || {};
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const bodyDef = typeof o.body === 'object' && o.body && !('nodeType' in o.body) ? o.body : { label: o.body };
      let content;
      if (o.body && typeof o.body === 'object' && 'nodeType' in o.body) content = o.body;
      else content = el('p', labelSpan(bodyDef, ''));
      const okDef = { label: o.ok, i18n: o.ok ? undefined : 'ui.ok' };
      const cancelDef = { label: o.cancel, i18n: o.cancel ? undefined : 'ui.cancel' };
      dialog({
        title: o.title,
        small: true,
        content,
        initialFocus: '[data-autofocus]',
        onClose: () => done(false),
        actions: [
          Object.assign({ variant: 'secondary', result: false, onClick: () => done(false) }, cancelDef, o.danger ? { autofocus: true } : {}),
          Object.assign({ variant: o.danger ? 'danger' : 'primary', result: true, onClick: () => done(true) }, okDef, o.danger ? {} : { autofocus: true }),
        ],
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // toast
  // ---------------------------------------------------------------------------------------------------------------------
  const ICON_FOR = { info: 'info', ok: 'check-circle', warn: 'warning', error: 'alert-circle' };
  const MS_FOR = { info: 4200, ok: 4200, warn: 6500, error: 8000 };
  const live = [];

  // Placement: toasts must never cover the plan, the map controls (view/band switches, legend, zoom, tool palette,
  // markers, the editor's option bar, hint line and "Done" button) or the planner's sticky action bar.
  //   Desktop (>= 900 px, side panel visible): the bottom of the side panel column (Wi-Fi sidebar / editor
  //     inspector), same width as its cards, growing upwards - the lowest-priority part of the panel (room list,
  //     plan check), far from the sticky action bar at its top, and nothing on the stage is ever covered. If an open
  //     floating panel / menu / [data-toast-avoid] element sits there, the top of the panel (below its sticky bar) is
  //     used instead. Without a side panel: the top of the stage between / below the top toolbars (old behaviour).
  //   Phones: bottom of the screen as long as the stack stays below the lowest stage control in view (older toasts
  //     are tucked away while the newest needs the room); if not even one fits there, below the sticky header when
  //     that is free, else whichever edge covers less.
  //   No visible stage (welcome overlay): CSS default (bottom centre).
  // Re-evaluated on show/close, resize, scroll and view changes.
  // Whenever a toast does sit over the stage, its body lets the pointer through to the plan (only the action / close
  // buttons take clicks) and fades while the pointer passes over it.
  const STAGE_CTRL = '.stage .toolbar, .stage .legend, .stage__slot > *, .stage .btn, .tool-rail';
  const AVOID = '.pop-panel, .menu, [data-toast-avoid]';
  const TOAST_W = 440;
  const rectOf = (n) => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const overlapArea = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  let placeRaf = 0;

  /** Desktop: dock the stack to the bottom (or top) of the visible side panel. Returns false when there is none. */
  function placeInSidePanel(rootEl, view, stage, set) {
    const side = view.querySelector('.sidebar');
    if (!side || side.offsetWidth < 280 || side.offsetHeight < 240) return false;
    const cs = getComputedStyle(side);
    const sr = side.getBoundingClientRect();
    const l = sr.left + side.clientLeft + (parseFloat(cs.paddingLeft) || 0);
    const w = Math.min(TOAST_W, side.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
    const vh = window.innerHeight;
    const st = stage ? stage.getBoundingClientRect() : null;
    // bottom edge: level with the stage's bottom edge (same grid row), never below the viewport
    const bottomEdge = Math.min(vh - 8, st && st.bottom > sr.top ? st.bottom : sr.bottom - 2);
    // top edge: below the panel's own sticky bar (planner: "Find the best spot" / "Back to today's place")
    let topEdge = Math.max(sr.top + 2, 0);
    for (const n of Array.from(side.children)) {
      if (getComputedStyle(n).position !== 'sticky' || !n.offsetHeight) continue;
      topEdge = Math.max(topEdge, n.getBoundingClientRect().bottom + 8);
    }
    const header = document.getElementById('app-header');
    topEdge = Math.max(topEdge, header ? header.getBoundingClientRect().bottom + 8 : 8);
    set(l, w, null, vh - bottomEdge);
    const H = rootEl.offsetHeight || 64;
    let atTopNow = false;
    const avoid = Array.from(document.querySelectorAll(AVOID)).filter((n) => n.offsetWidth && n.offsetHeight && !n.closest('[hidden]')).map(rectOf);
    if (avoid.length) {
      const atBottom = { l, r: l + w, t: bottomEdge - H, b: bottomEdge };
      const cover = (r) => avoid.reduce((sum, c) => sum + overlapArea(r, c), 0);
      const below = cover(atBottom);
      if (below > 0) {
        // the top of the panel, or right below an avoided element up there (e.g. the head of a panel docked at the top
        // whose sticky action row sits at the bottom): the spot covering the least wins, the top edge on a tie
        const tops = [topEdge, ...avoid.filter((c) => c.r > l && c.l < l + w && c.b > topEdge && c.b + 8 + H <= bottomEdge).map((c) => c.b + 8)];
        let best = null;
        for (const tp of tops) { const cv = cover({ l, r: l + w, t: tp, b: tp + H }); if (!best || cv < best.cv) best = { tp, cv }; }
        if (best && best.cv < below) { set(l, w, best.tp, null); atTopNow = true; }
      }
    }
    // docked at the bottom: the panel gets that much extra scroll room, so whatever the stack covers (a list row, a
    // "Show" / "Join" button of the plan check...) can be scrolled up into view instead of staying unreachable
    if (!atTopNow) padWant = { side, px: Math.ceil(H + Math.max(0, sr.bottom - bottomEdge) + 8) };
    return true;
  }
  // the extra scroll room is decided during placement and applied once at its end, and only when it changes: removing
  // and re-adding it would shrink the panel's scroll height for a moment and clamp a panel scrolled to its end
  let paddedSide = null;
  let padWant = null;
  function applyPad() {
    const side = padWant ? padWant.side : null;
    if (paddedSide && paddedSide !== side) paddedSide.style.removeProperty('--toast-pad');
    paddedSide = side;
    if (side) { const v = `${padWant.px}px`; if (side.style.getPropertyValue('--toast-pad') !== v) side.style.setProperty('--toast-pad', v); }
  }

  function placeToastsNow() {
    placeRaf = 0;
    padWant = null;
    placeToastsInner();
    applyPad();
  }
  function placeToastsInner() {
    const rootEl = document.getElementById('toast-root');
    if (!rootEl || !live.length) return;
    const st = rootEl.style;
    const nodes = live.map((x) => x.node);
    nodes.forEach((n) => n.classList.remove('is-stacked'));
    const view = document.querySelector('.view:not([hidden])');
    const stage = view && view.querySelector('.stage');
    const welcome = g.WH.shell && typeof g.WH.shell.isWelcomeOpen === 'function' && g.WH.shell.isWelcomeOpen();
    rootEl.classList.remove('toast-root--over-stage');
    if (!stage || !stage.offsetWidth || welcome) {
      st.left = st.right = st.top = st.bottom = st.width = st.transform = '';
      rootEl.classList.remove('toast-root--top');
      return;
    }
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const header = document.getElementById('app-header');
    const headB = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    const ctrls = Array.from(view.querySelectorAll(STAGE_CTRL)).filter((n) => n.offsetWidth && n.offsetHeight && !n.closest('[hidden]')).map(rectOf);
    const set = (left, width, top, bottom) => {
      st.width = `${Math.round(width)}px`;
      st.left = `${Math.round(left)}px`;
      st.transform = 'none';
      st.right = '';
      if (top !== null) { st.top = `${Math.round(top)}px`; st.bottom = 'auto'; rootEl.classList.add('toast-root--top'); } else { st.top = ''; st.bottom = `${Math.round(bottom)}px`; rootEl.classList.remove('toast-root--top'); }
    };
    const tuck = (room) => {
      let H = rootEl.offsetHeight;
      for (let k = 0; H > room && k < nodes.length - 1; k += 1) { nodes[k].classList.add('is-stacked'); H = rootEl.offsetHeight; }
      return H;
    };
    if (vw >= 900) {
      // a side drawer (Help, Info o zařízení) lies over the side panel: the stack goes over the stage instead
      const drawer = Array.from(document.querySelectorAll('.modal--drawer')).some((n) => n.offsetWidth && n.offsetHeight);
      if (!drawer && placeInSidePanel(rootEl, view, stage, set)) return;
      rootEl.classList.add('toast-root--over-stage');
      const s = rectOf(stage);
      const pad = 12;
      const minTop = headB + 8;
      const row = ctrls.filter((c) => c.b > s.t && c.t < s.t + 96 && c.r > s.l && c.l < s.r);
      let segs = [[s.l + pad, s.r - pad]];
      for (const c of row) {
        const a = c.l - 10;
        const b = c.r + 10;
        segs = segs.flatMap(([x0, x1]) => (b <= x0 || a >= x1 ? [[x0, x1]] : [[x0, Math.min(x1, a)], [Math.max(x0, b), x1]].filter(([u, v]) => v - u > 0)));
      }
      const best = segs.reduce((m, x) => (!m || x[1] - x[0] > m[1] - m[0] ? x : m), null);
      if (best && best[1] - best[0] >= 380) {
        const w = Math.min(TOAST_W, best[1] - best[0]);
        set((best[0] + best[1]) / 2 - w / 2, w, Math.max(minTop, s.t + pad), null);
      } else {
        const rowB = row.reduce((m, c) => Math.max(m, c.b), s.t + pad);
        const w = Math.min(TOAST_W, s.r - s.l - 2 * pad);
        set((s.l + s.r) / 2 - w / 2, w, Math.max(minTop, Math.min(rowB + 8, vh - (rootEl.offsetHeight || 64) - 16)), null);
      }
      return;
    }
    // phones / narrow windows (the page scrolls): bottom edge, below every stage control (and every open floating
    // panel / [data-toast-avoid] element, e.g. a key action bar) that is in view
    const w = Math.min(TOAST_W, vw - 24);
    const left = (vw - w) / 2;
    set(left, w, null, 12);
    const avoid = Array.from(document.querySelectorAll(AVOID)).filter((n) => n.offsetWidth && n.offsetHeight && !n.closest('[hidden]')).map(rectOf);
    const inView = ctrls.concat(avoid).filter((c) => c.b > headB && c.t < vh);
    const gap = 8;
    const lowest = inView.reduce((m, c) => Math.max(m, c.b), headB);
    const highest = inView.reduce((m, c) => Math.min(m, c.t), vh);
    const roomBelow = vh - 12 - (lowest + gap);
    const H = tuck(roomBelow);
    if (H <= roomBelow) return;
    if (H <= highest - gap - (headB + gap)) { set(left, w, headB + gap, null); return; }
    // covering a key action bar / open panel ([data-toast-avoid], menus) counts double: a toast over the view switch
    // for a few seconds hurts less than one over "Find the best spot"
    const cover = (r) => ctrls.reduce((sum, c) => sum + overlapArea(r, c), 0) + 2 * avoid.reduce((sum, c) => sum + overlapArea(r, c), 0);
    const atTop = { l: left, r: left + w, t: headB + gap, b: headB + gap + H };
    const atBottom = { l: left, r: left + w, t: vh - 12 - H, b: vh - 12 };
    if (cover(atTop) < cover(atBottom)) set(left, w, headB + gap, null);
  }
  function placeToasts() { if (!placeRaf && typeof requestAnimationFrame === 'function') placeRaf = requestAnimationFrame(placeToastsNow); }
  ui.placeToasts = placeToasts;

  /** Toasts over the stage step aside: faded while the pointer is over their (click-through) body. */
  function yieldToPointer(e) {
    if (!live.length) return;
    const rootEl = document.getElementById('toast-root');
    const over = !!rootEl && rootEl.classList.contains('toast-root--over-stage');
    for (const rec of live) {
      const n = rec.node;
      let y = false;
      if (over && e && e.pointerType !== 'touch') {
        const b = n.getBoundingClientRect();
        y = e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom && !n.contains(e.target);
      }
      n.classList.toggle('is-yielding', y);
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', yieldToPointer, { passive: true, capture: true });
    window.addEventListener('pointerdown', yieldToPointer, { passive: true, capture: true });
    window.addEventListener('resize', () => { if (live.length) placeToasts(); });
    window.addEventListener('scroll', () => { if (live.length) placeToasts(); }, { passive: true, capture: true });
    if (g.WH.bus) {
      g.WH.bus.on('view:changed', () => { if (live.length) placeToasts(); });
      g.WH.bus.on('app:ready', () => { if (live.length) placeToasts(); });
    }
  }

  /** A toast node removed by someone else (another script, a test) still counted as live and kept the side panel's
   *  extra scroll room: forget such entries and re-place the rest. */
  let toastObs = null;
  function watchToastRoot(rootEl) {
    if (toastObs || typeof MutationObserver !== 'function') return;
    toastObs = new MutationObserver(() => {
      let gone = false;
      for (let i = live.length - 1; i >= 0; i--) if (!live[i].node.isConnected) { live.splice(i, 1); gone = true; }
      if (gone) placeToasts();
    });
    toastObs.observe(rootEl, { childList: true });
  }

  /**
   * Show a non-blocking message.  toast('text') | toast({text|i18n, params, action:{label, fn}}, {kind:'info|ok|warn|error', ms}).
   * A question with two answers: actions:[{label|i18n, fn, primary?}, ...] (shown on their own row under the text).
   * Returns {close()}.
   */
  function toast(msg, o) {
    o = Object.assign({}, typeof msg === 'object' && msg ? msg : null, o);
    const def = typeof msg === 'object' && msg ? msg : { label: msg };
    const kind = ICON_FOR[o.kind] ? o.kind : 'info';
    const { key, text } = textOf(def.text !== undefined ? { label: def.text, i18n: def.i18n, params: def.params } : def);
    const rootEl = document.getElementById('toast-root');
    if (!rootEl) { console.warn('[toast]', text); return { close() {} }; }

    const same = live.find((x) => x.text === text && x.kind === kind);
    if (same) { same.restart(); return { close: same.close }; }

    const node = el('div.toast.toast--' + kind, { role: kind === 'error' ? 'alert' : 'status' });
    const msgEl = el('div.toast__text');
    if (key) msgEl.setAttribute('data-i18n', key);
    msgEl.textContent = text;
    node.append(el('span.toast__icon', ui.icon(ICON_FOR[kind], 20)), msgEl);
    let timer = 0;
    let gone = false;
    const acts = (Array.isArray(def.actions) ? def.actions : def.action ? [def.action] : []).filter((a) => a && typeof a.fn === 'function');
    const ms = o.ms !== undefined ? o.ms : (acts.length ? 9000 : MS_FOR[kind]);
    const rec = { text, kind, restart, close, node };
    function close() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      const i = live.indexOf(rec);
      if (i >= 0) live.splice(i, 1);
      node.classList.add('is-leaving');
      setTimeout(() => { node.remove(); placeToasts(); }, 160);
    }
    function restart() {
      clearTimeout(timer);
      if (ms > 0) timer = setTimeout(close, ms);
    }
    const btns = acts.map((act) => {
      const a = ui.button({ label: act.label, i18n: act.i18n, icon: act.icon, variant: act.primary ? 'primary' : 'soft', size: 'sm' });
      a.classList.add('toast__action');
      a.addEventListener('click', () => { try { act.fn(); } catch (e) { console.error(e); caught(e, 'toast.action'); } close(); });
      return a;
    });
    if (btns.length === 1) node.append(btns[0]);
    const x = ui.iconButton({ icon: 'x', tip: 'ui.close', size: 'sm', variant: 'ghost' });
    x.classList.add('toast__close');
    x.setAttribute('data-tip-noaria', '');
    x.setAttribute('aria-label', t('ui.close'));
    x.addEventListener('click', close);
    node.append(x);
    if (btns.length > 1) { node.classList.add('toast--ask'); node.append(el('div.toast__actions', ...btns)); }
    node.addEventListener('pointerenter', () => clearTimeout(timer));
    node.addEventListener('pointerleave', restart);
    node.addEventListener('focusin', () => clearTimeout(timer));
    node.addEventListener('focusout', restart);

    live.push(rec);
    while (live.length > 3) live[0].close();
    watchToastRoot(rootEl);
    rootEl.append(node);
    ui.enhance(node);
    placeToastsNow();
    restart();
    return { close };
  }

  /** Screen-reader announcement through the #sr-live region. */
  function announce(text) {
    const n = document.getElementById('sr-live');
    if (!n) return;
    n.textContent = '';
    setTimeout(() => { n.textContent = text; }, 40);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // floating layers: popover panel & menu
  // ---------------------------------------------------------------------------------------------------------------------
  function positionFloating(node, anchor, o) {
    o = o || {};
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const m = 8;
    node.style.left = '0px';
    node.style.top = '0px';
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let placement = o.placement || 'bottom';
    if (placement === 'bottom' && vh - r.bottom < h + m && r.top > vh - r.bottom) placement = 'top';
    else if (placement === 'top' && r.top < h + m && vh - r.bottom > r.top) placement = 'bottom';
    let x;
    let y;
    if (placement === 'right' || placement === 'left') {
      x = placement === 'right' ? r.right + 6 : r.left - 6 - w;
      y = r.top;
    } else {
      x = o.align === 'end' ? r.right - w : o.align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
      y = placement === 'bottom' ? r.bottom + 6 : r.top - 6 - h;
    }
    x = Math.max(m, Math.min(x, vw - w - m));
    y = Math.max(m, Math.min(y, vh - h - m));
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
  }

  /** Common behaviour of menus and popover panels: stack entry, outside press, resize, focus return. */
  function openFloating(node, anchor, o) {
    const prevFocus = document.activeElement;
    let isClosed = false;
    const entry = { kind: 'float', el: node, escape: o.closeOnEsc !== false, close, onKey: o.onKey };
    // the caller may replace handle.reposition with its own placement (the planner's measurement popover does);
    // resize / scroll then use that one
    const handle = { el: node, close, reposition: () => positionFloating(node, anchor, o) };
    function close(result) {
      if (isClosed) return;
      isClosed = true;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      if (anchor && anchor.setAttribute && o.expandedAnchor !== false) anchor.setAttribute('aria-expanded', 'false');
      node.remove();
      if (o.restoreFocus !== false) {
        const back = anchor && anchor.isConnected ? anchor : prevFocus;
        if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }
      try { if (typeof o.onClose === 'function') o.onClose(result); } catch (e) { console.error(e); caught(e, 'popover.onClose'); }
    }
    // A resize keeps the panel and moves it with its anchor: on phones the on-screen keyboard resizes the window the
    // moment a field inside the panel gets focus (closing then made e.g. "how many metres?" impossible to fill in).
    // Only an anchor that is gone or hidden closes it.
    function onResize() {
      if (isClosed) return;
      if (!anchor || !anchor.isConnected || !anchor.getClientRects().length) { close(); return; }
      handle.reposition();
    }
    // Scrolling: the panel follows its anchor. When an inner scroll container (the sidebar, the inspector) carries the
    // anchor out of its visible area, the panel closes instead of floating detached over unrelated cards. Page scrolls
    // (phones: the on-screen keyboard scrolls the field into view) only move it.
    function onScroll(e) {
      if (isClosed) return;
      const t = e.target;
      if (t && t.nodeType === 1 && node.contains(t)) return;
      if (!anchor || !anchor.isConnected || !anchor.getClientRects().length) { close(); return; }
      if (t && t.nodeType === 1 && t !== document.documentElement && t !== document.body && t.contains(anchor)) {
        const s = t.getBoundingClientRect();
        const r = anchor.getBoundingClientRect();
        if (r.bottom < s.top + 4 || r.top > s.bottom - 4) { close(); return; }
      }
      handle.reposition();
    }
    function onOutside(e) {
      if (node.contains(e.target)) return;
      // A press inside a panel opened FROM this one (a dropdown menu inside the measurement popover, a nested popover)
      // or inside the shared hint bubble is not "outside": closing here would throw away what the user was filling in.
      const i = stack.indexOf(entry);
      if (i >= 0 && stack.slice(i + 1).some((s) => s.el && s.el.contains && s.el.contains(e.target))) return;
      if (e.target && e.target.closest && e.target.closest('.hint-bubble, [role="tooltip"]')) return;
      if (anchor && anchor.contains && anchor.contains(e.target) && o.toggleOnAnchor !== false) { e.stopPropagation(); e.preventDefault(); close(); return; }
      close();
    }
    overlayRoot().append(node);
    ui.enhance(node);
    positionFloating(node, anchor, o);
    stack.push(entry);
    if (anchor && anchor.setAttribute && o.expandedAnchor !== false) anchor.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return handle;
  }

  /**
   * Non-modal floating panel next to a button (layers, "how many metres?" ...).
   * WH.ui.popover(anchorEl, content, {title, placement:'top|bottom|left|right', align:'start|center|end', width, onClose, className}) -> {el, close}
   */
  function popover(anchor, content, o) {
    o = o || {};
    const panel = el('div.pop-panel', { role: 'dialog' });
    if (o.className) panel.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
    if (o.width) panel.style.width = typeof o.width === 'number' ? `${o.width}px` : o.width;
    if (o.title) {
      const titleDef = typeof o.title === 'object' ? o.title : { label: o.title };
      const h = labelSpan(titleDef, 'pop-panel__title');
      h.style.display = 'block';
      panel.append(h);
      panel.setAttribute('aria-label', h.textContent);
    }
    if (typeof content === 'string') panel.append(document.createTextNode(content));
    else if (content) panel.append(...(Array.isArray(content) ? content : [content]));
    const h = openFloating(panel, anchor, o);
    // land on the first real control: a "?" hint first in the panel would pop its explanation open over the panel
    const list = focusables(panel);
    const first = list.find((n) => !n.classList.contains('hint')) || list[0];
    if (first && o.autofocus !== false) requestAnimationFrame(() => { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    return h;
  }

  /**
   * Dropdown menu.  items: [{label|i18n, icon, kbd, onClick, danger, disabled, checked, radio, sep:true, note, heading, hidden}]
   * (checked !== undefined = a check column; radio:true makes it a menuitemradio and the menu opens on the checked one)
   * (or a function returning that array).  Keyboard: arrows/Home/End/Enter/Esc.  Returns {el, close}.
   */
  function menu(anchor, items, o) {
    o = o || {};
    const list = (typeof items === 'function' ? items() : items).filter((it) => it && !it.hidden);
    const node = el('div.menu', { role: 'menu' });
    const buttons = [];
    for (const it of list) {
      if (it.sep) { node.append(el('hr.menu__sep', { role: 'separator' })); continue; }
      if (it.heading) { node.append(labelSpan({ label: it.heading, i18n: it.i18n }, 'menu__heading')); continue; }
      if (it.note) { const n = labelSpan({ label: it.note, i18n: it.i18n }, 'menu__note'); n.style.display = 'block'; node.append(n); continue; }
      const checkable = it.checked !== undefined;
      const b = el('button.menu__item', { type: 'button', role: checkable ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem', tabindex: '-1' });
      if (checkable) {
        // a check column, then (optionally) the item's own icon: "✓ [sun] Light"
        b.setAttribute('aria-checked', it.checked ? 'true' : 'false');
        b.append(el('span.menu__check', it.checked ? ui.icon('check', 16) : null));
        if (it.icon) b.append(el('span.menu__icon', ui.icon(it.icon, 18)));
      } else if (it.icon) {
        b.append(el('span.menu__icon', ui.icon(it.icon, 18)));
      }
      b.append(labelSpan(it, 'menu__label'));
      if (it.kbd) b.append(el('span.menu__kbd', ui.kbd(it.kbd)));
      if (it.danger) b.classList.add('menu__item--danger');
      if (it.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      b.addEventListener('click', () => {
        handle.close();
        if (typeof it.onClick === 'function') setTimeout(() => { try { it.onClick(); } catch (e) { console.error(e); caught(e, 'menu.item'); } }, 0);
      });
      node.append(b);
      if (!it.disabled) buttons.push(b);
    }
    let idx = -1;
    const focusAt = (i) => {
      if (!buttons.length) return;
      idx = (i + buttons.length) % buttons.length;
      buttons[idx].focus({ preventScroll: true });
    };
    const handle = openFloating(node, anchor, Object.assign({ align: 'start' }, o, {
      onKey(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(idx + 1); return true; }
        if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(idx < 0 ? -1 : idx - 1); return true; }
        if (e.key === 'Home') { e.preventDefault(); focusAt(0); return true; }
        if (e.key === 'End') { e.preventDefault(); focusAt(-1); return true; }
        if (e.key === 'Tab') { e.preventDefault(); handle.close(); return true; }
        return false;
      },
    }));
    node.addEventListener('pointermove', (e) => { const b = e.target.closest && e.target.closest('.menu__item'); if (b) idx = buttons.indexOf(b); });
    // a radio menu (theme) opens on its checked item, any other menu on the first one
    const startAt = buttons.findIndex((x) => x.getAttribute('role') === 'menuitemradio' && x.getAttribute('aria-checked') === 'true');
    requestAnimationFrame(() => focusAt(Math.max(0, startAt)));
    return handle;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // buttons
  // ---------------------------------------------------------------------------------------------------------------------
  /**
   * <button class="btn btn--variant">  opts: {label|i18n, icon, variant, size:'sm|lg', onClick, kbd, tip, block, ariaLabel, type}
   */
  function button(o) {
    o = o || {};
    const b = el('button.btn', { type: o.type || 'button' });
    if (o.variant && o.variant !== 'secondary') b.classList.add(`btn--${o.variant}`);
    if (o.size) b.classList.add(`btn--${o.size}`);
    if (o.block) b.classList.add('btn--block');
    if (o.icon) b.append(ui.icon(o.icon, o.size === 'sm' ? 16 : 18));
    const { key, text } = textOf(o);
    if (text) {
      const s = el('span.btn__label');
      if (key) s.setAttribute('data-i18n', key);
      s.textContent = text;
      b.append(s);
    } else if (o.icon) {
      b.classList.add('btn--icon');
    }
    if (o.kbd && text) b.append(el('span.btn__kbd', ui.kbd(o.kbd)));
    if (o.tip) ui.tip(b, o.tip, o.kbd);
    if (o.ariaLabel) b.setAttribute('aria-label', o.ariaLabel);
    if (o.pressed !== undefined) b.setAttribute('aria-pressed', o.pressed ? 'true' : 'false');
    if (o.disabled) b.disabled = true;
    if (typeof o.onClick === 'function') b.addEventListener('click', o.onClick);
    return b;
  }

  /** Icon-only button with tooltip (+shortcut): {icon, tip, kbd, onClick, size, variant, pressed} */
  function iconButton(o) {
    const b = button({ icon: o.icon, variant: o.variant || 'ghost', size: o.size, onClick: o.onClick, pressed: o.pressed, disabled: o.disabled });
    b.classList.add('btn--icon');
    if (o.tip) ui.tip(b, o.tip, o.kbd);
    return b;
  }

  /** <span class="badge"><span class="badge__text">text</span></span> - the inner span lets CSS centre the capitals. */
  function badge(text, kind) {
    const b = el('span.badge' + (kind ? `.badge--${kind}` : ''));
    const { key, text: tx } = textOf({ label: text });
    const s = el('span.badge__text');
    if (key) s.setAttribute('data-i18n', key);
    s.textContent = tx;
    b.append(s);
    return b;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // segmented control, switch
  // ---------------------------------------------------------------------------------------------------------------------
  /**
   * items: [{value, label|i18n, icon, tip, kbd, disabled, ariaLabel}]
   * opts: {value, onChange(value, item), aria (i18n key or text), size:'sm', pill, block}
   * The returned element has: .value (get), .setValue(v, silent), .setDisabled(value, bool)
   */
  function segmented(items, o) {
    o = o || {};
    const root = el('div.seg', { role: 'radiogroup' });
    if (o.size) root.classList.add(`seg--${o.size}`);
    if (o.pill) root.classList.add('seg--pill');
    if (o.block) root.classList.add('seg--block');
    if (o.aria) {
      const { key, text } = textOf({ label: o.aria });
      if (key) root.setAttribute('data-i18n-aria', key);
      root.setAttribute('aria-label', text);
    }
    let value = o.value !== undefined ? o.value : items[0] && items[0].value;
    const btns = new Map();
    for (const it of items) {
      const b = el('button.seg__item', { type: 'button', role: 'radio' });
      if (it.icon) b.append(ui.icon(it.icon, 16));
      const { key, text } = textOf(it);
      if (text) { const s = el('span'); if (key) s.setAttribute('data-i18n', key); s.textContent = text; b.append(s); }
      if (it.ariaLabel) b.setAttribute('aria-label', it.ariaLabel);
      if (it.tip) ui.tip(b, it.tip, it.kbd);
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', () => select(it.value, true));
      btns.set(it.value, b);
      root.append(b);
    }
    function paint() {
      for (const [v, b] of btns) {
        const on = v === value;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    }
    function select(v, fire) {
      if (!btns.has(v)) return;
      const changed = v !== value;
      value = v;
      paint();
      if (fire && changed && typeof o.onChange === 'function') o.onChange(v, items.find((x) => x.value === v));
    }
    root.addEventListener('keydown', (e) => {
      const enabled = items.filter((it) => !btns.get(it.value).disabled);
      const i = enabled.findIndex((it) => it.value === value);
      let n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % enabled.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + enabled.length) % enabled.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = enabled.length - 1;
      if (n < 0 || !enabled.length) return;
      e.preventDefault();
      e.stopPropagation();
      select(enabled[n].value, true);
      btns.get(enabled[n].value).focus();
    });
    paint();
    Object.defineProperty(root, 'value', { get: () => value });
    root.setValue = (v, silent) => select(v, !silent);
    root.setDisabled = (v, dis) => { const b = btns.get(v); if (b) b.disabled = !!dis; };
    root.button = (v) => btns.get(v);
    return root;
  }

  /** <label class="switch"> opts: {checked, label|i18n, onChange(checked), hint, disabled, end} -> element with .input and .setChecked(b) */
  function switchControl(o) {
    o = o || {};
    const input = el('input', { type: 'checkbox', role: 'switch' });
    if (o.checked) input.checked = true;
    if (o.disabled) input.disabled = true;
    const lab = el('label.switch' + (o.end ? '.switch--end' : ''), input, el('span.switch__track'));
    const { key, text } = textOf(o);
    if (text) { const s = el('span.switch__label'); if (key) s.setAttribute('data-i18n', key); s.textContent = text; lab.append(s); }
    if (o.hint) lab.append(ui.hint(o.hint));
    input.addEventListener('change', () => { if (typeof o.onChange === 'function') o.onChange(input.checked); });
    lab.input = input;
    lab.setChecked = (b) => { input.checked = !!b; };
    return lab;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // form fields
  // ---------------------------------------------------------------------------------------------------------------------
  /**
   * Labelled field: {label|i18n, hint:'helpKey', unit, control (Node|Node[]), help|helpI18n, id, inline, error}
   * Wires <label for> to the first form control it can find.
   */
  function field(o) {
    o = o || {};
    const root = el('div.field' + (o.inline ? '.field--inline' : ''));
    const controls = Array.isArray(o.control) ? o.control : [o.control];
    const ctl = controls.find((c) => c && c.matches && c.matches('input,select,textarea')) || controls.find((c) => c && c.querySelector && c.querySelector('input,select,textarea'));
    const target = ctl && (ctl.matches('input,select,textarea') ? ctl : ctl.querySelector('input,select,textarea'));
    const id = o.id || (target && target.id) || g.WH.util.uid('f');
    if (target && !target.id) target.id = id;
    const lab = el('label.field__label', { for: target ? id : null });
    const ls = labelSpan(o, '');
    lab.append(ls);
    if (o.hint) lab.append(ui.hint(o.hint));
    const row = el('div.field__row', controls.filter(Boolean));
    if (o.unit) {
      const u = labelSpan({ label: o.unit }, 'field__unit');
      row.append(u);
    }
    root.append(lab, row);
    if (o.help || o.helpI18n) {
      const h = labelSpan({ label: o.help, i18n: o.helpI18n }, 'field__hint');
      h.style.display = 'block';
      h.id = `${id}-help`;
      root.append(h);
      if (target) target.setAttribute('aria-describedby', h.id);
    }
    const err = el('div.field__error', { hidden: true, role: 'alert' });
    root.append(err);
    root.setError = (msg) => { err.textContent = msg || ''; err.hidden = !msg; if (target) target.setAttribute('aria-invalid', msg ? 'true' : 'false'); };
    root.control = target;
    return root;
  }

  /** Number input: {value, min, max, step, onInput(v), onChange(v), ariaLabel, id, placeholder, decimals} (v = number|null) */
  /** Number as the app's language writes it ("0,9" in Czech, "0.9" in English) - a type=number field follows the
   *  BROWSER's locale instead, so a Czech page in an English browser showed "0.9". Full precision, no grouping. */
  const numText = (v) => { const s = String(v); return g.WH.i18n && g.WH.i18n.lang === 'cs' ? s.replace('.', ',') : s; };
  /** "0,9" / "0.9" / "−3" / "1 000" -> number; NaN when it is not one. */
  const numParse = (s) => {
    const v = String(s == null ? '' : s).replace(/[\s  ]/g, '').replace(/[−–]/g, '-').replace(',', '.');
    return v === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v) ? NaN : Number(v);
  };
  ui.numText = numText;
  ui.numParse = numParse;

  /** A numeric text field: localized decimal separator, `.valueAsNumber` like a number input (NaN when empty or not a
   *  number), ArrowUp / ArrowDown step within min..max. Mark: `input.input--num[data-num]`. */
  function numberInput(o) {
    o = o || {};
    const i = el('input.input.input--num', { type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'data-num': '' });
    const min = Number.isFinite(Number(o.min)) && o.min !== null && o.min !== '' ? Number(o.min) : -Infinity;
    const max = Number.isFinite(Number(o.max)) && o.max !== null && o.max !== '' ? Number(o.max) : Infinity;
    const step = Number(o.step) > 0 ? Number(o.step) : 1;
    if (o.min !== undefined) i.dataset.min = String(o.min);
    if (o.max !== undefined) i.dataset.max = String(o.max);
    if (o.id) i.id = o.id;
    if (o.ariaLabel) i.setAttribute('aria-label', o.ariaLabel);
    if (o.placeholder) i.placeholder = o.placeholder;
    Object.defineProperty(i, 'valueAsNumber', { configurable: true, get: () => numParse(i.value) });
    const read = () => (i.value === '' || !Number.isFinite(i.valueAsNumber) ? null : i.valueAsNumber);
    if (typeof o.onInput === 'function') i.addEventListener('input', () => o.onInput(read()));
    if (typeof o.onChange === 'function') i.addEventListener('change', () => o.onChange(read()));
    i.setValue = (v) => { i.value = v === null || v === undefined || !Number.isFinite(v) ? '' : numText(v); };
    i.addEventListener('keydown', (e) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const cur = Number.isFinite(i.valueAsNumber) ? i.valueAsNumber : Number.isFinite(min) ? min : 0;
      const k = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const dec = (String(step).split('.')[1] || '').length;
      const next = Math.min(max, Math.max(min, Math.round((cur + k * step) * 10 ** dec) / 10 ** dec));
      i.setValue(next);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (o.value !== undefined && o.value !== null) i.setValue(Number(o.value));
    return i;
  }

  /** <select class="select">  options: [{value, label|i18n, disabled}]  opts: {value, onChange(value), id, ariaLabel} */
  function select(options, o) {
    o = o || {};
    const s = el('select.select');
    if (o.id) s.id = o.id;
    if (o.ariaLabel) s.setAttribute('aria-label', o.ariaLabel);
    const fill = (opts) => {
      s.replaceChildren();
      for (const op of opts) {
        const { key, text } = textOf(op);
        const x = el('option', { value: String(op.value) });
        if (key) x.setAttribute('data-i18n', key);
        x.textContent = text;
        if (op.disabled) x.disabled = true;
        s.append(x);
      }
    };
    fill(options);
    if (o.value !== undefined) s.value = String(o.value);
    if (typeof o.onChange === 'function') s.addEventListener('change', () => o.onChange(s.value));
    s.setOptions = (opts, value) => { fill(opts); if (value !== undefined) s.value = String(value); };
    return s;
  }

  /** Range slider with live value: {min,max,step,value,onInput(v),onChange(v),format(v)->string,ariaLabel} -> element with .input, .setValue(v) */
  function range(o) {
    o = o || {};
    const i = el('input.range', { type: 'range', min: String(o.min !== undefined ? o.min : 0), max: String(o.max !== undefined ? o.max : 100), step: String(o.step !== undefined ? o.step : 1) });
    if (o.ariaLabel) i.setAttribute('aria-label', o.ariaLabel);
    if (o.id) i.id = o.id;
    i.value = String(o.value !== undefined ? o.value : i.min);
    const out = el('output.range-value', { for: o.id || null });
    const fmtv = o.format || ((v) => g.WH.util.fmt(v, 0));
    const sync = () => { out.textContent = fmtv(parseFloat(i.value)); ui.rangeFill(i); };
    i.addEventListener('input', () => { sync(); if (typeof o.onInput === 'function') o.onInput(parseFloat(i.value)); });
    i.addEventListener('change', () => { if (typeof o.onChange === 'function') o.onChange(parseFloat(i.value)); });
    const wrap = el('div.row.grow', i, out);
    wrap.input = i;
    wrap.setValue = (v) => { i.value = String(v); sync(); };
    sync();
    return wrap;
  }

  /** Thin progress bar. progress({value:0..1}) or progress({indeterminate:true}) -> element with .setValue(v) */
  function progress(o) {
    o = o || {};
    const bar = el('div.progress__bar');
    const root = el('div.progress' + (o.indeterminate ? '.progress--indeterminate' : ''), { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    root.setValue = (v) => {
      const x = Math.max(0, Math.min(1, v));
      root.style.setProperty('--p', String(x));
      root.setAttribute('aria-valuenow', String(Math.round(x * 100)));
      root.classList.remove('progress--indeterminate');
    };
    if (o.value !== undefined) root.setValue(o.value);
    return root;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // card
  // ---------------------------------------------------------------------------------------------------------------------
  /**
   * Collapsible card.  {id, title|i18n, icon, hint:'helpKey', badge, collapsible=true, open=true, actions:[Node], body: Node|Node[]|string}
   * The open/closed state of cards with an id is remembered in prefs (collapsed.<id>).
   * Returns the element; .body is the content container; .setOpen(bool), .isOpen(), .setBadge(textOrNumber|null), .setTitle(text)
   */
  function card(o) {
    o = o || {};
    const collapsible = o.collapsible !== false;
    const store = g.WH.store;
    let open = o.open !== false;
    if (collapsible && o.id && store) {
      const saved = store.getPref(`collapsed.${o.id}`);
      if (saved !== undefined) open = !saved;
    }
    const uid = g.WH.util.uid('card');
    const bodyId = `${uid}-body`;
    const titleId = `${uid}-title`;
    const root = el('section.card', { 'data-card': o.id || '' });
    if (collapsible) root.setAttribute('data-collapsible', '');
    root.setAttribute('data-open', open ? 'true' : 'false');

    const titleEl = labelSpan(o, 'card-title', 'title');
    titleEl.id = titleId;
    const inside = [o.icon ? el('span.card-icon', ui.icon(o.icon, 20)) : null, titleEl];
    const toggle = collapsible
      ? el('button.card-toggle', { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId }, inside)
      : el('div.card-toggle', inside);
    const head = el('div.card-head', toggle);
    if (o.hint) head.append(ui.hint(o.hint));
    head.append(el('span.spacer'));
    const badgeEl = el('span.badge.badge--count', { hidden: true });
    head.append(badgeEl);
    if (o.actions && o.actions.length) head.append(el('div.card-actions', o.actions));
    if (collapsible) head.append(el('span.card-chevron', { 'aria-hidden': 'true' }, ui.icon('chevron-down', 18)));

    const inner = el('div.card-body__inner');
    if (typeof o.body === 'string') inner.textContent = o.body;
    else if (o.body) inner.append(...(Array.isArray(o.body) ? o.body : [o.body]));
    const bodyWrap = el('div.card-body', { id: bodyId, role: 'group', 'aria-labelledby': titleId }, inner);
    root.append(head, bodyWrap);

    function apply(next, persist) {
      open = next;
      root.setAttribute('data-open', open ? 'true' : 'false');
      if (collapsible) {
        toggle.setAttribute('aria-expanded', String(open));
        if (open) bodyWrap.removeAttribute('inert'); else bodyWrap.setAttribute('inert', '');
      }
      if (persist && o.id && store) store.setPref(`collapsed.${o.id}`, !open);
    }
    apply(open, false);

    if (collapsible) {
      const flip = () => {
        root.classList.add('is-animating');
        apply(!open, true);
        setTimeout(() => root.classList.remove('is-animating'), 260);
      };
      toggle.addEventListener('click', (e) => { e.stopPropagation(); flip(); });
      head.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select, textarea, .hint')) return;
        flip();
      });
    }
    root.body = inner;
    root.isOpen = () => open;
    root.setOpen = (b) => { if (!!b !== open) { root.classList.add('is-animating'); apply(!!b, true); setTimeout(() => root.classList.remove('is-animating'), 260); } };
    root.setBadge = (v) => {
      const show = v !== null && v !== undefined && v !== '' && v !== 0;
      badgeEl.hidden = !show;
      badgeEl.replaceChildren(show ? el('span.badge__text', String(v)) : '');
    };
    root.setTitle = (text) => { titleEl.removeAttribute('data-i18n'); titleEl.textContent = text; };
    if (o.badge !== undefined) root.setBadge(o.badge);
    return root;
  }

  Object.assign(ui, {
    dialog, confirm, toast, announce, popover, menu, button, iconButton, badge, segmented, switch: switchControl, switchControl,
    field, numberInput, select, range, progress, card, focusables,
    modalCount: () => modalN,
    /** Treat something else (the welcome screen) as a modal: global shortcuts stay off while the count is > 0. */
    blockInput: (delta) => { modalN = Math.max(0, modalN + delta); },
    /** i18n helper for widgets: {key,text} for a def with i18n/label. */
    textOf,
  });
})();
