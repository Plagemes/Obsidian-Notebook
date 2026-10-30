/**
 * Operations on several pages at once (wave 0.8, 378). Each function turns a selection (page ids) into ONE command, so the
 * operation is a single undo step; a selection that would change nothing gives null. No 'obsidian': testable in Node.
 *
 * Pages are named by id: positions shift as soon as something moves, ids do not.
 */
import { removeBookmark, setBookmark } from "./bookmarks";
import { cloneMeta } from "./document";
import { Batch, DeletePage, InsertPages, SetMeta, SetPageSize, SetPaper, type Command } from "./history";
import { duplicatePage } from "./pages";
import { normalizePageTag, sameTags, SetPageTags, unionPageTags } from "./page-tags";
import { DEFAULT_META, PAPER_SPACING, type NotebookDocument, type Page, type PaperKind } from "./types";

/** Puts the pages in the order of `after` (ids). Pages it does not name keep their relative order, after the named ones. Undo restores `before`. */
export class ReorderPages implements Command {
	readonly label = "Move pages";
	constructor(readonly before: readonly string[], readonly after: readonly string[]) {}

	private arrange(doc: NotebookDocument, ids: readonly string[]): void {
		const byId = new Map(doc.pages.map((p) => [p.id, p] as const));
		const used = new Set<string>();
		const out: Page[] = [];
		for (const id of ids) {
			const page = byId.get(id);
			if (page && !used.has(id)) {
				out.push(page);
				used.add(id);
			}
		}
		for (const page of doc.pages) if (!used.has(page.id)) out.push(page);
		doc.pages.splice(0, doc.pages.length, ...out);
	}

	apply(doc: NotebookDocument): void {
		this.arrange(doc, this.after);
	}

	revert(doc: NotebookDocument): void {
		this.arrange(doc, this.before);
	}
}

/** The selected pages of `doc`, in document order (ids no page has any more are dropped). */
export function selectedPages(doc: Pick<NotebookDocument, "pages">, ids: Iterable<string>): Page[] {
	const wanted = new Set(ids);
	return doc.pages.filter((p) => wanted.has(p.id));
}

