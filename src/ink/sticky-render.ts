import { blend, STICKY_ICON, STICKY_PADDING, stickyColours } from "../model/sticky";
import type { StickyElement } from "../model/types";
import { layoutText } from "./text-layout";

/**
 * How a sticky note looks (v15, roadmap #20): one description of its shapes (`stickyShapes`) that the canvas, the SVG and the
 * PDF export draw alike, so a note on paper matches the note on screen. A paper-coloured square with a folded bottom-right
 * corner, a darker band along its top edge and a soft shadow; a collapsed note is the same shape as a small icon with two
 * lines of "writing" on it. Vector, page coordinates, no 'obsidian', nothing allocated per frame beyond a few small arrays.
 * The typed text is laid out by the caller's measure (`drawStickyText`) or by Helvetica metrics (the PDF).
 */

export type StickyPoint = readonly [number, number];

export type StickyShape =
	| { kind: "poly"; points: readonly StickyPoint[]; fill: string; alpha: number }
	| { kind: "rect"; x: number; y: number; width: number; height: number; fill: string; alpha: number };
// Only the shadow is translucent (alpha < 1); every other shape is a solid colour, so the PDF can leave the shadow out.

/** Font used for the typed text of a note on screen (the same as the text boxes). */
export const STICKY_FONT = "sans-serif";

const SHADOW_DX = 1.2;
const SHADOW_DY = 2.2;

/** The corner that is folded over, and the band along the top, for a note of this size (pt). */
function sizes(side: number): { fold: number; band: number } {
	return { fold: Math.max(4, Math.min(16, side * 0.11)), band: Math.max(3, Math.min(9, side * 0.07)) };
}

/** The outline of the note: its box without the folded bottom-right corner. */
function outline(x: number, y: number, w: number, h: number, fold: number): StickyPoint[] {
	return [[x, y], [x + w, y], [x + w, y + h - fold], [x + w - fold, y + h], [x, y + h]];
}

/** The box the typed text is laid out in (page coordinates), below the band and inside the padding. */
export function stickyTextBox(el: StickyElement): { x: number; y: number; width: number; height: number } {
	const { band } = sizes(Math.min(el.width, el.height));
	const pad = STICKY_PADDING * Math.min(1, Math.min(el.width, el.height) / 120 + 0.35);
	return { x: el.x + pad, y: el.y + band + pad * 0.6, width: Math.max(1, el.width - 2 * pad), height: Math.max(1, el.height - band - pad * 1.6) };
}

/** The shapes of a note, back to front (shadow, paper, band, folded corner; for an icon the two lines of writing too). Day colours unless `night`. */
export function stickyShapes(el: StickyElement, night = false): StickyShape[] {
	const c = stickyColours(el.color, night);
	if (el.collapsed) {
		const s = STICKY_ICON;
		const { fold, band } = sizes(s);
		const out: StickyShape[] = [
			{ kind: "poly", points: outline(el.x + SHADOW_DX * 0.6, el.y + SHADOW_DY * 0.6, s, s, fold), fill: "#000000", alpha: 0.18 },
			{ kind: "poly", points: outline(el.x, el.y, s, s, fold), fill: c.paper, alpha: 1 },
			{ kind: "rect", x: el.x, y: el.y, width: s, height: band, fill: blend(c.edge, c.paper, 0.55), alpha: 1 },
			{ kind: "poly", points: [[el.x + s - fold, el.y + s], [el.x + s, el.y + s - fold], [el.x + s - fold, el.y + s - fold]], fill: c.fold, alpha: 1 },
		];
		const line = (i: number, w: number) => out.push({ kind: "rect", x: el.x + 5, y: el.y + band + 4 + i * 4.5, width: w, height: 1.5, fill: blend(c.text, c.paper, 0.4), alpha: 1 });
		line(0, s - 10);
		line(1, (s - 10) * 0.6);
		return out;
	}
	const { fold, band } = sizes(Math.min(el.width, el.height));
	return [
		{ kind: "poly", points: outline(el.x + SHADOW_DX, el.y + SHADOW_DY, el.width, el.height, fold), fill: "#000000", alpha: 0.16 },
		{ kind: "poly", points: outline(el.x, el.y, el.width, el.height, fold), fill: c.paper, alpha: 1 },
		{ kind: "rect", x: el.x, y: el.y, width: el.width, height: band, fill: blend(c.edge, c.paper, 0.5), alpha: 1 },
		{ kind: "poly", points: [[el.x + el.width - fold, el.y + el.height], [el.x + el.width, el.y + el.height - fold], [el.x + el.width - fold, el.y + el.height - fold]], fill: c.fold, alpha: 1 },
	];
}

/** Draws a note (and the text typed on it) in page coordinates; the ink written on it is drawn by the page, above. */
export function drawSticky(ctx: CanvasRenderingContext2D, el: StickyElement, night = false): void {
	ctx.save();
	try {
		for (const s of stickyShapes(el, night)) {
			ctx.globalAlpha = s.alpha;
			ctx.fillStyle = s.fill;
			if (s.kind === "rect") ctx.fillRect(s.x, s.y, s.width, s.height);
			else {
				ctx.beginPath();
				s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
				ctx.closePath();
				ctx.fill();
			}
		}
		ctx.globalAlpha = 1;
		if (!el.collapsed && el.text) drawStickyText(ctx, el, night);
	} finally {
		ctx.restore();
	}
}

/** The typed text of a note, wrapped to its box and clipped to it. */
export function drawStickyText(ctx: CanvasRenderingContext2D, el: StickyElement, night = false): void {
	if (!el.text) return;
	const box = stickyTextBox(el);
	ctx.save();
	try {
		ctx.beginPath();
		ctx.rect(box.x, box.y, box.width, box.height);
		ctx.clip();
		ctx.font = `${el.fontSize}px ${STICKY_FONT}`;
		ctx.fillStyle = stickyColours(el.color, night).text;
		ctx.textBaseline = "top";
		const layout = layoutText(el.text, el.fontSize, box.width, (s) => ctx.measureText(s).width);
		for (let i = 0; i < layout.lines.length; i++) {
			const top = box.y + i * layout.lineHeight;
			if (top > box.y + box.height) break;
			ctx.fillText(layout.lines[i]!, box.x, top + (layout.lineHeight - el.fontSize) / 2);
		}
	} finally {
		ctx.restore();
	}
}
