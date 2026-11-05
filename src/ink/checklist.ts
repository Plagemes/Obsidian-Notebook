import { CHECKBOX_MAX_SIZE, CHECKBOX_MIN_SIZE, checkboxBounds } from "../model/checklist";
import type { CheckboxElement, Point, Stroke } from "../model/types";
import { strokeBounds, type BBox } from "./hit-test";
import { recognizeShape } from "./recognize";

/**
 * Handwritten checklists, the ink side (0.19, roadmap #103). Pure geometry on the page's own data, no 'obsidian', no DOM:
 *  - `checkboxFromStroke`: is this stroke a small square, drawn by hand, that can become a checkbox? (It reuses the shape
 *    recogniser of the hold-to-snap feature, `recognizeShape`, and adds the size and squareness a checkbox needs.)
 *  - `checkboxLabelInk`: the strokes on the same line to the right of a checkbox, up to a gap: its handwritten label. Nothing is
 *    stored; the label is whatever ink is there now.
 */

/** A drawn square counts as a checkbox between these sides (pt): a little smaller than a word, a little larger than a dot. */
export const DETECT_MIN_SIDE = 10;
export const DETECT_MAX_SIDE = 44;
/** The shorter side of the square's box over the longer one: below this it is a rectangle, not a square. */
const SQUARENESS = 0.75;
/** Share of the box that the recognised polygon fills: a square turned too far (a diamond) fills much less. */
const FILL = 0.72;
/** Fewest points a hand-drawn square has. */
const MIN_POINTS = 8;

export interface DetectedSquare {
	x: number;
	y: number;
	size: number;
}

function polygonArea(points: readonly Point[]): number {
	let a = 0;
	for (let i = 0; i < points.length; i++) {
		const p = points[i]!;
		const q = points[(i + 1) % points.length]!;
		a += p[0] * q[1] - q[0] * p[1];
	}
	return Math.abs(a) / 2;
}

/**
 * The square a stroke draws, or null when it is not clearly one. Strict like the recogniser (handwriting is never turned into a
 * checkbox): one closed stroke recognised as a rectangle whose box is nearly square, upright (turned by at most about 11°) and
 * between DETECT_MIN_SIDE and DETECT_MAX_SIDE. The checkbox is centred on the stroke's box and sized from the area of the square.
 */
export function checkboxFromStroke(points: readonly Point[]): DetectedSquare | null {
	if (points.length < MIN_POINTS) return null;
	// Cheap rejection before the recogniser runs: the extent of the stroke.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (w > DETECT_MAX_SIDE * 1.4 || h > DETECT_MAX_SIDE * 1.4 || w < DETECT_MIN_SIDE * 0.7 || h < DETECT_MIN_SIDE * 0.7) return null;
	const shape = recognizeShape(points);
	const clean = shape?.kind === "rectangle" ? shape.points[0] : undefined;
	if (!clean || clean.length < 4) return null;
	let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
	for (const [x, y] of clean) {
		if (x < cx0) cx0 = x;
		if (y < cy0) cy0 = y;
		if (x > cx1) cx1 = x;
		if (y > cy1) cy1 = y;
	}
	const bw = cx1 - cx0;
	const bh = cy1 - cy0;
	if (bw <= 0 || bh <= 0 || Math.min(bw, bh) / Math.max(bw, bh) < SQUARENESS) return null;
	const area = polygonArea(clean);
	if (area / (bw * bh) < FILL) return null;
	const side = Math.sqrt(area);
	if (side < DETECT_MIN_SIDE || side > DETECT_MAX_SIDE) return null;
	const size = Math.min(CHECKBOX_MAX_SIZE, Math.max(CHECKBOX_MIN_SIZE, Math.round(side * 100) / 100));
	const round2 = (v: number) => Math.round(v * 100) / 100;
	return { x: round2((cx0 + cx1) / 2 - size / 2), y: round2((cy0 + cy1) / 2 - size / 2), size };
}

// ---------------------------------------------------------------- tapping

/** A checkbox can be tapped by a finger within a square of at least this many CSS px, whatever its size on the page. */
export const TAP_TARGET_PX = 28;
/**
 * A pen (or a mouse) taps the box itself plus this margin, in page units (pt): a dot or a colon written next to the box, where the
 * label starts, is ink and must not tick it. The pen tip is precise; only a finger needs the larger target.
 */
export const PEN_TAP_MARGIN = 3;

/**
 * The topmost checkbox under the point (x, y) of a page, for a finger tap at zoom `scale` (CSS px per pt): the box itself, or a
 * square of TAP_TARGET_PX around its centre when that is larger (a finger does not need to hit a 14 pt square exactly).
 */
