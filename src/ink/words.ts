import type { Stroke } from "../model/types";
import type { BBox } from "./hit-test";

/**
 * Words and lines of handwriting found geometrically, without OCR (roadmap #255).
 *
 * Input: the strokes of one page (page coordinates, pt). Output: lines (top to bottom) of words
 * (left to right) of stroke ids, each with a bounding box, plus a baseline per line. Reflow
 * (#92), alignment (#93) and headings (#102) build on `TextLayout`.
 *
 * Method (all relative to the median stroke size, so it works for any handwriting size):
 *  1. Only `pen` strokes count. Highlighter and shape strokes, and strokes much larger than the
 *     handwriting (frames, long underlines, drawings), are listed in `ignored`.
 *  2. Strokes sorted left to right are attached to the line whose (slope-corrected) vertical band
 *     they fall in and whose right end is close enough; otherwise they start a new line. Centres
 *     are compared, not extents, so descenders and ascenders of neighbouring lines may overlap.
 *  3. Each line gets a baseline (robust least-squares fit through the stroke bottoms, ignoring
 *     descenders), and its strokes are cut into words wherever the gap along the baseline exceeds
 *     a fraction of the line's letter height.
 *
 * Pure: no DOM, no Obsidian. `TextLayoutCache` re-segments only when the stroke list changes.
 */

export interface TextOptions {
	/** A gap along the baseline wider than this × the line's letter height starts a new word. */
	wordGap: number;
	/** Strokes whose larger side exceeds this × the median stroke size are not text. */
	maxStrokeUnits: number;
	/** A stroke joins a line only if it starts within this × letter height of the line's right end. */
	maxLineGap: number;
}

export const DEFAULT_TEXT_OPTIONS: Readonly<TextOptions> = { wordGap: 0.45, maxStrokeUnits: 8, maxLineGap: 5 };

export interface TextWord {
	strokeIds: string[];
	/** Union of the strokes' point boxes (no pen-width padding). */
	bounds: BBox;
}

export interface Baseline {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** dy/dx */
	slope: number;
}

export interface TextLine {
	words: TextWord[];
	strokeIds: string[];
	bounds: BBox;
	baseline: Baseline;
	/** Median height of the line's letters (pt). */
	letterHeight: number;
}

export interface TextLayout {
	lines: TextLine[];
	/** Strokes that are not handwriting text (highlighter, shapes, oversized strokes, empty). */
	ignored: string[];
	/** Median stroke size used as the scale of the page (pt); 0 when there is no text. */
	unit: number;
	/** Point box of a stroke that is part of a line. */
	boundsOf(id: string): BBox | undefined;
}

interface Feat {
	n: number;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface Item {
	id: string;
	f: Feat;
	cx: number;
	cy: number;
	h: number;
	/** A dot, comma or hyphen: placed by its centre only and not used to measure the line. */
	tiny: boolean;
}

const featCache = new WeakMap<Stroke, Feat>();

function featOf(s: Stroke): Feat | null {
	const pts = s.points;
	if (pts.length === 0) return null;
	const c = featCache.get(s);
	if (c && c.n === pts.length) return c;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i]!;
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	const f = { n: pts.length, minX, minY, maxX, maxY };
	featCache.set(s, f);
	return f;
}

