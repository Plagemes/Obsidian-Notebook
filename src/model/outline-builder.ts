/**
 * The generated outline (roadmap #407, combining #15 bookmarks, #102 headings from handwriting size and #46 slide
 * changes): one ordered, nested list built from the document, never stored (no format change). Pure: no 'obsidian'.
 *
 * Sources, each can be left out:
 *  - bookmarks: the titled bookmarks of the notebook (`meta.bookmarks`), top level;
 *  - slides: a PDF document when the background's file changes, a slide when the background's PDF page changes;
 *  - headings: lines of large handwriting found geometrically (`ink/headings.ts`, no OCR, no recognised text);
 *  - markers: questions, homework and the importance markers (gaps are placeholders, not outline material).
 *
 * Order: by page, then by position on the page (bookmarks, documents and slides belong to the top of their page).
 * Nesting: each entry has a `level` (smaller is higher); `depth` follows from a stack of the entries above, so a
 * level-2 heading after a level-1 one is a child, and a level-1 entry after both closes them.
 *
 * Cost: the text layout of a page is cached by the identity of its strokes (strokes are immutable), so a page that did
 * not change costs a pointer comparison per stroke; everything else is a single pass over the pages.
 */
import { detectHeadings, lineSizes, pageLayout, referenceHeight, type LineSize, type PageHeading } from "../ink/headings";
import { bookmarkColor } from "./bookmarks";
import type { Asset, MarkerElement, MarkerKind, NotebookMeta, Page, Stroke } from "./types";

export const OUTLINE_SOURCES = ["bookmarks", "slides", "headings", "markers"] as const;
export type OutlineSource = (typeof OUTLINE_SOURCES)[number];
export type OutlineSources = Readonly<Record<OutlineSource, boolean>>;

export const DEFAULT_OUTLINE_SOURCES: OutlineSources = Object.freeze({ bookmarks: true, slides: true, headings: true, markers: true });

/** Marker kinds that appear in the outline. */
export const OUTLINE_MARKER_KINDS: readonly MarkerKind[] = ["question", "homework", "critical", "star", "important"];

/** Levels of the entries (smaller is higher). Headings take levels 3 and 4 so that they nest under a slide. */
const LEVEL = { bookmark: 1, document: 1, slide: 2, heading1: 3, heading2: 4, marker: 5 } as const;

/** Pages with more strokes than this are not searched for headings (the outline must stay cheap on a heavy page). */
export const MAX_HEADING_STROKES = 4000;

export type OutlineKind = "bookmark" | "document" | "slide" | "heading" | "marker";

export interface OutlineItem {
	/** Stable between builds of the same document: used as the key of the row. */
	key: string;
	kind: OutlineKind;
	source: OutlineSource;
	pageId: string;
	/** 0-based page index. */
	index: number;
	/** Position on the page (pt, from the top). */
	y: number;
	/** 1-based nesting depth to show (after normalising by the entries above). */
	depth: number;
	/** What the entry says: a bookmark title, a marker label, a PDF file name. Empty when there is none (the UI names the entry). */
	title: string;
	/** Bookmark colour; null for the accent colour. */
	color: string | null;
	category: string | null;
	/** Slide: the PDF asset and its 1-based page. Document: the asset. */
	slide?: { asset: string; page: number };
	/** Heading: the ink to show as a thumbnail (`rect` in page pt) and how much larger than usual it is. */
	heading?: { rect: PageHeading["rect"]; strokeIds: string[]; ratio: number; level: 1 | 2 };
	marker?: { kind: MarkerKind; done: boolean };
}

export interface OutlineInput {
	pages: readonly Page[];
	meta?: NotebookMeta | undefined;
	assets?: Readonly<Record<string, Asset>> | undefined;
}

interface PageCache {
	strokes: readonly Stroke[];
	sizes: LineSize[];
	layout: ReturnType<typeof pageLayout>;
	width: number;
	height: number;
	/** Headings with the notebook reference they were found with (0: the page's own). */
	headings: { reference: number; list: PageHeading[] } | null;
}

/** Builds the outline and keeps the per-page work between builds. One instance per open notebook. */
export class OutlineBuilder {
	private readonly pages = new Map<string, PageCache>();
	/** Pages whose layout was computed by the last build (for tests and the status of the cache). */
	lastComputed = 0;

