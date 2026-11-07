/**
 * "Back to the current slide" (0.21, roadmap #225), the pure part: during a lecture the user may look at an earlier page or
 * scroll ahead; a small pill then offers the way back to where they last wrote. No 'obsidian', no DOM, no document change.
 *
 * - The anchor is the spot of the last stroke written while the lecture mode was on, or beside a linked slide (#226).
 * - The pill shows when that spot is out of view by at least half a screen, stays until the spot is in view again (so a
 *   small scroll back and forth at the edge does not make it flicker) and can be dismissed until the user is back.
 */
import { strokeBounds } from "../ink/hit-test";
import type { NotebookDocument, Page, Stroke } from "./types";

/** A vertical range in document coordinates. */
export interface YRange {
	top: number;
	bottom: number;
}

/** The place the user last wrote: the page and the stroke's vertical extent in page coordinates. */
export interface BackAnchor {
	pageId: string;
	top: number;
	bottom: number;
	/** 1-based slide number when the page (or the ink written there) belongs to a slide, else null. */
	slide: number | null;
}

/** The anchor must be out of view by at least this many screens (of the view height) for the pill to appear. */
export const AWAY_SCREENS = 0.5;

/** Where on the screen the written spot is put when going back: this fraction of the view height from the top. */
export const RETURN_AT = 0.6;

/** Quiet time after the last scroll before the pill is reconsidered, ms. */
export const IDLE_MS = 220;

/** How far two ranges are apart, in screens (view heights); 0 when they overlap or touch. */
export function gapScreens(spot: YRange, view: YRange): number {
	const h = view.bottom - view.top;
	if (!(h > 0)) return 0;
	if (spot.bottom < view.top) return (view.top - spot.bottom) / h;
	if (spot.top > view.bottom) return (spot.top - view.bottom) / h;
	return 0;
}

export interface ShowInput {
	enabled: boolean;
	/** The anchor spot in document coordinates, or null when nothing was written yet. */
	spot: YRange | null;
	view: YRange;
	/** The pill is on screen now. */
	shown: boolean;
	/** The user closed the pill and has not been back since. */
	dismissed: boolean;
}

/** Whether the pill is shown (see the module comment). */
export function shouldShowBack(i: ShowInput): boolean {
	if (!i.enabled || !i.spot || i.dismissed) return false;
	const gap = gapScreens(i.spot, i.view);
	if (gap <= 0) return false;
	return i.shown || gap >= AWAY_SCREENS;
}

/** True once the anchor is in view again: the dismissal is over (the pill may come back next time the user leaves). */
export function isBackInView(spot: YRange | null, view: YRange): boolean {
	return !spot || gapScreens(spot, view) <= 0;
}

/** Page y to put at the top of the view so the written spot lands at `RETURN_AT` of the height; 0 when the page fits. */
export function returnY(anchor: Pick<BackAnchor, "bottom">, pageHeight: number, viewHeight: number): number {
	if (!(viewHeight > 0) || pageHeight <= viewHeight) return 0;
	const y = anchor.bottom - viewHeight * RETURN_AT;
	return Math.max(0, Math.min(y, pageHeight - viewHeight));
}

/** Whether a stroke counts for the anchor: any ink during the lecture mode, or ink written beside a linked slide. */
export function tracksWrite(lectureOn: boolean, stroke: Pick<Stroke, "slide">): boolean {
	return lectureOn || stroke.slide !== undefined;
}

/** The 1-based slide number of a stroke on a page: the slide it was written beside, else the page's own PDF page. */
export function slideNumberOf(doc: Pick<NotebookDocument, "slides">, page: Pick<Page, "background">, stroke: Pick<Stroke, "slide">): number | null {
	if (stroke.slide !== undefined) {
		const ref = doc.slides?.find((r) => r.id === stroke.slide);
		if (ref && Number.isInteger(ref.page) && ref.page >= 1) return ref.page;
	}
	const bg = page.background;
	if (bg && bg.kind === "pdf" && Number.isInteger(bg.page) && bg.page >= 1) return bg.page;
	return null;
}

/** The anchor for the newest of `ids` on this page, or null when none of them is there. */
export function anchorFor(doc: NotebookDocument, page: Page, ids: ReadonlySet<string>, lectureOn: boolean): BackAnchor | null {
	for (let i = page.strokes.length - 1; i >= 0; i--) {
		const s = page.strokes[i]!;
		if (!ids.has(s.id)) continue;
		if (!tracksWrite(lectureOn, s)) return null;
		const b = strokeBounds(s);
		if (!Number.isFinite(b.minY) || !Number.isFinite(b.maxY)) return null;
		return { pageId: page.id, top: b.minY, bottom: b.maxY, slide: slideNumberOf(doc, page, s) };
	}
	return null;
}
