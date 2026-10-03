/* WH.ui.tour(steps) - spotlight tour.
 *
 *   WH.ui.tour([
 *     { target: '#mode-wifi', title: 'tour.mode.t', body: 'tour.mode.b', placement: 'bottom' },
 *     { target: () => someEl, title: ..., body: ..., placement: 'left', before() { ... }, after() { ... }, optional: true },
 *     { title: 'tour.end.t', body: 'tour.end.b' }                       // no target = centred card
 *   ]).then((result) => ...)                                          // 'done' | 'skipped'
 *
 * title/body are i18n keys (or plain text).  A step may set `view: 'planner' | 'editor'` to switch the app view first.
 * Steps whose target is missing or hidden are skipped when `optional: true`, otherwise shown as a centred card.
 * Keys: Right/Enter = next, Left = back, Esc = skip.  Focus stays inside the card; the page behind is not clickable. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const ui = (g.WH.ui = g.WH.ui || {});

  const t = (k, p) => g.WH.i18n.t(k, p);
  let running = null;

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function resolveTarget(step) {
    let tg = step.target;
    if (typeof tg === 'function') { try { tg = tg(); } catch (e) { tg = null; } }
    if (typeof tg === 'string') tg = document.querySelector(tg);
    if (!tg || !tg.getBoundingClientRect) return null;
    const r = tg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(tg);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    return tg;
  }

  function text(v) {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /^[a-z][\w-]*(\.[\w-]+)+$/.test(s) && g.WH.i18n.has(s) ? t(s) : s;
  }

  function tour(steps, opts) {
    opts = opts || {};
    if (running) running.stop('skipped');
    const list = (steps || []).filter(Boolean);
    if (!list.length) return Promise.resolve('skipped');

    const prevFocus = document.activeElement;
    const U = g.WH.util;
    const overlay = U.el('div.tour', { role: 'presentation' });
    const block = U.el('div.tour__block');
    const spot = U.el('div.tour__spot.is-none');
    const stepEl = U.el('div.tour__step');
    const titleId = U.uid('tour-t');
    const bodyId = U.uid('tour-b');
    const titleEl = U.el('h2.tour__title', { id: titleId });
    const bodyEl = U.el('div.tour__body', { id: bodyId });
    const dots = U.el('div.tour__dots', { 'aria-hidden': 'true' });
    const backBtn = ui.button({ i18n: 'tour.back', variant: 'ghost', icon: 'arrow-left' });
    const skipBtn = ui.button({ i18n: 'tour.skip', variant: 'ghost' });
    const nextBtn = ui.button({ i18n: 'tour.next', variant: 'primary' });
    const nav = U.el('div.tour__nav', backBtn, U.el('span.spacer'), skipBtn, nextBtn);
    const card = U.el('div.tour__card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId, tabindex: '-1' }, stepEl, titleEl, bodyEl, dots, nav);
    overlay.append(block, spot, card);
    (document.getElementById('overlay-root') || document.body).append(overlay);

    let index = -1;
    let currentTarget = null;
    let currentStep = null;
    let ended = false;
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    const relayout = U.throttleRaf(layout);

    function layout() {
      if (ended) return;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const m = 12;
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      if (!currentTarget || !currentTarget.isConnected) {
        spot.classList.add('is-none');
        card.style.left = `${Math.round((vw - cw) / 2)}px`;
        card.style.top = `${Math.round(Math.max(m, (vh - ch) / 2.4))}px`;
        return;
      }
      const pad = currentStep && currentStep.padding !== undefined ? currentStep.padding : 6;
      const r = currentTarget.getBoundingClientRect();
      const sx = Math.max(2, r.left - pad);
      const sy = Math.max(2, r.top - pad);
      const sw = Math.min(vw - 4, r.right + pad) - sx;
      const sh = Math.min(vh - 4, r.bottom + pad) - sy;
      spot.classList.remove('is-none');
      // concentric with the target: its own corner radius + the padding (a round button gets a round spotlight)
      const rad = getComputedStyle(currentTarget).borderTopLeftRadius || '0';
      const tr = rad.endsWith('%') ? (parseFloat(rad) / 100) * Math.min(r.width, r.height) : parseFloat(rad) || 0;
      Object.assign(spot.style, { left: `${sx}px`, top: `${sy}px`, width: `${sw}px`, height: `${sh}px`, borderRadius: `${Math.round(Math.min(tr + pad, Math.min(sw, sh) / 2))}px` });
      const gap = 14;
      const pref = (currentStep && currentStep.placement) || 'bottom';
      const order = [pref, 'bottom', 'top', 'right', 'left'].filter((v, i, a) => a.indexOf(v) === i);
      let best = null;
      for (const pl of order) {
        let x;
        let y;
        if (pl === 'bottom') { x = r.left + r.width / 2 - cw / 2; y = sy + sh + gap; }
        else if (pl === 'top') { x = r.left + r.width / 2 - cw / 2; y = sy - gap - ch; }
        else if (pl === 'right') { x = sx + sw + gap; y = r.top + r.height / 2 - ch / 2; }
        else { x = sx - gap - cw; y = r.top + r.height / 2 - ch / 2; }
        const fits = x >= m - 1 && y >= m - 1 && x + cw <= vw - m + 1 && y + ch <= vh - m + 1;
        const cx = Math.max(m, Math.min(x, vw - cw - m));
        const cy = Math.max(m, Math.min(y, vh - ch - m));
        // Fits, or at least does not cover the highlighted element after clamping
        const overlaps = cx < sx + sw && cx + cw > sx && cy < sy + sh && cy + ch > sy;
        if (fits || !overlaps) { best = { x: cx, y: cy }; break; }
        if (!best) best = { x: cx, y: cy };
      }
      card.style.left = `${Math.round(best.x)}px`;
      card.style.top = `${Math.round(best.y)}px`;
    }

    function paint(i) {
      const step = list[i];
      stepEl.textContent = t('tour.step', { n: i + 1, total: list.length });
      titleEl.textContent = text(step.title);
      bodyEl.textContent = text(step.body);
      dots.replaceChildren(...list.map((_, k) => U.el('i', { class: k === i ? 'is-on' : '' })));
      backBtn.disabled = i === 0;
      const last = i === list.length - 1;
      const lab = nextBtn.querySelector('.btn__label');
      lab.setAttribute('data-i18n', last ? 'tour.done' : 'tour.next');
      lab.textContent = t(last ? 'tour.done' : 'tour.next');
      skipBtn.hidden = last;
    }

    async function show(i, dir) {
      if (ended) return;
      // find the next displayable step in the travel direction
      for (;;) {
        if (i < 0 || i >= list.length) { if (i >= list.length) finish('done'); else show(0, 1); return; }
        const step = list[i];
        if (index >= 0 && list[index] && typeof list[index].after === 'function' && index !== i) { try { list[index].after(); } catch (e) { console.error(e); } }
        let switched = false;
        if (step.view && g.WH.views && g.WH.views.current !== step.view) { g.WH.views.go(step.view); switched = true; }
        if (typeof step.before === 'function') { try { step.before(); } catch (e) { console.error(e); } }
        if (switched) await wait(260); else await nextFrame();
        if (ended) return;
        const tg = step.target ? resolveTarget(step) : null;
        if (step.target && !tg && step.optional) { i += dir; continue; }
        index = i;
        currentStep = step;
        currentTarget = tg;
        if (tg) {
          const r = tg.getBoundingClientRect();
          if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) tg.scrollIntoView({ block: 'center', inline: 'center' });
        }
        paint(i);
        layout();
        setTimeout(layout, 260);
        nextBtn.focus({ preventScroll: true });
        return;
      }
    }

    function finish(result) {
      if (ended) return;
      ended = true;
      if (list[index] && typeof list[index].after === 'function') { try { list[index].after(); } catch (e) { console.error(e); } }
      window.removeEventListener('resize', relayout);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', relayout, true);
      overlay.remove();
      running = null;
      try { if (g.WH.store) g.WH.store.setPref('tourDone', true); } catch (e) { /* ignore */ }
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      if (typeof opts.onEnd === 'function') { try { opts.onEnd(result); } catch (e) { console.error(e); } }
      if (g.WH.bus) g.WH.bus.emit('tour:ended', { result });
      resolveFn(result);
    }

    function onKey(e) {
      if (ended) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('skipped'); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); show(index + 1, 1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); if (index > 0) show(index - 1, -1); return; }
      if (e.key === 'Tab') {
        const f = ui.focusables(card);
        if (!f.length) return;
        const a = document.activeElement;
        if (e.shiftKey && (a === f[0] || !card.contains(a))) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (a === f[f.length - 1] || !card.contains(a))) { e.preventDefault(); f[0].focus(); }
        return;
      }
      // everything else must not reach the global shortcuts while the tour is open
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
    }

    nextBtn.addEventListener('click', () => show(index + 1, 1));
    backBtn.addEventListener('click', () => { if (index > 0) show(index - 1, -1); });
    skipBtn.addEventListener('click', () => finish('skipped'));
    window.addEventListener('resize', relayout);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', relayout, true);
    g.WH.i18n.applyDom(overlay);

    running = { stop: finish, promise };
    show(0, 1);
    return promise;
  }

  tour.isRunning = () => !!running;
  tour.stop = () => { if (running) running.stop('skipped'); };
  ui.tour = tour;
})();
