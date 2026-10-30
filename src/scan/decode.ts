import { downscaleSteps, photoMime, readJpegSize, safeSize, sniffImage, SAFE_CANVAS_PIXELS, SAFE_CANVAS_SIDE } from "./image-bytes";

/** Why a photo could not be decoded: `heic` has its own, actionable message. */
export class PhotoDecodeError extends Error {
	constructor(readonly reason: "heic" | "unreadable", detail?: string) {
		super(detail ?? reason);
		this.name = "PhotoDecodeError";
	}
}

export interface DecodedPhoto {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
}

interface Source {
	image: CanvasImageSource;
	width: number;
	height: number;
	release: () => void;
}

function newCanvas(w: number, h: number): DecodedPhoto {
	const canvas = createEl("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		canvas.width = 0;
		canvas.height = 0;
		throw new Error("2D canvas is not available");
	}
	return { canvas, ctx };
}

function fromBitmap(bmp: ImageBitmap): Source {
	return { image: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
}

function waitForLoad(img: HTMLImageElement, prior: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		if (img.complete) return img.naturalWidth > 0 ? resolve() : reject(prior instanceof Error ? prior : new Error("image failed to load"));
		img.addEventListener("load", () => resolve(), { once: true });
		img.addEventListener("error", () => reject(prior instanceof Error ? prior : new Error("image failed to load")), { once: true });
	});
}

/** Decodes through an <img> (a different code path than createImageBitmap, accepted by every WebView). */
async function viaImageElement(blob: Blob): Promise<Source> {
	const url = URL.createObjectURL(blob);
	const img = new Image();
	const release = () => {
		img.removeAttribute("src");
		URL.revokeObjectURL(url);
	};
	try {
		img.src = url;
		if (typeof img.decode === "function") {
			try {
				await img.decode();
			} catch (e) {
				// decode() can reject for a still loadable image on old WebViews: fall back to the load events.
				await waitForLoad(img, e);
			}
		} else {
			await waitForLoad(img, null);
		}
		if (img.naturalWidth === 0 || img.naturalHeight === 0) throw new Error("image has no size");
		return { image: img, width: img.naturalWidth, height: img.naturalHeight, release };
	} catch (e) {
		release();
		throw e;
	}
}

/** Last resort for huge JPEGs: let the browser decode straight to a small size (lower memory), when it supports resize options. */
async function viaResizedBitmap(blob: Blob, bytes: ArrayBuffer, maxSide: number): Promise<Source> {
	const size = readJpegSize(bytes);
	if (!size) throw new Error("size unknown");
	const target = safeSize(size.width, size.height, maxSide, maxSide * maxSide);
	return fromBitmap(await createImageBitmap(blob, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "medium" }));
}

async function openSource(blob: Blob, bytes: ArrayBuffer, maxSide: number): Promise<Source> {
	const errors: unknown[] = [];
	// 1. Plain createImageBitmap, with no options (some WebViews reject them).
	if (typeof createImageBitmap === "function") {
		try {
			return fromBitmap(await createImageBitmap(blob));
		} catch (e) {
			errors.push(e);
		}
	}
	// 2. <img> + object URL.
	try {
		return await viaImageElement(blob);
	} catch (e) {
		errors.push(e);
	}
	// 3. Browser-side downscaled decode.
	if (typeof createImageBitmap === "function") {
		try {
			return await viaResizedBitmap(blob, bytes, maxSide);
		} catch (e) {
			errors.push(e);
		}
	}
	throw new PhotoDecodeError("unreadable", errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" | "));
}

/** Pixel size of an image file, through the same checks and decoder fallbacks as `decodePhoto` (aspect ratio is exact). */
export async function photoSize(bytes: ArrayBuffer, name: string, declaredType = ""): Promise<{ width: number; height: number }> {
	if (bytes.byteLength === 0) throw new PhotoDecodeError("unreadable", "empty file");
	if (sniffImage(bytes) === "heic") throw new PhotoDecodeError("heic");
	const blob = new Blob([bytes], { type: photoMime(bytes, name, declaredType) });
	const source = await openSource(blob, bytes, SAFE_CANVAS_SIDE);
	try {
		if (source.width <= 0 || source.height <= 0) throw new PhotoDecodeError("unreadable", "decoded image has no size");
		return { width: source.width, height: source.height };
	} finally {
		source.release();
	}
}

/**
 * Decodes a photo and returns it on a canvas whose longest side is at most `maxSide` (and never above the safe canvas
 * limits). The full-resolution photo is never drawn on a canvas: it is shrunk in steps that stay within the safe size.
 */
export async function decodePhoto(bytes: ArrayBuffer, name: string, maxSide: number, declaredType = ""): Promise<DecodedPhoto> {
	if (bytes.byteLength === 0) throw new PhotoDecodeError("unreadable", "empty file");
	if (sniffImage(bytes) === "heic") throw new PhotoDecodeError("heic");
	const side = Math.min(maxSide, SAFE_CANVAS_SIDE);
	const blob = new Blob([bytes], { type: photoMime(bytes, name, declaredType) });
	const source = await openSource(blob, bytes, side);
	const made: HTMLCanvasElement[] = [];
	try {
		if (source.width <= 0 || source.height <= 0) throw new PhotoDecodeError("unreadable", "decoded image has no size");
		const dst = safeSize(source.width, source.height, side, SAFE_CANVAS_PIXELS);
		let from: CanvasImageSource = source.image;
		let last: DecodedPhoto | null = null;
		for (const step of downscaleSteps({ width: source.width, height: source.height }, dst)) {
			const target = newCanvas(step.width, step.height);
			made.push(target.canvas);
			target.ctx.imageSmoothingEnabled = true;
			target.ctx.imageSmoothingQuality = "high";
			target.ctx.drawImage(from, 0, 0, step.width, step.height);
			if (last) {
				last.canvas.width = 0;
				last.canvas.height = 0;
			}
			last = target;
			from = target.canvas;
		}
		if (!last) throw new Error("nothing drawn");
		return last;
	} catch (e) {
		for (const c of made) {
			c.width = 0;
			c.height = 0;
		}
		throw e instanceof PhotoDecodeError ? e : new PhotoDecodeError("unreadable", e instanceof Error ? e.message : String(e));
	} finally {
		source.release();
	}
}
