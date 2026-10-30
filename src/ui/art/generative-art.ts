// Procedural subject artwork (DESIGN.md §2.6): deterministic line art from a seed and a subject colour, for subject
// cards (fading in from the right) and notebook covers. No AI, no network, no stock images.
//
// Does not import obsidian: `drawArt` and the families are pure canvas code, testable in Node with a fake context.
// The image functions need a canvas, made with `activeDocument.createEl` unless a factory is set (tests).
import type { Rgb } from "../../ink/colour";
import { darken, hexOf, lighten, rgba, rgbOf } from "./art-colour";
import { drawBranches, drawCells, drawContours, drawFlow, drawGrid, drawOrbits, drawWaves } from "./families";
import { LruCache } from "./lru";
import { flat, SOLID, type ArtContext, type Painter } from "./painter";
import { hashString, rngFor } from "./prng";

import { folderIconSvg as folderSvg } from "./folder-icon";
export type { ArtContext } from "./painter";

export type ArtStyle = "contours" | "cells" | "waves" | "branches" | "flow" | "orbits" | "grid";

export interface ArtSpec {
	/** Stable seed (e.g. folder path or notebook id): same seed → same picture. */
	seed: string;
	/** Base colour, `#rrggbb` (a subject colour from DESIGN.md §2.3). */
	color: string;
	/** Visual family; default: artStyleFor(seed). */
	style?: ArtStyle;
	/** 0..1, default 0.6. */
	density?: number;
	/**
	 * Overall opacity of the art, 0..1, default 1 (optional addition to the shared contract). Low values (≈0.15–0.3)
	 * make the faint header bands behind page titles, e.g. `artImage({ …, intensity: 0.2 }, 1200, 160)`.
	 */
	intensity?: number;
	/**
	 * The surface the art sits on (optional addition to the shared contract): "dark" (default, the reference cards)
	 * draws lightened, glowing lines; "light" draws deeper lines with a softer glow, so they read on light themes.
	 */
	surface?: "dark" | "light";
}

/** Every family, in a fixed order (the order `artStyleFor` hashes into: never reorder, only append). */
export const ART_STYLES: readonly ArtStyle[] = ["contours", "cells", "waves", "branches", "flow", "orbits", "grid"];

const FAMILIES: Record<ArtStyle, (p: Painter) => void> = {
	contours: drawContours,
	cells: drawCells,
	waves: drawWaves,
	branches: drawBranches,
	flow: drawFlow,
	orbits: drawOrbits,
	grid: drawGrid,
};

/** Picks a style deterministically from a name (e.g. "Matematica" → a hash, not keyword AI). */
export function artStyleFor(name: string): ArtStyle {
	return ART_STYLES[hashString(`style:${name.trim().toLowerCase()}`) % ART_STYLES.length]!;
}

interface Resolved {
	seed: string;
	color: string;
	style: ArtStyle;
	density: number;
	intensity: number;
	surface: "dark" | "light";
}

const clamp01 = (v: number | undefined, fallback: number): number =>
	Math.round((typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback) * 100) / 100;

function resolve(spec: ArtSpec): Resolved {
	const style = spec.style && ART_STYLES.includes(spec.style) ? spec.style : artStyleFor(spec.seed);
	return { seed: spec.seed, color: hexOf(spec.color), style, density: clamp01(spec.density, 0.6), intensity: clamp01(spec.intensity, 1), surface: spec.surface === "light" ? "light" : "dark" };
}

/** How a layer of art is laid out on its surface. */
export interface ArtLayer {
	/**
	 * "right": masked so it fades in from the right half (cards, header bands); "radial": a centred composition fading
	 * out towards the edges (empty states); "none": the whole surface (covers).
	 */
	fade: "right" | "radial" | "none";
	/** Overall opacity. */
	alpha: number;
	/** Focus of the composition, as fractions of w and h. */
	focusX: number;
	focusY: number;
	/** Glow passes and the soft radial glow. */
	glow: boolean;
	/** Line colour; default: the subject colour, lightened. */
	lineColour?: Rgb;
}

const CARD_LAYER: ArtLayer = { fade: "right", alpha: 1, focusX: 0.74, focusY: 0.5, glow: true };
const EMPTY_LAYER: ArtLayer = { fade: "radial", alpha: 1, focusX: 0.5, focusY: 0.5, glow: true };

/**
 * Draws one layer of art for a resolved spec. Exported for the cover and for tests (a recording fake context);
 * everything else goes through `drawArt`, `artImage` or `coverImage`.
 */
