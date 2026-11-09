/**
 * 0.16 (#90) The PDF text under a highlighted region. Pure: no pdf.js, DOM or 'obsidian' import.
 *
 * `bands` are the rectangles the highlighter strokes of the region cover (page coordinates, pt); `boxes` are the text runs
 * of the PDF page placed on the page (`boxesOnPage`). A run counts when a band covers at least `MIN_LINE_OVERLAP` of its
 * height; inside it the words the bands cover (at least `WORD_COVERAGE` of the word) are kept, so the result is whole
 * words in reading order: lines top to bottom, runs left to right, one space between runs and words, a hyphenated word
 * at a line end joined again. The same word is never listed twice, even when several strokes cover it.
 */
import { prefixShare, type TextBox, type TextMeasure } from "./text-items";

export interface TextBand {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** A band must cover this share of a run's height for the run to be under the highlight. */
const MIN_LINE_OVERLAP = 0.4;
/** A word is under the highlight when the bands cover at least this share of its width. */
const WORD_COVERAGE = 0.4;
/** Two runs whose vertical centres are closer than this many heights are on one line. */
const SAME_LINE = 0.5;
/** Runs closer than this many heights are glued without a space. */
const GLUE_GAP = 0.12;

interface Piece {
	text: string;
	x0: number;
	x1: number;
	cy: number;
	h: number;
}

/** Merges overlapping x-intervals. */
function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
	const sorted = [...list].sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	for (const [a, b] of sorted) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** A rectangle in page coordinates (pt) whose text must never be quoted (a redaction box). */
export interface TextExclusion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Whether the word [a, b] of `box` may lie under an exclusion. The place of a word inside a run is measured, not known exactly, so it is
 * widened by the run's height on each side: a word near the edge of a box is left out rather than quoted.
 */
function excluded(box: TextBox, a: number, b: number, exclude: readonly TextExclusion[]): boolean {
	const slack = box.height;
	return exclude.some((r) => a - slack < r.x + r.width && r.x < b + slack && box.y < r.y + r.height && r.y < box.y + box.height);
}

/** The words of one run that the x-intervals cover, joined by single spaces ("" when none). */
function wordsCovered(box: TextBox, spans: ReadonlyArray<[number, number]>, measure: TextMeasure | undefined, exclude: readonly TextExclusion[]): string {
	const re = /\S+/gu;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(box.str))) {
		const a = box.x + box.width * prefixShare(box, m.index, measure);
		const b = box.x + box.width * prefixShare(box, m.index + m[0].length, measure);
		const width = Math.max(1e-6, b - a);
		let covered = 0;
		for (const [s0, s1] of spans) covered += Math.max(0, Math.min(b, s1) - Math.max(a, s0));
		if (covered / width >= WORD_COVERAGE && !excluded(box, a, b, exclude)) out.push(m[0]);
	}
	return out.join(" ");
}

/**
 * The text of the runs under `bands`; "" when there is none. 0.26 review fix (#285, P5): a word that any rectangle of `exclude` (the
 * redaction boxes of the page) touches, even in part, is never quoted, however much of it the bands cover.
 */
export function textUnderBands(boxes: readonly TextBox[], bands: readonly TextBand[], measure?: TextMeasure, exclude: readonly TextExclusion[] = []): string {
	if (bands.length === 0) return "";
	const pieces: Piece[] = [];
	for (const box of boxes) {
		if (box.str.trim() === "" || box.height <= 0 || box.width <= 0) continue;
		const spans: Array<[number, number]> = [];
		for (const band of bands) {
			const overlap = Math.min(box.y + box.height, band.y1) - Math.max(box.y, band.y0);
			if (overlap < box.height * MIN_LINE_OVERLAP) continue;
			const a = Math.max(box.x, band.x0);
			const b = Math.min(box.x + box.width, band.x1);
			if (b > a) spans.push([a, b]);
		}
		if (spans.length === 0) continue;
		const text = wordsCovered(box, mergeIntervals(spans), measure, exclude);
		if (text) pieces.push({ text, x0: box.x, x1: box.x + box.width, cy: box.y + box.height / 2, h: box.height });
	}
	// Lines top to bottom, runs of a line left to right.
	pieces.sort((a, b) => a.cy - b.cy);
	const lines: Piece[][] = [];
	for (const p of pieces) {
		const line = lines[lines.length - 1];
		const ref = line?.[0];
		if (line && ref && Math.abs(p.cy - ref.cy) <= Math.max(p.h, ref.h) * SAME_LINE) line.push(p);
		else lines.push([p]);
	}
	const lineTexts: string[] = [];
	for (const line of lines) {
		line.sort((a, b) => a.x0 - b.x0);
		let text = "";
		let prev: Piece | null = null;
		for (const p of line) {
			if (prev && p.x0 - prev.x1 < Math.min(prev.h, p.h) * GLUE_GAP && !/\s$/u.test(text)) text += p.text;
			else text += (text ? " " : "") + p.text;
			prev = p;
		}
		lineTexts.push(text);
	}
	let result = "";
	for (const line of lineTexts) {
		if (!result) result = line;
		else if (/\p{L}-$/u.test(result) && /^\p{Ll}/u.test(line)) result = result.slice(0, -1) + line;
		else result += ` ${line}`;
	}
	return result.replace(/\s+/g, " ").trim();
}
