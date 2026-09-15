// Extract HIT_REGIONS geometry from a .3dm file into concise JSON descriptions,
// already converted to HP-GL plotter units and the plotter's coordinate system.
//
// Every hit region is an area, and is one of:
//   - a rectangle          (a closed PolylineCurve with 4 corners), or
//   - a concentric band of a wedge / annular sector
//                          (a closed PolyCurve of two arcs + two radial lines).
//
// HIT_REGIONS may still carry linework that is not an area — the start line is
// drawn on it as an open curve. Only areas are regions, so anything else is
// skipped with a warning.
//
// HIT_REGIONS is subdivided into sublayers (START, TRACK, FINISH) that say what
// each region *means*. Every region is tagged with the sublayer it came from as
// its `group`, and the regions are also indexed by group in `groups`. Sublayers
// may nest; a region's `group` is always the top-level sublayer under
// HIT_REGIONS, with the full path kept in `layer` when it sits deeper.
//
// Usage: node track/extract-hit-regions.mjs [path/to/file.3dm]   (or: yarn regions)

import rhino3dm from 'rhino3dm';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const LAYER = 'HIT_REGIONS';
// Where a car starts the lap: a single Point on its own top-level layer. It is
// a position rather than an area, so it lives outside HIT_REGIONS and comes
// back as its own field rather than as a region.
const START_POINT_LAYER = 'START_POINT';

// This script lives next to the model it reads, so paths are resolved against
// its own directory rather than the caller's — `yarn regions` works the same
// from anywhere. `sourceName` keeps the emitted `source` repo-relative, so the
// committed JSON does not record whose machine produced it.
export const TRACK_DIR = import.meta.dirname;
export const DEFAULT_MODEL = join(TRACK_DIR, 'track.3dm');
const sourceName = (file) => relative(join(TRACK_DIR, '..'), resolve(file));
const round = (n, d = 4) => +n.toFixed(d);
const TOL = 1e-3;

// ---- geometry helpers -------------------------------------------------------
const angleOf = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const deg = (r) => (r * 180) / Math.PI;
// normalize degrees to (-180, 180]
const norm180 = (d) => {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
};

// ---- model space -> plotter space -------------------------------------------
// The Rhino model is drawn in inches on a portrait Letter sheet: its `Page`
// layer is the rectangle (0,0)-(8.5,11), with Y up.
//
// The plotter's own units are 0.025 mm, 1016 to the inch. Viewing a plot the
// way you would normally hold it, the origin is at the lower left, X runs along
// the long axis of the paper and Y along the short one — so the addressable
// area is landscape, and on Letter ("A", 8.5 x 11 in) the hard-clip limits are
// 0-10300 by 0-7650 plotter units. (The plotter's *own* description in the
// manual has the origin at the upper-left with X running down the page; that is
// the same axes seen with the sheet as it lies in the carriage.)
//
// A portrait page therefore has to be turned a quarter turn to reach the paper.
// We rotate it 90 degrees counterclockwise — the direction HP-GL's own RO90
// would — and centre the sheet on the plotting range. The sheet is longer than
// the range in both directions, so its corners fall outside the hard-clip
// limits; everything on the HIT_REGIONS layer stays comfortably inside.
export const PLOTTER_UNITS_PER_INCH = 1016;

// Letter hard-clip limits, i.e. the maximum plotting range.
export const LETTER_PLOT_WIDTH = 10300;
export const LETTER_PLOT_HEIGHT = 7650;

// The modelled sheet, in inches, before rotation.
const PAGE_WIDTH_IN = 8.5;
const PAGE_HEIGHT_IN = 11;

// Rotating CCW puts the page in x = [-11, 0] in, y = [0, 8.5] in; these bring
// its centre onto the centre of the plotting range. Both are negative because
// the sheet overhangs the range it is centred on.
const OFFSET_X = (LETTER_PLOT_WIDTH - PAGE_HEIGHT_IN * PLOTTER_UNITS_PER_INCH) / 2;
const OFFSET_Y = (LETTER_PLOT_HEIGHT - PAGE_WIDTH_IN * PLOTTER_UNITS_PER_INCH) / 2;

const ROTATION_DEG = 90;

// A length in model inches, in plotter units. Distances survive a rotation
// untouched, so they only need the scale.
export const toPlotterLength = (inches) => Math.round(inches * PLOTTER_UNITS_PER_INCH);

// A model point [x, y] in inches, as a point in plotter units. One quarter turn
// CCW — (dx, dy) -> (-dy, dx) — then the centring offsets.
export const toPlotter = ([x, y]) => [
  Math.round((PAGE_HEIGHT_IN - y) * PLOTTER_UNITS_PER_INCH + OFFSET_X),
  Math.round(x * PLOTTER_UNITS_PER_INCH + OFFSET_Y),
];

// The transform is a rotation, not a reflection, so an angle just shifts and a
// CCW sweep stays CCW.
const toPlotterAngle = (degrees) => norm180(degrees + ROTATION_DEG);

