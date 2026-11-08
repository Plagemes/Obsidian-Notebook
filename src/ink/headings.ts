/**
 * Headings from the size of the handwriting (roadmap #102, part of the generated outline #407). No OCR, no AI: a line
 * of ink is a heading when its letters are clearly taller than the page's usual letters, it is the first line of its
 * block (nothing written just above it) and it starts near the left of the text. Built on the lines `segmentText`
 * already finds (#255). Pure: no DOM, no Obsidian.
 */
import type { BBox } from "./hit-test";
import { segmentText, type TextLayout, type TextLine } from "./words";
import { isWritingPen, type Stroke } from "../model/types";

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
	/** A line that is underlined is a heading from this × the usual letter height (always level 2: the underline lowers the bar, it does not raise the level). */
	minRatioUnderlined: number;
	/** An underline is at least this × the usual letter height long. */
	underlineMinLength: number;
	/** An underline covers at least this fraction of the shorter of itself and the line, sideways. */
	underlineCover: number;
}

/**
 * Thresholds (letter height of the line over the page's usual letter height, the weighted median of its lines):
 *  - below 1.7 the line is body text (handwriting varies by about 30 % within one page, and a line of capitals runs
 *    about 1.4 times a line of lower-case letters);
 *  - 1.7 to 2.4: a level 2 heading, 2.4 and over: level 1 (a title is usually twice to three times the body size);
 *  - an underlined line is a level 2 heading from 1.25 (a slightly larger, underlined word is how people mark a heading
 *    without writing big); an underlined line of ordinary size is not a heading (it may be an emphasis).
 * Colour is not used: pen colour is a style choice that people change for highlights as much as for titles.
 */
export const DEFAULT_HEADING_OPTIONS: Readonly<HeadingOptions> = {
	minRatio: 1.7,
	level1Ratio: 2.4,
	minStrokes: 2,
	maxStrokes: 80,
	maxIndent: 0.4,
	maxHeightFraction: 0.25,
	blockGap: 1,
	minReferenceLines: 3,
	minRatioUnderlined: 1.25,
	underlineMinLength: 3,
	underlineCover: 0.6,
};

export interface PageHeading {
	/** The line's strokes, and the underline's when it has one. */
	strokeIds: string[];
	/** A stroke is drawn under the line. */
	underlined?: true;
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

/** A long, nearly straight, nearly horizontal stroke: a candidate underline. */
export interface Rule {
	id: string;
	box: BBox;
	/** Midpoint, and slope (dy/dx) of the chord. */
	mx: number;
	my: number;
	slope: number;
	length: number;
}

/** The strokes that could be underlines: pen or shape, straight within 30 %, at most about 27 degrees off horizontal, at least `minLength` long. */
export function underlineCandidates(strokes: readonly Stroke[], minLength: number): Rule[] {
	const out: Rule[] = [];
	for (const s of strokes) {
		if (s.hidden || (!isWritingPen(s.tool) && s.tool !== "shape")) continue;
		const pts = s.points;
		if (pts.length < 2) continue;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, path = 0;
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i]!;
			if (p[0] < minX) minX = p[0];
			if (p[0] > maxX) maxX = p[0];
			if (p[1] < minY) minY = p[1];
			if (p[1] > maxY) maxY = p[1];
			if (i > 0) path += Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]);
		}
		const a = pts[0]!, b = pts[pts.length - 1]!;
		const dx = b[0] - a[0], dy = b[1] - a[1];
		const chord = Math.hypot(dx, dy);
		if (chord < minLength || path > 1.3 * chord || Math.abs(dx) < 2 * Math.abs(dy)) continue;
		out.push({ id: s.id, box: { minX, minY, maxX, maxY }, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, slope: dy / dx, length: chord });
	}
	return out;
}