export function drawArtLayer(ctx: ArtContext, w: number, h: number, spec: ArtSpec, layer: ArtLayer = CARD_LAYER): void {
	if (!(w > 0 && h > 0)) return;
	const r = resolve(spec);
	const base = rgbOf(r.color);
	const lineRgb = layer.lineColour ?? (r.surface === "light" ? darken(base, 0.12) : lighten(base, 0.3));
	let line: string | CanvasGradient, glow: string | CanvasGradient;
	let x0 = 0;
	const fx = w * layer.focusX, fy = h * layer.focusY;
	const alpha = layer.alpha * r.intensity;
	if (alpha <= 0) return;
	// Radius of the radial mask: the lines vanish before the nearest edge.
	const maskR = Math.min(w, h) * 0.5 / 0.85;
	if (layer.fade === "radial") {
		const l = ctx.createRadialGradient(fx, fy, 0, fx, fy, maskR);
		l.addColorStop(0, rgba(lineRgb, 1));
		l.addColorStop(0.5, rgba(lineRgb, 0.75));
		l.addColorStop(0.85, rgba(lineRgb, 0));
		l.addColorStop(1, rgba(lineRgb, 0));
		line = l;
		const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, maskR);
		g.addColorStop(0, rgba(base, 1));
		g.addColorStop(0.85, rgba(base, 0));
		g.addColorStop(1, rgba(base, 0));
		glow = g;
	} else if (layer.fade === "right") {
		// The right-to-left alpha mask lives in the paint itself: no compositing, nothing else on the target is touched.
		// Narrow cards (phones) keep more room for the title.
		const narrow = w < 480;
		x0 = w * (narrow ? 0.42 : 0.3);
		const x1 = w * (narrow ? 0.88 : 0.8);
		const l = ctx.createLinearGradient(x0, 0, x1, 0);
		l.addColorStop(0, rgba(lineRgb, 0));
		l.addColorStop(0.45, rgba(lineRgb, 0.4));
		l.addColorStop(1, rgba(lineRgb, 1));
		line = l;
		const g = ctx.createLinearGradient(x0, 0, x1, 0);
		g.addColorStop(0, rgba(base, 0));
		g.addColorStop(1, rgba(base, 1));
		glow = g;
	} else {
		line = flat(lineRgb);
		glow = flat(base);
	}
	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.setLineDash(SOLID);
	if (layer.glow) {
		// Soft radial glow in the subject colour behind the lines.
		const radius = layer.fade === "radial" ? maskR * 0.85 : Math.max(h * 1.1, w * 0.32);
		const rg = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
		const k = r.surface === "light" ? 0.55 : 1;
		rg.addColorStop(0, rgba(base, 0.26 * k * alpha));
		rg.addColorStop(0.5, rgba(base, 0.1 * k * alpha));
		rg.addColorStop(1, rgba(base, 0));
		ctx.globalAlpha = 1;
		ctx.fillStyle = rg;
		ctx.fillRect(x0, 0, w - x0, h);
	}
	const painter: Painter = {
		ctx, w, h,
		rng: rngFor(`${r.style}|${r.seed}`),
		density: r.density,
		unit: Math.min(w, h) / 200,
		fx, fy, x0,
		line, glow,
		glowOn: layer.glow,
		alpha,
		lineRgb,
	};
	FAMILIES[r.style](painter);
	ctx.restore();
}

/** Draws the line art (transparent background) into the given 2D context, in CSS pixels w × h. Nothing when `artEnabled()` is false. */
export function drawArt(ctx: CanvasRenderingContext2D, w: number, h: number, spec: ArtSpec): void {
	if (!artEnabled()) return;
	drawArtLayer(ctx, w, h, spec, CARD_LAYER);
}

// ---------------------------------------------------------------------------------------------------------------
// Switch

let enabledSetting = true;
let reducedMotion: MediaQueryList | null | undefined;

/**
 * Whether decorative art is drawn: false when the system asks for reduced motion (`prefers-reduced-motion: reduce`)
 * or when `setArtEnabled(false)` was called (for a plugin setting such as *Reduce motion and effects*). When false,
 * `drawArt` draws nothing, `artImage` and `emptyStateImage` return "" (callers show no image), and `coverImage`
 * returns the plain cover gradient without line art.
 */
export function artEnabled(): boolean {
	if (!enabledSetting) return false;
	if (reducedMotion === undefined) {
		reducedMotion = typeof activeWindow !== "undefined" && typeof activeWindow.matchMedia === "function"
			? activeWindow.matchMedia("(prefers-reduced-motion: reduce)")
			: null;
	}
	return !reducedMotion?.matches;
}

/** Turns decorative art on or off (a plugin setting; the system's reduced-motion preference still wins). */
export function setArtEnabled(on: boolean): void {
	enabledSetting = on;
}

