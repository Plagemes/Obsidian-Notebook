import { Batch, removeStrokes } from "../model/history";
import type { ImageElement, PageElement, Stroke } from "../model/types";
import { elementBounds } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { estimateMeasure, textElementBounds, type MeasureText } from "./text-layout";

/**
 * Ink attached to objects (roadmap 149), geometric and without any stored link: a stroke belongs to the
 * topmost element under which at least `ATTACH_SHARE` of its points lie. Moving, scaling or rotating that
 * element transforms those strokes with it; deleting the element offers to delete them too. Pure: the view
 * decides when to ask and which setting applies.
 *
 * v8 markers and structured boxes never own ink: they annotate a region of the page, they are not a surface the ink
 * is written on, so moving or deleting one leaves the ink it frames where it is (see `ownsInk`).
 */

/** Share of a stroke's points that must lie inside an element for the stroke to belong to it. */
export const ATTACH_SHARE = 0.6;

function inImage(el: ImageElement, x: number, y: number): boolean {
	const dx = x - (el.x + el.width / 2);
	const dy = y - (el.y + el.height / 2);
	const cos = Math.cos(-el.rotation);
	const sin = Math.sin(-el.rotation);
	const lx = dx * cos - dy * sin;
	const ly = dx * sin + dy * cos;
	return Math.abs(lx) <= el.width / 2 && Math.abs(ly) <= el.height / 2;
}

function overlap(a: BBox, b: BBox): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Whether ink can belong to the element: texts and images (and v10 excerpts), and v9 equations and graphs (ink written on a graph keeps
 * its graph coordinates, ink/graph-ink.ts); v8 markers and boxes only frame the page.
 */
export function ownsInk(el: PageElement): boolean {
	return el.type === "text" || el.type === "image" || el.type === "equation" || el.type === "graph" || el.type === "excerpt";
}

/**
 * v9: ink bound to a graph. When panning or zooming a graph moves the ink on it, the moved strokes get the id
 * `<graph id>~<new id>`: from then on they belong to that graph whatever their position (a zoom may carry them outside
 * the frame, where they are clipped away, and a later zoom brings them back). No format change: an id is any string.
 * Copies give strokes new ids, so a copied graph falls back to the geometric rule.
 */
export const BOUND_SEPARATOR = "~";

/** The id of the graph a stroke is bound to, or null. */
export function boundGraphId(stroke: Stroke): string | null {
	const at = stroke.id.indexOf(BOUND_SEPARATOR);
	return at > 0 ? stroke.id.slice(0, at) : null;
}

/** Whether `stroke` is bound to `el` (a graph). */
export function boundTo(stroke: Stroke, el: PageElement): boolean {
	return el.type === "graph" && boundGraphId(stroke) === el.id;
}

/** Frames of the graphs of a page by id (null when it has none): bound ink is drawn clipped to its graph's frame. */
export function graphClips(elements: readonly PageElement[] | undefined): Map<string, { x: number; y: number; width: number; height: number }> | null {
	let out: Map<string, { x: number; y: number; width: number; height: number }> | null = null;
	for (const el of elements ?? []) {
		if (el.type !== "graph") continue;
		out ??= new Map();
		out.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height });
	}
	return out;
}

/** The frame a stroke is clipped to (its graph is on the page), or null. */
export function strokeClip(stroke: Stroke, clips: ReturnType<typeof graphClips>): { x: number; y: number; width: number; height: number } | null {
	if (!clips) return null;
	const id = boundGraphId(stroke);
	return id === null ? null : clips.get(id) ?? null;
}

/** Whether (x, y) is on the element: the rotated rectangle of an image, the laid-out box of a text. */
export function pointOnElement(el: PageElement, x: number, y: number, measure: MeasureText = estimateMeasure): boolean {
	if (el.type === "image") return inImage(el, x, y);
	const b = el.type === "text" ? textElementBounds(el, measure) : elementBounds(el, measure);
	return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

/** Share (0–1) of the stroke's points that lie on the element. */
export function shareOnElement(stroke: Stroke, el: PageElement, measure: MeasureText = estimateMeasure): number {
	if (stroke.points.length === 0) return 0;
	let inside = 0;
	for (const [x, y] of stroke.points) if (pointOnElement(el, x, y, measure)) inside++;
	return inside / stroke.points.length;
}

/** The element the stroke is written on: the topmost (last drawn) one that holds at least `share` of its points. */
export function inkOwner(
	stroke: Stroke, elements: readonly PageElement[], measure: MeasureText = estimateMeasure, share = ATTACH_SHARE,
	boxes?: ReadonlyMap<PageElement, BBox>,
): PageElement | null {
	// Bound ink belongs to its graph wherever it is (see BOUND_SEPARATOR).
	const graphId = boundGraphId(stroke);
	if (graphId !== null) {
		const g = elements.find((e) => e.type === "graph" && e.id === graphId);
		if (g) return g;
	}
	const sb = strokeBounds(stroke);
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (!ownsInk(el)) continue;
		const eb = boxes?.get(el) ?? elementBounds(el, measure);
		if (!overlap(sb, eb)) continue;
		if (shareOnElement(stroke, el, measure) >= share) return el;
	}
	return null;
}

function boxesOf(elements: readonly PageElement[], measure: MeasureText): Map<PageElement, BBox> {
	return new Map(elements.map((e) => [e, elementBounds(e, measure)]));
}

/**
 * Strokes that move with `moving` (elements being transformed): those owned by one of them, except the ones in
 * `exclude` (already part of the transformed selection). `elements` is every element of the page, so that a stroke
 * written on an element that stays put is left alone even when a moving element overlaps it from below.
 */
export function attachedInk(
	strokes: readonly Stroke[], elements: readonly PageElement[], moving: readonly PageElement[],
	exclude: ReadonlySet<Stroke> = new Set(), measure: MeasureText = estimateMeasure, share = ATTACH_SHARE,
): Stroke[] {
	const owners = moving.filter(ownsInk);
	if (owners.length === 0 || elements.length === 0) return [];
	const movingSet = new Set(owners);
	const boxes = boxesOf(elements, measure);
	// Only strokes that touch a moving element can belong to it.
	const movingBoxes = owners.map((e) => boxes.get(e) ?? elementBounds(e, measure));
	const out: Stroke[] = [];
	for (const stroke of strokes) {
		if (exclude.has(stroke)) continue;
		const bound = boundGraphId(stroke);
		if (bound !== null && owners.some((e) => e.type === "graph" && e.id === bound)) {
			out.push(stroke);
			continue;
		}
		const sb = strokeBounds(stroke);
		if (!movingBoxes.some((b) => overlap(sb, b))) continue;
		const owner = inkOwner(stroke, elements, measure, share, boxes);
		if (owner && movingSet.has(owner)) out.push(stroke);
	}
	return out;
}

/** Strokes written on the `removed` elements (what is left when they are deleted), to offer deleting them too. */
export function inkOnRemoved(
	strokes: readonly Stroke[], elementsBefore: readonly PageElement[], removed: readonly PageElement[],
	exclude: ReadonlySet<Stroke> = new Set(), measure: MeasureText = estimateMeasure, share = ATTACH_SHARE,
): Stroke[] {
	return attachedInk(strokes, elementsBefore, removed, exclude, measure, share);
}

/** One undo step that deletes `strokes` from the page; null when none of them is on it any more. */
export function deleteInkCommand(pageId: string, pageStrokes: readonly Stroke[], strokes: readonly Stroke[]): Batch | null {
	return removeStrokes(pageId, pageStrokes, strokes, "Delete ink on deleted object");
}
