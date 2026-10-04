/* Planner: the Wi-Fi band of every measurement (SPEC 13 - "on a PC every measurement MUST know its band").
 *
 *   PL.bands.choice.get() / set(v)  the band the user said they are on: 2.4 | 5 | 6 | 'auto' ("Nevím") | null, kept for
 *                                   this browser session only (a phone roams between bands; tomorrow is another day)
 *   PL.bands.info(m)                {band, kind:'wifi'|'auto'|'none', mlo:[other bands], text, short}
 *                                   "5 GHz (+6 GHz MLO)", "≈ 5 GHz (odhad)", "5 GHz"
 *   PL.bands.verified(m)            the band is confirmed: measurement.wifi.band (the Wi-Fi details, or the user's own
 *                                   answer stored there) equals measurement.band, or band null = "Nevím" (inferred)
 *   PL.bands.withBand(wifi, b)      a measurement.wifi record that says band b (the other details kept when they fit)
 *   PL.bandText(b)                  "5 GHz" / "Auto (2,4 / 5 GHz)" - the view band in words
 *   PL.bands.autoOk(p)              the router sends ≥ 2 bands (the band switch offers Auto)
 *   PL.bands.paintCounts(seg)       measurement counts on the band switch
 *   PL.bands.counts(p)              {'2.4': n, '5': n, '6': n} measurements per band (inferred ones on their likely band)
 *   PL.bands.picker(o)              the big 2,4 / 5 / 6 / Nevím choice (+ "Kde to zjistím?") - checklist and phone sheet
 *   PL.bands.line(m)                "5 GHz · kanál 100 · −70 dBm" (the saved toast, the checklist)
 *   PL.bands.afterSave(m)           switch the map to the measured band (returns the toast line), warn once about steering
 *   PL.bands.fix(anchor, m)         the quick fix of "pásmo neověřeno": pick the band, or read it from the helper right now
 *   PL.bands.set(id, v)             one undoable band change (re-runs the calibration through the measurement version)
 * Only UI lives here; the band of a measurement is data (measurement.band, measurement.wifi, the engine's inference). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const store = () => WH.store;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const BANDS = [2.4, 5, 6];
  const nb = (b) => WH.engine.units.normBand(b);
  const bk = (b) => WH.engine.units.bandKey(b);
  const B = (PL.bands = {});
  B.BANDS = BANDS;
  const ghz = (b) => `${PL.band(b)}${WH.util.NBSP}${t('planner.ghz')}`;
  B.ghz = ghz;

  // ---------------------------------------------------------------------------------------------------------------
  // the user's own answer for this session
  // ---------------------------------------------------------------------------------------------------------------
  const SS_KEY = 'wh.planner.bandChoice';
  let mem = null;
  B.choice = {
    get() {
      let v = mem;
      try { const s = sessionStorage.getItem(SS_KEY); if (s !== null) v = s === 'auto' ? 'auto' : nb(Number(s)); } catch (e) { /* private mode: memory only */ }
      return v === 'auto' ? 'auto' : nb(v);
    },
    set(v) {
      mem = v === 'auto' ? 'auto' : nb(v);
      try { if (mem === null) sessionStorage.removeItem(SS_KEY); else sessionStorage.setItem(SS_KEY, String(mem)); } catch (e) { /* memory only */ }
    },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // what a measurement says about its band
  // ---------------------------------------------------------------------------------------------------------------
  /** Bands of the other links of a Wi-Fi 7 multi-link (MLO) connection, strongest first. */
  function mloOthers(m) {
    const links = m && m.wifi && Array.isArray(m.wifi.links) ? m.wifi.links : [];
    const out = [];
    for (const l of links) { const b = l && nb(l.band); if (b && b !== m.band && !out.includes(b)) out.push(b); }
    return out;
  }
  // the engine's guess for "Nevím" points (model.resolveBands), once per project state
  let inf = { key: '', by: new Map() };
  /** The band the engine infers for a "Nevím" measurement (null when it cannot say). */
  function inferredBand(m) {
    const b = nb(m.band);
    if (b) return b;
    const p = PL.P();
    const key = [PL.S.offsKey, PL.S.planVer, PL.S.measVer, p.measurements.length].join('|');
    if (inf.key !== key) {
      inf = { key, by: new Map() };
      try {
        const list = WH.engine.model.resolveBands(PL.ensureCtx(p), p, {});
        for (const x of list) if (x && x.bandInferred) inf.by.set(x.id, nb(x.band));
      } catch (e) { PL.report(e, 'bands.infer'); }
    }
    return inf.by.get(m.id) || null;
  }
  B.info = (m) => {
    if (!m) return { band: null, kind: 'none', mlo: [], text: '', short: '' };
    const det = m.wifi && nb(m.wifi.band);
    let kind;
    if (nb(m.band) === null) kind = 'auto';
    else if (det && det === m.band) kind = 'wifi';
    else kind = 'none';
    const band = kind === 'auto' ? inferredBand(m) : nb(m.band);
    const mlo = kind === 'wifi' ? mloOthers(m) : [];
    let text;
    if (kind === 'auto') text = band ? t('planner.bd.inferred', { b: PL.band(band) }) : t('planner.bd.unknown');
    else if (mlo.length) text = t('planner.bd.mlo', { b: PL.band(band), o: mlo.map((x) => PL.band(x)).join(' + ') });
    else text = ghz(band);
    return { band, kind, mlo, text, short: band ? PL.band(band) : '?' };
  };
  B.verified = (m) => B.info(m).kind !== 'none';
  /** The dot belongs to another band than the map shows (Auto shows every band). */
  B.isOther = (m) => { const v = PL.P().view.band; return v !== 'auto' && B.info(m).band !== v; };
  /** measurement.wifi saying band b: the details kept, their channel / MLO links only while they belong to that band. */
  B.withBand = (w, b) => {
    const base = { ssid: null, bssid: null, channel: null, band: null, rxRate: null, txRate: null, radio: null, security: null };
    const o = Object.assign(base, w && typeof w === 'object' ? w : null);
    const nbv = nb(b);
    if (nb(o.band) !== nbv) { o.channel = null; delete o.links; }
    o.band = nbv;
    return o;
  };
  /** The router sends at least two bands: the band switch offers Auto (SPEC 13). */
  B.autoOk = (p) => { try { return WH.engine.model.routerBandList(p).length >= 2; } catch (e) { return false; } };
  /** The view band in words: "5 GHz", or "Auto (2,4 / 5 GHz)". */
  PL.bandText = (b) => {
    if (b !== 'auto') return nb(b) ? ghz(b) : '';
    let list = [];
    try { list = WH.engine.model.routerBandList(PL.P()); } catch (e) { list = []; }
    return t('planner.bd.autoLabel', { list: list.map((x) => PL.band(x)).join(' / ') });
  };
  B.counts = (p) => {
    const c = { '2.4': 0, 5: 0, 6: 0 };
    for (const m of p.measurements) { const b = nb(m.band) || inferredBand(m); if (b) c[bk(b)]++; }
    return c;
  };
  /**
   * The band switch shows how many measurements each band has (a small count on its button, SPEC 13), so the user sees
   * where calibration / speed data exist. paintCounts(seg) after every change; the aria label carries it in words.
   */
  B.paintCounts = (seg) => {
    if (!seg || !seg.button) return;
    const c = B.counts(PL.P());
    for (const b of BANDS) {
      const btn = seg.button(b);
      if (!btn) continue;
      let n = btn.querySelector('.pl-bcnt');
      if (!n) { n = el('span.pl-bcnt', { 'aria-hidden': 'true' }); btn.append(n); }
      const k = c[bk(b)];
      n.hidden = !k;
      n.textContent = k ? String(k) : '';
      const tip = t(`planner.band.tip${String(b).replace('.', '')}`);
      btn.removeAttribute('data-i18n-aria');
      btn.setAttribute('aria-label', k ? `${tip} – ${t('planner.bd.count', { b: PL.band(b), n: k })}` : tip);
    }
  };
  /** "5 GHz · kanál 100 · −70 dBm" (the band, the channel and the signal - what a PC user wants to see confirmed). */
  B.line = (m) => {
    const parts = [B.info(m).text];
    if (m.wifi && fin(m.wifi.channel)) parts.push(t('planner.di.f.ch', { c: m.wifi.channel }));
    if (fin(m.value)) parts.push(WH.util.dbm(m.value));
    return parts.filter(Boolean).join(' · ');
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 2,4 / 5 / 6 / Nevím
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * o = {value (2.4|5|6|'auto'|null), onPick(v), auto=true (offer "Nevím"), how=true ("Kde to zjistím?"), size, label}
   * -> element with .value, .setValue(v), .focus()
   */
  B.picker = (o) => {
    o = o || {};
    const items = BANDS.map((b) => ({ value: b, label: PL.band(b), ariaLabel: ghz(b) }));
    if (o.auto !== false) items.push({ value: 'auto', i18n: 'planner.bd.dontKnow', ariaLabel: t('planner.bd.dontKnowLong') });
    const v0 = o.value === 'auto' ? 'auto' : nb(o.value);
    const seg = ui().segmented(items, { value: v0, aria: 'planner.bd.aria', size: o.size, block: true, onChange: (v) => { paintTab(); if (typeof o.onPick === 'function') o.onPick(v); } });
    seg.classList.add('pl-bd__seg');
    // nothing chosen yet: the first option stays reachable with Tab
    const paintTab = () => { if (seg.value === null || seg.value === undefined) { const f = seg.button(BANDS[0]); if (f) f.tabIndex = 0; } };
    paintTab();
    const phone = !!(PL.isPhone && PL.isPhone());
    // phones: WiFiman shows the band of the connected network (a link to it; nothing is sent anywhere)
    const how = el('p.text-xs.text-muted.pl-bd__how', { hidden: true }, t(phone ? 'planner.bd.howPhone' : 'planner.bd.howPc'),
      phone ? ' ' : null,
      phone ? el('a.pl-di__gh', { href: t('planner.di.ph.url'), target: '_blank', rel: 'noopener noreferrer' }, ui().icon('external', 16), el('span', t('planner.di.ph.link'))) : null);
    const howBtn = o.how === false ? null : ui().button({ i18n: 'planner.bd.where', icon: 'info', size: 'sm', variant: 'ghost', onClick: () => {
      how.hidden = !how.hidden;
      howBtn.setAttribute('aria-expanded', String(!how.hidden));
      if (typeof o.onLayout === 'function') o.onLayout();
    } });
    if (howBtn) { howBtn.setAttribute('aria-expanded', 'false'); howBtn.classList.add('pl-bd__whereBtn'); }
    const root = el('div.pl-bd', o.label ? el('div.pl-bd__label', o.label) : null, seg, howBtn ? el('div.pl-bd__where', howBtn) : null, how);
    Object.defineProperty(root, 'value', { get: () => seg.value });
    root.setValue = (v) => { seg.setValue(v === 'auto' ? 'auto' : nb(v), true); paintTab(); };
    root.focus = () => { const b = seg.button(seg.value) || seg.button(BANDS[0]); try { if (b) b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } };
    return root;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // after a save: the map follows the measured band; band steering explained once
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Show the measured band's map (calibration, speed curve, what-if and throughput then follow it). Returns the line for
   * the saved toast ("Mapa přepnuta na 5 GHz, na kterém měříš.") or '' when the map already shows it.
   * o = {toast: true} shows it as its own toast (the manual Save).
   */
  B.afterSave = (m, o) => {
    if (!m) return '';
    let msg = '';
    const p = PL.P();
    const b = B.info(m).band;
    const view = p.view.band;
    // "Auto" already shows every band where it would be used; a concrete band switches to the measured one
    if (b && view !== 'auto' && view !== b && PL.setView) {
      PL.setView({ band: b });
      msg = t('planner.bd.switched', { b: PL.band(b) });
    }
    steering(m);
    if (msg && o && o.toast) ui().toast({ text: msg }, { kind: 'info', ms: 5000 });
    return msg;
  };
  /** Two measurements in a row on different bands (both known): the router steers the device - say once that it is fine. */
  function steering(m) {
    if (store().getPref('planner.steerSeen', false)) return;
    const p = PL.P();
    const prev = p.measurements.filter((x) => x.id !== m.id && fin(x.t) && x.t <= m.t).sort((a, c) => c.t - a.t)[0];
    if (!prev) return;
    const a = B.info(prev);
    const c = B.info(m);
    if (a.kind === 'none' || a.kind === 'auto' || c.kind === 'none' || c.kind === 'auto' || !a.band || !c.band || a.band === c.band) return;
    store().setPref('planner.steerSeen', true);
    ui().toast({ text: t('planner.bd.steer', { a: PL.band(a.band), b: PL.band(c.band) }) }, { kind: 'info', ms: 14000 });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // "pásmo neověřeno" -> fix
  // ---------------------------------------------------------------------------------------------------------------
  /** One undoable change of a measurement's band: 2.4 | 5 | 6 (the user's choice) or 'auto' (let the engine infer it). */
  B.set = (id, v) => {
    const auto = v === 'auto';
    const b = auto ? null : nb(v);
    if (!auto && !b) return false;
    const ok = store().commit('planner.undo.measBand', (q) => {
      const x = q.measurements.find((y) => y.id === id);
      if (!x) return;
      // the user's answer is stored as the band of the Wi-Fi the point was measured on; "Nevím" = band null (inferred)
      x.band = b;
      if (auto) { if (x.wifi) { x.wifi.band = null; delete x.wifi.links; } } else x.wifi = B.withBand(x.wifi, b);
    }, ['measurements']);
    if (!ok) return false;
    const m = PL.P().measurements.find((y) => y.id === id);
    if (m) {
      const msg = B.afterSave(m);
      ui().toast({ text: [t('planner.bd.setDone', { name: m.name, b: B.info(m).text }), msg].filter(Boolean).join(' ') }, { kind: 'ok' });
    }
    return true;
  };
  /** Read the band from the helper right now and give it to measurement `id` (the user stands at that spot again). */
  async function fromHelper(id) {
    let w = null;
    let why = '';
    try {
      const hs = await PL.helperStatus({ ask: true, timeout: 4000 });
      if (hs.connected) w = await PL.helperWifi();
      else why = hs.reason === 'denied' ? 'planner.di.helper.denied' : hs.reason === 'prompt' ? 'planner.mall.wifi.askTimeout' : 'planner.bd.why.off';
    } catch (e) { why = PL.wifiProblemKey((e && e.code) || ''); PL.report(e, 'bands.fixHelper'); }
    const b = w && nb(w.band);
    if (!b) { ui().toast({ text: t(why || 'planner.bd.why.noBand') }, { kind: 'warn', ms: 9000 }); return; }
    const ok = store().commit('planner.undo.measBand', (q) => {
      const x = q.measurements.find((y) => y.id === id);
      if (!x) return;
      x.band = b;
      x.wifi = PL.wifiRecord(w);
    }, ['measurements']);
    const m = ok && PL.P().measurements.find((y) => y.id === id);
    if (m) {
      const msg = B.afterSave(m);
      ui().toast({ text: [t('planner.bd.setDone', { name: m.name, b: B.info(m).text }), msg].filter(Boolean).join(' ') }, { kind: 'ok' });
    }
  }
  B.fix = (anchor, m) => {
    const desk = !(PL.isPhone && PL.isPhone());
    const cur = nb(m.band);
    ui().menu(anchor, [
      { heading: t('planner.bd.fixHead', { name: m.name }) },
      ...BANDS.map((b) => ({ label: ghz(b), checked: cur === b && B.verified(m), radio: true, onClick: () => B.set(m.id, b) })),
      { i18n: 'planner.bd.dontKnowLong', checked: B.info(m).kind === 'auto', radio: true, onClick: () => B.set(m.id, 'auto') },
      desk ? { sep: true } : null,
      desk ? { i18n: 'planner.bd.fixHelper', icon: 'wifi', onClick: () => { fromHelper(m.id).catch((e) => PL.report(e, 'bands.fixHelper', { bug: true })); } } : null,
    ].filter(Boolean), { placement: 'bottom', align: 'end' });
  };
})();
