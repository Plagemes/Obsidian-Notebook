import { cloneMeta, findPage } from "./document";
import { freezeElement } from "./serialize";
import { marginsAfterResize, marginsOf, normalizeMargins, translateElement, translateStroke } from "./margins";
import { lockedChanges, snapshotLocked } from "./page-lock";
import { elementTextChanged, SetPageTimes, stampPages } from "./page-times";
import { shiftComments } from "./comments";
import { shiftPivots } from "./states";
import { sharesTables, survivingRedo, touchesPage, type PageRules, type PageStepResult } from "./page-scope";
import type { Asset, NotebookDocument, NotebookMeta, Page, PageBackground, PageComment, PageElement, PageMargins, PageStates, Paper, Stroke } from "./types";

/** A command knows how to apply and revert itself on a document: no snapshots. */
export interface Command {
	readonly label: string;
	apply(doc: NotebookDocument): void;
	revert(doc: NotebookDocument): void;
	/** v14: the page-lock guard of `History` lets this command change locked pages (see `exemptFromLocks`). Normal commands never set it. */
	readonly lockExempt?: boolean;
	/**
	 * 0.19: a command that holds element objects puts `swap(el)` in place of each of them (and of the page elements it keeps). Called by
	 * `History.applyQuietly` on every command of both stacks after an upkeep change replaced element objects without an undo step, so
	 * that the commands that find their elements by identity still find them (see `quietSwap`).
	 */
	remap?(swap: ElementSwap): void;
}

/**
 * 0.19: what an upkeep change (`History.applyQuietly`) did to the elements, for the commands still in the stacks. The very object it
 * replaced becomes the new one; any other copy of that element a command holds (the same id: what it was before a move, after a
 * margin change…) takes the changed fields where it agreed with the replaced object, and keeps its own value where it did not. So an
 * Undo of an unrelated change (a move, a margin) keeps the link that followed a renamed note, and an Undo past the step that made the
 * link still takes it away. Anything else comes back unchanged. The same object always gives the same answer.
 */
export type ElementSwap = (el: PageElement) => PageElement;

/** Deep equality of two stored field values (plain JSON data, or undefined). */
function sameValue(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The `ElementSwap` for the replacements `pairs` (old object → new object, same id). */
export function quietSwap(pairs: ReadonlyMap<PageElement, PageElement>): ElementSwap {
	const byId = new Map<string, { old: PageElement; next: PageElement }>();
	for (const [old, next] of pairs) byId.set(old.id, { old, next });
	const memo = new Map<PageElement, PageElement>(pairs);
	return (el) => {
		const known = memo.get(el);
		if (known) return known;
		const pair = byId.get(el.id);
		const out = pair && pair.old.type === el.type ? carried(el, pair.old, pair.next) : el;
		memo.set(el, out);
		return out;
	};
}

/** `el` with the fields that changed from `old` to `next`, where `el` had what `old` had; `el` itself when that is nothing. */
function carried(el: PageElement, old: PageElement, next: PageElement): PageElement {
	const from = old as unknown as Record<string, unknown>;
	const to = next as unknown as Record<string, unknown>;
	const own = el as unknown as Record<string, unknown>;
	let out: Record<string, unknown> | null = null;
	for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
		if (key === "id" || key === "type" || sameValue(from[key], to[key]) || !sameValue(own[key], from[key])) continue;
		out ??= { ...own };
		if (to[key] === undefined) delete out[key];
		else out[key] = to[key];
	}
	return out ? freezeElement(out as unknown as PageElement) : el;
}

/** Maps the elements of a page a command keeps (one that is not in the document now: a deleted or replaced page) in place. */
export function remapPage(page: Page, swap: ElementSwap): void {
	const els = page.elements;
	if (!els) return;
	for (let i = 0; i < els.length; i++) {
		const next = swap(els[i]!);
		if (next !== els[i]) els[i] = next;
	}
}

/** A stroke or an element of a page: elements are mapped, strokes stay (a quiet change never replaces a stroke). */
export function swapItem<T extends Stroke | PageElement>(item: T, swap: ElementSwap): T {
	return ("type" in item ? swap(item) : item) as T;
}

function pageOf(doc: NotebookDocument, pageId: string) {
	const page = findPage(doc, pageId);
	if (!page) throw new Error(`page ${pageId} not found`);
	return page;
}

export class AddStroke implements Command {
	readonly label = "Add stroke";
	/** `stamps`: false for ink that is not written now (moved in from another page, made from an equation): the page time is not moved (v19). */
	constructor(readonly pageId: string, readonly stroke: Stroke, readonly index: number, readonly stamps = true) {}

	apply(doc: NotebookDocument): void {
		pageOf(doc, this.pageId).strokes.splice(this.index, 0, this.stroke);
	}

	revert(doc: NotebookDocument): void {
		const strokes = pageOf(doc, this.pageId).strokes;
		const i = strokes.indexOf(this.stroke);
		if (i >= 0) strokes.splice(i, 1);
	}
}

export interface ErasedItem {
	stroke: Stroke;
	/** Index the stroke had when it was erased. */
	index: number;
}

/** Erasing one or more whole strokes in a single gesture. */
export class EraseStrokes implements Command {
	readonly label = "Erase strokes";
	/** `items` in erase order: each index refers to the array after the previous erasures. */
	constructor(readonly pageId: string, readonly items: ErasedItem[]) {}

	apply(doc: NotebookDocument): void {
		const strokes = pageOf(doc, this.pageId).strokes;
		for (const item of this.items) {
			const i = strokes.indexOf(item.stroke);
			if (i >= 0) strokes.splice(i, 1);
		}
	}

	revert(doc: NotebookDocument): void {
		const strokes = pageOf(doc, this.pageId).strokes;
		for (let k = this.items.length - 1; k >= 0; k--) {
			const item = this.items[k]!;
			strokes.splice(Math.min(item.index, strokes.length), 0, item.stroke);
		}
	}
}

/**
 * Replaces one stroke with zero or more strokes at the same position (segment eraser, transforms).
 * Strokes are immutable, so an edited stroke is always a new object.
 */
export class ReplaceStroke implements Command {
	readonly label = "Edit stroke";
	/** Whether the last apply() changed the page; revert() undoes only what apply() did. */
	private applied = false;
	constructor(readonly pageId: string, readonly before: Stroke, readonly after: readonly Stroke[], readonly index: number) {}

	/** A replacement only happens where `before` is: nothing is ever inserted twice. */
	apply(doc: NotebookDocument): void {
		const strokes = pageOf(doc, this.pageId).strokes;
		const i = strokes.indexOf(this.before);
		this.applied = i >= 0;
		if (i < 0) return;
		strokes.splice(i, 1, ...this.after.filter((s) => !strokes.includes(s)));
	}

	revert(doc: NotebookDocument): void {
		const strokes = pageOf(doc, this.pageId).strokes;
		if (!this.applied) return;
		this.applied = false;
		if (strokes.includes(this.before)) return;
		let at = -1;
		for (const s of this.after) {
			const i = strokes.indexOf(s);
			if (i < 0) continue;
			if (at < 0) at = i;
			strokes.splice(i, 1);
		}
		strokes.splice(at >= 0 ? at : Math.max(0, Math.min(this.index, strokes.length)), 0, this.before);
	}
}

