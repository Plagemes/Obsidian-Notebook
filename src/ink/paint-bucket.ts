// 0.28 (#184): the paint bucket. Pure geometry, no 'obsidian' and no canvas: the view draws the ink of the page into a low resolution mask,
// and this file does the rest: it closes small gaps, floods the area under the tap, and turns the area into a simplified polygon in PAGE
// coordinates (pt). The stored result is that polygon (a filled shape stroke), never a bitmap.
//
// Everything is bounded: the mask has a capped number of cells, the flood runs against a time budget and stops at the first contact with the
// edge of the mask, and the outline is simplified to a capped number of points. It runs once per tap, never on the frame path.
import { RENDER_FREEHAND, type Point, type Stroke } from "../model/types";
import { isFilled } from "./shape-style";

/**
 * Width (pt) of the line of a bucket fill. The shape is drawn as a fill with a hairline in the fill colour; the polygon runs under the ink, so
 * the hairline is hidden. A shape this thin that has a fill is how the paint bucket recognises its own fills (see `isBucketFill`).
 */
export const BUCKET_LINE_WIDTH = 0.25;
/** Most cells of the mask (the mask is the page, or a window around the tap on a very large page). */
export const MAX_CELLS = 2_000_000;
/** Highest resolution (cells per pt). */
export const MAX_SCALE = 4;
/** Lowest resolution at which a whole page is used; below it the mask is a window around the tap. */
export const MIN_SCALE = 1.5;
/** Resolution (cells per pt) of the window around the tap on a very large page. */
export const WINDOW_SCALE = 2;
/** Gaps in the outline up to about this wide (pt) are closed. */
export const GAP_PT = 1.5;
/** Ink is a cell whose coverage is at least this (0-255 alpha). */
export const ALPHA_THRESHOLD = 48;
/** Smallest area worth filling (pt squared). */
export const MIN_AREA_PT2 = 6;
/** A fill larger than this share of the mask is the paper, not an area (a frame drawn around the page edge). */
export const MAX_SHARE = 0.85;
/** The outline has at most this many points. */
export const MAX_POINTS = 400;
/** Default time budget of the flood (ms). */
export const BUDGET_MS = 400;

export type BucketFailure = "open" | "onInk" | "tooBig" | "tooSmall" | "busy";

export type BucketResult = { ok: true; points: Point[]; area: number } | { ok: false; reason: BucketFailure };

/** The part of the page that is rasterised: origin and size in pt, and the resolution. */
export interface BucketWindow {
	x: number;
	y: number;
	/** pt */
	width: number;
	height: number;
	/** Cells per pt. */
	scale: number;
	cols: number;
	rows: number;
}

/** The page, or a window around (x, y) when the page is too large to rasterise whole. */
export function bucketWindow(pageWidth: number, pageHeight: number, x: number, y: number): BucketWindow {
	const w = Math.max(1, pageWidth), h = Math.max(1, pageHeight);
	const whole = Math.min(MAX_SCALE, Math.sqrt(MAX_CELLS / (w * h)));
	if (whole >= MIN_SCALE) {
		const scale = Math.floor(whole * 100) / 100;
		return { x: 0, y: 0, width: w, height: h, scale, cols: Math.max(1, Math.floor(w * scale)), rows: Math.max(1, Math.floor(h * scale)) };
	}
	const scale = WINDOW_SCALE;
	const side = Math.floor(Math.sqrt(MAX_CELLS) / scale);
	const ww = Math.min(w, side), wh = Math.min(h, side);
	const x0 = Math.min(Math.max(0, x - ww / 2), w - ww), y0 = Math.min(Math.max(0, y - wh / 2), h - wh);
	return { x: x0, y: y0, width: ww, height: wh, scale, cols: Math.max(1, Math.floor(ww * scale)), rows: Math.max(1, Math.floor(wh * scale)) };
}

/** 1 where the coverage (alpha channel of RGBA data) reaches the threshold. */
export function maskFromAlpha(rgba: ArrayLike<number>, cols: number, rows: number, threshold = ALPHA_THRESHOLD): Uint8Array {
	const out = new Uint8Array(cols * rows);
	for (let i = 0; i < out.length; i++) if ((rgba[i * 4 + 3] ?? 0) >= threshold) out[i] = 1;
	return out;
}

