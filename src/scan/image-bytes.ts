/** Pure helpers for decoding photos robustly (no DOM, no 'obsidian'): format sniffing, MIME types, safe canvas sizes. */

export type ImageKind = "jpeg" | "png" | "gif" | "webp" | "bmp" | "avif" | "heic" | "unknown";

/** Largest side of any canvas the decoder creates (Android WebViews often fail above 4096-8192). */
export const SAFE_CANVAS_SIDE = 4096;
/** Largest area of any canvas the decoder creates (about 16 MP; Android WebViews cap canvases near this). */
export const SAFE_CANVAS_PIXELS = 16_700_000;

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function ascii(b: Uint8Array, from: number, to: number): string {
	let s = "";
	for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
	return s;
}

/** Identifies an image by its first bytes (the file name and MIME type of a camera photo are not reliable). */
export function sniffImage(input: ArrayBuffer | Uint8Array): ImageKind {
	const b = input instanceof Uint8Array ? input : new Uint8Array(input);
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
	if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "png";
	if (b.length >= 6 && ascii(b, 0, 3) === "GIF") return "gif";
	if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
	if (b.length >= 2 && ascii(b, 0, 2) === "BM") return "bmp";
	if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
		const major = ascii(b, 8, 12);
		if (AVIF_BRANDS.has(major)) return "avif";
		if (!HEIC_BRANDS.has(major)) return "unknown";
		// "mif1" / "msf1" are generic: AVIF files may use them as major brand and list "avif" as compatible.
		const boxSize = ((b[0] ?? 0) * 0x1000000) + ((b[1] ?? 0) << 16) + ((b[2] ?? 0) << 8) + (b[3] ?? 0);
		const end = Math.min(b.length, boxSize >= 16 ? boxSize : 64);
		for (let i = 16; i + 4 <= end; i += 4) if (AVIF_BRANDS.has(ascii(b, i, i + 4))) return "avif";
		return "heic";
	}
	return "unknown";
}

/** True for HEIC / HEIF photos, which Chromium-based WebViews cannot decode. */
export function isHeic(input: ArrayBuffer | Uint8Array): boolean {
	return sniffImage(input) === "heic";
}

const MIME_BY_KIND: Record<ImageKind, string> = {
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	heic: "image/heic",
	unknown: "",
};

const MIME_BY_EXT: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	jfif: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	heic: "image/heic",
	heif: "image/heif",
};

/** MIME type guessed from a file name ("" when the extension is unknown). */
export function mimeFromName(name: string): string {
	const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
	return (m && MIME_BY_EXT[(m[1] ?? "").toLowerCase()]) || "";
}

/** MIME type for the Blob of a photo: the content wins over the name; JPEG is the last resort (it is what cameras produce). */
export function photoMime(bytes: ArrayBuffer | Uint8Array, name: string, declared = ""): string {
	return MIME_BY_KIND[sniffImage(bytes)] || (declared.startsWith("image/") ? declared : "") || mimeFromName(name) || "image/jpeg";
}

/** Pixel size read from the first SOF marker of a JPEG (without decoding it); null if not found. */
export function readJpegSize(input: ArrayBuffer | Uint8Array): { width: number; height: number } | null {
	const b = input instanceof Uint8Array ? input : new Uint8Array(input);
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
	let i = 2;
	while (i + 4 <= b.length) {
		if (b[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = b[i + 1] ?? 0;
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			if (i + 9 > b.length) return null;
			const height = ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0);
			const width = ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (marker === 0xda || len < 2) return null;
		i += 2 + len;
	}
	return null;
}

export interface Size {
	width: number;
	height: number;
}

/** Size scaled down (never up) so that neither side exceeds `maxSide` and the area stays within `maxPixels`. */
export function safeSize(width: number, height: number, maxSide = SAFE_CANVAS_SIDE, maxPixels = SAFE_CANVAS_PIXELS): Size {
	if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
	const k = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
	return { width: Math.max(1, Math.floor(width * k)), height: Math.max(1, Math.floor(height * k)) };
}

/**
 * Sizes of the canvases to draw through when shrinking `src` to `dst`: each step at most halves the previous one
 * (better quality than one big jump) and no intermediate canvas exceeds the safe side or area. The last entry is `dst`.
 * The first draw always comes from the decoded source, so an intermediate size above the safe limits is simply skipped.
 */
export function downscaleSteps(src: Size, dst: Size, maxSide = SAFE_CANVAS_SIDE, maxPixels = SAFE_CANVAS_PIXELS): Size[] {
	const steps: Size[] = [];
	let w = src.width;
	let h = src.height;
	let guard = 0;
	while ((w > dst.width || h > dst.height) && guard++ < 32) {
		w = Math.max(dst.width, Math.ceil(w / 2));
		h = Math.max(dst.height, Math.ceil(h / 2));
		if (w === dst.width && h === dst.height) break;
		if (Math.max(w, h) <= maxSide && w * h <= maxPixels) steps.push({ width: w, height: h });
	}
	steps.push({ width: dst.width, height: dst.height });
	return steps;
}