/**
 * Removes strokes in one undoable step. Strokes no longer on the page are skipped; commands are
 * ordered by descending index so that undo puts every stroke back at its original position.
 */
export function removeStrokes(pageId: string, pageStrokes: readonly Stroke[], strokes: readonly Stroke[], label: string): Batch | null {
	const items = strokes
		.map((stroke) => ({ stroke, index: pageStrokes.indexOf(stroke) }))
		.filter((it) => it.index >= 0)
		.sort((a, b) => b.index - a.index);
	if (items.length === 0) return null;
	return new Batch(label, items.map((it) => new ReplaceStroke(pageId, it.stroke, [], it.index)));
}

export class AddPage implements Command {
	readonly label = "Add page";
	constructor(readonly page: Page, readonly index: number) {}

	apply(doc: NotebookDocument): void {
		if (doc.pages.includes(this.page)) return; // never insert a page twice
		doc.pages.splice(Math.min(this.index, doc.pages.length), 0, this.page);
	}

	revert(doc: NotebookDocument): void {
		const i = doc.pages.indexOf(this.page);
		// Never leave a document without pages.
		if (i >= 0 && doc.pages.length > 1) doc.pages.splice(i, 1);
	}

	remap(swap: ElementSwap): void {
		remapPage(this.page, swap);
	}
}

/**
 * Deletes a page. The only page of a document is never deleted: apply() is then a no-op and so
 * is revert(), which undoes only what apply() did. Undoing re-inserts the same page object.
 */
export class DeletePage implements Command {
	readonly label = "Delete page";
	private applied = false;
	constructor(readonly page: Page, readonly index: number) {}

	apply(doc: NotebookDocument): void {
		const i = doc.pages.indexOf(this.page);
		this.applied = i >= 0 && doc.pages.length > 1;
		if (this.applied) doc.pages.splice(i, 1);
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		if (doc.pages.includes(this.page)) return;
		doc.pages.splice(Math.max(0, Math.min(this.index, doc.pages.length)), 0, this.page);
	}

	remap(swap: ElementSwap): void {
		remapPage(this.page, swap);
	}
}

/** Moves a page from index `from` to index `to` (indices of the page array before the move). */
export class MovePage implements Command {
	readonly label = "Move page";
	/** Position the page actually had and reached; revert() puts it back exactly there. */
	private applied: { from: number; to: number } | null = null;
	constructor(readonly pageId: string, readonly from: number, readonly to: number) {}

	apply(doc: NotebookDocument): void {
		const i = doc.pages.findIndex((p) => p.id === this.pageId);
		if (i < 0) {
			this.applied = null;
			return;
		}
		const to = Math.max(0, Math.min(this.to, doc.pages.length - 1));
		this.applied = i === to ? null : { from: i, to };
		if (!this.applied) return;
		const [page] = doc.pages.splice(i, 1);
		doc.pages.splice(to, 0, page!);
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		const { from, to } = this.applied;
		this.applied = null;
		if (doc.pages[to]?.id !== this.pageId) return;
		const [page] = doc.pages.splice(to, 1);
		doc.pages.splice(from, 0, page!);
	}
}

/** Changes the paper (kind and spacing) of a page; strokes are untouched. */
export class SetPaper implements Command {
	readonly label = "Change paper";
	constructor(readonly pageId: string, readonly before: Paper, readonly after: Paper) {}

	apply(doc: NotebookDocument): void {
		pageOf(doc, this.pageId).paper = { kind: this.after.kind, spacing: this.after.spacing };
	}

	revert(doc: NotebookDocument): void {
		pageOf(doc, this.pageId).paper = { kind: this.before.kind, spacing: this.before.spacing };
	}
}

/**
 * Changes the size of a page. Strokes are NOT moved or scaled: they keep their page coordinates,
 * so shrinking a page can leave strokes outside it (they are kept, never deleted).
 * v6: on a page with margins the background keeps its box; the right and bottom margins take the
 * change (marginsAfterResize), so an infinite PDF page grows below the PDF instead of stretching it.
 */
export class SetPageSize implements Command {
	readonly label = "Change page size";
	/** Margins the page had before apply(), restored by revert(). */
	private previousMargins: PageMargins | undefined;
	private applied = false;
	constructor(
		readonly pageId: string,
		readonly before: { width: number; height: number },
		readonly after: { width: number; height: number },
	) {}

	apply(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		this.previousMargins = page.margins;
		this.applied = true;
		const margins = marginsAfterResize(page, this.after);
		page.width = this.after.width;
		page.height = this.after.height;
		if (margins) page.margins = margins;
		else delete page.margins;
	}

	revert(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		page.width = this.before.width;
		page.height = this.before.height;
		if (!this.applied) return;
		this.applied = false;
		if (this.previousMargins) page.margins = this.previousMargins;
		else delete page.margins;
	}
}

/**
 * v6: changes the margins around a page's background. The background box keeps its size, so the page
 * grows or shrinks by the change; when the left margin changes, the background moves right or left and
 * every stroke and element of the page moves with it (same ids, new frozen objects), so the ink stays
 * exactly where it was relative to the PDF. Undo puts back the very same stroke and element objects
 * and the exact previous page size.
 */
export class SetPageMargins implements Command {
	readonly label = "Change page margins";
	private readonly moved = new Map<Stroke | PageElement, Stroke | PageElement>();
	private readonly original = new Map<Stroke | PageElement, Stroke | PageElement>();
	private previous: { width: number; height: number; margins: PageMargins | undefined } | null = null;
	/** v13: the page's states table before and after the pivots moved with the ink (the same objects are put back by undo). */
	private states: { before: PageStates | undefined; after: PageStates | undefined } | null = null;
	/** v16: the same for the page's comments (their regions are page coordinates too: they stay on the part of the background they annotate). */
	private comments: { before: PageComment[] | undefined; after: PageComment[] | undefined } | null = null;
	readonly before: PageMargins | undefined;
	readonly after: PageMargins | undefined;

	constructor(readonly pageId: string, before: PageMargins | undefined, after: PageMargins | undefined) {
		this.before = normalizeMargins(before);
		this.after = normalizeMargins(after);
	}

	apply(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		const b = marginsOf({ margins: this.before });
		const a = marginsOf({ margins: this.after });
		this.previous = { width: page.width, height: page.height, margins: page.margins };
		const dx = Math.round((a.left - b.left) * 100) / 100;
		page.width = Math.round((page.width + a.left + a.right - b.left - b.right) * 100) / 100;
		page.height = Math.round((page.height + a.bottom - b.bottom) * 100) / 100;
		if (this.after) page.margins = { ...this.after };
		else delete page.margins;
		if (dx === 0) return;
		// v13: the parts' pivots are page coordinates like the ink: they move with it, or a rotated or scaled part would turn about
		// a point that is no longer where its strokes are.
		if (page.states) {
			const moved = shiftPivots(page.states, dx);
			this.states = { before: page.states, after: moved };
			if (moved) page.states = moved;
		}
		if (page.comments) {
			const moved = shiftComments(page.comments, dx);
			this.comments = { before: page.comments, after: moved };
			page.comments = moved;
		}
		const move = <T extends Stroke | PageElement>(item: T, make: (x: T) => T): T => {
			let m = this.moved.get(item) as T | undefined;
			if (!m) {
				m = make(item);
				this.moved.set(item, m);
				this.original.set(m, item);
			}
			return m;
		};
		const strokes = page.strokes;
		for (let i = 0; i < strokes.length; i++) strokes[i] = move(strokes[i]!, (s) => translateStroke(s, dx));
		const els = page.elements;
		if (els) for (let i = 0; i < els.length; i++) els[i] = move(els[i]!, (e) => translateElement(e, dx));
	}

