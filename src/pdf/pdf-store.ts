import type { PdfDoc, PdfLib, PdfPage, PdfRenderTask } from "./pdfjs-types";
import { textBoxes, type PageTextContent } from "./text-items";

export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

/** A bitmap never exceeds this many device pixels per side (GPU texture / WebView canvas limits). */
export const MAX_BITMAP_SIDE = 4096;
export const DEFAULT_MEMORY_BUDGET_BYTES = 160 * 1024 * 1024;
export const DEFAULT_MAX_OPEN_DOCS = 3;

export interface PdfStoreOptions {
	loadPdfJs: () => Promise<PdfLib>;
	readAsset: (assetId: string) => Promise<ArrayBuffer>;
	createCanvas: (width: number, height: number) => CanvasLike;
	/** Total w*h*4 of cached bitmaps. Default 160 MB. */
	memoryBudgetBytes?: number;
	/** pdf.js documents kept open at once. Default 3. */
	maxOpenDocs?: number;
}

export interface PageSize {
	width: number;
	height: number;
}

/** What `peek` returns: the bitmap and the scale (device px per pt) it was rendered at. */
export interface PeekResult {
	canvas: CanvasLike;
	scale: number;
}

interface CacheEntry {
	assetId: string;
	page: number;
	scale: number;
	canvas: CanvasLike;
	bytes: number;
}

interface Job {
	key: string;
	pageKey: string;
	assetId: string;
	promise: Promise<CanvasLike>;
	cancelled: boolean;
	task: PdfRenderTask | null;
}

/** Error a superseded or evicted render rejects with; callers can ignore it (`isAbortError`). */
export function abortError(message = "render superseded"): Error {
	const e = new Error(message);
	e.name = "AbortError";
	return e;
}

export function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === "AbortError";
}

const scaleKey = (scale: number) => Math.round(scale * 1000) / 1000;
const cacheKey = (assetId: string, page: number, scale: number) => `${assetId}|${page}|${scale}`;

/**
 * PDF page rasteriser with caches. Pure logic over injected dependencies (pdf.js, asset reader,
 * canvas factory) so it runs in Node tests with fakes.
 *
 * - Bitmaps live in an LRU bounded by `memoryBudgetBytes` (the most recent one is always kept,
 *   even if it alone exceeds the budget).
 * - Identical concurrent `render` calls share one promise.
 * - A pending render of a page at another scale is cancelled when a new scale is requested
 *   (the old promise rejects with an AbortError; ignore it with `isAbortError`).
 * - At most `maxOpenDocs` pdf.js documents stay open (LRU, `destroy()` on eviction; a document
 *   with a render in flight is not evicted).
 * - The effective scale is clamped so that neither side exceeds `MAX_BITMAP_SIDE` (4096) px.
 */
export class PdfStore {
	private readonly cache = new Map<string, CacheEntry>();
	private cacheBytes = 0;
	private readonly docs = new Map<string, Promise<PdfDoc>>();
	private readonly sizes = new Map<string, Promise<PageSize[]>>();
	private readonly counts = new Map<string, Promise<number>>();
	private readonly jobs = new Map<string, Job>();
	private readonly jobByPage = new Map<string, Job>();
	/** Operations in progress per asset; a busy document is not closed by the LRU. */
	private readonly busy = new Map<string, number>();
	private readonly budget: number;
	private readonly maxDocs: number;

	constructor(private readonly deps: PdfStoreOptions) {
		this.budget = deps.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES;
		this.maxDocs = Math.max(1, deps.maxOpenDocs ?? DEFAULT_MAX_OPEN_DOCS);
	}

	/** Bytes currently held by cached bitmaps. */
	get cachedBytes(): number {
		return this.cacheBytes;
	}

	pageCount(assetId: string): Promise<number> {
		let p = this.counts.get(assetId);
		if (!p) {
			p = this.openDoc(assetId).then((d) => d.numPages);
			this.counts.set(assetId, p);
			p.catch(() => this.counts.delete(assetId));
		}
		return p;
	}

