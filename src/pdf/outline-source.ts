/**
 * Where the notebook gets the outline of its PDFs (0.16, roadmap #46): from memory, else from the device's cache of
 * outlines already read (pdf/outline-cache.ts), else from the PDF itself, once. A PDF is never parsed again on a later
 * open; a file that could not be read is tried again after a while, not on every refresh. Pure over injected storage and
 * reader, so it runs in Node tests.
 */
import { normaliseOutlineCache, OUTLINE_CACHE_KEY, storeOutline, type OutlineCacheData } from "./outline-cache";
import type { PdfOutlineEntry } from "./pdf-outline";

/** The part of Obsidian's App that holds per-device values. */
export interface OutlineStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export interface OutlineSourceDeps {
	storage: OutlineStorage;
	/** Reads the outline from the PDF (rejects when the file cannot be read). */
	read(assetId: string): Promise<PdfOutlineEntry[]>;
	/** Something new is known: the outline should be built again. */
	changed(): void;
	now?: () => number;
}

/** A PDF that could not be read is tried again after this long, ms. */
export const RETRY_MS = 60_000;

export class PdfOutlineSource {
	private cache: OutlineCacheData | null = null;
	private readonly pending = new Set<string>();
	private readonly failed = new Map<string, number>();
	/** How many PDFs were read from the file (not from the cache) by this instance: for tests and the status of the cache. */
	reads = 0;

	constructor(private readonly deps: OutlineSourceDeps) {}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private load(): OutlineCacheData {
		if (!this.cache) {
			let raw: unknown = null;
			try {
				raw = this.deps.storage.loadLocalStorage(OUTLINE_CACHE_KEY);
			} catch {
				raw = null;
			}
			this.cache = normaliseOutlineCache(raw);
		}
		return this.cache;
	}

	/** The outline of a PDF if it is known (an empty list: it has none); otherwise undefined, and it is read in the background. */
	get(assetId: string): readonly PdfOutlineEntry[] | undefined {
		const have = this.load()[assetId];
		if (have) return have.entries;
		this.fetch(assetId);
		return undefined;
	}

	/** The known outlines of these PDFs; the ones not known yet are read in the background. */
	known(assetIds: Iterable<string>): Record<string, readonly PdfOutlineEntry[]> {
		const out: Record<string, readonly PdfOutlineEntry[]> = {};
		for (const id of assetIds) {
			const entries = this.get(id);
			if (entries) out[id] = entries;
		}
		return out;
	}

	private fetch(assetId: string): void {
		if (this.pending.has(assetId)) return;
		const failedAt = this.failed.get(assetId);
		if (failedAt !== undefined && this.now() - failedAt < RETRY_MS) return;
		this.pending.add(assetId);
		this.deps.read(assetId).then(
			(entries) => {
				this.pending.delete(assetId);
				this.failed.delete(assetId);
				this.reads++;
				this.cache = storeOutline(this.load(), assetId, entries, this.now());
				try {
					this.deps.storage.saveLocalStorage(OUTLINE_CACHE_KEY, this.cache);
				} catch {
					/* the cache is a convenience: the outline is shown anyway */
				}
				this.deps.changed();
			},
			() => {
				this.pending.delete(assetId);
				this.failed.set(assetId, this.now());
			},
		);
	}
}
