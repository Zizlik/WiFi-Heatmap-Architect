// SPEC 14.2: any number of nodes (AP / mesh / repeater) - data + migration, helpers, the combined field and the winner
// index, per-node contours / zones, uplink chains in the speed model, what-if, optimizer, analysis, performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, makeProject, mkNode, busyPlan } from './_helpers.mjs';
import { assertValidProject } from './_validate.mjs';

const { W, H } = E.CANVAS;
const P = E.project;
const M = E.model;
const R = E.raster;
const S = E.speed;
const A = E.analysis;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (eps ${eps})`);

// three rooms in a row, 10 dB walls between them; the router in the left one
function rowPlan(extra = {}) {
  return makeProject({
    rooms: [room(1, 100, 300, 400, 600, 'L'), room(2, 400, 300, 700, 600, 'M'), room(3, 700, 300, 1000, 600, 'R')],
    walls: [wall('w1', 400, 300, 400, 600, 10), wall('w2', 700, 300, 700, 600, 10)],
    router: [180, 450],
    view: { band: 5 },
    ...extra,
  });
}
const A_NODE = (more = {}) => mkNode({ id: 'node-a', name: 'AP A', pos: n(550, 450), ...more });
const B_NODE = (more = {}) => mkNode({ id: 'node-b', name: 'AP B', pos: n(880, 450), ...more });
const withNodes = (p, list) => P.sanitize({ ...p, nodes: list });

let mid = 0;
const sm = (value, down, up, band = 5) => ({ id: `c${++mid}`, x: 0.5, y: 0.5, band, value, name: 'c', download: down, upload: up, device: 'Telefon', t: 0 });
const CURVE = S.buildCurve([sm(-40, 600, 200), sm(-50, 450, 150), sm(-60, 220, 80), sm(-67, 90, 35), sm(-75, 25, 10), sm(-82, 4, 2)], { band: 5, device: 'Telefon' });

test('data: the old single node migrates to nodes[0]; nodes are sanitized building wide; files keep the legacy node', () => {
  // an old file with a node in use
  const old = rowPlan({ node: { mode: 'repeater', pos: n(880, 450), power: 3, maxMbps: 300, backhaulBand: 2.4, backhaulThreshold: -70, bands: { '2.4': true, '5': true, '6': false } } });
  assert.deepEqual(old.nodes, [{ id: 'node-1', name: 'AP 2', mode: 'repeater', pos: old.nodes[0].pos, bands: { '2.4': true, '5': true, '6': false }, power: 3, backhaulBand: 2.4, backhaulThreshold: -70, maxMbps: 300, uplink: 'router', enabled: true }]);
  close(old.nodes[0].pos.x, 880 / W, 1e-6);
  // an old file whose node was off ('none'): no node
  assert.deepEqual(rowPlan({ node: { mode: 'none', pos: n(880, 450) } }).nodes, []);
  // building-wide rules: <= 8, unique ids, valid acyclic uplinks, default names
  const many = Array.from({ length: 11 }, (_, k) => ({ id: k === 3 ? 'n0' : `n${k}`, mode: 'ap_cable', pos: n(150 + 80 * k, 450) }));
  const p = withNodes(rowPlan(), many);
  assertValidProject(p, 'many');
  assert.equal(p.nodes.length, 8);
  assert.equal(new Set(p.nodes.map((x) => x.id)).size, 8);
  assert.deepEqual(
    p.nodes.slice(0, 4).map((x) => x.name),
    ['AP 2', 'AP 3', 'AP 4', 'AP 5'],
  );
  const cyc = withNodes(rowPlan(), [A_NODE({ uplink: 'node-b' }), B_NODE({ uplink: 'node-a' }), mkNode({ id: 'node-c', pos: n(300, 450), uplink: 'node-c' }), mkNode({ id: 'node-d', pos: n(320, 450), uplink: 'gone' })]);
  assertValidProject(cyc, 'cycle');
  assert.deepEqual(
    cyc.nodes.map((x) => [x.id, x.uplink]),
    [
      ['node-a', 'node-b'],
      ['node-b', 'router'],
      ['node-c', 'router'],
      ['node-d', 'router'],
    ],
    'the cycle is cut where it closes, self / unknown uplinks -> the router',
  );
  // round trips: JSON and SVG keep every node; the legacy node = nodes[0] (switched off -> 'none')
  const two = withNodes(rowPlan(), [A_NODE({ mode: 'mesh_wifi', enabled: false }), B_NODE({ mode: 'repeater', uplink: 'node-a' })]);
  assert.deepEqual(P.sanitize(P.serialize(two)), two);
  assert.deepEqual(P.parseSvgText(P.buildSvg(two)).project, two);
  const data = JSON.parse(P.serialize(two));
  assert.equal(data.project.node.mode, 'none', 'nodes[0] is off');
  assert.deepEqual(data.project.node.pos, two.nodes[0].pos);
  assert.equal(JSON.parse(P.serialize(withNodes(two, [B_NODE()]))).project.node.mode, 'ap_cable');
  // what an older build of this app reads: the legacy node (its sanitize ignores nodes / floors)
  const older = JSON.parse(P.serialize(withNodes(two, [B_NODE({ mode: 'repeater', maxMbps: 200 })])));
  delete older.project.nodes;
  delete older.project.floors;
  assert.deepEqual(P.sanitize(older).nodes.map((x) => [x.mode, x.maxMbps]), [['repeater', 200]]);
});

test('helpers: newNode / addNode / removeNode / allNodes / nodeById; MAX_NODES', () => {
  const p = rowPlan();
  const a = P.newNode(p, { mode: 'mesh_wifi' });
  assert.equal(a.id, 'node-1');
  assert.equal(a.name, 'AP 2');
  assert.equal(P.roomAt(p.plan, a.pos).roomId, 3, 'the farthest room from the router');
  assert.deepEqual(a.bands, { '2.4': true, '5': true, '6': false }, 'the router bands');
  p.nodes.push(a);
  const b = P.newNode(p, { mode: 'repeater', uplink: 'node-1' });
  assert.equal(b.uplink, 'node-1');
  assert.equal(b.name, 'AP 3');
  assert.equal(P.roomAt(p.plan, b.pos).roomId, 2, 'away from the router and the first node');
  assert.equal(P.addNode(p, b), true);
  assert.equal(P.addNode(p, b), false, 'the same id twice');
  assertValidProject(p, 'two nodes');
  assert.deepEqual(
    P.allNodes(p).map((e) => [e.node.id, e.floor, e.index]),
    [
      ['node-1', 'floor-1', 0],
      ['node-2', 'floor-1', 1],
    ],
  );
  assert.equal(P.nodeById(p, 'node-2').node, b);
  assert.equal(P.nodeById(p, 'nope'), null);
  // removing node-1: node-2 takes over its uplink (the router)
  assert.equal(P.removeNode(p, 'node-1'), true);
  assert.deepEqual(
    p.nodes.map((x) => [x.id, x.uplink]),
    [['node-2', 'router']],
  );
  assertValidProject(p, 'after remove');
  for (let k = 0; k < 7; k++) assert.equal(P.addNode(p, P.newNode(p)), true);
  assert.equal(p.nodes.length, 8);
  assert.equal(P.newNode(p), null, 'MAX_NODES reached');
  assert.equal(P.addNode(p, mkNode({ id: 'node-x' })), false);
  assertValidProject(p, 'eight');
});

test('nodeList: switched off / cut-off chains do not serve; building order; fieldParams keeps a compat `node`', () => {
  const p = withNodes(rowPlan(), [A_NODE({ mode: 'mesh_wifi', enabled: false }), B_NODE({ mode: 'repeater', uplink: 'node-a' }), mkNode({ id: 'node-c', pos: n(600, 350) })]);
  assert.deepEqual(
    M.nodeList(p).map((x) => [x.id, x.index, x.uplinkIndex]),
    [['node-c', 0, -1]],
    'B uplinks to the switched-off A: no internet, no service',
  );
  p.nodes[0].enabled = true;
  const list = M.nodeList(p);
  assert.deepEqual(
    list.map((x) => [x.id, x.uplink, x.uplinkIndex, x.floor, x.pos.floor]),
    [
      ['node-a', 'router', -1, 'floor-1', 'floor-1'],
      ['node-b', 'node-a', 0, 'floor-1', 'floor-1'],
      ['node-c', 'router', -1, 'floor-1', 'floor-1'],
    ],
  );
  assert.deepEqual(M.nodeParams(p), list[0]);
  const st = M.fieldParams(p, 'trial');
  assert.equal(st.nodes.length, 3);
  assert.equal(st.node, st.nodes[0], 'compat: the first node');
  assert.ok(!Object.keys(st).includes('node'), 'non-enumerable: a spread does not carry it');
  assert.deepEqual(M.stateNodes({ ...st }), st.nodes);
  // the legacy override still works: {...state, node: X} / {...state, node: null}
  assert.deepEqual(M.stateNodes({ ...st, node: st.nodes[2] }), [st.nodes[2]]);
  assert.deepEqual(M.stateNodes({ ...st, node: null }), []);
  assert.deepEqual(M.fieldParams(p, 'today').nodes, []);
  assert.deepEqual(M.stateNodes({ router: { x: 0.5, y: 0.5 }, node: { mode: 'ap_cable', pos: { x: 0.2, y: 0.2 }, bands: { 5: true } } }).length, 1, 'a hand-made legacy state');
});

test('raster: the field is the strongest of all sources cell by cell; nodeWins = the winner index; one node = the legacy call', () => {
  const p = withNodes(rowPlan(), [A_NODE(), B_NODE({ power: 3 }), mkNode({ id: 'node-x', pos: n(250, 350), bands: { '2.4': true, '5': false, '6': false } })]);
  const ctx = M.createContext(p);
  for (const soften of [undefined, 0]) {
    const g = R.grid(ctx, { cell: 8 });
    const st = { ...M.fieldParams(p, 'trial'), soften };
    const fx = R.fieldEx(ctx, g, st);
    const solo = R.field(ctx, g, { ...st, nodes: [] });
    const fa = R.field(ctx, g, { ...st, nodes: [st.nodes[0]] });
    const fb = R.field(ctx, g, { ...st, nodes: [st.nodes[1]] });
    const counts = [0, 0, 0, 0];
    for (const i of g.idx) {
      const best = Math.max(solo[i], fa[i], fb[i]);
      assert.equal(fx.field[i], best, `cell ${i}`);
      const want = fb[i] > solo[i] && fb[i] > fa[i] ? 2 : fa[i] > solo[i] ? 1 : 0;
      assert.equal(fx.nodeWins[i], want, `winner of cell ${i}`);
      counts[fx.nodeWins[i]]++;
    }
    assert.ok(counts[0] > 50 && counts[1] > 50 && counts[2] > 50, counts.join(','));
    assert.equal(counts[3], 0, 'node-x does not serve 5 GHz');
    // one node through `nodes` = the legacy single-node call, bit for bit
    const legacy = R.fieldEx(ctx, g, { ...st, nodes: undefined, node: st.nodes[1] });
    const now = R.fieldEx(ctx, g, { ...st, nodes: [st.nodes[1]] });
    assert.deepEqual(Array.from(legacy.field), Array.from(now.field));
    assert.deepEqual(Array.from(legacy.nodeWins), Array.from(now.nodeWins));
  }
  // the per-source cache changes nothing; nodeWinsOf finds the winner array
  const g = R.grid(ctx, { cell: 4 });
  const st = { ...M.fieldParams(p, 'trial'), aa: 2 };
  const a1 = R.fieldEx(ctx, g, st);
  R.clearCache();
  const a2 = R.fieldEx(ctx, g, st);
  assert.deepEqual(Array.from(a1.field), Array.from(a2.field));
  assert.equal(R.nodeWinsOf(a2.field, st), a2.nodeWins);
  // moving another node invalidates only what moved
  const moved = { ...st, nodes: [st.nodes[0], { ...st.nodes[1], pos: { ...st.nodes[1].pos, x: st.nodes[1].pos.x - 0.02 } }, st.nodes[2]] };
  assert.equal(R.nodeWinsOf(a2.field, moved), undefined, 'another position: not this array');
  const a3 = R.fieldEx(ctx, g, moved);
  assert.notDeepEqual(Array.from(a3.field), Array.from(a2.field));
});

test('point model: pointSignalDetail = the raster (winner, strongest node, per-node values); steered winner', () => {
  const p = withNodes(rowPlan({ view: { band: 'auto' } }), [A_NODE({ mode: 'mesh_wifi' }), B_NODE({ mode: 'repeater', uplink: 'node-a' })]);
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial', { band: 5 });
  const g = R.grid(ctx, { cell: 4 });
  const fx = R.fieldEx(ctx, g, st);
  for (const [x, y, want] of [
    [200, 450, 0],
    [560, 470, 1],
    [900, 420, 2],
  ]) {
    const q = n(x, y);
    const d = M.pointSignalDetail(ctx, q, st);
    assert.equal(d.winner, want, `winner at ${x},${y}`);
    assert.equal(d.bestSource, want ? 'node' : 'router');
    assert.equal(d.nodes.length, 2);
    close(d.combined, Math.max(d.router, ...d.nodes), 1e-12);
    close(d.combined, R.sample(g, fx.field, q), 1, 'point = raster');
    const i = Math.floor((y / 4)) * g.cols + Math.floor(x / 4);
    assert.equal(fx.nodeWins[i], want);
  }
  const far = M.pointSignalDetail(ctx, n(900, 420), st);
  assert.equal(far.nodeIndex, 1);
  assert.equal(far.nodeId, 'node-b');
  // backhaul of B comes from A (its uplink, A's power added) on B's backhaul band
  close(far.backhaul, M.softSignal(ctx, st.nodes[0].pos, st.nodes[1].pos, 5, 0), 1e-9);
  assert.deepEqual(M.backhaulSignals(ctx, st), [M.backhaulSignal(ctx, st, 0), M.backhaulSignal(ctx, st, 1)]);
  close(M.backhaulSignal(ctx, st, 0), M.softSignal(ctx, st.router, st.nodes[0].pos, 5, 0), 1e-9, 'A from the router');
  // Auto: the winner of the steered band
  const sa = M.steeredSignal(ctx, n(900, 420), M.fieldParams(p, 'trial'));
  assert.equal(sa.winner, 2);
  assert.equal(sa.nodeWins, true);
  assert.equal(M.combinedSignal(ctx, n(900, 420), 5, st), far.combined);
});

test('contours per node (source "node:<id>"), zone borders and shares of every source', () => {
  const p = withNodes(rowPlan(), [A_NODE(), B_NODE()]);
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial');
  const base = { ...st, threshold: -60 };
  const lineB = R.contours(ctx, { ...base, source: 'node:node-b' });
  const lineBAlone = R.contours(ctx, { ...base, nodes: [st.nodes[1]], source: 'node' });
  assert.ok(lineB.length > 0);
  assert.deepEqual(lineB, lineBAlone, 'node B alone');
  assert.deepEqual(R.contours(ctx, { ...base, source: 'node' }), R.contours(ctx, { ...base, source: 'node:node-a' }), "'node' = the first node");
  assert.notDeepEqual(lineB, R.contours(ctx, { ...base, source: 'node:node-a' }));
  assert.deepEqual(R.contours(ctx, { ...base, source: 'node:nope' }), []);
  assert.deepEqual(R.contours(ctx, { ...base, source: 'router' }), R.contours(ctx, { ...base, nodes: [] }));
  // zones
  const g = R.grid(ctx, { cell: 8 });
  const fx = R.fieldEx(ctx, g, st);
  const edges = R.sourceEdges(g, fx.nodeWins);
  assert.ok(edges.length >= 2 && edges.every((ch) => ch.length > 2), 'a border around each node zone');
  const sh = R.sourceShare(g, fx.nodeWins, null, []);
  assert.equal(sh.bySource.length, 3);
  close(sh.bySource.reduce((s, v) => s + v, 0), 100, 1e-9);
  close(sh.router, sh.bySource[0], 1e-12);
  close(sh.node, sh.bySource[1] + sh.bySource[2], 1e-9);
  assert.ok(sh.perRoomBySource.get(2)[1] > 80 && sh.perRoomBySource.get(3)[2] > 80 && sh.perRoomBySource.get(1)[0] > 80, 'each room its own source');
  close(sh.perRoom.get(3), 100 - sh.perRoomBySource.get(3)[0], 1e-9);
});

test('speed: uplink chains (a repeater behind a repeater x 0.25, a wired AP behind a mesh node gets its capacity, unknown above = unknown)', () => {
  const p = withNodes(rowPlan(), [A_NODE({ mode: 'repeater', maxMbps: 400 }), B_NODE({ mode: 'repeater', uplink: 'node-a' })]);
  const ctx = M.createContext(p);
  const st = M.fieldParams(p, 'trial');
  const links = S.nodeLinks(ctx, st, CURVE);
  assert.deepEqual(
    links.map((l) => [l.id, l.uplink, l.uplinkIndex, l.hops, l.chainFactor]),
    [
      ['node-a', 'router', -1, 1, 0.5],
      ['node-b', 'node-a', 0, 2, 0.25],
    ],
  );
  const la = links[0];
  const lb = links[1];
  close(la.signal, M.backhaulSignal(ctx, st, 0), 1e-12);
  close(la.down, S.rate(CURVE, la.signal).down * 0.5, 1e-9);
  close(lb.signal, M.backhaulSignal(ctx, st, 1), 1e-12);
  close(lb.down, Math.min(S.rate(CURVE, lb.signal).down * 0.25, la.capDown), 1e-9);
  assert.deepEqual(lb.upstream, { down: la.capDown, up: la.capUp });
  assert.deepEqual(S.nodeLink(ctx, st, CURVE, { index: 1 }), lb);
  assert.deepEqual(S.nodeLink(ctx, st, CURVE), la, 'index 0 by default');
  // a wired AP behind the mesh node: no own hop, the mesh node's capacity
  const pw = withNodes(p, [p.nodes[0], { ...p.nodes[1], mode: 'ap_cable' }]);
  const lw = S.nodeLinks(ctx, M.fieldParams(pw, 'trial'), CURVE);
  assert.equal(lw[1].wireless, false);
  assert.equal(lw[1].hops, 1);
  close(lw[1].down, lw[0].capDown, 1e-12);
  // the first hop unknown (a curve that ends before its signal): everything behind it unknown
  const narrow = S.buildCurve([sm(-40, 600, 200), sm(-50, 450, 150)], { band: 5, device: 'Telefon' });
  const ln = S.nodeLinks(ctx, st, narrow);
  assert.equal(ln[0].known, false);
  assert.equal(ln[1].known, false);
  // the Speed map: a cell goes through the link of the node that wins it
  const g = R.grid(ctx, { cell: 8 });
  const a = A.run(p, { cell: 8, ctx, offsets: { '2.4': 0, '5': 0, '6': 0 } });
  const sf = S.fieldSpeed(ctx, g, a.params.trial, CURVE, { reserve: 0 }, a.trial);
  assert.equal(sf.links.length, 2);
  let onB = 0;
  for (const i of g.idx) {
    if (a.nodeWins[i] !== 2 || !sf.known[i]) continue;
    onB++;
    assert.ok(sf.down[i] <= lb.capDown + 1e-6, 'node B cells are capped by its chained link');
    const v = S.predictVia(CURVE, a.trial[i], { reserve: 0 }, lb);
    close(sf.down[i], v.down, 1e-3);
  }
  assert.ok(onB > 20, `cells served by B: ${onB}`);
  // the summary: shares per node add up
  const h = S.homeSummary(ctx, g, a.params.trial, CURVE, { reserve: 0 }, { targetDown: 50, targetUp: 20 }, a.trial);
  assert.equal(h.nodeShares.length, 2);
  close(h.nodeShares[0] + h.nodeShares[1], h.nodeShare, 1e-9);
  assert.equal(h.links.length, 2);
  // the tooltip: which source, which link
  const tip = S.pointSpeed(ctx, n(900, 420), a.params.trial, CURVE, { reserve: 0 });
  assert.equal(tip.sourceIndex, 2);
  assert.equal(tip.sourceId, 'node-b');
  assert.equal(tip.link.id, 'node-b');
});

test('analysis.run: every node with its backhaul and share; what-if names the node that serves a point', () => {
  const ms = [
    { id: 'm1', x: n(880, 420).x, y: n(880, 420).y, band: 5, value: -80, name: 'far', download: 8, upload: 3, device: 'Telefon', t: 1 },
    { id: 'm2', x: n(560, 420).x, y: n(560, 420).y, band: 5, value: -66, name: 'mid', download: 60, upload: 20, device: 'Telefon', t: 1 },
  ];
  const p = withNodes(rowPlan({ measurements: ms }), [A_NODE({ mode: 'mesh_wifi' }), B_NODE()]);
  const a = A.run(p, { cell: 8, curves: CURVE });
  assert.deepEqual(
    a.nodes.map((x) => [x.id, x.index, x.mode, x.onFloor, x.uplink]),
    [
      ['node-a', 0, 'mesh_wifi', true, 'router'],
      ['node-b', 1, 'ap_cable', true, 'router'],
    ],
  );
  close(a.nodes[0].backhaul, M.backhaulSignal(a.ctx, a.params.trial, 0), 1e-12);
  assert.equal(a.nodes[1].backhaul, null, 'wired: no wireless uplink');
  close(a.nodes[0].share + a.nodes[1].share, a.sourceShare.node, 1e-9);
  assert.ok(a.nodes[0].link && a.nodes[0].link.wireless && a.nodes[1].link && !a.nodes[1].link.wireless);
  assert.equal(A.run(p, { cell: 8 }).nodes[0].link, null, 'no curves -> no Mb/s');
  assert.equal(A.whatIfActive(p), true);
  const list = A.predictAtMeasurements(a.ctx, p, { offsets: a.offsets, curves: { 5: CURVE } });
  assert.deepEqual(
    list.map((e) => [e.id, e.source, e.sourceIndex, e.sourceId]),
    [
      ['m1', 'node', 2, 'node-b'],
      ['m2', 'node', 1, 'node-a'],
    ],
  );
  assert.ok(list[0].delta > 15 && list[1].delta > 3);
  // both switched off: nothing changes
  const off = withNodes(p, p.nodes.map((x) => ({ ...x, enabled: false })));
  assert.equal(A.whatIfActive(off), false);
  assert.ok(A.predictAtMeasurements(a.ctx, off, { offsets: a.offsets }).every((e) => e.delta === 0 && e.source === 'router'));
});

test('optimizer: every node stays put and counts; speed mode through the chained links', async () => {
  const p = withNodes(rowPlan(), [A_NODE({ mode: 'repeater' }), B_NODE({ mode: 'repeater', uplink: 'node-a' })]);
  const ctx = M.createContext(p);
  const g = R.grid(ctx, { cell: 8 });
  const st = M.fieldParams(p, 'trial');
  const base = { band: 5, threshold: -67, router: p.net.router, offsets: st.offsets, goalRoom: null, allowedRoom: null };
  const solo = await E.optimize.find(ctx, g, base);
  const r = await E.optimize.find(ctx, g, { ...base, nodes: st.nodes });
  assert.ok(r.after.coverage >= solo.after.coverage - 0.5);
  assert.ok(P.roomAt(p.plan, r.pos), 'on the floor');
  const legacy = await E.optimize.find(ctx, g, { ...base, node: st.nodes[0] });
  const one = await E.optimize.find(ctx, g, { ...base, nodes: [st.nodes[0]] });
  assert.deepEqual(legacy.pos, one.pos, 'one node: the legacy call');
  const sp = await E.optimize.find(ctx, g, { ...base, nodes: st.nodes, speed: { curve: CURVE, targetDown: 50, targetUp: 20, limits: {}, reserve: 0 } });
  assert.ok(Number.isFinite(sp.score) && P.roomAt(p.plan, sp.pos));
});

test('performance: 8 nodes on a real-size plan - a drag frame (cell 8, cache) stays cheap: node fields are cached', () => {
  const b = busyPlan();
  const modes = ['ap_cable', 'mesh_wifi', 'repeater', 'mesh_cable'];
  const spots = [[250, 200], [550, 200], [850, 200], [250, 450], [850, 450], [250, 700], [550, 700], [850, 700]];
  const raw = spots.map(([x, y], k) => mkNode({ id: `node-${k + 1}`, mode: modes[k % 4], pos: n(x, y), uplink: k === 2 ? 'node-2' : 'router' }));
  const p0 = makeProject({ rooms: b.rooms, walls: b.walls, furniture: b.furniture, router: [551, 447], view: { band: 'auto' } });
  const p = P.sanitize({ ...p0, nodes: raw });
  assert.equal(M.nodeList(p).length, 8);
  const frames = (proj) => {
    const ctx = M.createContext(proj);
    const offsets = M.offsets(ctx, proj);
    const cache = {};
    const times = [];
    for (let f = 0; f < 30; f++) {
      proj.net.router = P.nearestFloor(proj.plan, n(300 + f * 12, 300 + (f % 6) * 30));
      const t0 = performance.now();
      A.run(proj, { cell: 8, aa: 1, ctx, offsets, cache });
      times.push(performance.now() - t0);
    }
    const s = times.slice(4).sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  const solo = frames(P.sanitize({ ...p0, nodes: [] }));
  const eight = frames(p);
  // < 10 ms on a normal machine (7-8 ms measured, Auto = two bands); a CI box may be slower: compare with the frame
  // without nodes (the nodes' fields come from the cache, only the combine, zones and shares are extra)
  assert.ok(eight < Math.max(25, solo * 2), `8 nodes ${eight.toFixed(1)} ms vs no node ${solo.toFixed(1)} ms`);
});
