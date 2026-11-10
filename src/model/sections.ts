/**
 * Coloured sections (format 28, roadmap #52): a notebook can be divided into sections, like the tab dividers of a paper notebook or the
 * sections of OneNote. Pure, no 'obsidian'.
 *
 * - A section is a title and a colour anchored to the id of its first page (`Section.page`), never to an index. It runs from that page up to
 *   the page before the next section's first page (in page order), or to the end of the notebook. Pages before the first section belong to
 *   no section. The list is stored in the order the sections were made; everything that shows them uses page order (`resolveSections`).
 * - Every edit of the list is one `SetSections` command through the history (one undo step, the document guard and the page-lock guard apply
 *   as for any edit). The command holds no page, stroke or element, so it has nothing to remap.
 * - The page commands of the history keep the sections consistent in the same step (so undo puts them back exactly):
 *   - Deleting a page that starts a section moves the start to the next page when that page is in the same section; when the deleted page
 *     was the only page of its section (the next page starts another section, or there is none), the section disappears with it.
 *   - Moving pages: a page that did not move keeps its section. When the first page of a section is moved away while other pages of the
 *     section stay, the section now starts at the first of those that stay (in the new order) and the moved page takes the section of the
 *     place it lands in; when every page of the section moves (a whole section moved as a block), the section goes with exactly those
 *     pages. A block dropped inside another section splits it: the pages after the block keep their look through a continuation section
 *     (same title and colour). Details and the limits of the anchor model in `sectionsAfterReorder`.
 *   - Adding, inserting and duplicating pages changes nothing: a new page belongs to the section of the place it is put in (a copy of a page
 *     lands right after it, so it is in the same section).
 * - A section whose page the notebook does not have (a page taken away by a path that bypasses the history, a damaged file) stays in the list
 *   but shows nowhere: it is dormant and works again if the page comes back with that id. When two sections name the same page, the one made
 *   first is shown; nothing in the app makes such a pair.
 * - Pages copied to another notebook, or moved out of it, never take sections along (a section is about this notebook's pages). A notebook
 *   template keeps its sections, re-anchored to the copies of their pages. Merging a conflicted copy adds the copy's sections the main
 *   notebook lacks (by id) when their page is in the result and starts no other section.
 */
import type { Command } from "./history";
import { SECTIONS_MAX, SECTION_PAGE_ID_MAX, SECTION_TITLE_MAX, type NotebookDocument, type Section } from "./types";

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** The sections of the notebook, in list order (the order they were made). */
export function sectionsOf(doc: Pick<NotebookDocument, "sections">): readonly Section[] {
	return doc.sections ?? [];
}

/** A title as it is stored: control characters and whitespace runs become one space, trimmed, at most `SECTION_TITLE_MAX` characters. Empty when nothing is left. */
export function normalizeSectionTitle(title: string): string {
	let plain = "";
	for (const ch of title) {
		const code = ch.codePointAt(0)!;
		plain += code < 0x20 || code === 0x7f ? " " : ch;
	}
	const folded = plain.replace(/\s+/g, " ").trim();
	const chars = Array.from(folded);
	return (chars.length > SECTION_TITLE_MAX ? chars.slice(0, SECTION_TITLE_MAX).join("") : folded).trim();
}

/** True when `title` is exactly what `normalizeSectionTitle` would store (the strict reader accepts nothing else). */
export function isStoredSectionTitle(title: string): boolean {
	return title.length > 0 && Array.from(title).length <= SECTION_TITLE_MAX && normalizeSectionTitle(title) === title;
}

/** A `#rrggbb` colour. */
export function isSectionColor(color: string): boolean {
	return COLOR_RE.test(color);
}

/** A page id a stored section can name: not empty and at most `SECTION_PAGE_ID_MAX` characters. */
export function isUsableSectionPage(id: string): boolean {
	return id !== "" && id.length <= SECTION_PAGE_ID_MAX;
}

