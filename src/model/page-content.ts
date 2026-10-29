import { createPage, findPage } from "./document";
import { Batch, InsertPages, type Command } from "./history";
import { freezeElement } from "./serialize";
import type { NotebookDocument, PageElement, Stroke } from "./types";

/** The new content (and, for a page that grows, height) of one existing page. Strokes and elements are the objects to keep, in drawing order. */
export interface PageContentChange {
	pageId: string;
	strokes: readonly Stroke[];
	/** `undefined`: the page has no elements. */
	elements: readonly PageElement[] | undefined;
	/** New page height, pt (an infinite page that has to grow). */
	height?: number;
}

/** Content of a page that does not exist yet; created like the last page of the document. */
export interface NewPageContent {
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
}

export interface PageContentPlan {
	changes: readonly PageContentChange[];
	appended: readonly NewPageContent[];
	/** Where the appended pages go (index in the document); the end of the document when absent. */
	insertAt?: number;
}

/**
 * Replaces the strokes and elements of a page (and optionally its height) in one step. Strokes and elements
 * are immutable objects, so the command keeps the arrays of what was there and puts them back on undo.
 * The page's arrays are changed in place, so anything holding them keeps seeing the page.
 */
export class SetPageContent implements Command {
	readonly label = "Move content";
	private before: { strokes: Stroke[]; elements: PageElement[] | undefined; height: number } | null = null;

	constructor(readonly change: PageContentChange) {
		for (const el of change.elements ?? []) freezeElement(el);
	}

	apply(doc: NotebookDocument): void {
		const page = findPage(doc, this.change.pageId);
		if (!page) throw new Error(`page ${this.change.pageId} not found`);
		this.before ??= { strokes: [...page.strokes], elements: page.elements ? [...page.elements] : undefined, height: page.height };
		page.strokes.splice(0, page.strokes.length, ...this.change.strokes);
		const els = this.change.elements;
		if (els && els.length > 0) {
			if (page.elements) page.elements.splice(0, page.elements.length, ...els);
			else page.elements = [...els];
		} else if (page.elements) {
			delete page.elements;
		}
		if (this.change.height !== undefined) page.height = this.change.height;
	}

	revert(doc: NotebookDocument): void {
		const before = this.before;
		if (!before) return;
		const page = findPage(doc, this.change.pageId);
		if (!page) throw new Error(`page ${this.change.pageId} not found`);
		page.strokes.splice(0, page.strokes.length, ...before.strokes);
		if (before.elements) {
			if (page.elements) page.elements.splice(0, page.elements.length, ...before.elements);
			else page.elements = [...before.elements];
		} else {
			delete page.elements;
		}
		page.height = before.height;
	}
}

/**
 * One undoable step for a content plan: the changed pages, plus the pages that have to be appended
 * (same size and paper as the page before them, no background; at `plan.insertAt`, by default the end). Undo removes the pages it added.
 */
export function pageContentCommand(doc: NotebookDocument, plan: PageContentPlan, label: string): Command {
	const commands: Command[] = plan.changes.map((c) => new SetPageContent(c));
	const at = Math.max(0, Math.min(plan.insertAt ?? doc.pages.length, doc.pages.length));
	// New pages look like the page they continue.
	const like = doc.pages[at - 1] ?? doc.pages[doc.pages.length - 1];
	if (plan.appended.length > 0 && like) {
		const pages = plan.appended.map((content) => {
			const page = createPage({ width: like.width, height: like.height }, { ...like.paper });
			page.strokes = [...content.strokes];
			if (content.elements.length > 0) page.elements = content.elements.map((el) => freezeElement(el));
			return page;
		});
		commands.push(new InsertPages(pages, at));
	}
	return new Batch(label, commands);
}