const outsidePlotRange = ([x, y]) =>
  x < 0 || x > LETTER_PLOT_WIDTH || y < 0 || y > LETTER_PLOT_HEIGHT;

// The corners are the whole description. A centre, side lengths and an angle
// can all be derived from them, but emitting them too gave two descriptions of
// one rectangle that disagreed: each was rounded from model inches on its own,
// so the sides came out up to a unit off the corners they were meant to match.
// Deriving at the point of use keeps that impossible.
function describeRectangle(curve) {
  // closed polyline: last point repeats the first, so 4 unique corners
  const n = curve.pointCount;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const p = curve.point(k);
    pts.push([p[0], p[1]]);
  }
  return {
    type: 'rectangle',
    corners: pts.slice(0, n - 1).map(toPlotter), // drop the closing duplicate
  };
}

function describeWedgeBand(curve) {
  // gather the arc segments (there should be two, sharing a center)
  const arcs = [];
  for (let s = 0; s < curve.segmentCount; s++) {
    const seg = curve.segmentCurve(s);
    if (seg.constructor.name === 'ArcCurve') arcs.push(seg.arc());
  }
  if (arcs.length !== 2) return null;

  const center = arcs[0].center;
  // verify both arcs are concentric
  if (Math.hypot(arcs[1].center[0] - center[0], arcs[1].center[1] - center[1]) > TOL) {
    return null;
  }

  const radii = arcs.map((a) => a.radius).sort((a, b) => a - b);
  const innerRadius = radii[0];
  const outerRadius = radii[1];

  // boundary angles from an arc's endpoints; the sector spans CCW between them.
  const outer = arcs[0].radius >= arcs[1].radius ? arcs[0] : arcs[1];
  const a0 = deg(angleOf(outer.startPoint, center));
  const a1 = deg(angleOf(outer.endPoint, center));
  const sweep = outer.angleDegrees; // magnitude of the subtended angle

  // pick the start boundary so that a CCW travel of `sweep` lands on the other.
  const ccw = (from, to) => ((to - from) % 360 + 360) % 360;
  let startDeg;
  if (Math.abs(ccw(a0, a1) - sweep) < Math.abs(ccw(a1, a0) - sweep)) {
    startDeg = a0;
  } else {
    startDeg = a1;
  }
  const endDeg = startDeg + sweep; // CCW

  return {
    type: 'wedge_band',
    center: toPlotter([center[0], center[1]]),
    innerRadius: toPlotterLength(innerRadius),
    outerRadius: toPlotterLength(outerRadius),
    startAngleDeg: round(toPlotterAngle(startDeg)),
    endAngleDeg: round(toPlotterAngle(endDeg)),
    sweepDeg: round(sweep),
  };
}

// The points a region can reach, for the plotting-range check: a rectangle's
// corners, and for a wedge band the ends of its two arcs plus any cardinal
// direction its sweep passes through, where the outer arc touches an extreme.
function extremePoints(r) {
  if (r.type === 'rectangle') return r.corners;
  const at = (a, radius) => [
    r.center[0] + radius * Math.cos((a * Math.PI) / 180),
    r.center[1] + radius * Math.sin((a * Math.PI) / 180),
  ];
  const pts = [r.innerRadius, r.outerRadius].flatMap((radius) => [
    at(r.startAngleDeg, radius),
    at(r.endAngleDeg, radius),
  ]);
  for (const a of [0, 90, 180, 270]) {
    if (((a - r.startAngleDeg) % 360 + 360) % 360 <= r.sweepDeg) pts.push(at(a, r.outerRadius));
  }
  return pts;
}

// ---- layers -----------------------------------------------------------------
// Map every layer at or under HIT_REGIONS to how we label the regions on it:
//   group — the top-level sublayer under HIT_REGIONS (START / TRACK / FINISH),
//           or null for anything sitting directly on HIT_REGIONS itself.
//   path  — the sublayer path below HIT_REGIONS, e.g. "TRACK" or "TRACK/TURNS".
// Returns a Map keyed by layer index, so an object is labelled by a lookup.
function hitRegionLayers(doc, file) {
  const layers = doc.layers();
  const all = [];
  for (let i = 0; i < layers.count; i++) {
    const L = layers.get(i);
    all.push({ index: L.index, id: L.id, parent: L.parentLayerId, name: L.name });
  }

  const byId = new Map(all.map((L) => [L.id, L]));
  const named = all.filter((L) => L.name === LAYER);
  // Prefer a top-level HIT_REGIONS, so a sublayer of that name cannot shadow it.
  const root = named.find((L) => !byId.has(L.parent)) ?? named[0];
  if (!root) throw new Error(`Layer "${LAYER}" not found in ${file}`);

  const labels = new Map([[root.index, { group: null, path: '' }]]);

  // Walk each layer up to the root, collecting the names in between. The depth
  // guard is only there so a corrupt file with a parent cycle cannot hang us.
  for (const L of all) {
    const chain = [];
    let cur = L;
    for (let depth = 0; cur && cur.id !== root.id && depth < all.length; depth++) {
      chain.unshift(cur.name);
      cur = byId.get(cur.parent);
    }
    if (!cur || cur.id !== root.id || chain.length === 0) continue; // not under HIT_REGIONS
    labels.set(L.index, { group: chain[0], path: chain.join('/') });
  }
  return labels;
}

