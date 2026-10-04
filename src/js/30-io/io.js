/* WH.io - everything that crosses the boundary of the page: files in, files out, localStorage.
 *
 *   WH.io.importFile(file, {fresh, asBackground}) -> Promise<{kind}>   kind: 'project' | 'tracing_image' | 'background' | 'error' | 'cancelled'
 *   WH.io.openPicker(opts)                        -> Promise<result | null>
 *   WH.io.saveProjectSvg() / exportPlanPng()      download the project / a 2160x1884 PNG of the floor plan
 *   WH.io.saveLocal(project) / loadLocal() / clearLocal()      localStorage 'wifi-heatmap-v3' (+ legacy migration)
 *   WH.io.rasterizeBackground(file | dataUrl)     -> Promise<PNG data URL>, letterboxed into 1080x942, <= 1800 px wide
 *
 * importFile never rejects: problems are shown as a friendly toast and reported as {kind:'error', error:<code>}.
 * Hostile files stay cheap: no regex here can backtrack over a whole 8 MB file, foreign SVGs that would expand to more
 * than MAX_RENDERED shapes (<use> / pattern bombs) are refused, images above 100 MP are refused before decoding.
 * WH.engine is only touched lazily (at call time), never while this file loads. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;

  const LS_KEY = 'wifi-heatmap-v3';
  const BG_KEY = 'wifi-heatmap-v3-bg';
  const BAD_KEY = 'wifi-heatmap-v3-corrupt';
  const LEGACY_KEYS = ['wifi-floor-v5', 'wifi-floor-network-v1', 'wifi-speed-v1', 'wifi-flow-v1'];
  const MAX_FILE = 8000000;          // bytes accepted from the user
  const MAX_DATA_URL = 7000000;      // characters in a stored/embedded image
  const CANVAS_W = 1080;
  const CANVAS_H = 942;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const t = (k, p) => WH.i18n.t(k, p);

  /** Error with a code that maps to the i18n key io.err.<code>. */
  class IoError extends Error {
    constructor(code) { super(`io:${code}`); this.code = code; }
  }

  function toast(msg, opts) { if (WH.ui && WH.ui.toast) WH.ui.toast(msg, opts); else console.warn('[WH.io]', msg); }
  /** An unexpected (non-IoError) failure: kept in the error diary for Help -> Report a problem; the caller shows its own toast. */
  function report(e, context) { try { if (WH.diag) WH.diag.record(e, { kind: 'reported', context, notify: false }); } catch (x) { /* ignore */ } }

  function engineProject() {
    const ep = WH.engine && WH.engine.project;
    if (!ep) throw new IoError('noEngine');
    return ep;
  }

  /** Engine errors carry an i18n key as message ("err.plan.polygon" ...) with ready-made cs+en texts. */
  const isEngineKey = (e) => !!(e && typeof e.message === 'string' && /^err\.[\w.]+$/.test(e.message) && WH.i18n.has(e.message));

  function fail(e) {
    if (isEngineKey(e)) {
      toast(t(e.message), { kind: 'error' });
      return { kind: 'error', error: e.message };
    }
    const code = e instanceof IoError ? e.code : 'generic';
    if (!(e instanceof IoError)) { console.error('[WH.io] unexpected error:', e); report(e, 'io.import'); }
    toast({ i18n: `io.err.${code}` }, { kind: 'error' });
    return { kind: 'error', error: code };
  }

  // ===================================================================================================================
  // file type sniffing
  // ===================================================================================================================
  async function sniff(file) {
    let bytes;
    try { bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer()); } catch (e) { throw new IoError('generic'); }
    const at = (i, ...vals) => vals.every((v, k) => bytes[i + k] === v);
    if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
    if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '').trimStart();
    if (/\.svg$/i.test(file.name || '') || file.type === 'image/svg+xml' || /^<\?xml|^<svg|^<!-{2}|^<!DOCTYPE\s+svg/i.test(head)) return 'svg';
    return null;
  }

  // ===================================================================================================================
  // SVG handling: sanitise foreign SVG, then rasterise it as a tracing background
  // ===================================================================================================================
  const SVG_TAGS = new Set(['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'polygon', 'polyline', 'line', 'circle', 'ellipse', 'text', 'tspan', 'textPath',
    'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'image', 'title', 'desc']);
  const SVG_ATTRS = new Set(['id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'stroke',
    'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity',
    'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'offset', 'stop-color', 'stop-opacity',
    'gradientUnits', 'gradientTransform', 'spreadMethod', 'preserveAspectRatio', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'patternUnits', 'patternContentUnits',
    'patternTransform', 'letter-spacing', 'word-spacing', 'clip-path', 'mask', 'display', 'visibility', 'href']);
  const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const TEXT_HOLDERS = new Set(['text', 'tspan', 'textPath', 'title', 'desc']);

  /**
   * Parse SVG text into a Document. DOCTYPE without an internal subset is dropped; ENTITY tricks are refused.
   * (The DOCTYPE patterns cannot run past the next "<": "[^>]*" would rescan the rest of the file for every
   * "<!DOCTYPE" of a hostile 8 MB file - quadratic.)
   */
  function parseSvgDocument(source) {
    let text = String(source);
    if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^<>[]*\[/i.test(text)) throw new IoError('svg');
    text = text.replace(/<!DOCTYPE[^<>]*>/gi, '');
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || !root || root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== SVG_NS)) throw new IoError('svg');
    return doc;
  }

  function cssPixels(value, fallback) {
    const s = String(value || '').trim();
    if (s.length > 40) return fallback; // a length is short; the pattern below backtracks on long digit runs
    const m = s.match(/^([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|mm|cm|in|pt|pc|q)?$/i);
    if (!m) return fallback;
    const unit = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, q: 96 / 101.6 }[String(m[2] || 'px').toLowerCase()];
    return Number(m[1]) * unit;
  }

  const MAX_RENDERED = 200000;     // shapes a foreign SVG may expand to when it is drawn
  const URL_REF_RE = /^url\(\s*#([\w.-]+)\s*\)$/i;

  /**
   * Refuse "use bombs": 10 nested levels of 10 <use> (or url(#pattern) fills) are only ~100 elements in the file but
   * 10^10 shapes when the browser rasterises the image, which freezes the tab. Counts what would be drawn - every
   * element once per way it is reached (children, <use href>, fill / stroke / clip-path / mask url(#id)) - memoised,
   * so the check itself is linear; reference cycles are refused too.
   */
  function checkAmplification(doc) {
    const byId = new Map();
    for (const el of Array.from(doc.querySelectorAll('[id]'))) if (!byId.has(el.getAttribute('id'))) byId.set(el.getAttribute('id'), el);
    const memo = new Map();
    const tooBig = () => new IoError('svgComplex');
    const weight = (el, depth) => {
      const known = memo.get(el);
      if (known !== undefined) {
        if (known < 0) throw tooBig(); // reference cycle
        return known;
      }
      if (depth > 300) throw tooBig();
      memo.set(el, -1);
      let w = 1;
      const refs = [];
      if (el.localName === 'use') refs.push(String(el.getAttribute('href') || '').replace(/^#/, ''));
      for (const a of ['fill', 'stroke', 'clip-path', 'mask']) {
        const m = URL_REF_RE.exec(String(el.getAttribute(a) || ''));
        if (m) refs.push(m[1]);
      }
      for (const ch of Array.from(el.children)) {
        w += weight(ch, depth + 1);
        if (w > MAX_RENDERED) throw tooBig();
      }
      for (const id of refs) {
        const target = byId.get(id);
        if (target) w += weight(target, depth + 1);
        if (w > MAX_RENDERED) throw tooBig();
      }
      memo.set(el, w);
      return w;
    };
    weight(doc.documentElement, 0);
  }

  /** Copy only passive drawing elements/attributes (no scripts, styles, external references, event handlers). */
  function passiveSvg(doc) {
    const clean = document.implementation.createDocument(SVG_NS, 'svg', null);
    let count = 0;

    function copy(from, to, depth) {
      if (depth > 100 || ++count > 10000) throw new IoError('svgComplex');
      for (const a of Array.from(from.attributes)) {
        const key = a.localName;
        const v = a.value;
        const isDataImage = key === 'href' && from.localName === 'image' && DATA_IMAGE_RE.test(v) && v.length < 6000000;
        if (!SVG_ATTRS.has(key) || (!isDataImage && v.length > 100000) || v.indexOf('\\') >= 0) continue;
        if (key === 'href') {
          if (!/^#[\w.-]+$/.test(v) && !isDataImage) continue;
        } else if (/url\s*\(/i.test(v)) {
          if (!/^url\(\s*#[\w.-]+\s*\)$/i.test(v)) continue;
        } else if (/(?:@import|javascript:|data:|https?:|file:)/i.test(v)) {
          continue;
        }
        to.setAttribute(key, v);
      }
      for (const child of Array.from(from.childNodes)) {
        if (child.nodeType === 1) {
          if (!SVG_TAGS.has(child.localName) || (child.namespaceURI && child.namespaceURI !== SVG_NS)) continue;
          const next = clean.createElementNS(SVG_NS, child.localName);
          copy(child, next, depth + 1);
          to.appendChild(next);
        } else if (child.nodeType === 3 && TEXT_HOLDERS.has(from.localName)) {
          to.appendChild(clean.createTextNode(child.textContent));
        }
      }
    }
    copy(doc.documentElement, clean.documentElement, 0);
    checkAmplification(clean);

    const src = doc.documentElement;
    const box = String(src.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const vb = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
      ? box
      : [0, 0, cssPixels(src.getAttribute('width'), CANVAS_W), cssPixels(src.getAttribute('height'), CANVAS_H)];
    if (!(vb[2] > 0 && vb[3] > 0) || vb[2] > 1000000 || vb[3] > 1000000) throw new IoError('imageDims');
    const factor = Math.min(1, 1800 / Math.max(vb[2], vb[3]));
    clean.documentElement.setAttribute('viewBox', vb.join(' '));
    clean.documentElement.setAttribute('width', String(Math.max(1, Math.round(vb[2] * factor))));
    clean.documentElement.setAttribute('height', String(Math.max(1, Math.round(vb[3] * factor))));
    return new XMLSerializer().serializeToString(clean);
  }

  // ===================================================================================================================
  // rasterisation
  // ===================================================================================================================
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => reject(new IoError('image')), 20000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new IoError('image')); };
      img.decoding = 'async';
      img.src = url;
    });
  }

  /** Draw an image centred ("letterboxed") on a white canvas with the plan's aspect ratio. */
  function letterbox(img, width) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((width * CANVAS_H) / CANVAS_W);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    return c.toDataURL('image/png');
  }

  async function imageUrlToPng(url) {
    const img = await loadImage(url);
    // checked before the first draw (which decodes the pixels): 20000 x 20000 would need 1.6 GB of RAM
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h || w > 20000 || h > 20000 || w * h > 100e6) throw new IoError('imageDims');
    let png = letterbox(img, 1800);
    if (png.length >= MAX_DATA_URL) png = letterbox(img, 1080);
    if (png.length >= MAX_DATA_URL) throw new IoError('imageBig');
    return png;
  }

  async function svgTextToPng(text) {
    const url = URL.createObjectURL(new Blob([passiveSvg(parseSvgDocument(text))], { type: 'image/svg+xml' }));
    try { return await imageUrlToPng(url); } finally { URL.revokeObjectURL(url); }
  }

  function decodeBase64Utf8(b64) {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /** File/Blob or data URL (png/jpeg/webp/svg) -> PNG data URL letterboxed into the plan canvas. */
  async function rasterizeBackground(src) {
    try {
      if (typeof src === 'string') {
        const m = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(src);
        if (m) return await svgTextToPng(decodeBase64Utf8(m[1]));
        if (!DATA_IMAGE_RE.test(src) || src.length >= MAX_DATA_URL) throw new IoError('image');
        return await imageUrlToPng(src);
      }
      const isSvg = (await sniff(src)) === 'svg';
      if (isSvg) return await svgTextToPng(await WH.util.readFileText(src));
      const url = URL.createObjectURL(src);
      try { return await imageUrlToPng(url); } finally { URL.revokeObjectURL(url); }
    } catch (e) {
      if (e instanceof IoError) throw e;
      throw new IoError('image');
    }
  }

  // ===================================================================================================================
  // import
  // ===================================================================================================================
  let importSeq = 0;
  /** The file the current project was opened from ({stem, name}): "Save" offers that file name again (muj-byt.svg
   *  came back as wifi-....svg / the project's inner name before). Cleared by File > demo / new plan. */
  let openedAs = null;
  let openedOff = null;
  const stem = (name) => String(name || '').replace(/\.[^.]+$/, '').slice(0, 50);

  /** Put a freshly imported project into the store: hard reset for the first project, undoable replace otherwise. */
  function adopt(project, opts, label) {
    const store = WH.store;
    if (opts.fresh || !store.project) { store.init(project); return false; }
    store.replace(project, label);
    return true;
  }

  function undoAction() {
    return { i18n: 'ui.undo', fn: () => { if (WH.store.canUndo()) WH.store.undo(); } };
  }

  async function importSvgFile(file, opts, token) {
    let text = await WH.util.readFileText(file);
    text = text.replace(/^﻿/, '');
    const ep = engineProject();
    let parsed;
    try {
      parsed = ep.parseSvgText(text);
    } catch (e) {
      if (isEngineKey(e)) throw e; // a specific, translated engine message (err.svg.* / err.plan.*)
      throw new IoError('corrupt');
    }

    if (parsed && parsed.hasData) {
      const project = parsed.project;
      if (!project) throw new IoError('corrupt');
      // an old file's SVG data-URL tracing background: the engine reports it, the DOM rasterises it to PNG
      const legacyBg = parsed.svgBackground;
      if (legacyBg) {
        try { project.plan.background = await rasterizeBackground(legacyBg); } catch (e) { project.plan.background = null; }
      }
      if (token !== importSeq) return { kind: 'cancelled' };
      if (!project.name) project.name = stem(file.name) || t('io.defaultName');
      const undoable = adopt(project, opts, 'file.open');
      openedAs = { stem: stem(file.name), name: project.name };
      if (!openedOff && WH.bus) openedOff = WH.bus.on('project:created', () => { openedAs = null; });
      const pl = project.plan;
      const msg = t('io.ok.project', {
        name: project.name,
        rooms: t('io.rooms', { n: pl.rooms.length }),
        walls: t('io.walls', { n: pl.walls.length }),
        furniture: t('io.furniture', { n: pl.furniture.length }),
      });
      toast(undoable ? { text: msg, action: undoAction() } : msg, { kind: 'ok' });
      WH.bus.emit('project:imported', { kind: 'project', name: project.name, undoable });
      askScale(project);
      return { kind: 'project', name: project.name, rooms: pl.rooms.length, walls: pl.walls.length, doors: pl.doors.length, furniture: pl.furniture.length };
    }

    // a plain SVG (not ours): trace over it
    const png = await svgTextToPng(text);
    return finishTracing(png, file, opts, token);
  }

  /** SPEC 14.1: an older file's scale was never confirmed by anyone - ask once, right after opening it: "Měřítko z
   *  načteného souboru: byt ≈ 58 m². Sedí?" [Sedí] [Upravit] (the same question stays in the floor-plan editor's hint
   *  line and scale card, and the Wi-Fi view's header badge says "Měřítko neověřeno" until it is answered). */
  function askScale(project) {
    const sc = project && project.scale;
    if (!sc || sc.verified !== false || sc.method !== 'import' || !project.plan.rooms.length) return;
    let area = 0;
    try { area = engineProject().buildingArea(project).areaM2; } catch (e) { return; }
    if (!(area > 0)) return;
    const still = () => { const p = WH.store.project; return !!(p && p.scale && p.scale.verified === false); };
    const sc2 = () => (WH.editor && WH.editor.scaling) || null;
    toast({
      text: t('editor.scale.banner', { area: `${WH.util.fmt(area, area < 100 ? 1 : 0)}${WH.util.NBSP}m²` }),
      actions: [
        { i18n: 'editor.scale.bannerOk', icon: 'check', primary: true, fn: () => {
          if (!still()) return;
          if (sc2()) { sc2().confirmCurrent(); return; }
          WH.store.commit('editor.undo.scaleOk', (p) => { engineProject().confirmScale(p); }, ['scale']);
        } },
        { i18n: 'editor.scale.bannerEdit', icon: 'ruler', fn: () => {
          if (sc2()) sc2().editImported(); else if (WH.views) WH.views.go('editor');
        } },
      ],
    }, { kind: 'info', ms: 30000 });
  }

  async function importRasterFile(file, opts, token) {
    const png = await rasterizeBackground(file);
    return finishTracing(png, file, opts, token);
  }

  function finishTracing(png, file, opts, token) {
    if (token !== importSeq) return { kind: 'cancelled' };
    const store = WH.store;
    if (opts.asBackground && store.project) {
      store.commit('io.background', (p) => { p.plan.background = png; }, ['plan']);
      toast({ i18n: 'io.ok.background' }, { kind: 'ok' });
      WH.bus.emit('project:imported', { kind: 'background', name: stem(file.name), undoable: true });
      return { kind: 'background' };
    }
    const ep = engineProject();
    const project = ep.create({ template: 'blank', lang: WH.i18n.lang });
    project.plan.background = png;
    project.name = stem(file.name) || t('io.defaultName');
    const undoable = adopt(project, opts, 'file.open');
    openedAs = null;
    toast(undoable ? { i18n: 'io.ok.tracing', action: undoAction() } : { i18n: 'io.ok.tracing' }, { kind: 'ok' });
    WH.bus.emit('project:imported', { kind: 'tracing_image', name: project.name, undoable });
    return { kind: 'tracing_image', name: project.name };
  }

  /**
   * Import a user file.  opts.fresh: replace without keeping an undo step (first run);
   * opts.asBackground: only set the tracing background of the current plan (images / foreign SVG).
   */
  async function importFile(file, opts) {
    opts = opts || {};
    const token = ++importSeq;
    try {
      if (!file) throw new IoError('generic');
      if (!file.size) throw new IoError('empty');
      if (file.size > MAX_FILE) throw new IoError('size');
      const kind = await sniff(file);
      if (!kind) throw new IoError('type');
      engineProject(); // fail early with a clear message when the engine is missing
      if (kind === 'svg') {
        if (opts.asBackground) return finishTracing(await svgTextToPng((await WH.util.readFileText(file)).replace(/^﻿/, '')), file, opts, token);
        return await importSvgFile(file, opts, token);
      }
      return await importRasterFile(file, opts, token);
    } catch (e) {
      return fail(e);
    }
  }

  /** Open the system file chooser. Resolves with the import result, or null if the user cancelled. */
  function openPicker(opts) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.svg,image/svg+xml,.png,image/png,.jpg,.jpeg,image/jpeg,.webp,image/webp';
      input.style.display = 'none';
      document.body.appendChild(input);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        window.removeEventListener('focus', onFocus);
        input.remove();
        resolve(v);
      };
      // Browsers without the 'cancel' event: after the chooser closes the window regains focus
      const onFocus = () => setTimeout(() => { if (!done && !(input.files && input.files.length)) finish(null); }, 1200);
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) { finish(null); return; }
        finish(await importFile(f, opts));
      });
      input.addEventListener('cancel', () => finish(null));
      setTimeout(() => window.addEventListener('focus', onFocus), 400);
      input.click();
    });
  }

  // ===================================================================================================================
  // export
  // ===================================================================================================================
  function buildSvg(project) {
    return engineProject().buildSvg(project, { lang: WH.i18n.lang });
  }

  function fileName(project, suffix, ext) {
    const same = openedAs && openedAs.stem && project && project.name === openedAs.name;
    const base = WH.util.slug(same ? openedAs.stem : project && project.name, 'wifi');
    return `${base}${suffix ? `-${suffix}` : ''}.${ext}`;
  }

  /** Download the project as an SVG file (floor plan picture + all data in <metadata>). */
  function saveProjectSvg() {
    const p = WH.store.project;
    if (!p) { toast({ i18n: 'io.err.nothing' }, { kind: 'warn' }); return false; }
    try {
      const svg = buildSvg(p);
      const name = fileName(p, '', 'svg');
      WH.util.download(svg, name, 'image/svg+xml;charset=utf-8');
      toast(t('io.ok.saved', { name }), { kind: 'ok' });
      return true;
    } catch (e) {
      if (!(e instanceof IoError)) { console.error('[WH.io] saveProjectSvg:', e); report(e, 'io.saveSvg'); }
      fail(e instanceof IoError ? e : new IoError('export'));
      return false;
    }
  }

  /** Download a 2160 x 1884 PNG of the floor plan (rendered from the same SVG). */
  async function exportPlanPng() {
    const p = WH.store.project;
    if (!p) { toast({ i18n: 'io.err.nothing' }, { kind: 'warn' }); return false; }
    let url = '';
    try {
      let svg = buildSvg(p).replace(/<metadata\b[\s\S]*?<\/metadata>/i, ''); // the data block is irrelevant for a picture
      svg = svg.replace(/<svg\b[^>]*>/i, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, '').replace(/^<svg/, '<svg width="2160" height="1884"'));
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const img = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = 2160;
      c.height = 1884;
      const ctx = c.getContext('2d');
      // white paper in every theme: the exported plan is a document (the same light drawing as the saved SVG), not UI
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      if (!blob) throw new IoError('export');
      const name = fileName(p, WH.i18n.lang === 'cs' ? 'pudorys' : 'plan', 'png');
      WH.util.download(blob, name, 'image/png');
      toast(t('io.ok.png', { name }), { kind: 'ok' });
      return true;
    } catch (e) {
      fail(e instanceof IoError ? e : new IoError('export'));
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  // ===================================================================================================================
  // localStorage (project autosave)
  // ===================================================================================================================
  // Tracing backgrounds (multi-MB data URLs) live under their own keys, one per floor (SPEC 14.3), and are only
  // rewritten when they change. The first floor ('floor-1', every single-floor project) keeps the key of the versions
  // before floors, so an older build still finds its background. The project JSON itself never carries a background.
  let storedBgs = null;      // Map key -> background string in storage (undefined = something unknown); null = not read yet
  let failedBgs = new Set(); // backgrounds that did not fit (do not retry them on every autosave)
  let warnedQuota = false;
  let warnedFatal = false;

  const bgKey = (floorId) => (!floorId || floorId === 'floor-1' ? BG_KEY : `${BG_KEY}:${String(floorId).slice(0, 60)}`);
  const isBgKey = (k) => k === BG_KEY || (typeof k === 'string' && k.startsWith(BG_KEY + ':'));

  /** What this page believes is stored (scans the storage once, so stale keys of deleted floors get removed). */
  function knownBgs() {
    if (storedBgs) return storedBgs;
    storedBgs = new Map();
    try {
      for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (isBgKey(k)) storedBgs.set(k, undefined); }
    } catch (e) { /* storage blocked */ }
    return storedBgs;
  }

  /** The active floor's id of a stored / live project object (null: a project without floors). */
  function activeIdOf(project) {
    try { return engineProject().activeFloorId(project) || null; } catch (e) { return null; }
  }

  /** key -> background of every plan of the project (the active one at the top level, the others inside floors[]). */
  function backgroundsOf(project) {
    const want = new Map();
    want.set(bgKey(activeIdOf(project)), project.plan.background || null);
    if (Array.isArray(project.floors)) {
      for (const fl of project.floors) {
        if (fl && fl.plan && typeof fl.plan === 'object') want.set(bgKey(fl.id), fl.plan.background || null);
      }
    }
    return want;
  }

  /** The project as JSON without any background (they are stored separately). */
  function projectJson(project) {
    const copy = Object.assign({}, project, { plan: Object.assign({}, project.plan, { background: null }) });
    if (Array.isArray(project.floors)) {
      copy.floors = project.floors.map((fl) => (fl && fl.plan && typeof fl.plan === 'object' && fl.plan.background
        ? Object.assign({}, fl, { plan: Object.assign({}, fl.plan, { background: null }) }) : fl));
    }
    return JSON.stringify(copy);
  }

  /** Persist the project. The (large, rarely changing) backgrounds go to their own keys and are only rewritten when they change. */
  function saveLocal(project) {
    if (!project || !project.plan) return { ok: false };
    const stored = knownBgs();
    const want = backgroundsOf(project);
    let dropped = false;
    /** Give up storing every background (quota): the plan itself matters more. */
    const dropAll = () => {
      for (const v of want.values()) if (v) { failedBgs.add(v); dropped = true; }
      for (const k of Array.from(stored.keys())) { try { localStorage.removeItem(k); } catch (e2) { /* ignore */ } }
      stored.clear();
    };
    try {
      // keys of floors that are gone (or lost their background)
      for (const k of Array.from(stored.keys())) {
        if (!want.get(k)) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } stored.delete(k); }
      }
      for (const [k, bg] of want) {
        if (!bg || stored.get(k) === bg) continue;
        if (failedBgs.has(bg)) { dropped = true; continue; }
        try {
          localStorage.setItem(k, bg);
          stored.set(k, bg);
        } catch (e) {
          // this one does not fit: the plan matters more
          dropped = true;
          failedBgs.add(bg);
          try { localStorage.removeItem(k); } catch (e2) { /* ignore */ }
          stored.delete(k);
        }
      }
      const json = projectJson(project);
      try {
        localStorage.setItem(LS_KEY, json);
      } catch (e) {
        // the project no longer fits next to its stored backgrounds (more measurements, a bigger plan): retry
        // without them (SPEC 2.1) instead of losing the autosave altogether
        if (!stored.size) throw e;
        dropAll();
        localStorage.setItem(LS_KEY, json);
      }
      if (dropped && !warnedQuota) {
        warnedQuota = true;
        toast({ i18n: 'io.warn.quota' }, { kind: 'warn', ms: 12000 });
      }
      return { ok: true, droppedBackground: dropped };
    } catch (e) {
      if (!warnedFatal) {
        warnedFatal = true;
        toast({ i18n: 'io.err.quota' }, { kind: 'error', ms: 12000 });
      }
      return { ok: false };
    }
  }

  function getItem(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /** Read the saved project (or migrate an old-version one once). Returns a sanitised Project or null. Never throws. */
  function loadLocal() {
    let ep;
    try { ep = engineProject(); } catch (e) { console.warn('[WH.io] loadLocal: engine not loaded'); return null; }
    const raw = getItem(LS_KEY);
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        if (!obj.plan || typeof obj.plan !== 'object') obj.plan = {};
        const stored = knownBgs();
        const bg = getItem(bgKey(activeIdOf(obj)));
        if (bg) obj.plan.background = bg;
        if (Array.isArray(obj.floors)) {
          for (const fl of obj.floors) {
            if (!fl || !fl.plan || typeof fl.plan !== 'object') continue;
            const fb = getItem(bgKey(fl.id));
            if (fb) fl.plan.background = fb;
          }
        }
        // strict:false = drop single damaged objects instead of losing the whole project
        const project = ep.sanitize(obj, { strict: false, lang: WH.i18n.lang });
        stored.clear();
        for (const [k, v] of backgroundsOf(project)) if (v) stored.set(k, v);
        // keys nobody uses any more (a deleted floor) are removed on the next autosave
        try {
          for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (isBgKey(k) && !stored.has(k)) stored.set(k, undefined); }
        } catch (e) { /* storage blocked */ }
        return project;
      } catch (e) {
        console.warn('[WH.io] the saved project is unreadable (a copy was kept):', e);
        try { localStorage.setItem(BAD_KEY, raw); } catch (e2) { /* keep going */ }
        toast({ i18n: 'io.err.local' }, { kind: 'warn', ms: 10000 });
        return null;
      }
    }
    try {
      const migrated = ep.migrateLegacyStorage(getItem);
      if (migrated) {
        saveLocal(migrated);
        toast({ i18n: 'io.ok.migrated' }, { kind: 'ok' });
        return migrated;
      }
    } catch (e) {
      console.error('[WH.io] migration of the old data failed:', e);
      report(e, 'io.migrate');
    }
    return null;
  }

  /** Remove every key this app (and its older versions) wrote, except UI preferences. */
  function clearLocal() {
    const keys = [LS_KEY, BG_KEY, BAD_KEY].concat(LEGACY_KEYS);
    try {
      for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (isBgKey(k) && !keys.includes(k)) keys.push(k); }
    } catch (e) { /* storage blocked */ }
    for (const k of keys) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    }
    storedBgs = null;
    failedBgs = new Set();
  }

  WH.io = {
    IoError,
    constants: { LS_KEY, BG_KEY, MAX_FILE, MAX_DATA_URL },
    importFile, openPicker, saveProjectSvg, exportPlanPng, saveLocal, loadLocal, clearLocal, rasterizeBackground,
    /** For tests/tools: sanitised copy of a foreign SVG as text. */
    sanitizeSvgText: (text) => passiveSvg(parseSvgDocument(text)),
  };
})();
