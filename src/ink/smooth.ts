import { boundGraphId, pinnedInk } from "./attach";
import { Batch, ReplaceStroke } from "../model/history";
import { freezeStroke } from "../model/serialize";
import { isLinePen, type Page, type PageElement, type Point, type Stroke } from "../model/types";

/**
 * 0.26 (#66): "Smooth" and "Straighten" for the handwriting of a selection (pure, no 'obsidian').
 *
 * Both only move the points of a stroke; the stroke keeps its id, its place in the page order (so its layer), its style and every field,
 * the number of points and the pressure of each point, and the points stay [x, y, pressure] in page coordinates. The first and the last
 * point never move. The moved points are rounded like every other edit does (x and y to 0.01 pt as `quantizePoint` does, so the file stays compact). Nothing is stamped (the ink is reshaped, not written now). Who is touched: line pens only (`isLinePen`, so never a
 * shape, the highlighter or the marker), visible, not bound to a graph, not the ink a collapsed sticky note keeps hidden, and of a group
 * only when the whole group is asked for and holds no locked element. Text, images and area highlights are not strokes and are not touched.
 *
 *  - Smooth takes the jitter of the hand out: a few Taubin passes (a Laplacian step and a slightly larger step back, so a curve does not
 *    shrink), with the sharp corners of the stroke held in place, so the foot of an L or the tip of a check mark stays sharp. No point
 *    moves farther than a fraction of the pen width, so the shape cannot change, only its wobble. A stroke that is already smooth is not
 *    changed, which also bounds how often it can be run again.
 *  - Straighten turns a stroke that is almost a straight line into a clean line between its end points, each point at the same share of
 *    the way as it was along the stroke. A curve, a loop, a zig-zag or a stroke that doubles back is left as it is. It is idempotent.
 */

export const SMOOTH_RULES = {
	/** A stroke needs at least this many points to be smoothed. */
	minPoints: 5,
	/** Taubin pass: step forward `lambda`, step back `mu` (|mu| > lambda so the curve does not shrink); the number of pass pairs. */
	lambda: 0.5, mu: -0.53, passes: 4,
	/** A point never ends farther than this many pen widths (at least `maxMovePt`) from where it was. */
	maxMoveWidths: 1, maxMovePt: 0.8,
	/** A corner: the direction over `cornerReachWidths` pen widths (at least `cornerReachPt`) on each side turns by more than `cornerDegrees`. */
	cornerReachWidths: 2.5, cornerReachPt: 3, cornerDegrees: 50,
	/** A result whose farthest point moved less than this (pt) is not a change. */
	minChange: 0.05,
} as const;

export const STRAIGHT_RULES = {
	/** A stroke needs at least this many points and a chord at least this long (pen widths, and pt) to be straightened. */
	minPoints: 3, minChordWidths: 4, minChordPt: 8,
	/** The farthest point from the chord is at most this share of the chord. */
	maxBend: 0.07,
	/** The line along the stroke is at most this many times the chord. */
	maxLengthRatio: 1.12,
	/** No point lies behind the start or beyond the end by more than this share of the chord (a stroke that doubles back is not a line). */
	maxOvershoot: 0.03,
	/** A result whose farthest point moved less than this (pt) is not a change. */
	minChange: 0.02,
} as const;

export type SmoothMode = "smooth" | "straighten";

function cumulative(pts: readonly Point[]): number[] {
	const out = [0];
	for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
	return out;
}

/** A reshaped point: x and y rounded to 0.01 pt like the file (and every other edit, `quantizePoint`) does; the pressure is the point's own. */
function reshaped(x: number, y: number, pressure: number): Point {
	return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, pressure];
}

/** Whether `stroke` is handwriting this feature may reshape (before the page-level rules of groups and pinned ink). */
export function isReshapable(stroke: Stroke): boolean {
	return isLinePen(stroke.tool) && !stroke.hidden && boundGraphId(stroke) === null;
}

