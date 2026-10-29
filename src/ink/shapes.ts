import { quantizePoint } from "../model/document";
import type { Point } from "../model/types";

/** A 2D position or vector, page coordinates (pt). */
export type Vec = readonly [number, number];

/** Pressure of generated points (the shape tool has constant width, so it only has to be valid). */
export const SHAPE_PRESSURE = 0.5;
/** Maximum distance between generated points, pt: dense enough for the eraser and the lasso to behave as with handwriting. */
export const SHAPE_STEP = 3;
/** Opening of an arrow head (angle between the shaft and each wing). */
export const ARROW_HEAD_ANGLE = (28 * Math.PI) / 180;
/** Angle step of `constrain` for lines and arrows. */
export const SNAP_ANGLE = (15 * Math.PI) / 180;

const pt = (x: number, y: number): Point => quantizePoint(x, y, SHAPE_PRESSURE);

/** Polyline through `vertices`, resampled so that consecutive points are at most `step` apart. Closed: last point equals the first. */
export function polygonPoints(vertices: readonly Vec[], closed: boolean, step = SHAPE_STEP): Point[] {
	const out: Point[] = [];
	if (vertices.length === 0) return out;
	const first = vertices[0]!;
	out.push(pt(first[0], first[1]));
	const edges = closed ? vertices.length : vertices.length - 1;
	for (let i = 0; i < edges; i++) {
		const a = vertices[i]!;
		const b = vertices[(i + 1) % vertices.length]!;
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
		for (let k = 1; k < n; k++) out.push(pt(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
		out.push(i === edges - 1 && closed ? ([...out[0]!] as Point) : pt(b[0], b[1]));
	}
	return out;
}

export function linePoints(a: Vec, b: Vec): Point[] {
	return polygonPoints([a, b], false);
}

/**
 * Arrow as ONE polyline (so it is one stroke: one undo step, one eraser/lasso unit):
 * tail → tip, then tip → wing 1, back to the tip, tip → wing 2. `headSize` is the wing length (pt),
 * limited to 60 % of the shaft so that short arrows stay readable.
 */
export function arrowPoints(a: Vec, b: Vec, headSize: number): Point[] {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	if (len < 1e-9) return linePoints(a, b);
	const size = Math.min(Math.max(headSize, 0), len * 0.6);
	const back = Math.atan2(a[1] - b[1], a[0] - b[0]);
	const w1: Vec = [b[0] + size * Math.cos(back + ARROW_HEAD_ANGLE), b[1] + size * Math.sin(back + ARROW_HEAD_ANGLE)];
	const w2: Vec = [b[0] + size * Math.cos(back - ARROW_HEAD_ANGLE), b[1] + size * Math.sin(back - ARROW_HEAD_ANGLE)];
	return polygonPoints([a, b, w1, b, w2], false);
}

/** Axis-aligned rectangle with opposite corners `a` and `b`, closed, starting at `a`. */
export function rectPoints(a: Vec, b: Vec): Point[] {
	return polygonPoints([a, [b[0], a[1]], b, [a[0], b[1]]], true);
}

/** Ellipse (radii `rx`, `ry`, rotated by `rotation` radians around the centre), closed, starting at angle 0. */
export function ellipsePoints(center: Vec, rx: number, ry: number, rotation = 0): Point[] {
	rx = Math.abs(rx);
	ry = Math.abs(ry);
	// Uniform in the angle, so the fastest part (speed = the larger radius) sets the density.
	const n = Math.max(24, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / SHAPE_STEP));
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	const out: Point[] = [];
	for (let i = 0; i < n; i++) {
		const t = (2 * Math.PI * i) / n;
		const x = rx * Math.cos(t);
		const y = ry * Math.sin(t);
		out.push(pt(center[0] + x * cos - y * sin, center[1] + x * sin + y * cos));
	}
	out.push([...out[0]!] as Point);
	return out;
}

export type ConstrainMode = "line" | "arrow" | "rect" | "ellipse";

/**
 * "Perfect" mode of the drag from `a` to `b` (modifier key): returns the adjusted end point.
 * line/arrow: direction snapped to 15° steps, length kept. rect/ellipse: equal sides (square/circle), the larger drag wins.
 * With `perfect` false, `b` is returned unchanged.
 */
export function constrain(a: Vec, b: Vec, mode: ConstrainMode, perfect = true): [number, number] {
	if (!perfect) return [b[0], b[1]];
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	if (mode === "line" || mode === "arrow") {
		const len = Math.hypot(dx, dy);
		const angle = Math.round(Math.atan2(dy, dx) / SNAP_ANGLE) * SNAP_ANGLE;
		const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
		return [a[0] + snap(len * Math.cos(angle)), a[1] + snap(len * Math.sin(angle))];
	}
	const m = Math.max(Math.abs(dx), Math.abs(dy));
	return [a[0] + (dx < 0 ? -m : m), a[1] + (dy < 0 ? -m : m)];
}
