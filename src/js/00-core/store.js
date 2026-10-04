/* WH.store - the ONE source of truth for the project (SPEC 3.1) plus persisted UI preferences.
 *
 *   WH.store.project                      live project object (read-only for views)
 *   WH.store.init(project, {save})        hard reset: replaces the project, clears history, emits everything
 *   WH.store.replace(project, label)      undoable replacement (import / demo / new plan)
 *   WH.store.commit(label, mut, topics?)  one atomic change = one undo step
 *   WH.store.begin(label) / live(mut, topics?) / end() / cancel()     drag-style gestures: one undo step at end()
 *   WH.store.update(mut, topics?, opts?)  change WITHOUT an undo step (view toggles, other ephemeral state);
 *                                         opts.quiet suppresses the "history slice changed" warning
 *   WH.store.undo() / redo() / canUndo() / canRedo() / labels()
 *   WH.store.on(topic | [topics] | '*', fn) -> off     fn is called ONCE per change batch even when several topics matched
 *   WH.store.prefs / setPref(key, value) / getPref(key, fallback)
 *
 * History covers: name, plan, scale, net, node, model, goal, measurements.  `view` (band, layer, toggles ...) is
 * deliberately NOT part of undo/redo, so pressing Ctrl+Z never flips a layer switch back and forth.
 * The background image (a potentially multi-megabyte data URL string) is never deep-copied: snapshots keep the
 * same string reference. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};

  const TOPICS = ['plan', 'scale', 'net', 'node', 'model', 'goal', 'measurements', 'view'];
  const HISTORY_KEYS = ['name', 'plan', 'scale', 'net', 'node', 'model', 'goal', 'measurements'];
  const ALL_SIG_KEYS = HISTORY_KEYS.concat(['view']);
  const MAX_HISTORY = 100;
  const SAVE_DELAY = 500;
  const PREFS_KEY = 'wifi-heatmap-prefs';

  let project = null;
  let undoStack = [];
  let redoStack = [];
  let gesture = null;
  let autosaveEnabled = true;
  let warnedLive = false;
  let warnedUpdate = false;
  const regs = new Set();
  /** A bug caught here (a throwing listener or mutator) also goes to the error diary (WH.diag, Help -> Report a problem). */
  const diagCaught = (e, where) => { try { if (g.WH.diag) g.WH.diag.caught(e, where); } catch (x) { /* never let the diary break the store */ } };

  // ---------------------------------------------------------------------------------------------------------------
  // snapshots & signatures
  // ---------------------------------------------------------------------------------------------------------------
  const clone = (v) => {
    if (v === undefined || v === null || typeof v !== 'object') return v;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch (e) { /* fall back */ }
    }
    return JSON.parse(JSON.stringify(v));
  };

  /** Plan without its background (the background is tracked by reference). */
  function planNoBg(plan) {
    const copy = Object.assign({}, plan);
    delete copy.background;
    return copy;
  }

  function bgOf(p) { return p && p.plan ? p.plan.background || null : null; }

  /** Stringified slices: cheap structural fingerprints used for change detection. */
  function signatures(p) {
    const s = {};
    for (const k of ALL_SIG_KEYS) {
      try { s[k] = JSON.stringify(k === 'plan' ? planNoBg(p.plan || {}) : p[k]); } catch (e) { s[k] = String(Math.random()); }
    }
    return s;
  }

  function snapshot(p) {
    const data = {};
    for (const k of HISTORY_KEYS) data[k] = k === 'plan' ? clone(planNoBg(p.plan || {})) : clone(p[k]);
    return { data, bg: bgOf(p), sigs: signatures(p) };
  }

  /** Write a snapshot back into the live project object (top-level identity is kept). */
  function restore(snap) {
    for (const k of HISTORY_KEYS) {
      if (k === 'plan') {
        const plan = clone(snap.data.plan);
        plan.background = snap.bg;
        project.plan = plan;
      } else {
        project[k] = clone(snap.data[k]);
      }
    }
  }

  function historyDiffers(a, bSigs, bBg) {
    if (a.bg !== bBg) return true;
    for (const k of HISTORY_KEYS) if (a.sigs[k] !== bSigs[k]) return true;
    return false;
  }

  function changedTopics(aSigs, aBg, bSigs, bBg) {
    const out = [];
    for (const k of TOPICS) {
      if (aSigs[k] !== bSigs[k] || (k === 'plan' && aBg !== bBg)) out.push(k);
    }
    if (aSigs.name !== bSigs.name) out.push('meta');
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------------------------------------------
  function emit(topics, meta) {
    const list = Array.from(new Set(topics));
    if (!list.length) return;
    const set = new Set(list);
    const payload = Object.assign({ topics: list, project }, meta || {});
    for (const reg of Array.from(regs)) {
      if (!regs.has(reg)) continue;
      let hit = null;
      if (reg.all) hit = list[0];
      else for (const tp of reg.topics) if (set.has(tp)) { hit = tp; break; }
      if (!hit) continue;
      try { reg.fn(Object.assign({ topic: hit }, payload)); } catch (e) { console.error(`[WH.store] listener for "${hit}" failed:`, e); diagCaught(e, `store:${hit}`); }
    }
    if (g.WH.bus) for (const tp of list) g.WH.bus.emit(`store:${tp}`, payload);
  }

  /** Subscribe to one topic, an array of topics, or '*' for everything. fn(payload) runs at most once per change batch. */
  function on(topic, fn) {
    if (typeof fn !== 'function') throw new TypeError('WH.store.on: listener must be a function');
    const reg = { fn, all: topic === '*', topics: new Set(Array.isArray(topic) ? topic : [topic]) };
    regs.add(reg);
    return () => regs.delete(reg);
  }

  const asList = (t) => (Array.isArray(t) ? t.slice() : t ? [t] : []);

  // ---------------------------------------------------------------------------------------------------------------
  // autosave
  // ---------------------------------------------------------------------------------------------------------------
  function saveNow() {
    if (!autosaveEnabled || !project) return false;
    const io = g.WH.io;
    if (!io || typeof io.saveLocal !== 'function') return false;
    try { io.saveLocal(project); return true; } catch (e) { console.error('[WH.store] autosave failed:', e); diagCaught(e, 'store.autosave'); return false; }
  }

  let saveTimer = 0;
  function scheduleSave() {
    if (!autosaveEnabled) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = 0; saveNow(); }, SAVE_DELAY);
  }
  /** Save right now if a save is pending (called on page hide / before unload). */
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; saveNow(); }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // history
  // ---------------------------------------------------------------------------------------------------------------
  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
  }

  function needProject(fnName) {
    if (project) return true;
    console.warn(`[WH.store] ${fnName}() called before init()`);
    return false;
  }

  function init(p, opts) {
    if (!p || typeof p !== 'object' || !p.plan || typeof p.plan !== 'object') {
      console.error('[WH.store] init() needs a project object with a plan');
      return false;
    }
    gesture = null;
    project = p;
    undoStack = [];
    redoStack = [];
    emit(TOPICS.concat(['meta', 'project:replaced', 'history']), { source: 'init' });
    if (!opts || opts.save !== false) scheduleSave();
    return true;
  }

  /** Swap the whole document but keep it undoable (used by import, demo flat, new plan). */
  function replace(next, label) {
    if (!project) return init(next);
    if (!next || typeof next !== 'object' || !next.plan) { console.error('[WH.store] replace() needs a project object'); return false; }
    if (gesture) end();
    const before = snapshot(project);
    for (const k of HISTORY_KEYS) project[k] = next[k];
    if (next.view) project.view = next.view;
    pushUndo({ label: label || 'replace', snap: before, full: true });
    emit(TOPICS.concat(['meta', 'project:replaced', 'history']), { source: 'replace', label });
    scheduleSave();
    return true;
  }

  function commit(label, mutator, topics) {
    if (!needProject('commit')) return false;
    if (gesture) end();
    const before = snapshot(project);
    const bgBefore = before.bg;
    let ret;
    try { ret = mutator(project); } catch (e) {
      console.error(`[WH.store] commit "${label}" threw - rolled back:`, e);
      diagCaught(e, `store.commit:${label}`);
      restore(before);
      return false;
    }
    if (ret === false) { restore(before); return false; }
    const sigs = signatures(project);
    const bgAfter = bgOf(project);
    const histChanged = historyDiffers(before, sigs, bgAfter);
    const changed = changedTopics(before.sigs, bgBefore, sigs, bgAfter);
    const explicit = asList(topics);
    if (!histChanged && !changed.length) {
      if (explicit.length) emit(explicit, { source: 'commit', label });
      return false;
    }
    if (histChanged) pushUndo({ label, snap: before });
    emit(changed.concat(explicit, histChanged ? ['history'] : []), { source: 'commit', label });
    scheduleSave();
    return true;
  }

  function begin(label) {
    if (!needProject('begin')) return false;
    if (gesture) end();
    const snap = snapshot(project);
    gesture = { label, before: snap, lastSigs: snap.sigs, lastBg: snap.bg };
    return true;
  }

  function live(mutator, topics) {
    if (!needProject('live')) return false;
    if (!gesture) {
      if (!warnedLive) { warnedLive = true; console.warn('[WH.store] live() without begin(): applied without an undo step'); }
      return update(mutator, topics);
    }
    try { if (mutator(project) === false) return false; } catch (e) {
      console.error('[WH.store] live mutator threw:', e);
      diagCaught(e, `store.live:${gesture.label}`);
      return false;
    }
    const explicit = asList(topics);
    let list = explicit;
    if (!explicit.length) {
      const sigs = signatures(project);
      list = changedTopics(gesture.lastSigs, gesture.lastBg, sigs, bgOf(project));
      gesture.lastSigs = sigs;
      gesture.lastBg = bgOf(project);
    }
    emit(list, { source: 'live', label: gesture.label });
    scheduleSave();
    return true;
  }

  /** Finish a gesture: one undo step if (and only if) the result differs from the state at begin(). */
  function end() {
    const gs = gesture;
    gesture = null;
    if (!gs || !project) return false;
    const sigs = signatures(project);
    const changed = historyDiffers(gs.before, sigs, bgOf(project));
    if (changed) {
      pushUndo({ label: gs.label, snap: gs.before });
      emit(['history'], { source: 'end', label: gs.label });
    }
    scheduleSave();
    return changed;
  }

  /** Abort a gesture and restore the state from begin() (e.g. Esc while dragging). */
  function cancel() {
    const gs = gesture;
    gesture = null;
    if (!gs || !project) return false;
    const nowSigs = signatures(project);
    const nowBg = bgOf(project);
    restore(gs.before);
    emit(changedTopics(nowSigs, nowBg, gs.before.sigs, gs.before.bg), { source: 'cancel', label: gs.label });
    return true;
  }

  /** Change state without an undo step (view toggles etc.). History slices should go through commit/live.
   *  opts.quiet = true: the caller knows it touches history slices on purpose (e.g. snapping markers back onto the
   *  floor after a plan edit) - skip the one-time "not undoable" warning. */
  function update(mutator, topics, opts) {
    if (!needProject('update')) return false;
    const quiet = !!(opts && opts.quiet);
    const before = signatures(project);
    const bgBefore = bgOf(project);
    try { if (mutator(project) === false) return false; } catch (e) {
      console.error('[WH.store] update mutator threw:', e);
      diagCaught(e, 'store.update');
      return false;
    }
    const after = signatures(project);
    const changed = changedTopics(before, bgBefore, after, bgOf(project));
    if (!quiet && !warnedUpdate && changed.some((t) => t !== 'view' && t !== 'meta')) {
      warnedUpdate = true;
      console.warn('[WH.store] update() changed history slices (' + changed.join(',') + '): such changes are not undoable - use commit()');
    }
    const explicit = asList(topics);
    if (!changed.length && !explicit.length) return false;
    emit(changed.concat(explicit), { source: 'update' });
    scheduleSave();
    return true;
  }

  function step(fromStack, toStack, source) {
    if (!project || gesture || !fromStack.length) return false;
    const entry = fromStack.pop();
    const current = snapshot(project);
    toStack.push({ label: entry.label, snap: current, full: entry.full });
    if (toStack.length > MAX_HISTORY) toStack.shift();
    restore(entry.snap);
    const sigs = signatures(project);
    const changed = changedTopics(current.sigs, current.bg, sigs, bgOf(project));
    emit(changed.concat(entry.full ? TOPICS.concat(['project:replaced']) : [], ['history']), { source, label: entry.label });
    scheduleSave();
    return true;
  }

  const undo = () => step(undoStack, redoStack, 'undo');
  const redo = () => step(redoStack, undoStack, 'redo');
  const canUndo = () => !gesture && undoStack.length > 0;
  const canRedo = () => !gesture && redoStack.length > 0;
  const labels = () => ({
    undo: undoStack.length ? undoStack[undoStack.length - 1].label : null,
    redo: redoStack.length ? redoStack[redoStack.length - 1].label : null,
  });

  // ---------------------------------------------------------------------------------------------------------------
  // preferences (persisted separately under 'wifi-heatmap-prefs')
  // ---------------------------------------------------------------------------------------------------------------
  const PREF_DEFAULTS = () => ({ theme: 'auto', collapsed: {}, tourDone: false, welcomeDone: false, checklistDismissed: false });

  function loadPrefs() {
    const prefs = PREF_DEFAULTS();
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) if (k !== '__proto__' && k !== 'constructor') prefs[k] = raw[k];
      }
    } catch (e) { /* storage blocked / corrupt: defaults */ }
    if (!prefs.collapsed || typeof prefs.collapsed !== 'object' || Array.isArray(prefs.collapsed)) prefs.collapsed = {};
    if (!['auto', 'light', 'dark', 'oled'].includes(prefs.theme)) prefs.theme = 'auto';   // SPEC 12: dark = Deep dark, oled = OLED black
    return prefs;
  }

  const prefs = loadPrefs();

  function persistPrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  /** setPref('theme', 'dark') or with a dotted path: setPref('collapsed.advanced', true). */
  function setPref(key, value) {
    const parts = String(key).split('.');
    if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) return;
    let o = prefs;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (o[last] === value) return;
    o[last] = value;
    persistPrefs();
    emit(['prefs'], { source: 'prefs', key, value });
    if (g.WH.bus) g.WH.bus.emit('prefs:changed', { key, value });
  }

  function getPref(key, fallback) {
    let o = prefs;
    for (const p of String(key).split('.')) {
      if (o === null || typeof o !== 'object' || !(p in o)) return fallback;
      o = o[p];
    }
    return o;
  }

  g.WH.store = {
    TOPICS, HISTORY_KEYS, MAX_HISTORY,
    get project() { return project; },
    get gestureOpen() { return !!gesture; },
    init, replace, commit, begin, live, end, cancel, update, undo, redo, canUndo, canRedo, labels,
    on, prefs, setPref, getPref,
    flush, saveNow,
    /** Stop writing to localStorage (used right before "delete saved data" + reload). */
    disableAutosave() { autosaveEnabled = false; clearTimeout(saveTimer); saveTimer = 0; },
    enableAutosave() { autosaveEnabled = true; },
  };
})();
