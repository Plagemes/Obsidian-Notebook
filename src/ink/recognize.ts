import type { Point } from "../model/types";
import { pointSegmentDistance } from "./hit-test";
import { arrowPoints, ellipsePoints, linePoints, polygonPoints } from "./shapes";

/**
 * Shape recognition for "hold the pen still at the end of the stroke". Cheap heuristics, all in page coordinates (pt).
 * Philosophy: it is much worse to turn handwriting into a shape than to miss a sloppy shape, so every test is strict and
 * ALL tests of a kind must pass. Thresholds (errors are normalised by the shape size, so they do not depend on zoom):
 *
 *   minimum path length ........................ 24 pt
 *   line:       chord / path length >= 0.92, RMS deviation from the PCA line <= 2.5 % of the length, max <= 6 %
 *   closed:     gap (start→end) <= 15 % of the path length, thinnest side >= 5 % of the path length
 *   ellipse:    RMS relative radial error of the least-squares ellipse <= 9 %, total turning >= 300°
 *   rectangle:  (rotated) bounding rectangle from the dominant edge direction, RMS distance to its outline <= 5 % of the
 *               shorter side, max <= 18 %, every corner within 14 % of the shorter side of a stroke point
 *   triangle:   3 corners refined by line fitting, RMS distance to the outline <= 6 % of the mean side, corners
 *               within 15 % of a stroke point, all angles >= 22°, shortest side >= 18 % of the perimeter
 *   arrow:      open polyline with exactly 5 corners: tail → tip → wing → tip → wing (the way an arrow head is drawn in
 *               one stroke): tip revisited within 20 % of the shaft / half a wing, wings 10–70 % of the shaft, similar
 *               in length (×0.5–2) and angle, 10–60° from the shaft, on opposite sides, RMS to the polyline <= 4 %
 *
 * `score` is 1 − error / threshold of the weakest criterion, in (0, 1]; a result is only returned when it is above 0.
 * When a closed stroke matches several shapes the highest score wins.
 */
export type ShapeKind = "line" | "rectangle" | "ellipse" | "triangle" | "arrow";

export interface RecognizedShape {
	kind: ShapeKind;
	/** Clean replacement geometry: one polyline per stroke to create (currently always exactly one). */
	points: Point[][];
	score: number;
}

type V = [number, number];

export const MIN_SHAPE_LENGTH = 24;
const N = 64;
const LINE_STRAIGHTNESS = 0.92;
const LINE_RMS = 0.025;
const LINE_MAX = 0.06;
const CLOSE_RATIO = 0.15;
const MIN_THICKNESS = 0.05;
const ELLIPSE_ERR = 0.09;
const ELLIPSE_TURN = (300 * Math.PI) / 180;
const RECT_RMS = 0.05;
const RECT_MAX = 0.18;
const RECT_CORNER = 0.14;
const TRI_RMS = 0.06;
const TRI_CORNER = 0.15;
const TRI_MIN_ANGLE = (22 * Math.PI) / 180;
const TRI_MIN_SIDE = 0.18;
const ARROW_RMS = 0.04;

const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function pathLength(p: readonly V[]): number {
	let l = 0;
	for (let i = 1; i < p.length; i++) l += dist(p[i - 1]!, p[i]!);
	return l;
}

/** `n` points equally spaced along the path, the first and last being the path's ends. */
function resample(p: readonly V[], n: number): V[] {
	const total = pathLength(p);
	if (p.length < 2 || total === 0) return Array.from({ length: n }, () => [...(p[0] ?? [0, 0])] as V);
	const step = total / (n - 1);
	const out: V[] = [[...p[0]!] as V];
	let acc = 0;
	let next = step;
	for (let i = 1; i < p.length && out.length < n - 1; i++) {
		const a = p[i - 1]!;
		const b = p[i]!;
		const seg = dist(a, b);
		while (seg > 0 && acc + seg >= next && out.length < n - 1) {
			const t = (next - acc) / seg;
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			next += step;
		}
		acc += seg;
	}
	out.push([...p[p.length - 1]!] as V);
	return out;
}

function centroid(p: readonly V[]): V {
	let x = 0, y = 0;
	for (const q of p) { x += q[0]; y += q[1]; }
	return [x / p.length, y / p.length];
}

/** Principal axis angle of the points (radians) and centroid. */
function pca(p: readonly V[]): { c: V; angle: number } {
	const c = centroid(p);
	let sxx = 0, syy = 0, sxy = 0;
	for (const q of p) {
		const dx = q[0] - c[0], dy = q[1] - c[1];
		sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
	}
	return { c, angle: 0.5 * Math.atan2(2 * sxy, sxx - syy) };
}

function rms(values: readonly number[]): number {
	return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / Math.max(1, values.length));
}