/** An id that is not in `taken`: 8 base-36 characters. */
export function newSectionId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		let id = "";
		for (let i = 0; i < ID_LENGTH; i++) id += ID_CHARS[Math.floor(random() * ID_CHARS.length) % ID_CHARS.length];
		if (!taken.has(id)) return id;
	}
}

export interface SectionInput {
	title: string;
	color: string;
	page: string;
}

/** A new section, or null when it cannot be one (no title left, a colour that is not `#rrggbb`, an unusable page id). Frozen. */
export function makeSection(input: SectionInput, taken: ReadonlySet<string>, random?: () => number): Section | null {
	const title = normalizeSectionTitle(input.title);
	if (title === "" || !isSectionColor(input.color) || !isUsableSectionPage(input.page)) return null;
	return Object.freeze({ id: newSectionId(taken, random), title, color: input.color.toLowerCase(), page: input.page });
}

/** A section as it shows: where it starts and ends in the page order (0-based, both inclusive) and how many pages it has. */
export interface ResolvedSection {
	section: Section;
	start: number;
	end: number;
	count: number;
}

/**
 * The sections that show, in page order, with their page ranges. Dormant sections (their page is not in `pages`) are left out; when two
 * sections name the same page, the first in the list is shown.
 */
export function resolveSections(pages: readonly { id: string }[], sections: readonly Section[]): ResolvedSection[] {
	if (sections.length === 0) return [];
	const index = new Map<string, number>();
	pages.forEach((p, i) => index.set(p.id, i));
	const seen = new Set<string>();
	const starts: Array<{ section: Section; start: number }> = [];
	for (const s of sections) {
		const at = index.get(s.page);
		if (at === undefined || seen.has(s.page)) continue;
		seen.add(s.page);
		starts.push({ section: s, start: at });
	}
	starts.sort((a, b) => a.start - b.start);
	return starts.map((s, i) => {
		const end = i + 1 < starts.length ? starts[i + 1]!.start - 1 : pages.length - 1;
		return { section: s.section, start: s.start, end, count: end - s.start + 1 };
	});
}

/**
 * The sections that show nowhere (review S4): dormant ones (their page is not in `pages`) and a second section on a page another one already
 * starts. They still count toward `SECTIONS_MAX` (the list keeps them), so the UI offers to remove them.
 */
export function hiddenSections(pages: readonly { id: string }[], sections: readonly Section[]): Section[] {
	if (sections.length === 0) return [];
	const shown = new Set(resolveSections(pages, sections).map((r) => r.section));
	return sections.filter((s) => !shown.has(s));
}

/** The section page `index` (0-based) belongs to, or null (before the first section, or no sections). */
export function sectionAtIndex(resolved: readonly ResolvedSection[], index: number): ResolvedSection | null {
	for (const r of resolved) if (index >= r.start && index <= r.end) return r;
	return null;
}

/** The section of the page with id `pageId`, or null. */
export function sectionOfPage(doc: Pick<NotebookDocument, "pages" | "sections">, pageId: string): ResolvedSection | null {
	const at = doc.pages.findIndex((p) => p.id === pageId);
	if (at < 0) return null;
	return sectionAtIndex(resolveSections(doc.pages, sectionsOf(doc)), at);
}

/** The section that starts at page `pageId` (shown or dormant), or undefined. */
export function sectionStartingAt(sections: readonly Section[], pageId: string): Section | undefined {
	return sections.find((s) => s.page === pageId);
}

/** The sections with `section` added. The same list when the list is full, the id is taken or a section already starts at its page. */
export function withSectionAdded(sections: readonly Section[], section: Section): readonly Section[] {
	if (sections.length >= SECTIONS_MAX || sections.some((s) => s.id === section.id || s.page === section.page)) return sections;
	return [...sections, section];
}

/** The sections with section `id` renamed. The same list when there is no such section, the title is empty or unchanged. */
export function withSectionRenamed(sections: readonly Section[], id: string, title: string): readonly Section[] {
	const next = normalizeSectionTitle(title);
	const at = sections.findIndex((s) => s.id === id);
	if (at < 0 || next === "" || sections[at]!.title === next) return sections;
	return sections.map((s, i) => (i === at ? Object.freeze({ ...s, title: next }) : s));
}

