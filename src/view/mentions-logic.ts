/**
 * 0.18 mentions (O7): pure logic of the "Mentions" sheet: which links of a note point at a notebook, which page each one
 * names, how the hits are grouped (per page, and the ones naming the notebook as a whole) and the one-line context shown
 * for each. No Obsidian imports: testable in Node.
 */
import { pageTargetFromSubpath, resolvePageTarget } from "../integration/page-links";
import { splitLinktext } from "./hover-preview-logic";

/** The part of Obsidian's `ReferenceCache` this needs: `link` is the target with its subpath, the position is 0-based. */
export interface RawLink {
	link: string;
	line: number;
	col: number;
	endCol: number;
	embed: boolean;
}

/** One link (or embed) of a note that points at the notebook. */
export interface MentionHit {
	notePath: string;
	line: number;
	col: number;
	endCol: number;
	embed: boolean;
	/** The page it names, by id (so a reorder keeps it); null when it names the notebook as a whole (or a heading, or a page that is gone). */
	pageId: string | null;
}

/** The page id a link subpath names (null when it names no page, or a page the notebook no longer has). */
export function mentionPageId(subpath: string, pages: ReadonlyArray<{ id: string }>): string | null {
	const target = pageTargetFromSubpath(subpath);
	if (!target || pages.length === 0) return null;
	const found = resolvePageTarget(pages, target);
	return "index" in found ? pages[found.index]?.id ?? null : null;
}

/**
 * The hits of one note: its links and embeds for which `pointsAtNotebook(linkpath)` holds (the caller resolves the link path
 * the way Obsidian does), each with the page it names.
 */
export function hitsOfNote(
	notePath: string, links: readonly RawLink[], pointsAtNotebook: (linkpath: string) => boolean, pages: ReadonlyArray<{ id: string }>,
): MentionHit[] {
	const out: MentionHit[] = [];
	for (const l of links) {
		if (typeof l.link !== "string") continue;
		const { path, subpath } = splitLinktext(l.link);
		if (!pointsAtNotebook(path)) continue;
		out.push({ notePath, line: l.line, col: l.col, endCol: l.endCol, embed: l.embed, pageId: mentionPageId(subpath, pages) });
	}
	return out;
}

/** The hits in reading order within a note. */
function byPlace(a: MentionHit, b: MentionHit): number {
	return a.line - b.line || a.col - b.col;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/iu, "");

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** One row of the sheet: a note and its links to the group's target. */
export interface MentionRow {
	notePath: string;
	name: string;
	folder: string;
	hits: MentionHit[];
}

/** Rows (one per note, sorted by name then path) for the hits that `keep` accepts. */
function rowsOf(hits: readonly MentionHit[], keep: (h: MentionHit) => boolean): MentionRow[] {
	const byNote = new Map<string, MentionHit[]>();
	for (const h of hits) {
		if (!keep(h)) continue;
		const list = byNote.get(h.notePath);
		if (list) list.push(h);
		else byNote.set(h.notePath, [h]);
	}
	const rows: MentionRow[] = [...byNote].map(([notePath, list]) => ({ notePath, name: baseName(notePath), folder: folderOf(notePath), hits: list.sort(byPlace) }));
	return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.notePath < b.notePath ? -1 : a.notePath > b.notePath ? 1 : 0));
}

/** The notes that link to the page with this id. */
export function pageMentions(hits: readonly MentionHit[], pageId: string): MentionRow[] {
	return rowsOf(hits, (h) => h.pageId === pageId);
}

/** The notes that link to the notebook without naming a page. */
export function notebookMentions(hits: readonly MentionHit[]): MentionRow[] {
	return rowsOf(hits, (h) => h.pageId === null);
}

/**
 * Whether a change of the note at `changedPath` can change the notebook's mentions: the note is a source we already know, the
 * index already has it linking to the notebook (`indexed`: its `resolvedLinks` entry), or its fresh links now reach the
 * notebook (`linksNow`, only asked when the first two say no). Every other note's change leaves the sheet as it is.
 */
export function mentionsMayChange(
	changedPath: string, notebookPath: string, known: ReadonlySet<string>, indexed: Readonly<Record<string, number>> | undefined, linksNow: () => boolean,
): boolean {
	if (changedPath === notebookPath) return false;
	if (known.has(changedPath)) return true;
	if ((indexed?.[notebookPath] ?? 0) > 0) return true;
	return linksNow();
}

/** Whether every note of `known` still exists (a rename or delete of a source needs a fresh read of the index). */
export function sourcesIntact(known: ReadonlySet<string>, exists: (path: string) => boolean): boolean {
	for (const p of known) if (!exists(p)) return false;
	return true;
}

/** How many links name this page (the badge). */
export function pageMentionCount(hits: readonly MentionHit[], pageId: string | null | undefined): number {
	if (!pageId) return 0;
	let n = 0;
	for (const h of hits) if (h.pageId === pageId) n++;
	return n;
}

/** Longest line of context kept for a row. */
export const SNIPPET_MAX = 140;

/**
 * One line of context around a link: the line of the note with its whitespace collapsed, cut to about `max` characters
 * around the link (`startCol`..`endCol`) with an ellipsis where text was left out. A blank line gives "".
 */
export function contextSnippet(lineText: string, startCol: number, endCol: number, max = SNIPPET_MAX): string {
	const text = lineText.replace(/\r/gu, "");
	const from = Math.max(0, Math.min(text.length, startCol));
	const to = Math.max(from, Math.min(text.length, endCol));
	const before = text.slice(0, from).replace(/\s+/gu, " ").trimStart();
	const link = text.slice(from, to).replace(/\s+/gu, " ");
	const after = text.slice(to).replace(/\s+/gu, " ").trimEnd();
	if (before.length + link.length + after.length <= max) return before + link + after;
	// The link stays whole (cut only when it alone is too long); the rest of the budget is shared around it.
	const room = Math.max(0, max - link.length);
	let left = Math.min(before.length, Math.ceil(room / 2));
	const right = Math.min(after.length, room - left);
	left = Math.min(before.length, room - right);
	const head = left > 0 ? before.slice(before.length - left) : "";
	const tail = after.slice(0, right);
	const core = (head + link + tail).slice(0, Math.max(max, 1));
	return `${left < before.length ? "…" : ""}${core}${right < after.length ? "…" : ""}`;
}

/** The line `line` (0-based) of a note's text, or "" when it has fewer lines. */
export function lineOf(text: string, line: number): string {
	let start = 0;
	for (let i = 0; i < line; i++) {
		const nl = text.indexOf("\n", start);
		if (nl < 0) return "";
		start = nl + 1;
	}
	const end = text.indexOf("\n", start);
	return text.slice(start, end < 0 ? undefined : end);
}
