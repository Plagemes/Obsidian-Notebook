/**
 * Page trash (roadmap #26): deleted pages that stay recoverable after the session ends. Pure, no Obsidian.
 *
 * This is NOT part of the notebook format. Every entry is one small JSON file of its own in the plugin trash folder
 * (`_trash/pages/<notebook id>/<entry id>.json`, see storage/trash-paths.ts), written once and never rewritten, so
 * two devices that delete pages before they sync never write the same file (a shared, rewritten file would let the
 * last writer win, or leave a conflicted copy nobody reads). Files of the first layout (one file per notebook holding
 * every entry, `PageTrashFile`) are still read and moved over entry by entry. An entry holds the deleted page as a
 * one-page notebook document (so it is validated and migrated by the normal reader) together with the asset records
 * it needs. The assets themselves stay in `_assets/` and are referenced by id, as in the notebook.
 *
 * Retention: at most `PAGE_TRASH_MAX_ENTRIES` pages per notebook (the oldest go first) and none older than
 * `PAGE_TRASH_RETENTION_DAYS` days. The limits are applied each time a page is added.
 * Entries are kept as raw JSON; one that no longer validates is never rewritten or dropped except by those limits.
 */
import { cloneMeta, createId } from "./document";
import { copyBookmarkInfoMap } from "./bookmarks";
import { AddAsset, AddPage, Batch, SetMeta, type Command } from "./history";
import { duplicatePage } from "./pages";
import { parse, serialize } from "./serialize";
import { CURRENT_VERSION, DEFAULT_META, FORMAT_ID, type Asset, type NotebookDocument, type Page } from "./types";

export const PAGE_TRASH_FORMAT = "obsidian-notebook-page-trash";
export const PAGE_TRASH_VERSION = 1;
/** One entry per file (the current layout). */
export const PAGE_TRASH_ENTRY_FORMAT = "obsidian-notebook-page-trash-entry";
export const PAGE_TRASH_ENTRY_VERSION = 1;
export const PAGE_TRASH_MAX_ENTRIES = 50;
export const PAGE_TRASH_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface PageTrashEntry {
	id: string;
	/** Epoch ms. */
	deletedAt: number;
	/** Position the page had. */
	index: number;
	/** Id of the page that came before it, so the restore can follow that page if it moved. */
	afterPageId: string | null;
	/** One-page notebook document (format JSON as written by `serialize`). */
	document: unknown;
}

export interface PageTrashFile {
	format: typeof PAGE_TRASH_FORMAT;
	version: typeof PAGE_TRASH_VERSION;
	notebookId: string;
	entries: PageTrashEntry[];
}

export function emptyPageTrash(notebookId: string): PageTrashFile {
	return { format: PAGE_TRASH_FORMAT, version: PAGE_TRASH_VERSION, notebookId, entries: [] };
}

export type PageTrashParse = { ok: true; file: PageTrashFile } | { ok: false; message: string };

function parseEntry(e: unknown): PageTrashEntry | null {
	if (typeof e !== "object" || e === null) return null;
	const x = e as Record<string, unknown>;
	if (typeof x.id !== "string" || x.id === "" || typeof x.deletedAt !== "number" || typeof x.index !== "number") return null;
	return { id: x.id, deletedAt: x.deletedAt, index: x.index, afterPageId: typeof x.afterPageId === "string" ? x.afterPageId : null, document: x.document };
}

export function parsePageTrash(text: string): PageTrashParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, message: `invalid JSON: ${(e as Error).message}` };
	}
	if (typeof raw !== "object" || raw === null) return { ok: false, message: "not a page trash file" };
	const r = raw as Record<string, unknown>;
	if (r.format !== PAGE_TRASH_FORMAT) return { ok: false, message: "not a page trash file" };
	if (typeof r.version !== "number" || r.version > PAGE_TRASH_VERSION) return { ok: false, message: "page trash written by a newer version" };
	if (typeof r.notebookId !== "string" || !Array.isArray(r.entries)) return { ok: false, message: "malformed page trash file" };
	const entries: PageTrashEntry[] = [];
	for (const e of r.entries) {
		const entry = parseEntry(e);
		if (!entry) return { ok: false, message: "malformed entry" };
		entries.push(entry);
	}
	return { ok: true, file: { format: PAGE_TRASH_FORMAT, version: PAGE_TRASH_VERSION, notebookId: r.notebookId, entries } };
}

export type PageTrashEntryParse = { ok: true; notebookId: string; entry: PageTrashEntry } | { ok: false; message: string };

