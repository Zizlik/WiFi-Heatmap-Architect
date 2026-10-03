/* WH.ui.keys - one shortcut registry for the whole app (SPEC 1.6).
 *
 *   const off = WH.ui.keys.register({
 *     mode: 'planner',            // 'global' | 'planner' | 'editor' (or an array); scoped modes are active only in that view
 *     key: 'r',                   // 'ctrl+s', 'shift+/', 'arrowleft', 'escape', '?', ['ctrl+shift+z', 'ctrl+y'] ...
 *     i18n: 'planner.keys.router',// description shown in the cheat sheet
 *     run(e) { ... },             // return false to say "not handled" (the browser default then still happens)
 *     // optional: group (cheat-sheet heading key), when() -> bool, allowTyping, allowInModal, repeat, anyShift, hidden
 *   });
 *   WH.ui.keys.sheet()            // cheat-sheet dialog generated from the registrations
 *
 * Rules: 'ctrl' means Ctrl OR Cmd.  Keys are matched on what the keyboard layout produces (e.key), so Czech QWERTZ
 * users get the letters printed on their keys; letter keys fall back to the physical position on non-Latin layouts.
 * Shortcuts are ignored while the user types in an input/select/textarea (unless allowTyping) and while a modal
 * dialog is open (unless allowInModal).  Shift is ignored for digits and symbols (they need Shift on some layouts). */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const ui = (g.WH.ui = g.WH.ui || {});

  const t = (k, p) => g.WH.i18n.t(k, p);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

  const ALIAS = {
    esc: 'escape', del: 'delete', return: 'enter', space: ' ', spacebar: ' ', plus: '+', minus: '-',
    left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown',
    '←': 'arrowleft', '→': 'arrowright', '↑': 'arrowup', '↓': 'arrowdown', '⌫': 'backspace',
  };
  const DISPLAY = {
    escape: 'Esc', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', enter: 'Enter',
    ' ': 'Space', delete: 'Del', backspace: '⌫', tab: 'Tab',
  };
  const NEEDS_SHIFT_MATCH = (k) => /^[a-z]$/.test(k) || ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'enter', 'tab', 'escape', 'delete', 'backspace', ' '].includes(k) || /^f\d+$/.test(k);

  /** 'ctrl+shift+z' -> {ctrl, shift, alt, key}.  The final '+' of 'ctrl++' is the key. */
  function parse(spec, anyShift) {
    let s = String(spec).trim();
    const p = { ctrl: false, shift: false, alt: false, key: '', anyShift: !!anyShift };
    let m;
    while ((m = /^(ctrl|control|cmd|command|meta|alt|option|shift)\+(?=.)/i.exec(s))) {
      const mod = m[1].toLowerCase();
      if (mod === 'shift') p.shift = true;
      else if (mod === 'alt' || mod === 'option') p.alt = true;
      else p.ctrl = true;
      s = s.slice(m[0].length);
    }
    let k = s.length === 1 ? s : s.toLowerCase();
    if (k.length === 1) k = k.toLowerCase();
    p.key = ALIAS[k] || k;
    return p;
  }

  function eventKey(e) {
    let k = String(e.key === undefined || e.key === null ? '' : e.key).toLowerCase();
    if (k === 'spacebar') k = ' ';
    // A letter key that produced a non-ASCII character (Cyrillic/Greek layouts, macOS Option combos) is matched by
    // its physical position instead, so Ctrl+S etc. keep working there.
    const m = /^Key([A-Z])$/.exec(e.code || '');
    if (m && k.length === 1 && /[^\x00-\x7f]/.test(k)) k = m[1].toLowerCase();
    return k;
  }

  function matchesOne(p, e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (p.ctrl !== ctrl) return false;
    if (p.alt !== e.altKey) return false;
    if (eventKey(e) !== p.key) return false;
    if (!p.anyShift && NEEDS_SHIFT_MATCH(p.key) && p.shift !== e.shiftKey) return false;
    return true;
  }

  // ----- display -----------------------------------------------------------------------------------------------------
  /** Tokens to show for a shortcut spec ('ctrl+shift+z' -> ['Ctrl','Shift','Z']; macOS gets symbols). */
  function tokens(spec) {
    const p = parse(spec);
    const out = [];
    if (p.ctrl) out.push(isMac ? '⌘' : 'Ctrl');
    if (p.alt) out.push(isMac ? '⌥' : 'Alt');
    if (p.shift) out.push(isMac ? '⇧' : 'Shift');
    out.push(DISPLAY[p.key] || (p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1)));
    return out;
  }

  /** Plain text such as "Ctrl+S". */
  function kbdText(spec) { return tokens(spec).join(isMac ? '' : '+'); }

  /** <span class="kbd-combo"><kbd>Ctrl</kbd>+<kbd>S</kbd></span> */
  function kbd(spec) {
    const wrap = document.createElement('span');
    wrap.className = 'kbd-combo';
    tokens(spec).forEach((tok, i) => {
      if (i && !isMac) {
        const plus = document.createElement('span');
        plus.className = 'plus';
        plus.textContent = '+';
        wrap.append(plus);
      }
      const k = document.createElement('kbd');
      k.textContent = tok;
      wrap.append(k);
    });
    return wrap;
  }

  // ----- registry ------------------------------------------------------------------------------------------------------
  const regs = [];
  let seq = 0;

  function register(def) {
    if (!def || !def.key || typeof def.run !== 'function') throw new TypeError('WH.ui.keys.register: {key, run} required');
    const specs = Array.isArray(def.key) ? def.key : [def.key];
    const reg = {
      id: ++seq,
      modes: Array.isArray(def.mode) ? def.mode : [def.mode || 'global'],
      specs,
      parsed: specs.map((s) => parse(s, def.anyShift)),
      i18n: def.i18n || '',
      group: def.group || '',
      run: def.run,
      when: def.when,
      allowTyping: !!def.allowTyping,
      allowInModal: !!def.allowInModal,
      repeat: !!def.repeat,
      hidden: !!def.hidden,
      order: def.order || 0,
    };
    regs.push(reg);
    return () => { const i = regs.indexOf(reg); if (i >= 0) regs.splice(i, 1); };
  }

  const currentMode = () => (g.WH.views && g.WH.views.current) || null;
  const isActive = (reg) => reg.modes.includes('global') || reg.modes.includes(currentMode());

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || !e.key) return;
    const typing = g.WH.util.isTyping(e);
    const modal = (ui.modalCount ? ui.modalCount() > 0 : false) || (ui.tour && ui.tour.isRunning && ui.tour.isRunning());
    const mode = currentMode();
    // scoped registrations first, then global ones
    const ordered = regs.filter(isActive).sort((a, b) => (b.modes.includes(mode) ? 1 : 0) - (a.modes.includes(mode) ? 1 : 0) || a.id - b.id);
    for (const reg of ordered) {
      if (!reg.parsed.some((p) => matchesOne(p, e))) continue;
      if (e.repeat && !reg.repeat) continue;
      if (typing && !reg.allowTyping) continue;
      if (modal && !reg.allowInModal) continue;
      if (reg.when) { let ok = true; try { ok = reg.when(e); } catch (err) { ok = false; } if (!ok) continue; }
      let result;
      try { result = reg.run(e); } catch (err) { console.error(`[WH.ui.keys] handler for ${reg.specs[0]} failed:`, err); }
      if (result !== false) e.preventDefault();
      return;
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // ----- cheat sheet -----------------------------------------------------------------------------------------------------
  let sheetHandle = null;

  function keyCell(reg) {
    const cell = document.createElement('span');
    cell.className = 'keysheet__keys';
    reg.specs.forEach((spec, i) => {
      if (i) {
        const or = document.createElement('span');
        or.className = 'keysheet__alt';
        or.textContent = t('keys.or');
        cell.append(or);
      }
      cell.append(kbd(spec));
    });
    return cell;
  }

  function group(titleKey, list, current) {
    const box = document.createElement('section');
    box.className = 'keysheet__group';
    const h = document.createElement('h3');
    h.textContent = t(titleKey);
    if (current) h.append(' · ', Object.assign(document.createElement('span'), { className: 'text-accent', textContent: t('keys.here') }));
    box.append(h);
    if (!list.length) {
      // a view registers its keys when it is first opened: say so instead of showing an empty heading
      const p = document.createElement('p');
      p.className = 'keysheet__empty';
      p.textContent = t('keys.notYet');
      box.append(p);
    }
    for (const reg of list) {
      const row = document.createElement('div');
      row.className = 'keysheet__row';
      const label = document.createElement('span');
      label.textContent = reg.i18n ? t(reg.i18n) : reg.specs[0];
      row.append(label, keyCell(reg));
      box.append(row);
    }
    return box;
  }

  function sheetContent() {
    const wrap = document.createElement('div');
    const grid = document.createElement('div');
    grid.className = 'keysheet';
    const visible = regs.filter((r) => !r.hidden);
    const by = (mode) => visible.filter((r) => r.modes.includes(mode)).sort((a, b) => a.order - b.order || a.id - b.id);
    const mode = currentMode();
    const col1 = document.createElement('div');
    const col2 = document.createElement('div');
    col1.append(group('keys.group.global', by('global'), false));
    const order = mode === 'editor' ? ['editor', 'planner'] : ['planner', 'editor'];
    col2.append(group(`keys.group.${order[0]}`, by(order[0]), mode === order[0]));
    col2.append(group(`keys.group.${order[1]}`, by(order[1]), mode === order[1]));
    // mouse & touch help
    const mouse = document.createElement('section');
    mouse.className = 'keysheet__group';
    const mh = document.createElement('h3');
    mh.textContent = t('keys.group.mouse');
    mouse.append(mh);
    for (const k of ['pan', 'zoom', 'pinch', 'space', 'fit']) {
      const row = document.createElement('div');
      row.className = 'keysheet__row';
      row.append(Object.assign(document.createElement('span'), { textContent: t(`keys.mouse.${k}`) }));
      mouse.append(row);
    }
    col1.append(mouse);
    grid.append(col1, col2);
    const note = document.createElement('p');
    note.className = 'text-sm text-muted mt-4';
    note.textContent = t('keys.note');
    wrap.append(grid, note);
    return wrap;
  }

  /** Open (or close, if already open) the shortcut cheat sheet. */
  function sheet() {
    if (sheetHandle) { sheetHandle.close(); return null; }
    sheetHandle = ui.dialog({ title: t('keys.title'), content: sheetContent(), wide: true, onClose: () => { sheetHandle = null; } });
    return sheetHandle;
  }

  ui.kbd = kbd;
  ui.kbdText = kbdText;
  ui.keys = {
    register,
    sheet,
    list: () => regs.slice(),
    parse,
    isOpen: () => !!sheetHandle,
    /** Numeric arrow-key helper for nudging: returns {dx, dy} in steps (Shift = 4x) for an arrow key event, else null. */
    arrowDelta(e, step = 1, big = 4) {
      const m = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!m) return null;
      const k = e.shiftKey ? big : 1;
      return { dx: m[0] * step * k, dy: m[1] * step * k };
    },
  };
})();
