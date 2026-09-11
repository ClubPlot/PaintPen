# CLAUDE.md

## Rhino track file → hit regions

`track/track.3dm` is a Rhino model of a race track (an oval loop of straightaways
and turns). The gameplay-relevant part is the **`HIT_REGIONS`** layer, which
defines the areas a moving object can occupy on the track. We built a small
rhino3dm.js toolchain to extract those regions and verify them.

### The `HIT_REGIONS` layer

Every hit region is one closed curve, and is exactly one of two shapes:

- **Rectangle** — a closed `PolylineCurve` with 4 corners (the two straightaways).
- **Wedge band** — a closed `PolyCurve` made of two concentric arcs (inner +
  outer radius) joined by two radial line segments; i.e. an annular sector (the
  turns).

The current file has **5 regions**: 2 rectangles + 3 wedge bands, which chain
together into one closed track loop. All bands share the same radial thickness
(inner `1.3125` → outer `2.1875`, i.e. `0.875` wide), matching the `0.875`-wide
straightaways.

> Note: an earlier version of the layer also contained a `CHECKER` block instance
> (`InstanceReference`). The extractor warns on and skips anything that is not a
> rectangle or wedge band, so stray geometry on the layer is surfaced, not
> silently included.

### Test points

Two layers hold reference points for validating the regions:

- **`TEST_POINTS_HIT`** — points that must fall **inside** at least one region.
- **`TEST_POINTS_MISS`** — points that must fall **outside** every region.

### Scripts

Both are ES modules that use the `rhino3dm` npm package (WASM) to read the
`.3dm` directly — no Rhino install required.

- **`extract-hit-regions.mjs`** — reads `HIT_REGIONS` and emits concise JSON
  descriptions of each region. Exports `extractRegions(file)` for reuse and
  prints JSON when run directly.

  ```sh
  node extract-hit-regions.mjs [path/to/file.3dm]   # default: track/track.3dm
  ```

  Rectangle → `{ type, center, width, height, angleDeg, corners }`
  (`corners` is authoritative; `width`/`height` are edge lengths in corner order).
  Wedge band → `{ type, center, innerRadius, outerRadius, startAngleDeg, endAngleDeg, sweepDeg }`
  (angles in degrees, sweep is CCW from `startAngleDeg`).

  A generated snapshot lives at `track/hit-regions.json`.

- **`test-hit-regions.mjs`** — extracts the regions, reads the two point layers,
  and asserts every HIT point is inside a region and every MISS point is outside
  all of them. Prints failures with coordinates and sets a non-zero exit code on
  failure (CI-friendly).

  ```sh
  node test-hit-regions.mjs [path/to/file.3dm]
  ```

### Point-in-region logic (shared by the tests and any consumer)

- **Rectangle**: convex-quad test — the point must lie on the same side of all
  four edges (handles rotated rectangles, not just axis-aligned).
- **Wedge band**: distance from `center` must be within `[innerRadius, outerRadius]`,
  and the angle about `center` must fall within the CCW sweep from `startAngleDeg`.
