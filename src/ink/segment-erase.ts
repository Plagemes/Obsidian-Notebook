import { RENDER_INK, type Point, type Stroke } from "../model/types";
import { inkCurveAt } from "./ink-geometry";
import { pointSegmentDistance, strokeHit, type BBox } from "./hit-test";

/**
 * Segment eraser: removes the parts of a stroke within `radius` of the eraser's movement A→B
 * and returns the remaining runs of points, or null if the stroke was not touched.
 *
 * Long segments are subdivided first, so a gap between two distant points cannot hide a cut. For
 * render-2 strokes the inserted points lie on the curve the ink geometry draws (not on the chord),
 * so the pieces left by a cut keep the shape of the original.
 * Runs shorter than 2 points are dropped (they would render as stray dots), except for strokes
 * that were a single dot to begin with.
 */
export function eraseSegment(
	stroke: Stroke, ax: number, ay: number, bx: number, by: number, radius: number, bounds?: BBox,
): Point[][] | null {
	if (!strokeHit(stroke, ax, ay, bx, by, radius, bounds)) return null;
	const reach = radius + stroke.width / 2;
	const dense = densify(stroke.points, Math.max(radius / 2, 0.25), stroke.render === RENDER_INK);
	const runs: Point[][] = [];
	let run: Point[] = [];
	for (const p of dense) {
		if (pointSegmentDistance(p[0], p[1], ax, ay, bx, by) <= reach) {
			if (run.length) runs.push(run);
			run = [];
		} else {
			run.push(p);
		}
	}
	if (run.length) runs.push(run);
	// Within reach of the bounding test but no point actually touched: nothing to cut.
	if (runs.length === 1 && runs[0]!.length === dense.length) return null;
	const minLength = stroke.points.length === 1 ? 1 : 2;
	return runs.filter((r) => r.length >= minLength);
}

/**
 * Inserts interpolated points (with interpolated pressure) so no segment is longer than `step`.
 * Straight between the points by default; with `curved`, along the render-2 ink curve.
 */
export function densify(points: readonly Point[], step: number, curved = false): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < points.length; i++) {
		const p = points[i]!;
		if (i > 0) {
			const q = points[i - 1]!;
			const n = Math.floor(Math.hypot(p[0] - q[0], p[1] - q[1]) / step);
			for (let k = 1; k < n; k++) {
				const t = k / n;
				const [cx, cy] = curved ? inkCurveAt(points, i - 1, t) : [q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t];
				out.push([
					Math.round(cx * 100) / 100,
					Math.round(cy * 100) / 100,
					Math.round((q[2] + (p[2] - q[2]) * t) * 1000) / 1000,
				]);
			}
		}
		out.push([p[0], p[1], p[2]]);
	}
	return out;
}
