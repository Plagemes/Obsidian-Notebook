// wave 0.9 (376): the content box of a PDF page (where its non-white pixels are), for the view-only "crop the white margins"
// toggle. Pure: works on an RGBA bitmap, so it is tested on synthetic bitmaps in Node. Nothing here changes a notebook.
import { elementBounds } from "../ink/elements";
import { strokeBounds } from "../ink/hit-test";
import type { Range } from "../ink/layout";
import { backgroundRect } from "../model/margins";
import type { Page } from "../model/types";

/** An RGBA bitmap, as `ImageData` (rows top to bottom, 4 bytes per pixel). */
export interface Bitmap {
	data: ArrayLike<number>;
	width: number;
	height: number;
}

/** A rectangle as fractions of the bitmap (0-1). */
export interface FractionBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DetectOptions {
	/** A channel at or above this is "white" (default 245: the grey of anti-aliasing and scan noise counts as paper). */
	white?: number;
	/** A row or column needs at least this many non-white pixels to count (default 2: a stray speck is not content). */
	minPixels?: number;
	/** Breathing room added around the content, as a fraction of the bitmap (default 0.02). */
	padding?: number;
	/** The box is never narrower / shorter than this share of the page (default 0.3 / 0.15), so a nearly empty page does not zoom absurdly. */
	minWidth?: number;
	minHeight?: number;
}

/**
 * The smallest box around the non-white pixels of `bitmap`, with some padding, as fractions of the bitmap; null when the
 * bitmap has no content (a blank page) or is empty. Transparent pixels count as white.
 */
export function detectContentBox(bitmap: Bitmap, options: DetectOptions = {}): FractionBox | null {
	const { width, height, data } = bitmap;
	if (!(width > 0) || !(height > 0) || data.length < width * height * 4) return null;
	const white = options.white ?? 245;
	const minPixels = Math.max(1, options.minPixels ?? 2);
	const rows = new Uint32Array(height);
	const cols = new Uint32Array(width);
	for (let y = 0; y < height; y++) {
		let i = y * width * 4;
		for (let x = 0; x < width; x++, i += 4) {
			if (data[i + 3]! < 16) continue;
			if (data[i]! < white || data[i + 1]! < white || data[i + 2]! < white) {
				rows[y]!++;
				cols[x]!++;
			}
		}
	}
	const first = (counts: Uint32Array): number => counts.findIndex((n) => n >= minPixels);
	const last = (counts: Uint32Array): number => {
		for (let i = counts.length - 1; i >= 0; i--) if (counts[i]! >= minPixels) return i;
		return -1;
	};
	const top = first(rows), bottom = last(rows), left = first(cols), right = last(cols);
	if (top < 0 || left < 0 || bottom < top || right < left) return null;
	const pad = options.padding ?? 0.02;
	const span = (lo: number, hi: number, size: number, min: number): [number, number] => {
		let a = Math.max(0, lo / size - pad);
		let b = Math.min(1, (hi + 1) / size + pad);
		if (b - a < min) {
			const mid = (a + b) / 2;
			a = Math.max(0, Math.min(1 - min, mid - min / 2));
			b = Math.min(1, a + min);
		}
		return [a, b];
	};
	const [x0, x1] = span(left, right, width, options.minWidth ?? 0.3);
	const [y0, y1] = span(top, bottom, height, options.minHeight ?? 0.15);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The horizontal window of a PDF page that the cropped view fits: its content box, widened to hold everything the reader
 * wrote or placed on the page (ink in the margin must stay reachable). Page coordinates, pt. Null: no window (the whole page).
 */
export function pageWindow(page: Page, box: FractionBox | null): Range | null {
	if (!box) return null;
	const bg = backgroundRect(page);
	let lo = bg.x + box.x * bg.width;
	let hi = lo + box.width * bg.width;
	for (const stroke of page.strokes) {
		if (stroke.points.length === 0) continue;
		const b = strokeBounds(stroke);
		lo = Math.min(lo, b.minX);
		hi = Math.max(hi, b.maxX);
	}
	for (const el of page.elements ?? []) {
		const b = elementBounds(el);
		lo = Math.min(lo, b.minX);
		hi = Math.max(hi, b.maxX);
	}
	lo = Math.max(0, lo);
	hi = Math.min(page.width, hi);
	return hi > lo ? { x: lo, width: hi - lo } : null;
}
