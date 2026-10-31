/**
 * Headings from the size of the handwriting (roadmap #102, part of the generated outline #407). No OCR, no AI: a line
 * of ink is a heading when its letters are clearly taller than the page's usual letters, it is the first line of its
 * block (nothing written just above it) and it starts near the left of the text. Built on the lines `segmentText`
 * already finds (#255). Pure: no DOM, no Obsidian.
 */
import type { BBox } from "./hit-test";
import { segmentText, type TextLayout, type TextLine } from "./words";
import type { Stroke } from "../model/types";

export interface HeadingOptions {
	/** A line is a heading when its letters are at least this × the usual letter height. */
	minRatio: number;
	/** Letters at least this × the usual height make a top-level heading (level 1); the others are level 2. */
	level1Ratio: number;
	/** At least this many strokes (a single big stroke is a drawing, not a title). */
	minStrokes: number;
	/** At most this many strokes (a huge scribble is not a title). */
	maxStrokes: number;
	/** The line must start within this fraction of the page width from the text's left edge. */
	maxIndent: number;
	/** The line must not be taller than this fraction of the page height. */
	maxHeightFraction: number;
	/** Nothing may be written within this × the usual letter height above the line (it must start a block). */
	blockGap: number;
	/** Fewer lines than this on the page: the notebook's usual letter height is the reference when given. */
	minReferenceLines: number;
}

export const DEFAULT_HEADING_OPTIONS: Readonly<HeadingOptions> = {
	minRatio: 1.7,
	level1Ratio: 2.4,
	minStrokes: 2,
	maxStrokes: 80,
	maxIndent: 0.4,
	maxHeightFraction: 0.25,
	blockGap: 1,
	minReferenceLines: 3,
};

export interface PageHeading {
	strokeIds: string[];
	/** The ink's box, padded a little (pt), kept inside the page: what a thumbnail of the heading shows. */
	rect: { x: number; y: number; width: number; height: number };
	/** Letter height of the line over the reference. */
	ratio: number;
	/** 1 (biggest) or 2. */
	level: 1 | 2;
}

/** What a page contributes to the notebook-wide reference: the letter height of each of its lines, with the line's strokes as weight. */
export interface LineSize {
	height: number;
	weight: number;
}

export function lineSizes(layout: TextLayout): LineSize[] {
	return layout.lines.map((l) => ({ height: l.letterHeight, weight: l.strokeIds.length }));
}

/** Weighted median of the line heights (more strokes count more: a short title does not set the reference). 0 when empty. */
export function referenceHeight(sizes: readonly LineSize[]): number {
	const valid = sizes.filter((s) => s.height > 0 && s.weight > 0).sort((a, b) => a.height - b.height);
	let total = 0;
	for (const s of valid) total += s.weight;
	if (total === 0) return 0;
	let acc = 0;
	for (const s of valid) {
		acc += s.weight;
		if (acc * 2 >= total) return s.height;
	}
	return valid[valid.length - 1]!.height;
}

function pad(b: BBox, by: number, page: { width: number; height: number }): PageHeading["rect"] {
	const x0 = Math.max(0, b.minX - by);
	const y0 = Math.max(0, b.minY - by);
	const x1 = Math.min(page.width, b.maxX + by);
	const y1 = Math.min(page.height, b.maxY + by);
	const r = (n: number) => Math.round(n * 100) / 100;
	return { x: r(x0), y: r(y0), width: r(Math.max(1, x1 - x0)), height: r(Math.max(1, y1 - y0)) };
}

/**
 * The heading lines of a page. `notebookReference` (letter height, pt) is used when the page has too few lines to
 * have a usual size of its own; without it such a page has no headings.
 */
export function detectHeadings(
	layout: TextLayout,
	page: { width: number; height: number },
	notebookReference = 0,
	options: Partial<HeadingOptions> = {},
): PageHeading[] {
	const opt = { ...DEFAULT_HEADING_OPTIONS, ...options };
	const lines = layout.lines;
	if (lines.length === 0) return [];
	const own = referenceHeight(lineSizes(layout));
	const ref = lines.length >= opt.minReferenceLines ? own : notebookReference > 0 ? notebookReference : lines.length >= 2 ? own : 0;
	if (ref <= 0) return [];
	let left = Infinity;
	for (const l of lines) left = Math.min(left, l.bounds.minX);
	const out: PageHeading[] = [];
	for (const line of lines) {
		const ratio = line.letterHeight / ref;
		if (ratio < opt.minRatio) continue;
		if (line.strokeIds.length < opt.minStrokes || line.strokeIds.length > opt.maxStrokes) continue;
		if (line.bounds.maxY - line.bounds.minY > opt.maxHeightFraction * page.height) continue;
		if (line.bounds.minX - left > opt.maxIndent * page.width) continue;
		if (!startsBlock(line, lines, ref * opt.blockGap)) continue;
		out.push({
			strokeIds: line.strokeIds.slice(),
			rect: pad(line.bounds, 0.3 * line.letterHeight, page),
			ratio: Math.round(ratio * 100) / 100,
			level: ratio >= opt.level1Ratio ? 1 : 2,
		});
	}
	return out;
}

/** True when no other line sits just above `line` (overlapping it sideways, closer than `gap`). */
function startsBlock(line: TextLine, lines: readonly TextLine[], gap: number): boolean {
	for (const other of lines) {
		if (other === line) continue;
		if (other.bounds.maxX < line.bounds.minX || other.bounds.minX > line.bounds.maxX) continue;
		const above = line.bounds.minY - other.bounds.maxY;
		// A line above that touches or overlaps in height is a neighbour on the same row, not a line above.
		if (other.bounds.minY >= line.bounds.maxY) continue;
		if (above < gap && other.bounds.minY < line.bounds.minY) return false;
	}
	return true;
}

/** Layout of the visible strokes of a page (invisible ink is not read). */
export function pageLayout(strokes: readonly Stroke[]): TextLayout {
	return segmentText(strokes.some((s) => s.hidden) ? strokes.filter((s) => !s.hidden) : strokes);
}
