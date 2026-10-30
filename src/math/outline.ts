/**
 * Vector outlines of typeset equations (#110). The view typesets the LaTeX with Obsidian's MathJax and paints it
 * into a coverage raster; `traceCoverage` turns that raster into closed polygons (marching squares at half coverage,
 * then simplified), stored as a compact path in the element (`EquationElement.outline`): absolute `M x y`, `L x y`
 * and `Z` commands in pt relative to the element's top-left corner, filled with the even-odd rule. The canvas, the
 * PDF and SVG exports and "Convert to ink" all read this path, so none of them needs MathJax. Pure.
 */
import { contours, simplify, type Pt } from "./contour";

export type Polygon = Pt[];

const fmt = (n: number): string => {
	const r = Math.round(n * 100) / 100;
	return Object.is(r, -0) ? "0" : String(r);
};

/** The path text of closed polygons (each needs at least three points). */
export function formatOutline(polys: readonly (readonly Pt[])[]): string {
	let out = "";
	for (const p of polys) {
		if (p.length < 3) continue;
		out += `M${fmt(p[0]![0])} ${fmt(p[0]![1])}`;
		for (let i = 1; i < p.length; i++) out += `L${fmt(p[i]![0])} ${fmt(p[i]![1])}`;
		out += "Z";
	}
	return out;
}

/**
 * Polygons of an outline path, or null when the text is not exactly the grammar `formatOutline` writes (every
 * subpath `M x y`, then `L x y`…, then `Z`; finite numbers). Hand-written scanner: linear, no regular expression
 * backtracking on long input.
 */
export function parseOutline(d: string): Polygon[] | null {
	const polys: Polygon[] = [];
	let i = 0;
	const n = d.length;
	const num = (): number | null => {
		const start = i;
		if (d[i] === "-") i++;
		const digits = i;
		while (i < n && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) i++;
		if (i === digits) return null;
		if (d[i] === ".") {
			i++;
			const frac = i;
			while (i < n && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) i++;
			if (i === frac) return null;
		}
		const v = Number(d.slice(start, i));
		return Number.isFinite(v) ? v : null;
	};
	const pair = (): Pt | null => {
		const x = num();
		if (x === null || d[i] !== " ") return null;
		i++;
		const y = num();
		return y === null ? null : [x, y];
	};
	while (i < n) {
		if (d[i] !== "M") return null;
		i++;
		const first = pair();
		if (!first) return null;
		const poly: Polygon = [first];
		while (d[i] === "L") {
			i++;
			const p = pair();
			if (!p) return null;
			poly.push(p);
		}
		if (d[i] !== "Z" || poly.length < 3) return null;
		i++;
		polys.push(poly);
	}
	return polys;
}

/** Bounding box of an outline, or null when empty. */
export function outlineBounds(polys: readonly Polygon[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of polys) for (const [x, y] of p) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** The outline scaled by (sx, sy) about its origin (the element's top-left corner); null if the text is invalid. */
export function scaleOutline(d: string, sx: number, sy: number): string | null {
	const polys = parseOutline(d);
	if (!polys) return null;
	return formatOutline(polys.map((p) => p.map(([x, y]): Pt => [x * sx, y * sy])));
}

/**
 * Closed polygons where `coverage` (0–255, row-major, `width` × `height` pixels) is at least half, in pt: pixel
 * (i, j) covers [i, i + 1] × [j, j + 1] / `pxPerPt`. The raster is padded with an empty border so every contour
 * closes. `tolerance` (pt) simplifies the polygons.
 */
export function traceCoverage(coverage: ArrayLike<number>, width: number, height: number, pxPerPt: number, tolerance = 0.04): Polygon[] {
	const nx = width + 2;
	const ny = height + 2;
	const values = new Float32Array(nx * ny);
	for (let j = 0; j < height; j++) {
		for (let i = 0; i < width; i++) values[(j + 1) * nx + i + 1] = coverage[j * width + i]! / 255;
	}
	const lines = contours({ nx, ny, values }, 0.5);
	const out: Polygon[] = [];
	for (const line of lines) {
		// Grid point (gi, gj) is the centre of pixel (gi − 1, gj − 1): x = (gi − 0.5) / pxPerPt.
		const pts = line.map(([gi, gj]): Pt => [(gi - 0.5) / pxPerPt, (gj - 0.5) / pxPerPt]);
		if (pts.length > 1) {
			const a = pts[0]!;
			const b = pts[pts.length - 1]!;
			if (a[0] === b[0] && a[1] === b[1]) pts.pop();
		}
		const simple = simplify([...pts, pts[0]!], tolerance);
		simple.pop();
		if (simple.length >= 3 && Math.abs(polygonArea(simple)) > 1e-4) out.push(simple);
	}
	return out;
}

/** Signed area (shoelace). */
export function polygonArea(p: readonly Pt[]): number {
	let a = 0;
	for (let i = 0; i < p.length; i++) {
		const [x1, y1] = p[i]!;
		const [x2, y2] = p[(i + 1) % p.length]!;
		a += x1 * y2 - x2 * y1;
	}
	return a / 2;
}

/**
 * Coverage raster of polygons filled with the even-odd rule, `pxPerPt` pixels per pt, over the box `width` × `height`
 * pt from the origin: 1 inside, 0 outside (sampled at pixel centres). Used to convert an outline to ink.
 */
export function rasterize(polys: readonly Polygon[], width: number, height: number, pxPerPt: number): { data: Uint8Array; w: number; h: number } {
	const w = Math.max(1, Math.ceil(width * pxPerPt));
	const h = Math.max(1, Math.ceil(height * pxPerPt));
	const data = new Uint8Array(w * h);
	const edges: Array<[number, number, number, number]> = [];
	for (const p of polys) {
		for (let i = 0; i < p.length; i++) {
			const a = p[i]!;
			const b = p[(i + 1) % p.length]!;
			if (a[1] !== b[1]) edges.push([a[0] * pxPerPt, a[1] * pxPerPt, b[0] * pxPerPt, b[1] * pxPerPt]);
		}
	}
	const xs: number[] = [];
	for (let j = 0; j < h; j++) {
		const y = j + 0.5;
		xs.length = 0;
		for (const [x1, y1, x2, y2] of edges) {
			if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
		}
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
			const to = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
			for (let i = from; i <= to; i++) data[j * w + i] = 1;
		}
	}
	return { data, w, h };
}
