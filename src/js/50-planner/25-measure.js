/* Planner (Wi-Fi view) 2b: measuring (SPEC 6.2).
 *   - the measurement form with the built-in speed test ("Změřit rychlost teď"): a popover anchored at the map point
 *     on desktop, a bottom sheet on phones (< 640 px or a coarse pointer) that never hides the tapped point;
 *   - the phone "measuring mode": full-height map, minimal chrome (band switch, "tap where you stand", count, Done),
 *     44 px targets, screen kept awake (navigator.wakeLock) while it is on.
 * The signal is optional when the point has a speed result (value null; the engine fills in the model's prediction).
 * Stage 6 (SPEC 8 / 8.1): a new measurement leads with the big "Změřit vše" (26-measureall.js: device, Wi-Fi details,
 * quick speed test, automatic save, live checklist, Cancel any time) and an "Info o zařízení" button that shows the device
 * card inline (27-devinfo-ui.js); Wi-Fi details handed in (pasted / helper link / helper) are shown as a chip, prefill
 * the signal + band and are stored as measurement.wifi. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const store = () => WH.store;
  const BANDS = [2.4, 5, 6];
  const PHONE_MQ = '(max-width: 639px), (pointer: coarse)';

  /** Phone layout: the measure tool uses the bottom sheet and the measuring mode is offered. */
  PL.isPhone = () => !!(typeof matchMedia === 'function' && matchMedia(PHONE_MQ).matches);

  const parseNum = (s) => {
    const v = String(s || '').replace(/[−–]/g, '-').replace(',', '.').replace(/[^\d.+-]/g, '');
    if (!v || v === '-' || v === '+') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  /** Rates as they go into the form: one decimal below 10 Mb/s, whole numbers above. */
  const roundRate = (v) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);

  // ---------------------------------------------------------------------------------------------------------------
  // the form (shared by the popover and the sheet)
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * @param {{x,y}} loc the map point (mutable: setPoint moves it)
   * @param {object|null} m the measurement being edited
   * @param {'popover'|'sheet'} layout
   * @param {{onClose:function, onLayout:function, onWide?:function, opts?:object}} hooks  opts = openMeasure's 3rd argument
   * @returns {{body:Node, foot:Node, save:function, focusFirst:function, destroy:function, busy:function, cancel:function, setPoint:function, widget:HTMLElement, applyWifi:function, runAll:function}}
   */
  function buildForm(loc, m, layout, hooks) {
    const U = WH.util;
    const E = WH.engine;
    const p = PL.P();
    const sheet = layout === 'sheet';
    const fo = hooks.opts || {};
    let room = E.project.roomAt(p.plan, loc);
    let unit = store().getPref('planner.unit', 'dbm') === 'pct' ? 'pct' : 'dbm';
    // SPEC 13: the band is what the Wi-Fi details say or what the user picks (2,4 / 5 / 6 / Nevím = 'auto'); a new
    // measurement on a phone starts with this session's answer, never with the map's band (a PC: the helper, or a pick)
    let band = m ? (E.units.normBand(m.band) || 'auto') : sheet ? PL.bands.choice.get() : null;
    let bandTouched = false;
    let alive = true;
    const bandNum = () => E.units.normBand(band);
    const layout2 = () => { if (hooks.onLayout) hooks.onLayout(); };

    // signal (optional)
    const val = el('input.input.input--num', { type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '8', placeholder: unit === 'pct' ? '70' : t('planner.m.ph') });
    if (m && fin(m.value)) val.value = U.fmt(unit === 'pct' ? E.units.dbmToPct(m.value) : m.value, 0).replace('−', '-');
    const unitSeg = ui().segmented([{ value: 'dbm', i18n: 'planner.m.dbm' }, { value: 'pct', i18n: 'planner.m.pct' }], {
      value: unit, size: 'sm', aria: 'planner.m.unit',
      onChange: (u) => {
        const n = parseNum(val.value);
        if (n !== null) val.value = String(Math.round(u === 'pct' ? E.units.dbmToPct(n > 0 ? -n : n) : E.units.pctToDbm(n)));
        unit = u;
        val.placeholder = u === 'pct' ? '70' : t('planner.m.ph');
        store().setPref('planner.unit', u);
      },
    });
    // desktop popover: the "where do I read it" line lives in the "?" hint only (keeps the popover compact); a new
    // measurement on the phone has the device card (i) for it, so the sheet stays low enough to show the tapped point
    const sigF = ui().field({ i18n: 'planner.m.signalOpt', hint: 'whereSignal', control: [val, unitSeg], helpI18n: sheet && m ? 'planner.m.wifiman' : null });
    sigF.classList.add('pl-mform__sig');
    val.addEventListener('input', () => sigF.setError(''));

    // speed: built-in test + manual numbers
    // `test` = the speed result the numbers came from (a test run here, or the stored Cloudflare result when editing)
    let test = m && m.source === 'cloudflare' && fin(m.download) && fin(m.upload) ? { down: m.download, up: m.upload, ping: m.ping, jitter: m.jitter } : null;
    const num = (v) => {
      const i = ui().numberInput({ min: 0, max: 10000, step: 'any', value: v === null || v === undefined ? undefined : v, placeholder: '—' });
      i.addEventListener('input', () => spF.setError(''));
      return i;
    };
    const dn = num(m && m.download);
    const up = num(m && m.upload);
    dn.setAttribute('aria-label', t('planner.m.down'));
    up.setAttribute('aria-label', t('planner.m.up'));
    const spF = ui().field({ i18n: sheet ? 'planner.m.speedManual' : 'planner.m.speedOr', control: [el('span.pl-ico', ui().icon('download', 16)), dn, el('span.pl-ico', ui().icon('upload', 16)), up], unit: 'planner.mbps' });
    spF.classList.add('pl-mform__speed');
    const saveBtn = ui().button({ i18n: 'planner.m.save', kbd: sheet ? null : 'Enter', icon: sheet ? 'check' : null, variant: 'primary', size: sheet ? 'lg' : 'sm', type: 'submit' });
    let more = null;
    // a result far from the earlier tests (same band + device) or with upload far above download is usually a
    // hiccup of the connection, not of the Wi-Fi: suggest repeating it before it shapes the speed map
    const oddNote = el('div.notice.notice--warn.pl-mnote', { hidden: true }, ui().icon('warning', 18), el('span', t('planner.m.odd')));
    const checkOdd = (r) => {
      const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
      const dk = (d) => String(d || '').trim().toLowerCase();
      const prev = PL.P().measurements.filter((x) => x !== m && x.band === bandNum() && dk(x.device) === dk(dev ? dev.value : p.goal.device) && fin(x.download) && fin(x.upload));
      const off = (v, ref) => Number.isFinite(ref) && ref > 0 && v > 0 && (v / ref > 2.5 || ref / v > 2.5);
      const odd = (r.up > 3 * r.down && r.down > 0) || (prev.length > 0 && (off(r.down, med(prev.map((x) => x.download))) || off(r.up, med(prev.map((x) => x.upload)))));
      oddNote.hidden = !odd;
    };
    const widget = WH.speedtest.widget({
      compact: !sheet,
      result: test && fin(test.ping) ? { down: test.down, up: test.up, ping: test.ping, jitter: fin(test.jitter) ? test.jitter : NaN, mode: null } : null,
      onResult: (r) => {
        test = r;
        checkOdd(r);
        dn.setValue(roundRate(r.down));
        up.setValue(roundRate(r.up));
        spF.setError('');
        sigF.setError('');
      },
      onState: (s) => {
        saveBtn.disabled = s === 'running';
        if (hooks.onLayout) hooks.onLayout();
      },
    });
    // a new measurement leads with "Změřit vše": the speed-only button steps back to a quieter style
    if (!m) { const go = widget.querySelector('.st__go'); if (go) { go.classList.remove('btn--primary', 'btn--lg'); go.classList.add('btn--soft'); } }
    const speedBox = el('div.pl-mform__test', el('div.pl-cap', el('span', { 'data-i18n': 'planner.m.speedNow' }, t('planner.m.speedNow'))), widget, oddNote);

    // band, name, device
    const sum = el('span.pl-mmore__sum');
    // phone sheet of a new measurement: the place name sits in "Více údajů", so its summary names it
    const sumName = () => (sheet && !m ? clean(name.value) || (room ? room.name : '') : '');
    const bandWord = () => (band === 'auto' ? t('planner.bd.dontKnow') : bandNum() ? PL.bands.ghz(bandNum()) : '');
    const paintSum = () => { sum.textContent = [sumName(), m ? bandWord() : '', PL.dev.label(dev.value)].filter(Boolean).join(' · '); };
    // SPEC 13: 2,4 / 5 / 6 / Nevím - visible for a new measurement ("Na jakém pásmu jsi teď?"), in "Více" when editing
    // "Kde to zjistím?" (WiFiman) only in the phone sheet: on a computer the helper / the "?" hint answer it and the
    // desktop popover stays compact (SPEC 7.3)
    const bandPick = PL.bands.picker({
      value: band, size: 'sm', how: !m && sheet, onLayout: () => layout2(),
      onPick: (v) => { band = v; bandTouched = true; bandF.setError(''); if (!m && sheet) PL.bands.choice.set(v); paintSum(); },
    });
    const bandF = ui().field({ i18n: m ? 'planner.m.band' : 'planner.bd.formLabel', hint: 'bandAuto', control: bandPick });
    bandF.classList.add('pl-mform__band');
    // the phone sheet: "Kde to zjistím?" sits on the label's row (one row less - the tapped point stays visible above)
    const whereRow = bandPick.querySelector('.pl-bd__where');
    if (whereRow) { bandF.classList.add('pl-mform__band--where'); bandF.querySelector('.field__label').after(whereRow); }
    const name = el('input.input', { type: 'text', maxlength: '50', value: m ? m.name : fo.name ? clean(fo.name) : room ? room.name : '' });
    let nameTouched = !!m || !!fo.name;
    name.addEventListener('input', () => { nameTouched = true; if (sheet && !m && dev) paintSum(); });
    // "Změřit vše" measures THIS device (its detected preset) unless the user picked one here; manual entries keep the
    // goal device (the numbers may come from a phone and be typed in on the PC)
    let devTouched = false;
    const dev = PL.devicePicker({
      value: m ? m.device : p.goal.device, ariaKey: 'planner.dev.ariaMeas', enterSubmits: true,
      onChange: () => { devTouched = true; paintSum(); },
      onLayout: () => { if (hooks.onLayout) hooks.onLayout(); },
    });
    const notes = [];
    if (PL.moved()) {
      // the map shows the TRIAL position, the measurement belongs to today's: say it once (the measuring mode already
      // said it in a toast) and offer the one action that helps - showing today's position
      if (!(mm.active && mm.warned)) {
        const note = el('div.notice.notice--warn.pl-mnote', ui().icon('warning', 18),
          el('div.stack.gap-1', el('span', t('planner.m.notToday')),
            el('div', ui().button({ i18n: 'planner.m.showToday', icon: 'undo', size: 'sm', variant: 'ghost', onClick: () => { PL.backToToday(); note.remove(); if (hooks.onLayout) hooks.onLayout(); } }))));
        notes.push(note);
      }
    } else if (p.node.mode !== 'none') notes.push(el('div.notice.notice--warn.pl-mnote', ui().icon('warning', 18), el('span', t('planner.m.nodeOn'))));
    const where = el('span', room ? room.name : t('planner.tip.outside'));
    const fail = (f, k, focus) => {
      f.setError(t(k));
      if (more && (f === spF || (m && f === bandF))) more.open = true;
      try { focus.focus(); } catch (e) { /* ignore */ }
      return false;
    };

    // ---- Wi-Fi details handed in (SPEC 8): a chip; they prefill the signal + band and are stored as measurement.wifi
    let attached = null; // {wifi, source:'helper'|'paste'|'link'|'saved'}
    let info = null;     // the device card while it is shown inline
    let manualSaved = null; // hidden states of the manual fields while "Změřit vše" runs / after its save
    const chipTxt = el('span.pl-wchip__t');
    const chipX = ui().iconButton({ icon: 'x', tip: 'planner.mall.chipRemove', size: 'sm', onClick: () => { attached = null; paintChip(); try { val.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } });
    const chip = el('div.pl-wchip', { hidden: true }, el('span.pl-wchip__ico', ui().icon('wifi', 16)), chipTxt, chipX);
    function paintChip() {
      chip.hidden = !attached || !!info || !!manualSaved;
      if (attached) {
        chipTxt.textContent = `${PL.wifiLine(attached.wifi, { signal: true })} (${t(`planner.mall.src.${attached.source}`)})`;
        chip.title = chipTxt.textContent;
      }
      layout2();
    }
    /** Put Wi-Fi details into the form: signal (when empty, or `force`), band, chip. */
    function applyWifi(w, source, force) {
      const n = PL.normWifi && PL.normWifi(w);
      if (!n || !alive) return false;
      attached = { wifi: n, source: source || 'paste' };
      const d = PL.wifiDbm(n);
      if (d !== null && (force || !val.value.trim())) {
        val.value = unit === 'pct' ? String(fin(n.signalPct) ? n.signalPct : Math.round(E.units.dbmToPct(d))) : String(d);
        sigF.setError('');
      }
      if (n.band) { band = n.band; bandPick.setValue(n.band); bandF.setError(''); paintSum(); }
      paintChip();
      return true;
    }
    if (m && m.wifi && PL.normWifi) { const n = PL.normWifi(m.wifi); if (n) attached = { wifi: n, source: 'saved' }; }
    else if (!m && PL.wifiPending) { const pd = PL.wifiPending.get(); if (pd) applyWifi(pd.wifi, pd.source); }

    // ---- "Změřit vše" (SPEC 8.1): new measurements only
    let running = false;
    let ac = null;
    let done = null;      // the measurement "Změřit vše" saved (the form then offers "Měřit další místo")
    let offStore = null;
    const allBtn = m ? null : ui().button({ i18n: 'planner.mall.go', icon: 'sparkles', variant: 'primary', size: 'lg', onClick: () => runAll() });
    if (allBtn) allBtn.classList.add('pl-mall__go');
    const infoBtn = ui().iconButton({ icon: 'info', tip: 'planner.di.btn', variant: 'soft', onClick: () => openInfo() });
    infoBtn.classList.add('btn--lg', 'pl-mall__info-btn');
    const allRow = allBtn ? el('div.pl-mall__row', allBtn, infoBtn, ui().hint('measureAll')) : null;
    const chk = allBtn ? PL.mallChecklist({
      noCancel: true, onCancel: () => cancelAll(), onHow: () => openInfo(), onLayout: layout2,
      // "Připojit pomocníka" in the checklist: the details go to the saved measurement, else into this form
      onWifi: (w, src) => { if (done) attachToSaved(w, src); else applyWifi(w, src, true); },
    }) : null;
    if (chk) chk.hidden = true;
    // while it runs the footer holds just one "Cancel measuring" (no Save / close next to it)
    const stopBtn = ui().button({ i18n: 'planner.mall.stop', icon: 'x', variant: 'secondary', size: sheet ? null : 'sm', onClick: () => { if (chk) chk.cancel(); } });
    stopBtn.classList.add('pl-mall__stop');
    stopBtn.hidden = true;
    const typedDbm = () => {
      const raw = parseNum(val.value);
      if (raw === null) return null;
      const d = unit === 'pct' ? (raw >= 0 && raw <= 100 ? E.units.pctToDbm(raw) : null) : raw > 0 ? -raw : raw;
      return d !== null && d >= -100 && d <= -20 ? d : null;
    };
    // while "Změřit vše" runs and after its save the manual fields step aside (they would not be used)
    function hideManual() {
      if (manualSaved) return;
      manualSaved = new Map([sigF, m ? null : bandF, ...notes, speedBox, more, sheet ? name.closest('.field') : null].filter(Boolean).map((n) => [n, n.hidden]));
      for (const n of manualSaved.keys()) n.hidden = true;
      paintChip();
    }
    function showManual() {
      if (!manualSaved) return;
      for (const [n, h] of manualSaved) n.hidden = h;
      manualSaved = null;
      paintChip();
    }
    async function runAll() {
      if (running || done || widget.running || !chk) return;
      running = true;
      saveBtn.disabled = true;
      allRow.hidden = true;
      hideManual();
      for (const n of footMain) n.hidden = true;
      stopBtn.hidden = false;
      chk.reset();
      chk.hidden = false;
      layout2();
      try { stopBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      ac = new AbortController();
      let res = null;
      try {
        res = await PL.measureAll({
          // the band the user picked here (or this session) counts as their answer; the helper's band wins (SPEC 13)
          point: { x: loc.x, y: loc.y }, band: bandNum() || undefined, bandChoice: band || null, chooseBand: (c) => chk.chooseBand(c),
          name: nameTouched ? clean(name.value) : '', device: devTouched ? clean(dev.value) : '',
          value: typedDbm(), wifi: attached && attached.source !== 'saved' ? attached.wifi : null, wifiSource: attached ? attached.source : null,
          source: fo.source || 'manual', consent: () => chk.askConsent(),
          onStep: (s) => { chk.update(s); if (s.state !== 'running' || s.key !== 'speed') layout2(); },
        }, ac.signal);
      } catch (e) {
        // a bug must not end in the generic "something went wrong": say what stopped, keep what was gathered
        PL.report(e, 'measure.all', { bug: true, toast: { text: t('planner.mall.err', { msg: String((e && e.message) || e).slice(0, 120) }) }, ms: 9000 });
      }
      running = false;
      ac = null;
      if (!alive) return;
      chk.finish();
      stopBtn.hidden = true;
      if (res && res.measurement) {
        done = res.measurement;
        // (measureAll switched the map to the measured band and said so in its toast, SPEC 13)
        if (typeof fo.onDone === 'function') { try { fo.onDone(res); } catch (e) { PL.report(e, 'measure.onDone', { bug: true }); } }
        showDone();
        return;
      }
      // cancelled / nothing to save: keep what was gathered in the form, so Save (or another try) can use it
      if (res && res.data) {
        const d = res.data;
        if (d.wifi) applyWifi(d.wifi, d.wifiSource || 'helper');
        if (d.speed && fin(d.speed.down) && fin(d.speed.up)) {
          test = d.speed;
          dn.setValue(roundRate(d.speed.down));
          up.setValue(roundRate(d.speed.up));
          if (more) more.open = true;
        }
        if (!devTouched && d.device && d.device.presetDevice && (d.speed || d.wifi)) { dev.setValue(PL.dev.valueFor(d.device.presetDevice)); devTouched = true; paintSum(); }
      }
      allRow.hidden = false;
      showManual();
      for (const n of footMain) n.hidden = false;
      saveBtn.disabled = false;
      layout2();
      try { allBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    function cancelAll() { if (ac) ac.abort(); }
    // after the automatic save: "Měřit další místo" (+ Close); an undo of that save closes the form
    const nextBtn = ui().button({ i18n: 'planner.mall.next', icon: 'pin', variant: 'primary', size: sheet ? 'lg' : 'sm', onClick: () => next() });
    nextBtn.classList.add('pl-mall__next');
    nextBtn.hidden = true;
    const closeBtn = ui().button({ i18n: 'ui.close', variant: 'ghost', size: sheet ? null : 'sm', onClick: () => hooks.onClose(false) });
    closeBtn.hidden = true;
    function showDone() {
      for (const n of footMain) n.hidden = true;
      nextBtn.hidden = false;
      closeBtn.hidden = false;
      layout2();
      offStore = store().on('measurements', () => { if (alive && done && !PL.P().measurements.some((x) => x.id === done.id)) hooks.onClose(false); });
      requestAnimationFrame(() => { try { nextBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    }
    function next() {
      hooks.onClose(true);
      ui().announce(t(PL.isPhone() ? 'planner.mm.tap' : 'planner.mall.nextDesk'));
    }
    /** Wi-Fi details found after the automatic save (the "how to get them" link): added to that measurement. */
    function attachToSaved(w, source) {
      const n = PL.normWifi(w);
      if (!n || !done) return;
      const d = PL.wifiDbm(n);
      const id = done.id;
      store().commit('planner.undo.measWifi', (q) => {
        const x = q.measurements.find((y) => y.id === id);
        if (!x) return;
        x.wifi = PL.wifiRecord(n);
        if (x.value === null && d !== null) x.value = d;
        if (n.band) x.band = n.band;
      }, ['measurements']);
      if (chk) chk.update({ key: 'wifi', state: 'ok', info: { wifi: n, source, band: n.band || null, bandBy: n.band ? 'wifi' : null } });
      const saved = PL.P().measurements.find((y) => y.id === id);
      if (saved) done = saved;
      const sw = saved && n.band ? PL.bands.afterSave(saved) : '';
      ui().toast({ text: [t('planner.mall.wifiAdded', { s: PL.wifiLine(n, { signal: true }) }), sw].filter(Boolean).join(' ') }, { kind: 'ok' });
    }

    // ---- "Info o zařízení" inline (the form body switches to the device card and back)
    const infoHost = el('div.pl-di-host', { hidden: true });
    let saved = null;
    function openInfo() {
      if (running || info || !alive) return;
      saved = new Map();
      for (const n of bodyNodes) if (n !== infoHost) { saved.set(n, n.hidden); n.hidden = true; }
      for (const n of footAll) { saved.set(n, n.hidden); n.hidden = true; }
      info = PL.devInfoCard({
        context: layout,
        onBack: () => closeInfo(true),
        // SPEC 8: the details fill the signal (when it is still empty), switch the band and travel as measurement.wifi
        onUse: (w, src) => { if (done) attachToSaved(w, src || 'paste'); else applyWifi(w, src || 'paste'); closeInfo(true); },
        onLayout: layout2,
      });
      infoHost.replaceChildren(info);
      infoHost.hidden = false;
      if (hooks.onWide) hooks.onWide(true);
      layout2();
      requestAnimationFrame(() => info && info.focusFirst());
    }
    function closeInfo(focusBack) {
      if (!info) return;
      info.destroy();
      info = null;
      infoHost.replaceChildren();
      infoHost.hidden = true;
      for (const [n, h] of saved) n.hidden = h;
      saved = null;
      paintChip();
      if (hooks.onWide) hooks.onWide(false);
      layout2();
      if (focusBack) requestAnimationFrame(() => { const b = done ? nextBtn : allBtn && !allRow.hidden ? infoBtn : val; try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    }

    function save() {
      if (done) { next(); return true; }
      if (widget.running || running) return false;
      if (info) return false;
      sigF.setError('');
      spF.setError('');
      const raw = parseNum(val.value);
      let dbm = null;
      if (raw !== null) {
        if (unit === 'pct') { if (raw < 0 || raw > 100) return fail(sigF, 'planner.m.errPct', val); dbm = E.units.pctToDbm(raw); }
        else { dbm = raw > 0 ? -raw : raw; if (dbm < -100 || dbm > -20) return fail(sigF, 'planner.m.errRange', val); }
      }
      const sp = [dn, up].map((i) => (i.value === '' ? null : i.valueAsNumber));
      if (sp.some((v) => v !== null && !(v >= 0 && v <= 10000))) return fail(spF, 'planner.m.errSpeed', dn);
      // SPEC 13: the band - from the Wi-Fi details in the chip, else the user's explicit answer; an untouched edit keeps its own
      const det = attached ? E.units.normBand(attached.wifi.band) : null;
      let recBand;
      let bandBy;
      if (m && !bandTouched && (!det || det === E.units.normBand(m.band))) { recBand = m.band; bandBy = 'keep'; }
      else if (det && (!bandTouched || det === bandNum())) { recBand = det; bandBy = 'wifi'; }
      else if (band === 'auto') { recBand = null; bandBy = 'auto'; }
      else if (bandNum()) { recBand = bandNum(); bandBy = 'user'; }
      else return fail(bandF, 'planner.bd.errNeed', bandPick);
      if (dbm === null && (sp[0] === null || sp[1] === null)) return fail(sigF, sp[0] === null && sp[1] === null ? 'planner.m.errNeedOne' : 'planner.m.errNeedBoth', sp[0] === null && sp[1] === null ? val : dn);
      const pr = PL.P();
      const rec = {
        id: m ? m.id : U.uid('m'), x: PL.r6(loc.x), y: PL.r6(loc.y), band: recBand, value: dbm === null ? null : Math.round(dbm * 10) / 10,
        name: clean(name.value) || (room ? room.name : t('planner.m.defName', { n: pr.measurements.length + 1 })),
        download: sp[0], upload: sp[1], device: clean(dev.value) || pr.goal.device, t: m ? m.t : Date.now(),
      };
      // ping, jitter and the source travel with the numbers of a Cloudflare test (not after a manual change)
      if (test && sp[0] === roundRate(test.down) && sp[1] === roundRate(test.up)) {
        if (fin(test.ping)) rec.ping = Math.round(test.ping * 100) / 100;
        if (fin(test.jitter)) rec.jitter = Math.round(test.jitter * 100) / 100;
        rec.source = 'cloudflare';
      }
      // the Wi-Fi details shown in the chip; what "Info o zařízení" detected stays with an edited measurement
      if (attached) rec.wifi = attached.source === 'saved' && m && m.wifi ? m.wifi : PL.wifiRecord(attached.wifi);
      if (m && m.deviceInfo) rec.deviceInfo = m.deviceInfo;
      // SPEC 13: the user's own answer is the band of the Wi-Fi this point was measured on (no "pásmo neověřeno");
      // "Nevím" = band null, inferred by the engine
      if (bandBy === 'user') rec.wifi = PL.bands.withBand(rec.wifi, recBand);
      else if (bandBy === 'auto' && rec.wifi) rec.wifi = PL.bands.withBand(rec.wifi, null);
      store().commit(m ? 'planner.undo.measEdit' : 'planner.undo.measAdd', (q) => {
        const i = q.measurements.findIndex((x) => x.id === rec.id);
        if (i >= 0) q.measurements[i] = rec; else q.measurements.push(rec);
      }, ['measurements']);
      if (attached && (attached.source === 'paste' || attached.source === 'link') && PL.wifiPending) PL.wifiPending.clear();
      // the map follows the measured band (SPEC 13), said in a toast
      const savedRec = PL.P().measurements.find((x) => x.id === rec.id);
      if (savedRec && (!m || savedRec.band !== m.band)) PL.bands.afterSave(savedRec, { toast: true });
      ui().announce(rec.value === null ? t('planner.m.savedSpeed', { d: PL.mbps(rec.download), u: PL.mbps(rec.upload) }) : t('planner.m.saved', { v: U.dbm(rec.value) }));
      hooks.onClose(true);
      return true;
    }

    const del = m ? ui().button({ i18n: 'ui.delete', icon: 'trash', variant: 'danger-soft', size: sheet ? null : 'sm', onClick: () => PL.deleteMeas(m.id) }) : null;
    const devF = ui().field({ i18n: 'planner.m.device', hint: 'device', control: dev });
    devF.querySelector('.field__label').removeAttribute('for');
    let body;
    let foot;
    const place = sheet ? ui().field({ i18n: 'planner.m.place', control: name, inline: true }) : null;
    if (place) place.classList.add('pl-mform__place');
    // "Více": the manual speed numbers, band, (name) and device - collapsed so the form stays short (the phone sheet of
    // a new measurement keeps the place name there too: "Změřit vše" leads, the map point must stay visible)
    more = el('details.disclosure.pl-mmore',
      el('summary', el('span', { 'data-i18n': 'planner.m.morePop' }, t('planner.m.morePop')), sum),
      el('div.disclosure__body.stack',
        sheet && !m ? place : null,
        // phone sheet of a new spot: "Změřit vše" runs the speed test itself - the speed-only test waits in "Více"
        sheet && !m ? speedBox : null,
        m ? bandF : null, spF,
        sheet ? devF : el('div.field-grid', ui().field({ i18n: 'planner.m.name', control: name }), devF)));
    more.addEventListener('toggle', () => { if (hooks.onLayout) hooks.onLayout(); });
    if (m && !test && (m.download !== null || m.upload !== null)) more.open = true;
    paintSum();
    let footMain;
    if (sheet) {
      speedBox.classList.add('pl-mform__test--sheet');
      body = [m ? place : null, m ? null : bandF, allRow, chip, chk, sigF, ...notes, m ? speedBox : null, more, infoHost];
      footMain = [del, saveBtn].filter(Boolean);
      foot = [del, el('span.grow'), saveBtn, stopBtn, closeBtn, nextBtn];
    } else {
      body = [el('div.pl-mform__where.text-sm.text-muted', ui().icon('pin', 16), where), allRow, chip, chk, sigF, m ? null : bandF, ...notes, speedBox, more, infoHost];
      const cancelBtn = ui().button({ i18n: 'ui.cancel', variant: 'ghost', size: 'sm', onClick: () => hooks.onClose(false) });
      footMain = [del, cancelBtn, saveBtn].filter(Boolean);
      foot = [del, el('span.grow'), cancelBtn, saveBtn, stopBtn, closeBtn, nextBtn];
    }
    const bodyNodes = body.filter(Boolean);
    const footAll = foot.filter(Boolean);
    paintChip();
    if (!m && fo.autoStart) requestAnimationFrame(() => { if (alive) runAll(); });
    return {
      body: bodyNodes,
      foot: footAll,
      save,
      widget,
      busy: () => widget.running || running,
      cancel: () => { if (running && chk) chk.cancel(); else widget.cancel(); },
      isDone: () => !!done,
      // details handed over while this form is open (helper link, drawer): only into an editable form; the signal is
      // filled when it is still empty (SPEC 8)
      applyWifi: (w, source) => (running || done || info ? false : applyWifi(w, source)),
      runAll,
      focusFirst: () => { if (running || info) return; try { val.focus({ preventScroll: true }); val.select(); } catch (e) { /* ignore */ } },
      focusAll: () => { const b = allBtn && !allRow.hidden ? allBtn : val; try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } },
      destroy: () => {
        alive = false;
        if (ac) ac.abort();
        widget.destroy();
        if (info) { info.destroy(); info = null; }
        if (offStore) { offStore(); offStore = null; }
      },
      setPoint(q) {
        loc.x = q.x;
        loc.y = q.y;
        room = E.project.roomAt(PL.P().plan, loc);
        where.textContent = room ? room.name : t('planner.tip.outside');
        if (!nameTouched) name.value = room ? room.name : '';
        paintSum();
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // open: popover (desktop) or bottom sheet (phones)
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Open the measurement form at map point `at`; `id` edits an existing measurement.
   * opts (optional, e.g. the calibration wizard): {source:'wizard'|'manual', name, band, autoStart (run "Změřit vše"
   * right away), onDone(result of measureAll)}.
   */
  function openMeasure(at, id, opts) {
    const st = PL.stage;
    if (!st) return;
    PL.closePending();
    const S = PL.S;
    const p = PL.P();
    const m = id ? p.measurements.find((x) => x.id === id) : null;
    if (!m && p.measurements.length >= 500) { ui().toast({ i18n: 'planner.m.tooMany' }, { kind: 'warn' }); return; }
    const loc = m ? { x: m.x, y: m.y } : PL.measPoint(at);   // new points: inside the room under the cursor, never on a wall line
    if (PL.isPhone()) { openSheet(loc, m, opts); return; }
    const anchor = el('div.pl-anchor');
    st.layer.append(anchor);
    let h = null;
    let side = '';
    const f = buildForm(loc, m, 'popover', {
      opts,
      onClose: () => { if (h) h.close(); },
      onLayout: () => { if (h) requestAnimationFrame(() => { if (h) h.reposition(); }); },
      // the device card inline: a little wider than the form
      onWide: (on) => { if (h) { h.el.classList.toggle('is-wide', on); h.el.style.width = on ? '400px' : '340px'; requestAnimationFrame(() => { if (h) h.reposition(); }); } },
    });
    // body scrolls (rarely needed), the Save / Cancel row is always visible
    const form = el('form.pl-mform.pl-mform--pop', { novalidate: true }, el('div.pl-mform__body', { 'data-no-wheel': '' }, ...f.body), el('div.pl-mform__foot', ...f.foot));
    form.addEventListener('submit', (e) => { e.preventDefault(); f.save(); });
    S.pending = { anchor, at: loc, submit: f.save, h: null, kind: 'popover', isNew: !m, busy: f.busy, applyWifi: f.applyWifi, runAll: f.runAll };
    // the one-time "measure with the router at today's place" toast was for the click that just happened
    if (S.remind) { try { S.remind.close(); } catch (e) { /* ignore */ } S.remind = null; }
    st.place();
    if (PL.paintChrome) PL.paintChrome();
    h = ui().popover(anchor, form, {
      title: { i18n: m ? 'planner.m.editTitle' : 'planner.m.newTitle' }, placement: 'right', align: 'center', width: 340, autofocus: false, restoreFocus: false,
      className: 'pl-mpop',
      onClose: () => {
        f.destroy();
        anchor.remove();
        if (S.pending && S.pending.anchor === anchor) S.pending = null;
        if (PL.paintChrome) PL.paintChrome();
        const a = document.activeElement;
        if (st && (!a || a === document.body)) st.canvas.focus({ preventScroll: true });
      },
    });
    // our own placement: beside / above / below the point, never over it, clear of the map controls and toasts
    h.reposition = () => { side = placeBeside(h.el, PL.toClient(S.pending && S.pending.anchor === anchor ? S.pending.at : loc), side); };
    h.reposition();
    S.pending.h = h;
    requestAnimationFrame(f.focusFirst);
  }
  PL.openMeasure = openMeasure;

  /**
   * Put a floating panel next to client point c so that it (1) never covers the point (+ a 22 px ring), (2) stays in
   * the viewport and (3) overlaps the stage controls, the header and toasts as little as possible; the side used last
   * time wins ties, so the panel does not jump while the speed test changes its height.  Returns the chosen side.
   */
  function placeBeside(panel, c, prefer) {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const M = 8;
    const R = 22;
    panel.style.maxHeight = `${Math.max(240, vh - 2 * M)}px`;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const rect = (n) => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    const avoid = [...document.querySelectorAll('#view-planner .stage .toolbar, #view-planner .stage .legend, #view-planner .pl-sb, #app-header, #toast-root .toast')]
      .filter((n) => n.offsetWidth && !n.closest('[hidden]')).map(rect);
    const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    // the sidebar next to the map: better not covered either (less bad than a control, worse than a bit of map)
    const sideEl = document.querySelector('#view-planner .sidebar');
    const side = sideEl && sideEl.offsetWidth ? rect(sideEl) : null;
    const clampX = (x) => Math.max(M, Math.min(x, vw - w - M));
    const clampY = (y) => Math.max(M, Math.min(y, vh - h - M));
    const cand = [];
    // offsets along the free axis: centred, a few fixed ones, and flush with the edges of every control to avoid
    const vert = [c.y - h / 2, c.y - 48, c.y - h + 48, c.y - h * 0.3, c.y - h * 0.7, c.y - 16, c.y - h + 16];
    const horz = [c.x - w / 2, c.x - 48, c.x - w + 48];
    for (const a of avoid) { vert.push(a.b + 8, a.t - 8 - h); horz.push(a.r + 8, a.l - 8 - w); }
    for (const y of vert) { cand.push({ s: 'right', x: c.x + R, y: clampY(y) }); cand.push({ s: 'left', x: c.x - R - w, y: clampY(y) }); }
    for (const x of horz) { cand.push({ s: 'below', x: clampX(x), y: c.y + R }); cand.push({ s: 'above', x: clampX(x), y: c.y - R - h }); }
    // beside the point in the free band between the controls above and below it: a tall form (speed test consent,
    // "More" open) gets a shorter panel whose body scrolls, instead of covering a toolbar or the legend
    for (const s of ['right', 'left']) {
      const x = s === 'right' ? c.x + R : c.x - R - w;
      let top = M;
      let bot = vh - M;
      for (const a of avoid) {
        if (a.r <= x || a.l >= x + w) continue;
        if (a.b <= c.y) top = Math.max(top, a.b + 8); else if (a.t >= c.y) bot = Math.min(bot, a.t - 8);
      }
      const hh = Math.min(h, bot - top);
      if (hh >= 260 && hh < h) cand.push({ s, x, y: Math.max(top, Math.min(c.y - hh / 2, bot - hh)), h: hh });
    }
    let best = null;
    for (const k of cand) {
      const kh = k.h || h;
      if (k.x < M - 0.5 || k.x + w > vw - M + 0.5 || k.y < M - 0.5 || k.y + kh > vh - M + 0.5) continue;
      const r = { l: k.x, t: k.y, r: k.x + w, b: k.y + kh };
      if (area(r, { l: c.x - R + 2, t: c.y - R + 2, r: c.x + R - 2, b: c.y + R - 2 }) > 0) continue;
      let score = avoid.reduce((sc, a) => sc + area(r, a), 0) * 20;        // covering a control is the worst
      if (side) score += area(r, side) * 3;                                 // then the sidebar
      score += Math.hypot(k.x + w / 2 - c.x, k.y + kh / 2 - c.y) * 2;     // stay close to the point
      if (k.s === 'below' || k.s === 'above') score += 1500;               // beside the point reads best
      if (k.h) score += 600;                                               // a scrolling body only when it helps
      if (prefer && k.s !== prefer) score += 2000;                         // no jumping between sides for nothing
      if (!best || score < best.score) best = { ...k, score };
    }
    if (!best) {
      // tiny viewport: at least keep it inside the screen
      best = { s: '', x: clampX(c.x + R), y: clampY(c.y - h / 2) };
    }
    if (best.h) panel.style.maxHeight = `${Math.floor(best.h)}px`;
    panel.style.left = `${Math.round(best.x)}px`;
    panel.style.top = `${Math.round(best.y)}px`;
    return best.s;
  }
  PL.placeBeside = placeBeside;

  let lastPointer = 'mouse';
  if (typeof window !== 'undefined') window.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);

  function openSheet(loc, m, opts) {
    const S = PL.S;
    const st = PL.stage;
    const anchor = el('div.pl-anchor');
    st.layer.append(anchor);
    const titleId = WH.util.uid('pl-sheet-t');
    let closed = false;
    let ro = null;
    const title = el('h2.pl-sheet__title', { id: titleId, tabindex: '-1', 'data-i18n': m ? 'planner.m.editTitle' : 'planner.m.newTitle' }, t(m ? 'planner.m.editTitle' : 'planner.m.newTitle'));
    const f = buildForm(loc, m, 'sheet', { opts, onClose: () => close(), onLayout: () => requestAnimationFrame(reveal) });
    const closeBtn = ui().iconButton({ icon: 'x', tip: 'ui.close', kbd: 'Esc', onClick: () => close() });
    const form = el('form.pl-mform.pl-mform--sheet', { novalidate: true }, el('div.pl-sheet__body', { 'data-no-wheel': '' }, ...f.body), el('div.pl-sheet__foot', ...f.foot));
    form.addEventListener('submit', (e) => { e.preventDefault(); f.save(); });
    const sheet = el('div.pl-sheet', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId },
      el('div.pl-sheet__grip', { 'aria-hidden': 'true' }), el('div.pl-sheet__head', title, closeBtn), form);
    sheet.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (f.busy()) f.cancel(); else close();
    });
    (PL.root || document.body).append(sheet);
    let before = null; // the map view before the sheet moved it (restored on close)
    function close() {
      if (closed) return;
      closed = true;
      if (before) PL.setViewState(before);
      f.destroy();
      if (ro) ro.disconnect();
      const hadFocus = sheet.contains(document.activeElement);
      sheet.remove();
      anchor.remove();
      if (S.pending && S.pending.anchor === anchor) S.pending = null;
      document.body.classList.remove('pl-has-sheet');
      document.body.style.removeProperty('--pl-toast-top');
      // the toasts that sat at the top edge for the sheet go back to their normal place (clear of the mode's bars)
      if (ui().placeToasts) ui().placeToasts();
      if (PL.paintChrome) PL.paintChrome();
      if (hadFocus || document.activeElement === document.body) {
        const back = PL.mm.active ? PL.mm.focusTarget() : st.canvas;
        try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
      PL.mm.paint();
    }
    /** Keep the tapped point in the visible part of the map (between the top chrome and the sheet). */
    function reveal() {
      if (closed || !S.pending || S.pending.anchor !== anchor) return;
      const vh = document.documentElement.clientHeight;
      let sr = st.el.getBoundingClientRect();
      const sheetTop = vh - sheet.offsetHeight;
      if (!PL.mm.active && (sr.top < -1 || sr.top > Math.max(80, sheetTop - 220))) {
        // bring the map to the top of the screen first (the page scrolls on phones)
        window.scrollBy(0, sr.top);
        sr = st.el.getBoundingClientRect();
      }
      // toasts move to the top edge while the sheet is open (CSS: body.pl-has-sheet #toast-root) - keep the point below them
      const hdr = document.getElementById('app-header');
      const edge = PL.mm.active ? sr.top + PL.mm.topInset() : hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
      document.body.style.setProperty('--pl-toast-top', `${Math.round(edge + 8)}px`);
      const tr = document.getElementById('toast-root');
      const toastH = tr && tr.childElementCount ? tr.offsetHeight + 8 : 0;
      const top = Math.max(Math.max(sr.top, 0) + (PL.mm.active ? PL.mm.topInset() : 12), edge + toastH) + 28;
      const bottom = Math.min(sr.bottom, sheetTop) - 36;
      const c = PL.toClient(S.pending.at);
      let dx = 0;
      let dy = 0;
      if (c.y < top || c.y > bottom) dy = (bottom > top ? (top + bottom) / 2 : top) - c.y;
      if (c.x < sr.left + 24 || c.x > sr.right - 24) dx = (sr.left + sr.right) / 2 - c.x;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        if (!before) before = PL.viewState();
        PL.panBy(dx, dy);
      }
    }
    S.pending = {
      anchor, at: loc, submit: f.save, kind: 'sheet', isNew: !m, busy: f.busy, applyWifi: f.applyWifi, runAll: f.runAll,
      h: { close, reposition: () => {} },
      moveTo(q) {
        // while "Změřit vše" runs the point stays; after its automatic save a tap starts the next measurement
        if (f.busy()) return;
        if (f.isDone()) { close(); PL.openMeasure(q, null, opts); return; }
        const pt = PL.measPoint(q);
        f.setPoint(pt);
        S.pending.at = loc;
        st.place();
        requestAnimationFrame(reveal);
      },
    };
    document.body.classList.add('pl-has-sheet');
    // the one-time "measure with the router at today's place" toast would cover the sheet on a phone
    if (S.remind) { try { S.remind.close(); } catch (e) { /* ignore */ } S.remind = null; }
    if (PL.paintChrome) PL.paintChrome();
    st.place();
    PL.mm.paint();
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => requestAnimationFrame(reveal)); ro.observe(sheet); }
    requestAnimationFrame(() => {
      sheet.classList.add('is-open');
      reveal();
      // touch: no keyboard popping up - focus the heading; keyboard / mouse: straight into the signal field
      if (lastPointer === 'touch' || lastPointer === 'pen') { try { title.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } else f.focusFirst();
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // measuring mode (phones)
  // ---------------------------------------------------------------------------------------------------------------
  const mm = (PL.mm = { active: false });
  let bars = null;
  let prevTool = 'router';
  let entry = null;
  let lock = null;

  async function acquireLock() {
    try {
      if (!mm.active || lock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      const l = await navigator.wakeLock.request('screen');
      if (!mm.active) { l.release().catch(() => {}); return; }
      lock = l;
      l.addEventListener('release', () => { if (lock === l) lock = null; });
    } catch (e) { lock = null; /* not allowed (battery saver, not visible ...) - the mode still works */ }
  }
  function releaseLock() {
    const l = lock;
    lock = null;
    if (l) { try { l.release().catch(() => {}); } catch (e) { /* ignore */ } }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!mm.active) return;
      if (document.visibilityState === 'visible') acquireLock(); else releaseLock();
    });
  }
  mm.hasLock = () => !!lock;

  /** The toolbar button that starts the mode (shown on phones only, see CSS). */
  mm.button = () => {
    const b = ui().button({ icon: 'phone', i18n: 'planner.mm.enter', variant: 'ghost', tip: 'planner.mm.enter.tip', onClick: () => mm.enter() });
    b.classList.add('pl-tool', 'pl-tool--mm');
    b.setAttribute('data-i18n-aria', 'planner.mm.enter');
    b.setAttribute('aria-label', t('planner.mm.enter'));
    entry = b;
    return b;
  };

  mm.mount = (st) => {
    // the map's band: 2,4 · 5 · 6 · Auto (SPEC 13; Auto while the router sends ≥ 2 bands), counts of measurements
    const bandSeg = ui().segmented([...BANDS.map((b) => ({ value: b, label: PL.band(b) })), { value: 'auto', i18n: 'planner.bd.auto', ariaLabel: t('planner.bd.autoTip') }], { value: PL.P().view.band, aria: 'planner.band.aria', onChange: (b) => PL.setView({ band: b }) });
    bandSeg.classList.add('pl-mm__bands');
    bandSeg.button('auto').classList.add('pl-bands__auto');
    // "2,4 · 5 · 6 GHz · Auto" - the unit belongs to the numbers (like the map's band switch)
    bandSeg.button('auto').before(el('span.toolbar__label.pl-bands__unit', { 'data-i18n': 'planner.ghz', 'aria-hidden': 'true' }, t('planner.ghz')));
    const done = ui().button({ i18n: 'planner.mm.done', icon: 'check', variant: 'primary', onClick: () => mm.exit() });
    done.classList.add('pl-mm__done');
    const top = el('div.stage__slot.pl-mmslot.pl-mmslot--top',
      el('div.toolbar.pl-mmbar', { role: 'group', 'data-i18n-aria': 'planner.mm.enter', 'aria-label': t('planner.mm.enter') },
        bandSeg, ui().hint('band')),
      done);
    const count = el('span.badge.badge--accent.pl-mm__count');
    const tapTxt = el('span', { 'data-i18n': 'planner.mm.tap' }, t('planner.mm.tap'));
    // SPEC 9: the guided "Prvotní měření" from the measuring mode too (28-calib-wizard.js; relabels itself "Pokračovat 3 / 5")
    const calib = PL.calib && PL.calib.entryButton ? PL.calib.entryButton({ size: 'sm', variant: 'soft' }) : null;
    if (calib) calib.classList.add('pl-mm__calib');
    // data-toast-avoid: a toast (e.g. the saved one with its band line) never sits on "Prvotní měření" / the hint bar
    const bottom = el('div.stage__slot.pl-mmslot.pl-mmslot--bottom', { 'data-toast-avoid': '' }, calib,
      el('div.pl-mmbar.pl-mmbar--hint', { role: 'status' }, el('span.pl-mm__ico', ui().icon('pin', 20)), tapTxt, count));
    st.el.append(top, bottom);
    bars = { top, bottom, bandSeg, done, count };
    mm.paint();
    // a measurement saved in the measuring mode: a short confirmation, ready for the next spot
    store().on('measurements', (e) => {
      if (mm.active && e.source === 'commit' && /measAdd|measEdit/.test(e.label || '')) ui().toast({ i18n: 'planner.mm.saved' }, { kind: 'ok', ms: 2600 });
      mm.paint();
    });
    WH.bus.on('lang:changed', () => mm.paint());
  };

  mm.paint = () => {
    if (!bars) return;
    const p = PL.P();
    const autoOk = PL.bands.autoOk(p);
    bars.bandSeg.button('auto').hidden = !autoOk;
    bars.bandSeg.setDisabled('auto', !autoOk);
    bars.bandSeg.setValue(p.view.band, true);
    bars.count.textContent = t('planner.mm.count', { n: p.measurements.length });
    BANDS.forEach((b) => { const btn = bars.bandSeg.button(b); const s = btn && btn.querySelector('span'); if (s) s.textContent = PL.band(b); });
    PL.bands.paintCounts(bars.bandSeg);
    bars.bottom.classList.toggle('is-covered', !!(PL.S.pending && PL.S.pending.kind === 'sheet'));
  };
  mm.topInset = () => (bars ? bars.top.getBoundingClientRect().bottom - PL.stage.el.getBoundingClientRect().top : 0);
  /** {top, bottom} px of the stage taken by the mode's bars (for fitting the plan). */
  mm.insets = () => {
    if (!bars || !mm.active) return null;
    const sr = PL.stage.el.getBoundingClientRect();
    return { top: bars.top.getBoundingClientRect().bottom - sr.top, bottom: sr.bottom - bars.bottom.getBoundingClientRect().top };
  };
  mm.focusTarget = () => PL.stage.canvas;

  mm.enter = () => {
    const st = PL.stage;
    if (mm.active || !st) return;
    if (!PL.P().plan.rooms.length) { ui().toast({ i18n: 'planner.noplan.t' }, { kind: 'warn' }); return; }
    PL.closePending();
    mm.active = true;
    prevTool = PL.S.tool;
    PL.setTool('measure', true);
    document.body.classList.add('pl-measuring');
    st.el.classList.add('is-mm');
    if (entry) entry.setAttribute('aria-pressed', 'true');
    mm.paint();
    requestAnimationFrame(() => { st.vp.resize(); PL.fit(false); PL.requestDraw(); });
    acquireLock();
    ui().announce(t('planner.mm.on'));
    try { st.canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    mm.warned = false;
    if (PL.moved()) {
      mm.warned = true;
      ui().toast({ i18n: 'planner.m.notToday', action: { i18n: 'planner.m.showToday', fn: () => PL.backToToday() } }, { kind: 'warn', ms: 9000 });
    }
  };

  mm.exit = () => {
    const st = PL.stage;
    if (!mm.active) return;
    mm.active = false;
    releaseLock();
    PL.closePending();
    document.body.classList.remove('pl-measuring');
    if (st) st.el.classList.remove('is-mm');
    if (entry) entry.setAttribute('aria-pressed', 'false');
    PL.setTool(prevTool === 'measure' ? 'router' : prevTool, true);
    if (st) requestAnimationFrame(() => { st.vp.resize(); PL.fit(false); PL.requestDraw(); });
    ui().announce(t('planner.mm.off'));
    if (entry && entry.offsetParent) { try { entry.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  };

  /** "Measure" from the checklist / the measurements card: the measuring mode on phones, the measure tool elsewhere. */
  PL.startMeasuring = () => {
    if (PL.isPhone()) mm.enter();
    else PL.setTool(PL.S.tool === 'measure' ? 'router' : 'measure');
  };
})();
