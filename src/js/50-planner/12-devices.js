/* Planner: the device picker (SPEC 7.4) used by the Measurements card, the measurement popover / sheet and the Speed
 * card.  A button that looks like a select opens a menu with icons: the presets (phone, laptop, desktop PC, tablet,
 * Raspberry Pi, TV, game console), every custom name already used in the project and "Custom name..." which reveals a
 * text field.  The stored value stays a plain string (backwards compatible); a value that matches a preset in either
 * language ("Telefon" / "Phone") is shown with the preset's icon and label, and picking a preset reuses the spelling the
 * project already has, so the calibration / speed curves (keyed per device name) never split. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);

  const PRESETS = [
    { id: 'phone', icon: 'phone' },
    { id: 'laptop', icon: 'laptop' },
    { id: 'pc', icon: 'desktop' },
    { id: 'tablet', icon: 'tablet' },
    { id: 'rpi', icon: 'board' },
    { id: 'tv', icon: 'tv' },
    { id: 'console', icon: 'gamepad' },
  ];
  /** The device icons live in the shared set (20-ui/icons.js: phone laptop desktop tablet board tv gamepad). */
  function icon(name, size) { return WH.ui.icon(name, size); }
  PL.icon = icon;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  /** Every spelling of a preset: its label and aliases in both languages. */
  function spellings(id) {
    const out = new Set();
    for (const l of ['cs', 'en']) {
      const d = (WH.i18n.dictionary && WH.i18n.dictionary(l)) || {};
      if (d[`planner.dev.${id}`]) out.add(norm(d[`planner.dev.${id}`]));
      String(d[`planner.dev.${id}.alias`] || '').split('|').forEach((a) => { if (norm(a)) out.add(norm(a)); });
    }
    return out;
  }
  const spellCache = new Map();
  /** The preset a stored device name stands for, or null for a custom name. */
  function match(value) {
    const v = norm(value);
    if (!v) return null;
    for (const p of PRESETS) {
      let s = spellCache.get(p.id);
      if (!s) { s = spellings(p.id); spellCache.set(p.id, s); }
      if (s.has(v)) return p;
    }
    return null;
  }
  /** What the UI shows for a stored device name (a preset in the current language, else the name itself). */
  const label = (value) => { const p = match(value); return p ? t(`planner.dev.${p.id}`) : String(value || ''); };
  const iconOf = (value) => { const p = match(value); return p ? p.icon : 'wifi'; };

  /** Every device name the project uses (goal + measurements), first appearance first. */
  function used(extra) {
    const p = PL.P();
    const all = [extra, p.goal.device, ...p.measurements.map((m) => m.device)].filter((x) => typeof x === 'string' && x.trim());
    const seen = new Set();
    return all.filter((x) => { const k = norm(x); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  /** The string to store for a preset: a spelling the project already uses, else the label in the current language. */
  function valueFor(id) {
    const s = spellings(id);
    return used().find((x) => s.has(norm(x))) || t(`planner.dev.${id}`);
  }

  PL.dev = { PRESETS, match, label, iconOf, used, valueFor };

  /**
   * The picker.  o = {value, onChange(value), ariaKey?}.  Returns the root element with .value, .setValue(v),
   * .button (the trigger) and .customOpen().  A typed custom name counts as the value while its field is open.
   */
  PL.devicePicker = function devicePicker(o) {
    let value = o.value || '';
    const ico = el('span.pl-dev__ico');
    const lbl = el('span.pl-dev__lbl');
    const btn = el('button.pl-dev__btn', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, ico, lbl, el('span.pl-dev__chev', WH.ui.icon('chevron-down', 16)));
    const inp = el('input.input.pl-dev__inp', { type: 'text', maxlength: '50', autocomplete: 'off', enterkeyhint: 'done' });
    const ok = WH.ui.iconButton({ icon: 'check', tip: 'planner.dev.ok', variant: 'soft', onClick: () => commitCustom() });
    const custom = el('div.pl-dev__custom', { hidden: true }, inp, ok);
    const root = el('div.pl-dev', btn, custom);
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 50);

    function paint() {
      ico.replaceChildren(icon(iconOf(value), 18));
      lbl.textContent = label(value) || '—';
      btn.setAttribute('aria-label', t(o.ariaKey || 'planner.dev.aria', { name: label(value) || '—' }));
      inp.placeholder = t('planner.dev.customPh');
      inp.setAttribute('aria-label', t('planner.dev.customAria'));
    }
    function set(v, fire) {
      v = clean(v);
      if (!v) return;
      const changed = v !== value;
      value = v;
      paint();
      if (fire && changed && typeof o.onChange === 'function') o.onChange(v);
    }
    function openCustom() {
      custom.hidden = false;
      inp.value = match(value) ? '' : value;
      try { inp.focus({ preventScroll: true }); inp.select(); } catch (e) { /* ignore */ }
      if (typeof o.onLayout === 'function') o.onLayout();
    }
    function closeCustom(focusBtn) {
      if (custom.hidden) return;
      custom.hidden = true;
      if (focusBtn) { try { btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      if (typeof o.onLayout === 'function') o.onLayout();
    }
    function commitCustom() {
      const v = clean(inp.value);
      if (v) set(v, true);
      closeCustom(true);
    }
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !o.enterSubmits) { e.preventDefault(); e.stopPropagation(); commitCustom(); }
      else if (e.key === 'Escape' && !root.closest('.pop-panel')) { e.preventDefault(); e.stopPropagation(); closeCustom(true); }
    });
    // leaving the field with a name in it also takes it (and tidies the field away)
    inp.addEventListener('change', () => { if (clean(inp.value)) { set(inp.value, true); closeCustom(false); } });

    function items() {
      const cur = norm(value);
      const list = PRESETS.map((p) => ({ dev: p.icon, label: t(`planner.dev.${p.id}`), on: !!match(value) && match(value).id === p.id, pick: () => set(valueFor(p.id), true) }));
      const customs = used(value).filter((x) => !match(x)).slice(0, 8);
      const out = list.slice();
      if (customs.length) {
        out.push({ sep: true }, { heading: t('planner.dev.used') });
        customs.forEach((x) => out.push({ dev: 'wifi', label: x, on: norm(x) === cur, pick: () => set(x, true) }));
      }
      out.push({ sep: true }, { dev: 'plus', label: t('planner.dev.custom'), pick: openCustom });
      return out;
    }
    function openMenu() {
      const defs = items();
      const h = WH.ui.menu(btn, defs.map((d) => (d.sep || d.heading ? d : { label: d.label, onClick: d.pick })), { align: 'start' });
      // icons + the radio state (WH.ui.menu takes icon names only; the device icons may be inline fallbacks)
      const rows = h.el.querySelectorAll('.menu__item');
      defs.filter((d) => !d.sep && !d.heading).forEach((d, i) => {
        const b = rows[i];
        if (!b) return;
        b.prepend(el('span.menu__icon', icon(d.dev, 18)));
        if (d.on !== undefined && d.dev !== 'plus') {
          b.setAttribute('role', 'menuitemradio');
          b.setAttribute('aria-checked', d.on ? 'true' : 'false');
          if (d.on) b.append(el('span.pl-dev__on', WH.ui.icon('check', 16)));
        }
      });
      h.el.classList.add('pl-dev__menu');
      h.el.style.minWidth = `${Math.max(232, Math.round(btn.getBoundingClientRect().width))}px`;
      // focus the current entry instead of the first one
      const cur = h.el.querySelector('.menu__item[aria-checked="true"]');
      if (cur) requestAnimationFrame(() => requestAnimationFrame(() => { try { cur.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }));
    }
    btn.addEventListener('click', openMenu);
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); } });

    paint();
    Object.defineProperty(root, 'value', { get: () => (!custom.hidden && clean(inp.value) ? clean(inp.value) : value) });
    root.setValue = (v) => { if (v && clean(v) !== value) { value = clean(v); paint(); } else paint(); };
    root.repaint = paint;
    root.button = btn;
    root.input = inp;
    root.customOpen = () => !custom.hidden;
    return root;
  };
})();
