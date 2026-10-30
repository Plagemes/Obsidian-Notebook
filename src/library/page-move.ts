/**
 * Pure planning of "Move to notebook…" (no DOM, no 'obsidian'): which pages and files travel, and which pages may leave
 * the source afterwards. The caller does the writing: target first, then — only if it saved — the removal from the source.
 */
import { elementAssetId } from "../model/excerpts";
import { normalizeBookmarkInfo, setBookmark } from "../model/bookmarks";
import { cloneMeta, createPage } from "../model/document";
import { duplicatePage } from "../model/pages";
import { parse } from "../model/serialize";
import { DEFAULT_META, type Asset, type BookmarkInfo, type NotebookDocument, type NotebookMeta, type Page } from "../model/types";

export type PageMoveFailure =
	| { ok: false; reason: "no-pages" }
	| { ok: false; reason: "unknown-page"; pageId: string }
	| { ok: false; reason: "missing-asset"; assetId: string };

export interface PageMovePlan {
	ok: true;
	/**
	 * Copies of the pages, in source order, ready to be inserted in the target. Each keeps its page id, so stable links
	 * (`#p3&id=…`) can follow it, unless the target already has a page with that id: then it gets a new one (`renamed`).
	 * Strokes and elements get new ids.
	 */
	pages: Page[];
	/** Pages that had to get a new id in the target (old id -> new id), for "Update links" (storage/page-moves.ts). */
	renamed: Array<{ from: string; to: string }>;
	/** Asset records the target needs and does not have yet. The files are content-addressed and shared. */
	assets: Asset[];
	/** Source pages that move, with a snapshot of how they were when copied (to notice later edits). */
	moved: Array<{ pageId: string; snapshot: string }>;
	/**
	 * v7: bookmarks of the moved pages, under the copies' page ids, with their details (title, colour,
	 * category). Added to the target's metadata in the same write as the pages (`withMovedBookmarks`). Page
	 * tags need nothing here: they travel with the page.
	 */
	bookmarks: Array<{ pageId: string; info?: BookmarkInfo }>;
}

/** `meta` (the target's, current) with the bookmarks of the moved pages added; `meta` itself when there are none. */
export function withMovedBookmarks(meta: NotebookMeta | undefined, bookmarks: PageMovePlan["bookmarks"]): NotebookMeta {
	let out = meta ? cloneMeta(meta) : cloneMeta(DEFAULT_META);
	for (const b of bookmarks) out = setBookmark(out, b.pageId, b.info);
	return out;
}

/** Ids of the assets a page uses (its background and its image elements). */
export function pageAssetIds(page: Page): string[] {
	const ids = new Set<string>();
	if (page.background) ids.add(page.background.asset);
	for (const el of page.elements ?? []) {
		const id = elementAssetId(el);
		if (id !== null) ids.add(id);
	}
	return [...ids];
}

/** Text that changes whenever the page's content does (strokes, elements, background, size, paper). */
export function pageSnapshot(page: Page): string {
	return JSON.stringify(page);
}

/**
 * Plans moving the pages `pageIds` of `source` to the end of `target`. Pages keep the order they have in the source,
 * whatever the order of `pageIds`. Asset records the target already has (same content id) are not added again.
 */
