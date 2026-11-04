/**
 * The outlines of the PDFs the device has opened (0.16, roadmap #46), kept so that a PDF is parsed once, not on every open.
 * A PDF asset's id is the hash of its content, so the id is the cache key: a changed file is another asset. Kept in
 * Obsidian's per-device local storage, never in the notebook file or the vault, and bounded. Pure: no 'obsidian' import.
 *
 * An empty list is a result too ("this PDF has no outline"), so a PDF without one is not parsed again either.
 */
import { MAX_OUTLINE_ENTRIES, MAX_OUTLINE_LEVEL, type PdfOutlineEntry } from "./pdf-outline";

/** Local storage key. */
export const OUTLINE_CACHE_KEY = "notebook-pdf-outlines";
/** PDFs remembered; the least recently stored go first. */
export const MAX_CACHED_PDFS = 40;
/** The whole cache, serialised, stays under this many characters (the least recently stored PDFs go first). */
export const MAX_CACHE_CHARS = 512 * 1024;
/** One PDF whose serialised outline is larger than this is not cached at all (it is read again when needed). */
export const MAX_OUTLINE_CHARS = 128 * 1024;

export interface CachedOutline {
	/** When it was read, ms since the epoch (the oldest are forgotten first). */
	at: number;
	entries: PdfOutlineEntry[];
}

export type OutlineCacheData = Record<string, CachedOutline>;

const ASSET_ID = /^[A-Za-z0-9_.-]{8,80}$/;

function entryOf(v: unknown): PdfOutlineEntry | null {
	if (typeof v !== "object" || v === null) return null;
	const e = v as Record<string, unknown>;
	if (typeof e.title !== "string" || e.title.length === 0) return null;
	const level = typeof e.level === "number" && Number.isInteger(e.level) ? Math.min(MAX_OUTLINE_LEVEL, Math.max(1, e.level)) : 1;
	const page = typeof e.page === "number" && Number.isInteger(e.page) && e.page >= 0 && e.page < 100000 ? e.page : 0;
	return { title: e.title.slice(0, 200), level, page };
}

/** Whatever was stored, as a valid and bounded cache: bad ids and entries are dropped, the oldest PDFs are forgotten. */
export function normaliseOutlineCache(data: unknown): OutlineCacheData {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows: Array<[string, CachedOutline]> = [];
	for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
		if (!ASSET_ID.test(id) || typeof v !== "object" || v === null) continue;
		const row = v as Record<string, unknown>;
		if (!Array.isArray(row.entries)) continue;
		const entries = row.entries.slice(0, MAX_OUTLINE_ENTRIES).map(entryOf).filter((e): e is PdfOutlineEntry => e !== null);
		rows.push([id, { at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0, entries }]);
	}
	rows.sort((a, b) => b[1].at - a[1].at);
	// Newest first: keep rows while the count and the serialised size allow, so the oldest are evicted.
	const kept: Array<[string, CachedOutline]> = [];
	let chars = 0;
	for (const row of rows) {
		if (kept.length >= MAX_CACHED_PDFS) break;
		const size = outlineChars(row[1]);
		if (size > MAX_OUTLINE_CHARS || chars + size > MAX_CACHE_CHARS) continue;
		kept.push(row);
		chars += size;
	}
	return Object.fromEntries(kept);
}

/** Serialised size of one cached outline, in characters (what local storage holds, plus the id and punctuation). */
export function outlineChars(row: CachedOutline): number {
	return JSON.stringify(row).length + 90;
}

/** The cache after storing the outline of one PDF (a new object). */
export function storeOutline(cache: OutlineCacheData, assetId: string, entries: readonly PdfOutlineEntry[], now: number): OutlineCacheData {
	if (!ASSET_ID.test(assetId)) return cache;
	// A single huge outline is not cached (it would crowd out the rest); an older copy of it goes too, being out of date.
	if (outlineChars({ at: now, entries: [...entries] }) > MAX_OUTLINE_CHARS) {
		if (!(assetId in cache)) return cache;
		const { [assetId]: _dropped, ...rest } = cache;
		return rest;
	}
	return normaliseOutlineCache({ ...cache, [assetId]: { at: now, entries } });
}
