/* Planner: "what if" at the measured points (SPEC 10) + where a measurement dot may stand.
 *
 *   PL.wi.active()            the scenario differs from today (router moved or a second node on)
 *   PL.wi.onMap()             the map layer "Předpověď u bodů" is on (view.whatif) and the dots are shown (view.points)
 *   PL.wi.layerWhy()          why that layer has nothing to show: 'points' | 'none' | 'same' | null (it can show)
 *   PL.wi.rows() / row(id)    engine.analysis.predictAtMeasurements for every measurement (cached; null without the API)
 *   PL.wi.label(m, i, view)   what a dot says: {key, full:[parts], short:[parts], tone, text} - "−72 → −58 (+14)",
 *                             "↓120 → ≈310"; plain "−63" / "↓245 / ↑38" while nothing changed
 *   PL.wi.fill(valEl, lab)    renders a label spec (both lengths; CSS shows one: data-lv on the marker)
 *   PL.wi.tip(m)              tooltip lines (measured / model today / model new / predicted + what limits the speed)
 *   PL.wi.summary()           {n, avg, up, down, same, best, worst, items[]} sorted by benefit
 *   PL.wi.verdict(sum)        one plain sentence naming the change ("Opakovač pomůže hlavně v místě „Ložnice“ (+14 dB), …")
 *   PL.wi.section()           the "Co by se změnilo v tvých bodech" block of the Measurements card ({el, sync})
 *   PL.insidePoint(q, m)      a floor point >= m metres from every wall / room outline, as close to q as possible
 *   PL.measPoint(q)           where a NEW measurement goes: the room under the cursor, never on a wall line
 *   PL.measOff(m)             a dot off the floor or sitting on a wall line ("Posunout dovnitř")
 * Only UI lives here; the numbers come from the engine. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const W = 1080;
  const H = 942;
  const WI = (PL.wi = {});

  // ---------------------------------------------------------------------------------------------------------------
  // where a dot may stand
  // ---------------------------------------------------------------------------------------------------------------
  /** px distance of canvas point (x, y) to the nearest wall or to the outline of `room` (negative = outside it). */
  function clearancePx(p, room, x, y) {
    const G = WH.engine.geom;
    let d = G.signedDistPx({ x: x / W, y: y / H }, room.points);
    if (!(d > 0)) return d;
    for (const w of p.plan.walls) {
      if (!w || !w.a || !w.b) continue;
      d = Math.min(d, G.pointSegDistPx(x, y, w.a.x * W, w.a.y * H, w.b.x * W, w.b.y * H));
    }
    return d;
  }
  /** The room a point belongs to (the nearest one when it is off the floor). */
  function roomOf(p, q) {
    const E = WH.engine.project;
    return E.roomAt(p.plan, q) || E.roomAt(p.plan, E.nearestFloor(p.plan, q));
  }
  PL.insidePoint = (q, clearM) => {
    const p = PL.P();
    const E = WH.engine.project;
    if (!p.plan.rooms.length || !q) return q ? PL.pt(q) : q;
    const base = E.floorMaskAt(p.plan, q) ? q : E.nearestFloor(p.plan, q);
    const room = roomOf(p, base);
    if (!room) return PL.pt(base);
    const want = (clearM || 0.25) / p.scale.mpp;
    const bx = base.x * W;
    const by = base.y * H;
    const c0 = clearancePx(p, room, bx, by);
    if (c0 >= want) return PL.pt(base);
    // rings around the point, nearest first: the first spot with the clearance wins, else the clearest one seen
    const step = Math.max(1, 0.04 / p.scale.mpp);
    const maxR = Math.max(want * 4, 1.2 / p.scale.mpp);
    let best = null;
    let bestC = c0;
    for (let r = step; r <= maxR; r += step) {
      const n = Math.max(12, Math.round((2 * Math.PI * r) / step));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const x = bx + r * Math.cos(a);
        const y = by + r * Math.sin(a);
        if (x < 1 || y < 1 || x > W - 1 || y > H - 1) continue;
        const c = clearancePx(p, room, x, y);
        if (c >= want) return PL.pt({ x: x / W, y: y / H });
        if (c > bestC) { bestC = c; best = { x: x / W, y: y / H }; }
      }
    }
    return PL.pt(best || base);
  };
  /** Clearance of a point in metres (negative / 0 = off the floor). */
  PL.clearM = (q) => {
    const p = PL.P();
    const room = WH.engine.project.roomAt(p.plan, q);
    return room ? clearancePx(p, room, q.x * W, q.y * H) * p.scale.mpp : -1;
  };
  PL.measPoint = (q) => {
    const p = PL.P();
    const c = { x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) };
    if (!p.plan.rooms.length) return PL.pt(c);
    const f = WH.engine.project.nearestFloor(p.plan, c);
    return PL.clearM(f) < 0.15 ? PL.insidePoint(f, 0.25) : PL.pt(f);
  };
  PL.measOff = (m) => !!(PL.P().plan.rooms.length && PL.clearM(m) < 0.08);
  /** "Posunout dovnitř" for one / all flagged dots (one undo step). */
  PL.moveInside = (ids) => {
    const p = PL.P();
    const moves = new Map();
    for (const m of p.measurements) if (ids.includes(m.id) && PL.measOff(m)) moves.set(m.id, PL.insidePoint(m, 0.25));
    if (!moves.size) return false;
    const ok = WH.store.commit('planner.undo.measInside', (pr) => {
      for (const m of pr.measurements) { const q = moves.get(m.id); if (q) { m.x = q.x; m.y = q.y; } }
    }, ['measurements']);
    if (ok) ui().toast({ text: t('planner.wi.movedIn', { n: moves.size }), action: { i18n: 'ui.undo', fn: () => { if (WH.store.labels().undo === 'planner.undo.measInside') WH.store.undo(); } } }, { kind: 'ok' });
    return !!ok;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // the engine's prediction at every measured point
  // ---------------------------------------------------------------------------------------------------------------
  WI.active = () => {
    const p = PL.P();
    if (!p || !p.plan.rooms.length) return false;
    return WH.engine.analysis.whatIfActive(p);
  };
  /** The dots on the map (labels, tooltips, PNG export) show the prediction: layers "Body měření" + "Předpověď u bodů".
   *  The sidebar's "Co by se změnilo" section and the Result line do not depend on it. */
  WI.onMap = () => { const v = PL.P().view; return v.points !== false && v.whatif !== false; };
  /** Why "Předpověď u bodů" has nothing to show (its switch is greyed): the dots are hidden, no measurements, or nothing
   *  differs from today; null = it can show. */
  WI.layerWhy = () => {
    const p = PL.P();
    if (p.view.points === false) return 'points';
    if (!p.measurements.length) return 'none';
    return WI.active() ? null : 'same';
  };
  let cache = { key: '', rows: null, by: new Map() };
  WI.rows = () => {
    const p = PL.P();
    const A = WH.engine.analysis;
    if (!p || !p.measurements.length || !p.plan.rooms.length) return null;
    const S = PL.S;
    // every project change goes through a new analysis (S.a): same analysis + measurements = same answer (cheap per dot)
    if (S.a && cache.a === S.a && cache.mv === S.measVer && cache.ok === S.offsKey) return cache.rows;
    // while the router is dragged a big set of points keeps its last answer until the pointer rests
    if (S.q === 'coarse' && cache.rows && p.measurements.length > 40) return cache.rows;
    let ctx;
    try { ctx = PL.ensureCtx(p); } catch (e) { return null; }
    const key = [ctx.version, S.offsKey, PL.posKey(p.net.router), JSON.stringify(p.node), S.measVer, JSON.stringify(PL.speedLimits(p)), p.goal.device, p.goal.reserve].join('|');
    if (key !== cache.key) {
      let rows = null;
      try { rows = A.predictAtMeasurements(ctx, p, { offsets: S.offs }); } catch (e) { PL.report(e, 'whatif.predict', { bug: true }); rows = null; }
      if (!Array.isArray(rows)) rows = null;
      cache = { key, rows, by: new Map((rows || []).filter((r) => r && r.id).map((r) => [r.id, r])) };
    }
    cache.a = S.a;
    cache.mv = S.measVer;
    cache.ok = S.offsKey;
    return cache.rows;
  };
  WI.row = (id) => (WI.rows() ? cache.by.get(id) || null : null);

  const num = (v) => WH.util.fmt(v, 0);
  const tone = (d) => (d >= 1 ? 'up' : d <= -1 ? 'down' : 'zero');
  const spTone = (a, b) => (!fin(a) || !fin(b) || a <= 0 ? 'zero' : b >= a * 1.1 ? 'up' : b <= a * 0.9 ? 'down' : 'zero');
  /** The binding speed limit of a row: {k:'backhaul'|'device'|'plan'|'link', v:Mb/s|null} or null. */
  const CAP_KINDS = ['backhaul', 'device', 'plan', 'link'];
  WI.cap = (r) => {
    const s = r && r.speed;
    const k = s && s.limitedBy;
    if (!CAP_KINDS.includes(k)) return null;
    // capDown = the binding ceiling (ENGINE-API 7.7); null for a wireless link the curve cannot rate ("slabé propojení")
    const p = PL.P();
    let v = s.capDown;
    if (!fin(v) && k === 'device') v = p.node.maxMbps;
    if (!fin(v) && k === 'plan') v = p.net.wanDown;
    if (!fin(v) && k === 'link') v = WH.engine.speed.linkLimit(p.net);
    return { k, v: fin(v) ? v : null };
  };
  /** "omezeno propojením ≈ 300 Mb/s" */
  WI.capText = (c) => (!c ? '' : c.v === null && c.k === 'backhaul' ? t('planner.wi.capU') : t('planner.wi.cap.' + c.k, { v: c.v === null ? '?' : PL.mbps(c.v) }));
  /** The same as a noun phrase for sentences: "propojení s routerem (≈ 300 Mb/s)" / "slabé propojení s routerem". */
  WI.capNoun = (c) => (!c ? '' : c.v === null && c.k === 'backhaul' ? t('planner.wi.capNU') : t('planner.wi.capN.' + c.k, { v: c.v === null ? '?' : PL.mbps(c.v) }));
  /** The second node serves this point with a stronger signal, yet the speed falls below the measured one because its link
   *  to the router / the device's ceiling binds (a repeater where the router's signal is already weak). */
  const slower = (r) => {
    const s = r && r.speed;
    return !!(s && r.source === 'node' && fin(s.measuredDown) && fin(s.predDown) && s.predDown < s.measuredDown * 0.9 && (s.limitedBy === 'backhaul' || s.limitedBy === 'device'));
  };
  /** The node serves this point, but its wireless link is too weak for any speed estimate. */
  const weakLink = (r) => !!(r && r.source === 'node' && r.speed && r.speed.reason === 'backhaul');
  WI.slower = slower;

  /**
   * The label of a dot. view = 'signal'|'speed'|'diff'. Parts: strings, {i:'arrow-down'} icons, {chip:'+14', tone}.
   * The full text never hides the numbers; the short form is what remains in a crowd / zoomed out.
   */
  WI.label = (m, i, view) => {
    const p = PL.P();
    const sig = fin(m.value);
    const hasSp = fin(m.download) && fin(m.upload);
    const other = PL.bands.isOther(m);
    // layer "Předpověď u bodů" off: only what was measured ("−61", "↓206 / ↑70")
    const r = WI.active() && WI.onMap() ? WI.row(m.id) : null;
    let full = [];
    let short = [];
    let tn = '';
    let cap = null;
    if (r && view === 'speed' && r.speed && fin(r.speed.predDown)) {
      const s = r.speed;
      cap = WI.cap(r);
      tn = spTone(s.measuredDown, s.predDown);
      const pred = '≈' + PL.mbps(s.predDown);
      full = fin(s.measuredDown) ? [{ i: 'arrow-down' }, PL.mbps(s.measuredDown), ' → ', { b: pred, tone: tn }] : [{ i: 'arrow-down' }, { b: pred, tone: tn }];
      short = [{ i: 'arrow-down' }, { b: pred, tone: tn }];
      if (cap) { full.push({ i: 'lock', cap: true }); short.push({ i: 'lock', cap: true }); }
    } else if (r && view === 'speed' && r.speed && r.changed && fin(r.speed.measuredDown) && (r.speed.reason === 'backhaul' || r.speed.reason === 'weak')) {
      // the speed after the change cannot be estimated (the node's link to the router / the new signal is weaker than
      // every speed test): "↓170 → ?" - with the lock when the weak link is the reason (the tooltip says it in words)
      const s = r.speed;
      cap = s.reason === 'backhaul' ? { k: 'backhaul', v: null } : null;
      tn = 'down';
      full = [{ i: 'arrow-down' }, PL.mbps(s.measuredDown), ' → ', { b: '?', tone: tn }];
      short = [{ i: 'arrow-down' }, { b: '?', tone: tn }];
      if (cap) { full.push({ i: 'lock', cap: true }); short.push({ i: 'lock', cap: true }); }
    } else if (r && fin(r.delta) && fin(r.predicted)) {
      const d = Math.round(r.delta);
      tn = tone(r.delta);
      const was = fin(r.measured) ? num(r.measured) : fin(r.modelToday) ? '≈' + num(r.modelToday) : '';
      const chip = { chip: PL.signed(d), tone: tn };
      // nothing changes here: the value + a grey "0" ("−58 → −58 (0)" only repeated the number)
      full = d === 0 ? [was, chip] : [was, ' → ', num(r.predicted), chip];
      short = [chip];
      // with a speed result the change of speed comes along when it changes ("↓120 → ≈310")
      const s = r.speed;
      if (view === 'diff' && s && fin(s.predDown) && fin(s.measuredDown) && spTone(s.measuredDown, s.predDown) !== 'zero') {
        full.push(' ', { i: 'arrow-down' }, PL.mbps(s.measuredDown), ' → ', { b: '≈' + PL.mbps(s.predDown), tone: spTone(s.measuredDown, s.predDown) });
        cap = WI.cap(r);
        if (cap && cap.k !== 'plan') full.push({ i: 'lock', cap: true });
      }
    } else if ((view === 'speed' || !sig) && hasSp) {
      full = [{ i: 'arrow-down' }, PL.mbps(m.download), { sep: '/' }, { i: 'arrow-up' }, PL.mbps(m.upload)];
      short = [{ i: 'arrow-down' }, PL.mbps(m.download)];
    } else {
      full = [sig ? num(m.value) : '—'];
      short = full;
    }
    if (other) { const ob = PL.bands.info(m).band; if (ob) full = [...full, { tag: PL.band(ob) }]; }
    const plain = (list) => list.map((x) => {
      if (typeof x === 'string') return x;
      if (x.b !== undefined) return x.b;
      if (x.chip !== undefined) return list.length === 1 ? x.chip : ` (${x.chip})`;
      if (x.sep) return ' / ';
      if (x.tag) return ` · ${x.tag} ${t('planner.ghz')}`;
      return x.i === 'arrow-down' ? '↓' : x.i === 'arrow-up' ? '↑' : '';
    }).join('').trim();
    const text = plain(full);
    return { key: JSON.stringify([full, short, tn, i]), full, short, tone: tn, text, shortText: plain(short), cap, no: i + 1 };
  };

  function parts(list) {
    return list.map((x) => {
      if (typeof x === 'string') return x;
      if (x.i) return x.cap ? el('span.pl-lab__cap', ui().icon(x.i, 16)) : ui().icon(x.i, 16);
      if (x.chip !== undefined) return el(`span.pl-chip.pl-chip--${x.tone || 'zero'}`, x.tone === 'up' || x.tone === 'down' ? ui().icon(x.tone === 'up' ? 'arrow-up' : 'arrow-down', 16) : null, el('span', x.chip));
      if (x.b !== undefined) return el(`b.pl-lab__v.pl-lab__v--${x.tone || 'zero'}`, x.b);
      if (x.sep) return el('span.pl-mk__sep', x.sep);
      if (x.tag) return el('span.pl-lab__tag', x.tag);
      return null;
    });
  }
  /** Fill the value label of a dot with both lengths (CSS picks one through data-lv on the marker). */
  WI.fill = (val, lab) => {
    val.replaceChildren(el('span.pl-lv0', parts(lab.full)), el('span.pl-lv1', parts(lab.short)));
    val.dataset.tone = lab.tone || '';
  };

  // ---------------------------------------------------------------------------------------------------------------
  // tooltip, summary, verdict
  // ---------------------------------------------------------------------------------------------------------------
  const db = (v) => WH.util.dbm(v);
  /** Tooltip lines of a measurement dot while the scenario differs from today. */
  WI.tip = (m) => {
    const r = WI.active() && WI.onMap() ? WI.row(m.id) : null;
    if (!r || !fin(r.predicted)) return [];
    const line = (cls, ...k) => el('div' + cls, ...k);
    const tn = tone(r.delta);
    const out = [el('div.pl-tip__sep')];
    if (fin(r.measured)) out.push(line('.text-muted', t('planner.wi.tip.measured', { v: db(r.measured) })));
    if (fin(r.modelToday) && fin(r.modelNew)) out.push(line('.text-muted', t('planner.wi.tip.model', { a: db(r.modelToday), b: db(r.modelNew) })));
    out.push(line('.pl-tip__wi', el('span', t('planner.wi.tip.pred')), el('b.num', db(r.predicted)), el(`span.pl-chip.pl-chip--${tn}`, tn !== 'zero' ? ui().icon(tn === 'up' ? 'arrow-up' : 'arrow-down', 16) : null, el('span', PL.db(r.delta)))));
    if (PL.P().node.mode !== 'none' && r.source) out.push(line('.text-muted', t(r.source === 'node' ? 'planner.wi.tip.fromNode' : 'planner.wi.tip.fromRouter')));
    // Auto (SPEC 13): a steering device may move to another band after the change
    const bn = WH.engine.units.normBand(r.bandNew);
    if (bn && bn !== WH.engine.units.normBand(r.band)) out.push(line('.text-muted', t('planner.wi.tip.bandNew', { a: PL.band(r.band), b: PL.band(bn) })));
    const s = r.speed;
    if (s && fin(s.predDown)) {
      const a = fin(s.measuredDown) ? `${PL.mbps(s.measuredDown)} → ≈${PL.mbps(s.predDown)}` : `≈${PL.mbps(s.predDown)}`;
      const b = fin(s.predUp) ? ` · ↑ ${fin(s.measuredUp) ? PL.mbps(s.measuredUp) + ' → ' : ''}≈${PL.mbps(s.predUp)}` : '';
      out.push(line('.pl-tip__speed', ui().icon('download', 16), el('span', `${a}${b} ${t('planner.mbps')}`)));
      const c = WI.cap(r);
      if (c) out.push(line('.pl-tip__cap', ui().icon('lock', 16), el('span', WI.capText(c))));
      if (slower(r)) out.push(line('.text-muted', t('planner.wi.tip.slower')));
    } else if (s && r.changed && fin(s.measuredDown) && (s.reason === 'backhaul' || s.reason === 'weak')) {
      // no speed estimate after the change: say why instead of leaving the speed out
      out.push(line('.pl-tip__cap', ui().icon('lock', 16), el('span', t(s.reason === 'backhaul' ? 'planner.wi.capU' : 'planner.wi.tip.weak'))));
    }
    out.push(line('.text-muted.text-xs', t('planner.wi.tip.note')));
    return out;
  };

  /** Rows sorted by benefit + the numbers of the summary; null when nothing to say. */
  WI.summary = () => {
    if (!WI.active()) return null;
    const rows = WI.rows();
    if (!rows) return null;
    const p = PL.P();
    const items = [];
    p.measurements.forEach((m, i) => { const r = cache.by.get(m.id); if (r && fin(r.delta) && fin(r.predicted)) items.push({ m, r, i, d: r.delta }); });
    if (!items.length) return null;
    items.sort((a, b) => b.d - a.d || a.i - b.i);
    const avg = items.reduce((s, x) => s + x.d, 0) / items.length;
    return {
      items, n: items.length, avg,
      up: items.filter((x) => x.d >= 1).length, down: items.filter((x) => x.d <= -1).length,
      same: items.filter((x) => x.d > -1 && x.d < 1).length, best: items[0], worst: items[items.length - 1],
    };
  };
  /** Who makes the change: the node type, the new router position, or both. */
  const who = () => {
    const p = PL.P();
    const node = p.node.mode !== 'none';
    return t('planner.wi.who.' + (node && PL.moved() ? 'both' : node ? p.node.mode : 'router'));
  };
  WI.verdict = (s) => {
    if (!s) return '';
    const w = who();
    // two points of the same name (two dots in one room) get their list number: „Ložnice“ (3)
    const p0 = PL.P();
    const name = (x) => {
      const nm = x.m.name || t('planner.m.defName', { n: x.i + 1 });
      return p0.measurements.some((y) => y !== x.m && y.name === x.m.name) ? t('planner.wi.nameNo', { name: nm, n: x.i + 1 }) : nm;
    };
    const b = s.best;
    const z = s.worst;
    if (b.d < 1 && z.d > -1) return t('planner.wi.v.none', { who: w });
    if (b.d < 1) return t('planner.wi.v.hurt', { who: w, name: name(z), d: PL.db(z.d) });
    let txt;
    const bs = b.r.speed;
    // a stronger signal through a repeater can still mean LESS speed (its link to the router binds): say it plainly
    if (slower(b.r)) txt = t('planner.wi.v.helpSlow', { who: w, name: name(b), d: PL.db(b.d), a: PL.mbps(bs.measuredDown), b: PL.mbps(bs.predDown), cap: WI.capNoun(WI.cap(b.r)) });
    else if (weakLink(b.r)) txt = t('planner.wi.v.helpWeak', { who: w, name: name(b), d: PL.db(b.d) });
    else {
      txt = t('planner.wi.v.help', { who: w, name: name(b), d: PL.db(b.d) });
      const c = WI.cap(b.r);
      if (c && c.k !== 'plan') txt += t('planner.wi.v.cap', { cap: WI.capNoun(c) });
      txt += '.';
    }
    const sl = s.items.find((x) => x !== b && slower(x.r));
    if (z !== b && z.d <= -1) txt += ' ' + t('planner.wi.v.worse', { name: name(z), d: PL.db(z.d) });
    else if (sl) txt += ' ' + t('planner.wi.v.slower', { name: name(sl), a: PL.mbps(sl.r.speed.measuredDown), b: PL.mbps(sl.r.speed.predDown) });
    else if (s.same && z !== b) { const same = s.items.find((x) => x.d > -1 && x.d < 1); if (same) txt += ' ' + t('planner.wi.v.same', { name: name(same) }); }
    // the link to the router is what slows it down: the one thing that helps is a spot closer to the router
    const mode = PL.P().node.mode;
    const linkBinds = (r) => (slower(r) && r.speed.limitedBy === 'backhaul') || weakLink(r);
    if ((mode === 'repeater' || mode === 'mesh_wifi') && s.items.some((x) => linkBinds(x.r))) txt += ' ' + t('planner.wi.v.closer');
    return txt;
  };
  let link = { a: null, v: null };
  /** engine.speed.nodeLink for the current scenario (the backhaul band's own curve when there is one), cached per analysis. */
  WI.link = () => {
    const p = PL.P();
    const S = PL.S;
    const E = WH.engine;
    if (!p || p.node.mode === 'none' || !S.a) return null;
    if (link.a === S.a && link.mv === S.measVer) return link.v;
    let v = null;
    try {
      const meas = PL.filledMeasurements();
      const curve = PL.speedCurve(p.view.band, meas).curve;
      const bh = E.speed.buildCurve(meas, { band: p.node.backhaulBand, device: p.goal.device });
      v = E.speed.nodeLink(S.a.ctx, E.model.fieldParams(p, 'trial', { offsets: S.offs }), curve, bh ? { backhaulCurve: bh } : {});
    } catch (e) { PL.report(e, 'whatif.nodeLink', { bug: true }); v = null; }
    link = { a: S.a, mv: S.measVer, v };
    return v;
  };
  /** Throughput of the second node's wireless link to the router (Mb/s), NaN when unknown (no speed curve / wired). */
  WI.backhaulMbps = () => { const l = WI.link(); return l && l.wireless && l.known && fin(l.down) ? l.down : NaN; };
  /** One line for the Result card. */
  WI.resultLine = (s) => (s ? t('planner.wi.res', { n: s.n, d: PL.db(s.avg), up: s.up, down: s.down }) : '');

  /** "Co by se změnilo v tvých bodech" (Measurements card). Shown while the scenario differs from today. */
  WI.section = () => {
    const head = el('div.pl-cap.pl-wi__head', el('span', t('planner.wi.title')), ui().hint('whatIf'));
    const sum = el('p.pl-wi__sum');
    // only the one-sentence verdict is announced (the list would be read out on every change)
    const verdict = el('p.pl-wi__verdict', { 'aria-live': 'polite' });
    const list = el('ol.pl-wi__list');
    const tip = el('p.text-xs.text-muted.pl-wi__idle');
    const box = el('div.pl-wi', head, verdict, sum, list);
    const root = el('div.pl-wi-host', box, tip);
    let key = '';
    function row(x) {
      const r = x.r;
      const tn = tone(x.d);
      const was = fin(r.measured) ? num(r.measured) : fin(r.modelToday) ? '≈' + num(r.modelToday) : '';
      const st = r.speed && fin(r.speed.predDown) ? spTone(r.speed.measuredDown, r.speed.predDown) : 'zero';
      const sp = r.speed && fin(r.speed.predDown)
        ? el('span.pl-wi__sp', ui().icon('download', 16), fin(r.speed.measuredDown) ? PL.mbps(r.speed.measuredDown) + ' → ' : '', el(`b.pl-lab__v.pl-lab__v--${st}`, '≈' + PL.mbps(r.speed.predDown)), ` ${t('planner.mbps')}`)
        : null;
      const c = WI.cap(r) || (weakLink(r) ? { k: 'backhaul', v: null } : null);
      const b = el('button.pl-wi__row', { type: 'button', 'aria-label': t('planner.wi.rowAria', { name: x.m.name, a: was, b: num(r.predicted), d: PL.db(r.delta) }) + (c ? ' · ' + WI.capText(c) : '') },
        el('span.pl-wi__no', String(x.i + 1)),
        el('span.pl-wi__main', el('span.pl-wi__name.truncate', x.m.name), el('span.pl-wi__sub', el('span.num', `${was} → ${num(r.predicted)} dBm`), sp, c ? el('span.pl-wi__capt', ui().icon('lock', 16), WI.capText(c)) : null)),
        el(`span.pl-chip.pl-chip--${tn}`, tn !== 'zero' ? ui().icon(tn === 'up' ? 'arrow-up' : 'arrow-down', 16) : null, el('span', PL.signed(Math.round(x.d)))));
      b.addEventListener('click', () => { if (PL.showMeas) PL.showMeas(x.m.id); });
      return el('li', b);
    }
    return {
      el: root,
      sync(q) {
        if (q === 'coarse') return;   // while the router is dragged: once the pointer rests
        const p = PL.P();
        const s = WI.summary();
        const k = s ? JSON.stringify([WH.i18n.lang, s.items.map((x) => [x.m.id, x.m.name, Math.round(x.d * 10), x.r.predicted, x.r.speed && x.r.speed.predDown, x.r.speed && x.r.speed.limitedBy]), p.node.mode, PL.moved()]) : 'none' + WH.i18n.lang + (p.measurements.length > 0) + WI.active() + !!WI.rows();
        if (k === key) return;
        key = k;
        box.hidden = !s;
        // nothing changed yet: say how to see it (only with measurements and the engine's prediction available)
        tip.hidden = !!s || !p.measurements.length || WI.active();
        tip.textContent = t('planner.wi.idle');
        if (!s) { list.replaceChildren(); return; }
        verdict.textContent = WI.verdict(s);
        sum.replaceChildren(
          el('span', t('planner.wi.avg', { d: PL.db(s.avg) })),
          el('span.pl-wi__cnt.pl-wi__cnt--up', t('planner.wi.up', { n: s.up })),
          el('span.pl-wi__cnt.pl-wi__cnt--down', t('planner.wi.down', { n: s.down })),
          el('span.pl-wi__cnt', t('planner.wi.same', { n: s.same })));
        list.replaceChildren(...s.items.map(row));
      },
    };
  };
})();
