import { findPage } from "./document";
import type { NotebookDocument, Page, Paper, Stroke } from "./types";

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
 */
export class SetPageSize implements Command {
	readonly label = "Change page size";
	constructor(
		readonly pageId: string,
		readonly before: { width: number; height: number },
		readonly after: { width: number; height: number },
	) {}

	apply(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		page.width = this.after.width;
		page.height = this.after.height;
	}

	revert(doc: NotebookDocument): void {
		const page = pageOf(doc, this.pageId);
		page.width = this.before.width;
		page.height = this.before.height;
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
