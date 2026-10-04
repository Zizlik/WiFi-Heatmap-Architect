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
  /** Number field: {i18n, hint, unit, min, max, step, d (decimals for the error), req, ph, get, set(p, v), undo} */
  function numField(o) {
    const inp = ui().numberInput({ min: o.min, max: o.max, step: o.step || 'any', placeholder: o.ph || '' });
    const f = ui().field({ i18n: o.i18n, hint: o.hint, unit: o.unit, control: inp });
    inp.addEventListener('input', () => f.setError(''));
    inp.addEventListener('change', () => {
      const v = inp.value === '' ? null : inp.valueAsNumber;
      if (v === null && !o.req) { commit(o.undo, (p) => o.set(p, null)); return; }
      if (v === null || !Number.isFinite(v) || v < o.min || v > o.max) {
        f.setError(t('planner.err.range', { min: WH.util.fmt(o.min, o.d || 0), max: WH.util.fmt(o.max, o.d || 0) }));
        inp.setValue(o.get());
        return;
      }
      commit(o.undo, (p) => o.set(p, v));
    });
    syncs.push(() => { inp.disabled = !!(o.off && o.off()); if (!focused(inp)) inp.setValue(o.get()); });
    return f;
  }

  /** Slider: one undo step per gesture.  {i18n, hint, min, max, step, fmt, get, set(p, v), undo, topics} */
  function slider(o) {
    let open = false;
    const apply = (v) => {
      if (!open) { WH.store.begin(o.undo); open = true; }
      WH.store.live((p) => o.set(p, v), o.topics);
    };
    const r = ui().range({ min: o.min, max: o.max, step: o.step, value: o.get(), format: o.fmt, onInput: apply, onChange: (v) => { apply(v); open = false; WH.store.end(); } });
    syncs.push(() => { if (!open) r.setValue(o.get()); });
    return ui().field({ i18n: o.i18n, hint: o.hint, control: r });
  }

  /** Select: {i18n, hint, opts() -> [{value,label}], get, set(p, v), undo, inline} */
  function selField(o) {
    const s = ui().select(o.opts(), { value: String(o.get()), onChange: (v) => commit(o.undo, (p) => o.set(p, v)) });
    const f = ui().field({ i18n: o.i18n, hint: o.hint, control: s, inline: o.inline });
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

  const roomOpts = (first, label) => () => [{ value: first, label }, ...P().plan.rooms.map((r) => ({ value: r.roomId, label: r.name }))];

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
    const target = selField({ i18n: 'planner.res.target', hint: 'target', inline: true, undo: 'planner.undo.target', opts: roomOpts('all', 'planner.res.all'), get: () => P().goal.room, set: (p, v) => { p.goal.room = v === 'all' ? 'all' : Number(v); } });
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
    const rooms = el('div.pl-rooms');
    const live = el('div.sr-only', { 'aria-live': 'polite' });
    // SPEC 9: the model tuned by measurements (plain words) and the whole-home throughput (28-calib-wizard.js)
    const fitSec = PL.calib && PL.calib.resultSection ? PL.calib.resultSection() : null;
    const tpSec = PL.calib && PL.calib.throughputSection ? PL.calib.throughputSection() : null;
    if (fitSec) syncs.push((q) => fitSec.sync(q));
    if (tpSec) syncs.push((q) => tpSec.sync(q));
    const c = ui().card({ id: 'pl-result', i18n: 'planner.res.title', icon: 'gauge', body: [
      target, el('div.pl-cap', el('span', t('planner.res.coverage')), ui().hint('coverage')), hero, kv, sentence, srcLine, wiLine, speedLine, fitSec, tpSec,
      el('div.pl-subhead', el('span', t('planner.res.rooms')), el('span', t('planner.res.roomsHint'))), rooms, live].filter(Boolean) });
    const rows = new Map();
    let order = '';
    let lastLive = '';
    syncs.push((q) => {
      const p = P();
      const a = PL.S.a;
      const pct = WH.util.fmtPct;
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
      const cmp = PL.moved() || p.node.mode !== 'none';
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
      // SPEC 10.3: which rooms the second point serves (a room counts as its when it is the stronger source on at least
      // half of the floor); the drag frames (coarse) carry no shares - the line keeps its last text until the pointer rests
      if (q !== 'coarse') {
        const sh = p.node.mode !== 'none' && a.sourceShare ? a.sourceShare : null;
        srcLine.hidden = !sh;
        if (sh) {
          const who = PL.nodeLabel();
          const counted = p.plan.rooms.filter((r) => { const s2 = a.perRoom.trial.get(r.roomId); return s2 && s2.n; });
          const names = counted.filter((r) => (sh.perRoom.get(r.roomId) || 0) >= 50).map((r) => r.name);
          srcLine.textContent = !names.length ? t('planner.res.srcNone', { who })
            : names.length >= counted.length ? t('planner.res.srcAll', { who })
              : t(names.length === 1 ? 'planner.res.srcOne' : 'planner.res.srcMany', { who, list: PL.listOf(names) });
        }
      }
      const ws = q === 'coarse' ? null : PL.wi.summary();
      if (q !== 'coarse') { wiLine.hidden = !ws; if (ws) wiTxt.textContent = PL.wi.resultLine(ws); }
      const sp = PL.S.sp;
      // the throughput section says the same (and more) whenever a speed curve exists
      speedLine.hidden = !sp || !!(tpSec && !tpSec.hidden);
      if (sp) {
        speedLine.textContent = sp.stats
          ? t('planner.res.speed', { v: pct(sp.stats.coverage), d: PL.mbps(p.goal.targetDown), u: PL.mbps(p.goal.targetUp) }) + (sp.stats.known < 99.5 ? ' ' + t('planner.res.speedKnown', { v: pct(sp.stats.known) }) : '')
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
    const allowed = selField({ i18n: 'planner.router.allowed', hint: 'allowedArea', undo: 'planner.undo.allowed', opts: roomOpts('any', 'planner.router.anywhere'), get: () => P().goal.allowedRoom, set: (p, v) => { p.goal.allowedRoom = v === 'any' ? 'any' : Number(v); } });
    const inlet = el('span');
    const c = ui().card({ id: 'pl-router', i18n: 'planner.router.title', icon: 'router', hint: 'trial', body: [
      status,
      el('div.cluster', el('span.row.gap-1', mark, ui().hint('baseline'))),
      allowed,
      el('div.pl-inlet', el('span.pl-inlet__ico', ui().icon('globe', 18)), el('div.grow', el('div.pl-inlet__t', el('span', t('planner.router.inletT')), ui().hint('inlet')), el('div.pl-inlet__d', inlet, ui().hint('cable')))),
    ] });
    syncs.push(() => {
      const p = P();
      const moved = PL.moved();
      const has = p.plan.rooms.length > 0;
      const room = (PL.roomAt(p.net.router) || {}).name || t('planner.tip.outside');
      status.textContent = !has ? t('planner.res.noplan') : moved ? t('planner.router.trial', { room, d: PL.m(PL.distM(p.net.router, p.net.baseline)) }) : t('planner.router.atToday', { room });
      mark.disabled = !moved;
      const d = PL.distM(p.net.router, p.net.optic);
      const lo = Math.max(1, Math.floor(d * 1.3));
      inlet.textContent = t('planner.router.inlet', { d: PL.m(d), lo, hi: Math.max(lo + 1, Math.ceil(d * 1.6)) });
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
  // 5. second access point
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Where a newly switched-on second node starts: towards the weakest room. A wireless node (repeater / mesh over Wi-Fi)
   * stops where the router's signal on its link band is still good (SPEC 10: a repeater deep in the weak area serves a
   * strong signal but little speed); the marker never lands on a room's name.
   */
  function suggestNode(p, mode) {
    const a = PL.S.a;
    const E = WH.engine;
    let best = null;
    if (a) for (const r of p.plan.rooms) {
      if (p.goal.excluded.includes(r.roomId)) continue;
      const s = a.perRoom.trial.get(r.roomId);
      if (s && s.n && (!best || s.mean < best.mean)) best = { mean: s.mean, r };
    }
    let q = E.project.nearestFloor(p.plan, best ? E.geom.labelPoint(best.r.points) : p.node.pos);
    try {
      if (best && (mode === 'repeater' || mode === 'mesh_wifi')) {
        const ctx = PL.ensureCtx(p);
        const band = p.node.backhaulBand;
        const off = (PL.S.offs && PL.S.offs[String(band)]) || 0;
        const from = p.net.router;
        const want = p.node.backhaulThreshold + 3;
        let ok = null;
        for (let i = 4; i <= 24; i++) {
          const c = { x: from.x + ((q.x - from.x) * i) / 24, y: from.y + ((q.y - from.y) * i) / 24 };
          const room = E.project.roomAt(p.plan, c);
          if (!room || p.goal.excluded.includes(room.roomId)) continue;
          if (E.model.softSignal(ctx, from, c, band, off) >= want) ok = c;
        }
        if (ok) q = ok;
      }
      // keep the room's name readable: step ~0.9 m off the label point when the spot is that close to one
      const lp = p.plan.rooms.map((r) => ({ r, l: E.geom.labelPoint(r.points) }));
      const near = lp.find((x) => Math.hypot((x.l.x - q.x) * 1080, (x.l.y - q.y) * 942) * p.scale.mpp < 0.7);
      if (near) {
        const d = 0.9 / p.scale.mpp;
        const room = E.project.roomAt(p.plan, q) || near.r;
        const c = [[0, d], [0, -d], [d, 0], [-d, 0]].map(([dx, dy]) => ({ x: near.l.x + dx / 1080, y: near.l.y + dy / 942 })).find((c) => E.project.roomAt(p.plan, c) === room);
        if (c) q = c;
      }
      if (PL.insidePoint) q = PL.insidePoint(q, 0.4);
    } catch (e) { /* the plain suggestion */ }
    return PL.pt(q);
  }

  function cardNode() {
    const MODES = ['none', 'ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater'];
    const HK = { none: 'secondAp', ap_cable: 'apCable', mesh_cable: 'meshCable', mesh_wifi: 'meshWifi', repeater: 'repeater' };
    const wirelessMode = (m) => m === 'mesh_wifi' || m === 'repeater';
    const modeHint = ui().hint('apCable');
    const mode = ui().select(MODES.map((m) => ({ value: m, label: `planner.node.${m}` })), {
      value: P().node.mode,
      onChange: (v) => commit('planner.undo.node', (p) => { const was = p.node.mode; p.node.mode = v; if (was === 'none' && v !== 'none') p.node.pos = suggestNode(p, v); }, ['node']),
    });
    const bands = el('div.cluster.pl-nbands', WH.engine.BANDS.map((b) => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        const ok = commit('planner.undo.node', (p) => {
          const bs = { ...p.node.bands, [bk(b)]: cb.checked };
          if (!Object.values(bs).some(Boolean)) return false;
          p.node.bands = bs;
          if (!bs[bk(p.node.backhaulBand)]) p.node.backhaulBand = [5, 2.4, 6].find((x) => bs[bk(x)]);
        }, ['node']);
        if (!ok && !cb.checked && P().node.bands[bk(b)]) { cb.checked = true; ui().toast({ i18n: 'planner.node.oneBand' }, { kind: 'warn' }); }
      });
      syncs.push(() => { cb.checked = !!P().node.bands[bk(b)]; });
      return el('label.check', cb, el('span', `${PL.band(b)} ${t('planner.ghz')}`), ui().hint(b === 2.4 ? 'band24' : `band${b}`));
    }));
    const nodeSlider = (o) => slider(Object.assign({ undo: 'planner.undo.node', topics: ['node'] }, o));
    const power = nodeSlider({ i18n: 'planner.node.power', hint: 'power', min: -10, max: 6, step: 1, fmt: (v) => PL.db(v), get: () => P().node.power, set: (p, v) => { p.node.power = v; } });
    const bh = selField({ i18n: 'planner.node.bhBand', hint: 'backhaul', undo: 'planner.undo.node', opts: () => WH.engine.BANDS.filter((b) => P().node.bands[bk(b)]).map((b) => ({ value: b, label: `${PL.band(b)} ${t('planner.ghz')}` })), get: () => P().node.backhaulBand, set: (p, v) => { p.node.backhaulBand = Number(v); } });
    const thr = nodeSlider({ i18n: 'planner.node.bhThr', min: -80, max: -55, step: 1, fmt: (v) => WH.util.dbm(v), get: () => P().node.backhaulThreshold, set: (p, v) => { p.node.backhaulThreshold = v; } });
    const bhLine = el('div.notice');
    // SPEC 10: the node's real ceiling (node.maxMbps) and the speed its link to the router allows
    const maxF = numField({ i18n: 'planner.node.max', hint: 'nodeMax', unit: 'planner.mbps', min: 10, max: 10000, step: 1, ph: '—', undo: 'planner.undo.nodeMax', get: () => (Number.isFinite(P().node.maxMbps) ? P().node.maxMbps : null), set: (p, v) => { p.node.maxMbps = v; } });
    maxF.classList.add('pl-nmax');
    const bhSpeed = el('p.pl-bhspeed', { hidden: true });
    const wireless = el('div.stack', bh, thr, bhLine);
    const sub = el('div.stack.pl-nsub', ui().field({ i18n: 'planner.node.bands', control: bands }), power, wireless, maxF, bhSpeed, el('p.text-xs.text-muted', t('planner.node.drag')));
    const c = ui().card({ id: 'pl-node', i18n: 'planner.node.title', icon: 'node', hint: 'secondAp', open: false, body: [ui().field({ i18n: 'planner.node.mode', control: [mode, modeHint] }), sub] });
    syncs.push(() => {
      const n = P().node;
      if (!focused(mode)) mode.value = n.mode;
      sub.hidden = n.mode === 'none';
      wireless.hidden = !wirelessMode(n.mode);
      modeHint.hidden = n.mode === 'none';
      if (modeHint.getAttribute('data-hint') !== HK[n.mode]) {
        modeHint.setAttribute('data-hint', HK[n.mode]);
        modeHint.setAttribute('aria-label', t('ui.hint.about', { topic: t(`help.${HK[n.mode]}.t`) }));
      }
      c.setBadge(n.mode !== 'none' ? t('planner.node.on') : null);
      const a = PL.S.a;
      bhLine.hidden = wireless.hidden || !a || a.backhaul === null;
      if (!bhLine.hidden) {
        const ok = a.backhaul >= n.backhaulThreshold;
        bhLine.className = 'notice notice--' + (ok ? 'ok' : 'warn');
        bhLine.replaceChildren(ui().icon(ok ? 'check-circle' : 'warning', 18), el('span', t(ok ? 'planner.node.bhOk' : 'planner.node.bhWeak', { v: WH.util.dbm(a.backhaul), q: PL.qWord(a.backhaul) })));
      }
      // "Propojení s routerem ≈ 280 Mb/s" (wireless; needs a speed curve) / by cable no link limit
      const bs = n.mode === 'none' ? null : PL.wi.backhaulMbps();
      const lk = n.mode === 'none' ? null : PL.wi.link();
      const mx = Number.isFinite(n.maxMbps) ? n.maxMbps : null;
      const maxTxt = mx !== null ? ' ' + t('planner.node.maxOnly', { v: PL.mbps(mx) }) : '';
      let txt = '';
      if (n.mode !== 'none') {
        if (!wirelessMode(n.mode)) txt = t('planner.node.bhCable') + maxTxt;
        else if (Number.isFinite(bs)) txt = mx !== null && mx < bs ? t('planner.node.bhSpeedMax', { v: PL.mbps(bs), m: PL.mbps(mx) }) : t('planner.node.bhSpeedCap', { v: PL.mbps(bs) });
        // no speed curve yet: the link quality in dBm is in the notice above, plus the ceiling when known
        else txt = lk && lk.reason === 'weak' ? t('planner.node.bhTooWeak') : t('planner.node.bhNoCurve') + maxTxt;
      }
      bhSpeed.hidden = !txt;
      bhSpeed.textContent = txt;
    });
    return c;
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
    const width = numField({
      i18n: 'planner.adv.width', hint: 'scale', unit: 'planner.unit.m', min: 1, max: 200, step: 0.1, d: 0, req: true, undo: 'planner.undo.scale',
      off: () => !P().plan.rooms.length,
      get: () => (P().plan.rooms.length ? Math.round(E.project.widthFromMpp(P().plan, P().scale.mpp) * 10) / 10 : null),
      set: (p, v) => { if (p.plan.rooms.length) p.scale.mpp = E.project.deriveMpp(p.plan, v); },
    });
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

  // ---------------------------------------------------------------------------------------------------------------
  let raf = 0;
  let pendQ = 'coarse';
  function run(q) {
    if (!host || !P()) return;
    for (const f of syncs) { try { f(q); } catch (e) { PL.report(e, 'planner.sidebar', { bug: true }); } }
  }
  const side = (PL.side = {
    showRouterBands: () => showRB(),
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
      host.replaceChildren(...[actionBar(), slot, cardStart(), cardResult(), cardRouter(), cardMeas(), cardNode(), cardSpeed(), cardAdv()].filter(Boolean));
      if (PL.calib && PL.calib.afterSideRender) PL.calib.afterSideRender();
      run('full');
    },
    schedule(q) {
      if (q !== 'coarse') pendQ = 'full';
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; const x = pendQ; pendQ = 'coarse'; run(x); });
    },
  });
})();
