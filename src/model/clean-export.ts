/**
 * Clean copy for exports (roadmap #239): the page as it is shared, without the study and working layers. Pure: no 'obsidian',
 * no DOM. No format change: the document is never touched, the function builds a filtered copy that the writers draw.
 *
 * Left out of a clean copy (each part can be switched off in the options):
 * - markers: gaps (placeholders), questions, importance badges and homework (`marker` elements, see markers.ts);
 * - margin comments (`page.comments`; the PDF notes strip is dropped by the caller, see `view/export.ts`);
 * - collapsed sticky notes, together with the ink they keep hidden (`withoutPinnedInk`: a removed note would otherwise show it);
 * - optionally the open sticky notes too (the note is left out, the ink written over it stays: it is ordinary page ink).
 *
 * Kept on purpose: structured boxes (definitions, theorems: they are content), text, pictures, equations, graphs, excerpts,
 * drawings with states, the paper and the background, the page header (a layout decoration the reader chose for exports), and
 * invisible ink, which still follows the one rule of every export (drawn only where the solutions are shown).
 * Tags, the lock and the other page fields are not drawn, so they are left alone.
 */
import { withoutPinnedInk } from "../ink/attach";
import type { Page, PageElement } from "./types";

export interface CleanExportOptions {
	/** Placeholders, questions, importance badges and homework markers. Default true. */
	markers?: boolean;
	/** Margin comments. Default true. */
	comments?: boolean;
	/** Collapsed sticky notes and the ink they hide. Default true. */
	collapsedStickies?: boolean;
	/** Open sticky notes. Default false (an open note is part of the page). */
	openStickies?: boolean;
}

export const DEFAULT_CLEAN_OPTIONS: Required<CleanExportOptions> = { markers: true, comments: true, collapsedStickies: true, openStickies: false };

/** The options with every missing choice at its default. */
export function resolveCleanOptions(options: CleanExportOptions = {}): Required<CleanExportOptions> {
	return {
		markers: options.markers ?? DEFAULT_CLEAN_OPTIONS.markers,
		comments: options.comments ?? DEFAULT_CLEAN_OPTIONS.comments,
		collapsedStickies: options.collapsedStickies ?? DEFAULT_CLEAN_OPTIONS.collapsedStickies,
		openStickies: options.openStickies ?? DEFAULT_CLEAN_OPTIONS.openStickies,
	};
}

/** Whether a clean copy of `page` would differ from it (what the export would leave out is there). */
export function hasCleanableContent(page: Page, options: CleanExportOptions = {}): boolean {
	const o = resolveCleanOptions(options);
	if (o.comments && (page.comments?.length ?? 0) > 0) return true;
	return (page.elements ?? []).some((el) => dropsElement(el, o));
}

function dropsElement(el: PageElement, o: Required<CleanExportOptions>): boolean {
	if (el.type === "marker") return o.markers;
	if (el.type === "sticky") return el.collapsed === true ? o.collapsedStickies : o.openStickies;
	return false;
}

/**
 * The page as a clean export draws it. Returns `page` itself when there is nothing to leave out (so a page without study
 * layers is drawn exactly as before); otherwise a shallow copy with new `elements` / `strokes` / `comments` where they changed.
 * Never mutates `page` or anything it holds.
 */
export function cleanPageForExport(page: Page, options: CleanExportOptions = {}): Page {
	const o = resolveCleanOptions(options);
	const elements = page.elements ?? [];
	const kept = elements.filter((el) => !dropsElement(el, o));
	const dropComments = o.comments && (page.comments?.length ?? 0) > 0;
	if (kept.length === elements.length && !dropComments) return page;
	const next: Page = { ...page };
	if (kept.length !== elements.length) {
		// The ink a collapsed note keeps hidden goes with the note: without it the strokes would be drawn once the note is gone.
		const hiddenByNotes = elements.filter((el) => el.type === "sticky" && el.collapsed === true && dropsElement(el, o));
		if (hiddenByNotes.length > 0) next.strokes = withoutPinnedInk(page.strokes, hiddenByNotes);
		if (kept.length > 0) next.elements = kept;
		else delete next.elements;
	}
	if (dropComments) delete next.comments;
	return next;
}

/** `cleanPageForExport` over a list; the pages keep their order and index (a page that needs nothing is the same object). */
export function cleanPagesForExport(pages: readonly Page[], options: CleanExportOptions = {}): Page[] {
	return pages.map((p) => cleanPageForExport(p, options));
}
