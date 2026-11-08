// 0.25 markedview (#419): the page navigator can show only the marked pages. A page is "marked" when it has an in-notebook bookmark, a
// global bookmark (library/bookmarks), a marker (gap, question, homework, importance), a stroke in a colour with a meaning, an open checkbox
// or a page tag. The reader picks which of those count (none picked: all of them). Marked-only keeps the real page numbers; the choice is
// remembered per notebook on this device, in bounded local storage. Pure logic: no DOM, no 'obsidian', nothing is written to the notebook.
import { checklistCounts } from "../model/checklist";
import { MATCH_TOLERANCE, matchMeaning, type Meaning } from "../model/colour-meaning";
import type { MarkerKind, Page } from "../model/types";

export const MARK_KINDS = ["bookmark", "global", "marker", "meaning", "task", "tag"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export const isMarkKind = (v: unknown): v is MarkKind => typeof v === "string" && (MARK_KINDS as readonly string[]).includes(v);

/** Why a page is marked: the kind, and for some kinds a short detail (marker kinds, a colour meaning's label, the open checkbox count). */
export interface PageMark {
	kind: MarkKind;
	detail?: string;
}

/** What the look-up needs besides the page itself. */
export interface MarkContext {
	/** Ids of the pages with an in-notebook bookmark. */
	bookmarks: ReadonlySet<string>;
	/** Ids of the pages with a global bookmark (from the bookmarks list of this device and the synced ones). */
	globalBookmarks: ReadonlySet<string>;
	/** The legend of colours with a meaning in force for the notebook (empty: none). */
	legend: readonly Meaning[];
	tolerance?: number;
}

/** The marker kinds of a page, each once, in the order they first appear. */
function markerKinds(page: Pick<Page, "elements">): MarkerKind[] {
	const out: MarkerKind[] = [];
	for (const el of page.elements ?? []) if (el.type === "marker" && !out.includes(el.kind)) out.push(el.kind);
	return out;
}

/** The labels of the legend entries that some visible stroke of the page matches (one look-up per distinct colour). */
function meaningLabels(page: Pick<Page, "strokes">, legend: readonly Meaning[], tolerance: number): string[] {
	if (legend.length === 0) return [];
	const seen = new Set<string>();
	const hit = new Set<number>();
	for (const s of page.strokes) {
		if (s.hidden || seen.has(s.color)) continue;
		seen.add(s.color);
		const i = matchMeaning(s.color, legend, tolerance);
		if (i >= 0) hit.add(i);
	}
	return [...hit].sort((a, b) => a - b).map((i) => legend[i]!.label);
}

/**
 * Why the page is marked, limited to the kinds in `wanted` (empty: all kinds), in the order of `MARK_KINDS`. Empty list: the page is not marked.
 */
export function pageMarks(page: Page, ctx: MarkContext, wanted: readonly MarkKind[] = []): PageMark[] {
	const want = (k: MarkKind) => wanted.length === 0 || wanted.includes(k);
	const out: PageMark[] = [];
	if (want("bookmark") && ctx.bookmarks.has(page.id)) out.push({ kind: "bookmark" });
	if (want("global") && ctx.globalBookmarks.has(page.id)) out.push({ kind: "global" });
	if (want("marker")) {
		const kinds = markerKinds(page);
		if (kinds.length > 0) out.push({ kind: "marker", detail: kinds.join(",") });
	}
	if (want("meaning")) {
		const labels = meaningLabels(page, ctx.legend, ctx.tolerance ?? MATCH_TOLERANCE);
		if (labels.length > 0) out.push({ kind: "meaning", detail: labels.join(", ") });
	}
	if (want("task")) {
		const open = checklistCounts(page).open;
		if (open > 0) out.push({ kind: "task", detail: String(open) });
	}
	if (want("tag") && (page.tags?.length ?? 0) > 0) out.push({ kind: "tag", detail: page.tags!.map((x) => `#${x}`).join(" ") });
	return out;
}

export interface MarkedEntry {
	page: Page;
	/** 0-based index in the whole notebook: the page number stays what it is. */
	index: number;
	marks: PageMark[];
}

/** The marked pages (with the reasons) in page order. */
export function markedPages(pages: readonly Page[], ctx: MarkContext, wanted: readonly MarkKind[] = []): MarkedEntry[] {
	const out: MarkedEntry[] = [];
	pages.forEach((page, index) => {
		const marks = pageMarks(page, ctx, wanted);
		if (marks.length > 0) out.push({ page, index, marks });
	});
	return out;
}

/** How many pages each kind marks (all kinds counted independently), for the sub-filter menu. */
export function markCounts(pages: readonly Page[], ctx: MarkContext): Record<MarkKind, number> {
	const counts: Record<MarkKind, number> = { bookmark: 0, global: 0, marker: 0, meaning: 0, task: 0, tag: 0 };
	for (const page of pages) for (const m of pageMarks(page, ctx)) counts[m.kind]++;
	return counts;
}

/** The kinds with `kind` switched on or off (in the order of `MARK_KINDS`); every kind on is the same as none picked. */
export function toggleKind(kinds: readonly MarkKind[], kind: MarkKind): MarkKind[] {
	const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
	const ordered = MARK_KINDS.filter((k) => next.includes(k));
	return ordered.length === MARK_KINDS.length ? [] : ordered;
}

// ------------------------------------------------------------------------------------------------------ local storage

/** Local storage key of the per-notebook choices. */
export const NAV_MARKED_KEY = "notebook-nav-marked-by-notebook";
/** Notebooks remembered (the oldest choices are forgotten first). */
export const MAX_MARKED_NOTEBOOKS = 100;

const NOTEBOOK_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/** A notebook showing marked pages only: `[notebook id, kinds]` (no kinds: all of them), oldest first. A notebook not listed shows all pages. */
export type MarkedStore = ReadonlyArray<readonly [string, readonly MarkKind[]]>;

/** Whatever was stored, as a valid, bounded list (bad ids and kinds dropped, one row per notebook, the oldest forgotten). */
export function normaliseMarked(data: unknown): MarkedStore {
	if (!Array.isArray(data)) return [];
	const out: Array<readonly [string, readonly MarkKind[]]> = [];
	for (const row of data as unknown[]) {
		if (!Array.isArray(row) || row.length !== 2) continue;
		const [id, kinds] = row as [unknown, unknown];
		if (typeof id !== "string" || !NOTEBOOK_ID.test(id) || !Array.isArray(kinds)) continue;
		const clean = MARK_KINDS.filter((k) => (kinds as unknown[]).includes(k));
		const at = out.findIndex((r) => r[0] === id);
		if (at >= 0) out.splice(at, 1);
		out.push([id, clean.length === MARK_KINDS.length ? [] : clean]);
	}
	return out.slice(-MAX_MARKED_NOTEBOOKS);
}

/** The choice for a notebook: null shows all pages, else the kinds that count (empty: all kinds). */
export function markedOf(store: MarkedStore, notebookId: string | null): readonly MarkKind[] | null {
	return (notebookId ? store.find((r) => r[0] === notebookId)?.[1] : undefined) ?? null;
}

/** The store with the choice for a notebook set (`null`: all pages, nothing stored); the newest goes last. */
export function withMarked(store: MarkedStore, notebookId: string, kinds: readonly MarkKind[] | null): MarkedStore {
	if (!NOTEBOOK_ID.test(notebookId)) return store;
	const rest = store.filter((r) => r[0] !== notebookId);
	return normaliseMarked(kinds === null ? rest : [...rest, [notebookId, kinds]]);
}

export interface MarkedStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export function loadMarked(app: MarkedStorage): MarkedStore {
	try {
		return normaliseMarked(app.loadLocalStorage(NAV_MARKED_KEY));
	} catch {
		return [];
	}
}

export function saveMarked(app: MarkedStorage, notebookId: string, kinds: readonly MarkKind[] | null): void {
	try {
		app.saveLocalStorage(NAV_MARKED_KEY, withMarked(loadMarked(app), notebookId, kinds));
	} catch (e) {
		console.error("[notebook] could not store the marked-pages filter", e);
	}
}