/** Grows every 1 of `mask` by `r` cells in each direction (a square, two linear passes). Returns a new mask. */
export function dilate(mask: Uint8Array, cols: number, rows: number, r: number): Uint8Array {
	if (r <= 0) return mask.slice();
	const tmp = new Uint8Array(mask.length);
	// Horizontal: distance to the last 1 on the left / the next 1 on the right.
	for (let y = 0; y < rows; y++) {
		const row = y * cols;
		let last = -Infinity;
		for (let x = 0; x < cols; x++) {
			if (mask[row + x]) last = x;
			if (x - last <= r) tmp[row + x] = 1;
		}
		last = Infinity;
		for (let x = cols - 1; x >= 0; x--) {
			if (mask[row + x]) last = x;
			if (last - x <= r) tmp[row + x] = 1;
		}
	}
	const out = new Uint8Array(mask.length);
	for (let x = 0; x < cols; x++) {
		let last = -Infinity;
		for (let y = 0; y < rows; y++) {
			if (tmp[y * cols + x]) last = y;
			if (y - last <= r) out[y * cols + x] = 1;
		}
		last = Infinity;
		for (let y = rows - 1; y >= 0; y--) {
			if (tmp[y * cols + x]) last = y;
			if (last - y <= r) out[y * cols + x] = 1;
		}
	}
	return out;
}

export type FloodResult =
	| { kind: "region"; region: Uint8Array; count: number }
	| { kind: "open" }
	| { kind: "onInk" }
	| { kind: "busy" };

/**
 * Fills the 4-connected free area around (sx, sy) in `blocked` (1 = wall). Stops at once when the area touches the edge of the mask ("open"),
 * and when `now()` passes `deadline` ("busy"). A seed on a wall moves to the nearest free cell within `reach` cells (the band the gap tolerance
 * added around the ink); further than that it is "onInk".
 */
export function floodRegion(
	blocked: Uint8Array, cols: number, rows: number, sx: number, sy: number, reach: number, now: () => number, deadline: number,
): FloodResult {
	let x0 = Math.floor(sx), y0 = Math.floor(sy);
	if (x0 < 0 || y0 < 0 || x0 >= cols || y0 >= rows) return { kind: "open" };
	if (blocked[y0 * cols + x0]) {
		const found = nearestFree(blocked, cols, rows, x0, y0, reach);
		if (!found) return { kind: "onInk" };
		[x0, y0] = found;
	}
	const region = new Uint8Array(blocked.length);
	// Scanline fill: the stack holds the start cell of spans still to be explored.
	let stack = new Int32Array(1024);
	let top = 0;
	const push = (x: number, y: number): void => {
		if (top + 2 > stack.length) {
			const bigger = new Int32Array(stack.length * 2);
			bigger.set(stack);
			stack = bigger;
		}
		stack[top++] = x;
		stack[top++] = y;
	};
	push(x0, y0);
	let count = 0;
	let tick = 0;
	while (top > 0) {
		const y = stack[--top]!;
		const x = stack[--top]!;
		if (region[y * cols + x] || blocked[y * cols + x]) continue;
		if ((++tick & 255) === 0 && now() > deadline) return { kind: "busy" };
		let xl = x, xr = x;
		while (xl > 0 && !blocked[y * cols + xl - 1] && !region[y * cols + xl - 1]) xl--;
		while (xr < cols - 1 && !blocked[y * cols + xr + 1] && !region[y * cols + xr + 1]) xr++;
		if (xl === 0 || xr === cols - 1 || y === 0 || y === rows - 1) return { kind: "open" };
		for (let i = xl; i <= xr; i++) region[y * cols + i] = 1;
		count += xr - xl + 1;
		for (const ny of [y - 1, y + 1]) {
			let inSpan = false;
			for (let i = xl; i <= xr; i++) {
				const free = !blocked[ny * cols + i] && !region[ny * cols + i];
				if (free && !inSpan) push(i, ny);
				inSpan = free;
			}
		}
	}
	return { kind: "region", region, count };
}

function nearestFree(blocked: Uint8Array, cols: number, rows: number, x: number, y: number, reach: number): [number, number] | null {
	for (let d = 1; d <= reach; d++) {
		for (let dy = -d; dy <= d; dy++) {
			for (let dx = -d; dx <= d; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
				if (!blocked[ny * cols + nx]) return [nx, ny];
			}
		}
	}
	return null;
}

/**
 * The outer outline of a region as the corners of its cells (integer cell-corner coordinates, clockwise on screen, no repeated point).
 * Holes are not part of it. `region` must be one 4-connected area (a flood result).
 */
