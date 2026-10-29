/**
 * Search in the text of a PDF page (roadmap 44). Pure: no pdf.js, DOM or 'obsidian' import, tested in Node.
 *
 * The text of a page comes from pdf.js as positioned runs (see text-items.ts). `assemblePageText` joins them into
 * one string (reading order = content-stream order) and remembers where each run sits in it, so a match in the
 * string can be turned back into boxes on the page. Matching ignores case, accents, ligatures and the amount of
 * white space.
 */
import type { PageTextContent, TextBox } from "./text-items";

/** Where the text of run `item` sits in the assembled page text: `text.slice(start, end) === items[item].str`. */
export interface TextSpan {
	item: number;
	start: number;
	end: number;
}

/** The text of one page as a single string and the spans of its runs. */
export interface PageText {
	text: string;
	spans: TextSpan[];
}

/** A match in `PageText.text` (UTF-16 offsets, end exclusive). */
export interface TextHit {
	start: number;
	end: number;
}

/** Shortest query that is searched: one letter would match nearly everything. */
export const MIN_QUERY_LENGTH = 2;

/** A run on the same line as the previous one is separated from it by a space when the gap is wider than this many heights. */
const WORD_GAP = 0.12;

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/**
 * Joins the runs of a page. Runs on one line that touch are joined as they are; a gap, a new line or a
 * white-space run in between becomes one space. Runs without text are skipped.
 */
export function assemblePageText(items: readonly TextBox[]): PageText {
	let text = "";
	const spans: TextSpan[] = [];
	let prev: TextBox | null = null;
	items.forEach((box, item) => {
		if (box.str.length === 0) return;
		if (prev && text.length > 0 && !isSpace(text[text.length - 1]) && !isSpace(box.str[0])) {
			const h = Math.max(prev.height, box.height, 1e-6);
			const sameLine = Math.abs(prev.y + prev.height / 2 - (box.y + box.height / 2)) < h * 0.6;
			const gap = box.x - (prev.x + prev.width);
			if (!sameLine || gap > h * WORD_GAP) text += " ";
		}
		spans.push({ item, start: text.length, end: text.length + box.str.length });
		text += box.str;
		prev = box;
	});
	return { text, spans };
}

/** Text prepared for matching, with the offset in the original of every character. */
export interface Normalized {
	norm: string;
	/** `origin[i]` = offset in the original text of the character that produced `norm[i]`. */
	origin: Uint32Array;
	/** `length[i]` = UTF-16 length in the original of that character (1 or 2; a ligature is one character). */
	length: Uint8Array;
}

const slow = new Map<string, string>();

/** Lower case without accents or compatibility forms ("ﬁ" → "fi"), white space as nothing here (see `normalizeText`). */
function foldChar(ch: string): string {
	let f = slow.get(ch);
	if (f === undefined) {
		f = ch.normalize("NFKD").toLowerCase().replace(/[\p{M}­​-‍⁠﻿]/gu, "");
		if (slow.size < 4096) slow.set(ch, f);
	}
	return f;
}

/**
 * Case-, accent- and white-space-insensitive form of `text` for matching: letters are lower-cased and stripped of
 * accents, ligatures are expanded, every run of white space becomes one space, soft hyphens and zero-width
 * characters vanish. Plain ASCII takes a fast path (no `normalize` call), so a page costs microseconds.
 */
export function normalizeText(text: string): Normalized {
	const n = text.length;
	// A character expands to at most 18 code units (U+FDFA); the arrays grow when needed.
	let cap = n + 16;
	let origin = new Uint32Array(cap);
	let length = new Uint8Array(cap);
	let out = "";
	let count = 0;
	let lastSpace = false;
	const push = (s: string, at: number, len: number): void => {
		for (let k = 0; k < s.length; k++) {
			if (count >= cap) {
				cap *= 2;
				const o = new Uint32Array(cap);
				o.set(origin);
				origin = o;
				const l = new Uint8Array(cap);
				l.set(length);
				length = l;
			}
			origin[count] = at;
			length[count] = len;
			count++;
		}
		out += s;
	};
	for (let i = 0; i < n; ) {
		const code = text.charCodeAt(i);
		let step = 1;
		let folded: string;
		if (code < 128) {
			if (code === 32 || (code >= 9 && code <= 13)) folded = " ";
			else if (code >= 65 && code <= 90) folded = String.fromCharCode(code + 32);
			else folded = String.fromCharCode(code);
		} else {
			const cp = text.codePointAt(i)!;
			const ch = String.fromCodePoint(cp);
			step = ch.length;
			folded = /\s/u.test(ch) ? " " : foldChar(ch);
		}
		if (folded === " ") {
			if (!lastSpace) push(" ", i, step);
			lastSpace = true;
		} else if (folded.length > 0) {
			push(folded, i, step);
			lastSpace = false;
		}
		i += step;
	}
	return { norm: out, origin: origin.subarray(0, count), length: length.subarray(0, count) };
}

