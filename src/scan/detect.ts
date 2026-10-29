import { convexHull, orderCorners, polygonArea } from "./geometry";
import type { Pt, Quad } from "./types";

const WORK_SIDE = 256;
const MIN_AREA_FRACTION = 0.15;
const MAX_AREA_FRACTION = 0.97;
const MIN_FILL = 0.8;
const MIN_CONTRAST = 20;

/** Box-average downscale of an 8-bit gray image so the long side is at most `maxSide`. */
function downscale(gray: ArrayLike<number>, w: number, h: number, maxSide: number): { data: Float32Array; w: number; h: number } {
	const scale = Math.max(1, Math.max(w, h) / maxSide);
	const nw = Math.max(1, Math.round(w / scale));
	const nh = Math.max(1, Math.round(h / scale));
	const data = new Float32Array(nw * nh);
	for (let y = 0; y < nh; y++) {
		const y0 = Math.floor((y * h) / nh);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
		for (let x = 0; x < nw; x++) {
			const x0 = Math.floor((x * w) / nw);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
			let s = 0;
			for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += gray[yy * w + xx]!;
			data[y * nw + x] = s / ((y1 - y0) * (x1 - x0));
		}
	}
	return { data, w: nw, h: nh };
}

function boxBlur3(src: Float32Array, w: number, h: number): Float32Array {
	const out = new Float32Array(src.length);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let s = 0;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= h) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= w) continue;
					s += src[yy * w + xx]!;
					n++;
				}
			}
			out[y * w + x] = s / n;
		}
	}
	return out;
}

/** Otsu threshold over 0..255 values, plus the mean of each class. */
function otsu(values: Float32Array): { threshold: number; lowMean: number; highMean: number } {
	const hist = new Float64Array(256);
	for (const v of values) hist[Math.min(255, Math.max(0, Math.round(v)))]!++;
	const total = values.length;
	let sumAll = 0;
	for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;
	let wB = 0;
	let sumB = 0;
	let best = -1;
	let threshold = 128;
	for (let t = 0; t < 256; t++) {
		wB += hist[t]!;
		if (wB === 0) continue;
		const wF = total - wB;
		if (wF === 0) break;
		sumB += t * hist[t]!;
		const mB = sumB / wB;
		const mF = (sumAll - sumB) / wF;
		const between = wB * wF * (mB - mF) * (mB - mF);
		if (between > best) {
			best = between;
			threshold = t;
		}
	}
	let lo = 0;
	let loN = 0;
	let hi = 0;
	let hiN = 0;
	for (const v of values) {
		if (v <= threshold) {
			lo += v;
			loN++;
		} else {
			hi += v;
			hiN++;
		}
	}
	return { threshold, lowMean: loN ? lo / loN : 0, highMean: hiN ? hi / hiN : 255 };
}

/** Largest 4-connected component of `mask`; returns its pixel indices (empty if none). */
function largestComponent(mask: Uint8Array, w: number, h: number): number[] {
	const seen = new Uint8Array(mask.length);
	const stack: number[] = [];
	let best: number[] = [];
	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || seen[start]) continue;
		const comp: number[] = [];
		seen[start] = 1;
		stack.push(start);
		while (stack.length) {
			const i = stack.pop()!;
			comp.push(i);
			const x = i % w;
			const y = (i - x) / w;
			if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
			if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
			if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
			if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
		}
		if (comp.length > best.length) best = comp;
	}
	return best;
}

/** Picks the 4 hull vertices of (locally) maximal area, starting from the diagonal extremes. */
function fitQuad(hull: Pt[]): Pt[] {
	let tl = hull[0]!;
	let br = hull[0]!;
	let tr = hull[0]!;
	let bl = hull[0]!;
	for (const p of hull) {
		if (p.x + p.y < tl.x + tl.y) tl = p;
		if (p.x + p.y > br.x + br.y) br = p;
		if (p.x - p.y > tr.x - tr.y) tr = p;
		if (p.x - p.y < bl.x - bl.y) bl = p;
	}
	const q = [tl, tr, br, bl];
	// Coordinate descent: move each vertex to the hull point that maximizes the quad area.
	for (let iter = 0; iter < 8; iter++) {
		let changed = false;
		for (let k = 0; k < 4; k++) {
			let bestP = q[k]!;
			let bestA = polygonArea(q);
			for (const p of hull) {
				const trial = q.slice();
				trial[k] = p;
				const a = polygonArea(trial);
				if (a > bestA + 1e-9) {
					bestA = a;
					bestP = p;
				}
			}
			if (bestP !== q[k]) {
				q[k] = bestP;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return q;
}

/**
 * Cheap automatic page-corner guess on an 8-bit gray image (w * h values).
 * Downscales to ~256 px, blurs, splits bright/dark with Otsu and takes the largest bright blob.
 * Returns corners (tl, tr, br, bl) in the input's pixel coordinates, or null when unsure.
 */
export function detectDocument(gray: ArrayLike<number>, w: number, h: number): Quad | null {
	if (w < 8 || h < 8 || gray.length < w * h) return null;
	const small = downscale(gray, w, h, WORK_SIDE);
	const blurred = boxBlur3(boxBlur3(small.data, small.w, small.h), small.w, small.h);
	const { threshold, lowMean, highMean } = otsu(blurred);
	if (highMean - lowMean < MIN_CONTRAST) return null;
	const mask = new Uint8Array(blurred.length);
	for (let i = 0; i < blurred.length; i++) mask[i] = blurred[i]! > threshold ? 1 : 0;
	const comp = largestComponent(mask, small.w, small.h);
	const frac = comp.length / (small.w * small.h);
	if (frac < MIN_AREA_FRACTION || frac > MAX_AREA_FRACTION) return null;

	// Hull of the boundary pixels' corner points.
	const sw = small.w;
	const pts: Pt[] = [];
	for (const i of comp) {
		const x = i % sw;
		const y = (i - x) / sw;
		const edge = x === 0 || y === 0 || x === sw - 1 || y === small.h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - sw] || !mask[i + sw];
		if (!edge) continue;
		pts.push({ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 });
	}
	const hull = convexHull(pts);
	if (hull.length < 4) return null;
	const quad = fitQuad(hull);
	const qa = polygonArea(quad);
	const ha = polygonArea(hull);
	if (qa < MIN_AREA_FRACTION * sw * small.h || ha <= 0 || qa / ha < MIN_FILL) return null;
	// The blob itself must fill most of the quad, otherwise it is not page-shaped.
	if (comp.length / qa < 0.7) return null;

	const sx = w / sw;
	const sy = h / small.h;
	const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
	return orderCorners(quad.map((p) => ({ x: clamp(p.x * sx, w - 1), y: clamp(p.y * sy, h - 1) })));
}
