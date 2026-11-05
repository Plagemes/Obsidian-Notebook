/**
 * 0.19 Figures gallery (roadmap #228): every picture placed on the pages of a notebook (photos, board photos, imported pictures)
 * and every anchored excerpt that holds a picture (figure cut-outs), collected for a read-only grid. Pure (no 'obsidian', no DOM)
 * and format-neutral: everything is derived from the elements the document already has, nothing is stored.
 *
 * A "section" is a lecture: the pages from a lecture header up to the next one (`lectureRange` in markers.ts). A notebook without
 * lecture headers has no sections and the section scope is the whole notebook.
 */
import { lectureRange, startsLecture } from "./markers";
import type { ExcerptElement, ImageElement, Page } from "./types";

/** "photo": a picture placed on the page (taken, imported or pasted); "crop": an anchored excerpt that holds a snapshot. */
export const FIGURE_KINDS = ["photo", "crop"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export const FIGURE_SCOPES = ["section", "notebook", "range"] as const;
export type FigureScope = (typeof FIGURE_SCOPES)[number];

export interface FigureEntry {
	/** Stable within a document: `<page id>:<element id>`. */
	key: string;
	/** 0-based position and the id of the page the figure is on. */
	pageIndex: number;
	pageId: string;
	elementId: string;
	kind: FigureKind;
	/** The image asset that holds the picture (the pixels shown in the gallery). */
	asset: string;
	/** The box the figure covers on its page (page points; the bounding box when it is rotated). */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Width over height of the figure as placed (for the thumbnail's frame). */
	aspect: number;
}

/** The bounding box of an element's box, turned by `rotation` around its centre. */
export function turnedBox(box: { x: number; y: number; width: number; height: number }, rotation = 0): { x: number; y: number; width: number; height: number } {
	if (!Number.isFinite(rotation) || rotation === 0) return { ...box };
	const cos = Math.abs(Math.cos(rotation));
	const sin = Math.abs(Math.sin(rotation));
	const width = box.width * cos + box.height * sin;
	const height = box.width * sin + box.height * cos;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	return { x: cx - width / 2, y: cy - height / 2, width, height };
}

function finiteBox(b: { x: number; y: number; width: number; height: number }): boolean {
	return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width > 0 && b.height > 0;
}

function entryOf(pageIndex: number, page: Page, element: ImageElement | ExcerptElement, asset: string, kind: FigureKind): FigureEntry | null {
	const rotation = element.type === "image" ? element.rotation : 0;
	const box = turnedBox(element, rotation);
	if (!finiteBox(box)) return null;
	return {
		key: `${page.id}:${element.id}`, pageIndex, pageId: page.id, elementId: element.id, kind, asset,
		x: box.x, y: box.y, width: box.width, height: box.height, aspect: element.width / element.height,
	};
}

/** The pages `from` ≤ i < `to` as a list of 0-based indexes. */
export function indexesOf(range: { from: number; to: number }, count: number): number[] {
	const out: number[] = [];
	for (let i = Math.max(0, range.from); i < Math.min(range.to, count); i++) out.push(i);
	return out;
}

/** Whether the notebook has sections (some page starts a lecture): the section scope means something only then. */
export function hasSections(pages: readonly Page[]): boolean {
	return pages.some(startsLecture);
}

export interface ScopeInput {
	scope: FigureScope;
	/** The page in view (0-based). */
	current: number;
	/** The pages typed for the "range" scope (0-based, from parsePageRange). */
	range?: readonly number[] | null;
}

/**
 * The pages a scope covers, ascending. Section: the lecture of the current page (the whole notebook without lecture headers);
 * notebook: every page; range: the pages typed (none yet: an empty list).
 */
export function scopePages(pages: readonly Page[], input: ScopeInput): number[] {
	if (pages.length === 0) return [];
	if (input.scope === "notebook") return indexesOf({ from: 0, to: pages.length }, pages.length);
	if (input.scope === "range") return [...new Set(input.range ?? [])].filter((i) => i >= 0 && i < pages.length).sort((a, b) => a - b);
	if (!hasSections(pages)) return indexesOf({ from: 0, to: pages.length }, pages.length);
	return indexesOf(lectureRange(pages, input.current), pages.length);
}

/**
 * Figures of the given pages, in reading order (page, then top to bottom, then left to right). Pictures whose asset is not in the
 * document's list, and excerpts without a stored snapshot (they are drawn live from a page, there is no picture to list), are left out.
 * `assets`: the ids of the image assets of the document; absent: every asset id is accepted.
 */
export function collectFigures(pages: readonly Page[], indexes: readonly number[], assets?: ReadonlySet<string>): FigureEntry[] {
	const out: FigureEntry[] = [];
	for (const i of indexes) {
		const page = pages[i];
		if (!page) continue;
		const here: FigureEntry[] = [];
		for (const e of page.elements ?? []) {
			let entry: FigureEntry | null = null;
			if (e.type === "image" && e.asset && (!assets || assets.has(e.asset))) entry = entryOf(i, page, e, e.asset, "photo");
			else if (e.type === "excerpt" && e.asset && (!assets || assets.has(e.asset))) entry = entryOf(i, page, e, e.asset, "crop");
			if (entry) here.push(entry);
		}
		here.sort((a, b) => a.y - b.y || a.x - b.x);
		out.push(...here);
	}
	return out;
}

/** The figures of one kind (every figure for null). */
export function filterFigures(entries: readonly FigureEntry[], kind: FigureKind | null): FigureEntry[] {
	return kind === null ? [...entries] : entries.filter((e) => e.kind === kind);
}

export function figureCounts(entries: readonly FigureEntry[]): Record<FigureKind, number> & { total: number } {
	let photo = 0;
	let crop = 0;
	for (const e of entries) if (e.kind === "photo") photo++;
	else crop++;
	return { photo, crop, total: entries.length };
}

/** The number of different pages the figures are on (entries in page order). */
export function pageCount(entries: readonly FigureEntry[]): number {
	return new Set(entries.map((e) => e.pageIndex)).size;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Thumbnails: a small bounded cache and a one-at-a-time queue, so a gallery of hundreds of photos never decodes them all at once.

/** Thumbnails kept at most (least recently used go first). */
export const THUMB_CACHE_MAX = 60;
/** Pictures decoded at the same time. */
export const THUMB_CONCURRENCY = 1;
/** Width of a thumbnail, CSS px, before the device pixel ratio. */
export const THUMB_CSS_WIDTH = 220;
/** The device pixel ratio used for thumbnails never goes above this. */
export const THUMB_MAX_DPR = 2;

/** Pixel width of a thumbnail for a source picture `sourceWidth` px wide (never enlarged). */
export function thumbPixelWidth(sourceWidth: number, dpr: number): number {
	const wanted = Math.round(THUMB_CSS_WIDTH * Math.min(THUMB_MAX_DPR, Math.max(1, Number.isFinite(dpr) ? dpr : 1)));
	return Math.max(1, Math.min(wanted, Math.round(sourceWidth)));
}

/** A least-recently-used map with a fixed size; `onEvict` gives a dropped value back (to free it). */
export class LruCache<V> {
	private readonly map = new Map<string, V>();

	constructor(private readonly max: number, private readonly onEvict: (key: string, value: V) => void = () => undefined) {}

	get size(): number {
		return this.map.size;
	}

	get(key: string): V | undefined {
		const v = this.map.get(key);
		if (v === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, v);
		return v;
	}

	has(key: string): boolean {
		return this.map.has(key);
	}

	set(key: string, value: V): void {
		const old = this.map.get(key);
		if (old !== undefined && old !== value) this.onEvict(key, old);
		this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			const v = this.map.get(oldest) as V;
			this.map.delete(oldest);
			this.onEvict(oldest, v);
		}
	}

	clear(): void {
		for (const [k, v] of this.map) this.onEvict(k, v);
		this.map.clear();
	}
}

/**
 * Runs queued jobs `limit` at a time, in the order they were queued; a job that is queued again before it starts keeps its place
 * and a job can be cancelled before it starts (a card that scrolled away). The jobs are promises: the queue never throws.
 */
export class JobQueue {
	private readonly waiting: Array<{ key: string; run: () => Promise<void> }> = [];
	private running = 0;
	private stopped = false;

	constructor(private readonly limit: number = THUMB_CONCURRENCY) {}

	get pending(): number {
		return this.waiting.length;
	}

	add(key: string, run: () => Promise<void>): void {
		if (this.stopped || this.waiting.some((j) => j.key === key)) return;
		this.waiting.push({ key, run });
		this.pump();
	}

	cancel(key: string): void {
		const i = this.waiting.findIndex((j) => j.key === key);
		if (i >= 0) this.waiting.splice(i, 1);
	}

	/** Forgets the jobs that have not started; the queue takes new ones. */
	clear(): void {
		this.waiting.length = 0;
	}

	/** Forgets the jobs that have not started and takes no more. */
	stop(): void {
		this.stopped = true;
		this.waiting.length = 0;
	}

	private pump(): void {
		while (!this.stopped && this.running < this.limit && this.waiting.length > 0) {
			const job = this.waiting.shift()!;
			this.running++;
			void job.run().catch(() => undefined).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}
}
