/* Planner (Wi-Fi view) 3/3: the sidebar cards.  Every card is built once; small "sync" functions refresh values from
 * the store / the latest analysis without touching a control the user is typing in. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const P = () => WH.store.project;
  const commit = (label, fn, topics) => WH.store.commit(label, fn, topics);
  const focused = (n) => !!n && (document.activeElement === n || n.contains(document.activeElement));
  const bk = (b) => WH.engine.units.bandKey(b);
  let host = null;
  let syncs = [];
  let measCard = null;

  // ---------------------------------------------------------------------------------------------------------------
  // small bound controls
  // ---------------------------------------------------------------------------------------------------------------
  /** Number field: {i18n|label, hint, unit, min, max, step, d (decimals for the error), req, ph, get, set(p, v), undo, topics} */
  function numField(o) {
    const inp = ui().numberInput({ min: o.min, max: o.max, step: o.step || 'any', placeholder: o.ph || '' });
    const f = ui().field({ i18n: o.i18n, label: o.label, hint: o.hint, unit: o.unit, control: inp });
    inp.addEventListener('input', () => f.setError(''));
    inp.addEventListener('change', () => {
      const v = inp.value === '' ? null : inp.valueAsNumber;
      if (v === null && !o.req) { commit(o.undo, (p) => o.set(p, null), o.topics); return; }
      if (v === null || !Number.isFinite(v) || v < o.min || v > o.max) {
        f.setError(t('planner.err.range', { min: WH.util.fmt(o.min, o.d || 0), max: WH.util.fmt(o.max, o.d || 0) }));
        inp.setValue(o.get());
        return;
      }
      commit(o.undo, (p) => o.set(p, v), o.topics);
    });
    syncs.push(() => { inp.disabled = !!(o.off && o.off()); if (!focused(inp)) inp.setValue(o.get()); });
    return f;
  }

  /** Slider: one undo step per gesture.  {i18n|label, hint, min, max, step, fmt, get, set(p, v), undo, topics} */
  function slider(o) {
    let open = false;
    const apply = (v) => {
      if (!open) { WH.store.begin(o.undo); open = true; }
      WH.store.live((p) => o.set(p, v), o.topics);
    };
    const r = ui().range({ min: o.min, max: o.max, step: o.step, value: o.get(), format: o.fmt, onInput: apply, onChange: (v) => { apply(v); open = false; WH.store.end(); } });
    syncs.push(() => { if (!open) r.setValue(o.get()); });
    return ui().field({ i18n: o.i18n, label: o.label, hint: o.hint, control: r });
  }

  /** Select: {i18n|label, hint, opts() -> [{value,label}], get, set(p, v), undo, inline, topics} */
  function selField(o) {
    const s = ui().select(o.opts(), { value: String(o.get()), onChange: (v) => commit(o.undo, (p) => o.set(p, v), o.topics) });
    const f = ui().field({ i18n: o.i18n, label: o.label, hint: o.hint, control: s, inline: o.inline });
    let key = '';
    syncs.push(() => {
      if (focused(s)) return;
      const opts = o.opts();
      const k = JSON.stringify(opts) + WH.i18n.lang;
      if (k !== key) { key = k; s.setOptions(opts, String(o.get())); } else s.value = String(o.get());
    });
    return f;
  }

  function sw(o) {
    const s = ui().switch({ checked: !!o.get(), i18n: o.i18n, hint: o.hint, onChange: (v) => o.set(v) });
    syncs.push(() => s.setChecked(!!o.get()));
    return s;
  }

  const roomOpts = (first, label) => () => [{ value: first, label: typeof label === 'function' ? label() : label }, ...P().plan.rooms.map((r) => ({ value: r.roomId, label: r.name }))];
  /** "Celý byt" - or "Celé patro" in a house with several floors (the goal is the floor on screen, SPEC 14.3). */
  const allKey = () => (PL.multi() ? 'planner.res.allFloor' : 'planner.res.all');

  /** "Device" = goal.device (the measurements that calibrate the map and build the speed curve): a real picker (SPEC 7.4). */
  function deviceField(i18n) {
    const pick = PL.devicePicker({ value: P().goal.device, onChange: (v) => commit('planner.undo.device', (p) => { p.goal.device = v; }, ['goal']) });
    syncs.push(() => { if (!focused(pick)) pick.setValue(P().goal.device); });
    const f = ui().field({ i18n, hint: 'device', control: pick });
    f.querySelector('.field__label').removeAttribute('for');   // the trigger names itself ("Device: Phone")
    return f;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 1. getting started
  // ---------------------------------------------------------------------------------------------------------------
  function cardStart() {
    const list = el('ul.pl-steps');
    const close = ui().iconButton({ icon: 'x', tip: 'planner.start.hide', size: 'sm', onClick: () => WH.store.setPref('checklistDismissed', true) });
    const c = ui().card({ id: 'pl-start', i18n: 'planner.start.title', icon: 'flag', actions: [close], body: list });
    let key = '';
    syncs.push(() => {
      const p = P();
      const pref = (k) => !!WH.store.getPref('planner.' + k);
      // the last step is the guided "Prvotní měření" (SPEC 9): it shows where to measure and tunes the model
      const cal = PL.calib && PL.calib.startItem ? PL.calib.startItem() : { done: p.measurements.length > 0, label: null };
      const it = [
        { k: 'plan', done: p.plan.rooms.length > 0, go: () => WH.views.go('editor') },
        // SPEC 14.1: "Měřítko půdorysu" - done once the scale is verified (area, a known distance or the width)
        { k: 'scale', done: p.plan.rooms.length > 0 && PL.scale.verified(), go: p.plan.rooms.length ? () => PL.scale.open() : null },
        { k: 'today', done: PL.baselineOk() || p.measurements.length > 0, go: () => { WH.store.setPref('planner.baselineOk', PL.posKey(P().net.baseline)); ui().toast({ i18n: 'planner.router.markedSame' }, { kind: 'ok', ms: 2500 }); } },
        { k: 'move', done: pref('movedOnce') || PL.moved() },
        // SPEC 13: which bands the router sends (Wi-Fi 6E / 7 users tick 6 GHz) - Auto and "Nevím" points follow it
        { k: 'bands', done: pref('bandsOk') || p.measurements.length > 0, go: () => { WH.store.setPref('planner.bandsOk', true); PL.side.showRouterBands(); } },
        PL.calib && PL.calib.open
          ? { k: 'calib', done: cal.done, label: cal.label, go: (e) => PL.calib.open({ from: e && e.currentTarget }) }
          : { k: 'measure', done: p.measurements.length > 0, go: () => PL.startMeasuring() },
      ];
      c.hidden = !!WH.store.getPref('checklistDismissed') || it.every((x) => x.done);
      const k = it.map((x) => +x.done + (x.label || '')).join('') + WH.i18n.lang;
      if (k === key) return;
      key = k;
      list.replaceChildren(...it.map((x) => el('li.pl-step' + (x.done ? '.is-done' : ''),
        el('span.pl-step__ico', ui().icon(x.done ? 'check-circle' : 'circle', 20)),
        el('div.pl-step__main', el('div.pl-step__t', t(`planner.start.${x.k}`)), x.done ? null : el('div.pl-step__b', t(`planner.start.${x.k}.b`))),
        x.done || !x.go ? null : ui().button(x.label ? { label: x.label, size: 'sm', variant: 'soft', onClick: x.go } : { i18n: `planner.start.${x.k}.go`, size: 'sm', variant: 'soft', onClick: x.go }))));
    });
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 2. result
  // ---------------------------------------------------------------------------------------------------------------
  /** Change in percentage POINTS between the two shown (rounded) percentages, so "32 % -> 63 %" says +31. */
  function deltaBadge(a, b) {
    const r = Math.round(b) - Math.round(a);
    return el(`span.badge.pl-delta.badge--${r > 0 ? 'ok' : r < 0 ? 'danger' : 'muted'}`, r ? ui().icon(r > 0 ? 'arrow-up' : 'arrow-down', 16) : null, r ? t('planner.res.pts', { n: PL.signed(r) }) : t('planner.res.same'));
  }

  function roomRow(id) {
    const b = el('button.list-row.pl-room', { type: 'button', 'aria-pressed': 'false' });
    const row = { b, n: el('span.pl-room__name'), m: el('span.meter'), c: el('span.num'), d: el('span.num'), x: el('span.delta.pl-room__delta'), sign: null };
    b.append(row.n, row.m, row.c, row.d, row.x);
    b.addEventListener('click', () => commit('planner.undo.target', (p) => { p.goal.room = p.goal.room === id ? 'all' : id; }, ['goal']));
    return row;
  }

  function cardResult() {
    const target = selField({ i18n: 'planner.res.target', hint: 'target', inline: true, undo: 'planner.undo.target', opts: roomOpts('all', allKey), get: () => P().goal.room, set: (p, v) => { p.goal.room = v === 'all' ? 'all' : Number(v); } });
    target.classList.add('pl-target');
    const hero = el('div.pl-hero');
    const avg = el('span');
    const p10 = el('dd.num');
    const kv = el('dl.kv.pl-kv',
      el('div', el('dt', t('planner.res.avg'), ui().hint('avgSignal')), el('dd.num', avg, ui().hint('quality'))),
      el('div', el('dt', t('planner.res.p10'), ui().hint('p10')), p10));
    const sentence = el('p.pl-sentence');
    // SPEC 10.3: with a second point on, who covers which rooms ("AP 2 má navrch v místnostech Ložnice a Pracovna, …")
    const srcLine = el('p.pl-sentence.pl-srcline', { hidden: true });
    // SPEC 10: what the change does at the measured points (+ "Podrobnosti" -> the Measurements card)
    const wiTxt = el('span');
    const wiLine = el('p.pl-wiline', { hidden: true }, ui().icon('pin', 16), wiTxt, ui().button({ i18n: 'planner.wi.details', size: 'sm', variant: 'ghost', onClick: () => {
      if (!measCard) return;
      measCard.setOpen(true);
      requestAnimationFrame(() => { const n = measCard._wi; if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest', behavior: WH.util.prefersReducedMotion() ? 'auto' : 'smooth' }); });
    } }));
    const speedLine = el('p.pl-speedline', { hidden: true });
    // SPEC 14.1: an unverified scale makes every number a guess - say it where the numbers are, with the way out
    const scaleTxt = el('span');
    const scaleNote = el('div.notice.notice--warn.pl-scalenote', { hidden: true }, ui().icon('ruler', 18),
      el('div.stack.gap-2', scaleTxt, el('div', ui().button({ i18n: 'planner.scale.set', icon: 'ruler', size: 'sm', onClick: () => PL.scale.open() }))));
    // SPEC 14.3: the whole house - every floor's coverage (area weighted), a click goes to that floor
    const house = houseSection();
    const rooms = el('div.pl-rooms');
    const live = el('div.sr-only', { 'aria-live': 'polite' });
    // SPEC 9: the model tuned by measurements (plain words) and the whole-home throughput (28-calib-wizard.js)
    const fitSec = PL.calib && PL.calib.resultSection ? PL.calib.resultSection() : null;
    const tpSec = PL.calib && PL.calib.throughputSection ? PL.calib.throughputSection() : null;
    if (fitSec) syncs.push((q) => fitSec.sync(q));
    if (tpSec) syncs.push((q) => tpSec.sync(q));
    const c = ui().card({ id: 'pl-result', i18n: 'planner.res.title', icon: 'gauge', body: [
      target, scaleNote, el('div.pl-cap', el('span', t('planner.res.coverage')), ui().hint('coverage')), hero, kv, sentence, srcLine, wiLine, speedLine, house.el, fitSec, tpSec,
      el('div.pl-subhead', el('span', t('planner.res.rooms')), el('span', t('planner.res.roomsHint'))), rooms, live].filter(Boolean) });
    const rows = new Map();
    let order = '';
    let lastLive = '';
    let titleKey = '';
    syncs.push((q) => {
      const p = P();
      const a = PL.S.a;
      const pct = WH.util.fmtPct;
      // the Result is the floor on screen (SPEC 14.3): its name in the title while there are several
      const tk = (PL.multi() ? PL.floorName(PL.floorId()) : '') + WH.i18n.lang;
      if (tk !== titleKey) { titleKey = tk; c.setTitle(PL.multi() ? t('planner.res.titleFloor', { floor: PL.floorName(PL.floorId()) }) : t('planner.res.title')); }
      const sn = PL.scale.needed();
      scaleNote.hidden = !sn;
      if (sn && q !== 'coarse') {
        const ar = PL.scale.area();
        scaleTxt.textContent = ar && ar.areaM2 > 0 ? t('planner.scale.note', { a: PL.scale.fmt(ar.areaM2) }) : t('planner.scale.noteNoArea');
      }
      house.sync(q);
      if (!a || !p.plan.rooms.length) {
        hero.replaceChildren(el('span.hero-num', '—'));
        avg.textContent = '—';
        p10.textContent = '—';
        sentence.textContent = t('planner.res.noplan');
        srcLine.hidden = true;
        speedLine.hidden = true;
        rooms.replaceChildren();
        rows.clear();
        order = '';
        return;
      }
      const s = a.stats;
      const cmp = PL.moved() || PL.anyNode();
      const dl = s.trial.coverage - s.today.coverage;
      hero.replaceChildren(...(cmp ? [
        el('span.pl-hero__cap.pl-a1', t('planner.res.today')), el('span.pl-hero__cap.pl-a3', t('planner.res.now')),
        el('span.pl-hero__old.num.pl-b1', pct(s.today.coverage)), el('span.pl-hero__arrow.pl-b2', ui().icon('arrow-right', 20)),
        el('span.hero-num.pl-b3', pct(s.trial.coverage)), deltaBadge(s.today.coverage, s.trial.coverage)] : [el('span.hero-num.pl-b1', pct(s.trial.coverage))]));
      avg.textContent = s.trial.n ? `${WH.util.dbm(s.trial.mean)} · ${PL.qWord(s.trial.mean)}` : '—';
      p10.textContent = s.trial.n ? WH.util.dbm(s.trial.p10) : '—';
      const cov = s.trial.coverage;
      const lvl = cov >= 90 ? 'great' : cov >= 70 ? 'good' : cov >= 40 ? 'half' : 'poor';
      let txt = t('planner.res.s.' + lvl);
      if (PL.atBest()) {
        // the router already stands on the optimizer's answer: no "try moving it" advice right after it was moved
        txt += ' ' + t('planner.res.s.atBest');
        if (cov < 70) txt += ' ' + t('planner.res.s.addAp');
      } else if (lvl === 'half') txt += ' ' + t('planner.res.s.tryMove');
      else if (lvl === 'poor') txt += ' ' + t('planner.res.s.tryFind');
      if (cmp && dl >= 3) txt += ' ' + t('planner.res.s.better');
      else if (cmp && dl <= -3) txt += ' ' + t('planner.res.s.worse');
      sentence.textContent = txt;
      // SPEC 10.3 / 14.2: which rooms each node serves (a room counts as a node's when that node is the stronger source on
      // at least half of its floor); the drag frames (coarse) carry no shares - the line keeps its last text until the
      // pointer rests
      if (q !== 'coarse') {
        const sh = PL.anyNode() && a.sourceShare ? a.sourceShare : null;
        const txt2 = sh ? srcSentence(p, a, sh) : '';
        srcLine.hidden = !txt2;
        if (txt2) srcLine.textContent = txt2;
      }
      const ws = q === 'coarse' ? null : PL.wi.summary();
      if (q !== 'coarse') { wiLine.hidden = !ws; if (ws) wiTxt.textContent = PL.wi.resultLine(ws); }
      const sp = PL.S.sp;
      // the throughput section says the same (and more) whenever a speed curve exists
      speedLine.hidden = !sp || !!(tpSec && !tpSec.hidden);
      if (sp) {
        // per floor (SPEC 14.3): the speed of the floor on screen, named while there are several
        const prm = { v: sp.stats ? pct(sp.stats.coverage) : '', d: PL.mbps(p.goal.targetDown), u: PL.mbps(p.goal.targetUp), floor: PL.floorName(PL.floorId()) };
        speedLine.textContent = sp.stats
          ? t(PL.multi() ? 'planner.res.speedFloor' : 'planner.res.speed', prm) + (sp.stats.known < 99.5 ? ' ' + t('planner.res.speedKnown', { v: pct(sp.stats.known) }) : '')
          : t('planner.res.speedNone');
      }
      // rooms
      const ids = p.plan.rooms.map((r) => r.roomId);
      const ex = new Set(p.goal.excluded);
      for (const r of p.plan.rooms) {
        let row = rows.get(r.roomId);
        if (!row) { row = roomRow(r.roomId); rows.set(r.roomId, row); }
        const sT = a.perRoom.trial.get(r.roomId);
        const s0 = a.perRoom.today.get(r.roomId);
        row.n.textContent = r.name;
        if (!sT || !sT.n) {
          row.m.style.setProperty('--v', '0');
          row.c.textContent = '—';
          row.d.textContent = '—';
          if (row.sign !== 0) { row.x.replaceChildren(); row.sign = 0; }
        } else {
          row.m.style.setProperty('--v', (sT.coverage / 100).toFixed(3));
          row.m.style.setProperty('--c', PL.qVar(sT.mean));
          row.c.textContent = pct(sT.coverage);
          row.d.textContent = WH.util.dbm(sT.mean);
          const dd = cmp && s0 && s0.n ? Math.round(sT.mean - s0.mean) : 0;
          const sign = Math.sign(dd);
          if (sign !== row.sign) {
            row.sign = sign;
            row.x.className = 'delta pl-room__delta delta--' + (sign > 0 ? 'up' : sign < 0 ? 'down' : 'zero');
            row.x.replaceChildren(...(sign ? [ui().icon(sign > 0 ? 'arrow-up' : 'arrow-down', 16), el('span')] : []));
          }
          if (sign) row.x.lastChild.textContent = `${WH.util.fmt(Math.abs(dd), 0)}${WH.util.NBSP}dB`;
        }
        row.b.setAttribute('aria-pressed', String(p.goal.room === r.roomId));
        row.b.classList.toggle('is-excluded', ex.has(r.roomId));
        if (q !== 'coarse') {
          row.b.setAttribute('aria-label', t('planner.res.roomAria', { name: r.name, cov: sT && sT.n ? pct(sT.coverage) : '—', v: sT && sT.n ? WH.util.dbm(sT.mean) : '—' }) + (ex.has(r.roomId) ? ' ' + t('planner.res.excluded') : ''));
          row.b.title = ex.has(r.roomId) ? t('planner.res.excluded') : '';
        }
      }
      for (const id of [...rows.keys()]) if (!ids.includes(id)) rows.delete(id);
      const ok = ids.join(',');
      if (ok !== order) { order = ok; rooms.replaceChildren(...ids.map((id) => rows.get(id).b)); }
      if (q === 'full') {
        const msg = t('planner.res.live', { cov: pct(cov), v: s.trial.n ? WH.util.dbm(s.trial.mean) : '—' });
        if (msg !== lastLive) { lastLive = msg; live.textContent = msg; }
      }
    });
    return c;
  }

  /**
   * "AP 2 má navrch v místnostech Ložnice a Pracovna, jinde je silnější router." - for any number of nodes (SPEC 14.2):
   * every room goes to the source that wins at least half of its floor; a node of another floor is named with its floor.
   * A node of ANOTHER floor that wins nothing here is simply left out (the mesh upstairs is not meant for the ground
   * floor); '' = nothing to say on this floor.
   */
  function srcSentence(p, a, sh) {
    const list = a.params && a.params.trial && Array.isArray(a.params.trial.nodes) ? a.params.trial.nodes : PL.nodeList();
    const counted = p.plan.rooms.filter((r) => { const s2 = a.perRoom.trial.get(r.roomId); return s2 && s2.n; });
    const by = sh.perRoomBySource instanceof Map ? sh.perRoomBySource : null;
    const won = list.map(() => []);
    for (const r of counted) {
      if (by && by.get(r.roomId)) {
        const v = by.get(r.roomId);
        let k = 0;
        for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i;
        if (k > 0 && v[k] >= 50 && won[k - 1]) won[k - 1].push(r.name);
      } else if ((sh.perRoom.get(r.roomId) || 0) >= 50 && won[0]) won[0].push(r.name);
    }
    const who = (n) => (PL.here(n.floor) ? PL.nodeName(n) : t('planner.res.srcWhoFloor', { who: PL.nodeName(n), floor: PL.floorName(n.floor) }));
    // only the nodes of this floor are expected to win here; one of another floor counts when it does win something
    const relevant = list.map((nd, i) => i).filter((i) => PL.here(list[i].floor) || won[i].length);
    if (!relevant.length) return '';
    if (relevant.length === 1) {
      const i = relevant[0];
      const names = won[i];
      const w = who(list[i]);
      return !names.length ? t('planner.res.srcNone', { who: w })
        : names.length >= counted.length ? t(PL.multi() ? 'planner.res.srcAllFloor' : 'planner.res.srcAll', { who: w })
          : t(names.length === 1 ? 'planner.res.srcOne' : 'planner.res.srcMany', { who: w, list: PL.listOf(names) });
    }
    const parts = [];
    let n = 0;
    list.forEach((nd, i) => {
      const names = won[i];
      if (!names.length) return;
      n += names.length;
      parts.push(t(names.length === 1 ? 'planner.res.srcPart1' : 'planner.res.srcPartN', { who: who(nd), list: PL.listOf(names) }));
    });
    if (!parts.length) return t('planner.res.srcNoneMany');
    return t(n >= counted.length ? 'planner.res.srcMultiAll' : 'planner.res.srcMulti', { parts: parts.join(', ') });
  }

  /** "Celý dům" (SPEC 14.3): the area-weighted coverage of every floor + each floor's own (click = go there). Computed
   *  with engine.analysis.building after a full-quality analysis, once the pointer rests (all floors at cell 8). */
  function houseSection() {
    const total = el('div.pl-house__total');
    const floors = el('div.pl-house__floors');
    const root = el('div.pl-house', { hidden: true }, el('div.pl-cap', el('span', t('planner.res.house')), ui().hint('house')), total, floors);
    let pend = 0;
    let doneFor = null;
    let data = null;
    const cache = {};
    const paint = () => {
      const p = P();
      if (!data || !PL.multi()) { root.hidden = true; return; }
      root.hidden = false;
      const pct = WH.util.fmtPct;
      const cmp = PL.moved() || PL.anyNode();
      const tt = data.total || {};
      const trial = tt.trial && Number.isFinite(tt.trial.coverage) ? tt.trial.coverage : null;
      const today = tt.today && Number.isFinite(tt.today.coverage) ? tt.today.coverage : null;
      total.replaceChildren(
        el('span.pl-house__lbl', t('planner.res.houseCov')),
        cmp && today !== null ? el('span.pl-house__old.num', pct(today)) : null,
        cmp && today !== null ? el('span.pl-house__arrow', ui().icon('arrow-right', 16)) : null,
        el('b.pl-house__v.num', trial === null ? '—' : pct(trial)),
        cmp && today !== null && trial !== null ? deltaBadge(today, trial) : null);
      const act = PL.floorId();
      floors.replaceChildren(...(data.floors || []).slice().sort((x, y) => y.level - x.level).map((f) => {
        const v = f.stats && f.stats.trial && f.stats.trial.n !== 0 && Number.isFinite(f.stats.trial.coverage) ? f.stats.trial.coverage : null;
        const b = el('button.list-row.pl-house__floor', { type: 'button', 'aria-pressed': String(f.id === act) },
          el('span.pl-house__name.truncate', f.name),
          el('span.meter', { style: { '--v': v === null ? '0' : (v / 100).toFixed(3), '--c': v === null ? 'var(--line-strong)' : `var(--q-${v >= 70 ? 'good' : v >= 40 ? 'weak' : 'veryWeak'})` } }),
          el('span.num', v === null ? '—' : pct(v)));
        b.setAttribute('aria-label', t('planner.res.houseFloorAria', { name: f.name, v: v === null ? '—' : pct(v) }));
        b.addEventListener('click', () => { if (f.id !== PL.floorId()) PL.fl.go(f.id); });
        return b;
      }));
      if (!p.plan.rooms.length) root.hidden = true;
    };
    const compute = () => {
      pend = 0;
      const p = P();
      const a = PL.S.a;
      if (!a || !PL.multi() || PL.S.q !== 'full') return;
      try { data = WH.engine.analysis.building(p, { cell: 8, band: p.view.band, cache }); } catch (e) { PL.report(e, 'planner.building', { bug: true }); data = null; }
      doneFor = a;
      paint();
    };
    return {
      el: root,
      sync(q) {
        if (!PL.multi()) { root.hidden = true; data = null; doneFor = null; return; }
        if (q === 'coarse') return;   // while dragging: the last numbers, until the pointer rests
        if (PL.S.a && PL.S.a !== doneFor && !pend) pend = setTimeout(compute, 60);
        else paint();
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 0. the two key router actions: a compact bar pinned to the top of the sidebar (sticky on desktop), so
  //    "Find the best spot" and "Back to today's spot" are visible without scrolling even on a 1366x768 laptop.
  //    The Router card below keeps the secondary items (status, mark as today, allowed area, inlet distance).
  // ---------------------------------------------------------------------------------------------------------------
  function actionBar() {
    const find = ui().button({ i18n: 'planner.router.find', icon: 'sparkles', variant: 'primary', kbd: 'F', onClick: () => PL.findBest() });
    find.id = 'pl-find';
    find.classList.add('grow');
    const back = ui().button({ i18n: 'planner.router.back', icon: 'undo', kbd: 'D', onClick: () => PL.backToToday() });
    back.id = 'pl-back';
    back.classList.add('grow');
    // data-toast-avoid: a toast never sits on the two key buttons (phones: the bar is not sticky, toasts dock at the bottom)
    const bar = el('div.pl-actions', { role: 'group', 'data-toast-avoid': '', 'data-i18n-aria': 'planner.router.title', 'aria-label': t('planner.router.title') },
      el('div.row', find, ui().hint('optimize')),
      el('div.row', back, ui().hint('today')));
    syncs.push(() => {
      const p = P();
      const has = p.plan.rooms.length > 0;
      find.disabled = !!PL.S.opt || !has;
      back.disabled = !PL.moved();
    });
    return bar;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 3. router (secondary items; the primary actions live in actionBar())
  // ---------------------------------------------------------------------------------------------------------------
  function cardRouter() {
    const status = el('p.pl-status');
    const mark = ui().button({ i18n: 'planner.router.mark', icon: 'pin', size: 'sm', onClick: () => PL.markToday() });
    // (goal.allowedRoom is a room of the router's floor - SPEC 14.3)
    const allowed = selField({ i18n: 'planner.router.allowed', hint: 'allowedArea', undo: 'planner.undo.allowed', opts: () => [{ value: 'any', label: 'planner.router.anywhere' }, ...PL.routerPlan().rooms.map((r) => ({ value: r.roomId, label: r.name }))], get: () => P().goal.allowedRoom, set: (p, v) => { p.goal.allowedRoom = v === 'any' ? 'any' : Number(v); } });
    const inlet = el('span');
    // SPEC 14.3: the router stands on another floor - say which, and go there
    const goFloor = ui().button({ label: '—', icon: 'arrow-right', size: 'sm', variant: 'soft', onClick: () => PL.fl.go(P().net.routerFloor) });
    const floorRow = el('div.pl-rfloor', { hidden: true }, goFloor);
    const c = ui().card({ id: 'pl-router', i18n: 'planner.router.title', icon: 'router', hint: 'trial', body: [
      status, floorRow,
      el('div.cluster', el('span.row.gap-1', mark, ui().hint('baseline'))),
      allowed,
      el('div.pl-inlet', el('span.pl-inlet__ico', ui().icon('globe', 18)), el('div.grow', el('div.pl-inlet__t', el('span', t('planner.router.inletT')), ui().hint('inlet')), el('div.pl-inlet__d', inlet, ui().hint('cable')))),
    ] });
    syncs.push(() => {
      const p = P();
      const moved = PL.moved();
      const has = p.plan.rooms.length > 0;
      const here = PL.routerHere();
      const rr = WH.engine.project.roomAt(PL.routerPlan(), p.net.router);
      const room = (rr || {}).name || t('planner.tip.outside');
      status.textContent = !has ? t('planner.res.noplan') : moved ? t('planner.router.trial', { room, d: PL.m(PL.distM(p.net.router, p.net.baseline)) }) : t('planner.router.atToday', { room });
      floorRow.hidden = here || !PL.multi();
      if (!floorRow.hidden) {
        const fname = PL.floorName(p.net.routerFloor);
        status.textContent = t('planner.router.otherFloor', { floor: fname, room }) + ' ' + status.textContent;
        goFloor.querySelector('.btn__label').textContent = t('planner.fl.goFloor', { floor: fname });
      }
      mark.disabled = !moved;
      const d = PL.distM(p.net.router, p.net.optic);
      const lo = Math.max(1, Math.floor(d * 1.3));
      inlet.textContent = t('planner.router.inlet', { d: PL.m(d), lo, hi: Math.max(lo + 1, Math.ceil(d * 1.6)) });
      // the inlet on another floor than the router: the cable also goes through the ceiling
      if (PL.multi() && p.net.opticFloor && p.net.routerFloor && p.net.opticFloor !== p.net.routerFloor) inlet.textContent += ' ' + t('planner.router.inletFloor', { floor: PL.floorName(p.net.opticFloor) });
    });
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 4. measurements
  // ---------------------------------------------------------------------------------------------------------------
  function cardMeas() {
    // phones: straight into the measuring mode (full-height map + speed test); desktop: the measure tool
    const add = ui().button({ i18n: 'planner.m.add', icon: 'plus', variant: 'soft', kbd: 'M', block: true, onClick: () => PL.startMeasuring() });
    const list = el('div.pl-mlist');
    const cal = el('div.pl-cal');
    // the switch also chooses between the model tuned by the guide (model.fit) and the default one: rebuild the context
    const calSw = sw({ i18n: 'planner.m.calibrate', hint: 'calibration', get: () => P().view.calibrate !== false, set: (v) => { PL.S.geomDirty = true; PL.setView({ calibrate: v }); } });
    // "Prvotní měření" (SPEC 9): the guided way to measure, opens / resumes the guide
    const cta = PL.calib && PL.calib.cta ? PL.calib.cta() : null;
    if (cta) syncs.push(() => cta.sync());
    // SPEC 8: "Info o zařízení" (27-devinfo-ui.js) next to "Přidat měření"
    const info = PL.devInfoButton ? PL.devInfoButton({ variant: 'ghost' }) : null;
    // SPEC 10: what the moved router / the second node would do at the measured points
    const wi = PL.wi.section();
    syncs.push((q) => wi.sync(q));
    // dots on a wall line / off the floor (SPEC 10): one button for all of them
    const offBox = el('div.notice.notice--warn.pl-moffall', { hidden: true });
    // SPEC 13: measurements saved without knowing their band (older ones): how many, fixed one by one in the list
    const nbBox = el('div.notice.notice--warn.pl-mnbAll', { hidden: true });
    const c = ui().card({ id: 'pl-meas', i18n: 'planner.m.title', icon: 'antenna', hint: 'measurement', body: [
      el('p.text-sm.text-ink2', t('planner.m.intro')), cta, el('div.pl-madd', add, info), wi.el, offBox, nbBox, list, cal, calSw, deviceField('planner.m.deviceGoal')].filter(Boolean) });
    measCard = c;
    measCard._wi = wi.el;
    let key = '';
    syncs.push(() => {
      const p = P();
      const S = PL.S;
      c.setBadge(p.measurements.length || null);
      add.setAttribute('aria-pressed', String(S.tool === 'measure'));
      const k = [S.measVer, S.offsKey, WH.i18n.lang, p.view.band, p.view.palette, p.view.calibrate, S.planVer, S.badges > 0].join('|');
      if (k === key) return;
      key = k;
      const fid = document.activeElement && list.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      const C = S.cal || {};
      const filled = p.measurements.some((m) => !Number.isFinite(m.value)) && PL.S.ctx ? PL.filledMeasurements() : null;
      const multiDev = new Set(p.measurements.map((m) => String(m.device || '').toLowerCase())).size > 1;
      const offIds = p.measurements.filter((m) => PL.measOff(m)).map((m) => m.id);
      offBox.hidden = offIds.length < 2;
      if (!offBox.hidden) offBox.replaceChildren(ui().icon('warning', 18), el('div.stack.gap-2', el('span', t('planner.wi.offAll')), el('div', ui().button({ i18n: 'planner.wi.offAllBtn', icon: 'move', size: 'sm', onClick: () => PL.moveInside(offIds) }))));
      const unver = p.measurements.filter((m) => !PL.bands.verified(m)).length;
      nbBox.hidden = unver < 2;
      if (!nbBox.hidden) nbBox.replaceChildren(ui().icon('warning', 18), el('span', t('planner.bd.unverifiedAll', { n: unver }), ' ', ui().hint('bandAuto')));
      list.classList.toggle('has-no', S.badges > 0);
      list.replaceChildren(...(p.measurements.length ? p.measurements.map((m, i) => {
        const sig = Number.isFinite(m.value);
        // SPEC 13: "5 GHz (+6 GHz MLO)", "≈ 5 GHz (odhad)" or a band nobody confirmed
        const bi = PL.bands.info(m);
        const Cb = bi.band ? C[bk(bi.band)] : null;
        const u = Cb && Cb.used && Cb.used.find((x) => x.id === m.id);
        const res = u ? u.residual - (p.view.calibrate === false ? 0 : Cb.offset) : null;
        // speed-only point: "signal estimated" (+ the model's value the speed map uses for it)
        const est = !sig && filled && filled[i] && filled[i].id === m.id && Number.isFinite(filled[i].value) ? filled[i].value : null;
        const sigTxt = sig ? WH.util.dbm(m.value) : est !== null ? t('planner.m.sigEstimatedV', { v: WH.util.dbm(est) }) : t('planner.m.sigEstimated');
        const sub = [el('span' + (sig ? '' : '.pl-est'), `${sigTxt} · `, el('span.pl-mband' + (bi.kind === 'auto' ? '.is-est' : ''), bi.text))];
        if (m.download !== null || m.upload !== null) sub.push(el('span.pl-sp', ui().icon('download', 16), PL.mbps(m.download), ui().icon('upload', 16), PL.mbps(m.upload)));
        if (Number.isFinite(m.ping)) sub.push(el('span', t('planner.m.ping', { v: WH.util.fmt(m.ping, 0) })));
        if (multiDev) sub.push(el('span.pl-mdev', PL.icon(PL.dev.iconOf(m.device), 16), PL.dev.label(m.device)));
        if (res !== null && Number.isFinite(res)) sub.push(el('span' + (u.outlier ? '.pl-mout' : ''), t(u.outlier ? 'planner.m.outlier' : 'planner.m.residual', { d: PL.db(res) })));
        // SPEC 8: the Wi-Fi details the measurement was taken with ("„Doma“ · kanál 36 · linka 1 201 Mb/s"; the band is above)
        if (m.wifi && PL.wifiLine) { const wl = PL.wifiLine(m.wifi, { noBand: true }); if (wl) sub.push(el('span.pl-mwifi', ui().icon('wifi', 16), el('span.truncate', wl))); }
        const edit = ui().iconButton({ icon: 'edit', tip: 'planner.m.edit', size: 'sm', onClick: () => PL.openMeasure(m, m.id) });
        const del = ui().iconButton({ icon: 'trash', tip: 'ui.delete', size: 'sm', onClick: () => PL.deleteMeas(m.id) });
        edit.dataset.f = 'e' + m.id;
        del.dataset.f = 'd' + m.id;
        const dot = sig ? el('i.pl-mdot', { style: { background: `rgb(${WH.engine.raster.signalColor(m.value, p.view.palette)})` } }) : el('i.pl-mdot.is-nosig');
        // on a wall line / off the floor: say so and offer the (undoable) fix right here
        const off = offIds.includes(m.id);
        const fix = off ? el('div.pl-moff', ui().icon('warning', 16), el('span', t('planner.wi.off')), ui().button({ i18n: 'planner.wi.offBtn', size: 'sm', variant: 'ghost', onClick: () => PL.moveInside([m.id]) })) : null;
        // saved without knowing its band: a badge + the quick fix (pick the band / read it from the helper now)
        let nbFix = null;
        if (bi.kind === 'none') {
          const fb = ui().button({ i18n: 'planner.bd.fixBtn', icon: 'edit', size: 'sm', variant: 'ghost' });
          fb.dataset.f = 'b' + m.id;
          fb.setAttribute('aria-haspopup', 'menu');
          fb.addEventListener('click', () => PL.bands.fix(fb, m));
          const bd = ui().badge(t('planner.bd.unverified'), 'warn');
          bd.title = t('planner.bd.unverifiedTip');
          nbFix = el('div.pl-moff.pl-mnb', bd, fb);
        }
        return el('div.pl-mrow' + (bi.band !== p.view.band && p.view.band !== 'auto' ? '.is-other' : ''), el('span.pl-mrow__no', { 'aria-hidden': 'true' }, String(i + 1)), dot,
          el('div.pl-mrow__main', el('div.pl-mrow__t.truncate', m.name), el('div.pl-mrow__s', sub), fix, nbFix), edit, del);
      }) : [el('p.text-sm.text-muted', t('planner.m.empty'))]));
      if (fid) { const n = list.querySelector(`[data-f="${CSS.escape(fid)}"]`); (n || add).focus({ preventScroll: true }); }
      const lines = [];
      for (const b of WH.engine.BANDS) {
        const r = C[bk(b)];
        if (!r || !r.n) continue;
        const bl = `${PL.band(b)} ${t('planner.ghz')}`;
        if (r.suspicious) lines.push(el('div.notice.notice--warn', ui().icon('warning', 18), el('span', t('planner.cal.suspicious', { b: bl, d: PL.db(r.offset) }))));
        else {
          let s = t(r.n > 1 ? 'planner.cal.ok' : 'planner.cal.single', { b: bl, d: PL.db(r.offset), rms: WH.util.fmt(r.rms, 0), n: r.n });
          if (r.fallback) s += ' ' + t('planner.cal.fallback');
          if (p.view.calibrate === false) s += ' ' + t('planner.cal.off');
          lines.push(el('div.pl-calrow', ui().icon('check-circle', 16), el('span', s)));
        }
      }
      cal.replaceChildren(...(lines.length ? [el('div.pl-cap', el('span', t('planner.cal.title')), ui().hint('residual')), ...lines] : []));
    });
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 5. more access points (SPEC 14.2): AP / mesh / repeater - any number (≤ 8 in the building), each with its own row
  // ---------------------------------------------------------------------------------------------------------------
  let nodesCard = null;
  let revealId = null;
  const KINDS = ['ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater'];
  const HELP = { ap_cable: 'apCable', mesh_cable: 'meshCable', mesh_wifi: 'meshWifi', repeater: 'repeater' };
  const bandsText = (bs) => WH.engine.BANDS.filter((b) => bs && bs[bk(b)]).map((b) => PL.band(b)).join(' + ') + WH.util.NBSP + t('planner.ghz');

  function cardNodes() {
    const N = PL.nodes;
    const list = el('div.pl-nlist', { role: 'list' });
    const empty = el('p.text-sm.text-ink2.pl-nempty', t('planner.nodes.empty'));
    const add = ui().button({ i18n: 'planner.nodes.add', icon: 'plus', variant: 'soft', block: true, onClick: () => N.menu(add) });
    add.setAttribute('aria-haspopup', 'menu');
    const maxNote = el('p.text-xs.text-muted', { hidden: true });
    // "How many access points do I need, and where?" (engine optimize.howMany): a goal share of the home with good signal
    let sugGoal = 90;
    let sugBusy = false;
    let sugFor = null;   // what the shown result was computed for (sugKey); another key hides it
    let sugAc = null;
    let sugRun = null;   // the key a running search started with
    // everything the suggestion depends on (like the router search's optKey)
    const sugKey = () => {
      const q = P();
      return [q.view.band, sugGoal, JSON.stringify(q.goal), JSON.stringify(q.net), JSON.stringify(PL.allNodes().map((x) => [x.floor, x.node.pos, x.node.enabled, x.node.mode])),
        JSON.stringify((q.floors || []).map((f) => [f.id, f.level, f.ceiling])), PL.S.planVer, JSON.stringify(PL.S.offs)].join('|');
    };
    const sugOut = el('div.pl-nsug.stack', { hidden: true, style: { '--gap': '6px' }, 'aria-live': 'polite' });
    const sugGoalSeg = ui().segmented([{ value: '80', label: '80 %' }, { value: '90', label: '90 %' }, { value: '95', label: '95 %' }], { value: '90', size: 'sm', aria: 'planner.nodes.suggest.goal', onChange: (v) => { sugGoal = Number(v); sugOut.hidden = true; } });
    const sugBtn = ui().button({ i18n: 'planner.nodes.suggest', icon: 'sparkles', variant: 'ghost', block: true, onClick: () => runSuggest() });
    async function runSuggest() {
      if (sugBusy) return;
      sugBusy = true;
      sugBtn.disabled = true;
      sugOut.hidden = false;
      sugFor = null;
      sugOut.replaceChildren(el('p.text-sm.text-muted', t('planner.nodes.suggest.busy')));
      const key = sugKey();
      sugRun = key;
      sugAc = new AbortController();
      const ac = sugAc;
      try {
        const p = P();
        const r = await WH.engine.optimize.howMany(p, { goal: sugGoal, cell: 8, band: p.view.band, offsets: { ...PL.S.offs } }, { signal: ac.signal });
        // the project changed while it was thinking: the answer belongs to something else
        if (ac.signal.aborted || key !== sugKey()) { sugOut.hidden = true; return; }
        sugFor = key;
        // the places that count: the target room ("Cíl") or the whole home
        const target = p.goal.room !== 'all' && PL.roomName(p.goal.room) ? PL.roomName(p.goal.room) : '';
        const tk = (k) => (target ? k + 'Room' : k);
        const f = (v) => WH.util.fmt(Math.round(v), 0);
        const rows = [];
        if (!r.steps.length && r.reached) {
          rows.push(el('p.text-sm', t(tk('planner.nodes.suggest.enough'), { c: f(r.today), g: f(r.goal), room: target })));
        } else if (!r.steps.length) {
          rows.push(el('p.text-sm', t(tk('planner.nodes.suggest.none'), { c: f(r.today), room: target })));
        } else {
          const where = r.steps.map((st) => {
            const fl = Array.isArray(p.floors) && p.floors.length > 1 ? PL.floorName(st.floor) : '';
            const pf = st.floor && Array.isArray(p.floors) ? WH.engine.project.atFloor(p, st.floor) : p;
            const room = WH.engine.project.roomAt(pf.plan, st.pos);
            return [fl, room ? room.name : ''].filter(Boolean).join(' · ') || t('planner.nodes.suggest.somewhere');
          });
          rows.push(el('p.text-sm', t(tk(r.reached ? 'planner.nodes.suggest.need' : 'planner.nodes.suggest.short'), { k: r.steps.length, g: f(r.goal), a: WH.util.fmt(r.today, 1), b: WH.util.fmt(r.coverage, 1), where: where.join('; '), room: target })));
          const apply = ui().button({ label: t('planner.nodes.suggest.apply', { k: r.steps.length }), icon: 'plus', size: 'sm', variant: 'soft', onClick: () => {
            if (sugFor !== sugKey()) { sugOut.hidden = true; return; } // stale: never add APs computed for another state
            PL.nodes.addPlanned(r.steps);
            sugOut.hidden = true;
          } });
          rows.push(apply, el('p.text-xs.text-muted', t('planner.nodes.suggest.note')));
        }
        sugOut.replaceChildren(...rows);
      } catch (e) {
        if (e && e.name === 'AbortError') { sugOut.hidden = true; return; }
        PL.report(e, 'nodes.suggest');
        sugOut.replaceChildren(el('p.text-sm', t('planner.nodes.suggest.fail')));
      } finally {
        if (sugAc === ac) sugAc = null;
        sugBusy = false;
        sugBtn.disabled = !PL.nodes.canAdd() || !P().plan.rooms.length;
      }
    }
    const sugBox = el('div.pl-nsugbox.stack', { style: { '--gap': '6px' } }, el('div.row.gap-1', sugBtn, sugGoalSeg), sugOut);
    const c = ui().card({ id: 'pl-nodes', i18n: 'planner.nodes.title', icon: 'node', hint: 'nodesList', open: false, body: [empty, list, add, sugBox, maxNote] });
    nodesCard = c;
    const rows = new Map();
    let order = '';
    syncs.push((q) => {
      const all = PL.allNodes();
      const on = all.filter((x) => x.node.enabled).length;
      c.setBadge(all.length ? (on === all.length ? all.length : `${on}/${all.length}`) : null);
      empty.hidden = all.length > 0;
      add.disabled = !N.canAdd() || !P().plan.rooms.length;
      if (!sugBusy) sugBtn.disabled = add.disabled;
      // a result (or a run) for a state that is gone: hide it / stop it
      if (sugBusy && sugAc && sugRun !== sugKey()) sugAc.abort();
      if (!sugBusy && !sugOut.hidden && sugFor !== null && sugFor !== sugKey()) { sugOut.hidden = true; sugFor = null; }
      maxNote.hidden = N.canAdd();
      if (!maxNote.hidden) maxNote.textContent = t('planner.nodes.max', { n: N.max() });
      const ids = all.map((x) => x.node.id);
      for (const id of [...rows.keys()]) if (!ids.includes(id)) { rows.get(id).el.remove(); rows.delete(id); }
      for (const id of ids) if (!rows.has(id)) rows.set(id, nodeRow(id));
      const k = ids.join(',');
      if (k !== order) { order = k; list.replaceChildren(...ids.map((id) => rows.get(id).el)); }
      for (const x of all) rows.get(x.node.id).sync(q, x);
      if (revealId && rows.has(revealId)) { const r = rows.get(revealId); revealId = null; requestAnimationFrame(() => r.reveal()); }
    });
    return c;
  }

  /** One node's row: a header (icon, name, what it is and how it is linked, on / off, delete) and its settings below
   *  (open for the selected node - a click on the row or on its marker). The row's controls keep their own sync list. */
  function nodeRow(id) {
    const N = PL.nodes;
    const nd = () => N.ref(P(), id);
    const TOP = N.TOPICS;
    const own = [];
    const saved = syncs;
    syncs = own;
    const ico = el('span.pl-nrow__ico');
    const name = el('span.pl-nrow__name.truncate');
    const sub = el('span.pl-nrow__sub');
    const bodyId = WH.util.uid('pl-nrow');
    const main = el('button.pl-nrow__main', { type: 'button', 'aria-expanded': 'false', 'aria-controls': bodyId }, ico, el('span.pl-nrow__txt', name, sub), el('span.pl-nrow__chev', ui().icon('chevron-down', 16)));
    main.addEventListener('click', () => N.select(N.selected() === id ? null : id));
    const onSw = ui().switch({ checked: true, onChange: (v) => N.toggle(id, v) });
    onSw.classList.add('pl-nrow__sw');
    const del = ui().iconButton({ icon: 'trash', tip: 'planner.nodes.delete', size: 'sm', onClick: () => N.remove(id) });
    // name (an own name stays; the default "AP 3" follows the type)
    const nameIn = el('input.input', { type: 'text', maxlength: '50', autocomplete: 'off', spellcheck: 'false' });
    nameIn.addEventListener('change', () => {
      const v = nameIn.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 50);
      if (!v) { nameIn.value = PL.nodeName(nd()); return; }
      N.patch(id, (n) => { if (n.name === v) return false; n.name = v; return undefined; }, 'planner.undo.nodeName');
    });
    own.push(() => { const n = nd(); if (n && !focused(nameIn)) nameIn.value = PL.nodeName(n); });
    const nameF = ui().field({ i18n: 'planner.nodes.name', control: nameIn });
    // type
    const modeHint = ui().hint('apCable');
    const mode = ui().select(KINDS.map((m) => ({ value: m, label: `planner.node.${m}` })), {
      value: (nd() || {}).mode || 'ap_cable',
      onChange: (v) => N.patch(id, (n) => {
        if (n.mode === v) return false;
        n.mode = v;
        const nn = N.defaultName(n.name, v);
        if (nn) n.name = nn;
        return undefined;
      }, 'planner.undo.nodeType'),
    });
    own.push(() => {
      const n = nd();
      if (!n) return;
      if (!focused(mode)) mode.value = n.mode;
      if (modeHint.getAttribute('data-hint') !== HELP[n.mode]) {
        modeHint.setAttribute('data-hint', HELP[n.mode]);
        modeHint.setAttribute('aria-label', t('ui.hint.about', { topic: t(`help.${HELP[n.mode]}.t`) }));
      }
    });
    const modeF = ui().field({ i18n: 'planner.node.mode', control: [mode, modeHint] });
    // bands
    const bands = el('div.cluster.pl-nbands', WH.engine.BANDS.map((b) => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        const ok = N.patch(id, (n) => {
          const bs = { ...n.bands, [bk(b)]: cb.checked };
          if (!Object.values(bs).some(Boolean)) return false;
          n.bands = bs;
          if (!bs[bk(n.backhaulBand)]) n.backhaulBand = [5, 2.4, 6].find((x) => bs[bk(x)]);
          return undefined;
        }, 'planner.undo.node');
        const n = nd();
        if (!ok && !cb.checked && n && n.bands[bk(b)]) { cb.checked = true; ui().toast({ i18n: 'planner.node.oneBand' }, { kind: 'warn' }); }
      });
      own.push(() => { const n = nd(); if (n) cb.checked = !!n.bands[bk(b)]; });
      return el('label.check', cb, el('span', `${PL.band(b)} ${t('planner.ghz')}`), ui().hint(b === 2.4 ? 'band24' : `band${b}`));
    }));
    const set = (fn) => (p, v) => { const n = N.ref(p, id); if (n) fn(n, v); };
    const get = (fn, dflt) => () => { const n = nd(); return n ? fn(n) : dflt; };
    const power = slider({ i18n: 'planner.node.power', hint: 'power', min: -10, max: 6, step: 1, fmt: (v) => PL.db(v), undo: 'planner.undo.node', topics: TOP, get: get((n) => n.power, 0), set: set((n, v) => { n.power = v; }) });
    // its uplink: the router or another node (any floor, never one behind it - no cycles)
    const uplink = selField({ i18n: 'planner.nodes.uplink', hint: 'uplink', undo: 'planner.undo.nodeUplink', topics: TOP, opts: () => N.uplinkOptions(id), get: get((n) => n.uplink || 'router', 'router'), set: set((n, v) => { n.uplink = v; }) });
    // SPEC 14.3: which floor it stands on (a home with floors) - moved there at the same spot, snapped onto that floor
    const floorF = selField({
      i18n: 'planner.nodes.floor', hint: 'floorSwitch', undo: 'planner.undo.nodeFloor', topics: ['nodes', 'floors', 'plan'],
      opts: () => PL.floorList().slice().reverse().map((f) => ({ value: f.id, label: f.name })),
      get: () => { const x = PL.nodeById(id); return (x && x.floor) || PL.floorId() || ''; },
      set: (p, v) => { WH.engine.project.moveNodeToFloor(p, id, v); },
    });
    const bh = selField({ i18n: 'planner.node.bhBand', hint: 'backhaul', undo: 'planner.undo.node', topics: TOP, opts: () => { const n = nd(); return WH.engine.BANDS.filter((b) => n && n.bands[bk(b)]).map((b) => ({ value: b, label: `${PL.band(b)} ${t('planner.ghz')}` })); }, get: get((n) => n.backhaulBand, 5), set: set((n, v) => { n.backhaulBand = Number(v); }) });
    const thr = slider({ i18n: 'planner.node.bhThr', min: -80, max: -55, step: 1, fmt: (v) => WH.util.dbm(v), undo: 'planner.undo.node', topics: TOP, get: get((n) => n.backhaulThreshold, -65), set: set((n, v) => { n.backhaulThreshold = v; }) });
    const bhLine = el('div.notice', { hidden: true });
    const wireless = el('div.stack', bh, thr, bhLine);
    // SPEC 10: the node's real ceiling ("Kolik zvládne") and the speed its link allows
    const maxF = numField({ i18n: 'planner.node.max', hint: 'nodeMax', unit: 'planner.mbps', min: 10, max: 10000, step: 1, ph: '—', undo: 'planner.undo.nodeMax', topics: TOP, get: get((n) => (Number.isFinite(n.maxMbps) ? n.maxMbps : null), null), set: set((n, v) => { n.maxMbps = v; }) });
    maxF.classList.add('pl-nmax');
    const bhSpeed = el('p.pl-bhspeed', { hidden: true });
    const show = ui().button({ label: '—', icon: 'target', size: 'sm', variant: 'ghost', onClick: () => PL.showNode(id) });
    const dragTip = el('p.text-xs.text-muted', t('planner.nodes.drag'));
    const body = el('div.stack.pl-nrow__body', { id: bodyId, hidden: true }, nameF, modeF, floorF, ui().field({ i18n: 'planner.node.bands', control: bands }), power, uplink, wireless, maxF, bhSpeed, el('div.pl-nrow__foot', show), dragTip);
    const root = el('div.pl-nrow', { role: 'listitem' }, el('div.pl-nrow__head', main, onSw, del), body);
    syncs = saved;
    let icoKey = '';
    let rowKey = '';
    return {
      el: root,
      reveal() {
        try { root.scrollIntoView({ block: 'nearest', behavior: WH.util.prefersReducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ }
        try { main.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      },
      sync(q, x) {
        const n = x.node;
        const open = PL.nodes.selected() === id;
        const nm = PL.nodeName(n);
        const wl = PL.nodeWireless(n.mode);
        const serving = PL.nodeList().some((y) => y.id === id);
        const info = PL.nodes.info(id);
        // header: the type's icon, the name and one line about it ("Mesh přes Wi-Fi · 2,4 + 5 GHz · Wi-Fi k routeru · −62 dBm")
        if (icoKey !== n.mode) { icoKey = n.mode; ico.replaceChildren(ui().icon(PL.nodeIcon(n.mode), 18)); }
        const upName = n.uplink && n.uplink !== 'router' ? (PL.nodeById(n.uplink) ? PL.nodeName(PL.nodeById(n.uplink).node) : '') : '';
        const parts = [t('planner.node.' + n.mode), bandsText(n.bands), t(`planner.nodes.sub${wl ? 'Wifi' : 'Cable'}${upName ? 'N' : 'R'}`, { up: upName })];
        let warn = '';
        if (!n.enabled) warn = t('planner.nodes.off');
        else if (!serving) warn = t('planner.nodes.chainOff');
        else if (wl && info && Number.isFinite(info.backhaul)) parts.push(`${WH.util.dbm(info.backhaul)} · ${PL.qWord(info.backhaul)}`);
        if (PL.multi() && !x.active) parts.push(t('planner.nodes.subFloor', { floor: x.floorName }));
        const rk = JSON.stringify([nm, parts, warn, info && info.weakBackhaul, open, n.enabled, WH.i18n.lang]);
        if (rk !== rowKey) {
          rowKey = rk;
          name.textContent = nm;
          sub.replaceChildren(...[el('span', parts.join(' · ')), warn ? el('span.pl-nrow__warn', ` · ${warn}`) : null].filter(Boolean));
          sub.classList.toggle('is-weak', !!(info && info.weakBackhaul && n.enabled));
          root.classList.toggle('is-sel', open);
          root.classList.toggle('is-off', !n.enabled);
          main.setAttribute('aria-expanded', String(open));
          main.setAttribute('aria-label', t('planner.nodes.rowAria', { name: nm, what: parts.join(', ') + (warn ? `, ${warn}` : '') }));
          onSw.input.setAttribute('aria-label', t('planner.nodes.onAria', { name: nm }));
          del.setAttribute('aria-label', t('planner.nodes.delAria', { name: nm }));
          show.querySelector('.btn__label').textContent = x.active || !PL.multi() ? t('planner.nodes.show') : t('planner.nodes.showFloor', { floor: x.floorName });
        }
        onSw.setChecked(n.enabled);
        body.hidden = !open;
        if (!open) return;
        for (const f of own) f(q);
        floorF.hidden = !PL.multi();
        wireless.hidden = !wl;
        // the wireless uplink's quality (dBm) - from the latest analysis
        bhLine.hidden = !wl || !info || !Number.isFinite(info.backhaul);
        if (!bhLine.hidden) {
          const ok = !info.weakBackhaul;
          const up = upName || t('planner.nodes.withRouter');   // "Spojení s routerem" (instrumental)
          bhLine.className = 'notice notice--' + (ok ? 'ok' : 'warn');
          bhLine.replaceChildren(ui().icon(ok ? 'check-circle' : 'warning', 18), el('span', t(ok ? 'planner.nodes.bhOk' : 'planner.nodes.bhWeak', { up, v: WH.util.dbm(info.backhaul), q: PL.qWord(info.backhaul) })));
        }
        // the speed of its uplink chain ("Propojení ≈ 280 Mb/s") and its own ceiling - once the pointer rests (the links
        // are computed per analysis; a drag frame keeps the last text)
        if (q === 'coarse') return;
        const mx = Number.isFinite(n.maxMbps) ? n.maxMbps : null;
        const maxTxt = mx !== null ? ' ' + t('planner.node.maxOnly', { v: PL.mbps(mx) }) : '';
        const lk = serving ? PL.wi.linkOf(id) : null;
        const bs = lk && lk.known && Number.isFinite(lk.down) ? lk.down : NaN;
        let txt = '';
        if (!serving) txt = '';
        else if (!wl && !upName) txt = t('planner.node.bhCable') + maxTxt;
        else if (Number.isFinite(bs)) txt = mx !== null && mx < bs ? t('planner.node.bhSpeedMax', { v: PL.mbps(bs), m: PL.mbps(mx) }) : t('planner.node.bhSpeedCap', { v: PL.mbps(bs) });
        else if (!wl) txt = t('planner.nodes.bhViaNode', { up: upName }) + maxTxt;
        else txt = lk && lk.reason === 'weak' ? t('planner.node.bhTooWeak') : t('planner.node.bhNoCurve') + maxTxt;
        if (txt && lk && lk.hops > 1) txt += ' ' + t('planner.nodes.hops', { n: lk.hops });
        bhSpeed.hidden = !txt;
        bhSpeed.textContent = txt;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 6. speed target
  // ---------------------------------------------------------------------------------------------------------------
  function cardSpeed() {
    const num = (i18n, hint, get, set, o) => numField(Object.assign({ i18n, hint, get, set, undo: 'planner.undo.speed', unit: 'planner.mbps', min: 1, max: 10000, step: 1 }, o));
    const rate = (r) => (r >= 1000 ? `${WH.util.fmt(r / 1000, r % 1000 ? 1 : 0)} ${t('planner.gbps')}` : `${r} ${t('planner.mbps')}`);
    const rates = () => [{ value: '', label: 'planner.speed.unknown' }, ...WH.engine.project.WAN_RATES.map((r) => ({ value: r, label: rate(r) }))];
    const port = (i18n, hint, prop) => selField({ i18n, hint, undo: 'planner.undo.speed', opts: rates, get: () => (P().net[prop] === null ? '' : P().net[prop]), set: (p, v) => { p.net[prop] = v === '' ? null : Number(v); } });
    const cats = () => WH.engine.project.CABLE_CATEGORIES.map((c) => ({ value: c, label: c === 'unknown' ? 'planner.speed.unknown' : c.replace('cat', 'Cat') }));
    const limit = el('p.pl-limit');
    const warns = el('div.stack.gap-2');
    const show = ui().button({ i18n: 'planner.speed.show', icon: 'speed', size: 'sm', onClick: () => PL.setView({ layer: 'speed' }) });
    const det = el('details.disclosure.pl-disc',
      el('summary', ui().icon('cable', 18), el('span', t('planner.speed.link')), ui().hint('wan')),
      el('div.disclosure__body.stack',
        port('planner.speed.wanPort', 'wanPort', 'wanPort'), port('planner.speed.ontPort', 'ontPort', 'ontPort'), port('planner.speed.wanLink', 'link', 'wanLink'),
        selField({ i18n: 'planner.speed.cat', hint: 'cableCategory', undo: 'planner.undo.speed', opts: cats, get: () => P().net.cableCategory, set: (p, v) => { p.net.cableCategory = v; } }),
        numField({ i18n: 'planner.speed.len', hint: 'cable', unit: 'planner.unit.m', min: 0.1, max: 500, step: 0.1, d: 1, ph: '—', undo: 'planner.undo.speed', get: () => P().net.cableLength, set: (p, v) => { p.net.cableLength = v; } })));
    const c = ui().card({ id: 'pl-speed', i18n: 'planner.speed.title', icon: 'speed', hint: 'speedView', open: false, body: [
      el('p.text-sm.text-ink2', t('planner.speed.intro')),
      deviceField('planner.m.deviceGoal'),
      el('div.field-grid', num('planner.speed.tDown', 'speedTarget', () => P().goal.targetDown, (p, v) => { p.goal.targetDown = v; }, { req: true }), num('planner.speed.tUp', null, () => P().goal.targetUp, (p, v) => { p.goal.targetUp = v; }, { req: true })),
      slider({ i18n: 'planner.speed.reserve', hint: 'reserve', min: 0, max: 80, step: 5, fmt: (v) => WH.util.fmtPct(v), get: () => P().goal.reserve, set: (p, v) => { p.goal.reserve = v; }, undo: 'planner.undo.speed', topics: ['goal'] }),
      el('div.field-grid', num('planner.speed.wanDown', 'plan', () => P().net.wanDown, (p, v) => { p.net.wanDown = v; }, { min: 0, ph: '—' }), num('planner.speed.wanUp', null, () => P().net.wanUp, (p, v) => { p.net.wanUp = v; }, { min: 0, ph: '—' })),
      det, limit, warns, show] });
    syncs.push(() => {
      const p = P();
      const n = p.net;
      const g = p.goal;
      const k = 1 - g.reserve / 100;
      const link = WH.engine.speed.linkLimit(n);
      const cd = Math.min(n.wanDown === null ? Infinity : n.wanDown, link) * k;
      const cu = Math.min(n.wanUp === null ? Infinity : n.wanUp, link) * k;
      const f = (v) => (Number.isFinite(v) ? PL.mbps(v) : '—');
      limit.textContent = Number.isFinite(cd) || Number.isFinite(cu) ? t('planner.speed.limit', { d: f(cd), u: f(cu), r: WH.util.fmtPct(g.reserve) }) : t('planner.speed.noLimit');
      const w = [];
      if ((Number.isFinite(cd) && cd < g.targetDown) || (Number.isFinite(cu) && cu < g.targetUp)) w.push('planner.speed.cant');
      if (n.cableCategory === 'cat5') w.push('planner.speed.cat5');
      if (n.cableLength !== null && n.cableLength > 100) w.push('planner.speed.long');
      const wk = w.join() + WH.i18n.lang;
      if (warns._k !== wk) { warns._k = wk; warns.replaceChildren(...w.map((x) => el('div.notice.notice--warn', ui().icon('warning', 18), el('span', t(x))))); }
      show.hidden = p.view.layer === 'speed';
    });
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 7. advanced
  // ---------------------------------------------------------------------------------------------------------------
  function cardAdv() {
    const E = WH.engine;
    const dbm = (v) => WH.util.dbm(v);
    const mdl = (i18n, hint, prop, min, max, step, fmt) => slider({ i18n, hint, min, max, step, fmt, get: () => P().model[prop], set: (p, v) => { p.model[prop] = Math.round(v * 10) / 10; }, undo: 'planner.undo.model', topics: ['model'] });
    // SPEC 14.1: typing the real width sets AND verifies the scale (method 'width')
    const width = numField({
      i18n: 'planner.adv.width', hint: 'scale', unit: 'planner.unit.m', min: 1, max: 200, step: 0.1, d: 0, req: true, undo: 'planner.undo.scale', topics: ['scale'],
      off: () => !P().plan.rooms.length,
      get: () => (P().plan.rooms.length ? Math.round(E.project.widthFromMpp(P().plan, P().scale.mpp) * 10) / 10 : null),
      set: (p, v) => { if (p.plan.rooms.length) E.project.setScale(p, { mpp: E.project.deriveMpp(p.plan, v), method: 'width', ref: { metres: v } }); },
    });
    // what the scale makes of the flat ("≈ 58,3 m², největší Obývák 24,1 m²") and whether anybody checked it
    const areaTxt = el('span');
    const areaLine = el('div.field__hint.pl-area', areaTxt);
    width.append(areaLine);
    const scaleBtn = ui().button({ i18n: 'planner.scale.set', icon: 'ruler', size: 'sm', onClick: () => PL.scale.open() });
    const scaleRow = el('div.pl-scalerow', el('span.pl-scalerow__state'), scaleBtn);
    syncs.push((q) => {
      if (q === 'coarse') return;
      const ar = PL.scale.area();
      areaLine.hidden = !ar || !(ar.areaM2 > 0);
      if (!areaLine.hidden) areaTxt.textContent = ar.largest ? t('planner.scale.area', { a: PL.scale.fmt(ar.areaM2), room: ar.largest.name, r: PL.scale.fmt(ar.largest.areaM2) }) : t('planner.scale.areaOnly', { a: PL.scale.fmt(ar.areaM2) });
      const ok = PL.scale.verified();
      const stt = scaleRow.firstChild;
      stt.className = 'pl-scalerow__state ' + (ok ? 'is-ok' : 'is-warn');
      stt.replaceChildren(ui().icon(ok ? 'check-circle' : 'warning', 16), el('span', t(ok ? 'planner.scale.ok' : 'planner.scale.badge')));
      scaleRow.hidden = !P().plan.rooms.length;
    });
    const ceil = ceilingSection();
    syncs.push((q) => ceil.sync(q));
    const roomsBox = el('div.pl-roomchecks');
    const checks = new Map();
    let rk = '';
    syncs.push(() => {
      const p = P();
      const k = p.plan.rooms.map((r) => r.roomId + ':' + r.name).join('|');
      if (k !== rk) {
        rk = k;
        checks.clear();
        roomsBox.replaceChildren(...p.plan.rooms.map((r) => {
          const cb = el('input', { type: 'checkbox' });
          const id = r.roomId;
          cb.addEventListener('change', () => {
            const ok = commit('planner.undo.rooms', (pr) => {
              const ex = new Set(pr.goal.excluded);
              if (cb.checked) ex.delete(id); else ex.add(id);
              if (ex.size >= pr.plan.rooms.length) return false;
              pr.goal.excluded = [...ex].sort((x, y) => x - y);
            }, ['goal']);
            if (!ok && !cb.checked) { cb.checked = true; ui().toast({ i18n: 'planner.adv.lastRoom' }, { kind: 'warn' }); }
          });
          checks.set(id, cb);
          return el('label.check', cb, el('span.truncate', r.name));
        }));
        if (!p.plan.rooms.length) roomsBox.append(el('p.text-sm.text-muted', t('planner.res.noplan')));
      }
      const ex = new Set(p.goal.excluded);
      for (const [id, cb] of checks) cb.checked = !ex.has(id);
    });
    const reset = ui().button({
      i18n: 'planner.adv.reset', icon: 'refresh', size: 'sm',
      onClick: () => {
        if (commit('planner.undo.resetModel', (p) => { p.model = E.project.defaults(WH.i18n.lang).model; }, ['model'])) {
          ui().toast({ i18n: 'planner.adv.resetDone', action: { i18n: 'ui.undo', fn: () => { if (WH.store.labels().undo === 'planner.undo.resetModel') WH.store.undo(); } } }, { kind: 'ok' });
        }
      },
    });
    // the default wall loss is the 5 GHz value; show what it becomes on the other bands (SPEC 7.1)
    const wall = mdl('planner.adv.wall', 'wallLoss', 'wallLoss', 0, 20, 1, (v) => PL.db(v).replace('+', ''));
    const wallBands = el('div.field__hint.pl-wallbands');
    wall.append(wallBands);
    syncs.push(() => {
      const v = P().model.wallLoss;
      const f = (b) => WH.util.fmt(Math.round(v * PL.bandK(b) * 10) / 10, 0) + WH.util.NBSP + 'dB';
      wallBands.textContent = t('planner.adv.wallBands', { a: f(2.4), c: f(6) });
    });
    // optional transmit-power difference of 2.4 / 6 GHz against 5 GHz (model.bandPower, -10..+6 dB)
    const bp = (b) => slider({
      i18n: b === 2.4 ? 'planner.adv.bp24' : 'planner.adv.bp6', min: -10, max: 6, step: 1, fmt: (v) => PL.db(v), undo: 'planner.undo.model', topics: ['model'],
      get: () => { const o = P().model.bandPower; return o && Number.isFinite(o[bk(b)]) ? o[bk(b)] : 0; },
      set: (p, v) => { p.model.bandPower = { '2.4': 0, 5: 0, 6: 0, ...(p.model.bandPower || {}), [bk(b)]: Math.round(v) }; },
    });
    // SPEC 13: "Která pásma tvůj router vysílá" (net.routerBands) - Auto, band zones and "Nevím" points follow it
    const rbBox = el('div.cluster.pl-rbands', E.BANDS.map((b) => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        const ok = commit('planner.undo.routerBands', (p) => {
          const rb = { '2.4': true, 5: true, 6: false, ...(p.net.routerBands || {}), [bk(b)]: cb.checked };
          if (!Object.values(rb).some(Boolean)) return false;
          p.net.routerBands = rb;
          // one band left: Auto has nothing to choose from - show that band
          if (p.view.band === 'auto' && E.BANDS.filter((x) => rb[bk(x)]).length < 2) p.view.band = E.BANDS.find((x) => rb[bk(x)]);
        }, ['net', 'view']);
        if (!ok && !cb.checked) { cb.checked = true; ui().toast({ i18n: 'planner.adv.rbOne' }, { kind: 'warn' }); }
      });
      syncs.push(() => { const rb = P().net.routerBands; cb.checked = rb ? !!rb[bk(b)] : b !== 6; });
      return el('label.check', cb, el('span', `${PL.band(b)} ${t('planner.ghz')}`));
    }));
    // the band-steering rule of Auto (model.steer): stay on 6 GHz from -70 dBm, on 5 GHz from -72 dBm, else 2.4 GHz
    const steer = (k, i18n) => slider({
      i18n, min: -90, max: -50, step: 1, fmt: dbm, undo: 'planner.undo.steer', topics: ['model'],
      get: () => E.model.steerOf(P())[k],
      set: (p, v) => { p.model.steer = { ...E.model.steerOf(p), [k]: Math.round(v) }; },
    });
    // SPEC 9: while the measured fit (model.fit) is in use it tunes n / walls / router strength; the sliders are its prior
    const fitTxt = el('span');
    const fitNote = el('div.notice.notice--muted.pl-fitnote', { hidden: true }, ui().icon('info', 18), fitTxt);
    syncs.push(() => {
      const p = P();
      const f = p.model.fit;
      fitNote.hidden = !(f && p.view.calibrate !== false);
      if (!fitNote.hidden) fitTxt.textContent = t(f.method === 'offset+n+walls' ? 'planner.adv.fitNote' : 'planner.adv.fitNoteOffset');
    });
    const advCard = ui().card({ id: 'pl-adv', i18n: 'planner.adv.title', icon: 'settings', open: false, body: [
      width,
      scaleRow,
      ceil.el,
      el('h4', t('planner.adv.model')),
      fitNote,
      mdl('planner.adv.near', 'nearSignal', 'nearSignal', -55, -25, 1, dbm),
      mdl('planner.adv.decay', 'decay', 'n', 1.6, 4, 0.1, (v) => WH.util.fmt(v, 1)),
      wall,
      el('div.pl-cap.pl-bphead', el('span', t('planner.adv.bandPower')), ui().hint('bandPower')),
      bp(2.4),
      bp(6),
      el('div.pl-cap.pl-rbhead', el('span', t('planner.adv.routerBands')), ui().hint('routerBands')),
      rbBox,
      el('div.pl-cap', el('span', t('planner.adv.steer')), ui().hint('steer')),
      steer('six', 'planner.adv.steer6'),
      steer('five', 'planner.adv.steer5'),
      mdl('planner.adv.thr', 'threshold', 'threshold', -75, -55, 1, dbm),
      mdl('planner.adv.range', 'rangeThreshold', 'rangeThreshold', -80, -45, 1, dbm),
      reset,
      el('div.pl-cap', el('span', t('planner.adv.rooms')), ui().hint('roomsCount')),
      roomsBox,
      sw({ i18n: 'planner.adv.palette', hint: 'palette', get: () => P().view.palette === 'cb', set: (v) => PL.setView({ palette: v ? 'cb' : 'default' }) }),
    ] });
    // "Začínáme" -> the router's bands: open Advanced, bring the checkboxes into view and focus the first one
    showRB = () => {
      advCard.setOpen(true);
      requestAnimationFrame(() => {
        try { rbBox.scrollIntoView({ block: 'center', behavior: WH.util.prefersReducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ }
        const cb = rbBox.querySelector('input');
        if (cb) cb.focus({ preventScroll: true });
      });
    };
    return advCard;
  }
  let showRB = () => {};

  /** SPEC 14.3: the slabs between the floors - one block per floor that has a floor above it: material (concrete 15 dB,
   *  reinforced concrete 20 dB, wood 8 dB, own value), its loss and the storey height. Shown with two or more floors. */
  function ceilingSection() {
    const E = WH.engine;
    const MATS = ['concrete', 'reinforced_concrete', 'wood', 'custom'];
    const box = el('div.stack.pl-ceil', { hidden: true });
    const head = el('div.pl-cap', el('span', t('planner.ceil.title')), ui().hint('ceilingLoss'));
    let key = '';
    let own = [];
    const fl = (id) => (P().floors || []).find((f) => f.id === id) || null;
    function block(lower, upper) {
      const id = lower.id;
      const dflt = (m) => { const v = E.project.CEILING_MATERIALS && E.project.CEILING_MATERIALS[m]; return Number.isFinite(v) ? v : null; };
      const matOpts = () => MATS.map((m) => ({ value: m, label: m === 'custom' ? t('planner.ceil.mat.custom') : t('planner.ceil.matDb', { m: t('planner.ceil.mat.' + m), d: WH.util.fmt(dflt(m), 0) }) }));
      const saved = syncs;
      syncs = own;
      const mat = selField({ i18n: 'planner.ceil.material', undo: 'planner.undo.ceiling', topics: ['floors'], opts: matOpts, get: () => { const f = fl(id); return f && f.ceiling ? f.ceiling.material : 'concrete'; }, set: (p, v) => { E.project.setCeiling(p, id, { material: v }); } });
      const loss = slider({
        i18n: 'planner.ceil.loss', hint: 'ceilingLoss', min: 0, max: 40, step: 1, fmt: (v) => `${WH.util.fmt(v, 0)}${WH.util.NBSP}dB`, undo: 'planner.undo.ceiling', topics: ['floors'],
        get: () => { const f = fl(id); return f && f.ceiling ? f.ceiling.lossDb : 15; },
        // a value of its own makes the material "Vlastní" (the list shows each material's default)
        set: (p, v) => { const f = (p.floors || []).find((x) => x.id === id); const m = f && f.ceiling ? f.ceiling.material : 'custom'; E.project.setCeiling(p, id, { material: dflt(m) === Math.round(v) ? m : 'custom', lossDb: Math.round(v) }); },
      });
      const height = slider({
        i18n: 'planner.ceil.height', hint: 'ceilingHeight', min: 2, max: 6, step: 0.1, fmt: (v) => PL.m(v), undo: 'planner.undo.ceiling', topics: ['floors'],
        get: () => { const f = fl(id); return f && f.ceiling ? f.ceiling.heightM : 2.7; },
        set: (p, v) => { E.project.setCeiling(p, id, { heightM: Math.round(v * 10) / 10 }); },
      });
      syncs = saved;
      return el('div.pl-ceil__slab', el('div.pl-ceil__t', ui().icon('stairs', 16), el('span', t('planner.ceil.between', { a: lower.name, b: upper.name }))), mat, loss, height);
    }
    return {
      el: box,
      sync(q) {
        const list = PL.floorList();
        if (list.length < 2) { box.hidden = true; return; }
        box.hidden = false;
        const k = JSON.stringify([list.map((f) => [f.id, f.name, f.level]), WH.i18n.lang]);
        if (k !== key) {
          key = k;
          own = [];
          const blocks = [];
          for (let i = 0; i + 1 < list.length; i++) blocks.push(block(list[i], list[i + 1]));
          box.replaceChildren(head, ...blocks.reverse(), el('p.text-xs.text-muted', t('planner.ceil.note')));
        }
        for (const f of own) f(q);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  let raf = 0;
  let pendQ = 'coarse';
  function run(q) {
    if (!host || !P()) return;
    for (const f of syncs) { try { f(q); } catch (e) { PL.report(e, 'planner.sidebar', { bug: true }); } }
  }
  const side = (PL.side = {
    showRouterBands: () => showRB(),
    /** "Další přístupové body" open (a node added from elsewhere, a marker clicked). */
    openNodes: () => { if (nodesCard) nodesCard.setOpen(true); },
    /** Open the card, the node's row, and bring it into view (its marker was clicked / it was just added). */
    revealNode: (id) => { if (nodesCard) nodesCard.setOpen(true); revealId = id; side.schedule('full'); },
    mount(node) {
      host = node;
      side.render();
      PL.on((q) => side.schedule(q));
      if (PL.calib && PL.calib.mount) PL.calib.mount();
    },
    render() {
      if (!host) return;
      syncs = [];
      // the "Prvotní měření" guide sits at the top on desktop (the action bar steps aside while it is open; the slot is
      // empty while it is closed)
      const slot = PL.calib && PL.calib.sideSlot ? PL.calib.sideSlot() : null;
      host.replaceChildren(...[actionBar(), slot, cardStart(), cardResult(), cardRouter(), cardMeas(), cardNodes(), cardSpeed(), cardAdv()].filter(Boolean));
      if (PL.calib && PL.calib.afterSideRender) PL.calib.afterSideRender();
      run('full');
    },
    schedule(q) {
      if (q !== 'coarse') pendQ = 'full';
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; const x = pendQ; pendQ = 'coarse'; run(x); });
    },
  });
})();
