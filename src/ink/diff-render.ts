// 0.20 visual version diff (#121): draws one page of a version diff on a canvas. The page itself is drawn by the ordinary page
// raster (white sheet, paper, boxes, text, ink); on top come the marks of the diff: added ink and elements in green, removed
// ones in red and ghosted, moved or changed ones with an amber outline. Pictures, PDF and image backgrounds are not loaded for
// this preview (a changed picture still gets its outline). Read-only: nothing here touches a document.
import type { Page, Stroke } from "../model/types";
import type { ItemChange, PageDiff } from "../model/version-diff";
import { strokeBounds, type BBox } from "./hit-test";
import { elementBounds } from "./elements";
import { drawPageRaster } from "./page-raster";
import { strokeSvgPath } from "./stroke-shape";

export type DiffMode = "before" | "after" | "overlay";
export const DIFF_MODES: readonly DiffMode[] = ["before", "overlay", "after"];

/** The colours of the marks (the legend uses the same ones). */
export const DIFF_COLORS = { added: "#16a34a", removed: "#dc2626", changed: "#f59e0b" } as const;

/** Marks drawn on one page at most (a page with more differences shows the first ones; the counts say the rest). */
export const DIFF_MAX_MARKS = 3000;

export interface DiffMark {
	kind: "stroke" | "element";
	id: string;
	change: ItemChange;
	/** Where the item is in the version this mark is drawn on (the earlier version for a removed item). */
	box: BBox;
	/** A moved or changed item in the overlay: where it was before (dashed). */
	oldBox?: BBox;
	/** The ink to draw tinted (added or removed strokes). */
	stroke?: Stroke;
}

/**
 * The marks to draw for `mode`: "before" shows what was removed and what changed (as it was), "after" what was added and what
 * changed (as it is), "overlay" everything on the later version with the removed items ghosted in. Pure.
 */
export function diffMarks(before: Page | null, after: Page | null, pd: PageDiff, mode: DiffMode): DiffMark[] {
	const marks: DiffMark[] = [];
	if (!before || !after) return marks;
	const bStrokes = new Map(before.strokes.map((s) => [s.id, s]));
	const aStrokes = new Map(after.strokes.map((s) => [s.id, s]));
	const bEls = new Map((before.elements ?? []).map((e) => [e.id, e]));
	const aEls = new Map((after.elements ?? []).map((e) => [e.id, e]));
	for (const item of pd.items) {
		if (marks.length >= DIFF_MAX_MARKS) break;
		const { kind, id, change } = item;
		if (mode === "before" && change === "added") continue;
		if (mode === "after" && change === "removed") continue;
		const old = kind === "stroke" ? bStrokes.get(id) : bEls.get(id);
		const now = kind === "stroke" ? aStrokes.get(id) : aEls.get(id);
		const boxOf = (it: Stroke | NonNullable<typeof now> | undefined): BBox | null => {
			if (!it) return null;
			return "points" in it ? strokeBounds(it) : elementBounds(it);
		};
		const showBefore = change === "removed" || (mode === "before" && (change === "changed" || change === "moved"));
		const box = boxOf(showBefore ? old : now);
		if (!box) continue;
		const mark: DiffMark = { kind, id, change, box };
		if (mode === "overlay" && (change === "moved" || change === "changed")) {
			const oldBox = boxOf(old);
			if (oldBox) mark.oldBox = oldBox;
		}
		if (kind === "stroke" && (change === "added" || change === "removed")) mark.stroke = (showBefore ? old : now) as Stroke | undefined;
		marks.push(mark);
	}
	return marks;
}

export interface DiffRenderOptions {
	/** Canvas width in pixels (the height follows the page, capped). */
	width: number;
	/** Longest side of the canvas in pixels. */
	maxHeight?: number;
	/** Said on a page that does not exist in the version shown ("Page not in this version"). */
	missingLabel: string;
}

const PAD = 4;

function pagePx(page: Page | null, other: Page | null): { w: number; h: number } {
	return { w: Math.max(page?.width ?? 0, other?.width ?? 0, 1), h: Math.max(page?.height ?? 0, other?.height ?? 0, 1) };
}

