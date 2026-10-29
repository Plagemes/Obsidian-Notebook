/**
 * Transform between screen coordinates (CSS px relative to the canvas) and page coordinates (pt):
 *   screen = page * scale + offset
 */
export interface Viewport {
	/** CSS px per pt */
	scale: number;
	offsetX: number;
	offsetY: number;
}

export interface Size {
	width: number;
	height: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
/** Margin around the page in CSS px. */
export const PAGE_MARGIN = 16;

export function screenToPage(v: Viewport, x: number, y: number): [number, number] {
	return [(x - v.offsetX) / v.scale, (y - v.offsetY) / v.scale];
}

export function pageToScreen(v: Viewport, x: number, y: number): [number, number] {
	return [x * v.scale + v.offsetX, y * v.scale + v.offsetY];
}

/** Page as wide as the view (minus margins), aligned to the top. */
export function fitWidth(view: Size, page: Size, margin = PAGE_MARGIN): Viewport {
	const usable = Math.max(1, view.width - 2 * margin);
	const scale = clamp(usable / page.width, MIN_SCALE, MAX_SCALE);
	return { scale, offsetX: (view.width - page.width * scale) / 2, offsetY: margin };
}

/** Zoom by `factor` keeping the screen point (fx, fy) still. */
export function zoomAt(v: Viewport, factor: number, fx: number, fy: number): Viewport {
	const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
	const k = scale / v.scale;
	return { scale, offsetX: fx - (fx - v.offsetX) * k, offsetY: fy - (fy - v.offsetY) * k };
}

export function pan(v: Viewport, dx: number, dy: number): Viewport {
	return { ...v, offsetX: v.offsetX + dx, offsetY: v.offsetY + dy };
}

/**
 * Keeps the page from getting lost outside the view: a page narrower than the view stays
 * centred, otherwise its edges cannot move in past the margin.
 */
export function clampToPage(v: Viewport, view: Size, page: Size, margin = PAGE_MARGIN): Viewport {
	const w = page.width * v.scale;
	const h = page.height * v.scale;
	const axis = (offset: number, content: number, viewLen: number) => {
		if (content + 2 * margin <= viewLen) return (viewLen - content) / 2;
		return clamp(offset, viewLen - content - margin, margin);
	};
	const offsetX = axis(v.offsetX, w, view.width);
	// Vertically, a short page stays at the top instead of being centred.
	const offsetY = h + 2 * margin <= view.height ? margin : clamp(v.offsetY, view.height - h - margin, margin);
	return { scale: v.scale, offsetX, offsetY };
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}
