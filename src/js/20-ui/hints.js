/* Hints & tooltips (SPEC 1.7).
 *
 *   WH.ui.hint('band')                 -> <button class="hint">?</button>  (rich popover: help.band.t / .b / .more)
 *   <span data-hint="band"></span>     -> replaced by the button above (WH.ui.enhance, also automatic for any DOM added later)
 *   hint.dataset.hintNote = 'i18n.key' -> an extra line about the control's current state under the title (why it is greyed)
 *   WH.ui.tip(el, 'planner.tool.router', 'R')   or   <button data-tip="i18n.key" data-kbd="R">   -> small tooltip with <kbd>
 *   WH.ui.enhance(root)                -> i18n.applyDom + icons ([data-icon]) + hints + tooltip labels + range fills
 *
 * One shared popover element (#wh-popover, role="tooltip").  Rich hints open on hover (150 ms delay, mouse only), keyboard
 * focus and click/tap (click pins them); they close on Esc, blur, outside press, scroll and resize.  Tooltips open on hover
 * (400 ms) and keyboard focus and never block the pointer.  Content is looked up at show time, so a language switch just works. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const ui = (g.WH.ui = g.WH.ui || {});

  const POP_ID = 'wh-popover';
  const HOVER_DELAY_HINT = 150;
  const HOVER_DELAY_TIP = 400;
  const LEAVE_DELAY = 220;
  const TRIGGER = 'button.hint[data-hint], [data-tip]';

  const t = (k, p) => g.WH.i18n.t(k, p);
  const has = (k) => g.WH.i18n.has(k);

  let pop = null;
  let current = null;       // { trigger, mode: 'hover' | 'focus' | 'click', rich }
  let showTimer = 0;
  let hideTimer = 0;
  let pendingTrigger = null;

  function root() { return document.getElementById('overlay-root') || document.body; }

  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = document.createElement('div');
    pop.id = POP_ID;
    pop.className = 'popover';
    pop.setAttribute('role', 'tooltip');
    pop.addEventListener('pointerenter', () => { clearTimeout(hideTimer); });
    pop.addEventListener('pointerleave', () => { if (current && current.mode === 'hover') scheduleHide(); });
    root().appendChild(pop);
    return pop;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // content
  // -------------------------------------------------------------------------------------------------------------------
  function buildContent(trigger) {
    const hintKey = trigger.getAttribute('data-hint');
    if (hintKey && trigger.classList.contains('hint')) {
      const frag = document.createDocumentFragment();
      const title = document.createElement('strong');
      title.className = 'popover__title';
      title.textContent = t(`help.${hintKey}.t`);
      const body = document.createElement('div');
      body.className = 'popover__body';
      body.textContent = t(`help.${hintKey}.b`);
      frag.append(title);
      // data-hint-note="i18n.key": a line about the CURRENT state, right under the title (e.g. why a switch is greyed)
      const noteKey = trigger.getAttribute('data-hint-note');
      if (noteKey && has(noteKey)) {
        const note = document.createElement('div');
        note.className = 'popover__note';
        note.textContent = t(noteKey);
        frag.append(note);
      }
      frag.append(body);
      if (has(`help.${hintKey}.more`)) {
        const more = document.createElement('div');
        more.className = 'popover__more';
        more.textContent = t(`help.${hintKey}.more`);
        frag.append(more);
      }
      return { rich: true, frag };
    }
    const tipKey = trigger.getAttribute('data-tip');
    const frag = document.createDocumentFragment();
    const label = document.createElement('span');
    label.className = 'popover__title';
    label.textContent = tipKey && has(tipKey) ? t(tipKey) : String(tipKey || '');
    frag.append(label);
    const kbd = trigger.getAttribute('data-kbd');
    if (kbd && ui.kbd) frag.append(ui.kbd(kbd));
    return { rich: false, frag };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // positioning
  // -------------------------------------------------------------------------------------------------------------------
  function place(trigger, rich) {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const m = 8;
    const gap = rich ? 10 : 8;
    pop.style.left = '0px';
    pop.style.top = '0px';
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let placement = trigger.getAttribute('data-tip-pos') || (rich ? 'bottom' : 'bottom');
    const below = vh - r.bottom;
    const above = r.top;
    if (placement === 'bottom' && below < ph + gap + m && above > below) placement = 'top';
    else if (placement === 'top' && above < ph + gap + m && below > above) placement = 'bottom';
    let x;
    let y;
    if (placement === 'left' || placement === 'right') {
      if (placement === 'right' && vw - r.right < pw + gap + m && r.left > vw - r.right) placement = 'left';
      else if (placement === 'left' && r.left < pw + gap + m && vw - r.right > r.left) placement = 'right';
      x = placement === 'right' ? r.right + gap : r.left - gap - pw;
      y = r.top + r.height / 2 - ph / 2;
    } else {
      x = r.left + r.width / 2 - pw / 2;
      y = placement === 'bottom' ? r.bottom + gap : r.top - gap - ph;
    }
    x = Math.max(m, Math.min(x, vw - pw - m));
    y = Math.max(m, Math.min(y, vh - ph - m));
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
    pop.dataset.placement = placement;
    const ax = Math.max(14, Math.min(r.left + r.width / 2 - x, pw - 14));
    pop.style.setProperty('--arrow-x', `${Math.round(ax)}px`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // show / hide
  // -------------------------------------------------------------------------------------------------------------------
  function show(trigger, mode) {
    if (!trigger || !trigger.isConnected) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pendingTrigger = null;
    const p = ensurePop();
    if (current && current.trigger !== trigger) release(current.trigger);
    const { rich, frag } = buildContent(trigger);
    p.replaceChildren(frag);
    const arrow = document.createElement('span');
    arrow.className = 'popover__arrow';
    p.append(arrow);
    p.classList.toggle('popover--tip', !rich);
    current = { trigger, mode: mode || 'hover', rich };
    place(trigger, rich);
    p.classList.add('is-open');
    trigger.setAttribute('aria-describedby', POP_ID);
    if (trigger.classList.contains('hint')) trigger.setAttribute('aria-expanded', 'true');
  }

  function release(trigger) {
    if (!trigger) return;
    if (trigger.getAttribute('aria-describedby') === POP_ID) trigger.removeAttribute('aria-describedby');
    if (trigger.classList.contains('hint')) trigger.setAttribute('aria-expanded', 'false');
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pendingTrigger = null;
    if (!current) return;
    release(current.trigger);
    current = null;
    if (pop) pop.classList.remove('is-open');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, LEAVE_DELAY);
  }

  function scheduleShow(trigger, delay) {
    if (current && current.trigger === trigger) { clearTimeout(hideTimer); return; }
    clearTimeout(showTimer);
    pendingTrigger = trigger;
    // a button whose own menu / panel is open shows no tooltip over it
    const busy = () => !trigger.classList.contains('hint') && trigger.getAttribute('aria-expanded') === 'true';
    showTimer = setTimeout(() => { if (pendingTrigger === trigger && !busy()) show(trigger, 'hover'); }, delay);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // delegated listeners
  // -------------------------------------------------------------------------------------------------------------------
  const triggerOf = (node) => (node && node.closest ? node.closest(TRIGGER) : null);

  function focusVisible(el) {
    try { return el.matches(':focus-visible'); } catch (e) { return true; }
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const tr = triggerOf(e.target);
    if (!tr) return;
    if (current && current.mode !== 'hover' && current.trigger !== tr) return; // a pinned popover wins over hovers
    scheduleShow(tr, tr.classList.contains('hint') ? HOVER_DELAY_HINT : HOVER_DELAY_TIP);
  });

  document.addEventListener('pointerout', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const tr = triggerOf(e.target);
    if (!tr) return;
    if (e.relatedTarget && tr.contains(e.relatedTarget)) return;
    if (pendingTrigger === tr) { clearTimeout(showTimer); pendingTrigger = null; }
    if (current && current.trigger === tr && current.mode === 'hover') {
      // tooltips go immediately, rich hints linger so the pointer can travel into them
      if (current.rich) scheduleHide(); else hide();
    }
  });

  document.addEventListener('focusin', (e) => {
    const tr = triggerOf(e.target);
    if (!tr || !focusVisible(tr)) return;
    show(tr, 'focus');
  });

  document.addEventListener('focusout', (e) => {
    const tr = triggerOf(e.target);
    if (tr && current && current.trigger === tr && !(pop && pop.contains(e.relatedTarget))) hide();
  });

  // Press outside closes a pinned/open popover.
  document.addEventListener('pointerdown', (e) => {
    if (!current) return;
    if (pop && pop.contains(e.target)) return;
    if (current.trigger.contains(e.target)) { if (!current.rich) hide(); return; }
    hide();
  }, true);

  // Clicking a "?" pins (or unpins) the popover; it must never activate a surrounding label/summary/button.
  document.addEventListener('click', (e) => {
    const tr = triggerOf(e.target);
    if (!tr) return;
    if (tr.classList.contains('hint')) {
      e.preventDefault();
      e.stopPropagation();
      if (current && current.trigger === tr && current.mode === 'click') hide();
      else show(tr, 'click');
    } else {
      // tooltip on an action button: get out of the way once it is used - also when it was still waiting for its
      // hover delay (a quick click on "Layers" otherwise showed the tip a moment later over the panel it opened)
      if (pendingTrigger === tr) { clearTimeout(showTimer); pendingTrigger = null; }
      if (current && current.trigger === tr) hide();
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current) return;
    const rich = current.rich;
    const tr = current.trigger;
    hide();
    // A rich "?" popover consumes Esc; a plain tooltip is only dismissed, so one Esc still closes the dialog/menu around it.
    if (rich) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (tr && tr.isConnected && tr.classList.contains('hint')) tr.focus({ preventScroll: true });
    }
  }, true);

  document.addEventListener('scroll', (e) => {
    if (!current) return;
    if (pop && e.target instanceof Node && pop.contains(e.target)) return;
    hide();
  }, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);

  // -------------------------------------------------------------------------------------------------------------------
  // public helpers
  // -------------------------------------------------------------------------------------------------------------------
  function hintLabel(key) {
    return t('ui.hint.about', { topic: t(`help.${key}.t`) });
  }

  /**
   * The tiny round "?" button for help.<key>.*  The "?" is the drawn 'help-q' icon, not a font character: a text glyph
   * sits wherever the font's side bearings and ascent/descent put it (Segoe UI drew it ~1 px low and, under an
   * inline-flex override, hard left), the SVG is centred by geometry in every font (SPEC 7.2).
   */
  function hint(key, opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hint' + (opts && opts.class ? ` ${opts.class}` : '');
    b.setAttribute('data-hint', key);
    b.setAttribute('aria-label', hintLabel(key));
    b.setAttribute('aria-expanded', 'false');
    if (ui.icon) b.append(ui.icon('help-q', 16)); else b.textContent = '?';
    return b;
  }

  /** Attach a small tooltip (i18n key + optional keyboard shortcut) to an element. Returns the element. */
  function tip(el, key, kbd, opts) {
    el.setAttribute('data-tip', key);
    if (kbd) el.setAttribute('data-kbd', kbd); else el.removeAttribute('data-kbd');
    if (opts && opts.pos) el.setAttribute('data-tip-pos', opts.pos);
    syncTipLabel(el);
    return el;
  }

  /** Icon-only elements get their accessible name from the tooltip text. */
  function syncTipLabel(el) {
    if (el.hasAttribute('data-tip-noaria')) return;
    const key = el.getAttribute('data-tip');
    if (!key) return;
    const visible = Array.from(el.childNodes).some((n) => (n.nodeType === 3 && n.textContent.trim()) || (n.nodeType === 1 && n.tagName.toLowerCase() !== 'svg' && n.textContent.trim()));
    if (visible) return; // already has a text label
    let label = has(key) ? t(key) : key;
    const kbd = el.getAttribute('data-kbd');
    if (kbd) label += ` (${ui.kbdText ? ui.kbdText(kbd) : kbd})`;
    el.setAttribute('aria-label', label);
  }

  function rangeFill(input) {
    const min = parseFloat(input.min || '0');
    const max = parseFloat(input.max || '100');
    const v = parseFloat(input.value);
    const pct = max > min ? Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)) : 0;
    input.style.setProperty('--fill', `${pct}%`);
  }

  function all(rootNode, sel) {
    const out = Array.from(rootNode.querySelectorAll ? rootNode.querySelectorAll(sel) : []);
    if (rootNode.matches && rootNode.matches(sel)) out.unshift(rootNode);
    return out;
  }

  /**
   * Make freshly built markup alive:  translations, [data-icon] placeholders, [data-hint] placeholders, tooltip labels,
   * range-slider fills.  Safe to call repeatedly.  Also runs automatically for any element added to the page.
   */
  function enhance(scope) {
    const rootNode = scope || document;
    if (g.WH.i18n) g.WH.i18n.applyDom(rootNode);
    for (const ph of all(rootNode, '[data-icon]')) {
      if (!ui.icon || ph.tagName.toLowerCase() === 'svg') continue;
      const svg = ui.icon(ph.getAttribute('data-icon'), parseInt(ph.getAttribute('data-size') || '20', 10) || 20);
      if (ph.className) svg.setAttribute('class', `${svg.getAttribute('class')} ${ph.className}`);
      ph.replaceWith(svg);
    }
    for (const ph of all(rootNode, '[data-hint]')) {
      if (ph.tagName === 'BUTTON' && ph.classList.contains('hint')) {
        // a hand-written <button class="hint">?</button>: swap the font "?" for the drawn, centred glyph
        if (ui.icon && !ph.querySelector('svg')) ph.replaceChildren(ui.icon('help-q', 16));
        continue;
      }
      const b = hint(ph.getAttribute('data-hint'), { class: ph.className });
      ph.replaceWith(b);
    }
    for (const el of all(rootNode, '[data-tip]')) syncTipLabel(el);
    for (const r of all(rootNode, 'input.range')) rangeFill(r);
  }

  document.addEventListener('input', (e) => {
    const r = e.target;
    if (r && r.tagName === 'INPUT' && r.classList.contains('range')) rangeFill(r);
  });

  // Re-translate labels and the open popover after a language change.
  function refresh() {
    for (const b of Array.from(document.querySelectorAll('button.hint[data-hint]'))) b.setAttribute('aria-label', hintLabel(b.getAttribute('data-hint')));
    for (const el of Array.from(document.querySelectorAll('[data-tip]'))) syncTipLabel(el);
    if (current && current.trigger.isConnected) show(current.trigger, current.mode);
  }
  if (g.WH.bus) g.WH.bus.on('lang:changed', refresh);

  // Automatic enhancement of dynamically added markup (views render with innerHTML / el()).
  const SELECTOR_AUTO = '[data-icon],[data-hint],[data-tip],[data-i18n],[data-i18n-html],[data-i18n-title],[data-i18n-aria],[data-i18n-ph],input.range';
  if (typeof MutationObserver === 'function') {
    const queue = new Set();
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const nodes = Array.from(queue);
      queue.clear();
      for (const n of nodes) {
        if (!n.isConnected) continue;
        if ((n.matches && n.matches(SELECTOR_AUTO)) || n.querySelector(SELECTOR_AUTO)) {
          try { enhance(n); } catch (err) { console.error('[WH.ui] auto-enhance failed:', err); if (globalThis.WH.diag) globalThis.WH.diag.caught(err, 'ui.enhance'); }
        }
      }
    };
    const observe = () => {
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) queue.add(n);
        if (queue.size && !scheduled) { scheduled = true; Promise.resolve().then(flush); }
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) observe(); else document.addEventListener('DOMContentLoaded', observe);
  }

  ui.hint = hint;
  ui.tip = tip;
  ui.enhance = enhance;
  ui.rangeFill = rangeFill;
  ui.hints = {
    show: (trigger) => show(trigger, 'click'),
    hide,
    isOpen: () => !!current,
    refresh,
  };
})();
