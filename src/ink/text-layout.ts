import type { TextElement } from "../model/types";
import type { BBox } from "./hit-test";

/** Line height as a multiple of the font size. */
export const LINE_HEIGHT = 1.25;

/** Width in pt of `s` at the given font size (the view supplies `ctx.measureText`; tests supply a fixed-pitch stub). */
export type MeasureText = (s: string, fontSize: number) => number;

/** Rough fixed-pitch estimate used when no measure function is available. */
export const estimateMeasure: MeasureText = (s, fontSize) => Array.from(s).length * fontSize * 0.55;

export interface TextLayout {
	lines: string[];
	height: number;
	lineHeight: number;
}

/** Greedy split of a word that is wider than `width` into pieces that fit (at least one character each). */
function breakWord(word: string, width: number, measure: (s: string) => number): string[] {
	const pieces: string[] = [];
	let cur = "";
	for (const ch of Array.from(word)) {
		if (cur !== "" && measure(cur + ch) > width) {
			pieces.push(cur);
			cur = ch;
		} else cur += ch;
	}
	pieces.push(cur);
	return pieces;
}

/**
 * Wraps `text` into lines no wider than `width`. Breaks at spaces, breaks words wider than the box by characters,
 * keeps explicit newlines (an empty paragraph is an empty line). Spaces at a wrap point are dropped.
 * `measure` gives the width of a string at the font size being laid out.
 */
export function layoutText(text: string, fontSize: number, width: number, measure: (s: string) => number): TextLayout {
	const lineHeight = LINE_HEIGHT * fontSize;
	const lines: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
		const words = paragraph.split(" ");
		// Starts a new line with `word`, pushing the pieces of an overlong word; returns the open line.
		const start = (word: string) => {
			if (word === "" || measure(word) <= width) return word;
			const pieces = breakWord(word, width, measure);
			const last = pieces.pop()!;
			lines.push(...pieces);
			return last;
		};
		let line = start(words[0]!);
		for (let i = 1; i < words.length; i++) {
			const w = words[i]!;
			const candidate = line + " " + w;
			if (measure(candidate) <= width) line = candidate;
			else if (w === "") continue; // space at a wrap point
			else {
				lines.push(line);
				line = start(w);
			}
		}
		lines.push(line);
	}
	return { lines, height: lines.length * lineHeight, lineHeight };
}

/** Box of a text element: `x`, `y`, `width` and the height of the wrapped text. */
export function textElementBounds(el: TextElement, measure: MeasureText = estimateMeasure): BBox {
	const { height } = layoutText(el.text, el.fontSize, el.width, (s) => measure(s, el.fontSize));
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + height };
}
