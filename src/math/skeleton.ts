/**
 * "Convert to ink" for equations (#110): the filled glyph outline becomes pen-like strokes along the middle of each
 * glyph stroke, as wide as the glyph there, so the result can be erased, recoloured or tweaked like handwriting.
 * The outline is rasterised, thinned (Zhang–Suen) and the skeleton is followed from end points and junctions into
 * polylines; a chamfer distance transform gives the width. Pure: no 'obsidian', no DOM.
 */
import { simplify, type Pt } from "./contour";
import { parseOutline, rasterize } from "./outline";

export interface InkPath {
	/** Points in pt relative to the equation's top-left corner. */
	points: Pt[];
	/** Stroke width, pt. */
	width: number;
}

/** Zhang–Suen thinning of a binary image (1 = ink), in place. */
export function thin(img: Uint8Array, w: number, h: number): void {
	const at = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : img[j * w + i]!);
	const remove: number[] = [];
	for (let changed = true, guard = 0; changed && guard < 500; guard++) {
		changed = false;
		for (const pass of [0, 1]) {
			remove.length = 0;
			for (let j = 0; j < h; j++) {
				for (let i = 0; i < w; i++) {
					if (!img[j * w + i]) continue;
					const p2 = at(i, j - 1), p3 = at(i + 1, j - 1), p4 = at(i + 1, j), p5 = at(i + 1, j + 1);
					const p6 = at(i, j + 1), p7 = at(i - 1, j + 1), p8 = at(i - 1, j), p9 = at(i - 1, j - 1);
					const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
					if (b < 2 || b > 6) continue;
					const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
					let a = 0;
					for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
					if (a !== 1) continue;
					if (pass === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
					remove.push(j * w + i);
				}
			}
			for (const k of remove) img[k] = 0;
			if (remove.length > 0) changed = true;
		}
	}
}

/** Chamfer (3-4) distance to the nearest background pixel, in pixels. */
export function distanceTransform(img: Uint8Array, w: number, h: number): Float32Array {
	const big = 1e9;
	const d = new Float32Array(w * h);
	for (let k = 0; k < w * h; k++) d[k] = img[k] ? big : 0;
	const get = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : d[j * w + i]!);
	for (let j = 0; j < h; j++) {
		for (let i = 0; i < w; i++) {
			const k = j * w + i;
			if (!d[k]) continue;
			d[k] = Math.min(d[k], get(i - 1, j) + 3, get(i, j - 1) + 3, get(i - 1, j - 1) + 4, get(i + 1, j - 1) + 4);
		}
	}
	for (let j = h - 1; j >= 0; j--) {
		for (let i = w - 1; i >= 0; i--) {
			const k = j * w + i;
			if (!d[k]) continue;
			d[k] = Math.min(d[k], get(i + 1, j) + 3, get(i, j + 1) + 3, get(i + 1, j + 1) + 4, get(i - 1, j + 1) + 4);
		}
	}
	for (let k = 0; k < w * h; k++) d[k] = d[k]! / 3;
	return d;
}

/** Orthogonal neighbours first: a walk along a staircase of pixels takes every step instead of cutting corners. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
/** The eight neighbours in circular order, for counting background → ink transitions. */
const RING: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/**
 * Polylines (as pixel index lists) of a one-pixel-wide skeleton: from end points and junctions (pixels whose
 * neighbourhood is not one contiguous arc), then the loops that are left. Every skeleton pixel is on one path.
 */
