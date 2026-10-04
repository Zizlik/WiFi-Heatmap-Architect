/* Planner: "Info o zařízení" - device & connection info (SPEC 8, 8.2 app side).
 *
 *   WH.devinfo.detect() -> Promise<{os, osKey, osVersion, model, browser, mobile, connType, effectiveType, downlink, rtt,
 *                                   online, presetDevice, arch, screen, label}>
 *       OS / device / browser from User-Agent Client Hints (getHighEntropyValues) with a UA-string fallback, the connection
 *       from navigator.connection (type only in Chrome on Android). Nothing is sent anywhere and nothing is stored.
 *   WH.planner.devInfoCard({onUse(wifi), onBack?, context}) -> element (.destroy())   the card (form inline or drawer)
 *   WH.planner.openDevInfo()        the card in a side drawer (Measurements card, help)
 *   WH.planner.devInfoButton()      a ready "Info o zařízení" button for other cards
 *   WH.planner.cmdTips({os, all})   the per-OS command guide with Copy buttons (card + Help -> "Jak změřit signál")
 *   #wifi=<base64url JSON> in the URL (the helper's one-shot mode): read on load / hashchange with WH.devinfo.fromHash,
 *       kept for the next measurement (WH.planner.wifiPending), the hash is removed (history.replaceState).
 *
 * Hard limits said plainly in the UI: no browser can read SSID / BSSID / signal / channel / link rate, and a web page
 * cannot start a program - the helper is started by the user (double-click); the app only talks to it on 127.0.0.1. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const DI = (WH.devinfo = WH.devinfo || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;

  // ---------------------------------------------------------------------------------------------------------------
  // detection
  // ---------------------------------------------------------------------------------------------------------------
  const OS_NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', ipados: 'iPadOS', chromeos: 'ChromeOS' };
  const BRANDS = [['Microsoft Edge', 'Edge'], ['Opera', 'Opera'], ['Brave', 'Brave'], ['Vivaldi', 'Vivaldi'], ['Samsung Internet', 'Samsung Internet'], ['YaBrowser', 'Yandex'], ['Google Chrome', 'Chrome'], ['Chromium', 'Chromium']];

  /** What the UA string says (sync; also the fallback when Client Hints are missing). */
  function parseUa(ua, touch) {
    const r = { osKey: 'other', osVersion: '', model: '', browser: '', mobile: false, arch: '', kind: '' };
    let m;
    if ((m = /Windows NT ([\d.]+)/.exec(ua))) { r.osKey = 'windows'; r.osVersion = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]] || ''; }
    else if (/CrOS/.test(ua)) r.osKey = 'chromeos';
    else if ((m = /Android\s*([\d.]+)?/.exec(ua))) {
      r.osKey = 'android';
      r.osVersion = (m[1] || '').replace(/\.0$/, '');
      r.mobile = /Mobile/.test(ua);
      const mm = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\)/.exec(ua);
      const mod = mm ? mm[1].trim() : '';
      if (mod && !/^(K|wv|Linux|U|[a-z]{2}[-_][a-z]{2})$/i.test(mod)) r.model = mod;
    } else if ((m = /(iPhone|iPad|iPod)[^)]*?OS ([\d_]+)/.exec(ua))) {
      r.osKey = m[1] === 'iPad' ? 'ipados' : 'ios';
      r.osVersion = m[2].replace(/_/g, '.');
      r.model = m[1];
      r.mobile = m[1] !== 'iPad';
    } else if (/Macintosh|Mac OS X/.test(ua)) {
      // iPadOS asks for the desktop site and says "Macintosh"; only the touch screen gives it away
      if (touch > 1) { r.osKey = 'ipados'; r.model = 'iPad'; } else r.osKey = 'mac';
    } else if (/Linux|X11/.test(ua)) r.osKey = 'linux';
    if (/aarch64|armv\d|\barm/i.test(ua)) r.arch = 'arm';
    if (/Edg(?:e|A|iOS)?\//.test(ua)) r.browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) r.browser = 'Opera';
    else if (/SamsungBrowser\//.test(ua)) r.browser = 'Samsung Internet';
    else if (/Firefox\/|FxiOS\//.test(ua)) r.browser = 'Firefox';
    else if (/CriOS\/|Chrome\//.test(ua)) r.browser = 'Chrome';
    else if (/Safari\//.test(ua)) r.browser = 'Safari';
    if (/SmartTV|SMART-TV|Tizen|Web0S|WebOS|BRAVIA|AFT[A-Z]|CrKey|HbbTV/i.test(ua)) r.kind = 'tv';
    else if (/PlayStation|Xbox|Nintendo/i.test(ua)) r.kind = 'console';
    return r;
  }
  DI.parseUa = parseUa;

  /** The device-picker preset (12-devices.js ids) a detection stands for. */
  function presetOf(r) {
    if (r.kind) return r.kind;
    if (r.osKey === 'ios') return 'phone';
    if (r.osKey === 'ipados') return 'tablet';
    if (r.osKey === 'android') return r.mobile ? 'phone' : 'tablet';
    if (r.osKey === 'linux' && r.arch === 'arm') return 'rpi';
    if (r.mobile) return 'phone';
    return 'laptop';
  }

  const nav = () => (typeof navigator !== 'undefined' ? navigator : {});
  const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
  let chCache = null;

  /** Quick synchronous guess of the OS ('windows'|'mac'|'linux'|'android'|'ios'|'ipados'|'chromeos'|'other'). */
  DI.guessOs = () => parseUa(nav().userAgent || '', nav().maxTouchPoints || 0).osKey;

  /** Full detection (Client Hints are asked once per page, the connection is read fresh every time). */
  async function detect() {
    const n = nav();
    const r = parseUa(n.userAgent || '', n.maxTouchPoints || 0);
    const uad = n.userAgentData;
    if (uad) {
      const brands = (uad.brands || []).map((b) => b && b.brand);
      const b = BRANDS.find(([k]) => brands.includes(k));
      if (b && r.browser !== 'Samsung Internet') r.browser = b[1];
      if (typeof uad.mobile === 'boolean') r.mobile = uad.mobile || r.mobile;
      if (!chCache && typeof uad.getHighEntropyValues === 'function') {
        try { chCache = await withTimeout(uad.getHighEntropyValues(['platform', 'platformVersion', 'model', 'mobile', 'architecture']), 500); } catch (e) { chCache = null; }
      }
      const h = chCache;
      if (h) {
        const v = String(h.platformVersion || '');
        const major = parseInt(v, 10);
        if (h.platform === 'Windows') { r.osKey = 'windows'; if (Number.isFinite(major)) r.osVersion = major >= 13 ? '11' : major > 0 ? '10' : r.osVersion; }
        else if (h.platform === 'macOS') { r.osKey = r.osKey === 'ipados' ? 'ipados' : 'mac'; if (v) r.osVersion = v.split('.').slice(0, 2).join('.').replace(/\.0$/, ''); }
        else if (h.platform === 'Android') { r.osKey = 'android'; if (Number.isFinite(major)) r.osVersion = String(major); }
        else if (h.platform === 'Chrome OS' || h.platform === 'ChromeOS') r.osKey = 'chromeos';
        else if (h.platform === 'Linux' && r.osKey === 'other') r.osKey = 'linux';
        if (typeof h.model === 'string' && h.model.trim()) r.model = h.model.trim().slice(0, 50);
        if (typeof h.mobile === 'boolean') r.mobile = h.mobile;
        if (/arm/i.test(String(h.architecture || ''))) r.arch = 'arm';
      }
    }
    const c = n.connection || n.mozConnection || n.webkitConnection || null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    let screenClass = 'desktop';
    try { const s = Math.min(screen.width, screen.height); screenClass = s < 600 ? 'phone' : s < 900 ? 'tablet' : 'desktop'; } catch (e) { /* no screen */ }
    if (r.osKey === 'other' && (n.maxTouchPoints || 0) > 0 && screenClass === 'phone') r.mobile = true;
    const os = OS_NAMES[r.osKey] || '';
    const osPart = [os, r.osVersion].filter(Boolean).join(' ');
    const out = {
      os, osKey: r.osKey, osVersion: r.osVersion, model: r.model, browser: r.browser, mobile: !!r.mobile,
      connType: c && typeof c.type === 'string' ? c.type : null,
      effectiveType: c && typeof c.effectiveType === 'string' ? c.effectiveType : null,
      downlink: c ? num(c.downlink) : null, rtt: c ? num(c.rtt) : null,
      online: n.onLine !== false, presetDevice: presetOf(r), arch: r.arch, screen: screenClass,
    };
    out.label = [osPart, r.model && r.model !== os ? r.model : '', r.browser].filter(Boolean).join(' · ');
    return out;
  }
  DI.detect = detect;

  /** A phone or tablet (no desktop OS): no helper, no commands - WiFiman instead. */
  const isHandheld = (osKey) => osKey === 'android' || osKey === 'ios' || osKey === 'ipados';
  PL.isHandheldOs = isHandheld;

  // ---------------------------------------------------------------------------------------------------------------
  // commands, helper files
  // ---------------------------------------------------------------------------------------------------------------
  /** The guide per OS; the command lines themselves come from the parser module (WH.devinfo.COMMANDS, one source). */
  const GUIDE = {
    windows: { main: ['windows', 'cmd'], alt: [['planner.di.cw.alt', 'windows', 'powershell']], steps: ['planner.di.cw.1', 'planner.di.cw.2', 'planner.di.cw.3'], note: ['pin', 'planner.di.err.location'], icon: 'monitor' },
    mac: { main: ['macos', 'copy'], alt: [['planner.di.cm.alt', 'macos', 'wdutil']], steps: ['planner.di.cm.1', 'planner.di.cm.2', 'planner.di.cm.3'], note: ['lightbulb', 'planner.di.cm.tip'], icon: 'laptop' },
    linux: { main: ['linux', 'xclip'], alt: [['planner.di.cl.alt', 'linux', 'wlcopy']], steps: ['planner.di.cl.1', 'planner.di.cl.2', 'planner.di.cl.3'], note: null, icon: 'terminal' },
  };
  const cmdOf = (os, kind) => { const C = DI.COMMANDS || {}; return C[os] && typeof C[os][kind] === 'string' ? C[os][kind] : ''; };
  PL.cmdOf = cmdOf;
  /** The helper files (SPEC 8.2; folder pomocnik/ next to index.html - relative links work on GitHub Pages and locally). */
  const HELPER_FILES = {
    windows: ['pomocnik/Windows/Spustit pomocníka.cmd', 'pomocnik/Windows/wifi-helper.ps1'],
    mac: ['pomocnik/macOS/Spustit pomocníka.command', 'pomocnik/macOS/wifi-helper.py'],
    linux: ['pomocnik/Linux/spustit-pomocnika.sh', 'pomocnik/Linux/wifi-helper.py'],
  };
  PL.HELPER_FILES = HELPER_FILES;
  const pcOs = (k) => (k === 'mac' || k === 'linux' ? k : k === 'chromeos' ? 'linux' : 'windows');
  const relHref = (p) => p.split('/').map(encodeURIComponent).join('/');

  /** Copy text to the clipboard: the async API, else a hidden textarea + execCommand. */
  async function copyText(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall back */ }
    const prev = document.activeElement;
    try {
      const ta = el('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      return !!ok;
    } catch (e) { return false; }
  }
  PL.copyText = copyText;

  /** A command line: the command (selectable, monospace) + a Copy button that confirms itself. */
  function cmdRow(cmd) {
    const code = el('code.pl-di__code', { tabindex: '0', translate: 'no' }, cmd);
    const btn = ui().button({ i18n: 'planner.di.copy', icon: 'copy', size: 'sm', variant: 'soft' });
    btn.classList.add('pl-di__copy');
    btn.setAttribute('aria-label', t('planner.di.copyAria', { cmd }));
    let timer = 0;
    btn.addEventListener('click', async () => {
      const ok = await copyText(cmd);
      const lbl = btn.querySelector('.btn__label');
      clearTimeout(timer);
      if (ok) {
        btn.classList.add('is-done');
        btn.replaceChild(ui().icon('check', 16), btn.querySelector('svg'));
        if (lbl) { lbl.removeAttribute('data-i18n'); lbl.textContent = t('planner.di.copied'); }
        ui().announce(t('planner.di.copied'));
        timer = setTimeout(() => {
          if (!btn.isConnected) return;
          btn.classList.remove('is-done');
          btn.replaceChild(ui().icon('copy', 16), btn.querySelector('svg'));
          if (lbl) { lbl.setAttribute('data-i18n', 'planner.di.copy'); lbl.textContent = t('planner.di.copy'); }
        }, 2200);
      } else {
        // select the command so Ctrl+C works
        try { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); code.focus(); } catch (e) { /* ignore */ }
        ui().toast({ i18n: 'planner.di.copyFail' }, { kind: 'warn' });
      }
    });
    return el('div.pl-di__cmd', code, btn);
  }

  /** Numbered steps (help-style counters, compact). */
  function steps(keys, params) {
    return el('ol.steps.pl-di__steps', keys.map((k) => el('li', el('span', t(k, params)))));
  }

  /** The per-OS command guide. o = {os:'windows'|'mac'|'linux'|'phone'} -> one block; {all:true} -> the three PC blocks. */
  function cmdBlock(os) {
    if (os === 'phone') {
      return el('div.pl-di__os', { dataset: { os } },
        el('p.pl-di__lead', t('planner.di.ph.lead')),
        steps(['planner.di.ph.1', 'planner.di.ph.2']),
        el('a.pl-di__gh.text-sm', { href: t('planner.di.ph.url'), target: '_blank', rel: 'noopener noreferrer' }, ui().icon('external', 16), el('span', t('planner.di.ph.link'))),
        el('div.notice.notice--muted.pl-di__note', ui().icon('info', 18), el('span', t('planner.di.helper.phone'))));
    }
    const c = GUIDE[os];
    const main = cmdOf(...c.main);
    return el('div.pl-di__os', { dataset: { os } },
      main ? cmdRow(main) : null,
      steps(c.steps),
      ...c.alt.map(([k, o2, kind]) => { const cmd = cmdOf(o2, kind); return cmd ? el('div.pl-di__alt', el('div.pl-di__altl.text-sm.text-muted', t(k)), cmdRow(cmd)) : null; }),
      c.note ? el('div.notice.notice--muted.pl-di__note', ui().icon(c.note[0], 18), el('span', t(c.note[1]))) : null);
  }
  PL.cmdTips = function cmdTips(o) {
    o = o || {};
    if (o.all) {
      return el('div.pl-di.pl-di--help',
        ['windows', 'mac', 'linux'].map((os) => el('div.pl-di__osblock', el('h4.pl-di__osh', ui().icon(GUIDE[os].icon, 18), el('span', t(`planner.di.os.${os}`))), cmdBlock(os))),
        helperHelp());
    }
    return cmdBlock(o.os || pcOs(DI.guessOs()));
  };

  /** Download links + the 3-step start guide for one OS (+ the GitHub folder). */
  function helperGuide(os) {
    const files = HELPER_FILES[os];
    const dl = el('div.pl-di__dl', files.map((f) => {
      const name = f.split('/').pop();
      const a = el('a.btn.btn--sm.btn--secondary.pl-di__file', { href: relHref(f), download: name }, ui().icon('download', 16), el('span.btn__label', name));
      return a;
    }));
    const keys = { windows: ['planner.di.hw.1', 'planner.di.hw.2', 'planner.di.hw.3'], mac: ['planner.di.hm.1', 'planner.di.hm.2', 'planner.di.hm.3'], linux: ['planner.di.hl.1', 'planner.di.hl.2', 'planner.di.hl.3'] }[os];
    const list = steps(keys);
    list.firstChild.append(dl);
    return el('div.pl-di__helper', el('p.pl-di__lead', t('planner.di.helper.what')), list,
      el('div.notice.notice--muted.pl-di__note', ui().icon('lock', 18), el('span', t('planner.di.helper.allow'))),
      el('a.pl-di__gh.text-sm', { href: t('planner.di.githubUrl'), target: '_blank', rel: 'noopener noreferrer' }, ui().icon('external', 16), el('span', t('planner.di.github'))));
  }

  /** Help panel: what the helper is + the downloads for every OS. */
  function helperHelp() {
    return el('div.pl-di__osblock',
      el('h4.pl-di__osh', ui().icon('download', 18), el('span', t('helpPanel.helper.t'))),
      el('p.pl-di__lead', t('helpPanel.helper.b')),
      el('div.pl-di__dlall', ['windows', 'mac', 'linux'].map((os) => el('div.pl-di__dlrow',
        el('span.pl-di__dlos', t(`planner.di.os.${os}`)),
        el('div.pl-di__dl', HELPER_FILES[os].map((f) => { const name = f.split('/').pop(); return el('a.btn.btn--sm.btn--secondary.pl-di__file', { href: relHref(f), download: name }, ui().icon('download', 16), el('span.btn__label', name)); }))))),
      el('a.pl-di__gh.text-sm', { href: t('planner.di.githubUrl'), target: '_blank', rel: 'noopener noreferrer' }, ui().icon('external', 16), el('span', t('planner.di.github'))));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the card
  // ---------------------------------------------------------------------------------------------------------------
  const CONN = { wifi: 'wifi', cellular: 'cellular', ethernet: 'ethernet', none: 'offline' };

  /**
   * o = {onUse(wifi), onBack?() (shows a back button - inline in the measurement form), context:'popover'|'sheet'|'drawer'}
   * Probes the helper once when it opens (a user action) and on "Zkusit znovu"; never in the background.
   */
  PL.devInfoCard = function devInfoCard(o) {
    o = o || {};
    const root = el('div.pl-di', { role: 'region', 'aria-label': t('planner.di.title') });
    const S = { det: null, helper: null, checking: false, os: null, text: '', found: null, helperWifi: null, loading: false };
    let alive = true;
    let parseTimer = 0;
    const offLang = WH.bus.on('lang:changed', () => render());

    const handheld = () => isHandheld(S.det ? S.det.osKey : DI.guessOs());

    function head() {
      if (!o.onBack) return null;
      const back = ui().button({ i18n: 'planner.di.back', icon: 'arrow-left', size: 'sm', variant: 'ghost', onClick: () => o.onBack() });
      back.classList.add('pl-di__back');
      return el('div.pl-di__head', back);
    }

    function secDevice() {
      const d = S.det;
      const sec = el('section.pl-di__sec', el('div.pl-di__cap', el('span', t('planner.di.this'))));
      if (!d) { sec.append(el('div.pl-di__row', el('span.spinner.pl-spin'), el('span.text-muted', t('planner.di.detecting')))); return sec; }
      const pr = PL.dev && PL.dev.PRESETS.find((p) => p.id === d.presetDevice);
      const devName = pr ? t(`planner.dev.${pr.id}`) : '';
      const title = d.model && d.model !== d.os ? d.model : devName || d.os || t('planner.di.unknown');
      sec.append(el('div.pl-di__dev', el('span.pl-di__devico', ui().icon(pr ? pr.icon : 'monitor', 24)),
        el('div.pl-di__devtxt', el('b', title), el('span.text-sm.text-muted', [d.os && [d.os, d.osVersion].filter(Boolean).join(' '), d.browser, pr && title !== devName ? devName : ''].filter(Boolean).join(' · ')))));
      const conn = !d.online ? 'offline' : CONN[d.connType] || 'unknown';
      const kv = el('dl.kv.pl-di__kv', el('div', el('dt', t('planner.di.k.conn')), el('dd', t(`planner.di.conn.${conn}`))));
      sec.append(kv);
      if (d.connType === 'cellular') sec.append(el('div.notice.notice--warn.pl-di__note', ui().icon('warning', 18), el('span', t('speedtest.cellular'))));
      return sec;
    }

    function secCant() {
      return el('div.notice.notice--muted.pl-di__note.pl-di__cant', ui().icon('eye-off', 18),
        el('div', el('b', t('planner.di.cant.t')), ' ', el('span', t('planner.di.cant.b')), ' ', ui().hint('devinfo')));
    }

    function secHelper() {
      if (handheld()) return null;
      const sec = el('section.pl-di__sec.pl-di__hstat', { 'aria-live': 'polite' });
      const h = S.helper;
      let line;
      // while the browser's own question is open: say what it is and what to click (SPEC 10.1), wait up to 30 s
      if (S.asking) line = el('div.stack.gap-2', el('div.pl-di__row', el('span.spinner.pl-spin'), el('span', t('planner.mall.wifi.asking'))), el('div.notice.pl-di__note.pl-di__ask', ui().icon('lock', 18), el('span', t('planner.di.helper.asking'))));
      else if (S.checking || !h) line = el('div.pl-di__row', el('span.spinner.pl-spin'), el('span', t('planner.di.helper.checking')));
      else if (h.connected) {
        const get = ui().button({ i18n: 'planner.di.helper.read', icon: 'wifi', size: 'sm', variant: 'soft', onClick: () => readHelper() });
        get.disabled = S.loading;
        line = el('div.pl-di__row.is-ok', el('span.pl-di__ok', ui().icon('check-circle', 18)), el('span.grow', t('planner.di.helper.on')), get);
      } else if (h.blocked === 'prompt') {
        // a page from the internet (GitHub Pages): Chrome / Edge ask once before it may reach a program on this computer -
        // only on purpose, never as a surprise during "Změřit vše"
        const ask = ui().button({ i18n: 'planner.di.helper.ask', icon: 'wifi', size: 'sm', variant: 'soft', onClick: () => probe(4000, true) });
        line = el('div.stack.gap-1', el('div.pl-di__row', el('span.pl-di__off', ui().icon('circle', 18)), el('span.grow', t('planner.di.helper.idle')), ask, ui().hint('wifiHelper')),
          el('p.pl-di__lead.text-xs', t('planner.di.helper.askLead')));
      } else {
        const retry = ui().button({ i18n: 'planner.di.helper.retry', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => probe(4000, true) });
        const denied = h.blocked === 'denied' || h.reason === 'denied';
        line = el('div.pl-di__row', el('span.pl-di__off', ui().icon(denied ? 'lock' : 'circle', 18)), el('span.grow', t(denied ? 'planner.di.helper.blockedLine' : 'planner.di.helper.off')), retry, ui().hint('wifiHelper'));
      }
      sec.append(line);
      if (h && !h.connected && !S.checking && !S.asking) {
        // specific reasons, never a generic error: blocked by the browser (how to allow it again + the paste way below),
        // the question left unanswered, or the browser allowed it but no helper answers
        const k = h.blocked === 'denied' || h.reason === 'denied' ? 'planner.di.helper.denied' : S.asked && h.blocked === 'prompt' ? 'planner.mall.wifi.askTimeout' : S.asked && h.reason === 'timeout' ? 'planner.di.helper.slow' : S.asked ? 'planner.di.helper.notRunning' : '';
        if (k) sec.append(el('div.notice.notice--warn.pl-di__note', ui().icon(k === 'planner.di.helper.denied' ? 'lock' : 'warning', 18), el('span', t(k))));
      }
      return sec;
    }

    function secOs() {
      const os = S.os || (handheld() ? 'phone' : pcOs(S.det ? S.det.osKey : DI.guessOs()));
      S.os = os;
      const tabs = ui().segmented(['windows', 'mac', 'linux', 'phone'].map((v) => ({ value: v, i18n: `planner.di.os.${v}` })), {
        value: os, size: 'sm', aria: 'planner.di.os.aria', onChange: (v) => { S.os = v; render(true); },
      });
      tabs.classList.add('pl-di__tabs');
      const sec = el('section.pl-di__sec', el('div.pl-di__cap', ui().icon(os === 'phone' ? 'phone' : 'terminal', 16), el('span', t(os === 'phone' ? 'planner.di.cmd.tPhone' : 'planner.di.cmd.t'))), tabs);
      if (os !== 'phone') sec.append(el('p.pl-di__lead', t('planner.di.cmd.lead')));
      sec.append(cmdBlock(os));
      if (os !== 'phone') {
        // the helper: download + start guide, folded (the command above needs no download)
        const d = el('details.disclosure.pl-di__more', el('summary', ui().icon('download', 18), el('span', t('planner.di.helper.dl', { os: t(`planner.di.os.${os}`) }))), el('div.disclosure__body', helperGuide(os)));
        if (S.helperOpen) d.open = true;
        d.addEventListener('toggle', () => { S.helperOpen = d.open; });
        sec.append(d);
      }
      return sec;
    }

    let ta = null;
    function secPaste() {
      if (S.os === 'phone') return null;
      const pasteBtn = ui().button({ i18n: 'planner.di.paste', icon: 'list', size: 'sm', variant: 'primary', onClick: () => pasteNow() });
      ta = el('textarea.textarea.pl-di__ta', { rows: '3', spellcheck: 'false', autocomplete: 'off', placeholder: t('planner.di.pastePh', { k: WH.util.isMac ? '⌘V' : 'Ctrl+V' }), 'aria-label': t('planner.di.pasteLabel') });
      ta.value = S.text;
      ta.addEventListener('input', () => { S.text = ta.value; clearTimeout(parseTimer); parseTimer = setTimeout(() => parse(true), 160); });
      ta.addEventListener('paste', () => setTimeout(() => { S.text = ta.value; parse(true, true); }, 0));
      const hint = el('p.pl-di__phint.text-sm.text-muted', { hidden: !S.pasteHint }, t('planner.di.pasteHint', { k: WH.util.isMac ? '⌘V' : 'Ctrl+V' }));
      return el('section.pl-di__sec.pl-di__paste', el('div.pl-di__row', pasteBtn), ta, hint, foundBox());
    }

    let foundEl = null;
    function foundBox() {
      foundEl = el('div.pl-di__found', { 'aria-live': 'polite' });
      paintFound();
      return foundEl;
    }
    function paintFound() {
      if (!foundEl) return;
      const f = S.found;
      foundEl.replaceChildren();
      if (!f) return;
      if (f.none) { foundEl.append(el('div.notice.notice--warn.pl-di__note', ui().icon('warning', 18), el('span', t(f.none)))); return; }
      const use = ui().button({ i18n: 'planner.di.use', icon: 'check', size: 'sm', variant: 'primary', onClick: () => { if (typeof o.onUse === 'function') o.onUse(f.wifi, f.source); } });
      use.classList.add('pl-di__use');
      foundEl.append(el('div.notice.notice--ok.pl-di__note', ui().icon('check-circle', 18),
        el('div.stack.gap-2', el('span.pl-di__foundt', PL.wifiFound(f.wifi)), ...(f.warns || []).map((k) => el('span.text-xs.pl-di__warn', t(k))), el('div', use))));
    }

    /** Parse the pasted text with the parser of 36-devinfo; its warnings (i18n keys) explain what is missing. */
    function parse(announce, reveal) {
      const txt = S.text.trim();
      if (!txt) { S.found = null; paintFound(); return; }
      let r = null;
      try { r = typeof DI.parse === 'function' ? DI.parse(txt) : null; } catch (e) { r = null; PL.report(e, 'devinfo.parse'); }
      const w = r ? PL.normWifi(r) : null;
      const warns = r && Array.isArray(r.warnings) ? r.warnings.filter((k) => typeof k === 'string' && WH.i18n.has(k)) : [];
      // Windows 11 (24H2+) prints a "needs location permission" text instead of the details while Location is off (the
      // parser recognises it in every language by its ms-settings:privacy-location link)
      const locOff = !w && warns.includes('devinfo.warn.location');
      S.found = w ? { wifi: w, source: 'paste', warns: warns.filter((k) => k !== 'devinfo.warn.notConnected' && k !== 'devinfo.warn.noWifi') }
        : { none: locOff ? 'planner.di.err.location' : warns[0] || 'planner.di.notFound' };
      paintFound();
      if (announce) {
        ui().announce(w ? PL.wifiFound(w) : t(S.found.none));
        // the answer (and "Použít v měření") sits under the box: bring it into view after a paste
        if (reveal) requestAnimationFrame(() => { try { if (foundEl && foundEl.isConnected) foundEl.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } });
      }
    }

    async function pasteNow() {
      let txt = null;
      try { if (navigator.clipboard && navigator.clipboard.readText) txt = await navigator.clipboard.readText(); } catch (e) { txt = null; }
      if (!alive) return;
      if (txt && txt.trim()) {
        S.text = txt;
        S.pasteHint = false;
        if (ta) { ta.value = txt; }
        parse(true, true);
        const h = root.querySelector('.pl-di__phint');
        if (h) h.hidden = true;
      } else {
        // reading the clipboard is not allowed here: the box + Ctrl+V does the same
        S.pasteHint = true;
        const h = root.querySelector('.pl-di__phint');
        if (h) h.hidden = false;
        if (ta) { try { ta.focus(); ta.select(); } catch (e) { /* ignore */ } }
        ui().announce(t('planner.di.pasteHint', { k: WH.util.isMac ? '⌘V' : 'Ctrl+V' }));
      }
    }

    async function probe(ms, ask) {
      if (handheld()) return;
      S.checking = true;
      render(true);
      let h;
      try {
        h = await PL.helperStatus({ timeout: ms, ask: !!ask, onAsk: () => { if (!alive) return; S.asking = true; render(true); ui().announce(t('planner.di.helper.asking')); } });
      } catch (e) { PL.report(e, 'devinfo.helper'); h = { connected: false, reason: 'error' }; }
      if (!alive) return;
      S.checking = false;
      S.asking = false;
      S.asked = !!ask || !!S.asked;
      S.helper = h;
      render(true);
      if (ask) ui().announce(t(h.connected ? 'planner.di.helper.on' : h.blocked === 'denied' || h.reason === 'denied' ? 'planner.di.helper.denied' : h.blocked === 'prompt' ? 'planner.mall.wifi.askTimeout' : 'planner.di.helper.notRunning'));
    }

    async function readHelper() {
      S.loading = true;
      render(true);
      let w = null;
      let code = '';
      try { w = await PL.helperWifi(); } catch (e) { w = null; code = (e && e.code) || ''; PL.report(e, 'devinfo.helperWifi'); }
      if (!alive) return;
      S.loading = false;
      S.found = w ? { wifi: w, source: 'helper' } : { none: PL.wifiProblemKey(code) };
      render(true);
      ui().announce(w ? PL.wifiFound(w) : t(S.found.none));
      requestAnimationFrame(() => { try { if (foundEl && foundEl.isConnected) foundEl.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } });
    }

    /** (Re)build the card; keep the focused control focused when possible. */
    function render(keepFocus) {
      if (!alive) return;
      const a = document.activeElement;
      const key = keepFocus && a && root.contains(a) ? (a.classList.contains('pl-di__ta') ? 'ta' : a.classList.contains('pl-di__back') ? 'back' : a.closest('.seg') ? 'tab:' + (a.getAttribute('aria-checked') === 'true' ? S.os : '') : a.closest('.pl-di__hstat') ? 'helper' : a.closest('.pl-di__found') ? 'found' : '') : '';
      const sel = ta && key === 'ta' ? [ta.selectionStart, ta.selectionEnd] : null;
      root.replaceChildren(...[head(), secDevice(), secCant(), secHelper(), secOs(), secPaste()].filter(Boolean));
      ui().enhance(root);
      if (key === 'back') { const b = root.querySelector('.pl-di__back'); if (b) b.focus({ preventScroll: true }); }
      else if (key === 'found') { const b = root.querySelector('.pl-di__use') || ta; if (b) b.focus({ preventScroll: true }); }
      else if (key === 'ta' && ta) { ta.focus({ preventScroll: true }); if (sel) ta.setSelectionRange(sel[0], sel[1]); }
      else if (key.startsWith('tab:')) { const b = root.querySelector('.pl-di__tabs [aria-checked="true"]'); if (b) b.focus({ preventScroll: true }); }
      else if (key === 'helper') { const b = root.querySelector('.pl-di__hstat .btn'); if (b) b.focus({ preventScroll: true }); }
      if (typeof o.onLayout === 'function') o.onLayout();
    }

    render();
    detect().then((d) => {
      if (!alive) return;
      S.det = d;
      render(true);
      if (!isHandheld(d.osKey)) probe(300);
    }).catch((e) => { PL.report(e, 'devinfo.detect', { bug: true }); });

    root.destroy = () => { alive = false; clearTimeout(parseTimer); offLang(); };
    root.focusFirst = () => { const b = root.querySelector('.pl-di__back') || root.querySelector('button, [tabindex="0"]'); if (b) { try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } };
    return root;
  };

  /** The card in a side drawer (Measurements card / help): "Použít v měření" keeps the details for the next measurement. */
  PL.openDevInfo = function openDevInfo() {
    let h = null;
    const card = PL.devInfoCard({
      context: 'drawer',
      onUse: (w, src) => {
        PL.wifiPending.set(w, src || 'paste');
        if (h) h.close();
        const pend = PL.S && PL.S.pending;
        if (pend && pend.applyWifi && pend.applyWifi(w, src || 'paste')) return;
        ui().toast({ text: t('planner.di.usedNext', { s: PL.wifiLine(w, { signal: true }) }), action: { i18n: 'planner.di.measureNow', fn: () => { if (WH.views.current !== 'planner') WH.views.go('planner'); if (PL.startMeasuring && PL.S.tool !== 'measure') PL.startMeasuring(); } } }, { kind: 'ok' });
      },
    });
    h = ui().dialog({ title: { i18n: 'planner.di.title' }, content: card, className: 'modal--drawer pl-di-drawer', onClose: () => card.destroy() });
    if (h.el.parentNode) h.el.parentNode.classList.add('modal-backdrop--drawer');
    return h;
  };

  /** A ready "Info o zařízení" button (the Measurements card puts it next to "Přidat měření"). */
  PL.devInfoButton = function devInfoButton(opts) {
    const b = ui().button({ i18n: 'planner.di.btn', icon: 'info', variant: (opts && opts.variant) || 'ghost', size: (opts && opts.size) || 'sm', tip: 'planner.di.btn.tip', onClick: () => PL.openDevInfo() });
    b.classList.add('pl-di-open');
    b.setAttribute('aria-haspopup', 'dialog');
    return b;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // #wifi=<base64url JSON> from the helper's one-shot mode
  // ---------------------------------------------------------------------------------------------------------------
  const startHash = typeof location !== 'undefined' ? String(location.hash || '') : '';
  const isWifiHash = (h) => /^#wifi=./i.test(h || '');

  /** Read a #wifi=... hash, keep its details for the next measurement and take it out of the URL. */
  function importHash(hash) {
    if (!isWifiHash(hash)) return false;
    let r = null;
    try { r = typeof DI.fromHash === 'function' ? DI.fromHash(hash) : null; } catch (e) { r = null; PL.report(e, 'devinfo.hash'); }
    // the data never stays in the address bar (nor in the history)
    try {
      if (isWifiHash(location.hash)) history.replaceState(history.state, '', location.pathname + location.search + (WH.views && WH.views.current === 'editor' ? '#plan' : '#wifi'));
    } catch (e) { /* file:// quirks */ }
    const w = r && r.ok ? PL.normWifi(r) : null;
    if (!w) {
      const k = r && !r.ok && r.error && WH.i18n.has(r.error) ? r.error : (r && (r.warnings || []).find((x) => WH.i18n.has(x))) || 'planner.di.hash.bad';
      ui().toast({ i18n: k }, { kind: 'warn' });
      return true;
    }
    PL.wifiPending.set(w, 'link');
    const pend = PL.S && PL.S.pending;
    if (pend && pend.applyWifi && pend.applyWifi(w, 'link')) {
      ui().toast({ text: t('planner.di.hash.ok', { s: PL.wifiLine(w, { signal: true }) }) }, { kind: 'ok' });
      return true;
    }
    ui().toast({
      text: `${t('planner.di.hash.ok', { s: PL.wifiLine(w, { signal: true }) })} ${t(PL.isPhone && PL.isPhone() ? 'planner.di.hash.nextTouch' : 'planner.di.hash.next')}`,
      action: { i18n: 'planner.di.measureNow', fn: () => { if (WH.views.current !== 'planner') WH.views.go('planner'); if (PL.startMeasuring && PL.S.tool !== 'measure') PL.startMeasuring(); } },
    }, { kind: 'ok', ms: 12000 });
    return true;
  }
  PL.importWifiHash = importHash;
  if (typeof window !== 'undefined') {
    if (WH.shell && typeof WH.shell.onReady === 'function') WH.shell.onReady(() => importHash(startHash));
    window.addEventListener('hashchange', () => { if (isWifiHash(location.hash)) importHash(location.hash); });
  }
})();
