/**
 * v10 anchored excerpts (#105): pure helpers shared by the format, the renderer, the view and the copy paths. No
 * 'obsidian', no canvas. An excerpt shows a region of a page (of this notebook or of another one) and jumps back to it.
 * Elements are immutable: every change returns a new element.
 */
import { createId } from "./document";
import type { ExcerptElement, ExcerptSource, NotebookDocument, Page, PageElement } from "./types";

/** Longest stored source notebook path, characters. */
export const EXCERPT_PATH_MAX = 1024;
/** Longest stored document or page id of a source, characters. */
export const EXCERPT_ID_MAX = 200;
/** Side of the "go to source" badge drawn on the top-right corner of an excerpt, pt (like a marker badge). */
export const EXCERPT_BADGE = 14;
/** Smallest region side that can be excerpted, pt: anything smaller is a tap. */
export const MIN_EXCERPT_SIDE = 8;
/** Space added around a lasso selection when it becomes an excerpt region, pt. */
export const EXCERPT_PADDING = 4;
/** Free space kept around a new excerpt on its target page, pt. */
export const EXCERPT_PAGE_MARGIN = 24;

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isExcerpt(e: PageElement): e is ExcerptElement {
	return e.type === "excerpt";
}

/** The image asset an element draws (an image, or an excerpt's snapshot), or null. Every copy path brings it along. */
export function elementAssetId(e: PageElement): string | null {
	if (e.type === "image") return e.asset;
	if (e.type === "excerpt") return e.asset ?? null;
	return null;
}

/** The same element using asset `asset` instead of the one it has (an image or an excerpt snapshot stored again). */
export function withElementAsset<T extends PageElement>(e: T, asset: string): T {
	if (e.type === "image" || (e.type === "excerpt" && e.asset !== undefined)) return { ...e, asset };
	return e;
}

/** The region of `page` a selection box covers, padded and kept inside the page; null when too small to excerpt. */
export function excerptRegion(bounds: { minX: number; minY: number; maxX: number; maxY: number }, page: { width: number; height: number }, padding = EXCERPT_PADDING): Rect | null {
	const x0 = Math.max(0, bounds.minX - padding);
	const y0 = Math.max(0, bounds.minY - padding);
	const x1 = Math.min(page.width, bounds.maxX + padding);
	const y1 = Math.min(page.height, bounds.maxY + padding);
	if (!(x1 - x0 >= MIN_EXCERPT_SIDE) || !(y1 - y0 >= MIN_EXCERPT_SIDE)) return null;
	return { x: round2(x0), y: round2(y0), width: round2(x1 - x0), height: round2(y1 - y0) };
}

/**
 * Where a region of `size` goes on `page`: its own size, scaled down (aspect kept) to fit inside the page less
 * EXCERPT_PAGE_MARGIN, centred on `centre` (default: the page centre) and kept inside the page.
 */
export function placeExcerpt(size: { width: number; height: number }, page: { width: number; height: number }, centre?: readonly [number, number]): Rect {
	const room = { width: Math.max(1, page.width - 2 * EXCERPT_PAGE_MARGIN), height: Math.max(1, page.height - 2 * EXCERPT_PAGE_MARGIN) };
	const k = Math.min(1, room.width / size.width, room.height / size.height);
	const width = Math.max(1, round2(size.width * k));
	const height = Math.max(1, round2(size.height * k));
	const [cx, cy] = centre ?? [page.width / 2, page.height / 2];
	const x = Math.min(Math.max(0, page.width - width), Math.max(0, cx - width / 2));
	const y = Math.min(Math.max(0, page.height - height), Math.max(0, cy - height / 2));
	return { x: round2(x), y: round2(y), width, height };
}

