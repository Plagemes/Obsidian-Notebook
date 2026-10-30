// wave 0.10 (81): the pages an export or a print covers, typed as "1-3, 5, 8-". Pure: no 'obsidian', no DOM.

export type PageRangeError = "empty" | "syntax" | "backwards" | "outOfRange";

export type PageRangeResult =
	| { ok: true; /** 0-based page indices, ascending, without duplicates. */ pages: number[] }
	| { ok: false; error: PageRangeError; /** The part of the text that is wrong (syntax, backwards). */ text?: string; /** The 1-based page that does not exist (outOfRange). */ page?: number };

/** Longest number accepted: a page number beyond this is certainly a typing mistake. */
const MAX_DIGITS = 7;

/**
 * Reads a list of pages and ranges: `3`, `2-5`, `8-` (to the last page), `-4` (from the first), separated by commas,
 * semicolons or spaces. Dashes may have spaces around them (`2 - 5`) and may be en or em dashes. Pages are numbered
 * from 1 as people read them. A page that does not exist is an error, not silently dropped.
 */
export function parsePageRange(input: string, count: number): PageRangeResult {
	const text = input.replace(/\s*[-‐-―−]\s*/g, "-").trim();
	if (text === "") return { ok: false, error: "empty" };
	const chosen = new Set<number>();
	for (const token of text.split(/[,;\s]+/)) {
		if (token === "") continue;
		const m = /^(\d*)-(\d*)$/.exec(token) ?? /^(\d+)()$/.exec(token);
		if (!m || (m[1] === "" && m[2] === "") || m[1]!.length > MAX_DIGITS || m[2]!.length > MAX_DIGITS) return { ok: false, error: "syntax", text: token };
		const single = !token.includes("-");
		const from = m[1] === "" ? 1 : Number(m[1]);
		const to = single ? from : m[2] === "" ? count : Number(m[2]);
		if (from < 1) return { ok: false, error: "outOfRange", page: from };
		if (from > count) return { ok: false, error: "outOfRange", page: from };
		if (to < 1 || to > count) return { ok: false, error: "outOfRange", page: to };
		if (to < from) return { ok: false, error: "backwards", text: token };
		for (let n = from; n <= to; n++) chosen.add(n - 1);
	}
	if (chosen.size === 0) return { ok: false, error: "empty" };
	return { ok: true, pages: [...chosen].sort((a, b) => a - b) };
}

/** `[0, 1, 2, 4]` -> `1-3, 5`: the way the pages are read back to the user. */
export function formatPageRange(pages: readonly number[]): string {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
		parts.push(j > i ? `${sorted[i]! + 1}-${sorted[j]! + 1}` : String(sorted[i]! + 1));
		i = j + 1;
	}
	return parts.join(", ");
}
