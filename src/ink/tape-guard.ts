import type { PageElement, Stroke, TapeElement } from "../model/types";
import { elementBounds, type MeasureText } from "./elements";
import { inkReach } from "./ink-geometry";
import { strokeBounds, type BBox } from "./hit-test";
import { estimateMeasure } from "./text-layout";

/**
 * Study tape (0.29, #10), review fix T1: what the erasers must leave alone. A hidden tape hides what is under it, so nothing the erasers do
 * may change ink or an element under it, even in part: the stroke, segment, area and scribble erasers skip every stroke and element that
 * reaches under one of the hidden tapes, tested against ALL of them (a stroke covered by two tapes side by side is under tape too). The user
 * reveals the tape to erase there. The selection is not limited (review fix T2): the lasso, groups and "ink follows objects" take covered ink
 * with the rest, so what is saved never depends on what is revealed on this screen. No 'obsidian', no DOM.
 */

/** A little more than the reach of the ink: the line drawn through the points of a smooth stroke can bulge a bit past the polyline. */
const CURVE_MARGIN = 1;

/** Whether box `b` overlaps one of `tapes` (more than touching an edge). */
export function boxTouchesTapes(b: BBox, tapes: readonly TapeElement[]): boolean {
	return tapes.some((t) => b.minX < t.x + t.width && b.maxX > t.x && b.minY < t.y + t.height && b.maxY > t.y);
}

/** Whether the segment a→b crosses or lies in the rectangle (Liang–Barsky clipping). */
function segmentInRect(ax: number, ay: number, bx: number, by: number, r: BBox): boolean {
	let t0 = 0;
	let t1 = 1;
	const dx = bx - ax;
	const dy = by - ay;
	const clip = (p: number, q: number): boolean => {
		if (p === 0) return q >= 0;
		const k = q / p;
		if (p < 0) {
			if (k > t1) return false;
			if (k > t0) t0 = k;
		} else {
			if (k < t0) return false;
			if (k < t1) t1 = k;
		}
		return true;
	};
	return clip(-dx, ax - r.minX) && clip(dx, r.maxX - ax) && clip(-dy, ay - r.minY) && clip(dy, r.maxY - ay);
}

/**
 * Whether any part of `stroke` lies under one of `tapes`: its line (the polyline grown by the reach of the ink) or, for a filled shape, its
 * box (the fill covers the inside). `bounds` lets the caller reuse a cache.
 */
export function strokeTouchesTapes(stroke: Stroke, tapes: readonly TapeElement[], bounds: BBox = strokeBounds(stroke)): boolean {
	if (tapes.length === 0 || !boxTouchesTapes(bounds, tapes)) return false;
	const pts = stroke.points;
	if (stroke.fill !== undefined || pts.length === 0) return true;
	const pad = inkReach(stroke.tool, stroke.width) + CURVE_MARGIN;
	for (const t of tapes) {
		const r: BBox = { minX: t.x - pad, minY: t.y - pad, maxX: t.x + t.width + pad, maxY: t.y + t.height + pad };
		if (pts.length === 1) {
			const [x, y] = pts[0]!;
			if (x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY) return true;
			continue;
		}
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1]!;
			const b = pts[i]!;
			if (segmentInRect(a[0], a[1], b[0], b[1], r)) return true;
		}
	}
	return false;
}

/** Whether element `el` (not a tape: a tape is what hides, never what is hidden) lies under one of `tapes`, even in part. */
export function elementTouchesTapes(el: PageElement, tapes: readonly TapeElement[], measure: MeasureText = estimateMeasure): boolean {
	if (el.type === "tape" || tapes.length === 0) return false;
	return boxTouchesTapes(elementBounds(el, measure), tapes);
}

/**
 * Review R3: whether a selection holds ink or elements that one of the hidden `tapes` covers, even in part. The selection frame draws the
 * hidden tapes over what it holds, so Delete and Cut ask first: otherwise the covered answers would go without anyone seeing them. The
 * tapes themselves do not count (a tape alone is visible), but a selected tape still hides what it covers until it is gone.
 */
export function selectionHoldsCovered(
	strokes: readonly Stroke[], elements: readonly PageElement[], tapes: readonly TapeElement[],
	boundsOf?: (s: Stroke) => BBox, measure: MeasureText = estimateMeasure,
): boolean {
	if (tapes.length === 0) return false;
	return strokes.some((s) => strokeTouchesTapes(s, tapes, boundsOf?.(s))) || elements.some((el) => elementTouchesTapes(el, tapes, measure));
}
