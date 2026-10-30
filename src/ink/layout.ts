import type { BBox } from "./hit-test";

/**
 * Pages stacked vertically in "document space" (pt). The viewport maps document space to
 * the screen; strokes stay in page coordinates, so a page's box is only an offset.
 */
export const PAGE_GAP = 24;

/**
 * wave 0.9 (376): a horizontal part of a page or of a layout that the view fits to its width instead of the whole page
 * ("crop the white margins", view-only). In a box's own coordinates for `PageBox.window`, in document space for
 * `Layout.window`. Nothing but the zoom and the pan limits read it: boxes, pages and ink coordinates are unchanged.
 */
export interface Range {
	x: number;
	width: number;
}

export interface PageBox {
	x: number;
	y: number;
	width: number;
	height: number;
	/** wave 0.9: the part of the page the view fits (see `Range`). */
	window?: Range;
}

export interface Layout {
	boxes: PageBox[];
	width: number;
	height: number;
	/** wave 0.9: the part of the document width the view fits in continuous mode (the union of the boxes' windows). */
	window?: Range;
}

/** A window that is at least this much of the page width is not worth a different zoom. */
const WINDOW_MAX_SHARE = 0.97;

/**
 * The same layout with the windows `windowOf` returns (box-local; null: the whole page). Windows that would not change
 * the zoom are dropped. The layout window is the union of the boxes' windows (a box without one counts as whole), so
 * every page stays reachable.
 */
export function withWindows(layout: Layout, windowOf: (index: number) => Range | null): Layout {
	let any = false;
	const boxes = layout.boxes.map((b, i): PageBox => {
		const w = windowOf(i);
		if (!w || !(w.width > 0) || w.width >= b.width * WINDOW_MAX_SHARE) return b;
		const x = Math.min(Math.max(0, w.x), b.width - 1);
		any = true;
		return { ...b, window: { x, width: Math.min(w.width, b.width - x) } };
	});
	if (!any) return layout;
	let lo = Infinity, hi = -Infinity;
	for (const b of boxes) {
		const x = b.x + (b.window?.x ?? 0);
		lo = Math.min(lo, x);
		hi = Math.max(hi, x + (b.window?.width ?? b.width));
	}
	const next: Layout = { ...layout, boxes };
	if (hi - lo < layout.width * WINDOW_MAX_SHARE) next.window = { x: lo, width: hi - lo };
	return next;
}

export function layoutPages(pages: ReadonlyArray<{ width: number; height: number }>, gap = PAGE_GAP): Layout {
	const width = pages.reduce((w, p) => Math.max(w, p.width), 0);
	let y = 0;
	const boxes = pages.map((p) => {
		const box = { x: (width - p.width) / 2, y, width: p.width, height: p.height };
		y += p.height + gap;
		return box;
	});
	return { boxes, width, height: pages.length ? y - gap : 0 };
}

/** Index of the page containing the document point (box grown by `tolerance`), or -1. */
export function pageAt(layout: Layout, x: number, y: number, tolerance = 0): number {
	return layout.boxes.findIndex((b) =>
		x >= b.x - tolerance && x <= b.x + b.width + tolerance && y >= b.y - tolerance && y <= b.y + b.height + tolerance);
}

/** Page whose box is closest to the document point vertically (for "current page"). */
export function nearestPage(layout: Layout, y: number): number {
	let best = -1;
	let bestDist = Infinity;
	layout.boxes.forEach((b, i) => {
		const d = y < b.y ? b.y - y : y > b.y + b.height ? y - b.y - b.height : 0;
		if (d < bestDist) {
			bestDist = d;
			best = i;
		}
	});
	return best;
}

/** Indices of the pages intersecting a rectangle in document space. */
export function visiblePages(layout: Layout, rect: BBox): number[] {
	const out: number[] = [];
	layout.boxes.forEach((b, i) => {
		if (b.x <= rect.maxX && b.x + b.width >= rect.minX && b.y <= rect.maxY && b.y + b.height >= rect.minY) out.push(i);
	});
	return out;
}

export function toPageLocal(box: PageBox, x: number, y: number): [number, number] {
	return [x - box.x, y - box.y];
}
