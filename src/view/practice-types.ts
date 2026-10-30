import type { App, TFile } from "obsidian";
import type { Stroke, NotebookDocument } from "../model/types";
import type { EditContext } from "./edit-context";

/**
 * What the practice flows (view/practice*.ts, "Redo this exercise") may do with a notebook view. The view hands it out with
 * `practiceHost()`; this file holds only types so the view does not import the practice modules.
 */
export interface PracticeViewHost {
	readonly app: App;
	readonly file: TFile | null;
	/** Where the practice banner goes (the area around the page panel and the page). */
	readonly body: HTMLElement;
	doc(): NotebookDocument | null;
	/** Null unless the document is open, editable and no stroke is in progress. */
	editContext(): EditContext | null;
	currentPage(): number;
	/** Scrolls to the page (index in this document). */
	goToPage(index: number): void;
	/** The lasso selection, when there is one: the page it is on and its strokes. */
	selectedStrokes(): { pageIndex: number; strokes: readonly Stroke[] } | null;
	/** Draws `strokes` over page `pageIndex` until called with null. View only: never saved. */
	setPeek(pageIndex: number, strokes: readonly Stroke[] | null): void;
}

/** What the view calls (page changes, document loads) and what the commands call. One per open notebook view. */
export interface PracticeHooks {
	/** The page in view may have changed (called often: cheap when nothing did). */
	page(index: number): void;
	/** A document was loaded into the view. */
	loaded(): void;
	/** "Redo this exercise…" for the page at `index` (default: the one in view). */
	redo(index?: number): Promise<void>;
	goToOriginal(): Promise<void>;
	attempts(): Promise<void>;
	/** Command form of the peek (a hotkey cannot be held): switches the overlay on or off. */
	togglePeek(): void;
	toggleTimer(): void;
	destroy(): void;
}

/** Given to the view by the plugin (`NotebookHost.practice`). */
export interface PracticeProvider {
	attach(host: PracticeViewHost): PracticeHooks;
}
