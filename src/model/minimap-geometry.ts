/**
 * Geometry of the minimap (0.17, roadmap #173): a small overview of the page in view with the rectangle the view shows,
 * tap or drag to pan. Pure: no 'obsidian' import, no DOM (tested in Node). Nothing here touches the document or its format.
 *
 * Coordinates: "page" = pt inside the page; the layout box places the page in document space; the viewport maps document
 * space to the view (`screen = document * scale + offset`); the map is the page scaled by `MapSize.scale` (map px per pt).
 */

export type MinimapMode = "auto" | "always" | "never";
export const MINIMAP_MODES: readonly MinimapMode[] = ["auto", "always", "never"];

export function isMinimapMode(v: unknown): v is MinimapMode {
	return v === "auto" || v === "always" || v === "never";
}

export type MinimapCorner = "tl" | "tr" | "bl" | "br";

export function isMinimapCorner(v: unknown): v is MinimapCorner {
	return v === "tl" || v === "tr" || v === "bl" || v === "br";
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface MapSize {
	width: number;
	height: number;
	/** Map px per pt of page. */
	scale: number;
}

interface Vp {
	scale: number;
	offsetX: number;
	offsetY: number;
}

interface Dim {
	width: number;
	height: number;
}

interface Placed extends Dim {
	x: number;
	y: number;
}

/** The map is at most this many CSS px wide and tall. */
export const MAP_MAX_W = 168;
export const MAP_MAX_H = 232;
/** In "auto" the map shows when the view is zoomed in this much beyond fitting the page width. */
export const AUTO_ZOOM_FACTOR = 1.75;
/** Fewest ms between two renderings of the map's picture. */
export const MAP_REFRESH_MS = 1200;

/** The map of a page: it fits the box `maxW × maxH` with the page's proportions (never below 1 px). */
export function mapSize(page: Dim, maxW = MAP_MAX_W, maxH = MAP_MAX_H): MapSize {
	if (!(page.width > 0) || !(page.height > 0)) return { width: 1, height: 1, scale: 1 };
	const scale = Math.min(maxW / page.width, maxH / page.height);
	return { width: Math.max(1, Math.round(page.width * scale)), height: Math.max(1, Math.round(page.height * scale)), scale };
}

/** The part of the page the view shows, in page pt (not clipped to the page: it may extend past it). */
export function visibleInPage(vp: Vp, view: Dim, box: Placed): Rect {
	const s = vp.scale > 0 ? vp.scale : 1;
	return {
		x: -vp.offsetX / s - box.x,
		y: -vp.offsetY / s - box.y,
		width: view.width / s,
		height: view.height / s,
	};
}

/** The view's rectangle on the map in map px, clipped to the map (zero size when the view shows none of the page). */
export function viewRectOnMap(vp: Vp, view: Dim, box: Placed, map: MapSize): Rect {
	const v = visibleInPage(vp, view, box);
	const x0 = clamp(v.x * map.scale, 0, map.width);
	const y0 = clamp(v.y * map.scale, 0, map.height);
	const x1 = clamp((v.x + v.width) * map.scale, 0, map.width);
	const y1 = clamp((v.y + v.height) * map.scale, 0, map.height);
	return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Whether the view shows the whole page (nothing to pan to). */
export function wholePageVisible(vp: Vp, view: Dim, box: Placed): boolean {
	const v = visibleInPage(vp, view, box);
	const eps = 0.5;
	return v.x <= eps && v.y <= eps && v.x + v.width >= box.width - eps && v.y + v.height >= box.height - eps;
}

/**
 * The viewport that centres the view on the map point (mx, my) (map px; clamped to the map), same zoom. The caller
 * passes it through the view's own clamp, so the page cannot be lost.
 */
export function viewportCentredOn(vp: Vp, view: Dim, box: Placed, map: MapSize, mx: number, my: number): Vp {
	const px = clamp(mx, 0, map.width) / map.scale;
	const py = clamp(my, 0, map.height) / map.scale;
	return {
		scale: vp.scale,
		offsetX: view.width / 2 - (box.x + px) * vp.scale,
		offsetY: view.height / 2 - (box.y + py) * vp.scale,
	};
}

export interface ShowInput {
	mode: MinimapMode;
	/** The page in view is an infinite page. */
	infinite: boolean;
	/** Zoom of the view (CSS px per pt). */
	scale: number;
	/** Zoom that fits the page width to the view. */
	fitScale: number;
	/** The view shows the whole page. */
	whole: boolean;
}

/**
 * Whether the map is shown. never: no; always: yes; auto: on an infinite page, or when zoomed in beyond the threshold,
 * and only while the view does not already show the whole page (then there is nothing to navigate).
 */
export function shouldShowMinimap(i: ShowInput): boolean {
	if (i.mode === "never") return false;
	if (i.mode === "always") return true;
	if (i.whole) return false;
	return i.infinite || (i.fitScale > 0 && i.scale >= i.fitScale * AUTO_ZOOM_FACTOR);
}

/** Zoom that fits a page of this width to a view of this width (matches `fitWidth` without clamping). */
export function fitScaleFor(viewWidth: number, pageWidth: number, margin: number): number {
	return pageWidth > 0 ? Math.max(1, viewWidth - 2 * margin) / pageWidth : 1;
}

/** The corner nearest to the point (x, y) of a container: where a dragged map settles. */
export function nearestCorner(x: number, y: number, container: Dim): MinimapCorner {
	const right = x > container.width / 2;
	const bottom = y > container.height / 2;
	return bottom ? (right ? "br" : "bl") : right ? "tr" : "tl";
}

/** Milliseconds to wait before the map's picture may be drawn again (0: now). */
export function refreshDelay(lastAt: number, now: number, gap = MAP_REFRESH_MS): number {
	if (!Number.isFinite(lastAt)) return 0;
	return Math.max(0, lastAt + gap - now);
}

export interface MinimapPrefs {
	corner: MinimapCorner;
	collapsed: boolean;
}

export const DEFAULT_MINIMAP_PREFS: MinimapPrefs = { corner: "br", collapsed: false };

/** Whatever was stored as valid preferences (a corrupt value is the default). */
export function normaliseMinimapPrefs(data: unknown): MinimapPrefs {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { ...DEFAULT_MINIMAP_PREFS };
	const d = data as Record<string, unknown>;
	return {
		corner: isMinimapCorner(d.corner) ? d.corner : DEFAULT_MINIMAP_PREFS.corner,
		collapsed: d.collapsed === true,
	};
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}