	revert(doc: NotebookDocument): void {
		const prev = this.previous;
		if (!prev) return;
		this.previous = null;
		const page = pageOf(doc, this.pageId);
		page.width = prev.width;
		page.height = prev.height;
		if (prev.margins) page.margins = prev.margins;
		else delete page.margins;
		const kept = this.states;
		this.states = null;
		if (kept) {
			// The table this apply left, put back as it was; one another command changed since (never in a stack) is moved back instead.
			if (page.states === kept.after) {
				if (kept.before) page.states = kept.before;
				else delete page.states;
			} else if (page.states) {
				const back = shiftPivots(page.states, -Math.round((marginsOf({ margins: this.after }).left - marginsOf({ margins: this.before }).left) * 100) / 100);
				if (back) page.states = back;
			}
		}
		const shifted = this.comments;
		this.comments = null;
		if (shifted) {
			if (page.comments === shifted.after) {
				if (shifted.before) page.comments = shifted.before;
				else delete page.comments;
			} else if (page.comments) {
				page.comments = shiftComments(page.comments, -Math.round((marginsOf({ margins: this.after }).left - marginsOf({ margins: this.before }).left) * 100) / 100);
			}
		}
		const strokes = page.strokes;
		for (let i = 0; i < strokes.length; i++) {
			const o = this.original.get(strokes[i]!);
			if (o) strokes[i] = o as Stroke;
		}
		const els = page.elements;
		if (els) {
			for (let i = 0; i < els.length; i++) {
				const o = this.original.get(els[i]!);
				if (o) els[i] = o as PageElement;
			}
		}
	}

	remap(swap: ElementSwap): void {
		const pairs = [...this.moved];
		this.moved.clear();
		this.original.clear();
		for (const [o, m] of pairs) {
			const from = swapItem(o, swap);
			const to = swapItem(m, swap);
			this.moved.set(from, to);
			this.original.set(to, from);
		}
	}
}

/**
 * Replaces a page's background and size in one step (a re-published slide switched to its new version).
 * Strokes and elements keep their page coordinates; margins are kept. Undo restores both exactly.
 */
export class SetPageBackground implements Command {
	readonly label = "Change page background";
	private previous: { background: PageBackground | undefined; width: number; height: number } | null = null;
	constructor(
		readonly pageId: string,
		readonly background: PageBackground,
		readonly size: { width: number; height: number },
	) {}

	apply(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		this.previous = { background: page.background, width: page.width, height: page.height };
		page.background = { ...this.background };
		page.width = this.size.width;
		page.height = this.size.height;
	}

	revert(doc: NotebookDocument): void {
		const prev = this.previous;
		if (!prev) return;
		this.previous = null;
		const page = pageOf(doc, this.pageId);
		if (prev.background) page.background = prev.background;
		else delete page.background;
		page.width = prev.width;
		page.height = prev.height;
	}
}

/** The element array of a page, created on first use (pages without elements have none). */
function elementsOf(doc: NotebookDocument, pageId: string): PageElement[] {
	const page = pageOf(doc, pageId);
	return (page.elements ??= []);
}

/**
 * Adds an element (a text box or an image). Elements are immutable like strokes, so the command
 * freezes it. Applying twice never duplicates; undoing removes it wherever it is.
 */
export class AddElement implements Command {
	readonly label = "Add element";
	/** Not readonly: an upkeep change maps it (`remap`). */
	element: PageElement;
	/** `stamps`: false for an element that is not added now (moved in from another page): the page time is not moved (v19). */
	constructor(readonly pageId: string, element: PageElement, readonly index: number, readonly stamps = true) {
		this.element = freezeElement(element);
	}

	apply(doc: NotebookDocument): void {
		const els = elementsOf(doc, this.pageId);
		if (els.includes(this.element)) return;
		els.splice(Math.max(0, Math.min(this.index, els.length)), 0, this.element);
	}

	revert(doc: NotebookDocument): void {
		const els = elementsOf(doc, this.pageId);
		const i = els.indexOf(this.element);
		if (i >= 0) els.splice(i, 1);
	}

	remap(swap: ElementSwap): void {
		this.element = swap(this.element);
	}
}

/** Removes an element; undo puts the same object back where it was. A missing element is a no-op both ways. */
export class RemoveElement implements Command {
	readonly label = "Remove element";
	private applied = false;
	private at = 0;
	/** Not readonly: an upkeep change maps it (`remap`). */
	element: PageElement;
	constructor(readonly pageId: string, element: PageElement) {
		this.element = element;
	}

	apply(doc: NotebookDocument): void {
		const els = elementsOf(doc, this.pageId);
		const i = els.indexOf(this.element);
		this.applied = i >= 0;
		if (i < 0) return;
		this.at = i;
		els.splice(i, 1);
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		const els = elementsOf(doc, this.pageId);
		if (els.includes(this.element)) return;
		els.splice(Math.max(0, Math.min(this.at, els.length)), 0, this.element);
	}

	remap(swap: ElementSwap): void {
		this.element = swap(this.element);
	}
}

/** Replaces an element with an edited copy at the same position (elements are immutable). */
export class ReplaceElement implements Command {
	readonly label = "Edit element";
	private applied = false;
	private at = 0;
	/** Not readonly: an upkeep change maps them (`remap`). */
	before: PageElement;
	after: PageElement;
	constructor(readonly pageId: string, before: PageElement, after: PageElement) {
		this.before = before;
		this.after = freezeElement(after);
	}

	apply(doc: NotebookDocument): void {
		const els = elementsOf(doc, this.pageId);
		const i = els.indexOf(this.before);
		this.applied = i >= 0 && !els.includes(this.after);
		if (!this.applied) return;
		this.at = i;
		els.splice(i, 1, this.after);
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		const els = elementsOf(doc, this.pageId);
		if (els.includes(this.before)) return;
		const i = els.indexOf(this.after);
		if (i >= 0) {
			els.splice(i, 1, this.before);
			return;
		}
		// The edited copy was replaced since (it should not be: see `remap`). The element it became is put back, never a second copy of it.
		const same = els.findIndex((e) => e.id === this.before.id);
		if (same >= 0) els.splice(same, 1, this.before);
		else els.splice(Math.max(0, Math.min(this.at, els.length)), 0, this.before);
	}

	remap(swap: ElementSwap): void {
		this.before = swap(this.before);
		this.after = swap(this.after);
	}
}

/**
 * Changes the layer order (roadmap 357): the strokes or the elements of a page in a new order, nothing else. The order
 * is stored as the items in `before` and `after`; applying puts the items of `after` that are on the page into the slots
 * those items occupy now, so an item that is not in the lists keeps its position, and a list that has become stale
 * (an item erased in between) still gives a valid page. Undoing puts `before` back the same way.
 */
export class ReorderLayer implements Command {
	readonly label = "Change layer order";
	private before: readonly (Stroke | PageElement)[];
	private after: readonly (Stroke | PageElement)[];
	constructor(readonly pageId: string, readonly layer: "strokes" | "elements", before: readonly (Stroke | PageElement)[], after: readonly (Stroke | PageElement)[]) {
		this.before = [...before];
		this.after = [...after];
	}

