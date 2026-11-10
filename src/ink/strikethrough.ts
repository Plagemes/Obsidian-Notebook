import { isLinePen, type Stroke } from "../model/types";
import type { BBox } from "./hit-test";
import { segmentText, type TextLine, type TextOptions } from "./words";

/**
 * Strike-through as logical deletion (roadmap #96): a roughly horizontal line drawn through the middle of a handwritten word
 * marks that word as deleted. The word stays on the page and readable (the line is ordinary ink); the view and the clean
 * export can leave it out. Nothing is stored: the struck state is DERIVED from the geometry of the strokes every time, so
 * the document format is untouched, an undo of the line un-strikes the word, and erasing the line brings the word back.
 *
 * This only READS strokes. It is separate from the scribble eraser (a fast back-and-forth scratch), which stays as it is:
 * a strike is one slow, straight pass, a scribble is a zig-zag, and the two shapes never match the same stroke.
 *
 * Method (pure, no DOM, no Obsidian; sizes relative to the page's handwriting, so any hand size works):
 *  1. Candidate lines: pen, fountain and brush strokes that are straight (path ≈ chord, little sideways wobble, no going
 *     back), nearly horizontal (tilt ≤ ~20°) and at least as long as a typical stroke. Hidden (invisible) ink never takes part.
 *  2. The page's words are found WITHOUT the candidates (`segmentText`), so a line across two words does not glue them into one.
 *     Pages without a candidate skip this step: the cost of a page of plain writing is one pass over its points.
 *  3. A candidate strikes a word of a line when it is at least ~one letter height long, covers most of the word's width, and
 *     passes through the middle band of the line's letters (above the baseline by 15 % to 85 % of the letter height). An
 *     underline (at or below the baseline), an overline, the bar of a t, an A, an e or a hyphen (too short) therefore do not count;
 *     a long line over several words of one line strikes them all; a single crossed-out letter is a word of its own.
 *     A line strikes only the strokes written before it (earlier in the page's stroke order): a word written on the place of a
 *     struck one afterwards is not struck.
 *  4. The struck words' strokes and the lines that struck them are the "struck ink". A line that struck nothing is ordinary ink.
 */
export interface StrikeOptions {
	/** Largest tilt of a strike line, as |dy| / |dx| (0.36 is about 20°). */
	maxTilt: number;
	/** Largest path length of the line relative to its chord (a wobbly line passes, a zig-zag does not). */
	maxPathRatio: number;
	/** Largest sideways distance of any point from the chord, relative to the chord. */
	maxDeviation: number;
	/** Largest travel against the line's direction, relative to the chord (a line that goes back on itself is a scribble). */
	maxBackward: number;
	/** A candidate is at least this × the median stroke size of the page long (cheap pre-filter). */
	minUnits: number;
	/** The line must be at least this × the line's letter height long. */
	minLetters: number;
	/** Share of a word's width the line must cover. */
	cover: number;
	/** The line passes the letters between baseline − `bandHigh` × letter height and baseline − `bandLow` × letter height. */
	bandLow: number;
	bandHigh: number;
	/** Passed to the word segmentation. */
	text?: Partial<TextOptions>;
}

export const DEFAULT_STRIKE: Readonly<StrikeOptions> = {
	maxTilt: 0.36,
	maxPathRatio: 1.25,
	maxDeviation: 0.12,
	maxBackward: 0.1,
	minUnits: 0.9,
	minLetters: 0.9,
	cover: 0.7,
	bandLow: 0.15,
	bandHigh: 0.85,
};

/** A straight, nearly horizontal stroke seen as a segment, left to right. */
export interface StrikeLine {
	id: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	length: number;
}

export interface StruckWord {
	/** The word's strokes (the line is not among them). */
	strokeIds: string[];
	/** The lines that struck it. */
	strikeIds: string[];
	/** Box of the word's strokes. */
	bounds: BBox;
}

export interface StrikeResult {
	words: StruckWord[];
	/** The ids of the struck words' strokes and of the lines that struck them: what "hide struck words" leaves out. */
	ink: ReadonlySet<string>;
}

export const NO_STRIKES: StrikeResult = { words: [], ink: new Set() };

