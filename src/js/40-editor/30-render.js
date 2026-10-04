/* Floor-plan editor - SVG renderer.
 * World layer (canvas px inside one <g transform>): keyed, incremental updates of rooms, furniture, walls, doors and room
 * labels; strokes use vector-effect:non-scaling-stroke so they keep their on-screen width at any zoom.
 * Overlay layer (screen px, rebuilt per frame - it only holds a handful of shapes): hover/selection outlines, handles,
 * drafts, snap guides, live dimensions, plan-check highlights and the read-only router / today / internet markers. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});
  const W = 1080;
  const H = 942;
  const f2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
  const esc = (s) => WH.util.escapeHtml(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  let svg = null;
  let host = null;
  let world = null;
  let sheet = null;
  let dotPat = null;
  let dotKey = '';
  let hatchPat = null;
  let lastScale = 0;
  let bg = null;
  let bgSrc = null;
  let ghostRef = null;
  const layers = {};
  let ov = null;
  let fontFamily = '';
  let mctx = null;
  const widthCache = new Map();
  const labelCache = new Map();

  // ---------------------------------------------------------------------------------------------------------------
  // build
  // ---------------------------------------------------------------------------------------------------------------
  function build(svgEl, hostEl) {
    svg = svgEl;
    host = hostEl;
    // the drawable canvas is a sheet lying on a dotted design canvas (SPEC 7.5): the sheet (fill + soft shadow) is a
    // DOM box under the svg, the world-space dot grid (on the snap lattice) a screen-space pattern rect above it
    sheet = document.createElement('div');
    sheet.className = 'ed-sheet';
    host.insertBefore(sheet, svg);
    svg.innerHTML = '<defs>'
      + '<pattern id="ed-dots" patternUnits="userSpaceOnUse"><path class="ed-dot"/><path class="ed-dot ed-dot--major"/></pattern>'
      + '<pattern id="ed-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><rect class="ed-hatch-bg" width="8" height="8"/><path class="ed-hatch-line" d="M0 0V8"/></pattern>'
      + '</defs><rect class="ed-dots" width="100%" height="100%" fill="url(#ed-dots)"/><g class="ed-world">'
      + '<image class="ed-bg" x="0" y="0" width="1080" height="942" preserveAspectRatio="none" style="display:none"/>'
      + '<g class="ed-ghost"/><g class="ed-rooms"/><g class="ed-furns"/><g class="ed-walls"/><g class="ed-doors"/><g class="ed-labels"/>'
      + '</g><g class="ed-ov"/>';
    world = svg.querySelector('.ed-world');
    dotPat = svg.querySelector('#ed-dots');
    dotKey = '';
    lastScale = 0;
    hatchPat = svg.querySelector('#ed-hatch');
    bg = svg.querySelector('.ed-bg');
    bgSrc = null;
    for (const k of ['ghost', 'rooms', 'furns', 'walls', 'doors', 'labels']) { layers[k] = svg.querySelector(`.ed-${k}`); layers[k]._map = new Map(); }
    ghostRef = null;
    ov = svg.querySelector('.ed-ov');
    fontFamily = getComputedStyle(svg).fontFamily || 'sans-serif';
  }
  const ready = () => !!(svg && svg.isConnected && ED.S.vp);

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, cls) => { const e = document.createElementNS(NS, tag); if (cls) e.setAttribute('class', cls); return e; };
  const ptsAttr = (pts) => pts.map((p) => `${f2(p.x * W)},${f2(p.y * H)}`).join(' ');

  /** Keyed list sync: create / update (only when the signature changed) / reorder / remove. */
  function sync(group, list, make, sig, update) {
    const map = group._map;
    const seen = new Set();
    let prev = null;
    for (const o of list) {
      seen.add(o.id);
      let e = map.get(o.id);
      if (!e) { e = { el: make(o), sig: null }; map.set(o.id, e); }
      const s = sig(o);
      if (s !== e.sig) { update(e.el, o); e.sig = s; }
      const want = prev ? prev.nextSibling : group.firstChild;
      if (want !== e.el) group.insertBefore(e.el, want);
      prev = e.el;
    }
    for (const [id, e] of map) if (!seen.has(id)) { e.el.remove(); map.delete(id); }
  }

  /** Stroke weight of a wall in screen px (thicker = more loss at 5 GHz). */
  function wallWeight(w) {
    const l = ED.wallLoss(w);
    return l <= 5 ? 3 : l <= 10 ? 4.5 : l <= 16 ? 6 : 7.5;
  }
  const LIGHT = { drywall: 1, glass: 1, wood: 1 };

  // ---------------------------------------------------------------------------------------------------------------
  // world layer
  // ---------------------------------------------------------------------------------------------------------------
  function worldRender() {
    const pl = ED.plan();
    if (!pl) return;
    sync(layers.rooms, pl.rooms, () => mk('polygon', 'ed-room'), (r) => r.color + ptsAttr(r.points), (el, r) => {
      el.setAttribute('points', ptsAttr(r.points));
      el.setAttribute('fill', /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#8eadd2');
    });
    sync(layers.furns, pl.furniture, () => mk('polygon', 'ed-furn'), (f) => (f.blocksSignal === false ? '0' : '1') + ptsAttr(f.points), (el, f) => {
      el.setAttribute('points', ptsAttr(f.points));
      el.classList.toggle('is-soft', f.blocksSignal === false);
    });
    sync(layers.walls, pl.walls, () => mk('line', 'ed-wall'), (w) => `${wallWeight(w)}${w.material || ''}${w.a.x},${w.a.y},${w.b.x},${w.b.y}`, (el, w) => {
      el.setAttribute('x1', f2(w.a.x * W)); el.setAttribute('y1', f2(w.a.y * H));
      el.setAttribute('x2', f2(w.b.x * W)); el.setAttribute('y2', f2(w.b.y * H));
      el.style.setProperty('--ww', wallWeight(w));
      el.classList.toggle('is-light', !!LIGHT[w.material]);
    });
    // a door = an opening cut into its wall + accent jamb ticks at both ends (+ a dashed leaf when closed), the same
    // symbol the Wi-Fi map draws
    const wallById = new Map(pl.walls.map((w) => [w.id, w]));
    sync(layers.doors, pl.doors, () => { const e = mk('g', 'ed-door'); e.append(mk('line', 'ed-door-gap'), mk('line', 'ed-door-line'), mk('path', 'ed-door-jambs')); return e; },
      (d) => { const w = wallById.get(d.wallId); return `${d.loss > 0 ? 1 : 0}${w ? wallWeight(w) : 4}${d.a.x},${d.a.y},${d.b.x},${d.b.y}`; },
      (el, d) => {
        const ax = d.a.x * W; const ay = d.a.y * H; const bx = d.b.x * W; const by = d.b.y * H;
        for (const ln of [el.childNodes[0], el.childNodes[1]]) {
          ln.setAttribute('x1', f2(ax)); ln.setAttribute('y1', f2(ay));
          ln.setAttribute('x2', f2(bx)); ln.setAttribute('y2', f2(by));
        }
        const w = wallById.get(d.wallId);
        const ww = w ? wallWeight(w) : 4;
        el.style.setProperty('--ww', ww);
        el.classList.toggle('is-open', !(d.loss > 0));
        const len = Math.hypot(bx - ax, by - ay) || 1;
        el._j = { ax, ay, bx, by, nx: -(by - ay) / len, ny: (bx - ax) / len, half: Math.max(5.5, ww / 2 + 3) };
        jambs(el, ED.S.vp ? ED.S.vp.view.scale : 1);
      });
    sync(layers.labels, pl.rooms, () => { const e = mk('g', 'ed-label'); e.append(mk('text', 'ed-label__name'), mk('text', 'ed-label__sub')); return e; },
      (r) => `${r.name}|${ED.mpp()}|${ptsAttr(r.points)}`, (el, r) => {
        el.firstChild.textContent = r.name;
        el.lastChild.textContent = ED.fmtArea(r.points);
        el._room = r.id;
      });
    // tracing background (the data URL can be megabytes: only touch the attribute when it changed)
    const src = pl.background || null;
    if (src !== bgSrc) {
      bgSrc = src;
      if (src) bg.setAttribute('href', src); else bg.removeAttribute('href');
    }
    bg.style.display = src && ED.pref('bg') ? '' : 'none';
    bg.setAttribute('opacity', String(ED.bgAlpha()));
    ghostRender();
    for (const id of labelCache.keys()) if (!layers.labels._map.has(id)) labelCache.delete(id);
  }

  /** The floor below the active one, faint under the plan (SPEC 14.3: aligning the walls of two floors). Rebuilt only
   *  when that plan changes (it cannot be edited while another floor is active). */
  function ghostRender() {
    const gp = ED.floors ? ED.floors.ghostPlan() : null;
    if (gp === ghostRef) return;
    ghostRef = gp;
    const parts = [];
    if (gp) {
      for (const r of gp.rooms) parts.push(`<polygon class="ed-ghost-room" points="${ptsAttr(r.points)}"/>`);
      for (const w of gp.walls) parts.push(`<line class="ed-ghost-wall" x1="${f2(w.a.x * W)}" y1="${f2(w.a.y * H)}" x2="${f2(w.b.x * W)}" y2="${f2(w.b.y * H)}"/>`);
    }
    layers.ghost.innerHTML = parts.join('');
  }

  /** Jamb ticks of a door: screen-constant length across its wall (world coordinates, so they follow the zoom). */
  function jambs(el, s) {
    const j = el._j;
    if (!j) return;
    const L = (j.half * (ED.S.zf || 1)) / s;
    const dx = j.nx * L;
    const dy = j.ny * L;
    el.lastChild.setAttribute('d', `M${f2(j.ax - dx)} ${f2(j.ay - dy)}L${f2(j.ax + dx)} ${f2(j.ay + dy)}M${f2(j.bx - dx)} ${f2(j.by - dy)}L${f2(j.bx + dx)} ${f2(j.by + dy)}`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // labels: name (+ area) at the visual centre, font adapts to zoom but never overflows the room
  // ---------------------------------------------------------------------------------------------------------------
  function textW(text, weight) {
    const k = `${weight}|${text}`;
    let w = widthCache.get(k);
    if (w === undefined) {
      if (!mctx) mctx = document.createElement('canvas').getContext('2d');
      mctx.font = `${weight} 100px ${fontFamily}`;
      w = mctx.measureText(text).width / 100;
      if (widthCache.size > 2000) widthCache.clear();
      widthCache.set(k, w);
    }
    return w;
  }

  /** Interval [lo, hi] (normalized) of the horizontal or vertical line through p that lies inside the polygon. */
  function span(pts, p, horiz) {
    const xs = [];
    const n = pts.length;
    for (let i = 0; i < n; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (horiz) { if ((a.y > p.y) !== (b.y > p.y)) xs.push(a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)); } else if ((a.x > p.x) !== (b.x > p.x)) xs.push(a.y + ((p.x - a.x) * (b.y - a.y)) / (b.x - a.x));
    }
    xs.sort((u, v) => u - v);
    const v = horiz ? p.x : p.y;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i] <= v && v <= xs[i + 1]) return [xs[i], xs[i + 1]];
    return [v, v];
  }

  /** Label anchor: the pole of inaccessibility, then centred along the free horizontal / vertical line through it
   *  (a long corridor has many equally good poles; centring keeps its label in the middle). */
  function labelGeom(r) {
    const key = ptsAttr(r.points);
    let c = labelCache.get(r.id);
    if (!c || c.key !== key) {
      const lp = WH.engine.geom.labelPoint(r.points);
      const h = span(r.points, lp, true);
      const p1 = { x: (h[0] + h[1]) / 2, y: lp.y };
      const v = span(r.points, p1, false);
      const p2 = { x: p1.x, y: (v[0] + v[1]) / 2 };
      const h2 = span(r.points, p2, true);
      const ok = WH.engine.geom.pointInPolygon(p2, r.points) && h2[1] - h2[0] >= (h[1] - h[0]) * 0.8;
      const at = ok ? p2 : lp;
      const hs = ok ? h2 : h;
      const vs = span(r.points, at, false);
      c = { key, lp: at, hs: (hs[1] - hs[0]) * W, vs: (vs[1] - vs[0]) * H };
      labelCache.set(r.id, c);
    }
    return c;
  }

  function labelsRender(s, zf) {
    const base = clamp(12.5 * Math.sqrt(zf), 12, 15);
    const halo = 3 / s;
    layers.labels.setAttribute('stroke-width', String(Math.round(halo * 1000) / 1000));
    for (const e of layers.labels._map.values()) {
      const el = e.el;
      const r = ED.find(el._room);
      if (!r) continue;
      const c = labelGeom(r);
      const name = el.firstChild;
      const sub = el.lastChild;
      const availW = c.hs * s - 10;
      const availH = c.vs * s - 6;
      const wn = textW(r.name, 650);
      let fs = base;
      if (wn * fs > availW) fs = availW / wn;
      if (fs * 1.25 > availH) fs = availH / 1.25;
      const showName = fs >= 8.5 && r.name.trim() !== '';
      const fs2 = Math.min(fs * 0.84, 12.5);
      const showSub = showName && fs * 1.2 + fs2 * 1.25 + 4 <= availH && textW(sub.textContent, 500) * fs2 <= availW;
      el.style.display = showName ? '' : 'none';
      if (!showName) continue;
      const x = f2(c.lp.x * W);
      const y = c.lp.y * H;
      name.setAttribute('x', x);
      name.setAttribute('y', f2(showSub ? y - (fs2 * 0.62) / s : y));
      name.setAttribute('font-size', String(f2((fs / s) * 1000) / 1000));
      sub.style.display = showSub ? '' : 'none';
      if (showSub) {
        sub.setAttribute('x', x);
        sub.setAttribute('y', f2(y + (fs * 0.66) / s));
        sub.setAttribute('font-size', String(f2((fs2 / s) * 1000) / 1000));
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // view (pan / zoom): transform, grid density, hatch size, stroke factor, labels
  // ---------------------------------------------------------------------------------------------------------------
  // WH.viewport measures host-relative px from the stage's padding box (inside the 1 px border), which is exactly where
  // the inset:0 <svg> starts - so the world transform and the overlay need no border compensation.
  function viewRender() {
    const vp = ED.S.vp;
    const v = vp.view;
    world.setAttribute('transform', `translate(${f2(v.tx)} ${f2(v.ty)}) scale(${v.scale})`);
    const zf = clamp(Math.sqrt(v.scale / (vp.fitScale || 1)), 0.8, 2);
    const zfChanged = f2(zf) !== ED.S.zf;
    ED.S.zf = f2(zf);
    svg.style.setProperty('--zf', ED.S.zf);
    sheet.style.transform = `translate(${f2(v.tx)}px, ${f2(v.ty)}px)`;
    sheet.style.width = `${f2(W * v.scale)}px`;
    sheet.style.height = `${f2(H * v.scale)}px`;
    dots(v);
    if (v.scale !== lastScale || zfChanged) {
      lastScale = v.scale;
      hatchPat.setAttribute('patternTransform', `rotate(45) scale(${f2((1 / v.scale) * 1000) / 1000})`);
      for (const e of layers.doors._map.values()) jambs(e.el, v.scale);
    }
    labelsRender(v.scale, zf);
  }

  /** Dot grid on the snap lattice (1 % of the canvas): every k-th lattice point so that dots stay ~14-35 px apart on
   *  screen, every 5th dot of that level a little stronger; the radius is constant in screen px. */
  function dots(v) {
    let k = 1;
    for (const c of [1, 2, 5, 10, 20, 50]) { k = c; if (10.8 * c * v.scale >= 14) break; }
    dotPat.setAttribute('patternTransform', `translate(${f2(v.tx)} ${f2(v.ty)}) scale(${v.scale})`);
    const key = `${k}|${v.scale}`;
    if (key === dotKey) return;
    dotKey = key;
    const gx = 10.8 * k;
    const gy = 9.42 * k;
    dotPat.setAttribute('x', String(-gx / 2));
    dotPat.setAttribute('y', String(-gy / 2));
    dotPat.setAttribute('width', String(gx * 5));
    dotPat.setAttribute('height', String(gy * 5));
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const circ = (x, y, r) => `M${r3(x - r)} ${r3(y)}a${r3(r)} ${r3(r)} 0 1 0 ${r3(2 * r)} 0a${r3(r)} ${r3(r)} 0 1 0 ${r3(-2 * r)} 0`;
    const rm = 0.65 / v.scale;
    let d = '';
    for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) if (i || j) d += circ(gx * (i + 0.5), gy * (j + 0.5), rm);
    dotPat.firstChild.setAttribute('d', d);
    dotPat.lastChild.setAttribute('d', circ(gx / 2, gy / 2, 0.75 / v.scale));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // overlay (screen space)
  // ---------------------------------------------------------------------------------------------------------------
  function scr(p) { return ED.S.vp.toScreen(p); }
  const pstr = (pts) => pts.map((p) => { const q = scr(p); return `${f2(q.x)},${f2(q.y)}`; }).join(' ');

  /** Handles of the selected object in screen px: {kind:'v'|'m'|'a'|'b', i, x, y}. */
  function handles() {
    const S = ED.S;
    const o = S.sel && ED.find(S.sel);
    if (!o || !S.vp) return [];
    const out = [];
    if (o.points) {
      const n = o.points.length;
      const sp = o.points.map(scr);
      sp.forEach((q, i) => out.push({ kind: 'v', i, x: q.x, y: q.y }));
      if (n < 200) {
        for (let i = 0; i < n; i += 1) {
          const a = sp[i];
          const b = sp[(i + 1) % n];
          if (Math.hypot(b.x - a.x, b.y - a.y) >= 44) out.push({ kind: 'm', i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
    } else {
      const a = scr(o.a);
      const b = scr(o.b);
      out.push({ kind: 'a', i: 0, x: a.x, y: a.y }, { kind: 'b', i: 1, x: b.x, y: b.y });
    }
    return out;
  }

  function pill(parts, x, y, text, small) {
    const fs = small ? 11 : 12;
    const h = small ? 18 : 22;
    const w = textW(text, 600) * fs + (small ? 12 : 16);
    const sz = ED.S.vp.size;
    const px = clamp(x, w / 2 + 4, Math.max(w / 2 + 4, sz.w - w / 2 - 4));
    const py = clamp(y, h / 2 + 4, Math.max(h / 2 + 4, sz.h - h / 2 - 4));
    parts.push(`<g class="ed-pill${small ? ' ed-pill--dim' : ''}" transform="translate(${f2(px)} ${f2(py)})"><rect x="${f2(-w / 2)}" y="${-h / 2}" width="${f2(w)}" height="${h}" rx="${h / 2}"/><text y="0.5">${esc(text)}</text></g>`);
  }

  /** Live dimensions (SPEC 14.1): the length of every edge of a polygon that is long enough on screen, as a small pill
   *  just outside the edge (`closed` = polygon, else an open chain). */
  function edgeDims(parts, pts, closed) {
    const sp = pts.map(scr);
    const n = sp.length;
    if (n < 2) return;
    let cx = 0;
    let cy = 0;
    for (const q of sp) { cx += q.x; cy += q.y; }
    cx /= n;
    cy /= n;
    for (let i = 0; i < (closed ? n : n - 1); i += 1) {
      const a = sp[i];
      const b = sp[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 64) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      let nx = -(b.y - a.y) / len;
      let ny = (b.x - a.x) / len;
      if (closed && (mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
      // clear of the edge and its midpoint handle whatever the edge's direction: half the pill's extent along the
      // normal + a gap (a vertical edge needs half the pill's WIDTH, a horizontal one half its height)
      const text = ED.fmtM(ED.dpx(pts[i], pts[(i + 1) % n]));
      const d = 9 + Math.abs(nx) * (textW(text, 600) * 11 + 12) / 2 + Math.abs(ny) * 9;
      pill(parts, mx + nx * d, my + ny * d, text, true);
    }
  }

  /** "3,2 × 4,0 m · 12,8 m²" of an axis-aligned rectangle (rooms) / "3,2 × 4,0 m" (furniture). */
  function rectLabel(a, b, withArea) {
    const w = Math.abs(b.x - a.x) * W;
    const h = Math.abs(b.y - a.y) * H;
    const base = `${ED.fmtM(w, false)} × ${ED.fmtM(h)}`;
    return withArea ? `${base} · ${WH.util.fmt(w * h * ED.mpp() * ED.mpp(), 1)}${WH.util.NBSP}m²` : base;
  }

  function outline(parts, o, cls) {
    if (o.points) parts.push(`<polygon class="${cls}" points="${pstr(o.points)}"/>`);
    else { const a = scr(o.a); const b = scr(o.b); parts.push(`<line class="${cls} ${cls}--line" x1="${f2(a.x)}" y1="${f2(a.y)}" x2="${f2(b.x)}" y2="${f2(b.y)}"/>`); }
  }

  function marker(parts, p, cls, icon) {
    const q = scr(p);
    parts.push(`<g class="ed-marker ${cls}" transform="translate(${f2(q.x)} ${f2(q.y)})"><circle r="12"/>${WH.ui.iconHtml(icon, 16).replace('<svg ', '<svg x="-8" y="-8" ')}</g>`);
  }

  function overlayRender() {
    const S = ED.S;
    const pl = ED.plan();
    const pr = ED.proj();
    if (!pl || !S.vp) { ov.innerHTML = ''; return; }
    const parts = [];
    // plan-check highlight
    if (S.focus) {
      const gm = S.focus.geom || {};
      for (const poly of gm.polys || []) parts.push(`<polygon class="ed-issue" points="${pstr(poly)}"/>`);
      for (const [a, b] of gm.segs || []) { const p = scr(a); const q = scr(b); parts.push(`<line class="ed-issue ed-issue--line" x1="${f2(p.x)}" y1="${f2(p.y)}" x2="${f2(q.x)}" y2="${f2(q.y)}"/>`); }
      if (gm.pts) {
        const [a, b] = gm.pts.map(scr);
        parts.push(`<circle class="ed-issue" cx="${f2((a.x + b.x) / 2)}" cy="${f2((a.y + b.y) / 2)}" r="${f2(Math.max(16, Math.hypot(b.x - a.x, b.y - a.y) / 2 + 10))}"/>`);
      }
    }
    // hover + selection
    const hov = S.tool === 'select' && S.hover && S.hover !== S.sel ? ED.find(S.hover) : null;
    if (hov) outline(parts, hov, 'ed-hover');
    const sel = S.sel ? ED.find(S.sel) : null;
    if (sel) {
      outline(parts, sel, 'ed-sel');
      // live dimensions of the selection: edge lengths of a room / furniture piece, the length of a wall or door
      if (S.tool === 'select') {
        if (sel.points) edgeDims(parts, sel.points, true);
        else if (!(S.drag && S.drag.label)) edgeDims(parts, [sel.a, sel.b], false);
      }
      if (S.tool === 'select') {
        for (const h of handles()) {
          const hot = S.hoverHandle && S.hoverHandle.kind === h.kind && S.hoverHandle.i === h.i;
          if (h.kind === 'm') parts.push(`<circle class="ed-handle ed-handle--mid${hot ? ' is-hot' : ''}" cx="${f2(h.x)}" cy="${f2(h.y)}" r="4.5"/>`);
          else parts.push(`<circle class="ed-handle${hot ? ' is-hot' : ''}" cx="${f2(h.x)}" cy="${f2(h.y)}" r="${hot ? 7 : 6}"/>`);
        }
      }
      if (S.drag && S.drag.label) { const q = scr(S.drag.at); pill(parts, q.x + 18, q.y - 22, S.drag.label); }
    }
    draftRender(parts, S);
    // read-only markers (they are moved in the Wi-Fi view)
    // (only the ones on the floor shown here: net.routerFloor / net.opticFloor, SPEC 14.3)
    if (pr && pr.net && pl.rooms.length) {
      const G = WH.engine.geom;
      const rHere = ED.onActiveFloor(pr.net.routerFloor);
      if (pr.net.optic && ED.onActiveFloor(pr.net.opticFloor)) marker(parts, pr.net.optic, 'ed-marker--inlet', 'globe');
      if (rHere && pr.net.baseline && pr.net.router && G.dist(pr.net.baseline, pr.net.router) > 2) marker(parts, pr.net.baseline, 'ed-marker--today', 'home');
      if (rHere && pr.net.router) marker(parts, pr.net.router, 'ed-marker--router', 'router');
    }
    ov.innerHTML = parts.join('');
  }

  function draftRender(parts, S) {
    const d = S.draft;
    const cur = S.cur;
    if (S.tool === 'door' && S.doorPreview) {
      const p = scr(S.doorPreview.a);
      const q = scr(S.doorPreview.b);
      parts.push(`<line class="ed-door-ghost" x1="${f2(p.x)}" y1="${f2(p.y)}" x2="${f2(q.x)}" y2="${f2(q.y)}"/>`);
      pill(parts, (p.x + q.x) / 2, Math.min(p.y, q.y) - 22, ED.fmtM(ED.dpx(S.doorPreview.a, S.doorPreview.b)));
    }
    if (d) {
      if ((d.kind === 'rect') && d.a && cur) {
        const pts = WH.engine.geom.rectPoints(d.a, cur);
        parts.push(`<polygon class="ed-draft" points="${pstr(pts)}"/>`);
        const q = scr(cur);
        pill(parts, q.x + 18, q.y + 26, rectLabel(d.a, cur, S.tool === 'rect'));
      } else if (d.kind === 'poly' && d.pts.length) {
        const pts = d.pts.concat(cur && !S.closeHover ? [cur] : []);
        if (pts.length >= 3) {
          parts.push(`<polygon class="ed-draft ed-draft--fill" points="${pstr(pts)}"/>`);
          // the area of the outline so far, in the middle of it
          const c = WH.engine.geom.polygonCentroid(pts);
          if (WH.engine.geom.pointInPolygon(c, pts)) { const q = scr(c); pill(parts, q.x, q.y, `≈${WH.util.NBSP}${ED.fmtArea(pts)}`, true); }
        }
        parts.push(`<polyline class="ed-draft-line" points="${pstr(d.pts)}"/>`);
        const last = d.pts[d.pts.length - 1];
        const tgt = S.closeHover ? d.pts[0] : cur;
        if (tgt) {
          const a = scr(last);
          const b = scr(tgt);
          parts.push(`<line class="ed-draft-line ed-draft-line--live${S.polyBad ? ' is-bad' : ''}" x1="${f2(a.x)}" y1="${f2(a.y)}" x2="${f2(b.x)}" y2="${f2(b.y)}"/>`);
          if (ED.dpx(last, tgt) >= 2) pill(parts, b.x + 18, b.y + 26, ED.fmtM(ED.dpx(last, tgt)));
        }
        d.pts.forEach((p, i) => { const q = scr(p); parts.push(`<circle class="ed-draft-pt${i === 0 && S.closeHover ? ' is-close' : ''}" cx="${f2(q.x)}" cy="${f2(q.y)}" r="${i === 0 ? 6 : 4}"/>`); });
      } else if ((d.kind === 'wall' || d.kind === 'scale') && d.a) {
        const end = d.b || cur;
        const a = scr(d.a);
        parts.push(`<circle class="ed-draft-pt" cx="${f2(a.x)}" cy="${f2(a.y)}" r="4.5"/>`);
        if (end) {
          const b = scr(end);
          parts.push(`<line class="${d.kind === 'scale' ? 'ed-measure' : 'ed-draft-wall'}" x1="${f2(a.x)}" y1="${f2(a.y)}" x2="${f2(b.x)}" y2="${f2(b.y)}"/>`);
          if (d.kind === 'scale') {
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const nx = (-(b.y - a.y) / len) * 7;
            const ny = ((b.x - a.x) / len) * 7;
            for (const q of [a, b]) parts.push(`<line class="ed-measure" x1="${f2(q.x - nx)}" y1="${f2(q.y - ny)}" x2="${f2(q.x + nx)}" y2="${f2(q.y + ny)}"/>`);
          }
          if (!d.asking && ED.dpx(d.a, end) >= 2) pill(parts, b.x + 18, b.y + 26, ED.fmtM(ED.dpx(d.a, end)));
        }
      }
    }
    // snap guide + landing dot of the drawing tools
    if (cur && S.tool !== 'select' && S.tool !== 'door' && !(d && d.asking)) {
      const q = scr(cur);
      if (cur.kind === 'edge' && cur.a && cur.b) { const a = scr(cur.a); const b = scr(cur.b); parts.push(`<line class="ed-snap-edge" x1="${f2(a.x)}" y1="${f2(a.y)}" x2="${f2(b.x)}" y2="${f2(b.y)}"/>`); }
      if (cur.kind === 'vertex' || cur.kind === 'edge') parts.push(`<circle class="ed-snap-ring" cx="${f2(q.x)}" cy="${f2(q.y)}" r="8"/>`);
      parts.push(`<circle class="ed-cursor-dot" cx="${f2(q.x)}" cy="${f2(q.y)}" r="3"/>`);
    }
  }

  ED.render = { build, ready, world: worldRender, view: viewRender, overlay: overlayRender, handles, scr, textW };
})();
