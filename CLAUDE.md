# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`Paint Pen` is a browser app that drives a vintage **HP-GL pen plotter** (HP 7475A / 7550
class) live over a WebSocket bridge. There is no backend in this repo — the app talks to a
socket-to-serial bridge on the plotter host (`DEFAULT_URL` points at a Tailscale address,
`ws://plotpi…:8181`). The app is a single page:

- **`index.html` → `src/main.ts`** — a Microsoft Paint-style drawing surface that emits HP-GL.

## Commands

```sh
yarn dev              # Vite dev server
yarn build            # tsc type-check (noEmit) + vite build — this is also the "lint"
yarn preview          # serve the production build
yarn deploy           # rsync dist/ to the plotter host
```

There is no separate linter and no test suite. `tsc` (via `yarn build`) is the type/lint gate;
its config is strict (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`).

## Architecture

### `src/plot.ts` — the protocol + transport layer (start here)

Everything device-specific lives here:

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

### `src/main.ts` — the page shell

Renders the connection bar, the raw-command console and the log, owns the `Connection`, and
mounts the paint surface via `mountPaint(host, port)` — the port supplies `send` / `note` /
`isLive`.

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
- The `quiet` flag on `send` keeps per-frame freehand batches out of the log.
