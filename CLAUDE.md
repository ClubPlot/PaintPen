# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`interplot` is a browser app that drives a vintage **HP-GL pen plotter** (HP 7475A / 7550
class) live over a WebSocket bridge. There is no backend in this repo — the app talks to a
socket-to-serial bridge on the plotter host (`DEFAULT_URL` points at a Tailscale address,
`ws://plotpi…:8181`). Two independent front-ends share the protocol layer:

- **`index.html` → `src/main.ts`** — a Microsoft Paint-style drawing surface that emits HP-GL.
- **`gamepad.html` → `src/gamepad.ts`** — drive the pen directly with a game controller.

The `track/` directory is a separate concern: a Rhino model and tooling for a race-track game
(see the last section).

## Commands

```sh
yarn dev              # Vite dev server (both pages)
yarn build            # tsc type-check (noEmit) + vite build — this is also the "lint"
yarn preview          # serve the production build

yarn test             # the only automated test; classifies random points against the
                      # track hit regions and draws track/hit-regions-test.svg
yarn regions          # print the extracted hit regions as JSON
yarn regions:update   # regenerate the track/hit-regions.json snapshot
```

The track tooling lives in `track/` alongside the model it reads, and both scripts resolve
their default paths against their own directory — so they behave the same however they are
invoked, whether through yarn or as `node track/<script>.mjs` from anywhere.