export function planPageMove(source: NotebookDocument, pageIds: readonly string[], target: NotebookDocument): PageMovePlan | PageMoveFailure {
	const wanted = new Set(pageIds);
	if (wanted.size === 0) return { ok: false, reason: "no-pages" };
	for (const id of wanted) if (!source.pages.some((p) => p.id === id)) return { ok: false, reason: "unknown-page", pageId: id };
	const chosen = source.pages.filter((p) => wanted.has(p.id));
	const assets: Asset[] = [];
	const seen = new Set<string>();
	for (const page of chosen) {
		for (const id of pageAssetIds(page)) {
			if (seen.has(id)) continue;
			seen.add(id);
			if (target.assets && Object.prototype.hasOwnProperty.call(target.assets, id)) continue;
			const record = source.assets?.[id];
			if (!record) return { ok: false, reason: "missing-asset", assetId: id };
			assets.push({ ...record });
		}
	}
	// Keep the page ids unless the target already uses one (a copy of the notebook, a page moved there before).
	const taken = new Set(target.pages.map((p) => p.id));
	const renamed: PageMovePlan["renamed"] = [];
	const pages = chosen.map((p) => {
		const copy = duplicatePage(p);
		if (taken.has(p.id)) renamed.push({ from: p.id, to: copy.id });
		else copy.id = p.id;
		taken.add(copy.id);
		return copy;
	});
	const marked = new Set(source.meta?.bookmarks ?? []);
	const bookmarks: PageMovePlan["bookmarks"] = [];
	chosen.forEach((p, i) => {
		if (!marked.has(p.id)) return;
		const info = Object.prototype.hasOwnProperty.call(source.meta?.bookmarkInfo ?? {}, p.id) ? normalizeBookmarkInfo(source.meta?.bookmarkInfo?.[p.id]) : undefined;
		bookmarks.push(info ? { pageId: pages[i]!.id, info } : { pageId: pages[i]!.id });
	});
	return {
		ok: true,
		pages,
		renamed,
		assets,
		moved: chosen.map((p) => ({ pageId: p.id, snapshot: pageSnapshot(p) })),
		bookmarks,
	};
}

export interface SourceRemoval {
	/** Pages to delete from the source: the moved ones that are still exactly as they were copied. */
	remove: Page[];
	/** Moved pages edited since they were copied; they stay in the source. */
	changed: string[];
	/** Moved pages that no longer exist in the source (already deleted). */
	gone: string[];
	/** A blank page like the last removed one to add to the source, which may never be left without pages. */
	replacement: Page | null;
}

/** Which pages may leave the source now that the target has saved. */
export function planSourceRemoval(current: NotebookDocument, moved: PageMovePlan["moved"]): SourceRemoval {
	const remove: Page[] = [];
	const changed: string[] = [];
	const gone: string[] = [];
	for (const m of moved) {
		const page = current.pages.find((p) => p.id === m.pageId);
		if (!page) gone.push(m.pageId);
		else if (pageSnapshot(page) !== m.snapshot) changed.push(m.pageId);
		else remove.push(page);
	}
	let replacement: Page | null = null;
	if (remove.length > 0 && remove.length === current.pages.length) {
		const like = remove[remove.length - 1]!;
		replacement = createPage({ width: like.width, height: like.height }, { ...like.paper });
		if (like.infinite) replacement.infinite = true;
	}
	return { remove, changed, gone, replacement };
}

/** Short text that tells pages apart in the move dialog: the start of the first text box, or "". */
export function pageExcerpt(page: Page, max = 40): string {
	for (const el of page.elements ?? []) {
		if (el.type !== "text") continue;
		const text = el.text.replace(/\s+/g, " ").trim();
		if (text) return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
	}
	return "";
}

/**
 * Whether the document text read back from the destination's file holds every moved page. The source keeps its pages
 * unless this is true: a destination that was deleted, turned read-only or reloaded during the move did not store them.
 */
export function holdsPages(text: string, pageIds: readonly string[]): boolean {
	const back = parse(text);
	if (!back.ok) return false;
	const ids = new Set(back.doc.pages.map((p) => p.id));
	return pageIds.length > 0 && pageIds.every((id) => ids.has(id));
}

/**
 * Whether a move into an open destination may remove the pages from the source. The file read back decides
 * (`stored`): a flush that failed only because the user kept writing in the destination after the pages were saved
 * must not leave the same pages in both notebooks. `flushed` only picks the message when they are not in the file.
 */
export function destinationVerdict(flushed: boolean, stored: boolean): "ok" | "not-saved" | "not-stored" {
	if (stored) return "ok";
	return flushed ? "not-stored" : "not-saved";
}