/** The stroke as a strike line, or null when it is not straight and nearly horizontal enough. */
export function strikeLineOf(s: Stroke, opt: StrikeOptions = DEFAULT_STRIKE): StrikeLine | null {
	const pts = s.points;
	if (pts.length < 2 || !isLinePen(s.tool) || s.hidden) return null;
	let a = pts[0]!, b = pts[pts.length - 1]!;
	// Drawn right to left is the same line.
	if (b[0] < a[0]) { const t = a; a = b; b = t; }
	const dx = b[0] - a[0], dy = b[1] - a[1];
	if (!(dx > 0) || Math.abs(dy) > opt.maxTilt * dx) return null;
	const chord = Math.hypot(dx, dy);
	const forward = pts[0]![0] <= pts[pts.length - 1]![0] ? 1 : -1;
	let path = 0, back = 0, dev = 0;
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i - 1]!, q = pts[i]!;
		path += Math.hypot(q[0] - p[0], q[1] - p[1]);
		const step = (q[0] - p[0]) * forward;
		if (step < 0) back -= step;
		dev = Math.max(dev, Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / chord);
	}
	if (path > opt.maxPathRatio * chord || back > opt.maxBackward * chord || dev > opt.maxDeviation * chord) return null;
	return { id: s.id, x0: a[0], y0: a[1], x1: b[0], y1: b[1], length: chord };
}