/** Draws the page `pd` of a diff in `mode` into a new canvas. Returns null when no 2D context is available. */
export function renderDiffCanvas(before: Page | null, after: Page | null, pd: PageDiff, mode: DiffMode, o: DiffRenderOptions): HTMLCanvasElement | null {
	const { w, h } = pagePx(before, after);
	const maxHeight = o.maxHeight ?? 4096;
	const scale = Math.min(Math.max(1, Math.round(o.width)) / w, maxHeight / h);
	const canvas = createEl("canvas");
	canvas.width = Math.max(1, Math.round(w * scale));
	canvas.height = Math.max(1, Math.round(h * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	const base = mode === "before" ? before : mode === "after" ? after : after ?? before;
	if (!base) {
		drawMissing(ctx, canvas, o.missingLabel);
		return canvas;
	}
	drawPageRaster(ctx, base, scale, { background: null, images: new Map() });
	ctx.save();
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	// A page that exists on one side only is framed whole.
	if (pd.status === "added" && mode !== "before") frame(ctx, base, DIFF_COLORS.added, scale);
	if (pd.status === "removed" && mode !== "after") frame(ctx, base, DIFF_COLORS.removed, scale);
	const marks = diffMarks(before, after, pd, mode);
	// Tints and ghosts first, outlines on top.
	for (const m of marks) {
		if (m.change === "added") tint(ctx, m, DIFF_COLORS.added, 0.12, 0.55);
		else if (m.change === "removed") tint(ctx, m, DIFF_COLORS.removed, 0.1, mode === "overlay" ? 0.35 : 0.5);
	}
	ctx.lineWidth = Math.max(1.5, 2 / scale);
	for (const m of marks) {
		if (m.change !== "moved" && m.change !== "changed") continue;
		if (m.oldBox) {
			ctx.setLineDash([4 / scale, 3 / scale]);
			ctx.strokeStyle = DIFF_COLORS.changed;
			ctx.globalAlpha = 0.6;
			rect(ctx, m.oldBox);
			ctx.globalAlpha = 1;
			ctx.setLineDash([]);
		}
		ctx.strokeStyle = DIFF_COLORS.changed;
		ctx.fillStyle = DIFF_COLORS.changed;
		ctx.globalAlpha = 0.08;
		ctx.fillRect(m.box.minX - PAD, m.box.minY - PAD, m.box.maxX - m.box.minX + 2 * PAD, m.box.maxY - m.box.minY + 2 * PAD);
		ctx.globalAlpha = 1;
		rect(ctx, m.box);
	}
	ctx.restore();
	return canvas;
}

function rect(ctx: CanvasRenderingContext2D, b: BBox): void {
	ctx.strokeRect(b.minX - PAD, b.minY - PAD, b.maxX - b.minX + 2 * PAD, b.maxY - b.minY + 2 * PAD);
}

function frame(ctx: CanvasRenderingContext2D, page: Page, colour: string, scale: number): void {
	const lw = 4 / scale;
	ctx.strokeStyle = colour;
	ctx.lineWidth = lw;
	ctx.strokeRect(lw / 2, lw / 2, page.width - lw, page.height - lw);
}

/** A translucent box over the item and, for ink, its own shape in the colour. */
function tint(ctx: CanvasRenderingContext2D, m: DiffMark, colour: string, boxAlpha: number, inkAlpha: number): void {
	ctx.fillStyle = colour;
	ctx.globalAlpha = boxAlpha;
	ctx.fillRect(m.box.minX - PAD, m.box.minY - PAD, m.box.maxX - m.box.minX + 2 * PAD, m.box.maxY - m.box.minY + 2 * PAD);
	if (m.stroke) {
		const d = strokeSvgPath(m.stroke);
		if (d) {
			ctx.globalAlpha = inkAlpha;
			ctx.fill(new Path2D(d));
		}
	} else {
		ctx.globalAlpha = Math.min(1, boxAlpha * 2.5);
		ctx.strokeStyle = colour;
		ctx.setLineDash([5, 4]);
		rect(ctx, m.box);
		ctx.setLineDash([]);
	}
	ctx.globalAlpha = 1;
}

function drawMissing(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, label: string): void {
	ctx.fillStyle = "#f3f4f6";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = "#6b7280";
	ctx.font = `${Math.max(12, Math.round(canvas.width / 24))}px sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 24);
}
