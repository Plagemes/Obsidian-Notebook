/**
 * Standard Helvetica (PDF base-14 font) metrics and WinAnsi text helpers, used by the PDF writer
 * to wrap text without embedding a font. The advance widths are the public Adobe AFM values
 * (units of 1/1000 em) for character codes 32..255 in WinAnsiEncoding.
 */

// prettier-ignore
const WIDTHS: readonly number[] = [
	// 32..47
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
	// 48..63
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
	// 64..79
	1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
	// 80..95
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
	// 96..111
	333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
	// 112..127
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
	// 128..143
	556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
	// 144..159
	350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667,
	// 160..175
	278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
	// 176..191
	400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
	// 192..207
	667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
	// 208..223
	722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
	// 224..239
	556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
	// 240..255
	556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** Unicode code points of WinAnsi 0x80..0x9F that are not Latin-1 controls. */
const WIN_ANSI_HIGH: Readonly<Record<number, number>> = {
	0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
	0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
	0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
	0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * WinAnsi code (32..255) of a Unicode code point. Tab and other whitespace map to a space;
 * anything not representable maps to "?".
 */
export function winAnsiCode(cp: number): number {
	if (cp === 9) return 32;
	if (cp === 0xa0) return 0xa0;
	if (cp >= 32 && cp <= 126) return cp;
	if (cp >= 0xa1 && cp <= 0xff) return cp;
	return WIN_ANSI_HIGH[cp] ?? 63;
}

/** Advance width of a WinAnsi code at `fontSize` pt. */
export function helveticaCodeWidth(code: number, fontSize: number): number {
	return ((WIDTHS[code - 32] ?? 556) * fontSize) / 1000;
}

/** WinAnsi codes of a string (one per code point). */
export function toWinAnsi(text: string): number[] {
	const out: number[] = [];
	for (const ch of text) out.push(winAnsiCode(ch.codePointAt(0)!));
	return out;
}

/** Width in pt of `text` set in Helvetica at `fontSize`. */
export function helveticaWidth(text: string, fontSize: number): number {
	let w = 0;
	for (const c of toWinAnsi(text)) w += helveticaCodeWidth(c, fontSize);
	return w;
}

/**
 * Greedy word wrap to `maxWidth` pt. Newlines start a new line (empty lines are kept), runs of
 * spaces collapse at a wrap point, and a word wider than the box is split between characters.
 * Every line holds at least one character, so the result is finite even for a tiny width.
 * Returns lines as WinAnsi code arrays.
 */
export function wrapHelvetica(text: string, fontSize: number, maxWidth: number): number[][] {
	const lines: number[][] = [];
	const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
	for (const para of paragraphs) {
		const codes = toWinAnsi(para);
		let line: number[] = [];
		let lineW = 0;
		let i = 0;
		while (i < codes.length) {
			// Next token: a run of spaces or a run of non-spaces.
			const isSpace = codes[i] === 32;
			let j = i;
			let tokW = 0;
			while (j < codes.length && (codes[j] === 32) === isSpace) {
				tokW += helveticaCodeWidth(codes[j]!, fontSize);
				j++;
			}
			const token = codes.slice(i, j);
			i = j;
			if (isSpace) {
				if (line.length > 0) {
					line.push(...token);
					lineW += tokW;
				}
				continue;
			}
			if (line.length > 0 && lineW + tokW > maxWidth) {
				while (line.length > 0 && line[line.length - 1] === 32) line.pop();
				lines.push(line);
				line = [];
				lineW = 0;
			}
			if (tokW <= maxWidth) {
				line.push(...token);
				lineW += tokW;
				continue;
			}
			// A word wider than the box: split it by characters.
			for (const c of token) {
				const cw = helveticaCodeWidth(c, fontSize);
				if (line.length > 0 && lineW + cw > maxWidth) {
					lines.push(line);
					line = [];
					lineW = 0;
				}
				line.push(c);
				lineW += cw;
			}
		}
		while (line.length > 0 && line[line.length - 1] === 32) line.pop();
		lines.push(line);
	}
	return lines;
}
