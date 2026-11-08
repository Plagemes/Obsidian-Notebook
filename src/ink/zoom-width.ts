// 0.26 zoomwidth (#350): "Pen width follows zoom". The chosen width is what the stroke LOOKS like on screen; the page-unit width
// that is stored is the chosen width divided by the zoom. Pure: no obsidian import. Stored strokes stay plain page-unit widths.

/** Smallest and largest page-unit width a zoom-following stroke may get (so 8x zoom never writes hairlines nor 0.25x blobs). */
export const ZOOM_WIDTH_MIN = 0.1;
export const ZOOM_WIDTH_MAX = 48;
/** The highlighter is wider by nature. */
export const ZOOM_WIDTH_MAX_HIGHLIGHTER = 96;

/**
 * Page-unit width to store for a stroke that should look `chosen` wide on screen at `scale` (CSS px per page unit).
 * `follow = false` returns `chosen` unchanged (today's behaviour, byte identical).
 */
export function zoomedWidth(chosen: number, scale: number, follow: boolean, highlighter = false): number {
	if (!follow || !(chosen > 0) || !Number.isFinite(scale) || scale <= 0) return chosen;
	const w = chosen / scale;
	const max = highlighter ? ZOOM_WIDTH_MAX_HIGHLIGHTER : ZOOM_WIDTH_MAX;
	return Math.min(max, Math.max(ZOOM_WIDTH_MIN, w));
}

/** How wide a stored width looks on screen, CSS px. */
export function screenWidth(stored: number, scale: number): number {
	return stored * scale;
}

/** The on-screen width (px) that the pen options show: with the option on it is the chosen width (unless clamped), off it is chosen x zoom. */
export function effectiveScreenWidth(chosen: number, scale: number, follow: boolean, highlighter = false): number {
	return screenWidth(zoomedWidth(chosen, scale, follow, highlighter), scale);
}
