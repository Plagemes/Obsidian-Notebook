/**
 * Pure planning of "Move to notebook…" (no DOM, no 'obsidian'): which pages and files travel, and which pages may leave
 * the source afterwards. The caller does the writing: target first, then — only if it saved — the removal from the source.
 */
import { createPage } from "../model/document";
import { duplicatePage } from "../model/pages";
import { parse } from "../model/serialize";
import type { Asset, NotebookDocument, Page } from "../model/types";

export type PageMoveFailure =
	| { ok: false; reason: "no-pages" }
	| { ok: false; reason: "unknown-page"; pageId: string }
	| { ok: false; reason: "missing-asset"; assetId: string };

export interface PageMovePlan {
	ok: true;
	/** Copies of the pages (new page, stroke and element ids), in source order, ready to be inserted in the target. */
	pages: Page[];
	/** Asset records the target needs and does not have yet. The files are content-addressed and shared. */
	assets: Asset[];
	/** Source pages that move, with a snapshot of how they were when copied (to notice later edits). */
	moved: Array<{ pageId: string; snapshot: string }>;
}

/** Ids of the assets a page uses (its background and its image elements). */
export function pageAssetIds(page: Page): string[] {
	const ids = new Set<string>();
	if (page.background) ids.add(page.background.asset);
	for (const el of page.elements ?? []) if (el.type === "image") ids.add(el.asset);
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
	return {
		ok: true,
		pages: chosen.map((p) => duplicatePage(p)),
		assets,
		moved: chosen.map((p) => ({ pageId: p.id, snapshot: pageSnapshot(p) })),
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
