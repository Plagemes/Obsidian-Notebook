// 0.24 navadapt (#414): the page navigator adapts to the notebook. Mostly PDF or picture pages (an annotated PDF, slides)
// get large thumbnails; mostly written pages get a compact list (number, title, time, a small thumbnail); anything in between
// keeps the usual layout. The reader can override per notebook (Auto / Thumbnails / List), remembered on this device only,
// in bounded local storage. Pure logic: no DOM, no 'obsidian'.
import { pageTimes } from "../model/page-times";
import type { Page } from "../model/types";

export type NavMode = "auto" | "thumbs" | "list";
/** What the panel really shows: large thumbnails, the usual thumbnails, or the compact list. */
export type NavLayout = "large" | "normal" | "list";
export type NavKind = "media" | "written" | "mixed";

/** At least this share of pages with a PDF or picture background: a "media" notebook. */
export const MEDIA_SHARE = 0.6;
/** At most this share: a "written" notebook. */
export const WRITTEN_SHARE = 0.2;

/** Whether the notebook is mostly backgrounds (PDF, scans), mostly written pages, or a mix. An empty notebook is mixed. */
export function classifyPages(pages: ReadonlyArray<Pick<Page, "background">>): NavKind {
	if (pages.length === 0) return "mixed";
	let media = 0;
	for (const p of pages) if (p.background) media++;
	const share = media / pages.length;
	if (share >= MEDIA_SHARE) return "media";
	if (share <= WRITTEN_SHARE) return "written";
	return "mixed";
}

/** The layout for a mode and a notebook kind. */
export function resolveLayout(mode: NavMode, kind: NavKind): NavLayout {
	if (mode === "list") return "list";
	if (mode === "thumbs") return kind === "media" ? "large" : "normal";
	return kind === "media" ? "large" : kind === "written" ? "list" : "normal";
}

/** Next mode when the header toggle is pressed: Auto, Thumbnails, List. */
export function nextMode(mode: NavMode): NavMode {
	return mode === "auto" ? "thumbs" : mode === "thumbs" ? "list" : "auto";
}

const MAX_TITLE = 80;

/** The first line of `text`, trimmed, collapsed and cut to a readable length ("" if none). */
function firstLine(text: string): string {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/^[\s#>*\-•]+/, "").replace(/\s+/g, " ").trim();
		if (line) return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
	}
	return "";
}

/** The title shown in the list: the bookmark's title, else the first line of the topmost typed text, else the label of a checkbox or sticky; "" when none. */
export function pageRowTitle(page: Page, bookmarkTitle?: string): string {
	const marked = bookmarkTitle ? firstLine(bookmarkTitle) : "";
	if (marked) return marked;
	let best: { y: number; text: string } | null = null;
	for (const el of page.elements ?? []) {
		if (el.type !== "text") continue;
		const text = firstLine(el.text);
		if (text && (!best || el.y < best.y)) best = { y: el.y, text };
	}
	return best?.text ?? "";
}

/** The start of the page's writing time (ms since 1970), or null when the page has none. */
export function pageRowTime(page: Pick<Page, "startAt" | "endAt">): number | null {
	return pageTimes(page)?.startAt ?? null;
}

// ------------------------------------------------------------------------------------------------------ local storage

/** Local storage key of the per-notebook choices. */
export const NAV_MODE_KEY = "notebook-nav-mode-by-notebook";
/** Notebooks remembered (the oldest choices are forgotten first). */
export const MAX_NAV_NOTEBOOKS = 100;

const NOTEBOOK_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * Stored choices as `[notebook id, mode]` pairs in order of age: the last pair is the newest. A list, not an object: object keys that look like
 * integers are enumerated first whatever the order they were added in, which would make "forget the oldest" forget the wrong ones.
 */
export type NavModes = ReadonlyArray<readonly [string, "thumbs" | "list"]>;

/**
 * Whatever was stored, as a valid, bounded list (bad ids and values dropped, one pair per notebook, the oldest forgotten). Reads the pair list and
 * the plain object an earlier build stored.
 */