/** Distance from `p` to a polyline/polygon outline. */
function distToOutline(p: V, verts: readonly V[], closed: boolean): number {
	let best = Infinity;
	const edges = closed ? verts.length : verts.length - 1;
	for (let i = 0; i < edges; i++) {
		const a = verts[i]!, b = verts[(i + 1) % verts.length]!;
		best = Math.min(best, pointSegmentDistance(p[0], p[1], a[0], a[1], b[0], b[1]));
	}
	return best;
}

function bbox(p: readonly V[]) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of p) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- line

function fitLine(raw: readonly V[], length: number): RecognizedShape | null {
	const pts = resample(raw, N);
	const { c, angle } = pca(pts);
	const ux = Math.cos(angle), uy = Math.sin(angle);
	const dev = pts.map((q) => Math.abs(-(q[0] - c[0]) * uy + (q[1] - c[1]) * ux));
	const e = rms(dev) / length;
	const m = Math.max(...dev) / length;
	if (e > LINE_RMS || m > LINE_MAX) return null;
	const project = (q: V): V => {
		const t = (q[0] - c[0]) * ux + (q[1] - c[1]) * uy;
		return [c[0] + t * ux, c[1] + t * uy];
	};
	const a = project(raw[0]!);
	const b = project(raw[raw.length - 1]!);
	return { kind: "line", points: [linePoints(a, b)], score: clamp01(1 - Math.max(e / LINE_RMS, m / LINE_MAX)) };
}

// ---------------------------------------------------------------- closed shapes

function totalTurning(contour: readonly V[]): number {
	let sum = 0;
	for (let i = 2; i < contour.length; i++) {
		const h0 = Math.atan2(contour[i - 1]![1] - contour[i - 2]![1], contour[i - 1]![0] - contour[i - 2]![0]);
		const h1 = Math.atan2(contour[i]![1] - contour[i - 1]![1], contour[i]![0] - contour[i - 1]![0]);
		sum += wrap(h1 - h0);
	}
	return sum;
}

function fitEllipse(contour: readonly V[], length: number): RecognizedShape | null {
	if (Math.abs(totalTurning(contour)) < ELLIPSE_TURN) return null;
	const { c, angle } = pca(contour);
	const cos = Math.cos(angle), sin = Math.sin(angle);
	const local = contour.map((q): V => [(q[0] - c[0]) * cos + (q[1] - c[1]) * sin, -(q[0] - c[0]) * sin + (q[1] - c[1]) * cos]);
	// Least squares for u·x² + v·y² = 1 (axis-aligned ellipse in the principal frame).
	let s40 = 0, s22 = 0, s04 = 0, s20 = 0, s02 = 0;
	for (const [x, y] of local) {
		s40 += x ** 4; s22 += x * x * y * y; s04 += y ** 4; s20 += x * x; s02 += y * y;
	}
	const det = s40 * s04 - s22 * s22;
	if (Math.abs(det) < 1e-9) return null;
	const u = (s20 * s04 - s02 * s22) / det;
	const v = (s40 * s02 - s22 * s20) / det;
	if (!(u > 0) || !(v > 0)) return null;
	const a = 1 / Math.sqrt(u), b = 1 / Math.sqrt(v);
	if (Math.min(a, b) * 2 < MIN_THICKNESS * length) return null;
	const e = rms(local.map(([x, y]) => Math.sqrt(u * x * x + v * y * y) - 1));
	if (e > ELLIPSE_ERR) return null;
	return { kind: "ellipse", points: [ellipsePoints(c, a, b, angle)], score: clamp01(1 - e / ELLIPSE_ERR) };
}

