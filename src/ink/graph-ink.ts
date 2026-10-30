/**
 * Ink written on a function graph (#113) follows the graph's coordinates. Moving or scaling the frame already carries
 * it (ink attached to objects, ink/attach.ts: the same matrix transforms the frame and the ink). Panning or zooming
 * inside the graph changes which part of the plane the frame shows; the ink on it then moves by the matrix that maps
 * a point of the plane from where it was drawn to where it is drawn now, so a note written next to a root stays next
 * to that root. Pure: no 'obsidian'.
 */
import { quantizePoint } from "../model/document";
import { Batch, ReplaceElement, ReplaceStroke, type Command } from "../model/history";
import { isViewport } from "../model/math-elements";
import { freezeStroke } from "../model/serialize";
import type { GraphElement, GraphViewport, Page, Point, Stroke } from "../model/types";
import { attachedInk } from "./attach";
import type { MeasureText } from "./text-layout";
import { apply, type Matrix } from "./transform";

type Frame = Pick<GraphElement, "x" | "y" | "width" | "height" | "view">;

/** Page → page matrix taking a point drawn on graph `before` to the same graph point drawn on graph `after`. */
export function graphViewMatrix(before: Frame, after: Frame): Matrix {
	const b = before.view, a = after.view;
	// page = x + (gx − xMin)·kx, gy from page: gx = xMin + (px − x)/kx.
	const kxB = before.width / (b.xMax - b.xMin), kyB = before.height / (b.yMax - b.yMin);
	const kxA = after.width / (a.xMax - a.xMin), kyA = after.height / (a.yMax - a.yMin);
	const sx = kxA / kxB;
	const sy = kyA / kyB;
	// px' = after.x + (b.xMin + (px − before.x)/kxB − a.xMin)·kxA
	const ex = after.x + (b.xMin - a.xMin) * kxA - before.x * sx;
	// py' = after.y + (a.yMax − gy)·kyA with gy = b.yMax − (py − before.y)/kyB
	const fy = after.y + (a.yMax - b.yMax) * kyA - before.y * sy;
	return [sx, 0, 0, sy, ex, fy];
}

/** The viewport moved by (dx, dy) pt of the frame (a drag: the plane follows the finger). */
export function panView(g: Frame, dx: number, dy: number): GraphViewport {
	const v = g.view;
	const gx = (dx * (v.xMax - v.xMin)) / g.width;
	const gy = (dy * (v.yMax - v.yMin)) / g.height;
	const out = { xMin: v.xMin - gx, xMax: v.xMax - gx, yMin: v.yMin + gy, yMax: v.yMax + gy };
	return isViewport(out) ? out : v;
}

/**
 * The viewport zoomed by `factor` (> 1 zooms in) about the page point (px, py) inside the frame; `axis` limits the
 * zoom to one axis.
 */
export function zoomView(g: Frame, factor: number, px: number, py: number, axis: "both" | "x" | "y" = "both"): GraphViewport {
	const v = g.view;
	const cx = v.xMin + ((px - g.x) / g.width) * (v.xMax - v.xMin);
	const cy = v.yMax - ((py - g.y) / g.height) * (v.yMax - v.yMin);
	const fx = axis === "y" ? 1 : factor;
	const fy = axis === "x" ? 1 : factor;
	const out = {
		xMin: cx - (cx - v.xMin) / fx, xMax: cx + (v.xMax - cx) / fx,
		yMin: cy - (cy - v.yMin) / fy, yMax: cy + (v.yMax - cy) / fy,
	};
	return isViewport(out) ? out : v;
}

/** A stroke moved by `m` (positions only: the pen width stays, so notes stay readable at any zoom). */
export function moveStroke(s: Stroke, m: Matrix): Stroke {
	const points: Point[] = s.points.map(([x, y, p]) => {
		const [tx, ty] = apply(m, x, y);
		return quantizePoint(tx, ty, p);
	});
	return freezeStroke({ ...s, points });
}

/** Strokes of `page` written on `graph` (the ink-attached-to-objects rule). */
export function inkOnGraph(page: Page, graph: GraphElement, measure?: MeasureText): Stroke[] {
	return attachedInk(page.strokes, page.elements ?? [], [graph], new Set(), measure);
}

/**
 * One undo step replacing `before` with `after` and moving `ink` (the strokes that were on `before`) so they keep
 * their graph coordinates. Null when nothing changes.
 */
export function graphEditCommand(page: Page, before: GraphElement, after: GraphElement, ink: readonly Stroke[], label = "Edit graph"): Command | null {
	if (before === after) return null;
	const commands: Command[] = [new ReplaceElement(page.id, before, after)];
	const m = graphViewMatrix(before, after);
	const identity = Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[3] - 1) < 1e-12 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;
	if (!identity) {
		for (const s of ink) {
			const i = page.strokes.indexOf(s);
			if (i >= 0) commands.push(new ReplaceStroke(page.id, s, [moveStroke(s, m)], i));
		}
	}
	return new Batch(label, commands);
}
