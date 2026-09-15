
import track from "../track/hit-regions.json";
import type { Point as XY } from "./plot"

type Point = [x: number, y: number];

// `layer` is present only on a region sitting deeper than its top-level group.
type WedgeBand = {
    group: string,
    layer?: string,
    type: "wedge_band",
    center: Point,
    innerRadius: number,
    outerRadius: number,
    startAngleDeg: number,
    endAngleDeg: number,
    sweepDeg: number
};

// The corners are the whole description — the extractor emits no centre, side
// lengths or angle, so anything of that sort is derived from these.
type Rectangle = {
    group: string,
    layer?: string,
    type: "rectangle",
    corners: Array<Point>
};

type Region = Rectangle | WedgeBand;

const startRegions = track.regions.filter((region) => region.group === 'START') as Array<Region>;
const trackRegions = track.regions.filter((region) => region.group === 'TRACK') as Array<Region>;
const finishRegions = track.regions.filter((region) => region.group === 'FINISH') as Array<Region>;


// Regions and points are both whole plotter units, so a point on a boundary can
// land up to one unit (0.025 mm) to either side of it.
const TOL = 1;

function inRectangle(p: Point, r: Region): boolean {
    if (r.type == "rectangle") {
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
    } else {
        return false;
    }
}

function inWedgeBand(p: Point, r: Region): boolean {
    if (r.type === "wedge_band") {
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
    else {
        return false;
    }
}

function inRegions(p: Point, regions: Array<Region>): boolean {
    return regions.some(region => inRectangle(p, region) || inWedgeBand(p, region));
}

export function startPoint(): XY {
    const [x, y] = track.startPoint as Point;
    return { x, y };
}

export function onTrack({ x, y }: XY): boolean {
    return inRegions([x, y], trackRegions);
}

export function finished({ x, y }: XY): boolean {
    return inRegions([x, y], finishRegions);
}

export function starting({ x, y }: Point): boolean {
    return inRegions([x, y], startRegions);
}
