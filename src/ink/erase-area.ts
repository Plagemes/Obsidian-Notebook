import { createId, quantizePoint } from "../model/document";
import { Batch, RemoveElement, ReplaceStroke, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import type { Page, Point, Stroke } from "../model/types";
import { elementsInLasso, type MeasureText } from "./elements";
import { filterErasable, type EraseFilter } from "./erase-filter";
import { strokeBounds, type BBox } from "./hit-test";
import { pointInPolygon, type Polygon } from "./lasso";
import { densify } from "./segment-erase";
import { estimateMeasure } from "./text-layout";

/** Points are inserted so no segment is longer than this (pt): the cut then follows the outline closely. */
const CUT_STEP = 2;
/** Bisection steps to find where a segment crosses the outline (2 pt / 2^10 resolution). */
const BISECT = 10;

function polygonBounds(poly: Polygon): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of poly) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

function overlaps(a: BBox, b: BBox): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** The point on p→q where it crosses the outline (p and q are on different sides), on the outside of the outline. */
function crossing(p: Point, q: Point, poly: Polygon): Point {
	const pInside = pointInPolygon(p[0], p[1], poly);
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < BISECT; i++) {
		const mid = (lo + hi) / 2;
		const inside = pointInPolygon(p[0] + (q[0] - p[0]) * mid, p[1] + (q[1] - p[1]) * mid, poly);
		if (inside === pInside) lo = mid;
		else hi = mid;
	}
	const k = pInside ? hi : lo;
	return quantizePoint(p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k);
}

/**
 * Erase area on one stroke: the parts of the stroke inside the outline disappear, the parts outside
 * stay. Returns null when no point of the stroke is inside the outline (nothing to do), otherwise
 * the runs of points that survive (an empty array when the stroke was entirely inside). Runs shorter
 * than 2 points are dropped, as in the segment eraser. For render-2 strokes the points inserted
 * lie on the curve the ink geometry draws.
 */
export function cutOutsidePolygon(stroke: Stroke, poly: Polygon): Point[][] | null {
	if (poly.length < 3 || stroke.points.length === 0) return null;
	if (!overlaps(strokeBounds(stroke), polygonBounds(poly))) return null;
	const dense = densify(stroke.points, CUT_STEP, stroke.render === 2);
	const runs: Point[][] = [];
	let run: Point[] = [];
	let touched = false;
	let prev: Point | null = null;
	let prevInside = false;
	for (const p of dense) {
		const inside = pointInPolygon(p[0], p[1], poly);
		if (inside) touched = true;
		if (prev && inside !== prevInside) {
			// The outline lies between the two points: end or start a run exactly on it.
			const edge = crossing(prev, p, poly);
			if (inside) {
				run.push(edge);
				if (run.length) runs.push(run);
				run = [];
			} else {
				run = [edge];
			}
		}
		if (!inside) run.push(p);
		prev = p;
		prevInside = inside;
	}
	if (run.length) runs.push(run);
	if (!touched) return null;
	const minLength = stroke.points.length === 1 ? 1 : 2;
	return runs.filter((r) => r.length >= minLength);
}

export interface EraseAreaOptions {
	/** Only these strokes may be erased (selective eraser). */
	filter: EraseFilter;
	/** Also remove the text boxes and images whose centre is inside the outline (only with the filter `all`). */
	includeElements: boolean;
	measure?: MeasureText;
	/** Called for every new piece of a cut stroke; defaults to a fresh id. */
	newId?: () => string;
	/** v8: strokes the eraser must leave alone (hidden ink while the solutions are not shown). */
	skip?: (stroke: Stroke) => boolean;
}

/**
 * One undoable step that erases everything inside `poly` on `page`, or null when nothing is inside.
 * Strokes crossing the outline are cut (the outside part stays, with a new id); the commands go in
 * descending stroke index so undo puts every stroke back exactly where it was.
 */
export function eraseAreaCommand(page: Pick<Page, "id" | "strokes" | "elements">, poly: Polygon, options: EraseAreaOptions): Command | null {
	if (poly.length < 3) return null;
	const newId = options.newId ?? createId;
	const erasable = new Set(filterErasable(page.strokes, options.filter));
	const edits: Array<{ stroke: Stroke; index: number; after: Stroke[] }> = [];
	page.strokes.forEach((stroke, index) => {
		if (!erasable.has(stroke) || options.skip?.(stroke)) return;
		const runs = cutOutsidePolygon(stroke, poly);
		if (runs === null) return;
		edits.push({ stroke, index, after: runs.map((points) => freezeStroke({ ...stroke, id: newId(), points })) });
	});
	edits.sort((a, b) => b.index - a.index);
	const commands: Command[] = edits.map((e) => new ReplaceStroke(page.id, e.stroke, e.after, e.index));
	if (options.includeElements && options.filter.kind === "all") {
		for (const el of elementsInLasso(page.elements ?? [], poly, options.measure ?? estimateMeasure)) {
			commands.push(new RemoveElement(page.id, el));
		}
	}
	return commands.length > 0 ? new Batch("Erase area", commands) : null;
}
