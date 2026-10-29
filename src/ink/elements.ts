import type { ImageElement, PageElement, TextElement } from "../model/types";
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
	const c = imageCorners(el);
	const xs = c.map((p) => p[0]);
	const ys = c.map((p) => p[1]);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function hits(el: PageElement, x: number, y: number, tolerance: number, measure: MeasureText): boolean {
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

function transformText(el: TextElement, m: Matrix, measure: MeasureText): TextElement {
	const k = scaleFactor(m);
	const fontSize = Math.max(1, round2(el.fontSize * k));
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

/** New element moved/scaled/rotated by `m` (elements are immutable). Text scales font size and width uniformly. */
export function transformElement(el: PageElement, m: Matrix, measure: MeasureText = estimateMeasure): PageElement {
	return el.type === "text" ? transformText(el, m, measure) : transformImage(el, m);
}
