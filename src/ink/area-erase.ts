import type { AreaElement, NotebookDocument, PageElement } from "../model/types";
import { RemoveElement, type Command } from "../model/history";
import { areaBounds, isArea } from "../model/area";
import type { EraseFilter } from "./erase-filter";

/**
 * Erasing area highlighters (v23, #99). An area is highlighter ink: the whole-stroke and the segment eraser remove the WHOLE area when
 * the eraser touches it and the gesture removed no ink (`AreaEraseGesture`; an area has no stroke to cut), the area eraser removes the areas whose centre is inside its outline, and the
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

/**
 * One whole-stroke or segment eraser gesture and the areas under it (review fix, #99). An area has no stroke to cut, so the eraser would take
 * all of it as soon as it touched it, also when the user only meant to rub out a letter written on top. The rule: an area goes only when the
 * gesture has removed no ink (the user is erasing the highlight itself), or when the selective eraser is set to "highlighter". An area taken
 * before the gesture reached ink is put back the moment ink is hit, so the step that is recorded at the end never holds both. The commands are
 * pushed on the gesture's own list, in the order they were applied.
 */
export class AreaEraseGesture {
	private removed: RemoveElement[] = [];
	private ink = false;

	constructor(private readonly commands: Command[]) {}

	/** May the areas under the eraser be taken now? */
	allowed(filter: EraseFilter): boolean {
		return filter.kind === "highlighter" || !this.ink;
	}

	/** Ink was removed or cut in this gesture: the areas taken so far are put back (not under the "highlighter" filter). True when any came back. */
	inkErased(doc: NotebookDocument, filter: EraseFilter): boolean {
		this.ink = true;
		if (filter.kind === "highlighter" || this.removed.length === 0) return false;
		for (let i = this.removed.length - 1; i >= 0; i--) {
			const cmd = this.removed[i]!;
			cmd.revert(doc);
			const at = this.commands.indexOf(cmd);
			if (at >= 0) this.commands.splice(at, 1);
		}
		this.removed = [];
		return true;
	}

	/** Takes the areas under the eraser if the rule allows it. True when any went. */
	eraseAreas(doc: NotebookDocument, pageId: string, areas: readonly AreaElement[], filter: EraseFilter): boolean {
		if (areas.length === 0 || !this.allowed(filter)) return false;
		for (const el of areas) {
			const cmd = new RemoveElement(pageId, el);
			cmd.apply(doc);
			this.commands.push(cmd);
			this.removed.push(cmd);
		}
		return true;
	}
}