/** Text of the file that holds one entry (current layout). */
export function serializePageTrashEntry(notebookId: string, entry: PageTrashEntry): string {
	return JSON.stringify({ format: PAGE_TRASH_ENTRY_FORMAT, version: PAGE_TRASH_ENTRY_VERSION, notebookId, entry });
}

export function parsePageTrashEntry(text: string): PageTrashEntryParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, message: `invalid JSON: ${(e as Error).message}` };
	}
	if (typeof raw !== "object" || raw === null) return { ok: false, message: "not a page trash entry" };
	const r = raw as Record<string, unknown>;
	if (r.format !== PAGE_TRASH_ENTRY_FORMAT) return { ok: false, message: "not a page trash entry" };
	if (typeof r.version !== "number" || r.version > PAGE_TRASH_ENTRY_VERSION) return { ok: false, message: "page trash entry written by a newer version" };
	if (typeof r.notebookId !== "string") return { ok: false, message: "malformed page trash entry" };
	const entry = parseEntry(r.entry);
	return entry ? { ok: true, notebookId: r.notebookId, entry } : { ok: false, message: "malformed page trash entry" };
}

/**
 * Entries read from several files (entry files, their conflicted copies, files of the first layout), one per id.
 * Copies of an entry are identical (entry files are never rewritten); if two ever differ, the first one read is kept.
 */
export function mergeEntries(lists: ReadonlyArray<readonly PageTrashEntry[]>): PageTrashEntry[] {
	const byId = new Map<string, PageTrashEntry>();
	for (const list of lists) for (const e of list) if (!byId.has(e.id)) byId.set(e.id, e);
	return [...byId.values()];
}

/**
 * Ids of the entries that go when the limits are applied: an older entry of a page that was deleted again (the newest
 * one stays), entries older than the retention, and the oldest beyond the maximum count. Same rules as `addEntry`.
 */
export function entriesToDrop(entries: readonly PageTrashEntry[], now: number, max = PAGE_TRASH_MAX_ENTRIES, retentionDays = PAGE_TRASH_RETENTION_DAYS): Set<string> {
	const newestByPage = new Map<string, PageTrashEntry>();
	for (const e of entries) {
		const pageId = entryPageId(e);
		if (pageId === null) continue;
		const seen = newestByPage.get(pageId);
		if (!seen || e.deletedAt > seen.deletedAt || (e.deletedAt === seen.deletedAt && e.id > seen.id)) newestByPage.set(pageId, e);
	}
	const unique = entries.filter((e) => {
		const pageId = entryPageId(e);
		return pageId === null || newestByPage.get(pageId) === e;
	});
	const keep = new Set(pruneEntries(unique, now, max, retentionDays).map((e) => e.id));
	return new Set(entries.filter((e) => !keep.has(e.id)).map((e) => e.id));
}

export function serializePageTrash(file: PageTrashFile): string {
	return JSON.stringify(file);
}

/** Asset records `page` needs, taken from `doc`. */
function assetsNeeded(page: Page, doc: NotebookDocument): Record<string, Asset> {
	const out: Record<string, Asset> = {};
	const ids = new Set<string>();
	if (page.background) ids.add(page.background.asset);
	for (const el of page.elements ?? []) if (el.type === "image") ids.add(el.asset);
	for (const id of ids) {
		const a = doc.assets?.[id];
		if (a) out[id] = { ...a };
	}
	return out;
}

/** Entry for `page`, which sits at `index` in `doc` (call it before the page is removed). */
export function makeEntry(doc: NotebookDocument, page: Page, index: number, now: number): PageTrashEntry {
	const iso = new Date(now).toISOString();
	// The page's bookmark (v7: with its title, colour and category) travels with it, so a restore brings it back.
	const meta = cloneMeta(DEFAULT_META);
	if (doc.meta?.bookmarks.includes(page.id)) {
		meta.bookmarks = [page.id];
		const info = doc.meta.bookmarkInfo?.[page.id];
		if (info) meta.bookmarkInfo = copyBookmarkInfoMap({ [page.id]: info });
	}
	const mini: NotebookDocument = {
		format: FORMAT_ID, version: CURRENT_VERSION, id: createId(), createdAt: iso, modifiedAt: iso,
		pages: [page], meta, assets: assetsNeeded(page, doc),
	};
	return {
		id: createId(),
		deletedAt: now,
		index,
		afterPageId: index > 0 ? (doc.pages[index - 1]?.id ?? null) : null,
		document: JSON.parse(serialize(mini)),
	};
}

