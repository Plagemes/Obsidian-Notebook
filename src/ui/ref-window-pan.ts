// 0.20 reference window (#107): pan and zoom of the reference inside the window. The content is placed with one CSS transform
// while the fingers move (no drawing per frame); raster sources are drawn again only when a zoom has ended and the picture
// is too coarse, or when the window was resized. Pure numbers, no DOM.
import type { Size } from "./ref-window-geometry";

/** Zoom 1 shows the content fitted to the window's width. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
/** A raster picture is drawn again when the wanted detail is this many times its detail, or when it is this many times finer than needed. */
export const REDRAW_RATIO = 1.4;
/** The longest side of a drawn picture (px): keeps the memory of a tablet bounded. */
export const MAX_RASTER_SIDE = 2400;

export interface ContentView {
	scale: number;
	x: number;
	y: number;
}

export const FIT: ContentView = { scale: 1, x: 0, y: 0 };

/** The view with the zoom within limits and the content kept over the frame (centred along a side it does not fill). */
export function clampView(v: ContentView, content: Size, frame: Size): ContentView {
	const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(v.scale) ? v.scale : 1));
	const axis = (offset: number, c: number, f: number): number => {
		const span = c * scale;
		if (span <= f) return (f - span) / 2;
		return Math.min(0, Math.max(f - span, Number.isFinite(offset) ? offset : 0));
	};
	return { scale, x: axis(v.x, content.width, frame.width), y: axis(v.y, content.height, frame.height) };
}

/** Moves the content by (dx, dy). */
export function panView(v: ContentView, dx: number, dy: number, content: Size, frame: Size): ContentView {
	return clampView({ ...v, x: v.x + dx, y: v.y + dy }, content, frame);
}

/** Zooms by `factor` keeping the point (fx, fy) of the frame under the fingers. */
export function zoomView(v: ContentView, factor: number, fx: number, fy: number, content: Size, frame: Size): ContentView {
	const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1)));
	const k = scale / v.scale;
	return clampView({ scale, x: fx - (fx - v.x) * k, y: fy - (fy - v.y) * k }, content, frame);
}

/** The view after the content or the frame changed size: the zoom stays, the offset is fitted. */
export function refit(v: ContentView, content: Size, frame: Size): ContentView {
	return clampView(v, content, frame);
}

/** Width (device px) a raster source should be drawn at for this zoom, within the memory limit of a tablet. */
export function rasterWidth(frameWidth: number, scale: number, dpr: number, aspect: number): number {
	const wanted = Math.max(1, Math.round(frameWidth * scale * Math.max(1, dpr)));
	const side = Math.max(1, MAX_RASTER_SIDE / Math.max(1, aspect));
	return Math.min(wanted, Math.round(side));
}

/** Whether a picture drawn at `drawn` px wide should be drawn again to show `wanted` px: only when the difference is clear. */
export function shouldRedraw(drawn: number, wanted: number): boolean {
	if (drawn <= 0) return true;
	const ratio = wanted / drawn;
	return ratio >= REDRAW_RATIO || ratio <= 1 / (REDRAW_RATIO * REDRAW_RATIO);
}

/** Distance between two points, and the factor of a pinch from one distance to the next. */
export function pinchFactor(previous: number, current: number): number {
	return previous > 0 && current > 0 ? current / previous : 1;
}
