// Test the extracted HIT_REGIONS by classifying random points, and draw the
// result so it can be checked by eye.
//
// The model no longer carries TEST_POINTS_* layers. Instead we scatter points
// across the whole plotting range and ask which region — if any — contains
// each one, then render the regions and the classified points to an SVG:
//
//   START   the starting square      TRACK   the racing loop
//   FINISH  the finishing square     (none)  off track
//
// The regions come out of the extractor already in plotter units, so the
// points are generated in plotter units too and nothing needs converting.
//
// Usage: node track/test-hit-regions.mjs [file.3dm] [--points=N] [--seed=S] [--out=f.svg]
//        (or: yarn test)

import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  extractRegions,
  DEFAULT_MODEL,
  TRACK_DIR,
  LETTER_PLOT_WIDTH,
  LETTER_PLOT_HEIGHT,
} from './extract-hit-regions.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
// Paths default to this script's own directory, so the run does not depend on
// where it was invoked from. Names are reported repo-relative, which keeps the
// caption in the committed SVG the same on every machine.
const FILE = argv.find((a) => !a.startsWith('--')) ?? DEFAULT_MODEL;
const POINTS = Number(flag('points', 4000));
const SEED = Number(flag('seed', 12345));
const OUT = flag('out', join(TRACK_DIR, 'hit-regions-test.svg'));
const name = (f) => relative(join(TRACK_DIR, '..'), resolve(f));

// Regions and points are both whole plotter units, so a point on a boundary
// can land up to one unit (0.025 mm) to either side of it.
const TOL = 1;
const OFF = '(none)';

// ---- point-in-region tests --------------------------------------------------
// Convex-quad test: the point must lie on the same side of all four edges.
function inRectangle(p, r) {
  const c = r.corners;
  let sign = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    // the cross product over the edge length is the distance to that edge
    if (Math.abs(cross) / Math.hypot(b[0] - a[0], b[1] - a[1]) < TOL) continue; // on the edge
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
  // TOL is a distance, so the slack at a radial edge is the angle it
  // subtends at the point's own radius — a flat degree of it would be 39
  // units out at the outer radius and a fraction of one at the inner.
  const angTol = ((TOL / rad) * 180) / Math.PI;
  return rel <= r.sweepDeg + angTol || rel >= 360 - angTol;
}

const inside = (p, r) => (r.type === 'rectangle' ? inRectangle(p, r) : inWedgeBand(p, r));

// which regions (by index) contain this point? Indices are into the full
// region list, so they match the extractor's output and its `groups` map.
function hittingRegions(p, regions) {
  const hits = [];
  regions.forEach((r, i) => {
    if (inside(p, r)) hits.push(i);
  });
  return hits;
}

// ---- random points ----------------------------------------------------------
// mulberry32: a seeded PRNG, so a given seed always draws the same picture.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- classify ---------------------------------------------------------------
const { regions, groups, startPoint, warnings } = await extractRegions(FILE);
for (const w of warnings) console.error('WARN ' + w);

console.log(`Loaded ${regions.length} hit regions from ${name(FILE)}`);
for (const [group, idx] of Object.entries(groups)) {
  console.log(`  ${group}: ${idx.map((i) => regions[i].type).join(', ')}`);
}

const rand = rng(SEED);
const classified = [];
const tally = { START: 0, TRACK: 0, FINISH: 0, [OFF]: 0 };
// A point inside regions of two *different* groups has no single answer, which
// would mean the groups overlap — collect those as failures.
const ambiguous = [];

for (let i = 0; i < POINTS; i++) {
  const p = [Math.round(rand() * LETTER_PLOT_WIDTH), Math.round(rand() * LETTER_PLOT_HEIGHT)];
  const hitGroups = [...new Set(hittingRegions(p, regions).map((h) => regions[h].group))];
  const group = hitGroups.length === 0 ? OFF : hitGroups[0];
  if (hitGroups.length > 1) ambiguous.push({ p, hitGroups });
  tally[group] = (tally[group] ?? 0) + 1;
  classified.push({ p, group });
}

// The start point is a position, not a region, so it is not part of the random
// sample — but it should sit inside one, and which group tells us it is sane.
const startGroup = startPoint
  ? (hittingRegions(startPoint, regions).map((i) => regions[i].group)[0] ?? OFF)
  : null;
console.log(
  startPoint
    ? `  start point (${startPoint}) — ${startGroup}`
    : '  start point — none in the model',
);