/** Corner points (indices): where the direction turns sharply over a reach of a few pen widths. */
function corners(pts: readonly Point[], cum: readonly number[], width: number): Set<number> {
	const n = pts.length;
	const reach = Math.max(SMOOTH_RULES.cornerReachPt, SMOOTH_RULES.cornerReachWidths * width);
	const cos = Math.cos((SMOOTH_RULES.cornerDegrees * Math.PI) / 180);
	const turn = new Array<number>(n).fill(1); // cosine of the turn: 1 = straight on, -1 = a reversal
	let a = 0;
	let b = 0;
	for (let i = 1; i < n - 1; i++) {
		while (a < i - 1 && cum[i]! - cum[a + 1]! >= reach) a++;
		if (b < i) b = i;
		while (b < n - 1 && cum[b]! - cum[i]! < reach) b++;
		if (cum[i]! - cum[a]! < reach || cum[b]! - cum[i]! < reach) continue;
		const ux = pts[i]![0] - pts[a]![0];
		const uy = pts[i]![1] - pts[a]![1];
		const vx = pts[b]![0] - pts[i]![0];
		const vy = pts[b]![1] - pts[i]![1];
		const lu = Math.hypot(ux, uy);
		const lv = Math.hypot(vx, vy);
		if (lu === 0 || lv === 0) continue;
		turn[i] = (ux * vx + uy * vy) / (lu * lv);
	}
	// Only the sharpest point of each bend is a corner.
	const out = new Set<number>();
	for (let i = 1; i < n - 1; i++) {
		if (turn[i]! >= cos) continue;
		let best = true;
		for (let j = i - 1; j >= 1 && cum[i]! - cum[j]! < reach; j--) if (turn[j]! < turn[i]!) { best = false; break; }
		if (best) for (let j = i + 1; j < n - 1 && cum[j]! - cum[i]! < reach; j++) if (turn[j]! <= turn[i]!) { best = false; break; }
		if (best) out.add(i);
	}
	return out;
}

/** The smoothed points of `stroke`, or null when it is not to be smoothed or the result is not a visible change. */
export function smoothedPoints(stroke: Stroke): Point[] | null {
	const pts = stroke.points;
	const n = pts.length;
	if (!isReshapable(stroke) || n < SMOOTH_RULES.minPoints) return null;
	const cum = cumulative(pts);
	if (!(cum[n - 1]! > 0)) return null;
	const fixed = corners(pts, cum, stroke.width);
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const step = (k: number): void => {
		const nx = xs.slice();
		const ny = ys.slice();
		for (let i = 1; i < n - 1; i++) {
			if (fixed.has(i)) continue;
			nx[i] = xs[i]! + k * ((xs[i - 1]! + xs[i + 1]!) / 2 - xs[i]!);
			ny[i] = ys[i]! + k * ((ys[i - 1]! + ys[i + 1]!) / 2 - ys[i]!);
		}
		for (let i = 1; i < n - 1; i++) { xs[i] = nx[i]!; ys[i] = ny[i]!; }
	};
	for (let pass = 0; pass < SMOOTH_RULES.passes; pass++) {
		step(SMOOTH_RULES.lambda);
		step(SMOOTH_RULES.mu);
	}
	const cap = Math.max(SMOOTH_RULES.maxMovePt, SMOOTH_RULES.maxMoveWidths * stroke.width);
	let moved = 0;
	const out: Point[] = pts.map((p, i) => {
		if (i === 0 || i === n - 1) return p;
		let dx = xs[i]! - p[0];
		let dy = ys[i]! - p[1];
		const d = Math.hypot(dx, dy);
		if (d > cap) { dx *= cap / d; dy *= cap / d; }
		const m = Math.min(d, cap);
		if (m > moved) moved = m;
		return reshaped(p[0] + dx, p[1] + dy, p[2]);
	});
	return moved < SMOOTH_RULES.minChange ? null : out;
}

