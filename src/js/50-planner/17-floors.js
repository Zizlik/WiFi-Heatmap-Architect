/* Planner: floors of a multi-storey home (SPEC 14.3) - the planner side.
 *
 *   PL.fl.go(id, {quiet})      make floor `id` the one on the map (the top-level plan / nodes / measurements follow it -
 *                               ENGINE-API S); not an undo step, like the band or the view
 *   PL.fl.step(dir)            one floor up (+1) / down (-1): Ctrl+↑ / Ctrl+↓
 *   PL.fl.goNth(n)             the n-th floor counted from the lowest (1-based): Alt+1 … Alt+9
 *   PL.fl.mount(st)            the floor switch on the stage (left edge, like the buttons of a lift: the top floor on top)
 *   PL.fl.sync()               rebuild / repaint it (floors added or renamed in the editor, another floor active)
 *   PL.fl.pill()               the floor pill of the phone's measuring mode (tap = choose the floor)
 *   PL.fl.short(f)             the short label of a floor on narrow stages: "P" / "1" / "−1"
 *   PL.ghostList()             the sources standing on another floor, drawn as faded ghosts "na jiném patře":
 *                              [{key, kind:'router'|'node', id?, mode?, pos, floor, name}]
 * Only UI lives here; which floor is active and what lies on it is data (WH.engine.project.switchFloor & co.). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const store = () => WH.store;
  const FL = (PL.fl = {});
  /** Every topic a floor switch touches (the top level now holds another floor's content). */
  const TOPICS = ['plan', 'nodes', 'measurements', 'goal', 'floors', 'view'];

  FL.short = (f) => (!f ? '' : f.level === 0 ? t('planner.fl.short0') : f.level > 0 ? String(f.level) : t('planner.fl.shortDown', { n: -f.level }));

  /** Switch the map to floor `id`. o.quiet: no announcement (the caller says something itself). */
  FL.go = (id, o) => {
    const p = PL.P();
    o = o || {};
    if (!p || !Array.isArray(p.floors) || !id || id === PL.floorId() || !p.floors.some((f) => f.id === id)) return false;
    if (PL.cancelGestures) PL.cancelGestures();
    let ok = false;
    store().update((pr) => { ok = WH.engine.project.switchFloor(pr, id) !== false; }, TOPICS, { quiet: true });
    if (!ok) return false;
    const name = PL.floorName(id);
    if (!o.quiet) ui().announce(t('planner.fl.switched', { name }));
    // the plan of another floor may stand elsewhere on the canvas: follow it unless the user placed the view himself
    if (PL.autoFit) requestAnimationFrame(() => PL.autoFit());
    FL.sync();
    return true;
  };
  /** dir +1 = the floor above, -1 = below; at the top / bottom a short note instead. */
  FL.step = (dir) => {
    const list = PL.floorList();
    const i = list.findIndex((f) => f.id === PL.floorId());
    const n = list[i + (dir > 0 ? 1 : -1)];
    if (!n) { ui().toast({ i18n: dir > 0 ? 'planner.fl.top' : 'planner.fl.bottom' }, { ms: 1800 }); return false; }
    return FL.go(n.id);
  };
  FL.goNth = (n) => {
    const list = PL.floorList();
    const f = list[n - 1];
    if (!f) return false;
    if (f.id === PL.floorId()) { ui().announce(t('planner.fl.switched', { name: f.name })); return true; }
    return FL.go(f.id);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // the sources on another floor: faded ghosts on the map ("na jiném patře")
  // ---------------------------------------------------------------------------------------------------------------
  PL.ghostList = () => {
    const p = PL.P();
    if (!p || !PL.multi() || !p.plan.rooms.length) return [];
    const out = [];
    if (!PL.routerHere() && p.net.router) out.push({ key: 'router', kind: 'router', pos: p.net.router, floor: p.net.routerFloor, name: t('planner.tip.routerName') });
    for (const x of PL.allNodes()) {
      const n = x.node;
      if (x.active || !n.enabled || !n.pos) continue;
      out.push({ key: 'n:' + n.id, kind: 'node', id: n.id, mode: n.mode, pos: n.pos, floor: x.floor, name: PL.nodeName(n) });
    }
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // the floor switch on the stage
  // ---------------------------------------------------------------------------------------------------------------
  let slot = null;
  let seg = null;
  let key = '';
  FL.mount = (st) => {
    slot = el('div.stage__slot.stage__cl.pl-floorslot', { hidden: true });
    st.el.append(slot);
    st.floorSlot = slot;
    FL.sync();
  };
  FL.sync = () => {
    if (!slot) return;
    const list = PL.floorList();
    const multi = list.length > 1;
    const act = PL.floorId();
    const k = multi ? JSON.stringify([list.map((f) => [f.id, f.name, f.level]), WH.i18n.lang]) : '';
    if (k !== key) {
      key = k;
      seg = null;
      if (multi) {
        // the top floor on top, like a lift; ArrowDown goes one floor down
        const items = list.slice().reverse().map((f) => ({ value: f.id, label: f.name, ariaLabel: t('planner.fl.aria1', { name: f.name, n: list.indexOf(f) + 1 }) }));
        seg = ui().segmented(items, { value: act, aria: 'planner.fl.aria', onChange: (v) => FL.go(v) });
        seg.classList.add('pl-floors');
        for (const it of items) {
          const b = seg.button(it.value);
          const f = list.find((x) => x.id === it.value);
          const s = b.querySelector('span');
          if (s) s.classList.add('pl-fl__long');
          b.append(el('span.pl-fl__short', { 'aria-hidden': 'true' }, FL.short(f)));
        }
        slot.replaceChildren(el('div.toolbar.toolbar--vertical.pl-floorbar', seg, ui().hint('floorSwitch')));
      } else slot.replaceChildren();
    }
    if (seg && seg.value !== act) seg.setValue(act, true);
    const hide = !multi;
    if (slot.hidden !== hide) {
      slot.hidden = hide;
      // the plan steps right of the switch (or takes the room back) - unless the user placed the view himself
      if (PL.refitChrome) requestAnimationFrame(() => PL.refitChrome());
    }
    if (pillEl) paintPill();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // measuring mode (phones): the floor pill in the top bar - which floor the new points go to, tap to change it
  // ---------------------------------------------------------------------------------------------------------------
  let pillEl = null;
  FL.pill = () => {
    // (a real label from the start: an empty one would make it an icon-only button)
    pillEl = ui().button({ icon: 'stairs', label: PL.floorName(PL.floorId()) || '—', size: 'sm', variant: 'soft', onClick: () => pillMenu() });
    pillEl.classList.add('pl-mm__floor');
    pillEl.setAttribute('aria-haspopup', 'menu');
    pillEl.append(ui().icon('chevron-down', 16));
    paintPill();
    return pillEl;
  };
  function paintPill() {
    if (!pillEl) return;
    const multi = PL.multi();
    pillEl.hidden = !multi;
    if (!multi) return;
    const name = PL.floorName(PL.floorId());
    const lbl = pillEl.querySelector('.btn__label');
    if (lbl && lbl.textContent !== name) lbl.textContent = name;
    pillEl.setAttribute('aria-label', t('planner.fl.pillAria', { name }));
  }
  FL.paintPill = paintPill;
  function pillMenu() {
    const list = PL.floorList().slice().reverse();
    const act = PL.floorId();
    ui().menu(pillEl, list.map((f) => ({ label: f.name, checked: f.id === act, radio: true, onClick: () => { if (FL.go(f.id)) ui().toast({ text: t('planner.fl.mmSwitched', { name: f.name }) }, { kind: 'info', ms: 2200 }); } })), { align: 'start' });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // keys: Ctrl+↑ / Ctrl+↓, Alt+1 … Alt+9 (the cheat sheet lists Alt+1 for the row; Alt+2 … 9 are hidden twins)
  // ---------------------------------------------------------------------------------------------------------------
  let keysDone = false;
  function registerKeys() {
    if (keysDone || !(WH.ui && WH.ui.keys)) return;
    keysDone = true;
    const K = (k, i18n, run, extra) => ui().keys.register(Object.assign({ mode: 'planner', key: k, i18n, run }, extra || {}));
    const can = () => PL.multi() && !(PL.S && PL.S.pending);
    K('ctrl+arrowup', 'planner.keys.floorUp', () => { FL.step(+1); }, { order: 11, when: can });
    K('ctrl+arrowdown', 'planner.keys.floorDown', () => { FL.step(-1); }, { order: 12, when: can });
    for (let n = 1; n <= 9; n++) K(`alt+${n}`, 'planner.keys.floorNum', () => { FL.goNth(n); }, { order: 13, when: can, hidden: n > 1 });
    // keyboard layouts whose number row types letters (Czech: + ě š č ř ž ý á í): the physical digit key counts
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const m = /^Digit([1-9])$/.exec(e.code || '');
      if (!m || /^[1-9]$/.test(e.key) || !WH.views || WH.views.current !== 'planner') return;
      if (WH.util.isTyping(e) || (ui().modalCount && ui().modalCount() > 0) || !can()) return;
      e.preventDefault();
      FL.goNth(Number(m[1]));
    });
  }
  FL.registerKeys = registerKeys;
  registerKeys();
})();
