# ENGINE-API — authoritative reference for `WH.engine`

Owner: engine (`src/js/10-engine/*`, `tests/engine/*`). This file is the contract for the editor, planner, io and app
code. It supersedes SPEC §2.2 where they differ (differences are listed in section 9). Everything below is implemented,
unit tested (`node tests/engine/run-all.mjs`) and also verified in headless Chrome.

* The engine is **DOM-free**, has no side effects and no state except small caches (`raster.grid`). It runs in the browser
  and in Node.
* Load order = lexical file order: `00-ns, 10-geom, 20-units, 30-project, 31-demo, 35-edit, 40-model, 45-fit, 50-raster,
  60-speed, 70-optimize, 75-analysis, 99-strings`. `WH.i18n` must exist before `99-strings.js` (it does: `00-core`).
* **Calibration fit (SPEC 9, §7.1b)**: `project.model.fit` (written by `model.fitProject` after the "first measurement"
  wizard) is part of the CONTEXT while `view.calibrate` is on: `createContext` puts the fitted path-loss exponent into
  `ctx.p.n` and multiplies every obstacle loss by `ctx.wf`. So the raster, optimizer, contours, tooltips, calibration
  and speed model use the fitted physics with no extra parameter - one source of truth. Rebuild the context when
  `model` OR `view.calibrate` changes.
* The Wi-Fi details parser `WH.devinfo` (SPEC 8, `src/js/36-devinfo/`, §12) follows the same rules (pure, Node-tested)
  but lives outside `WH.engine`.
* **What-if at the measured points + speed through a second node (SPEC 10, stage 7)**: `analysis.predictAtMeasurements`
  (§7.7) and ONE speed rule `speed.predictVia` (§7.8) shared by the Speed map (`fieldSpeed`), the tooltip
  (`pointSpeed`), the summary (`homeSummary`), the optimizer's speed mode and the what-if. A second node no longer
  makes speed "unsupported"; a wireless node's uplink and `node.maxMbps` cap what it serves. None of these throws on odd
  measurement data - they return explicit `reason`s.
* **Band steering / band mode Auto (SPEC 13, stage 7b, §7.9)**: `view.band` may be `'auto'` (the default whenever the
  router sends ≥ 2 bands: `net.routerBands`). One steering rule (`model.steerBand`, thresholds `model.steer`) picks the
  band of every cell / point; every field, statistic, contour, tooltip, optimizer, speed and what-if path accepts
  `'auto'`, `model.fieldParams` puts `bands` + `steer` into the state, so views pass nothing extra. Measurements may
  have `band: null` ("Nevím") - the engine infers it (`model.resolveBands`, `bandInferred`, half weight in the
  calibration). Wi-Fi 7 MLO links: `measurement.wifi.links` (`WH.devinfo`).
* Never mutate what you got from `create/sanitize/parse…` except through the store (`WH.store.commit/live`). Engine
  functions **never mutate their inputs** except where a function is documented as "mutates in place" (`WH.engine.edit.*`,
  to be called inside a store mutator).
* **Diffraction softening is on by default** (`soften`, metres, default `model.SOFTEN = 0.4`; see §7.0). Every map,
  statistic, tooltip, calibration, optimizer result and range line uses the same softened model, so views pass nothing
  extra. `soften: 0` anywhere gives the exact ray model (the old behaviour).
* **Obstacle losses depend on the band** (SPEC 7.1, §7.1a below): every loss stored in a plan is the **5 GHz reference**;
  presets use per-band tables (`model.MATERIALS`, `model.FURNITURE_KINDS`), everything else × `model.BAND_FACTOR`
  (2.4 GHz × 0.65, 6 GHz × 1.15). Every function that takes a band applies it itself; to show "the dB the model uses" for
  an object call `model.obstacleLossFor(obj, band, project)`. `model.bandPower` adds a per-band transmit power difference.

## 0. Conventions

| Thing | Convention |
|---|---|
| Point | `{x,y}` **normalized** 0..1 over the fixed canvas `WH.engine.CANVAS = {W:1080, H:942}` px |
| Distances | `geom.dist` returns **canvas px** (the canvas is not square — never use a normalized distance). Metres = px × `project.scale.mpp` |
| Bands | numbers `2.4 | 5 | 6`; as **object keys** the strings `'2.4' | '5' | '6'` (`WH.engine.units.bandKey(b)`). Iterate with `WH.engine.BANDS` (`[2.4,5,6]`). Do not rely on `Object.keys` order of band maps |
| Signal | dBm, always clamped to **[−110, −20]** by the model |
| Fields | `Float32Array(grid.cols*grid.rows)`, index `i = row*cols + col`, `NaN` outside rooms |
| Errors | `Error` whose **`message` is an i18n key** (`err.…`), also on `.code`; show with `WH.i18n.t(err.message)`. Programming mistakes (missing `band`/`router`) throw `RangeError` |
| Language | functions that create *data* in a language (`create`, `buildSvg`, default names) take `lang: 'cs'|'en'`; default = `WH.i18n.lang`, else `'cs'` |
| Rounding | all stored coordinates are rounded to 6 decimals by `sanitize` (so `sanitize` is idempotent) |

Namespaces: `geom, units, project, edit, model, raster, speed, optimize, analysis` plus helpers `util`, `text`, `demo`.

---

## 1. Project (v3) — the one data model

```js
Project = {
  v: 3,
  name: string(≤80),
  plan: { rooms: Room[], walls: Wall[], doors: Door[], furniture: Furniture[], background: dataURL|null },  // each array ≤ 250
  scale: { mpp: number },                    // metres per canvas px, 0.0005..0.2. NEVER re-derived after load
  net:   { router: Point,                    // TRIAL position (what the user moves)
           baseline: Point,                  // TODAY (where the router really is; measurements belong to it)
           optic: Point,                     // internet inlet
           wanDown: null|0..10000, wanUp: null|0..10000,          // Mb/s of the plan
           wanPort: null|100|1000|2500|5000|10000, ontPort: same, wanLink: same,
           cableCategory: 'unknown|cat5|cat5e|cat6|cat6a|cat7|cat8', cableLength: null|0.1..500,
           routerBands: {'2.4':bool,'5':bool,'6':bool} },  // SPEC 13: the bands the router sends (default 2.4 + 5)
  node:  { mode: 'none|ap_cable|mesh_cable|mesh_wifi|repeater', pos: Point,
           bands: {'2.4':bool,'5':bool,'6':bool}, power: -10..6 (dB), backhaulBand: 2.4|5|6, backhaulThreshold: -80..-55,
           maxMbps: null|10..10000 },        // SPEC 10: the node's real ceiling in Mb/s ("Kolik zvládne"), whole numbers;
                                             // null = unknown (also 0 / negative / garbage); older files load with null
  model: { nearSignal: -55..-25 (dBm at 1 m, 5 GHz; 40), n: 1.6..4 (2.2), wallLoss: 0..20 (8, the 5 GHz value),
           threshold: -75..-55 (-67, "good signal"), rangeThreshold: -80..-45 (-60),
           bandPower: {'2.4': -10..6, '5': -10..6, '6': -10..6} (dB, default 0 each; added to that band's signal),
           steer: {six: -90..-50 (-70), five: -90..-50 (-72)},   // SPEC 13: band-steering thresholds (§7.9)
           fit?: Fit },                      // SPEC 9, only after the calibration wizard (older files: no key at all)
  goal:  { room: 'all'|roomId, allowedRoom: 'any'|roomId, excluded: roomId[], mode: 'signal'|'speed',
           targetDown: 1..10000 (50), targetUp: 1..10000 (50), reserve: 0..80 (30, %), device: string(≤50) },
  measurements: Measurement[] (≤500),
  view:  { band: 2.4|5|6|'auto' ('auto' with ≥ 2 router bands; §7.9), layer: 'signal|speed|diff', ranges, walls, furniture, labels, values, calibrate: bool,
           points: bool (true; planner layer "Body měření" - the measurement dots + their labels),
           whatif: bool (true; layer "Předpověď u bodů" - the "→ predicted (+Δ)" part of those labels / tooltips / PNG),
           sourceZones: bool (true; layer "Zdroj signálu", SPEC 10.3 - the border between the router's and the node's zone),
           palette: 'default|cb' }      // a missing / non-boolean points, whatif or sourceZones (older files) ⇒ true; view only, not undoable
}
Room        { id:'room-1', type:'room', roomId:1..250 (unique int), name(≤50), points: Point[3..200], color:'#rrggbb' }
Wall        { id, type:'wall', name, a:Point, b:Point, material?:'drywall|brick|concrete|reinforced_concrete|glass|wood|metal|masonry|solid_guess|custom', loss?:0..30 }
              // `loss` and `material` come as a pair; no loss ⇒ the wall uses model.wallLoss. loss = the 5 GHz value.
              // A preset material stores its table's 5 GHz value (brick 11); sanitize turns the OLD app's preset numbers
              // (brick 8, drywall 3, …) into the new ones, so a legacy preset wall IS that preset (SPEC 7.1)
Door        { id, type:'door', name, a:Point, b:Point, wallId, loss:0..30 }   // loss 0 = open doorway, ~3 = closed door (5 GHz)
Furniture   { id, type:'furniture', name, points: Point[3..200], loss:0..30 (5 GHz), kind:'custom|bed|wood|books|appliance|metal', blocksSignal:boolean }
Measurement { id, x, y, band:2.4|5|6|null (null = "Nevím", inferred by the engine, §7.9), value:-100..-20 (dBm) | null, name(≤50), download:null|0..10000, upload:null|0..10000, device(≤50), t:epoch ms,
              ping?:0..10000 (ms), jitter?:0..10000 (ms), source?:'cloudflare',
              wifi?:{ssid:string(≤64)|null, bssid:'aa:bb:cc:dd:ee:ff'|null, channel:1..233|null, band:2.4|5|6|null,
                     rxRate:0..100000|null, txRate:0..100000|null (Mb/s), radio:string(≤24)|null ('802.11ax'), security:string(≤40)|null,
                     links?:[{band, channel, rssiDbm, widthMHz}] (Wi-Fi 7 MLO, 1..4, strongest first; §7.9)},
              deviceInfo?:{os:string(≤40)|null, model:string(≤50)|null, browser:string(≤40)|null,
                           connType:'wifi'|'ethernet'|'cellular'|'bluetooth'|'wimax'|'other'|'none'|'unknown'|'mixed'|null} }
              // value null = a speed-test point without a measured signal (SPEC 6.2): kept only with download AND upload;
              // ping/jitter/source only when known (the built-in speed test), so older records keep their exact shape;
              // wifi / deviceInfo (SPEC 8) likewise only when at least one field is known - then with ALL their keys
              // (null = unknown). WH.devinfo.toWifi(parse(text).connected) gives exactly the wifi object.
Fit         { n:1.6..4, wallFactor:0.5..2, method:'offset'|'offset+n+walls', count:int (points used), at:epoch ms,
              fitted:{n:bool, wallFactor:bool}, sig?:string (what it was made from, see model.fitStale),
              byBand:{'2.4'|'5'|'6': {offset:-40..40 (dB, "router strength"), rms, looRms|null, count, outliers:id[],
                                      n? (present when the band took part in the n/wall fit), before?:{offset, rms, looRms|null}}} }
```

Invariants guaranteed by `sanitize` (and expected from the editor): ids unique across all object types; polygons valid
(`geom.validatePolygon`); every door has an existing wall; `net.router`, `net.baseline`, `node.pos` lie on the floor
(when the plan has rooms); `goal.room/allowedRoom/excluded` refer to existing roomIds; the node's backhaul band is one the
node serves; all numbers clamped to the ranges above. Constants: `project.WALL_MATERIALS` (the number a preset stores in
`wall.loss` = the 5 GHz column of `MATERIALS`: drywall 4, wood 5, glass 4, brick 11, masonry 11, solid_guess 15,
concrete 18, reinforced_concrete 26, metal 30), `project.LEGACY_WALL_MATERIALS` (the OLD app's numbers: drywall 3, brick 8,
concrete 12, reinforced_concrete 18, glass 3, wood 3, metal 25, masonry 8, solid_guess 12), `project.FURNITURE_KINDS`
(stored numbers: custom 3, bed 1, wood 3, books 5, appliance 8, metal 12 - unchanged, they equal the 5 GHz column),
`project.MATERIALS` / `FURNITURE_BANDS` / `BAND_FACTOR` (= the `model.*` tables of §7.1a), `BAND_POWER_MIN/MAX` (−10 / 6),
`project.ROOM_COLORS`, `NODE_MODES`, `NODE_MBPS_MIN/MAX` (10 / 10000), `WAN_RATES`, `CABLE_CATEGORIES`, `MAX_ITEMS` (250), `CONN_TYPES`,
`FIT_METHODS`, `STEER_MIN/MAX` (−90 / −50), `STEER_DEFAULT` (`{six:-70, five:-72}`), `ROUTER_BANDS_DEFAULT`, `MAX_LINKS` (4).

---

## 2. Recipes

### 2.1 "Today vs trial" in 5 lines

```js
const E = WH.engine, cache = {};                                   // optional: keep ONE cache object per quality (cell/aa) between calls
const a = E.analysis.run(project, { cell: 4, cache });             // idle quality; use { cell: 8 } while dragging
//  a.stats.today.coverage / a.stats.trial.coverage  (% of floor area ≥ model.threshold),  a.delta.coverage
//  a.today, a.trial, a.diff : Float32Array dBm per cell;  a.perRoom.trial : Map<roomId,{coverage,mean,median,p10,n}>
const img = E.raster.colorize(a.grid, a.trial, { palette: project.view.palette });   // or a.diff with {mode:'diff'}
ctx2d.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);            // 270×236 px, scale up to the canvas, clip to rooms
```

The same by hand (what `analysis.run` does):

```js
const ctx    = E.model.createContext(project);                      // cheap; rebuild after ANY plan/model/scale change
const grid   = E.raster.grid(ctx, { cell: 4 });                     // cached on the room outlines + cell
const offs   = E.model.offsets(ctx, project);                       // calibration offsets {'2.4','5','6'} (0 if view.calibrate=false)
const today  = E.raster.field(ctx, grid, E.model.fieldParams(project, 'today', { offsets: offs }));
const trial  = E.raster.field(ctx, grid, E.model.fieldParams(project, 'trial', { offsets: offs }));
const s      = E.raster.stats(grid, trial, null /* whole flat */, project.model.threshold, project.goal.excluded);
```

### 2.2 Dragging the router (≥ 30 fps)

```js
const grid8 = E.raster.grid(ctx, { cell: 8 });                 // ctx/offsets/cache live as long as the plan + model do
const buf   = new Float32Array(grid8.cols * grid8.rows);       // reused output buffer for the trial field
const cacheFast = {}, cacheFull = {};                           // the cache holds one entry: one object per quality
// on every pointermove:
const p = E.project.nearestFloor(project.plan, WH.viewport.toWorld(ev.clientX, ev.clientY));   // keep the marker on the floor
store.live(pr => { pr.net.router = p; }, ['net']);
const a = E.analysis.run(project, { cell: 8, aa: 1, ctx, offsets, cache: cacheFast, reuse: { trial: buf } });   // ≈ 4–6 ms (real plan)
// when the pointer rests ≈ 120 ms:  E.analysis.run(project, { cell: 4, ctx, offsets, cache: cacheFull })    // ≈ 15–25 ms, smooth edges
```
`router`, `baseline` and `node.pos` are not part of the context, so keep the same `ctx` while only they move; rebuild it
(`model.createContext(project)`) after any plan / model / scale edit. With a `cache`, today's field **and today's
statistics** (`stats.today`, `perRoom.today`) are computed once per baseline; a drag frame only computes the trial
field and its statistics (exact median / p10 by selection, no sorting), so a view no longer needs its own lean path.

