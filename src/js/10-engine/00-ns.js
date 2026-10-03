/* WiFi Heatmap Architect - engine: namespace bootstrap + tiny shared helpers.
 *
 * The engine is DOM-free and runs both in the browser (concatenated into the app bundle) and in Node (tests load
 * every file of this directory in lexical order into one shared global). Every engine file is an IIFE that talks to
 * the shared namespace through `globalThis.WH.engine`.
 *
 * Coordinates: all public points are NORMALIZED {x,y} in [0,1] over a fixed canvas of W=1080 x H=942 px.
 * Internally the physics runs in canvas pixels; `mpp` (metres per pixel) converts to metres.
 */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const E = (g.WH.engine = g.WH.engine || {});

  /** Fixed canvas size in px (all normalized coordinates refer to it). */
  E.CANVAS = Object.freeze({ W: 1080, H: 942 });
  /** Supported Wi-Fi bands in GHz. */
  E.BANDS = Object.freeze([2.4, 5, 6]);

  // ---------------------------------------------------------------------------------------------------------------
  // util
  // ---------------------------------------------------------------------------------------------------------------
  const util = (E.util = E.util || {});

  /** True for finite numbers only (no numeric strings, no NaN/Infinity). */
  util.isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  /** True for non-null, non-array objects. */
  util.isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** Clamp v into [lo, hi]. */
  util.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  /** Round to `d` decimals (default 6). */
  util.round = (v, d = 6) => {
    const k = Math.pow(10, d);
    return Math.round(v * k) / k;
  };
  /** Number clamped into [lo,hi] and rounded to 6 decimals; falls back to `def` when v is not a finite number. */
  util.num = (v, lo, hi, def) => (util.isNum(v) ? util.round(util.clamp(v, lo, hi), 6) : def);
  /** Like num(), or null when v is null/undefined/not a finite number. */
  util.numOrNull = (v, lo, hi) => (util.isNum(v) ? util.round(util.clamp(v, lo, hi), 6) : null);

  /** Median of a numeric array (does not modify the input). Empty -> 0. */
  util.median = (arr) => {
    const n = arr.length;
    if (!n) return 0;
    const s = Float64Array.from(arr).sort();
    const m = n >> 1;
    return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /**
   * Strip control characters, trim and truncate to `max` Unicode code points (never splits a surrogate pair).
   * Non-strings and numbers are coerced; null/undefined -> ''.
   */
  util.cleanText = (v, max = 50) => {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    // C0/C1 controls, DEL and noncharacters FFFE/FFFF are not allowed in XML 1.0 text; lone surrogates neither
    // (no regex look-behind here: Safari < 16.4 would fail to parse the whole bundle).
    const s = String(v)
      .replace(/[\u0000-\u001f\u007f-\u009f￾￿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    let out = '';
    let n = 0;
    for (const ch of s) {
      // for..of yields a lone surrogate as a 1-unit string in the surrogate range
      if (ch.length === 1 && ch >= '\ud800' && ch <= '\udfff') continue;
      if (n++ >= max) break;
      out += ch;
    }
    return out.trim();
  };

  /** Create an Error whose message is an i18n key (e.g. 'err.plan.invalid'); `.code` mirrors it. */
  util.fail = (key, params) => {
    const e = new Error(key);
    e.code = key;
    e.i18n = true;
    if (params) e.params = params;
    return e;
  };

  /**
   * Yield to the event loop cheaply. Returns {yield(): Promise<void>, close()}.
   * Order of preference: setImmediate (Node only: a MessageChannel there can starve timers and I/O for up to 1000
   * messages), MessageChannel (browsers: every message is its own task, no 4 ms timer clamp, input and rendering run
   * in between), setTimeout 0. scheduler.yield() is deliberately not used: its continuations jump ahead of timers.
   */
  util.makeYielder = () => {
    if (typeof setImmediate === 'function') {
      return { yield: () => new Promise((resolve) => setImmediate(resolve)), close() {} };
    }
    if (typeof MessageChannel === 'function') {
      try {
        const ch = new MessageChannel();
        let pending = null;
        ch.port1.onmessage = () => {
          const r = pending;
          pending = null;
          if (r) r();
        };
        return {
          yield: () =>
            new Promise((resolve) => {
              pending = resolve;
              ch.port2.postMessage(0);
            }),
          // Closing is essential in Node, otherwise the open port keeps the process alive.
          close: () => {
            try {
              ch.port1.close();
              ch.port2.close();
            } catch (e) {
              /* ignore */
            }
          },
        };
      } catch (e) {
        /* fall through to setTimeout */
      }
    }
    return { yield: () => new Promise((resolve) => setTimeout(resolve, 0)), close() {} };
  };

  /** Monotonic-ish clock in ms. */
  util.now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // ---------------------------------------------------------------------------------------------------------------
  // text: the engine's own tiny dictionary. It is needed because engine functions create user-visible *data*
  // (room names of the demo flat, default object names, SVG title) in a language chosen by the caller, independent of
  // the current UI language. Error messages are i18n KEYS and are translated by the UI through WH.i18n.t(err.message).
  // ---------------------------------------------------------------------------------------------------------------
  const dict = { cs: {}, en: {} };
  const text = (E.text = E.text || {});
  text.dict = dict;
  /** Register strings: text.add('cs', {'engine.x': '...'}). Also forwarded to WH.i18n when it exists. */
  text.add = (lang, d) => {
    if (!dict[lang]) return;
    Object.assign(dict[lang], d);
  };
  /** Resolve the language: explicit 'cs'|'en', else the UI language when known, else Czech. */
  text.lang = (lang) => {
    if (lang === 'cs' || lang === 'en') return lang;
    const ui = g.WH && g.WH.i18n && g.WH.i18n.lang;
    return ui === 'en' ? 'en' : 'cs';
  };
  /** Translate key into `lang` with {name} interpolation; falls back to the other language, then to the key. */
  text.t = (key, lang, params) => {
    const l = text.lang(lang);
    let s = dict[l][key];
    if (s === undefined) s = dict[l === 'cs' ? 'en' : 'cs'][key];
    if (s === undefined) s = key;
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m)) : s;
  };
})();
