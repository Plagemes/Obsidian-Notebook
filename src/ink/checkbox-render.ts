import type { CheckboxElement } from "../model/types";

/**
 * How a handwritten checkbox looks (v17, roadmap #103): one description of its shapes (`checkboxPaths`) that the canvas, the SVG and
 * the PDF export draw alike, so a checkbox on paper matches the one on screen. A rounded square outline and, when ticked, a tick
 * that overshoots the top-right corner the way a hand draws it. Vector, page coordinates, in the checkbox's own colour; no
 * 'obsidian', nothing allocated per frame beyond two small arrays.
 */

export type CheckboxPoint = readonly [number, number];

export interface CheckboxPath {
	points: readonly CheckboxPoint[];
	closed: boolean;
	/** Stroke width (pt). */
	width: number;
}

/** Corner radius as a share of the side. */
const CORNER = 0.2;
/** Points per rounded corner (the corner is a short polyline: enough to look round at checkbox size). */
const CORNER_STEPS = 3;

function roundedSquare(x: number, y: number, s: number): CheckboxPoint[] {
	const r = s * CORNER;
	const out: CheckboxPoint[] = [];
	// Corners clockwise from the top-left; each is an arc of a quarter circle.
	const corners: Array<[number, number, number]> = [[x + r, y + r, Math.PI], [x + s - r, y + r, -Math.PI / 2], [x + s - r, y + s - r, 0], [x + r, y + s - r, Math.PI / 2]];
	for (const [cx, cy, from] of corners) {
		for (let i = 0; i <= CORNER_STEPS; i++) {
			const a = from + ((Math.PI / 2) * i) / CORNER_STEPS;
			out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
		}
	}
	return out;
}

/** The outline, then (ticked) the tick. */
export function checkboxPaths(el: CheckboxElement): CheckboxPath[] {
	const s = el.size;
	const out: CheckboxPath[] = [{ points: roundedSquare(el.x, el.y, s), closed: true, width: Math.max(1.1, s * 0.085) }];
	if (el.checked === true) {
		out.push({
			points: [[el.x + s * 0.2, el.y + s * 0.55], [el.x + s * 0.42, el.y + s * 0.8], [el.x + s * 0.98, el.y + s * -0.08]],
			closed: false,
			width: Math.max(1.4, s * 0.13),
		});
	}
	return out;
}

/** Draws the checkbox in page coordinates (`color` replaces its own, for the night view). */
export function drawCheckbox(ctx: CanvasRenderingContext2D, el: CheckboxElement, color: string = el.color): void {
	ctx.save();
	try {
		ctx.strokeStyle = color;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		for (const p of checkboxPaths(el)) {
			ctx.lineWidth = p.width;
			ctx.beginPath();
			p.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
			if (p.closed) ctx.closePath();
			ctx.stroke();
		}
	} finally {
		ctx.restore();
	}
}