export function traceOutline(region: Uint8Array, cols: number, rows: number): Array<[number, number]> {
	const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < cols && y < rows && region[y * cols + x] === 1;
	let start = -1;
	for (let i = 0; i < region.length; i++) {
		if (region[i]) {
			start = i;
			break;
		}
	}
	if (start < 0) return [];
	const sx = start % cols, sy = Math.floor(start / cols);
	// Directions: 0 east, 1 south, 2 west, 3 north. The region is on the right hand.
	const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
	// Start at the top-left corner of the first cell as if arriving along its left edge (heading north): the first decision turns east.
	let cx = sx, cy = sy, d = 3;
	const out: Array<[number, number]> = [];
	const limit = 4 * (cols + 1) * (rows + 1) + 8;
	for (let step = 0; step < limit; step++) {
		// The cells ahead of the corner, to the left and to the right of the walk.
		let l: boolean, r: boolean;
		if (d === 0) { l = inside(cx, cy - 1); r = inside(cx, cy); }
		else if (d === 1) { l = inside(cx, cy); r = inside(cx - 1, cy); }
		else if (d === 2) { l = inside(cx - 1, cy); r = inside(cx - 1, cy - 1); }
		else { l = inside(cx - 1, cy - 1); r = inside(cx, cy - 1); }
		const nd = l ? (d + 3) % 4 : r ? d : (d + 1) % 4;
		if (nd !== d) out.push([cx, cy]);
		d = nd;
		cx += DX[d]!;
		cy += DY[d]!;
		// Back at the start corner, arriving along the left edge of the first cell (heading north): the loop is closed.
		if (cx === sx && cy === sy && d === 3) break;
	}
	return dedupe(out);
}

function dedupe(points: Array<[number, number]>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
	}
	if (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
	return out;
}

/** Douglas-Peucker on an open run of `pts` between indices a and b (inclusive); marks the points to keep. */
function dpMark(pts: ReadonlyArray<readonly [number, number]>, a: number, b: number, eps: number, keep: Uint8Array): void {
	const stack: Array<[number, number]> = [[a, b]];
	while (stack.length > 0) {
		const [i, j] = stack.pop()!;
		if (j <= i + 1) continue;
		const [ax, ay] = pts[i]!;
		const [bx, by] = pts[j]!;
		const dx = bx - ax, dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let worst = -1, at = -1;
		for (let k = i + 1; k < j; k++) {
			const [px, py] = pts[k]!;
			let dist: number;
			if (len2 === 0) dist = Math.hypot(px - ax, py - ay);
			else {
				const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
				dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			}
			if (dist > worst) { worst = dist; at = k; }
		}
		if (worst > eps) {
			keep[at] = 1;
			stack.push([i, at], [at, j]);
		}
	}
}

/** A closed polygon (no repeated end point) reduced to within `eps` of the original. */
export function simplifyClosed(pts: ReadonlyArray<readonly [number, number]>, eps: number): Array<[number, number]> {
	const n = pts.length;
	if (n <= 3) return pts.map((p) => [p[0], p[1]] as [number, number]);
	// Split the ring at point 0 and at the point farthest from it, and simplify each half.
	let far = 1, best = -1;
	for (let i = 1; i < n; i++) {
		const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]);
		if (d > best) { best = d; far = i; }
	}
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[far] = 1;
	dpMark(pts, 0, far, eps, keep);
	const second = [...pts.slice(far), pts[0]!];
	const keep2 = new Uint8Array(second.length);
	dpMark(second, 0, second.length - 1, eps, keep2);
	const out: Array<[number, number]> = [];
	for (let i = 0; i <= far; i++) if (keep[i]) out.push([pts[i]![0], pts[i]![1]]);
	for (let k = 1; k < second.length - 1; k++) if (keep2[k]) out.push([second[k]![0], second[k]![1]]);
	return out;
}

/** The outline simplified to at most `max` points (the tolerance grows until it fits). */
export function simplifyTo(pts: ReadonlyArray<readonly [number, number]>, eps: number, max: number): Array<[number, number]> {
	let e = eps;
	let out = simplifyClosed(pts, e);
	for (let guard = 0; out.length > max && guard < 40; guard++) {
		e *= 1.5;
		out = simplifyClosed(pts, e);
	}
	return out;
}

/** Shoelace area (absolute) of a polygon. */
export function polygonArea(pts: ReadonlyArray<readonly [number, number]>): number {
	let a = 0;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]![0] + pts[i]![0]) * (pts[j]![1] - pts[i]![1]);
	return Math.abs(a) / 2;
}

export interface BucketInput {
	/** 1 = ink, one byte per cell, `cols * rows` cells, row by row. */
	mask: Uint8Array;
	cols: number;
	rows: number;
	/** Cells per pt, and the page position (pt) of the top-left corner of the mask. */
	scale: number;
	originX: number;
	originY: number;
	/** The tap, in page coordinates (pt). */
	x: number;
	y: number;
	/** Gaps up to this wide (pt) are closed. */
	gap?: number;
	/** Clock for the time budget (ms), and the budget. */
	now?: () => number;
	budget?: number;
}

