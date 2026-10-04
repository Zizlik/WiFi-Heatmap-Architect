// SPEC 10.3: who serves what with a second node - range lines per source (contours {source}), the border between the
// router's and the node's zone (raster.sourceEdges), the shares (raster.sourceShare) and analysis.run's source fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './_load.mjs';
import { n, room, wall, makeProject, ctxOf } from './_helpers.mjs';

const { raster, model } = E;
const { W, H } = E.CANVAS;

// a 12 dB wall at x = 600 splits one room: the router (x 350) owns the left, the wired node (x 850) the right
const NODE = { mode: 'ap_cable', pos: n(850, 450), bands: { '2.4': true, '5': true, '6': true }, power: 0, backhaulBand: 5, backhaulThreshold: -70 };
const onePlan = (extra) => makeProject({ rooms: [room(1, 100, 100, 1000, 800)], walls: [wall('w', 600, 0, 600, 942, 12)], router: [350, 450], node: NODE, ...(extra || {}) });
const onSide = (chains, right) => chains.some((ch) => ch.some((q) => (right ? q.x * W > 800 : q.x * W < 400)));
const count = (chains) => chains.reduce((s, ch) => s + ch.length, 0);

test('contours {source}: router = the node ignored, node = the node alone, combined (default) = as before', () => {
  const p = onePlan();
  const c = ctxOf(p);
  const node = model.nodeParams(p);
  const base = { band: 5, router: p.net.router, node, offset: 0, threshold: -52 };
  const combined = raster.contours(c, base);
  assert.deepEqual(raster.contours(c, { ...base, source: 'combined' }), combined, 'default = combined');
  assert.deepEqual(raster.contours(c, { ...base, source: 'bogus' }), combined, 'an unknown source = combined');
  const router = raster.contours(c, { ...base, source: 'router' });
  assert.deepEqual(router, raster.contours(c, { ...base, node: null }), 'router = the node ignored');
  assert.ok(onSide(router, false) && !onSide(router, true), 'the router lines stay on its side of the wall');
  const nodeL = raster.contours(c, { ...base, source: 'node' });
  assert.ok(nodeL.length >= 1 && count(nodeL) > 20);
  assert.ok(onSide(nodeL, true) && !onSide(nodeL, false), 'the node lines stay on the far side');
  assert.notDeepEqual(nodeL, router);
  // the node alone = a router standing where the node stands; its power shifts the line like an offset
  assert.deepEqual(nodeL, raster.contours(c, { band: 5, router: node.pos, offset: 0, threshold: -52 }));
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: { ...node, power: 4 } }), raster.contours(c, { band: 5, router: node.pos, offset: 4, threshold: -52 }));
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', offset: undefined, offsets: { '2.4': 0, '5': -3, '6': 0 }, node: { ...node, power: 2 } }), raster.contours(c, { band: 5, router: node.pos, offset: -1, threshold: -52 }), 'offsets map + power');
  assert.deepEqual(raster.contours(c, { ...base, source: 'node' }), nodeL, 'deterministic');
  // the combined lines are the union of the zones: every router / node point lies where the combined field is at the threshold too
  assert.ok(combined.length >= 1 && onSide(combined, true) && onSide(combined, false));
  // nothing for the node source without a node, with the node off or on a band it does not serve
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: { ...node, bands: { '2.4': true, '5': false, '6': false } } }), []);
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: null }), []);
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: { ...node, mode: 'none' } }), []);
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: undefined }), []);
  // the options are not mutated
  const snap = JSON.stringify(base);
  raster.contours(c, { ...base, source: 'node' });
  assert.equal(JSON.stringify(base), snap);
  // a programming mistake still throws
  assert.throws(() => raster.contours(c, { router: p.net.router, node, threshold: -60, source: 'node' }), RangeError);
  assert.throws(() => raster.contours(c, { router: p.net.router, node, threshold: -60, source: 'router' }), RangeError);
});

