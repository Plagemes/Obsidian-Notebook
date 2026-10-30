/** Pure helpers of the notebook view (no DOM, no 'obsidian'): testable in Node. */
import { elementBounds, type MeasureText } from "../ink/elements";
import { strokeBounds, type BBox } from "../ink/hit-test";
import { projectToRuler, type Ruler } from "../ink/ruler";
import { arrowPoints, constrain, ellipsePoints, linePoints, rectPoints, type Vec } from "../ink/shapes";
import { bookmarkInfoMapEquals, copyBookmarkInfoMap, removeBookmark } from "../model/bookmarks";
import { cloneMeta } from "../model/document";
import { A4_HEIGHT, A4_WIDTH, type NotebookMeta, type Page, type PageElement, type Point, type Stroke } from "../model/types";

export type ShapeKind = "line" | "arrow" | "rectangle" | "ellipse";
export const SHAPE_KINDS: readonly ShapeKind[] = ["line", "arrow", "rectangle", "ellipse"];

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Page range typed in the "insert PDF" dialog: whole numbers within 1..count and from <= to; null otherwise. */
export function parsePageRange(from: string | number, to: string | number, count: number): { from: number; to: number } | null {
	const num = (v: string | number): number => (typeof v === "number" ? v : /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
	const a = num(from);
	const b = num(to);
	if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
	if (a < 1 || b > count || a > b) return null;
	return { from: a, to: b };
}

/** Largest size with the aspect ratio of w × h that fits in maxW × maxH (never enlarged unless `upscale`). */
export function fitInside(w: number, h: number, maxW: number, maxH: number, upscale = true): { width: number; height: number } {
	if (!(w > 0) || !(h > 0) || !(maxW > 0) || !(maxH > 0)) return { width: Math.max(1, maxW || 1), height: Math.max(1, maxH || 1) };
	let k = Math.min(maxW / w, maxH / h);
	if (!upscale) k = Math.min(1, k);
	return { width: round2(w * k), height: round2(h * k) };
}

/**
 * Page for an image used as a background: A4 portrait or landscape depending on the image, shrunk on one side so that
 * it has exactly the image's proportions (the image is drawn stretched to the page, so it must not be distorted).
 */
export function imagePageSize(imgW: number, imgH: number): { width: number; height: number } {
	if (!(imgW > 0) || !(imgH > 0)) return { width: A4_WIDTH, height: A4_HEIGHT };
	return imgW > imgH ? fitInside(imgW, imgH, A4_HEIGHT, A4_WIDTH) : fitInside(imgW, imgH, A4_WIDTH, A4_HEIGHT);
}

/** Size of an image element on a page: 96 dpi pixels to pt, at most 60 % of the page in each direction. */
export function imageElementSize(imgW: number, imgH: number, pageW: number, pageH: number): { width: number; height: number } {
	return fitInside(imgW * 0.75, imgH * 0.75, pageW * 0.6, pageH * 0.6, false);
}

/** Top-left corner for a box of `size` centred on (cx, cy), kept inside the page when it fits. */
export function centredPosition(cx: number, cy: number, size: { width: number; height: number }, page: { width: number; height: number }): [number, number] {
	const clamp = (v: number, max: number) => (max < 0 ? 0 : Math.min(max, Math.max(0, v)));
	return [round2(clamp(cx - size.width / 2, page.width - size.width)), round2(clamp(cy - size.height / 2, page.height - size.height))];
}

/** Default text box for a tap at (x, y): about 60 % of the page wide, never past the right edge. */
export function newTextBox(pageWidth: number, x: number, y: number): { x: number; y: number; width: number } {
	const MIN = 80;
	const margin = 8;
	const bx = Math.max(0, Math.min(x, pageWidth - MIN - margin));
	return { x: round2(bx), y: round2(Math.max(0, y)), width: round2(Math.max(MIN, Math.min(pageWidth * 0.6, pageWidth - bx - margin))) };
}

/** Changes whenever what a thumbnail of the page shows changes (cheap: samples the strokes). */
export function pageSignature(page: Page): string {
	const parts: Array<string | number> = [page.width, page.height, page.paper.kind, page.paper.spacing, page.strokes.length];
	const n = page.strokes.length;
	const stride = Math.max(1, Math.floor(n / 16));
	const sample = (s: Stroke) => parts.push(s.id, s.points.length, s.points[0]?.[0] ?? 0, s.points[0]?.[1] ?? 0, s.width);
	for (let i = 0; i < n; i += stride) sample(page.strokes[i]!);
	if (n > 0 && (n - 1) % stride !== 0) sample(page.strokes[n - 1]!);
	for (const el of page.elements ?? []) {
		if (el.type === "text") parts.push(el.id, el.x, el.y, el.width, el.text, el.fontSize, el.color);
		else if (el.type === "image") parts.push(el.id, el.x, el.y, el.width, el.height, el.rotation, el.asset);
		else if (el.type === "box") parts.push(el.id, el.x, el.y, el.width, el.height, el.kind);
		else parts.push(el.id, el.x, el.y, el.kind, el.done ? 1 : 0);
	}
	const bg = page.background;
	if (bg) parts.push(bg.kind, bg.asset, bg.kind === "pdf" ? bg.page : 0);
	return parts.join("|");
}

/** Metadata with `bookmarks` toggled for a page. */
export function toggleBookmark(meta: NotebookMeta, pageId: string): NotebookMeta {
	// Removing a bookmark also drops its v7 details (title, colour, category); undo brings both back.
	if (meta.bookmarks.includes(pageId)) return removeBookmark(meta, pageId);
	const next = cloneMeta(meta);
	next.bookmarks = [...meta.bookmarks, pageId];
	return next;
}

/** `meta` with the fields of `patch` replaced (arrays copied). */
export function mergeMeta(meta: NotebookMeta, patch: Partial<NotebookMeta>): NotebookMeta {
	const next = cloneMeta(meta);
	if (patch.tags !== undefined) next.tags = [...patch.tags];
	if (patch.favorite !== undefined) next.favorite = patch.favorite;
	if (patch.cover !== undefined) next.cover = patch.cover;
	if (patch.bookmarks !== undefined) next.bookmarks = [...patch.bookmarks];
	if ("bookmarkInfo" in patch) {
		const info = copyBookmarkInfoMap(patch.bookmarkInfo);
		if (info) next.bookmarkInfo = info;
		else delete next.bookmarkInfo;
	}
	return next;
}

export function metaEquals(a: NotebookMeta, b: NotebookMeta): boolean {
	const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	return a.favorite === b.favorite && a.cover === b.cover && same(a.tags, b.tags) && same(a.bookmarks, b.bookmarks)
		&& bookmarkInfoMapEquals(a.bookmarkInfo, b.bookmarkInfo);
}

/** Polyline of the shape dragged from `a` to `b` (page coordinates); empty when the drag is too short to mean anything. */
export function shapePoints(kind: ShapeKind, a: Vec, b: Vec, strokeWidth: number, perfect = false): Point[] {
	let c: [number, number];
	switch (kind) {
		case "line":
			c = constrain(a, b, "line", perfect);
			return Math.hypot(c[0] - a[0], c[1] - a[1]) < 2 ? [] : linePoints(a, c);
		case "arrow":
			c = constrain(a, b, "arrow", perfect);
			return Math.hypot(c[0] - a[0], c[1] - a[1]) < 2 ? [] : arrowPoints(a, c, 10 + strokeWidth * 3);
		case "rectangle":
			c = constrain(a, b, "rect", perfect);
			return Math.abs(c[0] - a[0]) < 2 || Math.abs(c[1] - a[1]) < 2 ? [] : rectPoints(a, c);
		case "ellipse":
			c = constrain(a, b, "ellipse", perfect);
			return Math.abs(c[0] - a[0]) < 2 || Math.abs(c[1] - a[1]) < 2
				? []
				: ellipsePoints([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], Math.abs(c[0] - a[0]) / 2, Math.abs(c[1] - a[1]) / 2);
	}
}

/** Union of the bounds of strokes and elements; null when both are empty. */
export function unionBounds(strokes: readonly Stroke[], elements: readonly PageElement[], measure: MeasureText): BBox | null {
	const boxes = [...strokes.map(strokeBounds), ...elements.map((e) => elementBounds(e, measure))];
	if (boxes.length === 0) return null;
	return boxes.reduce((a, b) => ({
		minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
	}));
}

/** Distance (CSS px) within which two fingers placed near the ruler grab it instead of zooming the page. */
export const RULER_GRAB_PX = 90;

/** Should a two-finger gesture centred on `mid` (page coordinates) move the ruler? Always, if its centre is out of view. */
export function shouldGrabRuler(ruler: Ruler, mid: Vec, scale: number, centreVisible: boolean): boolean {
	if (!centreVisible) return true;
	return projectToRuler(ruler, mid, RULER_GRAB_PX / Math.max(scale, 1e-6)) !== null;
}
