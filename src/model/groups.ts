/**
 * Groups and locked elements (roadmap #39, format v18). Pure, no Obsidian.
 *
 * A GROUP is a set of at least two strokes and elements of one page that carry the same `group` id there (`ElementFlags.group`,
 * `Stroke.group`): the lasso and a tap select all of them as soon as one is picked, so they move, resize, copy and delete as one.
 * The id is scoped to the page. Nothing is stored about a group but that id on its members, so a group that loses members
 * (erased, moved to another page) simply shrinks and, below two, stops being one (the reader and the writer release the last
 * one: serialize.ts). A LOCKED element (`ElementFlags.locked`) is skipped by the lasso, by a tap and by the area eraser, so it
 * cannot be moved, resized, restyled or erased until it is unlocked; ink over it is unaffected. Locking says nothing about
 * what a tap on the element itself does (a checkbox is still ticked).
 *
 * Every change is one undo step through `History` (`UpdateItems`), which refuses it on a locked page like any other edit.
 */
import { createId } from "./document";
import type { Command, ElementSwap } from "./history";
import { freezeElement, freezeStroke } from "./serialize";
import { pieceTaper } from "./taper";
import type { NotebookDocument, Page, PageElement, Point, Stroke } from "./types";

/** A stroke or an element of a page. */
export type PageItem = Stroke | PageElement;

/** A selection of one page: the strokes and the elements picked. */
export interface PageSelection {
	strokes: Stroke[];
	elements: PageElement[];
}

export function isLockedElement(el: PageElement): boolean {
	return el.locked === true;
}

/** The elements that are not locked, in the same order (the same array when none is locked). */
export function unlockedElements<T extends PageElement>(elements: readonly T[]): readonly T[] {
	return elements.some(isLockedElement) ? elements.filter((e) => !isLockedElement(e)) : elements;
}

/** The locked elements of a page, in page order. */
export function lockedElementsOf(page: Pick<Page, "elements">): PageElement[] {
	return (page.elements ?? []).filter(isLockedElement);
}

