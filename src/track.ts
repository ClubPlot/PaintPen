import type { Point } from "./plot"

export function startPoint(): Point {
     return {x: 469,y: 948}
}

export function onTrack(pos: Point): boolean {
    return true
}

export function finished(pos: Point): boolean {
    return true
}
