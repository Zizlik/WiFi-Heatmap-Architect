/* App glue (integrator): the shell boots itself on DOMContentLoaded (WH.shell.boot); this file only adds what no
 * single module owns.
 *   - WH.app.version
 *   - a last-resort safety net: an unexpected error (a bug) shows ONE friendly toast instead of leaving a non-technical
 *     user with a silently broken screen. The error still reaches the console unchanged (nothing is swallowed) and
 *     aborted work (AbortError, e.g. a cancelled "find the best spot") is ignored.
 *   - re-places the toast stack once the first view is on screen (the welcome overlay may just have closed). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  WH.app = Object.assign(WH.app || {}, { version: '3.0.0' });
  if (typeof window === 'undefined') return;

  let lastToast = 0;
  function friendly(err) {
    if (err && (err.name === 'AbortError' || err === 'cancelled')) return;
    const now = Date.now();
    if (now - lastToast < 15000 || !WH.ui || typeof WH.ui.toast !== 'function' || !WH.shell || !WH.shell.ready) return;
    lastToast = now;
    try { WH.ui.toast({ i18n: 'app.err.unexpected' }, { kind: 'error', ms: 9000 }); } catch (e) { /* never recurse */ }
  }
  window.addEventListener('error', (e) => {
    // resource loading errors (no JS error object) are not ours to report here
    if (!e || (!e.error && !e.message)) return;
    friendly(e.error);
  });
  window.addEventListener('unhandledrejection', (e) => friendly(e && e.reason));

  if (WH.shell && typeof WH.shell.onReady === 'function') {
    WH.shell.onReady(() => { if (WH.ui && WH.ui.placeToasts) WH.ui.placeToasts(); });
  }
})();