/** A few words that tell an element apart in a list (its text, label or title; empty when it has none), at most `max` characters. */
export function elementDetail(el: PageElement, max = 48): string {
	const raw = el.type === "text" || el.type === "sticky" ? el.text : el.type === "checkbox" ? el.label : el.type === "box" ? el.title : el.type === "marker" ? el.text : el.type === "equation" ? el.latex : undefined;
	const text = (raw ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A function that gives each old group id a fresh one (the same new id for the same old one): for copies of a set of items. */
export function groupRenamer(make: () => string = createId): (group: string) => string {
	const fresh = new Map<string, string>();
	return (group) => {
		let id = fresh.get(group);
		if (id === undefined) {
			id = make();
			fresh.set(group, id);
		}
		return id;
	};
}

/**
 * `sel` plus every other member of the groups its items belong to. Strokes are taken from `ink` (the ink in view: hidden ink and
 * the ink a collapsed note keeps hidden are not offered), elements from the page; a locked element never comes along. The same
 * object when nothing is added.
 */
export function expandToGroups(page: Pick<Page, "strokes" | "elements">, sel: PageSelection, ink: readonly Stroke[] = page.strokes): PageSelection {
	const wanted = new Set<string>();
	for (const s of sel.strokes) if (s.group !== undefined) wanted.add(s.group);
	for (const e of sel.elements) if (e.group !== undefined) wanted.add(e.group);
	if (wanted.size === 0) return sel;
	const haveStrokes = new Set(sel.strokes);
	const haveElements = new Set(sel.elements);
	const strokes = ink.filter((s) => s.group !== undefined && wanted.has(s.group) && !haveStrokes.has(s));
	const elements = (page.elements ?? []).filter((e) => e.group !== undefined && wanted.has(e.group) && !haveElements.has(e) && !isLockedElement(e));
	if (strokes.length === 0 && elements.length === 0) return sel;
	return { strokes: [...sel.strokes, ...strokes], elements: [...sel.elements, ...elements] };
}

/**
 * What a selection asked for by a tool (find, select similar, the states tools, ...) becomes on page `page`: the locked elements are
 * dropped (they cannot be moved, resized or erased) and every group it touches is completed, as the lasso does.
 */
export function selectableItems(page: Pick<Page, "strokes" | "elements">, sel: PageSelection, ink: readonly Stroke[] = page.strokes): PageSelection {
	return expandToGroups(page, { strokes: sel.strokes, elements: [...unlockedElements(sel.elements)] }, ink);
}

/**
 * Whether another stroke or element of the page is in `item`'s group. A group of one is nothing (the writer releases it), but it
 * stays on the item in memory until the page is read again: whatever copies the item's flags (the pieces of a cut stroke) asks
 * this first, so a group that is already gone does not come back.
 */
export function hasGroupMate(page: Pick<Page, "strokes" | "elements">, item: PageItem): boolean {
	const group = item.group;
	if (group === undefined) return false;
	for (const s of page.strokes) if (s.group === group && s !== item) return true;
	for (const e of page.elements ?? []) if (e.group === group && e !== item) return true;
	return false;
}

/** The pieces a cut leaves of `stroke` (one per run of points, fresh ids, frozen): they stay in its group only while the page has another member of it. */
export function strokePieces(page: Pick<Page, "strokes" | "elements">, stroke: Stroke, runs: readonly Point[][], newId: () => string = createId): Stroke[] {
	const base = stroke.group === undefined || hasGroupMate(page, stroke) ? stroke : ungroupedItem(stroke);
	// v22: a piece of a cut shape is an open line: it has no fill (the line style stays).
	const { fill: _fill, fillTint: _tint, taperStart: _ts, taperEnd: _te, ...plain } = base;
	void _fill;
	void _tint;
	void _ts;
	void _te;
	// v25: a piece keeps the taper of an end of the original only when the piece still reaches that end (a cut makes new, untapered ends).
	return runs.map((points) => freezeStroke({ ...plain, id: newId(), points, ...pieceTaper(stroke, points) }));
}

/** What a selection says about groups: how many different groups its items belong to and how many items are in one. */
export function groupStats(sel: PageSelection): { groups: number; grouped: number; total: number } {
	const ids = new Set<string>();
	let grouped = 0;
	for (const item of [...sel.strokes, ...sel.elements]) {
		if (item.group === undefined) continue;
		ids.add(item.group);
		grouped++;
	}
	return { groups: ids.size, grouped, total: sel.strokes.length + sel.elements.length };
}

/** Whether "Group" does anything for the selection: two items or more that are not already exactly one group. */
export function canGroup(sel: PageSelection): boolean {
	const s = groupStats(sel);
	return s.total >= 2 && !(s.groups === 1 && s.grouped === s.total);
}

// --- the changes of one item (a new object; the same object when there is nothing to change) ---

/** `item` in group `group`. */
export function groupedItem<T extends PageItem>(item: T, group: string): T {
	return item.group === group ? item : { ...item, group };
}

/** `item` out of its group. */
export function ungroupedItem<T extends PageItem>(item: T): T {
	if (item.group === undefined) return item;
	const copy = { ...item };
	delete copy.group;
	return copy;
}

/** The element locked at time `at` (ms). */
export function lockedElement<T extends PageElement>(el: T, at: number): T {
	return el.locked === true ? el : { ...el, locked: true, lockAt: at };
}

/** The element unlocked at time `at` (ms); the time stays, so an older copy that still has the lock does not bring it back. */
export function unlockedElement<T extends PageElement>(el: T, at: number): T {
	if (el.locked !== true) return el;
	const copy = { ...el, lockAt: at };
	delete copy.locked;
	return copy;
}

/**
 * v18 merge of the flags of the same item (same id, same content) in the main notebook and in its copy; null when the main
 * notebook's stays. Membership of a group is united: an item that is in no group in the main notebook takes the copy's group (a
 * group only grows in a merge; deletions are not inferred). A lock follows the later decision (`lockAt`; none counts as 0): the
 * copy's lock, or its absence, replaces the main notebook's when the copy decided later; on a tie that disagrees the lock wins, so
 * a lock is never lost. `joinGroup` false leaves the group alone (see `groupJoins`).
 */
export function mergedFlags<T extends PageItem>(main: T, copy: T, joinGroup = true): T | null {
	let out: PageItem = main;
	if (joinGroup && main.group === undefined && copy.group !== undefined) out = groupedItem(out, copy.group);
	if (isElement(main) && isElement(copy)) {
		const mainAt = main.lockAt ?? 0;
		const copyAt = copy.lockAt ?? 0;
		if (copyAt > mainAt) {
			const e: PageElement = { ...(out as PageElement), lockAt: copyAt };
			if (copy.locked === true) e.locked = true;
			else delete e.locked;
			out = e;
		} else if (copyAt === mainAt && copy.locked === true && main.locked !== true) {
			out = { ...(out as PageElement), locked: true };
		}
	}
	return out === main ? null : (out as T);
}

/**
 * Which of the items of one page that take the copy's group in a merge really may: those whose group would still have two members
 * or more in the result. `page` is the main page as it is, `added` the groups of the items the merge adds to it, `copies` the
 * copy's version of each item that is on both sides (by id). An item that would join a group of one (its group mates are in another
 * group here, or not on this page) stays free: the writer would drop the lone group anyway, and the copy would be offered again on
 * every open.
 */
export function groupJoins(page: Pick<Page, "strokes" | "elements">, added: readonly string[], copies: ReadonlyMap<string, PageItem>): Set<string> {
	const count = new Map<string, number>();
	const bump = (group: string | undefined, by: number): void => {
		if (group !== undefined) count.set(group, (count.get(group) ?? 0) + by);
	};
	for (const g of added) bump(g, 1);
	const joins = new Map<string, string>();
	for (const item of [...page.strokes, ...(page.elements ?? [])]) {
		bump(item.group, 1);
		const copy = copies.get(item.id);
		if (item.group === undefined && copy?.group !== undefined) {
			joins.set(item.id, copy.group);
			bump(copy.group, 1);
		}
	}
	// Dropping a lone join can leave another group of one: repeat until it is stable.
	for (let changed = true; changed;) {
		changed = false;
		for (const [id, group] of joins) {
			if ((count.get(group) ?? 0) >= 2) continue;
			joins.delete(id);
			bump(group, -1);
			changed = true;
		}
	}
	return new Set(joins.keys());
}

function isElement(item: PageItem): item is PageElement {
	return "type" in item;
}

// --- the undoable changes ---

interface Swap {
	before: PageItem;
	after: PageItem;
	stroke: boolean;
}

/**
 * Changes the strokes and elements with the ids `ids` of page `pageId` to `change(item)` (one undo step). The items are found by
 * id when the command runs, so it still works after another command of the same step replaced the objects (a margin change in a
 * merge moves every item). An item that `change` returns as it was is left alone; a missing item is a no-op both ways.
 */
export class UpdateItems implements Command {
	private replaced: Swap[] = [];
	/** What the last undo put back: a redo on those same objects puts the same `after` back, so the steps above find it. */
	private undone: Swap[] = [];

	constructor(readonly pageId: string, private readonly ids: ReadonlySet<string>, private readonly change: (item: PageItem) => PageItem, readonly label: string) {}

	apply(doc: NotebookDocument): void {
		const again = new Map<PageItem, Swap>(this.undone.map((r) => [r.before, r]));
		this.undone = [];
		this.replaced = [];
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		this.swapIn(page.strokes, true, again);
		if (page.elements) this.swapIn(page.elements, false, again);
	}

	private swapIn(list: PageItem[], stroke: boolean, again: ReadonlyMap<PageItem, Swap>): void {
		for (let i = 0; i < list.length; i++) {
			const before = list[i]!;
			if (!this.ids.has(before.id)) continue;
			const known = again.get(before);
			const after = known ? known.after : this.change(before);
			if (after === before) continue;
			if (!known) {
				if (stroke) Object.freeze(after);
				else freezeElement(after as PageElement);
			}
			list[i] = after;
			this.replaced.push({ before, after, stroke });
		}
	}

	revert(doc: NotebookDocument): void {
		const done = this.replaced;
		this.replaced = [];
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		for (let k = done.length - 1; k >= 0; k--) {
			const r = done[k]!;
			const list: PageItem[] | undefined = r.stroke ? page.strokes : page.elements;
			if (!list) continue;
			let i = list.indexOf(r.after);
			// The object was replaced since by a change that is no undo step (upkeep): it is put back by id, never twice.
			if (i < 0) i = list.findIndex((x) => x.id === r.before.id && "type" in x === "type" in r.before);
			if (i >= 0) list[i] = r.before;
		}
		this.undone = done;
	}

	remap(swap: ElementSwap): void {
		const mapped = (r: Swap): Swap => (r.stroke ? r : { stroke: false, before: swap(r.before as PageElement), after: swap(r.after as PageElement) });
		this.replaced = this.replaced.map(mapped);
		this.undone = this.undone.map(mapped);
	}
}

function idsOf(items: readonly PageItem[]): Set<string> {
	return new Set(items.map((i) => i.id));
}

/** "Group": the selection becomes one group (a new id). Null when there is nothing to do (fewer than two items, or already one group). */
export function groupCommand(page: Pick<Page, "id">, sel: PageSelection, newId: () => string = createId): Command | null {
	if (!canGroup(sel)) return null;
	const group = newId();
	return new UpdateItems(page.id, idsOf([...sel.strokes, ...sel.elements]), (item) => groupedItem(item, group), "Group");
}

/** "Ungroup": every item of the selection that is in a group leaves it. Null when none is. */
export function ungroupCommand(page: Pick<Page, "id">, sel: PageSelection): Command | null {
	const grouped = [...sel.strokes, ...sel.elements].filter((i) => i.group !== undefined);
	if (grouped.length === 0) return null;
	return new UpdateItems(page.id, idsOf(grouped), (item) => ungroupedItem(item), "Ungroup");
}

/** "Lock": the unlocked elements of `elements` are locked at time `at`. Null when there is none. */
export function lockCommand(page: Pick<Page, "id">, elements: readonly PageElement[], at: number = Date.now()): Command | null {
	const todo = elements.filter((e) => !isLockedElement(e));
	if (todo.length === 0) return null;
	return new UpdateItems(page.id, idsOf(todo), (item) => lockedElement(item as PageElement, at), "Lock");
}

/** "Unlock": the locked elements of `elements` are unlocked at time `at`. Null when there is none. */
export function unlockCommand(page: Pick<Page, "id">, elements: readonly PageElement[], at: number = Date.now()): Command | null {
	const todo = elements.filter(isLockedElement);
	if (todo.length === 0) return null;
	return new UpdateItems(page.id, idsOf(todo), (item) => unlockedElement(item as PageElement, at), "Unlock");
}
