import type { ImageDataLike, Pt, Quad } from "./types";

/**
 * 3x3 projective transform (row-major, h[8] = 1) that maps each `src[i]` to `dst[i]`.
 * Solves the standard 8x8 linear system with Gaussian elimination and partial pivoting.
 * Throws when the points are degenerate (e.g. three collinear).
 */
export function homography(src: Quad, dst: Quad): number[] {
	const a: number[][] = [];
	for (let i = 0; i < 4; i++) {
		const { x, y } = src[i]!;
		const { x: u, y: v } = dst[i]!;
		a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}
	const n = 8;
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
		if (Math.abs(a[piv]![col]!) < 1e-12) throw new Error("degenerate homography");
		[a[col], a[piv]] = [a[piv]!, a[col]!];
		const pr = a[col]!;
		for (let r = col + 1; r < n; r++) {
			const row = a[r]!;
			const f = row[col]! / pr[col]!;
			if (f === 0) continue;
			for (let c = col; c <= n; c++) row[c]! -= f * pr[c]!;
		}
	}
	const h = new Array<number>(9).fill(1);
	for (let r = n - 1; r >= 0; r--) {
		const row = a[r]!;
		let s = row[n]!;
		for (let c = r + 1; c < n; c++) s -= row[c]! * h[c]!;
		h[r] = s / row[r]!;
	}
	h[8] = 1;
	return h;
}

export function applyHomography(h: readonly number[], x: number, y: number): Pt {
	const w = h[6]! * x + h[7]! * y + h[8]!;
	return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w };
}

function dist(a: Pt, b: Pt): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Output size for a rectified quad: average opposite side lengths, longest side capped at `maxSide`. */
export function outputSize(corners: Quad, maxSide: number): { width: number; height: number } {
	const [tl, tr, br, bl] = corners;
	let w = (dist(tl, tr) + dist(bl, br)) / 2;
	let h = (dist(tl, bl) + dist(tr, br)) / 2;
	const longest = Math.max(w, h);
	if (longest > maxSide) {
		const k = maxSide / longest;
		w *= k;
		h *= k;
	}
	return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/**
 * Rectifies the quad `corners` (tl, tr, br, bl in source pixels) into an `outW` x `outH` image.
 * Inverse mapping with bilinear sampling; samples outside the source are clamped to the edge.
 */
export function warpPerspective(src: ImageDataLike, corners: Quad, outW: number, outH: number): ImageDataLike {
	const out = new Uint8ClampedArray(outW * outH * 4);
	const dst: Quad = [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }];
	const h = homography(dst, corners); // output pixel -> source pixel
	const { data, width: sw, height: sh } = src;
	const maxX = sw - 1;
	const maxY = sh - 1;
	let o = 0;
	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			const w = h[6]! * x + h[7]! * y + 1;
			let sx = (h[0]! * x + h[1]! * y + h[2]!) / w;
			let sy = (h[3]! * x + h[4]! * y + h[5]!) / w;
			sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
			sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			const x1 = x0 < maxX ? x0 + 1 : x0;
			const y1 = y0 < maxY ? y0 + 1 : y0;
			const fx = sx - x0;
			const fy = sy - y0;
			const i00 = (y0 * sw + x0) * 4;
			const i10 = (y0 * sw + x1) * 4;
			const i01 = (y1 * sw + x0) * 4;
			const i11 = (y1 * sw + x1) * 4;
			const w00 = (1 - fx) * (1 - fy);
			const w10 = fx * (1 - fy);
			const w01 = (1 - fx) * fy;
			const w11 = fx * fy;
			out[o++] = data[i00]! * w00 + data[i10]! * w10 + data[i01]! * w01 + data[i11]! * w11;
			out[o++] = data[i00 + 1]! * w00 + data[i10 + 1]! * w10 + data[i01 + 1]! * w01 + data[i11 + 1]! * w11;
			out[o++] = data[i00 + 2]! * w00 + data[i10 + 2]! * w10 + data[i01 + 2]! * w01 + data[i11 + 2]! * w11;
			out[o++] = 255;
		}
	}
	return { data: out, width: outW, height: outH };
}

/** Orders four points clockwise from the top-left: tl, tr, br, bl (screen coordinates, y down). */
export function orderCorners(points: readonly Pt[]): Quad {
	if (points.length !== 4) throw new Error("orderCorners needs exactly 4 points");
	const cx = points.reduce((s, p) => s + p.x, 0) / 4;
	const cy = points.reduce((s, p) => s + p.y, 0) / 4;
	// With y down, increasing atan2 goes clockwise on screen.
	const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
	let start = 0;
	for (let i = 1; i < 4; i++) if (sorted[i]!.x + sorted[i]!.y < sorted[start]!.x + sorted[start]!.y) start = i;
	return [sorted[start]!, sorted[(start + 1) % 4]!, sorted[(start + 2) % 4]!, sorted[(start + 3) % 4]!];
}

/** Rectangle inset by `fraction` of each side: the fallback when detection is unsure. */
export function insetQuad(width: number, height: number, fraction = 0.05): Quad {
	const dx = width * fraction;
	const dy = height * fraction;
	return [{ x: dx, y: dy }, { x: width - dx, y: dy }, { x: width - dx, y: height - dy }, { x: dx, y: height - dy }];
}

/** Rotates an image by 90 degrees (clockwise or counter-clockwise). */
export function rotate90(src: ImageDataLike, clockwise: boolean): ImageDataLike {
	const { width: w, height: h, data } = src;
	const out = new Uint8ClampedArray(data.length);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const nx = clockwise ? h - 1 - y : y;
			const ny = clockwise ? x : w - 1 - x;
			const s = (y * w + x) * 4;
			const d = (ny * h + nx) * 4;
			out[d] = data[s]!;
			out[d + 1] = data[s + 1]!;
			out[d + 2] = data[s + 2]!;
			out[d + 3] = data[s + 3]!;
		}
	}
	return { data: out, width: h, height: w };
}

/** Maps a point of a `width` x `height` image to its position after `rotate90`. */
export function rotatePoint90(p: Pt, width: number, height: number, clockwise: boolean): Pt {
	return clockwise ? { x: height - p.y, y: p.x } : { x: p.y, y: width - p.x };
}

function cross(o: Pt, a: Pt, b: Pt): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in math orientation. */
export function convexHull(points: readonly Pt[]): Pt[] {
	const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	if (pts.length < 3) return pts;
	const lower: Pt[] = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper: Pt[] = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i]!;
		while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
		upper.push(p);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
}

export function polygonArea(poly: readonly Pt[]): number {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i]!;
		const b = poly[(i + 1) % poly.length]!;
		s += a.x * b.y - b.x * a.y;
	}
	return Math.abs(s) / 2;
}
