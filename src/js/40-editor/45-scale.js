/* Floor-plan editor - scale (SPEC 14.1): the scale is verified, never silently assumed.
 *   - "Měřítko" card at the top of the inspector: the resulting floor area (biggest / smallest room) so a wrong scale is
 *     obvious, the friendly "Víš, kolik má byt m²?" prompt, and three methods (flat area in m², two points with a known
 *     distance = the S tool, width of the whole plan);
 *   - "Tahle místnost má [x] m²" / "Tahle zeď měří [x] m" forms for the inspector's room / wall card;
 *   - the result toast "Byt teď má 58,0 m² · Ložnice 14,0 m² · …" with Undo;
 *   - the prompt offered when leaving the editor ("Hotovo -> Wi-Fi") while the scale is unverified;
 *   - after loading a file whose scale nobody confirmed: "Měřítko z načteného souboru: byt ≈ 58 m². Sedí?" [Sedí]
 *     [Upravit] in the hint line and at the top of the scale card (one answer verifies it, it never covers the plan);
 *   - the hint-line requests and the plan-check items of WH.engine.project.scaleIssues.
 * Scale changes are uniform: the geometry stays, only metres per canvas px change (one undo step). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const NB = () => WH.util.NBSP;
  const fmtA = (v) => `${WH.util.fmt(v, 1)}${NB()}m²`;
  const fmtLen = (v) => `${WH.util.fmt(v, v < 1 ? 2 : 1)}${NB()}m`;
  const typing = (n) => !!n && document.activeElement === n;
  const AREA = { min: 1, max: 5000 };       // m² of the whole flat / house
  const ROOM_AREA = { min: 0.2, max: 2000 }; // m² of one room
  const LEN = { min: 0.1, max: 200 };        // m of one wall / distance
  const MPP_MIN = 0.0005;
  const MPP_MAX = 0.2;
  const MAX_PREVIEW = 4;

  // ---------------------------------------------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------------------------------------------
  /** project.scale with defaults: {mpp, verified, method, ref}. */
  function state() {
    const p = ED.proj();
    const s = (p && p.scale) || {};
    return { mpp: s.mpp > 0 ? s.mpp : 0.012, verified: s.verified === true, method: typeof s.method === 'string' ? s.method : 'default', ref: s.ref && typeof s.ref === 'object' ? s.ref : null };
  }
  const verified = () => state().verified;

  /** Rooms of every floor with their area in canvas px²; `counted` = part of the flat's area (not excluded like a
   *  balcony - the same list as goal.excluded, see ED.isExcluded). */
  // Outdoor spaces are not part of the floor area people know from a lease or a listing ("byt má 58 m²"),
  // so the scale-by-area never counts them, even when they count toward Wi-Fi coverage.
  const OUTDOOR = /balk|lod[žz]i|teras|zahr|balcon|terrace|loggia|garden|patio|veranda/i;
  const isOutdoor = (r) => OUTDOOR.test(String(r && r.name || ''));
  function roomList() {
    const out = [];
    const G = WH.engine.geom;
    for (const f of ED.plans()) {
      for (const r of f.plan.rooms) out.push({ room: r, name: r.name, floor: f, px2: G.polygonAreaPx(r.points), counted: !ED.isExcluded(f, r) && !isOutdoor(r) });
    }
    return out;
  }

  /** Area figures for a given mpp: {total, n, rooms:[{name, area}] (counted, biggest first), excluded:[names],
   *  biggest, smallest} (areas in m²). */
  function summary(mpp) {
    const k = mpp * mpp;
    const all = roomList();
    const rooms = all.filter((r) => r.counted).map((r) => ({ name: r.name, area: r.px2 * k, room: r.room, floor: r.floor })).sort((a, b) => b.area - a.area);
    const total = rooms.reduce((s, r) => s + r.area, 0);
    const excluded = [];
    for (const r of all) if (!r.counted && !excluded.includes(r.name)) excluded.push(r.name);
    return { total, n: rooms.length, rooms, excluded, biggest: rooms[0] || null, smallest: rooms.length > 1 ? rooms[rooms.length - 1] : null };
  }
  /** Total counted area in canvas px² (what one m² value of the flat is compared with). */
  const countedPx2 = () => roomList().reduce((s, r) => s + (r.counted ? r.px2 : 0), 0);

  // ---------------------------------------------------------------------------------------------------------------
  // applying a scale
  // ---------------------------------------------------------------------------------------------------------------
  const clampMpp = (v) => Number(Math.min(MPP_MAX, Math.max(MPP_MIN, v)).toPrecision(10));

  /** "Byt teď má 58,0 m² · Ložnice 14,0 m² · …" (+ Undo when the change made an undo step). */
  function resultToast(undoable, lead) {
    const s = summary(state().mpp);
    let text;
    if (!s.n) text = t('editor.scale.done', { px: WH.util.fmt(1 / state().mpp, 0) });
    else {
      const parts = s.rooms.slice(0, MAX_PREVIEW).map((r) => `${r.name} ${fmtA(r.area)}`);
      if (s.rooms.length > MAX_PREVIEW) parts.push('…');
      text = t('editor.scale.applied', { total: fmtA(s.total), rooms: parts.join(' · ') });
    }
    if (lead) text = `${lead} ${text}`;
    // a typo ("1412" instead of "14") must not pass silently: outside the plausible range the toast says so
    const lim = WH.engine.project.SCALE_LIMITS || { areaMin: 15, areaMax: 400, roomMin: 1.5, roomMax: 80 };
    const odd = s.n > 0 && (s.total < lim.areaMin || s.total > lim.areaMax || (s.biggest && s.biggest.area > lim.roomMax));
    if (odd) text = `${text} ${t('editor.scale.suspicious')}`;
    WH.ui.toast(undoable ? { text, action: { i18n: 'ui.undo', fn: () => { if (WH.store.canUndo()) WH.store.undo(); } } } : { text }, { kind: odd ? 'warn' : 'ok', ms: undoable || odd ? 12000 : 5000 });
  }

  /** Set (and verify) the scale: one undo step + the result toast. method: 'two-points'|'area'|'width'|'import'. */
  function apply(mpp, method, ref) {
    if (!(mpp > 0) || !Number.isFinite(mpp) || !ED.proj()) return false;
    const val = clampMpp(mpp);
    const ok = WH.store.commit('editor.undo.scale', (p) => WH.engine.project.setScale(p, { mpp: val, method, ref: ref || null }) !== false, ['scale']);
    S().scaleSnooze = false;
    resultToast(ok, val !== Number(mpp.toPrecision(10)) ? t('editor.scale.clamped') : '');
    ED.emit('scale');
    return true;
  }

  /** The user confirms the current scale as it is ("Sedí"). */
  function confirmCurrent() {
    const ok = WH.store.commit('editor.undo.scaleOk', (p) => { WH.engine.project.confirmScale(p); }, ['scale']);
    WH.ui.toast(ok ? { text: t('editor.scale.confirmed'), action: { i18n: 'ui.undo', fn: () => { if (WH.store.canUndo()) WH.store.undo(); } } } : { text: t('editor.scale.confirmed') }, { kind: 'ok' });
    ED.emit('scale');
  }

  /** mpp from the flat's area in m² (rooms that count toward the flat, every floor). */
  function mppFromArea(m2) {
    const px2 = countedPx2();
    if (!(px2 > 0) || !(m2 > 0)) return null;
    const plans = ED.plans();
    // one floor: the engine's own helper (same rule as the planner); several floors: the same formula over all of them
    if (plans.length === 1) {
      const ex = ED.excludedIds(plans[0]).concat(plans[0].plan.rooms.filter(isOutdoor).map((r) => r.roomId));
      const v = WH.engine.project.scaleFromArea(plans[0].plan, m2, { excluded: ex });
      return v > 0 ? v : null;
    }
    return Math.sqrt(m2 / px2);
  }

  const fromArea = (m2) => { const v = mppFromArea(m2); return v ? apply(v, 'area', { areaM2: round2(m2) }) : false; };
  const round2 = (v) => Math.round(v * 100) / 100;
  function fromWidth(m) {
    const pl = widthPlan();
    if (!pl || !(m > 0)) return false;
    return apply(WH.engine.project.scaleFromWidth(pl, m), 'width', { metres: round2(m) });
  }
  function fromPoints(a, b, metres) {
    const v = WH.engine.project.scaleFromLength(a, b, metres);
    if (!(v > 0)) return false;
    return apply(v, 'two-points', { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, metres: round2(metres) });
  }
  function fromRoom(room, m2) {
    const v = ED.plan() ? WH.engine.project.scaleFromArea(ED.plan(), m2, { roomId: room.roomId }) : null;
    if (!(v > 0)) return false;
    return apply(v, 'area', { areaM2: round2(m2), roomId: room.roomId });
  }
  function fromWall(w, metres) { return fromPoints(w.a, w.b, metres); }
  /** The plan whose bounding box is "the width of the whole plan": the active floor, else the first one with rooms. */
  function widthPlan() {
    const act = ED.plan();
    if (act && act.rooms.length) return act;
    const f = ED.plans().find((x) => x.plan.rooms.length);
    return f ? f.plan : act;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // small form builders
  // ---------------------------------------------------------------------------------------------------------------
  /** Number field of the scale card. A click or Tab into it selects what is there, so typing "58" REPLACES the prefilled
   *  value instead of being appended to it (the prefilled "12" + typed "58" became "5812", "14" became "1412,9"). */
  function numIn(o) {
    const i = WH.ui.numberInput(o);
    i.classList.add('input--sm');
    let fresh = false;
    i.addEventListener('focus', () => { fresh = true; try { i.select(); } catch (e) { /* ignore */ } });
    i.addEventListener('mouseup', (e) => { if (fresh) { fresh = false; e.preventDefault(); } });
    i.addEventListener('blur', () => { fresh = false; });
    return i;
  }
  /** Unit right after the input (before the button). */
  const unit = (u) => el('span.field__unit', u);

  /** Read a number field, show an error under it when out of range; null = invalid. */
  function readNum(input, f, lim, errKey) {
    const v = input.valueAsNumber;
    if (!(v >= lim.min && v <= lim.max)) {
      f.setError(t(errKey, { min: WH.util.fmt(lim.min, lim.min < 1 ? 1 : 0), max: WH.util.fmt(lim.max, 0) }));
      input.focus();
      return null;
    }
    f.setError('');
    return v;
  }

  /** "Plocha bytu [58] m² [Použít]" + "Nepočítám: Balkon" + what every room becomes. */
  function areaForm(o) {
    o = o || {};
    const input = numIn({ min: AREA.min, max: AREA.max, step: 0.5, placeholder: t('editor.scale.areaPh'), ariaLabel: t('editor.scale.areaLabel') });
    const go = () => { const v = readNum(input, f, AREA, 'editor.scale.badArea'); if (v !== null && fromArea(v) && o.after) o.after(); };
    const btn = WH.ui.button({ i18n: 'editor.scale.apply', variant: o.primary ? 'primary' : 'soft', size: 'sm', onClick: go });
    // inside a question that already asks for the area (prompt, leaving the editor) the field needs no label of its own
    const f = WH.ui.field(o.bare ? { control: [input, unit('m²'), btn] } : { label: 'editor.scale.areaLabel', hint: 'scaleVerify', control: [input, unit('m²'), btn] });
    if (o.bare) f.querySelector('.field__label').remove();
    f.classList.add('ed-scale-field');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const excl = el('p.ed-note.ed-scale-excl');
    const prev = el('p.ed-note.ed-scale-prev', { 'aria-live': 'polite' });
    const preview = () => {
      const v = input.valueAsNumber;
      const mpp = v >= AREA.min && v <= AREA.max ? mppFromArea(v) : null;
      if (!mpp) { prev.hidden = true; return; }
      const s = summary(mpp);
      const parts = s.rooms.slice(0, MAX_PREVIEW).map((r) => `${r.name} ${fmtA(r.area)}`);
      if (s.rooms.length > MAX_PREVIEW) parts.push('…');
      prev.textContent = t('editor.scale.preview', { rooms: parts.join(' · ') });
      prev.hidden = !parts.length;
    };
    input.addEventListener('input', () => { f.setError(''); preview(); });
    const root = el('div.ed-scale-form', f, prev, excl);
    function sync(prefill) {
      const s = summary(state().mpp);
      excl.textContent = s.excluded.length ? t('editor.scale.without', { names: s.excluded.join(', ') }) : '';
      excl.hidden = !s.excluded.length;
      if (prefill !== undefined && !typing(input)) input.setValue(prefill === null ? null : Math.round(prefill * 10) / 10);
      const has = s.n > 0;
      input.disabled = !has;
      btn.disabled = !has;
      preview();
    }
    return { el: root, input, sync };
  }

  /** "Tahle místnost má [14] m²" / "Tahle zeď měří [4,2] m" for the inspector (SPEC 14.3 addition). */
  function objectForm(o) {
    const isRoom = o.type === 'room';
    const lim = isRoom ? ROOM_AREA : LEN;
    const input = numIn({ min: lim.min, max: lim.max, step: isRoom ? 0.5 : 0.05, ariaLabel: t(isRoom ? 'editor.scale.roomHas' : 'editor.scale.wallHas') });
    const go = () => {
      const v = readNum(input, f, lim, isRoom ? 'editor.scale.badRoom' : 'editor.scale.badLen');
      const cur = ED.find(o.id);
      if (v === null || !cur) return;
      if (isRoom) fromRoom(cur, v); else fromWall(cur, v);
    };
    const btn = WH.ui.button({ i18n: 'editor.scale.apply', variant: 'soft', size: 'sm', onClick: go });
    const f = WH.ui.field({ label: isRoom ? 'editor.scale.roomHas' : 'editor.scale.wallHas', control: [input, unit(isRoom ? 'm²' : 'm'), btn], helpI18n: 'editor.scale.objNote' });
    f.classList.add('ed-scale-field', 'ed-scale-obj');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    input.addEventListener('input', () => f.setError(''));
    function sync(ob) {
      if (typing(input)) return;
      const v = isRoom ? ED.areaM2(ob.points) : ED.dpx(ob.a, ob.b) * ED.mpp();
      input.setValue(isRoom ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);
      f.classList.toggle('is-unverified', !verified());
    }
    return { el: f, sync };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the "Měřítko" card
  // ---------------------------------------------------------------------------------------------------------------
  const S = () => ED.S;
  let cardApi = null;

  function methodNote(st) {
    const r = st.ref || {};
    switch (st.method) {
      case 'area': {
        if (r.roomId !== undefined) {
          const room = ED.plans().map((f) => f.plan.rooms.find((x) => x.roomId === r.roomId)).find(Boolean);
          if (room && r.areaM2 > 0) return t('editor.scale.by.room', { name: room.name, area: fmtA(r.areaM2) });
        }
        return r.areaM2 > 0 ? t('editor.scale.by.area', { area: fmtA(r.areaM2) }) : t('editor.scale.by.areaPlain');
      }
      case 'two-points': return r.metres > 0 ? t('editor.scale.by.points', { m: fmtLen(r.metres) }) : t('editor.scale.by.pointsPlain');
      case 'width': return t('editor.scale.by.width', { m: fmtLen(currentWidth()) });
      case 'import': return t('editor.scale.by.import');
      default: return '';
    }
  }
  function currentWidth() { const pl = widthPlan(); return pl ? WH.engine.project.widthFromMpp(pl, ED.mpp()) : 0; }

  function buildCard() {
    const card = WH.ui.card({ id: 'ed-scale', title: 'editor.card.scale', icon: 'ruler', hint: 'scaleVerify', collapsible: false });
    card.classList.add('ed-scale-card');
    const head = card.querySelector('.card-head');
    const status = el('span.ed-scale-status');
    head.append(status);

    // summary: total area, biggest / smallest room, how the scale was set
    const total = el('b.ed-scale-total.num');
    const totalLab = el('span.ed-scale-total__lab');
    const extremes = el('div.ed-scale-ext.num');
    const how = el('div.ed-scale-how');
    const sum = el('div.ed-scale-sum', el('div.ed-scale-total__row', total, totalLab), extremes, how);
    const empty = el('p.ed-note.ed-scale-empty');

    // "Víš, kolik má byt m²?" prompt
    const pForm = areaForm({ primary: true, bare: true });
    const pTitle = el('div.ed-scale-ask__t', el('span', t('editor.scale.ask.t')), WH.ui.hint('scaleVerify'));
    const pText = el('p.ed-scale-ask__b', t('editor.scale.ask.b'));
    const pAlt = el('div.cluster.ed-scale-ask__alt',
      WH.ui.button({ i18n: 'editor.scale.ask.points', icon: 'ruler', size: 'sm', variant: 'ghost', onClick: () => ED.tools.setTool('scale', { kbd: false }) }),
      WH.ui.button({ i18n: 'editor.scale.ask.later', size: 'sm', variant: 'ghost', onClick: () => { S().scaleSnooze = true; sync(); ED.emit('hint'); } }));
    const prompt = el('div.ed-scale-ask', pTitle, pText, pForm.el, pAlt);

    // a file whose scale nobody confirmed yet (method 'import'): "Měřítko z načteného souboru ... Sedí?"
    const iText = el('p.ed-scale-ask__b');
    // the user knows the real floor area (e.g. 58 m²): type it right here, no need to find it behind "Upravit"
    const iForm = areaForm({ primary: true, bare: true });
    const imp = el('div.ed-scale-ask.ed-scale-import',
      el('div.ed-scale-ask__t', el('span', t('editor.scale.importT'))), iText,
      el('p.ed-scale-ask__b.ed-scale-import__or', t('editor.scale.importArea')), iForm.el,
      el('div.cluster.ed-scale-ask__alt',
        WH.ui.button({ i18n: 'editor.scale.bannerOk', icon: 'check', size: 'sm', variant: 'primary', onClick: () => confirmCurrent() }),
        WH.ui.button({ i18n: 'editor.scale.bannerEdit', icon: 'ruler', size: 'sm', variant: 'soft', onClick: () => editImported() })));

    // warning when unverified (and the prompt is not shown)
    const warn = el('div.notice.notice--warn.ed-scale-warn', WH.ui.icon('warning', 18), el('span', t('editor.scale.warn')));

    // the three methods
    const panels = {};
    const seg = WH.ui.segmented([
      { value: 'area', i18n: 'editor.scale.m.area' },
      { value: 'points', i18n: 'editor.scale.m.points' },
      { value: 'width', i18n: 'editor.scale.m.width' },
    ], { value: 'area', size: 'sm', block: true, aria: 'editor.scale.methods', onChange: (v) => showMethod(v) });
    const mForm = areaForm({});
    panels.area = el('div.ed-scale-panel', mForm.el);
    const pointsLast = el('p.ed-note');
    panels.points = el('div.ed-scale-panel',
      el('p.ed-scale-text', t('editor.scale.pointsText')),
      el('div.cluster', ED.withKbd(WH.ui.button({ i18n: 'editor.scale.pointsBtn', icon: 'ruler', size: 'sm', variant: 'soft', onClick: () => ED.tools.setTool('scale') }), 's')),
      pointsLast);
    const widthIn = numIn({ min: 1, max: 200, step: 0.1, ariaLabel: t('editor.scale.width') });
    // A flat is rarely wider than ~30 m: a big number here is almost always the floor AREA typed into the width field
    // (58 "m" instead of 58 m² made a bedroom 861 m²). Ask before applying, and offer to use it as the area.
    const WIDTH_SUSPICIOUS = 30;
    const goW = async () => {
      const v = readNum(widthIn, fW, { min: 1, max: 200 }, 'editor.scale.badWidth');
      if (v === null) return;
      if (v > WIDTH_SUSPICIOUS) {
        const pl = widthPlan();
        const mpp = pl ? WH.engine.project.scaleFromWidth(pl, v) : null;
        const would = mpp ? summary(mpp).total : 0;
        const asArea = await WH.ui.confirm({
          title: t('editor.scale.wideT', { m: fmtLen(v) }),
          body: t('editor.scale.wideB', { m: fmtLen(v), area: fmtA(would), a: WH.util.fmt(v, 0) }),
          ok: t('editor.scale.wideArea', { a: WH.util.fmt(v, 0) }),
          cancel: t('editor.scale.wideKeep', { m: fmtLen(v) }),
        });
        if (asArea) {
          if (v >= AREA.min && v <= AREA.max) fromArea(v);
          return;
        }
      }
      fromWidth(v);
    };
    widthIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goW(); } });
    widthIn.addEventListener('input', () => fW.setError(''));
    const fW = WH.ui.field({ label: 'editor.scale.width', hint: 'scale', control: [widthIn, unit('m'), WH.ui.button({ i18n: 'editor.scale.apply', variant: 'soft', size: 'sm', onClick: goW })], helpI18n: 'editor.scale.widthHelp' });
    fW.classList.add('ed-scale-field');
    panels.width = el('div.ed-scale-panel', fW);
    const scaleLine = el('div.ed-scale-line');
    const methods = el('div.ed-scale-methods', seg, panels.area, panels.points, panels.width, scaleLine);
    function showMethod(v) {
      for (const k of Object.keys(panels)) panels[k].hidden = k !== v;
      if (seg.value !== v) seg.setValue(v, true);
    }
    showMethod('area');

    // verified: the methods hide behind "Změnit měřítko"
    const more = el('details.disclosure.ed-scale-more', el('summary', el('span', t('editor.scale.change'))));
    const moreBody = el('div.disclosure__body');
    more.append(moreBody);
    const open = el('div.ed-scale-open');

    card.body.append(empty, sum, imp, prompt, warn, open, more);

    let lastMode = '';
    let lastSig = '';
    function sync(force) {
      const st = state();
      const s = summary(st.mpp);
      const has = s.n > 0;
      const pl = ED.plan();
      // runs on every store change (drag frames too): touch the DOM only when something it shows changed
      const sig = JSON.stringify([WH.i18n.lang, st, s.total.toFixed(2), s.n, s.biggest && [s.biggest.name, s.biggest.area.toFixed(2)], s.smallest && [s.smallest.name, s.smallest.area.toFixed(2)],
        s.excluded, S().scaleSnooze, S().importEdit, ED.plans().length, !!(pl && pl.background), currentWidth().toFixed(2)]);
      if (sig === lastSig && !force) return;
      lastSig = sig;
      // status chip in the head
      status.replaceChildren(WH.ui.badge(t(st.verified ? 'editor.scale.verified' : 'editor.scale.unverified'), st.verified ? 'ok' : 'warn'));
      card.classList.toggle('is-unverified', !st.verified);
      // summary
      sum.hidden = !has;
      empty.hidden = has;
      empty.textContent = t(pl && pl.background ? 'editor.scale.emptyImage' : 'editor.scale.empty');
      if (has) {
        total.textContent = `≈${NB()}${fmtA(s.total)}`;
        totalLab.textContent = t(ED.plans().length > 1 ? 'editor.scale.totalHouse' : 'editor.scale.totalFlat');
        const ex = [];
        if (s.biggest) ex.push(t('editor.scale.biggest', { name: s.biggest.name, area: fmtA(s.biggest.area) }));
        if (s.smallest) ex.push(t('editor.scale.smallest', { name: s.smallest.name, area: fmtA(s.smallest.area) }));
        extremes.textContent = ex.join(' · ');
        extremes.hidden = !ex.length;
        const note = st.verified ? methodNote(st) : '';
        how.replaceChildren(WH.ui.icon(st.verified ? 'check-circle' : 'warning', 16), el('span', note || t(st.verified ? 'editor.scale.okPlain' : 'editor.scale.notYet')));
        how.dataset.kind = st.verified ? 'ok' : 'warn';
        iText.textContent = t('editor.scale.importB', { area: fmtA(s.total) });
      }
      const mode = modeOf(st, has);
      // the questions say it already: no "not verified yet" line under the total then
      how.hidden = mode === 'prompt' || mode === 'import';
      imp.hidden = mode !== 'import';
      prompt.hidden = mode !== 'prompt';
      warn.hidden = mode !== 'open';
      more.hidden = mode !== 'verified';
      if (mode !== lastMode) {
        if (mode === 'verified') { moreBody.append(methods); more.open = false; } else open.append(methods);
        open.hidden = mode !== 'open';
        if (mode === 'open') showMethod(has ? 'area' : 'points');
        lastMode = mode;
      }
      open.hidden = mode !== 'open';
      panels.area.querySelector('.ed-scale-form').classList.toggle('is-off', !has);
      pForm.sync();
      iForm.sync();
      mForm.sync(st.verified && has ? s.total : undefined);
      if (!typing(widthIn)) widthIn.setValue(pl && widthPlan() ? Math.round(currentWidth() * 10) / 10 : null);
      pointsLast.textContent = st.method === 'two-points' && st.ref && st.ref.metres > 0 ? t('editor.scale.by.points', { m: fmtLen(st.ref.metres) }) : '';
      pointsLast.hidden = !pointsLast.textContent;
      scaleLine.replaceChildren(el('span.num', t('editor.scale.line', { px: WH.util.fmt(1 / st.mpp, 0) })));
    }

    /** Bring the card into view with a method open and its input focused. */
    function reveal(which) {
      const st = state();
      if (st.verified) more.open = true;
      else if (lastMode === 'import' && (!which || which === 'area')) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        try { iForm.input.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        flashCard();
        return;
      } else if (lastMode === 'import') { editImported(); return; }
      else if (lastMode === 'prompt' && (!which || which === 'area')) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        try { pForm.input.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        flashCard();
        return;
      } else if (lastMode === 'prompt') { S().scaleSnooze = true; sync(); }
      const has = summary(st.mpp).n > 0;
      const m = which || (has ? 'area' : 'points');
      showMethod(m);
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const target = m === 'area' ? mForm.input : m === 'width' ? widthIn : panels.points.querySelector('button');
      try { if (target && !target.disabled) target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      flashCard();
    }
    let flashT = 0;
    function flashCard() {
      card.classList.remove('is-flash');
      void card.offsetWidth;
      card.classList.add('is-flash');
      clearTimeout(flashT);
      flashT = setTimeout(() => card.classList.remove('is-flash'), 1300);
    }
    cardApi = { el: card, sync, reveal };
    return cardApi;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // leaving the editor ("Hotovo -> Wi-Fi") with an unverified scale
  // ---------------------------------------------------------------------------------------------------------------
  let leavePop = null;
  /** true = a prompt is shown (the caller must not leave yet). */
  function askOnLeave(anchor, go) {
    if (verified() || S().leaveAsked || !summary(state().mpp).n) return false;
    S().leaveAsked = true;
    if (leavePop) leavePop.close();
    const form = areaForm({ primary: true, bare: true, after: () => { if (leavePop) leavePop.close(); go(); } });
    form.sync();
    const body = [
      el('p.ed-scale-ask__b', t('editor.scale.ask.b')),
      form.el,
      el('div.cluster.ed-scale-ask__alt',
        WH.ui.button({ i18n: 'editor.scale.ask.points', icon: 'ruler', size: 'sm', variant: 'ghost', onClick: () => { if (leavePop) leavePop.close(); ED.tools.setTool('scale'); } }),
        WH.ui.button({ i18n: 'editor.scale.leave.go', icon: 'arrow-right', size: 'sm', variant: 'ghost', onClick: () => { S().scaleSnooze = true; if (leavePop) leavePop.close(); go(); } })),
    ];
    leavePop = WH.ui.popover(anchor, body, {
      title: { i18n: 'editor.scale.ask.t' }, placement: 'bottom', align: 'end', width: 320, className: 'ed-scale-pop ed-leave-pop',
      onClose: () => { leavePop = null; },
    });
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // a file whose scale nobody confirmed yet (method 'import', SPEC 14.1 "Měřítko z načteného souboru ... Sedí?")
  // ---------------------------------------------------------------------------------------------------------------
  // It is asked in the hint line (with [Sedí] [Upravit]) and at the top of the scale card - never over the plan.
  /** Card / hint mode: 'verified' | 'import' (confirm the file's scale) | 'prompt' ("Víš, kolik má byt m²?") | 'open'. */
  function modeOf(st, has) {
    const s = S();
    if (st.verified) return 'verified';
    if (has && st.method === 'import' && !s.importEdit) return 'import';
    if (has && !s.scaleSnooze && !s.importEdit) return 'prompt';
    return 'open';
  }
  /** "Upravit": the imported scale is not right - show the methods (flat area first). */
  function editImported() {
    S().importEdit = true;
    if (cardApi) cardApi.sync();
    ED.emit('hint');
    openScale('area');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // hint line requests (60-view.js asks before its tool hints)
  // ---------------------------------------------------------------------------------------------------------------
  /** {text, icon, kind, actions:[{i18n, fn, icon, primary}]} or null. */
  function hint() {
    const s = S();
    if (verified() || s.draft && (s.draft.a || (s.draft.pts && s.draft.pts.length) || s.draft.asking)) return null;
    if (s.tool !== 'select' && s.tool !== 'rect' && s.tool !== 'poly') return null;
    if (s.tool === 'select' && s.sel) return null;
    const pl = ED.plan();
    if (!pl) return null;
    const st = state();
    const sm = summary(st.mpp);
    const mode = modeOf(st, sm.n > 0);
    if (mode === 'import') {
      return { icon: 'ruler', kind: 'ask', text: t('editor.scale.banner', { area: fmtA(sm.total) }), actions: [
        { i18n: 'editor.scale.bannerOk', icon: 'check', primary: true, fn: () => confirmCurrent() },
        { i18n: 'editor.scale.bannerEdit', fn: () => editImported() }] };
    }
    if (sm.n > 0) {
      if (mode !== 'prompt') return null;
      return { icon: 'ruler', kind: 'ask', text: t('editor.hint.scaleAsk'), actions: [{ i18n: 'editor.hint.scaleAskBtn', fn: () => openScale('area') }] };
    }
    if (pl.background) return { icon: 'ruler', kind: 'ask', text: t('editor.hint.scaleImage'), actions: [{ i18n: 'editor.hint.scaleImageBtn', fn: () => ED.tools.setTool('scale') }] };
    if (s.scaleAsk === 'blank' && s.tool !== 'select') return { icon: 'ruler', kind: 'ask', text: t('editor.hint.scaleBlank') };
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // plan check: engine scale issues -> check items with one-click "Nastavit měřítko"
  // ---------------------------------------------------------------------------------------------------------------
  function boxOf(pts) {
    let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0;
    for (const q of pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }

  /** One engine scale issue -> a plan-check item {type:'scale', code, key, ids, params, box, geom, fix:'scale', floor,
   *  method}; rooms / doors of another floor carry its name (Ukázat switches to it). */
  function item(is, plans, act) {
    const code = is && is.code;
    if (!code) return null;
    const f = is.floor ? plans.find((x) => x.id === is.floor) : null;
    const it = { type: 'scale', code, key: `scale:${code}:${is.floor || ''}:${is.roomId || is.doorId || ''}`, ids: [], params: {}, box: null, geom: null, fix: 'scale', floor: is.floor || null, method: 'area' };
    if (f && act && f.id !== act) it.params.floor = f.name;
    switch (code) {
      case 'unverified': break;
      case 'areaSmall':
      case 'areaLarge':
        Object.assign(it.params, { area: fmtA(is.value), limit: fmtA(is.limit) });
        break;
      case 'roomSmall':
      case 'roomLarge': {
        const r = f && f.plan.rooms.find((x) => x.roomId === is.roomId);
        Object.assign(it.params, { name: is.name || (r && r.name) || '', area: fmtA(is.value), limit: fmtA(is.limit) });
        if (r) { it.ids = [r.id]; it.box = boxOf(r.points); it.geom = { polys: [r.points] }; }
        it.method = 'room';
        break;
      }
      case 'doorNarrow':
      case 'doorWide': {
        const d = f && f.plan.doors.find((x) => x.id === is.doorId);
        Object.assign(it.params, { name: is.name || (d && d.name) || '', w: fmtLen(is.value), limit: fmtLen(is.limit) });
        if (d) { it.ids = [d.id]; it.box = boxOf([d.a, d.b]); it.geom = { segs: [[d.a, d.b]] }; }
        it.method = 'points';
        break;
      }
      default: return null;
    }
    return it;
  }

  function issues() {
    const E = WH.engine.project;
    const p = ED.proj();
    if (!p || !p.plan || typeof E.scaleIssues !== 'function') return [];
    let list = [];
    try { list = E.scaleIssues(p) || []; } catch (e) { console.error('[editor] scale check failed:', e); return []; }
    const plans = ED.plans();
    const act = ED.activeFloorId();
    return list.map((is) => item(is, plans, act)).filter(Boolean);
  }

  /** "Nastavit měřítko" of a plan-check item: a room -> its "Tahle místnost má [x] m²" field, a door -> two points
   *  (its ends snap), anything else -> the flat's area. */
  function fixIssue(is) {
    if (is.floor && ED.floors && is.floor !== ED.activeFloorId()) ED.floors.switchTo(is.floor);
    if (is.method === 'room' && is.ids[0] && ED.find(is.ids[0])) {
      if (ED.tools && ED.S.tool !== 'select') ED.tools.setTool('select');
      ED.select(is.ids[0]);
      ED.reveal(is.ids[0]);
      requestAnimationFrame(() => {
        const inp = document.querySelector('#view-editor .ed-top-card .ed-scale-obj input');
        if (inp) { inp.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); try { inp.focus({ preventScroll: true }); inp.select(); } catch (e) { /* ignore */ } }
      });
      return;
    }
    openScale(is.method === 'points' ? 'points' : 'area');
  }

  /** Open the editor's scale card (the planner's "Měřítko neověřeno" badge, the banner, plan-check items). */
  let pendingReveal = null;
  function openScale(which) {
    if (WH.views && WH.views.current !== 'editor') {
      pendingReveal = which || '';
      WH.views.go('editor');
      return;
    }
    if (ED.tools && ED.S.tool !== 'select' && ED.S.tool !== 'scale') ED.tools.setTool('select');
    if (cardApi) { cardApi.sync(); cardApi.reveal(which); }
  }
  /** Called by the view's show(): a reveal requested before the editor was on screen. */
  function consumePending() {
    if (pendingReveal === null) return;
    const w = pendingReveal;
    pendingReveal = null;
    requestAnimationFrame(() => openScale(w || undefined));
  }

  ED.scaling = {
    state, verified, summary, apply, confirmCurrent, fromArea, fromWidth, fromPoints, fromRoom, fromWall, mppFromArea,
    buildCard, sync: () => { if (cardApi) cardApi.sync(); }, objectForm, askOnLeave, editImported, hint, issues, fixIssue,
    open: openScale, consumePending, fmtA, fmtLen,
  };
  /** Public entry for other views (planner badge "Měřítko neověřeno" -> the editor's scale card). */
  ED.openScale = openScale;
})();