/** The sections with section `id` in colour `color`. The same list when there is no such section, the colour is not `#rrggbb` or unchanged. */
export function withSectionRecoloured(sections: readonly Section[], id: string, color: string): readonly Section[] {
	const at = sections.findIndex((s) => s.id === id);
	if (at < 0 || !isSectionColor(color) || sections[at]!.color === color.toLowerCase()) return sections;
	return sections.map((s, i) => (i === at ? Object.freeze({ ...s, color: color.toLowerCase() }) : s));
}

/** The sections without section `id` (its pages join the section before it, or none). */
export function withSectionRemoved(sections: readonly Section[], id: string): readonly Section[] {
	return sections.some((s) => s.id === id) ? sections.filter((s) => s.id !== id) : sections;
}

/** Whether two lists are the same sections in the same order. */
export function sameSections(a: readonly Section[], b: readonly Section[]): boolean {
	return a.length === b.length && a.every((s, i) => s === b[i] || (s.id === b[i]!.id && s.title === b[i]!.title && s.color === b[i]!.color && s.page === b[i]!.page));
}

// ------------------------------------------------------------------ following the page operations

/**
 * The sections after the page `deletedId` was deleted, `nextId` being the page that now has its place (the one after it), or undefined when
 * it was the last page. A section that started at the deleted page starts at `nextId` when that page starts no section (it was in the same
 * section); otherwise the section had no other page and is removed. The same list when nothing changes.
 */
export function sectionsAfterDelete(sections: readonly Section[], deletedId: string, nextId: string | undefined): readonly Section[] {
	const at = sections.findIndex((s) => s.page === deletedId);
	if (at < 0) return sections;
	const keep = nextId !== undefined && !sections.some((s) => s.page === nextId);
	if (!keep) return sections.filter((_, i) => i !== at);
	return sections.map((s, i) => (i === at ? Object.freeze({ ...s, page: nextId }) : s));
}

