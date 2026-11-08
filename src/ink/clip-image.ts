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

/** Why a route failed, as far as the next step is concerned: the user closed the share sheet, the browser wants a fresh tap, or anything else. */
export type ClipFailure = "cancelled" | "needs-tap" | "other";

/** The one notice an outcome gets: nothing was copied on purpose, a new tap is needed, the next way is being tried, or nothing worked. */
export type ClipNotice = "cancelled" | "needsTap" | "fallback" | "failed";

/**
 * What to do after a route failed: the next one to try (null: stop) and the one notice to show. A share that came too long after the tap
 * (`needs-tap`) is not a reason to save a file the user did not ask for: it stops and asks for a new tap. A closed sheet stops too.
 */
export function afterFailure(routes: readonly ClipRoute[], failed: ClipRoute, failure: ClipFailure): { route: ClipRoute | null; notice: ClipNotice } {
	if (failure === "cancelled") return { route: null, notice: "cancelled" };
	if (failure === "needs-tap") return { route: null, notice: "needsTap" };
	const i = routes.indexOf(failed);
	const next = i >= 0 && i + 1 < routes.length ? routes[i + 1]! : null;
	return next ? { route: next, notice: "fallback" } : { route: null, notice: "failed" };
}

/** Whether the picture needs to be painted onto white (transparent PNGs show black in some apps). */
export function needsWhite(background: ClipBackground): boolean {
	return background === "white";
}

/** How a classified share error counts for the next step (`classifyShareError`): only a closed sheet and a missing tap are special. */
export function failureOf(outcome: "cancelled" | "needs-tap" | "unsupported" | "failed"): ClipFailure {
	return outcome === "cancelled" ? "cancelled" : outcome === "needs-tap" ? "needs-tap" : "other";
}

/** How long a picture drawn for a share that asked for a new tap is kept for that tap (ms). */
export const CLIP_RETRY_MS = 60_000;

/**
 * A share that needs a new tap is answered once with a notice; the picture is kept so the next tap shares at once, inside the tap, instead of
 * drawing again for as long as the browser's window lasts. If the share still needs a tap with the picture ready, asking again would never end:
 * it counts as an ordinary failure and the next route (the saved copy) is tried.
 */
export function failureOnRetry(failure: ClipFailure, retried: boolean): ClipFailure {
	return retried && failure === "needs-tap" ? "other" : failure;
}
