/* Planner: any number of access points / mesh nodes / repeaters (SPEC 14.2) - what the UI does with them.
 *
 *   PL.nodes.max() / count() / canAdd()   the building holds at most MAX_NODES (8)
 *   PL.nodes.add(mode, {anchor})          a new node of that type on the active floor (one undo step), selected; where it
 *                                         starts: the engine's default (the room farthest from the other sources), a
 *                                         wireless node pulled back towards its uplink until that link is still good
 *   PL.nodes.remove(id)                   delete (nodes hanging on it take over its uplink; undoable, toast with Undo)
 *   PL.nodes.patch(id, fn, label)         one undoable change of one node, on any floor: fn(node, project) (false = no-op)
 *   PL.nodes.ref(p, id)                   the live node object of `id` (any floor) inside a store mutator
 *   PL.nodes.uplinkOptions(id)            [{value:'router'|nodeId, label}] without the node itself and the nodes behind it
 *   PL.nodes.info(id)                     what the latest analysis says about it: {backhaul, weakBackhaul, share, ...}|null
 *   PL.nodes.select(id) / selected()      the node whose settings are open (sidebar row) and whose marker is ringed
 *   PL.nodes.menu(anchor)                 "+ Přidat AP / mesh / opakovač": the four kinds
 * Only UI lives here; the data rules (ids, names, uplink chains, limits) are the engine's (WH.engine.project). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const ui = () => WH.ui;
  const store = () => WH.store;
  const EP = () => WH.engine.project;
  const N = (PL.nodes = {});
  N.KINDS = ['ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater'];
  /** Topics of a node change (a node of another floor lives inside `floors`). */
  N.TOPICS = ['nodes', 'floors'];

  /** The default name of a kind for a name that is still a default one ("AP 3" -> "Mesh 3"; an own name -> null). */
  const PREFIX = /^(AP|Mesh|Opakovač|Repeater)\s+(\d{1,2})$/;
  N.defaultName = (name, mode) => { const m = PREFIX.exec(String(name || '').trim()); return m ? `${t('planner.nodes.pfx.' + mode)} ${m[2]}` : null; };
  N.max = () => EP().MAX_NODES || 8;
  N.count = () => PL.allNodes().length;
  N.canAdd = () => N.count() < N.max();
  N.ref = (p, id) => {
    const here = (p.nodes || []).find((n) => n.id === id);
    if (here) return here;
    const x = Array.isArray(p.floors) ? EP().nodeById(p, id) : null;
    return x ? x.node : null;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // selection (the open row in the sidebar, the ringed marker on the map)
  // ---------------------------------------------------------------------------------------------------------------
  let sel = null;
  N.selected = () => (sel && N.ref(PL.P(), sel) ? sel : null);
  N.select = (id, o) => {
    const next = id && N.ref(PL.P(), id) ? id : null;
    if (next === sel && !(o && o.force)) return;
    sel = next;
    if (PL.stage && PL.stage.place) PL.requestDraw();
    if (PL.side && PL.side.schedule) PL.side.schedule();
    if (sel && o && o.reveal && PL.side && PL.side.revealNode) PL.side.revealNode(sel);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // where a new node starts
  // ---------------------------------------------------------------------------------------------------------------
  /** A wireless node (repeater / mesh over Wi-Fi) stops where its uplink's signal on the link band is still good (SPEC 10:
   *  a repeater deep in the weak area serves a strong signal but little speed); the marker never lands on a room name. */
  function placeNode(p, n) {
    const E = WH.engine;
    let q = n.pos;
    try {
      if (PL.nodeWireless(n.mode) && PL.routerHere() && PL.S.ctx) {
        const ctx = PL.ensureCtx(p);
        const band = n.backhaulBand;
        const off = (PL.S.offs && PL.S.offs[E.units.bandKey(band)]) || 0;
        const from = p.net.router;
        const want = n.backhaulThreshold + 3;
        let ok = null;
        for (let i = 4; i <= 24; i++) {
          const c = { x: from.x + ((q.x - from.x) * i) / 24, y: from.y + ((q.y - from.y) * i) / 24 };
          const room = E.project.roomAt(p.plan, c);
          if (!room || p.goal.excluded.includes(room.roomId)) continue;
          if (E.model.softSignal(ctx, from, c, band, off) >= want) ok = c;
        }
        if (ok) q = ok;
      }
      // keep the room's name readable: step ~0.9 m off the label point when the spot is that close to one
      const lp = p.plan.rooms.map((r) => ({ r, l: E.geom.labelPoint(r.points) }));
      const near = lp.find((x) => Math.hypot((x.l.x - q.x) * PL.W, (x.l.y - q.y) * PL.H) * p.scale.mpp < 0.7);
      if (near) {
        const d = 0.9 / p.scale.mpp;
        const room = E.project.roomAt(p.plan, q) || near.r;
        const c = [[0, d], [0, -d], [d, 0], [-d, 0]].map(([dx, dy]) => ({ x: near.l.x + dx / PL.W, y: near.l.y + dy / PL.H })).find((cand) => E.project.roomAt(p.plan, cand) === room);
        if (c) q = c;
      }
      if (PL.insidePoint) q = PL.insidePoint(q, 0.4);
    } catch (e) { PL.report(e, 'nodes.place'); }
    return PL.pt(q);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // add / remove / change
  // ---------------------------------------------------------------------------------------------------------------
  N.add = (mode) => {
    const p = PL.P();
    if (!p || !p.plan.rooms.length) { ui().toast({ i18n: 'planner.noplan.t' }, { kind: 'warn' }); return null; }
    if (!N.canAdd()) { ui().toast({ text: t('planner.nodes.max', { n: N.max() }) }, { kind: 'warn' }); return null; }
    let id = null;
    let name = '';
    const ok = store().commit('planner.undo.nodeAdd', (pr) => {
      const n = EP().newNode(pr, { mode: N.KINDS.includes(mode) ? mode : 'ap_cable', lang: WH.i18n.lang });
      if (!n) return false;
      // the engine names every new node "AP n": a mesh / repeater gets its own kind's word, and the number is the first
      // one no node of the building uses yet ("AP 2", "Mesh 3", "Opakovač 4" - the router is 1)
      if (PREFIX.test(String(n.name || '').trim())) {
        const used = new Set(EP().allNodes(pr).map((x) => { const m = /(\d{1,2})\s*$/.exec(String(x.node.name || '')); return m ? Number(m[1]) : 0; }));
        let k = 2;
        while (used.has(k)) k += 1;
        n.name = `${t('planner.nodes.pfx.' + n.mode)} ${k}`;
      }
      n.pos = placeNode(pr, n);
      pr.nodes.push(n);
      id = n.id;
      name = PL.nodeName(n);
    }, N.TOPICS);
    if (!id) return null;
    N.select(id, { reveal: true });
    if (PL.side && PL.side.openNodes) PL.side.openNodes();
    ui().toast(ok
      ? { text: t('planner.nodes.added', { name }), action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.nodeAdd') store().undo(); } } }
      : { text: t('planner.nodes.added', { name }) }, { kind: 'ok', ms: 6000 });
    if (PL.showNode) requestAnimationFrame(() => PL.showNode(id));
    return id;
  };

  /** Add wired APs at engine-suggested places (optimize.howMany steps: {floor, pos}) as ONE undo step; returns the added ids. */
  N.addPlanned = (steps) => {
    const ids = [];
    if (!Array.isArray(steps) || !steps.length) return ids;
    store().commit('planner.undo.nodeAdd', (pr) => {
      for (const s of steps) {
        const floor = s.floor === null || s.floor === undefined ? undefined : s.floor;
        const nd = EP().newNode(pr, { mode: 'ap_cable', pos: s.pos, floor, lang: WH.i18n.lang });
        if (!nd || !EP().addNode(pr, nd, floor)) break;
        ids.push(nd.id);
      }
    }, N.TOPICS);
    if (ids.length) {
      N.select(ids[0], { reveal: true });
      if (PL.side && PL.side.openNodes) PL.side.openNodes();
      ui().toast({ text: t('planner.nodes.suggest.added', { n: ids.length }), action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.nodeAdd') store().undo(); } } }, { kind: 'ok', ms: 7000 });
    }
    return ids;
  };

  N.remove = (id) => {
    const p = PL.P();
    const x = N.ref(p, id);
    if (!x) return false;
    const name = PL.nodeName(x);
    const ok = store().commit('planner.undo.nodeDel', (pr) => EP().removeNode(pr, id) !== false, N.TOPICS);
    if (N.ref(PL.P(), id)) return false;
    if (sel === id) N.select(null);
    ui().toast(ok
      ? { text: t('planner.nodes.deleted', { name }), action: { i18n: 'ui.undo', fn: () => { if (store().labels().undo === 'planner.undo.nodeDel') store().undo(); } } }
      : { text: t('planner.nodes.deleted', { name }) }, { kind: 'info' });
    return true;
  };

  /** One change of one node (any floor). fn(node, project) may return false = nothing to change. -> bool (applied). */
  N.patch = (id, fn, label) => {
    let hit = false;
    store().commit(label || 'planner.undo.node', (pr) => {
      const n = N.ref(pr, id);
      if (!n) return false;
      if (fn(n, pr) === false) return false;
      hit = true;
      return undefined;
    }, N.TOPICS);
    return hit;
  };

  N.toggle = (id, on) => N.patch(id, (n) => { if (n.enabled === !!on) return false; n.enabled = !!on; return undefined; }, on ? 'planner.undo.nodeOn' : 'planner.undo.nodeOff');

  /** The nodes that hang (directly or through others) on `id`: they cannot become its uplink (no cycles). */
  function behind(id) {
    const all = PL.allNodes().map((x) => x.node);
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of all) if (!out.has(n.id) && out.has(n.uplink)) { out.add(n.id); grew = true; }
    }
    return out;
  }
  N.uplinkOptions = (id) => {
    const no = behind(id);
    const multi = PL.multi();
    const out = [{ value: 'router', label: t('planner.nodes.upRouter') }];
    for (const x of PL.allNodes()) {
      if (no.has(x.node.id)) continue;
      const nm = PL.nodeName(x.node);
      out.push({ value: x.node.id, label: multi && !x.active ? t('planner.nodes.upFloor', { name: nm, floor: x.floorName }) : nm });
    }
    return out;
  };

  /** The latest analysis' word on a node: {id, backhaul, weakBackhaul, share, onFloor, ...} or null (not serving). */
  N.info = (id) => {
    const a = PL.S.a;
    if (!a || !Array.isArray(a.nodes)) return null;
    return a.nodes.find((x) => x && x.id === id) || null;
  };

  /** The four kinds for "+ Přidat AP / mesh / opakovač" (also used by the empty state). */
  N.menu = (anchor) => {
    ui().menu(anchor, N.KINDS.map((m) => ({ label: t('planner.node.' + m), icon: PL.nodeIcon(m), onClick: () => N.add(m) })), { align: 'start' });
  };
})();
