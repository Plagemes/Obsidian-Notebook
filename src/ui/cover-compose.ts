// Draws a notebook cover picture (0.22 covers): a cropped image or page, or a template with the notebook's title on generated
// art. Used by the "Change cover" dialog for its preview and once, at full size, to bake the picture that is stored. Browser
// canvas only (no Obsidian); the cropping maths is model/cover-crop.ts and the pure template helpers are model/cover-template.ts.
// Nothing here runs per frame except the crop preview while a finger drags it.
import { COVER_PX, COVER_SOURCE_MAX, cropWindow, downscaleSize, type Crop } from "../model/cover-crop";
import { readableOn, shade, wrapTitle, type CoverTemplateId } from "../model/cover-template";
import { artRef, resolveRef } from "./art/art-ref";
import type { ArtFamily } from "./art/generative-art";

/** A picture held for cropping: a canvas no larger than `COVER_SOURCE_MAX` on its long side. */
export interface CoverSource {
	canvas: HTMLCanvasElement;
	/** Size of the original, for the note under the picture. */
	originalW: number;
	originalH: number;
}

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

function newCanvas(w: number, h: number): HTMLCanvasElement {
	const c = createEl("canvas");
	c.width = w;
	c.height = h;
	return c;
}

/** Decodes image bytes, keeping at most `COVER_SOURCE_MAX` pixels on the long side (null when they are not an image). */
export async function decodeSource(bytes: ArrayBuffer, mime = ""): Promise<CoverSource | null> {
	let bitmap: ImageBitmap | null = null;
	try {
		bitmap = await createImageBitmap(new Blob([bytes], mime ? { type: mime } : undefined));
		const size = downscaleSize(bitmap.width, bitmap.height, COVER_SOURCE_MAX);
		if (size.w === 0) return null;
		const canvas = newCanvas(size.w, size.h);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(bitmap, 0, 0, size.w, size.h);
		return { canvas, originalW: bitmap.width, originalH: bitmap.height };
	} catch {
		return null;
	} finally {
		bitmap?.close();
	}
}

/** Loads a picture from a URL or data URL (null when it cannot be loaded). */
export function loadImage(url: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		if (!url) return resolve(null);
		const img = createEl("img");
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = url;
	});
}

/** A data URL (a page picture) as a source for cropping. */
export async function sourceFromUrl(url: string): Promise<CoverSource | null> {
	const img = await loadImage(url);
	if (!img || img.naturalWidth === 0) return null;
	const size = downscaleSize(img.naturalWidth, img.naturalHeight, COVER_SOURCE_MAX);
	const canvas = newCanvas(size.w, size.h);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(img, 0, 0, size.w, size.h);
	return { canvas, originalW: img.naturalWidth, originalH: img.naturalHeight };
}

/** Draws the part of `src` that `crop` shows over the whole of `ctx`'s `w` x `h`. */
export function paintCrop(ctx: CanvasRenderingContext2D, w: number, h: number, src: CoverSource, crop: Crop): void {
	const r = cropWindow(src.canvas.width, src.canvas.height, crop);
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, w, h);
	if (r.w === 0) return;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(src.canvas, r.x, r.y, r.w, r.h, 0, 0, w, h);
}

export interface TemplateInput {
	template: CoverTemplateId;
	title: string;
	/** The cover colour, `#rrggbb`. */
	color: string;
	/** The generated art to lay over it (lines on a transparent ground), or null. */
	art: CanvasImageSource | null;
}

/** Loads the line art of a template (a seed, a family, a colour) at the size the dialog draws; null when the art engine is off. */
export async function loadTemplateArt(seed: string, family: ArtFamily, color: string): Promise<HTMLImageElement | null> {
	const url = await resolveRef(artRef("art", { seed, color, style: family, surface: "dark", density: 0.7 }, COVER_PX.w / 2, COVER_PX.h / 2));
	return loadImage(url);
}

function gradient(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: ReadonlyArray<[number, string]>): CanvasGradient {
	const g = ctx.createLinearGradient(x0, y0, x1, y1);
	for (const [at, colour] of stops) g.addColorStop(at, colour);
	return g;
}

function drawArt(ctx: CanvasRenderingContext2D, art: CanvasImageSource | null, x: number, y: number, w: number, h: number, alpha = 1): void {
	if (!art) return;
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.beginPath();
	ctx.rect(x, y, w, h);
	ctx.clip();
	ctx.drawImage(art, x, y, w, h);
	ctx.restore();
}

/** Writes `title` in up to `lines` lines inside the box, from the top (`anchor` "top") or ending at the bottom ("bottom"). */
function drawTitle(
	ctx: CanvasRenderingContext2D, title: string, colour: string,
	box: { x: number; y: number; w: number; h: number }, o: { size: number; lines: number; align: CanvasTextAlign; anchor: "top" | "bottom" | "middle" },
): number {
	ctx.font = `700 ${o.size}px ${FONT}`;
	const lines = wrapTitle(title, (s) => ctx.measureText(s).width, box.w, o.lines);
	if (lines.length === 0) return box.y;
	const lh = o.size * 1.18;
	const total = lines.length * lh;
	const top = o.anchor === "top" ? box.y : o.anchor === "bottom" ? box.y + box.h - total : box.y + (box.h - total) / 2;
	ctx.fillStyle = colour;
	ctx.textAlign = o.align;
	ctx.textBaseline = "top";
	const x = o.align === "center" ? box.x + box.w / 2 : o.align === "right" ? box.x + box.w : box.x;
	lines.forEach((line, i) => ctx.fillText(line, x, top + i * lh));
	return top;
}

