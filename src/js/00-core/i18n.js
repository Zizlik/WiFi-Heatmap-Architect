/* WH.i18n - Czech + English dictionaries, interpolation, plural helper, DOM application.
 *
 *   WH.i18n.add('cs', { 'planner.title': '...', 'rooms.count.one': '{n} místnost', ... })
 *   WH.i18n.t('rooms.count', { n: 3 })      -> picks rooms.count.few (cs) / rooms.count.other (en)
 *   WH.i18n.t('greeting', { name: 'Eva' })  -> replaces {name}
 *
 * Fallback order for a missing key: other language -> the key itself (a console.warn is printed once per key).
 * This file must load before every strings*.js file (it lives in 00-core, lexical order guarantees that). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};

  const SUPPORTED = ['cs', 'en'];
  const LOCALES = { cs: 'cs-CZ', en: 'en-GB' };
  const PREFS_KEY = 'wifi-heatmap-prefs';

  const dict = { cs: {}, en: {} };
  const warned = new Set();
  const listeners = new Set();

  /** Language saved by the user (read directly: this file loads before WH.store). */
  function savedLang() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (p && SUPPORTED.includes(p.lang)) return p.lang;
    } catch (e) { /* storage blocked or corrupt - ignore */ }
    return null;
  }

  /**
   * The browser's language mapped to ours: the first entry of navigator.languages (or navigator.language) that we can
   * map decides - cs or sk -> 'cs', en -> 'en'; null when none of them is Czech, Slovak or English.
   */
  function browserLang() {
    if (typeof navigator === 'undefined' || !navigator) return null;
    const list = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
    for (const raw of list) {
      const l = String(raw || '').toLowerCase();
      if (/^(cs|sk)(\b|_)/.test(l)) return 'cs';
      if (/^en(\b|_)/.test(l)) return 'en';
    }
    return null;
  }

  /**
   * Language at start (SPEC 6.2): the user's saved choice wins; otherwise a Czech or Slovak browser gets Czech (so the
   * English-default index.html on GitHub Pages opens in Czech for Czech users); otherwise the file's default
   * (index.cs.html = cs, index.html = en).
   */
  function initialLang() {
    const saved = savedLang();
    if (saved) return saved;
    if (browserLang() === 'cs') return 'cs';
    if (SUPPORTED.includes(g.WH_DEFAULT_LANG)) return g.WH_DEFAULT_LANG;
    return browserLang() || 'en';
  }

  let lang = initialLang();

  function warnOnce(key) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[i18n] missing translation for "${key}" (${lang})`);
  }

  /** Plural category for an integer n.  cs: one (1) / few (2-4) / other;  en: one (1) / other. */
  function pluralForm(l, n) {
    if (l === 'cs') {
      if (n === 1) return 'one';
      if (Number.isInteger(n) && n >= 2 && n <= 4) return 'few';
      return 'other';
    }
    return n === 1 ? 'one' : 'other';
  }

  function find(l, key, params) {
    const d = dict[l];
    if (params && typeof params.n === 'number') {
      const form = pluralForm(l, params.n);
      if (d[`${key}.${form}`] !== undefined) return d[`${key}.${form}`];
      if (d[`${key}.other`] !== undefined) return d[`${key}.other`];
    }
    return d[key];
  }

  function interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined && params[name] !== null ? String(params[name]) : m));
  }

  /** Translate `key`. */
  function t(key, params) {
    let s = find(lang, key, params);
    if (s === undefined) {
      s = find(lang === 'cs' ? 'en' : 'cs', key, params);
      warnOnce(key);
    }
    if (s === undefined) return String(key);
    return interpolate(s, params);
  }

  /** True when the key (or one of its plural forms) exists in the active or the other language. */
  function has(key) {
    const probe = (l) => dict[l][key] !== undefined || dict[l][`${key}.other`] !== undefined || dict[l][`${key}.one`] !== undefined;
    return probe(lang) || probe(lang === 'cs' ? 'en' : 'cs');
  }

  /** Merge a dictionary into a language (later calls override earlier keys). */
  function add(l, entries) {
    if (!dict[l]) throw new Error(`WH.i18n.add: unsupported language "${l}"`);
    Object.assign(dict[l], entries);
  }

  /** All keys that start with `prefix` (union of both languages, sorted). */
  function keys(prefix = '') {
    const set = new Set();
    for (const l of SUPPORTED) for (const k of Object.keys(dict[l])) if (k.startsWith(prefix)) set.add(k);
    return Array.from(set).sort();
  }

  const fmtCache = new Map();
  /** Locale-aware number formatting ("cs-CZ" decimal comma / "en-GB"). */
  function number(n, opts) {
    const locale = LOCALES[lang];
    const ck = locale + JSON.stringify(opts || {});
    let f = fmtCache.get(ck);
    if (!f) {
      try { f = new Intl.NumberFormat(locale, opts); } catch (e) { f = { format: (v) => String(v) }; }
      fmtCache.set(ck, f);
    }
    return f.format(n);
  }

  const DOM_SELECTOR = '[data-i18n],[data-i18n-html],[data-i18n-title],[data-i18n-aria],[data-i18n-ph]';

  function paramsOf(node) {
    const raw = node.getAttribute('data-i18n-params');
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  }

  /**
   * Apply translations to a DOM subtree (default: the whole document).
   *   data-i18n="key"        -> textContent        (leaf elements only: children are replaced)
   *   data-i18n-html="key"   -> innerHTML          (trusted strings only)
   *   data-i18n-title="key"  -> title attribute
   *   data-i18n-aria="key"   -> aria-label attribute
   *   data-i18n-ph="key"     -> placeholder attribute
   *   data-i18n-params='{"n":3}' -> interpolation parameters for the keys above
   */
  function applyDom(root) {
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    const nodes = Array.from(scope.querySelectorAll(DOM_SELECTOR));
    if (scope.matches && scope.matches(DOM_SELECTOR)) nodes.unshift(scope);
    for (const node of nodes) {
      const p = paramsOf(node);
      let k = node.getAttribute('data-i18n');
      if (k) node.textContent = t(k, p);
      k = node.getAttribute('data-i18n-html');
      if (k) node.innerHTML = t(k, p);
      k = node.getAttribute('data-i18n-title');
      if (k) node.setAttribute('title', t(k, p));
      k = node.getAttribute('data-i18n-aria');
      if (k) node.setAttribute('aria-label', t(k, p));
      k = node.getAttribute('data-i18n-ph');
      if (k) node.setAttribute('placeholder', t(k, p));
    }
  }

  function syncDocument() {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
    const meta = document.querySelector('meta[name="description"]');
    if (meta && has('app.description')) meta.setAttribute('content', t('app.description'));
  }

  /** Subscribe to language changes. Returns an unsubscribe function. */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Switch language: persists the choice, re-applies data-i18n attributes, notifies listeners and WH.bus ('lang:changed'). */
  function setLang(l) {
    if (!SUPPORTED.includes(l)) return false;
    const changed = l !== lang;
    lang = l;
    syncDocument();
    if (changed) {
      try {
        if (g.WH.store && typeof g.WH.store.setPref === 'function') g.WH.store.setPref('lang', l);
        else {
          const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
          p.lang = l;
          localStorage.setItem(PREFS_KEY, JSON.stringify(p));
        }
      } catch (e) { /* private mode / quota: the choice just is not remembered */ }
    }
    if (typeof document !== 'undefined') applyDom(document);
    if (changed) {
      for (const fn of Array.from(listeners)) {
        try { fn(lang); } catch (e) { console.error('[i18n] onChange listener failed:', e); }
      }
      if (g.WH.bus) g.WH.bus.emit('lang:changed', { lang });
    }
    return true;
  }

  g.WH.i18n = {
    SUPPORTED,
    get lang() { return lang; },
    get locale() { return LOCALES[lang]; },
    setLang, t, has, add, keys, onChange, applyDom, number, pluralForm, browserLang,
    /** Read-only access for tooling/tests. */
    dictionary(l) { return dict[l]; },
  };
})();
