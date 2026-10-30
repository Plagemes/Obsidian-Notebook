/**
 * v10 anchored excerpts (#105): how an excerpt looks on the canvas (notebook view, page images of the Markdown export,
 * navigator thumbnails). The picture of the source region (drawn live or from the snapshot, chosen by the caller) in
 * the excerpt's box with a thin frame, and the "go to source" badge on its top-right corner. Vector, page coordinates.
 * No 'obsidian'. The PDF and SVG exports draw the snapshot as an image (no badge: a page on paper cannot jump).
 */
import { excerptBadgeRect } from "../model/excerpts";
import type { ExcerptElement } from "../model/types";

export const EXCERPT_COLOR = "#0d9488";
/** Badge of an excerpt whose source cannot be found (its page was deleted from this notebook). */
export const EXCERPT_MISSING_COLOR = "#94a3b8";
const PLACEHOLDER_FILL = "#f1f5f9";
const PLACEHOLDER_LINE = "#94a3b8";

/** The excerpt's picture (or a placeholder without one) and its frame; under the ink, like an image. */
export function drawExcerpt(ctx: CanvasRenderingContext2D, el: ExcerptElement, img: CanvasImageSource | null): void {
	ctx.save();
	try {
		if (img) {
			ctx.drawImage(img, el.x, el.y, el.width, el.height);
			ctx.strokeStyle = EXCERPT_COLOR;
			ctx.globalAlpha = 0.6;
			ctx.lineWidth = 0.75;
			ctx.strokeRect(el.x, el.y, el.width, el.height);
			return;
		}
		// No picture yet (loading) or none at all (no snapshot, source not drawable): a light card with a broken frame.
		ctx.fillStyle = PLACEHOLDER_FILL;
		ctx.fillRect(el.x, el.y, el.width, el.height);
		ctx.strokeStyle = PLACEHOLDER_LINE;
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 3]);
		ctx.strokeRect(el.x, el.y, el.width, el.height);
		ctx.setLineDash([]);
		const s = Math.min(el.width, el.height) * 0.3;
		if (s >= 4) {
			// A page with a folded corner, the sign of "a part of a page".
			const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
			ctx.beginPath();
			ctx.moveTo(cx - s / 2, cy - s / 2);
			ctx.lineTo(cx + s / 4, cy - s / 2);
			ctx.lineTo(cx + s / 2, cy - s / 4);
			ctx.lineTo(cx + s / 2, cy + s / 2);
			ctx.lineTo(cx - s / 2, cy + s / 2);
			ctx.closePath();
			ctx.stroke();
		}
	} finally {
		ctx.restore();
	}
}

/** The "go to source" badge: a rounded square with an arrow pointing back (up and left). Above the ink, like markers. */
export function drawExcerptBadge(ctx: CanvasRenderingContext2D, el: ExcerptElement, missing = false): void {
	const r = excerptBadgeRect(el);
	if (r.width < 2) return;
	ctx.save();
	try {
		ctx.fillStyle = missing ? EXCERPT_MISSING_COLOR : EXCERPT_COLOR;
		const rad = r.width * 0.22;
		ctx.beginPath();
		ctx.moveTo(r.x + rad, r.y);
		ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rad);
		ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rad);
		ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rad);
		ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rad);
		ctx.closePath();
		ctx.fill();
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 0.8;
		ctx.stroke();
		// Arrow from the bottom-right to the top-left, with its head at the top-left.
		const s = r.width;
		const ax = r.x + s * 0.3, ay = r.y + s * 0.3, bx = r.x + s * 0.72, by = r.y + s * 0.72;
		ctx.lineWidth = Math.max(0.6, s * 0.1);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		ctx.moveTo(bx, by);
		ctx.lineTo(ax, ay);
		ctx.moveTo(ax, ay + s * 0.26);
		ctx.lineTo(ax, ay);
		ctx.lineTo(ax + s * 0.26, ay);
		ctx.stroke();
	} finally {
		ctx.restore();
	}
}
