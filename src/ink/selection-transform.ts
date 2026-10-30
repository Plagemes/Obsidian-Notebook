import { Batch, ReplaceElement, ReplaceStroke, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import type { Page, PageElement, Stroke } from "../model/types";
import { attachedInk, boundGraphId, inkOwner } from "./attach";
import { elementBounds, transformElement, type MeasureText } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { transformStroke } from "./lasso";
import { estimateMeasure } from "./text-layout";
import { apply, IDENTITY, isIdentity, multiply, scaleAbout, translate, type Matrix } from "./transform";

/**
 * Exact transformations of a selection (roadmap 38, 65): align and distribute, rotate by 90 degrees, mirror, exact size.
 * Pure. Every one of them is a matrix (or a matrix per item) applied to the vector points in page coordinates; pressure
 * and everything else of the stroke are kept (`transformStroke`). The undoable command is one `Batch` (`applyPlacement`),
 * so each operation is one undo step. No format change: strokes and elements are replaced by transformed copies, as a
 * drag does.
 */

/** Which matrix moves each stroke and element. Items that are not in a map stay where they are. */
export interface Placement {
	strokes: Map<Stroke, Matrix>;
	elements: Map<PageElement, Matrix>;
}

export function emptyPlacement(): Placement {
	return { strokes: new Map(), elements: new Map() };
}

export interface PlacementPlan {
	command: Batch;
	/** The selected strokes and elements after the change (same order as the selection). */
	strokes: Stroke[];
	elements: PageElement[];
}

/** Union of the bounds of strokes and elements; null when both are empty. */
export function itemsBounds(strokes: readonly Stroke[], elements: readonly PageElement[], measure: MeasureText = estimateMeasure): BBox | null {
	const boxes = [...strokes.map(strokeBounds), ...elements.map((e) => elementBounds(e, measure))];
	if (boxes.length === 0) return null;
	return boxes.reduce((a, b) => ({
		minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
	}));
}

/**
 * The command that applies `placement` to `page` as one undo step, and the new objects to keep selected. Strokes and
 * elements that are no longer on the page, and identity matrices, are skipped. Null when nothing would change.
 */
export function applyPlacement(
	page: Page, selStrokes: readonly Stroke[], selElements: readonly PageElement[], placement: Placement,
	measure: MeasureText = estimateMeasure, label = "Transform selection",
): PlacementPlan | null {
	const commands: Command[] = [];
	const onPage = new Set(page.strokes);
	const onPageEls = new Set(page.elements ?? []);
	const strokeAfter = new Map<Stroke, Stroke>();
	for (const [s, m] of placement.strokes) {
		if (!onPage.has(s) || isIdentity(m)) continue;
		const next = freezeStroke(transformStroke(s, m));
		strokeAfter.set(s, next);
		commands.push(new ReplaceStroke(page.id, s, [next], page.strokes.indexOf(s)));
	}
	const elementAfter = new Map<PageElement, PageElement>();
	for (const [e, m] of placement.elements) {
		if (!onPageEls.has(e) || isIdentity(m)) continue;
		const next = transformElement(e, m, measure);
		elementAfter.set(e, next);
		commands.push(new ReplaceElement(page.id, e, next));
	}
	if (commands.length === 0) return null;
	return {
		command: new Batch(label, commands),
		strokes: selStrokes.filter((s) => onPage.has(s)).map((s) => strokeAfter.get(s) ?? s),
		elements: selElements.filter((e) => onPageEls.has(e)).map((e) => elementAfter.get(e) ?? e),
	};
}

/** Every stroke and element of a selection under one matrix (followers: unselected ink that moves with the objects). */
export function uniformPlacement(strokes: readonly Stroke[], elements: readonly PageElement[], followers: readonly Stroke[], m: Matrix): Placement {
	const p = emptyPlacement();
	for (const s of strokes) p.strokes.set(s, m);
	for (const s of followers) p.strokes.set(s, m);
	for (const e of elements) p.elements.set(e, m);
	return p;
}

// --- ink written on objects ---

/** Who owns which ink (setting "Ink follows objects"): the strokes written on the selected objects and the object each one belongs to. */
export interface InkOwnership {
	owner: ReadonlyMap<Stroke, PageElement>;
	/** The owned strokes that are not selected themselves: they move with their object. */
	followers: Stroke[];
}

export const NO_OWNERSHIP: InkOwnership = { owner: new Map(), followers: [] };

export function inkOwnership(
	page: Page, selStrokes: readonly Stroke[], selElements: readonly PageElement[], measure: MeasureText = estimateMeasure,
	/** Setting "Ink follows objects". Off: only ink bound to a selected graph (`<graph id>~…`) still belongs to it, as its id says. */
	follow = true,
): InkOwnership {
	const elements = page.elements ?? [];
	if (selElements.length === 0 || elements.length === 0) return NO_OWNERSHIP;
	const graphs = selElements.filter((e) => e.type === "graph");
	const owned = follow
		? attachedInk(page.strokes, elements, selElements, new Set(), measure)
		: graphs.length > 0 ? attachedInk(page.strokes, elements, graphs, new Set(), measure).filter((s) => boundGraphId(s) !== null) : [];
	const selected = new Set(selStrokes);
	const owner = new Map<Stroke, PageElement>();
	const followers: Stroke[] = [];
	for (const s of owned) {
		const el = inkOwner(s, elements, measure);
		if (!el) continue;
		owner.set(s, el);
		if (!selected.has(s)) followers.push(s);
	}
	return { owner, followers };
}

// --- rotate by 90 degrees ---

/** Rotation by a quarter turn about the centre of `b`, clockwise or anticlockwise as seen on the page (exact matrices, no rounding). */
export function rotate90Matrix(b: BBox, clockwise: boolean): Matrix {
	const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
	return clockwise ? [0, 1, -1, 0, cx + cy, cy - cx] : [0, -1, 1, 0, cx - cy, cx + cy];
}

/** Elements that have no rotated form in the format (no rotation field): a rotation moves their centre and keeps their orientation. */
export function rotationKeepsOrientation(el: PageElement): boolean {
	return el.type === "text" || el.type === "equation" || el.type === "graph";
}

/**
 * Turns the selection a quarter turn about the centre of `bounds`. Pictures, boxes and markers turn with it; text boxes,
 * equations and graphs only move their centre to where it would go (they keep their size and orientation, so a graph's
 * viewport still fits its frame), and ink written on them moves with them by the same translation instead of turning.
 */
export function rotatePlacement(
	strokes: readonly Stroke[], elements: readonly PageElement[], bounds: BBox, clockwise: boolean, ownership: InkOwnership = NO_OWNERSHIP,
	measure: MeasureText = estimateMeasure,
): Placement {
	const m = rotate90Matrix(bounds, clockwise);
	const p = emptyPlacement();
	const moves = new Map<PageElement, Matrix>();
	for (const e of elements) {
		if (!rotationKeepsOrientation(e)) {
			p.elements.set(e, m);
			continue;
		}
		const b = elementBounds(e, measure);
		const [cx, cy] = apply(m, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
		const t = translate(cx - (b.minX + b.maxX) / 2, cy - (b.minY + b.maxY) / 2);
		moves.set(e, t);
		p.elements.set(e, t);
	}
	for (const s of [...strokes, ...ownership.followers]) {
		const owner = ownership.owner.get(s);
		p.strokes.set(s, (owner && moves.get(owner)) ?? m);
	}
	return p;
}

// --- mirror ---

export type MirrorAxis = "horizontal" | "vertical";

/** The kinds of element that have no mirrored form in the format (no flip field): they are moved to the mirrored place, not flipped. */
export function mirrorKeepsOrientation(el: PageElement): boolean {
	return el.type === "image" || el.type === "text" || el.type === "equation" || el.type === "graph";
}

/**
 * Mirrors the selection about its own centre line: "horizontal" swaps left and right (a flip about the vertical axis),
 * "vertical" swaps top and bottom. Ink is flipped; elements are moved to the mirrored position. Ink written on an
 * object follows the object (translated with it), so a picture and its annotations stay together.
 */
export function mirrorPlacement(
	strokes: readonly Stroke[], elements: readonly PageElement[], bounds: BBox, axis: MirrorAxis, ownership: InkOwnership = NO_OWNERSHIP,
	measure: MeasureText = estimateMeasure,
): Placement {
	const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
	const flip: Matrix = axis === "horizontal" ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy];
	const p = emptyPlacement();
	const moves = new Map<PageElement, Matrix>();
	for (const e of elements) {
		const b = elementBounds(e, measure);
		const dx = axis === "horizontal" ? 2 * cx - (b.minX + b.maxX) : 0;
		const dy = axis === "vertical" ? 2 * cy - (b.minY + b.maxY) : 0;
		const m = translate(dx, dy);
		moves.set(e, m);
		p.elements.set(e, m);
	}
	for (const s of strokes) {
		const owner = ownership.owner.get(s);
		p.strokes.set(s, (owner && mirrorKeepsOrientation(owner) ? moves.get(owner) : undefined) ?? flip);
	}
	for (const s of ownership.followers) {
		const owner = ownership.owner.get(s);
		p.strokes.set(s, (owner && moves.get(owner)) ?? IDENTITY);
	}
	return p;
}

// --- exact size ---

/** Smallest and largest factor applied along one axis in one go (the drag handle uses the same limits). */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 20;
/** The size of a selection stops here (pt): far more than any page, and keeps the numbers finite. */
export const MAX_SIDE = 20000;

const clampScale = (k: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));

