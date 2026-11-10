import type { TapeElement } from "../model/types";

/**
 * How a study tape (v27, roadmap #10) looks. A hidden tape is an opaque strip in its colour with a darker edge and a few faint diagonal
 * stripes (the look of paper tape), drawn above all the ink so nothing under it shows. A revealed tape (view-only) leaves the page readable:
 * only a faint tint and a dashed outline in its colour, so it can be found and tapped again to hide what it covers.
 *
 * The canvas, the PNG raster and the thumbnails use `drawTape`; the SVG and the PDF exports write the same fill and edge from `tapeEdge`.
 * No 'obsidian' import, nothing allocated per call but the stripe loop.
 */

/** Width of the edge line, pt. */
export const TAPE_EDGE = 0.75;
/** Distance between two stripes, pt. */
const STRIPE_GAP = 9;
/** No more stripes than this on one tape (a huge tape keeps a cheap draw). */
const STRIPES_MAX = 160;
/** Opacity of the tint of a revealed tape in the view. */
const REVEALED_TINT = 0.14;

const HEX = /^#([0-9a-f]{6})$/i;

/** `a` mixed with `b` (both `#rrggbb`), `t` of the way to `b`; `a` itself when either is not a colour. */
export function mixHex(a: string, b: string, t: number): string {
	const ma = HEX.exec(a);
	const mb = HEX.exec(b);
	if (!ma || !mb) return a;
	const va = parseInt(ma[1]!, 16);
	const vb = parseInt(mb[1]!, 16);
	const ch = (v: number, shift: number) => (v >> shift) & 255;
	const mix = (shift: number) => Math.round(ch(va, shift) + (ch(vb, shift) - ch(va, shift)) * t);
	return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

/** The edge colour of a tape: its colour a little darker. */
export function tapeEdge(color: string): string {
	return mixHex(color, "#000000", 0.22);
}

/** The colour a tape is drawn in at night (darker, so it does not glare on a dark page; still clearly a tape). */
export function nightTape(color: string): string {
	return mixHex(color, "#1b1d22", 0.45);
}

export interface TapeLook {
	/** Revealed in the view: only the tint and the dashed outline. Default false (hidden: the opaque strip). */
	revealed?: boolean;
	/** Night mode of the view. */
	night?: boolean;
	/** Canvas px per pt (the dashed outline of a revealed tape stays a hairline at any zoom). Default 1. */
	scale?: number;
}

/** Draws `el` (page coordinates) on `ctx`. The caller saves and restores the context state. */
export function drawTape(ctx: CanvasRenderingContext2D, el: TapeElement, look: TapeLook = {}): void {
	const color = look.night ? nightTape(el.color) : el.color;
	const { x, y, width: w, height: h } = el;
	if (look.revealed) {
		const px = 1 / Math.max(0.05, look.scale ?? 1);
		ctx.globalAlpha = REVEALED_TINT;
		ctx.fillStyle = color;
		ctx.fillRect(x, y, w, h);
		ctx.globalAlpha = 1;
		ctx.strokeStyle = tapeEdge(color);
		ctx.lineWidth = 1.25 * px;
		ctx.setLineDash([5 * px, 4 * px]);
		ctx.strokeRect(x, y, w, h);
		ctx.setLineDash([]);
		return;
	}
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "source-over";
	ctx.fillStyle = color;
	ctx.fillRect(x, y, w, h);
	// Faint diagonal stripes, clipped to the strip: it reads as tape, not as a hole in the page.
	ctx.save();
	ctx.beginPath();
	ctx.rect(x, y, w, h);
	ctx.clip();
	ctx.strokeStyle = mixHex(color, "#ffffff", 0.35);
	ctx.globalAlpha = 0.55;
	ctx.lineWidth = 2;
	ctx.beginPath();
	const span = w + h;
	const step = Math.max(STRIPE_GAP, span / STRIPES_MAX);
	for (let d = step / 2; d < span; d += step) {
		ctx.moveTo(x + d, y);
		ctx.lineTo(x + d - h, y + h);
	}
	ctx.stroke();
	ctx.restore();
	ctx.globalAlpha = 1;
	ctx.strokeStyle = tapeEdge(color);
	ctx.lineWidth = TAPE_EDGE;
	ctx.strokeRect(x + TAPE_EDGE / 2, y + TAPE_EDGE / 2, Math.max(0, w - TAPE_EDGE), Math.max(0, h - TAPE_EDGE));
}
