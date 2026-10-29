/**
 * Highlighter that snaps to the text lines of a PDF page (roadmap 43). Pure: no pdf.js, DOM or 'obsidian' import.
 *
 * Input: a hand-drawn highlighter stroke (page coordinates) and the text runs of the PDF page placed on the page
 * (`boxesOnPage`). Output: one straight band per line of text the stroke crossed, covering whole words. The view
 * turns each band into an ordinary highlighter stroke (`bandPoints`), so the document format does not change.
 *
 * Text geometry comes from pdf.js runs: a run's box is `font size` high, from `size` above the baseline to the baseline.
 * Letters occupy roughly 0.25-1.2 of the box height (ascenders, then descenders below the baseline), which is the band
 * that is highlighted. Inside a run the characters are taken to have equal widths (the same approximation as the search
 * hits); snapping to whole words keeps the error of that approximation invisible.
 */
import type { TextBox } from "./text-items";

/** A straight highlight: the rectangle (page coordinates, pt) to cover. */
export interface Band {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

/** Band of a line: from this fraction of the run height below its top ... */
const BAND_TOP = 0.12;
/** ... to this fraction of it below its top (the descenders reach about 1.2). */
const BAND_BOTTOM = 1.22;
/** The stroke may pass this far (in heights) above or below a run and still count as crossing it. */
const STRICT_TOLERANCE = 0.15;
/** Used when the strict test finds nothing: the stroke ran in the gap between lines, the nearest line is taken. */
const LOOSE_TOLERANCE = 0.6;
/** A word is highlighted when the stroke covers at least this much of it. */
const WORD_COVERAGE = 0.4;
/** Two stretches of a line further apart than this many heights (columns) are highlighted separately. */
const COLUMN_GAP = 1.5;
/** A round cap reaches this much of the radius beyond the end point of a highlight (see `bandPoints`). */
const CAP_INSET = 0.45;

interface Word {
	a: number;
	b: number;
}

/** Non-blank stretches of a run's text as x-ranges of its box (equal character widths). */
function wordRanges(box: TextBox): Word[] {
	const len = box.str.length;
	const out: Word[] = [];
	if (len === 0) return out;
	const re = /\S+/gu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(box.str))) {
		out.push({ a: box.x + (box.width * m.index) / len, b: box.x + (box.width * (m.index + m[0].length)) / len });
	}
	return out;
}

/** Part of a polyline segment with `y` in [lo, hi]: its x-range, or null. */
function clipX(x0: number, y0: number, x1: number, y1: number, lo: number, hi: number): [number, number] | null {
	let t0 = 0;
	let t1 = 1;
	const dy = y1 - y0;
	if (Math.abs(dy) < 1e-9) {
		if (y0 < lo || y0 > hi) return null;
	} else {
		let ta = (lo - y0) / dy;
		let tb = (hi - y0) / dy;
		if (ta > tb) [ta, tb] = [tb, ta];
		t0 = Math.max(t0, ta);
		t1 = Math.min(t1, tb);
		if (t0 > t1) return null;
	}
	const ax = x0 + (x1 - x0) * t0;
	const bx = x0 + (x1 - x0) * t1;
	return ax <= bx ? [ax, bx] : [bx, ax];
}

/** x-range of the stroke inside the horizontal strip [lo, hi], or null when it never enters it. */
function strokeExtentIn(points: ReadonlyArray<readonly number[]>, lo: number, hi: number): [number, number] | null {
	let min = Infinity;
	let max = -Infinity;
	const first = points[0];
	if (points.length === 1 && first && first[1]! >= lo && first[1]! <= hi) return [first[0]!, first[0]!];
	for (let i = 1; i < points.length; i++) {
		const p = points[i - 1]!;
		const q = points[i]!;
		const r = clipX(p[0]!, p[1]!, q[0]!, q[1]!, lo, hi);
		if (!r) continue;
		min = Math.min(min, r[0]);
		max = Math.max(max, r[1]);
	}
	return min <= max ? [min, max] : null;
}

/** A stretch of one run chosen for highlighting. */
interface Piece {
	x0: number;
	x1: number;
	top: number;
	height: number;
}

/** A run is a candidate unless it is blank or vertical text (its box is a tall narrow column). */
function usable(box: TextBox): boolean {
	if (!(box.height > 0) || !(box.width > 0)) return false;
	if (box.str.trim().length === 0) return false;
	return !(box.height > box.width * 2.5 && box.str.trim().length > 2);
}

