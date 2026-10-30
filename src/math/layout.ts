/**
 * Placing equations among handwriting (#110): the size of the typeset maths follows the handwriting next to it, so a
 * formula sits naturally in the notes. Pure: the caller passes the lines found by ink/words.ts (segmentText).
 */

export interface HandwritingLine {
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	/** Median letter height of the line, pt. */
	letterHeight: number;
}

/** Smallest and largest automatic equation size, pt. */
export const EQUATION_SIZE_MIN = 8;
export const EQUATION_SIZE_MAX = 72;
/**
 * Equation size (the em of the maths font) per pt of median handwritten letter height. A handwritten line's median
 * letter is about one x-height and a half (small letters with some ascenders); TeX's x-height is 0.43 em.
 */
export const EM_PER_LETTER_HEIGHT = 1.9;

/**
 * Size for an equation placed at (x, y): from the nearest handwritten line (vertically within three of its letter
 * heights, horizontally within 40 of them), or null when there is no handwriting near.
 */
export function equationSizeNear(lines: readonly HandwritingLine[], x: number, y: number): number | null {
	let best: { d: number; h: number } | null = null;
	for (const l of lines) {
		const h = l.letterHeight;
		if (!(h > 0)) continue;
		const dy = y < l.bounds.minY ? l.bounds.minY - y : y > l.bounds.maxY ? y - l.bounds.maxY : 0;
		const dx = x < l.bounds.minX ? l.bounds.minX - x : x > l.bounds.maxX ? x - l.bounds.maxX : 0;
		if (dy > h * 3 || dx > h * 40) continue;
		const d = dy * 4 + dx;
		if (!best || d < best.d) best = { d, h };
	}
	if (!best) return null;
	const size = Math.round(best.h * EM_PER_LETTER_HEIGHT * 2) / 2;
	return Math.min(EQUATION_SIZE_MAX, Math.max(EQUATION_SIZE_MIN, size));
}

/** Structures of the editor's palette: LaTeX inserted at the caret, `□` marking where the caret goes next. */
export const EQUATION_SNIPPETS = {
	fraction: "\\frac{□}{}",
	root: "\\sqrt{□}",
	nthRoot: "\\sqrt[n]{□}",
	power: "^{□}",
	index: "_{□}",
	matrix: "\\begin{pmatrix} □ & b \\\\ c & d \\end{pmatrix}",
	integral: "\\int_{a}^{b} □ \\, dx",
	sum: "\\sum_{i=1}^{n} □",
	limit: "\\lim_{x \\to □}",
	system: "\\begin{cases} □ & x > 0 \\\\ 0 & x \\le 0 \\end{cases}",
	aligned: "\\begin{aligned} □ &= b \\\\ &= c \\end{aligned}",
} as const;
export type EquationSnippet = keyof typeof EQUATION_SNIPPETS;

/**
 * `text` with `snippet` inserted over the selection [from, to); returns the new text and the caret (where `□` was, the
 * marker removed).
 */
export function insertSnippet(text: string, from: number, to: number, snippet: string): { text: string; caret: number } {
	const at = snippet.indexOf("□");
	const clean = snippet.replace("□", "");
	const out = text.slice(0, from) + clean + text.slice(to);
	return { text: out, caret: from + (at >= 0 ? at : clean.length) };
}