/** The entries that stay: not older than the retention, and the newest `max`. */
export function pruneEntries(
	entries: readonly PageTrashEntry[],
	now: number,
	max = PAGE_TRASH_MAX_ENTRIES,
	retentionDays = PAGE_TRASH_RETENTION_DAYS,
): PageTrashEntry[] {
	const fresh = entries.filter((e) => now - e.deletedAt < retentionDays * DAY_MS);
	const newestFirst = [...fresh].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, Math.max(0, max));
	const keep = new Set(newestFirst);
	return fresh.filter((e) => keep.has(e));
}

function entryPageId(entry: PageTrashEntry): string | null {
	const pages = (entry.document as { pages?: Array<{ id?: unknown }> } | null)?.pages;
	const id = pages?.[0]?.id;
	return typeof id === "string" ? id : null;
}

/** Adds `entry` (the same page deleted twice replaces its earlier entry) and applies the limits. */
export function addEntry(file: PageTrashFile, entry: PageTrashEntry, now: number): PageTrashFile {
	const pageId = entryPageId(entry);
	const others = file.entries.filter((e) => e.id !== entry.id && (pageId === null || entryPageId(e) !== pageId));
	return { ...file, entries: pruneEntries([...others, entry], now) };
}

export function removeEntry(file: PageTrashFile, id: string): PageTrashFile {
	return { ...file, entries: file.entries.filter((e) => e.id !== id) };
}

/** The deleted page read back (validated and migrated), or null if the entry is damaged. */
export function entryDocument(entry: PageTrashEntry): NotebookDocument | null {
	const r = parse(JSON.stringify(entry.document));
	return r.ok && r.doc.pages.length === 1 ? r.doc : null;
}

/** Entries to offer in the notebook: newest first, without the pages that are in the notebook again (an undone delete). */
export function visibleEntries(file: PageTrashFile, doc: NotebookDocument): PageTrashEntry[] {
	const present = new Set(doc.pages.map((p) => p.id));
	return [...file.entries]
		.filter((e) => {
			const id = entryPageId(e);
			return id === null || !present.has(id);
		})
		.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Position for the restored page: after the page that preceded it if that page still exists, else where it was (clamped). */
export function restoreIndex(doc: NotebookDocument, entry: PageTrashEntry): number {
	if (entry.afterPageId !== null) {
		const i = doc.pages.findIndex((p) => p.id === entry.afterPageId);
		if (i >= 0) return i + 1;
	}
	return Math.max(0, Math.min(Math.floor(entry.index), doc.pages.length));
}

export interface PageTrashRestorePlan {
	command: Command;
	/** Index of the restored page once the command is applied. */
	pageIndex: number;
}

/** Restoring a page is one undo step. Null when the entry cannot be read. */
export function planPageTrashRestore(doc: NotebookDocument, entry: PageTrashEntry): PageTrashRestorePlan | null {
	const saved = entryDocument(entry);
	const source = saved?.pages[0];
	if (!saved || !source) return null;
	// Keep the ids (bookmarks, links) unless the notebook already uses one of them.
	const used = new Set<string>();
	for (const p of doc.pages) {
		used.add(p.id);
		for (const s of p.strokes) used.add(s.id);
		for (const e of p.elements ?? []) used.add(e.id);
	}
	const clash = used.has(source.id) || source.strokes.some((s) => used.has(s.id)) || (source.elements ?? []).some((e) => used.has(e.id));
	const page = clash ? duplicatePage(source) : source;
	const commands: Command[] = [];
	for (const a of Object.values(saved.assets ?? {})) {
		if (doc.assets && Object.prototype.hasOwnProperty.call(doc.assets, a.id)) continue;
		commands.push(new AddAsset({ ...a }));
	}
	const pageIndex = restoreIndex(doc, entry);
	commands.push(new AddPage(page, pageIndex));
	// The bookmark the page had (under its new id when the ids had to change).
	if (saved.meta?.bookmarks.includes(source.id)) {
		const before = cloneMeta(doc.meta ?? DEFAULT_META);
		const after = cloneMeta(before);
		if (!after.bookmarks.includes(page.id)) after.bookmarks.push(page.id);
		const info = saved.meta.bookmarkInfo?.[source.id];
		if (info) after.bookmarkInfo = { ...(after.bookmarkInfo ?? {}), ...copyBookmarkInfoMap({ [page.id]: info }) };
		commands.push(new SetMeta(before, after));
	}
	return { command: new Batch("Restore deleted page", commands), pageIndex };
}

/** Ids of the assets that deleted pages still need; a future clean-up of `_assets/` must keep them (#27). */
export function trashedAssetIds(file: PageTrashFile): Set<string> {
	const ids = new Set<string>();
	for (const e of file.entries) {
		const assets = (e.document as { assets?: Record<string, unknown> } | null)?.assets;
		if (assets && typeof assets === "object") for (const id of Object.keys(assets)) ids.add(id);
	}
	return ids;
}