export function normaliseNavModes(data: unknown): NavModes {
	if (typeof data !== "object" || data === null) return [];
	const rows: unknown[] = Array.isArray(data) ? data : Object.entries(data as Record<string, unknown>);
	const out: Array<readonly [string, "thumbs" | "list"]> = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length !== 2) continue;
		const [id, mode] = row as [unknown, unknown];
		if (typeof id !== "string" || !NOTEBOOK_ID.test(id) || (mode !== "thumbs" && mode !== "list")) continue;
		const at = out.findIndex((r) => r[0] === id);
		if (at >= 0) out.splice(at, 1); // a later pair for the same notebook replaces the earlier one and counts as newer
		out.push([id, mode]);
	}
	return out.slice(-MAX_NAV_NOTEBOOKS);
}

/** The mode chosen for a notebook (auto when none). */
export function modeOf(store: NavModes, notebookId: string | null): NavMode {
	return (notebookId ? store.find((r) => r[0] === notebookId)?.[1] : undefined) ?? "auto";
}

/** The store with `mode` chosen for a notebook (auto removes the choice); the newest choice goes last. */
export function withMode(store: NavModes, notebookId: string, mode: NavMode): NavModes {
	if (!NOTEBOOK_ID.test(notebookId)) return store;
	const rest = store.filter((r) => r[0] !== notebookId);
	return normaliseNavModes(mode === "auto" ? rest : [...rest, [notebookId, mode]]);
}

// ------------------------------------------------------------------------------------------------------ thumbnail cache

/** Page thumbnails kept at most (data URLs: the memory of a large notebook on a tablet). */
export const MAX_THUMBS = 200;
/** Between a page id and a width in a cache slot (a character no page id contains). */
const SEP = "\u0000";

/**
 * The navigator's thumbnails by page and width (data URLs: the memory of a big notebook on a tablet). Bounded: the least recently used go first, so
 * three widths per page can never grow with the size of the notebook, and a thumbnail of a page that has changed is dropped when the page is drawn again.
 */
export class ThumbCache {
	private readonly map = new Map<string, { key: string; url: string }>();

	constructor(private readonly max = MAX_THUMBS) {}

	private static slot(pageId: string, width: number): string {
		return `${pageId}${SEP}${width}`;
	}

	get size(): number {
		return this.map.size;
	}

	/** The thumbnail of the page at `width` when it is drawn and still current (`key` says what the page looks like now), else null. */
	get(pageId: string, width: number, key: string): string | null {
		const slot = ThumbCache.slot(pageId, width);
		const hit = this.map.get(slot);
		if (!hit || hit.key !== key) return null;
		this.map.delete(slot);
		this.map.set(slot, hit); // most recently used goes last
		return hit.url;
	}

	/** Whether any width of the page is drawn and current (does not count as a use). */
	peek(pageId: string, key: string): string | null {
		for (const [slot, hit] of this.map) if (slot.startsWith(`${pageId}${SEP}`) && hit.key === key) return hit.url;
		return null;
	}

	set(pageId: string, width: number, key: string, url: string): void {
		// The page changed: its thumbnails at other widths are out of date and go; current ones at other widths stay (a layout switch and the
		// scrollbar preview use more than one width), within the bound.
		const prefix = `${pageId}${SEP}`;
		for (const [slot, hit] of [...this.map]) if (slot.startsWith(prefix) && hit.key !== key) this.map.delete(slot);
		const own = ThumbCache.slot(pageId, width);
		this.map.delete(own);
		this.map.set(own, { key, url });
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next();
			if (oldest.done) break;
			this.map.delete(oldest.value);
		}
	}

	/** Forgets every width of the page. */
	drop(pageId: string): void {
		const prefix = `${pageId}${SEP}`;
		for (const slot of [...this.map.keys()]) if (slot.startsWith(prefix)) this.map.delete(slot);
	}

	clear(): void {
		this.map.clear();
	}
}

export interface NavStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export function loadNavModes(app: NavStorage): NavModes {
	try {
		return normaliseNavModes(app.loadLocalStorage(NAV_MODE_KEY));
	} catch {
		return [];
	}
}

export function saveNavMode(app: NavStorage, notebookId: string, mode: NavMode): void {
	try {
		app.saveLocalStorage(NAV_MODE_KEY, withMode(loadNavModes(app), notebookId, mode));
	} catch (e) {
		console.error("[notebook] could not store the navigator layout", e);
	}
}
