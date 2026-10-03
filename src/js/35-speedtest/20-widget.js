/* WH.speedtest (2/2) - the reusable speed-test widget: start button + test length, the one-time consent (inline, so it
 * also works inside a popover or bottom sheet), a live gauge (current Mb/s, phase ping -> download -> upload,
 * progress, Cancel), the result (download and upload tiles, ping and jitter) and friendly error states.
 *
 *   const w = WH.speedtest.widget({ onResult(res), onState(state), result?, compact? });   parent.append(w);
 *   w.start()   w.cancel()   w.reset()   w.destroy()   w.result   w.running   w.state
 *   states (data-state): idle | consent | running | done | error
 * Consent is remembered in prefs ('speedtest.consent'), the chosen length in 'speedtest.mode'.
 */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const ST = (g.WH.speedtest = g.WH.speedtest || {});
  const t = (k, p) => g.WH.i18n.t(k, p);
  const el = (...a) => g.WH.util.el(...a);
  const ui = () => g.WH.ui;
  const getPref = (k, d) => (g.WH.store && g.WH.store.getPref ? g.WH.store.getPref(k, d) : d);
  const setPref = (k, v) => { if (g.WH.store && g.WH.store.setPref) g.WH.store.setPref(k, v); };
  const fmtMbps = (n) => (g.WH.engine && g.WH.engine.units ? g.WH.engine.units.formatMbps(n, g.WH.i18n.lang) : String(Math.round(n)));
  const fmtMs = (n) => (Number.isFinite(n) ? g.WH.util.fmt(n, n < 10 ? 1 : 0) : '—');
  const SVGNS = 'http://www.w3.org/2000/svg';
  /** Static text that re-translates itself when the language changes (WH.i18n.applyDom). */
  const tx = (tag, key) => el(tag, { 'data-i18n': key }, t(key));

  // gauge: a 240 degree arc around (60, 60), r 48, open at the bottom
  const R = 48;
  const pt = (deg) => [60 + R * Math.cos((deg * Math.PI) / 180), 60 + R * Math.sin((deg * Math.PI) / 180)].map((v) => v.toFixed(2)).join(' ');
  const ARC = `M ${pt(150)} A ${R} ${R} 0 1 1 ${pt(30)}`;
  /** 0..1 position on a log scale 0 .. 1000 Mb/s (10 Mb/s ~ 0.35, 100 ~ 0.67). */
  const gaugePos = (mbps) => (Number.isFinite(mbps) && mbps > 0 ? Math.min(1, Math.log10(1 + mbps) / Math.log10(1001)) : 0);
  ST.gaugePos = gaugePos;

  function svg(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }

  /** Result tile: label (icon + word), big value, unit. */
  function tile(kind, icon) {
    const v = el('span.st__tile-v.num', '—');
    const label = el('span.st__tile-l', ui().icon(icon, 16), tx('span', 'speedtest.' + kind));
    const box = el(`div.st__tile.st__tile--${kind}`, label, el('span.st__tile-n', v, tx('span.st__tile-u', 'speedtest.mbps')));
    box.v = v;
    return box;
  }
  /** Small "Ping 14 ms" pair of the latency line. */
  function stat(kind) {
    const v = el('b.num', '—');
    const box = el(`span.st__stat.st__stat--${kind}`, tx('span', 'speedtest.' + kind), ' ', v, '\u00a0', tx('span', 'speedtest.ms'));
    box.v = v;
    return box;
  }

  /**
   * @param {{onResult?:function, onState?:function, result?:object|null, compact?:boolean}} [opts]
   * @returns {HTMLElement} the widget root with start/cancel/reset/destroy and result/running/state
   */
  function widget(opts) {
    const o = opts || {};
    let state = 'idle';
    let result = o.result || null;
    let ac = null;
    let last = { phase: 'ping', value: NaN, fraction: 0 };
    let paintRaf = 0;
    let lastPhase = '';
    const root = el('div.st' + (o.compact ? '.st--compact' : ''), { role: 'group', 'data-state': 'idle', 'data-i18n-aria': 'speedtest.title', 'aria-label': t('speedtest.title') });

    // idle
    const go = ui().button({ i18n: 'speedtest.go', icon: 'speed', variant: 'primary', size: 'lg', block: true, onClick: () => start() });
    go.classList.add('st__go');
    let mode = getPref('speedtest.mode', 'quick') === 'full' ? 'full' : 'quick';
    const modes = ui().segmented([
      { value: 'quick', i18n: 'speedtest.mode.quick', tip: 'speedtest.mode.quick.tip' },
      { value: 'full', i18n: 'speedtest.mode.full', tip: 'speedtest.mode.full.tip' },
    ], { value: mode, size: 'sm', aria: 'speedtest.mode.aria', onChange: (v) => { mode = v; setPref('speedtest.mode', v); } });
    const offline = el('div.notice.notice--muted.st__note', { hidden: true }, ui().icon('globe', 18), tx('span', 'speedtest.offline'));
    const cell = () => el('div.notice.notice--warn.st__note', ui().icon('warning', 18), tx('span', 'speedtest.cellular'));
    const cellIdle = cell();
    const lenRow = el('div.st__opts', modes, ui().hint('speedtest'));
    const idle = el('div.st__idle', go, lenRow, offline, cellIdle);

    // consent (one time)
    const okBtn = ui().button({ i18n: 'speedtest.consent.ok', icon: 'play', variant: 'primary', onClick: () => { setPref('speedtest.consent', true); begin(); } });
    const noBtn = ui().button({ i18n: 'speedtest.consent.cancel', variant: 'ghost', onClick: () => { setState('idle'); focusIn(go); } });
    const consentTitle = el('div.st__consent-t', ui().icon('info', 18), tx('span', 'speedtest.consent.t'));
    const cellConsent = cell();
    const consent = el('div.st__consent', { hidden: true, role: 'group', 'data-i18n-aria': 'speedtest.consent.t', 'aria-label': t('speedtest.consent.t') },
      consentTitle, tx('p.st__consent-b', 'speedtest.consent.b'), cellConsent, el('div.st__consent-acts', okBtn, noBtn));

    // running
    const track = svg('path', { d: ARC, class: 'st__track', fill: 'none', 'stroke-width': '10', 'stroke-linecap': 'round', pathLength: '100' });
    const arc = svg('path', { d: ARC, class: 'st__arc', fill: 'none', 'stroke-width': '10', 'stroke-linecap': 'round', pathLength: '100', 'stroke-dasharray': '0 100' });
    const gs = svg('svg', { viewBox: '0 0 120 96', 'aria-hidden': 'true', focusable: 'false' });
    gs.append(track, arc);
    const num = el('span.st__num.num', '—');
    const unit = el('span.st__unit', t('speedtest.mbps'));
    const gauge = el('div.st__gauge', { 'aria-hidden': 'true' }, gs, el('div.st__readout', num, unit));
    const phaseIco = el('span.st__phase-ico');
    const phaseTxt = el('span');
    const phase = el('div.st__phase', phaseIco, phaseTxt);
    const bar = ui().progress({ value: 0 });
    bar.setAttribute('aria-label', t('speedtest.gauge.aria'));
    const stop = ui().button({ i18n: 'speedtest.cancel', icon: 'x', variant: 'secondary', size: 'sm', onClick: () => cancel() });
    const run = el('div.st__run', { hidden: true }, gauge, el('div.st__runside', phase, bar, stop));

    // result
    const tiles = { down: tile('down', 'download'), up: tile('up', 'upload'), ping: stat('ping'), jitter: stat('jitter') };
    const meta = el('span.st__meta');
    const again = ui().button({ i18n: 'speedtest.again', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => start() });
    const res = el('div.st__res', { hidden: true },
      el('div.st__tiles', tiles.down, tiles.up),
      el('div.st__lat', tiles.ping, el('span.st__dot', { 'aria-hidden': 'true' }), tiles.jitter),
      el('div.st__resfoot', meta, again));

    // error
    const errTxt = el('span');
    const retry = ui().button({ i18n: 'speedtest.retry', icon: 'refresh', size: 'sm', onClick: () => start() });
    const err = el('div.st__err', { hidden: true }, el('div.notice.notice--warn', ui().icon('warning', 18), errTxt), retry);

    const live = el('div.sr-only', { 'aria-live': 'polite' });
    root.append(idle, consent, run, res, err, live);

    const say = (txt) => { live.textContent = ''; setTimeout(() => { live.textContent = txt; }, 40); };
    const focusIn = (n) => { if (root.contains(document.activeElement) || document.activeElement === document.body) { try { n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } };

    function paintAvail() {
      const ok = ST.isAvailable();
      go.disabled = !ok || state === 'running';
      again.disabled = !ok;
      retry.disabled = !ok;
      okBtn.disabled = !ok;
      offline.hidden = ok;
      lenRow.hidden = !ok;   // offline: the test length does not matter, the note takes its place
      const c = ST.onCellular();
      cellIdle.hidden = !c;
      cellConsent.hidden = !c;
    }

    function setState(s) {
      state = s;
      root.dataset.state = s;
      idle.hidden = s !== 'idle';
      consent.hidden = s !== 'consent';
      run.hidden = s !== 'running';
      res.hidden = s !== 'done';
      err.hidden = s !== 'error';
      paintAvail();
      if (typeof o.onState === 'function') { try { o.onState(s); } catch (e) { console.error(e); } }
    }

    function paintResult() {
      if (!result) return;
      tiles.down.v.textContent = fmtMbps(result.down);
      tiles.up.v.textContent = fmtMbps(result.up);
      tiles.ping.v.textContent = fmtMs(result.ping);
      tiles.jitter.v.textContent = fmtMs(result.jitter);
      meta.textContent = result.mode ? t(result.mode === 'full' ? 'speedtest.meta.full' : 'speedtest.meta.quick') : '';
    }

    function paintLive() {
      paintRaf = 0;
      const p = last;
      const ph = p.phase === 'done' ? 'up' : p.phase;
      root.dataset.phase = ph;
      if (ph !== lastPhase) {
        lastPhase = ph;
        phaseIco.replaceChildren(ui().icon(ph === 'down' ? 'download' : ph === 'up' ? 'upload' : 'signal', 18));
        phaseTxt.textContent = t('speedtest.phase.' + ph);
        unit.textContent = t(ph === 'ping' ? 'speedtest.ms' : 'speedtest.mbps');
      }
      const v = p.value;
      if (ph === 'ping') {
        num.textContent = fmtMs(v);
        arc.setAttribute('stroke-dasharray', '0 100');
      } else {
        num.textContent = Number.isFinite(v) ? fmtMbps(v) : '—';
        arc.setAttribute('stroke-dasharray', `${(gaugePos(v) * 100).toFixed(2)} 100`);
      }
      bar.setValue(p.fraction || 0);
    }

    function onProgress(p) {
      if (!p || p.phase === 'done') return;
      if (p.phase !== last.phase) {
        // the next phase starts from an empty gauge
        last = { phase: p.phase, value: NaN, fraction: p.fraction };
        if (p.phase !== 'ping') say(t('speedtest.phase.' + p.phase));
      }
      last = { phase: p.phase, value: Number.isFinite(p.value) ? p.value : last.value, fraction: Math.max(last.fraction || 0, p.fraction || 0) };
      if (!paintRaf) paintRaf = requestAnimationFrame(paintLive);
    }

    async function begin() {
      if (state === 'running') return;
      if (!ST.isAvailable()) { showError('speedtest.err.offline'); return; }
      ac = new AbortController();
      const mine = ac;
      last = { phase: 'ping', value: NaN, fraction: 0 };
      lastPhase = '';
      setState('running');
      paintLive();
      focusIn(stop);
      say(t('speedtest.sr.start'));
      try {
        const r = await ST.run({ mode, onProgress }, mine.signal);
        if (ac !== mine) return;
        ac = null;
        result = r;
        paintResult();
        setState('done');
        focusIn(again);
        say(t('speedtest.sr.result', { d: fmtMbps(r.down), u: fmtMbps(r.up), p: fmtMs(r.ping) }));
        if (typeof o.onResult === 'function') { try { o.onResult(r); } catch (e) { console.error(e); } }
      } catch (e) {
        if (ac !== mine) return;
        ac = null;
        const key = ST.errorKey(e);
        if (!key) { setState(result ? 'done' : 'idle'); focusIn(result ? again : go); say(t('speedtest.cancelled')); return; }
        showError(key);
      } finally {
        if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
      }
    }

    function showError(key) {
      errTxt.textContent = t(key);
      setState('error');
      focusIn(retry);
      say(t(key));
    }

    function start() {
      if (state === 'running') return;
      if (!getPref('speedtest.consent', false)) { setState('consent'); focusIn(okBtn); return; }
      begin();
    }
    function cancel() { if (ac) ac.abort(); }

    const onNet = () => { if (!root.isConnected && !ac) { detach(); return; } paintAvail(); };
    const detach = () => { g.removeEventListener('online', onNet); g.removeEventListener('offline', onNet); };
    g.addEventListener('online', onNet);
    g.addEventListener('offline', onNet);

    if (result) paintResult();
    setState(result ? 'done' : 'idle');

    root.start = start;
    root.cancel = cancel;
    root.reset = () => { cancel(); result = null; setState('idle'); };
    root.destroy = () => { if (ac) { const a = ac; ac = null; a.abort(); } detach(); };
    Object.defineProperty(root, 'result', { get: () => result });
    Object.defineProperty(root, 'running', { get: () => state === 'running' });
    Object.defineProperty(root, 'state', { get: () => state });
    return root;
  }

  ST.widget = widget;
})();
