import type { Layout } from "./layout";
import type { ScrollMode } from "./page-mode";
import { FIT_EPSILON, fitScale, type RestoredView } from "./view-position";
import { MAX_SCALE, MIN_SCALE, screenToPage, type Size, type Viewport } from "./viewport";

/**
 * Saved views (0.23, #264): what is in view as a region of a page, and the way back. Pure geometry, no 'obsidian'.
 *
 * A region is the part of page `pageIndex` that the view shows: its top-left corner and size in page coordinates (pt), plus the zoom
 * relative to the fit-to-width scale of that page (1 = the page fills the width), so it means the same on any screen size. Recalling
 * puts the middle of the region in the middle of the view at that zoom: on the screen it was saved on it is exactly the saved view, on a
 * different screen it is the same part of the page, centred.
 */
export interface ViewRegion {
	/** 0-based page the middle of the view is on. */
	pageIndex: number;
	x: number;
	y: number;
	width: number;
	height: number;
	zoom: number;
}

/** The region in view now on page `pageIndex`, or null while there is nothing to measure. */
export function captureRegion(mode: ScrollMode, v: Viewport, view: Size, layout: Layout, pageIndex: number): ViewRegion | null {
	const box = layout.boxes[pageIndex];
	if (!box || view.width <= 0 || view.height <= 0 || !(v.scale > 0)) return null;
	const fit = fitScale(mode, view, layout, pageIndex);
	if (!(fit > 0)) return null;
	const [left, top] = screenToPage(v, 0, 0);
	const region = { pageIndex, x: left - box.x, y: top - box.y, width: view.width / v.scale, height: view.height / v.scale, zoom: v.scale / fit };
	return [region.x, region.y, region.width, region.height, region.zoom].every(Number.isFinite) ? region : null;
}

/** The viewport that shows `region` in a view of size `view` (the caller clamps it to the pages). Null while there is nothing to measure. */
export function restoreRegion(region: Omit<ViewRegion, "pageIndex">, pageIndex: number, mode: ScrollMode, view: Size, layout: Layout): RestoredView | null {
	const box = layout.boxes[pageIndex];
	if (!box || view.width <= 0 || view.height <= 0) return null;
	const fit = fitScale(mode, view, layout, pageIndex);
	if (!(fit > 0)) return null;
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, region.zoom * fit));
	const cx = box.x + region.x + region.width / 2;
	const cy = box.y + region.y + region.height / 2;
	return { viewport: { scale, offsetX: view.width / 2 - cx * scale, offsetY: view.height / 2 - cy * scale }, fit: Math.abs(region.zoom - 1) < FIT_EPSILON, pageIndex };
}
