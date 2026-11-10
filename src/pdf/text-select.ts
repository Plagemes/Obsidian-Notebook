/**
 * Selecting and copying the text of a PDF page (0.16, roadmap #45). Pure: no pdf.js, DOM or 'obsidian' import, tested in Node.
 *
 * There is no text layer: the view reads the runs of the page on demand (text-items.ts, cached per page by
 * text-index.ts), and this module turns a drag into a range of the assembled page text (text-search.ts) and back into
 * boxes to highlight. Points are first moved from the notebook page into the PDF's own viewport (scale 1, pt, origin
 * top-left), where the runs are.
 */
import { invert } from "../ink/transform";
import { isIdentityView, mapRect, sourceToPage, type PdfView } from "../model/pdf-view";
import { prefixShare, type PageTextContent, type TextBox, type TextMeasure } from "./text-items";
import { hitBoxes, type PageText, type TextHit } from "./text-search";

export interface Point {
	x: number;
	y: number;
}

export interface RectLike {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A point of the notebook page moved into the PDF viewport. `rect` is where the PDF is drawn on the page (its
 * background box, see model/margins.ts) and `content` the natural size of the PDF page.
 */
export function pageToPdf(p: Point, rect: RectLike, content: { width: number; height: number }, view?: PdfView): Point {
	if (!isIdentityView(view)) {
		// 0.28 (#76): through the turn and crop of the page's background back to the PDF page.
		const [a, b, c, d, e, f] = invert(sourceToPage(view, content, rect));
		return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
	}
	const sx = rect.width > 0 ? content.width / rect.width : 1;
	const sy = rect.height > 0 ? content.height / rect.height : 1;
	return { x: (p.x - rect.x) * sx, y: (p.y - rect.y) * sy };
}

/** A box of the PDF viewport moved onto the notebook page (the inverse of `pageToPdf`). */
export function pdfRectToPage(r: RectLike, rect: RectLike, content: { width: number; height: number }, view?: PdfView): RectLike {
	if (!isIdentityView(view)) return mapRect(sourceToPage(view, content, rect), r);
	const sx = content.width > 0 ? rect.width / content.width : 1;
	const sy = content.height > 0 ? rect.height / content.height : 1;
	return { x: rect.x + r.x * sx, y: rect.y + r.y * sy, width: r.width * sx, height: r.height * sy };
}

/** How far `p` is from a run's box, across and down (0 inside). */
function gap(b: TextBox, p: Point): { dx: number; dy: number } {
	const dx = p.x < b.x ? b.x - p.x : p.x > b.x + b.width ? p.x - (b.x + b.width) : 0;
	const dy = p.y < b.y ? b.y - p.y : p.y > b.y + b.height ? p.y - (b.y + b.height) : 0;
	return { dx, dy };
}

/** The character boundary (0..str.length) of a run closest to x. */
export function caretInRun(box: TextBox, x: number, measure?: TextMeasure): number {
	const len = box.str.length;
	if (len === 0 || !(box.width > 0)) return 0;
	const share = (x - box.x) / box.width;
	if (share <= 0) return 0;
	if (share >= 1) return len;
	let lo = 0;
	let hi = len;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (prefixShare(box, mid, measure) < share) lo = mid;
		else hi = mid;
	}
	const a = prefixShare(box, lo, measure);
	const b = prefixShare(box, hi, measure);
	return share - a <= b - share ? lo : hi;
}

export interface Caret {
	/** Offset in `PageText.text`. */
	offset: number;
	/** Distance to the run it fell in, in pt (0: the point is inside the run). */
	distance: number;
	/** The run (index in `content.items`). */
	item: number;
}

/**
 * The place in the page text nearest to a point of the PDF viewport. With `maxDistance` (in run heights) a point far from
 * any text gives null, so a tap on empty paper selects nothing; a drag passes none and always lands on the nearest text.
 */
export function caretAt(content: PageTextContent, page: PageText, p: Point, measure?: TextMeasure, maxDistance?: number): Caret | null {
	// The line is chosen first (a point to the right of a short line, a little below it, belongs to that line and not to the
	// longer one above), then the run on it.
	let best: { span: PageText["spans"][number]; score: number; d: number } | null = null;
	for (const span of page.spans) {
		const box = content.items[span.item];
		if (!box || box.str.length === 0) continue;
		const { dx, dy } = gap(box, p);
		const score = dy * 1000 + dx;
		if (!best || score < best.score) best = { span, score, d: Math.hypot(dx, dy) };
		if (score === 0) break;
	}
	if (!best) return null;
	const box = content.items[best.span.item]!;
	if (maxDistance !== undefined && best.d > Math.max(box.height, 1) * maxDistance) return null;
	return { offset: best.span.start + caretInRun(box, p.x, measure), distance: best.d, item: best.span.item };
}

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