	apply(doc: NotebookDocument): void {
		this.place(doc, this.after);
	}

	revert(doc: NotebookDocument): void {
		this.place(doc, this.before);
	}

	remap(swap: ElementSwap): void {
		if (this.layer !== "elements") return;
		this.before = this.before.map((x) => swapItem(x, swap));
		this.after = this.after.map((x) => swapItem(x, swap));
	}

	private place(doc: NotebookDocument, order: readonly (Stroke | PageElement)[]): void {
		const page = pageOf(doc, this.pageId);
		const list = (this.layer === "strokes" ? page.strokes : page.elements) as (Stroke | PageElement)[] | undefined;
		if (!list) return;
		const members = new Set(order);
		const slots: number[] = [];
		const onPage = new Set<Stroke | PageElement>();
		list.forEach((item, i) => {
			if (!members.has(item)) return;
			slots.push(i);
			onPage.add(item);
		});
		const present = order.filter((item) => onPage.has(item));
		if (present.length !== slots.length) return;
		present.forEach((item, k) => {
			list[slots[k]!] = item;
		});
	}
}

/** Changes the notebook metadata (tags, favourite, cover, bookmarks). Both sides are copied. */
export class SetMeta implements Command {
	readonly label = "Change notebook properties";
	private readonly before: NotebookMeta;
	private readonly after: NotebookMeta;
	constructor(before: NotebookMeta, after: NotebookMeta) {
		this.before = cloneMeta(before);
		this.after = cloneMeta(after);
	}

	apply(doc: NotebookDocument): void {
		doc.meta = cloneMeta(this.after);
	}

	revert(doc: NotebookDocument): void {
		doc.meta = cloneMeta(this.before);
	}
}

/**
 * Registers an asset. An asset that already exists (same content id) is left alone, and then
 * undoing does not remove it: revert() removes only what this command added.
 */
export class AddAsset implements Command {
	readonly label = "Add file";
	private added = false;
	constructor(readonly asset: Asset) {}

	/** 0.28 (#98): this command added the record (it was not there), so undoing it takes the record away. */
	get adds(): boolean {
		return this.added;
	}

	apply(doc: NotebookDocument): void {
		const assets = (doc.assets ??= {});
		this.added = !Object.prototype.hasOwnProperty.call(assets, this.asset.id);
		if (this.added) assets[this.asset.id] = this.asset;
	}

	revert(doc: NotebookDocument): void {
		if (!this.added) return;
		this.added = false;
		if (doc.assets) delete doc.assets[this.asset.id];
	}
}

/**
 * Inserts many pages at once (a PDF import) as one undo step. Pages already in the document are
 * skipped; undo removes exactly the pages this command inserted, and never the last remaining page.
 */
export class InsertPages implements Command {
	readonly label = "Insert pages";
	private inserted: Page[] = [];
	constructor(readonly pages: readonly Page[], readonly index: number) {}

	apply(doc: NotebookDocument): void {
		const fresh = this.pages.filter((p, i) => !doc.pages.includes(p) && this.pages.indexOf(p) === i);
		if (fresh.length === 0) return; // already applied (or nothing to add): keep what revert() must remove
		this.inserted = fresh;
		doc.pages.splice(Math.max(0, Math.min(this.index, doc.pages.length)), 0, ...this.inserted);
	}

	revert(doc: NotebookDocument): void {
		const mine = new Set(this.inserted);
		this.inserted = [];
		if (mine.size === 0) return;
		const keep = doc.pages.filter((p) => !mine.has(p));
		if (keep.length === 0) return; // never leave a document without pages
		doc.pages.splice(0, doc.pages.length, ...keep);
	}

	remap(swap: ElementSwap): void {
		for (const p of this.pages) remapPage(p, swap);
	}
}

/** Turns the infinite-page option on or off. Off is stored as the absence of the flag. */
export class SetPageInfinite implements Command {
	readonly label = "Change infinite page";
	private previous: boolean | undefined;
	private applied = false;
	constructor(readonly pageId: string, readonly value: boolean) {}

	apply(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		this.previous = page.infinite;
		this.applied = true;
		if (this.value) page.infinite = true;
		else delete page.infinite;
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		const page = pageOf(doc, this.pageId);
		if (this.previous === undefined) delete page.infinite;
		else page.infinite = this.previous;
	}
}

/** Several commands undone and redone as one (e.g. one eraser gesture across pages). */
export class Batch implements Command {
	/** `lockExempt`: the page-lock guard lets this batch change locked pages (maintenance that keeps what the pages show, see asset-ops). */
	constructor(readonly label: string, readonly commands: readonly Command[], readonly lockExempt = false) {}

	apply(doc: NotebookDocument): void {
		for (const c of this.commands) c.apply(doc);
	}

	revert(doc: NotebookDocument): void {
		for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i]!.revert(doc);
	}

	remap(swap: ElementSwap): void {
		for (const c of this.commands) c.remap?.(swap);
	}
}

/**
 * Checks the document after a command (`checkContent` in serialize.ts): a message refuses the command, which is undone
 * at once, so no edit can leave the document in a state the writer rejects (every later save would stop).
 */
export type ContentGuard = (doc: NotebookDocument) => string | null;

/**
 * 0.29 (review R3-1): a check of an undo or a redo the history does not own (the view's redaction guard). Called with the document BEFORE
 * the step; it returns null (nothing to check) or a function called with the document AFTER the step, which returns true to refuse the step.
 * A refused step changes nothing: the document is put back as it was and the step stays exactly where it was in its stack (it is not dropped,
 * like a step on a locked page), so it is still offered once what refused it is gone.
 * Review U4: should the inverse that takes a refused step back throw, the document is put back from a snapshot and the step is treated like
 * a step that failed (`dropStep`: an in-order step is dropped, one taken from the middle stays where it was), never left half done.
 * Round-2 review (H4): the check says why through its verdict (see `StepVerdict`), which the history calls only once the step is back where
 * it was; a check that throws refuses the step too (fail closed) and the history says so with `setStepCheck`'s `failed`.
 */
export type StepCheck = (doc: NotebookDocument, step: "undo" | "redo", info: StepInfo) => ((after: NotebookDocument) => StepVerdict) | null;

/** Round-2 review (H4): false, the step stands; true, it is refused; a function, it is refused and the function says why once it is put back. */
export type StepVerdict = boolean | (() => void);

/** 0.29 (reviews U2, U7): what the history knows about a step when it asks a `StepCheck`. */
export interface StepInfo {
	/** The ids of the pages the step names (per-page undo rules); null: unknown, or the step may change every page. */
	pages: ReadonlySet<string> | null;
	/** A token that stays the same for every step of one `runSteps` run (a history-panel jump); null outside a run. */
	run: object | null;
}

/** What an object of the document held before an undo or a redo: its own fields, and the contents of its lists and tables that can change in place. */
interface Shot {
	target: Record<string, unknown>;
	fields: Record<string, unknown>;
	lists: Array<[unknown[], unknown[]]>;
	tables: Array<[Record<string, unknown>, Record<string, unknown>]>;
}

