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

/** Stored choices in order of age: the last key is the newest. */
export type NavModes = Readonly<Record<string, "thumbs" | "list">>;

/** Whatever was stored, as a valid, bounded map (bad ids and values dropped, the oldest forgotten). */
export function normaliseNavModes(data: unknown): NavModes {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows = Object.entries(data as Record<string, unknown>).filter(([id, v]) => NOTEBOOK_ID.test(id) && (v === "thumbs" || v === "list"));
	return Object.fromEntries(rows.slice(-MAX_NAV_NOTEBOOKS)) as NavModes;
}

/** The mode chosen for a notebook (auto when none). */
export function modeOf(store: NavModes, notebookId: string | null): NavMode {
	return (notebookId ? store[notebookId] : undefined) ?? "auto";
}

/** The store with `mode` chosen for a notebook (auto removes the choice); the newest choice goes last. */
export function withMode(store: NavModes, notebookId: string, mode: NavMode): NavModes {
	if (!NOTEBOOK_ID.test(notebookId)) return store;
	const rest = Object.fromEntries(Object.entries(store).filter(([id]) => id !== notebookId));
	return normaliseNavModes(mode === "auto" ? rest : { ...rest, [notebookId]: mode });
}

export interface NavStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export function loadNavModes(app: NavStorage): NavModes {
	try {
		return normaliseNavModes(app.loadLocalStorage(NAV_MODE_KEY));
	} catch {
		return {};
	}
}

export function saveNavMode(app: NavStorage, notebookId: string, mode: NavMode): void {
	try {
		app.saveLocalStorage(NAV_MODE_KEY, withMode(loadNavModes(app), notebookId, mode));
	} catch (e) {
		console.error("[notebook] could not store the navigator layout", e);
	}
}