// ---- start point ------------------------------------------------------------
// The one Point on START_POINT, in plotter units, or null if the model has
// none. Whether it lands inside a hit region is not checked here — that is a
// question about the regions, and the hit-test lives in test-hit-regions.mjs.
function extractStartPoint(doc, warnings) {
  const layers = doc.layers();
  const onLayer = new Set();
  for (let i = 0; i < layers.count; i++) {
    const L = layers.get(i);
    if (L.name === START_POINT_LAYER) onLayer.add(L.index);
  }
  if (onLayer.size === 0) {
    warnings.push(`no "${START_POINT_LAYER}" layer — startPoint is null`);
    return null;
  }

  const objs = doc.objects();
  const found = [];
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i);
    if (!onLayer.has(o.attributes().layerIndex)) continue;
    const geo = o.geometry();
    if (geo.constructor.name !== 'Point') {
      warnings.push(
        `object #${i} on ${START_POINT_LAYER}: expected a Point, ` +
          `got ${geo.constructor.name} — skipped`,
      );
      continue;
    }
    found.push(toPlotter(geo.location));
  }

  if (found.length === 0) {
    warnings.push(`no Point on "${START_POINT_LAYER}" — startPoint is null`);
    return null;
  }
  if (found.length > 1) {
    warnings.push(`${found.length} points on ${START_POINT_LAYER} — using the first`);
  }
  const point = found[0];
  if (outsidePlotRange(point)) {
    warnings.push(
      `${START_POINT_LAYER} at (${point}) is outside the ` +
        `${LETTER_PLOT_WIDTH} x ${LETTER_PLOT_HEIGHT} Letter plotting range`,
    );
  }
  return point;
}

// ---- extraction -------------------------------------------------------------
// Returns { source, layer, units, paper, plotRange, startPoint, count, summary,
// groups, regions, warnings } for a .3dm file, all geometry in plotter units.
// Each region carries the `group` (sublayer) it was found on.
export async function extractRegions(file) {
  const rhino = await rhino3dm();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(readFileSync(file)));

  const labels = hitRegionLayers(doc, file);

  const objs = doc.objects();
  const regions = [];
  const warnings = [];

  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i);
    const label = labels.get(o.attributes().layerIndex);
    if (!label) continue;

    const geo = o.geometry();
    const kind = geo.constructor.name;
    let region = null;

    if (kind === 'PolylineCurve' && geo.isClosed) {
      region = describeRectangle(geo);
    } else if (kind === 'PolyCurve' && geo.isClosed) {
      region = describeWedgeBand(geo);
    }

    const where = label.path ? `${LAYER}/${label.path}` : LAYER;
    if (!region) {
      warnings.push(
        `object #${i} on ${where}: ${kind} is not an area ` +
          `(not a rectangle or wedge band) — skipped`,
      );
      continue;
    }

    // Label first, so `group` leads each region in the emitted JSON.
    regions.push({
      group: label.group,
      ...(label.path && label.path !== label.group ? { layer: label.path } : {}),
      ...region,
    });
    if (extremePoints(region).some(outsidePlotRange)) {
      warnings.push(
        `object #${i} on ${where}: ${region.type} reaches outside the ` +
          `${LETTER_PLOT_WIDTH} x ${LETTER_PLOT_HEIGHT} Letter plotting range`,
      );
    }
  }

  // Region indices per group, in the order they were found.
  const groups = {};
  regions.forEach((r, i) => {
    const key = r.group ?? LAYER;
    (groups[key] ??= []).push(i);
  });

  const countOf = (type) => regions.filter((r) => r.type === type).length;

  return {
    source: sourceName(file),
    layer: LAYER,
    // Already converted: see "model space -> plotter space" above.
    units: `plotter units (0.025 mm, ${PLOTTER_UNITS_PER_INCH}/in)`,
    paper: 'letter',
    plotRange: [LETTER_PLOT_WIDTH, LETTER_PLOT_HEIGHT],
    startPoint: extractStartPoint(doc, warnings),
    count: regions.length,
    summary: {
      rectangles: countOf('rectangle'),
      wedge_bands: countOf('wedge_band'),
    },
    groups,
    regions,
    warnings,
  };
}

// ---- CLI --------------------------------------------------------------------
// Run the extraction and print JSON only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await extractRegions(process.argv[2] ?? DEFAULT_MODEL);
  for (const w of out.warnings) console.error('WARN ' + w);
  const { warnings, ...json } = out;
  console.log(JSON.stringify(json, null, 2));
}