// ---------------------------------------------------------------------------------------------------------------
// Covers

/** Paints a portrait notebook cover: a soft diagonal gradient, large smooth wave shapes, a faint art layer, a spine. */
export function drawCover(ctx: ArtContext, w: number, h: number, spec: ArtSpec): void {
	if (!(w > 0 && h > 0)) return;
	const r = resolve(spec);
	const base = rgbOf(r.color);
	const rng = rngFor(`cover|${r.seed}`);
	ctx.save();
	ctx.globalAlpha = 1;
	const bg = ctx.createLinearGradient(0, 0, w, h);
	bg.addColorStop(0, rgba(lighten(base, 0.3), 1));
	bg.addColorStop(0.55, rgba(base, 1));
	bg.addColorStop(1, rgba(darken(base, 0.3), 1));
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	// A large soft light in the top-left corner.
	const light = ctx.createRadialGradient(w * 0.15, h * 0.08, 0, w * 0.15, h * 0.08, Math.max(w, h) * 0.75);
	light.addColorStop(0, "rgba(255,255,255,0.22)");
	light.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = light;
	ctx.fillRect(0, 0, w, h);
	// Smooth wave bands across the lower half: two light, one dark.
	const bands = 3;
	for (let i = 0; i < bands; i++) {
		const y0 = h * (0.45 + i * 0.13 + rng.range(-0.05, 0.05));
		const y1 = h * (0.35 + i * 0.16 + rng.range(-0.08, 0.08));
		ctx.beginPath();
		ctx.moveTo(0, y0);
		ctx.bezierCurveTo(w * rng.range(0.25, 0.4), y0 - h * rng.range(0.08, 0.2), w * rng.range(0.6, 0.75), y1 + h * rng.range(0.08, 0.2), w, y1);
		ctx.lineTo(w, h);
		ctx.lineTo(0, h);
		ctx.closePath();
		ctx.fillStyle = i === 1 ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.1)";
		ctx.fill();
	}
	// A round blob top-right.
	ctx.beginPath();
	const br = w * rng.range(0.32, 0.48);
	ctx.arc(w * rng.range(0.75, 0.95), h * rng.range(0.12, 0.28), br, 0, Math.PI * 2);
	ctx.fillStyle = "rgba(255,255,255,0.08)";
	ctx.fill();
	ctx.restore();
	if (artEnabled()) drawArtLayer(ctx, w, h, spec, { fade: "none", alpha: 0.3, focusX: 0.62, focusY: 0.6, glow: false, lineColour: lighten(base, 0.8) });
	ctx.save();
	// The spine: a darker band on the left with a thin highlight.
	const spine = Math.max(4, w * 0.065);
	ctx.globalAlpha = 1;
	ctx.fillStyle = "rgba(0,0,0,0.14)";
	ctx.fillRect(0, 0, spine, h);
	ctx.fillStyle = "rgba(255,255,255,0.2)";
	ctx.fillRect(spine, 0, 1, h);
	ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// Never break a layout (0.12.3)

/**
 * The art is decoration (DESIGN.md §3): a failure must only drop the picture, never the card, the section or the
 * dialog around it. Every public image function below runs through `decoration`: an exception is logged once (with its
 * message, for the device's console) and the caller gets its fallback ("" = no image). After three failures the
 * engine stops trying for the session, so a WebView that cannot make canvases does not pay for every card.
 */
const MAX_FAILURES = 3;
let failures = 0;
let lastFailure = "";

/** `canvas`: the image needs a canvas (switched off with the engine); the folder icon is plain markup and does not. */
function decoration<T>(what: string, fallback: T, make: () => T, canvas = true): T {
	if (canvas && failures >= MAX_FAILURES) return fallback;
	try {
		return make();
	} catch (e) {
		failures++;
		lastFailure = e instanceof Error ? e.message : String(e);
		if (failures === 1) console.error(`[notebook] art: the ${what} could not be drawn; decoration dropped`, e);
		return fallback;
	}
}

/** Failures so far and the last message (the harness and the settings' device info). */
export function artFailures(): { count: number; last: string; off: boolean } {
	return { count: failures, last: lastFailure, off: failures >= MAX_FAILURES };
}

/** Forgets earlier failures (tests, or the harness between scenarios). */
export function resetArtFailures(): void {
	failures = 0;
	lastFailure = "";
}

/** Inline SVG of the glossy folder (folder-icon.ts); "" if it cannot be made, and the caller shows a plain icon. */
export function folderIconSvg(color: string, size = 56): string {
	return decoration("folder icon", "", () => folderSvg(color, size), false);
}