### 2.3 Hover tooltip

```js
const room = E.project.roomAt(project.plan, p);                       // room object or null (null ⇒ no tooltip)
const st   = E.model.fieldParams(project, 'trial', { offsets: offs }); // band = project.view.band
const d    = E.model.pointSignalDetail(ctx, p, st);                   // {router,node,combined,baseline,bestSource,backhaul,weakBackhaul}
const q    = E.units.qualityOf(d.combined);                           // {key:'good',…} → WH.i18n.t('quality.'+q.key)
const delta = d.combined - d.baseline;                                // Δ vs today (today = baseline router without the node)
const fast  = E.raster.sample(grid, a.trial, p);                      // same number from the field (bilinear), NaN off-floor
```
Both are softened like the map: away from walls they agree to a median 0.04 dB, p95 0.3 dB (`pointSignalDetail` ≈ 0.05–0.1 ms;
`sample` is free and exactly what is drawn).

### 2.4 "Find the best place"

```js
const ac = new AbortController();
const r = await E.optimize.find(ctx, grid, {
    band: project.view.band, goalRoom: project.goal.room === 'all' ? null : project.goal.room,
    allowedRoom: project.goal.allowedRoom === 'any' ? null : project.goal.allowedRoom,
    threshold: project.model.threshold, excluded: project.goal.excluded,
    router: project.net.router, node: E.model.nodeParams(project), offsets: offs,
  }, { onProgress: f => bar.value = f, signal: ac.signal });
// r.pos (normalized, on the floor, ≥ 0.2 m from walls), r.roomId, r.before.coverage → r.after.coverage, r.after.mean …
// before/after are the same (softened, aa 2 at cell 4) numbers analysis.run shows for those router positions
```

### 2.5 Files

```js
const text = await file.text();                       // SVG saved by this app or by the old app
const r = E.project.parseSvgText(text);               // throws Error('err.svg.*' | 'err.plan.*')
if (!r.hasData) { /* plain image/SVG → offer as tracing background */ }
else { if (r.svgBackground) { /* io: rasterize this data:image/svg+xml URL to PNG → r.project.plan.background */ }
       store.init(r.project); }
download(E.project.buildSvg(project, { lang }), 'muj-byt.svg');          // loads in the old app too
localStorage.setItem('wifi-heatmap-v3', E.project.serialize(project));  // JSON string; read back with E.project.sanitize(str)
const mig = E.project.migrateLegacyStorage(k => localStorage.getItem(k));   // null or a Project; never throws
```

### 2.6 Measurements → calibration / speed

```js
project.measurements.push({ id: 'm-' + Date.now().toString(36), x: p.x, y: p.y, band: 5, value: -63, name: 'Kuchyň',
                            download: 310, upload: 95, device: project.goal.device, t: Date.now() });   // via store.commit
const cal   = E.model.calibrateAll(ctx, project);     // {'2.4':{offset,rms,n,fallback,suspicious,used[]},'5':…,'6':…}
const curve = E.speed.buildCurve(project.measurements, { band: 5, device: project.goal.device });   // null until ≥2 signal values ≥5 dB apart
const net = project.net, goal = project.goal;
const sf = E.speed.fieldSpeed(ctx, grid, E.model.fieldParams(project, 'trial', { offsets: offs }), curve,
             { wanDown: net.wanDown, wanUp: net.wanUp, wanPort: net.wanPort, ontPort: net.ontPort, wanLink: net.wanLink, reserve: goal.reserve });
const ratio = E.speed.ratioField(grid, sf, goal.targetDown, goal.targetUp);       // −1 unknown, ≥ 1 target met
const img = E.raster.colorize(grid, ratio, { mode: 'speed' });
// with a second node (stage 7) the same call works: sf.source[i] = 1 where the node serves, sf.limitedBy[i] codes
// E.speed.LIMIT_KINDS[...] ('backhaul' = the repeater's link, 'device' = node.maxMbps, 'link', 'plan'), sf.link = its uplink
const tip = E.speed.pointSpeed(ctx, p, E.model.fieldParams(project, 'trial', { offsets: offs }), curve, limits);  // the tooltip
```
Always take measurements with the router at `net.baseline` and the second node switched off (the model assumes it).
A measurement may have `band: null` ("Nevím", SPEC 13): `calibrateAll` / `offsets` / `fitProject` infer it themselves;
before `fillSignals` / `buildCurve(s)` pass `model.resolveBands(ctx, project)` instead of `project.measurements` (§7.9).

### 2.7 "Prvotní měření" - calibration wizard (SPEC 9)

```js
const ctx   = E.model.createContext(project);                                  // rebuild after model / view.calibrate changes
const spots = E.analysis.suggestSpots(ctx, project, { band: 5, count: 5 });    // [{x,y,roomId,kind,predicted,distance,walls}]
//   kinds in walking order: near (1-2 m) · sameRoom (far side) · oneWall · twoWalls · far (the weakest room)
// ... the user measures at the pins (router at net.baseline), measurements are saved as usual ...
const fit = E.model.fitProject(project, { band: 5 });                          // null when no measured signal yet
store.commit('fit', (p) => { p.model.fit = fit; }, ['model']);                 // "Vrátit výchozí model": delete p.model.fit
// result card, in plain words (all numbers in the stored fit):
//   fit.byBand['5'].offset       "router is 4 dB stronger than assumed"
//   fit.wallFactor - 1           "walls block about 20 % more" (only when fit.fitted.wallFactor)
//   fit.n vs project.model.n     "the signal fades faster / slower" (only when fit.fitted.n)
//   fit.byBand['5'].looRms       "the model is now within ±3 dB" vs fit.byBand['5'].before.looRms "(before ±9 dB)"
//   fit.byBand['5'].outliers     ids of measurements > 12 dB off (not used)
E.model.fitStale(project);        // true when the measurements of the fitted bands changed since -> offer "Přepočítat"
const before = E.model.createContext(project, { fit: false });                // the default model, e.g. "before" thumbnail
```
Everything that takes the context (fields, statistics, optimizer, contours, tooltips, `calibrate`, `speed.fillSignals`)
now uses the fitted model. Whole-home throughput (`speed.homeSummary`, §7.3) on the same analysis:

```js
const a = E.analysis.run(project, { cell: 4 });
const curve = E.speed.buildCurve(E.speed.fillSignals(a.ctx, project.measurements, { baseline: project.net.baseline, offsets: a.offsets }),
                                 { band: a.band, device: project.goal.device });
const net = project.net, goal = project.goal;
const limits = { wanDown: net.wanDown, wanUp: net.wanUp, wanPort: net.wanPort, ontPort: net.ontPort, wanLink: net.wanLink, reserve: goal.reserve };
const h = E.speed.homeSummary(a.ctx, a.grid, a.params.trial, curve, limits,
                              { targetDown: goal.targetDown, targetUp: goal.targetUp, roomIds: a.targetRooms, excluded: goal.excluded }, a.trial);
// h.areaMeetingTarget (%), h.perRoom[{roomId, medianDown, medianUp, meets}], h.weakest {roomId,x,y,down,up}, h.limitedByPlan
// with a second node: h.nodeShare (% served by it), h.limitedShare.{plan,link,backhaul,device} (%), h.link (its uplink)
```

### 2.8 Wi-Fi details from a command / the helper (SPEC 8)

```js
const r = WH.devinfo.parse(textarea.value);          // netsh (cs/en/...), system_profiler (text/-json), wdutil, nmcli, iw, helper JSON
if (r.connected) {                                   // {ssid, bssid, band, channel, rssiDbm, signalPct, rxRate, txRate, radio, wifiGen, ...}
  measurement.value = r.connected.rssiDbm;           // dBm (from % via %/2-100 when the OS only gives %; r.warnings says so)
  measurement.band  = r.connected.band || view.band;
  measurement.wifi  = WH.devinfo.toWifi(r.connected); // the stored shape, sanitize keeps it as is
}
r.warnings.forEach((k) => show(WH.i18n.t(k)));       // devinfo.warn.* (cs + en in 36-devinfo/strings-parse.js)
const h = WH.devinfo.fromHash(location.hash);        // helper one-shot: {ok, error?, os, connected, ...}; then drop the hash
```

### 2.9 What-if at the measured points (SPEC 10)

```js
const ctx  = E.model.createContext(project);                      // the planner's ctx and offsets (fit + calibration)
const offs = E.model.offsets(ctx, project);
if (E.analysis.whatIfActive(project)) {                           // router moved or a second node on
  const list = E.analysis.predictAtMeasurements(ctx, project, { offsets: offs });
  for (const e of list) {
    if (e.reason) continue;                                       // 'invalid' | 'band' | 'position' (odd data, never thrown)
    label(e, `${fmt(e.measured ?? e.modelToday)} → ${fmt(e.predicted)} (${sign(e.delta)})`);   // "−72 → −58 (+14)"
    if (e.speed && e.speed.predDown !== null) label2(e, `↓${e.speed.measuredDown ?? '–'} → ≈${e.speed.predDown}`);
    if (e.speed && e.speed.limitedBy === 'backhaul') why(e, `omezeno propojením ≈ ${e.speed.capDown} Mb/s`);
    if (!e.onFloor) offerMoveInside(e, e.inside);                 // "Posunout dovnitř"
  }
  const s = E.analysis.summarizePredictions(list);                // s.best / s.worst / s.rooms[0] / s.improved ...
}
const link = E.speed.nodeLink(ctx, E.model.fieldParams(project, 'trial', { offsets: offs }), curve);
// "Propojení s routerem ≈ 280 Mb/s": link.down (null when wired / unknown), link.signal dBm, link.weak, link.maxMbps
```

### 2.10 Band mode Auto, "Nevím" measurements, Wi-Fi 7 MLO (SPEC 13)

```js
// project.view.band === 'auto' (default with 2.4 + 5 GHz): nothing else to pass - fieldParams adds bands + steer
const a = E.analysis.run(project, { cell: 4 });                   // a.band 'auto', a.trial = what a steering client gets
a.bandShare.trial;                                                // {'2.4': 31, '5': 69, '6': 0} - legend "kde budeš na 2,4 / 5 / 6 GHz"
const zones = E.raster.bandZones(a.grid, a.bands.trial, { '2.4': cssVar('--band-24'), '5': cssVar('--band-5'), '6': cssVar('--band-6') });
const edges = E.raster.bandEdges(a.grid, a.bands.trial);          // thin outline between the zones
const d = E.model.pointSignalDetail(a.ctx, p, a.params.trial);   // d.band (steered), d.byBand, d.baselineBand
// measurements: "Nevím" = band null; show the guess, build per-band curves from the resolved list
const list = E.model.resolveBands(ctx, project);                  // m.bandInferred -> "≈ 5 GHz (odhad)"
const curves = E.speed.buildCurves(E.speed.fillSignals(ctx, list, { baseline: project.net.baseline, offsets: offs }), { device: project.goal.device });
const h = E.speed.homeSummary(a.ctx, a.grid, a.params.trial, curves, limits, target, a.trial);   // h.bandShare, h.approxShare
const tip = E.speed.pointSpeed(a.ctx, p, a.params.trial, curves, limits);                        // tip.band, tip.approx
// the optimizer: pass the state's bands / steer
E.optimize.find(a.ctx, a.grid, { band: 'auto', bands: a.params.trial.bands, steer: a.params.trial.steer, /* … */ });
// Wi-Fi 7 multi-link: WH.devinfo.parse(text).connected.links -> toWifi(...).links -> measurement.wifi.links
//   list label "5 GHz (+6 GHz MLO)": wifi.links.slice(1).map((l) => l.band)
```

---

## 3. `WH.engine.geom`

All points normalized. Returned distances are px.

| Function | Returns |
|---|---|
| `dist(a,b)` | px distance |
| `distM(a,b,mpp)` | metres |
| `toPx(p)` / `fromPx(x,y)` | `{x,y}` in canvas px / normalized |
| `pointInPolygon(p, pts)` | bool (even-odd; boundary points are arbitrary but consistent with the raster grid) |
| `polygonArea(pts)` / `polygonAreaPx(pts)` | absolute area, normalized units / px² |
| `polygonCentroid(pts)` | area centroid (vertex average for degenerate polygons) |
| `labelPoint(pts)` | visual centre inside the polygon (pole of inaccessibility) — use for room labels |
| `signedDistPx(p, pts)` | + inside / − outside distance to the outline in px |
| `pointSegDistPx(x,y,ax,ay,bx,by)` | px distance, px arguments |
| `segIntersection(a,b,c,d)` | `{t,u,x,y}` or `null` (parallel or not touching; inclusive ends) |
| `closestOnSegment(p,a,b)` | `{x,y,t,d}` — closest point (normalized), `t` 0..1 along a→b, `d` px |
| `bbox(pts)` | `{minX,minY,maxX,maxY}` or `null` |
| `validatePolygon(pts)` | bool: 3..200 finite vertices, no self-crossing, area > 2e-5 (normalized). Same rule as the old app, so files we write open there |
| `snapGrid(p, step=0.01)` | snapped copy, clamped to 0..1 |
| `rectPoints(a,b)` | 4 corners of the axis-aligned rectangle |
| `simplify(pts, tolPx=0.5)` | copy without duplicate / collinear vertices |

## 4. `WH.engine.units`

* `pctToDbm(pct)` = pct/2 − 100 · `dbmToPct(dbm)` clamped 0..100 (Windows "Signal %").
* `qualityOf(dbm) → {key, min, max}` with `key ∈ excellent|veryGood|good|weak|veryWeak|unusable`; cut-offs ≥−50, −60, −67, −75, −85;
  `qualityIndex(dbm)` 0..5; `QUALITY` = the table (strongest first; `min` inclusive, `max` exclusive).
* `formatMbps(n, lang?)` → `'—'` for null/NaN, 1 decimal below 10, grouped integer otherwise. `formatDbm(dbm, lang?)` → `'−67 dBm'` (U+2212, NBSP).
* `normBand(b)` accepts `2.4, '2,4', '5', '5 GHz'…` → `2.4|5|6|null` · `normBandMode(b)` = the same + `'auto'` (SPEC 13) · `bandKey(b)` → `'2.4'|'5'|'6'` · `bandLabel(b, lang)` → `'2,4'|'2.4'|'5'|'6'` (`''` for `'auto'` - label it yourself).

## 5. `WH.engine.project`

