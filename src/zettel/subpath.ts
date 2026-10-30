/**
 * Card subpaths (Z1): a page link or embed can name a page by id and a region of it, so a Zettel note
 * shows that part of the page live (`![[Box.notebook#p3&id=<page id>&r=40,60,200,120]]`).
 *
 *   #p3                      page 3 (as before)
 *   #p3&id=<page id>         the page with this id; `p3` is only a fallback for older readers
 *   #p3&id=<page id>&r=x,y,w,h   the region of that page, in page units (pt, origin top-left)
 *
 * Parameters may come in any order after the page; unknown ones are ignored (forward compatible).
 * Pure: no 'obsidian'.
 */

export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const PAGE_ID_PARAM = "id";
export const REGION_PARAM = "r";

/** Smallest card region side (pt): anything smaller is a tap, not a region. */
export const MIN_REGION_SIDE = 4;

/** One decimal is far below a pen's precision and keeps links short. */
function num(n: number): string {
	const r = Math.round(n * 10) / 10;
	return String(Object.is(r, -0) ? 0 : r);
}

/** `x,y,w,h` with at most one decimal. */
export function formatRegion(r: Region): string {
	return [r.x, r.y, r.width, r.height].map(num).join(",");
}

/** Reads `x,y,w,h`; null unless four finite numbers with a positive width and height. */
export function parseRegion(text: string): Region | null {
	const parts = text.trim().split(/\s*,\s*/);
	if (parts.length !== 4 || parts.some((p) => !/^-?\d+(?:\.\d+)?$/.test(p))) return null;
	const [x, y, width, height] = parts.map(Number) as [number, number, number, number];
	if (!(width > 0 && height > 0)) return null;
	return { x, y, width, height };
}

/** Page ids are UUIDs or hex strings; anything that could break a link is refused. */
export function validPageId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export interface SubpathParams {
	/** Text before the first `&` (the page part: `p3`, `3`, `page=3`). */
	head: string;
	pageId: string | null;
	region: Region | null;
	/** The parameter that could not be read (`r=abc`), or null. */
	bad: string | null;
}

/** Splits a fragment (text after `#`) into the page part and the card parameters. */
export function parseSubpathParams(fragment: string): SubpathParams {
	const [head = "", ...rest] = fragment.split("&");
	const out: SubpathParams = { head: head.trim(), pageId: null, region: null, bad: null };
	for (const raw of rest) {
		const eq = raw.indexOf("=");
		const key = (eq >= 0 ? raw.slice(0, eq) : raw).trim().toLowerCase();
		const value = eq >= 0 ? raw.slice(eq + 1).trim() : "";
		if (key === PAGE_ID_PARAM) {
			if (validPageId(value)) out.pageId = value;
			else out.bad ??= raw;
		} else if (key === REGION_PARAM) {
			const region = parseRegion(value);
			if (region) out.region = region;
			else out.bad ??= raw;
		}
	}
	return out;
}

/** Subpath of a card: `#p<page>&id=<page id>` plus `&r=x,y,w,h` for a region card. */
export function cardSubpath(page: number, pageId: string, region: Region | null): string {
	let s = `#p${Math.max(1, Math.floor(page))}&${PAGE_ID_PARAM}=${pageId}`;
	if (region) s += `&${REGION_PARAM}=${formatRegion(region)}`;
	return s;
}

export type PageLookup = { index: number } | { missing: "range" | "deleted" };

/**
 * Which page an embed shows. With a page id, only that page (it may have moved): when it is gone the
 * card's page was deleted, and another page is never shown in its place. Without one, the 1-based number.
 */
export function lookupPage(pages: ReadonlyArray<{ id: string }>, page: number, pageId: string | null): PageLookup {
	if (pageId !== null) {
		const index = pages.findIndex((p) => p.id === pageId);
		return index >= 0 ? { index } : { missing: "deleted" };
	}
	return page >= 1 && page <= pages.length ? { index: page - 1 } : { missing: "range" };
}

/** The part of `region` inside a page of this size; null when nothing (or less than MIN_REGION_SIDE) is left. */
export function clampRegion(region: Region, page: { width: number; height: number }): Region | null {
	const x0 = Math.max(0, region.x);
	const y0 = Math.max(0, region.y);
	const x1 = Math.min(page.width, region.x + region.width);
	const y1 = Math.min(page.height, region.y + region.height);
	if (x1 - x0 < MIN_REGION_SIDE || y1 - y0 < MIN_REGION_SIDE) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A selection's bounds grown by `pad` on each side and kept on the page. */
export function regionFromBounds(
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	page: { width: number; height: number },
	pad = 8,
): Region | null {
	return clampRegion({ x: bounds.minX - pad, y: bounds.minY - pad, width: bounds.maxX - bounds.minX + 2 * pad, height: bounds.maxY - bounds.minY + 2 * pad }, page);
}

/** Whether a point lies in a region grown by `tolerance`. */
export function regionContains(r: Region, x: number, y: number, tolerance = 0): boolean {
	return x >= r.x - tolerance && x <= r.x + r.width + tolerance && y >= r.y - tolerance && y <= r.y + r.height + tolerance;
}