/** For each line, the longest candidate drawn under it (parallel to its baseline, covering most of it); each candidate belongs to the line it sits closest under. */
function underlinesOf(lines: readonly TextLine[], rules: readonly Rule[], opt: HeadingOptions): Array<Rule | undefined> {
	const best: Array<{ rule: Rule; off: number } | undefined> = lines.map(() => undefined);
	for (const r of rules) {
		let pick = -1;
		let pickOff = Infinity;
		lines.forEach((l, i) => {
			const b = l.baseline;
			const lh = l.letterHeight;
			if (Math.abs(r.slope - b.slope) > 0.12) return;
			const off = r.my - (b.y0 + b.slope * (r.mx - b.x0));
			if (off < -0.25 * lh || off > 1.1 * lh) return;
			const over = Math.min(r.box.maxX, l.bounds.maxX) - Math.max(r.box.minX, l.bounds.minX);
			const lineW = l.bounds.maxX - l.bounds.minX;
			const ruleW = r.box.maxX - r.box.minX;
			if (over < opt.underlineCover * Math.min(ruleW, lineW) || ruleW > 1.6 * lineW + 2 * lh) return;
			if (Math.abs(off) < Math.abs(pickOff)) { pick = i; pickOff = off; }
		});
		if (pick < 0) continue;
		const have = best[pick];
		if (!have || r.length > have.rule.length) best[pick] = { rule: r, off: pickOff };
	}
	return best.map((b) => b?.rule);
}

/**
 * The heading lines of a page. `notebookReference` (letter height, pt) is used when the page has too few lines to
 * have a usual size of its own; without it such a page has no headings. `strokes` (the page's visible strokes) lets a
 * line with a stroke drawn under it count as a heading from a smaller size (`minRatioUnderlined`).
 */
export function detectHeadings(
	layout: TextLayout,
	page: { width: number; height: number },
	notebookReference = 0,
	options: Partial<HeadingOptions> = {},
	strokes: readonly Stroke[] = [],
): PageHeading[] {
	const opt = { ...DEFAULT_HEADING_OPTIONS, ...options };
	const lines = layout.lines;
	if (lines.length === 0) return [];
	const own = referenceHeight(lineSizes(layout));
	const ref = lines.length >= opt.minReferenceLines ? own : notebookReference > 0 ? notebookReference : lines.length >= 2 ? own : 0;
	if (ref <= 0) return [];
	let left = Infinity;
	for (const l of lines) left = Math.min(left, l.bounds.minX);
	// Only lines that are a little larger than usual can need their underline looked for.
	const rules = strokes.length > 0 ? underlineCandidates(strokes, opt.underlineMinLength * ref) : [];
	const under = rules.length > 0 ? underlinesOf(lines, rules, opt) : [];
	const out: PageHeading[] = [];
	lines.forEach((line, n) => {
		const ratio = line.letterHeight / ref;
		const rule = under[n];
		if (ratio < (rule ? opt.minRatioUnderlined : opt.minRatio)) return;
		const body = rule ? line.strokeIds.filter((id) => id !== rule.id) : line.strokeIds;
		if (body.length < opt.minStrokes || body.length > opt.maxStrokes) return;
		if (line.bounds.maxY - line.bounds.minY > opt.maxHeightFraction * page.height) return;
		if (line.bounds.minX - left > opt.maxIndent * page.width) return;
		if (!startsBlock(line, lines, ref * opt.blockGap)) return;
		const box: BBox = rule
			? { minX: Math.min(line.bounds.minX, rule.box.minX), minY: Math.min(line.bounds.minY, rule.box.minY), maxX: Math.max(line.bounds.maxX, rule.box.maxX), maxY: Math.max(line.bounds.maxY, rule.box.maxY) }
			: line.bounds;
		const ids = rule && !line.strokeIds.includes(rule.id) ? [...line.strokeIds, rule.id] : line.strokeIds.slice();
		const level: 1 | 2 = rule ? 2 : ratio >= opt.level1Ratio ? 1 : 2;
		const heading: PageHeading = { strokeIds: ids, rect: pad(box, 0.3 * line.letterHeight, page), ratio: Math.round(ratio * 100) / 100, level };
		if (rule) heading.underlined = true;
		out.push(heading);
	});
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
