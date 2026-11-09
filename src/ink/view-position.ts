import type { Layout } from "./layout";
import { fitPageViewport, type ScrollMode } from "./page-mode";
import { fitWidth, MAX_SCALE, MIN_SCALE, screenToPage, type Size, type Viewport } from "./viewport";

/**
 * Where the reader was (O16): the page, the zoom and the scroll position, in terms that survive a different view
 * size (rotation, another device, a resized pane). Kept in the workspace state and the plugin settings, never in
 * the notebook file.
 *
 * - `page`: 1-based.
 * - `zoom`: the scale relative to the fit-to-width scale (1 = the page fills the width).
 * - `x`, `y`: the point of that page (pt, page coordinates) shown at the top-left corner of the view.
 */
export interface SavedPosition {
	page: number;
	zoom: number;
	x: number;
	y: number;
}

/** A zoom this close to the fit-to-width scale counts as fitted (the view keeps re-fitting when it is resized). */
export const FIT_EPSILON = 0.01;

const ZOOM_MIN = MIN_SCALE / 40;
const ZOOM_MAX = MAX_SCALE * 40;
const COORD_LIMIT = 1e6;

/** The scale that fills the width, for this mode and page. */
export function fitScale(mode: ScrollMode, view: Size, layout: Layout, pageIndex: number): number {
	return mode === "pages" ? fitPageViewport(view, layout, pageIndex).scale : fitWidth(view, layout).scale;
}

/**
 * The scale a saved zoom is measured against (zoom 1). Review fix (S2): in a spread the fit of the whole pair is about half the fit of a
 * page, so a zoom measured against it came back about twice too big or small in a single column, and the reverse. Whatever the mode, the
 * zoom is measured against the page-wide fit (the widest page fills the width, as in a single column), so a position or a saved view
 * means the same page size on the screen in every mode. In the other modes this is `fitScale`.
 */
export function zoomBase(mode: ScrollMode, view: Size, layout: Layout, pageIndex: number): number {
	if (mode !== "spread") return fitScale(mode, view, layout, pageIndex);
	let widest = layout.boxes[0];
	for (const b of layout.boxes) if ((b.window?.width ?? b.width) > (widest?.window?.width ?? widest?.width ?? 0)) widest = b;
	return widest ? fitWidth(view, widest).scale : fitWidth(view, layout).scale;
}

/** Whether `scale` is the fit-to-width scale of the mode (the view keeps re-fitting when it is resized). */
export function isFitScale(scale: number, mode: ScrollMode, view: Size, layout: Layout, pageIndex: number): boolean {
	const fit = fitScale(mode, view, layout, pageIndex);
	return fit > 0 && Math.abs(scale / fit - 1) < FIT_EPSILON;
}

/**
 * Review fix (R1): the zoom to store for `scale`. A view at the mode's fit is stored as exactly 1, whatever the mode, so "fitted" survives a
 * switch between a spread and a single column (the format is the one of 0.26: zoom 1 = fitted, so an older record reads the same). Any
 * other scale is measured against the page-wide fit (`zoomBase`); where that lands within FIT_EPSILON of 1 (a spread zoomed in until one
 * page fills the width) it is nudged just outside, so it is not mistaken for the fit.
 */
export function zoomFor(scale: number, mode: ScrollMode, view: Size, layout: Layout, pageIndex: number): number {
	if (isFitScale(scale, mode, view, layout, pageIndex)) return 1;
	const z = scale / zoomBase(mode, view, layout, pageIndex);
	return Math.abs(z - 1) < FIT_EPSILON ? 1 + Math.sign(z - 1 || 1) * FIT_EPSILON * 1.5 : z;
}

/** The scale a stored zoom means in this mode, and whether it is the fit (zoom 1: the mode's own fit, which the view keeps re-fitting). */
export function scaleFor(zoom: number, mode: ScrollMode, view: Size, layout: Layout, pageIndex: number): { scale: number; fit: boolean } | null {
	const base = zoomBase(mode, view, layout, pageIndex);
	const fit = fitScale(mode, view, layout, pageIndex);
	if (!(base > 0) || !(fit > 0)) return null;
	const isFit = Math.abs(zoom - 1) < FIT_EPSILON;
	return { scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, isFit ? fit : zoom * base)), fit: isFit };
}

const round = (n: number, digits: number): number => {
	const k = 10 ** digits;
	return Math.round(n * k) / k;
};

/** The position of a viewport on page `pageIndex` (0-based), or null while there is nothing to measure. */
export function capturePosition(mode: ScrollMode, v: Viewport, view: Size, layout: Layout, pageIndex: number): SavedPosition | null {
	const box = layout.boxes[pageIndex];
	if (!box || view.width <= 0 || view.height <= 0 || !(v.scale > 0)) return null;
	if (!(zoomBase(mode, view, layout, pageIndex) > 0)) return null;
	const [dx, dy] = screenToPage(v, 0, 0);
	const pos = { page: pageIndex + 1, zoom: round(zoomFor(v.scale, mode, view, layout, pageIndex), 6), x: round(dx - box.x, 1), y: round(dy - box.y, 1) };
	return isFinitePosition(pos) ? pos : null;
}

export interface RestoredView {
	viewport: Viewport;
	/** The zoom is the fit-to-width one: keep re-fitting when the view changes size. */
	fit: boolean;
	/** 0-based, clamped to the pages that exist. */
	pageIndex: number;
}

/** The viewport that shows `pos` in a view of size `view` (the caller clamps it to the page). */
export function restoreViewport(pos: SavedPosition, mode: ScrollMode, view: Size, layout: Layout): RestoredView | null {
	if (layout.boxes.length === 0 || view.width <= 0 || view.height <= 0) return null;
	const pageIndex = Math.min(layout.boxes.length - 1, Math.max(0, pos.page - 1));
	const box = layout.boxes[pageIndex]!;
	const s = scaleFor(pos.zoom, mode, view, layout, pageIndex);
	if (!s) return null;
	const viewport = { scale: s.scale, offsetX: -(box.x + pos.x) * s.scale, offsetY: -(box.y + pos.y) * s.scale };
	return { viewport, fit: s.fit, pageIndex };
}

function isFinitePosition(p: SavedPosition): boolean {
	return Number.isInteger(p.page) && p.page >= 1
		&& Number.isFinite(p.zoom) && p.zoom >= ZOOM_MIN && p.zoom <= ZOOM_MAX
		&& Number.isFinite(p.x) && Math.abs(p.x) <= COORD_LIMIT
		&& Number.isFinite(p.y) && Math.abs(p.y) <= COORD_LIMIT;
}

/** Reads a saved position from untrusted data (workspace state, plugin settings). Anything wrong gives null. */
export function parsePosition(raw: unknown): SavedPosition | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const pos = { page: o.page as number, zoom: o.zoom as number, x: o.x as number, y: o.y as number };
	if ([pos.page, pos.zoom, pos.x, pos.y].some((n) => typeof n !== "number")) return null;
	return isFinitePosition(pos) ? pos : null;
}

/** The position in a view state (`{ page, view: { page, zoom, x, y } }`); it only applies to the page the state names. */
export function positionFromState(state: unknown): SavedPosition | null {
	if (typeof state !== "object" || state === null) return null;
	const s = state as { page?: unknown; view?: unknown };
	const pos = parsePosition(s.view);
	return pos && pos.page === s.page ? pos : null;
}

export function positionEquals(a: SavedPosition | null, b: SavedPosition | null): boolean {
	if (a === null || b === null) return a === b;
	return a.page === b.page && Math.abs(a.zoom - b.zoom) < 0.005 && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
}