/**
 * The matrix that gives the selection the size `width` x `height` (pt, stroke thickness included), keeping its top-left
 * corner. Stroke thickness scales with the transform, so the first guess is corrected up to three times against the real
 * result; text boxes and equations scale in proportion only, so the other side may differ for them. Null for a size that
 * is not a positive finite number, or a selection without extent.
 */
export function sizeMatrix(
	strokes: readonly Stroke[], elements: readonly PageElement[], width: number, height: number, measure: MeasureText = estimateMeasure,
): Matrix | null {
	if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
	const b = itemsBounds(strokes, elements, measure);
	if (!b) return null;
	const w0 = b.maxX - b.minX, h0 = b.maxY - b.minY;
	if (!(w0 > 0) || !(h0 > 0)) return null;
	const w = Math.min(MAX_SIDE, width), h = Math.min(MAX_SIDE, height);
	let sx = clampScale(w / w0), sy = clampScale(h / h0);
	const measured = (k: Matrix) => itemsBounds(strokes.map((s) => transformStroke(s, k)), elements.map((e) => transformElement(e, k, measure)), measure);
	let m = scaleAbout(sx, sy, b.minX, b.minY);
	for (let i = 0; i < 3; i++) {
		const after = measured(m);
		if (!after) break;
		const aw = after.maxX - after.minX, ah = after.maxY - after.minY;
		if (Math.abs(aw - w) <= 0.05 && Math.abs(ah - h) <= 0.05) break;
		const nx = clampScale(sx * (aw > 0 ? w / aw : 1)), ny = clampScale(sy * (ah > 0 ? h / ah : 1));
		if (nx === sx && ny === sy) break;
		sx = nx;
		sy = ny;
		m = scaleAbout(sx, sy, b.minX, b.minY);
	}
	// Stroke thickness grows about the anchor too, so the corner is put back where it was.
	const done = measured(m);
	return done ? multiply(translate(b.minX - done.minX, b.minY - done.minY), m) : m;
}

/** Keeps the proportions of `from` when one side of the size dialog is typed: the other side follows. */
export function lockedSize(from: { width: number; height: number }, edited: "width" | "height", value: number): { width: number; height: number } {
	if (!(value > 0) || !(from.width > 0) || !(from.height > 0)) return { width: from.width, height: from.height };
	return edited === "width"
		? { width: value, height: Math.round((value * from.height / from.width) * 100) / 100 }
		: { width: Math.round((value * from.width / from.height) * 100) / 100, height: value };
}