function median(a: ArrayLike<number>): number {
	if (a.length === 0) return 0;
	const s = Float64Array.from(a).sort();
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A line being built: its members and the vertical band `cy(x) = a + b·x` new strokes must fall in. */
interface Acc {
	items: Item[];
	/** The last solid strokes (RECENT at most), oldest first. */
	recent: Item[];
	maxX: number;
	a: number;
	b: number;
	/** Letter height: the band's tolerance scale. */
	h: number;
	/** `a`, `b`, `h` are out of date. */
	dirty: boolean;
	lastCx: number;
	lastCy: number;
	/** Index in the open-line arrays. */
	slot: number;
}

const RECENT = 8;

function push(acc: Acc, it: Item): void {
	acc.items.push(it);
	if (it.f.maxX > acc.maxX) acc.maxX = it.f.maxX;
	if (it.tiny && acc.recent.length > 0) return;
	if (!it.tiny && acc.recent.length > 0 && acc.recent[0]!.tiny) acc.recent.length = 0;
	acc.recent.push(it);
	if (acc.recent.length > RECENT) acc.recent.shift();
	acc.lastCx = it.cx;
	acc.lastCy = it.cy;
	acc.dirty = true;
	// The reach test needs a letter height from the first stroke on.
	if (acc.items.length === 1) refresh(acc);
}

/** Recomputes the band from the recent strokes: O(RECENT), no allocation. */
function refresh(acc: Acc): void {
	acc.dirty = false;
	const r = acc.recent;
	const n = r.length;
	// Tolerance scale: the second tallest recent stroke (robust against one oversized stroke).
	let h1 = 0, h2 = 0;
	for (let i = 0; i < n; i++) {
		const h = r[i]!.h;
		if (h > h1) { h2 = h1; h1 = h; } else if (h > h2) h2 = h;
	}
	acc.h = Math.max(n > 1 ? h2 : h1, 1e-6);
	// Slope: oldest third against newest third of the window (jitter of letter heights averages out).
	let slope = 0;
	if (n >= 5) {
		const k = Math.floor(n / 3);
		let ax = 0, ay = 0, bx = 0, by = 0;
		for (let i = 0; i < k; i++) { ax += r[i]!.cx; ay += r[i]!.cy; bx += r[n - 1 - i]!.cx; by += r[n - 1 - i]!.cy; }
		const dx = (bx - ax) / k;
		if (dx > 3 * acc.h) slope = 0.9 * Math.max(-0.7, Math.min(0.7, (by - ay) / k / dx));
		if (Math.abs(slope) < 0.08) slope = 0;
	}
	acc.b = slope;
	if (slope === 0) {
		// Without a slope the last stroke anchors the band (an average would lag behind a steep line).
		acc.a = r[n - 1]!.cy;
	} else {
		let sum = 0;
		for (let i = 0; i < n; i++) sum += r[i]!.cy - slope * r[i]!.cx;
		acc.a = sum / n;
	}
}

/** Segments the strokes of one page into lines and words. Cost O(n log n + n × open lines). */
export function segmentText(strokes: readonly Stroke[], options: Partial<TextOptions> = {}): TextLayout {
	const opt = { ...DEFAULT_TEXT_OPTIONS, ...options };
	const ignored: string[] = [];
	const cand: Item[] = [];
	for (const s of strokes) {
		const f = s.tool === "pen" ? featOf(s) : null;
		if (!f) { ignored.push(s.id); continue; }
		cand.push({ id: s.id, f, cx: (f.minX + f.maxX) / 2, cy: (f.minY + f.maxY) / 2, h: f.maxY - f.minY, tiny: false });
	}
	const unit = median(cand.map((c) => Math.max(c.f.maxX - c.f.minX, c.f.maxY - c.f.minY)));
	const boundsById = new Map<string, BBox>();
	const empty: TextLayout = { lines: [], ignored, unit, boundsOf: (id) => boundsById.get(id) };
	if (cand.length === 0 || unit <= 0) return empty;

	const items: Item[] = [];
	for (const c of cand) {
		if (Math.max(c.f.maxX - c.f.minX, c.f.maxY - c.f.minY) > opt.maxStrokeUnits * unit) ignored.push(c.id);
		else items.push(c);
	}
	if (items.length === 0) return empty;
	// Small marks are placed by their centre; "small" is relative to the typical stroke height.
	const hMed = median(items.map((i) => i.h));
	for (const i of items) i.tiny = i.h < 0.4 * hMed && i.f.maxX - i.f.minX < 1.2 * hMed;
	// Left to right (ties: top first) through a typed key array: faster than comparing objects.
	const keyX = Float64Array.from(items, (i) => i.f.minX);
	const keyY = Float64Array.from(items, (i) => i.f.minY);
	const order = Uint32Array.from(items.keys()).sort((p, q) => keyX[p]! - keyX[q]! || keyY[p]! - keyY[q]!);
	const sortedItems = Array.from(order, (k) => items[k]!);

	const all: Acc[] = [];
	// Open lines (those that can still take strokes), kept sorted by the y of their last stroke so a
	// stroke only looks at the lines near it vertically, however many lines the page has.
	let open: Acc[] = [];
	let maxH = 0;
	const lowerBound = (y: number) => {
		let lo = 0, hi = open.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (open[mid]!.lastCy < y) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	const swap = (i: number, j: number) => {
		const x = open[i]!, y = open[j]!;
		open[i] = y; open[j] = x;
		y.slot = i; x.slot = j;
	};
	const test = (acc: Acc, it: Item, best: { acc: Acc | null; d: number }) => {
		if (it.f.minX - acc.maxX > opt.maxLineGap * acc.h) return;
		if (acc.dirty) refresh(acc);
		const d = Math.abs(it.cy - (acc.a + acc.b * it.cx));
		const scale = it.tiny ? acc.h : Math.max(acc.h, Math.min(it.h, 2 * acc.h));
		// A young line has no slope estimate yet: more tolerance.
		const k = it.tiny ? 1.2 : acc.recent.length < 4 ? 0.85 : 0.6;
		if (d <= k * scale && d < best.d) { best.acc = acc; best.d = d; }
	};
	let sincePrune = 0;
	const best = { acc: null as Acc | null, d: Infinity };
	for (const it of sortedItems) {
		// Lines that ended too far to the left can no longer take strokes (sorted by minX).
		if (++sincePrune >= 256) {
			sincePrune = 0;
			open = open.filter((acc) => it.f.minX - acc.maxX <= opt.maxLineGap * acc.h);
			open.forEach((acc, j) => { acc.slot = j; });
		}
		best.acc = null;
		best.d = Infinity;
		const window = 2 * (maxH + it.h);
		const lo = lowerBound(it.cy);
		for (let j = lo - 1; j >= 0 && it.cy - open[j]!.lastCy <= window; j--) test(open[j]!, it, best);
		for (let j = lo; j < open.length && open[j]!.lastCy - it.cy <= window; j++) test(open[j]!, it, best);
		let acc = best.acc as Acc | null;
		if (!acc) {
			acc = { items: [], recent: [], maxX: -Infinity, a: 0, b: 0, h: 0, dirty: true, lastCx: 0, lastCy: it.cy, slot: 0 };
			open.splice(lowerBound(it.cy), 0, acc);
			for (let j = 0; j < open.length; j++) open[j]!.slot = j;
			all.push(acc);
		}
		push(acc, it);
		if (acc.h > maxH) maxH = acc.h;
		let j = acc.slot;
		while (j > 0 && open[j - 1]!.lastCy > acc.lastCy) { swap(j - 1, j); j--; }
		while (j < open.length - 1 && open[j + 1]!.lastCy < acc.lastCy) { swap(j, j + 1); j++; }
	}

	const lines = all.map((acc) => buildLine(acc.items, opt, boundsById));
	lines.sort((a, b) => lineMidY(a) - lineMidY(b) || a.bounds.minX - b.bounds.minX);
	return { lines, ignored, unit, boundsOf: (id) => boundsById.get(id) };
}

function lineMidY(l: TextLine): number {
	return (l.baseline.y0 + l.baseline.y1) / 2;
}

/**
 * Baseline = the line through the stroke bottoms that most bottoms sit on (RANSAC over pairs, so
 * descenders, which sit below it, do not tilt it); ties go to the higher line. Refit on the inliers.
 */
function fitBaseline(items: Item[], h: number): Baseline {
	const pts = items.filter((i) => !i.tiny);
	const use = pts.length > 0 ? pts : items;
	const x0 = Math.min(...items.map((i) => i.f.minX));
	const x1 = Math.max(...items.map((i) => i.f.maxX));
	const tol = 0.15 * h;
	const sample = use.length > 14 ? Array.from({ length: 14 }, (_, k) => use[Math.floor((k * use.length) / 14)]!) : use;
	// Best horizontal line, and best sloped line; the slope must earn its keep with clearly more inliers.
	const best = { flat: { n: -1, mean: Infinity, a: 0, b: 0 }, tilted: { n: -1, mean: Infinity, a: 0, b: 0 } };
	const tryLine = (key: "flat" | "tilted", a: number, b: number) => {
		let n = 0, sum = 0;
		for (const i of use) if (Math.abs(i.f.maxY - (a + b * i.cx)) <= tol) { n++; sum += i.f.maxY; }
		const mean = n > 0 ? sum / n : Infinity;
		const cur = best[key];
		if (n > cur.n || (n === cur.n && mean < cur.mean)) best[key] = { n, mean, a, b };
	};
	for (const p of sample) tryLine("flat", p.f.maxY, 0);
	// Most lines are flat: only search for a slope when the best flat line leaves many bottoms off it.
	const search = use.length >= 8 && best.flat.n < 0.7 * use.length;
	for (let i = 0; search && i < sample.length; i++) {
		for (let j = i + 1; j < sample.length; j++) {
			const dx = sample[j]!.cx - sample[i]!.cx;
			if (Math.abs(dx) < 2 * h) continue;
			const b = (sample[j]!.f.maxY - sample[i]!.f.maxY) / dx;
			if (Math.abs(b) > 0.7 || Math.abs(b) < 0.02) continue;
			tryLine("tilted", sample[i]!.f.maxY - b * sample[i]!.cx, b);
		}
	}
	const pick = use.length >= 8 && best.tilted.n >= Math.max(6, best.flat.n + 3) ? best.tilted : best.flat;
	const bestA = pick.a, bestB = pick.b;
	const inl = use.filter((i) => Math.abs(i.f.maxY - (bestA + bestB * i.cx)) <= tol);
	let a = bestA, b = bestB;
	if (inl.length >= 3) {
		let mx = 0, my = 0;
		for (const i of inl) { mx += i.cx; my += i.f.maxY; }
		mx /= inl.length;
		my /= inl.length;
		let sxx = 0, sxy = 0;
		for (const i of inl) { sxx += (i.cx - mx) ** 2; sxy += (i.cx - mx) * (i.f.maxY - my); }
		if (sxx > (2 * h) ** 2) { b = Math.max(-0.7, Math.min(0.7, sxy / sxx)); a = my - b * mx; }
	}
	return { x0, y0: a + b * x0, x1, y1: a + b * x1, slope: b };
}

function union(items: Item[]): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const i of items) {
		if (i.f.minX < minX) minX = i.f.minX;
		if (i.f.minY < minY) minY = i.f.minY;
		if (i.f.maxX > maxX) maxX = i.f.maxX;
		if (i.f.maxY > maxY) maxY = i.f.maxY;
	}
	return { minX, minY, maxX, maxY };
}

