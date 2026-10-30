import { AddStroke, removeStrokes, type Batch } from "../model/history";
import type { Page, Stroke } from "../model/types";
import { segmentDistance, strokeBounds, type BBox } from "./hit-test";

/**
 * Scribble to erase: a fast back-and-forth scratch with the pen deletes the strokes it crosses.
 *
 * The detector works on the finished stroke (page coordinates, pt) and its duration. The stroke is
 * resampled at a fixed arc length, direction reversals are found where the path turns back on
 * itself, and the legs between reversals are checked: long enough (so small handwriting zig-zags
 * such as "mmm" do not count), roughly parallel, piling up on one spot instead of travelling along
 * a line (so writing and sweeping zig-zag shading do not count), and fast. The result still needs
 * ink underneath: see `scribbleVictims`.
 */
export interface ScribbleOptions {
	/** Arc-length step of the resampled path (pt). */
	step: number;
	/** The turn at a sample is measured over this many samples on each side. */
	probe: number;
	/** cos of the angle between the incoming and outgoing direction below which the path "turns back". */
	turnCos: number;
	/** Legs shorter than this (pt) do not count. */
	minLeg: number;
	/** Direction reversals needed in a row between long legs (4 = five legs). */
	minReversals: number;
	/** Cos of the largest angle between a leg and the common axis. */
	axisCos: number;
	/** Drift across the axis, relative to the mean leg length, above which the path is travelling (writing, shading). */
	maxDrift: number;
	/** Mean time per leg (ms) above which the scratch is too slow. */
	maxLegMs: number;
	/** Largest side of the scribble's box (pt). */
	maxExtent: number;
	/** The scribble must be at least this part of the stroke's length. */
	minShare: number;
}

export const DEFAULT_SCRIBBLE: ScribbleOptions = {
	step: 2,
	probe: 4,
	turnCos: -0.5,
	minLeg: 12,
	minReversals: 4,
	axisCos: 0.7,
	maxDrift: 0.8,
	maxLegMs: 300,
	maxExtent: 320,
	minShare: 0.6,
};

/** A point of a stroke: `[x, y]` or `[x, y, pressure]`. */
export type InkPoint = readonly number[];

export interface Scribble {
	/** The path of each leg (resampled points). */
	legs: Array<Array<[number, number]>>;
	/** Box of the scribble. */
	bounds: BBox;
	reversals: number;
}

type P = [number, number];

/** The polyline resampled every `step` pt of arc length (the first and last point included). */
export function resamplePath(points: readonly InkPoint[], step: number): P[] {
	const out: P[] = [];
	const first = points[0];
	if (!first) return out;
	out.push([first[0]!, first[1]!]);
	let carry = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!, b = points[i]!;
		const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
		const len = Math.hypot(dx, dy);
		if (!(len > 0)) continue;
		let at = step - carry;
		while (at <= len) {
			out.push([a[0]! + (dx * at) / len, a[1]! + (dy * at) / len]);
			at += step;
		}
		carry = len - (at - step);
	}
	const last = points[points.length - 1]!;
	const tail = out[out.length - 1]!;
	if (Math.hypot(last[0]! - tail[0], last[1]! - tail[1]) > step / 4) out.push([last[0]!, last[1]!]);
	return out;
}

/** Indices of the samples where the path turns back (one per turn). */
function reversalIndices(path: readonly P[], probe: number, turnCos: number): number[] {
	const found: number[] = [];
	let best = -1;
	let bestCos = 0;
	let lastCandidate = -Infinity;
	const flush = () => {
		if (best >= 0) found.push(best);
		best = -1;
	};
	for (let k = probe; k < path.length - probe; k++) {
		const a = path[k - probe]!, m = path[k]!, b = path[k + probe]!;
		const ax = m[0] - a[0], ay = m[1] - a[1], bx = b[0] - m[0], by = b[1] - m[1];
		const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
		if (la < 1e-6 || lb < 1e-6) continue;
		const cos = (ax * bx + ay * by) / (la * lb);
		if (cos >= turnCos) continue;
		if (k - lastCandidate > probe) flush();
		if (best < 0 || cos < bestCos) {
			best = k;
			bestCos = cos;
		}
		lastCandidate = k;
	}
	flush();
	return found;
}

