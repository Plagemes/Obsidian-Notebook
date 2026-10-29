/**
 * Pure logic for page links (`[[Physics.notebook#p3]]`), native embeds (`![[Physics.notebook#p3]]`),
 * page suggestions and the file explorer menu. No Obsidian imports: testable in Node.
 */
import type { Page } from "../model/types";
import { parseSubpathParams } from "../zettel/subpath";
import { pageFromState, parsePageFragment } from "./links";

// ------------------------------------------------------------------------- subpaths

/** Page (1-based) from a link subpath: `#p3`, `#3`, `#page=3` (Z1 card parameters after `&` ignored). Headings and block ids give null. */
export function pageFromSubpath(subpath: string): number | null {
	const s = subpath.trim();
	return parsePageFragment(parseSubpathParams(s.startsWith("#") ? s.slice(1) : s).head);
}

/** Link subpath that points at a page, as Obsidian writes it after the file name. */
export function pageSubpath(page: number): string {
	return `#p${Math.max(1, Math.floor(page))}`;
}

/**
 * Page requested by Obsidian's ephemeral state. Following a link calls `setEphemeralState({ subpath })`;
 * the plugin's own callers may pass `{ page }`.
 */
export function pageFromEphemeralState(state: unknown): number | null {
	if (typeof state !== "object" || state === null) return null;
	const subpath = (state as { subpath?: unknown }).subpath;
	if (typeof subpath === "string") {
		const page = pageFromSubpath(subpath);
		if (page !== null) return page;
	}
	return pageFromState(state);
}

/** `generateMarkdownLink` may or may not add the `!` of an embed; this makes it match `embed`. */
export function withEmbedMarker(link: string, embed: boolean): string {
	const bare = link.startsWith("!") ? link.slice(1) : link;
	return embed ? `!${bare}` : bare;
}

/** Text to insert at the cursor: an embed starts on its own line and ends with a line break. */
export function insertionText(link: string, embed: boolean, atLineStart: boolean): string {
	return embed ? `${atLineStart ? "" : "\n"}${link}\n` : link;
}

// ------------------------------------------------------------------- native embeds

/** Whether the `src` of an `.internal-embed` element (`Physics.notebook#p3`) points at a notebook file. */
export function isNotebookEmbedSrc(src: string, extensions: readonly string[]): boolean {
	const hash = src.indexOf("#");
	const path = (hash >= 0 ? src.slice(0, hash) : src).trim().toLowerCase();
	return extensions.some((ext) => path.endsWith(`.${ext.toLowerCase()}`));
}

/** `notebook` code block text that renders the same preview as a native embed with this `src`. */
export function embedSourceFromSrc(src: string): string {
	return `[[${src.trim()}]]`;
}

/** The same for a resolved file (`path`) and the subpath Obsidian passed (`#p3`, or empty for page 1). */
export function embedSourceFromFile(path: string, subpath: string): string {
	return `path: ${path}${subpath.trim()}`;
}

// ---------------------------------------------------------------- link suggestions

export interface PageLinkTrigger {
	/** Text between `[[` and `#`: the link path typed so far. */
	linkpath: string;
	/** What was typed after `#`. */
	query: string;
	/** Index in the line prefix where `query` starts. */
	queryStart: number;
}

/**
 * Detects `[[Name#query` (or `![[Name#query`) at the end of the text before the cursor.
 * Returns null when the cursor is not inside the subpath of an unfinished link.
 */
export function parsePageLinkTrigger(linePrefix: string): PageLinkTrigger | null {
	const m = /\[\[([^[\]|#^]+)#([^[\]|#^]*)$/.exec(linePrefix);
	if (!m) return null;
	const query = m[2] ?? "";
	return { linkpath: (m[1] ?? "").trim(), query, queryStart: linePrefix.length - query.length };
}

export const PAGE_TITLE_MAX = 60;

/** First non-empty line of the first text box of a page (top to bottom, then left to right), shortened. */
export function pageTitle(page: Page): string | null {
	const boxes = (page.elements ?? []).filter((e) => e.type === "text");
	boxes.sort((a, b) => a.y - b.y || a.x - b.x);
	for (const box of boxes) {
		const line = box.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
		if (line) return line.length > PAGE_TITLE_MAX ? `${line.slice(0, PAGE_TITLE_MAX - 1).trimEnd()}…` : line;
	}
	return null;
}

export interface PageSuggestion {
	/** 1-based page number. */
	page: number;
	title: string | null;
	hasInk: boolean;
}

export const MAX_PAGE_SUGGESTIONS = 200;

/**
 * Pages matching what was typed after `#`: nothing lists them all, digits (with or without `p`)
 * match the start of the page number, other text matches the title.
 */
export function pageSuggestions(pages: readonly Page[], query: string): PageSuggestion[] {
	const q = query.trim().toLowerCase();
	const numeric = /^(?:p|page)?\s*[=-]?\s*(\d*)$/.exec(q);
	const out: PageSuggestion[] = [];
	for (let i = 0; i < pages.length && out.length < MAX_PAGE_SUGGESTIONS; i++) {
		const page = pages[i];
		if (!page) continue;
		const title = pageTitle(page);
		const number = String(i + 1);
		let match: boolean;
		if (q === "") match = true;
		else if (numeric) match = number.startsWith(numeric[1] ?? "");
		else match = (title ?? "").toLowerCase().includes(q);
		if (match) out.push({ page: i + 1, title, hasInk: page.strokes.length > 0 });
	}
	return out;
}

// ------------------------------------------------------------- file explorer menu

export type FileMenuKind = "folder" | "pdf";

/** What the file explorer menu offers for an entry: a new notebook in a folder, annotating a PDF. */
export function fileMenuKind(entry: { isFolder: boolean; extension?: string }): FileMenuKind | null {
	if (entry.isFolder) return "folder";
	return entry.extension?.toLowerCase() === "pdf" ? "pdf" : null;
}
