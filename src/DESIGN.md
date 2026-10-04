# WiFi Heatmap Architect v3 - design system & shell contract

Owner: **infra** (`template.html`, `build.mjs`, `css/00..30`, `js/00-core`, `js/20-ui`, `js/30-io`, this file).
The editor and planner views are written **against this document**. If something you need is missing, append a line to
`src/CHANGES-REQUESTED.md` and work around it; do not edit infra files.

Contents: 1 Build & load order - 2 DOM contract - 3 Layout contract - 4 Tokens - 5 Component classes - 6 Icons -
7 Hints & tooltips - 8 i18n rules - 9 Runtime API (util, i18n, bus, store, viewport, ui, views, io, shell) - 10 Events - 11 Gotchas.

---------------------------------------------------------------------------------------------------------------------

## 1. Build & load order

```
node build.mjs            # writes index.cs.html (default cs), index.html (default en), sw.js, manifest.webmanifest
node build.mjs --check    # + syntax check, i18n completeness (cs/en keys + placeholders), mandatory hint keys,
                          #   no external URLs, template ids, theme-token sync (Deep dark x2 identical, OLED = same
                          #   properties), size <= 2 MB (no minifier),
                          #   PWA manifest/icons/service-worker version. Exit code 1 on errors.
node build.mjs --dry      # do not write the files (with --check: also catches a stale committed sw.js / manifest)
node build.mjs --out=DIR  # isolated build (HTML + sw.js + manifest + assets/ icons) for QA
```

* **Network rule**: the bundle may not use `fetch`/`XMLHttpRequest` or contain `http(s)://` URLs, except plain-text help
  links in `strings*.js` and the speed test: files in `src/js/35-speedtest/` may call `https://speed.cloudflare.com/`.
* **PWA** (SPEC 6.3): `src/pwa/sw.js` + `src/pwa/manifest.webmanifest` are the sources; the build injects the cache version
  (short SHA-256 of both HTML outputs + manifest + icons) and the precache list. Icons are committed PNGs in `assets/`
  (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, rendered from the brand SVG).
  `src/js/20-ui/pwa.js` adds the manifest link and registers the worker **only on http(s)** - file:// stays request-free.
* **Build id + source map** (stage 7): the template's `{{BUILD}}` becomes `window.WH_BUILD = {v, files}` - `v` = short SHA-256 of
  template + CSS + JS (same in both languages), `files` = `[[line, 'src/js/…'], …]`, the HTML line of every file's
  `/* ===== src/js/… ===== */` marker (rendered in two passes, both one line, so no line moves). `WH.diag` uses it to name
  the source file of a stack frame inside the one inline script (`50-planner/25-measure.js:123`).

Tests: engine `node tests/engine/run-all.mjs`; centring/clipping guard `qa/s5-centering.mjs` (SPEC 7.2, see section 5) (on Node >= 21 `node --test tests/engine` does not work; use that or `node --test "tests/engine/*.test.mjs"`). UI: headless-Chrome scripts live in the QA scratchpad, they load the built `index.cs.html`.

* CSS: `src/css/*.css` in file-name order (`00-tokens`, `10-base`, `20-components`, `30-shell`, `40-editor`, `50-planner`).
* JS: every `src/js/**/*.js` (not `*.test.*`, not starting with `_`) in **lexical path order** in one `<script>`:
  `00-core` -> `10-engine` -> `20-ui` -> `30-io` -> `40-editor` -> `50-planner` -> `90-app`.
* Each file is an IIFE that starts with `globalThis.WH = globalThis.WH || {}`. **Never touch another module at load time**
  (only inside functions that run later) - inside one directory the order is alphabetical, not by dependency.
* Strings files (`strings*.js` or `NN-strings.js`, anywhere under `src/js`) may contain **only** `WH.i18n.add('cs'|'en', {...})`
  calls; the build evaluates them with a stub to verify completeness. Keys are `<module>.<thing>`; help entries are `help.<key>.t|b|more`.
* The shell boots itself on `DOMContentLoaded` (`WH.shell.boot()`); all scripts have run by then, so views registered at load
  time are found. To run your own boot instead set `WH.shell.autoBoot = false` while your script loads and call `WH.shell.boot()`.

## 2. DOM contract (template.html)

| id | what |
|---|---|
| `#app-header` | sticky 56 px header. Children: `#brand`, `#mode-switch` (`#mode-plan` -> editor, `#mode-wifi` -> planner), `#estimate-badge`, `#btn-file`, `#btn-keys`, `#btn-theme`, `#lang-switch`, `#btn-help` |
| `#app-main` | `<main>`; contains the two view roots |
| `#view-planner`, `#view-editor` | `<section class="view" hidden>` - **empty**; `impl.mount(root)` fills them. `hidden` is toggled by `WH.views.go` |
| `#welcome` | first-run overlay (managed by the shell) |
| `#overlay-root` | dialogs, menus, popovers, the hint bubble and the tour are appended here |
| `#toast-root` | toast stack (`aria-live`) |
| `#sr-live` | screen-reader announcements: `WH.ui.announce(text)` |

`<html lang>` is kept in sync with the active language. `body[data-view="planner|editor"]` tells CSS which view is on.
`<html data-theme="light|dark|oled">` is set only when the user chose a theme (dark = Deep dark, oled = OLED black); absent =
follow the OS (light <-> Deep dark). `<html data-scheme="light|dark">` is ALWAYS set (by the pre-paint script in the template and
by `WH.ui.theme`): the colour scheme in effect - OLED and auto-dark count as dark. Module CSS that needs "any dark palette" should
use `:root[data-scheme="dark"]` instead of repeating the prefers-color-scheme / data-theme pair.

## 3. Layout contract for views

The page is a flex column: header (56 px) + `#app-main` (fills the rest). On screens >= 900 px wide and >= 560 px tall the app fits the
viewport (no page scroll, panels scroll inside); below that the page scrolls normally and the stage gets `clamp(300px, 58dvh, 620px)`.

### Wi-Fi view: `.layout > .stage + .sidebar`

```html
<section id="view-planner" class="view">                      <!-- already exists; you fill it -->
  <div class="layout">                                         <!-- grid: 1fr + var(--sidebar-w) (360 / 400 px), < 900 px: stacked -->
    <div class="stage" id="pl-stage">                          <!-- map frame, position:relative, overflow:hidden -->
      <canvas class="stage__canvas"></canvas>                  <!-- fills the stage (absolute inset 0) -->
      <div class="stage__layer"> ...DOM markers (position:absolute)... </div>   <!-- pointer-events:none, children auto -->
      <div class="stage__slot stage__tl"> <div class="toolbar"> ... </div> </div>   <!-- slots: tl tr tc bl br bc cl cr -->
      <div class="stage__slot stage__bc"> <div class="legend"> ... </div> </div>
      <div class="stage__slot stage__br"> <div class="toolbar toolbar--vertical"> zoom buttons </div> </div>
    </div>
    <aside class="sidebar" aria-label="..."> <!-- WH.ui.card(...) elements --> </aside>   <!-- scrolls on its own, gap 12 px -->
  </div>
</section>
```

