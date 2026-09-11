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

node test-hit-regions.mjs      # the only automated test; validates track hit regions
node extract-hit-regions.mjs   # regenerate track/hit-regions.json from the .3dm
```

There is no separate linter or test runner. `tsc` (via `yarn build`) is the type/lint gate;
its config is strict (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`). The only
runtime test is `test-hit-regions.mjs`, run directly with `node`.

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

`track/track.3dm` is a Rhino model of an oval race track. The **`HIT_REGIONS`** layer defines
the areas an object can occupy; every region is one closed curve of exactly one of two shapes:

- **Rectangle** — a closed `PolylineCurve` with 4 corners (the straightaways).
- **Wedge band** — a closed `PolyCurve` of two concentric arcs (inner + outer radius) joined by
  two radial lines, i.e. an annular sector (the turns).

The current file holds 5 regions (2 rectangles + 3 wedge bands) that chain into one closed
loop; all bands share a `0.875`-wide radial thickness matching the straightaways.

- **`extract-hit-regions.mjs`** reads the layer via `rhino3dm.js` (WASM, no Rhino install) and
  emits concise JSON. It exports `extractRegions(file)` for reuse and prints JSON when run
  directly; it warns on and skips any geometry that is not a rectangle or wedge band. Snapshot:
  `track/hit-regions.json`.
  - rectangle → `{ type, center, width, height, angleDeg, corners }` (`corners` is authoritative)
  - wedge band → `{ type, center, innerRadius, outerRadius, startAngleDeg, endAngleDeg, sweepDeg }`
    (angles in degrees, sweep is CCW from `startAngleDeg`)
- **`test-hit-regions.mjs`** asserts every point on `TEST_POINTS_HIT` falls inside a region and
  every point on `TEST_POINTS_MISS` falls outside all of them (non-zero exit on failure). The
  hit-test logic: convex-quad side test for rectangles; radius-in-`[inner,outer]` plus
  CCW-sweep angle test for wedge bands.

`track/pdf2hpgl.sh` is an unrelated utility that converts PDF/PS/EPS linework to HP-GL
(ghostscript → pstoedit → affine fit/rotate/pen transform).
