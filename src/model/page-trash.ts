/**
 * Page trash (roadmap #26): deleted pages that stay recoverable after the session ends. Pure, no Obsidian.
 *
 * This is NOT part of the notebook format. Each notebook has one JSON file in the plugin trash folder
 * (storage/trash-paths.ts); an entry holds the deleted page as a one-page notebook document (so it is
 * validated and migrated by the normal reader) together with the asset records it needs. The assets
 * themselves stay in `_assets/` and are referenced by id, as in the notebook.
 *
 * Retention: at most `PAGE_TRASH_MAX_ENTRIES` pages per notebook (the oldest go first) and none older than
 * `PAGE_TRASH_RETENTION_DAYS` days. The limits are applied each time a page is added.
 * Entries are kept as raw JSON; one that no longer validates is never rewritten or dropped except by those limits.
 */
import { cloneMeta, createId } from "./document";
import { AddAsset, AddPage, Batch, type Command } from "./history";
import { duplicatePage } from "./pages";
import { parse, serialize } from "./serialize";
import { CURRENT_VERSION, DEFAULT_META, FORMAT_ID, type Asset, type NotebookDocument, type Page } from "./types";

export const PAGE_TRASH_FORMAT = "obsidian-notebook-page-trash";
export const PAGE_TRASH_VERSION = 1;
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
		if (typeof e !== "object" || e === null) return { ok: false, message: "malformed entry" };
		const x = e as Record<string, unknown>;
		if (typeof x.id !== "string" || typeof x.deletedAt !== "number" || typeof x.index !== "number") return { ok: false, message: "malformed entry" };
		entries.push({ id: x.id, deletedAt: x.deletedAt, index: x.index, afterPageId: typeof x.afterPageId === "string" ? x.afterPageId : null, document: x.document });
	}
	return { ok: true, file: { format: PAGE_TRASH_FORMAT, version: PAGE_TRASH_VERSION, notebookId: r.notebookId, entries } };
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
	const mini: NotebookDocument = {
		format: FORMAT_ID, version: CURRENT_VERSION, id: createId(), createdAt: iso, modifiedAt: iso,
		pages: [page], meta: cloneMeta(DEFAULT_META), assets: assetsNeeded(page, doc),
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