* `.sidebar` is `position:relative` (absolutely positioned descendants such as `.sr-only` live regions and switch inputs are clipped by its scroll box).
* Toasts never cover the plan or the stage (stage 5): on desktop (>= 900 px) `WH.ui` docks the stack to the **bottom of the
  side panel** (`.sidebar` of the visible view - Wi-Fi sidebar / editor inspector), as wide as its cards, bottom edge level
  with the stage's bottom edge, growing upwards; only if an open `.pop-panel`, `.menu` or `[data-toast-avoid]` element sits
  there does it move to the top of the panel, below the panel's own `position: sticky` children (the planner's action bar),
  or right below an avoided element at the top of the panel (e.g. the head of the "Prvotní měření" guide) - whichever
  covers the least. While a side drawer (`.modal--drawer`: Help, Info o zařízení) is open the stack goes over the stage
  instead (re-placed when a dialog opens or closes).
  While docked at the bottom the panel gets that much extra scroll room (`--toast-pad` on the `.sidebar`, added to its
  `padding-bottom`), so whatever the stack covers can be scrolled up into view; it is removed when the last toast closes.
  A view without a `.sidebar` falls back to the top of the stage between / below the top toolbars (toast body click-through,
  fading under the pointer). On phones at the bottom of the screen unless that would cover a stage control
  (`.stage .toolbar, .stage .legend, .stage__slot > *, .stage .btn, .tool-rail`) or a `[data-toast-avoid]` / open floating
  panel, then below the header; when neither edge is free the one covering less wins, covering a `[data-toast-avoid]` bar
  counting double. Keep map controls inside those selectors and mark key action bars / sheets that must stay
  visible on phones with `data-toast-avoid`.
* Slots (`.stage__tl|tr|tc|bl|br|bc|cl|cr`) have `pointer-events:none` so the map stays pannable between controls; their children are
  clickable. `tc`/`bc` span the stage width and centre their content (a `.legend` is `min(420px, 100%)` wide).
  Wi-Fi mode (stage 7b): the band switch reads `2,4 · 5 · 6 GHz · Auto` (the unit sits inside the segmented control, before
  Auto); on stages ≤ 400 px wide (phones) the `tr` slot takes a second row under `tl` - code that reserves room at the
  top reads the slots' real bottoms (`offsetTop + offsetHeight`), never a fixed height.
* Stage states: `.stage--loading` (dims + thin progress line on the top edge), `<div class="stage__state">` for a centred empty/loading message.
* Put the viewport on the **stage** element: `WH.viewport(stageEl, {...})`. Mouse wheel/drag over `.toolbar, .legend, .pop-panel, .menu, .popover, [data-no-wheel]` is ignored by the viewport.

### Floor-plan view: `.layout.layout--rail > .tool-rail + .stage + .sidebar`

```html
<div class="layout layout--rail">                            <!-- 56 px | 1fr | var(--inspector-w) (320 / 340 px); < 900 px: rail becomes a horizontal bar on top -->
  <div class="tool-rail" role="toolbar" aria-orientation="vertical">
    <button class="tool-rail__btn" aria-pressed="true" data-tip="editor.tool.rect" data-kbd="R"><span data-icon="rect" data-size="24"></span><span class="tool-rail__kbd">R</span></button>
    <span class="tool-rail__sep"></span>
    <span class="tool-rail__spacer"></span>                   <!-- pushes following buttons to the bottom -->
  </div>
  <div class="stage"> <svg class="stage__canvas">...</svg> <div class="stage__slot stage__tl"><div class="stage__hint">Context hint line</div></div> ... </div>
  <aside class="sidebar sidebar--inspector"> cards </aside>
</div>
```

Everything inside a view is yours; the shell only guarantees the root element, `hidden` toggling and the calls `mount -> show -> hide`.

## 4. Tokens (css/00-tokens.css)

All colours are CSS custom properties on `:root`. Three palettes (SPEC 12):
* **light** (default) - the values below the first column;
* **Deep dark** - neutral near-black, no blue cast (bg `#0a0a0b`, surface `#121214`, raised `#19191c`, line `#26262b`, ink `#f2f2f3`,
  muted `#a1a1aa`, accent `#2dd4bf`); applied by `prefers-color-scheme: dark` unless `data-theme="light"` (media block) and by
  `data-theme="dark"` - two identical blocks;
* **OLED black** - `data-theme="oled"` only: `#000` page, stage and surfaces, 1 px hairlines (`#1f1f22` / `#2e2e33`), floating
  layers barely lifted (`#0b0b0c`), NO shadows (zero transparent shadows), no large grey areas, dot grid `rgba(255,255,255,.07)`.
  The OLED block declares exactly the same properties as Deep dark and comes last (with a dark OS both match; it wins).
`build.mjs --check` fails when the Deep dark blocks differ or the OLED block lacks / adds a property - edit all three.
**Never hard-code colours in component CSS; use tokens.** Shadows are always lists (`--shadow-1` may be `0 0 0 0 transparent`, never
`none`), so `box-shadow: var(--shadow-1), inset 0 0 0 1px …` stays valid in every palette.
Module tokens that exist only in light + Deep dark (the planner's `--pl-*`, the editor's `.ed` opacities) get a compatibility copy
of their Deep dark values under `:root[data-theme="oled"]` at the end of 00-tokens.css (OLED on a LIGHT OS would otherwise show
their light values on black); a module that defines its own OLED values wins (same specificity, later file).
Contrast audit (stage 7, `qa/s7-contrast.mjs`): 53 token pairs per palette (text >= 4.5:1, focus / control lines / walls >= 3:1)
plus every visible text element of welcome, planner (+ Speed), editor, Help, menus, toasts and the error details in all three.

* Surfaces/ink: `--bg --surface --surface-2 --surface-3 --surface-float --ink --ink-2 --muted --line --line-strong --control-line --scrim`
  (`--surface-float` = floating layers: popovers, menus, toasts, dialogs, drawers, the tour card - **use it for your own sheets /
  popovers too**: white in light, lifted `#19191c` in Deep dark, `#0b0b0c` in OLED)
* Brand/semantic: `--accent --accent-hover --accent-ink --accent-soft --accent-soft-ink`, `--warn(-soft|-ink)`, `--danger(-hover|-soft|-ink) --on-danger`, `--ok(-soft|-ink)`, `--info(-soft|-ink)`, `--focus`, `--brand-bg --brand-ink` (logo tile, teal in every theme)
* Small parts: `--tip-bg --tip-ink --tip-line --tip-kbd-bg --tip-kbd-line` (tooltip; inverse of the page except OLED, where it is a dark chip), `--accent-kbd-bg --accent-kbd-line` (a `<kbd>` on a solid accent button), `--switch-knob`
* Derived tints (precomputed): `--glass --stage-veil --accent-line --accent-glow --accent-wash --accent-soft-hover --focus-glow --danger-line --hover-wash --mark --drop-scrim`
* Map/canvas: `--stage-bg --stage-dot --stage-dot-major --stage-sheet-shadow --stage-vignette --stage-grid --map-wall --map-wall-soft --map-room --map-room-line --map-label --map-halo --map-furniture --map-marker-ring --map-marker-shadow --map-selection`
* Map labels (stage 7, SPEC 10 "−72 → −58 (+14)"): `--map-chip-bg --map-chip-ink --map-chip-line` (a label chip drawn over heat and dashed
  range lines), `--map-delta-pos --map-delta-neg --map-delta-zero` (the "+14" / "−6" / "±0" text on such a chip; >= 4.5:1 on the chip in
  every palette, also when the chip lies on the darkest heat colour - light chip bg is 96 % white for that). Canvas code: read
  them with `WH.ui.cssVar()` and redraw on `theme:changed`.
