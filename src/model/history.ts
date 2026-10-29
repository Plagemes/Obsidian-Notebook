import { cloneMeta, findPage } from "./document";
import { freezeElement } from "./serialize";
import { marginsAfterResize, marginsOf, normalizeMargins, translateElement, translateStroke } from "./margins";
import type { Asset, NotebookDocument, NotebookMeta, Page, PageBackground, PageElement, PageMargins, Paper, Stroke } from "./types";

/** A command knows how to apply and revert itself on a document: no snapshots. */
export interface Command {
	readonly label: string;
	apply(doc: NotebookDocument): void;
	revert(doc: NotebookDocument): void;
}

function pageOf(doc: NotebookDocument, pageId: string) {
	const page = findPage(doc, pageId);
	if (!page) throw new Error(`page ${pageId} not found`);
	return page;
}

export class AddStroke implements Command {
	readonly label = "Add stroke";
	constructor(readonly pageId: string, readonly stroke: Stroke, readonly index: number) {}

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
	constructor(readonly pageId: string, readonly element: PageElement, readonly index: number) {
		freezeElement(element);
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
}

/** Removes an element; undo puts the same object back where it was. A missing element is a no-op both ways. */
export class RemoveElement implements Command {
	readonly label = "Remove element";
	private applied = false;
	private at = 0;
	constructor(readonly pageId: string, readonly element: PageElement) {}

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
}

/** Replaces an element with an edited copy at the same position (elements are immutable). */
export class ReplaceElement implements Command {
	readonly label = "Edit element";
	private applied = false;
	private at = 0;
	constructor(readonly pageId: string, readonly before: PageElement, readonly after: PageElement) {
		freezeElement(after);
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
		if (i >= 0) els.splice(i, 1, this.before);
		else els.splice(Math.max(0, Math.min(this.at, els.length)), 0, this.before);
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
	constructor(readonly label: string, readonly commands: readonly Command[]) {}

	apply(doc: NotebookDocument): void {
		for (const c of this.commands) c.apply(doc);
	}

	revert(doc: NotebookDocument): void {
		for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i]!.revert(doc);
	}
}

export class History {
	private undoStack: Command[] = [];
	private redoStack: Command[] = [];

	constructor(private readonly doc: () => NotebookDocument, readonly limit = 500) {}

	/** Runs the command and records it. */
	execute(cmd: Command): void {
		cmd.apply(this.doc());
		this.record(cmd);
	}

	/** Records an already applied command (e.g. the eraser, which erases while it moves). */
	record(cmd: Command): void {
		this.undoStack.push(cmd);
		if (this.undoStack.length > this.limit) this.undoStack.shift();
		this.redoStack = [];
	}

	undo(): Command | null {
		const cmd = this.undoStack.pop();
		if (!cmd) return null;
		cmd.revert(this.doc());
		this.redoStack.push(cmd);
		return cmd;
	}

	redo(): Command | null {
		const cmd = this.redoStack.pop();
		if (!cmd) return null;
		cmd.apply(this.doc());
		this.undoStack.push(cmd);
		return cmd;
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
}
