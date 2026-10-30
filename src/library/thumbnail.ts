/** Page thumbnails for the library cards. Runs in the browser (canvas). */
import { lodLevel, lodSvgPath } from "../ink/lod";
import { HIGHLIGHTER_ALPHA } from "../ink/stroke-shape";
import { minorVisible, PAPER_COLORS, paperPattern } from "../ink/paper";
import type { Page } from "../model/types";

export interface ThumbnailOptions {
	/** Draws under the paper pattern and the ink (e.g. a PDF page). `scale` is canvas px per pt. */
	drawBackground?: (ctx: CanvasRenderingContext2D, page: Page, scale: number) => void;
	/** Encoding of the data URL. JPEG keeps the index small; default is PNG. */
	mime?: "image/png" | "image/jpeg" | "image/webp";
	quality?: number;
	/** Z1 cards: only this part of the page (page units), at its own aspect ratio. */
	region?: { x: number; y: number; width: number; height: number };
}

/** Tall pages (infinite pages) show only their top part: height is at most this many times the width. */
export const MAX_ASPECT = 1.5;
/** Pen strokes are never thinner than this many canvas pixels, so handwriting stays visible. */
const MIN_STROKE_PX = 1.1;
/** Give up drawing more strokes after this long (ms); the thumbnail then shows the start of the page. */
const TIME_BUDGET_MS = 700;

/** Canvas size for a thumbnail of `page` that is `width` px wide. */
export function thumbnailSize(page: Page, width: number): { width: number; height: number; scale: number } {
	const w = Math.max(1, Math.round(width));
	const aspect = page.width > 0 ? Math.min(page.height / page.width, MAX_ASPECT) : 1;
	return { width: w, height: Math.max(1, Math.round(w * aspect)), scale: page.width > 0 ? w / page.width : 1 };
}

/** Renders `page` to a data URL, `width` px wide. White paper, pattern hairlines, then the ink. */
export function renderThumbnail(page: Page, width: number, options: ThumbnailOptions = {}): string {
	const region = options.region;
	const size = region ? regionSize(region, width) : thumbnailSize(page, width);
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "";
	const { scale } = size;

	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, size.width, size.height);
	ctx.save();
	ctx.scale(scale, scale);
	if (region) ctx.translate(-region.x, -region.y);

	options.drawBackground?.(ctx, page, scale);

	const visible = region
		? { minX: region.x, minY: region.y, maxX: region.x + region.width, maxY: region.y + region.height }
		: { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
	const { lines, dots } = paperPattern(page, visible, { includeMinor: minorVisible(page.paper.spacing, scale) });
	ctx.lineWidth = Math.max(0.5, 0.8 / scale);
	for (const kind of ["minor", "major", "margin"] as const) {
		ctx.strokeStyle = PAPER_COLORS[kind];
		ctx.beginPath();
		let any = false;
		for (const l of lines) {
			if (l.kind !== kind) continue;
			ctx.moveTo(l.x1, l.y1);
			ctx.lineTo(l.x2, l.y2);
			any = true;
		}
		if (any) ctx.stroke();
	}
	if (dots.length > 0) {
		const r = Math.max(0.6, 0.8 / scale);
		ctx.fillStyle = PAPER_COLORS.dot;
		ctx.beginPath();
		for (const [x, y] of dots) {
			ctx.moveTo(x + r, y);
			ctx.arc(x, y, r, 0, Math.PI * 2);
		}
		ctx.fill();
	}

	// Small thumbnails draw strokes from simplified points (ink/lod.ts); the saved points are untouched.
	const lod = lodLevel(scale, 1);
	const started = performance.now();
	let drawn = 0;
	for (const stroke of page.strokes) {
		if (stroke.points.length === 0) continue;
		if (region && !strokeNear(stroke.points, visible, stroke.width)) continue;
		if (++drawn % 64 === 0 && performance.now() - started > TIME_BUDGET_MS) break;
		const highlighter = stroke.tool === "highlighter";
		ctx.fillStyle = stroke.color;
		ctx.globalAlpha = highlighter ? HIGHLIGHTER_ALPHA : 1;
		ctx.globalCompositeOperation = highlighter ? "multiply" : "source-over";
		const w = highlighter ? stroke.width : Math.max(stroke.width, MIN_STROKE_PX / scale);
		// Same geometry as the notebook (old strokes: perfect-freehand, new ones: the ink engine).
		ctx.fill(new Path2D(lodSvgPath(stroke, w, lod)));
	}
	ctx.restore();

	return canvas.toDataURL(options.mime ?? "image/png", options.quality);
}

/** Canvas size for a region `width` px wide (no height cap: a card region is drawn whole). */
export function regionSize(region: { width: number; height: number }, width: number): { width: number; height: number; scale: number } {
	const w = Math.max(1, Math.round(width));
	const scale = region.width > 0 ? w / region.width : 1;
	return { width: w, height: Math.max(1, Math.round(region.height * scale)), scale };
}

/** Whether any point of a stroke lies within `width` of the box (strokes far from a card region are skipped). */
function strokeNear(points: ReadonlyArray<readonly [number, number, number]>, box: { minX: number; minY: number; maxX: number; maxY: number }, width: number): boolean {
	const m = width * 2;
	return points.some(([x, y]) => x >= box.minX - m && x <= box.maxX + m && y >= box.minY - m && y <= box.maxY + m);
}
