import { createId, quantizePoint } from "../model/document";
import { RENDER_FREEHAND, type Point, type Stroke, type TextElement } from "../model/types";
import { recognizeShape } from "./recognize";
import { polygonPoints, ARROW_HEAD_ANGLE, SHAPE_PRESSURE, type Vec } from "./shapes";

/**
 * Instant axes (0.22, roadmap #206), the pure side, no 'obsidian', no DOM:
 *  - `axesFromL` / `axesFromCross`: is this stroke an "L", or are these two strokes a "+"? Both reuse the shape recogniser of the
 *    hold-to-snap feature (`recognizeShape`): every leg must be recognised as a straight line.
 *  - `buildAxes`: the plain vector strokes (shape ink, one polyline per arm with its ticks and arrowhead) and the small number labels
 *    (text boxes), all in one fresh group, ready to be added in one undo step.
 * Nothing is stored beyond what a drawing already is: no format change.
 */

/** Shortest leg of a gesture that counts (pt): a handwritten "L" or "+" is much smaller. */
export const AXES_MIN_LEG = 40;
/** Largest tilt of a leg from the horizontal or vertical that is still taken as an axis (degrees). */
const AXIS_TILT = (22 * Math.PI) / 180;
/** The two legs of an "L" meet at an angle within this many degrees of a right angle. */
const RIGHT_ANGLE = (24 * Math.PI) / 180;
/** The corner of an "L" is inside this share of the path (not at one end). */
const CORNER_BAND = [0.18, 0.82] as const;
/** The strokes of a "+" cross inside this share of both (from the start). */
const CROSS_BAND = [0.22, 0.78] as const;
/** The legs of an "L" differ in length by at most this factor. */
const LEG_RATIO = 3;

/** Axes: the origin and the length of each arm (pt, 0 = no arm), page coordinates; y grows downwards on the page, `up` points to smaller y. */
export interface AxesSpec {
	ox: number;
	oy: number;
	left: number;
	right: number;
	up: number;
	down: number;
}

export type AxesKind = "first" | "four";

const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The straight line a stroke is, as its two end points; null when the recogniser does not take it for a line. */
function lineEnds(points: readonly Point[]): [Vec, Vec] | null {
	const shape = recognizeShape(points);
	if (shape?.kind !== "line") return null;
	const p = shape.points[0];
	if (!p || p.length < 2) return null;
	const a = p[0]!;
	const b = p[p.length - 1]!;
	return [[a[0], a[1]], [b[0], b[1]]];
}

/** "horizontal" / "vertical" when the segment a → b is within AXIS_TILT of that axis, else null. */
function axisOf(a: Vec, b: Vec): "h" | "v" | null {
	const dx = Math.abs(b[0] - a[0]);
	const dy = Math.abs(b[1] - a[1]);
	if (dx === 0 && dy === 0) return null;
	const tilt = Math.atan2(Math.min(dx, dy), Math.max(dx, dy));
	if (tilt > AXIS_TILT) return null;
	return dx >= dy ? "h" : "v";
}

/** The point of the polyline farthest from the chord between its ends, with that distance and its index. */
function farthestFromChord(points: readonly Point[]): { index: number; d: number } {
	const a = points[0]!;
	const b = points[points.length - 1]!;
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
	let index = 0;
	let best = -1;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i]!;
		const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
		if (d > best) {
			best = d;
			index = i;
		}
	}
	return { index, d: best };
}

/** Share of the path length at which point `index` lies. */
function shareAt(points: readonly Point[], index: number): number {
	let total = 0;
	let upTo = 0;
	for (let i = 1; i < points.length; i++) {
		const d = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
		total += d;
		if (i <= index) upTo += d;
	}
	return total > 0 ? upTo / total : 0;
}

/**
 * The axes an "L" stroke draws: two straight legs, one horizontal and one vertical, at a right angle, each at least AXES_MIN_LEG
 * long and not wildly different in length. The origin is the corner; the arms run along the legs (an "L" gives the first quadrant),
 * and the legs are straightened to the exact axes. Null when the stroke is anything else (handwriting included).
 */
export function axesFromL(points: readonly Point[]): AxesSpec | null {
	if (points.length < 6) return null;
	const { index, d } = farthestFromChord(points);
	if (index <= 0 || d < AXES_MIN_LEG * 0.4) return null;
	const at = shareAt(points, index);
	if (at < CORNER_BAND[0] || at > CORNER_BAND[1]) return null;
	const first = lineEnds(points.slice(0, index + 1));
	const second = lineEnds(points.slice(index));
	if (!first || !second) return null;
	const corner: Vec = [points[index]![0], points[index]![1]];
	const a = first[0];
	const b = second[1];
	const la = dist(a, corner);
	const lb = dist(b, corner);
	if (la < AXES_MIN_LEG || lb < AXES_MIN_LEG) return null;
	if (Math.max(la, lb) / Math.min(la, lb) > LEG_RATIO) return null;
	const angle = Math.acos(Math.max(-1, Math.min(1, ((a[0] - corner[0]) * (b[0] - corner[0]) + (a[1] - corner[1]) * (b[1] - corner[1])) / (la * lb))));
	if (Math.abs(angle - Math.PI / 2) > RIGHT_ANGLE) return null;
	const ka = axisOf(corner, a);
	const kb = axisOf(corner, b);
	if (!ka || !kb || ka === kb) return null;
	const [h, hl, v, vl] = ka === "h" ? [a, la, b, lb] as const : [b, lb, a, la] as const;
	const spec: AxesSpec = { ox: corner[0], oy: corner[1], left: 0, right: 0, up: 0, down: 0 };
	if (h[0] >= corner[0]) spec.right = hl;
	else spec.left = hl;
	if (v[1] <= corner[1]) spec.up = vl;
	else spec.down = vl;
	return spec;
}

