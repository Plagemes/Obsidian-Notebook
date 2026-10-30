// The drawing surface shared by the art families (pure logic: no DOM globals, no obsidian).
import type { Rgb } from "../../ink/colour";
import type { Rng } from "./prng";
import { rgba } from "./art-colour";

/**
 * The part of CanvasRenderingContext2D the art uses. Tests pass a recording fake that implements just this.
 */
export type ArtContext = Pick<CanvasRenderingContext2D,
	| "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "arc" | "ellipse"
	| "closePath" | "stroke" | "fill" | "fillRect" | "createLinearGradient" | "createRadialGradient" | "setLineDash"
	| "strokeStyle" | "fillStyle" | "lineWidth" | "globalAlpha" | "lineCap" | "lineJoin"
>;

export type Paint = string | CanvasGradient;

/** Everything a family needs: the context, the size, the seeded source and the resolved colours. */
export interface Painter {
	ctx: ArtContext;
	w: number;
	h: number;
	rng: Rng;
	/** 0..1. */
	density: number;
	/** min(w, h) / 200: lengths are designed for a 200 px tall card and scale with it. */
	unit: number;
	/** Where the composition is centred (the visible side of a card). */
	fx: number;
	fy: number;
	/** First x worth drawing: everything left of it is masked out anyway. */
	x0: number;
	/** Fine line paint (already carries the fade mask). */
	line: Paint;
	/** Glow paint (subject colour, same mask). */
	glow: Paint;
	/** Whether glow passes are drawn. */
	glowOn: boolean;
	/** Overall opacity multiplier. */
	alpha: number;
	lineRgb: Rgb;
}

/** No dash (a shared constant: setting a dash allocates nothing per call). */
export const SOLID: number[] = [];
export const DASH_FINE: number[] = [1.5, 3.5];
export const DASH_LONG: number[] = [6, 5];

/** Strokes the current path: an optional soft glow pass (wider, faint, subject colour), then the fine line. */
export function strokeLine(p: Painter, width: number, alpha: number, glow = false): void {
	const { ctx } = p;
	if (glow && p.glowOn) {
		// One soft pass (no shadowBlur: it is slow on Android WebViews).
		ctx.strokeStyle = p.glow;
		ctx.globalAlpha = Math.min(1, alpha * 0.3 * p.alpha);
		ctx.lineWidth = width * 2.4 + 0.8;
		ctx.stroke();
	}
	ctx.strokeStyle = p.line;
	ctx.globalAlpha = Math.min(1, alpha * p.alpha);
	ctx.lineWidth = width;
	ctx.stroke();
}

/** Fills the current path with the line paint. */
export function fillDots(p: Painter, alpha: number): void {
	p.ctx.fillStyle = p.line;
	p.ctx.globalAlpha = Math.min(1, alpha * p.alpha);
	p.ctx.fill();
}

/** A plain colour paint for a flat (unmasked) layer. */
export function flat(c: Rgb): string {
	return rgba(c, 1);
}

/** Three opacity levels: the "varying opacity" of the reference line art. */
export const LEVELS = [0.32, 0.58, 0.9] as const;

/** The opacity of level i (clamped to 0..2). */
export function levelAlpha(i: number): number {
	return i <= 0 ? LEVELS[0] : i >= 2 ? LEVELS[2] : LEVELS[1];
}

/** A count scaled by density (0..1 → 0.55×..1.45×), at least 1. */
export function scaled(n: number, density: number): number {
	return Math.max(1, Math.round(n * (0.55 + 0.9 * density)));
}