/** The word around an offset of the text (the word the offset touches), or null on white space and punctuation. */
export function wordRange(text: string, offset: number): TextHit | null {
	const at = Math.min(Math.max(0, offset), text.length);
	const isWord = (i: number): boolean => i >= 0 && i < text.length && WORD_CHAR.test(text[i]!);
	let seed = -1;
	if (isWord(at)) seed = at;
	else if (isWord(at - 1)) seed = at - 1;
	if (seed < 0) return null;
	let start = seed;
	let end = seed + 1;
	while (isWord(start - 1)) start--;
	while (isWord(end)) end++;
	return { start, end };
}

/** The range between two offsets in either order; null when they are the same place. */
export function rangeBetween(a: number, b: number): TextHit | null {
	if (a === b) return null;
	return a < b ? { start: a, end: b } : { start: b, end: a };
}

/** Does the range hold any text that is not white space? */
export function rangeHasText(page: PageText, hit: TextHit): boolean {
	return /\S/.test(page.text.slice(hit.start, hit.end));
}

const sameLine = (a: TextBox, b: TextBox): boolean => Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < Math.max(a.height, b.height, 1e-6) * 0.6;

/**
 * The text of a range, as a person would copy it: runs joined as they are on one line, lines joined with a space, a word
 * broken with a hyphen at the end of a line joined again, white space collapsed. (The page text keeps stream order.)
 */
export function selectionText(content: PageTextContent, page: PageText, hit: TextHit): string {
	let out = "";
	let prev: { span: PageText["spans"][number]; box: TextBox; piece: string } | null = null;
	for (const span of page.spans) {
		if (span.end <= hit.start) continue;
		if (span.start >= hit.end) break;
		const box = content.items[span.item];
		if (!box) continue;
		const piece = box.str.slice(Math.max(hit.start, span.start) - span.start, Math.min(hit.end, span.end) - span.start);
		if (piece.length === 0) continue;
		if (prev) {
			const sep = page.text.slice(prev.span.end, span.start);
			const broken = sep === " " && !sameLine(prev.box, box) && /\p{L}-$/u.test(out) && /^\p{Ll}/u.test(piece);
			if (broken) out = out.slice(0, -1);
			else out += sep;
		}
		out += piece;
		prev = { span, box, piece };
	}
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Boxes to highlight for a range, in the PDF viewport: one per line. A run's box is its font size high and the letters
 * sit lower in it, so the box is moved down a little and made a little taller, like the search marks.
 */
export function selectionBoxes(content: PageTextContent, page: PageText, hit: TextHit, measure?: TextMeasure): RectLike[] {
	return hitBoxes(content, page, hit, measure).map((b) => ({ x: b.x, y: b.y + b.height * 0.1, width: b.width, height: b.height * 1.15 }));
}

/** The box around a set of boxes, or null when there are none. */
export function unionBox(boxes: readonly RectLike[]): RectLike | null {
	if (boxes.length === 0) return null;
	const x0 = Math.min(...boxes.map((r) => r.x));
	const y0 = Math.min(...boxes.map((r) => r.y));
	const x1 = Math.max(...boxes.map((r) => r.x + r.width));
	const y1 = Math.max(...boxes.map((r) => r.y + r.height));
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A drag is a tap when it lasted less than `maxMs` and moved less than `slopPx`. */
export function isTap(distancePx: number, ms: number, slopPx = 8, maxMs = 500): boolean {
	return distancePx <= slopPx && ms <= maxMs;
}

export interface QuoteSource {
	/** The PDF's name (may be empty). */
	pdf: string;
	/** 1-based page of the PDF. */
	pdfPage: number;
	/** A link back to the notebook page ("" when there is none). */
	link: string;
}

/**
 * The selection as a Markdown quote with where it comes from: a block quote, then a line with the PDF and its page and the
 * link to the notebook page. Every line of the text is quoted, so it stays one block in a note.
 */
export function formatQuote(text: string, source: QuoteSource): string {
	const body = text.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n");
	const where = [source.pdf ? `${source.pdf}, p. ${source.pdfPage}` : `p. ${source.pdfPage}`, source.link].filter((s) => s.length > 0).join(" · ");
	return `${body}\n>\n> — ${where}`;
}
