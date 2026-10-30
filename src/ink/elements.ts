import { boxBounds, markerBounds, MARKER_BADGE } from "../model/markers";
import type { BoxElement, EquationElement, GraphElement, ImageElement, MarkerElement, PageElement, TextElement } from "../model/types";
import { scaleOutline } from "../math/outline";
import { EQUATION_OUTLINE_MAX, GRAPH_MAX_SIDE } from "../model/math-elements";
import { MAX_FONT_SIZE } from "../model/serialize";
import type { BBox } from "./hit-test";
import { pointInPolygon, type Polygon } from "./lasso";
import { estimateMeasure, textElementBounds, type MeasureText } from "./text-layout";
import { apply, scaleFactor, type Matrix } from "./transform";

export type { MeasureText } from "./text-layout";

const round2 = (v: number) => Math.round(v * 100) / 100;

function imageCorners(el: ImageElement): Array<[number, number]> {
	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const cos = Math.cos(el.rotation);
	const sin = Math.sin(el.rotation);
	const hw = el.width / 2;
	const hh = el.height / 2;
	return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(
		([dx, dy]): [number, number] => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos],
	);
}

/** Axis-aligned box of an element: text is laid out with `measure`; an image is its rotated rectangle's bounding box. */
export function elementBounds(el: PageElement, measure: MeasureText = estimateMeasure): BBox {
	if (el.type === "text") return textElementBounds(el, measure);
	if (el.type === "marker") return markerBounds(el);
	if (el.type === "box") return boxBounds(el);
	if (el.type === "equation") return equationBounds(el);
	if (el.type === "graph") return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
	const c = imageCorners(el);
	const xs = c.map((p) => p[0]);
	const ys = c.map((p) => p[1]);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function hits(el: PageElement, x: number, y: number, tolerance: number, measure: MeasureText): boolean {
	if (el.type === "marker" || el.type === "box" || el.type === "equation" || el.type === "graph") {
		const b = elementBounds(el, measure);
		return x >= b.minX - tolerance && x <= b.maxX + tolerance && y >= b.minY - tolerance && y <= b.maxY + tolerance;
	}
	if (el.type === "text") {
		const b = textElementBounds(el, measure);
		return x >= b.minX - tolerance && x <= b.maxX + tolerance && y >= b.minY - tolerance && y <= b.maxY + tolerance;
	}
	// Into the image's own (unrotated) frame, so the hit area follows the rotation.
	const dx = x - (el.x + el.width / 2);
	const dy = y - (el.y + el.height / 2);
	const cos = Math.cos(-el.rotation);
	const sin = Math.sin(-el.rotation);
	const lx = dx * cos - dy * sin;
	const ly = dx * sin + dy * cos;
	return Math.abs(lx) <= el.width / 2 + tolerance && Math.abs(ly) <= el.height / 2 + tolerance;
}

/** Topmost element (the last one in the array is drawn on top) under (x, y), with `tolerance` pt around it. */
export function hitElement(
	elements: readonly PageElement[], x: number, y: number, tolerance: number, measure: MeasureText = estimateMeasure,
): PageElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (hits(el, x, y, tolerance, measure)) return el;
	}
	return null;
}

