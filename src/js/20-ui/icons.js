/* WH.ui.icon(name, size = 20) - inline SVG icon set (24x24 grid, 1.75 px round stroke, currentColor).
 * Unknown names fall back to the "help" icon (and warn once). WH.ui.icon.names() lists every icon. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  g.WH.ui = g.WH.ui || {};

  const dot = (x, y) => `<path d="M${x} ${y}h.01"/>`;
  const fillDot = (x, y, r = 1.3) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;

  /** Inner markup of every icon. Keep shapes inside the 3..21 box so they line up optically. */
  const P = {
    // --- modes & tools -------------------------------------------------------------------------------------------
    plan: '<path d="M4 4h16v16H4z"/><path d="M4 11h8V4M12 15v5M12 15h8"/>',
    wifi: `<path d="M2.5 9a15 15 0 0 1 19 0"/><path d="M5.6 12.6a10.4 10.4 0 0 1 12.8 0"/><path d="M8.8 16a5.9 5.9 0 0 1 6.4 0"/>${fillDot(12, 19.4, 1.1)}`,
    cursor: '<path d="M5.25 5.1l13.5 6.2-5.7 1.8-2.2 5.8z"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
    polygon: `<path d="M12 4l8 5.5-3 10H7L4 9.5z"/>${fillDot(12, 4, 1.4)}${fillDot(20, 9.5, 1.4)}${fillDot(17, 19.5, 1.4)}${fillDot(7, 19.5, 1.4)}${fillDot(4, 9.5, 1.4)}`,
    wall: '<path d="M3 6h18v12H3zM3 10h18M3 14h18M9 6v4M15 10v4M9 14v4"/>',
    door: `<path d="M6 21V4h12v17"/><path d="M3 21h18"/>${fillDot(15, 13, 1)}`,
    sofa: '<g transform="translate(0 -1)"><path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M3 13a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v5H3z"/><path d="M5.5 18v2M18.5 18v2"/></g>',
    ruler: '<path d="M3.5 16.5L16.5 3.5l4 4-13 13z"/><path d="M7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2"/>',
    autowall: '<path d="M3 3h18v18H3z" stroke-dasharray="2.5 2.5"/><path d="M8 8h8v8H8z"/>',
    move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
    // --- history / view ------------------------------------------------------------------------------------------
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16M11 8v6M8 11h6"/>',
    'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16M8 11h6"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    grid: '<path d="M4 4h16v16H4zM4 9.33h16M4 14.67h16M9.33 4v16M14.67 4v16"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
    layers: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5"/>',
    eye: '<path d="M2.6 12s3.4-6.6 9.4-6.6S21.4 12 21.4 12s-3.4 6.6-9.4 6.6S2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M9.9 5.6A9.4 9.4 0 0 1 12 5.4c6 0 9.4 6.6 9.4 6.6a16.5 16.5 0 0 1-3.1 3.9M6.4 7C3.9 8.6 2.6 12 2.6 12s3.4 6.6 9.4 6.6c1.5 0 2.8-.4 4-.9M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="M3.5 3.5l17 17"/>',
    // --- network objects -----------------------------------------------------------------------------------------
    router: `<rect x="3" y="13" width="18" height="7" rx="2"/>${dot(7, 16.5)}${dot(11, 16.5)}<path d="M7.5 13L5.5 5.5M16.5 13l2-7.5"/>`,
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
    pin: '<path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    sparkles: '<path d="M10.5 3.5l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2L3.5 10.5l5.2-1.8z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    target: `<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>${fillDot(12, 12, 1)}`,
    measure: `<circle cx="12" cy="12" r="6"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>${fillDot(12, 12, 1.2)}`,
    antenna: `<g transform="translate(0 -1)"><path d="M12 12v9M8.5 21h7"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>${fillDot(12, 12, 1.4)}</g>`,
    node: '<g transform="translate(0 -0.75)"><circle cx="12" cy="16" r="3.5"/><path d="M7.6 11.8a6 6 0 0 1 8.8 0M4.9 9a9.8 9.8 0 0 1 14.2 0"/></g>',
    mesh: '<circle cx="6" cy="6.5" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9.5" cy="18" r="2.5"/><path d="M8.4 7.2l7.2 1M7.2 15.6L6.4 9M16.4 11.2l-5 5.1"/>',
    repeater: '<path d="M3 12h4.5l2.5-6.5 4 13 2.5-6.5H21"/>',
    cable: '<g transform="translate(2 0)"><path d="M8 3v5M12 3v5"/><path d="M6 8h8v4.5a4 4 0 0 1-8 0z"/><path d="M10 16.5V21"/></g>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3.4 3.2 14.6 0 18M12 3c-3.2 3.4-3.2 14.6 0 18"/>',
    speed: `<g transform="translate(0 1)"><path d="M4.3 17a8.5 8.5 0 1 1 15.4 0"/><path d="M12 14.2L16 8.5"/>${fillDot(12, 14.5, 1.4)}</g>`,
    signal: '<path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/>',
    gauge: '<g transform="translate(0 1)"><path d="M4.3 17a8.5 8.5 0 1 1 15.4 0"/><path d="M12 13.5V8"/><path d="M8.2 6.4l.8 1.3M15.8 6.4l-.8 1.3"/></g>',
    // --- furniture presets ---------------------------------------------------------------------------------------
    bed: '<path d="M3 19V6M3 15h18v4M21 15v-2.5A2.5 2.5 0 0 0 18.5 10H11v5"/><circle cx="7" cy="11.5" r="1.8"/>',
    box: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
    fridge: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M6 10h12M9 6.2v1.6M9 13v2.5"/>',
    books: '<g transform="translate(-1.4 0)"><path d="M4.5 4h3.5v16H4.5zM10 4h3.5v16H10z"/><path d="M15.7 6.2l3.3-.9 3.4 13.8-3.3.9z"/></g>',
    table: '<g transform="translate(0 -1.5)"><path d="M3 8h18M5 8v11M19 8v11M8 8v3.5M16 8v3.5"/></g>',
    // --- file / io -----------------------------------------------------------------------------------------------
    'folder-open': '<path d="M3 18.5V6a1 1 0 0 1 1-1h4.6l2 2.4h6.9a1 1 0 0 1 1 1V10"/><path d="M3 18.5L5.5 11H21l-2.5 7.5z"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
    save: '<path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
    'file-image': '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><circle cx="10" cy="12.5" r="1.3"/><path d="M18 18l-3.5-3.5L8 20"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    // --- generic actions -----------------------------------------------------------------------------------------
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    edit: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    'arrow-right': '<path d="M4 12h16M14 6l6 6-6 6"/>',
    'arrow-left': '<path d="M20 12H4M10 6l-6 6 6 6"/>',
    'arrow-up': '<path d="M12 20V4M6 10l6-6 6 6"/>',
    'arrow-down': '<path d="M12 4v16M6 14l6 6 6-6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    more: `${fillDot(5, 12, 1.5)}${fillDot(12, 12, 1.5)}${fillDot(19, 12, 1.5)}`,
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    list: `<path d="M9 6h11M9 12h11M9 18h11"/>${dot(4.5, 6)}${dot(4.5, 12)}${dot(4.5, 18)}`,
    palette: `<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.9-.9 1.6-1.9-.3-1 .3-2.1 1.6-2.1H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/>${fillDot(7.5, 11.5, 1)}${fillDot(10, 7.5, 1)}${fillDot(15, 7.8, 1)}`,
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-3.6M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 3.6M20 20v-4h-4"/>',
    play: '<path d="M6 4.5v15l12-7.5z"/>',
    flag: '<g transform="translate(1.5 0)"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></g>',
    lightbulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    // --- status & chrome -----------------------------------------------------------------------------------------
    help: `<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4.1"/>${dot(12, 17.6)}`,
    keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2"/>${dot(6, 10)}${dot(10, 10)}${dot(14, 10)}${dot(18, 10)}${dot(6, 14)}${dot(18, 14)}<path d="M9 14h6"/>`,
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
    // OLED black theme (SPEC 12): the moon with a small star in its hollow (the star stays >= 1 unit clear of the moon)
    'moon-star': '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/><path d="M16.4 5l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8z"/>',
    contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
    info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/>${dot(12, 7.8)}`,
    warning: `<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/>${dot(12, 17.3)}`,
    'alert-circle': `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/>${dot(12, 16.2)}`,
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16.2 9.4"/>',
    circle: '<circle cx="12" cy="12" r="8.5"/>',
    // The "?" of the round hint button (SPEC 7.2): a drawn glyph instead of a font character, so it is centred the same
    // way in every font and OS. Bolder stroke than the set (it stands alone in an 18 px circle); its ink box (hook top
    // 5.89 .. dot bottom 18.08, x 8.15 .. 15.86) is centred on 12/12.
    'help-q': `<path d="M9.35 9.75A2.66 2.66 0 1 1 13.33 12.05C12.86 12.32 12 12.72 12 13.26V13.62" stroke-width="2.4"/>${fillDot(12, 16.82, 1.26)}`,
    // --- devices (measurement device picker, SPEC 7.4) -------------------------------------------------------------
    phone: `<rect x="7" y="2.5" width="10" height="19" rx="2.2"/>${dot(12, 18.4)}`,
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 19h19"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    desktop: '<g transform="translate(0 .25)"><rect x="2.5" y="4" width="13.5" height="10.5" rx="1.5"/><path d="M9.25 14.5V19M6.25 19.5h6"/><path d="M19 4h1.5a1 1 0 0 1 1 1v13.5a1 1 0 0 1-1 1H19a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M19.75 7.5h.01"/></g>',
    tablet: `<rect x="4.5" y="3" width="15" height="18" rx="2.2"/>${dot(12, 17.9)}`,
    board: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="10" y="10" width="4" height="4" rx=".6"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
    tv: '<g transform="translate(0 1.25)"><rect x="2.5" y="6.5" width="19" height="12" rx="2"/><path d="M8.5 3l3.5 3.5L15.5 3"/></g>',
    gamepad: `<path d="M8.2 7h7.6a4.6 4.6 0 0 1 4.45 3.43l.9 3.47a2.55 2.55 0 0 1-4.25 2.5L15 14.5H9l-1.9 1.9a2.55 2.55 0 0 1-4.25-2.5l.9-3.47A4.6 4.6 0 0 1 8.2 7z"/><path d="M8 9.5v3M6.5 11h3"/>${fillDot(15.5, 10.1, 1)}${fillDot(17.3, 11.9, 1)}`,
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
  };

  const NAMES = Object.keys(P);
  let warned = false;
  /** Optical recentring (stage 5 pixel audit): these shapes are drawn off the 12/12 centre by up to 0.75 units (a
   *  router's antennas, a door's floor line...), which shows as a glyph sitting low / to one side in a round button.
   *  Shifting the whole drawing puts the centre of its ink box on the centre of the 24 box (measured at 4 px/unit). */
  const NUDGE = { wifi: [0, -0.625], door: [0, -0.5], layers: [0, -0.5], router: [0, -0.75], home: [0, 0.5], sparkles: [-0.5, 0], signal: [-0.5, 0], bed: [0, -0.5], lock: [0, -0.5], flag: [0, -0.5], moon: [0.375, -0.375], 'moon-star': [0.375, -0.375],
    // magnifiers: lens at 11/11 + handle to 20.5 -> ink box 3.1..21.4, centre 12.25
    'zoom-in': [-0.25, -0.25], 'zoom-out': [-0.25, -0.25], search: [-0.25, -0.25] };

  /** Icons are only ever rendered at 16, 18, 20 or 24 px (SPEC 1.8.1): other sizes snap to the nearest allowed one. */
  function snap(size) {
    const n = Number(size) || 20;
    return n <= 16 ? 16 : n <= 18 ? 18 : n <= 20 ? 20 : 24;
  }

  function markup(name) {
    let inner = P[name];
    if (inner === undefined) {
      if (!warned) { warned = true; console.warn(`[WH.ui.icon] unknown icon "${name}"`); }
      inner = P.help;
    }
    const n = NUDGE[name];
    return n ? `<g transform="translate(${n[0]} ${n[1]})">${inner}</g>` : inner;
  }

  /** Returns an <svg class="icon icon-NAME"> element. size in px (default 20). */
  function icon(name, size = 20) {
    size = snap(size);
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', `icon icon-${name}`);
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.75');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.innerHTML = markup(name);
    return s;
  }

  /** Same icon as an HTML string (for template literals). */
  function iconHtml(name, size = 20) {
    size = snap(size);
    return `<svg class="icon icon-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${markup(name)}</svg>`;
  }

  icon.names = () => NAMES.slice();
  icon.has = (n) => Object.prototype.hasOwnProperty.call(P, n);

  g.WH.ui.icon = icon;
  g.WH.ui.iconHtml = iconHtml;
})();
