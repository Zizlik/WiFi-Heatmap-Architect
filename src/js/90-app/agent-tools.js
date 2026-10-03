/* Optional browser-agent interface (WebMCP), ported from the old app: the same actions as the visible controls, exposed
 * as tools when - and only when - the browser offers `document.modelContext.registerTool`.  Nothing is sent anywhere;
 * the tools read and change the local project through WH.store / WH.engine / WH.io exactly like the UI does.
 *
 *   get_wifi_coverage            read the illustrative coverage estimate (router/today, band, target, coverage, rooms)
 *   get_wifi_speed_estimate      read the empirical speed scenario (needs >= 2 speed tests, same device + band)
 *   export_wifi_floorplan        the plan as structured data (wifi-floor-v2 + v3 project), without the raster background
 *   export_wifi_floorplan_svg    the SVG the "Save project as SVG" command writes
 *   import_wifi_floorplan        import an SVG (project or tracing background) or a PNG/JPEG/WebP data URL, undoable
 *   set_wifi_router_position     move the simulated router (trial position), undoable
 *   set_wifi_secondary_position  move the enabled second node, undoable
 *
 * Input validation is the old app's: x/y finite numbers in 0..1 that lie on the floor, no extra keys; exactly one of
 * svgSource / imageDataUrl.  Registration happens once the shell is ready; all tools are unregistered on pagehide. */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
  const POINT_INPUT = { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false };
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

  function coverageSnapshot() {
    const p = project();
    const E = WH.engine;
    const a = analyse(p);
    const nodeOn = p.node.mode !== 'none';
    const wireless = nodeOn && E.model.isWirelessNode(p.node);
    const thr = p.model.threshold;
    const trial = a ? E.raster.stats(a.grid, a.trial, targetIds(p), thr, p.goal.excluded) : null;
    const today = a ? E.raster.stats(a.grid, a.today, targetIds(p), thr, p.goal.excluded) : null;
    return {
      type: 'illustrative_prediction',
      router: { x: p.net.router.x, y: p.net.router.y },
      today: { x: p.net.baseline.x, y: p.net.baseline.y },
      secondary: nodeOn ? {
        position: { x: p.node.pos.x, y: p.node.pos.y },
        scenario: p.node.mode,
        bands: Object.assign({}, p.node.bands),
        wirelessUplinkDbm: wireless && a && Number.isFinite(a.backhaul) ? Math.round(a.backhaul) : null,
        wirelessUplinkBandGHz: wireless ? p.node.backhaulBand : null,
      } : null,
      bandGHz: p.view.band,
      target: targetName(p),
      goodSignalThresholdDbm: thr,
      targetCoveragePercent: trial && trial.n ? Math.round(trial.coverage) : null,
      targetMeanDbm: trial && trial.n ? Math.round(trial.mean) : null,
      todayCoveragePercent: today && today.n ? Math.round(today.coverage) : null,
      calibrationPoints: p.measurements.filter((m) => m.band === p.view.band && Number.isFinite(m.value)).length,
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
    const meas = a ? E.speed.fillSignals(a.ctx, p.measurements, { baseline: p.net.baseline, offsets: a.offsets, soften: a.soften }) : p.measurements;
    const curve = E.speed.buildCurve(meas, { band, device: g.device });
    const out = {
      type: 'empirical_scenario_not_guarantee',
      device: g.device,
      bandGHz: band,
      calibrationCount: curve ? curve.count : 0,
      measuredSignalRangeDbm: curve ? [curve.min, curve.max] : null,
      safetyReservePercent: g.reserve,
      targetsMbps: { download: g.targetDown, upload: g.targetUp },
      limitsMbps: { download: p.net.wanDown, upload: p.net.wanUp },
      secondarySpeedSupported: false,
      target: targetName(p),
      result: null,
      rooms: [],
    };
    if (p.node.mode !== 'none') return Object.assign(out, { reason: 'secondary_node', note: t('app.tool.speed.node') });
    if (!curve) return Object.assign(out, { reason: 'needs_speed_tests', note: t('app.tool.speed.noCurve') });
    if (!a) return out;
    const n = p.net;
    const sf = E.speed.fieldSpeed(a.ctx, a.grid, a.params.trial, curve,
      { wanDown: n.wanDown, wanUp: n.wanUp, wanPort: n.wanPort, ontPort: n.ontPort, wanLink: n.wanLink, reserve: g.reserve }, a.trial);
    const st = (ids, excluded) => {
      const s = E.speed.stats(a.grid, sf, { roomIds: ids, excluded, targetDown: g.targetDown, targetUp: g.targetUp });
      return { knownPercent: r1(s.known), meetsTargetPercent: r1(s.coverage), medianDownMbps: r1(s.medianDown), medianUpMbps: r1(s.medianUp), p10DownMbps: r1(s.p10Down), p10UpMbps: r1(s.p10Up) };
    };
    out.result = st(targetIds(p), g.excluded);
    out.rooms = p.plan.rooms.map((r) => Object.assign({ name: r.name }, st([r.roomId], [])));
    return out;
  }

  /** Old-app validation: an object with exactly finite x/y in 0..1 that lies on the floor. */
  function floorPoint(input) {
    const p = project();
    const ok = input && typeof input === 'object' && !Object.keys(input).some((k) => k !== 'x' && k !== 'y')
      && Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= 0 && input.x <= 1 && input.y >= 0 && input.y <= 1
      && !!WH.engine.project.roomAt(p.plan, { x: input.x, y: input.y });
    if (!ok) throw new Error(t('app.tool.err.position'));
    return { x: r6(input.x), y: r6(input.y) };
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
        description: 'Move the simulated Router (trial position) on the floor map. x and y are normalized plan coordinates from 0 to 1 and must lie on the floor. Undoable. Does not change the physical router.',
        inputSchema: POINT_INPUT, annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const q = floorPoint(input);
          WH.store.commit('planner.undo.router', (p) => { p.net.router = q; }, ['net']);
          await settle();
          return coverageSnapshot();
        },
      },
      {
        name: 'set_wifi_secondary_position', title: t('app.tool.node'),
        description: 'Move the enabled simulated secondary Wi-Fi node on the floor map using normalized coordinates (0 to 1, on the floor). Select a scenario in the visible controls first. Undoable. Does not configure hardware.',
        inputSchema: POINT_INPUT, annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          if (project().node.mode === 'none') throw new Error(t('app.tool.err.noNode'));
          const q = floorPoint(input);
          WH.store.commit('planner.undo.node', (p) => { p.node.pos = q; }, ['node']);
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
