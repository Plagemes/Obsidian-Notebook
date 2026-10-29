/**
 * Cache of PDF page text and the chunked search over it (roadmap 44). Pure over injected dependencies (the text
 * source, the clock and the yield), so it runs in Node tests with fakes.
 *
 * pdf.js reads and parses the text in its worker; what stays on the main thread is matching. The search therefore
 * fetches a few pages at a time, matches them, and gives the event loop back whenever it has used its time budget, so
 * typing, scrolling and drawing stay responsive on a PDF with hundreds of pages. A newer search cancels the older one.
 */
import type { PageTextContent } from "./text-items";
import { assemblePageText, findInPage, snippetOf, type PageText, type Snippet, type TextHit } from "./text-search";

/** Where page text comes from (`PdfStore.pageText`). */
export interface PdfTextSource {
	pageText(assetId: string, page: number): Promise<PageTextContent>;
}

/** The text of one PDF page, ready for matching and for placing matches on the page. */
export interface CachedPage {
	content: PageTextContent;
	text: PageText;
}

/** At most this many pages are kept (a few MB); the oldest go first. */
export const DEFAULT_CACHE_PAGES = 4000;

/**
 * Text per PDF page (asset id + 1-based page number). Concurrent requests for a page share one fetch. A page that cannot be
 * read is not cached (the next request tries again) and reads as empty.
 */
export class PageTextCache {
	private readonly pages = new Map<string, CachedPage>();
	private readonly pending = new Map<string, Promise<CachedPage | null>>();

	constructor(private readonly source: PdfTextSource, private readonly max = DEFAULT_CACHE_PAGES) {}

	get size(): number {
		return this.pages.size;
	}

	private static key(asset: string, page: number): string {
		return `${asset}|${page}`;
	}

	/** The page if it is cached already. */
	peek(asset: string, page: number): CachedPage | null {
		return this.pages.get(PageTextCache.key(asset, page)) ?? null;
	}

	/** The page's text; null when it could not be read. */
	get(asset: string, page: number): Promise<CachedPage | null> {
		const key = PageTextCache.key(asset, page);
		const hit = this.pages.get(key);
		if (hit) return Promise.resolve(hit);
		let p = this.pending.get(key);
		if (!p) {
			p = this.source.pageText(asset, page).then(
				(content) => {
					const entry: CachedPage = { content, text: assemblePageText(content.items) };
					this.store(key, entry);
					return entry;
				},
				() => null,
			).finally(() => this.pending.delete(key));
			this.pending.set(key, p);
		}
		return p;
	}

	/** Drops one PDF's pages (it was replaced), or everything. */
	clear(asset?: string): void {
		if (asset === undefined) {
			this.pages.clear();
			return;
		}
		const prefix = `${asset}|`;
		for (const key of [...this.pages.keys()]) if (key.startsWith(prefix)) this.pages.delete(key);
	}

	private store(key: string, entry: CachedPage): void {
		this.pages.set(key, entry);
		while (this.pages.size > this.max) {
			const oldest = this.pages.keys().next().value;
			if (oldest === undefined) break;
			this.pages.delete(oldest);
		}
	}
}

/** A page of the notebook that shows a PDF page. */
export interface SearchTarget {
	pageId: string;
	asset: string;
	/** 1-based page of the PDF. */
	pdfPage: number;
}

/** One match: where it is and the text around it. */
export interface SearchHit {
	target: SearchTarget;
	start: number;
	end: number;
	snippet: Snippet;
}

export interface SearchRunOptions {
	/** Through `normalizeQuery`; an empty query finds nothing. */
	query: string;
	/** In the order they are searched. */
	targets: readonly SearchTarget[];
	cache: PageTextCache;
	/** Stops after this many matches (the result is then flagged truncated). */
	limit?: number;
	/** Pages fetched at once. */
	batch?: number;
	/** Milliseconds of work between two yields to the event loop. */
	budgetMs?: number;
	now?: () => number;
	yieldToUi?: () => Promise<void>;
}

export interface SearchRunHandlers {
	/** New matches, in the order the pages were searched. */
	onHits(hits: SearchHit[]): void;
	onProgress?(done: number, total: number): void;
}

export interface SearchRunResult {
	truncated: boolean;
	cancelled: boolean;
	/** Pages whose text could not be read. */
	unreadable: number;
}

export const DEFAULT_HIT_LIMIT = 500;

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Searches `targets` in order. Resolves when everything was searched, the limit was reached or `signal.cancelled` turned
 * true (checked after every await). Pages of an unreadable PDF are skipped after the first failure.
 */
export async function runSearch(options: SearchRunOptions, handlers: SearchRunHandlers, signal: { cancelled: boolean }): Promise<SearchRunResult> {
	const { query, targets, cache } = options;
	const limit = options.limit ?? DEFAULT_HIT_LIMIT;
	const batch = Math.max(1, options.batch ?? 4);
	const budget = options.budgetMs ?? 8;
	const now = options.now ?? (() => performance.now());
	const yieldToUi = options.yieldToUi ?? defaultYield;
	const result: SearchRunResult = { truncated: false, cancelled: false, unreadable: 0 };
	if (!query) return result;

	const failed = new Set<string>();
	const matched = new Map<string, TextHit[]>();
	let total = 0;
	let sliceStart = now();
	for (let i = 0; i < targets.length; i += batch) {
		const group = targets.slice(i, i + batch).filter((t) => !failed.has(t.asset));
		const pages = await Promise.all(group.map((t) => cache.get(t.asset, t.pdfPage)));
		if (signal.cancelled) return { ...result, cancelled: true };
		for (let k = 0; k < group.length; k++) {
			const target = group[k]!;
			const page = pages[k];
			if (!page) {
				result.unreadable++;
				failed.add(target.asset);
				continue;
			}
			const key = `${target.asset}|${target.pdfPage}`;
			let hits = matched.get(key);
			if (!hits) {
				hits = findInPage(page.text, query, limit - total);
				matched.set(key, hits);
			}
			if (hits.length === 0) continue;
			const room = limit - total;
			const taken = hits.slice(0, room);
			handlers.onHits(taken.map((h) => ({ target, start: h.start, end: h.end, snippet: snippetOf(page.text.text, h) })));
			total += taken.length;
			if (total >= limit) {
				result.truncated = true;
				handlers.onProgress?.(Math.min(targets.length, i + k + 1), targets.length);
				return result;
			}
		}
		handlers.onProgress?.(Math.min(targets.length, i + batch), targets.length);
		if (now() - sliceStart >= budget) {
			await yieldToUi();
			if (signal.cancelled) return { ...result, cancelled: true };
			sliceStart = now();
		}
	}
	return result;
}
