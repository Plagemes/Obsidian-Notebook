import type { App, TFile } from "obsidian";
import type { MeasureText } from "../ink/elements";
import type { Command } from "../model/history";
import type { Asset, NotebookDocument } from "../model/types";

/**
 * What a flow that lives outside the notebook view (board shot, new lecture, moving pages between notebooks)
 * may do to the open document. The view builds it with `editContext()`; it is only valid while the same editable
 * document is open (`alive()`), because every flow here is asynchronous (camera, dialogs, file writes).
 */
export interface EditContext {
	readonly app: App;
	/** Notebooks folder (the assets folder is `<folder>/_assets`). */
	readonly folder: string;
	readonly file: TFile | null;
	readonly doc: NotebookDocument;
	readonly measure: MeasureText;
	/** Same editable document still open and no stroke in progress. */
	alive(): boolean;
	/** Makes a stored asset readable before the command that adds it to the document runs. */
	addPending(asset: Asset): void;
	removePending(id: string): void;
	/** Index of the page in view. */
	currentPage(): number;
	/** Visible part of a page in the page's own coordinates (pt), or null when the page is not in view. */
	visibleLocal(pageIndex: number): { minY: number; maxY: number } | null;
	/** Runs a command as one undo step (ends text editing, clears the selection), optionally scrolling to a page. */
	execute(cmd: Command, scrollToPage?: number): void;
	/** Saves now. True only when nothing is left unsaved in memory. */
	flush(): Promise<boolean>;
}

/** A view that can hand out an `EditContext` (checked by shape so modules need not import the view). */
export interface EditContextSource {
	readonly file: TFile | null;
	editContext(): EditContext | null;
}

export function isEditContextSource(view: unknown): view is EditContextSource {
	return typeof view === "object" && view !== null && typeof (view as { editContext?: unknown }).editContext === "function";
}
