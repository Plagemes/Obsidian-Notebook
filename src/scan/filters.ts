import type { ImageDataLike, ScanFilter } from "./types";

export function toGray(img: ImageDataLike): Uint8ClampedArray {
	const { data, width, height } = img;
	const g = new Uint8ClampedArray(width * height);
	for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
	return g;
}

/** Box mean over a (2r+1) square window (clamped at the borders) using an integral image. */
function boxMean(values: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
	const stride = w + 1;
	const integral = new Float64Array(stride * (h + 1));
	for (let y = 0; y < h; y++) {
		let row = 0;
		for (let x = 0; x < w; x++) {
			row += values[y * w + x]!;
			integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + row;
		}
	}
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const y0 = Math.max(0, y - r);
		const y1 = Math.min(h, y + r + 1);
		for (let x = 0; x < w; x++) {
			const x0 = Math.max(0, x - r);
			const x1 = Math.min(w, x + r + 1);
			const sum = integral[y1 * stride + x1]! - integral[y0 * stride + x1]! - integral[y1 * stride + x0]! + integral[y0 * stride + x0]!;
			out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
		}
	}
	return out;
}

/** The unmodified photo (a copy, so callers may mutate the result). */
export function original(img: ImageDataLike): ImageDataLike {
	return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/**
 * Document filter: grayscale, then an adaptive threshold against the local mean (integral-image box filter).
 * Pixels clearly darker than their surroundings become black, the rest white; a short soft ramp
 * between the two keeps strokes anti-aliased instead of jagged.
 */
export function enhanceDocument(img: ImageDataLike): ImageDataLike {
	const { width: w, height: h } = img;
	const gray = toGray(img);
	const radius = Math.max(7, Math.floor(Math.min(w, h) / 20));
	const mean = boxMean(gray, w, h, radius);
	const out = new Uint8ClampedArray(w * h * 4);
	const LOW = 0.72; // ratio to the local mean at or below which a pixel is pure ink
	const HIGH = 0.9; // ratio at or above which a pixel is pure paper
	for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
		const ratio = gray[i]! / Math.max(1, mean[i]!);
		const t = Math.min(1, Math.max(0, (ratio - LOW) / (HIGH - LOW)));
		const v = t * t * (3 - 2 * t) * 255;
		out[o] = v;
		out[o + 1] = v;
		out[o + 2] = v;
		out[o + 3] = 255;
	}
	return { data: out, width: w, height: h };
}

/** Separable max filter of radius `r` over a grid. */
function dilate(grid: Float32Array, gw: number, gh: number, r: number): Float32Array {
	const tmp = new Float32Array(grid.length);
	for (let y = 0; y < gh; y++) {
		for (let x = 0; x < gw; x++) {
			let m = 0;
			for (let xx = Math.max(0, x - r); xx <= Math.min(gw - 1, x + r); xx++) m = Math.max(m, grid[y * gw + xx]!);
			tmp[y * gw + x] = m;
		}
	}
	const out = new Float32Array(grid.length);
	for (let y = 0; y < gh; y++) {
		for (let x = 0; x < gw; x++) {
			let m = 0;
			for (let yy = Math.max(0, y - r); yy <= Math.min(gh - 1, y + r); yy++) m = Math.max(m, tmp[yy * gw + x]!);
			out[y * gw + x] = m;
		}
	}
	return out;
}

/**
 * Whiteboard filter: estimates the lit background (coarse grid, grey dilation to drop strokes, blur),
 * divides every channel by it to remove shadows and glare, then lifts saturation slightly.
 */
export function enhanceWhiteboard(img: ImageDataLike): ImageDataLike {
	const { width: w, height: h, data } = img;
	const gray = toGray(img);
	const block = Math.max(2, Math.round(Math.max(w, h) / 160));
	const gw = Math.max(1, Math.ceil(w / block));
	const gh = Math.max(1, Math.ceil(h / block));
	const grid = new Float32Array(gw * gh);
	for (let gy = 0; gy < gh; gy++) {
		for (let gx = 0; gx < gw; gx++) {
			let s = 0;
			let n = 0;
			for (let y = gy * block; y < Math.min(h, (gy + 1) * block); y++) {
				for (let x = gx * block; x < Math.min(w, (gx + 1) * block); x++) {
					s += gray[y * w + x]!;
					n++;
				}
			}
			grid[gy * gw + gx] = s / n;
		}
	}
	const bg = boxMean(dilate(grid, gw, gh, 2), gw, gh, 2);

	const out = new Uint8ClampedArray(data.length);
	const SAT = 1.2;
	const WHITE = 0.96; // the background maps to pure white slightly below its estimated level
	for (let y = 0; y < h; y++) {
		// Bilinear sample of the background grid at the pixel centre.
		const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
		const y0 = Math.floor(fy);
		const y1 = Math.min(gh - 1, y0 + 1);
		const ty = fy - y0;
		for (let x = 0; x < w; x++) {
			const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
			const x0 = Math.floor(fx);
			const x1 = Math.min(gw - 1, x0 + 1);
			const tx = fx - x0;
			const b =
				(bg[y0 * gw + x0]! * (1 - tx) + bg[y0 * gw + x1]! * tx) * (1 - ty) +
				(bg[y1 * gw + x0]! * (1 - tx) + bg[y1 * gw + x1]! * tx) * ty;
			const k = 255 / (Math.max(8, b) * WHITE);
			const i = (y * w + x) * 4;
			const r = data[i]! * k;
			const g = data[i + 1]! * k;
			const bl = data[i + 2]! * k;
			const l = 0.299 * r + 0.587 * g + 0.114 * bl;
			out[i] = l + (r - l) * SAT;
			out[i + 1] = l + (g - l) * SAT;
			out[i + 2] = l + (bl - l) * SAT;
			out[i + 3] = 255;
		}
	}
	return { data: out, width: w, height: h };
}

export function applyFilter(img: ImageDataLike, filter: ScanFilter): ImageDataLike {
	if (filter === "document") return enhanceDocument(img);
	if (filter === "whiteboard") return enhanceWhiteboard(img);
	return original(img);
}