/** Paints a template over the whole of `ctx`'s `w` x `h` (the baked size is `COVER_PX`; the preview is half of it). */
export function paintTemplate(ctx: CanvasRenderingContext2D, w: number, h: number, input: TemplateInput): void {
	const { template, title, color, art } = input;
	const u = w / 270; // one unit of the 270 x 360 design grid
	const padL = 34 * u; // clear of the spine the library draws on the left edge
	const padR = 20 * u;
	const textW = w - padL - padR;
	ctx.save();
	ctx.clearRect(0, 0, w, h);
	if (template === "minimal") {
		ctx.fillStyle = shade(color, 0.9);
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 14 * u, h);
		ctx.fillRect(padL, h - 150 * u, 34 * u, 4 * u);
		drawTitle(ctx, title, shade(color, -0.6), { x: padL, y: h - 138 * u, w: textW, h: 112 * u }, { size: 26 * u, lines: 4, align: "left", anchor: "top" });
	} else if (template === "band") {
		const split = h * 0.62;
		ctx.fillStyle = gradient(ctx, 0, 0, w, split, [[0, shade(color, 0.1)], [1, shade(color, -0.3)]]);
		ctx.fillRect(0, 0, w, split);
		drawArt(ctx, art, 0, 0, w, split);
		const base = shade(color, -0.55);
		ctx.fillStyle = base;
		ctx.fillRect(0, split, w, h - split);
		ctx.fillStyle = shade(color, 0.35);
		ctx.fillRect(0, split, w, 3 * u);
		drawTitle(ctx, title, readableOn(base), { x: padL, y: split + 14 * u, w: textW, h: h - split - 28 * u }, { size: 22 * u, lines: 3, align: "left", anchor: "middle" });
	} else if (template === "frame") {
		const base = shade(color, -0.5);
		ctx.fillStyle = gradient(ctx, 0, 0, w, h, [[0, shade(color, -0.3)], [1, shade(color, -0.65)]]);
		ctx.fillRect(0, 0, w, h);
		drawArt(ctx, art, 0, 0, w, h, 0.55);
		ctx.strokeStyle = shade(color, 0.55);
		ctx.lineWidth = 1.5 * u;
		ctx.strokeRect(24 * u, 18 * u, w - 24 * u - 14 * u, h - 36 * u);
		const ink = readableOn(base);
		const y = drawTitle(ctx, title, ink, { x: 36 * u, y: 40 * u, w: w - 36 * u - 26 * u, h: h - 80 * u }, { size: 24 * u, lines: 5, align: "center", anchor: "middle" });
		ctx.fillStyle = shade(color, 0.55);
		ctx.fillRect(w / 2 + 5 * u - 15 * u, Math.max(30 * u, y - 14 * u), 30 * u, 2 * u);
	} else if (template === "poster") {
		ctx.fillStyle = gradient(ctx, 0, 0, w, h, [[0, shade(color, 0.05)], [1, shade(color, -0.45)]]);
		ctx.fillRect(0, 0, w, h);
		drawArt(ctx, art, 0, 0, w, h);
		ctx.fillStyle = gradient(ctx, 0, 0, 0, h * 0.6, [[0, "rgba(0,0,0,0.55)"], [1, "rgba(0,0,0,0)"]]);
		ctx.fillRect(0, 0, w, h * 0.6);
		drawTitle(ctx, title, "#ffffff", { x: padL, y: 30 * u, w: textW, h: 190 * u }, { size: 32 * u, lines: 5, align: "left", anchor: "top" });
	} else {
		// classic
		ctx.fillStyle = gradient(ctx, 0, 0, w, h, [[0, shade(color, 0.12)], [1, shade(color, -0.4)]]);
		ctx.fillRect(0, 0, w, h);
		drawArt(ctx, art, 0, 0, w, h);
		ctx.fillStyle = gradient(ctx, 0, h * 0.45, 0, h, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.62)"]]);
		ctx.fillRect(0, h * 0.45, w, h * 0.55);
		const y = drawTitle(ctx, title, "#ffffff", { x: padL, y: h - 128 * u, w: textW, h: 104 * u }, { size: 24 * u, lines: 4, align: "left", anchor: "bottom" });
		ctx.fillStyle = shade(color, 0.6);
		ctx.fillRect(padL, y - 12 * u, 30 * u, 3 * u);
	}
	ctx.restore();
}

/** Bakes the canvas as JPEG bytes (null when the browser cannot encode it). */
export function canvasJpeg(canvas: HTMLCanvasElement, quality = 0.86): Promise<ArrayBuffer | null> {
	return new Promise((resolve) => {
		try {
			canvas.toBlob((b) => (b ? void b.arrayBuffer().then(resolve, () => resolve(null)) : resolve(null)), "image/jpeg", quality);
		} catch {
			resolve(null);
		}
	});
}

/** A canvas of the baked size, to paint into. */
export function bakeCanvas(): HTMLCanvasElement {
	return newCanvas(COVER_PX.w, COVER_PX.h);
}