function buildLine(members: Item[], opt: TextOptions, boundsById: Map<string, BBox>): TextLine {
	const solid = members.filter((i) => !i.tiny);
	const hs = median((solid.length > 0 ? solid : members).map((i) => i.h));
	// Ignore slivers (flat strokes, hyphens) when measuring letters.
	const letterHeight = median((solid.length > 0 ? solid : members).filter((i) => i.h >= 0.4 * hs).map((i) => i.h)) || hs;
	const baseline = fitBaseline(members, letterHeight);
	const len = Math.hypot(1, baseline.slope);
	const ux = 1 / len, uy = baseline.slope / len;
	const span = (i: Item): [number, number] => {
		const f = i.f;
		const a = f.minX * ux + f.minY * uy, b = f.maxX * ux + f.minY * uy;
		const c = f.minX * ux + f.maxY * uy, d = f.maxX * ux + f.maxY * uy;
		return [Math.min(a, b, c, d), Math.max(a, b, c, d)];
	};
	const sorted = members.map((i) => ({ i, s: span(i) })).sort((p, q) => p.s[0] - q.s[0]);
	const groups: Item[][] = [];
	let cur: Item[] = [];
	let curMax = -Infinity;
	const gap = opt.wordGap * letterHeight;
	for (const { i, s } of sorted) {
		if (cur.length > 0 && s[0] - curMax > gap) { groups.push(cur); cur = []; curMax = -Infinity; }
		cur.push(i);
		if (s[1] > curMax) curMax = s[1];
	}
	if (cur.length > 0) groups.push(cur);

	const words: TextWord[] = groups.map((g) => {
		for (const i of g) boundsById.set(i.id, { minX: i.f.minX, minY: i.f.minY, maxX: i.f.maxX, maxY: i.f.maxY });
		return { strokeIds: g.map((i) => i.id), bounds: union(g) };
	});
	return { words, strokeIds: words.flatMap((w) => w.strokeIds), bounds: union(members), baseline, letterHeight };
}

