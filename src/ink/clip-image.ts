// 0.25 clipimage (#277): "Copy as image". Pure decisions for putting a picture of the written area (or the selection) on the system
// clipboard: how big it may be drawn, which background it gets, and which way out to try (image clipboard, share sheet, saved copy).
// No 'obsidian', no DOM: the view (src/view/copy-image.ts) draws and writes.

/** Scale asked for (pixels per pt multiplier): 2x, as the PNG export. */
export const CLIP_SCALE = 2;
/** Longest side of the picture, px: bigger ones are drawn smaller (chat apps and WebView clipboards refuse huge bitmaps). */
export const CLIP_MAX_SIDE = 4096;
/** Most pixels in the picture. */
export const CLIP_MAX_PIXELS = 12_000_000;
/** Scale never goes below this, whatever the size (a huge area is still copied, only smaller). */
export const CLIP_MIN_SCALE = 0.25;

export type ClipBackground = "white" | "transparent";
export const CLIP_BACKGROUNDS: readonly ClipBackground[] = ["white", "transparent"];

export function isClipBackground(v: unknown): v is ClipBackground {
	return v === "white" || v === "transparent";
}

/** The scale to draw a `width` x `height` pt area at: `CLIP_SCALE`, lowered until the picture fits the pixel limits. */
export function clipScale(width: number, height: number, wanted: number = CLIP_SCALE): { scale: number; capped: boolean } {
	const w = Math.max(1, Number.isFinite(width) ? width : 1);
	const h = Math.max(1, Number.isFinite(height) ? height : 1);
	let scale = Math.max(CLIP_MIN_SCALE, wanted);
	scale = Math.min(scale, CLIP_MAX_SIDE / Math.max(w, h), Math.sqrt(CLIP_MAX_PIXELS / (w * h)));
	scale = Math.max(CLIP_MIN_SCALE, scale);
	return { scale, capped: scale < wanted - 1e-9 };
}

/** The ways to hand the picture over, best first. */
export type ClipRoute = "clipboard" | "share" | "save";

export interface ClipCapabilities {
	/** `navigator.clipboard.write` with a `ClipboardItem` that takes image/png. */
	imageClipboard: boolean;
	/** The share sheet takes a PNG file. */
	shareFiles: boolean;
}

/**
 * The routes to try, in order: the image clipboard where the device has it, else the system share sheet with the PNG, and a saved
 * copy in the vault as the last resort (always possible, so the action never ends with nothing).
 */
export function clipRoutes(caps: ClipCapabilities): ClipRoute[] {
	const routes: ClipRoute[] = [];
	if (caps.imageClipboard) routes.push("clipboard");
	if (caps.shareFiles) routes.push("share");
	routes.push("save");
	return routes;
}

/** What to do after a route failed: the next one, or stop (the user closed the share sheet on purpose). */
export function afterFailure(routes: readonly ClipRoute[], failed: ClipRoute, cancelled: boolean): ClipRoute | null {
	if (cancelled) return null;
	const i = routes.indexOf(failed);
	return i >= 0 && i + 1 < routes.length ? routes[i + 1]! : null;
}

/** Whether the picture needs to be painted onto white (transparent PNGs show black in some apps). */
export function needsWhite(background: ClipBackground): boolean {
	return background === "white";
}
