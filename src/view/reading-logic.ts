/**
 * Pure helpers of the PDF reading tools (search results, reveal, which pages are searched). No 'obsidian' or DOM import.
 */
import type { Size, Viewport } from "../ink/viewport";
import type { Page } from "../model/types";
import type { SearchHit, SearchTarget } from "../pdf/text-index";

/** Opacity of a PDF or image background: 1 normally, lighter when dimmed (the page behind it is white). */
export function backgroundAlpha(dimmed: boolean, strength: number): number {
	return dimmed ? 1 - Math.min(0.9, Math.max(0, strength)) : 1;
}

/** Pages with a PDF background, in notebook order, starting at `from` and wrapping round (the search starts where you are). */
export function searchTargets(pages: readonly Page[], from: number): SearchTarget[] {
	const n = pages.length;
	const out: SearchTarget[] = [];
	if (n === 0) return out;
	const start = Math.min(n - 1, Math.max(0, from));
	for (let k = 0; k < n; k++) {
		const page = pages[(start + k) % n]!;
		const bg = page.background;
		if (bg?.kind === "pdf") out.push({ pageId: page.id, asset: bg.asset, pdfPage: bg.page });
	}
	return out;
}

export function hasPdfPages(pages: readonly Page[]): boolean {
	return pages.some((p) => p.background?.kind === "pdf");
}

export function hasBackgrounds(pages: readonly Page[]): boolean {
	return pages.some((p) => !!p.background);
}

/** Next (+1) or previous (-1) index in a list of `count`, wrapping round; -1 when the list is empty. */
export function stepIndex(count: number, current: number, delta: 1 | -1): number {
	if (count <= 0) return -1;
	if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
	return (current + delta + count) % count;
}

/**
 * Inserts `added` (hits of pages searched later) into `list` so that it stays in notebook order: by page, then by
 * position in the page. `order` maps a page id to its index; hits of pages that are gone sort last.
 */
export function insertHits(list: SearchHit[], added: readonly SearchHit[], order: ReadonlyMap<string, number>): void {
	if (added.length === 0) return;
	const rank = (h: SearchHit): number => order.get(h.target.pageId) ?? Number.MAX_SAFE_INTEGER;
	list.push(...added);
	// Hits arrive page by page and the list is nearly sorted already: a stable sort is cheap.
	list.sort((a, b) => rank(a) - rank(b) || a.start - b.start);
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The viewport that shows `rect` (document coordinates) in the view. Unchanged when the rect is already inside the
 * visible area (below `insetTop` px that something covers); otherwise the rect is centred in that area, at the same zoom.
 */
export function revealViewport(v: Viewport, view: Size, rect: Rect, insetTop = 0): Viewport {
	const pad = 24;
	const left = rect.x * v.scale + v.offsetX;
	const right = (rect.x + rect.width) * v.scale + v.offsetX;
	const top = rect.y * v.scale + v.offsetY;
	const bottom = (rect.y + rect.height) * v.scale + v.offsetY;
	const areaTop = Math.min(view.height, insetTop) + pad;
	const areaBottom = view.height - pad;
	const inside = left >= pad && right <= view.width - pad && top >= areaTop && bottom <= areaBottom;
	if (inside) return v;
	let { offsetX, offsetY } = v;
	if (left < pad || right > view.width - pad) {
		offsetX += view.width / 2 - (left + right) / 2;
	}
	if (top < areaTop || bottom > areaBottom) {
		offsetY += (areaTop + areaBottom) / 2 - (top + bottom) / 2;
	}
	return { scale: v.scale, offsetX, offsetY };
}
