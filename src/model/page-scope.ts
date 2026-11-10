/**
 * 0.28 (#98): the types and the pure rules of per-page undo that `History` itself needs (so that history.ts imports nothing that imports
 * it back). Which pages a command touches is decided in page-undo.ts and handed to the History as a `ScopeFn`.
 */
import type { Command } from "./history";

/**
 * A file or slide-table entry a step registers. The tables (files, slides) and the cover are shared by every page, so a step that ADDED an
 * entry is never undone out of order, and a step above one that registers is never redone past it (see `History.undoOnPage` / `redoOnPage`).
 */
export interface Registered {
	readonly kind: "asset" | "slide";
	readonly id: string;
	/** The step added it (it was not there already): undoing the step removes it. */
	adds(): boolean;
}

/** What a step touches. */
export interface StepScope {
	/** The ids of the pages the step names (empty for a step about the notebook itself). */
	readonly pages: ReadonlySet<string>;
	/** The step touches every page (a reorder of all of them). */
	readonly all: boolean;
	/**
	 * The step can be undone and redone on its own page, out of order: it names exactly one page, and nothing in it changes the page list or
	 * the notebook as a whole. False means "global".
	 */
	readonly local: boolean;
	/** The files and slide entries the step registers (a picture, ink linked to a slide). */
	readonly registers: readonly Registered[];
}

/** The scope of a step. */
export type ScopeFn = (cmd: Command) => StepScope;

/** What the History needs to undo out of order: which pages a step touches. */
export interface PageRules {
	scope: ScopeFn;
}

/** The step names this page (or every page). */
export function touchesPage(scope: StepScope, pageId: string): boolean {
	return scope.all || scope.pages.has(pageId);
}

/**
 * Does a step undone earlier (in the redo list) survive a new edit `fresh`? Only when both are about one page and not the same one: the new
 * edit cannot have changed what the undone step needs. Everything else is dropped, as an ordinary new edit drops the whole redo list.
 */
export function redoSurvives(undone: StepScope, fresh: StepScope): boolean {
	if (!undone.local || !fresh.local) return false;
	for (const id of fresh.pages) if (undone.pages.has(id)) return false;
	return true;
}

/** What Undo / Redo on one page did. */
export type PageStepResult =
	/** The newest step of the page was undone (or redone). */
	| { kind: "done"; cmd: Command }
	/** The page has no step to undo (or redo). */
	| { kind: "nothing" }
	/**
	 * The newest step of the page also touches other pages or the whole notebook, so it is not taken out of order. `why` "shared": it added a
	 * file or slide entry (undo), or an undone step that registers one sits above it (redo): the shared tables only change in order.
	 */
	| { kind: "global"; cmd: Command; why?: "shared" }
	/** The history refused the step (a locked page, a change the writer would reject, read-only mode): it said why itself. */
	| { kind: "refused" };
