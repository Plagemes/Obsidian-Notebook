import { findPage } from "./document";
import type { NotebookDocument, Page, Stroke } from "./types";

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
		doc.pages.splice(Math.min(this.index, doc.pages.length), 0, this.page);
	}

	revert(doc: NotebookDocument): void {
		const i = doc.pages.indexOf(this.page);
		// Never leave a document without pages.
		if (i >= 0 && doc.pages.length > 1) doc.pages.splice(i, 1);
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