function boundsOfPoints(pts: readonly P[]): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of pts) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

function pathLength(pts: readonly P[]): number {
	let sum = 0;
	for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
	return sum;
}

/**
 * Is this stroke (page coordinates, pt) a scribble? `durationMs` is the time from pen down to pen
 * up. Returns the legs of the scribble, or null.
 */
export function detectScribble(points: readonly InkPoint[], durationMs: number, options: Partial<ScribbleOptions> = {}): Scribble | null {
	const o = { ...DEFAULT_SCRIBBLE, ...options };
	if (points.length < 2 * o.probe + 2 || !(durationMs > 0)) return null;
	const path = resamplePath(points, o.step);
	if (path.length < 2 * o.probe + 2) return null;
	const total = pathLength(path);
	const rev = reversalIndices(path, o.probe, o.turnCos);
	if (rev.length < o.minReversals) return null;
	// Mean time per leg over the whole stroke.
	if (durationMs / (rev.length + 1) > o.maxLegMs) return null;

	// The longest run of consecutive interior legs that are long enough.
	const chord = (j: number) => Math.hypot(path[rev[j + 1]!]![0] - path[rev[j]!]![0], path[rev[j + 1]!]![1] - path[rev[j]!]![1]);
	let bestFrom = -1, bestCount = 0;
	for (let j = 0; j < rev.length - 1;) {
		if (!(chord(j) >= o.minLeg)) {
			j++;
			continue;
		}
		let e = j;
		while (e < rev.length - 1 && chord(e) >= o.minLeg) e++;
		if (e - j > bestCount) {
			bestCount = e - j;
			bestFrom = j;
		}
		j = e;
	}
	// `bestCount` legs are bounded by `bestCount + 1` reversals.
	if (bestCount < o.minReversals - 1) return null;

	const turns = rev.slice(bestFrom, bestFrom + bestCount + 1).map((i) => path[i]!);
	// Common axis: legs alternate in direction.
	let axX = 0, axY = 0;
	const dirs: P[] = [];
	for (let j = 0; j < bestCount; j++) {
		const dx = turns[j + 1]![0] - turns[j]![0], dy = turns[j + 1]![1] - turns[j]![1];
		const len = Math.hypot(dx, dy);
		const u: P = [dx / len, dy / len];
		dirs.push(u);
		const s = j % 2 === 0 ? 1 : -1;
		axX += s * u[0];
		axY += s * u[1];
	}
	const axLen = Math.hypot(axX, axY);
	if (axLen < 1e-6) return null;
	axX /= axLen;
	axY /= axLen;
	for (const u of dirs) if (Math.abs(u[0] * axX + u[1] * axY) < o.axisCos) return null;

	// Drift across the axis versus leg length: a scribble piles up, writing and shading travel.
	let lo = Infinity, hi = -Infinity, legSum = 0;
	for (const [x, y] of turns) {
		const across = -x * axY + y * axX;
		if (across < lo) lo = across;
		if (across > hi) hi = across;
	}
	for (let j = 0; j < bestCount; j++) legSum += chord(bestFrom + j);
	if (hi - lo > o.maxDrift * (legSum / bestCount)) return null;

	// The legs between the reversals, plus the way in and out of the scratch (at most one leg long each).
	const firstTurn = rev[bestFrom]!, lastTurn = rev[bestFrom + bestCount]!;
	const lead = Math.max(1, Math.floor(legSum / bestCount / o.step));
	const legs: Array<Array<[number, number]>> = [];
	if (firstTurn > 0) legs.push(path.slice(Math.max(0, firstTurn - lead), firstTurn + 1));
	for (let j = 0; j < bestCount; j++) legs.push(path.slice(rev[bestFrom + j], rev[bestFrom + j + 1]! + 1));
	if (lastTurn < path.length - 1) legs.push(path.slice(lastTurn, Math.min(path.length, lastTurn + lead + 1)));

	// Most of the stroke must be the scratch: a long word with a flourish is not a scribble.
	const scratchLength = legs.reduce((sum, leg) => sum + pathLength(leg), 0);
	if (scratchLength < o.minShare * total) return null;
	const bounds = boundsOfPoints(legs.flat());
	if (Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) > o.maxExtent) return null;
	return { legs, bounds, reversals: bestCount + 1 };
}

