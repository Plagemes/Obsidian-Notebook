import { RENDER_INK, type Point, type Stroke, type Tool } from "../model/types";
import { addInkPath, InkBuilder, SvgPathSink, type PathSink } from "./ink-geometry";
import { strokeOutline, strokeSvgPath } from "./stroke-shape";

/**
 * Level of detail for committed strokes (roadmap 387).
 *
 * When the page is drawn small, a handwriting stroke has far more detail than the screen can show.
 * The renderer then fills a simplified shape whose difference from the exact one is below
 * `LOD_TOLERANCE_PX` device px:
 * - render 1 (perfect-freehand): the outline is computed as usual, flattened and simplified with
 *   Douglas–Peucker into a polygon. (Decimating the *points* instead changes the shape a lot:
 *   perfect-freehand smooths by point index, so fewer points give a different, rounder curve.)
 * - render 2 (wet-ink geometry): the nodes of the exact geometry (discs along the curve, with their radius)
 *   are simplified with Douglas–Peucker, the radius error counted, and the committed path is built from the
 *   kept nodes.
 * The saved points are never changed: this is a drawing cache, the exact geometry is used again as soon
 * as the page is shown at normal zoom. Pure: no canvas, no 'obsidian'.
 */

/** Below this zoom (CSS px per pt, `Viewport.scale`) strokes are drawn simplified; at or above it, exactly. */
export const LOD_MAX_SCALE = 0.5;
/** The most the simplified stroke may differ from the exact one, in device px. */
export const LOD_TOLERANCE_PX = 0.5;
/**
 * Simplification tolerances (pt) of levels 1..4 (level 0 = exact). Doubling steps keep the number of
 * cached variants per stroke small: a level is the largest tolerance not above `LOD_TOLERANCE_PX` device px.
 */
export const LOD_TOLERANCES_PT: readonly number[] = [0.25, 0.5, 1, 2];
/** Strokes with fewer points than this are always drawn exactly. */
export const LOD_MIN_POINTS = 8;
/** A simplified shape is kept only if it has at most this share of the points (vertices); otherwise the exact path is used. */
export const LOD_MAX_KEPT = 0.8;
/**
 * Douglas–Peucker is run with a fraction of the allowed error, the rest is left to the flattening of the
 * outline (render 1) and to the straight links between kept nodes (render 2). Measured in tests/lod.test.ts.
 */
export const LOD_OUTLINE_SHARE = 0.8;
export const LOD_NODES_SHARE = 0.8;
/** Samples per quadratic piece when an outline is flattened for simplification. */
const FLATTEN_STEPS = 3;

/**
 * LOD level for a view: 0 (exact) at normal zoom, 1..4 when zoomed out. `scale` is CSS px per pt, `dpr` the
 * device pixel ratio. A level is used only if its tolerance stays within `LOD_TOLERANCE_PX` device px.
 */
export function lodLevel(scale: number, dpr: number): number {
	if (!(scale > 0) || !(dpr > 0) || scale >= LOD_MAX_SCALE) return 0;
	const allowed = LOD_TOLERANCE_PX / (scale * dpr); // pt
	let level = 0;
	for (let i = 0; i < LOD_TOLERANCES_PT.length; i++) {
		if (LOD_TOLERANCES_PT[i]! <= allowed) level = i + 1;
	}
	return level;
}

/** Tolerance (pt) of a level; 0 for the exact level. */
export function lodTolerance(level: number): number {
	return level > 0 ? (LOD_TOLERANCES_PT[Math.min(level, LOD_TOLERANCES_PT.length) - 1] ?? 0) : 0;
}

/**
 * The closed curve that `outlineToPath` draws (quadratic pieces through the midpoints of the outline, see
 * stroke-shape.ts), flattened into a flat [x0, y0, x1, y1, …] array.
 */