/** Distance from a point to a box (0 inside). */
export function distanceToBox(b: BBox, x: number, y: number): number {
	const dx = Math.max(b.minX - x, 0, x - b.maxX);
	const dy = Math.max(b.minY - y, 0, y - b.maxY);
	return Math.hypot(dx, dy);
}

export interface WordHit {
	line: TextLine;
	word: TextWord;
}

/** The word nearest to (x, y) within `tolerance` pt (distance to its strokes' boxes), or null. */
export function wordAt(layout: TextLayout, x: number, y: number, tolerance: number): WordHit | null {
	let best: WordHit | null = null;
	let bestD = Infinity;
	for (const line of layout.lines) {
		if (distanceToBox(line.bounds, x, y) > tolerance) continue;
		for (const word of line.words) {
			if (distanceToBox(word.bounds, x, y) > tolerance) continue;
			let d = Infinity;
			for (const id of word.strokeIds) {
				const b = layout.boundsOf(id);
				if (b) d = Math.min(d, distanceToBox(b, x, y));
			}
			if (d < bestD) { bestD = d; best = { line, word }; }
		}
	}
	return bestD <= tolerance ? best : null;
}

/** The line of the word at (x, y), or else the line whose box is nearest within `tolerance`. */
export function lineAt(layout: TextLayout, x: number, y: number, tolerance: number): TextLine | null {
	const hit = wordAt(layout, x, y, tolerance);
	if (hit) return hit.line;
	let best: TextLine | null = null;
	let bestD = tolerance;
	for (const line of layout.lines) {
		const d = distanceToBox(line.bounds, x, y);
		if (d <= bestD) { bestD = d; best = line; }
	}
	return best;
}

/**
 * Caches the layout of a page: the strokes list is compared by identity, so an unchanged page costs
 * O(n) pointer comparisons, and a changed one re-segments from per-stroke cached boxes.
 */
export class TextLayoutCache {
	private seen: readonly Stroke[] = [];
	private layout: TextLayout | null = null;

	get(strokes: readonly Stroke[]): TextLayout {
		if (this.layout && strokes.length === this.seen.length) {
			let same = true;
			for (let i = 0; i < strokes.length; i++) if (strokes[i] !== this.seen[i]) { same = false; break; }
			if (same) return this.layout;
		}
		this.seen = strokes.slice();
		this.layout = segmentText(strokes);
		return this.layout;
	}
}