function shoot(target: object): Shot {
	const t = target as Record<string, unknown>;
	const fields = { ...t };
	const lists: Shot["lists"] = [];
	const tables: Shot["tables"] = [];
	for (const v of Object.values(fields)) {
		if (!v || typeof v !== "object" || Object.isFrozen(v)) continue;
		if (Array.isArray(v)) lists.push([v as unknown[], [...(v as unknown[])]]);
		else tables.push([v as Record<string, unknown>, { ...(v as Record<string, unknown>) }]);
	}
	return { target: t, fields, lists, tables };
}

function putBack(target: Record<string, unknown>, fields: Record<string, unknown>): void {
	for (const k of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(fields, k)) delete target[k];
	Object.assign(target, fields);
}

function restoreShot(s: Shot): void {
	putBack(s.target, s.fields);
	for (const [list, items] of s.lists) {
		list.length = items.length;
		for (let i = 0; i < items.length; i++) list[i] = items[i];
	}
	for (const [table, fields] of s.tables) putBack(table, fields);
}

/**
 * 0.19: the document as it is (its fields, its pages and theirs: shallow, no stroke or element is copied), so that an undo or a redo
 * the guard refuses can be taken back exactly, whatever the command did.
 */
function snapshotDocument(doc: NotebookDocument): Shot[] {
	return [shoot(doc), ...doc.pages.map((p) => shoot(p))];
}

/**
 * 0.19: the element objects an upkeep command replaced, old → new, when that is all it did: the same pages, the same strokes, and
 * each changed element slot holds an element with the same id. Null when it did anything else (that cannot be told to the stacks).
 */
function swapsSince(doc: NotebookDocument, before: ReadonlyArray<{ page: Page; strokes: readonly Stroke[]; elements: readonly PageElement[] }>): Map<PageElement, PageElement> | null {
	if (doc.pages.length !== before.length) return null;
	const pairs = new Map<PageElement, PageElement>();
	for (let p = 0; p < before.length; p++) {
		const was = before[p]!;
		const page = doc.pages[p]!;
		if (page !== was.page || page.strokes.length !== was.strokes.length || page.strokes.some((s, i) => s !== was.strokes[i])) return null;
		const els = page.elements ?? [];
		if (els.length !== was.elements.length) return null;
		for (let i = 0; i < els.length; i++) {
			const old = was.elements[i]!;
			const next = els[i]!;
			if (old === next) continue;
			if (old.id !== next.id || old.type !== next.type) return null;
			pairs.set(old, next);
		}
	}
	return pairs;
}

/**
 * v19: the ids of the pages `cmd` adds ink (`AddStroke`) or an element (`AddElement`) to, or changes the text of an element of
 * (`ReplaceElement`: text box, sticky note, marker label, box title, equation, checkbox label; not a move or a restyle), in `added`,
 * looking into batches and into the lock-exempt wrapper; and those it sets the times of itself (`SetPageTimes`), in `explicit`.
 * An add built with `stamps = false` (ink moved in from another page, made from an equation) is not "written now" and is left out.
 */
export function collectAdds(cmd: Command, added: Set<string>, explicit: Set<string>): void {
	if (cmd instanceof AddStroke || cmd instanceof AddElement) {
		if (cmd.stamps) added.add(cmd.pageId);
	} else if (cmd instanceof ReplaceElement) {
		if (elementTextChanged(cmd.before, cmd.after)) added.add(cmd.pageId);
	} else if (cmd instanceof SetPageTimes) explicit.add(cmd.pageId);
	else if (cmd instanceof Batch) for (const c of cmd.commands) collectAdds(c, added, explicit);
	else if ("inner" in cmd && typeof cmd.inner === "object" && cmd.inner !== null) collectAdds(cmd.inner as Command, added, explicit);
}

/** 0.25 (#84): one step of the history as the panel lists it: the command and the time (ms) it was made, or null when it is not known. */
export interface HistoryEntry {
	readonly cmd: Command;
	readonly at: number | null;
}

export class History {
	private undoStack: Command[] = [];
	private redoStack: Command[] = [];
	/** 0.25 (#84): when each step was recorded (for the history panel only: nothing else reads it, and a step without a time is fine). */
	private readonly madeAt = new WeakMap<Command, number>();
	/** 0.25: inside `runSteps`, and the guard result the last step ended with (null: not known). */
	private stepsRun = false;
	private knownBad: boolean | null = null;

	constructor(
		private readonly doc: () => NotebookDocument, readonly limit = 500,
		/** `step`: set when an undo or a redo was refused (and dropped from the history), absent for a new edit. */
		private readonly guard: ContentGuard | null = null, private readonly refused: ((message: string, step?: "undo" | "redo", kept?: boolean) => void) | null = null,
		/** wave 0.10 (51): true while the document must not change (read-only mode): nothing is run, undone or redone. */
		private readonly locked: (() => boolean) | null = null,
		/**
		 * v14 (#124): called with the ids of the locked pages a command, an undo or a redo tried to change. The change was
		 * not kept: the command is reverted (or re-applied) and, for execute, not recorded. See model/page-lock.ts.
		 */
		private readonly pagesLocked: ((pageIds: readonly string[]) => void) | null = null,
		/**
		 * v19 (#217): the time of day in ms. When given, a command that adds ink or an element to a page stamps the page's start and end
		 * times (model/page-times.ts) once it has succeeded: upkeep, so there is no undo step for it and Undo / Redo never touch it.
		 */
		private readonly clock: (() => number) | null = null,
	) {}

	/**
	 * Runs the command and records it. False when the guard refused it (it is undone and not recorded) or the history is
	 * locked (read-only mode: the command is not even applied).
	 */
	execute(cmd: Command): boolean {
		if (this.locked?.()) return false;
		const doc = this.doc();
		// v14: ONE guard for every edit that goes through the history: a locked page keeps its content. Nothing is snapshotted
		// when no page is locked.
		const locks = cmd.lockExempt ? null : snapshotLocked(doc);
		cmd.apply(doc);
		if (locks) {
			const hit = lockedChanges(doc, locks);
			if (hit.length > 0) {
				cmd.revert(doc);
				this.pagesLocked?.(hit);
				return false;
			}
		}
		const problem = this.guard?.(doc) ?? null;
		if (problem !== null) {
			cmd.revert(doc);
			this.refused?.(problem);
			return false;
		}
		this.record(cmd);
		// v19: upkeep after the step is recorded: whatever goes wrong with the clock, the step stays an undo step.
		if (this.clock) {
			try {
				this.stampAdded(doc, cmd, this.clock());
			} catch (e) {
				console.error("[notebook] page times", e);
			}
		}
		return true;
	}

	/** v19: the pages `cmd` added ink or an element to, or changed the text of, are stamped `now` (not those a `SetPageTimes` of the same command sets itself). */
	private stampAdded(doc: NotebookDocument, cmd: Command, now: number): void {
		const added = new Set<string>();
		const explicit = new Set<string>();
		collectAdds(cmd, added, explicit);
		for (const id of explicit) added.delete(id);
		if (added.size > 0) stampPages(doc, added, Math.floor(now));
	}

