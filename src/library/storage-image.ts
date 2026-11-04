/**
 * Draws the smaller copy of a picture for "Downscale" (Storage manager, roadmap #128). The decisions (size, format, whether it
 * is worth keeping) are in storage-image-logic.ts. Browser APIs only: `createImageBitmap` and a canvas made with the global
 * `createEl` (never on a Document).
 */
import { DOWNSCALE_MAX_EDGE, JPEG_QUALITY, downscaledName, hasTransparency, mimeOf, outputFormat, targetSize, worthKeeping } from "./storage-image-logic";

export interface Downscaled {
	bytes: ArrayBuffer;
	/** Display name for the new asset record. */
	name: string;
	width: number;
	height: number;
}

export type DownscaleResult = { ok: true; image: Downscaled } | { ok: false; reason: "no-gain" | "cannot-decode" };

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
}

/**
 * The picture scaled to at most `maxEdge` pixels on its longest side (a picture already that small is only recompressed),
 * saved as PNG when it has transparency and as JPEG otherwise. `no-gain` when the result is not clearly smaller than the
 * original: then nothing is written.
 */
export async function downscaleImage(bytes: ArrayBuffer, name: string, maxEdge = DOWNSCALE_MAX_EDGE): Promise<DownscaleResult> {
	let bitmap: ImageBitmap | null = null;
	try {
		bitmap = await createImageBitmap(new Blob([bytes], { type: mimeOf(name) }));
		const size = targetSize(bitmap.width, bitmap.height, maxEdge);
		const canvas = createEl("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return { ok: false, reason: "cannot-decode" };
		ctx.drawImage(bitmap, 0, 0, size.width, size.height);
		const alpha = hasTransparency(ctx.getImageData(0, 0, size.width, size.height).data);
		const format = outputFormat(alpha);
		const blob = await toBlob(canvas, format.mime, JPEG_QUALITY);
		if (!blob) return { ok: false, reason: "cannot-decode" };
		const out = await blob.arrayBuffer();
		if (!worthKeeping(bytes.byteLength, out.byteLength)) return { ok: false, reason: "no-gain" };
		return { ok: true, image: { bytes: out, name: downscaledName(name, format.ext), width: size.width, height: size.height } };
	} catch (e) {
		console.error("[notebook] downscale: could not decode or draw", e);
		return { ok: false, reason: "cannot-decode" };
	} finally {
		bitmap?.close();
	}
}
