// Extract HIT_REGIONS geometry from a .3dm file into concise JSON descriptions,
// already converted to HP-GL plotter units and the plotter's coordinate system.
//
// Every hit region is either:
//   - a rectangle          (a closed PolylineCurve with 4 corners), or
//   - a concentric band of a wedge / annular sector
//                          (a closed PolyCurve of two arcs + two radial lines).
//
// Usage: node extract-hit-regions.mjs [path/to/file.3dm]

import rhino3dm from 'rhino3dm';
import { readFileSync } from 'node:fs';

const LAYER = 'HIT_REGIONS';
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

function describeRectangle(curve) {
  // closed polyline: last point repeats the first, so 4 unique corners
  const n = curve.pointCount;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const p = curve.point(k);
    pts.push([p[0], p[1]]);
  }
  const corners = pts.slice(0, n - 1); // drop the closing duplicate
  const cx = corners.reduce((s, p) => s + p[0], 0) / corners.length;
  const cy = corners.reduce((s, p) => s + p[1], 0) / corners.length;
  // width = length of edge 0->1, height = length of edge 1->2
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const w = dist(corners[0], corners[1]);
  const h = dist(corners[1], corners[2]);
  const angle = deg(Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]));
  return {
    type: 'rectangle',
    center: toPlotter([cx, cy]),
    width: toPlotterLength(w),
    height: toPlotterLength(h),
    angleDeg: round(toPlotterAngle(angle)),
    corners: corners.map(toPlotter),
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

// ---- extraction -------------------------------------------------------------
// Returns { source, layer, units, paper, plotRange, count, summary, regions,
// warnings } for a .3dm file, with all geometry in plotter units.
export async function extractRegions(file) {
  const rhino = await rhino3dm();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(readFileSync(file)));

  const layers = doc.layers();
  let layerIndex = -1;
  for (let i = 0; i < layers.count; i++) {
    if (layers.get(i).name === LAYER) layerIndex = layers.get(i).index;
  }
  if (layerIndex === -1) throw new Error(`Layer "${LAYER}" not found in ${file}`);

  const objs = doc.objects();
  const regions = [];
  const warnings = [];

  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i);
    if (o.attributes().layerIndex !== layerIndex) continue;

    const geo = o.geometry();
    const kind = geo.constructor.name;
    let region = null;

    if (kind === 'PolylineCurve' && geo.isClosed) {
      region = describeRectangle(geo);
    } else if (kind === 'PolyCurve' && geo.isClosed) {
      region = describeWedgeBand(geo);
    }

    if (!region) {
      warnings.push(`object #${i}: unrecognized ${kind} (not a rectangle or wedge band) — skipped`);
      continue;
    }

    regions.push(region);
    if (extremePoints(region).some(outsidePlotRange)) {
      warnings.push(
        `object #${i}: ${region.type} reaches outside the ` +
          `${LETTER_PLOT_WIDTH} x ${LETTER_PLOT_HEIGHT} Letter plotting range`,
      );
    }
  }

  return {
    source: file,
    layer: LAYER,
    // Already converted: see "model space -> plotter space" above.
    units: `plotter units (0.025 mm, ${PLOTTER_UNITS_PER_INCH}/in)`,
    paper: 'letter',
    plotRange: [LETTER_PLOT_WIDTH, LETTER_PLOT_HEIGHT],
    count: regions.length,
    summary: {
      rectangles: regions.filter((r) => r.type === 'rectangle').length,
      wedge_bands: regions.filter((r) => r.type === 'wedge_band').length,
    },
    regions,
    warnings,
  };
}

// ---- CLI --------------------------------------------------------------------
// Run the extraction and print JSON only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await extractRegions(process.argv[2] ?? 'track/track.3dm');
  for (const w of out.warnings) console.error('WARN ' + w);
  const { warnings, ...json } = out;
  console.log(JSON.stringify(json, null, 2));
}