export function flattenOutline(outline: readonly number[][], steps = FLATTEN_STEPS): number[] {
	const n = outline.length;
	if (n < 3) return outline.flatMap((p) => [p[0]!, p[1]!]);
	const out: number[] = [];
	let cx = outline[0]![0]!, cy = outline[0]![1]!;
	let kx = outline[1]![0]!, ky = outline[1]![1]!;
	let ex = (kx + outline[2]![0]!) / 2, ey = (ky + outline[2]![1]!) / 2;
	const quad = () => {
		for (let k = 0; k < steps; k++) {
			const t = k / steps, u = 1 - t;
			out.push(u * u * cx + 2 * u * t * kx + t * t * ex, u * u * cy + 2 * u * t * ky + t * t * ey);
		}
	};
	quad();
	// "T" pieces: the control point is the previous one reflected about the previous end point.
	for (let i = 2; i < n - 1; i++) {
		const nkx = 2 * ex - kx, nky = 2 * ey - ky;
		cx = ex;
		cy = ey;
		kx = nkx;
		ky = nky;
		ex = (outline[i]![0]! + outline[i + 1]![0]!) / 2;
		ey = (outline[i]![1]! + outline[i + 1]![1]!) / 2;
		quad();
	}
	out.push(ex, ey);
	return out;
}

/** Douglas–Peucker on the run of vertices a..b of a closed flat xy array (b may be `count`, meaning vertex 0); marks the kept ones. */
function dpRun(xy: readonly number[], a0: number, b0: number, tol: number, keep: Uint8Array, count: number): void {
	const stack: number[] = [a0, b0];
	while (stack.length > 0) {
		const b = stack.pop()!;
		const a = stack.pop()!;
		if (b - a < 2) continue;
		const ax = xy[2 * a]!, ay = xy[2 * a + 1]!;
		const bx = xy[2 * (b % count)]!, by = xy[2 * (b % count) + 1]!;
		const dx = bx - ax, dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let worst = -1;
		let worstErr = tol;
		for (let i = a + 1; i < b; i++) {
			const px = xy[2 * i]!, py = xy[2 * i + 1]!;
			let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			const err = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			if (err > worstErr) {
				worstErr = err;
				worst = i;
			}
		}
		if (worst < 0) continue;
		keep[worst] = 1;
		stack.push(a, worst, worst, b);
	}
}

/** Douglas–Peucker for a closed polygon given as a flat xy array: anchored at vertex 0 and the vertex farthest from it. */
export function simplifyRing(xy: readonly number[], tolerance: number): number[] {
	const count = xy.length / 2;
	if (count <= 3) return xy.slice();
	let far = 1;
	let farD = -1;
	for (let i = 1; i < count; i++) {
		const d = Math.hypot(xy[2 * i]! - xy[0]!, xy[2 * i + 1]! - xy[1]!);
		if (d > farD) {
			farD = d;
			far = i;
		}
	}
	const keep = new Uint8Array(count);
	keep[0] = 1;
	keep[far] = 1;
	dpRun(xy, 0, far, tolerance, keep, count);
	dpRun(xy, far, count, tolerance, keep, count);
	const out: number[] = [];
	for (let i = 0; i < count; i++) if (keep[i]) out.push(xy[2 * i]!, xy[2 * i + 1]!);
	return out;
}

/**
 * Simplified outline polygon (flat xy, to be filled with `moveTo`, `lineTo`s and a close) of a
 * perfect-freehand stroke for `level` >= 1, or null when the exact path should be used. `width` is the width to draw with.
 */
export function lodPolygon(points: readonly Point[], width: number, tool: Tool, level: number): number[] | null {
	if (level <= 0 || points.length < LOD_MIN_POINTS) return null;
	const outline = strokeOutline(points, width, true, tool);
	if (outline.length < 3) return null;
	const poly = simplifyRing(flattenOutline(outline), lodTolerance(level) * LOD_OUTLINE_SHARE);
	return poly.length / 2 > outline.length * LOD_MAX_KEPT ? null : poly;
}

