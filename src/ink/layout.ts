import type { BBox } from "./hit-test";

/**
 * Pages stacked vertically in "document space" (pt). The viewport maps document space to
 * the screen; strokes stay in page coordinates, so a page's box is only an offset.
 */
export const PAGE_GAP = 24;

export interface PageBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Layout {
	boxes: PageBox[];
	width: number;
	height: number;
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