	/** Size of every page in pt (scale 1), cached. */
	pageSizes(assetId: string): Promise<PageSize[]> {
		let p = this.sizes.get(assetId);
		if (!p) {
			p = this.withBusy(assetId, async () => {
				const doc = await this.openDoc(assetId);
				const out: PageSize[] = [];
				for (let n = 1; n <= doc.numPages; n++) {
					const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
					out.push({ width: vp.width, height: vp.height });
				}
				return out;
			});
			this.sizes.set(assetId, p);
			p.catch(() => this.sizes.delete(assetId));
		}
		return p;
	}

	/**
	 * Text runs of `page` (1-based) with their boxes at scale 1, for re-published slide fingerprints and the
	 * annotation export. Not cached (callers read each page once). A pdf.js without text support, or a page
	 * whose text cannot be read, gives no items.
	 */
	pageText(assetId: string, page: number): Promise<PageTextContent> {
		return this.withBusy(assetId, async () => {
			const doc = await this.openDoc(assetId);
			if (!Number.isInteger(page) || page < 1 || page > doc.numPages) throw new RangeError(`page ${page} out of range (1..${doc.numPages})`);
			const p = await doc.getPage(page);
			const vp = p.getViewport({ scale: 1 });
			if (typeof p.getTextContent !== "function") return { width: vp.width, height: vp.height, items: [] };
			const content = await p.getTextContent();
			return { width: vp.width, height: vp.height, items: textBoxes(Array.isArray(content?.items) ? content.items : [], vp.transform) };
		});
	}

	/** Renders `page` (1-based) at `scale` device px per pt. */
	async render(assetId: string, page: number, scale: number): Promise<CanvasLike> {
		const size = await this.pageSize(assetId, page);
		const eff = this.clampScale(size, scale);
		const key = cacheKey(assetId, page, eff);

		const hit = this.cache.get(key);
		if (hit) {
			this.touch(key, hit);
			return hit.canvas;
		}
		const pending = this.jobs.get(key);
		if (pending) return pending.promise;

		const pageKey = `${assetId}|${page}`;
		const superseded = this.jobByPage.get(pageKey);
		if (superseded) this.cancel(superseded);

		const job: Job = { key, pageKey, assetId, cancelled: false, task: null, promise: Promise.resolve(null as never) };
		job.promise = this.withBusy(assetId, () => this.runJob(job, page, eff)).finally(() => {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
			if (this.jobByPage.get(pageKey) === job) this.jobByPage.delete(pageKey);
		});
		this.jobs.set(key, job);
		this.jobByPage.set(pageKey, job);
		return job.promise;
	}

	/**
	 * Best cached bitmap of a page, synchronously: the smallest scale >= `minScale`, otherwise the
	 * largest one below it (with `minScale` omitted: the largest). Null if there is none.
	 */
	peek(assetId: string, page: number, minScale?: number): PeekResult | null {
		const min = minScale ?? Infinity; // no minimum: the sharpest bitmap wins
		let above: CacheEntry | null = null;
		let below: CacheEntry | null = null;
		for (const e of this.cache.values()) {
			if (e.assetId !== assetId || e.page !== page) continue;
			if (e.scale >= min) {
				if (!above || e.scale < above.scale) above = e;
			} else if (!below || e.scale > below.scale) below = e;
		}
		const best = above ?? below;
		if (!best) return null;
		this.touch(cacheKey(best.assetId, best.page, best.scale), best);
		return { canvas: best.canvas, scale: best.scale };
	}

	/** Drops everything about one asset: bitmaps, sizes, pending renders, the open document. */
	evictAsset(assetId: string): void {
		for (const [key, e] of [...this.cache]) {
			if (e.assetId === assetId) this.drop(key, e);
		}
		for (const job of [...this.jobs.values()]) if (job.assetId === assetId) this.cancel(job);
		this.sizes.delete(assetId);
		this.counts.delete(assetId);
		this.closeDoc(assetId);
	}

	clear(): void {
		for (const job of [...this.jobs.values()]) this.cancel(job);
		this.cache.clear();
		this.cacheBytes = 0;
		this.sizes.clear();
		this.counts.clear();
		for (const id of [...this.docs.keys()]) this.closeDoc(id);
	}

	// ---------------------------------------------------------------------------------------