	/**
	 * Runs a command that is upkeep, not an edit by the user (a task link that follows a renamed note, or is dropped because its
	 * line is gone): it is not recorded, so Undo goes on undoing the user's own steps, and the redo steps are kept. The document
	 * has changed all the same, so the caller saves it. False, with nothing changed and nothing said, when the history is locked, a
	 * locked page would change or the guard refused it: the caller tries again later.
	 *
	 * 0.19: the steps in both stacks find their elements by identity, so an upkeep change may only replace element objects (same
	 * pages, same strokes, an element with the same id in each changed slot; anything else is refused like a locked page), and every
	 * step is told what replaced what (`Command.remap`, `quietSwap`): an Undo or a Redo then works on what is there now and never
	 * makes a second copy of an element.
	 */
	applyQuietly(cmd: Command): boolean {
		if (this.locked?.()) return false;
		const doc = this.doc();
		const locks = cmd.lockExempt ? null : snapshotLocked(doc);
		const before = doc.pages.map((page) => ({ page, strokes: [...page.strokes], elements: [...(page.elements ?? [])] }));
		cmd.apply(doc);
		const pairs = swapsSince(doc, before);
		if (pairs === null || (locks && lockedChanges(doc, locks).length > 0) || (this.guard?.(doc) ?? null) !== null) {
			cmd.revert(doc);
			return false;
		}
		if (pairs.size > 0) {
			const swap = quietSwap(pairs);
			for (const c of this.undoStack) c.remap?.(swap);
			for (const c of this.redoStack) c.remap?.(swap);
		}
		return true;
	}

	/**
	 * 0.25 (#84): runs `fn`, which takes many undo / redo steps in a row (a jump in the history panel), and lets each step reuse the
	 * guard result the step before it ended with: the document is the same between two steps, so "did it already fail the guard?" is
	 * the answer the last step gave. Every step still checks the document after it, as always; only the repeated check before it is
	 * saved. A step that is refused, fails or is not run leaves the answer unknown, and the next one asks again. Nothing may change the
	 * document between steps inside `fn`.
	 */
	runSteps<T>(fn: () => T): T {
		const was = this.stepsRun;
		const token = this.runToken;
		this.stepsRun = true;
		this.knownBad = null;
		// 0.29 (review U7): one token per run (an inner run keeps the outer one), so a step check can read what it needs once per jump.
		if (!token) this.runToken = {};
		try {
			return fn();
		} finally {
			this.stepsRun = was;
			this.runToken = token;
			this.knownBad = null;
		}
	}

	/** 0.29 (review U7): the token of the `runSteps` run in progress (null outside one), handed to the step check. */
	private runToken: object | null = null;

	/** The guard result the previous step of a `runSteps` run ended with (true: the document failed it), taken: the next step sets it again. */
	private takeKnown(): boolean | null {
		const known = this.stepsRun ? this.knownBad : null;
		this.knownBad = null;
		return known;
	}

	/** Did the document already fail the guard before the step? (The previous step's answer when it is known.) */
	private badBefore(doc: NotebookDocument, snapshot: Shot[] | null, known: boolean | null): boolean {
		if (snapshot === null) return false;
		return known ?? (this.guard?.(doc) ?? null) !== null;
	}

	/**
	 * 0.19 backstop: after an undo or a redo the document must still be one the writer saves (the guard, as for every edit). When it
	 * is not, the document is put back exactly as it was before the step (`snapshot`), the step is dropped from the history (doing it
	 * again would do the same) and it is said. True when the step was refused.
	 */
	private refusedStep(doc: NotebookDocument, snapshot: Shot[] | null, step: "undo" | "redo", wasBad: boolean, cmd: Command, keepAt: number | null): boolean {
		// A document that already failed the guard before the step (a change outside the history) is not the step's doing: it is kept.
		if (!snapshot || !this.guard || wasBad) return false;
		const problem = this.guard(doc);
		if (problem === null) {
			if (this.stepsRun) this.knownBad = false;
			return false;
		}
		this.dropStep(snapshot, problem, step, cmd, keepAt);
		return true;
	}

	/**
	 * The document back exactly as before the step, and it is said. An ordinary step is dropped from the history, with the redo steps made on
	 * top of a redo that is dropped (only those that depended on it when per-page undo is on). 0.28 (#98): a step taken out of order
	 * (`keepAt`: where it was) is NOT dropped: the refusal may come from the state of other pages that a later step of the history changes,
	 * so it goes back where it was, and nothing else in either stack changes.
	 */
	private dropStep(snapshot: Shot[], problem: string, step: "undo" | "redo", cmd: Command, keepAt: number | null): void {
		for (const s of snapshot) restoreShot(s);
		if (keepAt !== null) {
			const stack = step === "undo" ? this.undoStack : this.redoStack;
			stack.splice(Math.min(keepAt, stack.length), 0, cmd);
		} else if (step === "redo") {
			// The refused step was the next Redo, so every undone step left is below it: when it shares the tables they all go (R2-1).
			const rules = this.rules;
			const scope = rules ? rules.scope(cmd) : null;
			this.redoStack = this.pagewise && rules && scope ? survivingRedo(this.redoStack, (r) => rules.scope(r), scope, sharesTables(scope)) : [];
		}
		this.refused?.(problem, step, keepAt !== null);
	}

	/** Runs the step; an exception leaves the document as it was, drops (or, out of order, keeps) the step and says so. True when it ran. */
	private ran(run: () => void, snapshot: Shot[] | null, step: "undo" | "redo", cmd: Command, keepAt: number | null): boolean {
		try {
			run();
			return true;
		} catch (e) {
			if (!snapshot) throw e;
			this.dropStep(snapshot, e instanceof Error ? e.message : String(e), step, cmd, keepAt);
			return false;
		}
	}

	/** Records an already applied command (e.g. the eraser, which erases while it moves). */
	record(cmd: Command): void {
		try {
			this.madeAt.set(cmd, Math.floor(this.clock ? this.clock() : Date.now()));
		} catch {
			// The time is only a label of the step: a clock that fails never stops the step from being recorded.
		}
		this.undoStack.push(cmd);
		// 0.27 review (M3): inside a group the stack is trimmed once, when the group ends, so one group costs one entry like one step.
		if (!this.grouping) this.trimUndo();
		// 0.28 review (P5): inside a group with per-page undo on, the undone steps are filtered once, against the merged step, when the group ends.
		if (!(this.grouping && this.isPagewise)) {
			this.redoStack = this.keptRedo(cmd);
			this.trimRedo();
		}
		this.grouping?.push(cmd);
	}

	/** 0.28 review (P6): the redo list has the depth limit of the undo list too (the undone steps farthest from the next Redo go first). */
	private trimRedo(): void {
		while (this.redoStack.length > this.limit) this.redoStack.shift();
	}

	/**
	 * 0.28 (#98): the redo steps that stay after the new edit `cmd`. Ordinarily none. With per-page undo on, a step undone on its own page
	 * stays redoable while the person writes on another page: only the undone steps that touch the pages `cmd` touches (and every global
	 * one) are dropped. See `redoSurvives`. 0.28 review (R2-1): when a dropped step is global or registers a file or slide entry, every
	 * undone step below it is dropped too, on every page (`survivingRedo`), so no step left can be redone pointing at an entry that is gone.
	 */
	private keptRedo(cmd: Command): Command[] {
		const rules = this.rules;
		if (!this.pagewise || !rules || this.redoStack.length === 0) return [];
		return survivingRedo(this.redoStack, (r) => rules.scope(r), rules.scope(cmd));
	}

	/** 0.28 (#98): how the pages a step touches are told (page-undo.ts `pageRules`); null: per-page undo is not available. */
	private rules: PageRules | null = null;
	/** 0.28 (#98): per-page undo is on, so a new edit keeps the undone steps of the other pages. Off: the redo list is cleared as always. */
	private pagewise = false;