| Function | Notes |
|---|---|
| `SCHEMA_VERSION` | 3 |
| `create({template:'demo'|'blank', lang}) → Project` | demo (SPEC 11, the README showcase): a realistic Czech 3+kk, 74 m² + a 3.9 m² balcony, 10.5 × 8.8 m incl. the bay and the balcony, `scale.mpp = 0.0125` (80 px per m). 7 rooms (Obývák s kuchyní / Living & kitchen with a bay, Ložnice / Bedroom, Pracovna / Study, Koupelna / Bathroom, WC, Předsíň / Hall - L-shaped -, Balkon / Balcony), an entrance niche; 22 walls (exterior brick, reinforced concrete / concrete to the building's corridor, a brick load-bearing spine, plasterboard partitions, tiled masonry around bathroom and WC, a glass bay front and balcony railing); 7 doors (an open doorway hall → living room, closed doors, a glass balcony door, a heavy front door); 22 pieces of furniture as real shapes at real sizes (L corner sofa, coffee table, TV unit, dining table with chairs, L kitchen counter, fridge, oven, 160 × 200 bed + 2 nightstands, wardrobe, desk, round office chair, bookcase, sofa bed, bathtub, half-oval washbasin, washing machine, toilet with cistern and oval bowl, shoe cabinet, built-in wardrobe, round balcony table; ≤ 12 corners each). Router = baseline by the shoe cabinet next to the front door, the internet inlet (fibre box) on the other side of the door - markers ≥ 1.3 m apart and clear of the hall label even on a phone: 5 GHz whole flat ≈ 52 % today, ≈ 79 % at the best spot, 2.4 GHz ≈ 93 %. `goal.excluded` = the balcony; the (off) second node waits in the bedroom; `goal.device` "Telefon"/"Phone"; `view.band` `'auto'` with `net.routerBands` 2.4 + 5 GHz (SPEC 13). blank: no rooms, `mpp 0.012`, also `'auto'`. Unknown template ⇒ demo |
| `defaults(lang?)` | fresh `{scale,net,node,model,goal,measurements,view}` (plan-independent defaults) |
| `sanitize(raw, {strict=true, lang}) → Project` | accepts: v3 Project, SVG-metadata payload (with/without `project`), legacy `wifi-floor-v2` `{plan,width,router,original,optic}`, bare plan (old demo shape / `USER_PLAN`), old localStorage `{ed, appliedPlan}`, or a JSON **string** of any of these. Clamps everything, snaps markers to the floor, drops unusable measurements, cleans names (control chars, ≤50 code points). Legacy defaults: `mpp = deriveMpp(plan, width∈[6,25] else 12)`, `baseline = original ?? router`, trial = `router`, optic from file or just inside the left edge, band 5. A wall with a preset material and the OLD app's number of that preset (`LEGACY_WALL_MATERIALS`, e.g. brick 8) gets the new table's 5 GHz number (brick 11; SPEC 7.1); `model.bandPower` defaults to zeros. Throws on garbage (see §8). `strict:false` drops bad objects instead of throwing (used for the app's own localStorage) |
| `sanitizeDetailed(raw, opts) → {project, warnings:string[], svgBackground:string|null}` | `svgBackground` = a legacy `data:image/svg+xml;base64,…` plan background that cannot be kept; **io must rasterize it to PNG** and set `project.plan.background` |
| `serialize(project, {withBackground=true}) → string` | JSON for `<metadata id="wifi-plan-data">`: `{format:'wifi-floor-v2', plan, width, router, original, optic, app:'wifi-heatmap-architect', v:3, project:{name,scale,net,node,model,goal,measurements,view}}`. The first six keys are what the OLD app reads (`width` is clamped to 6..25; `router`=trial, `original`=baseline). Also the format for localStorage `wifi-heatmap-v3`. Throws `err.plan.polygon` for an invalid outline; everything else is written as `sanitize(project, {strict:false})` (a no-op for a store project), so a half-edited object (NaN point, door whose wall is gone, duplicate id, missing colour) is repaired/dropped instead of producing a file our own loader refuses - **every file we write loads again** |
| `buildSvg(project, {lang, markers=true, withBackground=true}) → string` | complete visual SVG 1080×942 (rooms, furniture, walls, doors, labels, router/today/inlet markers, 1 m scale bar) + XML-escaped metadata, both drawn from the same repaired project as `serialize` (no `NaN`/`undefined` anywhere - tested incl. a broken live project and 250-object plans). Round-trips: `parseSvgText(buildSvg(p)).project` deep-equals `sanitize(p)`. Tested against ports of the old loader. ≈ 37 KB for the showcase demo, ≈ 0.7 MB for 250 of everything |
| `parseSvgText(text) → {project, hasData, svgBackground, warnings}` | DOM-free (regex + entity decoding; handles CDATA, single quotes, numeric entities). `hasData:false` ⇒ ordinary image (`project:null`). Rejects DOCTYPE/ENTITY, > 8 000 000 chars. **Linear time** on hostile input (the metadata block is found with an attribute run that cannot cross the next `<`; the old single regex took 33 s for 800 kB of `<metadata `, 8 MB now ≈ 10 ms). The first `<metadata … id="wifi-plan-data" …>` (attributes ≤ 1000 chars, `id` preceded by white space) wins |
| `migrateLegacyStorage(getItem, {lang}) → Project|null` | reads `wifi-floor-v5`, `wifi-floor-network-v1`, `wifi-speed-v1`, `wifi-flow-v1`; measurements only if taken at the same "original" (within 2e-6 of the original the old app stored, or of the snapped baseline) and on the floor (old rule); never throws; `null` when there is nothing worth migrating (no plan / empty plan without background) |
| `deriveMpp(plan, widthMeters)` / `widthFromMpp(plan, mpp)` | width = real width of the bounding box of all rooms (84 % of the canvas if there are no rooms) |
| `planBounds(plan)` | `{minX,minY,maxX,maxY}` of the rooms, else of other geometry, else `{.05,.05,.95,.95}` |
| `roomAt(plan, p) → room|null` | the room containing `p` (last room wins when rooms overlap — same rule as the raster) |
| `floorMaskAt(plan, p) → bool` | `p` is on the floor |
| `nearestFloor(plan, p) → Point` | `p` if on the floor, else the closest floor point (2–16 px inside the nearest outline); plans without rooms return `p`; invalid `p` ⇒ (0.5,0.5). Use it for every marker drag/drop |
| `autoWalls(plan, {defaultMaterial, lang}) → Wall[]` | NEW walls for room edges not covered by a collinear wall (3 px tolerance); shared edges once; partial coverage adds only the missing piece; gaps < 3 px ignored. `defaultMaterial`: a `WALL_MATERIALS` key (the wall gets that preset: `loss = WALL_MATERIALS[key]`, the 5 GHz value) or `'default'`/undefined (= follow `model.wallLoss`). Does not modify the plan; idempotent after you append the result |
| `roomIndexOf(plan, roomId)` · `nextRoomId(plan)` (smallest free 1..250 or `null`) · `nextId(plan, 'wall')` (free `wall-N`) | |
| `clone(project)` | deep copy, background data URL shared by reference |
| `cleanWifi(obj) → Measurement.wifi|null` · `cleanLinks(list) → links|null` (SPEC 13) · `cleanRouterBands(obj)` · `cleanDeviceInfo(obj) → Measurement.deviceInfo|null` · `cleanFit(obj) → Fit|null` | the validators `sanitize` uses for the SPEC 8 / 9 extras (every field checked on its own; null = nothing usable). `macOf(text)` → `'aa:bb:cc:dd:ee:ff'` (from `AA-BB-…`, `aabb…`) or null |

## 6. `WH.engine.edit` (helpers for the editor; pure geometry)

Functions marked **mutates** change the plan in place — call them inside `store.commit/live` mutators.

* `nearestWall(plan, p, {maxPx=12, exclude}) → {wall, x, y, t, d}|null` — wall under the cursor (`d` px, `t` along a→b).
* `makeDoor(plan, wallId, p, {widthM=0.9, mpp=0.012, loss=0, name, lang}) → Door` — centred at the projection of `p`, kept inside the wall (walls shorter than the door get an 80 % door); **not added** to the plan. Throws `err.plan.door` for an unknown wall.
* `fitDoors(plan, wallId, oldWall:{a,b}) → count` **mutates** — after a wall moved/reshaped, doors keep their relative position along it.
* `removeObject(plan, id) → removedIds[]` **mutates** — deleting a wall also deletes its doors.
* `snapPoint(plan, p, {vertexPx=8, grid=0.01|false, exclude}) → {x,y,kind:'vertex'|'grid'|'none'}`.

## 7. Model, raster, speed, optimize, analysis

### 7.0 Diffraction softening (`soften`)

A ray model casts razor-sharp shadows: straight red/green wedges radiating from the router through door openings, past
wall ends and furniture corners. Real Wi-Fi diffracts and multipath fills such shadows within a few tens of centimetres,
and to a user the wedges look like rendering bugs. So what the app shows is the free-space term minus a **Gaussian-blurred
obstacle loss**:

```
soft(p) = nearSignal − 20·log10(band/5) − 10·n·log10(max(1, distM)) − G_σ[obstacleLoss](p) + offset      (clamped to [−110, −20])
```

* `soften` = σ in **metres** (default `model.SOFTEN = 0.4`, clamped to `0..model.SOFTEN_MAX = 2`; `0`, a negative number
  ⇒ off = exact rays; `undefined`/`null`/garbage ⇒ the default). The same physical σ at every cell size (cell 4 and cell 8
  give the same penumbra: a 10–90 % ramp of 2.56 σ ≈ 1 m across a shadow edge).
* Only the **obstacle loss** is blurred, never the distance term; the calibration **offset** and the node's `power` are
  added after the blur (so a calibrated map still reproduces a measurement exactly where it was taken).
* The blur never crosses a **wall or closed door** (any wall/door segment with a loss ≥ `model.BARRIER_DB = 0.5` dB between
  two points): walls — between rooms or inside one — stay sharp steps (on average 90 % of their exact size on the real
  plan, 97 % on the demo — less only right next to a doorway; a loss that is constant on each side is not changed at
  all). It does pass through an **open doorway** and across a room boundary without a wall, where the exact field is
  continuous too (masking by room id instead would draw an invisible wall into every doorway).
* Raster (`raster.field/fieldEx`): per source, the loss of every floor cell is blurred with a masked separable
  box-Gaussian — 4 iterations of a row pass + a column pass, box variances 8:4:2:1 of σ², large first, the pass order
  alternating, averaged with the mirrored order. That matches a true wall-masked 2D Gaussian to ≈ 0.15 dB rms on the real
  plan and leaves no rectangles behind doorways (equal boxes or a fixed order do). Cost ≈ +0.3–0.6 ms at cell 8; at
  cell 4 with `aa:2` the softened field is **cheaper** than the exact one (only cells along walls still need sub-samples).
* Point functions (`softSignal`, `combinedSignal`, `pointSignalDetail`, `backhaulSignal`, `calibrate`): the mean of the
  exact loss over a deterministic 128-point Gaussian stencil, without stencil points off the floor or behind a wall/closed
  door as seen from `p`. Agrees with `raster.sample` of the field (median 0.04 dB, p95 0.3 dB away from walls).
* Second node: each source is softened **separately**, then the stronger one wins per cell; `nodeWins` (the weak-uplink
  hatch) and `pointSignalDetail().bestSource` are decided on the **softened** values, so the hatch matches the colours.
* Numbers vs exact rays (demo + real plan, 4 router spots, 3 bands, cell 4; with the band-dependent losses of SPEC 7.1):
  whole-flat coverage changes by ≤ 3.9 percentage points (median 1.1 pp; the worst is the demo at 2.4 GHz), the mean
  by ≤ 0.21 dB, the median by ≤ 2.3 dB (6 GHz, 13–18 dB walls), p10 by −0.2 … +2.0 dB. No
  same-room neighbours that are not separated by a wall differ by more than 3.5 dB (with or without a node, 2.4/5 GHz;
  exact rays: thousands of such pairs > 6 dB).
* σ was tuned on a real user plan: 0.3–0.35 m still leaves recognisable diagonal streaks behind doorways (small rooms
  behind a door), 0.5 m washes out door beams; 0.4 m ≈ the first Fresnel zone radius a few metres behind an
  obstacle at 5 GHz. `soften` is not stored in the Project (no UI); pass it only to compare with the exact model.

### 7.1 `WH.engine.model`

```js
ctx = model.createContext(project, { fit })   // fit: omitted = project.model.fit while view.calibrate !== false;
                                              //      false = the default model; {n, wallFactor, byBand?} = that fit
// Ctx is opaque. Public fields: ctx.version (hash of geometry + parameters + the losses of ALL bands + the fit; cache key),
// ctx.roomsVersion (room outlines only), ctx.mpp, ctx.p ({nearSignal,n,wallLoss,threshold,rangeThreshold,bandPower,baseN,
// routerBands,steer}  (routerBands / steer = SPEC 13, what the band 'auto' of signal / softSignal means):
// n = the fitted exponent when a fit is active, baseN = project.model.n), ctx.wf (obstacle-loss multiplier, 1 without a
// fit), ctx.fit ({n, wallFactor, offsets:{'2.4','5','6': dB|null}} or null),
// ctx.band (5: createContext returns the 5 GHz view; model.forBand(ctx, 2.4|6) gives the others - same version).
// Cost ≈ 0.2 ms. Does not include router/baseline/node/measurements. Tolerates half-edited objects (missing points, NaN):
// they are skipped. Without a fit the version is exactly what it was before SPEC 9.
```

Physics (identical to the old app unless noted — see §9), the exact ray model; what the map shows is this with the
obstacle loss softened (§7.0):
`signal = nearSignal − 20·log10(band/5) + bandPower[band] − 10·n·log10(max(1, distM)) − obstacleLoss(band) + offset`,
clamped to [−110,−20].

#### 7.1a Band-dependent obstacle loss (SPEC 7.1)

Every loss stored in a plan (`wall.loss`, `door.loss`, `furniture.loss`, `model.wallLoss`) is the **5 GHz reference**. The
loss used at a band:

| Object | 2.4 / 5 / 6 GHz |
|---|---|
| wall with a preset `material` whose stored loss is missing, equals the table's 5 GHz value or the OLD preset number (`LEGACY_MATERIALS`) | the table `MATERIALS[material]` |
| any other wall with a loss (`custom`, an edited number on a preset material, no material) | `loss × BAND_FACTOR` |
| wall without a loss | `model.wallLoss × BAND_FACTOR` |
| door | `loss × BAND_FACTOR` (an open doorway stays 0) |
| furniture of a preset `kind` with its table's 5 GHz value (or no number) | `FURNITURE_KINDS[kind]` |
| other furniture (`custom`, edited numbers) | `loss × BAND_FACTOR`; `blocksSignal:false` ⇒ 0 |

```js
model.BAND_FACTOR      = {'2.4': 0.65, '5': 1, '6': 1.15}                      // frozen
model.MATERIALS        = { drywall:{'2.4':3,'5':4,'6':5}, wood:{3,5,6}, glass:{2,4,5}, brick:{7,11,13}, masonry:{7,11,13},
                           solid_guess:{10,15,18}, concrete:{12,18,21}, reinforced_concrete:{17,26,30}, metal:{25,30,32} }
model.FURNITURE_KINDS  = { bed:{1,1,1}, wood:{2,3,4}, books:{3,5,6}, appliance:{6,8,9}, metal:{10,12,13}, custom:null }
model.LEGACY_MATERIALS = { drywall:3, brick:8, concrete:12, reinforced_concrete:18, glass:3, wood:3, metal:25, masonry:8, solid_guess:12 }
model.obstacleLossFor(obj, band, project) → dB   // what the model uses for that wall / door / furniture at that band
                                                 // (type inferred when missing; unknown band = 5; project only for walls
                                                 //  without a loss: model.wallLoss, else 8)
model.lossBands(obj, project) → {'2.4','5','6'} // the same for all three bands, e.g. for "7 / 11 / 13 dB"
model.presetOf(obj) → 'brick'|…|'books'|…|null    // the preset whose table applies (null = custom number / default loss)
model.forBand(ctx, band) → ctx view                // only needed for the px helpers traceLoss / crossLoss
```

Scaled numbers are rounded to 4 decimals (8 × 0.65 = 5.2); the 5 GHz value is the stored number itself, so **every
stored number keeps its 5 GHz result bit for bit** (tested on a real user plan against the engine before SPEC 7.1). The one
deliberate 5 GHz change: walls that still carry an OLD preset number are that preset (brick 8 → 7 / 11 / 13). On a real
user plan (whole flat, router at today's place, cell 8) 2.4 GHz coverage rose by about 20 percentage points, 5 GHz stayed
within 0.1 pp and 6 GHz fell by about 1.5 pp; 5 GHz differed from before only where legacy preset walls became their
tables (e.g. `solid_guess` 12 → 15 dB, `drywall` 3 → 4 dB). `model.bandPower[band]` (dB, −10…+6, default 0) is added to that band's signal for the router, the node and
the backhaul alike (routers often send 2.4 GHz ~3 dB weaker). Calibration stays per band and uses that band's losses;
`speed.fillSignals` predicts a speed-only point with its own band; `optimize.find`, `contours`, `analysis.run`,
`raster.field` all trace the band they are asked for. The softening's wall mask (`BARRIER_DB`) is decided on the 5 GHz
reference losses, so `raster.blurPlan` is shared by all bands.
`obstacleLoss`: walls extended by 1.5 px at both ends; crossings < ~2.5 px apart along the ray (corner, T-junction,
duplicates, double lines) count as one obstacle (MAX; beyond 2.5 px the merge fades out smoothly up to 4.5 px so the field has
no wall-sized step there); a ray running inside a wall counts once; a crossing within 3 px of a door's segment uses the door's loss;
furniture adds its loss once per piece if the ray passes through it (chords shorter than 15 cm get a proportional share;
outlines with more than 16 vertices are traced simplified to within 0.25 px - Douglas-Peucker - and culled by a slab test
against their box, so a 200-point round table costs ~20 edges; shapes with ≤ 16 vertices are traced exactly as drawn).

| Function | Returns |
|---|---|
| `obstacleLoss(ctx, a, b, band?) → dB` | between normalized points, exact rays, at `band` (default: the band of `ctx`, i.e. 5 GHz for `createContext()`'s context) |
| `rawSignal(ctx, from, to, band, {nodePower}) → dBm` | uncalibrated, **unclamped**, exact rays |
| `signal(ctx, from, to, band, offset=0) → dBm` | `clamp(raw + offset, −110, −20)`, exact rays |
| `softSignal(ctx, from, to, band, offset=0, soften?) → dBm` | **what the map shows at one point**: softened (§7.0), + offset, clamped. `soften` 0 ⇒ identical to `signal` |
| `softRawSignal(ctx, from, to, band, soften?)` / `softObstacleLoss(ctx, a, b, soften?, band?)` | softened, uncalibrated + unclamped / the softened loss alone |
| `fieldParams(project, 'trial'|'today', {band, offsets, soften}) → State` | `State = {band, router, node, offsets, baseline, soften?}`. `'today'`: router at `net.baseline`, **no node**; `'trial'`: router at `net.router` + the node (`nodeParams`). band default `view.band`; offsets default zeros; `soften` is copied into the state only when given (else every consumer uses `SOFTEN`) |
| `nodeParams(project) → NodeParams|null` | `{mode,pos,power,bands,backhaulBand,backhaulThreshold,maxMbps}` (`maxMbps` null = no ceiling known); `null` when `node.mode==='none'` (or no project / position) |
| `combinedSignal(ctx, p, band, state) → dBm` | `max(router, node)`, each softened with `state.soften`; node counts only for bands it serves; offsets applied per band, node adds `power` |
| `backhaulSignal(ctx, state) → dBm|null` | router → node on `backhaulBand` (softened, what the router-only map shows at the node); compare with `node.backhaulThreshold` |
| `pointSignalDetail(ctx, p, state) → {router, node, combined, baseline, bestSource:'router'|'node', backhaul, weakBackhaul}` | all softened like the map (`state.soften`); `node`/`baseline`/`backhaul` are `null` when not applicable; `weakBackhaul` = node wins here, uplink is wireless and below threshold |
| `calibrate(ctx, measurements, band, {device, baseline, soften}) → {offset, rms, n, fallback, suspicious, used[], fitted?, outliers?}` | speed-only points (`value:null`) never take part; `offset` = median of (measured − `softRawSignal(baseline→point)`) — the prediction is softened like the map and the offset is added afterwards, so a calibrated map reproduces a measurement where it was taken; `rms` of the residuals around it; measurements of `device` (case-insensitive) preferred, if it has none on that band **all devices** are used (`fallback:true`); no points ⇒ `{offset:0,rms:0,n:0}`; `suspicious` = |offset| > 20 dB; `used[i] = {id,x,y,measured,predicted,residual}`. ≈ 0.05 ms per measurement. **With a fit in the context** (`ctx.fit`, SPEC 9) the prediction uses the fitted n / wallFactor and the offset follows `robustOffset` (from 4 points: the mean with > 12 dB outliers dropped, flagged `used[i].outlier:true` and listed in `outliers`; below: the median), `fitted:true`; with no point on that band the fit's stored offset of the band is returned (`n:0`) - the router's strength does not depend on where it stands. This equals the fit's stored `byBand[k].offset` while the measurements are unchanged, and follows new measurements live |
| `calibrateAll(ctx, project, {soften}) → {'2.4':Cal,'5':Cal,'6':Cal}` | per band, uses `goal.device` + `net.baseline` |
| `offsets(ctx, project, {soften}) → {'2.4':dB,'5':dB,'6':dB}` | what you pass to `fieldParams/field`; all 0 when `view.calibrate===false`. Use the same `soften` as for the fields (default everywhere) |
| `softenOf(v)` | resolves a `soften` value: not a number ⇒ `SOFTEN`, else clamped to `0..SOFTEN_MAX` |
| `wallBlocks(ctx, ax,ay,bx,by)` · `crossLoss(ctx, wallIndex, ax,ay,bx,by)` · `roomAtPx(ctx, x, y)` | px helpers of the softening: a wall/closed door ≥ `BARRIER_DB` (at 5 GHz, whatever the band of `ctx`) between two points · one wall's (door-aware) loss at the band of `ctx` where it crosses a segment, −1 if it does not · room id at a px point (0 = outside) |
| `SOFTEN` (0.4 m) · `SOFTEN_MAX` (2 m) · `BARRIER_DB` (0.5 dB) | constants of §7.0 |
| `wallCount(ctx, a, b) → int` | walls / closed doors (≥ `BARRIER_DB`, decided at 5 GHz, fit-independent) the straight line a → b passes through; crossings < 2.5 px apart (corner, T-junction, doubled wall) count once; an open doorway or a line along a wall does not count. "Přes 2 zdi" |
| `robustOffset(residuals, keys?) → {offset, rms, outliers:index[]}` · `OUTLIER_DB` (12) | the offset rule of a fitted model (see `calibrate`): ≥ 4 values: mean after dropping, worst first, values > 12 dB from it (at most ¼, at least 1); 3: median, one > 12 dB off is dropped (mean of the other two); 1–2: median. Order independent (sums in `keys` order) |
| `activeFit(project, {fit}) → {n, wallFactor, offsets}|null` · `FIT_BOUNDS` (`{n:[1.6,4], wallFactor:[0.5,2]}`) | what `createContext` applies |
| `isWirelessNode(node)`, `nodeActive(node, band)`, `offsetFor(offsets, band)`, `bandBase(ctx, band)` (nearSignal − 20·log10(band/5) + bandPower), `traceLoss(ctx, ax,ay,bx,by)` (px, hot path, at the band of `ctx` - pass `forBand(ctx, band)`), `bandIndex(band)` (0/1/2, −1) | low level |

#### 7.1b Calibration fit - `model.fitCalibration / fitProject / fitStale` (SPEC 9, `45-fit.js`)

The plain calibration shifts a band's whole map by the median residual. With a few points that span distances and
wall counts the wizard also learns the SHAPE of the model:

```
measured_i = bandBase(b) + offset_b − n·D_i − wallFactor·L_i + noise
   D_i = 10·log10(max(1, distance_m))      L_i = softened obstacle loss at band b (band factors included, fit ignored)
```

* `offset_b` per band always ("router strength"). With **≥ 4 points of a band** whose distances span a 2× ratio
  (`D` spread ≥ 3) the shared `n` is fitted, whose wall losses span ≥ 3 dB the shared `wallFactor` (each only if the data
  can tell it - `fitted:{n, wallFactor}`); `method` = `'offset+n+walls'` then, else `'offset'` (the plain median of the
  fallback = the existing calibration).
* Least squares on the dB residuals (offsets profiled out per band) with a **ridge prior** towards `model.n` and 1:
  λ = σ²/τ² with τ_n = 0.6, τ_wf = 0.35 and the scatter σ estimated from the data together with a 4 dB prior worth 6
  points (σ² = (6·16 + SSR)/(6 + N − p), clamped 1..8 dB): 4–5 noisy points move the shape only part of the way, 20+
  consistent points pin it down (synthetic ground truth, 25 points, 1.5 dB noise: n within ±0.4, wallFactor ±0.15).
  The box n ∈ [1.6, 4], wallFactor ∈ [0.5, 2] is solved exactly (interior optimum or the best of the four edges).
* **Outliers**: a point more than `OUTLIER_DB` = 12 dB off the fitted model is dropped, worst first, refitting after each
  (at most a quarter of a band's points, at least one; 3 points: the odd one; 1–2: none) and listed in `outliers`.
* The stored offsets / rms / outliers come from `robustOffset` at the final shape - **the very rule `calibrate` applies
  to a fitted context**, so the live map and the stored fit agree (and the live offset follows new measurements).
* `looRms` = leave-one-out error (each point predicted by a fit without it): the honest accuracy number;
  `before` = the same points with the default model (n = model.n, walls × 1) and the plain median offset.
* Deterministic and independent of the order of the measurements; ≈ 0.1 ms per measurement (the softened loss).

| Function | Returns |
|---|---|
| `fitCalibration(ctx, measurements, {baseline*, band?, device?, soften?, prior?}) → FitResult` | `band` = only that band (default: every band with measured points); `device` preferred like `calibrate` (fallback to all devices, `byBand[k].fallback`); `prior = {n, wallFactor, sigma0, tauN, tauW, nu0}` or fixed `{lambdaN, lambdaW}`. A fitted `ctx` is fine (its fit is ignored). `FitResult = {byBand:{[k]:{offset, n?, rms, looRms, count, total, outliers:id[], method, fallback, before:{offset, rms, looRms}}}, n, wallFactor, count, total, method, fitted:{n, wallFactor}, prior:{n, wallFactor, sigma, lambdaN, lambdaW}}` (`count` = points used, `total` = considered). Throws `RangeError` without a baseline |
| `fitProject(project, {band?, device?, soften?, prior?, at?}) → Fit|null` | `fitCalibration` on the project's DEFAULT model (`createContext(p, {fit:false})`), `net.baseline`, `goal.device` → the sanitized object to store in `project.model.fit` (with `at` = now and `sig`); `null` when there is no measured signal |
| `fitStale(project) → bool` | the measurements of the bands the stored fit was made from changed since (added / removed / moved / values / baseline) → offer a refit. False without a fit |
| `fitSignature(project, bands)` · `FIT` | the signature used by `fitStale` · the constants above |

Applying it: `createContext` (see above) → `ctx.p.n = fit.n`, every obstacle loss × `fit.wallFactor` (walls, doors,
furniture, after the band factors; the softening's wall mask stays decided on the stored losses), live offsets from
`calibrate` on that context; all of it only while `view.calibrate !== false`. `createContext(p, {fit:false})` = the
model without the fit (before/after previews).

### 7.2 `WH.engine.raster`

```js
Grid = raster.grid(ctx, { cell = 4 })      // integer 1..64; always covers the whole canvas
// cols = ceil(1080/cell) (270 at 4), rows = ceil(942/cell) (236 at 4), cell, 
// cx, cy : Float32Array(cols*rows)  normalized centre of every CELL INDEX,   colPx, rowPx : Float64Array(cols|rows) px centres
// room : Uint16Array(cols*rows) roomId or 0,   idx : Int32Array of floor cell indices (ascending),
// roomCells : Map<roomId, Int32Array>,  roomIds : number[] (sorted),  areaPx = idx.length*cell²,  count = idx.length,
// rim : Int32Array — non-floor cells touching the floor (used by colorize)
// Cached on (ctx.roomsVersion, cell): the same object comes back after the router/walls/params change. Treat as READ-ONLY.
```

| Function | Notes |
|---|---|
| `field(ctx, grid, params, reuse?) → Float32Array` | `params = {band, router, node?, offsets?, aa?, soften?}` (= `model.fieldParams(...)` result). `reuse`: your own `Float32Array(cols*rows)` to avoid allocation (returned). **`soften`** (metres, default `model.SOFTEN` = 0.4, 0 = exact rays): diffraction softening, §7.0. **`aa`** (default 1): anti-aliasing factor, must divide `grid.cell` (4 → 2 or 4). Softened (default): `aa:2` re-samples only the cells along a wall (wall steps get anti-aliased; everything else is blurred anyway) — no extra cost. Exact (`soften:0`): `aa:2` re-evaluates the cells on wedge / shadow / wall edges (they differ from a same-room neighbour by > 0.4 dB) as the mean of 2×2 same-room sub-samples, ≈ 1.3–2× the cost of aa 1 (equals exhaustive 2×2 supersampling: mean error 0.0005 dB). Rule of thumb: dragging `{cell:8, aa:1}`, settled `{cell:4, aa:2}`. `targetBand` is accepted as an alias of `band`. Deterministic; a `reuse` buffer's old content does not matter |
| `nodeWinsOf(field, params) → Uint8Array|null|undefined` | the `nodeWins` `fieldEx` computed for exactly this output array with these source positions (a WeakMap: nothing kept alive; `undefined` when the array was not, or no longer, computed for them - e.g. a reused buffer refilled for another router position). `speed.fieldSpeed` / `homeSummary` use it, so `a.trial` needs nothing extra |
| `fieldEx(ctx, grid, params, reuse?) → {field, nodeWins:Uint8Array|null}` | `nodeWins[i]=1` where the second node beats the router (hatch it when the uplink is weak). With softening each source is softened separately and `nodeWins` is decided on the softened values (= the colours, = `pointSignalDetail().bestSource`) |
| `diff(a, b)` | `a − b` per cell (positive = a stronger); `diff(trial, today)` = improvement |
| `smooth(grid, field, {passes=1})` | 3×3 blur that never mixes rooms — **display only** (stats should use the raw field). Rarely needed now that fields are softened |
| `stats(grid, field, roomIds|null, threshold, excluded?) → {coverage, mean, median, p10, n}` | area-weighted (every cell has equal area). `roomIds`: array / single id / `null` = whole flat (all rooms except `excluded`). `coverage` in %, others dBm, `p10` = weak tail (10th percentile), `n` cells. Empty ⇒ `{0,−110,−110,−110,0}`. `median`/`p10` are exact order statistics found by selection (O(n), ≈ 0.1 ms for 13 500 cells — the same values a sort gives) |
| `perRoom(grid, field, threshold) → Map<roomId, stats>` | |
| `sample(grid, field, p, {nearest}) → dBm|NaN` | bilinear between cell centres, ignores off-floor neighbours; NaN away from the floor |
| `colorize(grid, field, {palette:'default'|'cb', mode:'signal'|'diff'|'speed', alpha=1, bleed=true, target?}) → {width,height,data}` | one pixel per grid cell, `data` is `Uint8ClampedArray` RGBA → `new ImageData(data,width,height)`. `signal`: dBm field; `diff`: dB difference (≤−10 red, 0 grey/low alpha, ≥+10 green); `speed`: ratio field from `speed.ratioField` (<0 grey = unknown). Off-floor cells transparent. **`bleed:true`** copies the edge colour into the 1-cell rim so that smooth up-scaling stays solid up to the outline — then **clip the image to the room polygons** when drawing (as SPEC §1.8 says); `bleed:false` for a raw image. `target`: reuse a `Uint8ClampedArray(cols*rows*4)` |
| `signalColor(dbm, palette) → [r,g,b]` | for legends; stops are the SPEC §1.8 palettes (`raster.STOPS`) |
| `contours(ctx, {band, router, node?, offset?, offsets?, threshold, res=[120,104], soften?, smooth=2, grid?, field?}) → Point[][]` | range lines = iso-lines of "signal = threshold" (marching squares). Chains of normalized points; a closed loop repeats its first point at the end. **Traced on the softened field** (the colours): by default on a grid of cell ≈ `1080/res[0]` px (9 px at res 120, 18 px at res 60; `aa 1`) inside the rooms and up to ~2 cells beyond the outlines (clip to the rooms when drawing); with `grid` + `field` (e.g. `a.grid, a.trial`) exactly on that field, nothing recomputed. `soften:0` (or a plan without rooms) = the old exact lattice of (res[0]+1)×(res[1]+1) nodes over the whole canvas. Node counted as in `field`. **Smoothed**: points closer than half a lattice cell to their predecessor are dropped (marching-squares stubs), then `smooth` Chaikin passes (default 2, 0 = raw polylines, max 4) — closed loops stay closed, open chains keep their end points, every point stays within half a lattice cell of the raw line; the sharpest turn of a range line on a real plan drops from ≈ 70° to ≈ 20°. 3 bands at res 120 ≈ 6–13 ms, at res 60 ≈ 1.5–3 ms |
| `contours(ctx, {…, source:'router'|'node'|'combined'})` | **SPEC 10.3** (per-source range lines): `'combined'` (default) = the stronger of both sources, as before; `'router'` = the router alone (the node ignored); `'node'` = the second node alone - its position stands in for the router, its `power` is added to the band's offset, only the bands it serves (`[]` when there is no node, it is off, or it does not serve the band; in the band mode Auto only the router bands it serves take part). With a given `grid` + `field` the source is ignored (that field is traced as it is). Same tracing / smoothing; deterministic; the options are not mutated |
| `sourceEdges(grid, nodeWins, {smooth=2}) → Point[][]` | **SPEC 10.3**: the border between the router's zone and the node's zone - smoothed chains like `contours`, traced midway between cells of different winners of a `nodeWins` mask (`fieldEx` / `analysis.run`); chains may run ~2 cells beyond the outlines (clip to the rooms). `[]` without a mask, with a mask of another grid, or when one source wins everywhere. ≈ 1 ms at cell 4 |
| `sourceShare(grid, nodeWins, roomIds?, excluded?) → {node, router, perRoom:Map<roomId, %>}` | **SPEC 10.3**: the node's / the router's share (%) of the selected floor (`roomIds` as in `stats`; null = whole flat minus `excluded`) and the node's share of EVERY room with floor cells. Without a mask: `node 0, router 100` |
| `chaikin(chain, iterations)` | the Chaikin corner cutting used by `contours` (1/4–3/4 points; open chains keep their ends, closed loops stay closed; chains < 3 points untouched) |
| `blurPlan(ctx, grid)` · `boxRadii(sigmaCells)` | internals of the softening, exported for tests: the cached wall-masked row/column runs (keyed on `ctx.version` + cell) · the 4 decreasing box radii |
| `cellAreaM2(ctx, grid)` | m² of one cell |

### 7.3 `WH.engine.speed`

Empirical only — no default dBm→Mb/s conversion. A `Curve` exists only with ≥ 2 distinct measured signal values ≥ 5 dB apart,
download **and** upload on every used test, same band and same device (strict device match here, unlike calibration).

* `buildCurve(measurements, {band, device?}) → Curve|null` — `{band, device, download:[{x,y}], upload:[{x,y}], min, max, count}` (`x` dBm, `y` = log1p(Mb/s) after isotonic regression; `min/max` weakest/strongest measured dBm).
* `diagnose(measurements, {band, device?}) → {count, distinct, spread, ok, needs:'none'|'tests'|'spread'}` — drives the "add another test" hint.
* `fillSignals(ctx, measurements, {baseline, offsets?, soften?}) → Measurement[]` — speed-only points (`value:null`) get the model's
  predicted signal at their spot (router at `baseline`, softened like the map + that band's calibration offset = what the calibrated
  "today" map shows there), as copies flagged `predictedSignal:true`; measured points are passed through as the same objects.
  `buildCurve`/`diagnose` ignore `value:null` points, so pass them the filled list: `buildCurve(fillSignals(ctx, p.measurements,
  {baseline: p.net.baseline, offsets}), {band, device})`. ≈ 0.1 ms per filled point — cache it per calibration.
* `rate(curve, signal) → {down, up, extrapolated}|null` — `null` when weaker than the weakest test; stronger than the strongest ⇒ clamped to the best test (`extrapolated:true`).
* `predict(curve, signal, {wanDown, wanUp, linkLimit, reserve}) → {down, up, extrapolated}|null` — `min(rate, plan, link) × (1 − reserve/100)`; `reserve` in % .
* `linkLimit({wanPort, ontPort, wanLink}) → Mb/s|Infinity` · `toLimits({wanDown,wanUp,wanPort,ontPort,wanLink,reserve})` → `predict`'s argument.
* `fieldSpeed(ctx, grid, params, curve, limits, signalField?, {nodeWins, backhaulCurve}?) → {down, up, known, limitedBy, source, link, supported, reason}` — Float32Array/Uint8Array per cell
  (from `signalField` when given — pass `a.trial` — else from `raster.field(ctx, grid, params)`, i.e. softened unless `params.soften` is 0). **With a second node (stage 7)** node-served cells (`source[i] = 1`, the
  field's `nodeWins`: taken from `opts.nodeWins`, else remembered by `raster.fieldEx` for that very array - so `a.trial` /
  the planner's coarse field need nothing extra - else recomputed) go through the node's link (§7.8); `link` = `nodeLink(...)`
  (also when there is no curve). `limitedBy[i]` = index into `LIMIT_KINDS` (0 = the Wi-Fi signal, 1 plan, 2 link, 3 backhaul,
  4 device), also 3 on node cells whose wireless link is unknown (`known 0`). `supported:false` with `reason:'curve'` (no / broken curve) or `'params'` (no grid / router) — **never `'node'` any more, and never throws**. `limits` takes the raw fields incl. `reserve` (percent).
* `ratioField(grid, sf, targetDown, targetUp) → Float32Array` (NaN off-floor, −1 unknown, `min(down/td, up/tu)` otherwise) for `colorize({mode:'speed'})`.
* `stats(grid, sf, {roomIds|null, excluded, targetDown, targetUp}) → {known, coverage, medianDown, medianUp, p10Down, p10Up, n}` — `known`/`coverage` are % of all selected cells; medians/p10 are `null` when unknown.
* `homeSummary(ctx, grid, params, curve, limits, target, signalField?, {nodeWins, backhaulCurve}?) → HomeSummary` — **"Propustnost bytu"** (SPEC 9):
  `target = {targetDown, targetUp, roomIds?: id[]|null (null = whole home minus excluded), excluded?}`; `params` as for
  `fieldSpeed` (usually `a.params.trial` / `today`; the fitted / calibrated physics come with `ctx` + `params.offsets`);
  pass `signalField` (`a.trial`) to skip the field computation (≈ 40 ms at cell 4 otherwise).
  `HomeSummary = {supported, reason:null|'curve'|'params', areaMeetingTarget (% of the floor meeting BOTH targets), known (%),
  medianDown, medianUp, p10Down, p10Up, perRoom:[{roomId, medianDown, medianUp, meets (%), known (%), n}] (by roomId),
  weakest:{roomId, x, y, signal, down|null, up|null} (the floor cell with the weakest signal), weakestRoom:{roomId,
  medianDown, medianUp, meets} (lowest median download, unknown = lowest), limitedByPlan, planLimitedShare (%),
  planCap:{down|null, up|null} (min of plan and WAN/ONT/link ceilings), limitedShare:{plan, link, backhaul, device} (% of
  the area whose download that ceiling binds - `fieldSpeed().limitedBy`), nodeShare (% served by the second node),
  link (`nodeLink()` or null), target:{down, up}}`. A median is `null` when more than half of that area is weaker than the
  weakest speed test. `planLimitedShare` = % of the area where the Wi-Fi alone (on node cells: incl. the node's uplink
  and ceiling) gives ≥ `PLAN_NEAR` (85 %) of the plan / link ceiling in some direction; `limitedByPlan` = that holds for
  at least half of the area with a known speed. **A second node is supported** (stage 7; its area goes through
  `predictVia` with the node's link). Unsupported (`reason`: no / broken curve, no grid / params) → zeros, `perRoom:[]`,
  `weakest:null`; never throws.
* `monotoneSpeed`, `validRate`, `scoreRatios` — building blocks (the legacy semantics); `validCurve(c)` — a curve as
  `buildCurve` makes it (anything else counts as "no curve" everywhere, never throws); `applyCeilings({down, up}, limits,
  link?)` — the ceilings of `predictVia` applied to a rate you already have (the what-if's anchored speeds);
  `linkFromSignal(node, signal, curve, backhaulCurve?)` — `nodeLink` from a known uplink signal (the optimizer).
* `buildCurve`, `diagnose`, `fillSignals` and `model.calibrate` skip `null` / non-object entries and points without
  finite coordinates instead of throwing (SPEC 10 diagnostics).

### 7.4 `WH.engine.optimize.find(ctx, grid, opts, ctl?) → Promise<Result>`

`opts = {band*, goalRoom|null, allowedRoom|null, threshold, node, offsets, excluded, router, clearance=0.2, aa, soften, speed}`;
`ctl = {onProgress(0..1), signal: AbortSignal}`. `speed = {curve, targetDown, targetUp, limits, reserve, backhaulCurve?}`
optimizes the share of the floor that meets both speed targets instead (rejects with `err.opt.noCurve` without a valid
curve). **With a second node** (stage 7) node-served samples go through `speed.predictVia` with the node's link; a
wireless node's uplink (router → node on its backhaul band, exact rays like the rest of the search) is traced again for
every candidate router position, so the search also weighs how well the router feeds the repeater. `err.opt.speedNode`
is gone (never thrown, string removed).

Result: `{pos, roomId, score, scoreBefore|null, before|null, after, candidates}` with `before/after = {coverage, mean, median, p10}`
computed exactly on the full grid (same method as `analysis.run`: softened with `soften`, default `SOFTEN`; `aa` default
2 at cell ≤ 4); `before` is `null` when `opts.router` is omitted. `score`/`scoreBefore` are the sub-sample scores of the search.

Behaviour: deterministic; candidate lattice ≈ 0.5 m, plus the current router position; scoring on a regular ≤ 1200-point
sub-sample of the target rooms (at least 24 points per room, fewer when there are more than 100 target rooms so the total
stays ≤ ~2400) with the exact rays **of the requested band** (fast); top three refined to ≈ 3 cm; `score = coverage + 0.2·(mean+100) +
0.2·(p10+100)` per room, area-weighted. **Final pick on the softened full grid** (signal mode, `soften` > 0): the three
refined finalists and the current position (when it is an allowed candidate) are scored again with the same formula on
the softened full-grid field, the best one wins — so `after` is never worse than staying put in the numbers the UI shows
(≈ +30–60 ms). The router keeps `clearance` metres from every wall (dropped automatically for tiny rooms; a current
position closer to a wall, e.g. in a doorway, is not a candidate, so there `after` can be a little below `before`); yields
to the event loop every ~12 ms; honours `AbortSignal` (rejects with `error.name === 'AbortError'` — ignore it); typically
0.2–0.5 s. Speed mode ranks as before (exact-ray sub-sample). Rejects with `err.opt.noFloor` when there is nothing to place
the router on.

### 7.5 `WH.engine.analysis.run(project, {cell=4, band, aa, soften, ctx, offsets, cache, reuse}) → Analysis`

```js
{ ctx, grid, band, offsets, threshold, soften, params:{today,trial}, today, trial, diff /* Float32Array */, nodeWins|null,
  backhaul: dBm|null, weakBackhaul: bool, targetRooms: roomId[]|null,
  stats:{today,trial}, perRoom:{today:Map,trial:Map}, delta:{coverage, mean} /* trial − today */,
  source: Uint8Array|null, sourceEdges: Point[][], sourceShare: {node, router, perRoom}|null /* SPEC 10.3, see below */ }
```
**SPEC 10.3 (a second node on)**: `source` = the winning source of every trial cell (1 = the node, 0 = the router; the
same array as `nodeWins`), `sourceEdges` = `raster.sourceEdges(grid, nodeWins)` (the planner's "Zdroj signálu" border;
`[]` without a node), `sourceShare` = `raster.sourceShare(grid, nodeWins, targetRooms, excluded)` (the Result sentence
"AP 2 má navrch v místnostech …"; `null` without a node). Deterministic, ≈ 1 ms extra at cell 4 with a node.
`cell<=4` ⇒ `aa` defaults to 2, otherwise 1. `soften` (metres, default `SOFTEN`) goes into both `params` and is returned;
offsets that `run` computes itself are calibrated with the same `soften`. `cache` (an object you keep, one per quality)
makes the unchanged "today" field **and its statistics** free while the router moves: `today`, `stats.today` and
`perRoom.today` are computed once per (geometry/parameters, baseline, band, offset, cell, aa, soften) and, for the
statistics, (threshold, goal room, excluded rooms); the returned `today`, `stats.today` and `perRoom.today` are then the
cached objects (read-only — the same object on every frame, so `===` tells you they did not change). If trial equals today
(nothing moved, no node) the field is computed once and copied, and the trial statistics are independent copies.
`reuse:{today,trial}` are your own output buffers. Backwards compatible: same result shape (+`soften`), same numbers
with and without a cache.

### 7.6 `WH.engine.analysis.suggestSpots(ctx, project, {band, count=5, minGap=1.5, offsets, router}) → Spot[]`

The numbered pins of the calibration wizard (SPEC 9): `Spot = {x, y, roomId, kind, predicted, distance, walls}`,
`kind` ∈ `analysis.SPOT_KINDS` = `['near', 'sameRoom', 'oneWall', 'twoWalls', 'far']`, returned in that walking order
(then by distance). near = 1–2 m from the router without a wall (closest to 1.5 m); sameRoom = the far side of the
router's room (≥ 2 m, no wall); oneWall = behind exactly one wall near the typical distance of such places (2–5 m);
twoWalls = behind ≥ 2 walls (2 preferred); far = the room with the weakest predicted signal (median), measured near
its visual centre. Every spot lies inside a room, ≥ 0.3 m from every wall (relaxed to 0.15 / 0 m only on plans that leave
no room for it), ≥ 0.2 m inside its room outline, not inside furniture, ≥ `minGap` m from the others and ≥ 0.8 m from
the router. `count` 1..8: fewer spots keep the priority near, far, oneWall, twoWalls, sameRoom; more (or kinds a plan
cannot offer, e.g. no walls) are spread by farthest-point sampling (kind from their wall count). `predicted` = what the
(calibrated, fitted) map shows there (softened, 0.1 dB), `distance` in m (0.01), `walls` = `model.wallCount`. The router
is `net.baseline` (measurements are always taken there) unless `router` is given; band default `view.band`; offsets
default `model.offsets(ctx, project)`. Deterministic, ≈ 3–10 ms. `[]` for a plan without rooms.

### 7.7 What-if at the measured points - `analysis.predictAtMeasurements` (SPEC 10, stage 7)

"How much would the value at my measured points rise or fall if I moved the router / added a wired AP / a repeater?"
**Today** = the router at `net.baseline`, **no second node** (measurements are always taken like that); **new** = the
trial router `net.router` + the current node scenario. Both on the measurement's own band, with the same calibration
(`offsets`) and the same fitted model (`ctx`, SPEC 9), softened like the map.

```js
const ctx  = E.model.createContext(project);                         // the planner's ctx (fit applied while calibrating)
const offs = E.model.offsets(ctx, project);                          // the planner's offsets
const list = E.analysis.predictAtMeasurements(ctx, project, { offsets: offs });   // one entry per measurement, same order
// list[i] = { id, name, band, x, y, roomId, onFloor, inside,
//             measured: -72|null, modelToday: -70.4, modelNew: -56.1, routerNew: -69.0, nodeNew: -56.1|null,
//             delta: +14.3, predicted: -57.7, source: 'node', changed: true,
//             speed: { measuredDown: 120, measuredUp: 40, todayDown: 118, todayUp: 41, predDown: 300, predUp: 96,
//                      anchored: true, limitedBy: 'backhaul', limitedByUp: 'backhaul', capDown: 300, capUp: 96,
//                      reason: null, approx: false } | null,
//             reason: null }
const sum = E.analysis.summarizePredictions(list);                   // counts, mean Δ, best / worst point, per room
E.analysis.whatIfActive(project);                                    // router moved (> 1 px) or a node is on
```

| Field | Meaning |
|---|---|
| `measured` | the measured dBm (`null` for a speed-only point) |
| `modelToday` | what the (calibrated, fitted, softened) map shows at the point with the router at `net.baseline`, no node (dBm) |
| `routerNew` / `nodeNew` | the trial router alone / the node alone (`null` when the node is off or does not serve that band) |
| `modelNew` | `max(routerNew, nodeNew)` = what the trial map shows there |
| `delta` | `modelNew − modelToday` (dB, positive = better) |
| `predicted` | `measured + delta` (clamped to −110…−20), or `modelNew` when `measured` is null — the user's real number anchors it |
| `source` | `'node'` when the node is the stronger source at the point (it serves the client), else `'router'` |
| `changed` | `|delta| ≥ 0.05` dB or `source === 'node'` |
| `roomId` / `onFloor` / `inside` | the room under the point (0 = none); `onFloor:false` for a point off the floor (on an exterior wall line, outside every room) and then `inside` = `project.nearestFloor(...)` ("Posunout dovnitř"), else `null`. Off-floor points are still predicted |
| `bandInferred` / `bandNew` / `steered` | SPEC 13 (§7.9): the point's band was inferred (band null in the data) / the band of `routerNew`, `nodeNew`, `modelNew` (= `band` unless a steering client switches) / steering of the new scenario was on |
| `reason` | `null`, or why an entry could not be computed: `'invalid'` (not an object), `'band'`, `'position'` (the point's or a broken / missing router / baseline marker's coordinates are not finite) — then every model number is `null` (never throws). Without a usable `ctx` (`model.createContext`) or project the result is `[]` |

`opts = {offsets, band, soften, curves, backhaulCurve, limits}` (all optional):
`offsets` default `model.offsets(ctx, project)` (pass the planner's); `band` = only measurements of that band (default:
all, each on its own band); `soften` as everywhere; `curves = {'2.4'|'5'|'6': Curve|null}` overrides the speed curves
(default: per band `speed.buildCurve(speed.fillSignals(ctx, measurements, {baseline, offsets}), {band, device})`,
device = the measurement's own device when it has a curve on that band, else `goal.device`); `backhaulCurve` = the curve
of `node.backhaulBand` (default: built the same way; when none exists the client band's curve is used, flagged
`speed.approx`); `limits = {wanDown, wanUp, wanPort, ontPort, wanLink}` (default `project.net`). **No planning reserve**:
these are expected speeds comparable with the measured ones (`goal.reserve` only applies to the map / target checks).

`speed` (`null` when the point has no speed test AND no curve exists for its band):

| Field | Meaning |
|---|---|
| `measuredDown/Up` | the measured Mb/s (`null` without a speed test) |
| `todayDown/Up` | the model today (router at the baseline): the curve at today's signal (measured dBm, else `modelToday`), plan / link caps; `null` without a curve or when weaker than the weakest test |
| `predDown/Up` | **anchored** when the point has a speed test: `measured × curve(sig_new) / curve(sig_today)` (raw curve rates, sig_today = measured dBm or `modelToday`, sig_new = `predicted`), never above `max(measured, best test of the curve)`, then capped; else (`anchored:false`) the model at `predicted` through `speed.predictVia`. `null` when unknown (`reason`) |
| `limitedBy` / `limitedByUp` | what binds the predicted download / upload: `'backhaul'` (the wireless node's link to the router), `'device'` (`node.maxMbps`), `'link'` (WAN / ONT port / negotiated link), `'plan'` (internet plan; also when the Wi-Fi reaches ≥ 85 % of it, as `speed.PLAN_NEAR`), or `null` (the Wi-Fi signal) |
| `capDown/Up` | the Mb/s of that binding limit (`null` when `limitedBy` is null) — "omezeno propojením ≈ 300 Mb/s" |
| `reason` | `null`, `'curve'` (no speed curve: a point whose scenario does not change keeps its measured speed, anything else is `null`), `'weak'` (the new signal is weaker than the weakest speed test), `'backhaul'` (the node's link is too weak to estimate) |
| `approx` | the backhaul speed came from a curve of another band |

`summarizePredictions(list, {minDb = 1}) → {count, changed, improved, worsened, unchanged, meanDelta, best, worst,
rooms:[{roomId, count, meanDelta, maxDelta, minDelta}] (best first), speed:{count, improved, worsened,
limited:{plan, link, backhaul, device}}}` — `improved/worsened` = `delta ≥ +minDb` / `≤ −minDb` (entries with a `reason`
are skipped); `best`/`worst` = the entries with the largest / smallest `delta` (`null` when none); `changed` = any entry
changed; speed counts use `predDown` vs `measuredDown` (±5 %), `limited` counts `limitedBy`.

### 7.8 Speed through a second node (SPEC 10; lifts the old "speed unsupported with a node" rule)

Clients use the **stronger** source (exactly the signal map's `nodeWins` / `pointSignalDetail().bestSource`).
Router-served places are unchanged. Node-served places:

```
wired AP / wired mesh (ap_cable, mesh_cable): min(curve(node signal), node.maxMbps, link, plan)
wireless mesh (mesh_wifi):                     min(curve(node signal), backhaul, node.maxMbps, link, plan)
repeater:                                      the same, backhaul factor 0.5 instead of 0.6
backhaul = curve(backhaul signal router → node through the walls, band node.backhaulBand) × BACKHAUL_FACTOR[mode]
```
`speed.BACKHAUL_FACTOR = {mesh_wifi: 0.6, repeater: 0.5}` (half-duplex on the same radio), `node.maxMbps` (new,
`null | 10..10000`, sanitized / serialized / round-tripped, `null` = no ceiling known) = the node's real ceiling the user
enters ("Kolik zvládne (Mb/s)"). The map (`fieldSpeed`), the tooltip (`pointSpeed`), the summary (`homeSummary`), the
optimizer's speed mode and the what-if (`predictAtMeasurements`) all go through the same `speed.predictVia`.

| Function | Returns |
|---|---|
| `speed.nodeLink(ctx, state, curve, {backhaulCurve}) → NodeLink|null` | the node's uplink for `state = model.fieldParams(project, 'trial', {offsets})` (`null` without a node): `{mode, wireless, band (backhaul band), signal (dBm, softened router → node; null when wired), weak (signal < backhaulThreshold), factor (0.6 / 0.5 / null), down, up (Mb/s of the backhaul = curve × factor; null when wired or unknown), known (false = wireless and the curve cannot say: no curve / weaker than the weakest test), reason: null|'curve'|'weak', approx (curve of another band), maxMbps, capDown, capUp (= min(backhaul, maxMbps), the node-side ceiling, null = none)}`. `backhaulCurve` = a curve for the backhaul band; default `curve` (then `approx` when its band differs). Works without a curve too: signal + maxMbps ("show the backhaul quality in dBm + the ceiling") |
| `speed.predictVia(curve, signal, limits, link?) → Via|null` | the one speed rule: `limits` = the raw fields (`{wanDown, wanUp, wanPort, ontPort, wanLink, reserve}`) or `toLimits(...)`, `link` = a `NodeLink` when the node serves this place, else omitted. `Via = {down, up (after caps and × (1 − reserve)), wifiDown, wifiUp (the raw curve), extrapolated, limitedBy, limitedByUp, capDown, capUp (the binding ceiling in Mb/s, before the reserve; null when the Wi-Fi signal binds)}`; `null` when the curve cannot say (weaker than the weakest test, no curve) or the node's wireless link is unknown |
| `speed.pointSpeed(ctx, p, state, curve, limits, {backhaulCurve, link}) → PointSpeed` | the map tooltip: `{known, down, up, limitedBy, limitedByUp, capDown, capUp, extrapolated, source, signal, link, reason: null|'params'|'curve'|'weak'|'backhaul'}` - what the Speed map shows at `p` (with the reserve of `limits`) |
| `speed.LIMIT_KINDS` | `[null, 'plan', 'link', 'backhaul', 'device']` - the per-cell codes of `fieldSpeed().limitedBy` |

### 7.9 Band steering, band mode **Auto** and inferred measurement bands (SPEC 13, stage 7b)

A steering client (band steering, Wi-Fi 7 MLO) picks the band by itself, so the user cannot pin it to one band. The
engine models the client with ONE rule and applies it per cell / point everywhere a band is taken:

```
steerBand: 6 GHz   if the router sends 6 GHz   and its signal ≥ model.steer.six  (−70 dBm)
           else 5 GHz if the router sends 5 GHz and its signal ≥ model.steer.five (−72 dBm)
           else 2.4 GHz if the router sends 2.4 GHz
           else (no 2.4 GHz) the strongest band the router sends
```
"Its signal" = the combined signal of that band at the place (router + the second node where it serves that band,
calibrated, softened - exactly what that band's map shows). Bands the router does not send never take part.

Data (sanitized, serialized, round-tripped like everything else):

| Field | Meaning |
|---|---|
| `net.routerBands` | `{'2.4':bool,'5':bool,'6':bool}` "Která pásma tvůj router vysílá"; default `{'2.4':true,'5':true,'6':false}`; all off (or garbage) ⇒ the default |
| `model.steer` | `{six: −90..−50 (−70), five: −90..−50 (−72)}` dBm thresholds of the rule (Advanced). `model.STEER` = the defaults, `project.STEER_MIN/MAX` = −90 / −50 |
| `view.band` | `2.4 | 5 | 6 | 'auto'`. A file's own value is kept; missing ⇒ `'auto'` when ≥ 2 router bands are on, else the single band. `create()` (demo and blank) ⇒ `'auto'` |
| `measurement.band` | `2.4 | 5 | 6 | null` - **null = "Nevím (automaticky)"** (input `'auto'` is stored as null). A missing / invalid band still drops the measurement (old rule). The engine infers the band of a null-band point (`bandInferred`) |
| `measurement.wifi.links` | optional `[{band:2.4|5|6|null, channel:1..233|null, rssiDbm:−110..−20|null, widthMHz:20|40|80|160|320|null}]` (1..4, strongest first) - every Wi-Fi 7 MLO link the parser saw; the primary (strongest) link is also `wifi.band/channel` and the measurement's `band`/`value`. Absent when there were no link lines, so older records keep their shape |
| *verified band* (planner convention, no extra field) | a measurement's band counts as **confirmed** when `wifi.band === band` - the helper / pasted `netsh` output fills `wifi`, and the user's explicit answer (2,4 / 5 / 6 in the checklist, the phone sheet or "Opravit pásmo") is stored as `wifi = {…the other keys, band}`. `band: null` ("Nevím") is confirmed as unknown and inferred. Anything else (old records, a band without `wifi.band`) shows the badge "pásmo neověřeno" (`WH.planner.bands.verified`) |

Functions (all accept `'auto'` wherever a band is taken; none throws on odd data):

| Function | Returns |
|---|---|
| `E.BAND_AUTO` | `'auto'` |
| `units.normBandMode(b)` | `2.4 | 5 | 6 | 'auto' | null` (`'auto'`/`'Auto'`/`' AUTO '` ⇒ `'auto'`, else `normBand`) |
| `model.STEER` | `{six:-70, five:-72}` (frozen) |
| `model.routerBandList(projectOrBands) → number[]` | the bands the router sends, ascending (`[2.4, 5]` by default); a project, a `routerBands` map or an array |
| `model.steerOf(projectOrSteer) → {six, five}` | the thresholds (sanitized, defaults for garbage) |
| `model.steerBand(signals, bands, steer) → 2.4|5|6|null` | the rule above; `signals = {'2.4':dBm,'5':dBm,'6':dBm}` (missing / NaN = that band is not there), `bands` = list or map of the router's bands, `steer` = thresholds. `null` only when no band has a signal |
| `model.isAuto(bandOrState)` | `true` for `'auto'` or a state whose `band` is `'auto'` |
| `model.fieldParams(project, which, {band:'auto'})` | the state gets `band:'auto'`, `bands` (= `routerBandList`), `steer` (= `steerOf`); band default `view.band`, so a planner in Auto mode passes nothing extra |
| `model.signal / softSignal(ctx, from, to, 'auto', offset|offsets)` | the router-only signal of the band the rule picks at `to` - with the context's `ctx.p.routerBands` / `ctx.p.steer` (rebuild the context after `routerBands` / `steer` change if you use this; the fields take them from `fieldParams`) |
| `model.steeredSignal(ctx, p, state) → {band, signal, byBand:{'2.4'|'5'|'6': dBm|null}, nodeWins}` | the combined signal of every router band at `p`, the band the rule picks and its signal (`nodeWins` = the node serves `p` on that band). A single-band state gives that band |
| `model.combinedSignal(ctx, p, 'auto', state)` | = `steeredSignal(...).signal` |
| `model.pointSignalDetail(ctx, p, state)` | + `band` (the band of `router/node/combined/backhaul`); in Auto also `byBand` (trial, per band), `baselineBand` (the band a client uses there TODAY) and `baseline` on that band, `steered:true` - so `combined − baseline` compares what a steering client gets today vs. in the trial |
| `model.inferBand(ctx, project, p, {offsets, soften}) → {band, signals}` | the band a steering client most likely used at `p` TODAY (router at `net.baseline`, no node) |
| `model.resolveBands(ctx, project, {offsets, soften}) → Measurement[]` | same order; a null-band measurement becomes a copy `{...m, band: inferred, bandInferred: true}`, every other one is the same object. `offsets` default: the calibration of the KNOWN-band points (whatever `view.calibrate` says - it is only used to guess the band). Use it for the list ("≈ 5 GHz (odhad)") and before `speed.fillSignals / buildCurve(s)` |
| `model.INFERRED_WEIGHT` | `0.5` - the weight of an inferred-band point in `calibrate` (weighted median / weighted robust mean; `used[i].inferred:true`) and in a fit's offsets (`fitCalibration`: such points never shape n / wallFactor). `calibrateAll`, `offsets` and `fitProject` resolve null bands themselves |
| `raster.field/fieldEx(ctx, g, {band:'auto', bands, steer, …})` | every band's field (softened, calibrated, node per band), then per cell the band of the rule; `fieldEx` returns `{field, nodeWins, bands}` - `bands`: `Uint8Array` band index per cell (0 = 2.4, 1 = 5, 2 = 6, 255 off the floor), `null` for a single band. Cost ≈ one field per router band |
| `raster.bandsOf(field, params) → Uint8Array|null|undefined` | the `bands` `fieldEx` computed for exactly that array (like `nodeWinsOf`) |
| `raster.adoptField(field, params, {nodeWins, bands})` | tell the raster that `field` (e.g. your own copy) is the field of `params` with these extras, so `nodeWinsOf` / `bandsOf` / `speed.fieldSpeed(…, field)` find them (`analysis.run` does it for its trial copy) |
| `raster.bandShare(grid, bands, roomIds?, excluded?) → {'2.4':%, '5':%, '6':%}` | the band-zone legend: "kde budeš na 6 / 5 / 2,4 GHz" (% of the selected floor; roomIds null = whole flat minus excluded) |
| `raster.bandZones(grid, bands, colors, {alpha=0.22, bleed=true, target}) → {width,height,data}` | the optional overlay image (one pixel per cell, like `colorize`); `colors = {'2.4':[r,g,b] or '#rrggbb', '5':…, '6':…}` - read them from the CSS tokens |
| `raster.bandEdges(grid, bands, {smooth=2}) → Point[][]` | the borders between band zones (chains like `contours`) for a thin outline of the overlay |
| `raster.contours(ctx, {band:'auto', bands, steer, …})` | range lines of the steered field (or of a given `grid` + `field`) |
| `speed.buildCurves(measurements, {device}) → {'2.4':Curve|null, '5':…, '6':…}` | `buildCurve` per band (pass `resolveBands` + `fillSignals` output) |
| `speed.curveFor(curves, band) → {curve, band, approx}|null` | the curve of `band`, else the nearest band's (`CURVE_ORDER`: 2.4 → 5 → 6, 5 → 6 → 2.4, 6 → 5 → 2.4) with `approx:true`; `curves` may also be ONE Curve (used for every band, `approx` when its band differs) |
| `speed.fieldSpeed / pointSpeed / homeSummary / nodeLink`, `optimize.find({speed:{curve}})` | `curve` may be a Curve OR a curves map; in Auto every cell uses the curve of its steered band (nearest band's with a flag). `fieldSpeed` + `bands` (Uint8Array|null), `approx` (Uint8Array|null, 1 = a curve of another band), `approxAny`; `pointSpeed` + `band`, `curveBand`, `approx`; `homeSummary` + `bandShare` (`{'2.4','5','6'}` % or null), `approxShare` (%) |
| `optimize.find(ctx, g, {band:'auto', bands, steer, …})` | scores the steered signal per sample (and per-band curves in speed mode) |
| `analysis.run(project, {band})` | band default `view.band` (so `'auto'`); + `bands:{today, trial}` (Uint8Array|null) and `bandShare:{today, trial}` of the goal's rooms (null for a single band). The `cache` key holds the router bands, thresholds and every band's offset. Drag frame (cell 8 + cache) ≈ 4 ms, settled (cell 4) ≈ 17 ms on the demo - about 2× one band |
| `analysis.suggestSpots(ctx, project, {band:'auto'})` | `predicted` = the steered signal; every spot + `band` (the band a client would use there) |
| `analysis.predictAtMeasurements(ctx, project, opts)` | a null-band point is predicted on its inferred band (`bandInferred:true`); entries + `bandNew` (the band of `modelNew / routerNew / nodeNew`) and `steered`. **Steering of the new scenario** (`opts.steer`, default `true` when `view.band` is `'auto'` and `opts.band` is not a number; `opts.band:'auto'` = all points + steering; with one router band nothing switches): the client switches band only when the rule picks ANOTHER band for the new signals than for today's (an unchanged scenario never moves a measured point) - then `bandNew` = that band, `modelNew/routerNew/nodeNew` are on it, `delta = modelNew(bandNew) − modelToday(band)` ("2,4 → 5 GHz, −3 dB" can be a big speed gain), `changed:true`, and the anchored speed is `measured × curve_bandNew(new) / curve_band(today)`; a band without its own curve borrows the nearest band's (`speed.approx`). `opts.band` = a number: only the points on that band (measured or inferred), no steering |

---

## 8. Error keys (thrown `Error.message` = `.code`)

All have cs + en strings in `src/js/10-engine/99-strings.js`, registered with `WH.i18n.add` (UI: `toast(WH.i18n.t(err.message))`).

| Key | Thrown by | Meaning |
|---|---|---|
| `err.plan.invalid` | sanitize, parseSvgText | not an object / no plan data / array member not an object |
| `err.plan.format` | sanitize, parseSvgText | `format` is not `wifi-floor-v2` |
| `err.plan.tooMany` | sanitize | > 250 rooms/walls/doors/furniture |
| `err.plan.duplicateId` | sanitize | two objects share an id |
| `err.plan.point` | sanitize | point not finite or outside 0..1 (± 0.001 tolerated) |
| `err.plan.polygon` | sanitize, serialize, buildSvg | outline self-crossing, < 3 or > 200 points, no area |
| `err.plan.roomId` | sanitize | roomId not an integer 1..250 or repeated |
| `err.plan.door` | sanitize, edit.makeDoor | door without an existing wall |
| `err.svg.badData` | parseSvgText | metadata is not valid JSON |
| `err.svg.dtd` | parseSvgText | DOCTYPE / ENTITY present |
| `err.svg.tooBig` | parseSvgText | > 8 000 000 characters |
| `err.svg.invalid` | parseSvgText | not an SVG text |
| `err.project.invalid` | create | template missing (cannot happen in a normal build) |
| `err.opt.noFloor` | optimize.find | no floor to place the router on |
| `err.opt.noCurve` | optimize.find | speed search without a speed curve |

Other engine strings: `engine.*` (default names, SVG title) — the engine reads them from its own dictionary (`WH.engine.text`)
because it needs an explicit language; they are mirrored into `WH.i18n` as well.

## 9. Differences from SPEC §2.2 / §3 (additions marked +)

* **Diffraction softening** (+, §7.0): `soften` on `field/fieldEx/contours/analysis.run/optimize.find/fieldParams/calibrate*/offsets`,
  default 0.4 m; `model.softSignal/softRawSignal/softObstacleLoss/softenOf/wallBlocks/crossLoss/roomAtPx`, `SOFTEN/SOFTEN_MAX/BARRIER_DB` (+).
  `combinedSignal/pointSignalDetail/backhaulSignal/calibrate` are softened by default (`soften: 0` = SPEC §3.3 exactly).
* `contours` traces the softened field (or a given `grid`+`field`) and smooths the chains (`smooth`, Chaikin) (+); `raster.chaikin` (+).
* `field()` accepts `aa` (+), `reuse` (+); `fieldEx` (+); `raster.smooth/sample/cellAreaM2/signalColor` (+); grid has `colPx,rowPx,rim,roomIds,count` (+) and `cx/cy` are **per cell index**.
* `colorize` has `bleed` (default **true**) and `target` (+).
* `model.fieldParams/offsets/calibrateAll/nodeParams/pointSignalDetail` (+); `calibrate` returns `fallback`, `suspicious`, `used[{id,x,y,measured,predicted,residual}]` (+).
* `project.sanitizeDetailed/clone/nextId/roomAt/floorMaskAt/nearestFloor` (+). `sanitize` also accepts bare plans, `{ed,appliedPlan}` and JSON strings.
* `speed.diagnose/ratioField/stats/toLimits/scoreRatios` (+); `fieldSpeed` returns `supported/reason` (+).
* `optimize.find` options `router`, `clearance`, `aa` (+); result adds `roomId, scoreBefore, candidates` and `before/after` carry `median,p10`. Scoring is area-weighted (SPEC), not per-room-equal as in the old app.
* `analysis.run` (+, caches today's field and statistics), `edit.*` (+). `optimize.find` picks the final position on the
  softened full grid (+).
* **SPEC §3.3 "Band does not alter wall loss" is superseded by SPEC §7.1** (§7.1a): per-band presets and `BAND_FACTOR`,
  `model.bandPower` (+), `model.forBand/obstacleLossFor/lossBands/presetOf/bandIndex`, `MATERIALS/FURNITURE_KINDS/
  LEGACY_MATERIALS/BAND_FACTOR` (+); `obstacleLoss`/`softObstacleLoss` take an optional band (+); `project.WALL_MATERIALS`
  now holds the new tables' 5 GHz values; sanitize upgrades the old preset numbers.
* Files (+): `serialize`/`buildSvg` write the `sanitize(…, {strict:false})`-repaired project (always loadable, no NaN);
  `parseSvgText` runs in linear time on hostile input.
* Physics tweaks beyond SPEC §3.3, all invisible in the normal case: the "cluster" merge is exactly MAX below 2.5 px as specified, but fades out smoothly (2.5 → 4.5 px) instead of switching hard to the sum, so sliding a ray past a junction cannot change the loss by a full wall in one step; furniture chords < 15 cm get a proportional loss (soft shadow edges).
* **SPEC 9 (+)**: `model.fitCalibration/fitProject/fitStale/fitSignature/robustOffset/activeFit/wallCount`, `FIT`,
  `FIT_BOUNDS`, `OUTLIER_DB`; `createContext(project, {fit})` applies `project.model.fit` (`ctx.p.n`, `ctx.wf`, `ctx.fit`,
  `ctx.p.baseN`); `calibrate` uses the robust rule and the stored offsets on a fitted context; `analysis.suggestSpots`,
  `analysis.SPOT_KINDS`; `speed.homeSummary`, `speed.PLAN_NEAR`; `project.model.fit` (optional).
* **SPEC 8 (+)**: optional `measurement.wifi` / `measurement.deviceInfo`; `project.cleanWifi/cleanDeviceInfo/cleanFit/
  macOf`, `CONN_TYPES`, `FIT_METHODS`; the parser `WH.devinfo` (§12).
* **SPEC 10 (+, stage 7)**: `analysis.predictAtMeasurements/summarizePredictions/whatIfActive`, `WHATIF_DB`;
  `speed.predictVia/applyCeilings/nodeLink/linkFromSignal/pointSpeed/validCurve`, `BACKHAUL_FACTOR`, `LIMIT_KINDS`;
  `fieldSpeed` (+ `limitedBy/source/link/signal`, 7th argument) and `homeSummary` (+ `limitedShare/nodeShare/link`, 8th
  argument) support a second node - **SPEC §3.3 "second node ⇒ speed unsupported" is superseded**; `optimize.find` speed
  mode with a node; `node.maxMbps` (`project.NODE_MBPS_MIN/MAX`, `model.nodeParams().maxMbps`); `raster.nodeWinsOf`;
  `err.opt.speedNode` removed. The demo flat is the SPEC 11 showcase (§5).
* **SPEC 13 (+, stage 7b)**: `net.routerBands`, `model.steer`, `view.band:'auto'` (the new default), `measurement.band:null`,
  `measurement.wifi.links`; `units.normBandMode`, `E.BAND_AUTO`; `model.steerBand/routerBandList/steerOf/isAuto/steeredSignal/
  inferBand/resolveBands/weightedMedian`, `STEER`, `INFERRED_WEIGHT`, `ctx.p.routerBands/steer`, `robustOffset(res, keys,
  weights)`; `raster.bandsOf/bandShare/bandZones/bandEdges/adoptField`, `fieldEx().bands`; `speed.buildCurves/curveFor`,
  `CURVE_ORDER`, curve maps everywhere a curve is taken; `analysis.run().bands/bandShare`, `suggestSpots()[i].band`,
  `predictAtMeasurements` entries `bandInferred/bandNew/steered` and `opts.steer`; `project.cleanLinks/cleanRouterBands`,
  `STEER_*`, `ROUTER_BANDS_DEFAULT`, `MAX_LINKS`; `WH.devinfo` `Conn.links`, `linksOf`, `LIMITS.MAX_LINKS`.
* **SPEC 10.3 (+, node layers)**: `contours(…, {source:'router'|'node'|'combined'})`, `raster.sourceEdges/sourceShare`,
  `analysis.run().source/sourceEdges/sourceShare`, `view.sourceZones` (sanitized, serialized, default on; `tests/engine/source.test.mjs`).
* Node test runner: `node --test tests/engine` does not work on Node ≥ 21 (a directory is treated as a module). Use `node tests/engine/run-all.mjs` or `node --test "tests/engine/*.test.mjs"`.

## 10. Performance

Measured on the same (busy, noisy) machine: Node 24 — best / median of 4 runs of 41 repetitions each; headless Chrome —
medians. "Real plan" = a real user plan with a tracing background (~20 walls and ~20 furniture pieces, a
bit larger than the demo); the demo of stages 1–6 (the rows below up to stage 6) had 37 290 floor cells at cell 4, the SPEC 11 showcase flat has 31 160. "Before" = the engine without softening and without the statistics cache / selection (same machine, same runs).

| Call (Node) | Demo before → after | Real plan before → after |
|---|---|---|
| `createContext` | 0.03–0.1 ms | 0.1–0.2 ms |
| `field` cell 8 (135×118), aa 1 — drag mode | 1.8 / 1.9 → 2.1 / 2.7 ms | 2.6 / 3.6 → 3.2 / 4.4 ms |
| `field` cell 4 (270×236), aa 2 | 12.0 / 15.1 → 7.9 / 12.6 ms | 23.0 / 26.5 → 12.4 / 18.2 ms |
| `analysis.run` cell 8, aa 1, `cache` (one drag frame) | 4.3 / 4.9 → 2.0 / 2.7 ms | 7.3 / 7.8 → **3.9 / 4.0 ms** |
| `analysis.run` cell 4, aa 2, `cache` (settled frame, router moved) | 23 / 32 → 8.3 / 10.4 ms | 39 / 45 → **14.7 / 17.1 ms** |
| `analysis.run` cell 4, no cache (today + trial) | 32 / 50 → 16.5 / 20.5 ms | 75 / 89 → 38 / 44 ms |
| `contours` × 3 bands, res 120 / res 60 | 7.2 / 2.0 → 5.2 / 1.2 ms | 11.1 / 2.3 → 9.0 / 2.4 ms |
| `pointSignalDetail` (tooltip) | ~0 → 0.03–0.04 ms | ~0 → 0.06–0.1 ms |
| `optimize.find` (cell-4 grid) | 0.2–0.25 s | 0.3–0.5 s |

In the real app (headless Chrome, planner over `file://`, real plan, 90 drag frames): coarse drag frame (the planner's own
cell-8 path) 3.8–4.0 ms median, p90 4.6–5.1 ms (before 3.7–5.9 / 4.6–10 ms); settled full-quality analysis 14–25 ms
(before 57–64 ms). `analysis.run` drag frame in Chrome: 5.1–5.7 ms (before 7.7–9.2 ms; `raster.stats` on the cell-8
grid of a real plan 1.5 → 0.1 ms). Limit asked for: `field()` on 270×236 with ~20 walls + ~20 furniture < 150 ms — met by a factor of ≥ 8.

**Stage 5 (band-dependent losses, 2026-10-03)**: the hot path is unchanged (one loss array per band view, picked once per
field), so the numbers are the same as before within noise. Node, real plan, 90-frame drag path, per band: drag frame
(`analysis.run` cell 8 + cache) 3.6–3.9 ms median, settled (cell 4, aa 2) 15–17 ms median - old engine in the same runs
3.6–3.9 / 15–17 ms. Note: this laptop drops to ~1/3 of its clock after ~4 s of continuous load (every measurement,
`raster.stats` included, then becomes 3.3× slower), so long runs read 11–12 ms / 40–45 ms for the old and the new build
alike (headless Chrome, planner's own coarse path: root build before stage 5 11.5 ms, new 11.4 ms; settled 43 / 44 ms).
250 of everything (250 rooms / walls / doors / 8-gon furniture, 500 measurements; tests/engine/robust.test.mjs):
sanitize ≈ 55 ms, `buildSvg` ≈ 60 ms (0.7 MB), parse ≈ 15 ms, `field` cell 8 ≈ 25–40 ms, `optimize.find` a few s
(was 40 s: ≥ 24 samples in each of 250 rooms; now capped). Many-sided furniture is culled by a slab test before its edge
loop and simplified to 0.25 px (250 × 200-gons: `field` cell 4 1.15 s → 0.28 s, `analysis.run` cold 2.0 → 0.37 s); plans
whose furniture has ≤ 16 vertices (every realistic one, the demo, real user plans) trace exactly as before.

**Stage 6 (SPEC 8 / 9, Node, demo)**: `fitCalibration` 1.7 ms for 6 points, 5.7 ms for 20 (the softened loss per point
dominates); `suggestSpots` ≈ 4.5 ms; `homeSummary` 13 ms with the signal field handed in (20 ms computing it, cell 4);
`analysis.run` cell 4 with a fit = without (9.4 / 9.7 ms: the fit is one multiply per traced ray and another `n`).
`WH.devinfo.parse` < 1 ms per fixture.

**Stage 7 (SPEC 10, Node, the new showcase demo, 12 measurements with speed tests, best / median)**: `fieldSpeed` cell 4
3.1 / 3.2 ms router only, 3.2 / 3.7 ms with a wired AP, 3.4 / 3.6 ms with a repeater (cell 8: 0.8–0.9 ms) - the node's
cells cost nothing extra once the field (`a.trial`) and its remembered `nodeWins` are handed in; `homeSummary` cell 4
17–21 ms (the per-room order statistics); `predictAtMeasurements` 1.2 ms (no node) / 1.8 ms (node) for 12 points incl.
building the speed curves (< 15 ms for 30 points, tested < 120 ms); `pointSpeed` 0.05 ms (0.12 ms with a node).

**Stage 7b (SPEC 13, Node, demo, best / median)**: band mode Auto with the default 2.4 + 5 GHz router = two fields per
frame: `analysis.run` drag frame (cell 8, aa 1, cache) 3.9 / 4.2 ms (one band 2.1 / 2.3), settled (cell 4, aa 2, cache)
16.4 / 18.5 ms (one band 8.6 / 9.4); `contours` Auto res 120 3.8 / 4.2 ms; `bandEdges` 1.3 ms; `optimize.find` Auto 0.33 s
(one band 0.21 s). A one-band router in Auto costs exactly one field.

## 11. Tests

Stage 6 (SPEC 8 / 9) added: `fit.test.mjs` (synthetic ground truth: 25 noisy points recover n / wallFactor / offset on the
demo and a 3×3-room plan at 5 and 2.4 GHz, noise-free data almost exactly; 4–5 noisy points stay near the defaults, wild
truths are pulled in; bounds under fuzz and at extreme truths; > 12 dB outliers flagged and the fit unmoved; < 4 points =
the plain median; spans decide what is fitted; determinism / order independence / a fitted context refits the same;
`robustOffset`; `fitProject` storage, file round trips, `fitStale`; sanitize of hostile fits; the context applies the fit
only while calibration is on; live calibration = stored offsets, stored offset kept without points; ONE source of truth:
field = n_fit / wallFactor × blurred loss cell by cell, `analysis.run`, contours, optimizer `after`, `fillSignals`;
cost), `spots.test.mjs` (every SPEC 9 rule on the demo, a 3×3 plan, an open room, a tiny flat, no rooms; kinds and
walking order; count / band / minGap; predicted = the fitted map; speed), `home.test.mjs` (`homeSummary` = `speed.stats`
overall and per room, weakest cell / room, plan limit detection, rooms / excluded, unsupported cases, the fitted signal),
`extras.test.mjs` (measurement `wifi` / `deviceInfo`: cleaning, hostile values, omitted when empty, exact old shape,
serialize + SVG round trips, prototype pollution, the parser's `toWifi` output stored unchanged), and
`tests/devinfo/parse.test.mjs` + `hash.test.mjs` (§12).

Stage 7 (SPEC 10 / 11) added `whatif.test.mjs`: nothing changed → delta 0 / predicted = measured / speed kept; moving
the router closer to a far point → positive delta there (and negative in its old room), today / new = the tooltip
(`pointSignalDetail`) and the raster; the anchoring formula; a wired AP next to a point → a large delta, served by the
node, capped only by `node.maxMbps` ('device'), the plan ('plan', also at 85 %) or the WAN port ('link'); a repeater
behind 2 walls → strong client signal but the speed capped by its uplink ('backhaul', = curve(backhaul) × 0.5; mesh × 0.6);
`nodeLink` (wired / no curve / too weak / other band / explicit backhaul curve); ONE rule: every `fieldSpeed` cell =
`predictVia`, map vs points vs `pointSpeed` agree; `homeSummary` with a node; the optimizer's speed mode with a node;
band, calibration offsets and the fit apply to today and new alike; determinism; odd data (null entries, numbers,
arrays, no band, NaN / string positions, off-floor points with a floor point to move to, invalid rates, no / broken
curves, odd projects) never throws; `summarizePredictions`; `node.maxMbps` sanitize / serialize / SVG round trip;
`whatIfActive`; speed. The demo-dependent tests were updated for the showcase flat (`sanitize.test.mjs` checks its
rooms, areas, materials, furniture shapes and sizes - toilet, washbasin, chair and balcony table are not boxes, ≤ 12
corners each -, router / inlet / node rooms, the markers' clearance for a phone - router and inlet ≥ 1.2 m apart, ≥ 0.4 m
from every wall, ≥ 0.9 m from the hall label, not in furniture -, the excluded balcony). `predictAtMeasurements` also
returns `[]` for a `ctx` that is not a model context and reason `'position'` for broken router / baseline markers.

Stage 7b (SPEC 13) added `steer.test.mjs`: the steering rule (thresholds, missing bands, no 2.4 GHz, garbage), data
(routerBands / steer / view 'auto' / band null / wifi.links sanitized, serialized, SVG round trip, older files), the
point model in Auto (steeredSignal = per-band combinedSignal, pointSignalDetail band / baselineBand, signal / softSignal
'auto'), the raster (every cell = the field of the band the rule picks, incl. the node and offsets; bandsOf, shares,
stricter thresholds, zones, edges, contours, a one-band router = that band exactly, no param mutation, buffers),
`analysis.run` (bands, shares, Auto between the bands' coverages, cache invalidation by thresholds / router bands),
the optimizer (before / after = the Auto analysis, curve maps, no curve), speed (curveFor order / approx, map = rule,
tooltip, summary shares, the node's backhaul curve from a map), inferBand / resolveBands, the weighted calibration
and fit (inferred points), the what-if (no switch without a change, a switch to 5 GHz with an AP, anchored speed over
two curves, steer:false, band filters) and speed. `tests/devinfo/parse.test.mjs` checks the MLO links (two links, the
real one-link output, helper raw / JSON, garbage) and `extras.test.mjs` stores them. The single-band tests that
assume a 5 GHz view now set `view.band = 5` explicitly (the demo opens in Auto).

Map layers `view.points` / `view.whatif` (planner "Body měření" / "Předpověď u bodů"): `sanitize.test.mjs` checks the
defaults (demo, blank, `defaults()`: on), older files without the keys and the OLD app's payload (on), each one off kept
through `sanitize`, `serialize` (localStorage), the SVG round trip and idempotence, and non-booleans falling back to on;
`_validate.mjs` requires both booleans.

`node tests/engine/run-all.mjs` (= `npm test`; ≈ 20–25 s, 289 tests: the engine tests + the 22 speed-test unit tests of
`tests/speedtest/` + the Wi-Fi details parser tests of `tests/devinfo/`;
set `WH_PRIVATE_PLAN=/path/to/plan.svg` to also run the real-plan checks on a plan of your own - it is never part of the
repository, and every expectation is derived from that file):
`band.test.mjs` (SPEC 7.1: tables, `obstacleLossFor`/`lossBands`/`presetOf`, per-band tracing of walls / doors /
furniture, `forBand`, version over all bands, `bandPower`, legacy preset upgrade, field = point model per band, contours /
calibration / optimizer proven on "twin" projects - A at 2.4 GHz ≡ B at 5 GHz -, speed-only points per band, and on an
optional private real plan: legacy presets upgraded, presets ≡ the same numbers as custom walls at 5 GHz bit for bit,
coverage 2.4 ≥ 5 ≥ 6 GHz); `robust.test.mjs`
(hostile 8 MB inputs in linear time, absurd JSON, a half-edited live project still exports a loadable file, round trip of
every slice incl. `bandPower` and speed-only points, a 120-plan round-trip fuzz, no NaN/undefined in any export,
many-sided furniture traced within a quarter pixel, 250 of everything end to end); `migrate.test.mjs` also covers the
stored-original rule and the legacy preset upgrade;
speed-only measurements (`speedonly.test.mjs`: sanitize, round trips, migration, calibration, `fillSignals`, curve); geometry & units; physics (corner/T-junction/duplicate/collinear/gap/door/furniture,
calibration, node); raster (grid vs `roomAt`, smoothness bound, corner robustness incl. a comparison with a port of the old
tracer — the tracer tests run with `soften: 0` —, closed-room test, performance, stats, colours, contours); speed curve;
project (an optional private real plan, old demo payload, v3, hostile input, fuzz, prototype pollution); file formats (round
trips, port of the old `safePlan`); auto walls / floor helpers; legacy storage migration; optimizer (improvement,
`allowedRoom`, determinism, abort, event-loop turns); source hygiene (DOM-free, Safari-16-safe syntax, i18n keys).
`soften.test.mjs`: no > 6 dB jump between same-room neighbours not separated by a wall anywhere on the demo (and the
optional private real plan) (5 router spots × node/no node × 2 bands × cell 4 and 8); penumbra width = 2.56 σ at cell 4 and 8 and scales with
`soften`; walls between rooms / inside a room keep their steps, constant losses are untouched, an open doorway lets the
softening through; coverage / mean / median / p10 close to the exact rays; calibration exact (offset after the softening;
a calibrated map reproduces a measurement in a penumbra); node: per-source softening, `nodeWins` = softened winner =
tooltip; tooltip vs raster agreement; the point stencil never reaches through a wall; parameter handling, determinism,
plumbing through `fieldParams/analysis.run/optimize/speed`; performance; contours on the softened field, Chaikin smoothing
(closed stays closed, ends kept, sharpest turn halved and < 35°), a given grid + field traced as is; `analysis.run` cache of
today's stats/perRoom (no recomputation while dragging, correct invalidation); `stats` selection = sorting; the optimizer's final pick on the softened grid is never worse than the (allowed) start and stable when asked again.

## 12. `WH.devinfo` - Wi-Fi details from command output (SPEC 8; `src/js/36-devinfo/10-parse.js`)

A browser cannot read SSID / BSSID / signal / channel / band / link rate on any OS. The user (or the local helper of
SPEC 8.2) runs a command; this pure, DOM-free parser reads its text. Strings of its messages:
`36-devinfo/strings-parse.js` (`devinfo.warn.*`, `devinfo.hash.*`, cs + en).

| Function | Returns |
|---|---|
| `parse(text) → {os:'windows'|'macos'|'linux'|null, source:'netsh'|'system_profiler'|'wdutil'|'nmcli'|'iw'|'helper'|null, interfaces:Conn[], connected:Conn|null, warnings:key[]}` | Windows `netsh wlan show interfaces` (English, Czech, Slovak, German labels; also Czech text whose diacritics broke in `| clip`; several adapters; disconnected; Wi-Fi 6E / 7; the Windows 11 "needs Location" text → `devinfo.warn.location`), macOS `system_profiler SPAirPortDataType` (text and `-json`, and the helper's condensed text) and `sudo wdutil info`, Linux `nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi` (also the default columns and `-t`) and `iw dev <if> link`, and the helper's JSON (also inside its clipboard summary). CRLF / CR / BOM / NBSP / tabs / odd spacing do not matter; never throws; text beyond 300 000 characters is ignored (`truncated`). `connected` = the connected adapter (the strongest when several, `multiple`), the `IN-USE` row of nmcli |
| `Conn` | `{name, description, state:'connected'|'disconnected'|'visible'|…|null, ssid(≤64)|null, bssid, band:2.4|5|6|null, channel, freqMHz, widthMHz, signalPct, rssiDbm, rssiFromPct, noiseDbm, rxRate, txRate, maxRate (nmcli: the AP's max rate, not the link), radio:'802.11ax'|…, wifiGen:'Wi-Fi 4'…'Wi-Fi 7'|'Wi-Fi 6E', security, links}`. `links` (SPEC 13) = every Wi-Fi 7 multi-link (MLO) link `[{band, channel, rssiDbm, widthMHz}]`, strongest first (≤ `LIMITS.MAX_LINKS` = 4), or null; the strongest is the primary link (band / channel / rssiDbm / widthMHz of the Conn when the adapter lines lack them). Band: explicit text first ("5 GHz", "Pásmo 6 GHz", "(6GHz, 160MHz)", "6g37/160"), then the frequency (2400–2500 / 4900–5924 / 5925–7125 MHz), then the channel (1–14 → 2.4, 32–177 → 5). dBm: the RSSI when printed (Windows 11 `Rssi`, Windows Wi-Fi 7 multi-link `LinkID: …, RSSI: -70, Channel: 100, Band: 5 GHz, BW: 80` lines - the strongest link also gives band / channel / width -, macOS, iw), else from the percentage (`rssiFromPct:true`, warning `rssiFromPct`): Windows `signalPct/2 − 100`, nmcli `0.6 × SIGNAL − 100` (NetworkManager's quality maps −100…−40 dBm onto 0…100). 802.11ax → Wi-Fi 6 (6E on 6 GHz), 802.11be → Wi-Fi 7, ac → 5, n → 4 |
| warnings | `devinfo.warn.empty · unknown · noWifi · location · notConnected · multiple · ssidHidden` (macOS "<redacted>") `· rssiFromPct · noSignal · truncated` (`WH.devinfo.WARNINGS`) |
| `toWifi(conn) → Measurement.wifi|null` | `{ssid, bssid, channel, band, rxRate, txRate, radio, security}` + `links` when the connection has MLO links - stored by `sanitize` unchanged |
| `linksOf(list) → links|null` | validates links from the parser or the helper's JSON (`{band, channel, rssiDbm|rssi, widthMHz|width}`), strongest first |
| `fromObject(obj)` | the helper's JSON `{v:1, os, at?, wifi?:{…, links?}, raw?}` (its `/wifi` answer or the hash payload) → the `parse` shape (+ `at`); every field validated; `raw` is parsed with the same rules and fills gaps; a `wifi` object wins |
| `fromHash(str) → {ok, error?, os, source, interfaces, connected, warnings, at?}` | `'#wifi=<base64url(UTF-8 JSON)>'` (also `wifi=…`, `…&wifi=…`, a bare payload, standard base64 with `+/=`, URL-encoded); `error` ∈ `devinfo.hash.none · tooBig` (> 12 000 chars) `· invalid` (bad base64 / UTF-8 / JSON / schema: needs a `wifi` object or a `raw` string, `v` 1..9). Never throws |
| `toHash(obj) → '#wifi=…'|null` | from a `parse` / `fromHash` result or `{os, connected|wifi, raw?, at?}`; drops `raw` when the hash would be too long |
| `wifiGen(radio, band)`, `radioOf(text)`, `bandFromText`, `bandFromFreq`, `bandFromChannel`, `freqOf(ch, band)`, `channelOf(MHz)`, `pctToDbm` | helpers |
| `COMMANDS` | the commands the UI offers (one source): `windows.{show, cmd ('… | clip'), powershell ('… | Set-Clipboard')}`, `macos.{show, copy ('… | pbcopy'), json, wdutil}`, `linux.{show, xclip, wlcopy, iw}` |
| `LIMITS`, `HASH_ERRORS`, `WARNINGS` | constants |

The helper (`pomocnik/`) hands over `{v:1, os, raw}` (the raw command output; the app parses it with these rules) -
both in its `/wifi` answer and in `#wifi=`. Tests: `tests/devinfo/parse.test.mjs` (16 hand-written fixtures + 1 redacted real Windows 11 Wi-Fi 7 output in
`tests/devinfo/fixtures/`, every one as LF / CRLF / CR / BOM / trailing spaces / tabs, broken Czech diacritics, several
adapters, location text, German labels, redacted macOS names, nmcli terse / default / hidden networks, helper JSON,
fuzz, helpers, strings, source hygiene) and `hash.test.mjs` (round trip incl. emoji, the Python / PowerShell encodings,
raw-only, size / encoding / schema rejections, prototype pollution).
