// Extract HIT_REGIONS geometry from a .3dm file into concise JSON descriptions.
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
    center: [round(cx), round(cy)],
    width: round(w),
    height: round(h),
    angleDeg: round(norm180(angle)),
    corners: corners.map((p) => [round(p[0]), round(p[1])]),
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
    center: [round(center[0]), round(center[1])],
    innerRadius: round(innerRadius),
    outerRadius: round(outerRadius),
    startAngleDeg: round(norm180(startDeg)),
    endAngleDeg: round(norm180(endDeg)),
    sweepDeg: round(sweep),
  };
}

// ---- extraction -------------------------------------------------------------
// Returns { source, layer, count, summary, regions, warnings } for a .3dm file.
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

    if (region) regions.push(region);
    else warnings.push(`object #${i}: unrecognized ${kind} (not a rectangle or wedge band) — skipped`);
  }

  return {
    source: file,
    layer: LAYER,
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
