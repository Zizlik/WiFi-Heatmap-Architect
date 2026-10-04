/* WH.shell - application chrome and glue:
 *   WH.views   view registry + router (#wifi = planner, #plan = editor)
 *   WH.ui.theme / WH.ui.cssVar
 *   header wiring (mode switch, File menu, shortcuts, theme, language, help), welcome overlay, help drawer, tour,
 *   global shortcuts, global drag & drop, boot sequence.
 *
 * The shell boots itself on DOMContentLoaded.  Anything that wants to run its own boot can set
 * `WH.shell.autoBoot = false` while its script loads and call `WH.shell.boot()` later; `WH.shell.onReady(fn)` and the
 * bus topic 'app:ready' tell when the first view is on screen. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ui = (WH.ui = WH.ui || {});

  const t = (k, p) => WH.i18n.t(k, p);
  const $ = (id) => document.getElementById(id);
  const KEY_RE = /^[a-z][\w-]*(\.[\w-]+)+$/;

  // ===================================================================================================================
  // Views registry & router
  // ===================================================================================================================
  const VIEW_DEFS = {
    planner: { root: 'view-planner', hash: 'wifi', button: 'mode-wifi' },
    editor: { root: 'view-editor', hash: 'plan', button: 'mode-plan' },
  };
  const registry = {};
  let current = null;
  let errorTimer = 0;

  function hashFor(name) { return VIEW_DEFS[name] && VIEW_DEFS[name].hash; }
  function viewFromHash() {
    const h = (location.hash || '').replace(/^#/, '').toLowerCase();
    return Object.keys(VIEW_DEFS).find((k) => VIEW_DEFS[k].hash === h) || null;
  }

  function paintModeSwitch(name) {
    for (const key of Object.keys(VIEW_DEFS)) {
      const b = $(VIEW_DEFS[key].button);
      if (!b) continue;
      const on = key === name;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    document.body.dataset.view = name || '';
  }

  function showViewError(name) {
    const root = $(VIEW_DEFS[name].root);
    if (!root || root.childElementCount) return;
    root.append(WH.util.el('div.empty-state.view-error', WH.util.el('div.empty-state__icon', ui.icon('warning', 24)), WH.util.el('div.empty-state__title', t('shell.view.error'))));
  }

  function mountAndShow(name) {
    const reg = registry[name];
    const root = $(VIEW_DEFS[name].root);
    if (!reg || !reg.impl || !root) return;
    if (!reg.mounted && !reg.failed) {
      try {
        reg.impl.mount(root);
        reg.mounted = true;
        ui.enhance(root);
      } catch (e) {
        reg.failed = true;
        console.error(`[WH.views] mounting "${name}" failed:`, e);
        const rec = WH.diag ? WH.diag.record(e, { kind: 'caught', context: `views.mount:${name}`, notify: false }) : null;
        root.replaceChildren();
        showViewError(name);
        ui.toast({ i18n: 'shell.view.error', action: rec && ui.diag ? { i18n: 'app.err.details', fn: () => ui.diag.showDetails(rec.id) } : undefined }, { kind: 'error' });
        return;
      }
    }
    if (reg.mounted) {
      try { if (typeof reg.impl.show === 'function') reg.impl.show(); } catch (e) { console.error(`[WH.views] show() of "${name}" failed:`, e); if (WH.diag) WH.diag.caught(e, `views.show:${name}`); }
    }
  }

  const views = {
    /** Register a view implementation: { mount(root), show(), hide(), resize?(), exportPng?(), tourSteps?() }. */
    register(name, impl) {
      if (!VIEW_DEFS[name]) { console.warn(`[WH.views] unknown view "${name}"`); return; }
      if (!impl || typeof impl.mount !== 'function') throw new TypeError(`WH.views.register("${name}"): impl.mount(root) is required`);
      registry[name] = { impl, mounted: false, failed: false };
      if (current === name) { clearTimeout(errorTimer); mountAndShow(name); }
    },
    /** Switch to a view ('planner' | 'editor'). */
    go(name, opts) {
      opts = opts || {};
      if (!VIEW_DEFS[name]) { console.warn(`[WH.views] unknown view "${name}"`); return false; }
      if (current === name && !opts.force) return true;
      const prev = current;
      if (prev && registry[prev] && registry[prev].mounted) {
        try { if (typeof registry[prev].impl.hide === 'function') registry[prev].impl.hide(); } catch (e) { console.error(e); }
      }
      if (prev) { const pr = $(VIEW_DEFS[prev].root); if (pr) pr.hidden = true; }
      current = name;
      const root = $(VIEW_DEFS[name].root);
      if (root) root.hidden = false;
      const loading = $('app-loading');
      if (loading) loading.remove();
      paintModeSwitch(name);
      if (opts.updateHash !== false) {
        const want = `#${hashFor(name)}`;
        if (location.hash !== want) {
          try {
            if (opts.replaceHash) history.replaceState(null, '', want); else location.hash = want;
          } catch (e) { /* file:// quirks - routing still works without the hash */ }
        }
      }
      clearTimeout(errorTimer);
      if (registry[name]) mountAndShow(name);
      else errorTimer = setTimeout(() => { if (current === name && !registry[name]) showViewError(name); }, 2500);
      WH.bus.emit('view:changed', { name, prev });
      return true;
    },
    get current() { return current; },
    impl(name) { return registry[name] ? registry[name].impl : null; },
    isMounted(name) { return !!(registry[name] && registry[name].mounted); },
    list() { return Object.keys(VIEW_DEFS); },
  };
  WH.views = views;

  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v && v !== current) views.go(v, { updateHash: false });
  });

  window.addEventListener('resize', WH.util.throttleRaf(() => {
    const impl = current && registry[current] && registry[current].mounted ? registry[current].impl : null;
    if (impl && typeof impl.resize === 'function') { try { impl.resize(); } catch (e) { console.error(e); } }
  }));

  // ===================================================================================================================
  // Theme (SPEC 12): Automaticky (OS: light <-> Deep dark) · Světlý · Deep dark · OLED černá
  //   pref 'theme' = 'auto' | 'light' | 'dark' | 'oled'
  //   <html data-theme="light|dark|oled"> only when forced (auto = no attribute, CSS follows prefers-color-scheme)
  //   <html data-scheme="light|dark"> always: the colour scheme in effect (OLED is a dark scheme) for module CSS
  //   theme.effective() -> 'light' | 'dark' (scheme)   theme.resolved() -> 'light' | 'dark' | 'oled' (palette)
  // ===================================================================================================================
  const THEMES = ['auto', 'light', 'dark', 'oled'];
  const THEME_ICON = { auto: 'contrast', light: 'sun', dark: 'moon', oled: 'moon-star' };
  /** Mini previews for the picker: page / surface / line / accent / ink of each palette (data, not tokens: the picker
   *  shows the OTHER themes too). 'auto' is drawn half light, half Deep dark. */
  const THEME_PREVIEW = {
    light: { bg: '#f3f6fb', surface: '#ffffff', line: '#cdd6e3', accent: '#0f766e', ink: '#13233a' },
    dark: { bg: '#0a0a0b', surface: '#161618', line: '#2e2e33', accent: '#2dd4bf', ink: '#f2f2f3' },
    oled: { bg: '#000000', surface: '#000000', line: '#2a2a2e', accent: '#2dd4bf', ink: '#f4f4f5' },
  };
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  let cssCache = {};

  const theme = {
    list: () => THEMES.slice(),
    get() { const v = WH.store.prefs.theme; return THEMES.includes(v) ? v : 'auto'; },
    /** The concrete palette in use: 'light' | 'dark' (Deep dark) | 'oled'. */
    resolved() { const v = theme.get(); return v === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : v; },
    /** The colour scheme in use: 'light' | 'dark' (OLED counts as dark - canvas code that only knows light/dark keeps working). */
    effective() { return theme.resolved() === 'light' ? 'light' : 'dark'; },
    isDark() { return theme.effective() === 'dark'; },
    set(v) {
      if (!THEMES.includes(v)) return;
      WH.store.setPref('theme', v);
      theme.apply();
    },
    cycle() { theme.set(THEMES[(THEMES.indexOf(theme.get()) + 1) % THEMES.length]); },
    apply() {
      const v = theme.get();
      const root = document.documentElement;
      if (v === 'auto') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', v);
      root.setAttribute('data-scheme', theme.effective());
      cssCache = {};
      paintThemeButtons();
      WH.bus.emit('theme:changed', { theme: v, effective: theme.effective(), resolved: theme.resolved() });
    },
    menu: (anchor) => openThemeMenu(anchor),
    picker: () => themePicker(),
  };

  function paintThemeButtons() {
    const v = theme.get();
    for (const b of Array.from(document.querySelectorAll('#btn-theme, [data-theme-menu]'))) {
      const svg = b.querySelector('svg.icon');
      if (svg) svg.replaceWith(ui.icon(THEME_ICON[v], 20));
      b.setAttribute('data-tip', `shell.theme.${v}`);
      b.setAttribute('aria-label', t(`shell.theme.${v}`));
    }
    for (const p of Array.from(document.querySelectorAll('.theme-picker'))) paintPicker(p);
  }
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', () => {
      if (theme.get() !== 'auto') return;
      cssCache = {};
      document.documentElement.setAttribute('data-scheme', theme.effective());
      WH.bus.emit('theme:changed', { theme: 'auto', effective: theme.effective(), resolved: theme.resolved() });
    });
  }

  /** Header / welcome / File menu: a small radio menu "Automaticky · Světlý · Deep dark · OLED černá". */
  function openThemeMenu(anchor) {
    if (!anchor) return null;
    const cur = theme.get();
    return ui.menu(anchor, [
      { heading: true, i18n: 'theme.menu' },
      ...THEMES.map((v) => ({ i18n: `theme.${v}`, icon: THEME_ICON[v], radio: true, checked: v === cur, onClick: () => theme.set(v) })),
    ], { align: 'end' });
  }

  /** Help panel: the same choice as four preview tiles (radio group, arrow keys move and choose). */
  function themePicker() {
    const U = WH.util;
    const root = U.el('div.theme-picker', { role: 'radiogroup', 'data-i18n-aria': 'theme.menu' });
    for (const v of THEMES) {
      const sw = U.el('span.theme-opt__swatch', { 'aria-hidden': 'true' });
      const parts = v === 'auto' ? ['light', 'dark'] : [v];
      for (const k of parts) {
        const c = THEME_PREVIEW[k];
        const half = U.el('span.theme-opt__half', { style: { background: c.bg } },
          U.el('span.theme-opt__card', { style: { background: c.surface, borderColor: c.line } },
            U.el('span.theme-opt__line', { style: { background: c.ink } }),
            U.el('span.theme-opt__dot', { style: { background: c.accent } })));
        sw.append(half);
      }
      const b = U.el('button.theme-opt', { type: 'button', role: 'radio', 'data-theme-value': v },
        sw,
        U.el('span.theme-opt__text', U.el('span.theme-opt__name', { 'data-i18n': `theme.${v}` }), U.el('span.theme-opt__desc', { 'data-i18n': `theme.${v}.d` })));
      b.addEventListener('click', () => theme.set(v));
      root.append(b);
    }
    radioKeys(root, '.theme-opt', (b) => theme.set(b.getAttribute('data-theme-value')));
    paintPicker(root);
    return root;
  }
  function paintPicker(root) {
    const cur = theme.get();
    for (const b of Array.from(root.querySelectorAll('.theme-opt'))) {
      const on = b.getAttribute('data-theme-value') === cur;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  /** Resolved value of a CSS custom property (e.g. '--map-wall'), cached until the theme changes. For canvas drawing. */
  function cssVar(name) {
    if (cssCache[name] === undefined) cssCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return cssCache[name];
  }
  ui.theme = theme;
  ui.cssVar = cssVar;

  // ===================================================================================================================
  // Project helpers
  // ===================================================================================================================
  function engineProject() { return WH.engine && WH.engine.project ? WH.engine.project : null; }

  function makeProject(template) {
    const ep = engineProject();
    if (!ep || typeof ep.create !== 'function') { ui.toast({ i18n: 'io.err.noEngine' }, { kind: 'error' }); return null; }
    try {
      const p = ep.create({ template, lang: WH.i18n.lang });
      if (p && !p.name) p.name = t('io.defaultName');
      return p;
    } catch (e) {
      console.error('[WH.shell] creating a project failed:', e);
      if (WH.diag) WH.diag.record(e, { context: `project.create:${template}`, notify: false });
      ui.toast({ i18n: 'io.err.generic' }, { kind: 'error' });
      return null;
    }
  }

  function isTrivial(p) {
    if (!p || !p.plan) return true;
    const pl = p.plan;
    return !(pl.rooms && pl.rooms.length) && !(pl.walls && pl.walls.length) && !(pl.furniture && pl.furniture.length) && !pl.background;
  }

  async function confirmReplace() {
    if (isTrivial(WH.store.project)) return true;
    return ui.confirm({ title: t('file.replace.t'), body: t('file.replace.b'), ok: t('file.replace.ok') });
  }

  function labelText(label) {
    if (!label) return '';
    return typeof label === 'string' && KEY_RE.test(label) && WH.i18n.has(label) ? t(label) : String(label);
  }

  // ===================================================================================================================
  // Welcome overlay
  // ===================================================================================================================
  let welcomeOpen = false;

  function setBackgroundInert(on) {
    for (const id of ['app-header', 'app-main']) {
      const n = $(id);
      if (!n) continue;
      if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert');
    }
  }

  function showWelcome() {
    const w = $('welcome');
    if (!w) return;
    welcomeOpen = true;
    w.hidden = false;
    updateTitle();
    setBackgroundInert(true);
    if (ui.blockInput) ui.blockInput(1);
    // focus the dialog itself (screen readers announce its title, Tab reaches the first card) - focusing the first card
    // painted a keyboard focus ring on it at every start, which looked like a selection
    w.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => { try { w.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
  }

  function hideWelcome() {
    const w = $('welcome');
    if (!w || !welcomeOpen) return;
    welcomeOpen = false;
    w.hidden = true;
    updateTitle();
    setBackgroundInert(false);
    if (ui.blockInput) ui.blockInput(-1);
    WH.store.setPref('welcomeDone', true);
  }

  /** Route to the right view after something was imported / created, and offer the tour once. */
  function afterNewProject(view) {
    hideWelcome();
    views.go(view);
    offerTour();
  }

  function offerTour() {
    const prefs = WH.store.prefs;
    if (prefs.tourDone || prefs.tourOffered) return;
    WH.store.setPref('tourOffered', true);
    // one message at a time: wait until the "plan loaded" toast is gone (two stacked toasts covered half the panel)
    let tries = 0;
    const show = () => {
      const busy = document.querySelectorAll('#toast-root .toast').length > 0;
      if (busy && tries < 16) { tries += 1; setTimeout(show, 500); return; }
      ui.toast({ i18n: 'welcome.tourOffer', action: { i18n: 'welcome.tourStart', fn: startTour } }, { kind: 'info', ms: 10000 });
    };
    setTimeout(show, 900);
  }

  async function welcomeDemo() {
    const p = makeProject('demo');
    if (!p) return;
    WH.store.init(p);
    afterNewProject('planner');
  }

  async function welcomeBlank() {
    const p = makeProject('blank');
    if (!p) return;
    WH.store.init(p);
    WH.bus.emit('project:created', { template: 'blank' });
    afterNewProject('editor');
  }

  async function pickFile() {
    if (!WH.io) return;
    const res = await WH.io.openPicker({ fresh: welcomeOpen });
    routeAfterImport(res);
  }

  function routeAfterImport(res) {
    if (!res || res.kind === 'error' || res.kind === 'cancelled' || res.kind === 'background') return;
    afterNewProject(res.kind === 'tracing_image' ? 'editor' : 'planner');
  }

  // ===================================================================================================================
  // File menu actions
  // ===================================================================================================================
  async function menuDemo() {
    if (!(await confirmReplace())) return;
    const p = makeProject('demo');
    if (!p) return;
    WH.store.replace(p, 'file.demo');
    WH.bus.emit('project:created', { template: 'demo' });
    views.go('planner');
    ui.toast({ i18n: 'file.demoLoaded' }, { kind: 'ok' });
  }

  async function menuNew() {
    if (!(await confirmReplace())) return;
    const p = makeProject('blank');
    if (!p) return;
    WH.store.replace(p, 'file.new');
    WH.bus.emit('project:created', { template: 'blank' });
    views.go('editor');
    ui.toast({ i18n: 'file.newCreated' }, { kind: 'ok' });
  }

  async function menuClear() {
    const ok = await ui.confirm({ title: t('file.clear.t'), body: t('file.clear.b'), ok: t('file.clear.ok'), danger: true });
    if (!ok) return;
    WH.store.disableAutosave();
    if (WH.io) WH.io.clearLocal();
    ui.toast({ i18n: 'file.cleared' }, { kind: 'ok' });
    setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, 500);
  }

  async function saveMapPng() {
    const impl = current && views.impl(current);
    if (!impl || typeof impl.exportPng !== 'function') { ui.toast({ i18n: 'file.noViewPng' }, { kind: 'warn' }); return; }
    try {
      const blob = await impl.exportPng();
      if (blob instanceof Blob) {
        const name = `${WH.util.slug(WH.store.project && WH.store.project.name, 'wifi')}-${WH.i18n.lang === 'cs' ? 'mapa-signalu' : 'signal-map'}.png`;
        WH.util.download(blob, name, 'image/png');
        ui.toast(t('io.ok.png', { name }), { kind: 'ok' });
      }
    } catch (e) {
      console.error('[WH.shell] map export failed:', e);
      if (WH.diag) WH.diag.record(e, { context: 'file.saveMapPng', notify: false });
      ui.toast({ i18n: 'io.err.export' }, { kind: 'error' });
    }
  }

  async function installApp() {
    if (!WH.pwa || !WH.pwa.canInstall()) return;
    if (await WH.pwa.install()) ui.toast({ i18n: 'file.installed' }, { kind: 'ok' });
  }

  function openFileMenu() {
    const anchor = $('btn-file');
    if (!anchor) return;
    const themeBtn = $('btn-theme');
    const canMapPng = current === 'planner' && views.impl('planner') && typeof views.impl('planner').exportPng === 'function';
    ui.menu(anchor, [
      { i18n: 'file.open', icon: 'folder-open', kbd: 'ctrl+o', onClick: pickFile },
      { i18n: 'file.saveSvg', icon: 'save', kbd: 'ctrl+s', onClick: () => WH.io && WH.io.saveProjectSvg() },
      { i18n: 'file.savePlanPng', icon: 'file-image', onClick: () => WH.io && WH.io.exportPlanPng() },
      { i18n: 'file.saveMapPng', icon: 'image', onClick: saveMapPng, hidden: !canMapPng },
      { sep: true },
      { i18n: 'file.demo', icon: 'home', onClick: menuDemo },
      { i18n: 'file.new', icon: 'plan', onClick: menuNew },
      { sep: true },
      // the header's theme button is hidden on very narrow phones: the same menu opens from here
      { i18n: 'file.theme', icon: THEME_ICON[theme.get()], onClick: () => openThemeMenu(anchor), hidden: !!(themeBtn && themeBtn.offsetParent) },
      // offered by the browser (Chrome/Edge/Android) only when the app is served over https and not installed yet
      { i18n: 'file.install', icon: 'download', onClick: installApp, hidden: !(WH.pwa && WH.pwa.canInstall()) },
      { i18n: 'file.clear', icon: 'trash', danger: true, onClick: menuClear },
      { sep: true },
      { note: true, i18n: 'file.autosave' },
    ]);
  }

  // ===================================================================================================================
  // Help drawer
  // ===================================================================================================================
  let helpHandle = null;
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function glossaryEntries() {
    const items = [];
    for (const k of WH.i18n.keys('help.')) {
      const m = /^help\.([^.]+)\.t$/.exec(k);
      if (!m || !WH.i18n.has(`help.${m[1]}.b`)) continue;
      items.push({ key: m[1], title: t(k), body: t(`help.${m[1]}.b`), more: WH.i18n.has(`help.${m[1]}.more`) ? t(`help.${m[1]}.more`) : '' });
    }
    const collator = new Intl.Collator(WH.i18n.locale);
    return items.sort((a, b) => collator.compare(a.title, b.title));
  }

  function buildGlossary() {
    const entries = glossaryEntries();
    const U = WH.util;
    const search = U.el('input.input', { type: 'search', 'data-i18n-ph': 'helpPanel.glossary.search', 'data-i18n-aria': 'helpPanel.glossary.search', autocomplete: 'off', spellcheck: 'false' });
    const list = U.el('dl.glossary');
    const empty = U.el('p.text-muted.text-sm', { hidden: true, 'data-i18n': 'helpPanel.glossary.empty' });
    const rows = entries.map((e) => {
      const row = U.el('div', U.el('dt', e.title), U.el('dd', e.body + (e.more ? ` ${e.more}` : '')));
      row._hay = fold(`${e.title} ${e.body} ${e.more}`);
      return row;
    });
    list.append(...rows);
    search.addEventListener('input', () => {
      const q = fold(search.value.trim());
      let shown = 0;
      for (const r of rows) {
        const hit = !q || r._hay.includes(q);
        r.hidden = !hit;
        if (hit) shown += 1;
      }
      empty.hidden = shown > 0;
    });
    return [search, list, empty];
  }

  function disclosure(titleKey, iconName, bodyNodes, open, section) {
    const U = WH.util;
    const d = U.el('details.disclosure');
    if (section) d.setAttribute('data-help-section', section);
    if (open) d.open = true;
    d.append(U.el('summary', iconName ? ui.icon(iconName, 20) : null, U.el('span', { 'data-i18n': titleKey })), U.el('div.disclosure__body', bodyNodes));
    return d;
  }

  function buildHelpBody() {
    const U = WH.util;
    const nodes = [];
    // how it works
    const steps = U.el('ol.steps');
    for (const n of [1, 2, 3]) steps.append(U.el('li', U.el('b', { 'data-i18n': `helpPanel.how.${n}.t` }), U.el('span', { 'data-i18n': `helpPanel.how.${n}.b` })));
    nodes.push(U.el('section.help-section', U.el('h3', { 'data-i18n': 'helpPanel.how.t' }), steps));
    // tour + shortcuts
    const tourBtn = ui.button({ i18n: 'helpPanel.tour.btn', icon: 'play', variant: 'primary', size: 'sm', onClick: () => { if (helpHandle) helpHandle.close(); setTimeout(startTour, 80); } });
    const keysBtn = ui.button({ i18n: 'helpPanel.shortcuts', icon: 'keyboard', variant: 'secondary', size: 'sm', onClick: () => { if (helpHandle) helpHandle.close(); setTimeout(() => ui.keys.sheet(), 80); } });
    nodes.push(U.el('div.card.card--soft.p-3.stack', { style: { '--gap': '8px' } },
      U.el('div', U.el('b', { 'data-i18n': 'helpPanel.tour.t' }), U.el('div.text-sm.text-muted', { 'data-i18n': 'helpPanel.tour.b' })),
      U.el('div.row.row--wrap', tourBtn, keysBtn)));
    // SPEC 9: the guided "Prvotní měření" (50-planner/28-calib-wizard.js): closes Help, opens the Wi-Fi view and the guide
    const calib = WH.planner && WH.planner.calib && typeof WH.planner.calib.helpBlock === 'function' ? WH.planner.calib.helpBlock(() => { if (helpHandle) helpHandle.close(); }) : null;
    if (calib) nodes.push(calib);
    // measure guide
    const guide = U.el('div.platform-guide');
    // SPEC 13: 'steer' = Wi-Fi 7 / band steering - never ask the user to pin a device to one band
    const PLAT = [['android', 'phone'], ['iphone', 'phone'], ['windows', 'monitor'], ['mac', 'laptop'], ['linux', 'terminal'], ['speed', 'speed'], ['rules', 'check-circle'], ['steer', 'wifi']];
    for (const [k, ic] of PLAT) guide.append(U.el('div', U.el('h4', ui.icon(ic, 18), U.el('span', { 'data-i18n': `measure.${k}.t` })), U.el('p', { 'data-i18n': `measure.${k}.b` })));
    // SPEC 8 / 8.2: per-OS commands that copy the Wi-Fi details (Copy buttons) + the Wi-Fi helper downloads; the
    // block is built by the planner (50-planner/27-devinfo-ui.js, same commands as its "Info o zařízení" card)
    const cmdTips = WH.planner && typeof WH.planner.cmdTips === 'function' ? WH.planner.cmdTips({ all: true }) : null;
    const cmd = cmdTips ? [U.el('h4.help-subhead', ui.icon('terminal', 18), U.el('span', { 'data-i18n': 'helpPanel.cmd.t' })), U.el('p.text-sm.text-muted', { 'data-i18n': 'helpPanel.cmd.lead' }), cmdTips] : [];
    nodes.push(disclosure('helpPanel.measure.t', 'antenna', [U.el('p.text-muted', { 'data-i18n': 'helpPanel.measure.lead' }), guide, ...cmd], true));
    // on the phone: open the published page, add it to the home screen, measure where you stand (SPEC 6.2 / 6.3)
    const phone = U.el('ol.steps');
    for (const n of [1, 2, 3]) phone.append(U.el('li', U.el('span', { 'data-i18n-html': `helpPanel.phone.${n}` })));
    nodes.push(disclosure('helpPanel.phone.t', 'phone', [phone, U.el('p.text-sm.text-muted', { 'data-i18n': 'helpPanel.phone.offline' })], false));
    // the built-in speed test: what leaves the device and what does not (SPEC 6.1 privacy)
    const privacy = U.el('ul.help-list');
    for (const n of [1, 2, 3, 4]) privacy.append(U.el('li', { 'data-i18n': `helpPanel.speed.${n}` }));
    nodes.push(disclosure('helpPanel.speed.t', 'lock', [privacy, U.el('p.text-sm.text-muted', { 'data-i18n': 'helpPanel.speed.note' })], false));
    nodes.push(disclosure('helpPanel.glossary.t', 'help', buildGlossary(), false));
    nodes.push(disclosure('helpPanel.model.t', 'info', [U.el('p', { 'data-i18n': 'helpPanel.model.b' }), U.el('p.text-sm', { 'data-i18n-html': 'helpPanel.model.links' })], false));
    // SPEC 12: appearance (the same four choices as the header menu, with previews)
    nodes.push(disclosure('helpPanel.theme.t', 'contrast', [U.el('p.text-sm.text-muted', { 'data-i18n': 'helpPanel.theme.lead' }), themePicker()], false, 'theme'));
    // SPEC 10: "Nahlásit problém" - copy a diagnostic summary (no plan data, measurements or network names)
    const report = ui.diag && typeof ui.diag.helpBlock === 'function' ? ui.diag.helpBlock() : null;
    if (report) nodes.push(disclosure('diag.report.t', 'flag', [report], false, 'report'));
    nodes.push(U.el('p.text-xs.text-muted.mt-4', { style: 'line-height:1.5', 'data-i18n': 'helpPanel.footer' }));
    nodes.push(U.el('p.text-xs.text-muted.help-credits', { style: 'line-height:1.5', 'data-i18n-html': 'helpPanel.credits' }));
    return nodes;
  }

  /** Help drawer; opts.section ('theme' | 'report') opens that section and scrolls to it (the error details use it). */
  function openHelp(opts) {
    const section = opts && typeof opts === 'object' && typeof opts.section === 'string' ? opts.section : '';
    if (helpHandle && !section) { helpHandle.close(); return; }
    if (!helpHandle) {
      helpHandle = ui.dialog({
        title: { i18n: 'helpPanel.title' },
        content: buildHelpBody(),
        className: 'modal--drawer',
        onClose: () => { helpHandle = null; },
      });
      helpHandle.el.parentNode.classList.add('modal-backdrop--drawer');
    }
    const d = section ? helpHandle.body.querySelector(`[data-help-section="${section}"]`) : null;
    if (d) {
      d.open = true;
      requestAnimationFrame(() => {
        try { d.scrollIntoView({ block: 'start', behavior: WH.util.prefersReducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ }
        const s = d.querySelector('summary');
        if (s) { try { s.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      });
    }
  }

  // ===================================================================================================================
  // Guided tour
  // ===================================================================================================================
  function tourSteps() {
    const impl = current && views.impl(current);
    let own = [];
    try { if (impl && typeof impl.tourSteps === 'function') own = impl.tourSteps() || []; } catch (e) { console.error(e); }
    return [
      { title: 'tour.intro.t', body: 'tour.intro.b' },
      { target: '#mode-switch', title: 'tour.mode.t', body: 'tour.mode.b', placement: 'bottom' },
      ...own,
      { target: '#estimate-badge', title: 'tour.badge.t', body: 'tour.badge.b', placement: 'bottom' },
      { target: '#btn-file', title: 'tour.file.t', body: 'tour.file.b', placement: 'bottom' },
      { target: '#btn-keys', title: 'tour.keys.t', body: 'tour.keys.b', placement: 'bottom', optional: true },
      { target: '#btn-help', title: 'tour.help.t', body: 'tour.help.b', placement: 'bottom' },
      { title: 'tour.end.t', body: 'tour.end.b' },
    ];
  }

  function startTour() {
    if (welcomeOpen || !current) return Promise.resolve('skipped');
    return ui.tour(tourSteps());
  }

  // ===================================================================================================================
  // Global shortcuts
  // ===================================================================================================================
  function doUndo() {
    if (WH.store.gestureOpen) return;
    if (!WH.store.canUndo()) { ui.toast({ i18n: 'keys.nothingToUndo' }, { ms: 1500 }); return; }
    const label = labelText(WH.store.labels().undo);
    WH.store.undo();
    ui.toast(label ? t('keys.undone', { label }) : t('ui.undo'), { ms: 1800 });
  }
  function doRedo() {
    if (WH.store.gestureOpen) return;
    if (!WH.store.canRedo()) { ui.toast({ i18n: 'keys.nothingToRedo' }, { ms: 1500 }); return; }
    const label = labelText(WH.store.labels().redo);
    WH.store.redo();
    ui.toast(label ? t('keys.redone', { label }) : t('keys.redo'), { ms: 1800 });
  }

  function registerShortcuts() {
    const K = ui.keys.register;
    K({ mode: 'global', key: '1', i18n: 'keys.modeEditor', run: () => { views.go('editor'); }, order: 1 });
    K({ mode: 'global', key: '2', i18n: 'keys.modePlanner', run: () => { views.go('planner'); }, order: 2 });
    K({ mode: 'global', key: '?', i18n: 'keys.sheet', run: () => { ui.keys.sheet(); }, allowInModal: true, order: 3 });
    K({ mode: 'global', key: 'f1', i18n: 'keys.helpPanel', run: () => openHelp(), allowTyping: true, order: 4 });
    K({ mode: 'global', key: 'ctrl+s', i18n: 'keys.save', run: () => { if (WH.io) WH.io.saveProjectSvg(); }, allowTyping: true, order: 5 });
    K({ mode: 'global', key: 'ctrl+o', i18n: 'keys.open', run: () => { pickFile(); }, allowTyping: true, order: 6 });
    K({ mode: 'global', key: 'ctrl+z', i18n: 'keys.undo', run: doUndo, repeat: true, order: 7 });
    K({ mode: 'global', key: ['ctrl+shift+z', 'ctrl+y'], i18n: 'keys.redo', run: doRedo, repeat: true, order: 8 });
    K({ mode: 'global', key: '+', i18n: 'keys.zoomIn', run: () => { WH.bus.emit('viewport:zoom', { factor: 1.25 }); }, repeat: true, order: 9 });
    K({ mode: 'global', key: '=', run: () => { WH.bus.emit('viewport:zoom', { factor: 1.25 }); }, repeat: true, hidden: true });
    K({ mode: 'global', key: '-', i18n: 'keys.zoomOut', run: () => { WH.bus.emit('viewport:zoom', { factor: 0.8 }); }, repeat: true, order: 10 });
    K({ mode: 'global', key: '0', i18n: 'keys.zoomFit', run: () => { WH.bus.emit('viewport:fit', {}); }, order: 11 });
    // documentation entry only: the views handle Esc themselves
    K({ mode: 'global', key: 'escape', i18n: 'keys.esc', run: () => false, allowTyping: true, allowInModal: true, order: 12 });
  }

  // ===================================================================================================================
  // Language switch, mode switch & header wiring
  // ===================================================================================================================
  function paintLangSwitches() {
    for (const sw of Array.from(document.querySelectorAll('[data-lang-switch]'))) {
      for (const b of Array.from(sw.querySelectorAll('[data-lang]'))) {
        const on = b.getAttribute('data-lang') === WH.i18n.lang;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    }
  }

  /** Radio-group keyboard behaviour for the two static header switches. */
  function radioKeys(container, buttonsSel, activate) {
    container.addEventListener('keydown', (e) => {
      const list = Array.from(container.querySelectorAll(buttonsSel));
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % list.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + list.length) % list.length;
      if (n < 0) return;
      e.preventDefault();
      list[n].focus();
      activate(list[n]);
    });
  }

  function wireHeader() {
    for (const key of Object.keys(VIEW_DEFS)) {
      const b = $(VIEW_DEFS[key].button);
      if (b) b.addEventListener('click', () => views.go(key));
    }
    const modeSwitch = $('mode-switch');
    if (modeSwitch) radioKeys(modeSwitch, '[data-view]', (b) => views.go(b.getAttribute('data-view')));

    const file = $('btn-file');
    if (file) file.addEventListener('click', openFileMenu);
    const keys = $('btn-keys');
    if (keys) keys.addEventListener('click', () => ui.keys.sheet());
    const help = $('btn-help');
    if (help) help.addEventListener('click', () => openHelp());
    for (const b of Array.from(document.querySelectorAll('#btn-theme, [data-theme-menu]'))) b.addEventListener('click', () => openThemeMenu(b));

    for (const sw of Array.from(document.querySelectorAll('[data-lang-switch]'))) {
      for (const b of Array.from(sw.querySelectorAll('[data-lang]'))) b.addEventListener('click', () => WH.i18n.setLang(b.getAttribute('data-lang')));
      radioKeys(sw, '[data-lang]', (b) => WH.i18n.setLang(b.getAttribute('data-lang')));
    }
    const brand = $('brand');
    if (brand) brand.addEventListener('click', (e) => { e.preventDefault(); views.go('planner'); });

    const demo = $('welcome-demo');
    if (demo) demo.addEventListener('click', welcomeDemo);
    const blank = $('welcome-blank');
    if (blank) blank.addEventListener('click', welcomeBlank);
    for (const id of ['welcome-upload', 'welcome-open', 'welcome-drop']) {
      const b = $(id);
      if (b) b.addEventListener('click', pickFile);
    }
  }

  // ===================================================================================================================
  // Global drag & drop of files
  // ===================================================================================================================
  function wireDragDrop() {
    let depth = 0;
    let overlay = null;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    function show() {
      if (overlay) return;
      overlay = WH.util.el('div.drop-overlay', { role: 'presentation' },
        WH.util.el('div.drop-overlay__box', WH.util.el('span.icon-badge', ui.icon('upload', 24)), WH.util.el('div.drop-overlay__title', { 'data-i18n': 'drop.title' }), WH.util.el('div', { 'data-i18n': 'drop.body' })));
      (document.getElementById('overlay-root') || document.body).append(overlay);
      WH.i18n.applyDom(overlay);
    }
    function hide() {
      depth = 0;
      if (overlay) { overlay.remove(); overlay = null; }
    }

    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; show(); });
    window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) hide();
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length !== 1) { ui.toast({ i18n: 'io.err.multiple' }, { kind: 'warn' }); return; }
      if (!WH.io) return;
      routeAfterImport(await WH.io.importFile(files[0], { fresh: welcomeOpen }));
    });
    // a file dropped on a modal or anywhere else must never navigate away from the app
    window.addEventListener('blur', hide);
  }

  // ===================================================================================================================
  // Boot
  // ===================================================================================================================
  const readyCallbacks = [];
  let booted = false;
  let ready = false;

  function loadInitialProject() {
    let project = null;
    try { project = WH.io && typeof WH.io.loadLocal === 'function' ? WH.io.loadLocal() : null; } catch (e) { console.error('[WH.shell] loading the saved project failed:', e); }
    return project;
  }

  function boot() {
    if (booted) return;
    booted = true;

    WH.i18n.setLang(WH.i18n.lang);          // applies data-i18n attributes + <html lang>
    ui.enhance(document.body);              // icons, hints, tooltips
    theme.apply();
    paintLangSwitches();
    wireHeader();
    registerShortcuts();
    wireDragDrop();

    WH.bus.on('lang:changed', () => {
      paintLangSwitches();
      paintThemeButtons();
      if (helpHandle) { helpHandle.body.replaceChildren(...buildHelpBody()); ui.enhance(helpHandle.body); }
      updateTitle();
    });
    WH.bus.on('view:changed', () => updateTitle());
    WH.store.on('meta', updateTitle);

    if (!engineProject()) {
      console.error('[WH.shell] WH.engine.project is missing - the calculation engine did not load');
      const main = $('app-main');
      if (main) { const l = $('app-loading'); if (l) l.remove(); main.append(WH.util.el('div.empty-state.view-error', WH.util.el('div.empty-state__icon', ui.icon('warning', 24)), WH.util.el('div.empty-state__title', t('io.err.noEngine')))); }
      return;
    }

    const saved = loadInitialProject();
    const fromHash = viewFromHash();
    if (saved) {
      WH.store.init(saved, { save: false });
      views.go(fromHash || 'planner', { replaceHash: true });
    } else {
      // first run: a demo project sits behind the welcome screen (not saved until the user picks something)
      const placeholder = makeProject('demo');
      if (placeholder) WH.store.init(placeholder, { save: false });
      const l = $('app-loading');
      if (l) l.remove();
      showWelcome();
    }
    updateTitle();
    ready = true;
    WH.bus.emit('app:ready', { firstRun: !saved });
    for (const fn of readyCallbacks.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
  }

  function updateTitle() {
    const p = WH.store.project;
    // first run: the demo behind the welcome overlay is not "the user's project" yet
    document.title = p && p.name && !welcomeOpen ? `${p.name} · WiFi Heatmap Architect` : 'WiFi Heatmap Architect';
  }

  WH.shell = {
    autoBoot: true,
    boot,
    onReady(fn) { if (ready) fn(); else readyCallbacks.push(fn); },
    openHelp, startTour, showWelcome, hideWelcome, openFileMenu,
    isWelcomeOpen: () => welcomeOpen,
    get ready() { return ready; },
  };

  /** Minimal router facade (hash routing lives in WH.views). */
  WH.app = Object.assign(WH.app || {}, {
    go: (name, opts) => views.go(name, opts),
    route: () => viewFromHash() || current,
    get view() { return current; },
  });

  const start = () => { if (WH.shell.autoBoot) boot(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 0);
})();