/**
 * Simplified nodes (flat x, y, r triples) of the wet-ink geometry of a render-2 stroke for `level` >= 1, or
 * null when the exact path should be used. The error of a node is its distance from the chord between the kept
 * neighbours plus the difference of its radius from the chord's: the outline of the discs moves by no more.
 */
export function lodNodes(points: readonly Point[], width: number, tool: Tool, level: number): number[] | null {
	if (level <= 0 || points.length < LOD_MIN_POINTS) return null;
	const g = InkBuilder.fromPoints(points, width, tool, scratch);
	const n = g.nodeCount;
	if (n < 3) return null;
	const { nx, ny, nr } = g;
	const tol = lodTolerance(level) * LOD_NODES_SHARE;
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const stack: number[] = [0, n - 1];
	while (stack.length > 0) {
		const b = stack.pop()!;
		const a = stack.pop()!;
		if (b - a < 2) continue;
		const ax = nx[a]!, ay = ny[a]!, bx = nx[b]!, by = ny[b]!;
		const dx = bx - ax, dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let worst = -1;
		let worstErr = tol;
		for (let i = a + 1; i < b; i++) {
			let t = len2 === 0 ? 0 : ((nx[i]! - ax) * dx + (ny[i]! - ay) * dy) / len2;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			const err = Math.hypot(nx[i]! - (ax + t * dx), ny[i]! - (ay + t * dy)) + Math.abs(nr[i]! - (nr[a]! + (nr[b]! - nr[a]!) * t));
			if (err > worstErr) {
				worstErr = err;
				worst = i;
			}
		}
		if (worst < 0) continue;
		keep[worst] = 1;
		stack.push(a, worst, worst, b);
	}
	const out: number[] = [];
	let kept = 0;
	for (let i = 0; i < n; i++) {
		if (!keep[i]) continue;
		out.push(nx[i]!, ny[i]!, nr[i]!);
		kept++;
	}
	return kept > n * LOD_MAX_KEPT ? null : out;
}

const scratch = new InkBuilder();
const outBuilder = new InkBuilder();

/** Adds the committed path of simplified nodes (from `lodNodes`) to `sink`: the same construction as the exact path. */
export function addLodNodesPath(sink: PathSink, nodes: readonly number[]): void {
	const n = nodes.length / 3;
	const g = outBuilder;
	if (g.nx.length < n) {
		g.nx = new Float64Array(n);
		g.ny = new Float64Array(n);
		g.nr = new Float64Array(n);
	}
	for (let i = 0; i < n; i++) {
		g.nx[i] = nodes[3 * i]!;
		g.ny[i] = nodes[3 * i + 1]!;
		g.nr[i] = nodes[3 * i + 2]!;
	}
	g.nodeCount = n;
	addInkPath(sink, g);
}

/** SVG path (nonzero fill) of a flat xy polygon. */
export function polygonSvgPath(xy: readonly number[]): string {
	const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
	let d = "";
	for (let i = 0; i < xy.length; i += 2) d += `${i === 0 ? "M" : "L"}${fmt(xy[i]!)} ${fmt(xy[i + 1]!)}`;
	return d + "Z";
}

/**
 * SVG path of a stroke for LOD `level` at `width` (for one-off drawing such as thumbnails, where the width can
 * differ from the stroke's); the exact path when there is nothing to simplify.
 */
export function lodSvgPath(stroke: Pick<Stroke, "points" | "width" | "tool" | "render">, width: number, level: number): string {
	if (stroke.render === RENDER_INK) {
		const nodes = lodNodes(stroke.points, width, stroke.tool, level);
		if (!nodes) return strokeSvgPath({ ...stroke, width });
		const sink = new SvgPathSink();
		addLodNodesPath(sink, nodes);
		return sink.d;
	}
	const poly = lodPolygon(stroke.points, width, stroke.tool, level);
	return poly ? polygonSvgPath(poly) : strokeSvgPath({ ...stroke, width });
}
