/**
 * Search text for the companion note (0.19, O19): the typed text of a page that Obsidian's global search should find, as
 * Markdown lines safe to put inside the generated region. Pure: no 'obsidian'.
 *
 * Sources: sticky notes, margin comments and their replies, equation sources (LaTeX, as inline code), and the labels of
 * markers (questions, gaps, importance; homework is already a task line) and the typed labels of checkboxes (with a ☐ / ☑
 * for their state; an unlabelled box has no typed text and adds nothing). Text boxes and box titles are written by
 * companion-content.ts itself. Everything is escaped so the text stays plain text: no link, tag, comment, math, HTML or block.
 * The result per page is bounded (`SEARCH_PAGE_MAX` characters); when it is cut, the last line says so.
 */
import { cleanMarkerText } from "./markers";
import type { Page } from "./types";

/** Longest search text written for one page, characters (the notebook's own text boxes are not counted). */
export const SEARCH_PAGE_MAX = 4000;
/** Longest single item, characters. */
export const SEARCH_ITEM_MAX = 800;
/** Written as the last line of a page whose search text was cut. */
export const SEARCH_CUT_NOTE = "- … (more text on this page is not listed)";

/** Plain-text escape for one run of text: nothing in it can become a link, tag, comment, math, HTML, emphasis or block. */
export function escapeSearchText(raw: string): string {
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.replace(/[\\`*_[\]<>#$%|~^=!{}]/g, "\\$&").replace(/^([-+]|\d+[.)])(?=\s|$)/, "\\$1");
}

/** An equation source as inline code: one line, no backtick or comment marker inside, so it cannot end the span or the region. */
export function equationCode(latex: string): string {
	const s = latex.replace(/\s+/g, " ").trim().replace(/`/g, "'").replace(/%%/g, "% %");
	return s ? `\`${s}\`` : "";
}

function clip(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function byPosition<T extends { x: number; y: number }>(items: readonly T[]): T[] {
	return items.map((e, i) => ({ e, i })).sort((a, b) =>
		(Number(a.e.y) || 0) - (Number(b.e.y) || 0) || (Number(a.e.x) || 0) - (Number(b.e.x) || 0) || a.i - b.i).map(({ e }) => e);
}

function items(page: Page): string[] {
	const out: string[] = [];
	const els = (Array.isArray(page.elements) ? page.elements : []).filter((e): e is NonNullable<typeof e> => typeof e === "object" && e !== null);
	for (const e of byPosition(els)) {
		if (e.type === "sticky" && typeof e.text === "string") {
			const t = escapeSearchText(clip(e.text, SEARCH_ITEM_MAX));
			if (t) out.push(`- sticky: ${t}`);
		} else if (e.type === "equation" && typeof e.latex === "string") {
			const c = equationCode(clip(e.latex, SEARCH_ITEM_MAX));
			if (c) out.push(`- equation: ${c}`);
		} else if (e.type === "marker" && e.kind !== "homework") {
			const label = cleanMarkerText(e.text);
			const t = label ? escapeSearchText(clip(label, SEARCH_ITEM_MAX)) : "";
			if (t) out.push(`- ${e.kind}: ${t}`);
		} else if (e.type === "checkbox" && typeof e.label === "string") {
			// v17 (#103): the typed label, with the tick as a plain symbol (no `[x]`: that would be a task or a link to the reader).
			const t = escapeSearchText(clip(e.label, SEARCH_ITEM_MAX));
			if (t) out.push(`- checkbox: ${e.checked === true ? "☑" : "☐"} ${t}`);
		}
	}
	const comments = Array.isArray(page.comments) ? page.comments : [];
	for (const c of comments) {
		if (typeof c !== "object" || c === null || typeof c.text !== "string") continue;
		const t = escapeSearchText(clip(c.text, SEARCH_ITEM_MAX));
		if (t) out.push(`- ${"parent" in c ? "reply" : "comment"}: ${t}`);
	}
	return out;
}

/** The search lines of one page (empty when it has none), bounded; a cut ends with `SEARCH_CUT_NOTE`. */
export function searchLines(page: Page | undefined): string[] {
	if (!page) return [];
	const all = items(page);
	const out: string[] = [];
	let size = 0;
	for (const line of all) {
		if (size + line.length > SEARCH_PAGE_MAX) {
			out.push(SEARCH_CUT_NOTE);
			break;
		}
		out.push(line);
		size += line.length + 1;
	}
	return out;
}
