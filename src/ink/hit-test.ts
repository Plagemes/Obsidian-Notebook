import type { Stroke } from "../model/types";

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Stroke bounding box, grown by half the stroke width. */
export function strokeBounds(stroke: Stroke): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of stroke.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	const pad = stroke.width / 2;
	return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Minimum distance between segments AB and CD (0 if they intersect). */
export function segmentDistance(
	ax: number, ay: number, bx: number, by: number,
	cx: number, cy: number, dx: number, dy: number,
): number {
	const d1 = cross(cx, cy, dx, dy, ax, ay);
	const d2 = cross(cx, cy, dx, dy, bx, by);
	const d3 = cross(ax, ay, bx, by, cx, cy);
	const d4 = cross(ax, ay, bx, by, dx, dy);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
	return Math.min(
		pointSegmentDistance(ax, ay, cx, cy, dx, dy),
		pointSegmentDistance(bx, by, cx, cy, dx, dy),
		pointSegmentDistance(cx, cy, ax, ay, bx, by),
		pointSegmentDistance(dx, dy, ax, ay, bx, by),
	);
}

/**
 * Is the stroke touched by an eraser that moved from A to B with radius `radius` (pt)?
 * Testing the A→B segment, not just point B, avoids skipping strokes on fast movements.
 */
export function strokeHit(
	stroke: Stroke, ax: number, ay: number, bx: number, by: number, radius: number, bounds = strokeBounds(stroke),
): boolean {
	const reach = radius + stroke.width / 2;
	if (Math.max(ax, bx) + radius < bounds.minX || Math.min(ax, bx) - radius > bounds.maxX) return false;
	if (Math.max(ay, by) + radius < bounds.minY || Math.min(ay, by) - radius > bounds.maxY) return false;
	const pts = stroke.points;
	if (pts.length === 1) {
		const [x, y] = pts[0]!;
		return pointSegmentDistance(x, y, ax, ay, bx, by) <= reach;
	}
	for (let i = 1; i < pts.length; i++) {
		const [cx, cy] = pts[i - 1]!;
		const [dx, dy] = pts[i]!;
		if (segmentDistance(ax, ay, bx, by, cx, cy, dx, dy) <= reach) return true;
	}
	return false;
}

/** Strokes that were hit, in document order. `boundsOf` lets callers reuse a cache. */
export function findHitStrokes(
	strokes: readonly Stroke[], ax: number, ay: number, bx: number, by: number, radius: number,
	boundsOf: (s: Stroke) => BBox = strokeBounds,
): Stroke[] {
	return strokes.filter((s) => strokeHit(s, ax, ay, bx, by, radius, boundsOf(s)));
}