/** Elements whose centre is inside the lasso, in array order. */
export function elementsInLasso(elements: readonly PageElement[], poly: Polygon, measure: MeasureText = estimateMeasure): PageElement[] {
	if (poly.length < 3) return [];
	return elements.filter((el) => {
		const b = elementBounds(el, measure);
		return pointInPolygon((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, poly);
	});
}

/** The scale factor of `m`, limited so that `fontSize` stays within what the format accepts (MAX_FONT_SIZE). */
function fontScale(m: Matrix, fontSize: number): number {
	return Math.min(scaleFactor(m), MAX_FONT_SIZE / Math.max(fontSize, 1e-9));
}

function transformText(el: TextElement, m: Matrix, measure: MeasureText): TextElement {
	const k = fontScale(m, el.fontSize);
	const fontSize = Math.min(MAX_FONT_SIZE, Math.max(1, round2(el.fontSize * k)));
	const width = Math.max(1, round2(el.width * k));
	// Text boxes cannot rotate or flip: with a plain move/scale the top-left corner is mapped; otherwise the box keeps its
	// orientation and follows the transformed centre.
	if (m[0] > 0 && m[3] > 0 && Math.abs(m[1]) + Math.abs(m[2]) < 1e-9) {
		const [x, y] = apply(m, el.x, el.y);
		return { ...el, x: round2(x), y: round2(y), width, fontSize };
	}
	const b = textElementBounds(el, measure);
	const [cx, cy] = apply(m, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
	const height = (b.maxY - b.minY) * k;
	return { ...el, x: round2(cx - width / 2), y: round2(cy - height / 2), width, fontSize };
}

function transformImage(el: ImageElement, m: Matrix): ImageElement {
	const [cx, cy] = apply(m, el.x + el.width / 2, el.y + el.height / 2);
	const width = Math.max(1, round2(el.width * Math.hypot(m[0], m[1])));
	const height = Math.max(1, round2(el.height * Math.hypot(m[2], m[3])));
	return {
		...el,
		x: round2(cx - width / 2),
		y: round2(cy - height / 2),
		width,
		height,
		rotation: Math.round((el.rotation + Math.atan2(m[1], m[0])) * 1e6) / 1e6,
	};
}

/** Corners of a rectangle mapped by `m`, as an axis-aligned box (markers and boxes never rotate). */
function mappedRect(x: number, y: number, w: number, h: number, m: Matrix): { x: number; y: number; width: number; height: number } {
	const pts = [apply(m, x, y), apply(m, x + w, y), apply(m, x, y + h), apply(m, x + w, y + h)];
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	return { x: round2(minX), y: round2(minY), width: Math.max(1, round2(Math.max(...xs) - minX)), height: Math.max(1, round2(Math.max(...ys) - minY)) };
}

/** v8 marker: its region follows the transform; a point marker moves its badge centre (the badge keeps its size). */
function transformMarker(el: MarkerElement, m: Matrix): MarkerElement {
	if (el.width !== undefined && el.height !== undefined) {
		const r = mappedRect(el.x, el.y, el.width, el.height, m);
		return { ...el, x: r.x, y: r.y, width: r.width, height: r.height };
	}
	const [cx, cy] = apply(m, el.x + MARKER_BADGE / 2, el.y + MARKER_BADGE / 2);
	return { ...el, x: round2(cx - MARKER_BADGE / 2), y: round2(cy - MARKER_BADGE / 2) };
}

function transformBox(el: BoxElement, m: Matrix): BoxElement {
	return { ...el, ...mappedRect(el.x, el.y, el.width, el.height, m) };
}

/** v9 equation box (the number, when there is one, is drawn outside it: see equationNumberBox). */
export function equationBounds(el: EquationElement): BBox {
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

/**
 * v9 equation: it never rotates; its box follows the transformed centre and scales uniformly with the font size, and
 * the cached outline scales with it (or is dropped if it cannot be read, to be typeset again).
 */
function transformEquation(el: EquationElement, m: Matrix): EquationElement {
	// The size never passes MAX_FONT_SIZE (the writer refuses more): a larger scale stops there.
	const k = fontScale(m, el.fontSize);
	const [cx, cy] = apply(m, el.x + el.width / 2, el.y + el.height / 2);
	const width = Math.max(1, round2(el.width * k));
	const height = Math.max(1, round2(el.height * k));
	const fontSize = Math.min(MAX_FONT_SIZE, Math.max(1, round2(el.fontSize * k)));
	const out: EquationElement = { ...el, x: round2(cx - width / 2), y: round2(cy - height / 2), width, height, fontSize };
	if (el.outline !== undefined && (width !== el.width || height !== el.height)) {
		// Scaled numbers can be longer: an outline the writer would refuse is dropped (the equation is typeset again).
		const scaled = scaleOutline(el.outline, width / el.width, height / el.height);
		if (scaled !== null && scaled.length <= EQUATION_OUTLINE_MAX) out.outline = scaled;
		else delete out.outline;
	}
	return out;
}

/** v9 graph: the frame follows the transform (as a box, never rotated); the viewport stays, so the curves stretch with it. */
function transformGraph(el: GraphElement, m: Matrix): GraphElement {
	const r = mappedRect(el.x, el.y, el.width, el.height, m);
	// The frame never grows past GRAPH_MAX_SIDE (the reader's limit, which also bounds the sampling work).
	return { ...el, ...r, width: Math.min(GRAPH_MAX_SIDE, r.width), height: Math.min(GRAPH_MAX_SIDE, r.height) };
}

/** New element moved/scaled/rotated by `m` (elements are immutable). Text scales font size and width uniformly. */
export function transformElement(el: PageElement, m: Matrix, measure: MeasureText = estimateMeasure): PageElement {
	if (el.type === "marker") return transformMarker(el, m);
	if (el.type === "box") return transformBox(el, m);
	if (el.type === "equation") return transformEquation(el, m);
	if (el.type === "graph") return transformGraph(el, m);
	return el.type === "text" ? transformText(el, m, measure) : transformImage(el, m);
}