/** Fills the area under the tap: the polygon (closed: it ends at its first point) in page coordinates, or why not. */
export function paintBucket(input: BucketInput): BucketResult {
	const { mask, cols, rows, scale } = input;
	const now = input.now ?? (() => Date.now());
	const deadline = now() + (input.budget ?? BUDGET_MS);
	const r = Math.max(0, Math.round((input.gap ?? GAP_PT) * scale));
	const sx = (input.x - input.originX) * scale, sy = (input.y - input.originY) * scale;
	const ix = Math.floor(sx), iy = Math.floor(sy);
	if (ix >= 0 && iy >= 0 && ix < cols && iy < rows && mask[iy * cols + ix]) return { ok: false, reason: "onInk" };
	const walls = r > 0 ? dilate(mask, cols, rows, r) : mask;
	if (now() > deadline) return { ok: false, reason: "busy" };
	const flood = floodRegion(walls, cols, rows, sx, sy, r + 2, now, deadline);
	if (flood.kind === "open") return { ok: false, reason: "open" };
	// The tap is not on ink (checked above) but has no free cell within the gap band: a pocket narrower than the tolerance.
	if (flood.kind === "onInk") return { ok: false, reason: "tooSmall" };
	if (flood.kind === "busy") return { ok: false, reason: "busy" };
	if (flood.count / (cols * rows) > MAX_SHARE) return { ok: false, reason: "tooBig" };
	// Grow the area back to the ink (the gap tolerance kept it away from it), then one cell into the ink so the fill lies under its edge.
	const grown = r > 0 ? dilate(flood.region, cols, rows, r) : flood.region;
	const region = tuck(grown, mask, cols, rows);
	if (now() > deadline) return { ok: false, reason: "busy" };
	const outline = traceOutline(region, cols, rows);
	if (outline.length < 3) return { ok: false, reason: "tooSmall" };
	const simple = simplifyTo(outline, 0.9, MAX_POINTS);
	const area = polygonArea(simple) / (scale * scale);
	if (simple.length < 3 || area < MIN_AREA_PT2) return { ok: false, reason: "tooSmall" };
	const points: Point[] = simple.map(([px, py]) => [round2(input.originX + px / scale), round2(input.originY + py / scale), 0.5]);
	points.push([points[0]![0], points[0]![1], 0.5]);
	return { ok: true, points, area };
}

/** One cell further into the ink wherever the area touches it (8-neighbours), so the fill lies under the edge of the line. */
function tuck(region: Uint8Array, mask: Uint8Array, cols: number, rows: number): Uint8Array {
	const out = region.slice();
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const i = y * cols + x;
			if (region[i] || !mask[i]) continue;
			let touches = false;
			for (let dy = -1; dy <= 1 && !touches; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= rows) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					if (nx >= 0 && nx < cols && region[ny * cols + nx]) {
						touches = true;
						break;
					}
				}
			}
			if (touches) out[i] = 1;
		}
	}
	return out;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/** Is this stroke a fill made by the paint bucket? A filled shape with the bucket's hairline: it is not a wall for the next fill. */
export function isBucketFill(stroke: Pick<Stroke, "tool" | "fill" | "width" | "points">): boolean {
	return stroke.width <= BUCKET_LINE_WIDTH + 1e-6 && isFilled(stroke);
}

/** Where a new fill goes in the stroke order of a page: after the bucket fills at the start, so it lies under all the ink and over the older fills. */
export function bucketInsertIndex(strokes: readonly Pick<Stroke, "tool" | "fill" | "width" | "points">[]): number {
	let i = 0;
	while (i < strokes.length && isBucketFill(strokes[i]!)) i++;
	return i;
}

/**
 * The fill as a stroke of the shape tool: a closed polygon, `fill` in the fill colour (a tint when `tint`), a hairline in the same colour.
 * `colour` is `#rrggbb`. Optional opacity (format v24) is the pen's.
 */
export function bucketStroke(points: Point[], colour: string, tint: boolean, opacity: number | undefined, id: string): Stroke {
	const c = colour.toLowerCase();
	return {
		id, tool: "shape", color: c, width: BUCKET_LINE_WIDTH, render: RENDER_FREEHAND, points,
		fill: c, ...(tint ? { fillTint: true as const } : {}), ...(opacity === undefined ? {} : { opacity }),
	};
}