/**
 * The four-quadrant axes two strokes draw as a "+": two straight lines, one horizontal and one vertical, each at least AXES_MIN_LEG
 * long, that cross in the middle part of both. Null otherwise.
 */
export function axesFromCross(a: readonly Point[], b: readonly Point[]): AxesSpec | null {
	const la = lineEnds(a);
	const lb = lineEnds(b);
	if (!la || !lb) return null;
	const ka = axisOf(la[0], la[1]);
	const kb = axisOf(lb[0], lb[1]);
	if (!ka || !kb || ka === kb) return null;
	const [h, v] = ka === "h" ? [la, lb] : [lb, la];
	const hl = dist(h[0], h[1]);
	const vl = dist(v[0], v[1]);
	if (hl < AXES_MIN_LEG || vl < AXES_MIN_LEG) return null;
	// The horizontal line is crossed at the x of the vertical one, and the other way round.
	const x = (v[0][0] + v[1][0]) / 2;
	const y = (h[0][1] + h[1][1]) / 2;
	const hMin = Math.min(h[0][0], h[1][0]);
	const hMax = Math.max(h[0][0], h[1][0]);
	const vMin = Math.min(v[0][1], v[1][1]);
	const vMax = Math.max(v[0][1], v[1][1]);
	const sx = (x - hMin) / (hMax - hMin);
	const sy = (y - vMin) / (vMax - vMin);
	if (sx < CROSS_BAND[0] || sx > CROSS_BAND[1] || sy < CROSS_BAND[0] || sy > CROSS_BAND[1]) return null;
	return { ox: x, oy: y, left: x - hMin, right: hMax - x, up: y - vMin, down: vMax - y };
}

/** Whether the spec has all four arms (a "+") or one pair only (an "L"). */
export function axesKind(spec: AxesSpec): AxesKind {
	return spec.left > 0 && spec.right > 0 && spec.up > 0 && spec.down > 0 ? "four" : "first";
}

// ---------------------------------------------------------------- the drawing

/** Closest two ticks are drawn (pt): a denser page grid gives a tick every few cells. */
export const AXES_MIN_TICK_GAP = 14;
/** Most ticks on one arm. */
export const AXES_MAX_TICKS = 24;
/** Half the length of a tick, pt. */
const TICK_HALF = 2.6;
/** Length of the arrowhead wings, pt; the last tick stops this far before the tip. */
export const AXES_HEAD = 8;
/** A number label is drawn at most every this many pt along an arm. */
const LABEL_GAP = 24;
const LABEL_FONT = 9;
const LABEL_COLOUR_FALLBACK = "#444444";
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The tick spacing (pt) for a page: its grid or line spacing, multiplied up until two ticks are at least AXES_MIN_TICK_GAP apart.
 * A blank page (or any without a usable spacing) falls back to `fallback`.
 */
export function tickSpacing(paperSpacing: number | undefined, fallback = 14.17): number {
	const base = typeof paperSpacing === "number" && Number.isFinite(paperSpacing) && paperSpacing > 0 ? paperSpacing : fallback;
	return base * Math.max(1, Math.ceil(AXES_MIN_TICK_GAP / base - 1e-9));
}

export interface AxesOptions {
	/** Distance between ticks, pt (`tickSpacing`). */
	spacing: number;
	ticks: boolean;
	labels: boolean;
	color: string;
	width: number;
}

export interface AxesDrawing {
	strokes: Stroke[];
	texts: TextElement[];
	/** The group all of them are in. */
	group: string;
}

/** Number of ticks that fit an arm of this length. */
export function ticksOnArm(length: number, spacing: number): number {
	return Math.max(0, Math.min(AXES_MAX_TICKS, Math.floor((length - AXES_HEAD) / spacing)));
}

/** The length an arm gets: a whole number of ticks plus the room of the arrowhead when ticks are drawn, else the length drawn. */
export function armLength(length: number, spacing: number, ticks: boolean): number {
	if (length <= 0) return 0;
	const n = ticksOnArm(length, spacing);
	return ticks && n > 0 ? n * spacing + AXES_HEAD : length;
}

