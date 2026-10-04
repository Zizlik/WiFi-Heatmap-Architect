/* WH.bus - tiny synchronous publish/subscribe used for loose coupling between modules.
 * A throwing listener never breaks the others (the error is logged once per emit). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};

  const topics = new Map(); // topic -> Set<fn>

  /** Subscribe. Returns an unsubscribe function. */
  function on(topic, fn) {
    if (typeof fn !== 'function') throw new TypeError('WH.bus.on: listener must be a function');
    let set = topics.get(topic);
    if (!set) { set = new Set(); topics.set(topic, set); }
    set.add(fn);
    return () => off(topic, fn);
  }

  /** Subscribe for exactly one emit. */
  function once(topic, fn) {
    const un = on(topic, (p) => { un(); fn(p); });
    return un;
  }

  /** Unsubscribe a listener (or all listeners of the topic when fn is omitted). */
  function off(topic, fn) {
    const set = topics.get(topic);
    if (!set) return;
    if (fn) set.delete(fn); else set.clear();
    if (!set.size) topics.delete(topic);
  }

  /** Call every listener of `topic` synchronously with `payload`. Returns the number of listeners called. */
  function emit(topic, payload) {
    const set = topics.get(topic);
    if (!set || !set.size) return 0;
    let n = 0;
    for (const fn of Array.from(set)) {
      if (!set.has(fn)) continue; // removed by an earlier listener
      n += 1;
      try { fn(payload, topic); } catch (e) {
        console.error(`[WH.bus] listener for "${topic}" failed:`, e);
        if (g.WH.diag) g.WH.diag.caught(e, `bus:${topic}`);   // the error diary (Help -> Report a problem)
      }
    }
    return n;
  }

  g.WH.bus = { on, once, off, emit };
})();
