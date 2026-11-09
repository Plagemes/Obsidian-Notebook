/**
 * 0.27 pdfsuggest (#418): terms suggested under the PDF search box. Pure: no 'obsidian', no DOM, nothing stored, no format
 * change, no AI.
 *
 * Sources of one notebook (never another one): the outline of the PDFs it shows, its headings (box titles, bookmark titles,
 * marker and sticky labels) and the frequent meaningful words of the text the person typed in it (stop-words of English and
 * Italian left out). Handwriting is ink: it has no text to take words from, so it is not a source.
 *
 * The pool is bounded and ranked once per document (`SuggestCache`, keyed by a cheap signature of the sources, built in idle
 * time by the view); typing only filters the pool (`filterSuggestions`: prefix, word prefix, substring, one-typo), which is a
 * few hundred string comparisons per keystroke and never runs per frame.
 */
import { contentWords } from "../model/tag-suggest";
import { mapPdfOutline, type OutlineEntryLike } from "../model/pdf-outline-map";
import type { NotebookDocument, Page } from "../model/types";

export type SuggestSource = "outline" | "heading" | "text";

export interface Suggestion {
	/** The text to search for (shown on the chip). */
	term: string;
	source: SuggestSource;
	/** Higher first. */
	score: number;
}

export interface SuggestInput {
	/** PDF outline titles in reading order. */
	outline: readonly string[];
	/** Headings and labels, most important first. */
	headings: readonly string[];
	/** Typed text blocks. */
	text: readonly string[];
}

/** Pool limits: whatever the notebook holds, the pool stays this small. */
export const MAX_OUTLINE_TERMS = 120;
export const MAX_HEADING_TERMS = 60;
export const MAX_TEXT_TERMS = 60;
/** Characters of typed text read (a long notebook stays cheap). */
export const MAX_TEXT_CHARS = 30_000;
/** Longest chip, characters (a longer title is cut at a word). */
export const MAX_TERM_CHARS = 40;
/** A word of the text must come this often to be suggested. */
export const MIN_WORD_COUNT = 2;
/** Shortest term that can be searched (the search itself refuses less). */
export const MIN_TERM_CHARS = 2;

const BASE = { outline: 3000, heading: 2000, text: 0 } as const;

/** Lower case without accents: how terms are compared (the PDF search ignores both too). */
export function foldTerm(s: string): string {
	return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A title as a chip: one line, cut at a word when long; "" when nothing searchable is left (numbers, a lone symbol). */
export function cleanTerm(raw: string): string {
	let s = raw.replace(/\s+/g, " ").trim();
	if (s.length > MAX_TERM_CHARS) {
		const cut = s.slice(0, MAX_TERM_CHARS);
		const space = cut.lastIndexOf(" ");
		s = (space >= MAX_TERM_CHARS / 2 ? cut.slice(0, space) : cut).trim();
	}
	s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	if ([...s].length < MIN_TERM_CHARS || !/\p{L}/u.test(s)) return "";
	return s;
}

/** Ranked, deduplicated suggestions. Equal terms (ignoring case and accents) keep the strongest source. */
export function buildPool(input: SuggestInput): Suggestion[] {
	const seen = new Set<string>();
	const out: Suggestion[] = [];
	const add = (raw: string, source: SuggestSource, score: number): boolean => {
		const term = cleanTerm(raw);
		if (!term) return false;
		const key = foldTerm(term);
		if (seen.has(key)) return false;
		seen.add(key);
		out.push({ term, source, score });
		return true;
	};
	let n = 0;
	for (const raw of input.outline) {
		if (n >= MAX_OUTLINE_TERMS) break;
		if (add(raw, "outline", BASE.outline - n * 0.01)) n++;
	}
	n = 0;
	for (const raw of input.headings) {
		if (n >= MAX_HEADING_TERMS) break;
		if (add(raw, "heading", BASE.heading - n * 0.01)) n++;
	}
	// Frequent words: counted on the folded form, shown in the first spelling seen.
	const counts = new Map<string, { word: string; n: number }>();
	let chars = 0;
	for (const block of input.text) {
		if (chars >= MAX_TEXT_CHARS) break;
		const part = block.length > MAX_TEXT_CHARS - chars ? block.slice(0, MAX_TEXT_CHARS - chars) : block;
		chars += part.length;
		for (const word of contentWords(part)) {
			const key = foldTerm(word);
			const have = counts.get(key);
			if (have) have.n++;
			else counts.set(key, { word, n: 1 });
		}
	}
	const words = [...counts.entries()].filter(([, v]) => v.n >= MIN_WORD_COUNT).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
	n = 0;
	for (const [, v] of words) {
		if (n >= MAX_TEXT_TERMS) break;
		if (add(v.word, "text", BASE.text + Math.min(v.n, 999))) n++;
	}
	return out;
}

/** Edit distance of `a` and `b` when it is at most `max`, else `max + 1`. */
export function boundedDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
			row.push(v);
			if (v < best) best = v;
		}
		if (best > max) return max + 1;
		prev = row;
	}
	return prev[b.length]!;
}

