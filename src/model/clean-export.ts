/**
 * Clean copy for exports (roadmap #239): the page as it is shared, without the study and working layers. Pure: no 'obsidian',
 * no DOM. No format change: the document is never touched, the function builds a filtered copy that the writers draw.
 *
 * Left out of a clean copy (each part can be switched off in the options):
 * - markers: gaps (placeholders), questions, importance badges and homework (`marker` elements, see markers.ts);
 * - margin comments (`page.comments`; the PDF notes strip is dropped by the caller, see `view/export.ts`);
 * - collapsed sticky notes, together with the ink they keep hidden (`withoutPinnedInk`: a removed note would otherwise show it);
 * - optionally the open sticky notes too (the note is left out, the ink written over it stays: it is ordinary page ink);
 * - v27 study tapes (#10): a clean copy shows what the tapes cover (every other export draws them hidden, the way a notebook opens).
 *
 * Kept on purpose: structured boxes (definitions, theorems: they are content), text, pictures, equations, graphs, excerpts,
 * drawings with states, the paper and the background, the page header (a layout decoration the reader chose for exports), and
 * invisible ink, which still follows the one rule of every export (drawn only where the solutions are shown).
 * Tags, the lock and the other page fields are not drawn, so they are left alone.
 */
import { withoutPinnedInk } from "../ink/attach";
import { struckInk } from "../ink/strikethrough";
import { pageCopy } from "./states";
import type { Page, PageElement, Stroke } from "./types";

/**
 * Round-2 review (H2): the ink of the page before a clean copy left any of it out (struck words, the ink of a collapsed note), kept on the copy
 * under a symbol (never saved, never drawn). The redaction decides on it what a box covers that is not drawn as ink: the typed label of a
 * checkbox goes when a box touches its handwritten label (ink/redact.ts, P13), also when that handwriting was struck out and left out of the copy.
 */
const SOURCE_INK = Symbol("notebook.sourceInk");
type Cleaned = Page & { [SOURCE_INK]?: readonly Stroke[] };

/** The ink of `page` as it was before any clean copy left strokes out (`page.strokes` for a page that is not such a copy). */
export function sourceInk(page: Page): readonly Stroke[] {
	return (page as Cleaned)[SOURCE_INK] ?? page.strokes;
}

export interface CleanExportOptions {
	/** Placeholders, questions, importance badges and homework markers. Default true. */
	markers?: boolean;
	/** Margin comments. Default true. */
	comments?: boolean;
	/** Collapsed sticky notes and the ink they hide. Default true. */
	collapsedStickies?: boolean;
	/** Open sticky notes. Default false (an open note is part of the page). */
	openStickies?: boolean;
	/** v27 (#10): study tapes. Default true (a clean copy shows what they cover). */
	tapes?: boolean;
	/**
	 * 0.29 (#96): handwritten words that are struck through, with the lines that strike them (derived from the geometry of the ink,
	 * see `ink/strikethrough.ts`; nothing is stored). Default false: a struck word stays in the copy, struck through, as on the page.
	 */
	struck?: boolean;
}

export const DEFAULT_CLEAN_OPTIONS: Required<CleanExportOptions> = { markers: true, comments: true, collapsedStickies: true, openStickies: false, tapes: true, struck: false };

/** v27 (#10): only the study tapes left out, nothing else (the hand-in PDF: what is handed in is the work, not the study layer). */
export const TAPES_ONLY: CleanExportOptions = { markers: false, comments: false, collapsedStickies: false, openStickies: false, tapes: true, struck: false };

/**
 * 0.29 (#96): only the struck words left out, nothing of the study layers: the study tapes stay too, as every export draws them (round-2
 * review H3: the same filter for every writer, the export dialog and the share sheet included).
 */
export const STRUCK_ONLY: CleanExportOptions = { markers: false, comments: false, collapsedStickies: false, openStickies: false, tapes: false, struck: true };

/** The options with every missing choice at its default. */
export function resolveCleanOptions(options: CleanExportOptions = {}): Required<CleanExportOptions> {
	return {
		markers: options.markers ?? DEFAULT_CLEAN_OPTIONS.markers,
		comments: options.comments ?? DEFAULT_CLEAN_OPTIONS.comments,
		collapsedStickies: options.collapsedStickies ?? DEFAULT_CLEAN_OPTIONS.collapsedStickies,
		openStickies: options.openStickies ?? DEFAULT_CLEAN_OPTIONS.openStickies,
		tapes: options.tapes ?? DEFAULT_CLEAN_OPTIONS.tapes,
		struck: options.struck ?? DEFAULT_CLEAN_OPTIONS.struck,
	};
}

/** Whether a clean copy of `page` would differ from it (what the export would leave out is there). */
export function hasCleanableContent(page: Page, options: CleanExportOptions = {}): boolean {
	const o = resolveCleanOptions(options);
	if (o.comments && (page.comments?.length ?? 0) > 0) return true;
	if ((page.elements ?? []).some((el) => dropsElement(el, o))) return true;
	return o.struck && struckInk(page.strokes).size > 0;
}

function dropsElement(el: PageElement, o: Required<CleanExportOptions>): boolean {
	if (el.type === "marker") return o.markers;
	if (el.type === "sticky") return el.collapsed === true ? o.collapsedStickies : o.openStickies;
	if (el.type === "tape") return o.tapes;
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
	// 0.29 (#96): the struck words are found in the ink as it is on the page (the strikes are ink too), then left out of the copy.
	const struck = o.struck ? struckInk(page.strokes) : null;
	const dropStruck = struck !== null && struck.size > 0;
	if (kept.length === elements.length && !dropComments && !dropStruck) return page;
	// A live view of a page with states keeps its id, size and background only through its prototype: `pageCopy` keeps them.
	const next: Page = pageCopy(page);
	if (kept.length !== elements.length) {
		// The ink a collapsed note keeps hidden goes with the note: without it the strokes would be drawn once the note is gone.
		const hiddenByNotes = elements.filter((el) => el.type === "sticky" && el.collapsed === true && dropsElement(el, o));
		if (hiddenByNotes.length > 0) next.strokes = withoutPinnedInk(page.strokes, hiddenByNotes);
		if (kept.length > 0) next.elements = kept;
		else delete next.elements;
	}
	if (struck && dropStruck) next.strokes = next.strokes.filter((s) => !struck.has(s.id));
	if (dropComments) delete next.comments;
	if (next.strokes !== page.strokes) (next as Cleaned)[SOURCE_INK] = sourceInk(page);
	return next;
}

/** `cleanPageForExport` over a list; the pages keep their order and index (a page that needs nothing is the same object). */
export function cleanPagesForExport(pages: readonly Page[], options: CleanExportOptions = {}): Page[] {
	return pages.map((p) => cleanPageForExport(p, options));
}
