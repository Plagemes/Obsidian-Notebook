import { quantizePoint } from "../model/document";
import type { Point, Stroke } from "../model/types";
import { strokeBounds, type BBox } from "./hit-test";
import { apply, scaleFactor, type Matrix } from "./transform";

export type Polygon = ReadonlyArray<readonly [number, number]>;

/** Even-odd point-in-polygon test. */
export function pointInPolygon(x: number, y: number, poly: Polygon): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i]!;
		const [xj, yj] = poly[j]!;
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** A stroke is selected when at least `share` of its points are inside the lasso. */
export function strokesInLasso(strokes: readonly Stroke[], poly: Polygon, share = 0.5): Stroke[] {
	if (poly.length < 3) return [];
	return strokes.filter((s) => {
		let inside = 0;
		for (const [x, y] of s.points) if (pointInPolygon(x, y, poly)) inside++;
		return inside > 0 && inside / s.points.length >= share;
	});
}

/**
 * Rectangle selection (roadmap 63): the four corners of the box dragged from `a` to `b` as a polygon, starting at the
 * anchor `a`. It is handed to the same selection code as a freehand lasso, so both modes pick the same things.
 */
export function rectanglePolygon(a: readonly [number, number], b: readonly [number, number]): Array<[number, number]> {
	return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
}

export function selectionBounds(strokes: readonly Stroke[]): BBox | null {
	if (strokes.length === 0) return null;
	return strokes.map(strokeBounds).reduce((a, b) => ({
		minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
	}));
}

/** A transformed copy of the stroke (same id, points quantized, width scaled with the matrix). */
export function transformStroke(stroke: Stroke, m: Matrix): Stroke {
	const k = scaleFactor(m);
	const points: Point[] = stroke.points.map(([x, y, p]) => {
		const [tx, ty] = apply(m, x, y);
		return quantizePoint(tx, ty, p);
	});
	const width = Math.max(0.1, Math.round(stroke.width * k * 100) / 100);
	return { ...stroke, width, points };
}