/** A small deterministic generator (mulberry32) seeded from a string, so a continuation gets the same id on every redo. */
function seededRandom(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	let a = h >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The sections after the pages were put in the order `after` (ids) from the order `before`, `moved` being the pages the person moved. The
 * rule is that a page the person did not move keeps the section it had, as far as the anchor model can show it:
 * - A section whose pages all moved goes with them (a whole section moved as a block).
 * - Any other moved page takes the section of the place it lands in (the page before it; no section at the very start).
 * - Every page that did not move keeps its section. A section whose first page moved away while others stayed starts at the first of those
 *   that stayed (in the new order). When a moved block lands inside another section, that section's pages after the block keep their
 *   section through a continuation: a new section with the same title and colour (a deterministic id, so a redo makes the same one),
 *   starting at the first of them. When the list is full, or the page id cannot be stored, there is no continuation and they join the
 *   section before them.
 * - Pages that were in no section can stay so only at the start of the notebook: when a moved section lands in front of them, they join it.
 * - Two sections with the same title and colour that the move puts next to each other (they were not before) become one: the second is
 *   removed and its pages join the first. This is what puts a section back together when a block that split it moves out again.
 * Dormant sections, and a second section on a page that already starts one, are kept as they are. The same list when nothing changes.
 */
export function sectionsAfterReorder(sections: readonly Section[], before: readonly string[], after: readonly string[], moved: ReadonlySet<string>): readonly Section[] {
	if (sections.length === 0 || moved.size === 0) return sections;
	if (!sections.some((s) => moved.has(s.page))) return sections;
	const shown = resolveSections(before.map((id) => ({ id })), sections);
	const had = new Map<string, Section>();
	const whole = new Set<string>();
	for (const r of shown) {
		let all = true;
		for (let i = r.start; i <= r.end; i++) {
			had.set(before[i]!, r.section);
			if (!moved.has(before[i]!)) all = false;
		}
		if (all) whole.add(r.section.id);
	}
	const known = new Set(before);
	// Runs of the section each page should have, in the new order (null: no section).
	const runs: Array<{ section: Section | null; first: string }> = [];
	let current: Section | null = null;
	for (const id of after) {
		const was = had.get(id) ?? null;
		const want: Section | null = !known.has(id) || moved.has(id) ? (was && whole.has(was.id) ? was : current) : was;
		if (runs.length === 0 || want !== current) runs.push({ section: want, first: id });
		current = want;
	}
	// Where each section starts now; a second run of a section becomes a continuation, or joins the section before it.
	const taken = new Set(sections.map((s) => s.id));
	const placed: Array<{ section: Section; first: string; was: Section }> = [];
	const start = new Map<string, string>();
	const extra: Section[] = [];
	for (const run of runs) {
		const s = run.section;
		const last = placed[placed.length - 1];
		if (!s || (last && last.was === s)) continue;
		if (!start.has(s.id)) {
			start.set(s.id, run.first);
			placed.push({ section: s, first: run.first, was: s });
			continue;
		}
		if (sections.length + extra.length >= SECTIONS_MAX || !isUsableSectionPage(run.first)) continue;
		const id = newSectionId(taken, seededRandom(`${s.id}\n${run.first}`));
		taken.add(id);
		const copy = Object.freeze({ id, title: s.title, color: s.color, page: run.first });
		extra.push(copy);
		placed.push({ section: copy, first: run.first, was: s });
	}
	// Sections with the same look that the move made neighbours become one.
	const neighbours = new Set<string>();
	for (let i = 1; i < shown.length; i++) neighbours.add(`${shown[i - 1]!.section.id}\n${shown[i]!.section.id}`);
	const gone = new Set<string>();
	let prev: Section | null = null;
	for (const p of placed) {
		const s = p.section;
		if (prev && prev.title === s.title && prev.color === s.color && !neighbours.has(`${prev.id}\n${s.id}`)) {
			gone.add(s.id);
			continue;
		}
		prev = s;
	}
	const shownIds = new Set(shown.map((r) => r.section.id));
	let changed = sections.some((s) => gone.has(s.id)) || extra.some((s) => !gone.has(s.id));
	const out: Section[] = [];
	for (const s of sections) {
		if (!shownIds.has(s.id)) {
			out.push(s);
			continue;
		}
		if (gone.has(s.id)) continue;
		const page = start.get(s.id) ?? s.page;
		if (page === s.page) out.push(s);
		else {
			changed = true;
			out.push(Object.freeze({ ...s, page }));
		}
	}
	for (const s of extra) if (!gone.has(s.id)) out.push(s);
	return changed ? out : sections;
}

/**
 * The pages that moved from `before` to `after` (ids), when the person's choice is not known: the fewest pages whose move explains the new
 * order (everything outside a longest run of pages that kept their relative order).
 */
export function movedPages(before: readonly string[], after: readonly string[]): Set<string> {
	const rank = new Map<string, number>();
	before.forEach((id, i) => rank.set(id, i));
	const seq = after.filter((id) => rank.has(id));
	// Longest increasing subsequence of the old ranks, with the indices to rebuild it.
	const tails: number[] = [];
	const tailAt: number[] = [];
	const prev = new Array<number>(seq.length).fill(-1);
	seq.forEach((id, i) => {
		const r = rank.get(id)!;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid]! < r) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = r;
		tailAt[lo] = i;
		prev[i] = lo > 0 ? tailAt[lo - 1]! : -1;
	});
	const kept = new Set<string>();
	for (let i = tails.length > 0 ? tailAt[tails.length - 1]! : -1; i >= 0; i = prev[i]!) kept.add(seq[i]!);
	return new Set(seq.filter((id) => !kept.has(id)));
}

/** Copies of the sections for copies of the pages (`pageMap`: old page id → new page id), with new ids; sections whose page was not copied are left out. */
export function sectionsForCopy(sections: readonly Section[], pageMap: ReadonlyMap<string, string>, random?: () => number): Section[] {
	const taken = new Set<string>();
	const used = new Set<string>();
	const out: Section[] = [];
	for (const s of sections) {
		const page = pageMap.get(s.page);
		if (page === undefined || used.has(page)) continue;
		used.add(page);
		const id = newSectionId(taken, random);
		taken.add(id);
		out.push(Object.freeze({ id, title: s.title, color: s.color, page }));
	}
	return out;
}

