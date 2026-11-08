// The maths of a cover picture (0.22 covers): which part of a source image (a photo, a page of the notebook) a portrait card
// shows, and how a drag or a zoom moves it. Pure logic: no Obsidian, no DOM, so it is tested in Node.

/** A cover card is 3:4 (width : height); the baked picture is `COVER_PX` pixels. */
export const COVER_ASPECT = 3 / 4;
export const COVER_PX = { w: 540, h: 720 } as const;
/** The largest side an image is kept at while it is cropped (a 12 MP photo would cost ~48 MB as a canvas on Android). */
export const COVER_SOURCE_MAX = 1600;
export const COVER_ZOOM_MAX = 6;

/**
 * Which part of the source is shown: the centre as a fraction of the source (0..1 on each axis) and the zoom (1 = the
 * biggest 3:4 window the source has, 2 = half of it on each side, ...).
 */
export interface Crop {
	cx: number;
	cy: number;
	zoom: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The crop that shows the middle of the source at zoom 1. */
export function centeredCrop(): Crop {
	return { cx: 0.5, cy: 0.5, zoom: 1 };
}

/** The biggest window of shape `aspect` (w / h) inside a `srcW` x `srcH` source. */
export function baseWindow(srcW: number, srcH: number, aspect: number = COVER_ASPECT): { w: number; h: number } {
	if (!(srcW > 0) || !(srcH > 0) || !(aspect > 0)) return { w: 0, h: 0 };
	return srcW / srcH > aspect ? { w: srcH * aspect, h: srcH } : { w: srcW, h: srcW / aspect };
}

/** The window (in source pixels) a crop shows; always inside the source, always of shape `aspect`. */
export function cropWindow(srcW: number, srcH: number, crop: Crop, aspect: number = COVER_ASPECT): Rect {
	const base = baseWindow(srcW, srcH, aspect);
	if (base.w === 0) return { x: 0, y: 0, w: 0, h: 0 };
	const zoom = clamp(finite(crop.zoom, 1), 1, COVER_ZOOM_MAX);
	const w = base.w / zoom;
	const h = base.h / zoom;
	const x = clamp(finite(crop.cx, 0.5) * srcW - w / 2, 0, srcW - w);
	const y = clamp(finite(crop.cy, 0.5) * srcH - h / 2, 0, srcH - h);
	return { x, y, w, h };
}

/** The same crop with the zoom and the centre brought into range (so that the window stays inside the source). */
export function clampCrop(srcW: number, srcH: number, crop: Crop, aspect: number = COVER_ASPECT): Crop {
	const r = cropWindow(srcW, srcH, crop, aspect);
	if (r.w === 0) return centeredCrop();
	return { cx: (r.x + r.w / 2) / srcW, cy: (r.y + r.h / 2) / srcH, zoom: clamp(finite(crop.zoom, 1), 1, COVER_ZOOM_MAX) };
}

/**
 * Drags the picture: the finger moved `dx`, `dy` pixels over a frame `frameW` pixels wide. The picture follows the finger, so the
 * window moves the other way.
 */
export function panCrop(srcW: number, srcH: number, crop: Crop, dx: number, dy: number, frameW: number, aspect: number = COVER_ASPECT): Crop {
	if (!(frameW > 0)) return clampCrop(srcW, srcH, crop, aspect);
	const win = cropWindow(srcW, srcH, crop, aspect);
	const k = win.w / frameW;
	const x = win.x - dx * k;
	const y = win.y - dy * k;
	return clampCrop(srcW, srcH, { cx: (x + win.w / 2) / srcW, cy: (y + win.h / 2) / srcH, zoom: crop.zoom }, aspect);
}

/**
 * Changes the zoom to `zoom`, keeping the source point under the frame position (`fx`, `fy`: 0..1 of the frame) where it is
 * (a pinch or a wheel turn), or the centre when no position is given.
 */
export function zoomCrop(srcW: number, srcH: number, crop: Crop, zoom: number, fx = 0.5, fy = 0.5, aspect: number = COVER_ASPECT): Crop {
	const before = cropWindow(srcW, srcH, crop, aspect);
	const next = clamp(finite(zoom, crop.zoom), 1, COVER_ZOOM_MAX);
	const base = baseWindow(srcW, srcH, aspect);
	if (before.w === 0) return centeredCrop();
	const w = base.w / next;
	const h = base.h / next;
	const px = before.x + before.w * clamp(fx, 0, 1);
	const py = before.y + before.h * clamp(fy, 0, 1);
	const x = px - w * clamp(fx, 0, 1);
	const y = py - h * clamp(fy, 0, 1);
	return clampCrop(srcW, srcH, { cx: (x + w / 2) / srcW, cy: (y + h / 2) / srcH, zoom: next }, aspect);
}

/** The size of a `w` x `h` picture scaled down (never up) so that its longest side is at most `max`. */
export function downscaleSize(w: number, h: number, max: number = COVER_SOURCE_MAX): { w: number; h: number; scaled: boolean } {
	if (!(w > 0) || !(h > 0)) return { w: 0, h: 0, scaled: false };
	const k = Math.min(1, max / Math.max(w, h));
	if (k >= 1) return { w: Math.round(w), h: Math.round(h), scaled: false };
	return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}
