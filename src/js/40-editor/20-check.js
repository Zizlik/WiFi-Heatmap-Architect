/* Floor-plan editor - "Kontrola půdorysu" (plan check).
 *   WH.editor.check.run(plan, mpp) -> issues[]   (pure; no DOM, no store)
 *   WH.editor.check.fix(issue)     -> bool       (one undoable commit)
 * Issue = {type:'gap'|'door'|'edges'|'overlap'|'outside', key, ids[], params, box, geom, fix:null|'join'|'snap'|'door'|'dropDoor'|'edges', data}
 * Checks: (a) wall ends that almost meet another wall end or wall but leave a 0.5-20 px gap (also an offset "jog" between two
 * parallel walls), (b) doors without a wall or lying off it, (c) room edges without any wall, (d) overlapping rooms,
 * (e) furniture outside every room. */
(function () {
  'use strict';
  const g = globalThis;
  g.WH = g.WH || {};
  const WH = g.WH;
  const ED = (WH.editor = WH.editor || {});

  const W = 1080;
  const H = 942;
  const GAP_MIN = 0.5;
  const GAP_MAX = 20;
  const MAX_ISSUES = 30;
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const R6 = (p) => ({ x: r6(p.x), y: r6(p.y) });
  const dpx = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
  const kp = (p) => `${Math.round(p.x * W)},${Math.round(p.y * H)}`;
  const E = () => WH.engine;
  function boxOf(pts) {
    let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }
  const near = (p, w) => E().geom.closestOnSegment(p, w.a, w.b);
  const dir = (w) => Math.atan2((w.b.y - w.a.y) * H, (w.b.x - w.a.x) * W);
  function angleDiff(a, b) { let d = Math.abs(a - b) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d; }

  // ---------------------------------------------------------------------------------------------------------------
  // (a) gaps between walls
  // ---------------------------------------------------------------------------------------------------------------
  /** Wall end points clustered into nodes (ends closer than 0.5 px are one node). */
  function nodesOf(walls) {
    const nodes = [];
    for (const w of walls) {
      for (const k of ['a', 'b']) {
        let n = nodes.find((m) => dpx(m.p, w[k]) <= GAP_MIN);
        if (!n) { n = { p: w[k], ends: [] }; nodes.push(n); }
        n.ends.push({ w, k });
      }
    }
    return nodes;
  }

  function gaps(pl, out, cm) {
    const walls = pl.walls.filter((w) => dpx(w.a, w.b) >= 1);
    const nodes = nodesOf(walls);
    const pairs = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const A = nodes[i];
        const B = nodes[j];
        const d = dpx(A.p, B.p);
        if (d <= GAP_MIN || d > GAP_MAX) continue;
        if (A.ends.some((ea) => B.ends.some((eb) => ea.w === eb.w))) continue; // both ends of one short wall
        const joined = walls.some((w) => near(A.p, w).d <= GAP_MIN && near(B.p, w).d <= GAP_MIN);
        const jog = A.ends.some((ea) => B.ends.some((eb) => angleDiff(dir(ea.w), dir(eb.w)) < Math.PI / 12));
        if (joined && !jog) continue; // e.g. two walls meeting the same wall a few cm apart
        pairs.push({ A, B, d });
      }
    }
    pairs.sort((x, y) => x.d - y.d);
    const used = new Set();
    for (const pr of pairs) {
      if (used.has(pr.A) || used.has(pr.B)) continue;
      used.add(pr.A);
      used.add(pr.B);
      const wa = pr.A.ends[0].w;
      const wb = pr.B.ends[0].w;
      out.push({
        type: 'gap', key: `gap:${kp(pr.A.p)}:${kp(pr.B.p)}`, ids: [wa.id, wb.id],
        params: { a: wa.name, b: wb.name, d: cm(pr.d) }, box: boxOf([pr.A.p, pr.B.p]),
        geom: { pts: [pr.A.p, pr.B.p] }, fix: 'join', data: { from: R6(pr.A.p), to: R6(pr.B.p) },
      });
    }
    // a lone wall end stopping just short of another wall
    for (const N of nodes) {
      if (used.has(N) || N.ends.length > 1) continue;
      const own = N.ends[0].w;
      if (walls.some((w) => w !== own && near(N.p, w).d <= GAP_MIN)) continue;
      let best = null;
      let bd = GAP_MAX;
      for (const w of walls) {
        if (w === own) continue;
        const c = near(N.p, w);
        if (c.d > GAP_MIN && c.d <= bd) { bd = c.d; best = { w, c }; }
      }
      if (!best) continue;
      const to = R6(best.c);
      out.push({
        type: 'gap', key: `end:${own.id}:${N.ends[0].k}:${kp(N.p)}`, ids: [own.id, best.w.id],
        params: { a: own.name, b: best.w.name, d: cm(bd) }, box: boxOf([N.p, to]),
        geom: { pts: [N.p, to] }, fix: 'snap', data: { from: R6(N.p), to },
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // (b) doors, (c) edges without walls, (d) overlapping rooms, (e) furniture outside rooms
  // ---------------------------------------------------------------------------------------------------------------
  function doors(pl, out) {
    const byId = new Map(pl.walls.map((w) => [w.id, w]));
    for (const d of pl.doors) {
      const w = byId.get(d.wallId);
      const off = !w || Math.max(near(d.a, w).d, near(d.b, w).d) > 2;
      if (!off) continue;
      out.push({
        type: 'door', key: `door:${d.id}:${kp(d.a)}`, ids: [d.id], params: { a: d.name },
        box: boxOf([d.a, d.b]), geom: { segs: [[d.a, d.b]] }, fix: w ? 'door' : 'dropDoor', data: { id: d.id },
      });
    }
  }

  function edges(pl, out) {
    if (!pl.rooms.length) return;
    const segs = E().project.autoWalls(pl).filter((w) => dpx(w.a, w.b) >= 12);
    if (!segs.length) return;
    const pts = [];
    for (const w of segs) pts.push(w.a, w.b);
    out.push({
      type: 'edges', key: `edges:${segs.map((w) => kp(w.a) + kp(w.b)).join('|')}`, ids: [],
      params: { n: segs.length }, box: boxOf(pts), geom: { segs: segs.map((w) => [w.a, w.b]) }, fix: 'edges',
    });
  }

  /** Overlap area of two polygons in px^2 (sampling the shared bounding box, <= ~1600 samples). */
  function overlapPx(p1, p2, b1, b2) {
    const x0 = Math.max(b1.minX, b2.minX) * W;
    const x1 = Math.min(b1.maxX, b2.maxX) * W;
    const y0 = Math.max(b1.minY, b2.minY) * H;
    const y1 = Math.min(b1.maxY, b2.maxY) * H;
    if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
    const st = Math.max(1.5, Math.sqrt(((x1 - x0) * (y1 - y0)) / 1600));
    const pip = E().geom.pointInPolygon;
    let n = 0;
    for (let x = x0 + st / 2; x < x1; x += st) {
      for (let y = y0 + st / 2; y < y1; y += st) {
        const q = { x: x / W, y: y / H };
        if (pip(q, p1) && pip(q, p2)) n += 1;
      }
    }
    return n * st * st;
  }

  function overlaps(pl, out, m2) {
    const R = pl.rooms;
    const bb = R.map((r) => boxOf(r.points));
    const area = R.map((r) => E().geom.polygonAreaPx(r.points));
    for (let i = 0; i < R.length; i += 1) {
      for (let j = i + 1; j < R.length; j += 1) {
        const a = bb[i];
        const b = bb[j];
        if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY) continue;
        const ov = overlapPx(R[i].points, R[j].points, a, b);
        if (ov <= Math.max(150, 0.03 * Math.min(area[i], area[j]))) continue;
        out.push({
          type: 'overlap', key: `overlap:${R[i].id}:${R[j].id}`, ids: [R[i].id, R[j].id],
          params: { a: R[i].name, b: R[j].name, m: m2(ov) },
          box: { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) },
          geom: { polys: [R[i].points, R[j].points] }, fix: null,
        });
        if (out.length >= MAX_ISSUES) return;
      }
    }
  }

  function outside(pl, out) {
    if (!pl.rooms.length) return;
    for (const f of pl.furniture) {
      const c = E().geom.polygonCentroid(f.points);
      if (E().project.roomAt(pl, c) || f.points.some((q) => E().project.roomAt(pl, q))) continue;
      out.push({ type: 'outside', key: `outside:${f.id}:${kp(c)}`, ids: [f.id], params: { a: f.name }, box: boxOf(f.points), geom: { polys: [f.points] }, fix: null });
      if (out.length >= MAX_ISSUES) return;
    }
  }

  function run(pl, mpp) {
    const out = [];
    if (!pl || !E()) return out;
    const m = mpp > 0 ? mpp : 0.012;
    const cm = (px) => String(Math.max(1, Math.round(px * m * 100)));
    const m2 = (px2) => WH.util.fmt(px2 * m * m, 1);
    for (const step of [() => gaps(pl, out, cm), () => doors(pl, out), () => edges(pl, out), () => overlaps(pl, out, m2), () => outside(pl, out)]) {
      if (out.length >= MAX_ISSUES) break;
      try { step(); } catch (e) { console.error('[editor] plan check failed:', e); }
    }
    return out.slice(0, MAX_ISSUES);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // fixes
  // ---------------------------------------------------------------------------------------------------------------
  /** Drop consecutive duplicate points (keeps intentionally collinear vertices). */
  function dedupe(pts) {
    const outP = [];
    for (const p of pts) if (!outP.length || dpx(outP[outP.length - 1], p) > GAP_MIN) outP.push(p);
    while (outP.length > 1 && dpx(outP[0], outP[outP.length - 1]) <= GAP_MIN) outP.pop();
    return outP;
  }

  /** Put the doors of a reshaped wall back on it (keep them where they are when they still lie on the wall). */
  function refitDoors(pl, w, old) {
    for (const d of pl.doors) {
      if (d.wallId !== w.id) continue;
      const ca = near(d.a, w);
      const cb = near(d.b, w);
      if (ca.d <= 1 && cb.d <= 1 && dpx(ca, cb) >= 8) { d.a = R6(ca); d.b = R6(cb); } else E().edit.fitDoors({ walls: [w], doors: [d] }, w.id, old);
    }
  }

  /** Move every wall end and room vertex sitting on `from` to `to` (mutates pl). false = a room would become invalid. */
  function moveNode(pl, from, to) {
    const T = R6(to);
    const moved = [];
    for (const w of pl.walls) {
      const old = { a: Object.assign({}, w.a), b: Object.assign({}, w.b) };
      let hit = false;
      for (const k of ['a', 'b']) if (dpx(w[k], from) <= GAP_MIN) { w[k] = { x: T.x, y: T.y }; hit = true; }
      if (hit) moved.push({ w, old });
    }
    for (const r of pl.rooms) {
      if (!r.points.some((q) => dpx(q, from) <= GAP_MIN)) continue;
      const pts = dedupe(r.points.map((q) => (dpx(q, from) <= GAP_MIN ? { x: T.x, y: T.y } : q)));
      if (!E().geom.validatePolygon(pts)) return false;
      r.points = pts;
    }
    for (const m of moved) refitDoors(pl, m.w, m.old);
    return moved.length > 0;
  }

  /** Cost of merging `from` into `to`: room-edge length left without a wall, then the largest wall rotation. */
  function joinCost(pl, from, to) {
    const copy = JSON.parse(JSON.stringify(Object.assign({}, pl, { background: null })));
    if (!moveNode(copy, from, to)) return null;
    const bare = E().project.autoWalls(copy).reduce((s, w) => s + dpx(w.a, w.b), 0);
    let ang = 0;
    copy.walls.forEach((w, i) => { if (dpx(w.a, w.b) >= 1) ang = Math.max(ang, angleDiff(dir(w), dir(pl.walls[i]))); });
    return { bare, ang };
  }

  /** Ways to close an offset "jog" between two parallel walls WITHOUT tilting one of them: shift the whole wall that ends
   *  at P sideways (both of its ends, the room corners and the walls attached there move with it) until it is collinear
   *  with the wall ending at Q, then close what is left of the gap along the wall line. */
  function jogPlans(pl, from, to) {
    const endsAt = (p) => pl.walls.filter((w) => dpx(w.a, w.b) >= 1 && (dpx(w.a, p) <= GAP_MIN || dpx(w.b, p) <= GAP_MIN));
    const plans = [];
    for (const [P, Q] of [[from, to], [to, from]]) {
      const atQ = endsAt(Q);
      for (const w of endsAt(P)) {
        if (!atQ.some((v) => v !== w && angleDiff(dir(v), dir(w)) < Math.PI / 12)) continue;
        const dx = (w.b.x - w.a.x) * W;
        const dy = (w.b.y - w.a.y) * H;
        const len = Math.hypot(dx, dy);
        const nx = -dy / len;
        const ny = dx / len;
        const off = (Q.x - P.x) * W * nx + (Q.y - P.y) * H * ny; // sideways offset in px
        if (Math.abs(off) <= GAP_MIN) continue;                  // already in line: the plain join stays straight
        const far = dpx(w.a, P) <= GAP_MIN ? w.b : w.a;
        plans.push({ P: R6(P), Q: R6(Q), far: R6(far), shift: { x: (off * nx) / W, y: (off * ny) / H }, len, off: Math.abs(off), name: w.name });
      }
    }
    return plans;
  }

  function applyJog(p, plan) {
    const sh = (q) => ({ x: q.x + plan.shift.x, y: q.y + plan.shift.y });
    if (sh(plan.far).x < 0 || sh(plan.far).x > 1 || sh(plan.far).y < 0 || sh(plan.far).y > 1) return false;
    if (!moveNode(p, plan.far, sh(plan.far))) return false;
    const P2 = sh(plan.P);
    if (!moveNode(p, plan.P, P2)) return false;
    if (dpx(P2, plan.Q) > GAP_MIN && !moveNode(p, P2, plan.Q)) return false;
    return true;
  }

  /** Cheapest jog plan (fewest bare room edges afterwards, then the shorter wall) or null. */
  function bestJog(pl, from, to) {
    let best = null;
    for (const plan of jogPlans(pl, from, to)) {
      const copy = JSON.parse(JSON.stringify(Object.assign({}, pl, { background: null })));
      if (!applyJog(copy, plan)) continue;
      const bare = E().project.autoWalls(copy).reduce((s, w) => s + dpx(w.a, w.b), 0);
      if (!best || bare < best.bare - 1 || (Math.abs(bare - best.bare) <= 1 && plan.len < best.plan.len)) best = { plan, bare };
    }
    return best && best.plan;
  }

  function fix(issue) {
    const pl = ED.plan();
    ED.check.lastNote = null;
    if (!issue || !pl) return false;
    const label = 'editor.undo.fix';
    switch (issue.fix) {
      case 'join': {
        let { from, to } = issue.data;
        const jog = bestJog(pl, from, to);
        if (jog) {
          const ok = ED.commit(label, (p) => applyJog(p, jog));
          if (ok) ED.check.lastNote = { key: 'editor.check.shifted', params: { name: jog.name, d: String(Math.max(1, Math.round(jog.off * ED.mpp() * 100))) } };
          if (ok) return true;
        }
        const c1 = joinCost(pl, from, to);
        const c2 = joinCost(pl, to, from);
        if (!c1 || (c2 && (c2.bare < c1.bare - 1 || (Math.abs(c2.bare - c1.bare) <= 1 && c2.ang < c1.ang)))) { const x = from; from = to; to = x; }
        if (!c1 && !c2) return false;
        return ED.commit(label, (p) => moveNode(p, from, to));
      }
      case 'snap':
        return ED.commit(label, (p) => moveNode(p, issue.data.from, issue.data.to));
      case 'door':
        return ED.commit(label, (p) => {
          const d = p.doors.find((x) => x.id === issue.data.id);
          const w = d && p.walls.find((x) => x.id === d.wallId);
          if (!w) return false;
          const fresh = E().edit.makeDoor(p, w.id, { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }, { widthM: Math.max(0.3, dpx(d.a, d.b) * ED.mpp()), mpp: ED.mpp() });
          d.a = fresh.a;
          d.b = fresh.b;
        });
      case 'dropDoor':
        return ED.commit(label, (p) => { E().edit.removeObject(p, issue.data.id); });
      case 'edges':
        return ED.autoWallsAll() > 0;
      default:
        return false;
    }
  }

  ED.check = { run, fix, moveNode, GAP_MIN, GAP_MAX };
})();
