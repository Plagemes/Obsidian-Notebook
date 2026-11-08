/**
 * Start and end time of a page (roadmap #217, format v19). Pure, no Obsidian.
 *
 * `Page.startAt` is when the first ink or element was added to the page and `Page.endAt` when the last one was (ms since 1970, whole
 * numbers). The pair is written together or not at all, with `endAt >= startAt`. It is the time base audio recorded beside a page
 * will be laid against (M5), and it is shown beside the page (header, notebook map, page info).
 *
 * They are upkeep, not edits: `History` stamps them after a command that adds ink or an element, or changes the text of an element,
 * succeeded (`stampPage`), without an undo step of their own, so Undo never moves them (the page was started, whatever happens to
 * the ink afterwards) and a Redo does not stamp. Ink moved in from another page, and ink made from an equation, is not "written
 * now" and does not stamp. A clock reading outside `STAMP_FROM`..`STAMP_UNTIL` (a device that booted without network time) is
 * ignored; a wrong reading inside the window widens the span for good, nothing shrinks it.
 *
 * Copies: a duplicated page, a template page and a page restored as a new page start without them (it is a new page; its ink has no
 * time of its own); a page that moves, or comes back from the page trash, keeps them; restoring a version over a page keeps the union
 * of both spans. A merge of a conflicted copy takes the earliest start and the latest end (`mergedTimes`); the merge's `SetPageTimes`
 * is undone with the merge only while the times are still what it set, and a redo widens (it never lowers a later stamp).
 */
import type { Command } from "./history";
import type { NotebookDocument, Page, PageElement } from "./types";

/** The latest time a JS Date holds: a stored time beyond it could not be shown. */
export const MAX_PAGE_TIME = 8_640_000_000_000_000;
/** Clock readings the history stamps with: not before 2015-01-01 and not after 2100-01-01 (UTC). Others are ignored. */
export const STAMP_FROM = Date.UTC(2015, 0, 1);
export const STAMP_UNTIL = Date.UTC(2100, 0, 1);

export interface PageTimes {
	startAt: number;
	endAt: number;
}

function validTime(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_PAGE_TIME;
}

/** Null when `startAt` and `endAt` are a valid pair (both whole times, `endAt >= startAt`), else why not. Both absent is valid. */
export function pageTimesProblem(startAt: unknown, endAt: unknown): string | null {
	if (startAt === undefined && endAt === undefined) return null;
	if (startAt === undefined || endAt === undefined) return "startAt and endAt go together";
	if (!validTime(startAt)) return "startAt: expected a time in ms";
	if (!validTime(endAt)) return "endAt: expected a time in ms";
	if (endAt < startAt) return "endAt is before startAt";
	return null;
}

/** The times of `page`, or null when it has none (or an invalid pair: the reader never lets one in). */
export function pageTimes(page: Pick<Page, "startAt" | "endAt">): PageTimes | null {
	const { startAt, endAt } = page;
	return startAt !== undefined && endAt !== undefined && pageTimesProblem(startAt, endAt) === null ? { startAt, endAt } : null;
}

/** Puts `times` on `page` (null: removes them). */
export function putPageTimes(page: Page, times: PageTimes | null): void {
	if (times) {
		page.startAt = times.startAt;
		page.endAt = times.endAt;
	} else {
		delete page.startAt;
		delete page.endAt;
	}
}

/** The times of two copies of one page: the earliest start and the latest end; one side's alone when the other has none. */
export function mergedTimes(a: PageTimes | null, b: PageTimes | null): PageTimes | null {
	if (!a || !b) return a ?? b;
	return { startAt: Math.min(a.startAt, b.startAt), endAt: Math.max(a.endAt, b.endAt) };
}

/** True when two pairs are the same (both absent counts as the same). */
export function sameTimes(a: PageTimes | null, b: PageTimes | null): boolean {
	return a === b || (!!a && !!b && a.startAt === b.startAt && a.endAt === b.endAt);
}

/**
 * Something was added to `page` at `now`: the first time starts it, every time moves the end (a clock that went back never moves the
 * end back, nor the start forward). Returns true when the page changed.
 */
export function stampPage(page: Page, now: number): boolean {
	if (!validTime(now) || now < STAMP_FROM || now > STAMP_UNTIL) return false;
	const had = pageTimes(page);
	const next = had ? { startAt: Math.min(had.startAt, now), endAt: Math.max(had.endAt, now) } : { startAt: now, endAt: now };
	if (had && sameTimes(had, next)) return false;
	putPageTimes(page, next);
	return true;
}

/** The text an element carries, for telling an edit of its content from a move or a restyle (undefined: it carries none). */
function contentOf(el: PageElement): string | undefined {
	switch (el.type) {
		case "text": case "sticky": case "marker": return el.text ?? "";
		case "box": return el.title ?? "";
		case "equation": return el.latex;
		case "checkbox": return el.label ?? "";
		default: return undefined;
	}
}

/** True when `after` is `before` with other text (a text box, sticky note, marker label, box title, equation, checkbox label). Moves and restyles are not. */
export function elementTextChanged(before: PageElement, after: PageElement): boolean {
	if (before.type !== after.type) return false;
	const a = contentOf(before);
	return a !== undefined && a !== contentOf(after);
}

/** Stamps the pages of `doc` named in `pageIds` (ids that are not pages are ignored). True when any page changed. */
export function stampPages(doc: NotebookDocument, pageIds: Iterable<string>, now: number): boolean {
	let changed = false;
	for (const id of pageIds) {
		const page = doc.pages.find((p) => p.id === id);
		if (page && stampPage(page, now)) changed = true;
	}
	return changed;
}

/**
 * Sets the times of a page to given values (null: none): used where the times are not "now" (a merge takes them from the copy). One
 * undo step of its own when it is run as an edit; `History` leaves the pages that have one alone when it stamps. A missing page is a
 * no-op both ways.
 *
 * A stamp can land between a step and its undo or redo (the history never records those), so the step must not undo or overwrite
 * one: Undo puts the old times back only while the page still has exactly the times this step set (otherwise the page keeps what it
 * has: a later stamp is never lost), and a Redo widens the times the page has now (earliest start, latest end) instead of overwriting.
 */
export class SetPageTimes implements Command {
	readonly label = "Page times";
	private previous: PageTimes | null = null;
	private set: PageTimes | null = null;
	private applied = false;
	private ran = false;

	constructor(readonly pageId: string, readonly times: PageTimes | null) {}

	apply(doc: NotebookDocument): void {
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		this.previous = pageTimes(page);
		this.applied = true;
		const next = this.ran ? mergedTimes(this.previous, this.times) : this.times;
		this.ran = true;
		this.set = next;
		putPageTimes(page, next);
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (page && sameTimes(pageTimes(page), this.set)) putPageTimes(page, this.previous);
	}
}
