/* Floor-plan editor - inspector (right sidebar; below the stage on narrow screens).
 * Top card: "Půdorys" (nothing selected) or the properties of the selected object.  Then "Kontrola půdorysu" (plan check)
 * and a searchable object list.  Cards are built once per selection and only re-synced on store changes (an input the
 * user is typing in is never overwritten). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ICON = { room: 'rect', wall: 'wall', door: 'door', furniture: 'sofa' };
  const ISSUE_ICON = { gap: 'warning', door: 'door', edges: 'autowall', overlap: 'layers', outside: 'sofa', scale: 'ruler' };
  const fmt = (n, d) => WH.util.fmt(n, d);
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const typing = (n) => document.activeElement === n;

  let aside = null;
  let scaleBox = null;
  let topBox = null;
  let top = null;           // {key, el, sync()}
  let checkCard = null;
  let listCard = null;
  let listBody = null;
  let searchIn = null;
  let listSig = '';
  let listTimer = 0;

  // ---------------------------------------------------------------------------------------------------------------
  // small builders
  // ---------------------------------------------------------------------------------------------------------------
  function section(titleKey, hintKey, ...kids) {
    const h = el('div.ed-sec__title', el('span', { 'data-i18n': titleKey }, t(titleKey)));
    if (hintKey) h.append(WH.ui.hint(hintKey));
    return el('div.ed-sec', h, ...kids);
  }
  function kv(rows) { return el('dl.kv.ed-kv', rows.map(([k, v]) => el('div', el('dt', k), el('dd.num', v)))); }
  function withKbd(node, spec) { node.append(el('span.ed-kbd.hide-touch', WH.ui.kbd(spec))); return node; }
  ED.withKbd = withKbd;
  function numIn(o) {
    const i = WH.ui.numberInput(o);
    i.classList.add('input--sm');
    return i;
  }
  /** Select of wall materials / furniture kinds labelled with their per-band loss ("Cihla · 7 / 11 / 13 dB") and a
   *  "dB at 2.4 / 5 / 6 GHz" caption with a hint (SPEC 7.1). */
  function bandSelect(label, opts, o) {
    const s = WH.ui.select(opts, o);
    const f = WH.ui.field({ label, hint: o.hint, control: s });
    const cap = el('div.field__hint.ed-bandcap', { id: `${s.id}-bands` }, el('span', t('editor.f.bands')), WH.ui.hint('bandLoss'));
    f.insertBefore(cap, f.querySelector('.field__error'));
    s.setAttribute('aria-describedby', cap.id);
    f.sel = s;
    return f;
  }
  /** "default" (follows the model) | a preset key | "custom" (own number) for a wall. */
  const matOf = (w) => (!w.material ? 'default' : WH.engine.model.presetOf(w) || 'custom');
  /** A furniture kind whose table applies, else "custom" (own number). */
  const kindOf = (f) => WH.engine.model.presetOf(f) || 'custom';
  /** Material options; the default one shows what model.wallLoss means per band. */
  function matOptions(withCustom) {
    const T = ED.table('wall');
    return [{ value: 'default', label: `${t('editor.mat.default')} · ${ED.fmtBands(ED.triple(ED.proj().model.wallLoss))}` }]
      .concat(Object.keys(T).map((k) => ({ value: k, label: `${t(`editor.mat.${k}`)} · ${ED.fmtBands(T[k])}` })))
      .concat(withCustom ? [{ value: 'custom', label: t('editor.mat.custom') }] : []);
  }
  ED.matOptions = matOptions;

  // ---------------------------------------------------------------------------------------------------------------
  // "Půdorys" card (nothing selected)
  // ---------------------------------------------------------------------------------------------------------------
  function planCard() {
    const E = WH.engine;
    const card = WH.ui.card({ id: 'ed-plan', title: 'editor.card.plan', icon: 'plan', collapsible: false });
    const stats = el('div.ed-stats');
    const statEls = {};
    for (const [k, icon] of [['rooms', 'rect'], ['walls', 'wall'], ['doors', 'door'], ['furniture', 'sofa']]) {
      const n = el('b.num');
      const l = el('span');
      statEls[k] = { n, l };
      stats.append(el('div.ed-stat', WH.ui.icon(icon, 18), el('span.ed-stat__txt', n, l)));
    }

    // (the scale has its own card at the top of the inspector: 45-scale.js)
    // floor of a multi-storey plan: name, level, ceiling (55-floors.js)
    const floorSec = ED.floors ? ED.floors.section() : null;

    // walls
    const auto = WH.ui.button({ i18n: 'editor.autoWalls', icon: 'autowall', onClick: () => ED.autoWallsAll() });
    const wallSec = section('editor.sec.walls', 'autoWalls', el('div.cluster', auto));

    // tracing background
    const bgSec = section('editor.sec.bg', 'trace');
    const bgBody = el('div.stack.ed-bg-body', { style: { '--gap': '10px' } });
    bgSec.append(bgBody);
    let bgState = null;
    function buildBg(has) {
      bgBody.replaceChildren();
      if (!has) {
        bgBody.append(el('div.cluster', WH.ui.button({ i18n: 'editor.bg.upload', icon: 'upload', onClick: () => WH.io.openPicker({ asBackground: true }) })));
        return;
      }
      const sw = WH.ui.switch({ i18n: 'editor.bg.show', checked: ED.pref('bg'), onChange: (v) => ED.setPref('bg', v) });
      sw.querySelector('.switch__label').after(el('span.ed-kbd.hide-touch', WH.ui.kbd('t')));
      const op = WH.ui.range({ min: 10, max: 100, step: 5, value: Math.round(ED.bgAlpha() * 100), format: (v) => WH.util.fmtPct(v), ariaLabel: t('editor.bg.opacity'), onInput: (v) => ED.setPref('bgOpacity', v / 100) });
      const fOp = WH.ui.field({ label: 'editor.bg.opacity', hint: 'opacity', control: op });
      const btns = el('div.cluster',
        WH.ui.button({ i18n: 'editor.bg.replace', icon: 'image', size: 'sm', onClick: () => WH.io.openPicker({ asBackground: true }) }),
        WH.ui.button({ i18n: 'editor.bg.remove', icon: 'trash', size: 'sm', variant: 'danger-soft', onClick: () => ED.commit('editor.undo.bgRemove', (pl) => { pl.background = null; }) }));
      bgBody.append(sw, fOp, btns);
      bgBody._sw = sw;
      bgBody._op = op;
    }

    // snapping
    const snapSw = WH.ui.switch({ i18n: 'editor.snap', hint: 'snap', checked: ED.pref('snap'), onChange: (v) => ED.setPref('snap', v) });
    snapSw.querySelector('.switch__label').after(el('span.ed-kbd.hide-touch', WH.ui.kbd('g')));

    // colours / project
    const colors = WH.ui.button({ i18n: 'editor.colors', icon: 'palette', size: 'sm', variant: 'ghost', onClick: () => ED.recolor() });
    const note = el('p.ed-note', { 'data-i18n': 'editor.markersNote' }, t('editor.markersNote'));
    const proj = el('div.cluster',
      WH.ui.button({ i18n: 'editor.demo', icon: 'home', size: 'sm', onClick: () => ED.newProject('demo') }),
      WH.ui.button({ i18n: 'editor.new', icon: 'plan', size: 'sm', onClick: () => ED.newProject('blank') }));

    card.body.append(stats, floorSec ? floorSec.el : '', wallSec, bgSec, el('div.ed-sec', snapSw, colors), note, el('div.ed-sec', proj));

    function sync() {
      const pl = ED.plan();
      if (!pl) return;
      for (const k of ['rooms', 'walls', 'doors', 'furniture']) {
        const n = pl[k].length;
        statEls[k].n.textContent = String(n);
        statEls[k].l.textContent = ` ${t(`editor.count.${k}`, { n })}`;
      }
      if (floorSec) floorSec.sync();
      const has = !!pl.background;
      if (has !== bgState) { bgState = has; buildBg(has); }
      if (has && bgBody._sw) { bgBody._sw.setChecked(ED.pref('bg')); if (!typing(bgBody._op.input)) bgBody._op.setValue(Math.round(ED.bgAlpha() * 100)); }
      snapSw.setChecked(ED.pref('snap'));
      const cols = pl.rooms.map((r) => r.color);
      colors.hidden = !(pl.rooms.length > 1 && new Set(cols).size < Math.min(cols.length, E.project.ROOM_COLORS.length));
    }
    return { key: 'plan', el: card, sync };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // selected object
  // ---------------------------------------------------------------------------------------------------------------
  function objCard(o) {
    const E = WH.engine;
    const id = o.id;
    const syncs = [];
    const close = WH.ui.iconButton({ icon: 'x', tip: 'editor.deselect', kbd: 'Esc', size: 'sm', onClick: () => ED.select(null) });
    const card = WH.ui.card({ id: 'ed-sel', title: `editor.type.${o.type}`, icon: ICON[o.type], collapsible: false, actions: [close] });
    card.classList.add('ed-sel-card');
    const body = [];

    // name
    const name = el('input.input', { type: 'text', maxlength: '50', autocomplete: 'off', spellcheck: 'false' });
    name.value = o.name;
    const commitName = () => {
      const cur = ED.find(id);
      if (!cur) return;
      const v = ED.cut50(name.value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
      if (!v) { name.value = cur.name; return; }
      if (v !== cur.name) ED.edit(id, (ob) => { ob.name = v; });
    };
    name.addEventListener('change', commitName);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { const cur = ED.find(id); if (cur) name.value = cur.name; e.stopPropagation(); name.blur(); }
    });
    body.push(WH.ui.field({ label: 'editor.f.name', control: name }));
    syncs.push((ob) => { if (!typing(name)) name.value = ob.name; });

    if (o.type === 'room') {
      const C = E.project.ROOM_COLORS;
      const sw = el('div.ed-swatches', { role: 'group', 'aria-label': t('editor.f.color') });
      const paint = (ob) => {
        sw.replaceChildren();
        const list = C.includes(ob.color) ? C.slice() : [ob.color].concat(C);
        list.forEach((c, i) => {
          const on = c === ob.color;
          const b = el('button.ed-swatch', { type: 'button', 'aria-pressed': on ? 'true' : 'false', style: { '--c': c }, 'aria-label': i === 0 && !C.includes(ob.color) ? t('editor.color.current') : t('editor.color.n', { n: C.indexOf(c) + 1 }) });
          if (on) b.append(WH.ui.icon('check', 16));
          b.addEventListener('click', () => ED.edit(id, (r) => { r.color = c; }));
          sw.append(b);
        });
      };
      paint(o);
      let lastColor = o.color;
      syncs.push((ob) => { if (ob.color !== lastColor) { lastColor = ob.color; const f = document.activeElement && sw.contains(document.activeElement); paint(ob); if (f) { const b = sw.querySelector('[aria-pressed="true"]'); if (b) b.focus(); } } });
      body.push(el('div.field', el('div.field__label', t('editor.f.color')), sw));
      const area = el('span');
      syncs.push((ob) => { area.textContent = ED.fmtArea(ob.points); });
      body.push(kv([[t('editor.f.area'), area]]));
      // "Tahle místnost má [14] m²" -> the scale of the whole plan (SPEC 14.3, 14.1 addition)
      const sf = ED.scaling.objectForm(o);
      syncs.push(sf.sync);
      body.push(sf.el);
    }

    if (o.type === 'wall') {
      const T = ED.table('wall');
      const fMat = bandSelect('editor.f.material', matOptions(true), {
        value: matOf(o), hint: 'wallMaterial',
        onChange: (v) => ED.edit(id, (w) => {
          if (v === 'default') { delete w.material; delete w.loss; } else if (v === 'custom') { w.loss = ED.wallLoss(w); w.material = 'custom'; } else { w.material = v; w.loss = T[v][1]; }
        }),
      });
      const mat = fMat.sel;
      body.push(fMat);
      const loss = numIn({
        min: 0, max: 30, step: 0.5, ariaLabel: t('editor.f.loss5'),
        onChange: (v) => {
          if (v === null) { syncNow(); return; }
          const val = Math.round(Math.min(30, Math.max(0, v)) * 10) / 10;
          ED.edit(id, (w) => { if (ED.wallLoss(w) === val && w.material) return false; w.material = 'custom'; w.loss = val; return undefined; });
        },
      });
      body.push(WH.ui.field({ label: 'editor.f.loss5', unit: 'dB', control: loss, inline: true }));
      const len = el('span');
      body.push(kv([[t('editor.f.length'), len]]));
      body.push(el('div.cluster', WH.ui.button({ i18n: 'editor.addDoor', icon: 'door', size: 'sm', variant: 'soft', onClick: () => { const w = ED.find(id); if (w) ED.addDoor(id, { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }); } })));
      // "Tahle zeď měří [4,2] m" -> the scale of the whole plan
      const sf = ED.scaling.objectForm(o);
      syncs.push(sf.sync);
      body.push(sf.el);
      syncs.push((w) => {
        if (!typing(mat)) mat.value = matOf(w);
        if (!typing(loss)) loss.setValue(ED.wallLoss(w));
        len.textContent = ED.fmtM(ED.dpx(w.a, w.b));
      });
    }

    if (o.type === 'door') {
      const seg = WH.ui.segmented([{ value: 'open', i18n: 'editor.door.open' }, { value: 'closed', i18n: 'editor.door.closed' }], {
        value: o.loss > 0 ? 'closed' : 'open', size: 'sm', block: true, aria: 'editor.f.doorType',
        onChange: (v) => ED.edit(id, (d) => { d.loss = v === 'closed' ? 3 : 0; }),
      });
      body.push(el('div.field', el('div.field__label', t('editor.f.doorType'), WH.ui.hint('doorLoss')), seg));
      const loss = numIn({
        min: 0, max: 30, step: 0.5, ariaLabel: t('editor.f.loss5'),
        onChange: (v) => { if (v === null) { syncNow(); return; } ED.edit(id, (d) => { d.loss = Math.round(Math.min(30, Math.max(0, v)) * 10) / 10; }); },
      });
      body.push(WH.ui.field({ label: 'editor.f.loss5', unit: 'dB', control: loss, inline: true }));
      const width = numIn({
        min: 0.1, max: 20, step: 0.05, ariaLabel: t('editor.f.width'),
        onChange: (v) => { if (v === null || !(v > 0)) { syncNow(); return; } resizeDoor(id, v); },
      });
      body.push(WH.ui.field({ label: 'editor.f.width', unit: 'm', control: width, inline: true }));
      const wallName = el('span.truncate');
      const goWall = WH.ui.button({ i18n: 'editor.selectWall', icon: 'wall', size: 'sm', variant: 'ghost', onClick: () => { const d = ED.find(id); if (d) ED.select(d.wallId); } });
      // label on its own line: "Ve zdi:" squeezed next to a long wall name wrapped into "Ve / zdi:"
      body.push(el('div.field.ed-onwall-field', el('div.field__label', el('span', t('editor.f.onWall'))), el('div.ed-onwall', wallName, goWall)));
      syncs.push((d) => {
        seg.setValue(d.loss > 0 ? 'closed' : 'open', true);
        if (!typing(loss)) loss.setValue(d.loss);
        if (!typing(width)) width.setValue(Math.round(ED.dpx(d.a, d.b) * ED.mpp() * 100) / 100);
        const w = ED.find(d.wallId);
        wallName.textContent = w ? w.name : '—';
      });
    }

    if (o.type === 'furniture') {
      const T = ED.table('furn');
      const fKind = bandSelect('editor.f.kind', Object.keys(T).map((k) => ({ value: k, label: `${t(`editor.kind.${k}`)} · ${ED.fmtBands(T[k])}` }))
        .concat([{ value: 'custom', label: t('editor.kind.custom') }]), {
        value: kindOf(o),
        // an opening never blocks (the project normalisation forces it too); leaving it makes a piece block again
        onChange: (v) => ED.edit(id, (f) => { const was = f.kind; f.kind = v; if (T[v]) f.loss = T[v][1]; if (v === 'opening') f.blocksSignal = false; else if (was === 'opening') f.blocksSignal = true; }),
      });
      const kind = fKind.sel;
      body.push(fKind);
      const loss = numIn({
        min: 0, max: 30, step: 0.5, ariaLabel: t('editor.f.loss5'),
        onChange: (v) => { if (v === null) { syncNow(); return; } ED.edit(id, (f) => { f.loss = Math.round(Math.min(30, Math.max(0, v)) * 10) / 10; }); },
      });
      body.push(WH.ui.field({ label: 'editor.f.loss5', hint: 'furnitureLoss', unit: 'dB', control: loss, inline: true }));
      const blocks = WH.ui.switch({ i18n: 'editor.f.blocks', hint: 'blocksSignal', checked: o.blocksSignal !== false, onChange: (v) => ED.edit(id, (f) => { f.blocksSignal = v; }) });
      body.push(blocks);
      const area = el('span');
      body.push(kv([[t('editor.f.area'), area]]));
      syncs.push((f) => {
        if (!typing(kind)) kind.value = kindOf(f);
        if (!typing(loss)) loss.setValue(f.loss);
        blocks.setChecked(f.blocksSignal !== false);
        area.textContent = ED.fmtArea(f.points);
      });
    }

    // shortcuts in the tooltips: with <kbd> chips inside, the two buttons no longer fit on one line
    const dup = WH.ui.button({ i18n: 'editor.duplicate', icon: 'copy', size: 'sm', tip: 'editor.duplicate', kbd: 'ctrl+d', onClick: () => ED.duplicate(id) });
    const del = WH.ui.button({ i18n: 'editor.delete', icon: 'trash', size: 'sm', variant: 'danger-soft', tip: 'editor.delete', kbd: 'delete', onClick: () => ED.remove(id) });
    for (const b of [dup, del]) b.querySelector('.btn__kbd').remove();
    if (o.type === 'door') dup.hidden = true;
    body.push(el('div.cluster.ed-actions', dup, del));
    card.body.append(...body);

    function syncNow() { const ob = ED.find(id); if (ob) for (const f of syncs) f(ob); }
    return { key: `sel:${id}${o.type === 'wall' ? `:${ED.proj().model.wallLoss}` : ''}`, el: card, sync: syncNow };
  }

  /** Door width from the inspector: resized around its centre, kept inside the wall. */
  function resizeDoor(id, metres) {
    ED.edit(id, (d, pl) => {
      const w = pl.walls.find((x) => x.id === d.wallId);
      const len = w ? ED.dpx(w.a, w.b) : 0;
      if (!w || len < 1) return false;
      const G = WH.engine.geom;
      const ta = G.closestOnSegment(d.a, w.a, w.b).t;
      const tb = G.closestOnSegment(d.b, w.a, w.b).t;
      const c = (ta + tb) / 2;
      const half = Math.min(1, Math.max(8, metres / ED.mpp()) / len) / 2;
      let lo = c - half;
      let hi = c + half;
      if (lo < 0) { hi -= lo; lo = 0; }
      if (hi > 1) { lo -= hi - 1; hi = 1; }
      lo = Math.max(0, lo);
      const at = (k) => ED.P(w.a.x + (w.b.x - w.a.x) * k, w.a.y + (w.b.y - w.a.y) * k);
      const [p, q] = ta <= tb ? [at(lo), at(hi)] : [at(hi), at(lo)];
      d.a = p;
      d.b = q;
      return undefined;
    });
  }

  function showTop() {
    const s = ED.S;
    const o = s.sel && ED.find(s.sel);
    const key = o ? `sel:${o.id}${o.type === 'wall' ? `:${ED.proj().model.wallLoss}` : ''}` : 'plan';
    if (top && top.key === key) { top.sync(); return; }
    const had = top && topBox.contains(document.activeElement);
    const prevKey = top && top.key;
    top = o ? objCard(o) : planCard();
    topBox.replaceChildren(top.el);
    top.sync();
    // a new selection shows its properties from the top (the inspector kept the scroll position of the previous card,
    // so e.g. a freshly placed door opened with its name field scrolled out of view)
    if (o && prevKey !== key && aside && aside.scrollTop > topBox.offsetTop) aside.scrollTop = Math.max(0, topBox.offsetTop - 8);
    if (had) { try { top.el.querySelector('input,button,select').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // plan check card
  // ---------------------------------------------------------------------------------------------------------------
  function renderIssues() {
    if (!checkCard) return;
    const s = ED.S;
    const pl = ED.plan();
    const issues = s.issues.filter((i) => !s.ignored.has(i.key));
    checkCard.setBadge(issues.length || null);
    const box = checkCard.body;
    box.replaceChildren();
    if (!pl || (!pl.rooms.length && !pl.walls.length)) { box.append(el('p.ed-note', t('editor.check.empty'))); return; }
    if (!issues.length) {
      box.append(el('div.notice.notice--ok', WH.ui.icon('check-circle', 18), el('span', t('editor.check.ok'))));
      return;
    }
    const list = el('div.ed-issues');
    for (const is of issues) {
      const actions = el('div.cluster.ed-issue__actions');
      if (is.box) actions.append(WH.ui.button({ i18n: 'editor.check.show', icon: 'search', size: 'sm', variant: 'ghost', onClick: () => showIssue(is) }));
      if (is.fix === 'scale') {
        // scale sanity checks (SPEC 14.1): one click to the place where the scale is set
        actions.append(WH.ui.button({ i18n: 'editor.check.setScale', icon: 'ruler', size: 'sm', variant: 'soft', onClick: () => ED.scaling.fixIssue(is) }));
      } else if (is.fix) {
        actions.append(WH.ui.button({
          i18n: is.fix === 'join' || is.fix === 'snap' ? 'editor.check.join' : is.fix === 'edges' ? 'editor.check.addWalls' : 'editor.check.fix', icon: 'check', size: 'sm', variant: 'soft',
          onClick: () => {
            if (ED.check.fix(is)) {
              s.focus = null;
              const note = ED.check.lastNote;
              WH.ui.toast({ text: note ? t(note.key, note.params) : t('editor.check.fixed'), action: { i18n: 'ui.undo', fn: () => { if (WH.store.canUndo()) WH.store.undo(); } } }, { kind: 'ok' });
              ED.req();
            } else WH.ui.toast({ i18n: 'editor.check.cantFix' }, { kind: 'warn' });
          },
        }));
      }
      const ignore = () => { s.ignored.add(is.key); if (s.focus === is) s.focus = null; renderIssues(); ED.req(); };
      // room edges without walls are often real open passages: say so in words instead of a bare "ignore" eye
      if (is.type === 'edges') actions.append(WH.ui.button({ i18n: 'editor.check.keepOpen', icon: 'eye-off', size: 'sm', variant: 'ghost', onClick: ignore }));
      else actions.append(WH.ui.iconButton({ icon: 'eye-off', tip: 'editor.check.ignore', size: 'sm', onClick: ignore }));
      const info = is.type === 'edges';
      const k = is.type === 'scale' ? `editor.issue.scale.${is.code}` : `editor.issue.${is.type}`;
      const text = t(`${k}.b`, is.params) + (is.params && is.params.floor ? ` ${t('editor.issue.onFloor', { floor: is.params.floor })}` : '');
      list.append(el(`div.ed-issue${info ? '.ed-issue--info' : ''}`,
        el('span.ed-issue__icon', WH.ui.icon(ISSUE_ICON[is.type] || 'warning', 18)),
        el('div.ed-issue__main',
          el('div.ed-issue__title', t(`${k}.t`)),
          el('div.ed-issue__text', text),
          actions)));
    }
    box.append(list);
  }

  function showIssue(is) {
    const s = ED.S;
    if (is.floor && ED.floors && is.floor !== ED.activeFloorId()) ED.floors.switchTo(is.floor);
    if (is.ids.length && ED.find(is.ids[0])) ED.select(is.ids[0]);
    s.focus = is;
    ED.zoomTo(is.box);
    ED.req();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // object list
  // ---------------------------------------------------------------------------------------------------------------
  function subOf(o) {
    switch (o.type) {
      case 'room': return ED.fmtArea(o.points);
      case 'wall': return `${t(`editor.mat.${matOf(o)}`)} · ${ED.fmtBands(ED.bands(o))}`;
      case 'door': return `${t(o.loss > 0 ? 'editor.door.closedShort' : 'editor.door.openShort')} · ${ED.fmtM(ED.dpx(o.a, o.b))}`;
      default: return `${t(`editor.kind.${kindOf(o)}`)} · ${ED.fmtBands(ED.bands(o))}`;
    }
  }

  function renderList(force) {
    if (!listCard || !listBody) return;
    const pl = ED.plan();
    if (!pl) return;
    const q = fold(searchIn.value.trim());
    const sig = `${WH.i18n.lang}|${q}|${['rooms', 'walls', 'doors', 'furniture'].map((k) => pl[k].map((o) => `${o.id}:${o.name}:${subOf(o)}`).join(',')).join(';')}`;
    if (!force && sig === listSig) { markSelected(); return; }
    listSig = sig;
    const total = pl.rooms.length + pl.walls.length + pl.doors.length + pl.furniture.length;
    listCard.setBadge(total || null);
    listBody.replaceChildren();
    let shown = 0;
    for (const [k, type] of [['rooms', 'room'], ['walls', 'wall'], ['doors', 'door'], ['furniture', 'furniture']]) {
      const items = pl[k].filter((o) => !q || fold(o.name).includes(q));
      if (!items.length) continue;
      shown += items.length;
      const grp = el('div.ed-group', el('div.ed-group__title', WH.ui.icon(ICON[type], 16), el('span', t(`editor.group.${k}`)), el('span.ed-group__n.num', String(items.length))));
      const ul = el('div.list');
      for (const o of items) {
        const row = el('button.list-row.ed-row', { type: 'button', 'data-id': o.id },
          o.type === 'room' ? el('span.ed-row__dot', { style: { '--c': o.color } }) : null,
          el('span.list-row__main', el('span.list-row__title', { style: { display: 'block' } }, o.name), el('span.list-row__sub', { style: { display: 'block' } }, subOf(o))));
        row.addEventListener('click', () => { ED.select(o.id); ED.reveal(o.id); });
        ul.append(row);
      }
      grp.append(ul);
      listBody.append(grp);
    }
    if (!shown) listBody.append(el('p.ed-note', t(total ? 'editor.list.noMatch' : 'editor.list.empty')));
    markSelected();
  }

  function markSelected() {
    if (!listBody) return;
    for (const r of listBody.querySelectorAll('.ed-row')) {
      const on = r.getAttribute('data-id') === ED.S.sel;
      if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
    }
  }

  function scheduleList() {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => { if (WH.store.gestureOpen) { scheduleList(); return; } renderList(false); }, 180);
  }

  // ---------------------------------------------------------------------------------------------------------------
  function build(asideEl) {
    aside = asideEl;
    scaleBox = el('div.ed-scale-box');
    topBox = el('div.ed-top-card');
    checkCard = WH.ui.card({ id: 'ed-check', title: 'editor.card.check', icon: 'check-circle', hint: 'editorCheck' });
    checkCard.classList.add('ed-check-card');
    listCard = WH.ui.card({ id: 'ed-objects', title: 'editor.card.objects', icon: 'list' });
    searchIn = el('input.input.input--sm', { type: 'search', autocomplete: 'off', spellcheck: 'false', 'data-i18n-ph': 'editor.search', 'data-i18n-aria': 'editor.search', placeholder: t('editor.search'), 'aria-label': t('editor.search') });
    searchIn.addEventListener('input', () => renderList(false));
    listBody = el('div.ed-list', { 'data-no-wheel': '' });
    listCard.body.append(searchIn, listBody);
    aside.replaceChildren(scaleBox, topBox, checkCard, listCard);
    refresh();
  }

  /** Full rebuild (language switch, first show). */
  function refresh() {
    if (!aside) return;
    const had = scaleBox.contains(document.activeElement);
    scaleBox.replaceChildren(ED.scaling.buildCard().el);
    ED.scaling.sync();
    if (had) { try { scaleBox.querySelector('input,button').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    top = null;
    showTop();
    renderIssues();
    renderList(true);
  }

  function planChanged() {
    if (!aside) return;
    ED.scaling.sync();
    showTop();
    scheduleList();
  }

  ED.inspector = { build, refresh, planChanged, showTop, renderIssues, renderList: () => renderList(false), markSelected };
})();