test('contours {source} in the band mode Auto (SPEC 13), on the exact lattice and with a given field', () => {
  const p = onePlan();
  const c = ctxOf(p);
  const node = model.nodeParams(p);
  const st = model.fieldParams(p, 'trial', { band: 'auto' });
  assert.deepEqual(st.bands, [2.4, 5]);
  // -50 dBm: at -55 the node's 2.4 GHz signal (wall loss x 0.65) legitimately reaches the router's side of the wall
  const base = { band: 'auto', bands: st.bands, steer: st.steer, router: p.net.router, node, offsets: { '2.4': 0, '5': 0, '6': 0 }, threshold: -50 };
  const nodeL = raster.contours(c, { ...base, source: 'node' });
  assert.ok(nodeL.length >= 1 && onSide(nodeL, true) && !onSide(nodeL, false));
  assert.deepEqual(nodeL, raster.contours(c, { ...base, router: node.pos, node: null }), 'a router at the node\'s place on the node\'s bands');
  assert.deepEqual(raster.contours(c, { ...base, source: 'router' }), raster.contours(c, { ...base, node: null }));
  // the node serving 5 GHz only: its lines are the 5 GHz lines from its place; serving none of the router's bands: nothing
  const n5 = { ...node, bands: { '2.4': false, '5': true, '6': false } };
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: n5 }), raster.contours(c, { ...base, bands: [5], router: node.pos, node: null }));
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: { ...node, bands: { '2.4': false, '5': false, '6': true } } }), []);
  // the node's power goes into every band's offset
  assert.deepEqual(raster.contours(c, { ...base, source: 'node', node: { ...node, power: 3 } }), raster.contours(c, { ...base, router: node.pos, node: null, offsets: { '2.4': 3, '5': 3, '6': 0 } }));
  // the exact lattice (soften 0) honours the source too
  const ex = { band: 5, router: p.net.router, node, offset: 0, threshold: -52, soften: 0, res: [60, 52] };
  const exNode = raster.contours(c, { ...ex, source: 'node' });
  assert.ok(exNode.length >= 1 && onSide(exNode, true) && !onSide(exNode, false));
  assert.deepEqual(raster.contours(c, { ...ex, source: 'router' }), raster.contours(c, { ...ex, node: null }));
  // a given grid + field is traced as it is (the source is ignored there)
  const g = raster.grid(c, { cell: 8 });
  const f = raster.field(c, g, model.fieldParams(p, 'trial', { band: 5 }));
  const given = { band: 5, router: p.net.router, threshold: -52, grid: g, field: f };
  assert.deepEqual(raster.contours(c, { ...given, source: 'node' }), raster.contours(c, given));
});

test('sourceEdges: the border between the zones, smoothed; [] when one source wins everywhere or without a mask', () => {
  const p = onePlan();
  const c = ctxOf(p);
  const g = raster.grid(c, { cell: 8 });
  const r = raster.fieldEx(c, g, model.fieldParams(p, 'trial', { band: 5 }));
  assert.ok(r.nodeWins, 'the node is on');
  const edges = raster.sourceEdges(g, r.nodeWins);
  assert.ok(edges.length >= 1 && count(edges) > 20);
  assert.deepEqual(raster.sourceEdges(g, r.nodeWins), edges, 'deterministic');
  // the border runs along the 12 dB wall: every point near the floor has router cells AND node cells within 2 cells
  let checked = 0;
  for (const ch of edges) {
    for (const q of ch) {
      const cc = Math.floor((q.x * W) / g.cell);
      const rr = Math.floor((q.y * H) / g.cell);
      let w0 = false;
      let w1 = false;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const r2 = rr + dr;
          const c2 = cc + dc;
          if (r2 < 0 || r2 >= g.rows || c2 < 0 || c2 >= g.cols) continue;
          const i = r2 * g.cols + c2;
          if (!g.room[i]) continue;
          if (r.nodeWins[i]) w1 = true;
          else w0 = true;
        }
      }
      if (w0 || w1) {
        checked++;
        assert.ok(w0 && w1, `edge point ${(q.x * W).toFixed(0)},${(q.y * H).toFixed(0)} px is not between the zones`);
        assert.ok(Math.abs(q.x * W - 600) < 1.5 * g.cell, `the border stays at the wall: x ${(q.x * W).toFixed(0)} px`);
      }
    }
  }
  assert.ok(checked > count(edges) * 0.8, 'most points lie on (or right next to) the floor');
  // raw polylines with smooth 0; the smoothed ones stay within half a cell of them
  const raw = raster.sourceEdges(g, r.nodeWins, { smooth: 0 });
  assert.equal(raw.length, edges.length);
  for (const ch of edges) {
    for (const q of ch) {
      let d = Infinity;
      for (const rc of raw) for (const w of rc) d = Math.min(d, Math.hypot((q.x - w.x) * W, (q.y - w.y) * H));
      assert.ok(d <= 0.5 * g.cell + 1e-6, `smoothed point ${d.toFixed(2)} px from the raw line`);
    }
  }
  assert.deepEqual(raster.sourceEdges(g, new Uint8Array(g.cols * g.rows)), [], 'the router everywhere');
  assert.deepEqual(raster.sourceEdges(g, new Uint8Array(g.cols * g.rows).fill(1)), [], 'the node everywhere');
  assert.deepEqual(raster.sourceEdges(g, null), []);
  assert.deepEqual(raster.sourceEdges(g, new Uint8Array(3)), [], 'a mask of another grid');
  assert.deepEqual(raster.sourceEdges(null, r.nodeWins), []);
});