* Heat: `--heat-1..6` (default palette, -85 -> -30 dBm), `--heat-cb-1..6` (colour-blind), `--diff-neg --diff-zero --diff-pos`, quality: `--q-excellent --q-veryGood --q-good --q-weak --q-veryWeak --q-unusable`
* Type: `--font --font-mono`, sizes `--fs-xs(12) --fs-sm(13) --fs-md(15) --fs-lg(17) --fs-xl(21) --fs-2xl(28) --fs-hero(42)`; base 15 px, tabular numbers on `.num/.tnum/.kv dd/.badge/.legend/kbd`
* Space (8-pt grid): `--sp-1(4) --sp-2(8) --sp-3(12) --sp-4(16) --sp-5(20) --sp-6(24) --sp-8(32) --sp-10(40) --sp-12(48)`
* Shape/depth/motion: `--r-xs(6) --r-sm(8) --r-md(12) --r-lg(16) --r-pill`, `--shadow-1|2|pop`, `--t-fast(120ms) --t-med(200ms) --ease`
* Layout: `--header-h --sidebar-w --inspector-w --rail-w --gutter --stage-pad`; z-index: `--z-stage-ui(5) --z-header(50) --z-drawer --z-menu(280) --z-modal(300) --z-welcome(400) --z-drop --z-popover(500) --z-toast(600) --z-tour(700)`

Reading colours in canvas/JS: `WH.ui.cssVar('--map-wall')` (cached, refreshed on theme change). Redraw on bus `theme:changed`.
Never branch on `effective() === 'dark'` to pick a colour - read the token (OLED differs from Deep dark).

### 4.1 Stage canvas (SPEC 7.5) - both stages look like a design-tool canvas

| token | light | Deep dark | OLED | use |
|---|---|---|---|---|
| `--stage-bg` | `#eef2f8` | `#0d0d0f` | `#000000` | canvas colour (`.stage` background; fill it yourself if your canvas is opaque) |
| `--stage-dot` | `rgba(19,35,58,.13)` | `rgba(244,244,245,.10)` | `rgba(255,255,255,.07)` | minor grid dots |
| `--stage-dot-major` | `rgba(19,35,58,.21)` | `rgba(244,244,245,.17)` | `rgba(255,255,255,.12)` | every 5th dot (major grid, ~1.6x alpha) |
| `--stage-sheet-shadow` | `rgba(19,35,58,.16)` | `rgba(0,0,0,.60)` | transparent | soft drop shadow under the plan so it reads as a sheet lying on the canvas (OLED: none - black cannot show it) |
| `--stage-vignette` | `rgba(19,35,58,.05)` | `rgba(0,0,0,.28)` | transparent | optional soft darkening towards the stage edges |
| `--stage-veil` | `rgba(238,242,248,.82)` | `rgba(13,13,15,.84)` | `rgba(0,0,0,.86)` | `.stage__state` overlay (derived from `--stage-bg`) |

Recipe (each view draws it itself, in WORLD space): dot spacing is a real-world step chosen so the on-screen spacing
stays ~14-35 CSS px - the planner uses 1-2-5 steps in metres via `scale.mpp` (0.01 ... 50 m), the editor multiples of
its snap lattice (1 % of the canvas, so every dot is a snap point); dot diameter 1-1.5 CSS px independent of zoom (draw
per device pixel, centres snapped to device pixels so they stay crisp); every 5th dot in each direction uses
`--stage-dot-major`; never one DOM node per dot - the planner draws them into one cached offscreen canvas layer
(redrawn only on pan / zoom / resize / theme, reused while the router is dragged), the editor uses one SVG `<pattern>`
whose transform follows the viewport; pan/zoom moves the grid with the plan.
The plan's rooms cover the dots (heat map / room fill); the sheet shadow is drawn once under the union of the rooms
(`shadowColor = --stage-sheet-shadow`, blur ~18 px, offset y ~4 px at fit zoom). Exported PNGs keep a plain `--stage-bg`
(no dots). Redraw on `theme:changed`.

## 5. Component classes (css/20-components.css)

Naming: `block`, `block__element`, `block--modifier`, states `is-active`, `is-selected`, `is-open`, ARIA states (`aria-pressed`, `aria-checked`, `aria-expanded`) are styled too.
Prefer the JS builders in section 9.5 - they produce exactly this markup and wire the behaviour.

