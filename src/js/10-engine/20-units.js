/* WiFi Heatmap Architect - engine.units: dBm / % conversion, quality words, number formatting. */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { clamp, isNum } = E.util;

  /** Quality buckets, strongest first. `min` inclusive, `max` exclusive (Infinity / -Infinity at the ends). */
  const QUALITY = Object.freeze([
    Object.freeze({ key: 'excellent', min: -50, max: Infinity }),
    Object.freeze({ key: 'veryGood', min: -60, max: -50 }),
    Object.freeze({ key: 'good', min: -67, max: -60 }),
    Object.freeze({ key: 'weak', min: -75, max: -67 }),
    Object.freeze({ key: 'veryWeak', min: -85, max: -75 }),
    Object.freeze({ key: 'unusable', min: -Infinity, max: -85 }),
  ]);

  /** Windows "Signal" percentage -> approximate dBm (dBm = pct/2 - 100). */
  function pctToDbm(pct) {
    return pct / 2 - 100;
  }

  /** dBm -> Windows style percentage 0..100 (inverse of pctToDbm, clamped). */
  function dbmToPct(dbm) {
    return clamp((dbm + 100) * 2, 0, 100);
  }

  /**
   * Quality bucket of a signal. Cut-offs: >= -50 excellent, -50..-60 veryGood, -60..-67 good, -67..-75 weak,
   * -75..-85 veryWeak, < -85 unusable.
   * @returns {{key:string,min:number,max:number}}
   */
  function qualityOf(dbm) {
    if (!isNum(dbm)) return QUALITY[QUALITY.length - 1];
    for (const q of QUALITY) if (dbm >= q.min) return q;
    return QUALITY[QUALITY.length - 1];
  }

  /** Index (0 = excellent .. 5 = unusable) of the quality bucket. */
  function qualityIndex(dbm) {
    return QUALITY.indexOf(qualityOf(dbm));
  }

  function locale(lang) {
    return E.text.lang(lang) === 'en' ? 'en-GB' : 'cs-CZ';
  }

  /**
   * Format a throughput in Mb/s: '—' for null/NaN, one decimal below 10, grouped integer otherwise
   * (Czech: non-breaking space as group separator).
   * @param {number|null} n
   * @param {'cs'|'en'} [lang]
   */
  function formatMbps(n, lang) {
    if (!isNum(n)) return '—';
    const v = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
    try {
      return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: n < 10 ? 1 : 0, minimumFractionDigits: 0 }).format(v);
    } catch (e) {
      return String(v);
    }
  }

  /** "−67 dBm" with a real minus sign and a non-breaking space. */
  function formatDbm(dbm, lang) {
    if (!isNum(dbm)) return '—';
    const r = Math.round(dbm);
    const s = Math.abs(r).toLocaleString(locale(lang));
    return `${r < 0 ? '−' : r > 0 ? '+' : ''}${s} dBm`;
  }

  /** Normalize a band given as number or string ('5', '2.4', '2,4', '5 GHz') to 2.4 | 5 | 6, else null. */
  function normBand(b) {
    if (typeof b === 'string') b = parseFloat(b.replace(',', '.'));
    return b === 2.4 || b === 5 || b === 6 ? b : null;
  }

  /**
   * A band OR the band mode 'auto' (SPEC 13): 'auto' (any case, trimmed) -> 'auto', anything else as normBand().
   * @returns {2.4|5|6|'auto'|null}
   */
  function normBandMode(b) {
    if (typeof b === 'string' && b.trim().toLowerCase() === 'auto') return 'auto';
    return normBand(b);
  }

  /** Band as object key ('2.4' | '5' | '6'). */
  function bandKey(b) {
    return String(normBand(b) ?? b);
  }

  /** Band label without unit in the given language: '2,4' / '2.4', '5', '6'. */
  function bandLabel(b, lang) {
    const v = normBand(b);
    if (v === null) return '';
    return v === 2.4 && E.text.lang(lang) === 'cs' ? '2,4' : String(v);
  }

  E.units = { QUALITY, pctToDbm, dbmToPct, qualityOf, qualityIndex, formatMbps, formatDbm, normBand, normBandMode, bandKey, bandLabel };
})();
