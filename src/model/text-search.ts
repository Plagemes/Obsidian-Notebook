/**
 * Find and replace in the text boxes of a notebook (roadmap 361). Pure: the matching, the results of a whole document
 * and the undoable replacement. Only text boxes (`type: "text"`) are searched; handwriting is ink, not text, and marker
 * labels and box titles are not text boxes. No format change: a replacement is a ReplaceElement per text box, and
 * "Replace all" is one Batch, so it is one undo step.
 */
import { Batch, ReplaceElement, type Command } from "./history";
import type { NotebookDocument, Page, TextElement } from "./types";

export interface FindOptions {
	matchCase: boolean;
	wholeWord: boolean;
}

export const DEFAULT_FIND: Readonly<FindOptions> = { matchCase: false, wholeWord: false };

/** A match inside one text: [start, end) in UTF-16 code units. */
export interface TextMatch {
	start: number;
	end: number;
}

/** A match in the notebook. `element` is the text box as it is now (a replacement makes a new object: search again). */
export interface TextHit extends TextMatch {
	pageIndex: number;
	page: Page;
	element: TextElement;
	/** Position of the text box in the page's element array (reading order inside a page). */
	elementIndex: number;
	/** Which match of this text box (0-based), so that "replace this one" can find it again. */
	ordinal: number;
	/** A short piece of the text around the match, on one line. */
	before: string;
	match: string;
	after: string;
}

/** Longest list of results built for the panel (the count and "Replace all" are not limited by it). */
export const MAX_RESULTS = 500;
const SNIPPET_CONTEXT = 24;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD = "[\\p{L}\\p{N}_]";

/** The regular expression of a query (global, unicode); null for an empty query. */
export function queryRegExp(query: string, opts: FindOptions): RegExp | null {
	if (query.length === 0) return null;
	const body = escapeRegExp(query);
	// A whole word is not glued to a letter, digit or underscore on either side (accented and non-Latin letters count).
	const source = opts.wholeWord ? `(?<!${WORD})${body}(?!${WORD})` : body;
	return new RegExp(source, opts.matchCase ? "gu" : "giu");
}

/** Every match of `query` in `text`, left to right, not overlapping. */
export function findInText(text: string, query: string, opts: FindOptions = DEFAULT_FIND): TextMatch[] {
	const re = queryRegExp(query, opts);
	if (!re) return [];
	const out: TextMatch[] = [];
	for (const m of text.matchAll(re)) {
		if (m[0].length === 0 || m.index === undefined) continue;
		out.push({ start: m.index, end: m.index + m[0].length });
	}
	return out;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ");
}

function snippet(text: string, m: TextMatch): { before: string; match: string; after: string } {
	const from = Math.max(0, m.start - SNIPPET_CONTEXT);
	const to = Math.min(text.length, m.end + SNIPPET_CONTEXT);
	return {
		before: (from > 0 ? "…" : "") + oneLine(text.slice(from, m.start)),
		match: oneLine(text.slice(m.start, m.end)),
		after: oneLine(text.slice(m.end, to)) + (to < text.length ? "…" : ""),
	};
}

export interface FindResult {
	/** The first MAX_RESULTS hits, in reading order (page, then the order of the text boxes on the page). */
	hits: TextHit[];
	/** Matches in the whole notebook. */
	total: number;
	/** Text boxes that have at least one match. */
	boxes: number;
	truncated: boolean;
}

/** All matches of `query` in the text boxes of the notebook. */
export function findInDocument(doc: NotebookDocument, query: string, opts: FindOptions = DEFAULT_FIND): FindResult {
	const hits: TextHit[] = [];
	let total = 0;
	let boxes = 0;
	if (query.length > 0) {
		doc.pages.forEach((page, pageIndex) => {
			(page.elements ?? []).forEach((el, elementIndex) => {
				if (el.type !== "text") return;
				const matches = findInText(el.text, query, opts);
				if (matches.length === 0) return;
				boxes++;
				matches.forEach((m, ordinal) => {
					total++;
					if (hits.length < MAX_RESULTS) hits.push({ ...m, pageIndex, page, element: el, elementIndex, ordinal, ...snippet(el.text, m) });
				});
			});
		});
	}
	return { hits, total, boxes, truncated: total > hits.length };
}

/** `text` with the given matches replaced (matches in order and not overlapping, as findInText returns them). */
export function replaceMatches(text: string, matches: readonly TextMatch[], replacement: string): string {
	let out = "";
	let at = 0;
	for (const m of matches) {
		out += text.slice(at, m.start) + replacement;
		at = m.end;
	}
	return out + text.slice(at);
}

/** Replaces every match of `query` in `text`. */
export function replaceInText(text: string, query: string, replacement: string, opts: FindOptions = DEFAULT_FIND): string {
	return replaceMatches(text, findInText(text, query, opts), replacement);
}

/** A text box with new text; nothing else changes (id, position, size, colour). */
function withText(el: TextElement, text: string): TextElement {
	return { ...el, text };
}

function replaceCommands(boxes: Array<{ page: Page; element: TextElement; text: string }>): Command[] {
	return boxes
		.filter((b) => b.text !== b.element.text)
		.map((b) => new ReplaceElement(b.page.id, b.element, withText(b.element, b.text)));
}

/**
 * Replaces every match in the notebook as one undo step; null when nothing matches. A text box left with no text is kept
 * (the user may be clearing it on purpose; deleting boxes is a different action).
 */
export function replaceAllCommand(doc: NotebookDocument, query: string, replacement: string, opts: FindOptions = DEFAULT_FIND): { command: Command; replaced: number; boxes: number } | null {
	const re = queryRegExp(query, opts);
	if (!re) return null;
	const boxes: Array<{ page: Page; element: TextElement; text: string }> = [];
	let replaced = 0;
	for (const page of doc.pages) {
		for (const el of page.elements ?? []) {
			if (el.type !== "text") continue;
			const matches = findInText(el.text, query, opts);
			if (matches.length === 0) continue;
			replaced += matches.length;
			boxes.push({ page, element: el, text: replaceMatches(el.text, matches, replacement) });
		}
	}
	const commands = replaceCommands(boxes);
	if (commands.length === 0) return null;
	return { command: new Batch("Replace all", commands), replaced, boxes: commands.length };
}

/**
 * Replaces one match (the hit's own occurrence in its text box) as one undo step. Null when the text box is no longer the
 * one the hit was found in (it was edited or removed since), when the match is no longer there, or when the replacement
 * would not change anything.
 */
export function replaceHitCommand(doc: NotebookDocument, hit: TextHit, replacement: string, query: string, opts: FindOptions = DEFAULT_FIND): Command | null {
	if (!doc.pages.includes(hit.page) || !hit.page.elements?.includes(hit.element)) return null;
	const current = findInText(hit.element.text, query, opts)[hit.ordinal];
	if (!current || current.start !== hit.start || current.end !== hit.end) return null;
	const text = replaceMatches(hit.element.text, [current], replacement);
	return replaceCommands([{ page: hit.page, element: hit.element, text }])[0] ?? null;
}

/**
 * Index of the first hit at or after a place in reading order (page, text box, offset in the text), or -1 when there is none.
 * After a replacement the panel moves on to the next match with it, so a replacement that contains the query is not found again.
 */
export function nextHitIndex(hits: readonly TextHit[], at: { pageIndex: number; elementIndex: number; offset: number }): number {
	return hits.findIndex((h) =>
		h.pageIndex > at.pageIndex
		|| (h.pageIndex === at.pageIndex && (h.elementIndex > at.elementIndex || (h.elementIndex === at.elementIndex && h.start >= at.offset))));
}
