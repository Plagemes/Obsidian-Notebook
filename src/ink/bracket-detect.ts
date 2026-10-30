import type { Stroke } from "../model/types";
import type { BBox } from "./hit-test";

/**
 * Detects `[[` written by hand (O8): two bracket-shaped strokes side by side. Pure: no 'obsidian'.
 *
 * A bracket stroke is "[" shaped: a near-vertical spine with a short, roughly horizontal hook at each end, both hooks on the
 * same side. After simplifying the stroke to its corners it must have exactly three segments with corners of about 90 degrees.
 * That excludes what handwriting is full of: a plain stroke "l" or "|" (one segment), "1" (two), "(" and ")" (curves, whose
 * outer segments are steep and whose corners are blunt), "S" or "Z" (hooks on opposite sides), and letters as wide as they are tall.
 *
 * The result is only ever offered as a suggestion; nothing is converted automatically.
 */

type Pt = readonly [number, number, ...number[]];
export type BracketStroke = Pick<Stroke, "id" | "tool" | "points">;

/** Smallest and largest height (pt) of a bracket: below it is a dot or a speck, above it a drawing. */
const MIN_HEIGHT = 6;
const MAX_HEIGHT = 240;
/** Width of the hooks as a share of the height. */
const MIN_ASPECT = 0.1;
const MAX_ASPECT = 0.7;

/** How far the writer may move on from the brackets and still be "writing the link": heights of the brackets. */
const LINE_SLACK = 0.6;
const WORD_GAP = 3.5;
const MAX_TAIL = 80;
const LOOK_BACK = 120;

function bounds(points: readonly Pt[]): BBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	return { minX, minY, maxX, maxY };
}