	/** The outline of `input` with the given sources (default: all). */
	build(input: OutlineInput, sources: OutlineSources = DEFAULT_OUTLINE_SOURCES): OutlineItem[] {
		this.lastComputed = 0;
		const items: Array<{ item: OutlineItem; rank: number; level: number; seq: number }> = [];
		let seq = 0;
		const push = (item: OutlineItem, level: number, rank: number) => items.push({ item, level, rank, seq: seq++ });
		const { pages } = input;

		if (sources.bookmarks && input.meta) {
			const marked = new Set(input.meta.bookmarks);
			pages.forEach((page, index) => {
				if (!marked.has(page.id)) return;
				const info = input.meta?.bookmarkInfo?.[page.id];
				push({
					key: `b:${page.id}`, kind: "bookmark", source: "bookmarks", pageId: page.id, index, y: -3, depth: 1,
					title: info?.title ?? "", color: bookmarkColor(info), category: info?.category ?? null,
				}, LEVEL.bookmark, 0);
			});
		}

		if (sources.slides) {
			let prev: { asset: string; page: number } | null = null;
			pages.forEach((page, index) => {
				const bg = page.background;
				if (bg?.kind !== "pdf") return;
				if (!prev || prev.asset !== bg.asset) {
					push({
						key: `d:${page.id}`, kind: "document", source: "slides", pageId: page.id, index, y: -2, depth: 1,
						title: input.assets?.[bg.asset]?.name ?? "", color: null, category: null, slide: { asset: bg.asset, page: bg.page },
					}, LEVEL.document, 1);
				}
				if (!prev || prev.asset !== bg.asset || prev.page !== bg.page) {
					push({
						key: `s:${page.id}`, kind: "slide", source: "slides", pageId: page.id, index, y: -1, depth: 2,
						title: "", color: null, category: null, slide: { asset: bg.asset, page: bg.page },
					}, LEVEL.slide, 2);
				}
				prev = { asset: bg.asset, page: bg.page };
			});
		}

		if (sources.headings) this.addHeadings(pages, push);

		if (sources.markers) {
			pages.forEach((page, index) => {
				for (const el of page.elements ?? []) {
					if (el.type !== "marker" || !OUTLINE_MARKER_KINDS.includes(el.kind)) continue;
					push({
						key: `m:${el.id}`, kind: "marker", source: "markers", pageId: page.id, index, y: el.y, depth: 1,
						title: markerTitle(el), color: null, category: null, marker: { kind: el.kind, done: el.done === true },
					}, LEVEL.marker, 3);
				}
			});
		}

		items.sort((a, b) => a.item.index - b.item.index || a.item.y - b.item.y || a.rank - b.rank || a.seq - b.seq);
		const stack: number[] = [];
		const out: OutlineItem[] = [];
		for (const { item, level } of items) {
			while (stack.length > 0 && stack[stack.length - 1]! >= level) stack.pop();
			stack.push(level);
			out.push({ ...item, depth: stack.length });
		}
		this.forget(pages);
		return out;
	}

	private addHeadings(pages: readonly Page[], push: (item: OutlineItem, level: number, rank: number) => void): void {
		const caches = pages.map((page) => (page.strokes.length > MAX_HEADING_STROKES ? null : this.cacheOf(page)));
		const reference = referenceHeight(caches.flatMap((c) => c?.sizes ?? []));
		pages.forEach((page, index) => {
			const cache = caches[index];
			if (!cache) return;
			if (!cache.headings || cache.headings.reference !== reference) {
				cache.headings = { reference, list: detectHeadings(cache.layout, page, reference) };
			}
			cache.headings.list.forEach((h, n) => {
				push({
					key: `h:${page.id}:${h.strokeIds[0] ?? n}`, kind: "heading", source: "headings", pageId: page.id, index, y: h.rect.y, depth: 1,
					title: "", color: null, category: null, heading: { rect: h.rect, strokeIds: h.strokeIds, ratio: h.ratio, level: h.level },
				}, h.level === 1 ? LEVEL.heading1 : LEVEL.heading2, 4);
			});
		});
	}

	/** The cached layout of a page, recomputed when its strokes or size changed. */
	private cacheOf(page: Page): PageCache {
		const have = this.pages.get(page.id);
		if (have && have.width === page.width && have.height === page.height && sameStrokes(have.strokes, page.strokes)) return have;
		const layout = pageLayout(page.strokes);
		const next: PageCache = { strokes: page.strokes.slice(), sizes: lineSizes(layout), layout, width: page.width, height: page.height, headings: null };
		this.pages.set(page.id, next);
		this.lastComputed++;
		return next;
	}

	/** Drops the cache of pages that are gone. */
	private forget(pages: readonly Page[]): void {
		if (this.pages.size <= pages.length) return;
		const ids = new Set(pages.map((p) => p.id));
		for (const id of [...this.pages.keys()]) if (!ids.has(id)) this.pages.delete(id);
	}
}

function sameStrokes(a: readonly Stroke[], b: readonly Stroke[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function markerTitle(el: MarkerElement): string {
	return el.text ?? "";
}

/** Items of the bookmark source whose category is `category`, as a flat list (the category filter of the outline). */
export function filterByCategory(items: readonly OutlineItem[], category: string | null): OutlineItem[] {
	if (category === null) return items.slice();
	return items.filter((i) => i.kind === "bookmark" && i.category === category).map((i) => ({ ...i, depth: 1 }));
}
