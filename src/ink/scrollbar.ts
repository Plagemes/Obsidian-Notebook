/**
 * Fast scrollbar (roadmap 50): the geometry of a draggable thumb along the page edge in continuous scroll. Pure: no
 * DOM, no 'obsidian'. The thumb's position is the vertical scroll position as a fraction of the scroll range, so
 * dragging it is the same as panning and touches nothing in the document.
 */
import { nearestPage, type Layout } from "./layout";
import { PAGE_MARGIN, screenToPage, type Size, type Viewport } from "./viewport";

/** The thumb is never shorter than this (CSS px), so a long notebook still leaves something to grab. */
export const MIN_THUMB_PX = 44;

export interface ScrollMetrics {
	/** The document is taller than the view, so there is something to scroll. */
	scrollable: boolean;
	/** Scroll position, 0 (top) to 1 (bottom). */
	position: number;
	/** The share of the document the view shows, 0 to 1 (the thumb's size relative to its track). */
	size: number;
}

/** The vertical scroll range (CSS px of `viewport.offsetY`) as `clampToPage` allows it; null when the document fits. */
function range(layout: Layout, scale: number, view: Size, margin: number): { top: number; bottom: number } | null {
	const content = layout.height * scale;
	if (!(content > 0) || content + 2 * margin <= view.height) return null;
	return { top: margin, bottom: view.height - content - margin };
}

export function scrollMetrics(layout: Layout, viewport: Viewport, view: Size, margin = PAGE_MARGIN): ScrollMetrics {
	const r = range(layout, viewport.scale, view, margin);
	if (!r) return { scrollable: false, position: 0, size: 1 };
	const span = r.top - r.bottom;
	const position = Math.min(1, Math.max(0, (r.top - viewport.offsetY) / span));
	const size = Math.min(1, view.height / (layout.height * viewport.scale + 2 * margin));
	return { scrollable: true, position, size };
}

export interface ThumbBox {
	/** Distance from the top of the track (CSS px). */
	top: number;
	/** Length of the thumb (CSS px). */
	length: number;
}

/** Where the thumb sits in a track `track` CSS px long. */
export function thumbBox(m: ScrollMetrics, track: number, minLength = MIN_THUMB_PX): ThumbBox {
	if (!(track > 0)) return { top: 0, length: 0 };
	const length = Math.min(track, Math.max(minLength, m.size * track));
	return { top: m.position * (track - length), length };
}

/**
 * The scroll position (0 to 1) that puts the thumb's grabbed point under the pointer. `pointerY` is relative to the
 * track, `grab` the distance from the thumb's top to where it was grabbed.
 */
export function positionAtPointer(pointerY: number, grab: number, track: number, thumbLength: number): number {
	const free = track - thumbLength;
	if (!(free > 0)) return 0;
	return Math.min(1, Math.max(0, (pointerY - grab) / free));
}

/** The `offsetY` of the viewport for a scroll position (0 to 1); null when the document does not scroll. */
export function offsetForPosition(position: number, layout: Layout, scale: number, view: Size, margin = PAGE_MARGIN): number | null {
	const r = range(layout, scale, view, margin);
	if (!r) return null;
	const p = Math.min(1, Math.max(0, position));
	return r.top - p * (r.top - r.bottom);
}

/** The page in the middle of the view for a given `offsetY`: the page the page indicator shows (and the bubble). */
export function pageAtOffset(layout: Layout, viewport: Viewport, view: Size, offsetY: number): number {
	const [, y] = screenToPage({ ...viewport, offsetY }, view.width / 2, view.height / 2);
	return Math.max(0, nearestPage(layout, y));
}