console.log(`\n${POINTS} random points (seed ${SEED}):`);
for (const [group, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${group.padEnd(8)} ${String(n).padStart(5)}  ${((n / POINTS) * 100).toFixed(1)}%`);
}

// ---- render -----------------------------------------------------------------
const COLORS = { TRACK: '#2f6fd0', START: '#1f9d55', FINISH: '#d2323c', [OFF]: '#bdbdbd' };

const polar = (c, r, deg) => [
  c[0] + r * Math.cos((deg * Math.PI) / 180),
  c[1] + r * Math.sin((deg * Math.PI) / 180),
];
const n2 = (v) => Math.round(v * 100) / 100;

// Region outlines, in plotter coordinates — the <g> below flips Y, so these are
// written the way the plotter sees them: origin lower-left, Y up.
function regionShape(r) {
  const fill = COLORS[r.group] ?? '#888';
  const skin = `fill="${fill}" fill-opacity="0.15" stroke="${fill}" stroke-width="14"`;
  if (r.type === 'rectangle') {
    return `<polygon points="${r.corners.map((c) => `${c[0]},${c[1]}`).join(' ')}" ${skin}/>`;
  }
  // endAngleDeg is normalized to (-180,180], so walk the sweep from the start.
  const end = r.startAngleDeg + r.sweepDeg;
  const [ox, oy] = polar(r.center, r.outerRadius, r.startAngleDeg);
  const [ex, ey] = polar(r.center, r.outerRadius, end);
  const [ix, iy] = polar(r.center, r.innerRadius, end);
  const [sx, sy] = polar(r.center, r.innerRadius, r.startAngleDeg);
  // Inside the flipped group the axes are the plotter's, so sweep-flag 1 is CCW.
  const big = r.sweepDeg > 180 ? 1 : 0;
  const d =
    `M ${n2(ox)},${n2(oy)} A ${r.outerRadius},${r.outerRadius} 0 ${big} 1 ${n2(ex)},${n2(ey)} ` +
    `L ${n2(ix)},${n2(iy)} A ${r.innerRadius},${r.innerRadius} 0 ${big} 0 ${n2(sx)},${n2(sy)} Z`;
  return `<path d="${d}" ${skin}/>`;
}

// Off-track points are the majority; draw them first, smaller and paler, so the
// regions and their hits stay legible on top.
const order = [OFF, 'TRACK', 'START', 'FINISH'];
const dots = classified
  .slice()
  .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
  .map(({ p, group }) => {
    const off = group === OFF;
    return `<circle cx="${p[0]}" cy="${p[1]}" r="${off ? 17 : 26}" fill="${COLORS[group]}" fill-opacity="${off ? 0.55 : 0.95}"/>`;
  })
  .join('\n');

// The legend sits outside the flipped group, so its text is not mirrored. It
// gets an opaque panel because the track runs underneath it in this corner.
const legend =
  `<rect x="8900" y="170" width="1290" height="870" rx="60" fill="#fff" fill-opacity="0.93" stroke="#ddd" stroke-width="14"/>\n` +
  order
    .map((group, i) => {
      const y = 320 + i * 200;
      const name = group === OFF ? 'off track' : group.toLowerCase();
      return (
        `<circle cx="9040" cy="${y}" r="54" fill="${COLORS[group]}"/>` +
        `<text x="9140" y="${y + 40}" font-size="115" fill="#222">${name} — ${tally[group] ?? 0}</text>`
      );
    })
    .join('\n');

// The start point gets a crosshair rather than a dot, so it cannot be mistaken
// for one of the sampled points. Its caption goes outside the flipped group.
const startMark = startPoint
  ? `<g stroke="#111" stroke-width="28" fill="none">` +
    `<circle cx="${startPoint[0]}" cy="${startPoint[1]}" r="165"/>` +
    `<line x1="${startPoint[0] - 250}" y1="${startPoint[1]}" x2="${startPoint[0] + 250}" y2="${startPoint[1]}"/>` +
    `<line x1="${startPoint[0]}" y1="${startPoint[1] - 250}" x2="${startPoint[0]}" y2="${startPoint[1] + 250}"/>` +
    `</g><circle cx="${startPoint[0]}" cy="${startPoint[1]}" r="60" fill="#111"/>`
  : '';
const startLabel = startPoint
  ? `<text x="${startPoint[0] + 300}" y="${LETTER_PLOT_HEIGHT - startPoint[1] + 40}" font-size="110" fill="#111">start point</text>`
  : '';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LETTER_PLOT_WIDTH} ${LETTER_PLOT_HEIGHT}" width="${LETTER_PLOT_WIDTH / 10}" height="${LETTER_PLOT_HEIGHT / 10}" font-family="sans-serif">
<rect x="0" y="0" width="${LETTER_PLOT_WIDTH}" height="${LETTER_PLOT_HEIGHT}" fill="#fdfdfb" stroke="#ccc" stroke-width="18"/>
<!-- HP-GL's origin is lower-left with Y up; SVG's is upper-left with Y down. -->
<g transform="translate(0,${LETTER_PLOT_HEIGHT}) scale(1,-1)">
${regions.map(regionShape).join('\n')}
${dots}
${startMark}
</g>
${startLabel}
${legend}
<text x="150" y="${LETTER_PLOT_HEIGHT - 130}" font-size="115" fill="#555">${name(FILE)} — ${POINTS} points, seed ${SEED}</text>
</svg>
`;

writeFileSync(OUT, svg);
console.log(`\nWrote ${name(OUT)}`);

// ---- summary ----------------------------------------------------------------
// With no regions there is nothing to classify and every point trivially lands
// off track, so say so and fail rather than report a green run on nothing.
console.log(`\n${'='.repeat(40)}`);
if (regions.length === 0) {
  console.log('FAIL — no regions found on HIT_REGIONS; nothing to test against');
  process.exitCode = 1;
} else if (startPoint && startGroup === OFF) {
  console.log(`FAIL — start point (${startPoint}) lies outside every hit region`);
  process.exitCode = 1;
} else if (ambiguous.length > 0) {
  console.log(`FAIL — ${ambiguous.length} point(s) fell into more than one group:`);
  for (const { p, hitGroups } of ambiguous.slice(0, 10)) {
    console.log(`  (${p[0]}, ${p[1]}) — ${hitGroups.join(' + ')}`);
  }
  process.exitCode = 1;
} else {
  const start = startPoint ? `start point in ${startGroup}` : 'no start point';
  console.log(`PASS — ${POINTS} points classified, no group overlaps, ${start}`);
}