/** Ids of the pages from index `a` to index `b` (either order), inclusive, among `visible` (the pages shown by the filters). */
export function rangeIds(visible: readonly string[], a: string, b: string): string[] {
	const i = visible.indexOf(a);
	const j = visible.indexOf(b);
	if (i < 0 || j < 0) return j >= 0 ? [b] : i >= 0 ? [a] : [];
	return visible.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export type MoveTarget = "start" | "end" | { position: number };

/** The new order of the page ids when the selected pages are moved together, or null when that changes nothing. */
export function planMove(order: readonly string[], selected: ReadonlySet<string>, to: MoveTarget): string[] | null {
	const moving = order.filter((id) => selected.has(id));
	if (moving.length === 0) return null;
	const rest = order.filter((id) => !selected.has(id));
	const at = to === "start" ? 0 : to === "end" ? rest.length : Math.max(0, Math.min(rest.length, Math.floor(to.position) - 1));
	const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
	return next.every((id, i) => id === order[i]) ? null : next;
}

/** Moves the selected pages, keeping their order, to the start, the end or so that the first of them gets page number `position`. */
export function moveCommand(doc: NotebookDocument, ids: Iterable<string>, to: MoveTarget): Command | null {
	const before = doc.pages.map((p) => p.id);
	const after = planMove(before, new Set(ids), to);
	return after ? new ReorderPages(before, after) : null;
}

/** ` p3-5` for pages that follow each other, ` selection` otherwise: tells the PDF exports of one notebook apart. */
export function exportSuffix(doc: Pick<NotebookDocument, "pages">, pages: readonly Page[]): string {
	const first = doc.pages.indexOf(pages[0]!);
	const last = doc.pages.indexOf(pages[pages.length - 1]!);
	if (first < 0 || last < 0) return " selection";
	if (pages.length === 1) return ` p${first + 1}`;
	return last - first + 1 === pages.length ? ` p${first + 1}-${last + 1}` : " selection";
}

/** Same paper (kind and its usual spacing) on every selected page that does not have it yet. */
export function paperCommand(doc: NotebookDocument, ids: Iterable<string>, kind: PaperKind): Command | null {
	const after = { kind, spacing: PAPER_SPACING[kind] };
	const commands = selectedPages(doc, ids).filter((p) => p.paper.kind !== kind).map((p) => new SetPaper(p.id, { ...p.paper }, after));
	return commands.length > 0 ? new Batch("Change paper", commands) : null;
}

/** `base` (portrait) as the size of every selected page, each keeping its own orientation. Strokes are never moved or scaled. */
export function sizeCommand(doc: NotebookDocument, ids: Iterable<string>, base: { width: number; height: number }): Command | null {
	const commands: Command[] = [];
	for (const p of selectedPages(doc, ids)) {
		const landscape = p.width > p.height;
		const after = landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
		if (after.width !== p.width || after.height !== p.height) commands.push(new SetPageSize(p.id, { width: p.width, height: p.height }, after));
	}
	return commands.length > 0 ? new Batch("Change page size", commands) : null;
}

/** Adds the tags (case-insensitive duplicates ignored) to every selected page. */
export function addTagsCommand(doc: NotebookDocument, ids: Iterable<string>, tags: readonly string[]): Command | null {
	const commands: Command[] = [];
	for (const p of selectedPages(doc, ids)) {
		const next = unionPageTags(p.tags, tags);
		if (!sameTags(p.tags, next)) commands.push(new SetPageTags(p.id, p.tags, next));
	}
	return commands.length > 0 ? new Batch("Change page tags", commands) : null;
}

/** Removes one tag (any capitalisation) from every selected page that has it. */
export function removeTagCommand(doc: NotebookDocument, ids: Iterable<string>, tag: string): Command | null {
	const wanted = normalizePageTag(tag)?.toLowerCase();
	if (!wanted) return null;
	const commands: Command[] = [];
	for (const p of selectedPages(doc, ids)) {
		if (!p.tags?.some((x) => x.toLowerCase() === wanted)) continue;
		const rest = p.tags.filter((x) => x.toLowerCase() !== wanted);
		commands.push(new SetPageTags(p.id, p.tags, rest.length > 0 ? rest : undefined));
	}
	return commands.length > 0 ? new Batch("Change page tags", commands) : null;
}

/** Tags on the selected pages with the number of selected pages that have each, most used first. */
export function selectionTags(doc: NotebookDocument, ids: Iterable<string>): Array<{ tag: string; count: number }> {
	const counts = new Map<string, { tag: string; count: number }>();
	for (const p of selectedPages(doc, ids)) {
		for (const tag of p.tags ?? []) {
			const entry = counts.get(tag.toLowerCase());
			if (entry) entry.count++;
			else counts.set(tag.toLowerCase(), { tag, count: 1 });
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Whether every selected page is bookmarked. */
export function allBookmarked(doc: NotebookDocument, ids: Iterable<string>): boolean {
	const marked = new Set(doc.meta?.bookmarks ?? []);
	const pages = selectedPages(doc, ids);
	return pages.length > 0 && pages.every((p) => marked.has(p.id));
}

/**
 * Bookmarks every selected page, or, when all of them already are bookmarked, removes those bookmarks (with their titles and
 * colours; undo brings them back). Bookmarks that exist keep their details.
 */
export function bookmarkCommand(doc: NotebookDocument, ids: Iterable<string>): Command | null {
	const pages = selectedPages(doc, ids);
	if (pages.length === 0) return null;
	const before = doc.meta ?? cloneMeta(DEFAULT_META);
	const marked = new Set(before.bookmarks);
	let after = before;
	if (pages.every((p) => marked.has(p.id))) for (const p of pages) after = removeBookmark(after, p.id);
	else for (const p of pages) if (!marked.has(p.id)) after = setBookmark(after, p.id, undefined);
	return new SetMeta(before, after);
}

/** Copies of the selected pages, in order, right after the last selected one. `index` is where the first copy lands. */
export function duplicateCommand(doc: NotebookDocument, ids: Iterable<string>): { command: Command; index: number } | null {
	const pages = selectedPages(doc, ids);
	if (pages.length === 0) return null;
	const index = doc.pages.indexOf(pages[pages.length - 1]!) + 1;
	return { command: new InsertPages(pages.map((p) => duplicatePage(p)), index), index };
}

/** Deletes the selected pages. Null when nothing is selected or when it would leave the notebook without pages. */
/** A copy of a page as it was kept in the page trash before a delete: the object and its content then. */
export interface StashedPage {
	page: Page;
	snapshot: string;
}

export function stashSnapshot(page: Page): string {
	return JSON.stringify(page);
}

/**
 * Pages among `ids` whose copy in the page trash is not the version the notebook has now: no copy yet, the page object
 * was replaced (a version restore, a reload) or it changed after its copy was written. Deleting one of them would lose
 * what the copy lacks, so it needs a new copy first.
 */
export function unstashedPages(doc: Pick<NotebookDocument, "pages">, ids: Iterable<string>, stashed: ReadonlyMap<string, StashedPage>): Page[] {
	return selectedPages(doc, ids).filter((page) => {
		const kept = stashed.get(page.id);
		return !kept || kept.page !== page || kept.snapshot !== stashSnapshot(page);
	});
}

export function deleteCommand(doc: NotebookDocument, ids: Iterable<string>): Command | null {
	const pages = selectedPages(doc, ids);
	if (pages.length === 0 || pages.length >= doc.pages.length) return null;
	// Highest index first: undo puts them back in the opposite order, each at the index it had.
	const going = pages.map((page) => ({ page, index: doc.pages.indexOf(page) })).sort((a, b) => b.index - a.index);
	return new Batch("Delete pages", going.map((g) => new DeletePage(g.page, g.index)));
}