/** The pieces of runs the stroke crosses with `tolerance` (in run heights): whole words covered by at least 40%. */
function crossedPieces(points: ReadonlyArray<readonly number[]>, boxes: readonly TextBox[], tolerance: number): Piece[] {
	const pieces: Piece[] = [];
	for (const box of boxes) {
		const tol = box.height * tolerance;
		const ext = strokeExtentIn(points, box.y - tol, box.y + box.height + tol);
		if (!ext) continue;
		const [xa, xb] = ext;
		let best: Word | null = null;
		let bestOverlap = 0;
		const chosen: Word[] = [];
		for (const w of wordRanges(box)) {
			const overlap = Math.min(w.b, xb) - Math.max(w.a, xa);
			if (overlap <= 0 && !(xa === xb && xa >= w.a && xa <= w.b)) continue;
			if (overlap > bestOverlap) {
				best = w;
				bestOverlap = overlap;
			}
			if (overlap >= (w.b - w.a) * WORD_COVERAGE) chosen.push(w);
		}
		// A short stroke that only touches a word still highlights that word.
		if (chosen.length === 0 && best) chosen.push(best);
		if (chosen.length === 0) {
			// A point stroke (a tap) exactly on a word.
			for (const w of wordRanges(box)) if (xa >= w.a && xa <= w.b) chosen.push(w);
		}
		if (chosen.length === 0) continue;
		// Words of a run are contiguous: the highlight runs from the first to the last chosen word.
		pieces.push({ x0: chosen[0]!.a, x1: chosen[chosen.length - 1]!.b, top: box.y, height: box.height });
	}
	return pieces;
}

/** Groups pieces into lines (similar vertical centre), left to right, and joins the pieces of a line into bands. */
function bandsOf(pieces: readonly Piece[]): Band[] {
	const byY = [...pieces].sort((p, q) => p.top + p.height / 2 - (q.top + q.height / 2));
	const lines: Piece[][] = [];
	for (const p of byY) {
		const line = lines[lines.length - 1];
		const ref = line?.[0];
		if (line && ref && Math.abs(p.top + p.height / 2 - (ref.top + ref.height / 2)) <= 0.5 * Math.min(p.height, ref.height)) line.push(p);
		else lines.push([p]);
	}
	const bands: Band[] = [];
	for (const line of lines) {
		line.sort((p, q) => p.x0 - q.x0);
		let cur: { x0: number; x1: number; y0: number; y1: number; h: number } | null = null;
		const flush = (): void => {
			if (cur) bands.push({ x0: cur.x0, x1: cur.x1, y0: cur.y0, y1: cur.y1 });
			cur = null;
		};
		for (const p of line) {
			const y0 = p.top + BAND_TOP * p.height;
			const y1 = p.top + BAND_BOTTOM * p.height;
			if (cur && p.x0 - cur.x1 <= COLUMN_GAP * Math.max(cur.h, p.height)) {
				cur.x1 = Math.max(cur.x1, p.x1);
				cur.y0 = Math.min(cur.y0, y0);
				cur.y1 = Math.max(cur.y1, y1);
				cur.h = Math.max(cur.h, p.height);
			} else {
				flush();
				cur = { x0: p.x0, x1: p.x1, y0, y1, h: p.height };
			}
		}
		flush();
	}
	return bands;
}

/**
 * Straight highlights for a stroke: one band per line of text it crossed, covering the words it covers. Empty when
 * the stroke is not near any text (the caller then keeps the hand-drawn stroke).
 *
 * @param points the stroke's centre line, `[x, y, pressure]` in page coordinates
 * @param boxes the text runs of the PDF page in page coordinates
 */
export function snapHighlight(points: ReadonlyArray<readonly number[]>, boxes: readonly TextBox[]): Band[] {
	if (points.length === 0) return [];
	const candidates = boxes.filter(usable);
	if (candidates.length === 0) return [];
	let pieces = crossedPieces(points, candidates, STRICT_TOLERANCE);
	if (pieces.length === 0) {
		// The stroke did not cross a run: take the line it is closest to, if it is near one at all.
		const loose = crossedPieces(points, candidates, LOOSE_TOLERANCE);
		if (loose.length === 0) return [];
		const cy = points.reduce((s, p) => s + p[1]!, 0) / points.length;
		const distance = (p: Piece): number => Math.abs(p.top + p.height / 2 - cy);
		const nearest = Math.min(...loose.map(distance));
		pieces = loose.filter((p) => distance(p) <= nearest + 0.5 * p.height);
	}
	return bandsOf(pieces);
}

/** Spacing of the points of a snapped highlight, pt (the ink curve is smooth between them). */
const POINT_STEP = 12;

/**
 * The points of the highlighter stroke that draws `band`: a horizontal line at its middle, with the constant width of the
 * band's height. The highlighter has round ends (a disc of the stroke's radius at each end), so the end points are moved
 * inwards: the rounded end then reaches slightly past the first and last letter and no further.
 */
export function bandPoints(band: Band, pressure = 0.5): Array<[number, number, number]> {
	const cy = (band.y0 + band.y1) / 2;
	const r = (band.y1 - band.y0) / 2;
	let a = band.x0 + r * CAP_INSET;
	let b = band.x1 - r * CAP_INSET;
	if (b - a < 0.5) {
		const mid = (band.x0 + band.x1) / 2;
		a = mid - 0.25;
		b = mid + 0.25;
	}
	const n = Math.max(2, Math.ceil((b - a) / POINT_STEP) + 1);
	const out: Array<[number, number, number]> = [];
	for (let i = 0; i < n; i++) out.push([a + ((b - a) * i) / (n - 1), cy, pressure]);
	return out;
}

/** The width of the highlighter stroke that draws `band`. */
export function bandWidth(band: Band): number {
	return band.y1 - band.y0;
}
