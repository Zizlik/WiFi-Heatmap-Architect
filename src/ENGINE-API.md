# ENGINE-API — authoritative reference for `WH.engine`

Owner: engine (`src/js/10-engine/*`, `tests/engine/*`). This file is the contract for the editor, planner, io and app
code. It supersedes SPEC §2.2 where they differ (differences are listed in section 9). Everything below is implemented,
unit tested (`node tests/engine/run-all.mjs`) and also verified in headless Chrome.

* The engine is **DOM-free**, has no side effects and no state except small caches (`raster.grid`). It runs in the browser
  and in Node.
* Load order = lexical file order: `00-ns, 10-geom, 20-units, 30-project, 31-demo, 35-edit, 40-model, 50-raster,
  60-speed, 70-optimize, 75-analysis, 99-strings`. `WH.i18n` must exist before `99-strings.js` (it does: `00-core`).
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
           cableCategory: 'unknown|cat5|cat5e|cat6|cat6a|cat7|cat8', cableLength: null|0.1..500 },
  node:  { mode: 'none|ap_cable|mesh_cable|mesh_wifi|repeater', pos: Point,
           bands: {'2.4':bool,'5':bool,'6':bool}, power: -10..6 (dB), backhaulBand: 2.4|5|6, backhaulThreshold: -80..-55 },
  model: { nearSignal: -55..-25 (dBm at 1 m, 5 GHz; 40), n: 1.6..4 (2.2), wallLoss: 0..20 (8, the 5 GHz value),
           threshold: -75..-55 (-67, "good signal"), rangeThreshold: -80..-45 (-60),
           bandPower: {'2.4': -10..6, '5': -10..6, '6': -10..6} (dB, default 0 each; added to that band's signal) },
  goal:  { room: 'all'|roomId, allowedRoom: 'any'|roomId, excluded: roomId[], mode: 'signal'|'speed',
           targetDown: 1..10000 (50), targetUp: 1..10000 (50), reserve: 0..80 (30, %), device: string(≤50) },
  measurements: Measurement[] (≤500),
  view:  { band: 2.4|5|6 (5), layer: 'signal|speed|diff', ranges, walls, furniture, labels, values, calibrate: bool,
           palette: 'default|cb' }
}
Room        { id:'room-1', type:'room', roomId:1..250 (unique int), name(≤50), points: Point[3..200], color:'#rrggbb' }
Wall        { id, type:'wall', name, a:Point, b:Point, material?:'drywall|brick|concrete|reinforced_concrete|glass|wood|metal|masonry|solid_guess|custom', loss?:0..30 }
              // `loss` and `material` come as a pair; no loss ⇒ the wall uses model.wallLoss. loss = the 5 GHz value.
              // A preset material stores its table's 5 GHz value (brick 11); sanitize turns the OLD app's preset numbers
              // (brick 8, drywall 3, …) into the new ones, so a legacy preset wall IS that preset (SPEC 7.1)
Door        { id, type:'door', name, a:Point, b:Point, wallId, loss:0..30 }   // loss 0 = open doorway, ~3 = closed door (5 GHz)
Furniture   { id, type:'furniture', name, points: Point[3..200], loss:0..30 (5 GHz), kind:'custom|bed|wood|books|appliance|metal', blocksSignal:boolean }
Measurement { id, x, y, band:2.4|5|6, value:-100..-20 (dBm) | null, name(≤50), download:null|0..10000, upload:null|0..10000, device(≤50), t:epoch ms,
              ping?:0..10000 (ms), jitter?:0..10000 (ms), source?:'cloudflare' }
              // value null = a speed-test point without a measured signal (SPEC 6.2): kept only with download AND upload;
              // ping/jitter/source only when known (the built-in speed test), so older records keep their exact shape
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
`project.ROOM_COLORS`, `NODE_MODES`, `WAN_RATES`, `CABLE_CATEGORIES`, `MAX_ITEMS` (250).

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
```
Always take measurements with the router at `net.baseline` and the second node switched off (the model assumes it).

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
* `normBand(b)` accepts `2.4, '2,4', '5', '5 GHz'…` → `2.4|5|6|null` · `bandKey(b)` → `'2.4'|'5'|'6'` · `bandLabel(b, lang)` → `'2,4'|'2.4'|'5'|'6'`.

## 5. `WH.engine.project`

| Function | Notes |
|---|---|
| `SCHEMA_VERSION` | 3 |
| `create({template:'demo'|'blank', lang}) → Project` | demo: 9.0 × 6.6 m flat, 6 rooms (Obývací pokoj, Kuchyň, Ložnice, Chodba, Koupelna, Pracovna), 11 walls (brick/drywall), 5 doors (open + closed), 13 furniture, `scale.mpp = 0.01`, router = baseline in the hall (a bad spot on purpose), `goal.device` "Telefon"/"Phone". blank: no rooms, `mpp 0.012`. Unknown template ⇒ demo |
| `defaults(lang?)` | fresh `{scale,net,node,model,goal,measurements,view}` (plan-independent defaults) |
| `sanitize(raw, {strict=true, lang}) → Project` | accepts: v3 Project, SVG-metadata payload (with/without `project`), legacy `wifi-floor-v2` `{plan,width,router,original,optic}`, bare plan (old demo shape / `USER_PLAN`), old localStorage `{ed, appliedPlan}`, or a JSON **string** of any of these. Clamps everything, snaps markers to the floor, drops unusable measurements, cleans names (control chars, ≤50 code points). Legacy defaults: `mpp = deriveMpp(plan, width∈[6,25] else 12)`, `baseline = original ?? router`, trial = `router`, optic from file or just inside the left edge, band 5. A wall with a preset material and the OLD app's number of that preset (`LEGACY_WALL_MATERIALS`, e.g. brick 8) gets the new table's 5 GHz number (brick 11; SPEC 7.1); `model.bandPower` defaults to zeros. Throws on garbage (see §8). `strict:false` drops bad objects instead of throwing (used for the app's own localStorage) |
| `sanitizeDetailed(raw, opts) → {project, warnings:string[], svgBackground:string|null}` | `svgBackground` = a legacy `data:image/svg+xml;base64,…` plan background that cannot be kept; **io must rasterize it to PNG** and set `project.plan.background` |
| `serialize(project, {withBackground=true}) → string` | JSON for `<metadata id="wifi-plan-data">`: `{format:'wifi-floor-v2', plan, width, router, original, optic, app:'wifi-heatmap-architect', v:3, project:{name,scale,net,node,model,goal,measurements,view}}`. The first six keys are what the OLD app reads (`width` is clamped to 6..25; `router`=trial, `original`=baseline). Also the format for localStorage `wifi-heatmap-v3`. Throws `err.plan.polygon` for an invalid outline; everything else is written as `sanitize(project, {strict:false})` (a no-op for a store project), so a half-edited object (NaN point, door whose wall is gone, duplicate id, missing colour) is repaired/dropped instead of producing a file our own loader refuses - **every file we write loads again** |
| `buildSvg(project, {lang, markers=true, withBackground=true}) → string` | complete visual SVG 1080×942 (rooms, furniture, walls, doors, labels, router/today/inlet markers, 1 m scale bar) + XML-escaped metadata, both drawn from the same repaired project as `serialize` (no `NaN`/`undefined` anywhere - tested incl. a broken live project and 250-object plans). Round-trips: `parseSvgText(buildSvg(p)).project` deep-equals `sanitize(p)`. Tested against ports of the old loader. ≈ 23 KB for the demo, ≈ 0.7 MB for 250 of everything |
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
ctx = model.createContext(project)
// Ctx is opaque. Public fields: ctx.version (hash of geometry + parameters + the losses of ALL bands; cache key),
// ctx.roomsVersion (room outlines only), ctx.mpp, ctx.p ({nearSignal,n,wallLoss,threshold,rangeThreshold,bandPower}),
// ctx.band (5: createContext returns the 5 GHz view; model.forBand(ctx, 2.4|6) gives the others - same version).
// Cost ≈ 0.2 ms. Does not include router/baseline/node/measurements. Tolerates half-edited objects (missing points, NaN):
// they are skipped.
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
| `nodeParams(project) → NodeParams|null` | `{mode,pos,power,bands,backhaulBand,backhaulThreshold}`; `null` when `node.mode==='none'` |
| `combinedSignal(ctx, p, band, state) → dBm` | `max(router, node)`, each softened with `state.soften`; node counts only for bands it serves; offsets applied per band, node adds `power` |
| `backhaulSignal(ctx, state) → dBm|null` | router → node on `backhaulBand` (softened, what the router-only map shows at the node); compare with `node.backhaulThreshold` |
| `pointSignalDetail(ctx, p, state) → {router, node, combined, baseline, bestSource:'router'|'node', backhaul, weakBackhaul}` | all softened like the map (`state.soften`); `node`/`baseline`/`backhaul` are `null` when not applicable; `weakBackhaul` = node wins here, uplink is wireless and below threshold |
| `calibrate(ctx, measurements, band, {device, baseline, soften}) → {offset, rms, n, fallback, suspicious, used[]}` | speed-only points (`value:null`) never take part; `offset` = median of (measured − `softRawSignal(baseline→point)`) — the prediction is softened like the map and the offset is added afterwards, so a calibrated map reproduces a measurement where it was taken; `rms` of the residuals around it; measurements of `device` (case-insensitive) preferred, if it has none on that band **all devices** are used (`fallback:true`); no points ⇒ `{offset:0,rms:0,n:0}`; `suspicious` = |offset| > 20 dB; `used[i] = {id,x,y,measured,predicted,residual}`. ≈ 0.05 ms per measurement |
| `calibrateAll(ctx, project, {soften}) → {'2.4':Cal,'5':Cal,'6':Cal}` | per band, uses `goal.device` + `net.baseline` |
| `offsets(ctx, project, {soften}) → {'2.4':dB,'5':dB,'6':dB}` | what you pass to `fieldParams/field`; all 0 when `view.calibrate===false`. Use the same `soften` as for the fields (default everywhere) |
| `softenOf(v)` | resolves a `soften` value: not a number ⇒ `SOFTEN`, else clamped to `0..SOFTEN_MAX` |
| `wallBlocks(ctx, ax,ay,bx,by)` · `crossLoss(ctx, wallIndex, ax,ay,bx,by)` · `roomAtPx(ctx, x, y)` | px helpers of the softening: a wall/closed door ≥ `BARRIER_DB` (at 5 GHz, whatever the band of `ctx`) between two points · one wall's (door-aware) loss at the band of `ctx` where it crosses a segment, −1 if it does not · room id at a px point (0 = outside) |
| `SOFTEN` (0.4 m) · `SOFTEN_MAX` (2 m) · `BARRIER_DB` (0.5 dB) | constants of §7.0 |
| `isWirelessNode(node)`, `nodeActive(node, band)`, `offsetFor(offsets, band)`, `bandBase(ctx, band)` (nearSignal − 20·log10(band/5) + bandPower), `traceLoss(ctx, ax,ay,bx,by)` (px, hot path, at the band of `ctx` - pass `forBand(ctx, band)`), `bandIndex(band)` (0/1/2, −1) | low level |

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
| `fieldEx(ctx, grid, params, reuse?) → {field, nodeWins:Uint8Array|null}` | `nodeWins[i]=1` where the second node beats the router (hatch it when the uplink is weak). With softening each source is softened separately and `nodeWins` is decided on the softened values (= the colours, = `pointSignalDetail().bestSource`) |
| `diff(a, b)` | `a − b` per cell (positive = a stronger); `diff(trial, today)` = improvement |
| `smooth(grid, field, {passes=1})` | 3×3 blur that never mixes rooms — **display only** (stats should use the raw field). Rarely needed now that fields are softened |
| `stats(grid, field, roomIds|null, threshold, excluded?) → {coverage, mean, median, p10, n}` | area-weighted (every cell has equal area). `roomIds`: array / single id / `null` = whole flat (all rooms except `excluded`). `coverage` in %, others dBm, `p10` = weak tail (10th percentile), `n` cells. Empty ⇒ `{0,−110,−110,−110,0}`. `median`/`p10` are exact order statistics found by selection (O(n), ≈ 0.1 ms for 13 500 cells — the same values a sort gives) |
| `perRoom(grid, field, threshold) → Map<roomId, stats>` | |
| `sample(grid, field, p, {nearest}) → dBm|NaN` | bilinear between cell centres, ignores off-floor neighbours; NaN away from the floor |
| `colorize(grid, field, {palette:'default'|'cb', mode:'signal'|'diff'|'speed', alpha=1, bleed=true, target?}) → {width,height,data}` | one pixel per grid cell, `data` is `Uint8ClampedArray` RGBA → `new ImageData(data,width,height)`. `signal`: dBm field; `diff`: dB difference (≤−10 red, 0 grey/low alpha, ≥+10 green); `speed`: ratio field from `speed.ratioField` (<0 grey = unknown). Off-floor cells transparent. **`bleed:true`** copies the edge colour into the 1-cell rim so that smooth up-scaling stays solid up to the outline — then **clip the image to the room polygons** when drawing (as SPEC §1.8 says); `bleed:false` for a raw image. `target`: reuse a `Uint8ClampedArray(cols*rows*4)` |
| `signalColor(dbm, palette) → [r,g,b]` | for legends; stops are the SPEC §1.8 palettes (`raster.STOPS`) |
| `contours(ctx, {band, router, node?, offset?, offsets?, threshold, res=[120,104], soften?, smooth=2, grid?, field?}) → Point[][]` | range lines = iso-lines of "signal = threshold" (marching squares). Chains of normalized points; a closed loop repeats its first point at the end. **Traced on the softened field** (the colours): by default on a grid of cell ≈ `1080/res[0]` px (9 px at res 120, 18 px at res 60; `aa 1`) inside the rooms and up to ~2 cells beyond the outlines (clip to the rooms when drawing); with `grid` + `field` (e.g. `a.grid, a.trial`) exactly on that field, nothing recomputed. `soften:0` (or a plan without rooms) = the old exact lattice of (res[0]+1)×(res[1]+1) nodes over the whole canvas. Node counted as in `field`. **Smoothed**: points closer than half a lattice cell to their predecessor are dropped (marching-squares stubs), then `smooth` Chaikin passes (default 2, 0 = raw polylines, max 4) — closed loops stay closed, open chains keep their end points, every point stays within half a lattice cell of the raw line; the sharpest turn of a range line on a real plan drops from ≈ 70° to ≈ 20°. 3 bands at res 120 ≈ 6–13 ms, at res 60 ≈ 1.5–3 ms |
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
* `fieldSpeed(ctx, grid, params, curve, limits, signalField?) → {down, up, known, supported, reason}` — Float32Array/Uint8Array per cell
  (from `signalField` when given — pass `a.trial` — else from `raster.field(ctx, grid, params)`, i.e. softened unless `params.soften` is 0); `supported:false` with `reason:'node'` (a second node is configured: speed through it is not measured) or `'curve'` (no curve). `limits` takes the raw fields incl. `reserve` (percent).
* `ratioField(grid, sf, targetDown, targetUp) → Float32Array` (NaN off-floor, −1 unknown, `min(down/td, up/tu)` otherwise) for `colorize({mode:'speed'})`.
* `stats(grid, sf, {roomIds|null, excluded, targetDown, targetUp}) → {known, coverage, medianDown, medianUp, p10Down, p10Up, n}` — `known`/`coverage` are % of all selected cells; medians/p10 are `null` when unknown.
* `monotoneSpeed`, `validRate`, `scoreRatios` — building blocks (the legacy semantics).

### 7.4 `WH.engine.optimize.find(ctx, grid, opts, ctl?) → Promise<Result>`

`opts = {band*, goalRoom|null, allowedRoom|null, threshold, node, offsets, excluded, router, clearance=0.2, aa, soften, speed}`;
`ctl = {onProgress(0..1), signal: AbortSignal}`. `speed = {curve, targetDown, targetUp, limits, reserve}` optimizes the share of
the floor that meets both speed targets instead (rejects with `err.opt.speedNode` if a node is configured, `err.opt.noCurve`
without a curve).

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
  stats:{today,trial}, perRoom:{today:Map,trial:Map}, delta:{coverage, mean} /* trial − today */ }
```
`cell<=4` ⇒ `aa` defaults to 2, otherwise 1. `soften` (metres, default `SOFTEN`) goes into both `params` and is returned;
offsets that `run` computes itself are calibrated with the same `soften`. `cache` (an object you keep, one per quality)
makes the unchanged "today" field **and its statistics** free while the router moves: `today`, `stats.today` and
`perRoom.today` are computed once per (geometry/parameters, baseline, band, offset, cell, aa, soften) and, for the
statistics, (threshold, goal room, excluded rooms); the returned `today`, `stats.today` and `perRoom.today` are then the
cached objects (read-only — the same object on every frame, so `===` tells you they did not change). If trial equals today
(nothing moved, no node) the field is computed once and copied, and the trial statistics are independent copies.
`reuse:{today,trial}` are your own output buffers. Backwards compatible: same result shape (+`soften`), same numbers
with and without a cache.

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
| `err.opt.speedNode` | optimize.find | speed search with a second node |
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
* Node test runner: `node --test tests/engine` does not work on Node ≥ 21 (a directory is treated as a module). Use `node tests/engine/run-all.mjs` or `node --test "tests/engine/*.test.mjs"`.

## 10. Performance

Measured on the same (busy, noisy) machine: Node 24 — best / median of 4 runs of 41 repetitions each; headless Chrome —
medians. "Real plan" = a real user plan with a tracing background (~20 walls and ~20 furniture pieces, a
bit larger than the demo); the demo has 37 290 floor cells at cell 4. "Before" = the engine without softening and without the statistics cache / selection (same machine, same runs).

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

## 11. Tests

`node tests/engine/run-all.mjs` (≈ 15–20 s, 192 engine tests + the 22 speed-test unit tests of `tests/speedtest/`;
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