	private clampScale(size: PageSize, scale: number): number {
		const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
		const longest = Math.max(size.width, size.height, 1);
		// Floor (not round) the cap so the clamped bitmap is never above MAX_BITMAP_SIDE.
		const cap = Math.floor((MAX_BITMAP_SIDE / longest) * 1000) / 1000;
		return Math.min(scaleKey(s), cap);
	}

	private async pageSize(assetId: string, page: number): Promise<PageSize> {
		const sizes = await this.pageSizes(assetId);
		const size = sizes[page - 1];
		if (!size) throw new RangeError(`page ${page} out of range (1..${sizes.length})`);
		return size;
	}

	private async runJob(job: Job, pageNumber: number, scale: number): Promise<CanvasLike> {
		const check = () => {
			if (job.cancelled) throw abortError();
		};
		const doc = await this.openDoc(job.assetId);
		check();
		const page: PdfPage = await doc.getPage(pageNumber);
		check();
		const viewport = page.getViewport({ scale });
		const width = Math.max(1, Math.min(MAX_BITMAP_SIDE, Math.ceil(viewport.width)));
		const height = Math.max(1, Math.min(MAX_BITMAP_SIDE, Math.ceil(viewport.height)));
		const canvas = this.deps.createCanvas(width, height);
		const ctx = (canvas as HTMLCanvasElement).getContext("2d");
		if (!ctx) throw new Error("2d canvas context unavailable");
		const task = page.render({ canvasContext: ctx, viewport });
		job.task = task;
		try {
			await task.promise;
		} catch (e) {
			if (job.cancelled) throw abortError();
			throw e;
		}
		check();
		this.insert({ assetId: job.assetId, page: pageNumber, scale, canvas, bytes: width * height * 4 });
		return canvas;
	}

	private cancel(job: Job): void {
		if (job.cancelled) return;
		job.cancelled = true;
		try {
			job.task?.cancel();
		} catch {
			/* already finished */
		}
		if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
		if (this.jobByPage.get(job.pageKey) === job) this.jobByPage.delete(job.pageKey);
	}

	private insert(e: CacheEntry): void {
		const key = cacheKey(e.assetId, e.page, e.scale);
		const old = this.cache.get(key);
		if (old) this.drop(key, old);
		this.cache.set(key, e);
		this.cacheBytes += e.bytes;
		for (const [k, victim] of [...this.cache]) {
			if (this.cacheBytes <= this.budget || this.cache.size <= 1) break;
			if (victim === e) continue;
			this.drop(k, victim);
		}
	}

	private drop(key: string, e: CacheEntry): void {
		if (this.cache.delete(key)) this.cacheBytes -= e.bytes;
	}

	private touch(key: string, e: CacheEntry): void {
		this.cache.delete(key);
		this.cache.set(key, e);
	}

	private openDoc(assetId: string): Promise<PdfDoc> {
		const existing = this.docs.get(assetId);
		if (existing) {
			this.docs.delete(assetId);
			this.docs.set(assetId, existing); // most recently used
			return existing;
		}
		const p = (async () => {
			const [lib, data] = await Promise.all([this.deps.loadPdfJs(), this.deps.readAsset(assetId)]);
			return lib.getDocument({ data: new Uint8Array(data) }).promise;
		})();
		this.docs.set(assetId, p);
		p.then(
			() => this.trimDocs(),
			() => {
				if (this.docs.get(assetId) === p) this.docs.delete(assetId);
			},
		);
		return p;
	}

	/** Closes least recently used documents beyond the limit, sparing those with a render in flight. */
	private trimDocs(): void {
		for (const id of [...this.docs.keys()]) {
			if (this.docs.size <= this.maxDocs) return;
			if (this.busy.has(id)) continue;
			this.closeDoc(id);
		}
	}

	private async withBusy<T>(assetId: string, fn: () => Promise<T>): Promise<T> {
		this.busy.set(assetId, (this.busy.get(assetId) ?? 0) + 1);
		try {
			return await fn();
		} finally {
			const n = (this.busy.get(assetId) ?? 1) - 1;
			if (n <= 0) {
				this.busy.delete(assetId);
				this.trimDocs();
			} else this.busy.set(assetId, n);
		}
	}

	private closeDoc(assetId: string): void {
		const p = this.docs.get(assetId);
		if (!p) return;
		this.docs.delete(assetId);
		p.then((d) => d.destroy()).catch(() => undefined);
	}
}
