// Saved views (0.23, #264): the pure part of the dialog and the commands (no 'obsidian', no DOM), so Node tests can check it.
import { viewPageIndex, viewsOf } from "../model/views";
import type { NotebookDocument, SavedView } from "../model/types";

/** One line of the list as the dialog shows it. */
export interface ViewRow {
	id: string;
	name: string;
	/** 1-based page number now, or null when the notebook no longer has the page (the view is missing). */
	pageNumber: number | null;
	/** The saved zoom as a whole percent (100 = the page fills the width). */
	zoomPercent: number;
	missing: boolean;
}

/** The zoom as a whole percent. */
export function zoomPercent(zoom: number): number {
	return Math.max(1, Math.round(zoom * 100));
}

/** The list of views as rows, in list order; a view whose page is gone is a missing row. */
export function viewRows(doc: NotebookDocument): ViewRow[] {
	return viewsOf(doc).map((v) => {
		const index = viewPageIndex(doc, v);
		return { id: v.id, name: v.name, pageNumber: index >= 0 ? index + 1 : null, zoomPercent: zoomPercent(v.zoom), missing: index < 0 };
	});
}

/** Where a row can be moved: up needs a row above it, down a row below it. */
export function moveOptions(rows: readonly { id: string }[], id: string): { up: boolean; down: boolean } {
	const at = rows.findIndex((r) => r.id === id);
	return { up: at > 0, down: at >= 0 && at < rows.length - 1 };
}

/** The view with this id, or null. */
export function findView(doc: NotebookDocument, id: string): SavedView | null {
	return viewsOf(doc).find((v) => v.id === id) ?? null;
}