/** The vertices of one arm: out from the origin along `dir`, a tick (up, down, back) at each step, then the arrowhead at the tip. */
function armVertices(o: Vec, dir: Vec, length: number, spacing: number, ticks: boolean): Vec[] {
	const normal: Vec = [-dir[1], dir[0]];
	const out: Vec[] = [o];
	if (ticks) {
		const n = ticksOnArm(length, spacing);
		for (let k = 1; k <= n; k++) {
			const p: Vec = [o[0] + dir[0] * spacing * k, o[1] + dir[1] * spacing * k];
			out.push(p, [p[0] + normal[0] * TICK_HALF, p[1] + normal[1] * TICK_HALF], [p[0] - normal[0] * TICK_HALF, p[1] - normal[1] * TICK_HALF], p);
		}
	}
	const tip: Vec = [o[0] + dir[0] * length, o[1] + dir[1] * length];
	const back = Math.atan2(-dir[1], -dir[0]);
	out.push(
		tip,
		[tip[0] + AXES_HEAD * Math.cos(back + ARROW_HEAD_ANGLE), tip[1] + AXES_HEAD * Math.sin(back + ARROW_HEAD_ANGLE)],
		tip,
		[tip[0] + AXES_HEAD * Math.cos(back - ARROW_HEAD_ANGLE), tip[1] + AXES_HEAD * Math.sin(back - ARROW_HEAD_ANGLE)],
	);
	return out;
}

/** A number label as a text box centred on (cx, cy). */
function label(text: string, cx: number, cy: number, color: string, group: string, newId: () => string): TextElement {
	const width = Math.max(10, text.length * LABEL_FONT * 0.62 + 4);
	return { id: newId(), type: "text", x: round2(cx - width / 2), y: round2(cy - LABEL_FONT * 0.7), width: round2(width), text, fontSize: LABEL_FONT, color, group };
}

/**
 * The strokes and number labels of axes, in one fresh group. One shape-ink stroke per arm (ticks and arrowhead included); labels
 * count the ticks from the origin (right and up are positive, left and down negative), at
 * most one every LABEL_GAP pt. With one arm per axis there are still two strokes, so the group always has at least two members.
 */
export function buildAxes(spec: AxesSpec, opts: AxesOptions, newId: () => string = createId): AxesDrawing {
	const group = newId();
	const color = /^#[0-9a-fA-F]{6}$/.test(opts.color) ? opts.color : LABEL_COLOUR_FALLBACK;
	const o: Vec = [spec.ox, spec.oy];
	const arms: Array<{ dir: Vec; length: number; sign: 1 | -1; horizontal: boolean }> = [
		{ dir: [1, 0], length: spec.right, sign: 1, horizontal: true },
		{ dir: [-1, 0], length: spec.left, sign: -1, horizontal: true },
		{ dir: [0, -1], length: spec.up, sign: 1, horizontal: false },
		{ dir: [0, 1], length: spec.down, sign: -1, horizontal: false },
	];
	const strokes: Stroke[] = [];
	const texts: TextElement[] = [];
	const every = Math.max(1, Math.ceil(LABEL_GAP / opts.spacing));
	for (const arm of arms) {
		if (arm.length <= 0) continue;
		const length = armLength(arm.length, opts.spacing, opts.ticks);
		const verts = armVertices(o, arm.dir, length, opts.spacing, opts.ticks);
		const points: Point[] = polygonPoints(verts, false).map((p) => quantizePoint(p[0], p[1], SHAPE_PRESSURE));
		strokes.push({ id: newId(), tool: "shape", color, width: opts.width, render: RENDER_FREEHAND, group, points });
		if (opts.ticks && opts.labels) {
			const n = ticksOnArm(length, opts.spacing);
			for (let k = every; k <= n; k += every) {
				const px = o[0] + arm.dir[0] * opts.spacing * k;
				const py = o[1] + arm.dir[1] * opts.spacing * k;
				const text = `${arm.sign < 0 ? "−" : ""}${k}`;
				// Under the axis for x, left of it for y.
				texts.push(arm.horizontal ? label(text, px, py + TICK_HALF + LABEL_FONT * 0.9, color, group, newId) : label(text, px - TICK_HALF - 3 - (text.length * LABEL_FONT * 0.62) / 2, py, color, group, newId));
			}
		}
	}
	return { strokes, texts, group };
}

/** The axes of the "Axes" insert: four quadrants of `ticks` ticks each way, centred on (x, y), kept inside a page of this size. */
export function defaultAxes(x: number, y: number, spacing: number, page: { width: number; height: number }, ticks = 5): AxesSpec {
	const arm = ticks * spacing + AXES_HEAD;
	const half = Math.min(arm, Math.max(AXES_MIN_LEG, Math.min(page.width, page.height) / 2 - 6));
	const cx = Math.min(page.width - half - 4, Math.max(half + 4, x));
	const cy = Math.min(page.height - half - 4, Math.max(half + 4, y));
	return { ox: cx, oy: cy, left: half, right: half, up: half, down: half };
}