	/** 0.28 (#98): gives the history the rules that tell which pages a step touches. Needed by `undoOnPage`, `redoOnPage` and `pagewise`. */
	setPageRules(rules: PageRules | null): void {
		this.rules = rules;
	}

	/** 0.28 (#98): the "Per-page undo" setting. It only changes what a new edit does to the redo list; Undo and Redo themselves are chosen by the caller. */
	setPagewise(on: boolean): void {
		this.pagewise = on;
	}

	get isPagewise(): boolean {
		return this.pagewise && this.rules !== null;
	}

	/** 0.29 (review R3-1): the outside check of every undo and redo (see `StepCheck`); null: none. */
	private stepCheck: StepCheck | null = null;

	/** Round-2 review (H4): says that a step was refused because its check threw (the check could not say why itself); null: nothing is said. */
	private stepCheckFailed: ((step: "undo" | "redo") => void) | null = null;

	setStepCheck(check: StepCheck | null, failed: ((step: "undo" | "redo") => void) | null = null): void {
		this.stepCheck = check;
		this.stepCheckFailed = failed;
	}

	/** The outside check for one step, taken before it; a check that fails to start refuses the step (fail closed). */
	private prepareCheck(doc: NotebookDocument, step: "undo" | "redo", cmd: Command): ((after: NotebookDocument) => StepVerdict) | null {
		if (!this.stepCheck) return null;
		try {
			// Review U2: the pages the step names, so that a check need not copy every page of the notebook for each step.
			const scope = this.rules ? this.rules.scope(cmd) : null;
			return this.stepCheck(doc, step, { pages: scope && !scope.all ? scope.pages : null, run: this.runToken });
		} catch (e) {
			// Round-2 review (H4): thrown again where the verdict is read, so the refusal is said like that of a check that throws there.
			return () => {
				throw e;
			};
		}
	}

	/**
	 * 0.29 (review R3-1): asks the outside check about the step just taken; when it refuses (or fails: fail closed), the step is taken back
	 * with its own inverse (`inverse`: as for a locked page, so a command that remembers what it swapped, like `UpdateItems`, is ready for
	 * the next try): "refused", the caller puts the step back where it was. Review U4: should the inverse throw, the command may be half
	 * updated inside, so the document is put back from `snapshot` and the step goes the way of a step that failed (`dropStep`: dropped in
	 * order, kept where it was out of order, and said): "dropped", the caller does nothing more. "ok": the step stands.
	 * Round-2 review (H4): why a step was refused is said only once it is back ("refused"): by the verdict, or, when the check threw, by
	 * `stepCheckFailed`. A dropped step is said by `dropStep` alone.
	 */
	private checkRefused(
		check: (after: NotebookDocument) => StepVerdict, snapshot: Shot[], inverse: () => void, step: "undo" | "redo", cmd: Command, keepAt: number | null,
	): "ok" | "refused" | "dropped" {
		let verdict: StepVerdict;
		let threw = false;
		try {
			verdict = check(this.doc());
		} catch (e) {
			console.error("[notebook] undo/redo check", e);
			verdict = true;
			threw = true;
		}
		if (verdict === false) return "ok";
		try {
			inverse();
		} catch (e) {
			this.dropStep(snapshot, e instanceof Error ? e.message : String(e), step, cmd, keepAt);
			return "dropped";
		}
		try {
			if (threw) this.stepCheckFailed?.(step);
			else if (typeof verdict === "function") verdict();
		} catch (e) {
			// The notice is only words: the step is back where it was all the same.
			console.error("[notebook] undo/redo check notice", e);
		}
		return "refused";
	}

	/** Drops the oldest steps beyond the limit. */
	private trimUndo(): void {
		while (this.undoStack.length > this.limit) this.undoStack.shift();
	}

	/** 0.27 (#170): the steps recorded since `group` began (null outside a group). */
	private grouping: Command[] | null = null;

	/** How many steps the open `group` has recorded so far (0 outside a group): a counter a macro run compares before and after a step. */
	get groupedSteps(): number {
		return this.grouping?.length ?? 0;
	}

	/**
	 * 0.27 (#170): runs `fn`, which edits through this history step after step (a macro), and makes everything it recorded ONE undo step
	 * (a `Batch` named `label`). Each step still goes through `execute` with every guard of its own (locks, content check, read-only), so
	 * a refused step is simply not part of the group. Fewer than two recorded steps are left as they are. When anything else touched the
	 * stacks meanwhile (an undo, `clear`) the steps are left as separate ones: nothing is ever lost or reordered. A group inside a group
	 * is part of the outer one.
	 */
	group<T>(label: string, fn: () => T): T {
		if (this.grouping) return fn();
		this.grouping = [];
		try {
			return fn();
		} finally {
			const made = this.grouping;
			this.grouping = null;
			const merged = this.merge(label, made);
			this.trimUndo();
			// 0.28 review (P5): the undone steps kept for other pages are filtered against what the group became: one global step when it wrote on
			// several pages. Steps left separate (not merged) are filtered one by one.
			if (this.isPagewise) {
				for (const c of merged ? [merged] : made) this.redoStack = this.keptRedo(c);
				this.trimRedo();
			}
		}
	}

	/** Replaces `made`, the last steps of the undo stack, by one `Batch` (only when they are exactly the top of the stack, in order); the batch, or null. */
	private merge(label: string, made: readonly Command[]): Batch | null {
		if (made.length < 2) return null;
		const top = this.undoStack.slice(this.undoStack.length - made.length);
		if (top.length !== made.length || top.some((c, i) => c !== made[i])) return null;
		this.undoStack.length -= made.length;
		const batch = new Batch(label, made, made.every((c) => c.lockExempt === true));
		const at = this.madeAt.get(made[made.length - 1]!);
		if (at !== undefined) this.madeAt.set(batch, at);
		this.undoStack.push(batch);
		return batch;
	}

	undo(): Command | null {
		return this.undoAt(this.undoStack.length - 1);
	}

	/**
	 * Undoes the step at position `at` of the undo stack with its own `revert` (the newest one for an ordinary Undo). A step taken out of the
	 * middle is only ever asked for by `undoOnPage`, which has checked that no later step touches its page. Every guard is the one of Undo:
	 * a refused step is dropped (or, for a locked page, left where it was).
	 */
	private undoAt(at: number): Command | null {
		if (this.locked?.()) return null;
		const known = this.takeKnown();
		const cmd = this.undoStack[at];
		if (!cmd) return null;
		// 0.28 review (P3): a step taken from the middle of the stack is kept where it was when the guard refuses it.
		const keepAt = at !== this.undoStack.length - 1 ? at : null;
		this.undoStack.splice(at, 1);
		const doc = this.doc();
		const locks = cmd.lockExempt ? null : snapshotLocked(doc);
		const check = this.prepareCheck(doc, "undo", cmd);
		// Review U4: a snapshot whenever a check may take the step back (shallow: no stroke or element is copied).
		const snapshot = this.guard || check ? snapshotDocument(doc) : null;
		const wasBad = this.badBefore(doc, snapshot, known);
		if (!this.ran(() => cmd.revert(doc), snapshot, "undo", cmd, keepAt)) return null;
		if (check && snapshot) {
			const verdict = this.checkRefused(check, snapshot, () => cmd.apply(doc), "undo", cmd, keepAt);
			if (verdict === "refused") this.undoStack.splice(at, 0, cmd);
			if (verdict !== "ok") return null;
		}
		if (locks) {
			// An older edit of a page that has been locked since (a synced change, a lock set later and left on): the undo
			// is not done and stays on the stack for when the page is unlocked.
			// (A page the undo removes is the command's own add, e.g. a restored locked page: allowed.)
			const hit = lockedChanges(doc, locks, true);
			if (hit.length > 0) {
				cmd.apply(doc);
				this.undoStack.splice(at, 0, cmd);
				this.pagesLocked?.(hit);
				return null;
			}
		}
		if (this.refusedStep(doc, snapshot, "undo", wasBad, cmd, keepAt)) return null;
		this.redoStack.push(cmd);
		this.trimRedo();
		return cmd;
	}