function median(a: number[]): number {
	if (a.length === 0) return 0;
	const s = Float64Array.from(a).sort();
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function sizeOf(s: Stroke): number {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of s.points) {
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	return Math.max(maxX - minX, maxY - minY);
}

/** Whether `line` strikes a word spanning `[minX, maxX]` of `text` (the geometric test, see the header). */
function strikes(line: StrikeLine, text: TextLine, minX: number, maxX: number, wordBox: BBox, opt: StrikeOptions): boolean {
	const lh = text.letterHeight;
	if (!(lh > 0) || line.length < opt.minLetters * lh) return false;
	const width = Math.max(maxX - minX, 1e-6);
	const overlap = Math.min(line.x1, maxX) - Math.max(line.x0, minX);
	if (overlap < opt.cover * width) return false;
	// Height of the line at the word's centre (clamped to the line's own extent) against the letters' band.
	const xc = Math.min(Math.max((minX + maxX) / 2, line.x0), line.x1);
	const y = line.y0 + ((xc - line.x0) / (line.x1 - line.x0)) * (line.y1 - line.y0);
	const bl = text.baseline;
	const base = bl.y0 + bl.slope * (xc - bl.x0);
	if (y > base - opt.bandLow * lh || y < base - opt.bandHigh * lh) return false;
	// And inside the word's own box (a loose margin), whatever the baseline fit says.
	return y >= wordBox.minY - 0.1 * lh && y <= wordBox.maxY + 0.1 * lh;
}

/** The words of one page that are struck through. Cost O(points) for a page without a candidate line. */
export function detectStrikes(strokes: readonly Stroke[], options: Partial<StrikeOptions> = {}): StrikeResult {
	const opt = { ...DEFAULT_STRIKE, ...options };
	const pens = strokes.filter((s) => isLinePen(s.tool) && !s.hidden && s.points.length > 0);
	if (pens.length < 2) return NO_STRIKES;
	const unit = median(pens.map(sizeOf));
	if (!(unit > 0)) return NO_STRIKES;
	const lines: StrikeLine[] = [];
	for (const s of pens) {
		const l = strikeLineOf(s, opt);
		if (l && l.length >= opt.minUnits * unit) lines.push(l);
	}
	if (lines.length === 0) return NO_STRIKES;
	// The words without the candidate lines: a line across two words must not join them.
	const candidate = new Set(lines.map((l) => l.id));
	const layout = segmentText(strokes.filter((s) => !candidate.has(s.id) && !s.hidden), opt.text);
	if (layout.lines.length === 0) return NO_STRIKES;
	const found = new Map<string, StruckWord>();
	for (const l of layout.lines) {
		const lh = l.letterHeight;
		const top = Math.min(l.bounds.minY, l.baseline.y0, l.baseline.y1) - lh;
		const bottom = Math.max(l.bounds.maxY, l.baseline.y0, l.baseline.y1) + lh;
		for (const line of lines) {
			const ly = Math.min(line.y0, line.y1), hy = Math.max(line.y0, line.y1);
			if (hy < top || ly > bottom || line.x1 < l.bounds.minX || line.x0 > l.bounds.maxX) continue;
			for (const w of l.words) {
				if (!strikes(line, l, w.bounds.minX, w.bounds.maxX, w.bounds, opt)) continue;
				const key = w.strokeIds[0]!;
				const hit = found.get(key);
				if (hit) { if (!hit.strikeIds.includes(line.id)) hit.strikeIds.push(line.id); } else found.set(key, { strokeIds: w.strokeIds, strikeIds: [line.id], bounds: w.bounds });
			}
		}
	}
	if (found.size === 0) return NO_STRIKES;
	// A line strikes only what was written BEFORE it (page order is writing order): ink written after the newest line that
	// crosses a word, for instance a new word on the empty place of a hidden struck one, is never struck, so it stays visible.
	const order = new Map<string, number>();
	strokes.forEach((s, i) => order.set(s.id, i));
	const words: StruckWord[] = [];
	for (const w of found.values()) {
		const lastLine = Math.max(...w.strikeIds.map((id) => order.get(id) ?? -1));
		const before = w.strokeIds.filter((id) => (order.get(id) ?? Infinity) < lastLine);
		if (before.length === 0) continue;
		const first = Math.min(...before.map((id) => order.get(id)!));
		const lines = w.strikeIds.filter((id) => (order.get(id) ?? -1) > first);
		words.push(before.length === w.strokeIds.length && lines.length === w.strikeIds.length ? w : { strokeIds: before, strikeIds: lines, bounds: w.bounds });
	}
	if (words.length === 0) return NO_STRIKES;
	const ink = new Set<string>();
	for (const w of words) {
		for (const id of w.strokeIds) ink.add(id);
		for (const id of w.strikeIds) ink.add(id);
	}
	return { words, ink };
}

/** The ids of the strokes a struck-words-free copy of the page leaves out (empty set when nothing is struck). */
export function struckInk(strokes: readonly Stroke[]): ReadonlySet<string> {
	return detectStrikes(strokes).ink;
}

/**
 * Per-page memory of `detectStrikes`: a page is re-detected only when its stroke list changed (compared by identity, so an
 * unchanged page costs O(n) pointer comparisons and only ever at the moment someone asks, never per frame).
 */
export class StrikeCache {
	private readonly pages = new Map<string, { seen: readonly Stroke[]; result: StrikeResult }>();

	/** Whether the page's cached result is current. */
	fresh(pageId: string, strokes: readonly Stroke[]): boolean {
		const c = this.pages.get(pageId);
		if (!c || c.seen.length !== strokes.length) return false;
		for (let i = 0; i < strokes.length; i++) if (strokes[i] !== c.seen[i]) return false;
		return true;
	}

	/** The cached result, however old (null: never computed). */
	peek(pageId: string): StrikeResult | null {
		return this.pages.get(pageId)?.result ?? null;
	}

	/**
	 * The result for the page, computed when stale. `maxStrokes` (review S5): a page with more strokes than this is not looked at
	 * (nothing on it is hidden in the view): the detection cannot be sliced, so a very dense page would hold the main thread.
	 */
	get(pageId: string, strokes: readonly Stroke[], maxStrokes = Infinity): StrikeResult {
		if (this.fresh(pageId, strokes)) return this.pages.get(pageId)!.result;
		const result = strokes.length > maxStrokes ? NO_STRIKES : detectStrikes(strokes);
		this.pages.set(pageId, { seen: strokes.slice(), result });
		return result;
	}

	/** Forgets the pages that are not in `keep` (pages deleted from the notebook). */
	retain(keep: ReadonlySet<string>): void {
		for (const id of [...this.pages.keys()]) if (!keep.has(id)) this.pages.delete(id);
	}

	clear(): void {
		this.pages.clear();
	}
}
