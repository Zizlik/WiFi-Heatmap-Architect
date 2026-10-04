/* Floor-plan editor - the view: layout (tool rail | stage | inspector), contextual hint line, "Hotovo -> Wi-Fi" button,
 * per-tool option bar, empty state, keyboard shortcuts, store / bus wiring, WH.views registration and tour steps. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);

  const RAIL = [
    { tool: 'select', icon: 'cursor', key: 'v' },
    { tool: 'rect', icon: 'rect', key: 'r' },
    { tool: 'poly', icon: 'polygon', key: 'p' },
    { tool: 'wall', icon: 'wall', key: 'w' },
    { tool: 'door', icon: 'door', key: 'd' },
    { tool: 'furniture', icon: 'sofa', key: 'f' },
    { tool: 'scale', icon: 'ruler', key: 's' },
    { sep: true },
    { act: 'undo', icon: 'undo', key: 'ctrl+z', tip: 'editor.btn.undo' },
    { act: 'redo', icon: 'redo', key: 'ctrl+shift+z', tip: 'editor.btn.redo' },
    { spacer: true },
    { act: 'zoomIn', icon: 'zoom-in', key: '+', tip: 'editor.btn.zoomIn' },
    { act: 'zoomOut', icon: 'zoom-out', key: '-', tip: 'editor.btn.zoomOut' },
    { act: 'fit', icon: 'fit', key: '0', tip: 'editor.btn.fit' },
  ];
  const TOOL_ICON = { select: 'cursor', rect: 'rect', poly: 'polygon', wall: 'wall', door: 'door', furniture: 'sofa', scale: 'ruler' };

  const S = ED.S;
  const dom = {};
  let mounted = false;
  let needFit = true;
  let pendingTool = null;
  let checkTimer = 0;
  let lastFloor = null;

  // ---------------------------------------------------------------------------------------------------------------
  // layout
  // ---------------------------------------------------------------------------------------------------------------
  function railButton(b) {
    const tip = b.tip || `editor.tool.${b.tool}`;
    // zoom lives in a floating stage toolbar on narrow screens (the horizontal rail has no room for it there)
    const btn = el(`button.tool-rail__btn${b.act && b.act !== 'undo' && b.act !== 'redo' ? '.hide-mobile' : ''}`, { type: 'button', 'data-tip': tip, 'data-kbd': b.key, 'data-tip-pos': 'right', tabindex: '-1' },
      WH.ui.icon(b.icon, 24), b.tool ? el('span.tool-rail__kbd.hide-touch', { 'aria-hidden': 'true' }, b.key.toUpperCase()) : null);
    btn._def = b;
    if (b.tool) { btn.setAttribute('aria-pressed', 'false'); btn.addEventListener('click', (e) => ED.tools.setTool(b.tool, { kbd: e.detail === 0 })); }
    else btn.addEventListener('click', () => railAction(b.act));
    return btn;
  }

  function railAction(act) {
    const vp = S.vp;
    if (act === 'undo' || act === 'redo') ED.history(act === 'undo');
    else if (act === 'zoomIn') vp.zoomBy(1.25, undefined, undefined, { animate: true });
    else if (act === 'zoomOut') vp.zoomBy(0.8, undefined, undefined, { animate: true });
    else if (act === 'fit') vp.fit(fitBox(), { animate: true });
  }

  /** The plan box grown so that a fit puts the plan below the hint line and above the option bar - reserved even while
   *  the active tool has none, so switching tools never makes the plan "breathe" - and the phone zoom row (the viewport
   *  fits symmetrically with its default padding; the growth is solved for the resulting scale). */
  function fitBox() {
    const box = ED.planBox();
    const sz = S.vp && S.vp.size;
    if (!mounted || !sz || !(sz.w > 0 && sz.h > 0)) return box;
    const st = dom.stage.getBoundingClientRect();
    const pad = Math.min(40, Math.min(sz.w, sz.h) * 0.05); // = the viewport's default fit padding
    const top = Math.max(0, dom.topSlot.getBoundingClientRect().bottom - st.top + 6 - pad);
    const zr = dom.zoom.getBoundingClientRect();
    const optH = dom.opts.hidden ? 44 : dom.opts.getBoundingClientRect().height;
    let low = st.bottom - (parseFloat(getComputedStyle(dom.opts).bottom) || 0) - optH;
    if (zr.height) low = Math.min(low, zr.top);
    const bot = Math.max(0, st.bottom - low + 6 - pad);
    const bw = (box.maxX - box.minX) * ED.W;
    const bh = (box.maxY - box.minY) * ED.H;
    const s = Math.min((sz.w - 2 * pad) / bw, (sz.h - 2 * pad - top - bot) / bh);
    if (!(s > 0)) return box;
    return { minX: box.minX, maxX: box.maxX, minY: box.minY - top / s / ED.H, maxY: box.maxY + bot / s / ED.H };
  }

  function labelRail() {
    for (const b of dom.rail.querySelectorAll('.tool-rail__btn')) {
      const d = b._def;
      b.setAttribute('aria-label', `${t(d.tip || `editor.tool.${d.tool}`)} (${WH.ui.kbdText(d.key)})`);
    }
  }

  function paintRail() {
    let active = null;
    for (const b of dom.rail.querySelectorAll('.tool-rail__btn')) {
      const d = b._def;
      if (d.tool) { const on = d.tool === S.tool; b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (on) active = b; }
    }
    // roving tab stop: the active tool, unless focus is already elsewhere in the rail
    if (!dom.rail.contains(document.activeElement)) for (const b of dom.rail.querySelectorAll('.tool-rail__btn')) b.tabIndex = b === active ? 0 : -1;
    paintHistory();
  }

  function paintHistory() {
    if (!dom.rail) return;
    for (const b of dom.rail.querySelectorAll('.tool-rail__btn')) {
      const d = b._def;
      if (d.act === 'undo') b.disabled = !WH.store.canUndo();
      if (d.act === 'redo') b.disabled = !WH.store.canRedo();
    }
  }

  function railKeys(e) {
    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 0, End: 0 };
    if (!(e.key in keys)) return;
    const list = Array.from(dom.rail.querySelectorAll('.tool-rail__btn:not([disabled])'));
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + keys[e.key] + list.length) % list.length;
    for (const b of list) b.tabIndex = -1;
    list[n].tabIndex = 0;
    list[n].focus();
  }

  function build(root) {
    root.classList.add('ed');
    const rail = el('div.tool-rail.ed-rail', { role: 'toolbar', 'aria-orientation': 'vertical', 'data-i18n-aria': 'editor.aria.rail' });
    for (const b of RAIL) {
      if (b.sep) rail.append(el('span.tool-rail__sep', { 'aria-hidden': 'true' }));
      else if (b.spacer) rail.append(el('span.tool-rail__spacer', { 'aria-hidden': 'true' }));
      else rail.append(railButton(b));
    }
    rail.addEventListener('keydown', railKeys);
    rail.addEventListener('focusout', () => setTimeout(paintRail, 0));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'stage__canvas ed-svg');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-describedby', 'ed-hint-text');

    const hintIcon = el('span.ed-hint__icon');
    const hintText = el('span.ed-hint__text', { id: 'ed-hint-text' });
    const hintLive = el('span.ed-hint__live', { role: 'status', 'aria-live': 'polite' }, hintIcon, hintText);
    // an optional action of the hint ("Zadat plochu", "Označit vzdálenost") sits outside the live region
    const hintAct = el('span.ed-hint__act', { hidden: true });
    const hint = el('div.stage__hint.ed-hint', hintLive, hintAct);
    const done = el('button.btn.btn--primary.ed-done', { type: 'button', 'data-tip': 'editor.done.tip', 'data-kbd': '2' },
      el('span', { 'data-i18n': 'editor.done' }, t('editor.done')), WH.ui.icon('arrow-right', 18), el('span.ed-done__to', 'Wi-Fi'), el('span.btn__kbd.hide-touch', WH.ui.kbd('2')));
    // leaving with an unverified scale offers the "Víš, kolik má byt m²?" prompt once (non-blocking, SPEC 14.1)
    const leave = () => WH.views.go('planner');
    done.addEventListener('click', () => { if (!ED.scaling.askOnLeave(done, leave)) leave(); });
    const topSlot = el('div.stage__slot.stage__tc.ed-topbar', hint, done);
    const opts = el('div.stage__slot.stage__bc.ed-opts', { hidden: true });
    const zoom = el('div.stage__slot.stage__br.ed-zoombar.show-mobile', el('div.toolbar', { role: 'group', 'data-i18n-aria': 'editor.aria.zoom' },
      RAIL.filter((b) => b.act && b.act !== 'undo' && b.act !== 'redo').map((b) => WH.ui.iconButton({ icon: b.icon, tip: b.tip, kbd: b.key, variant: 'ghost', onClick: () => railAction(b.act) }))));
    const empty = el('div.ed-empty', { hidden: true },
      el('div.ed-empty__card',
        el('span.icon-badge', WH.ui.icon('rect', 24)),
        el('div.ed-empty__title'),
        el('p.ed-empty__text'),
        el('div.cluster.ed-empty__btns',
          WH.ui.button({ i18n: 'editor.bg.upload', icon: 'upload', variant: 'primary', size: 'sm', onClick: () => WH.io.openPicker({ asBackground: true }) }),
          WH.ui.button({ i18n: 'editor.demo', icon: 'home', size: 'sm', onClick: () => ED.newProject('demo') }))));
    const stage = el('div.stage.ed-stage', svg, topSlot, opts, zoom, empty);
    // floor tabs above the stage (SPEC 14.3; shown from two floors on)
    const floors = ED.floors.buildBar();
    const main = el('div.ed-main', floors, stage);
    const aside = el('aside.sidebar.sidebar--inspector.ed-inspector', { 'data-i18n-aria': 'editor.aria.inspector' });
    root.append(el('div.layout.layout--rail.ed-layout', rail, main, aside));
    Object.assign(dom, { root, rail, svg, stage, topSlot, hint, hintIcon, hintText, hintAct, done, opts, zoom, empty, aside, floors, main });
    labelRail();
    svg.setAttribute('aria-label', t('editor.aria.stage'));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // hint line
  // ---------------------------------------------------------------------------------------------------------------
  function hintFor() {
    if (S.flash) return { text: t(S.flash.key, S.flash.params), kind: S.flash.kind, icon: S.flash.kind === 'warn' ? 'warning' : S.flash.kind === 'ok' ? 'check-circle' : 'info' };
    // the scale comes first while it is not verified (SPEC 14.1): new plan / traced image / "Víš, kolik má byt m²?"
    const sh = ED.scaling.hint();
    if (sh) return sh;
    const d = S.draft;
    const pl = ED.plan();
    const icon = TOOL_ICON[S.tool];
    const kbd = S.kbdTool ? ` ${t('editor.hint.kbd')}` : '';
    switch (S.tool) {
      case 'rect': return { icon, text: t(d && d.a ? 'editor.hint.rect2' : 'editor.hint.rect1') + (d && d.a ? '' : kbd) };
      case 'furniture': {
        const pr = ED.PRESETS.find((x) => x.key === ED.pref('preset')) || ED.PRESETS[0];
        const T = ED.table('furn');
        const db = ED.fmtBands(T[pr.kind] && pr.loss === undefined ? T[pr.kind] : ED.triple(ED.presetLoss(pr)));
        return { icon, text: d && d.a ? t('editor.hint.rect2') : t('editor.hint.furn1', { name: t(`editor.preset.${pr.key}`), db }) + kbd };
      }
      case 'poly': return { icon, text: !d || !d.pts.length ? t('editor.hint.poly1') + kbd : d.pts.length < 3 ? t('editor.hint.poly2') : t('editor.hint.poly3') };
      case 'wall': return { icon, text: d && d.a ? t('editor.hint.wall2') : t('editor.hint.wall1') + kbd };
      case 'door': return pl && pl.walls.length ? { icon, text: t('editor.hint.door', { w: ED.fmtM(ED.pref('doorW') / ED.mpp()) }) } : { icon: 'info', kind: 'warn', text: t('editor.hint.doorNoWalls') };
      case 'scale': return { icon, text: t(d && d.asking ? 'editor.hint.scale3' : d && d.a ? 'editor.hint.scale2' : 'editor.hint.scale1') };
      default: {
        const o = S.sel && ED.find(S.sel);
        if (o) return { icon: 'cursor', text: t(o.points ? 'editor.hint.selPoly' : o.type === 'door' ? 'editor.hint.selDoor' : 'editor.hint.selWall') };
        const empty = !pl || (!pl.rooms.length && !pl.walls.length && !pl.furniture.length);
        return { icon: 'cursor', text: t(empty ? 'editor.hint.empty' : 'editor.hint.select') };
      }
    }
  }

  let lastHint = '';
  function paintHint() {
    if (!mounted) return;
    const h = hintFor();
    const acts = h.actions || [];
    const key = `${h.icon}|${h.kind || ''}|${h.text}|${acts.map((a) => a.i18n).join(',')}`;
    if (key === lastHint) return;
    lastHint = key;
    dom.hint.dataset.kind = h.kind || '';
    dom.hintIcon.replaceChildren(WH.ui.icon(h.icon || 'info', 18));
    dom.hintText.textContent = h.text;
    const hadFocus = dom.hintAct.contains(document.activeElement);
    dom.hintAct.replaceChildren();
    dom.hintAct.hidden = !acts.length;
    for (const a of acts) dom.hintAct.append(WH.ui.button({ i18n: a.i18n, icon: a.icon, size: 'sm', variant: a.primary ? 'primary' : 'soft', onClick: () => a.fn() }));
    if (hadFocus && dom.hintAct.firstChild) dom.hintAct.firstChild.focus();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // tool options bar (bottom of the stage)
  // ---------------------------------------------------------------------------------------------------------------
  function buildOpts() {
    const box = dom.opts;
    box.replaceChildren();
    const bar = el('div.toolbar.toolbar--wrap.ed-optbar', { role: 'group', 'aria-label': t(`editor.tool.${S.tool}`) });
    const label = (k) => el('span.toolbar__label', t(k));
    switch (S.tool) {
      case 'rect':
      case 'poly': {
        const sw = WH.ui.switch({ i18n: 'editor.opt.autoWalls', hint: 'autoWalls', checked: ED.pref('autoWalls'), onChange: (v) => ED.setPref('autoWalls', v) });
        bar.append(el('div.ed-optbar__item', sw));
        break;
      }
      case 'wall': {
        const sel = WH.ui.select(ED.matOptions(false), { value: ED.pref('wallMat'), onChange: (v) => ED.setPref('wallMat', v), ariaLabel: t('editor.opt.material') });
        sel.classList.add('select--sm');
        bar.append(label('editor.opt.material'), sel, WH.ui.hint('wallMaterial'));
        break;
      }
      case 'door': {
        const seg = WH.ui.segmented([{ value: 'open', i18n: 'editor.door.openShort' }, { value: 'closed', i18n: 'editor.door.closedShort' }], {
          value: ED.pref('door'), size: 'sm', aria: 'editor.f.doorType', onChange: (v) => ED.setPref('door', v),
        });
        const w = WH.ui.numberInput({ value: ED.pref('doorW'), min: 0.3, max: 3, step: 0.05, ariaLabel: t('editor.opt.width'), onChange: (v) => { if (v !== null && v >= 0.3 && v <= 3) { ED.setPref('doorW', v); paintHint(); } else w.setValue(ED.pref('doorW')); } });
        w.classList.add('input--sm', 'ed-optbar__num');
        bar.append(seg, WH.ui.hint('doorLoss'), el('span.toolbar__sep'), label('editor.opt.width'), w, el('span.toolbar__label.ed-unit', 'm'));
        break;
      }
      case 'furniture': {
        const seg = WH.ui.segmented(ED.PRESETS.map((p) => ({ value: p.key, icon: p.icon, i18n: `editor.preset.${p.key}` })), {
          value: ED.pref('preset'), size: 'sm', aria: 'editor.opt.preset', onChange: (v) => { ED.setPref('preset', v); paintHint(); showActive(bar); },
        });
        requestAnimationFrame(() => showActive(bar));
        seg.classList.add('ed-presets');
        bar.append(seg, WH.ui.hint('furnitureLoss'));
        break;
      }
      default:
        box.hidden = true;
        return;
    }
    box.append(bar);
    box.hidden = false;
  }

  /** Phones: the option bar scrolls sideways - keep the active preset fully in view (never a half-cut pill). */
  function showActive(bar) {
    const a = bar.querySelector('[aria-checked="true"]');
    if (!a || bar.scrollWidth <= bar.clientWidth) return;
    const r = a.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    if (r.left < b.left + 4) bar.scrollLeft -= b.left + 4 - r.left;
    else if (r.right > b.right - 4) bar.scrollLeft += r.right - b.right + 4;
  }

  function paintEmpty() {
    const pl = ED.plan();
    const empty = !pl || (!pl.rooms.length && !pl.walls.length && !pl.furniture.length && !pl.background);
    dom.empty.hidden = !empty || ED.tools.draftBusy() || S.tool === 'scale';
    if (dom.empty.hidden) return;
    // an empty floor of a house: draw it (the floor below shows faintly); the demo flat would replace the whole house
    const floor = ED.floors.count() > 1;
    const b = floor ? ED.floors.below() : null;
    dom.empty.querySelector('.ed-empty__title').textContent = t(floor ? 'editor.empty.floorT' : 'editor.empty.t');
    dom.empty.querySelector('.ed-empty__text').textContent = floor ? t(b && ED.pref('ghost') ? 'editor.empty.floorGhost' : 'editor.empty.floorB', { name: b ? b.name : '' }) : t('editor.empty.b');
    dom.empty.querySelectorAll('.ed-empty__btns .btn')[1].hidden = floor;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // plan check scheduling
  // ---------------------------------------------------------------------------------------------------------------
  function scheduleCheck(ms) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      if (WH.store.gestureOpen) { scheduleCheck(300); return; }
      const pl = ED.plan();
      // the drawing problems, then the scale sanity checks (SPEC 14.1; the scale card on top already says it too)
      S.issues = ED.check.run(pl, ED.mpp()).concat(ED.scaling.issues());
      if (S.focus) {
        const same = S.issues.find((i) => i.key === S.focus.key);
        S.focus = same || null;
      }
      ED.inspector.renderIssues();
      ED.floors.syncBar();
      ED.req();
    }, ms === undefined ? 300 : ms);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // keyboard (mode 'editor'; the global keys are the shell's)
  // ---------------------------------------------------------------------------------------------------------------
  const onControl = (e) => !!(e && e.target && e.target.closest && e.target.closest('button, a[href], summary, [role="radio"], [role="menuitem"], .menu, .pop-panel'));

  let keysDone = false;
  function registerKeys() {
    if (keysDone || !(WH.ui && WH.ui.keys)) return;
    keysDone = true;
    const K = (key, i18n, run, o) => WH.ui.keys.register(Object.assign({ mode: 'editor', key, i18n, run }, o));
    let order = 1;
    for (const b of RAIL) if (b.tool) K(b.key, `editor.keys.${b.tool}`, () => { ED.tools.setTool(b.tool, { kbd: true }); }, { order: order++ });
    K('g', 'editor.keys.snap', () => {
      const v = !ED.pref('snap');
      ED.setPref('snap', v);
      ED.flash(v ? 'editor.msg.snapOn' : 'editor.msg.snapOff', null, 'info');
    }, { order: order++ });
    K('t', 'editor.keys.trace', () => {
      const pl = ED.plan();
      if (!pl || !pl.background) { ED.flash('editor.msg.noBg', null, 'info'); return; }
      const v = !ED.pref('bg');
      ED.setPref('bg', v);
      ED.flash(v ? 'editor.msg.bgOn' : 'editor.msg.bgOff', null, 'info');
    }, { order: order++ });
    K('enter', 'editor.keys.enter', () => ED.tools.enter(), { when: (e) => S.tool !== 'select' && !onControl(e), order: order++ });
    K(['delete', 'backspace'], 'editor.keys.delete', (e) => ED.tools.backspaceOrDelete(e), { when: () => !!S.sel || ED.tools.draftBusy(), repeat: true, order: order++ });
    K('ctrl+d', 'editor.keys.duplicate', () => { ED.duplicate(S.sel); }, { when: () => !!S.sel, order: order++ });
    K(['arrowleft', 'arrowright', 'arrowup', 'arrowdown'], 'editor.keys.nudge', (e) => ED.tools.nudge(e), { when: (e) => !!S.sel && !onControl(e), repeat: true, anyShift: true, order: order++ });
    K('escape', 'editor.keys.esc', () => { ED.tools.escape(); }, { when: () => ED.tools.canEscape(), allowTyping: false, order: order++ });
    // floors (SPEC 14.3): the same keys as on the Wi-Fi map
    K('ctrl+arrowup', 'editor.keys.floorUp', () => { ED.floors.step(1); }, { when: () => ED.floors.count() > 1, order: order++ });
    K('ctrl+arrowdown', 'editor.keys.floorDown', () => { ED.floors.step(-1); }, { when: () => ED.floors.count() > 1, order: order++ });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------------------------------------------
  function onStore(ev) {
    const tp = ev.topics || [];
    if (tp.includes('project:replaced')) {
      ED.tools.endInteraction();
      S.sel = null;
      S.hover = null;
      S.focus = null;
      S.ignored.clear();
      // per-project answers to the scale questions (SPEC 14.1)
      S.scaleSnooze = false;
      S.leaveAsked = false;
      S.importEdit = false;
      S.scaleAsk = null;   // set again by the 'project:created' / 'project:imported' that follows a new plan
      needFit = true;
      if (S.visible) { needFit = false; S.vp.fit(fitBox(), { animate: false }); }
      ED.emit('sel', null);
    }
    if (S.sel && !ED.find(S.sel)) ED.select(null);
    if (S.hover && !ED.find(S.hover)) S.hover = null;
    // another active floor (switched here or in the Wi-Fi view) = another plan on the stage
    const fl = ED.activeFloorId();
    const floorChanged = fl !== lastFloor;
    lastFloor = fl;
    if (floorChanged && tp.indexOf('project:replaced') < 0) { S.focus = null; if (S.sel && !ED.find(S.sel)) ED.select(null); }
    const geo = floorChanged || tp.includes('plan') || tp.includes('scale') || tp.includes('model') || tp.includes('goal') || tp.includes('floors') || tp.includes('project:replaced');
    if (geo) { ED.req('world'); ED.inspector.planChanged(); scheduleCheck(); }
    if (tp.includes('net')) ED.req('overlay');
    if (tp.includes('history')) {
      paintHistory();
      if (ev.source !== 'live') { ED.inspector.planChanged(); scheduleCheck(); }
    }
    ED.floors.syncBar();
    paintEmpty();
    paintHint();
  }

  function applyPending() {
    if (!pendingTool) return;
    const kind = pendingTool;
    pendingTool = null;
    ED.tools.setTool('rect');
    // a traced image: the hint line asks for the scale first (ED.scaling.hint); once it is set, the tool's own hint
    if (kind === 'tracing_image' && ED.scaling.verified()) ED.flash('editor.hint.trace', null, 'info');
  }

  function onNewPlan(kind) {
    if (kind !== 'tracing_image' && kind !== 'blank') return;
    pendingTool = kind;
    S.scaleAsk = kind === 'blank' ? 'blank' : 'image';  // the hint line asks for the scale first (SPEC 14.1)
    if (mounted && S.visible) applyPending();
  }

  function mount(root) {
    build(root);
    ED.render.build(dom.svg, dom.stage);
    S.vp = WH.viewport(dom.stage, {
      onChange: () => ED.req('view'),
      canPan: (e) => S.tool === 'select' && !e.defaultPrevented,
      dblClickFit: true,
      fitBox,
    });
    ED.tools.attach(dom.stage, dom.svg);
    ED.inspector.build(dom.aside);
    registerKeys();
    ED.on('tool', () => { paintRail(); buildOpts(); paintHint(); paintEmpty(); });
    ED.on('draft', () => { paintHint(); paintEmpty(); });
    ED.on('hint', paintHint);
    ED.on('sel', () => { ED.inspector.showTop(); ED.inspector.markSelected(); paintHint(); });
    ED.on('prefs', (k) => { if (k !== 'bgOpacity') ED.inspector.planChanged(); if (k === 'preset' || k === 'doorW') paintHint(); });
    ED.on('focus', () => ED.inspector.renderIssues());
    ED.on('scale', () => { paintHint(); scheduleCheck(); });
    WH.store.on(['plan', 'scale', 'net', 'model', 'goal', 'floors', 'nodes', 'view', 'project:replaced', 'history'], onStore);
    WH.bus.on('lang:changed', () => {
      if (!mounted) return;
      labelRail();
      dom.svg.setAttribute('aria-label', t('editor.aria.stage'));
      buildOpts();
      // the floor tabs carry their own texts
      const fb = ED.floors.buildBar();
      dom.floors.replaceWith(fb);
      dom.floors = fb;
      ED.floors.syncBar();
      lastHint = '';
      paintHint();
      paintEmpty();
      ED.inspector.refresh();
      scheduleCheck(0);
      ED.renderAll();
    });
    mounted = true;
    lastFloor = ED.activeFloorId();
    dom.stage.dataset.tool = S.tool;
    paintRail();
    buildOpts();
    paintHint();
    paintEmpty();
  }

  function show() {
    S.visible = true;
    S.vp.resize();
    if (needFit) { needFit = false; S.vp.fit(fitBox(), { animate: false, silent: true }); }
    applyPending();
    lastFloor = ED.activeFloorId();
    ED.floors.syncBar();
    ED.inspector.refresh();
    paintRail();
    paintEmpty();
    paintHint();
    scheduleCheck(60);
    ED.renderAll();
    ED.scaling.consumePending();
  }

  function hide() {
    ED.tools.endInteraction();
    S.visible = false;
    S.hover = null;
    S.cur = null;
  }

  function resize() { if (S.vp) { S.vp.resize(); ED.req('view'); } }

  function tourSteps() {
    return [
      { target: '#view-editor .ed-rail', title: 'editor.tour.tools.t', body: 'editor.tour.tools.b', placement: 'right' },
      { target: '#view-editor .ed-hint', title: 'editor.tour.hint.t', body: 'editor.tour.hint.b', placement: 'bottom' },
      { target: '#view-editor .ed-scale-card', title: 'editor.tour.scale.t', body: 'editor.tour.scale.b', placement: 'left', optional: true },
      { target: '#view-editor .ed-top-card', title: 'editor.tour.inspector.t', body: 'editor.tour.inspector.b', placement: 'left', optional: true },
      { target: '#view-editor .ed-check-card', title: 'editor.tour.check.t', body: 'editor.tour.check.b', placement: 'left', optional: true },
      { target: '#view-editor .ed-done', title: 'editor.tour.done.t', body: 'editor.tour.done.b', placement: 'bottom' },
    ];
  }

  WH.views.register('editor', { mount, show, hide, resize, tourSteps });
  // the cheat sheet lists the floor-plan keys before the editor was ever opened (they only fire while it is shown,
  // and it is mounted by then)
  registerKeys();

  // New blank plan / traced image: start with the Rectangle tool (works before the view is mounted too).
  const wireBus = () => {
    WH.bus.on('project:imported', (p) => onNewPlan(p && p.kind));
    WH.bus.on('project:created', (p) => onNewPlan(p && p.template));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireBus); else wireBus();
})();