There is no separate linter or test runner. `tsc` (via `yarn build`) is the type/lint gate;
its config is strict (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`). The only
runtime test is `track/test-hit-regions.mjs`, wired up as `yarn test`.

## Architecture

Vite is configured for a **multi-page build** (`vite.config.ts` lists `index.html` and
`gamepad.html` as separate inputs). The two pages do not share state — only the modules below.

### `src/plot.ts` — the protocol + transport layer (start here)

Everything device-specific lives here and is imported by both front-ends:

- **`HPGL`** and **`DSC`** — command builders. `HPGL` is plain HP-GL (`PU`/`PD`/`PA`/`SP`/`LB`…,
  each terminated with `;`); `DSC` is the ESC-prefixed device-control set. Labels (`LB`) read
  raw bytes until an ETX terminator, so control characters are stripped before sending.
- **Unit system** — the plot area is `PLOT_WIDTH × PLOT_HEIGHT` = `10000 × 7500` plotter units
  (1 unit = 0.025 mm, so `PLOTTER_UNITS_PER_CM = 400`); a 4:3 area. **HP-GL's origin is
  lower-left**, not top-left — coordinate conversions must account for this.
- **`PENS` / `DEFAULT_PEN`** — the physical pen carousel. `DEFAULT_PEN = 3` is an index into
  `PENS`, one less than its `SP` number (slots 1–3 are out of service on the machine, so
  drawing starts on `SP4;`).
- **`createConnection(url)`** returns a `Connection`: a thin WebSocket wrapper exposing
  `ready()` / `read()` / `write()` / `close()`. Incoming messages are buffered through a
  `ReadableStream`; consumers `pump()` it in a loop until close.

### `src/paint.ts` — the drawing UI (large, self-contained)

An MS-Paint clone on a fixed **640 × 480** canvas (same 4:3 shape as the plot area).
Key ideas that span the file:

- **Coordinate flow**: everything is kept in canvas pixels and converted to plotter units only
  on the way out (`CM_PER_PIXEL`). The plotter's ~1 KB input buffer means polylines are chunked
  into short instructions (`MAX_PAIRS_PER_MESSAGE`), and freehand samples closer than
  `MIN_SEND_DISTANCE` are dropped.
- **Tools**: the 16-tool toolbox mirrors real MS Paint, but only tools with an honest HP-GL
  equivalent (pencil, line, rect, ellipse, text) actually plot; the rest are drawn but inert,
  each with a `why` explaining what the plotter cannot reproduce.
- **Text** mirrors the plotter's stick-font geometry (fixed-pitch, `SI` sizes in cm, 1.5× char
  advance, 2× line advance) so the on-screen box stands where the ink will land.
- Mounted via `mountPaint(host, port)` where `port` supplies `send`/`note`/`isLive` from
  `main.ts`; the `quiet` flag on `send` keeps per-frame freehand batches out of the log.

### `src/gamepad.ts` — controller-driven plotting

Polls the Gamepad API at frame rate (`requestAnimationFrame`) and turns stick input into
relative pen moves (`PR`). Notable: velocity magnitude maps to plotter speed (`VS`, capped at
`MAX_SPEED_CM_S = 38.1` for a 7475A), a `DEADZONE` guards against divide-by-zero on a centred
stick, and `plotToEnd` does a slab/ray-clip against the plotter window bounds (`OW`) so a move
stops at the paper edge. This file is the most experimental / in-flux part of the codebase.

## Track / Rhino hit regions (`track/`)

`track/track.3dm` is a Rhino model of a race track. The **`HIT_REGIONS`** layer defines the
areas an object can occupy; every region is one curve of exactly one of three shapes:

- **Rectangle** — a closed `PolylineCurve` with 4 corners (the straightaways).
- **Wedge band** — a closed `PolyCurve` of two concentric arcs (inner + outer radius) joined by
  two radial lines, i.e. an annular sector (the turns). The turns are reflex — the model's arcs
  subtend 221° and 263°, not 180°.
- **Line** — an open `LineCurve`: a gate to cross rather than an area (the start line).

`HIT_REGIONS` is divided into **sublayers that say what each region means** — currently
`START`, `TRACK` and `FINISH`. Every extracted region is tagged with its sublayer as `group`,
and `groups` maps each sublayer to its region indices. Sublayers may nest: `group` is always
the *top-level* sublayer, and a region deeper than that also carries the full path in `layer`.

The current file holds 8 regions — `TRACK` has the closed loop (2 rectangles + 3 wedge bands),
`START` a square plus the start line on its boundary with the loop, and `FINISH` a square. All
bands share a `0.875`-wide radial thickness matching the straightaways.

Separately, the top-level **`START_POINT`** layer holds a single `Point`: where a car begins the
lap. It is a position rather than an area, so it sits outside `HIT_REGIONS` and comes back as
its own `startPoint` field rather than as a region.

**The model is in inches on a portrait Letter sheet** — its `Page` layer is exactly
`(0,0)-(8.5,11)` — but nothing downstream sees those units. `extract-hit-regions.mjs` converts
everything on the way out: 1016 plotter units to the inch, then a 90° CCW rotation (what HP-GL's
own `RO90` does) to reach the plotter's landscape orientation, then a translation centring the
sheet on the Letter hard-clip limits of `10300 × 7650` plotter units. Note that is the real
Letter plotting range, *not* the 4:3 `PLOT_WIDTH × PLOT_HEIGHT` the paint page draws inside.
The sheet is bigger than the range, so its corners fall outside; every hit region lands inside
with ~260 units to spare. `toPlotter` / `toPlotterLength` and the limits are exported so
anything else in the pipeline converts the same way.

- **`track/extract-hit-regions.mjs`** (`yarn regions`) reads the layer via `rhino3dm.js` (WASM, no Rhino install) and
  emits concise JSON **in plotter units**. It exports `extractRegions(file)` for reuse and prints
  JSON when run directly; it warns on and skips any geometry that is not a rectangle or wedge
  band, and warns (without skipping) on a region reaching outside the plotting range. Snapshot:
  `track/hit-regions.json`.
  `startPoint` is the `START_POINT` layer's point in plotter units, or `null` with a warning if
  the layer is missing, holds no `Point`, or holds something else; extra points warn and the
  first wins. Whether it lands inside a region is checked by the test, not here.
  Each region leads with `group` (its sublayer), then:
  - rectangle → `{ type, center, width, height, angleDeg, corners }` (`corners` is authoritative)
  - wedge band → `{ type, center, innerRadius, outerRadius, startAngleDeg, endAngleDeg, sweepDeg }`
    (angles in degrees, sweep is CCW from `startAngleDeg`)
  - line → `{ type, from, to, length }` (endpoint order is the one drawn, so it gives a direction)
- **`track/test-hit-regions.mjs`** (`yarn test`) scatters random points over the whole plotting range, classifies
  each by the group of the region containing it (`START` / `TRACK` / `FINISH`, or off track),
  and renders regions + classified points to **`track/hit-regions-test.svg`** to be checked by
  eye. The model's old `TEST_POINTS_*` layers are gone, so there are no fixtures to compare
  against; instead the run fails if any point lands in two *different* groups (the groups would
  overlap, making the answer ambiguous), if no area regions were found at all, or if the
  `startPoint` exists but falls outside every region. The start point is drawn as a crosshair
  and its group reported (currently `START`). Points come from a seeded PRNG, so a given seed
  always draws the same picture.
  Flags: `--points=N` `--seed=S` `--out=file.svg`.
  The hit-test logic: convex-quad side test for rectangles; radius-in-`[inner,outer]` plus
  CCW-sweep angle test for wedge bands. `line` regions are gates, not areas, so they sit out the
  test. Tolerance is one plotter unit, since the extractor rounds to whole units.
  Sanity check: at `--points=400000` the measured group shares match the regions' analytic areas
  (TRACK 33.07% vs 33.04%, START/FINISH ~0.99% vs 1.003%).

`track/pdf2hpgl.sh` is an unrelated utility that converts PDF/PS/EPS linework to HP-GL
(ghostscript → pstoedit → affine fit/rotate/pen transform).