/** The straightened points of `stroke`, or null when it is not an almost-straight line or already is one. */
export function straightenedPoints(stroke: Stroke): Point[] | null {
	const pts = stroke.points;
	const n = pts.length;
	if (!isReshapable(stroke) || n < STRAIGHT_RULES.minPoints) return null;
	const a = pts[0]!;
	const b = pts[n - 1]!;
	const cx = b[0] - a[0];
	const cy = b[1] - a[1];
	const chord = Math.hypot(cx, cy);
	if (chord < Math.max(STRAIGHT_RULES.minChordPt, STRAIGHT_RULES.minChordWidths * stroke.width)) return null;
	const cum = cumulative(pts);
	const total = cum[n - 1]!;
	if (total > STRAIGHT_RULES.maxLengthRatio * chord) return null;
	const ux = cx / chord;
	const uy = cy / chord;
	let bend = 0;
	for (let i = 1; i < n - 1; i++) {
		const dx = pts[i]![0] - a[0];
		const dy = pts[i]![1] - a[1];
		const along = dx * ux + dy * uy;
		if (along < -STRAIGHT_RULES.maxOvershoot * chord || along > (1 + STRAIGHT_RULES.maxOvershoot) * chord) return null;
		const off = Math.abs(dx * uy - dy * ux);
		if (off > bend) bend = off;
	}
	if (bend > STRAIGHT_RULES.maxBend * chord) return null;
	let moved = 0;
	const out: Point[] = pts.map((p, i) => {
		if (i === 0 || i === n - 1) return p;
		const s = cum[i]! / total;
		const x = a[0] + cx * s;
		const y = a[1] + cy * s;
		const d = Math.hypot(x - p[0], y - p[1]);
		if (d > moved) moved = d;
		return reshaped(x, y, p[2]);
	});
	return moved < STRAIGHT_RULES.minChange ? null : out;
}

export interface SmoothPlan {
	command: Batch;
	/** The strokes of the request after the change (each reshaped one replaced by its new copy). */
	strokes: Stroke[];
	/** What became of each stroke that changed. */
	changes: ReadonlyMap<Stroke, Stroke>;
	/** How many strokes changed. */
	count: number;
}

export const SMOOTH_LABEL = "Smooth strokes";
export const STRAIGHTEN_LABEL = "Straighten strokes";

/**
 * The command that smooths or straightens the handwriting among `strokes` of `page`, as ONE undo step (one `ReplaceStroke` per stroke
 * that changes, each keeping its position in the page order). `elements` are the elements of the same request: a group is reshaped only
 * when every member of it on the page is asked for and none is a locked element. Null when nothing changes (so a second run of Straighten
 * is null). Strokes that are no longer on the page are skipped.
 */
export function planSmooth(page: Page, strokes: readonly Stroke[], elements: readonly PageElement[], mode: SmoothMode): SmoothPlan | null {
	const hidden = new Set(pinnedInk(page.strokes, page.elements ?? []));
	const askedStrokes = new Set(strokes);
	const askedElements = new Set(elements);
	// A group is moved whole or not at all.
	const whole = new Map<string, boolean>();
	const groupOk = (id: string): boolean => {
		const known = whole.get(id);
		if (known !== undefined) return known;
		let ok = true;
		for (const s of page.strokes) if (s.group === id && !askedStrokes.has(s)) ok = false;
		for (const e of page.elements ?? []) if (e.group === id && (e.locked || !askedElements.has(e))) ok = false;
		whole.set(id, ok);
		return ok;
	};
	const steps: ReplaceStroke[] = [];
	const changes = new Map<Stroke, Stroke>();
	page.strokes.forEach((s, index) => {
		if (!askedStrokes.has(s) || hidden.has(s)) return;
		if (s.group !== undefined && !groupOk(s.group)) return;
		const points = mode === "smooth" ? smoothedPoints(s) : straightenedPoints(s);
		if (!points) return;
		const next = freezeStroke({ ...s, points });
		changes.set(s, next);
		steps.push(new ReplaceStroke(page.id, s, [next], index));
	});
	if (steps.length === 0) return null;
	return {
		command: new Batch(mode === "smooth" ? SMOOTH_LABEL : STRAIGHTEN_LABEL, steps),
		strokes: strokes.map((s) => changes.get(s) ?? s),
		changes,
		count: steps.length,
	};
}
