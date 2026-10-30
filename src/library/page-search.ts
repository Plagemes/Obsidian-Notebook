/** Quick switcher search (roadmap 364): pages across all notebooks, from the library index only. Pure, no 'obsidian'. */
import { foldText, normalizeText, type LibraryEntry } from "./index";

export type PageHitKind = "page" | "notebook" | "bookmark" | "tag" | "text" | "recent";

export interface PageHit {
	path: string;
	name: string;
	/** 0-based page. */
	page: number;
	kind: PageHitKind;
	score: number;
	/** Bookmark title, tag, text snippet or "when" for recents. */
	detail: string;
	/** Notebook modification time, for ties. */
	modified: number;
}

export const MAX_HITS = 40;
const MAX_TEXT_HITS_PER_NOTEBOOK = 4;

/** Fuzzy score of `query` in `target` (both already normalised): null = no match, higher = better. */
export function fuzzyScore(query: string, target: string): number | null {
	if (!query) return 0;
	const at = target.indexOf(query);
	if (at >= 0) {
		const wordStart = at === 0 || /[\s\-_/.]/.test(target[at - 1]!);
		return 100 + (at === 0 ? 30 : wordStart ? 15 : 0) - Math.min(target.length, 60) * 0.1;
	}
	let ti = 0;
	let run = 0;
	let score = 40;
	for (const ch of query) {
		const found = target.indexOf(ch, ti);
		if (found < 0) return null;
		run = found === ti ? run + 1 : 0;
		score += run * 3 - Math.min(found - ti, 10) * 0.5;
		ti = found + 1;
	}
	return Math.max(1, score - Math.min(target.length, 60) * 0.1);
}

export interface ParsedQuery {
	/** 1-based page typed as `12` or `p12`, if any. */
	page: number | null;
	words: string[];
}

export function parseQuery(input: string): ParsedQuery {
	const words: string[] = [];
	let page: number | null = null;
	for (const tok of normalizeText(input).split(/\s+/).filter(Boolean)) {
		const m = /^p?(\d{1,5})$/.exec(tok);
		if (m && page === null && Number(m[1]) >= 1) page = Number(m[1]);
		else words.push(tok);
	}
	return { page, words };
}

/** Sum of the best score of every word against the parts; null when a word matches none. */
function matchAll(words: readonly string[], parts: readonly string[]): number | null {
	let total = 0;
	for (const w of words) {
		let best: number | null = null;
		for (const p of parts) {
			const s = fuzzyScore(w, p);
			if (s !== null && (best === null || s > best)) best = s;
		}
		if (best === null) return null;
		total += best;
	}
	return total;
}

function snippet(text: string, folded: string, word: string): string {
	const i = Math.max(0, folded.indexOf(word));
	const from = Math.max(0, i - 25);
	const to = Math.min(text.length, i + word.length + 40);
	return (from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "");
}

/** Pages matching `input`, best first. Empty when the query is empty. */
export function searchPages(entries: readonly LibraryEntry[], input: string, limit = MAX_HITS): PageHit[] {
	const { page, words } = parseQuery(input);
	if (page === null && words.length === 0) return [];
	const hits: PageHit[] = [];
	const push = (e: LibraryEntry, p: number, kind: PageHitKind, score: number, detail: string) =>
		hits.push({ path: e.path, name: e.name, page: p, kind, score, detail, modified: e.modified });

	for (const e of entries) {
		const name = normalizeText(e.name);
		const nameScore = words.length === 0 ? 0 : matchAll(words, [name]);
		if (page !== null) {
			if (page <= e.pages && nameScore !== null) push(e, page - 1, "page", 300 + nameScore, "");
			if (words.length === 0) continue;
		} else if (nameScore !== null) {
			push(e, 0, "notebook", 200 + nameScore, "");
		}
		for (const b of e.bookmarks ?? []) {
			if (page !== null && page - 1 !== b.page) continue;
			const title = normalizeText(b.title);
			const s = matchAll(words, [title, name]);
			if (s !== null && words.some((w) => fuzzyScore(w, title) !== null)) push(e, b.page, "bookmark", 150 + s, b.title);
		}
		for (const pt of e.pageTags ?? []) {
			if (page !== null && page - 1 !== pt.page) continue;
			const tags = pt.tags.map(normalizeText);
			const s = matchAll(words, [...tags, name]);
			if (s !== null && words.some((w) => tags.some((t) => fuzzyScore(w, t) !== null))) push(e, pt.page, "tag", 120 + s, pt.tags.join(", "));
		}
		if (e.text && e.textPages && e.textPages.length >= 2) {
			const rest = words.filter((w) => fuzzyScore(w, name) === null);
			if (rest.length === 0) continue;
			const folded = foldText(e.text);
			let n = 0;
			for (let k = 0; k + 1 < e.textPages.length && n < MAX_TEXT_HITS_PER_NOTEBOOK; k += 2) {
				const p = e.textPages[k]!;
				if (page !== null && p !== page - 1) continue;
				const start = e.textPages[k + 1]!;
				const end = k + 3 < e.textPages.length ? e.textPages[k + 3]! : folded.length;
				const seg = folded.slice(start, end);
				if (rest.every((w) => seg.includes(w))) {
					push(e, p, "text", 60 + rest.length * 10, snippet(e.text.slice(start, end), seg, rest[0]!));
					n++;
				}
			}
		}
	}
	// One result per (notebook, page): keep the best.
	const best = new Map<string, PageHit>();
	for (const h of hits) {
		const key = `${h.path}\u0000${h.page}`;
		const old = best.get(key);
		if (!old || h.score > old.score) best.set(key, h);
	}
	return [...best.values()].sort((a, b) => b.score - a.score || b.modified - a.modified || a.page - b.page).slice(0, limit);
}
