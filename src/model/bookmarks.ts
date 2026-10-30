/**
 * v7 bookmarks with details (roadmap #15 outline, #85 coloured bookmarks with categories). Pure, no Obsidian.
 *
 * Which pages are bookmarked stays in `meta.bookmarks` (page ids, as since v4); the optional details of each
 * bookmark (title, colour, category) are in `meta.bookmarkInfo`, keyed by page id. Every change goes through
 * `SetMeta`, so it is one undo step. The outline lists the bookmarks in page order.
 */
import { BOOKMARK_CATEGORIES, type BookmarkInfo, type NotebookMeta, type Page } from "./types";

/** Longest bookmark title and category name kept (characters). */
export const MAX_BOOKMARK_TITLE = 200;
export const MAX_BOOKMARK_CATEGORY = 60;

/** Colours offered for bookmarks (any #rrggbb is valid in the file). */
export const BOOKMARK_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"] as const;

/** Default colour of each built-in category, used when a bookmark has a category but no colour. */
export const CATEGORY_COLORS: Readonly<Record<(typeof BOOKMARK_CATEGORIES)[number], string>> = {
	important: "#ef4444",
	review: "#eab308",
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function clean(v: unknown, max: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.replace(/\s+/g, " ").trim().slice(0, max).trim();
	return s.length > 0 ? s : undefined;
}

/** Info with trimmed text, a valid colour and only the fields that are set; undefined when nothing is set. */
export function normalizeBookmarkInfo(info: BookmarkInfo | undefined): BookmarkInfo | undefined {
	if (!info) return undefined;
	const out: BookmarkInfo = {};
	const title = clean(info.title, MAX_BOOKMARK_TITLE);
	if (title !== undefined) out.title = title;
	if (typeof info.color === "string" && COLOR_RE.test(info.color)) out.color = info.color;
	const category = clean(info.category, MAX_BOOKMARK_CATEGORY);
	if (category !== undefined) out.category = category;
	return out.title === undefined && out.color === undefined && out.category === undefined ? undefined : out;
}

/**
 * Details kept for `bookmarks` (normalised, in bookmark order); undefined when there are none. Entries for
 * pages that are not bookmarked are dropped.
 */
export function normalizeBookmarkInfoMap(map: Readonly<Record<string, BookmarkInfo>> | undefined, bookmarks: readonly string[]): Record<string, BookmarkInfo> | undefined {
	if (!map) return undefined;
	const out: Record<string, BookmarkInfo> = {};
	let n = 0;
	for (const id of bookmarks) {
		// "__proto__" cannot be a plain object key: such a page keeps its bookmark without details.
		if (id === "__proto__" || !Object.prototype.hasOwnProperty.call(map, id)) continue;
		const info = normalizeBookmarkInfo(map[id]);
		if (info) {
			out[id] = info;
			n++;
		}
	}
	return n > 0 ? out : undefined;
}

export function copyBookmarkInfoMap(map: Readonly<Record<string, BookmarkInfo>> | undefined): Record<string, BookmarkInfo> | undefined {
	if (!map) return undefined;
	const out: Record<string, BookmarkInfo> = {};
	for (const [id, info] of Object.entries(map)) out[id] = { ...info };
	return out;
}

export function bookmarkInfoEquals(a: BookmarkInfo | undefined, b: BookmarkInfo | undefined): boolean {
	return (a?.title ?? "") === (b?.title ?? "") && (a?.color ?? "") === (b?.color ?? "") && (a?.category ?? "") === (b?.category ?? "");
}

export function bookmarkInfoMapEquals(a: Readonly<Record<string, BookmarkInfo>> | undefined, b: Readonly<Record<string, BookmarkInfo>> | undefined): boolean {
	const ka = Object.keys(a ?? {});
	const kb = Object.keys(b ?? {});
	if (ka.length !== kb.length) return false;
	return ka.every((k) => Object.prototype.hasOwnProperty.call(b ?? {}, k) && bookmarkInfoEquals(a?.[k], b?.[k]));
}

/** Copy of `meta` (arrays and details copied) with `fn` applied to the copy. */
function edit(meta: NotebookMeta, fn: (m: NotebookMeta) => void): NotebookMeta {
	const next: NotebookMeta = { tags: [...meta.tags], favorite: meta.favorite, cover: meta.cover, bookmarks: [...meta.bookmarks] };
	const info = copyBookmarkInfoMap(meta.bookmarkInfo);
	if (info) next.bookmarkInfo = info;
	fn(next);
	const normalized = normalizeBookmarkInfoMap(next.bookmarkInfo, next.bookmarks);
	if (normalized) next.bookmarkInfo = normalized;
	else delete next.bookmarkInfo;
	return next;
}

/** `meta` with `pageId` bookmarked (added at the end when it was not) and its details replaced by `info`. */
export function setBookmark(meta: NotebookMeta, pageId: string, info: BookmarkInfo | undefined): NotebookMeta {
	return edit(meta, (m) => {
		if (!m.bookmarks.includes(pageId)) m.bookmarks.push(pageId);
		const clean = normalizeBookmarkInfo(info);
		if (clean && pageId !== "__proto__") (m.bookmarkInfo ??= {})[pageId] = clean;
		else if (m.bookmarkInfo) delete m.bookmarkInfo[pageId];
	});
}

/** `meta` with the details of an existing bookmark changed by `patch` (fields set to "" or undefined are cleared). */
export function patchBookmark(meta: NotebookMeta, pageId: string, patch: BookmarkInfo): NotebookMeta {
	const current = meta.bookmarkInfo?.[pageId] ?? {};
	const merged: BookmarkInfo = { ...current };
	for (const key of ["title", "color", "category"] as const) {
		if (!(key in patch)) continue;
		const v = patch[key];
		if (v === undefined || v === "") delete merged[key];
		else merged[key] = v;
	}
	return setBookmark(meta, pageId, merged);
}

/** `meta` without the bookmark of `pageId` (and its details). */
export function removeBookmark(meta: NotebookMeta, pageId: string): NotebookMeta {
	return edit(meta, (m) => {
		m.bookmarks = m.bookmarks.filter((id) => id !== pageId);
		if (m.bookmarkInfo) delete m.bookmarkInfo[pageId];
	});
}

export interface OutlineEntry {
	pageId: string;
	/** 0-based page index. */
	index: number;
	/** Title as stored; empty when the bookmark has none (the UI shows the page number). */
	title: string;
	/** Colour to show: the stored one, else the built-in category's, else null (accent colour). */
	color: string | null;
	category: string | null;
}

/** Colour a bookmark is shown with. */
export function bookmarkColor(info: BookmarkInfo | undefined): string | null {
	if (info?.color) return info.color;
	const c = info?.category;
	return c && Object.prototype.hasOwnProperty.call(CATEGORY_COLORS, c) ? CATEGORY_COLORS[c as keyof typeof CATEGORY_COLORS] : null;
}

/** The outline: bookmarked pages in page order, optionally only those of `category`. */
export function outlineEntries(pages: readonly Page[], meta: NotebookMeta | undefined, category: string | null = null): OutlineEntry[] {
	if (!meta) return [];
	const marked = new Set(meta.bookmarks);
	const out: OutlineEntry[] = [];
	pages.forEach((page, index) => {
		if (!marked.has(page.id)) return;
		const info = meta.bookmarkInfo?.[page.id];
		const cat = info?.category ?? null;
		if (category !== null && cat !== category) return;
		out.push({ pageId: page.id, index, title: info?.title ?? "", color: bookmarkColor(info), category: cat });
	});
	return out;
}

/**
 * Categories in use, built-in ones first (in their fixed order), then custom ones alphabetically. With
 * `pages`, only bookmarks of those pages count (a bookmark left on a deleted page would give an empty filter).
 */
export function categoriesInUse(meta: NotebookMeta | undefined, pages?: readonly Pick<Page, "id">[]): string[] {
	const exists = pages ? new Set(pages.map((p) => p.id)) : null;
	const used = new Set<string>();
	for (const id of meta?.bookmarks ?? []) {
		if (exists && !exists.has(id)) continue;
		const c = meta?.bookmarkInfo?.[id]?.category;
		if (c) used.add(c);
	}
	const builtIn = BOOKMARK_CATEGORIES.filter((c) => used.has(c));
	const custom = [...used].filter((c) => !(BOOKMARK_CATEGORIES as readonly string[]).includes(c)).sort((a, b) => a.localeCompare(b));
	return [...builtIn, ...custom];
}

export function isBuiltInCategory(category: string): category is (typeof BOOKMARK_CATEGORIES)[number] {
	return (BOOKMARK_CATEGORIES as readonly string[]).includes(category);
}