function fitRectangle(contour: readonly V[], length: number): RecognizedShape | null {
	// Dominant edge direction modulo 90°: circular mean of 4·heading, weighted by segment length.
	let sx = 0, sy = 0;
	for (let i = 1; i < contour.length; i++) {
		const dx = contour[i]![0] - contour[i - 1]![0], dy = contour[i]![1] - contour[i - 1]![1];
		const w = Math.hypot(dx, dy), h = Math.atan2(dy, dx);
		sx += w * Math.cos(4 * h);
		sy += w * Math.sin(4 * h);
	}
	if (Math.hypot(sx, sy) < 1e-9) return null;
	const theta = Math.atan2(sy, sx) / 4;
	const c = centroid(contour);
	const cos = Math.cos(theta), sin = Math.sin(theta);
	const local = contour.map((q): V => [(q[0] - c[0]) * cos + (q[1] - c[1]) * sin, -(q[0] - c[0]) * sin + (q[1] - c[1]) * cos]);
	const { minX, minY, maxX, maxY } = bbox(local);
	const w = maxX - minX, h = maxY - minY;
	const short = Math.min(w, h);
	if (short < MIN_THICKNESS * length) return null;
	const d = local.map(([x, y]) => {
		const ox = Math.max(minX - x, 0, x - maxX), oy = Math.max(minY - y, 0, y - maxY);
		if (ox > 0 || oy > 0) return Math.hypot(ox, oy);
		return Math.min(x - minX, maxX - x, y - minY, maxY - y);
	});
	const e = rms(d) / short;
	const m = Math.max(...d) / short;
	if (e > RECT_RMS || m > RECT_MAX) return null;
	const corners: V[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
	let cornerErr = 0;
	for (const k of corners) cornerErr = Math.max(cornerErr, Math.min(...local.map((q) => dist(q, k))) / short);
	if (cornerErr > RECT_CORNER) return null;
	const world = corners.map((k): V => [c[0] + k[0] * cos - k[1] * sin, c[1] + k[0] * sin + k[1] * cos]);
	const score = clamp01(1 - Math.max(e / RECT_RMS, m / RECT_MAX, cornerErr / RECT_CORNER));
	return { kind: "rectangle", points: [polygonPoints(world, true)], score };
}

function lineThrough(pts: readonly V[]): { p: V; d: V } {
	const { c, angle } = pca(pts);
	return { p: c, d: [Math.cos(angle), Math.sin(angle)] };
}

function intersect(l1: { p: V; d: V }, l2: { p: V; d: V }): V | null {
	const cross = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
	if (Math.abs(cross) < 1e-6) return null;
	const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / cross;
	return [l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]];
}

function fitTriangle(contour: readonly V[]): RecognizedShape | null {
	const c = centroid(contour);
	let i0 = 0;
	for (let i = 1; i < contour.length; i++) if (dist(contour[i]!, c) > dist(contour[i0]!, c)) i0 = i;
	let i1 = 0;
	for (let i = 1; i < contour.length; i++) if (dist(contour[i]!, contour[i0]!) > dist(contour[i1]!, contour[i0]!)) i1 = i;
	const a0 = contour[i0]!, a1 = contour[i1]!;
	let i2 = 0, best = -1;
	for (let i = 0; i < contour.length; i++) {
		const q = contour[i]!;
		const area = Math.abs((a1[0] - a0[0]) * (q[1] - a0[1]) - (a1[1] - a0[1]) * (q[0] - a0[0]));
		if (area > best) { best = area; i2 = i; }
	}
	let verts: V[] = [[...a0] as V, [...a1] as V, [...contour[i2]!] as V];
	for (let iter = 0; iter < 3; iter++) {
		const groups: V[][] = [[], [], []];
		for (const q of contour) {
			let side = 0, bd = Infinity;
			for (let s = 0; s < 3; s++) {
				const a = verts[s]!, b = verts[(s + 1) % 3]!;
				const d = pointSegmentDistance(q[0], q[1], a[0], a[1], b[0], b[1]);
				if (d < bd) { bd = d; side = s; }
			}
			groups[side]!.push(q);
		}
		if (groups.some((g) => g.length < 3)) return null;
		const lines = groups.map(lineThrough);
		const next = [intersect(lines[2]!, lines[0]!), intersect(lines[0]!, lines[1]!), intersect(lines[1]!, lines[2]!)];
		if (next.some((v) => v === null)) return null;
		verts = next as V[];
	}
	const sides = [dist(verts[0]!, verts[1]!), dist(verts[1]!, verts[2]!), dist(verts[2]!, verts[0]!)];
	const perimeter = sides[0]! + sides[1]! + sides[2]!;
	const meanSide = perimeter / 3;
	if (!(meanSide > 0) || Math.min(...sides) < TRI_MIN_SIDE * perimeter) return null;
	for (let i = 0; i < 3; i++) {
		const p = verts[i]!, a = verts[(i + 1) % 3]!, b = verts[(i + 2) % 3]!;
		const ang = Math.abs(wrap(Math.atan2(a[1] - p[1], a[0] - p[0]) - Math.atan2(b[1] - p[1], b[0] - p[0])));
		if (ang < TRI_MIN_ANGLE) return null;
	}
	const e = rms(contour.map((q) => distToOutline(q, verts, true))) / meanSide;
	if (e > TRI_RMS) return null;
	let cornerErr = 0;
	for (const k of verts) cornerErr = Math.max(cornerErr, Math.min(...contour.map((q) => dist(q, k))) / meanSide);
	if (cornerErr > TRI_CORNER) return null;
	return { kind: "triangle", points: [polygonPoints(verts, true)], score: clamp01(1 - Math.max(e / TRI_RMS, cornerErr / TRI_CORNER)) };
}

// ---------------------------------------------------------------- arrow