/** The query as matched: normalised and trimmed; "" when it is shorter than `MIN_QUERY_LENGTH`. */
export function normalizeQuery(query: string): string {
	const q = normalizeText(query).norm.trim();
	return q.length >= MIN_QUERY_LENGTH ? q : "";
}

/**
 * Every non-overlapping match of `query` (already through `normalizeQuery`) in the page text, at most `limit`,
 * as offsets into `page.text`.
 */
export function findInPage(page: PageText, query: string, limit = Infinity): TextHit[] {
	if (!query || page.text.length === 0 || limit <= 0) return [];
	const n = normalizeText(page.text);
	const hits: TextHit[] = [];
	let from = 0;
	while (hits.length < limit) {
		const at = n.norm.indexOf(query, from);
		if (at < 0) break;
		const last = at + query.length - 1;
		hits.push({ start: n.origin[at]!, end: n.origin[last]! + n.length[last]! });
		from = at + query.length;
	}
	return hits;
}

/** The text around a match, white space collapsed, for the results list. `cutBefore` / `cutAfter`: the text goes on. */
export interface Snippet {
	before: string;
	match: string;
	after: string;
	cutBefore: boolean;
	cutAfter: boolean;
}

export function snippetOf(text: string, hit: TextHit, radius = 36): Snippet {
	const collapse = (s: string): string => s.replace(/\s+/g, " ");
	let from = Math.max(0, hit.start - radius);
	let to = Math.min(text.length, hit.end + radius);
	// Do not cut a word in half when there is a space nearby.
	if (from > 0) {
		const sp = text.indexOf(" ", from);
		if (sp >= 0 && sp < hit.start) from = sp + 1;
	}
	if (to < text.length) {
		const sp = text.lastIndexOf(" ", to);
		if (sp > hit.end) to = sp;
	}
	return {
		before: collapse(text.slice(from, hit.start)),
		match: collapse(text.slice(hit.start, hit.end)),
		after: collapse(text.slice(hit.end, to)),
		cutBefore: from > 0,
		cutAfter: to < text.length,
	};
}

/**
 * Boxes of a match on the PDF page (viewport coordinates at scale 1, like `PageTextContent`): the part of each run
 * the match covers, assuming equal character widths inside a run, and boxes of one line that are close merged into one.
 */
export function hitBoxes(content: PageTextContent, page: PageText, hit: TextHit): TextBox[] {
	const parts: TextBox[] = [];
	for (const span of page.spans) {
		if (span.end <= hit.start) continue;
		if (span.start >= hit.end) break;
		const box = content.items[span.item];
		const len = span.end - span.start;
		if (!box || len <= 0) continue;
		const a = Math.max(hit.start, span.start) - span.start;
		const b = Math.min(hit.end, span.end) - span.start;
		parts.push({
			str: box.str.slice(a, b),
			x: box.x + (box.width * a) / len,
			y: box.y,
			width: (box.width * (b - a)) / len,
			height: box.height,
		});
	}
	return mergeLineBoxes(parts);
}

/** Merges consecutive boxes that sit on the same line with a gap of less than `gap` heights. */
export function mergeLineBoxes(boxes: readonly TextBox[], gap = 0.6): TextBox[] {
	const out: TextBox[] = [];
	for (const b of boxes) {
		const last = out[out.length - 1];
		if (last) {
			const h = Math.max(last.height, b.height, 1e-6);
			const sameLine = Math.abs(last.y + last.height / 2 - (b.y + b.height / 2)) < h * 0.5;
			if (sameLine && b.x - (last.x + last.width) <= h * gap && b.x + b.width >= last.x) {
				const x = Math.min(last.x, b.x);
				const y = Math.min(last.y, b.y);
				const right = Math.max(last.x + last.width, b.x + b.width);
				const bottom = Math.max(last.y + last.height, b.y + b.height);
				out[out.length - 1] = { str: last.str + b.str, x, y, width: right - x, height: bottom - y };
				continue;
			}
		}
		out.push({ ...b });
	}
	return out;
}
