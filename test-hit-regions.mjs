// Test the extracted HIT_REGIONS against known points.
//
// Points on TEST_POINTS_HIT  must fall INSIDE at least one region.
// Points on TEST_POINTS_MISS must fall OUTSIDE every region.
//
// Usage: node test-hit-regions.mjs [path/to/file.3dm]

import rhino3dm from 'rhino3dm';
import { readFileSync } from 'node:fs';
import { extractRegions } from './extract-hit-regions.mjs';

const FILE = process.argv[2] ?? 'track/track.3dm';
const HIT_LAYER = 'TEST_POINTS_HIT';
const MISS_LAYER = 'TEST_POINTS_MISS';
const TOL = 1e-6; // points sit on the same construction grid as the regions

// ---- point-in-region tests --------------------------------------------------
// Convex-quad test: the point must lie on the same side of all four edges.
function inRectangle(p, r) {
  const c = r.corners;
  let sign = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < TOL) continue; // on the edge
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function inWedgeBand(p, r) {
  const dx = p[0] - r.center[0];
  const dy = p[1] - r.center[1];
  const rad = Math.hypot(dx, dy);
  if (rad < r.innerRadius - TOL || rad > r.outerRadius + TOL) return false;

  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  // is `ang` within the CCW sweep starting at startAngleDeg?
  const rel = (((ang - r.startAngleDeg) % 360) + 360) % 360;
  return rel <= r.sweepDeg + TOL || rel >= 360 - TOL;
}

const inside = (p, r) => (r.type === 'rectangle' ? inRectangle(p, r) : inWedgeBand(p, r));

// which regions (by index) contain this point?
function hittingRegions(p, regions) {
  const hits = [];
  regions.forEach((r, i) => {
    if (inside(p, r)) hits.push(i);
  });
  return hits;
}

// ---- read the test points ---------------------------------------------------
async function readPoints(file, layerNames) {
  const rhino = await rhino3dm();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(readFileSync(file)));
  const layers = doc.layers();
  const idxToName = {};
  const wanted = {};
  for (let i = 0; i < layers.count; i++) {
    const L = layers.get(i);
    idxToName[L.index] = L.name;
    if (layerNames.includes(L.name)) wanted[L.name] = [];
  }
  const objs = doc.objects();
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i);
    const g = o.geometry();
    if (g.constructor.name !== 'Point') continue;
    const layer = idxToName[o.attributes().layerIndex];
    if (wanted[layer]) wanted[layer].push(g.location);
  }
  return wanted;
}

// ---- run --------------------------------------------------------------------
const { regions, warnings } = await extractRegions(FILE);
for (const w of warnings) console.error('WARN ' + w);
console.log(`Loaded ${regions.length} hit regions from ${FILE}\n`);

const pts = await readPoints(FILE, [HIT_LAYER, MISS_LAYER]);
const fmt = (p) => `(${p[0].toFixed(3)}, ${p[1].toFixed(3)})`;

let failures = 0;

// HIT points must be inside some region.
const hitPts = pts[HIT_LAYER] ?? [];
console.log(`${HIT_LAYER}: ${hitPts.length} points (expect INSIDE)`);
for (const p of hitPts) {
  const hits = hittingRegions(p, regions);
  if (hits.length === 0) {
    failures++;
    console.log(`  FAIL ${fmt(p)} — hit nothing`);
  }
}

// MISS points must be outside every region.
const missPts = pts[MISS_LAYER] ?? [];
console.log(`${MISS_LAYER}: ${missPts.length} points (expect OUTSIDE)`);
for (const p of missPts) {
  const hits = hittingRegions(p, regions);
  if (hits.length > 0) {
    failures++;
    console.log(`  FAIL ${fmt(p)} — inside region(s) ${hits.join(', ')}`);
  }
}

// ---- summary ----------------------------------------------------------------
const total = hitPts.length + missPts.length;
console.log(`\n${'='.repeat(40)}`);
if (failures === 0) {
  console.log(`PASS — all ${total} points classified correctly`);
} else {
  console.log(`FAIL — ${failures} of ${total} points misclassified`);
  process.exitCode = 1;
}