/** Ramer–Douglas–Peucker; returns the kept points in order. */
function rdp(p: readonly V[], eps: number): V[] {
	if (p.length < 3) return p.map((q) => [...q] as V);
	const a = p[0]!, b = p[p.length - 1]!;
	let idx = -1, far = 0;
	for (let i = 1; i < p.length - 1; i++) {
		const d = pointSegmentDistance(p[i]![0], p[i]![1], a[0], a[1], b[0], b[1]);
		if (d > far) { far = d; idx = i; }
	}
	if (far <= eps) return [[...a] as V, [...b] as V];
	const left = rdp(p.slice(0, idx + 1), eps);
	const right = rdp(p.slice(idx), eps);
	return [...left.slice(0, -1), ...right];
}

function fitArrow(raw: readonly V[], length: number): RecognizedShape | null {
	const pts = resample(raw, 96);
	let v: V[] = [];
	for (const f of [0.03, 0.045, 0.06, 0.08]) {
		v = rdp(pts, f * length);
		if (v.length <= 5) break;
	}
	if (v.length !== 5) return null;
	const [v0, v1, v2, v3, v4] = v as [V, V, V, V, V];
	const shaft = dist(v0, v1);
	const w1 = dist(v1, v2), w2 = dist(v3, v4);
	if (shaft < 0.35 * length) return null;
	const wing = (w1 + w2) / 2;
	const tipGap = dist(v1, v3);
	if (tipGap > 0.2 * shaft || tipGap > 0.5 * wing) return null;
	if (w1 < 0.1 * shaft || w2 < 0.1 * shaft || w1 > 0.7 * shaft || w2 > 0.7 * shaft) return null;
	if (w1 / w2 > 2 || w2 / w1 > 2) return null;
	const back = Math.atan2(v0[1] - v1[1], v0[0] - v1[0]);
	const d1 = wrap(Math.atan2(v2[1] - v1[1], v2[0] - v1[0]) - back);
	const d2 = wrap(Math.atan2(v4[1] - v3[1], v4[0] - v3[0]) - back);
	const lo = (10 * Math.PI) / 180, hi = (60 * Math.PI) / 180;
	if (Math.abs(d1) < lo || Math.abs(d1) > hi || Math.abs(d2) < lo || Math.abs(d2) > hi || d1 * d2 > 0) return null;
	const e = rms(pts.map((q) => distToOutline(q, v, false))) / length;
	if (e > ARROW_RMS) return null;
	const tip: V = [(v1[0] + v3[0]) / 2, (v1[1] + v3[1]) / 2];
	const asym = Math.abs(Math.abs(d1) - Math.abs(d2)) / ((25 * Math.PI) / 180);
	const score = clamp01(1 - Math.max(tipGap / (0.2 * shaft), asym, e / ARROW_RMS));
	return { kind: "arrow", points: [arrowPoints(v0, tip, wing)], score };
}

// ---------------------------------------------------------------- entry points

/**
 * Turns a hand-drawn stroke into a clean shape, or null when it is not clearly one (handwriting included).
 * See the module comment for the thresholds.
 */
export function recognizeShape(points: readonly Point[]): RecognizedShape | null {
	const raw: V[] = [];
	for (const [x, y] of points) {
		const last = raw[raw.length - 1];
		if (!last || Math.hypot(x - last[0], y - last[1]) > 0.01) raw.push([x, y]);
	}
	if (raw.length < 2) return null;
	const length = pathLength(raw);
	if (length < MIN_SHAPE_LENGTH) return null;
	const chord = dist(raw[0]!, raw[raw.length - 1]!);
	if (chord / length >= LINE_STRAIGHTNESS) return fitLine(raw, length);
	if (chord / length > CLOSE_RATIO) return fitArrow(raw, length);
	// Closed: explicitly close the path, then work on N equally spaced points of the contour (first ≠ last).
	const contour = resample([...raw, raw[0]!], N + 1).slice(0, N);
	const found = [fitEllipse(contour, length), fitRectangle(contour, length), fitTriangle(contour)].filter(
		(s): s is RecognizedShape => s !== null,
	);
	if (found.length === 0) return null;
	return found.reduce((a, b) => (b.score > a.score ? b : a));
}

export interface TimedSample {
	x: number;
	y: number;
	/** ms, same clock as `now`. */
	t: number;
}

/**
 * Has the pen been kept still at the end of the stroke? True when the last sample, and every earlier sample back to
 * `holdMs` ago, lie within `radiusPx` (screen px) of the last sample. `now` is the current time: the pen does not send
 * events while it stays still, so the time since the last sample counts.
 */
export function isHold(samples: ReadonlyArray<TimedSample>, now: number, holdMs = 600, radiusPx = 4): boolean {
	const last = samples[samples.length - 1];
	if (!last) return false;
	let since = last.t;
	for (let i = samples.length - 2; i >= 0; i--) {
		const s = samples[i]!;
		if (Math.hypot(s.x - last.x, s.y - last.y) > radiusPx) break;
		since = s.t;
	}
	return now - since >= holdMs;
}