/** Distance from `p` to the segment a-b. */
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker: the corners of a polyline, ends included, with no point farther than `eps` from the result. */
export function simplify(points: readonly Pt[], eps: number): Pt[] {
	if (points.length <= 2) return [...points];
	const keep = new Array<boolean>(points.length).fill(false);
	keep[0] = keep[points.length - 1] = true;
	const stack: Array<[number, number]> = [[0, points.length - 1]];
	while (stack.length > 0) {
		const [lo, hi] = stack.pop()!;
		let far = -1;
		let farD = eps;
		for (let i = lo + 1; i < hi; i++) {
			const d = segmentDistance(points[i]!, points[lo]!, points[hi]!);
			if (d > farD) {
				far = i;
				farD = d;
			}
		}
		if (far >= 0) {
			keep[far] = true;
			stack.push([lo, far], [far, hi]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

/** Removes corners that are nearly straight (wider than `straight` degrees), the straightest first: DP keeps an arbitrary point of a wobbly line. */
function dropStraight(v: readonly Pt[], straight: number): Pt[] {
	const out = [...v];
	for (;;) {
		let at = -1;
		let widest = straight;
		for (let i = 1; i < out.length - 1; i++) {
			const a = cornerAngle(out[i - 1]!, out[i]!, out[i + 1]!);
			if (a > widest) {
				widest = a;
				at = i;
			}
		}
		if (at < 0) return out;
		out.splice(at, 1);
	}
}

/** Angle in degrees at `b` between the directions to `a` and `c` (0 = folded back, 180 = straight). */
function cornerAngle(a: Pt, b: Pt, c: Pt): number {
	const ux = a[0] - b[0];
	const uy = a[1] - b[1];
	const vx = c[0] - b[0];
	const vy = c[1] - b[1];
	const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
	if (n === 0) return 180;
	return (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n))) * 180) / Math.PI;
}

export type BracketSide = "open" | "close";

export interface BracketShape {
	side: BracketSide;
	box: BBox;
}

/**
 * Whether the points are one bracket, and which: `open` is "[" (hooks point right), `close` is "]" (hooks point left).
 * Either direction of writing works.
 */
export function bracketShape(points: readonly Pt[]): BracketShape | null {
	if (points.length < 4) return null;
	const box = bounds(points);
	const h = box.maxY - box.minY;
	const w = box.maxX - box.minX;
	if (!(h >= MIN_HEIGHT && h <= MAX_HEIGHT)) return null;
	if (w < MIN_ASPECT * h || w > MAX_ASPECT * h) return null;
	for (const k of [0.07, 0.1, 0.14]) {
		const v = dropStraight(simplify(points, Math.max(0.6, k * h)), 150);
		if (v.length !== 4) continue;
		const [p0, p1, p2, p3] = v as [Pt, Pt, Pt, Pt];
		const hook1 = [p1[0] - p0[0], p1[1] - p0[1]];
		const spine = [p2[0] - p1[0], p2[1] - p1[1]];
		const hook3 = [p3[0] - p2[0], p3[1] - p2[1]];
		// The spine is the long, near-vertical middle segment.
		if (Math.abs(spine[1]!) < 0.6 * h || Math.abs(spine[0]!) > 0.35 * Math.abs(spine[1]!)) continue;
		// Hooks are short and near-horizontal (within about 40 degrees) and not tiny.
		const flat = (s: number[]) => Math.abs(s[1]!) <= 0.85 * Math.abs(s[0]!) && Math.abs(s[0]!) >= 0.1 * h && Math.abs(s[0]!) <= 0.75 * h;
		if (!flat(hook1) || !flat(hook3)) continue;
		// The corners are about right angles.
		const c1 = cornerAngle(p0, p1, p2);
		const c2 = cornerAngle(p1, p2, p3);
		if (c1 < 50 || c1 > 130 || c2 < 50 || c2 > 130) continue;
		// Both hooks on one side of the spine: "[" has them pointing right (the stroke runs left at the first, right at the last).
		if (hook1[0]! < 0 && hook3[0]! > 0) return { side: "open", box };
		if (hook1[0]! > 0 && hook3[0]! < 0) return { side: "close", box };
	}
	return null;
}

/** Whether `a` then `b` (left to right) read as `[[`: two "[" of similar height, level, a spine apart. */
export function isOpenPair(a: BracketShape, b: BracketShape): boolean {
	if (a.side !== "open" || b.side !== "open") return false;
	const ha = a.box.maxY - a.box.minY;
	const hb = b.box.maxY - b.box.minY;
	if (hb / ha < 0.6 || hb / ha > 1.67) return false;
	const h = Math.max(ha, hb);
	const overlap = Math.min(a.box.maxY, b.box.maxY) - Math.max(a.box.minY, b.box.minY);
	if (overlap < 0.7 * Math.min(ha, hb)) return false;
	// Spine to spine: not on top of each other, not words apart.
	const gap = b.box.minX - a.box.minX;
	return gap >= 0.2 * h && gap <= 1.6 * h;
}

const isInk = (s: BracketStroke) => s.tool === "pen" && s.points.length >= 4;

/** A `[[` in the strokes (the pair at `index` and `index + 1`), or null. */
export function openBracketsAt(strokes: readonly BracketStroke[], index: number): { first: BracketShape; second: BracketShape } | null {
	const a = strokes[index];
	const b = strokes[index + 1];
	if (!a || !b || !isInk(a) || !isInk(b)) return null;
	const sa = bracketShape(a.points);
	if (!sa) return null;
	const sb = bracketShape(b.points);
	return sb && isOpenPair(sa, sb) ? { first: sa, second: sb } : null;
}

export interface PenLinkCandidate {
	/** The two bracket strokes, left then right. */
	brackets: [string, string];
	/** Brackets and everything written after them on the same line: the ink the link would be attached to. */
	strokeIds: string[];
	bounds: BBox;
}

/**
 * The `[[` the writer has just written, if any: the latest pair of bracket strokes among the last strokes of the page, with
 * only a few strokes after it, all on the same line to the right (the name being written). Writing anywhere else, or on
 * the next line, ends the candidate. Strokes are in writing order (the page's stroke array).
 */
export function penLinkCandidate(strokes: readonly BracketStroke[]): PenLinkCandidate | null {
	const last = strokes.length - 1;
	for (let i = last - 1; i >= Math.max(0, last - LOOK_BACK); i--) {
		if (last - i - 1 > MAX_TAIL) return null;
		const pair = openBracketsAt(strokes, i);
		if (!pair) continue;
		const h = Math.max(pair.first.box.maxY - pair.first.box.minY, pair.second.box.maxY - pair.second.box.minY);
		const top = Math.min(pair.first.box.minY, pair.second.box.minY);
		const bottom = Math.max(pair.first.box.maxY, pair.second.box.maxY);
		const box: BBox = {
			minX: Math.min(pair.first.box.minX, pair.second.box.minX), minY: top,
			maxX: Math.max(pair.first.box.maxX, pair.second.box.maxX), maxY: bottom,
		};
		const ids = [strokes[i]!.id, strokes[i + 1]!.id];
		for (let j = i + 2; j <= last; j++) {
			const s = strokes[j]!;
			if (s.points.length === 0) return null;
			const b = bounds(s.points);
			const mid = (b.minY + b.maxY) / 2;
			const sameLine = mid >= top - LINE_SLACK * h && mid <= bottom + LINE_SLACK * h && b.maxY - b.minY <= 3 * h;
			const toTheRight = b.minX >= pair.second.box.minX - 0.5 * h && b.minX - box.maxX <= WORD_GAP * h;
			if (!sameLine || !toTheRight) return null;
			box.minX = Math.min(box.minX, b.minX);
			box.maxX = Math.max(box.maxX, b.maxX);
			box.minY = Math.min(box.minY, b.minY);
			box.maxY = Math.max(box.maxY, b.maxY);
			ids.push(s.id);
		}
		return { brackets: [ids[0]!, ids[1]!], strokeIds: ids, bounds: box };
	}
	return null;
}
