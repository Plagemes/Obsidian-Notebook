/** Go to page number (roadmap 366): what the typed text means. Pure, no 'obsidian'. */
import { normalizeText } from "../library/index";

export interface GotoBookmark {
	/** 0-based page. */
	index: number;
	title: string;
}

export interface GotoTarget {
	index: number;
	kind: "page" | "bookmark";
	label: string;
}

/**
 * Suggestions for `input` in a notebook of `total` pages: a page when it is "12" or "p12" and exists, then bookmarks
 * whose title starts with the text (then those that contain it). With no input, all titled bookmarks.
 */
export function gotoTargets(input: string, total: number, bookmarks: readonly GotoBookmark[]): GotoTarget[] {
	const q = normalizeText(input.trim());
	const out: GotoTarget[] = [];
	const m = /^p?\s*(\d{1,6})$/.exec(q);
	if (m) {
		const n = Number(m[1]);
		if (n >= 1 && n <= total) out.push({ index: n - 1, kind: "page", label: String(n) });
	}
	const seen = new Set(out.map((o) => o.index));
	const add = (b: GotoBookmark) => {
		if (seen.has(b.index)) return;
		seen.add(b.index);
		out.push({ index: b.index, kind: "bookmark", label: b.title });
	};
	if (!q) {
		for (const b of bookmarks) add(b);
		return out;
	}
	for (const b of bookmarks) if (normalizeText(b.title).startsWith(q)) add(b);
	for (const b of bookmarks) if (normalizeText(b.title).includes(q)) add(b);
	return out;
}