/** How well `typed` (folded) fits a term (folded): 4 prefix, 3 prefix of a word, 2 inside, 1 one typo in a word's start (from four letters typed), 0 no. */
export function matchTier(typed: string, term: string): number {
	if (term.startsWith(typed)) return 4;
	const words = term.split(/[\s\-_/.,;:()]+/).filter(Boolean);
	if (words.some((w) => w.startsWith(typed))) return 3;
	if (term.includes(typed)) return 2;
	if ([...typed].length >= 4) {
		for (const w of words) {
			// Compare with the start of the word as long as what was typed (and one longer/shorter, for a missing or extra letter).
			for (const len of [typed.length, typed.length + 1, typed.length - 1]) {
				if (len < 2 || len > w.length) continue;
				if (boundedDistance(typed, w.slice(0, len), 1) <= 1) return 1;
			}
		}
	}
	return 0;
}

/** Share of the chips each source gets when nothing is typed (the rest goes to whichever has more). */
const QUOTA: Readonly<Record<SuggestSource, number>> = { outline: 0.5, heading: 0.25, text: 0.25 };

/**
 * The chips to show: with nothing typed, a mix of the sources in rank order; with something typed, the terms it fits, best fit
 * first (then rank). A term equal to what is typed is left out (searching it is what Enter does).
 */
export function filterSuggestions(pool: readonly Suggestion[], typed: string, limit: number): Suggestion[] {
	const max = Math.max(0, Math.floor(limit));
	if (max === 0 || pool.length === 0) return [];
	const q = foldTerm(typed);
	if (q === "") {
		const picked: Suggestion[] = [];
		const left = new Set(pool);
		for (const source of ["outline", "heading", "text"] as const) {
			const quota = Math.max(1, Math.round(max * QUOTA[source]));
			for (const s of pool) {
				if (picked.length >= max || quota <= picked.filter((p) => p.source === source).length) break;
				if (s.source === source) {
					picked.push(s);
					left.delete(s);
				}
			}
		}
		for (const s of pool) {
			if (picked.length >= max) break;
			if (left.has(s)) picked.push(s);
		}
		return picked.sort((a, b) => b.score - a.score);
	}
	const scored: Array<{ s: Suggestion; tier: number }> = [];
	for (const s of pool) {
		const term = foldTerm(s.term);
		if (term === q) continue;
		const tier = matchTier(q, term);
		if (tier > 0) scored.push({ s, tier });
	}
	scored.sort((a, b) => b.tier - a.tier || b.s.score - a.s.score);
	return scored.slice(0, max).map((x) => x.s);
}

/** A cheap fingerprint of the sources: equal sources give an equal key, whatever objects hold them. */
export function signatureOf(input: SuggestInput): string {
	let a = 0x811c9dc5;
	let n = 0;
	const feed = (s: string): void => {
		for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
		a = Math.imul(a ^ 0x1f, 0x01000193);
		n += s.length;
	};
	for (const group of [input.outline, input.headings, input.text]) {
		for (const s of group) feed(s);
		feed("|");
	}
	return `${input.outline.length}.${input.headings.length}.${input.text.length}.${n}.${(a >>> 0).toString(16)}`;
}

/** The pool of one open document, rebuilt only when its sources changed. */
export class SuggestCache {
	private key: string | null = null;
	private pool: readonly Suggestion[] = [];
	/** Pools built so far (for tests and the status of the cache). */
	built = 0;

	/** The pool for these sources; builds it when they are not the ones last seen. */
	get(input: SuggestInput): readonly Suggestion[] {
		const key = signatureOf(input);
		if (key !== this.key) {
			this.pool = buildPool(input);
			this.key = key;
			this.built++;
		}
		return this.pool;
	}

	/** Forgets the pool (another document was opened). */
	clear(): void {
		this.key = null;
		this.pool = [];
	}
}

/** The outlines already known, by PDF asset id (what the view's outline source keeps). */
export type KnownOutlines = Readonly<Record<string, readonly OutlineEntryLike[]>>;

const pagesOf = (doc: Pick<NotebookDocument, "pages">): readonly Page[] => doc.pages ?? [];

/**
 * Reads the sources out of ONE notebook document: the titles of the outline entries of its PDFs that it shows, the titles
 * and labels of its boxes, bookmarks, markers, stickies and checklists, and the text of its text boxes (capped).
 */
export function gatherSuggestInput(doc: Pick<NotebookDocument, "pages" | "meta" | "assets"> | null | undefined, outlines: KnownOutlines = {}): SuggestInput {
	const out: { outline: string[]; headings: string[]; text: string[] } = { outline: [], headings: [], text: [] };
	if (!doc) return out;
	const pages = pagesOf(doc);
	for (const [asset, entries] of Object.entries(outlines)) {
		for (const m of mapPdfOutline(pages, asset, entries)) out.outline.push(m.title);
	}
	for (const info of Object.values(doc.meta?.bookmarkInfo ?? {})) if (typeof info?.title === "string" && info.title) out.headings.push(info.title);
	let size = 0;
	for (const page of pages) {
		for (const el of page.elements ?? []) {
			if (el.type === "text") {
				if (typeof el.text === "string" && size < MAX_TEXT_CHARS) {
					out.text.push(el.text);
					size += el.text.length;
				}
			} else if (el.type === "box") {
				if (typeof el.title === "string" && el.title) out.headings.push(el.title);
			} else if (el.type === "marker") {
				if (typeof el.text === "string" && el.text) out.headings.push(el.text);
			} else if (el.type === "sticky") {
				if (typeof el.text === "string" && size < MAX_TEXT_CHARS) {
					out.text.push(el.text);
					size += el.text.length;
				}
			} else if (el.type === "checkbox") {
				if (typeof el.label === "string" && size < MAX_TEXT_CHARS) {
					out.text.push(el.label);
					size += el.label.length;
				}
			}
		}
	}
	return out;
}