/** A stroke touched by at least this many different legs of the scribble is deleted. */
export const MIN_LEGS_CROSSING = 2;
/** Strokes whose box is more than this many times the scribble's diagonal are left alone (rulings, frames). */
export const MAX_VICTIM_SPAN = 4;

/**
 * The strokes a scribble deletes: those it crosses with at least two different legs (a single
 * graze does not count), except very large strokes. `penWidth` is the width of the scribble's own ink.
 */
export function scribbleVictims(
	scribble: Scribble, strokes: readonly Stroke[], penWidth: number, boundsOf: (s: Stroke) => BBox = strokeBounds,
): Stroke[] {
	const sb = scribble.bounds;
	const pad = penWidth;
	const diag = Math.hypot(sb.maxX - sb.minX, sb.maxY - sb.minY);
	const victims: Stroke[] = [];
	for (const stroke of strokes) {
		const b = boundsOf(stroke);
		if (b.maxX < sb.minX - pad || b.minX > sb.maxX + pad || b.maxY < sb.minY - pad || b.minY > sb.maxY + pad) continue;
		if (Math.hypot(b.maxX - b.minX, b.maxY - b.minY) > MAX_VICTIM_SPAN * Math.max(diag, 1)) continue;
		const reach = stroke.width / 2 + penWidth / 2;
		let crossing = 0;
		for (const leg of scribble.legs) {
			if (legTouches(leg, stroke, reach)) crossing++;
			if (crossing >= MIN_LEGS_CROSSING) break;
		}
		if (crossing >= MIN_LEGS_CROSSING) victims.push(stroke);
	}
	return victims;
}

function legTouches(leg: readonly P[], stroke: Stroke, reach: number): boolean {
	const pts = stroke.points;
	if (pts.length === 1) {
		const [px, py] = pts[0]!;
		return leg.some(([x, y]) => Math.hypot(x - px, y - py) <= reach);
	}
	for (let i = 1; i < leg.length; i++) {
		const [ax, ay] = leg[i - 1]!, [bx, by] = leg[i]!;
		for (let k = 1; k < pts.length; k++) {
			const [cx, cy] = pts[k - 1]!, [dx, dy] = pts[k]!;
			if (segmentDistance(ax, ay, bx, by, cx, cy, dx, dy) <= reach) return true;
		}
	}
	return false;
}

/**
 * One undoable step that deletes the strokes crossed by the scribble `points` on `page`, or null
 * when the stroke is not a scribble or crosses no ink (then it stays an ordinary stroke).
 */
/**
 * Scribble erase as two undo steps: the scribble is first added as the user's stroke, then one batch removes it
 * together with the strokes it crossed. A single Undo after a false positive therefore gives back both the erased
 * strokes and the stroke the user drew; a second Undo removes that stroke too. Null when it is not a scribble.
 */
export function scribbleEraseSteps(
	page: Pick<Page, "id" | "strokes">, stroke: Stroke, durationMs: number,
	boundsOf: (s: Stroke) => BBox = strokeBounds, options: Partial<ScribbleOptions> = {},
): { keep: AddStroke; erase: Batch } | null {
	const scribble = detectScribble(stroke.points, durationMs, options);
	if (!scribble) return null;
	const victims = scribbleVictims(scribble, page.strokes, stroke.width, boundsOf);
	if (victims.length === 0) return null;
	const after = [...page.strokes, stroke];
	const erase = removeStrokes(page.id, after, [...victims, stroke], "Scribble erase");
	return erase ? { keep: new AddStroke(page.id, stroke, page.strokes.length), erase } : null;
}

export function scribbleEraseCommand(
	page: Pick<Page, "id" | "strokes">, points: readonly InkPoint[], durationMs: number, penWidth: number,
	boundsOf: (s: Stroke) => BBox = strokeBounds, options: Partial<ScribbleOptions> = {},
): Batch | null {
	const scribble = detectScribble(points, durationMs, options);
	if (!scribble) return null;
	const victims = scribbleVictims(scribble, page.strokes, penWidth, boundsOf);
	return removeStrokes(page.id, page.strokes, victims, "Scribble erase");
}