// ---------------------------------------------------------------------------------------------------------------
// Cached images

/** The 2D context the image functions need (the art context plus the transform). */
export type ImageContext = ArtContext & Pick<CanvasRenderingContext2D, "clearRect"> & {
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
};

/** The canvas the image functions draw into (an HTMLCanvasElement in the app; a fake in tests). */
export interface ArtCanvas {
	width: number;
	height: number;
	getContext(type: "2d"): ImageContext | null;
	toDataURL(type?: string): string;
}

// A detached canvas: `createEl` on a Document would append to the document itself and throw (0.12.2 on the device).
let makeCanvas: () => ArtCanvas = () => createEl("canvas");
let scratch: ArtCanvas | null = null;
const images = new LruCache<string>(40);

/** Replaces the canvas factory (tests, or a host without `activeDocument`). Clears the cache. */
export function setArtCanvasFactory(factory: () => ArtCanvas): void {
	makeCanvas = factory;
	scratch = null;
	resetArtFailures();
	images.clear();
}

/** Cache counters (tests and the harness). */
export function artCacheStats(): { size: number; hits: number; misses: number; capacity: number } {
	return { size: images.size, hits: images.hits, misses: images.misses, capacity: images.capacity };
}

export function clearArtCache(): void {
	images.clear();
}

function pixelRatio(dpr: number | undefined): number {
	const raw = dpr ?? (typeof activeWindow !== "undefined" ? activeWindow.devicePixelRatio : 1);
	const v = Number.isFinite(raw) && raw > 0 ? Math.min(3, Math.max(1, raw)) : 1;
	return Math.round(v * 100) / 100;
}

function render(key: string, w: number, h: number, dpr: number, paint: (ctx: ImageContext) => void): string {
	return images.getOrCreate(key, () => {
		scratch ??= makeCanvas();
		const canvas = scratch;
		canvas.width = Math.max(1, Math.round(w * dpr));
		canvas.height = Math.max(1, Math.round(h * dpr));
		const ctx = canvas.getContext("2d");
		if (!ctx) return "";
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		paint(ctx);
		const url = canvas.toDataURL("image/png");
		// Release the backing store until the next image.
		canvas.width = 0;
		canvas.height = 0;
		return url;
	});
}

function keyOf(kind: string, spec: ArtSpec, w: number, h: number, dpr: number): string {
	const r = resolve(spec);
	return `${kind}|${r.style}|${r.color}|${r.density}|${r.intensity}|${r.surface}|${w}x${h}@${dpr}|${artEnabled() ? 1 : 0}|${r.seed}`;
}

/**
 * Cached PNG data URL of the art at the given size (device-pixel aware); cheap on repeat calls. "" when
 * `artEnabled()` is false. Also makes the wide, faint header bands: e.g. 1200 × 160 with `intensity: 0.2`.
 */
export function artImage(spec: ArtSpec, w: number, h: number, dpr?: number): string {
	const cw = Math.round(w), ch = Math.round(h);
	return decoration("art image", "", () => {
		if (!(cw > 0 && ch > 0) || !artEnabled()) return "";
		const ratio = pixelRatio(dpr);
		return render(keyOf("art", spec, cw, ch, ratio), cw, ch, ratio, (ctx) => drawArtLayer(ctx, cw, ch, spec, CARD_LAYER));
	});
}

/** Notebook cover (portrait): soft gradient + art, as a cached data URL ("" if it cannot be drawn: show a plain colour). */
export function coverImage(spec: ArtSpec, w: number, h: number, dpr?: number): string {
	const cw = Math.round(w), ch = Math.round(h);
	return decoration("cover", "", () => {
		if (!(cw > 0 && ch > 0)) return "";
		const ratio = pixelRatio(dpr);
		return render(keyOf("cover", spec, cw, ch, ratio), cw, ch, ratio, (ctx) => drawCover(ctx, cw, ch, spec));
	});
}

/**
 * Empty-state illustration: a small composition centred in w × h (about 240 × 160) that fades out before the edges,
 * from the same families, as a cached data URL. "" when `artEnabled()` is false.
 */
export function emptyStateImage(spec: ArtSpec, w: number, h: number, dpr?: number): string {
	const cw = Math.round(w), ch = Math.round(h);
	return decoration("empty-state illustration", "", () => {
		if (!(cw > 0 && ch > 0) || !artEnabled()) return "";
		const ratio = pixelRatio(dpr);
		return render(keyOf("empty", spec, cw, ch, ratio), cw, ch, ratio, (ctx) => drawArtLayer(ctx, cw, ch, spec, EMPTY_LAYER));
	});
}
