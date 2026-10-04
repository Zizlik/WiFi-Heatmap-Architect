// Small builders for synthetic test plans. All coordinates are CANVAS PIXELS (1080 x 942) for readability.
import { E } from './_load.mjs';

const { W, H } = E.CANVAS;

export const n = (x, y) => ({ x: x / W, y: y / H });
export const rectPts = (x0, y0, x1, y1) => [n(x0, y0), n(x1, y0), n(x1, y1), n(x0, y1)];

export const room = (roomId, x0, y0, x1, y1, name = `R${roomId}`) => ({ id: `room-${roomId}`, type: 'room', roomId, name, points: rectPts(x0, y0, x1, y1), color: '#8eadd2' });
export const wall = (id, ax, ay, bx, by, loss) => ({ id, type: 'wall', name: id, a: n(ax, ay), b: n(bx, by), ...(loss === undefined ? {} : { loss, material: 'custom' }) });
export const door = (id, wallId, ax, ay, bx, by, loss = 0) => ({ id, type: 'door', name: id, a: n(ax, ay), b: n(bx, by), wallId, loss });
export const furn = (id, x0, y0, x1, y1, loss = 3, blocksSignal = true) => ({ id, type: 'furniture', name: id, points: rectPts(x0, y0, x1, y1), loss, kind: 'custom', blocksSignal });

/**
 * Build a sanitized project from parts. mpp defaults to 0.01 m/px. router/baseline/node in px.
 */
export function makeProject({ rooms = [], walls = [], doors = [], furniture = [], mpp = 0.01, router, baseline, optic, model, goal, node, measurements, view, name } = {}) {
  const raw = {
    v: 3,
    name: name || 'test',
    plan: { rooms, walls, doors, furniture, background: null },
    scale: { mpp },
    net: {
      ...(router ? { router: n(router[0], router[1]) } : {}),
      ...(baseline ? { baseline: n(baseline[0], baseline[1]) } : {}),
      ...(optic ? { optic: n(optic[0], optic[1]) } : {}),
    },
    ...(model ? { model } : {}),
    ...(goal ? { goal } : {}),
    ...(node ? { node } : {}),
    ...(measurements ? { measurements } : {}),
    ...(view ? { view } : {}),
  };
  return E.project.sanitize(raw);
}

/** A complete node of SPEC 14.2 (uplink router, enabled), for tests that need one AP / mesh / repeater. */
export const mkNode = (fields = {}) => ({ id: 'node-1', name: 'AP 2', mode: 'ap_cable', pos: { x: 0.4, y: 0.4 }, bands: { '2.4': true, '5': true, '6': false }, power: 0, backhaulBand: 5, backhaulThreshold: -67, maxMbps: null, uplink: 'router', enabled: true, ...fields });

/** The project with exactly one node: its current first node (if any) with `fields` on top, sanitized. */
export const withNode = (p, fields = {}) => E.project.sanitize({ ...p, nodes: [{ ...mkNode(), ...(p.nodes && p.nodes[0] ? p.nodes[0] : {}), ...fields }] });

/** Where the (off) second node of the old demo waited: the bedroom (P(2.6, 3.6) m). */
export const DEMO_BEDROOM = { x: 0.303704, y: 0.550955 };

/** A context for a project. */
export const ctxOf = (p) => E.model.createContext(p);

/** Obstacle loss between two px points of a project. */
export function lossPx(p, ax, ay, bx, by) {
  return E.model.obstacleLoss(ctxOf(p), n(ax, ay), n(bx, by));
}

/** Deterministic pseudo random generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A realistic, busier plan: 3x3 rooms, ~20 walls, ~20 furniture - used for performance and artifact tests. */
export function busyPlan({ gap = 0, seed = 7 } = {}) {
  const r = rng(seed);
  const x = [100, 400, 700, 1000];
  const y = [100, 330, 560, 790];
  const rooms = [];
  let id = 1;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) rooms.push(room(id++, x[i], y[j], x[i + 1], y[j + 1]));
  const walls = [];
  let wid = 1;
  // perimeter
  walls.push(wall(`w${wid++}`, x[0], y[0], x[3], y[0], 8), wall(`w${wid++}`, x[3], y[0], x[3], y[3], 8), wall(`w${wid++}`, x[3], y[3], x[0], y[3], 8), wall(`w${wid++}`, x[0], y[3], x[0], y[0], 8));
  // inner vertical walls (one piece per row, so they end at T-junctions); `gap` shortens them at both ends
  for (let k = 1; k <= 2; k++) for (let j = 0; j < 3; j++) walls.push(wall(`w${wid++}`, x[k], y[j] + gap, x[k], y[j + 1] - gap, 6));
  // inner horizontal walls
  for (let k = 1; k <= 2; k++) for (let i = 0; i < 3; i++) walls.push(wall(`w${wid++}`, x[i] + gap, y[k], x[i + 1] - gap, y[k], 6));
  const furniture = [];
  for (let k = 0; k < 20; k++) {
    const cx = 130 + r() * 840;
    const cy = 130 + r() * 630;
    furniture.push(furn(`f${k + 1}`, cx, cy, cx + 30 + r() * 50, cy + 20 + r() * 40, 2 + Math.floor(r() * 6)));
  }
  return { rooms, walls, furniture };
}
