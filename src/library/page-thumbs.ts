/**
 * 0.13: thumbnails of single pages for Home (the Continue card, the pages of Recent notes). The library index keeps only the
 * first page of each notebook (library/thumbnail.ts); these are drawn on demand when a box scrolls into view, one at a time
 * and only while the pen is quiet, and cached in memory (never stored). Boxes carry what to draw in `data-page-thumb-*`.
 */
import type { TFile } from "obsidian";
import type { NotebookDocument, Page } from "../model/types";
import { renderThumbnail, type ThumbnailOptions } from "./thumbnail";

export interface PageThumbDeps {
	fileOf(path: string): TFile | null;
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	background?(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null>;
	/** Resolves when the pen is quiet (writing guard). */
	idle(): Promise<void>;
	isClosed(): boolean;
}

const CACHE_MAX = 80;
const DOCS_MAX = 3;

export class PageThumbs {
	private readonly cache = new Map<string, string>();
	private readonly failed = new Set<string>();
	private readonly docs = new Map<string, NotebookDocument>();
	private readonly queue: Array<{ el: HTMLElement; key: string; path: string; mtime: number; pageId: string | undefined; width: number }> = [];
	private running = false;

	constructor(private readonly deps: PageThumbDeps, private readonly mtimeOf: (path: string) => number) {}

	/** Fills a `.nb-page-thumb` box: from the cache at once, else after drawing. */
	fill(el: HTMLElement): void {
		const path = el.dataset.pageThumbPath;
		if (!path) return;
		const pageId = el.dataset.pageThumbId || undefined;
		const width = Number(el.dataset.pageThumbWidth) || 200;
		const mtime = this.mtimeOf(path);
		const key = `${path}@${mtime}#${pageId ?? "first"}@${width}`;
		const url = this.cache.get(key);
		if (url) return show(el, url);
		if (this.failed.has(key)) return;
		this.queue.push({ el, key, path, mtime, pageId, width });
		void this.run();
	}

	clear(): void {
		this.queue.length = 0;
		this.cache.clear();
		this.docs.clear();
	}

	private async run(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0 && !this.deps.isClosed()) {
				await this.deps.idle();
				const job = this.queue.shift();
				if (!job || this.deps.isClosed()) break;
				if (!job.el.isConnected) continue;
				const cached = this.cache.get(job.key);
				if (cached) {
					show(job.el, cached);
					continue;
				}
				try {
					const url = await this.draw(job.path, job.mtime, job.pageId, job.width);
					if (url) {
						this.remember(job.key, url);
						if (job.el.isConnected) show(job.el, url);
					} else this.failed.add(job.key);
				} catch (e) {
					console.error("[notebook] page thumbnail failed", job.path, e);
					this.failed.add(job.key);
				}
				await new Promise<void>((r) => window.setTimeout(r, 8));
			}
		} finally {
			this.running = false;
		}
	}

	private remember(key: string, url: string): void {
		this.cache.set(key, url);
		if (this.cache.size > CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
	}

	private async draw(path: string, mtime: number, pageId: string | undefined, width: number): Promise<string> {
		const file = this.deps.fileOf(path);
		if (!file) return "";
		const docKey = `${path}@${mtime}`;
		let doc = this.docs.get(docKey) ?? null;
		if (!doc) {
			doc = await this.deps.readNotebook(file);
			if (!doc) return "";
			this.docs.set(docKey, doc);
			if (this.docs.size > DOCS_MAX) {
				const oldest = this.docs.keys().next().value;
				if (oldest !== undefined) this.docs.delete(oldest);
			}
		}
		const page = (pageId ? doc.pages.find((p) => p.id === pageId) : undefined) ?? doc.pages[0];
		if (!page) return "";
		const drawBackground = await this.deps.background?.(doc, page, width);
		return renderThumbnail(page, width, { drawBackground: drawBackground ?? undefined, mime: "image/jpeg", quality: 0.82 });
	}
}

function show(el: HTMLElement, url: string): void {
	el.empty();
	el.createEl("img", { attr: { src: url, alt: "", draggable: "false", decoding: "async" } });
}
