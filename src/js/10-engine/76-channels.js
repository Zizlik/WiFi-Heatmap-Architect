/* WiFi Heatmap Architect - engine.channels: what a measured Wi-Fi channel means for a Czech / EU home (SPEC 8).
 *
 * Pure facts, no map physics: after "Measure everything" the app knows the band, channel and (sometimes) width the device
 * is on, and can say in one plain sentence when that is worth knowing:
 *   - dfs:  a 5 GHz channel in the radar-protected ranges. With radar detected (weather radar, airports) the router must
 *           leave it and the Wi-Fi drops for about a minute - the cause of "it cuts out now and then".
 *   - off:  a 2.4 GHz channel other than 1, 6, 11: it overlaps its neighbours (only these three are clear of each other).
 *   - wide: 40 MHz on 2.4 GHz uses up two of those three clear channels; in a block of flats 20 MHz is steadier.
 * Region: EU (the Czech Republic follows it). The DFS ranges are those of ETSI EN 301 893 / Decision (EU) 2022/179:
 * 5250-5350 and 5470-5725 MHz. A channel needs DFS when its 20 MHz span reaches into one of them (centre = 5000 + 5 x
 * channel MHz); a span that only touches the edge - channel 48 ends at 5250 - does not. Table and wording after the
 * region table of SignalPlan (github.com/NC4321/SignalPlan, MIT, docs/MODEL.md "Channels and regions").
 * Wi-Fi 6 GHz has no radar detection and no hint.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { isNum } = E.util;

  /** MHz ranges of 5 GHz that need DFS (radar detection) in the EU. */
  const DFS_MHZ = Object.freeze([Object.freeze([5250, 5350]), Object.freeze([5470, 5725])]);
  /** The 2.4 GHz channels (20 MHz) that do not overlap each other. */
  const CLEAR_24 = Object.freeze([1, 6, 11]);

  /** True when a 5 GHz channel needs DFS; false for every other band, an unknown channel or one off the 5 GHz grid. */
  function isDfs(band, channel) {
    if (band !== 5 || !Number.isInteger(channel) || channel < 32 || channel > 177) return false;
    const lo = 5000 + 5 * channel - 10;
    const hi = 5000 + 5 * channel + 10;
    return DFS_MHZ.some(([a, b]) => lo < b && hi > a);
  }

  /**
   * The one thing worth saying about a connection's channel, or null: {key:'dfs'|'off'|'wide', channel}.
   * @param {{band?:number|null, channel?:number|null, widthMHz?:number|null}} w a connection entry / measurement.wifi
   */
  function hint(w) {
    if (!w || typeof w !== 'object') return null;
    const band = isNum(w.band) ? w.band : null;
    const ch = Number.isInteger(w.channel) ? w.channel : null;
    if (band === 5 && ch !== null && isDfs(5, ch)) return { key: 'dfs', channel: ch };
    if (band === 2.4 && ch !== null && ch >= 1 && ch <= 14) {
      if (isNum(w.widthMHz) && w.widthMHz >= 40) return { key: 'wide', channel: ch };
      if (!CLEAR_24.includes(ch)) return { key: 'off', channel: ch };
    }
    return null;
  }

  E.channels = Object.freeze({ isDfs, hint, DFS_MHZ, CLEAR_24 });
})();