export function traceSkeleton(img: Uint8Array, w: number, h: number): number[][] {
	const on = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && img[j * w + i] === 1;
	/** Number of background → ink transitions around a pixel: 1 at an end, 2 along a line, 3 or more at a junction. */
	const transitions = new Uint8Array(w * h);
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
		if (!on(i, j)) continue;
		let a = 0;
		for (let k = 0; k < 8; k++) {
			const [dx, dy] = RING[k]!;
			const [ex, ey] = RING[(k + 1) % 8]!;
			if (!on(i + dx, j + dy) && on(i + ex, j + ey)) a++;
		}
		transitions[j * w + i] = a;
	}
	const node = (k: number) => transitions[k] !== 2;
	const seen = new Set<number>();
	const visited = new Uint8Array(w * h);
	const linkKey = (a: number, b: number) => (a < b ? a * w * h + b : b * w * h + a);
	const paths: number[][] = [];
	const neighbours = (k: number): number[] => {
		const i = k % w;
		const j = (k - i) / w;
		const out: number[] = [];
		for (const [dx, dy] of NEIGHBOURS) if (on(i + dx, j + dy)) out.push((j + dy) * w + i + dx);
		return out;
	};
	const walk = (from: number, first: number): number[] => {
		const path = [from, first];
		seen.add(linkKey(from, first));
		visited[from] = 1;
		let prev = from;
		let cur = first;
		while (!node(cur) && !visited[cur]) {
			visited[cur] = 1;
			const next = neighbours(cur).find((n) => n !== prev && !seen.has(linkKey(cur, n)));
			if (next === undefined) break;
			seen.add(linkKey(cur, next));
			path.push(next);
			prev = cur;
			cur = next;
		}
		visited[cur] = 1;
		return path;
	};
	for (let k = 0; k < w * h; k++) {
		if (img[k] !== 1 || !node(k)) continue;
		if (transitions[k] === 0 && neighbours(k).length === 0) {
			visited[k] = 1;
			paths.push([k]);
			continue;
		}
		for (const n of neighbours(k)) if (!seen.has(linkKey(k, n)) && !(visited[n] && !node(n))) paths.push(walk(k, n));
	}
	// Loops (an "o", a "0") have no end and no junction: start anywhere not yet on a path.
	for (let k = 0; k < w * h; k++) {
		if (img[k] !== 1 || visited[k]) continue;
		const n = neighbours(k).find((x) => !seen.has(linkKey(k, x)));
		if (n === undefined) {
			visited[k] = 1;
			paths.push([k]);
			continue;
		}
		const p = walk(k, n);
		if (p[p.length - 1] !== k && neighbours(p[p.length - 1]!).includes(k)) p.push(k);
		paths.push(p);
	}
	return paths;
}

/** Strokes for an equation outline (`outline` in pt relative to the element), `pxPerPt` raster resolution. */
export function outlineToInk(outline: string, width: number, height: number, pxPerPt = 6): InkPath[] {
	const polys = parseOutline(outline);
	if (!polys || polys.length === 0) return [];
	const { data, w, h } = rasterize(polys, width, height, pxPerPt);
	const dist = distanceTransform(data, w, h);
	thin(data, w, h);
	const paths = traceSkeleton(data, w, h);
	const out: InkPath[] = [];
	const median = (xs: number[]) => {
		const s = xs.slice().sort((a, b) => a - b);
		return s[Math.floor(s.length / 2)] ?? 1;
	};
	const toPt = (k: number): Pt => [((k % w) + 0.5) / pxPerPt, (Math.floor(k / w) + 0.5) / pxPerPt];
	// Widths of whole components decide which short branches are spurs of thinning (corners of thick strokes).
	const widthOf = (p: number[]) => Math.max(1, 2 * median(p.map((k) => dist[k]!)) - 1);
	for (const p of paths) {
		const px = widthOf(p);
		const endA = degreeOf(data, w, h, p[0]!) <= 1;
		const endB = degreeOf(data, w, h, p[p.length - 1]!) <= 1;
		// A short branch that ends in the open on one side and at a junction on the other is a thinning spur.
		if (p.length > 1 && endA !== endB && p.length < px * 0.9) continue;
		const pts = simplify(p.map(toPt), 0.06);
		out.push({ points: pts, width: Math.max(0.3, Math.round((px / pxPerPt) * 100) / 100) });
	}
	return out;
}

function degreeOf(img: Uint8Array, w: number, h: number, k: number): number {
	const i = k % w;
	const j = (k - i) / w;
	let n = 0;
	for (const [dx, dy] of NEIGHBOURS) {
		const x = i + dx, y = j + dy;
		if (x >= 0 && y >= 0 && x < w && y < h && img[y * w + x] === 1) n++;
	}
	return n;
}
