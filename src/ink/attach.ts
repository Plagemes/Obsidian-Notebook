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

/** Whether (x, y) is on the element: the rotated rectangle of an image, the laid-out box of a text. */
export function pointOnElement(el: PageElement, x: number, y: number, measure: MeasureText = estimateMeasure): boolean {
	if (el.type === "image") return inImage(el, x, y);
	const b = textElementBounds(el, measure);
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
	const sb = strokeBounds(stroke);
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
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
	if (moving.length === 0 || elements.length === 0) return [];
	const movingSet = new Set(moving);
	const boxes = boxesOf(elements, measure);
	// Only strokes that touch a moving element can belong to it.
	const movingBoxes = moving.map((e) => boxes.get(e) ?? elementBounds(e, measure));
	const out: Stroke[] = [];
	for (const stroke of strokes) {
		if (exclude.has(stroke)) continue;
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
