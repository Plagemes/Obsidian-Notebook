/**
 * The decisions of "Downscale" (Storage manager, roadmap #128), kept pure so they are tested in Node: how big the smaller
 * copy is, what it is called, and whether it is worth keeping. The drawing itself is in storage-image.ts.
 */

/** The longest side of a downscaled picture, pixels (an A4 page at about 175 dpi: ink and text on top stay sharp). */
export const DOWNSCALE_MAX_EDGE = 2048;
/** The smaller copy is kept only if it is at most this share of the original. */
export const MIN_GAIN = 0.9;
/** JPEG quality of a downscaled photo. */
export const JPEG_QUALITY = 0.85;

/** Pixels of the smaller copy: the longest side at most `max`, the ratio kept, never enlarged, never below 1. */
export function targetSize(width: number, height: number, max = DOWNSCALE_MAX_EDGE): { width: number; height: number } {
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	const longest = Math.max(w, h);
	if (longest <= max) return { width: w, height: h };
	const k = max / longest;
	return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Whether a smaller copy is worth keeping: clearly smaller than the original. */
export function worthKeeping(originalBytes: number, newBytes: number): boolean {
	return newBytes > 0 && newBytes <= originalBytes * MIN_GAIN;
}

/** Image types the downscale handles. GIF is left alone (it may be animated: one frame would be all that is kept). */
export function canDownscale(path: string): boolean {
	return /\.(png|jpe?g|webp)$/i.test(path);
}

/** The mime type the browser decodes a file as, from its extension. */
export function mimeOf(path: string): string {
	const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
	return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
}

/** What the smaller copy is saved as: a picture with transparency stays PNG, anything else becomes a JPEG. */
export function outputFormat(hasAlpha: boolean): { mime: "image/png" | "image/jpeg"; ext: "png" | "jpg" } {
	return hasAlpha ? { mime: "image/png", ext: "png" } : { mime: "image/jpeg", ext: "jpg" };
}

/**
 * The display name of the smaller copy: the original name with the new extension. A name that holds an asset id (the file in
 * `_assets/` is named by one) is replaced by a plain one: an id inside a name would make every notebook that stores the name
 * look as if it still used the old picture (the library check finds assets by their ids in the text).
 */
export function downscaledName(name: string, ext: string): string {
	const stem = name.replace(/\.[^./\\]+$/, "");
	return `${stem === "" || /[0-9a-f]{24}/i.test(stem) ? "image" : stem}.${ext}`;
}

/** Whether any pixel of RGBA data is not fully opaque. */
export function hasTransparency(data: ArrayLike<number>): boolean {
	for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 255) < 255) return true;
	return false;
}
