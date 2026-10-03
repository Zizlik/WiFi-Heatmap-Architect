/* WH.util - small dependency-free helpers shared by every module.
 * Nothing here touches other WH modules at load time (files are concatenated in lexical order). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};

  const NBSP = ' ';
  const MINUS = '−';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const hasDom = typeof document !== 'undefined';

  /** document.getElementById shortcut. */
  const $ = (id) => (hasDom ? document.getElementById(id) : null);

  /** querySelectorAll -> real array. */
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Apply an attribute map to an element (shared by el() and svgEl()). */
  function applyAttrs(node, attrs) {
    if (!attrs) return node;
    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (val === undefined || val === null || val === false) continue;
      if (key === 'class' || key === 'className') {
        node.setAttribute('class', Array.isArray(val) ? val.filter(Boolean).join(' ') : String(val));
      } else if (key === 'style') {
        if (typeof val === 'string') node.setAttribute('style', val);
        else for (const p of Object.keys(val)) {
          if (p.startsWith('--')) node.style.setProperty(p, String(val[p]));
          else node.style[p] = val[p];
        }
      } else if (key === 'dataset') {
        for (const d of Object.keys(val)) if (val[d] !== undefined && val[d] !== null) node.dataset[d] = String(val[d]);
      } else if (key === 'html') {
        node.innerHTML = String(val); // trusted markup only
      } else if (key === 'text') {
        node.textContent = String(val);
      } else if (key.length > 2 && key.startsWith('on') && typeof val === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(val));
      }
    }
    return node;
  }

  /** Append children (strings -> text nodes, arrays flattened, null/false skipped). */
  function appendKids(node, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) appendKids(node, k);
      else if (typeof k === 'object' && 'nodeType' in k) node.appendChild(k);
      else node.appendChild(document.createTextNode(String(k)));
    }
    return node;
  }

  /**
   * Create an HTML element.  el('div.card.p-3#id', {onClick: fn, dataset:{a:1}, 'aria-label':'x'}, child, 'text', [more])
   * attrs: class/className, style (string|object, custom properties ok), dataset, html (trusted), text, on<event> handlers,
   * true -> empty attribute, false/null/undefined -> skipped.
   */
  function el(tag, attrs, ...kids) {
    let name = String(tag);
    let id = '';
    const classes = [];
    const m = /^([a-zA-Z][\w-]*)((?:[.#][\w-]+)*)$/.exec(name);
    if (m) {
      name = m[1];
      for (const part of m[2].match(/[.#][\w-]+/g) || []) {
        if (part[0] === '.') classes.push(part.slice(1));
        else id = part.slice(1);
      }
    }
    const node = document.createElement(name);
    if (id) node.id = id;
    if (classes.length) node.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || 'nodeType' in attrs || Array.isArray(attrs))) {
      kids.unshift(attrs); // el('div', 'text') convenience
      attrs = null;
    }
    if (attrs) {
      const extra = attrs.class || attrs.className;
      if (classes.length && extra) attrs = Object.assign({}, attrs, { class: classes.concat(extra), className: undefined });
      applyAttrs(node, attrs);
    }
    return appendKids(node, kids);
  }

  /** Create an SVG element in the SVG namespace (same attr rules as el(); numbers are stringified). */
  function svgEl(tag, attrs, ...kids) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs && (typeof attrs !== 'object' || 'nodeType' in attrs || Array.isArray(attrs))) {
      kids.unshift(attrs);
      attrs = null;
    }
    applyAttrs(node, attrs);
    return appendKids(node, kids);
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /** Trailing debounce. The returned function has .cancel() and .flush(). */
  function debounce(fn, ms) {
    let timer = 0;
    let lastArgs = null;
    let lastThis = null;
    function run() {
      timer = 0;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn.apply(lastThis, a);
    }
    function debounced(...a) {
      lastArgs = a;
      lastThis = this;
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    }
    debounced.cancel = () => { clearTimeout(timer); timer = 0; lastArgs = null; };
    debounced.flush = () => { if (timer) { clearTimeout(timer); run(); } };
    return debounced;
  }

  /** Coalesce calls into at most one per animation frame (last arguments win). Has .cancel(). */
  function throttleRaf(fn) {
    let raf = 0;
    let lastArgs = null;
    let lastThis = null;
    const raq = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    function throttled(...a) {
      lastArgs = a;
      lastThis = this;
      if (raf) return;
      raf = raq(() => {
        raf = 0;
        const args = lastArgs;
        lastArgs = null;
        if (args) fn.apply(lastThis, args);
      });
    }
    throttled.cancel = () => { if (raf) caf(raf); raf = 0; lastArgs = null; };
    return throttled;
  }

  let uidCounter = 0;
  /** Short unique id such as "m-k3j2x9-1" (unique per page load, practically unique across loads). */
  function uid(prefix = 'id') {
    uidCounter += 1;
    return `${prefix}-${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296).toString(36)}-${uidCounter}`;
  }

  /** Deep copy of JSON-like data. */
  function clone(obj) {
    if (obj === undefined || obj === null || typeof obj !== 'object') return obj;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(obj); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(obj));
  }

  function lang() {
    const i = g.WH && g.WH.i18n;
    return i && i.lang ? i.lang : 'en';
  }

  /** Locale-aware number; uses a real minus sign (U+2212) for negatives so dBm values look right. */
  function fmt(n, digits = 0) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const i = g.WH && g.WH.i18n;
    let s;
    if (i && i.number) s = i.number(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    else s = n.toFixed(digits);
    return s.replace(/^-/, MINUS);
  }

  /** "54 %" in Czech (non-breaking space), "54%" in English. */
  function fmtPct(n, digits = 0) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return fmt(n, digits) + (lang() === 'cs' ? NBSP : '') + '%';
  }

  /** "-67 dBm" with a real minus sign and a non-breaking space. */
  function dbm(n, digits = 0) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return fmt(n, digits) + NBSP + 'dBm';
  }

  /** True when a key press/event originates from something the user types into (or that uses the arrow keys itself). */
  function isTyping(e) {
    const t = (e && e.target) || (hasDom ? document.activeElement : null);
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    if (tag === 'INPUT') {
      const type = (t.getAttribute('type') || 'text').toLowerCase();
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'color'].includes(type);
    }
    return false;
  }

  /** Save text or a Blob as a file download. */
  function download(data, filename, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }

  /** Read a File/Blob as text (UTF-8). */
  function readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsText(file);
    });
  }

  /** addEventListener that returns its own remover. */
  function on(target, ev, fn, opts) {
    target.addEventListener(ev, fn, opts);
    return () => target.removeEventListener(ev, fn, opts);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Lower-case ascii file-name stem from a free-form name ("Můj byt 2" -> "muj-byt-2"). */
  function slug(s, fallback = 'wifi-plan') {
    const out = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return out || fallback;
  }

  /** Run once; later calls return the first result. */
  function once(fn) {
    let done = false;
    let val;
    return function (...a) { if (!done) { done = true; val = fn.apply(this, a); } return val; };
  }

  /** Compare two JSON-like values structurally. */
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }

  /** Whether the user asked for reduced motion. */
  function prefersReducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** macOS / iOS (affects how Ctrl is displayed: command symbol). */
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

  g.WH.util = {
    NBSP, MINUS, SVG_NS, isMac,
    $, $$, el, svgEl, clamp, lerp, debounce, throttleRaf, uid, clone, fmt, fmtPct, dbm, isTyping, download, readFileText, on,
    escapeHtml, slug, once, deepEqual, prefersReducedMotion,
  };
})();