test('sourceShare per room / for the goal; analysis.run exposes source, sourceEdges and sourceShare', () => {
  const rooms = [room(1, 100, 100, 600, 800, 'L'), room(2, 600, 100, 1000, 800, 'R')];
  const walls = [wall('w', 600, 100, 600, 800, 12)];
  const p = makeProject({ rooms, walls, router: [350, 450], node: NODE, view: { band: 5 } });
  const a = E.analysis.run(p, { cell: 8 });
  assert.ok(a.nodeWins && a.source === a.nodeWins, 'source = nodeWins');
  assert.ok(a.sourceEdges.length >= 1);
  assert.deepEqual(a.sourceEdges, raster.sourceEdges(a.grid, a.nodeWins));
  const s = a.sourceShare;
  assert.ok(s && Math.abs(s.node + s.router - 100) < 1e-9);
  assert.ok(s.perRoom.get(1) < 5 && s.perRoom.get(2) > 95, `L ${s.perRoom.get(1)} R ${s.perRoom.get(2)}`);
  assert.ok(s.node > 36 && s.node < 52, `node share ${s.node} (the right room is 400 of 900 px wide)`);
  const goal = raster.sourceShare(a.grid, a.nodeWins, [2]);
  assert.ok(goal.node > 95 && goal.perRoom.size === 2, 'the goal room only');
  assert.ok(raster.sourceShare(a.grid, a.nodeWins, null, [2]).node < 5, 'an excluded room leaves the whole-flat share');
  assert.ok(raster.sourceShare(a.grid, a.nodeWins, 2).node > 95, 'a single room id');
  // without a node: nothing
  const p0 = makeProject({ rooms, walls, router: [350, 450], view: { band: 5 } });
  const a0 = E.analysis.run(p0, { cell: 8 });
  assert.equal(a0.source, null);
  assert.deepEqual(a0.sourceEdges, []);
  assert.equal(a0.sourceShare, null);
  const none = raster.sourceShare(a0.grid, null);
  assert.equal(none.node, 0);
  assert.equal(none.router, 100);
  assert.equal(none.perRoom.get(2), 0);
  assert.deepEqual(raster.sourceShare(null, null).perRoom.size, 0);
  // the band mode Auto (the default) and a cache do not change it; deterministic
  const pa = makeProject({ rooms, walls, router: [350, 450], node: NODE });
  const cache = {};
  const aa = E.analysis.run(pa, { cell: 8, cache });
  assert.equal(aa.band, 'auto');
  assert.ok(aa.sourceEdges.length >= 1 && aa.sourceShare.perRoom.get(2) > 90);
  assert.deepEqual(E.analysis.run(pa, { cell: 8, cache }).sourceEdges, aa.sourceEdges);
  assert.deepEqual(E.analysis.run(pa, { cell: 8 }).sourceShare, aa.sourceShare);
});
