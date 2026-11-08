import type { AreaElement, PageElement } from "../model/types";
import { areaBounds, isArea } from "../model/area";
import type { EraseFilter } from "./erase-filter";

/**
 * Erasing area highlighters (v23, #99). An area is highlighter ink: the whole-stroke and the segment eraser remove the WHOLE area as soon as
 * the eraser touches it (an area has no stroke to cut), the area eraser removes the areas whose centre is inside its outline, and the
 * selective eraser treats it as a highlighter of its colour. A locked area is never erased (the eraser skips locked elements). Pure geometry,
 * no 'obsidian'.
 */

/** May the eraser touch an area of this colour? (The selective eraser: "pen" spares highlighters.) */
export function areaMatchesFilter(color: string, filter: EraseFilter): boolean {
	switch (filter.kind) {
		case "all":
		case "highlighter":
			return true;
		case "pen":
			return false;
		case "color":
			return color.toLowerCase() === filter.color.toLowerCase();
	}
}

/** Distance from the point to the rectangle (0 inside it). */
function pointToRect(px: number, py: number, minX: number, minY: number, maxX: number, maxY: number): number {
	const dx = Math.max(minX - px, 0, px - maxX);
	const dy = Math.max(minY - py, 0, py - maxY);
	return Math.hypot(dx, dy);
}

/** Distance from the point to the segment a-b. */
function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const vx = bx - ax, vy = by - ay;
	const len2 = vx * vx + vy * vy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
	return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Whether the segment a-b crosses the rectangle (or lies inside it): Liang-Barsky clipping. */
function segmentCrossesRect(ax: number, ay: number, bx: number, by: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
	let t0 = 0, t1 = 1;
	const dx = bx - ax, dy = by - ay;
	const edges: Array<[number, number]> = [[-dx, ax - minX], [dx, maxX - ax], [-dy, ay - minY], [dy, maxY - ay]];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return false;
			continue;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) return false;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return false;
			if (r < t1) t1 = r;
		}
	}
	return true;
}

/**
 * The distance from the eraser's path a-b to the area (0 when it touches or crosses it). Disjoint convex shapes are closest at an end of the
 * path or at a corner of the rectangle, so those are all that is measured.
 */
export function eraserDistanceToArea(el: AreaElement, ax: number, ay: number, bx: number, by: number): number {
	const b = areaBounds(el);
	if (segmentCrossesRect(ax, ay, bx, by, b.minX, b.minY, b.maxX, b.maxY)) return 0;
	let d = Math.min(pointToRect(ax, ay, b.minX, b.minY, b.maxX, b.maxY), pointToRect(bx, by, b.minX, b.minY, b.maxX, b.maxY));
	for (const [cx, cy] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as const) d = Math.min(d, pointToSegment(cx, cy, ax, ay, bx, by));
	return d;
}

/**
 * The areas of `elements` that the eraser (radius `radius` pt, moving from (ax, ay) to (bx, by)) touches and the selective eraser allows, in
 * array order. Locked areas and the ones in `spare` (ids of elements that must be left alone) are never returned.
 */
export function areasUnderEraser(
	elements: readonly PageElement[], ax: number, ay: number, bx: number, by: number, radius: number, filter: EraseFilter, spare?: ReadonlySet<string>,
): AreaElement[] {
	const out: AreaElement[] = [];
	for (const el of elements) {
		if (!isArea(el) || el.locked === true || spare?.has(el.id) || !areaMatchesFilter(el.color, filter)) continue;
		if (eraserDistanceToArea(el, ax, ay, bx, by) <= radius) out.push(el);
	}
	return out;
}