/**
 * The sections of `main` followed by those of `other` that `main` does not have (by id), whose page is among `pageIds` and starts no section
 * of `main`, as many as fit (`SECTIONS_MAX`). The same list when the copy adds nothing.
 */
export function mergedSections(main: readonly Section[], other: readonly Section[], pageIds: ReadonlySet<string>): readonly Section[] {
	const ids = new Set(main.map((s) => s.id));
	const anchors = new Set(main.map((s) => s.page));
	let out: readonly Section[] = main;
	for (const s of other) {
		if (ids.has(s.id) || anchors.has(s.page) || !pageIds.has(s.page) || out.length >= SECTIONS_MAX) continue;
		ids.add(s.id);
		anchors.add(s.page);
		out = [...out, s];
	}
	return out;
}

export interface SectionsMergeReport {
	/**
	 * Sections of the copy (on pages the result has) that the main notebook keeps its own version of: the same id with another title, colour
	 * or page, or another section on a page where the main notebook already starts one (with another title or colour).
	 */
	differ: number;
	/** Sections of the copy (on pages the result has) that were not added because the list is full (`SECTIONS_MAX`). */
	full: number;
}

/**
 * What `mergedSections` left out of the copy, for the merge summary (review S2, S8): sections the main notebook has its own version of, and
 * sections that did not fit. `united` is what `mergedSections` returned for the same arguments.
 */
export function sectionsMergeReport(main: readonly Section[], other: readonly Section[], united: readonly Section[], pageIds: ReadonlySet<string>): SectionsMergeReport {
	const mine = new Map(main.map((s) => [s.id, s]));
	const at = new Map<string, Section>();
	for (const s of main) if (!at.has(s.page)) at.set(s.page, s);
	const have = new Set(united.map((s) => s.id));
	let differ = 0;
	let full = 0;
	for (const s of other) {
		if (!pageIds.has(s.page)) continue;
		const own = mine.get(s.id);
		if (own) {
			if (!sameSections([own], [s])) differ++;
			continue;
		}
		const there = at.get(s.page);
		if (there) {
			if (there.title !== s.title || there.color !== s.color) differ++;
		} else if (!have.has(s.id)) full++;
	}
	return { differ, full };
}

// ------------------------------------------------------------------ the command

function put(doc: NotebookDocument, sections: readonly Section[]): void {
	if (sections.length === 0) delete doc.sections;
	else doc.sections = [...sections];
}

/**
 * Replaces the notebook's list of sections (`before` → `after`). One command for every edit of the list (add, rename, recolour, remove,
 * merge): the arrays are replaced, never changed in place, and an empty list leaves the document without `sections`. Undo puts `before` back.
 */
export class SetSections implements Command {
	private readonly before: readonly Section[];
	private readonly after: readonly Section[];
	constructor(before: readonly Section[], after: readonly Section[], readonly label = "Change sections") {
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

/** The command for a change of list, or null when the list does not change. */
export function setSections(doc: NotebookDocument, next: readonly Section[], label: string): SetSections | null {
	const before = sectionsOf(doc);
	return next === before || sameSections(before, next) ? null : new SetSections(before, next, label);
}

/**
 * For the page commands of the history (`DeletePage`, `MovePage`, `ReorderPages`): sets the sections to `next` and returns what they were,
 * to give back to `restoreSections` on undo; undefined when they do not change (nothing to restore).
 */
export function followSections(doc: NotebookDocument, next: readonly Section[]): readonly Section[] | undefined {
	const before = doc.sections;
	if (!before || next === before) return undefined;
	put(doc, next);
	return before;
}

/** Puts back the sections `followSections` returned (nothing when it returned undefined). */
export function restoreSections(doc: NotebookDocument, before: readonly Section[] | undefined): void {
	if (before !== undefined) put(doc, before);
}
