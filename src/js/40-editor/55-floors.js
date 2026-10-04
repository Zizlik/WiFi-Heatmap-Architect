/* Floor-plan editor - floors (SPEC 14.3).
 *   - floor tabs above the stage (shown from two floors on): switch, add (empty above / below, or a copy of this
 *     floor's plan), rename, move up / down, delete (with confirmation); Ctrl+Up / Ctrl+Down switch floors;
 *   - "Obrys patra pod ním": the floor below drawn at 20 % under the plan, for aligning walls (pref editor.ghost);
 *   - the "Patra" section of the inspector's plan card: add / duplicate a floor, the ceiling above this floor and the
 *     storey height (they set how much signal gets through to the next floor);
 *   - per-floor plan check: every tab carries the number of problems found on its floor.
 * The data model is the engine's (ENGINE-API S): the top-level plan is the active floor, the helpers move content
 * between the top level and project.floors. Switching floors is a view change (not undoable, like the planner);
 * adding / renaming / moving / deleting a floor is one undo step. The scale is shared by all floors. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const P = () => WH.engine.project;
  const TOPICS = ['plan', 'nodes', 'measurements', 'goal', 'floors', 'net', 'view'];
  const CEIL_KEYS = ['concrete', 'reinforced_concrete', 'wood'];

  let bar = null;            // {root, tabs, add, more, ghost}
  const issueCache = new WeakMap(); // plan of an inactive floor -> number of plan-check problems

  /** Floors lowest first (each with its content), [] for a project without floors. */
  function list() { return ED.hasFloors(ED.proj()) ? ED.plans() : []; }
  const count = () => list().length;
  const lang = () => WH.i18n.lang;

  // ---------------------------------------------------------------------------------------------------------------
  // operations
  // ---------------------------------------------------------------------------------------------------------------
  /** Make `id` the active floor (a view change: not undoable, the planner shows the same floor afterwards). */
  function switchTo(id) {
    const p = ED.proj();
    if (!p || !id || id === ED.activeFloorId() || !list().some((f) => f.id === id)) return false;
    ED.tools.endInteraction();
    if (WH.store.gestureOpen) WH.store.end();
    ED.select(null);
    ED.S.focus = null;
    WH.store.update((pr) => { P().switchFloor(pr, id); }, TOPICS, { quiet: true });
    const f = list().find((x) => x.id === id);
    if (f) WH.ui.announce(t('editor.floor.switched', { name: f.name }));
    return true;
  }

  /** Floor above (dir +1) / below (-1) the active one. */
  function step(dir) {
    const L = list();
    const i = L.findIndex((f) => f.active);
    const n = L[i + dir];
    if (i < 0 || !n) { ED.flash(dir > 0 ? 'editor.floor.noUp' : 'editor.floor.noDown', null, 'info'); return false; }
    return switchTo(n.id);
  }

  function limitToast() { WH.ui.toast(t('editor.floor.limit', { n: P().MAX_FLOORS || 9 }), { kind: 'warn' }); }
  const undoAction = () => ({ i18n: 'ui.undo', fn: () => { if (WH.store.canUndo()) WH.store.undo(); } });

  /** New floor: {above=true} empty, or {copyFrom: id} a copy of that floor's plan; the new floor becomes active. */
  function add(o) {
    o = o || {};
    const p = ED.proj();
    if (!p || !ED.hasFloors(p)) return null;
    if (count() >= (P().MAX_FLOORS || 9)) { limitToast(); return null; }
    ED.tools.endInteraction();
    if (WH.store.gestureOpen) WH.store.end();
    let id = null;
    WH.store.commit(o.copyFrom ? 'editor.undo.floorCopy' : 'editor.undo.floorAdd', (pr) => {
      id = o.copyFrom ? P().duplicateFloor(pr, o.copyFrom, { lang: lang() }) : P().addFloor(pr, { above: o.above !== false, lang: lang() });
      if (!id) return false;
      P().switchFloor(pr, id);
      return undefined;
    }, TOPICS);
    if (!id) { limitToast(); return null; }
    ED.select(null);
    const f = list().find((x) => x.id === id);
    WH.ui.toast({ text: t(o.copyFrom ? 'editor.floor.copied' : 'editor.floor.added', { name: f ? f.name : '' }), action: undoAction() }, { kind: 'ok' });
    return id;
  }

  function rename(id) {
    const f = list().find((x) => x.id === id);
    if (!f) return;
    const input = el('input.input', { type: 'text', maxlength: '50', autocomplete: 'off', spellcheck: 'false' });
    input.value = f.name;
    const fld = WH.ui.field({ label: 'editor.floor.name', control: input });
    let dlg = null;
    const save = () => {
      const v = ED.cut50(input.value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
      if (!v) { fld.setError(t('editor.floor.nameEmpty')); input.focus(); return false; }
      if (v !== f.name) WH.store.commit('editor.undo.floorRename', (pr) => { P().renameFloor(pr, id, v); }, TOPICS);
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (save() && dlg) dlg.close(); } });
    dlg = WH.ui.dialog({
      title: t('editor.floor.renameT'), small: true, content: fld, initialFocus: input,
      actions: [{ i18n: 'ui.cancel', variant: 'secondary', result: false }, { i18n: 'editor.floor.save', variant: 'primary', result: true, onClick: () => save() }],
    });
    requestAnimationFrame(() => { try { input.select(); } catch (e) { /* ignore */ } });
  }

  function move(id, dir) {
    // (the helpers' own answers count, not the commit's: a store that does not track 'floors' reports no change)
    let ok = false;
    WH.store.commit('editor.undo.floorMove', (pr) => { ok = P().moveFloor(pr, id, dir) !== false; return ok ? undefined : false; }, TOPICS);
    if (!ok) ED.flash(dir > 0 ? 'editor.floor.topmost' : 'editor.floor.lowest', null, 'info');
    return ok;
  }

  async function remove(id) {
    const L = list();
    const f = L.find((x) => x.id === id);
    if (!f) return false;
    if (L.length < 2) { ED.flash('editor.floor.lastOne', null, 'info'); return false; }
    const pr0 = ED.proj();
    const hasRouter = pr0.net && pr0.net.routerFloor === id;
    const n = f.plan.rooms.length;
    const body = t('editor.floor.delB', { name: f.name, n }) + (hasRouter ? ` ${t('editor.floor.delRouter')}` : '');
    const ok = await WH.ui.confirm({ title: t('editor.floor.delT', { name: f.name }), body, ok: t('editor.floor.delOk'), danger: true });
    if (!ok) return false;
    ED.tools.endInteraction();
    if (WH.store.gestureOpen) WH.store.end();
    ED.select(null);
    let done = false;
    WH.store.commit('editor.undo.floorDelete', (pr) => { done = P().removeFloor(pr, id) !== false; return done ? undefined : false; }, TOPICS);
    if (done) WH.ui.toast({ text: t('editor.floor.deleted', { name: f.name }), action: undoAction() }, { kind: 'info', ms: 9000 });
    return done;
  }

  function setCeiling(id, c) {
    return WH.store.commit('editor.undo.ceiling', (pr) => { P().setCeiling(pr, id, c); }, TOPICS);
  }

  /** The floor right below the active one (for the ghost outline), or null. */
  function below() {
    const L = list();
    const i = L.findIndex((f) => f.active);
    return i > 0 ? L[i - 1] : null;
  }
  /** Plan drawn faintly under the active floor, or null. */
  function ghostPlan() {
    if (!ED.pref('ghost')) return null;
    const b = below();
    return b && (b.plan.rooms.length || b.plan.walls.length) ? b.plan : null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // per-floor plan check
  // ---------------------------------------------------------------------------------------------------------------
  /** Number of plan-check problems of a floor (the active one: what the check card shows, minus ignored ones). */
  function problems(f) {
    const S = ED.S;
    if (f.active) return S.issues.filter((i) => i.type !== 'scale' && !S.ignored.has(i.key)).length;
    let n = issueCache.get(f.plan);
    if (n === undefined) {
      try { n = ED.check.run(f.plan, ED.mpp()).length; } catch (e) { n = 0; }
      issueCache.set(f.plan, n);
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // tab bar (above the stage)
  // ---------------------------------------------------------------------------------------------------------------
  function buildBar() {
    // data-toast-avoid: on phones a toast ("Přidal jsem patro") must not land on the tabs right under the header
    const root = el('div.ed-floors', { hidden: true, role: 'group', 'aria-label': t('editor.floor.bar'), 'data-toast-avoid': '' });
    const label = el('span.ed-floors__label', WH.ui.icon('stairs', 16), el('span', t('editor.floor.label')), WH.ui.hint('floors'));
    const tabs = el('div.ed-floors__tabs', { role: 'tablist', 'aria-label': t('editor.floor.bar'), 'data-no-wheel': '' });
    tabs.addEventListener('keydown', tabKeys);
    const addBtn = WH.ui.button({ i18n: 'editor.floor.add', icon: 'plus', size: 'sm', variant: 'ghost', onClick: (e) => addMenu(e.currentTarget) });
    addBtn.setAttribute('aria-haspopup', 'menu');
    const more = WH.ui.iconButton({ icon: 'more', tip: 'editor.floor.more', size: 'sm', onClick: (e) => floorMenu(e.currentTarget, ED.activeFloorId()) });
    more.setAttribute('aria-haspopup', 'menu');
    const ghost = WH.ui.switch({ i18n: 'editor.floor.ghost', checked: ED.pref('ghost'), onChange: (v) => ED.setPref('ghost', v) });
    ghost.classList.add('ed-floors__ghost');
    root.append(label, tabs, el('div.ed-floors__acts', addBtn, more), ghost);
    bar = { root, tabs, addBtn, more, ghost, sig: '' };
    return root;
  }

  function tabKeys(e) {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 0, End: 0 };
    if (!(e.key in keys) || !bar) return;
    const all = Array.from(bar.tabs.querySelectorAll('[role="tab"]'));
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + keys[e.key] + all.length) % all.length;
    all[n].focus();
    switchTo(all[n].dataset.floor);
  }

  /** Re-render the tabs when the floors, their names, the active one or their problem counts changed. */
  function syncBar() {
    if (!bar) return;
    const L = list();
    const show = L.length > 1;
    const was = !bar.root.hidden;
    bar.root.hidden = !show;
    if (was !== show && ED.S.vp) requestAnimationFrame(() => { ED.S.vp.resize(); ED.req('view'); });
    if (!show) return;
    const counts = L.map(problems);
    const sig = `${WH.i18n.lang}|${L.map((f, i) => `${f.id}:${f.name}:${f.active ? 1 : 0}:${counts[i]}`).join('|')}`;
    const b = below();
    bar.ghost.hidden = !(b && (b.plan.rooms.length || b.plan.walls.length));
    bar.ghost.setChecked(ED.pref('ghost'));
    if (b) bar.ghost.title = t('editor.floor.ghostTip', { name: b.name });
    if (sig === bar.sig) return;
    bar.sig = sig;
    const hadFocus = bar.tabs.contains(document.activeElement);
    bar.tabs.replaceChildren();
    // highest floor first would read like a building section; tabs read left to right like the levels' numbers
    L.forEach((f, i) => {
      const tab = el('button.ed-ftab', { type: 'button', role: 'tab', 'aria-selected': f.active ? 'true' : 'false', tabindex: f.active ? '0' : '-1', 'data-floor': f.id },
        el('span.ed-ftab__name', f.name));
      if (counts[i]) {
        const bd = WH.ui.badge(String(counts[i]), 'warn');
        bd.classList.add('ed-ftab__n');
        bd.setAttribute('aria-label', t('editor.floor.problems', { n: counts[i] }));
        tab.append(bd);
      }
      tab.addEventListener('click', () => switchTo(f.id));
      tab.addEventListener('dblclick', () => rename(f.id));
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); floorMenu(tab, f.id); });
      bar.tabs.append(tab);
    });
    if (hadFocus) { const a = bar.tabs.querySelector('[aria-selected="true"]'); if (a) a.focus(); }
    const act = bar.tabs.querySelector('[aria-selected="true"]');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function addMenu(anchor) {
    const act = ED.activeFloorId();
    WH.ui.menu(anchor, [
      { i18n: 'editor.floor.addUp', icon: 'arrow-up', onClick: () => add({ above: true }) },
      { i18n: 'editor.floor.addDown', icon: 'arrow-down', onClick: () => add({ above: false }) },
      { sep: true },
      { i18n: 'editor.floor.copy', icon: 'copy', onClick: () => add({ copyFrom: act }) },
    ]);
  }

  function floorMenu(anchor, id) {
    const L = list();
    const i = L.findIndex((f) => f.id === id);
    if (i < 0) return;
    WH.ui.menu(anchor, [
      { i18n: 'editor.floor.rename', icon: 'edit', onClick: () => rename(id) },
      { i18n: 'editor.floor.up', icon: 'arrow-up', disabled: i === L.length - 1, onClick: () => move(id, 1) },
      { i18n: 'editor.floor.down', icon: 'arrow-down', disabled: i === 0, onClick: () => move(id, -1) },
      { i18n: 'editor.floor.copy', icon: 'copy', onClick: () => add({ copyFrom: id }) },
      { sep: true },
      { i18n: 'editor.floor.delete', icon: 'trash', danger: true, disabled: L.length < 2, onClick: () => remove(id) },
    ]);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // "Patra" section of the inspector's plan card
  // ---------------------------------------------------------------------------------------------------------------
  function ceilingOptions() {
    const M = P().CEILING_MATERIALS || {};
    return CEIL_KEYS.filter((k) => M[k] !== undefined).map((k) => ({ value: k, label: `${t(`editor.ceil.${k}`)} · ${WH.util.fmt(M[k], 0)}${WH.util.NBSP}dB` }))
      .concat([{ value: 'custom', label: t('editor.ceil.custom') }]);
  }

  function section() {
    const head = el('div.ed-sec__title', el('span', t('editor.sec.floors')), WH.ui.hint('floors'));
    const intro = el('p.ed-note');
    const addBtn = WH.ui.button({ i18n: 'editor.floor.addShort', icon: 'plus', size: 'sm', variant: 'soft', onClick: () => add({ above: true }) });
    const copyBtn = WH.ui.button({ i18n: 'editor.floor.copy', icon: 'copy', size: 'sm', variant: 'ghost', onClick: () => add({ copyFrom: ED.activeFloorId() }) });
    const btns = el('div.cluster', addBtn, copyBtn);

    // ceiling of the active floor (only with two floors and more)
    const mat = WH.ui.select(ceilingOptions(), {
      ariaLabel: t('editor.ceil.material'),
      onChange: (v) => {
        const id = ED.activeFloorId();
        const f = id && list().find((x) => x.id === id);
        if (!f) return;
        if (v === 'custom') setCeiling(id, { material: 'custom', lossDb: f.ceiling ? f.ceiling.lossDb : 15 });
        else setCeiling(id, { material: v });
      },
    });
    const fMat = WH.ui.field({ label: 'editor.ceil.material', hint: 'ceiling', control: mat });
    const loss = WH.ui.numberInput({
      min: 0, max: 40, step: 1, ariaLabel: t('editor.ceil.loss'),
      onChange: (v) => {
        const id = ED.activeFloorId();
        if (!id) return;
        if (v === null || !(v >= 0 && v <= 40)) { sync(); return; }
        setCeiling(id, { material: 'custom', lossDb: Math.round(v * 10) / 10 });
      },
    });
    loss.classList.add('input--sm');
    const fLoss = WH.ui.field({ label: 'editor.ceil.loss', unit: 'dB', control: loss, inline: true });
    const height = WH.ui.numberInput({
      min: 2, max: 6, step: 0.1, ariaLabel: t('editor.ceil.height'),
      onChange: (v) => {
        const id = ED.activeFloorId();
        if (!id) return;
        if (v === null || !(v >= 2 && v <= 6)) { sync(); return; }
        setCeiling(id, { heightM: Math.round(v * 100) / 100 });
      },
    });
    height.classList.add('input--sm');
    const fHeight = WH.ui.field({ label: 'editor.ceil.height', unit: 'm', control: height, inline: true });
    const ceilBox = el('div.stack.ed-ceil', { style: { '--gap': '8px' } }, fMat, fLoss, fHeight);
    const top = el('p.ed-note.ed-ceil__top');
    ceilBox.append(top);
    const del = WH.ui.button({ i18n: 'editor.floor.deleteShort', icon: 'trash', size: 'sm', variant: 'danger-soft', onClick: () => remove(ED.activeFloorId()) });
    const ren = WH.ui.button({ i18n: 'editor.floor.rename', icon: 'edit', size: 'sm', variant: 'ghost', onClick: () => rename(ED.activeFloorId()) });
    const multiBtns = el('div.cluster', ren, del);
    const root = el('div.ed-sec.ed-floor-sec', head, intro, ceilBox, btns, multiBtns);

    function sync() {
      const L = list();
      root.hidden = !L.length;
      if (!L.length) return;
      const multi = L.length > 1;
      const f = L.find((x) => x.active) || L[0];
      head.firstChild.textContent = multi ? t('editor.sec.floor', { name: f.name }) : t('editor.sec.floors');
      intro.textContent = t(multi ? 'editor.floor.introMulti' : 'editor.floor.intro');
      ceilBox.hidden = !multi;
      multiBtns.hidden = !multi;
      addBtn.disabled = L.length >= (P().MAX_FLOORS || 9);
      copyBtn.disabled = addBtn.disabled;
      if (!multi || !f.ceiling) return;
      const c = f.ceiling;
      const M = P().CEILING_MATERIALS || {};
      const key = c.material !== 'custom' && M[c.material] !== undefined && M[c.material] === c.lossDb ? c.material : 'custom';
      if (document.activeElement !== mat) mat.value = key;
      if (document.activeElement !== loss) loss.setValue(c.lossDb);
      if (document.activeElement !== height) height.setValue(c.heightM);
      const isTop = L[L.length - 1].id === f.id;
      top.textContent = isTop ? t('editor.ceil.topNote') : t('editor.ceil.note', { name: L[L.findIndex((x) => x.id === f.id) + 1].name });
    }
    return { el: root, sync };
  }

  // ---------------------------------------------------------------------------------------------------------------
  ED.floors = { list, count, switchTo, step, add, rename, move, remove, setCeiling, below, ghostPlan, problems, buildBar, syncBar, section };
})();