	redo(): Command | null {
		return this.redoAt(this.redoStack.length - 1);
	}

	/** Redoes the step at position `at` of the redo stack (the next one for an ordinary Redo): the same as `undoAt`, the other way. */
	private redoAt(at: number): Command | null {
		if (this.locked?.()) return null;
		const known = this.takeKnown();
		const cmd = this.redoStack[at];
		if (!cmd) return null;
		const keepAt = at !== this.redoStack.length - 1 ? at : null;
		this.redoStack.splice(at, 1);
		const doc = this.doc();
		const locks = cmd.lockExempt ? null : snapshotLocked(doc);
		const check = this.prepareCheck(doc, "redo", cmd);
		const snapshot = this.guard || check ? snapshotDocument(doc) : null;
		const wasBad = this.badBefore(doc, snapshot, known);
		if (!this.ran(() => cmd.apply(doc), snapshot, "redo", cmd, keepAt)) return null;
		if (check && snapshot) {
			const verdict = this.checkRefused(check, snapshot, () => cmd.revert(doc), "redo", cmd, keepAt);
			if (verdict === "refused") this.redoStack.splice(at, 0, cmd);
			if (verdict !== "ok") return null;
		}
		if (locks) {
			const hit = lockedChanges(doc, locks);
			if (hit.length > 0) {
				cmd.revert(doc);
				this.redoStack.splice(at, 0, cmd);
				this.pagesLocked?.(hit);
				return null;
			}
		}
		if (this.refusedStep(doc, snapshot, "redo", wasBad, cmd, keepAt)) return null;
		this.undoStack.push(cmd);
		return cmd;
	}

	/** The position of the newest step of `stack` that touches `pageId` (-1: none). Both stacks are searched from their end: the next undo / redo first. */
	private lastTouching(stack: readonly Command[], pageId: string): number {
		const rules = this.rules;
		if (!rules) return -1;
		for (let i = stack.length - 1; i >= 0; i--) if (touchesPage(rules.scope(stack[i]!), pageId)) return i;
		return -1;
	}

	/**
	 * 0.28 (#98): Undo on one page. Takes the newest step that touches `pageId` out of the undo stack and undoes it with its own `revert`;
	 * the steps on other pages stay as they are. Safe because no later step touches that page (see page-undo.ts). When that newest step is
	 * global (it names several pages, or the page list, or the notebook) nothing is undone: `{ kind: "global" }`. Every guard of `undo()`
	 * applies (read-only mode, page locks, the content check).
	 */
	undoOnPage(pageId: string): PageStepResult {
		const rules = this.rules;
		const at = this.lastTouching(this.undoStack, pageId);
		if (!rules || at < 0) return { kind: "nothing" };
		const cmd = this.undoStack[at]!;
		const scope = rules.scope(cmd);
		if (!scope.local) return { kind: "global", cmd };
		// 0.28 review (P1, P2): the file table, the slide table and the cover are shared by every page, and the content check cannot tell what
		// the steps still in the history will put back. A step that ADDED an entry is only undone in order, as the newest step of all.
		if (at !== this.undoStack.length - 1 && scope.registers.some((r) => r.adds())) return { kind: "global", cmd, why: "shared" };
		const done = this.undoAt(at);
		return done ? { kind: "done", cmd: done } : { kind: "refused" };
	}

	/**
	 * 0.28 (#98): Redo on one page: the step undone last on that page (the one nearest the end of the redo list) is applied again with its own
	 * `apply`. A new edit on a page dropped that page's redo steps, so what is here is exactly what the page's own undo left.
	 */
	redoOnPage(pageId: string): PageStepResult {
		const rules = this.rules;
		const at = this.lastTouching(this.redoStack, pageId);
		if (!rules || at < 0) return { kind: "nothing" };
		const cmd = this.redoStack[at]!;
		if (!rules.scope(cmd).local) return { kind: "global", cmd };
		// 0.28 review (P1, P2): never redo past an undone step that is global (the cover, a file removed, the page list) or that registers a file
		// or a slide entry: this step may need what that one puts back first. In order it is the plain Redo.
		for (let i = at + 1; i < this.redoStack.length; i++) {
			const above = rules.scope(this.redoStack[i]!);
			if (!above.local || above.registers.length > 0) return { kind: "global", cmd, why: "shared" };
		}
		const done = this.redoAt(at);
		return done ? { kind: "done", cmd: done } : { kind: "refused" };
	}

	/** 0.28 (#98): what `undoOnPage` / `redoOnPage` would find for a page, without doing it (for the buttons). */
	peekOnPage(pageId: string): { undo: "none" | "page" | "global"; redo: "none" | "page" | "global" } {
		const rules = this.rules;
		const kind = (stack: readonly Command[]): "none" | "page" | "global" => {
			const at = this.lastTouching(stack, pageId);
			if (!rules || at < 0) return "none";
			return rules.scope(stack[at]!).local ? "page" : "global";
		};
		return { undo: kind(this.undoStack), redo: kind(this.redoStack) };
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
	}

	/**
	 * 0.25 (#84): the steps for the history panel. `undo` oldest first (the last one is where the document is now), `redo` with the step
	 * a Redo would run first. A copy: the caller cannot change the stacks.
	 */
	entries(): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
		const entry = (cmd: Command): HistoryEntry => ({ cmd, at: this.madeAt.get(cmd) ?? null });
		return { undo: this.undoStack.map(entry), redo: [...this.redoStack].reverse().map(entry) };
	}

	/** 0.25 (#84): how many steps the two stacks hold (cheap: no copy). */
	depth(): { undo: number; redo: number } {
		return { undo: this.undoStack.length, redo: this.redoStack.length };
	}

	/**
	 * 0.25 (#84): how many Undo (`undo`) or Redo (`redo`) steps lead to the point just after `cmd`; null when `cmd` is in neither stack.
	 * Redo steps count from the next one: the step a Redo would run first is 1.
	 */
	stepsTo(cmd: Command): { direction: "undo" | "redo"; steps: number } | null {
		const u = this.undoStack.lastIndexOf(cmd);
		if (u >= 0) return { direction: "undo", steps: this.undoStack.length - 1 - u };
		const r = this.redoStack.lastIndexOf(cmd);
		if (r >= 0) return { direction: "redo", steps: this.redoStack.length - r };
		return null;
	}

	/** Every command still in the undo and redo stacks (read-only: the library check asks what they still name). */
	pending(): readonly Command[] {
		return [...this.undoStack, ...this.redoStack];
	}
}