**Buttons** `.btn` + `--primary --secondary(default) --ghost --soft --danger --danger-soft`, sizes `--sm --lg`, `--block`, `--icon` (square). Toggle state: `aria-pressed="true"` or `.is-active`. `.btn__kbd` holds a `<kbd>`.
```html
<button class="btn btn--primary btn--lg"><svg class="icon">..</svg><span class="btn__label">Najít nejlepší místo</span><span class="btn__kbd"><kbd>F</kbd></span></button>
<button class="btn btn--icon btn--ghost" data-tip="planner.tool.measure" data-kbd="M" aria-pressed="false"><span data-icon="measure"></span></button>
```
**Segmented control** `.seg` (> `.seg__item` or `button`, `aria-checked="true"`), modifiers `--sm --pill --block`; inside `.toolbar` the active item gets the accent wash + an inner hairline ring.
Corners are concentric by construction: `--seg-r` (container radius, 10 px; `--pill` = round), `--seg-pad` (3 px) and the item
radius `--seg-item-r = --seg-r - --seg-pad - 1px`; a `.seg` placed directly in a `.toolbar` drops its frame, stretches to
the toolbar's content height and takes `--seg-item-r` from the toolbar (`--tb-r`, `--tb-pad`), so the active pill has the
same inset on every side and is never cut off. Change sizes through these variables, not with `border-radius`/`padding` on
the items. The active pill draws its ring INSIDE (`inset` box-shadow) - outer rings get clipped by the container.
**Card** `.card` (+ `--flat --soft --accent`), `.card-head` (`.card-toggle` button, `.card-icon`, `.card-title`, `.hint`, `.spacer`, `.badge--count`, `.card-actions`, `.card-chevron`), `.card-body > .card-body__inner`. Collapsing is driven by `data-open="true|false"` on `.card` (+ `data-collapsible`); use `WH.ui.card()`.
**Field** `.field` > `.field__label` (text + `.hint`) + `.field__row` (control + `.field__unit`) + `.field__hint` / `.field__error`; `--inline` puts label and control on one line; `.field-grid` = 2 columns.
**Controls** `.input` (`--num` right-aligned, `--sm`; `WH.ui.numberInput` is a TEXT field marked `input.input--num[data-num]`
that shows and accepts the app language's decimal separator - "0,9" in Czech - because a `type=number` field follows the
browser's locale; it keeps `.valueAsNumber` (NaN when empty / not a number), `.setValue(v)` and ArrowUp/Down stepping), `.select` (`--sm`), `.textarea`, `.input-group`, `.range` (+ `.range-value`; the `--fill` variable is maintained by `WH.ui.enhance`/`WH.ui.rangeFill`), `.switch` (`<label class="switch"><input type=checkbox role=switch><span class="switch__track"></span><span class="switch__label">..`, `--end`), `.check` (checkbox/radio + label).
**Chips/badges** `.chip` (`aria-pressed`/`.is-active`, `--static`, `.chip__x`), `.badge` + `--accent --ok --warn --danger --info --muted --count`, `.delta` + `--up --down --zero`, `kbd`/`.kbd`, `.kbd-combo`.
**Hint** `.hint` = the 18 px round "?" button; the "?" is the drawn `help-q` icon (16 px svg filling the 16 px content box),
never a font glyph - use `WH.ui.hint(key)` / `<span data-hint="key">`; a hand-written `<button class="hint" data-hint>?</button>`
gets the icon from `WH.ui.enhance`. `.hint--lg` = 22 px. Never give a hint a class that changes its `display`; see section 7.
**Optical text centring**: labels in fixed-height controls (`.btn__label`, `.seg__item > span`, `.seg > button > span`,
`.menu__label`, `.badge__text`, `.chip__label`, `.toolbar__label`, `.field__label > span`, opt-in `.t-cap`) are trimmed to
cap height + alphabetic baseline (`text-box: trim-both cap alphabetic`), so `align-items:center` centres the capitals on
the icon / box (Segoe UI's tall ascent otherwise puts text ~1 px low). `kbd`, `.badge--count` text and the help "steps"
numbers are centred the same way. Put text in such a span (not a bare text node) when it sits next to an icon in a
fixed-height control; never trim text that clips (`overflow:hidden` / ellipsis) - accents would be cut.
**Popovers** `.popover` (rich hint bubble, one shared element `#wh-popover`) / `.popover--tip` (tooltip), `.pop-panel` (generic floating panel next to a button, `WH.ui.popover`), `.menu` (`.menu__item --danger`, `.menu__icon .menu__label .menu__kbd .menu__sep .menu__note .menu__heading`, `.menu__check` + optional `.menu__icon` for checkable / radio items). All floating layers sit on `--surface-float` with a `--line-strong` hairline.
**Theme picker** `.theme-picker[role=radiogroup] > .theme-opt[role=radio][data-theme-value]` (`__swatch __half __card __line __dot __text __name __desc`) - built by `WH.ui.theme.picker()`.
**Diagnostics** `.diag-kv` (when / where / context / message grid), `.diag-pre` (`--full`; selectable monospace block), `.diag-status` (`.is-bad`), `.diag-stack` (stack disclosure), `.diag-dialog`, `.diag-report` (`__copy __show`).
**Overlays** `.modal-backdrop > .modal` (`--sm --wide --drawer`; `.modal__head .modal__title .modal__body .modal__foot`), `.toast` (`--ok --warn --error`, `.toast__icon .toast__text .toast__action .toast__close`), `.drop-overlay`.
**Icon holder** `.icon-badge` (56 px round tint, `--sm` 40 px) for a 24 px icon in empty states, overlays, cards. **Feedback** `.progress` (`--indeterminate`, `.progress__bar`, `--p` 0..1), `.spinner`, `.skeleton`, `.notice` (`--warn --ok --danger --muted`; use an 18 px icon - it is centred on the first text line), `.empty-state` (`__icon __title`), `.dropzone` (`.is-over`, also usable as `<button class="dropzone">`), `.meter` (`style="--v:.72;--c:var(--q-good)"`).
**Lists** `.list` > `.list-row` (`.is-selected`, `--static`, `__main __title __sub`), `.kv` (`<dl class="kv"><div><dt/><dd/></div></dl>`), `.disclosure` (styled `<details>`; `__body`).
**Map UI** `.toolbar` (floating pill; `--vertical --wrap`; `.toolbar__sep .toolbar__label`), `.stage` + slots, `.stage__hint`, `.stage__state`, `.tool-rail`, `.legend` (`__title __bar __marker __words __ticks`, `--cb --diff`, gradient from `--legend-gradient`), `.marker` helpers (`--router --ghost`, optional).
**Layout/utility** `.layout --rail`, `.sidebar`, `.row` (`--wrap --between --end --top`, flex nowrap!), `.col`, `.stack` (vertical, `--gap`), `.cluster` (wrapping group - **use this for groups of buttons**), `.grow`, `.gap-1..6`, `.m-0 .mt-1..6 .mb-1..6 .ml-auto .p-0..6 .px-3 .py-2`, `.w-full`, `.text-muted .text-ink2 .text-accent .text-warn .text-danger .text-ok .text-xs .text-sm .text-lg .text-center .text-right .fw-600 .fw-700 .nowrap .truncate .num .hero-num`, `.sr-only`, `.hide-mobile` (< 900), `.show-mobile`, `.hide-touch`, `.show-touch`.

Focus: every control gets a 2 px `--focus` ring on `:focus-visible`. Touch targets grow to 44 px on `(pointer: coarse)`; on touch-only devices (`hover: none` + `pointer: coarse`) `.btn__kbd` / `.menu__kbd` key chips are hidden. Motion is removed under `prefers-reduced-motion`.

## 6. Icons - `WH.ui.icon(name, size = 20)` / `WH.ui.iconHtml(name, size)` / `<span data-icon="name" data-size="22"></span>`

24x24 grid, 1.75 px round stroke, `currentColor`, `aria-hidden`, `display:block`. **Rendered at 16, 18, 20 or 24 px only** (other sizes snap to the nearest of these). For larger illustrations put a 24 px icon in `.icon-badge` (56 px round holder) or `.empty-state__icon`. Every icon keeps >= 1.5 units padding and is centred (checked by QA). 95 icons (stage 7: `moon-star` = OLED black; the theme menu uses `contrast` Auto, `sun` Light, `moon` Deep dark, `moon-star` OLED):
`plan wifi cursor rect polygon wall door sofa ruler autowall move undo redo zoom-in zoom-out fit grid image layers eye eye-off router home pin sparkles target measure antenna node mesh repeater cable globe speed signal gauge bed box fridge books table folder-open download upload save file-image lock external plus minus x check trash copy edit chevron-down chevron-up chevron-right chevron-left arrow-right arrow-left arrow-up arrow-down menu more search settings list palette refresh play flag lightbulb sidebar help keyboard sun moon moon-star contrast info warning alert-circle check-circle circle help-q phone laptop monitor desktop tablet board tv gamepad terminal`
(furniture presets: `bed` bed/sofa, `box` metal cabinet/wardrobe, `fridge`, `books`, `table`, `sofa`. Measurement devices (SPEC 7.4):
`phone` Telefon, `laptop` Notebook, `desktop` Počítač (PC), `tablet` Tablet, `board` Raspberry Pi (chip board), `tv` Televize / TV box,
`gamepad` Herní konzole, custom names -> `edit` or `monitor`. `help-q` is the bold "?" of the hint button - not for general use.)
Unknown names render the `help` icon and warn once. A few drawings that sit off the 12/12 centre (router, door, wifi,
layers, home, sparkles, signal, bed, lock, flag, moon) are shifted by a `NUDGE` table in `icons.js` so the centre of their
ink box is the centre of the 24 box (checked at 4 px per unit, every icon within 0.3 units). The header estimate badge
uses `info` (the `gauge` looked like the Speed view's icon).

## 7. Hints & tooltips

* **"?" hint** (rich popover): `WH.ui.hint('band')` returns the button (`<button class="hint" data-hint="band"><svg class="icon icon-help-q">`); or write `<span data-hint="band"></span>` anywhere in markup/templates (replaced automatically, also in DOM added later; the span's classes are copied onto the button). Content: `help.<key>.t` (title), `.b` (1-3 sentences), optional `.more`. Hover (150 ms, mouse), keyboard focus and click/tap (click pins) open it; Esc, outside press, scroll, resize close it.
* **Tooltip with shortcut** (small): `<button data-tip="planner.tool.router" data-kbd="R">` or `WH.ui.tip(el, 'planner.tool.router', 'R')`. `data-tip` is an **i18n key**; `data-kbd` accepts `R`, `Ctrl+S`, `ctrl+shift+z`, `?`, `arrowleft`. Icon-only elements get their `aria-label` from the tooltip text (+ the key). Position hint: `data-tip-pos="top|bottom|left|right"`.
* **All existing help keys** (cs+en, written in plain language): `estimate mode dbm quality palette band band24 band5 band6 threshold coverage avgSignal p10 target roomsCount viewSwitch speedView diffView layers ranges rangeThreshold today trial baseline inlet cable optimize allowedArea nearSignal decay wallLoss scale calibration measurement residual unitPct device speedTarget reserve plan wan wanPort ontPort link cableCategory secondAp apCable meshCable meshWifi repeater backhaul power wallMaterial doorLoss furnitureLoss blocksSignal snap trace opacity autoWalls`.
  Stage 7 (SPEC 13): `bandSteering` - "Wi-Fi 7 a automatické přepínání pásem" (one network for all bands, MLO, never pin a device
  to one band, every measurement records its band, the Auto map); use `WH.ui.hint('bandSteering')` next to the Auto band switch /
  the phone band picker instead of writing your own. `help.band.more` also mentions Auto.
  Planner map layers (2026-10-04): `layerPoints` ("Body měření"), `layerWhatIf` ("Předpověď u bodů", key `P`), `layerSource`
  ("Zdroj signálu", SPEC 10.3 - greyed with `data-hint-note` `planner.layers.why.noNode` while no second node is on) in
  `50-planner/strings-layers.js`.
  Need another one? Add `help.<newKey>.t|b|(more)` in **your own** strings file (cs+en); it shows up in the Help panel glossary automatically.
* **State note in a hint**: `hintButton.dataset.hintNote = 'i18n.key'` adds one highlighted line (`.popover__note`, warn tint) under the
  title, read at show time - use it to say why the control next to the "?" is greyed right now (the planner's layer
  "Předpověď u bodů": "Teď není co ukázat: zatím nemáš žádné měření."); delete the attribute when the reason is gone. The help
  key itself stays the same (the glossary shows it once).
* `WH.ui.enhance(root)` (idempotent) = `i18n.applyDom` + `[data-icon]` + `[data-hint]` + tooltip aria-labels + range fills. A `MutationObserver` runs it for every element added to the page, so you normally never call it.

## 8. i18n rules

* Every visible string through `WH.i18n.t(key, params)` or `data-i18n*` attributes (`data-i18n` textContent, `-html` trusted innerHTML, `-title`, `-aria` aria-label, `-ph` placeholder, `data-i18n-params='{"n":3}'`).
* Plural: define `key.one`, `key.few`, `key.other` (cs) / `key.one`, `key.other` (en) and call `t('key', {n})`.
* Fallback: other language -> the key (+ one `console.warn`). `build.mjs --check` fails when a key exists in only one language or a `{placeholder}` set differs (warning).
* Widgets accept `{i18n:'key'}` or a string; a string that looks like a key (`a.b.c`) and exists is translated (and re-translated when the language switches).
* Numbers: `WH.util.fmt(n, digits)` (decimal comma in cs, true minus U+2212), `fmtPct`, `dbm`. Keep a non-breaking space before units (`WH.util.NBSP`).
* Text that is rebuilt by your render functions must be re-rendered on bus `lang:changed`; static markup with `data-i18n` updates itself.

## 9. Runtime API

### 9.1 `WH.util`
`$(id) $$(sel, root) el(tag, attrs?, ...children) svgEl(tag, attrs?, ...children) clamp lerp debounce(fn,ms){.cancel,.flush} throttleRaf(fn){.cancel} uid(prefix) clone fmt fmtPct dbm isTyping(e) download(blobOrString, filename, mime) copyText(text)->Promise<bool> readFileText(file) on(target, ev, fn, opts)->off escapeHtml slug once deepEqual prefersReducedMotion NBSP MINUS isMac`.
`copyText` = Clipboard API, falling back to `execCommand('copy')` on a hidden textarea; never throws.
`el('div.card.p-3#id', {class, style:{}|'', dataset:{}, html (trusted), text, onclick: fn, 'aria-label': 'x', hidden: bool}, child, 'text', [more], null)` - falsy children are skipped, arrays flattened.

### 9.2 `WH.i18n`
`lang` (live), `locale`, `setLang(l)` (persists, re-applies `data-i18n*`, updates `<html lang>`, emits `lang:changed` `{lang}`), `t`, `has(key)`, `add(lang, dict)`, `keys(prefix)`, `onChange(fn)->off`, `applyDom(root)`, `number(n, opts)`, `pluralForm(lang, n)`.

### 9.3 `WH.bus` - `on(topic, fn)->off`, `once`, `off`, `emit(topic, payload)`; a throwing listener never breaks the others.

### 9.4 `WH.store` - single source of truth
* `project` (live object; **re-read it after events** - undo/redo replace nested objects such as `project.plan`), `init(project, {save=true})` (hard reset, clears history, emits everything), `replace(project, label)` (**undoable** swap - import/demo/new), `commit(label, mutator(project), topics?)`, `begin(label) / live(mutator, topics?) / end() / cancel()`, `update(mutator, topics?, {quiet})` (no undo step; `quiet:true` skips the one-time warning when a history slice is changed on purpose, e.g. markers snapped back onto the floor after a plan edit), `undo() redo() canUndo() canRedo() labels()`, `gestureOpen`.
* **Undo covers** `name plan scale net node model goal measurements`. **`view` is not undoable** - change it with `store.update(p => { p.view.layer = 'diff'; }, ['view'])`.
* Topics: `plan scale net node model goal measurements view meta(name) prefs history project:replaced`. Detected automatically from what actually changed (plus the ones you pass). `store.on(topic | [topics] | '*', fn)`: `fn({topics, topic, project, source, label})` runs **once per change batch** even if several listed topics changed. `source`: `commit|live|update|undo|redo|init|replace|cancel|end|prefs`.
* A gesture = `begin('label')`, many `live(p => {...}, ['net'])`, `end()` -> one undo step, only if the result differs from the start. `cancel()` restores (Esc while dragging). Omitting `topics` in `live` costs a JSON diff per call; pass them for dragging.
* Background image (data URL) is never deep-copied by history. No-op commits do nothing (no history entry, no events). A throwing mutator is rolled back and logged.
* `prefs` / `setPref('collapsed.advanced', true)` (dotted paths) / `getPref(key, fallback)`: persisted under `wifi-heatmap-prefs` (`lang theme collapsed tourDone tourOffered welcomeDone checklistDismissed ...`).
* Autosave: 500 ms after any change -> `WH.io.saveLocal`; flushed on page hide. `store.disableAutosave()` for "delete my data".
* Change `net.baseline` -> clear `measurements` (after your own confirmation) in the same `commit`.

### 9.5 `WH.ui` builders
```
icon(name,size) iconHtml hint(key) tip(el,key,kbd,{pos}) enhance(root) rangeFill(input) kbd(spec) kbdText(spec) announce(text) theme cssVar(name)
toast(msg | {text|i18n, params, action:{label|i18n, fn}}, {kind:'info|ok|warn|error', ms})  -> {close}
confirm({title, body (string|Node), ok, cancel, danger}) -> Promise<boolean>
dialog({title, content, wide, small, actions:[{label|i18n, variant, primary, result, onClick(close) /*return false keeps open*/, autofocus}], onClose, initialFocus, className}) -> {el, body, close(), closed:Promise, setTitle}
popover(anchorEl, content, {title, placement:'bottom|top|left|right', align:'start|center|end', width, onClose, autofocus}) -> {el, close, reposition}   // focuses the first control that is not a "?" hint; a window resize (phone keyboard!) repositions menus/panels, it closes them only when the anchor is gone; scrolling moves them with the anchor, and an inner scroll box (sidebar, inspector) that carries the anchor out of view closes them; a caller may replace `handle.reposition` with its own placement (resize / scroll then use it)
menu(anchorEl, items|()=>items, {align}) -> {el, close}      items: {label|i18n, icon, kbd, onClick, danger, disabled, checked, radio, sep:true, note, heading, hidden}
                                                             (checked !== undefined -> check column (+ icon); radio:true -> menuitemradio, opens focused on the checked item)
button({label|i18n, icon, variant, size, onClick, kbd, tip, block, pressed, disabled, ariaLabel}) iconButton({icon, tip, kbd, onClick, size, variant, pressed}) badge(text, kind)
segmented(items:[{value, label|i18n, icon, tip, kbd, disabled}], {value, onChange(value,item), aria, size:'sm', pill, block}) -> el with .value .setValue(v, silent) .setDisabled(v, bool) .button(v)
switch({checked, label|i18n, onChange(bool), hint, disabled, end}) -> label.switch with .input .setChecked(b)
field({label|i18n, hint:'helpKey', unit, control:Node|Node[], help|helpI18n, id, inline}) -> .field with .control .setError(msg)
numberInput({value,min,max,step,onInput(v|null),onChange,ariaLabel,id,placeholder}) -> input with .setValue(v)
select([{value,label|i18n,disabled}], {value, onChange(value), id, ariaLabel}) -> select with .setOptions(opts, value)
range({min,max,step,value,onInput,onChange,format(v)->string,ariaLabel,id}) -> div with .input .setValue(v)
progress({value 0..1 | indeterminate}) -> .setValue(v)
card({id, title|i18n, icon, hint, badge, collapsible=true, open=true, actions:[Node], body}) -> section.card with .body .isOpen() .setOpen(b) .setBadge(n|null) .setTitle(text)   (state remembered in prefs under collapsed.<id>)
keys.register({mode:'global|planner|editor'|[..], key:'r' | 'ctrl+s' | ['ctrl+shift+z','ctrl+y'], i18n:'desc.key', run(e), when(e), allowTyping, allowInModal, repeat, anyShift, hidden, order}) -> off
keys.sheet()  keys.list()  keys.arrowDelta(e, step, big)
tour(steps:[{target: selector|Element|fn, title, body (i18n keys or text), placement, view:'planner|editor', before(), after(), optional, padding}]) -> Promise<'done'|'skipped'>
modalCount()  blockInput(+1|-1)  focusables(container)  textOf(def)
```
Shortcuts: matched on what the layout produces (`e.key`), `ctrl` = Ctrl or Cmd, Shift is ignored for digits/symbols, ignored while typing (inputs/select/textarea/contenteditable/range) and while a dialog or the tour is open. `run` returning `false` = "not handled". The global ones (`1 2 ? F1 Ctrl+S Ctrl+O Ctrl+Z Ctrl+Shift+Z/Ctrl+Y + - 0 Esc`) are registered by the shell; **do not re-register them**. `+ - 0` emit bus `viewport:zoom {factor}` / `viewport:fit`, which every *visible* `WH.viewport` handles itself. Mode-scoped keys (`R`, `M`, `V`, ...) are yours: use `mode:'planner'` / `'editor'` and an `i18n` description - the cheat sheet is generated from the registrations. Mouse/touch help lines in the sheet are fixed (`keys.mouse.*`).

`WH.ui.theme` = `{list() get() set(v) cycle() resolved() effective() isDark() apply() menu(anchor) picker()}` (SPEC 12). Values
`auto|light|dark|oled` (pref `theme`; dark = Deep dark, oled = OLED black). `resolved()` -> the palette in use
(`light|dark|oled`); `effective()` -> the colour SCHEME (`light|dark`; OLED is dark, so canvas code that only knew light/dark keeps
working); `menu(anchor)` opens the radio menu (header `#btn-theme`, welcome `[data-theme-menu]`, File -> "Vzhled…" on phones where
the header button is hidden); `picker()` -> the Help panel's preview tiles. Bus `theme:changed {theme, effective, resolved}`.
The template's pre-paint script applies a saved theme (`data-theme`, `data-scheme`) before first paint.

### 9.6 `WH.viewport(hostEl, opts) -> vp`   (alias `WH.viewport.create`)
World = canvas px (0..1080 x 0..942, from `WH.engine.CANVAS`); public points are normalized 0..1. `vp.view = {scale, tx, ty}`: host-relative px = world px * scale + t, measured from the host's **padding box** (inside the 1 px `.stage` border) - exactly where an `inset:0` canvas/svg/marker layer starts. `toWorld/toClient` do the border maths; views must not add their own `clientLeft/clientTop` compensation.
* SVG: `<g transform>` = `vp.svgTransform()`; canvas: `ctx.setTransform(s*dpr,0,0,s*dpr,tx*dpr,ty*dpr)` with `vp.matrix()`.
* opts: `onChange(view)`, `canPan(e)->bool` (default: pressing the host itself / a `<canvas>` / `[data-pan]` / the svg root pans; markers and tools do not), `minScale`/`maxScale` (default 0.5x .. 16x of the fit scale), `dblClickFit`, `fitBox` (box or fn), `keyboard:false` (ignore bus zoom/fit), `world:{w,h}`, `ignoreSelector`.
* API: `fit(box?, {animate, padding, silent})`, `zoomBy(f, cx?, cy?, {animate})`, `panBy(dx,dy)`, `setView({scale,tx,ty})`, `toWorld(clientX, clientY)->{x,y}` normalized, `toWorldPx`, `toScreen(p)` (host-relative px), `toClient(p)`, `setEnabled(bool)` (disable while a tool needs the drag), `resize()`, `subscribe(fn)->off`, `fitScale`, `size`, `panning`, `destroy()`.
* The first fit happens **silently** at construction (no `onChange` yet): draw once yourself. Later size changes re-fit (while the user has not moved the view) and notify. Interaction: drag on empty space, middle button, Space+drag, wheel/ctrl+wheel/pinch zoom around the cursor, two-finger touch, double-click empty space (if `dblClickFit`). A drag longer than 4 px swallows the click that follows it. `prefers-reduced-motion` turns the 170 ms tweens off.
* Add class `data-no-wheel` to scrollable overlays on the stage; markers should `stopPropagation()`/`preventDefault()` their own `pointerdown` (or `canPan` returns false for them).
* A press on a real control - `button, a[href], input, select, textarea, label, summary, [role=button], [role=menuitem]` or any child
  of a `.stage__slot` - never starts a pan, whatever `canPan` says (capturing the pointer there would retarget the click to the
  host: the editor's "Done" button did nothing with the Select tool active).

### 9.7 `WH.views`
```
WH.views.register('planner' | 'editor', { mount(root), show(), hide(), resize?(), exportPng?() -> Blob|Promise<Blob>|void, tourSteps?() -> steps[] })
WH.views.go(name, {updateHash=true}) / .current / .impl(name) / .isMounted(name)
```
`mount` runs once, lazily, when the view is first shown (root is visible then, so measuring works). `show()` on every activation, `hide()` when leaving. Hash routing: `#wifi` = planner, `#plan` = editor (Back/Forward work). `exportPng` is called by File -> "Save signal map as PNG": return a `Blob` and the shell downloads `<project>-mapa-signalu.png`; return nothing if you saved it yourself. `tourSteps()` is appended to the tour between "modes" and "estimate badge" (targets must exist while the view is shown; use `optional:true` for conditional ones).

### 9.8 `WH.io`  (engine is called lazily; a missing engine gives a friendly error)
`importFile(file, {fresh, asBackground}) -> Promise<{kind}>` (`kind`: `project | tracing_image | background | error | cancelled`; never rejects, shows the toast itself), `openPicker(opts) -> Promise<result|null>`, `saveProjectSvg()`, `exportPlanPng()`, `saveLocal(project)`, `loadLocal()`, `clearLocal()`, `rasterizeBackground(file|dataUrl) -> Promise<pngDataUrl>`, `sanitizeSvgText(text)`.
* The editor's "upload tracing background" button: `WH.io.openPicker({asBackground: true})` (keeps the plan, sets `plan.background`, undoable).
* Imports replace the project through `store.replace` (undoable, toast offers **Undo**), except on first run (`fresh`).
* Storage keys: `wifi-heatmap-v3` (project without background), `wifi-heatmap-v3-bg` (background data URL, rewritten only when it changes), `wifi-heatmap-v3-corrupt` (copy of unreadable data), `wifi-heatmap-prefs`. Legacy `wifi-floor-v5`, `wifi-floor-network-v1`, `wifi-speed-v1`, `wifi-flow-v1` are migrated once (and left untouched).
* Foreign SVGs are never rendered inline: a whitelisted copy is rasterised via `<img>` to a white-paper PNG (<= 1800 px wide, < 7 MB).

### 9.9 `WH.shell` / `WH.app`
`WH.shell.{boot, onReady(fn), openHelp({section?: 'theme'|'report'}), startTour, showWelcome, hideWelcome, openFileMenu, isWelcomeOpen(), autoBoot}`, `WH.app.{go, route, view}` + from `90-app`: `version`, `agentTools.{register, tools, coverageSnapshot, speedSnapshot}` (optional WebMCP tools, registered only when `document.modelContext.registerTool` exists) and a safety net that turns an unexpected error into one friendly toast with **Podrobnosti** (the console still gets the error). First run (no saved project): a demo project is put in the store (not saved) behind the welcome overlay; choosing a card initialises the real project and routes to Wi-Fi (demo), Floor plan (blank / traced image) or Wi-Fi (SVG project).

### 9.10 `WH.pwa` (src/js/20-ui/pwa.js)
`{ enabled /* http(s) */, supported /* service worker usable */, registration, updateReady, canInstall(), install(), applyUpdate(), checkForUpdate(), syncThemeColor() }`.
A waiting new version shows the toast "Je k dispozici nová verze aplikace. [Načíst]" (`pwa.update` / `pwa.reload`); Reload =
`SKIP_WAITING` to the worker, then one page reload. File menu shows "Nainstalovat jako aplikaci" only after the browser fired
`beforeinstallprompt`. `<meta name="theme-color">` (light `#ffffff` / Deep dark `#111113` / OLED `#000000` = the header surface) follows a chosen theme; auto keeps the per-scheme pair of the template. Offline state for
features that need the network (speed test): read `navigator.onLine` and listen to `online`/`offline`.

**Language at start** (`WH.i18n`, SPEC 6.2): saved pref > browser language cs/sk -> `cs` > the file default (`WH_DEFAULT_LANG`).
`WH.i18n.browserLang()` returns `'cs'|'en'|null`.

### 9.11 Stage 6: one-click measuring, device info, the Wi-Fi helper, the calibration guide (planner, SPEC 8 / 8.1 / 8.2 / 9)
Full signatures live in the file headers; the public pieces other modules use:
* `WH.devinfo` (36-devinfo, pure / Node-testable, see ENGINE-API §12): `parse(text)`, `fromObject(json)`, `fromHash('#wifi=…')`,
  `toHash(obj)`, `toWifi(connection)`, `COMMANDS` (the per-OS command lines). From 50-planner/27: `detect()` -> OS / device /
  browser / connection of this device (Client Hints + UA fallback), `parseUa(ua)`, `guessOs()`.
* `WH.planner.measureAll({point, band?, name?, value?, wifi?, source?, onStep?, consent?}, signal)` -> `{measurement|null,
  steps:[{key:'device'|'wifi'|'speed'|'save', state, info}], data, cancelled}`; `mallChecklist({onCancel, onHow, onLayout,
  noCancel})` (the live checklist element), `wifiLine(w, {signal, noBand})`, `wifiFound(w)`, `wifiDbm(w)`, `measSummary(m)`,
  `wifiPending.{get,set,clear}` (details waiting for the next measurement, 15 min).
* Helper client (only file allowed to `fetch()` the loopback helper besides 36-devinfo: `50-planner/26-*`):
  `helperStatus({timeout, signal, ask, onAsk})` -> `{connected, blocked?:'prompt'|'denied'}` (probe only on a user action;
  on an https page with the browser's Local Network Access permission still undecided it does not probe unless `ask`),
  `helperWifi(signal)`, `helperPermission()`. Chrome logs a refused loopback request ("net::ERR_CONNECTION_REFUSED") when no
  helper runs - page code cannot silence it; QA suites that press "Změřit vše" ignore exactly that line.
* `WH.planner.openDevInfo()` (drawer), `devInfoButton()`, `devInfoCard({onUse, onBack, onLayout})`, `cmdTips({all})` (Help).
* `WH.planner.calib.{open, close, isOpen, state, progress, entryButton({idle, before, ...button}), helpBlock(close), cta(),
  resultSection(), throughputSection(), homeData(), fitText(p), applyFit(), resetFit(), mapClick(w)}`; progress lives in the
  pref `planner.calib` (saved only when it changed). The guide's own panel shows "Bod N uložený · Zpět" (no toasts over it).
* `project.model.fit` (engine `fitProject`) is applied by the engine context only while `view.calibrate` is on: anything that
  flips `view.calibrate` must rebuild the context (`PL.S.geomDirty = true`; 20-stage's store listener does it).

### 9.12 Diagnostics (SPEC 10): `WH.diag`, `WH.ui.diag`, `WH.app.reportError`
* **`WH.diag`** (00-core/diag.js, pure, memory only): the last 20 errors of the page session -
  `record(err, {kind, where, context, notify})`, `caught(err, where)`, `list()` (newest first), `last()`, `get(id)`, `count()`,
  `clear()`, `subscribe(fn)`, `whereOf(stack)`, `cleanStack(stack)`, `scrub(text)`, `mapLine(line)`, `build {v, files}`.
  Record: `{id, t, kind: 'error'|'rejection'|'caught'|'reported', name, message, where, stack (<= 12 lines), context, count}`.
  Every text is scrubbed before it is kept: URLs -> file name only (a page from disk would name the user's folders), Windows /
  home paths, MAC/BSSID, SSIDs (`SSID : …` lines of command output incl. names with spaces, `ssid=…`, `"ssid":"…"`,
  free text `SSID "…"`), IPv4 (not 127.0.0.1), e-mails, data: URLs, and the user's own words found in the live
  project (measurement SSIDs/BSSIDs + pending Wi-Fi details, room / measurement / device / project names) -> `[…]`. Stack frames of
  the bundle are mapped to source files via `WH_BUILD.files` ("at save (50-planner/25-measure.js:123:15)").
  Framework try/catches feed it: bus / store / i18n / viewport / keys listeners, store mutators, view mount/show, widget callbacks
  (`caught` -> the friendly toast); io and shell handled failures record with `notify:false` (they show their own toast).
* **`WH.app.reportError(err, context, opts)`** (90-app) - for HANDLED but noteworthy errors in your module (a speed test that
  failed, a helper probe that timed out unexpectedly, a parse that threw, a save that failed): it keeps the error in the diary
  (`kind:'reported'`) WITHOUT the generic toast and logs it with `console.debug` (QA counts errors / warnings only).
  `opts.toast` (text or `{i18n, params}`) shows YOUR specific message with a **Podrobnosti** button (`opts.kind` 'error'|'warn',
  `opts.ms`); `opts.log` = 'debug' (default) | 'info' | 'warn' | 'error' | false; `opts.where` overrides the location. AbortError is
  ignored (returns null). Returns the record. Also `WH.app.showErrorDetails(id?)`, `WH.app.errors()`, `WH.app.diagnostics()`
  (summary text), `WH.app.copyDiagnostics()`.
  ```js
  try { await WH.speedtest.run(o, signal); }
  catch (e) { WH.app.reportError(e, 'measure.speedtest', { toast: { i18n: 'planner.m.speedFailed' } }); }
  ```
* **Safety net**: an uncaught error, unhandled rejection or a caught framework bug -> ONE friendly toast per 15 s ("Něco se
  nepovedlo…" + **Podrobnosti**); `ResizeObserver loop` noise and AbortError are ignored; a cross-origin "Script error." (a
  browser extension - all app code is inline, so it is never ours) goes to the diary only (`context:'foreign-script'`), no toast.
* **`WH.ui.diag`** (20-ui/diagnostics.js): `showDetails(id?)` - the "Co se pokazilo" dialog (Kdy / Kde / Co aplikace dělala /
  Zpráva, stack disclosure, **Zkopírovat podrobnosti**, **Nahlásit problém** -> Help); `helpBlock()` - Help -> "Nahlásit problém"
  (what the report contains and leaves out, error count, **Zkopírovat diagnostiku**, "Ukázat, co se zkopíruje" preview, GitHub
  issues link); `summary({first})` / `copy({first})` - app version + build, browser / OS / device, page kind (`file://` or
  scheme + host, never a path), mode, language, theme, window, touch, online, storage, the errors with stacks. **No plan data,
  measurements, SSIDs, BSSIDs, MACs or file paths.** Copy failure (no clipboard) selects the text for Ctrl+C.

## 10. Events (bus)

| topic | payload | when |
|---|---|---|
| `lang:changed` | `{lang}` | after `i18n.setLang` changed the language (DOM already re-translated) |
| `theme:changed` | `{theme, effective, resolved}` | theme menu / picker, or OS scheme change while `auto` |
| `view:changed` | `{name, prev}` | after a view became current |
| `app:ready` | `{firstRun}` | first view is on screen |
| `project:imported` | `{kind:'project'|'tracing_image'|'background', name, undoable}` | a file was imported. **Editor: on `tracing_image` activate the Rectangle tool.** |
| `project:created` | `{template:'demo'|'blank'}` | File menu "demo flat" / "new plan" (**editor: on `blank` start with the Rectangle tool**) |
| `viewport:zoom` / `viewport:fit` | `{factor}` / `{}` | global `+ - 0` keys; visible viewports react |
| `prefs:changed` | `{key, value}` | `store.setPref` |
| `tour:ended` | `{result}` | tour finished or skipped |
| `pwa:update` | `{version:'waiting'}` | a new app version is installed and waits (the update toast is shown) |
| `store:<topic>` | store payload | mirror of every store topic (debugging) |

## 11. Gotchas

* Wrap button groups in `.cluster` (wraps) rather than `.row` (does not wrap) inside cards, otherwise 320 px phones overflow.
* Do not nest a `<button>` in a `<button>`: put `data-hint` spans next to the card toggle, not inside it (`WH.ui.card` does that).
* Re-read `WH.store.project` and its slices after store events; never keep `const plan = project.plan` across commits/undo.
* Pointer handlers on markers: call `e.stopPropagation()` on `pointerdown` (or `preventDefault()`), use `setPointerCapture`, and wrap drags in `store.begin/live/end`.
* `WH.shell.startTour()` returns a promise that resolves when the tour ends - do not `await` it inside tests/evaluate.
* Do not use `localStorage` directly for anything but per-viewer conveniences; use `store.setPref`.
* Dialog/menu/popover z-order is handled; do not use `<dialog>` (it would hide the hint bubble in the top layer).
