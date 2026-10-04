/* Optional browser-agent interface (WebMCP), ported from the old app: the same actions as the visible controls, exposed
 * as tools when - and only when - the browser offers `document.modelContext.registerTool`.  Nothing is sent anywhere;
 * the tools read and change the local project through WH.store / WH.engine / WH.io exactly like the UI does.
 *
 *   get_wifi_coverage            read the illustrative coverage estimate (router/today, band, target, coverage, rooms)
 *   get_wifi_speed_estimate      read the empirical speed scenario (needs >= 2 speed tests, same device + band)
 *   (band mode Auto, SPEC 13: bandGHz null + bandMode 'auto', the router's bands and where a steering device would be
 *   on which band; "Nevím" measurements count on the band the engine infers for them)
 *   export_wifi_floorplan        the plan as structured data (wifi-floor-v2 + v3 project), without the raster background
 *   export_wifi_floorplan_svg    the SVG the "Save project as SVG" command writes
 *   import_wifi_floorplan        import an SVG (project or tracing background) or a PNG/JPEG/WebP data URL, undoable
 *   set_wifi_router_position     move the simulated router (trial position, on its own floor), undoable
 *   set_wifi_secondary_position  move an access point / mesh node / repeater (SPEC 14.2: any of them - `node` = its number
 *                                in the snapshot's `nodes` list (1 = the first) or its name; without `node` the first
 *                                enabled one), undoable; the position lies on that node's floor (SPEC 14.3)
 *   (snapshots: `nodes` = every node with number, name, type, floor, uplink and link quality; `floor` / `floors` with
 *   several storeys; `secondary` = the first serving node, as before)
 *
 * Input validation is the old app's: x/y finite numbers in 0..1 that lie on the floor, no extra keys; exactly one of
 * svgSource / imageDataUrl.  Registration happens once the shell is ready; all tools are unregistered on pagehide. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
  const POINT_INPUT = { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false };
  const NODE_INPUT = {
    type: 'object',
    properties: {
      x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
      node: { anyOf: [{ type: 'integer', minimum: 1, maximum: 8 }, { type: 'string', minLength: 1, maxLength: 50 }] },
    },
    required: ['x', 'y'], additionalProperties: false,
  };
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;

  function project() {
    const p = WH.store && WH.store.project;
    if (!p || !WH.engine || !WH.engine.project) throw new Error(t('app.tool.err.notReady'));
    return p;
  }

  function targetName(p) {
    if (p.goal.room === 'all') return t('app.tool.wholeFlat');
    const r = p.plan.rooms.find((x) => x.roomId === p.goal.room);
    return r ? r.name : t('app.tool.wholeFlat');
  }
  const targetIds = (p) => (p.goal.room === 'all' ? null : [p.goal.room]);

  /** Fresh full-quality analysis of the current project (independent of what the planner has drawn). */
  function analyse(p) {
    return p.plan.rooms.length ? WH.engine.analysis.run(p, { cell: 4, band: p.view.band }) : null;
  }
  /** The band fields every snapshot carries: one band, or Auto (SPEC 13) with the router's bands. */
  function bandInfo(p, a) {
    const E = WH.engine;
    const auto = E.model.isAuto(p.view.band);
    const out = { bandGHz: auto ? null : p.view.band, bandMode: auto ? 'auto' : 'single', routerBandsGHz: E.model.routerBandList(p) };
    if (auto && a && a.bandShare && a.bandShare.trial) {
      const sh = a.bandShare.trial;
      out.bandSharePercent = {};
      for (const b of E.BANDS) { const v = sh[E.units.bandKey(b)]; if (Number.isFinite(v)) out.bandSharePercent[String(b)] = r1(v); }
    }
    return out;
  }
  /** The measurements with their bands resolved ("Nevím" -> the inferred band, like the planner). */
  function resolved(p, a) {
    try { return a ? WH.engine.model.resolveBands(a.ctx, p, { offsets: a.offsets, soften: a.soften }) : p.measurements; } catch (e) {
      if (WH.app && WH.app.reportError) WH.app.reportError(e, 'agent.resolveBands');
      return p.measurements;
    }
  }

  /** Every node of the building (SPEC 14.2) in the order the tools count them (1 = the first). */
  function nodeEntries(p) {
    const E = WH.engine;
    if (Array.isArray(p.floors) && typeof E.project.allNodes === 'function') return E.project.allNodes(p);
    return (p.nodes || []).map((node, index) => ({ node, floor: null, floorName: '', active: true, index }));
  }
  /** The snapshot's `nodes`: number, name, type, floor, position, bands, uplink and the wireless link quality. */
  function nodesInfo(p, a) {
    const E = WH.engine;
    const all = nodeEntries(p);
    const serving = new Set(E.model.nodeList(p).map((n) => n.id));
    const byId = new Map(all.map((x) => [x.node.id, x.node]));
    return all.map((x, i) => {
      const n = x.node;
      const wl = E.model.isWirelessNode(n);
      const inf = a && Array.isArray(a.nodes) ? a.nodes.find((y) => y && y.id === n.id) : null;
      const up = n.uplink && n.uplink !== 'router' ? byId.get(n.uplink) : null;
      return {
        number: i + 1, name: n.name, scenario: n.mode, enabled: !!n.enabled, serving: serving.has(n.id),
        floor: x.floorName || null, position: n.pos ? { x: n.pos.x, y: n.pos.y } : null, bands: Object.assign({}, n.bands),
        uplink: up ? up.name : 'router', maxMbps: Number.isFinite(n.maxMbps) ? n.maxMbps : null,
        wirelessUplinkDbm: wl && inf && Number.isFinite(inf.backhaul) ? Math.round(inf.backhaul) : null,
        wirelessUplinkBandGHz: wl ? n.backhaulBand : null,
        weakUplink: !!(wl && inf && inf.weakBackhaul),
        sharePercent: inf && Number.isFinite(inf.share) ? r1(inf.share) : null,
      };
    });
  }
  /** SPEC 14.3: the floor the numbers are for, and the others (only with several floors). */
  function floorInfo(p) {
    const E = WH.engine;
    if (!Array.isArray(p.floors) || p.floors.length < 2) return {};
    const act = E.project.activeFloorId(p);
    const name = (id) => { const f = p.floors.find((x) => x.id === id); return f ? f.name : null; };
    return { floor: name(act), routerFloor: name(p.net.routerFloor), floors: p.floors.slice().sort((x, y) => x.level - y.level).map((f) => ({ name: f.name, level: f.level })) };
  }

  function coverageSnapshot() {
    const p = project();
    const E = WH.engine;
    const a = analyse(p);
    const nodes = nodesInfo(p, a);
    const first = nodes.find((n) => n.serving) || null;
    const thr = p.model.threshold;
    const trial = a ? E.raster.stats(a.grid, a.trial, targetIds(p), thr, p.goal.excluded) : null;
    const today = a ? E.raster.stats(a.grid, a.today, targetIds(p), thr, p.goal.excluded) : null;
    return {
      type: 'illustrative_prediction',
      router: { x: p.net.router.x, y: p.net.router.y },
      today: { x: p.net.baseline.x, y: p.net.baseline.y },
      ...floorInfo(p),
      // (the first serving node, in the shape older agents know)
      secondary: first ? {
        position: first.position,
        scenario: first.scenario,
        bands: first.bands,
        wirelessUplinkDbm: first.wirelessUplinkDbm,
        wirelessUplinkBandGHz: first.wirelessUplinkBandGHz,
      } : null,
      nodes,
      ...bandInfo(p, a),
      target: targetName(p),
      goodSignalThresholdDbm: thr,
      targetCoveragePercent: trial && trial.n ? Math.round(trial.coverage) : null,
      targetMeanDbm: trial && trial.n ? Math.round(trial.mean) : null,
      todayCoveragePercent: today && today.n ? Math.round(today.coverage) : null,
      calibrationPoints: resolved(p, a).filter((m) => (E.model.isAuto(p.view.band) || m.band === p.view.band) && Number.isFinite(m.value)).length,
      rooms: a ? p.plan.rooms.map((r) => {
        const s = a.perRoom.trial.get(r.roomId);
        return { name: r.name, coveragePercent: s && s.n ? Math.round(s.coverage) : null, meanDbm: s && s.n ? Math.round(s.mean) : null };
      }) : [],
    };
  }

  function speedSnapshot() {
    const p = project();
    const E = WH.engine;
    const band = p.view.band;
    const g = p.goal;
    const a = analyse(p);
    // speed tests without a measured signal (value null) count with the calibrated model's signal at their spot, as in the planner
    const meas = a ? E.speed.fillSignals(a.ctx, resolved(p, a), { baseline: p.net.baseline, offsets: a.offsets, soften: a.soften }) : p.measurements;
    // Auto (SPEC 13): one curve per band; every cell uses the curve of the band a steering device would use there
    let curve = null;
    let count = 0;
    let lo = Infinity;
    let hi = -Infinity;
    if (E.model.isAuto(band)) {
      const curves = E.speed.buildCurves(meas, { device: g.device });
      for (const b of E.BANDS) {
        const c = curves[E.units.bandKey(b)];
        if (!c) continue;
        curve = curves;
        count += c.count;
        lo = Math.min(lo, c.min);
        hi = Math.max(hi, c.max);
      }
    } else {
      curve = E.speed.buildCurve(meas, { band, device: g.device });
      if (curve) { count = curve.count; lo = curve.min; hi = curve.max; }
    }
    const out = {
      type: 'empirical_scenario_not_guarantee',
      device: g.device,
      ...bandInfo(p, a),
      calibrationCount: count,
      measuredSignalRangeDbm: curve ? [lo, hi] : null,
      safetyReservePercent: g.reserve,
      targetsMbps: { download: g.targetDown, upload: g.targetUp },
      limitsMbps: { download: p.net.wanDown, upload: p.net.wanUp },
      // SPEC 10 / 14.2: a node-served place goes through that node's link (its uplink chain and its own ceiling)
      secondarySpeedSupported: true,
      ...floorInfo(p),
      target: targetName(p),
      result: null,
      rooms: [],
    };
    if (!curve) return Object.assign(out, { reason: 'needs_speed_tests', note: t('app.tool.speed.noCurve') });
    if (!a) return out;
    const n = p.net;
    const nodesOn = Array.isArray(a.params.trial.nodes) && a.params.trial.nodes.length > 0;
    const sf = E.speed.fieldSpeed(a.ctx, a.grid, a.params.trial, curve,
      { wanDown: n.wanDown, wanUp: n.wanUp, wanPort: n.wanPort, ontPort: n.ontPort, wanLink: n.wanLink, reserve: g.reserve }, a.trial,
      nodesOn ? { nodeWins: a.nodeWins || undefined, backhaulCurves: E.speed.buildCurves(meas, { device: g.device }) } : undefined);
    if (nodesOn) out.note = t('planner.agent.speedNodes');
    const st = (ids, excluded) => {
      const s = E.speed.stats(a.grid, sf, { roomIds: ids, excluded, targetDown: g.targetDown, targetUp: g.targetUp });
      return { knownPercent: r1(s.known), meetsTargetPercent: r1(s.coverage), medianDownMbps: r1(s.medianDown), medianUpMbps: r1(s.medianUp), p10DownMbps: r1(s.p10Down), p10UpMbps: r1(s.p10Up) };
    };
    out.result = st(targetIds(p), g.excluded);
    out.rooms = p.plan.rooms.map((r) => Object.assign({ name: r.name }, st([r.roomId], [])));
    return out;
  }

  /** Old-app validation: an object with exactly finite x/y in 0..1 (+ the `extra` keys) that lies on the floor of `plan`
   *  (default: the floor on screen). */
  function floorPoint(input, plan, extra) {
    const p = project();
    const keys = ['x', 'y'].concat(extra || []);
    const ok = input && typeof input === 'object' && !Object.keys(input).some((k) => !keys.includes(k))
      && Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= 0 && input.x <= 1 && input.y >= 0 && input.y <= 1
      && !!WH.engine.project.roomAt(plan || p.plan, { x: input.x, y: input.y });
    if (!ok) throw new Error(t('app.tool.err.position'));
    return { x: r6(input.x), y: r6(input.y) };
  }
  /** The plan of floor `id` (any floor; the floor on screen without floors). */
  function planOf(p, id) {
    const E = WH.engine.project;
    if (!id || !Array.isArray(p.floors) || typeof E.floorOf !== 'function') return p.plan;
    const f = E.floorOf(p, id);
    return (f && f.plan) || p.plan;
  }
  /** `node` of set_wifi_secondary_position: its number (1 = the first of the snapshot's list), its name (any case) or
   *  its id; without it the first enabled node. -> {node, floor} */
  function pickNode(p, sel) {
    const all = nodeEntries(p);
    if (!all.length) throw new Error(t('app.tool.err.noNode'));
    if (sel === undefined || sel === null) {
      const x = all.find((y) => y.node.enabled);
      if (!x) throw new Error(t('app.tool.err.noNode'));
      return x;
    }
    let x = null;
    if (typeof sel === 'number' && Number.isInteger(sel)) x = all[sel - 1] || null;
    else if (typeof sel === 'string') {
      const k = sel.trim().toLocaleLowerCase();
      x = all.find((y) => y.node.id === sel) || all.find((y) => String(y.node.name || '').trim().toLocaleLowerCase() === k) || null;
    }
    if (!x) throw new Error(t('planner.agent.err.node', { n: all.length }));
    return x;
  }

  const settle = () => new Promise((res) => setTimeout(res, 0));

  async function importFloorplan(input) {
    project();
    const has = (k) => input && typeof input === 'object' && typeof input[k] === 'string';
    let file = null;
    if (input && typeof input === 'object' && !Object.keys(input).some((k) => k !== 'svgSource' && k !== 'imageDataUrl')) {
      if (has('svgSource') && !input.imageDataUrl && input.svgSource.length <= 8000000) {
        file = new File([input.svgSource], 'floor-plan.svg', { type: 'image/svg+xml' });
      } else if (has('imageDataUrl') && !input.svgSource && input.imageDataUrl.length <= 11000000) {
        const m = input.imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (m) {
          let bytes = null;
          try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch (e) { bytes = null; }
          if (bytes) file = new File([bytes], 'floor-plan-image.' + m[1].slice(6).replace('jpeg', 'jpg'), { type: m[1] });
        }
      }
    }
    if (!file) throw new Error(t('app.tool.err.import'));
    const welcome = !!(WH.shell && WH.shell.isWelcomeOpen && WH.shell.isWelcomeOpen());
    const res = await WH.io.importFile(file, { fresh: welcome });
    if (!res || res.kind === 'error') {
      const code = res && res.error ? String(res.error) : 'generic';
      throw new Error(t(code.startsWith('err.') ? code : `io.err.${code}`));
    }
    if (res.kind === 'project' || res.kind === 'tracing_image') {
      if (WH.shell && WH.shell.hideWelcome) WH.shell.hideWelcome();
      WH.views.go(res.kind === 'tracing_image' ? 'editor' : 'planner');
    }
    await settle();
    const p = project();
    return { kind: res.kind, name: p.name, view: WH.views.current, rooms: p.plan.rooms.length, walls: p.plan.walls.length, undoable: !welcome };
  }

  function tools() {
    return [
      {
        name: 'get_wifi_coverage', title: t('app.tool.coverage'),
        description: 'Read the visible illustrative Wi-Fi coverage estimate. This is a model, not measured signal or internet speed.',
        inputSchema: NO_INPUT, annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() { return coverageSnapshot(); },
      },
      {
        name: 'get_wifi_speed_estimate', title: t('app.tool.speed'),
        description: 'Read the visible empirical download/upload scenario. It needs at least two measured tests for the same device and band. Unknown areas and secondary-node speeds are not confirmed. Not a guaranteed throughput.',
        inputSchema: NO_INPUT, annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() { return speedSnapshot(); },
      },
      {
        name: 'export_wifi_floorplan', title: t('app.tool.exportPlan'),
        description: 'Export the current floor plan as structured room, wall, doorway and furniture geometry with visible names and attenuation values (wifi-floor-v2, plus the full v3 project). Equivalent to the SVG export, without raster background data. Does not change the plan.',
        inputSchema: NO_INPUT, annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute() {
          const data = JSON.parse(WH.engine.project.serialize(project(), { withBackground: false }));
          if (data.plan) data.plan.background = null;
          return Object.assign(data, { source: 'current_floor_plan' });
        },
      },
      {
        name: 'export_wifi_floorplan_svg', title: t('app.tool.exportSvg'),
        description: 'Return the SVG floor plan produced by the visible "Save project as SVG" command. Contains editable vectors and planner metadata. Does not alter the current floor plan.',
        inputSchema: NO_INPUT, annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute() {
          const p = project();
          return { filename: `${WH.util.slug(p.name, 'wifi')}.svg`, mimeType: 'image/svg+xml', svg: WH.engine.project.buildSvg(p, { lang: WH.i18n.lang }) };
        },
      },
      {
        name: 'import_wifi_floorplan', title: t('app.tool.import'),
        description: 'Import a supplied floor-plan file through the same operation as the visible Open file command. SVG saved by this app (or the old one) restores the project and opens the Wi-Fi view; PNG/JPEG/WebP or another SVG becomes a tracing background of a new plan in the floor-plan editor. The previous plan stays available through Undo. Does not upload data to a server.',
        inputSchema: { type: 'object', properties: { svgSource: { type: 'string', maxLength: 8000000 }, imageDataUrl: { type: 'string', maxLength: 11000000 } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: importFloorplan,
      },
      {
        name: 'set_wifi_router_position', title: t('app.tool.router'),
        description: 'Move the simulated Router (trial position) on the floor map. x and y are normalized plan coordinates from 0 to 1 and must lie on the floor of the router\'s storey (routerFloor in the snapshot when the home has several floors). Undoable. Does not change the physical router.',
        inputSchema: POINT_INPUT, annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const p0 = project();
          const q = floorPoint(input, planOf(p0, p0.net.routerFloor));
          WH.store.commit('planner.undo.router', (p) => { p.net.router = q; }, ['net']);
          await settle();
          return coverageSnapshot();
        },
      },
      {
        name: 'set_wifi_secondary_position', title: t('app.tool.node'),
        description: 'Move a simulated access point, mesh node or repeater on the floor map using normalized coordinates (0 to 1, on that node\'s floor). `node` picks it: its number in the coverage snapshot\'s `nodes` list (1 = the first) or its name; without `node` the first enabled one is moved. Add nodes in the visible "More access points" card first. Undoable. Does not configure hardware.',
        inputSchema: NODE_INPUT, annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const p0 = project();
          const x = pickNode(p0, input && typeof input === 'object' ? input.node : undefined);
          const q = floorPoint(input, planOf(p0, x.floor), ['node']);
          const id = x.node.id;
          const fid = x.floor;
          WH.store.commit('planner.undo.nodeMove', (p) => {
            const E = WH.engine.project;
            if (fid && Array.isArray(p.floors) && typeof E.moveNodeToFloor === 'function') return E.moveNodeToFloor(p, id, fid, q) !== false ? undefined : false;
            const n = (p.nodes || []).find((y) => y.id === id);
            if (!n) return false;
            n.pos = q;
            return undefined;
          }, ['nodes', 'floors']);
          await settle();
          return coverageSnapshot();
        },
      },
    ];
  }

  let registered = false;
  function register() {
    const mc = typeof document !== 'undefined' ? document.modelContext : null;
    if (registered || !mc || typeof mc.registerTool !== 'function') return false;
    registered = true;
    const life = new AbortController();
    for (const tool of tools()) {
      try { Promise.resolve(mc.registerTool(tool, { signal: life.signal })).catch(() => {}); } catch (e) { /* an agent API problem must never break the app */ }
    }
    window.addEventListener('pagehide', () => life.abort(), { once: true });
    return true;
  }

  WH.app = Object.assign(WH.app || {}, { agentTools: { register, tools, coverageSnapshot, speedSnapshot } });
  if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.registerTool === 'function') {
    if (WH.shell && typeof WH.shell.onReady === 'function') WH.shell.onReady(register);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register);
    else register();
  }
})();
