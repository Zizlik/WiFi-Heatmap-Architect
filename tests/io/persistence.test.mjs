// Autosave failure handling in src/js/30-io/io.js: a persistent "not being saved" notice (with a one-click SVG save),
// recovery notice, and the download of an unreadable autosave. io.js is loaded in a fresh vm context with a fake
// localStorage (quota switch), a recording toast and stubs for the few things it touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../src/js/30-io/io.js');

function setup() {
  const store = new Map();
  const state = { quota: false, throwName: 'QuotaExceededError', corrupt: false };
  const toasts = [];
  const events = [];
  const downloads = [];
  const localStorage = {
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem(k, v) {
      if (state.quota) { const e = new Error('full'); e.name = state.throwName; throw e; }
      store.set(k, String(v));
    },
    removeItem: (k) => { store.delete(k); },
  };
  const WH = {
    i18n: { lang: 'cs', t: (k) => k, has: () => false },
    ui: { toast: (msg, opts) => { const rec = { msg, opts, closed: false, close() { rec.closed = true; } }; toasts.push(rec); return rec; } },
    bus: { emit: (topic, payload) => events.push({ topic, payload }) },
    util: { download: (data, name, mime) => downloads.push({ data, name, mime }) },
    store: { project: null },
    engine: { project: { activeFloorId: () => null, sanitize: () => { if (state.corrupt) throw new Error('bad'); return null; }, migrateLegacyStorage: () => null } },
  };
  const ctx = vm.createContext({ globalThis: null, console, localStorage, Date, JSON, Map, Set, Array, Object, String, Number, Error, setTimeout, clearTimeout, WH_UNUSED: 0 });
  ctx.globalThis = ctx;
  ctx.WH = WH;
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: SRC });
  return { io: ctx.WH.io, WH, store, state, toasts, events, downloads };
}

const project = () => ({ plan: { background: null, rooms: [] }, floors: null });

test('a normal save keeps the state ok and shows nothing', () => {
  const { io, toasts } = setup();
  assert.equal(io.saveLocal(project()).ok, true);
  assert.equal(io.saveState(), 'ok');
  assert.equal(toasts.length, 0);
});

test('a failing save raises ONE persistent notice with a save-as-SVG action and emits io:savestate', () => {
  const { io, state, toasts, events } = setup();
  state.quota = true;
  assert.equal(io.saveLocal(project()).ok, false);
  assert.equal(io.saveState(), 'failed');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].opts.ms, 0, 'persistent: never times out');
  assert.equal(toasts[0].msg.i18n, 'io.err.quota');
  assert.ok(toasts[0].msg.actions.some((a) => a.i18n === 'file.saveSvg' && typeof a.fn === 'function'));
  assert.deepEqual(events.map((e) => e.payload.state), ['failed']);
  // every further autosave while it keeps failing does not stack notices
  io.saveLocal(project()); io.saveLocal(project());
  assert.equal(toasts.length, 1);
  assert.equal(events.length, 1);
});

test('blocked storage (SecurityError) gets its own explanation', () => {
  const { io, state, toasts } = setup();
  state.quota = true; state.throwName = 'SecurityError';
  io.saveLocal(project());
  assert.equal(toasts[0].msg.i18n, 'io.err.blocked');
});

test('when saving works again the notice closes and the user is told', () => {
  const { io, state, toasts, events } = setup();
  state.quota = true;
  io.saveLocal(project());
  state.quota = false;
  assert.equal(io.saveLocal(project()).ok, true);
  assert.equal(io.saveState(), 'ok');
  assert.equal(toasts[0].closed, true);
  assert.equal(toasts.at(-1).msg.i18n, 'io.ok.saveBack');
  assert.deepEqual(events.map((e) => e.payload.state), ['failed', 'ok']);
});

test('an unreadable autosave is kept AND can be downloaded, even when the copy in storage fails', () => {
  const { io, state, store, toasts, downloads } = setup();
  store.set('wifi-heatmap-v3', '{"plan": {"rooms": [ ...damaged');
  state.corrupt = true;
  // JSON.parse fails first for this raw text; make the storage copy fail as well
  state.quota = true;
  assert.equal(io.loadLocal(), null);
  const t = toasts.at(-1);
  assert.equal(t.msg.i18n, 'io.err.local');
  const act = t.msg.actions.find((a) => a.i18n === 'io.err.localGet');
  assert.ok(act, 'toast offers the download');
  act.fn();
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].data, /damaged/);
  assert.match(downloads[0].name, /\.json$/);
});

test('downloadCorrupt without any damaged data does nothing', () => {
  const { io, downloads } = setup();
  assert.equal(io.downloadCorrupt(), false);
  assert.equal(downloads.length, 0);
});