/** A new excerpt of `region` of page `page` of `doc` (at vault path `path`), shown in `target`. */
export function createExcerpt(
	doc: Pick<NotebookDocument, "id">, path: string, page: Pick<Page, "id">, region: Rect, target: Rect, asset?: string,
): ExcerptElement {
	const source: ExcerptSource = {
		notebook: path, doc: doc.id, page: page.id,
		x: round2(region.x), y: round2(region.y), width: round2(region.width), height: round2(region.height),
	};
	const el: ExcerptElement = {
		id: createId(), type: "excerpt",
		x: round2(target.x), y: round2(target.y), width: round2(target.width), height: round2(target.height), source,
	};
	if (asset !== undefined) el.asset = asset;
	return el;
}

export function excerptBounds(el: ExcerptElement): { minX: number; minY: number; maxX: number; maxY: number } {
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

/** The badge's square: on the top-right corner, inside the excerpt (smaller on a tiny excerpt). */
export function excerptBadgeRect(el: ExcerptElement): Rect {
	const side = Math.min(EXCERPT_BADGE, el.width / 2, el.height / 2);
	return { x: el.x + el.width - side, y: el.y, width: side, height: side };
}

/** The topmost excerpt whose badge is at (x, y) (grown by `tolerance`), or null. */
export function excerptBadgeAt(elements: readonly PageElement[], x: number, y: number, tolerance = 0): ExcerptElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const e = elements[i]!;
		if (e.type !== "excerpt") continue;
		const b = excerptBadgeRect(e);
		if (x >= b.x - tolerance && x <= b.x + b.width + tolerance && y >= b.y - tolerance && y <= b.y + b.height + tolerance) return e;
	}
	return null;
}

/** Where an excerpt's source is, seen from the open document `doc`. */
export type ExcerptSourceState =
	/** The source page is in `doc` (the same notebook), at `index`. */
	| { kind: "here"; index: number }
	/** The source is `doc`, but no page has the source page id any more (deleted, or moved to another notebook). */
	| { kind: "page-missing" }
	/** The source is another notebook (found by path when it is opened). */
	| { kind: "other" };

/** Whether the excerpt's source is this notebook (by document id: a rename does not change it) and where its page is. */
export function excerptSourceState(el: ExcerptElement, doc: Pick<NotebookDocument, "id" | "pages">): ExcerptSourceState {
	if (el.source.doc !== doc.id) return { kind: "other" };
	const index = doc.pages.findIndex((p) => p.id === el.source.page);
	return index >= 0 ? { kind: "here", index } : { kind: "page-missing" };
}

/** The source region kept inside its page now (the page may have been made smaller); null when nothing is left. */
export function clampSourceRegion(source: ExcerptSource, page: { width: number; height: number }): Rect | null {
	const x0 = Math.max(0, source.x);
	const y0 = Math.max(0, source.y);
	const x1 = Math.min(page.width, source.x + source.width);
	const y1 = Math.min(page.height, source.y + source.height);
	if (!(x1 - x0 > 0.5) || !(y1 - y0 > 0.5)) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Display name of the source notebook: the file name of its stored path, without the extension. */
export function excerptSourceName(source: ExcerptSource): string {
	const file = source.notebook.split("/").pop() ?? source.notebook;
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(0, dot) : file;
}

/** The excerpts of a document whose source page is `pageId` of the document `docId` (for counts and notices). */
export function excerptsOf(doc: Pick<NotebookDocument, "pages">, docId: string, pageId: string): ExcerptElement[] {
	const out: ExcerptElement[] = [];
	for (const p of doc.pages) for (const e of p.elements ?? []) if (e.type === "excerpt" && e.source.doc === docId && e.source.page === pageId) out.push(e);
	return out;
}

/**
 * The document id of a notebook file's text (to tell a renamed source notebook from another one of the same name): read
 * from the header the writer puts at the start (no full parse of a large file), else from the parsed JSON. Null when
 * there is none.
 */
export function documentIdOf(text: string): string | null {
	const head = /^\{\s*"format":\s*"[^"]*",\s*"version":\s*\d+,\s*"id":\s*"((?:[^"\\]|\\.)*)"/.exec(text.slice(0, 4096));
	if (head) {
		try {
			return JSON.parse(`"${head[1]}"`) as string;
		} catch {
			return null;
		}
	}
	try {
		const raw = JSON.parse(text) as unknown;
		const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}
