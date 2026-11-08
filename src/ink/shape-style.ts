import type { Point, ShapeDash, Stroke } from "../model/types";
import { isShapeTool } from "../model/types";

/**
 * Filled shapes and dashed or dotted lines (format v22, roadmap #37). Pure geometry shared by the canvas, the PNG, the SVG, the PDF and the
 * thumbnails, so a shape looks the same everywhere. Does not import 'obsidian'.
 *
 * A stroke of the shape tool is a polyline of points drawn as one outline (perfect-freehand). A DASHED or DOTTED one is the same polyline cut into
 * runs by arc length, each run drawn as its own outline (round caps), so every path builder only has to ask for the runs. A FILL is the polygon through
 * the points of a closed shape, painted under the line.
 */

/** Opacity of a "tint" fill (a translucent wash of the colour: the ink and the paper pattern stay readable through it). */
export const FILL_TINT_ALPHA = 0.25;

/** The dash pattern never uses a line thinner than this (pt), so a hairline still shows clear dashes. */
export const DASH_MIN_UNIT = 1.5;
/** Length of the run that makes a dot (pt): the round caps do the rest. */
export const DOT_RUN = 0.05;
/** A closed shape ends at its start within this distance (pt). */
export const CLOSE_TOLERANCE = 1;
/** More runs than this and the stroke is drawn solid (a safeguard against a huge shape with a fine pattern). */
export const MAX_DASH_RUNS = 6000;

/**
 * The pattern of a line style for a line `width` pt wide: the length of a run and of the gap, measured between the run's centre-line ends (the round caps
 * add half the width at each end of a run and take as much from the gap). It scales with the width. Dashed: runs of three widths, gaps of three; dotted:
 * a dot every two widths.
 */
export function dashPattern(dash: ShapeDash, width: number): { on: number; off: number } {
	const unit = Math.max(width, DASH_MIN_UNIT);
	return dash === "dashed" ? { on: 3 * unit, off: 3 * unit } : { on: DOT_RUN, off: 2 * unit };
}

/** The runs of `points` for a dashed or dotted line `width` pt wide: sub-polylines in order, the pattern starting at the first point. */
export function dashRuns(points: readonly Point[], dash: ShapeDash, width: number): Point[][] {
	if (points.length < 2) return [points.slice()];
	const { on, off } = dashPattern(dash, width);
	const runs: Point[][] = [];
	let cur: Point[] | null = [points[0]!];
	let left = on;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!;
		const b = points[i]!;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (len < 1e-9) continue;
		let pos = 0;
		while (len - pos > 1e-9) {
			const step = Math.min(left, len - pos);
			pos += step;
			left -= step;
			const t = pos / len;
			const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2]];
			if (cur) cur.push(p);
			if (left <= 1e-9) {
				if (cur) {
					runs.push(cur);
					cur = null;
					left = off;
					if (runs.length > MAX_DASH_RUNS) return [points.slice()];
				} else {
					cur = [p];
					left = on;
				}
			}
		}
	}
	if (cur && cur.length >= 2) runs.push(cur);
	return runs;
}

/** Does the line of this stroke follow a dash pattern? (Only the shape tool has one.) */
export function isDashed(stroke: Pick<Stroke, "tool" | "dash">): boolean {
	return stroke.dash !== undefined && isShapeTool(stroke.tool);
}

/** Is the polyline closed (a rectangle, an ellipse, a triangle: it ends where it starts)? Needs at least three distinct corners. */
export function isClosedShape(points: readonly Point[]): boolean {
	if (points.length < 4) return false;
	const a = points[0]!;
	const b = points[points.length - 1]!;
	return Math.hypot(a[0] - b[0], a[1] - b[1]) <= CLOSE_TOLERANCE;
}

/** Is this stroke drawn with a fill? A closed shape-tool stroke that has a fill colour. */
export function isFilled(stroke: Pick<Stroke, "tool" | "fill"> & { points: readonly Point[] }): boolean {
	return stroke.fill !== undefined && isShapeTool(stroke.tool) && isClosedShape(stroke.points);
}

/** Opacity of the fill of `stroke` in the day look: solid, or the tint. */
export function fillAlpha(stroke: Pick<Stroke, "fillTint">): number {
	return stroke.fillTint === true ? FILL_TINT_ALPHA : 1;
}

/** SVG path (nonzero) of the polygon through the points of a closed shape: the area its fill covers. */
export function fillPathD(points: readonly Point[]): string {
	const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
	let d = "";
	for (let i = 0; i < points.length; i++) d += `${i === 0 ? "M" : "L"}${fmt(points[i]![0])} ${fmt(points[i]![1])}`;
	return d + "Z";
}

/** Is page point (x, y) inside the closed polygon of `points` (even-odd)? The interior a filled shape is picked by. */
export function insideShape(points: readonly Point[], x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [xi, yi] = points[i]!;
		const [xj, yj] = points[j]!;
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * The style fields a NEW shape is stored with: the fill (only a closed shape has one: `fillColor` null follows the line colour `color`) and the line
 * style (absent = solid). Nothing is written for a plain shape, so a shape drawn with the defaults is the same as before v22.
 */
export function newShapeStyle(
	points: readonly Point[], color: string, fill: "none" | "solid" | "tint", fillColor: string | null, line: "solid" | ShapeDash,
): Pick<Stroke, "fill" | "fillTint" | "dash"> {
	const out: Pick<Stroke, "fill" | "fillTint" | "dash"> = {};
	if (fill !== "none" && isClosedShape(points)) {
		out.fill = (fillColor ?? color).toLowerCase();
		if (fill === "tint") out.fillTint = true;
	}
	if (line !== "solid") out.dash = line;
	return out;
}
