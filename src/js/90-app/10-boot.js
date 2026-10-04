/* App glue (integrator): the shell boots itself on DOMContentLoaded (WH.shell.boot); this file only adds what no
 * single module owns.
 *   - WH.app.version / WH.app.build (short hash of the bundle, injected by build.mjs)
 *   - a last-resort safety net: an unexpected error (a bug) shows ONE friendly toast with "Podrobnosti" instead of
 *     leaving a non-technical user with a silently broken screen. The error still reaches the console unchanged
 *     (nothing is swallowed), it is kept in the error diary (WH.diag, last 20, memory only) for Help -> "Nahlásit
 *     problém", and aborted work (AbortError, e.g. a cancelled "find the best spot") is ignored.
 *   - WH.app.reportError(err, context, opts) for HANDLED but noteworthy errors (SPEC 10): a module that already shows
 *     its own specific message calls it so the error lands in the diary (and in a bug report) without the generic toast:
 *       WH.app.reportError(e, 'measure.speedtest')                                  // diary only (+ console.debug)
 *       WH.app.reportError(e, 'measure.helper', { toast: { i18n: 'x.y' } })          // + a specific error toast with "Podrobnosti"
 *       opts: { toast: text | {i18n, params} , kind: 'error'|'warn' (toast kind), ms, where, log: 'debug'|'info'|'warn'|'error'|false }
 *     -> the diary record ({id, …}) or null.  WH.app.showErrorDetails(id?) opens the "Podrobnosti" dialog.
 *   - WH.app.diagnostics() -> the text Help -> "Nahlásit problém" copies; WH.app.copyDiagnostics() -> Promise<bool>.
 *   - re-places the toast stack once the first view is on screen (the welcome overlay may just have closed). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  WH.app = Object.assign(WH.app || {}, { version: '3.0.0', build: (WH.diag && WH.diag.build && WH.diag.build.v) || 'dev' });
  if (typeof window === 'undefined') return;

  const isAbort = (err) => !!err && (err.name === 'AbortError' || err === 'cancelled');
  /** Browser noise that is not a bug of ours (Chrome reports it as an error event without an error object). */
  const isNoise = (msg) => /^ResizeObserver loop/i.test(String(msg || ''));
  /** An error of a script from another origin (a browser extension, an injected tool): the browser hides everything
   *  but "Script error.", and all of the app's own code is inline, so it is never ours - kept in the diary, no toast. */
  const isForeign = (e) => !e.error && /^Script error\.?$/i.test(String(e.message || '').trim());

  const showDetails = (id) => { if (WH.ui && WH.ui.diag) WH.ui.diag.showDetails(id); };
  const detailsAction = (rec) => (rec && WH.ui && WH.ui.diag ? { i18n: 'app.err.details', fn: () => showDetails(rec.id) } : undefined);

  // ---------------------------------------------------------------------------------------------------------------
  // the friendly toast for bugs (uncaught errors, unhandled rejections, errors caught by bus/store/keys listeners)
  // ---------------------------------------------------------------------------------------------------------------
  let lastToast = 0;
  function friendly(rec) {
    const now = Date.now();
    if (now - lastToast < 15000 || !WH.ui || typeof WH.ui.toast !== 'function' || !WH.shell || !WH.shell.ready) return;
    lastToast = now;
    try { WH.ui.toast({ i18n: 'app.err.unexpected', action: detailsAction(rec) }, { kind: 'error', ms: 12000 }); } catch (e) { /* never recurse */ }
  }
  if (WH.diag) WH.diag.subscribe((rec) => { if (rec.kind !== 'reported') friendly(rec); });

  window.addEventListener('error', (e) => {
    // resource loading errors (no JS error object) are not ours to report here
    if (!e || (!e.error && !e.message)) return;
    if (isAbort(e.error) || isNoise(e.message)) return;
    if (isForeign(e)) { if (WH.diag) WH.diag.record(e.message, { kind: 'error', context: 'foreign-script', notify: false }); return; }
    const where = e.filename || e.lineno ? { filename: e.filename, lineno: e.lineno, colno: e.colno } : '';
    if (WH.diag) WH.diag.record(e.error || e.message, { kind: 'error', where });
    else friendly(null);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    if (isAbort(reason)) return;
    if (WH.diag) WH.diag.record(reason, { kind: 'rejection' });
    else friendly(null);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------------------------------------------
  /** A handled error worth keeping (see the header). Never throws. */
  function reportError(err, context, opts) {
    opts = opts || {};
    let rec = null;
    try {
      if (isAbort(err)) return null;
      rec = WH.diag ? WH.diag.record(err, { kind: 'reported', context, where: opts.where, notify: false }) : null;
      const log = opts.log === undefined ? 'debug' : opts.log;
      if (log && typeof console[log] === 'function') console[log](`[WH] handled error${context ? ` (${context})` : ''}:`, err);
      if (opts.toast && WH.ui && typeof WH.ui.toast === 'function') {
        const msg = typeof opts.toast === 'object' ? Object.assign({}, opts.toast) : { text: String(opts.toast) };
        if (!msg.action) msg.action = detailsAction(rec);
        WH.ui.toast(msg, { kind: opts.kind || 'error', ms: opts.ms });
      }
    } catch (e) { /* the report must never become the problem */ }
    return rec;
  }

  Object.assign(WH.app, {
    reportError,
    showErrorDetails: showDetails,
    errors: () => (WH.diag ? WH.diag.list() : []),
    diagnostics: (opts) => (WH.ui && WH.ui.diag ? WH.ui.diag.summary(opts) : ''),
    copyDiagnostics: (opts) => (WH.ui && WH.ui.diag ? WH.ui.diag.copy(opts) : Promise.resolve(false)),
  });

  if (WH.shell && typeof WH.shell.onReady === 'function') {
    WH.shell.onReady(() => { if (WH.ui && WH.ui.placeToasts) WH.ui.placeToasts(); });
  }
})();
