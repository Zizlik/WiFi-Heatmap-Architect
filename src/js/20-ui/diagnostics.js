/* WH.ui.diag - the visible side of the error diary (SPEC 10, diagnostics; data: WH.diag in 00-core/diag.js).
 *
 *   WH.ui.diag.showDetails(id?)   "Podrobnosti" dialog of one recorded error (default: the newest): when, where, what the
 *                                 app was doing, the message, the cleaned stack - plus "Zkopírovat podrobnosti"
 *   WH.ui.diag.helpBlock()        Help -> "Nahlásit problém": what the report contains / leaves out, copy, preview
 *   WH.ui.diag.summary({first})   the plain-text diagnostic summary (app version, build, browser/OS, page kind, view,
 *                                 theme, window, last errors with stacks). NO plan data, measurements, SSIDs, BSSIDs,
 *                                 MACs, file paths or page paths (the recorded texts are scrubbed by WH.diag as well)
 *   WH.ui.diag.copy({first})      -> Promise<boolean>  copies the summary
 *   WH.ui.diag.browser()          -> {browser, os, device, ua}      WH.ui.diag.pageKind() -> 'file://' | scheme + '//' + host
 * Where reports go (GitHub issues) is a plain-text help link in strings-shell.js (diag.report.where). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ui = (WH.ui = WH.ui || {});
  const t = (k, p) => WH.i18n.t(k, p);

  // -------------------------------------------------------------------------------------------------------------------
  // environment (no personal data: the UA string, the page KIND and origin host only - never a path)
  // -------------------------------------------------------------------------------------------------------------------
  function browser() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const ua = String(nav.userAgent || '');
    const uad = nav.userAgentData;
    let name = '';
    let os = '';
    let m;
    if ((m = /Edg(?:A|iOS)?\/(\d+)/.exec(ua))) name = `Edge ${m[1]}`;
    else if ((m = /OPR\/(\d+)/.exec(ua))) name = `Opera ${m[1]}`;
    else if ((m = /SamsungBrowser\/(\d+)/.exec(ua))) name = `Samsung Internet ${m[1]}`;
    else if ((m = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua))) name = `Firefox ${m[1]}`;
    else if ((m = /(?:Chrome|CriOS)\/(\d+)/.exec(ua))) name = `Chrome ${m[1]}`;
    else if ((m = /Version\/(\d+(?:\.\d+)?).*Safari/.exec(ua))) name = `Safari ${m[1]}`;
    if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) os = m[1] === '10.0' ? 'Windows 10/11' : `Windows NT ${m[1]}`;
    else if ((m = /Android (\d+(?:\.\d+)?)/.exec(ua))) os = `Android ${m[1]}`;
    else if ((m = /(?:iPhone|CPU) OS (\d+)[._](\d+)/.exec(ua))) os = `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${m[1]}.${m[2]}`;
    else if (/Mac OS X/.test(ua)) os = /Mobile/.test(ua) ? 'iPadOS' : 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    if (uad && typeof uad.platform === 'string' && uad.platform && !os) os = uad.platform;
    const mobile = uad && typeof uad.mobile === 'boolean' ? uad.mobile : /Mobi|Android|iPhone|iPad/.test(ua);
    return { browser: name || '?', os: os || '?', device: mobile ? 'mobile' : 'desktop', ua: ua.slice(0, 300) };
  }

  /** "file://" for a page opened from disk (its path would name the user's folders), else scheme + host (+ port). */
  function pageKind() {
    if (typeof location === 'undefined') return '?';
    if (location.protocol === 'file:') return 'file://';
    const host = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(location.hostname) && location.hostname !== '127.0.0.1' ? '[ip]' : location.hostname;
    return `${location.protocol}//${host}${location.port ? `:${location.port}` : ''}`;
  }

  function storageOk() {
    try { const k = '__wh_diag__'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
  }

  const yesNo = (b) => t(b ? 'diag.yes' : 'diag.no');
  const timeOf = (ms) => { try { return new Date(ms).toLocaleTimeString(WH.i18n.locale || undefined, { hour12: false }); } catch (e) { return new Date(ms).toISOString().slice(11, 19); } };

  /** The text that "Kopírovat" puts on the clipboard. opts.first = id of the error to list first. */
  function summary(opts) {
    opts = opts || {};
    const b = browser();
    const app = WH.app || {};
    const th = ui.theme;
    const view = WH.views && WH.views.current ? WH.views.current : '-';
    const L = [];
    L.push(t('diag.sum.title'));
    L.push(`${t('diag.sum.version')}: ${app.version || '?'} (build ${(WH.diag && WH.diag.build.v) || 'dev'})`);
    L.push(`${t('diag.sum.time')}: ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`);
    L.push(`${t('diag.sum.browser')}: ${b.browser} · ${b.os} · ${t(`diag.device.${b.device}`)}`);
    L.push(`User agent: ${b.ua}`);
    L.push(`${t('diag.sum.page')}: ${pageKind()}${WH.pwa && WH.pwa.registration ? ` · ${t('diag.sum.sw')}` : ''}`);
    L.push(`${t('diag.sum.view')}: ${view} · ${t('diag.sum.lang')} ${WH.i18n.lang} · ${t('diag.sum.theme')} ${th ? `${th.get()} -> ${th.resolved()}` : '?'}`);
    const w = typeof window !== 'undefined' ? window : {};
    L.push(`${t('diag.sum.window')}: ${w.innerWidth || '?'} × ${w.innerHeight || '?'} · DPR ${w.devicePixelRatio || 1} · ${t('diag.sum.touch')} ${yesNo(typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)} · online ${yesNo(typeof navigator === 'undefined' || navigator.onLine !== false)} · ${t('diag.sum.storage')} ${yesNo(storageOk())}`);
    const list = WH.diag ? WH.diag.list() : [];
    if (opts.first) {
      const i = list.findIndex((r) => r.id === opts.first);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    }
    L.push('');
    if (!list.length) L.push(t('diag.sum.noErrors'));
    else {
      L.push(t('diag.sum.errors', { n: list.length }));
      list.forEach((r, i) => {
        L.push(`${i + 1}) ${timeOf(r.t)} · ${t(`diag.kind.${r.kind}`)}${r.count > 1 ? ` · ×${r.count}` : ''}`);
        if (r.where) L.push(`   ${t('diag.where')}: ${r.where}`);
        if (r.context) L.push(`   ${t('diag.context')}: ${r.context}`);
        L.push(`   ${r.name && r.name !== 'string' ? `${r.name}: ` : ''}${r.message}`);
        for (const s of (r.stack || '').split('\n')) {
          const x = s.trim();
          if (x.startsWith('at ')) L.push(`     ${x}`);
          else if (x && !x.includes(r.message)) L.push(`   ${x}`);   // the head line of a V8 stack repeats the message
        }
      });
    }
    L.push('');
    L.push(t('diag.sum.privacy'));
    return L.join('\n');
  }

  async function copy(opts) {
    return WH.util.copyText(summary(opts));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // "Podrobnosti" dialog
  // -------------------------------------------------------------------------------------------------------------------
  function statusLine() {
    return WH.util.el('p.diag-status', { role: 'status', 'aria-live': 'polite' });
  }
  /** Copy + say how it went in `status`; on failure show `fallback` (a <pre>) selected so Ctrl+C works. */
  async function copyInto(status, opts, fallback) {
    const ok = await copy(opts);
    status.textContent = t(ok ? 'diag.copied' : 'diag.copyFailed');
    status.classList.toggle('is-bad', !ok);
    if (!ok && fallback) {
      fallback.hidden = false;
      fallback.textContent = summary(opts);
      try {
        const r = document.createRange();
        r.selectNodeContents(fallback);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        fallback.focus({ preventScroll: false });
      } catch (e) { /* the text is there to select by hand */ }
    }
    return ok;
  }

  function showDetails(id) {
    const U = WH.util;
    const rec = (WH.diag && (id ? WH.diag.get(id) : WH.diag.last())) || null;
    const rows = [];
    const kv = U.el('dl.kv.diag-kv');
    const row = (k, v, cls) => { if (v) kv.append(U.el('div', U.el('dt', { 'data-i18n': k }), U.el(`dd${cls || ''}`, v))); };
    if (rec) {
      row('diag.when', `${timeOf(rec.t)}${rec.count > 1 ? ` (×${rec.count})` : ''}`);
      row('diag.where', rec.where || t('diag.unknown'), '.diag-mono');
      row('diag.context', rec.context, '.diag-mono');
      row('diag.message', `${rec.name && rec.name !== 'string' ? `${rec.name}: ` : ''}${rec.message}`, '.diag-msg');
    }
    rows.push(U.el('p', { 'data-i18n': rec ? 'diag.details.lead' : 'diag.details.none' }));
    if (rec) rows.push(kv);
    if (rec && rec.stack) {
      const d = U.el('details.disclosure.diag-stack');
      d.append(U.el('summary', U.el('span', { 'data-i18n': 'diag.details.stack' })), U.el('div.disclosure__body', U.el('pre.diag-pre', { tabindex: '0' }, rec.stack)));
      rows.push(d);
    }
    const n = WH.diag ? WH.diag.count() : 0;
    if (n > 1) rows.push(U.el('p.text-sm.text-muted', t('diag.details.more', { n })));
    const pre = U.el('pre.diag-pre.diag-pre--full', { tabindex: '0', hidden: true });
    const status = statusLine();
    rows.push(status, pre);
    const h = ui.dialog({
      title: { i18n: 'diag.details.t' },
      content: rows,
      className: 'diag-dialog',
      actions: [
        { i18n: 'diag.report.open', variant: 'ghost', icon: 'flag', onClick: (close) => { close(); setTimeout(() => { if (WH.shell && WH.shell.openHelp) WH.shell.openHelp({ section: 'report' }); }, 60); return false; } },
        { i18n: 'diag.copyDetails', icon: 'copy', primary: true, autofocus: true, onClick: () => { copyInto(status, { first: rec && rec.id }, pre); return false; } },
      ],
    });
    return h;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Help -> "Nahlásit problém"
  // -------------------------------------------------------------------------------------------------------------------
  function helpBlock() {
    const U = WH.util;
    const list = U.el('ul.help-list');
    for (const k of ['diag.report.has', 'diag.report.hasNot']) list.append(U.el('li', { 'data-i18n': k }));
    const count = U.el('p.text-sm.text-muted.diag-count');
    const paintCount = () => { count.textContent = t('diag.report.count', { n: WH.diag ? WH.diag.count() : 0 }); };
    paintCount();
    const pre = U.el('pre.diag-pre.diag-pre--full', { tabindex: '0', hidden: true });
    const status = statusLine();
    const copyBtn = ui.button({ i18n: 'diag.report.copy', icon: 'copy', variant: 'primary', size: 'sm' });
    copyBtn.classList.add('diag-report__copy');
    copyBtn.addEventListener('click', () => { paintCount(); copyInto(status, {}, pre); });
    const showBtn = ui.button({ i18n: 'diag.report.show', icon: 'eye', variant: 'secondary', size: 'sm' });
    showBtn.classList.add('diag-report__show');
    showBtn.setAttribute('aria-expanded', 'false');
    showBtn.addEventListener('click', () => {
      const open = pre.hidden;
      pre.hidden = !open;
      if (open) pre.textContent = summary();
      showBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      paintCount();
    });
    const block = U.el('div.stack.diag-report', { style: { '--gap': '10px' } },
      U.el('p.text-sm', { 'data-i18n': 'diag.report.lead' }),
      list,
      count,
      U.el('div.cluster', copyBtn, showBtn),
      status,
      pre,
      U.el('p.text-sm.text-muted', { 'data-i18n-html': 'diag.report.where' }));
    return block;
  }

  ui.diag = { showDetails, helpBlock, summary, copy, browser, pageKind };
})();