export function checkboxAt(elements: readonly { type: string }[], x: number, y: number, scale: number): CheckboxElement | null {
	const reach = TAP_TARGET_PX / 2 / Math.max(0.05, scale);
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i] as CheckboxElement;
		if (el.type !== "checkbox") continue;
		const half = Math.max(el.size / 2, reach);
		if (Math.abs(x - (el.x + el.size / 2)) <= half && Math.abs(y - (el.y + el.size / 2)) <= half) return el;
	}
	return null;
}

/** The topmost checkbox under the point (x, y) of a page for a pen or mouse contact: the box and PEN_TAP_MARGIN pt around it. */
export function checkboxAtPen(elements: readonly { type: string }[], x: number, y: number): CheckboxElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i] as CheckboxElement;
		if (el.type !== "checkbox") continue;
		if (x >= el.x - PEN_TAP_MARGIN && x <= el.x + el.size + PEN_TAP_MARGIN && y >= el.y - PEN_TAP_MARGIN && y <= el.y + el.size + PEN_TAP_MARGIN) return el;
	}
	return null;
}

// ---------------------------------------------------------------- the label

/** Strokes whose centre is within this share of the box above and below the box's own rows belong to the line. */
const BAND_ABOVE = 0.35;
const BAND_BELOW = 1.3;
/** A stroke taller than this many box sides is not one line of writing. */
const MAX_HEIGHT = 2.8;
/** Gap between neighbouring strokes (box sides, at least `MIN_GAP` pt) that ends the label. */
const GAP_SIDES = 1.8;
const MIN_GAP = 24;
/** A stroke may start this share of the box before its right edge (the pen overshoot of a tick drawn in the box) and still not be label. */
const OVERLAP = 0.15;

/** Whether another checkbox stands on the line of `cb` to its right (the label of `cb` ends where that one starts). */
function limitOf(cb: CheckboxElement, others: readonly CheckboxElement[]): number {
	let limit = Infinity;
	for (const o of others) {
		if (o === cb || o.id === cb.id || o.x <= cb.x + cb.size) continue;
		if (Math.abs(o.y + o.size / 2 - (cb.y + cb.size / 2)) > Math.max(o.size, cb.size) * 0.8) continue;
		if (o.x < limit) limit = o.x;
	}
	return limit;
}

/**
 * The ink of the line to the right of `cb`: visible strokes whose centre lies in the band of the checkbox's row, that start at or
 * beyond its right edge, followed one after the other (by their left edge) until a gap wider than the label gap, and stopping
 * before the next checkbox on the same row. In page order. The ink of a ticked checkbox is its label just the same.
 */
export function checkboxLabelInk(cb: CheckboxElement, strokes: readonly Stroke[], others: readonly CheckboxElement[] = []): Stroke[] {
	const left = cb.x + cb.size - cb.size * OVERLAP;
	const top = cb.y - cb.size * BAND_ABOVE;
	const bottom = cb.y + cb.size * BAND_BELOW;
	const limit = limitOf(cb, others);
	const gap = Math.max(MIN_GAP, cb.size * GAP_SIDES);
	const candidates: Array<{ stroke: Stroke; box: BBox }> = [];
	for (const stroke of strokes) {
		if (stroke.hidden || stroke.points.length === 0) continue;
		const box = strokeBounds(stroke);
		if (box.minX < left || box.minX >= limit) continue;
		const centre = (box.minY + box.maxY) / 2;
		if (centre < top || centre > bottom || box.maxY - box.minY > cb.size * MAX_HEIGHT) continue;
		candidates.push({ stroke, box });
	}
	candidates.sort((a, b) => a.box.minX - b.box.minX);
	const taken = new Set<Stroke>();
	let reach = cb.x + cb.size;
	for (const c of candidates) {
		if (c.box.minX - reach > gap) break;
		taken.add(c.stroke);
		reach = Math.max(reach, c.box.maxX);
	}
	return strokes.filter((s) => taken.has(s));
}

/** The box of the checkbox and its label ink together (the crop a task gets), or the checkbox's own box when it has no label. */
export function checkboxLabelBounds(cb: CheckboxElement, strokes: readonly Stroke[], others: readonly CheckboxElement[] = []): BBox {
	const out = { ...checkboxBounds(cb) };
	for (const s of checkboxLabelInk(cb, strokes, others)) {
		const b = strokeBounds(s);
		out.minX = Math.min(out.minX, b.minX);
		out.minY = Math.min(out.minY, b.minY);
		out.maxX = Math.max(out.maxX, b.maxX);
		out.maxY = Math.max(out.maxY, b.maxY);
	}
	return out;
}
