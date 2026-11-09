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
	/** The view is at the fit of the mode it was saved in (zoom 1): shown as "Fit", not as a percentage. */
	fit: boolean;
	missing: boolean;
}

/**
 * The zoom as a whole percent of the page-wide fit. A zoom that is a hair above 1 is how a spread zoomed to one page wide is stored (it must
 * not be taken for the fit, see ink/view-position.ts `zoomFor`): shown as 100 %.
 */
export function zoomPercent(zoom: number): number {
	if (zoom >= 1 && zoom < 1.02) return 100;
	return Math.max(1, Math.round(zoom * 100));
}

/**
 * Review fix (T4): a view at the fit is stored as zoom 1 in every mode, which means a different size in a spread (the fit of the pair, about
 * half a page) and in a column (a page), so it is shown as "Fit" and never as 100 %, which would be bigger than a "60 %" view next to it.
 */
export function zoomIsFit(zoom: number): boolean {
	return Math.abs(zoom - 1) < 0.01;
}

/** The list of views as rows, in list order; a view whose page is gone is a missing row. */
export function viewRows(doc: NotebookDocument): ViewRow[] {
	return viewsOf(doc).map((v) => {
		const index = viewPageIndex(doc, v);
		return { id: v.id, name: v.name, pageNumber: index >= 0 ? index + 1 : null, zoomPercent: zoomPercent(v.zoom), fit: zoomIsFit(v.zoom), missing: index < 0 };
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
