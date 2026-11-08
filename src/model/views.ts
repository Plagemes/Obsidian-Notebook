/**
 * Saved views (format 21, roadmap #264): a name, a page and the region of it that was in view, with the zoom, kept in the notebook
 * (`NotebookDocument.views`) so they travel with the file and are recalled in one step. Pure, no 'obsidian'.
 *
 * - Everything is in page coordinates (never screen coordinates); the zoom is relative to the fit-to-width scale of the page.
 * - Every edit is one `SetViews` command through the history, so it is one undo step and the document guard and the page-lock guard
 *   apply as for any edit. The command holds no page, stroke or element, so it has nothing to remap (`Command.remap`).
 * - A view whose page is no longer in the notebook stays in the list as missing (`viewPage` is null): it is never dropped silently, can be
 *   removed, and works again if the page comes back with the same id (undo, the trash).
 * - Pages copied inside a notebook (duplicate, page templates) and pages copied or moved to another notebook never take views along:
 *   a view names a page by its id, and a copy has a new id (or lives in another document). Pages moved out of a notebook (move to another
 *   notebook, extract, split) leave their views behind as missing ones, exactly like a deleted page: nothing is dropped without being asked,
 *   and a page that comes back with its id (moved back, restored) makes them work again.
 * - Merging a conflicted copy (`planMerge`) unites the views by id; the main notebook's view wins when both have one with that id.
 */
import type { Command } from "./history";
import { VIEWS_MAX, VIEW_COORD_LIMIT, VIEW_NAME_MAX, VIEW_ZOOM_MAX, VIEW_ZOOM_MIN, type NotebookDocument, type SavedView } from "./types";

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;

/** The views of the notebook, in list order. */
export function viewsOf(doc: NotebookDocument): readonly SavedView[] {
	return doc.views ?? [];
}

/** A name as it is stored: whitespace runs (and control characters) become one space, trimmed, at most `VIEW_NAME_MAX` characters. Empty when nothing is left. */
export function normalizeViewName(name: string): string {
	let plain = "";
	for (const ch of name) {
		const code = ch.codePointAt(0)!;
		plain += code < 0x20 || code === 0x7f ? " " : ch;
	}
	const folded = plain.replace(/\s+/g, " ").trim();
	const chars = Array.from(folded);
	return (chars.length > VIEW_NAME_MAX ? chars.slice(0, VIEW_NAME_MAX).join("") : folded).trim();
}

/** True when `name` is exactly what `normalizeViewName` would store (the strict reader accepts nothing else). */
export function isStoredViewName(name: string): boolean {
	return name.length > 0 && Array.from(name).length <= VIEW_NAME_MAX && normalizeViewName(name) === name;
}

/** An id that is not in `taken`: 8 base-36 characters. */
export function newViewId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		let id = "";
		for (let i = 0; i < ID_LENGTH; i++) id += ID_CHARS[Math.floor(random() * ID_CHARS.length) % ID_CHARS.length];
		if (!taken.has(id)) return id;
	}
}

/** `base`, or `base 2`, `base 3`… when a view of that name (any case) exists already. */
export function uniqueViewName(views: readonly SavedView[], base: string): string {
	const taken = new Set(views.map((v) => v.name.toLowerCase()));
	const root = normalizeViewName(base) || "View";
	if (!taken.has(root.toLowerCase())) return root;
	for (let n = 2; ; n++) {
		const suffix = ` ${n}`;
		const cut = Array.from(root).slice(0, Math.max(1, VIEW_NAME_MAX - suffix.length)).join("");
		const name = `${cut}${suffix}`;
		if (!taken.has(name.toLowerCase())) return name;
	}
}

const finite = (n: number): boolean => Number.isFinite(n);

/** The numbers of a region and a zoom are all usable (finite, in range, a region with a size). */
export function validRegion(r: { x: number; y: number; width: number; height: number; zoom: number }): boolean {
	return finite(r.x) && Math.abs(r.x) <= VIEW_COORD_LIMIT && finite(r.y) && Math.abs(r.y) <= VIEW_COORD_LIMIT
		&& finite(r.width) && r.width > 0 && r.width <= VIEW_COORD_LIMIT && finite(r.height) && r.height > 0 && r.height <= VIEW_COORD_LIMIT
		&& finite(r.zoom) && r.zoom >= VIEW_ZOOM_MIN && r.zoom <= VIEW_ZOOM_MAX;
}

/** The numbers rounded to what is worth keeping (0.1 pt, 4 digits of zoom), so a view does not carry noise. */
function rounded(r: { x: number; y: number; width: number; height: number; zoom: number }): { x: number; y: number; width: number; height: number; zoom: number } {
	const to = (n: number, digits: number): number => {
		const k = 10 ** digits;
		return Math.round(n * k) / k;
	};
	return { x: to(r.x, 1), y: to(r.y, 1), width: Math.max(0.1, to(r.width, 1)), height: Math.max(0.1, to(r.height, 1)), zoom: to(r.zoom, 4) };
}

export interface ViewInput {
	name: string;
	page: string;
	x: number;
	y: number;
	width: number;
	height: number;
	zoom: number;
}

/**
 * A new view from what was in view, or null when it cannot be one (no name left, an unusable region or zoom, no page). The result is
 * frozen. `taken`: the ids in use.
 */
export function makeView(input: ViewInput, taken: ReadonlySet<string>, random?: () => number): SavedView | null {
	const name = normalizeViewName(input.name);
	if (name === "" || input.page === "" || !validRegion(input)) return null;
	const r = rounded(input);
	if (!validRegion(r)) return null;
	return Object.freeze({ id: newViewId(taken, random), name, page: input.page, ...r });
}

/** The index of the page a view names, or -1 when the notebook no longer has it (the view is missing). */
export function viewPageIndex(doc: NotebookDocument, view: SavedView): number {
	return doc.pages.findIndex((p) => p.id === view.page);
}

/** The views with `view` added at the end. The same list when the notebook is full. */
export function withViewAdded(views: readonly SavedView[], view: SavedView): readonly SavedView[] {
	return views.length >= VIEWS_MAX ? views : [...views, view];
}

/** The views with the view `id` renamed. The same list when there is no such view, the name is empty or it is the name it has. */
export function withViewRenamed(views: readonly SavedView[], id: string, name: string): readonly SavedView[] {
	const next = normalizeViewName(name);
	const at = views.findIndex((v) => v.id === id);
	if (at < 0 || next === "" || views[at]!.name === next) return views;
	return views.map((v, i) => (i === at ? Object.freeze({ ...v, name: next }) : v));
}

/** The views without the view `id`. */
export function withViewRemoved(views: readonly SavedView[], id: string): readonly SavedView[] {
	return views.some((v) => v.id === id) ? views.filter((v) => v.id !== id) : views;
}

/** The views with the view `id` moved to index `to` (clamped). The same list when nothing moves. */
export function withViewMoved(views: readonly SavedView[], id: string, to: number): readonly SavedView[] {
	const from = views.findIndex((v) => v.id === id);
	if (from < 0) return views;
	const target = Math.max(0, Math.min(views.length - 1, Math.trunc(to)));
	if (target === from) return views;
	const next = [...views];
	const [moved] = next.splice(from, 1);
	next.splice(target, 0, moved!);
	return next;
}

/** The views with the view `id` pointing at `place` instead (its name and position in the list stay). The same list when it is unusable or unchanged. */
export function withViewReplaced(views: readonly SavedView[], id: string, place: Pick<ViewInput, "page" | "x" | "y" | "width" | "height" | "zoom">): readonly SavedView[] {
	const at = views.findIndex((v) => v.id === id);
	if (at < 0 || place.page === "" || !validRegion(place)) return views;
	const r = rounded(place);
	if (!validRegion(r)) return views;
	const old = views[at]!;
	if (old.page === place.page && old.x === r.x && old.y === r.y && old.width === r.width && old.height === r.height && old.zoom === r.zoom) return views;
	return views.map((v, i) => (i === at ? Object.freeze({ ...v, page: place.page, ...r }) : v));
}

/**
 * The views of `main` followed by those of `other` that `main` does not have (by id) and whose page is among `pageIds`, as many as fit
 * (`VIEWS_MAX`). The same list when the copy adds nothing. A name that `main` already uses gets a number (` 2`) so the list stays readable.
 */
export function mergedViews(main: readonly SavedView[], other: readonly SavedView[], pageIds: ReadonlySet<string>): readonly SavedView[] {
	const ids = new Set(main.map((v) => v.id));
	let out: readonly SavedView[] = main;
	for (const v of other) {
		if (ids.has(v.id) || !pageIds.has(v.page) || out.length >= VIEWS_MAX) continue;
		ids.add(v.id);
		const name = uniqueViewName(out, v.name);
		out = [...out, name === v.name ? v : Object.freeze({ ...v, name })];
	}
	return out;
}

/** Whether two lists are the same views in the same order. */
export function sameViews(a: readonly SavedView[], b: readonly SavedView[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i] || (v.id === b[i]!.id && v.name === b[i]!.name && v.page === b[i]!.page && v.x === b[i]!.x && v.y === b[i]!.y && v.width === b[i]!.width && v.height === b[i]!.height && v.zoom === b[i]!.zoom));
}

/**
 * Replaces the notebook's list of views (`before` → `after`). One command for every edit of the list (save, rename, reorder, delete,
 * update, merge): the arrays are replaced, never changed in place, so the history's snapshots of the document stay right, and an empty
 * list leaves the document without `views` (nothing is written). Undo puts `before` back whatever the list is now.
 */
export class SetViews implements Command {
	private readonly before: readonly SavedView[];
	private readonly after: readonly SavedView[];
	constructor(before: readonly SavedView[], after: readonly SavedView[], readonly label = "Change saved views") {
		this.before = [...before];
		this.after = [...after];
	}

	apply(doc: NotebookDocument): void {
		put(doc, this.after);
	}

	revert(doc: NotebookDocument): void {
		put(doc, this.before);
	}
}

function put(doc: NotebookDocument, views: readonly SavedView[]): void {
	if (views.length === 0) delete doc.views;
	else doc.views = [...views];
}

/** The command for a change of list, or null when the list does not change. */
export function setViews(doc: NotebookDocument, next: readonly SavedView[], label: string): SetViews | null {
	const before = viewsOf(doc);
	return next === before || sameViews(before, next) ? null : new SetViews(before, next, label);
}
