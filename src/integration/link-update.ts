/**
 * "Update page links" (wave 0.8, 388): finds links in notes that point at notebook pages and plans how to make them
 * follow the page. Pure: no 'obsidian' (the command in update-links.ts supplies the notebooks and applies the plan).
 *
 *   [[Physics.notebook#p3]]                     old link, names a position   -> pin: [[Physics.notebook#p3&id=<page id>]]
 *   [[Physics.notebook#p3&id=X]], X is page 5   the page moved               -> renumber: #p5&id=X
 *   [[Old.notebook#p3&id=X]], X is in New only  the page is in another file  -> relocate: [[New.notebook#p2&id=X]]
 *
 * A link is changed only when there is exactly one answer. Everything else is listed as skipped with the reason and left as
 * it is. Nothing here writes anything: the caller shows the plan (a dry run) and applies only what the user accepts.
 */
import { conflictBaseCandidates } from "../storage/conflicts";
import { parseSubpathParams, validPageId } from "../zettel/subpath";
import { parsePageFragment } from "./links";

export interface LinkRef {
	kind: "wiki" | "md";
	embed: boolean;
	/** Link path as written (Markdown links: percent-decoded). */
	path: string;
	/** Offsets into the note text: the link path, and the fragment after the `#` (both end exclusive). */
	pathStart: number;
	pathEnd: number;
	fragStart: number;
	fragEnd: number;
	fragment: string;
	/** 1-based line, for the list. */
	line: number;
	/** The text of that line (trimmed), so the list shows where the link is. */
	lineText: string;
}

/** Blank of the same length (offsets stay valid); line breaks are kept so that line numbers do too. */
function blank(s: string): string {
	return s.replace(/[^\n]/g, " ");
}

/**
 * A fence line: up to three spaces, or any indentation inside a list item or a blockquote/callout (`> `, `> > `, a
 * list marker), then three or more backticks or tildes.
 */
const FENCE = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;

/**
 * Blanks out what holds no links (same length, so offsets stay valid): the YAML frontmatter, fenced code blocks (also
 * inside blockquotes, callouts and lists), inline code and `%% … %%` comments (which may span lines).
 */
export function maskCode(text: string): string {
	const lines = text.split("\n");
	let start = 0;
	// Frontmatter: `---` on the first line, up to the next `---` or `...` line.
	if (/^---[ \t]*\r?$/.test(lines[0] ?? "")) {
		const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*\r?$/.test(l));
		if (end > 0) {
			for (let i = 0; i <= end; i++) lines[i] = blank(lines[i]!);
			start = end + 1;
		}
	}
	let fence: { char: string; length: number } | null = null;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i]!;
		const m = FENCE.exec(line);
		const run = m?.[1] ?? "";
		if (fence === null) {
			if (m) {
				fence = { char: run[0]!, length: run.length };
				lines[i] = blank(line);
			} else lines[i] = line.replace(/(`+)[^`\n]*?\1/g, (c) => blank(c));
			continue;
		}
		// A closing fence: the same character, at least as long, nothing after it.
		if (m && run[0] === fence.char && run.length >= fence.length && line.slice(m[0].length).trim() === "") fence = null;
		lines[i] = blank(line);
	}
	// Comments, outside code: from a %% to the next one (an unclosed one runs to the end of the note, as Obsidian shows it).
	return lines.join("\n").replace(/%%[\s\S]*?(?:%%|$)/g, (c) => blank(c));
}

function lineTextAt(text: string, offset: number): string {
	const from = text.lastIndexOf("\n", offset - 1) + 1;
	const to = text.indexOf("\n", offset);
	return text.slice(from, to < 0 ? text.length : to).trim();
}

/**
 * A notebook path as a Markdown link target: percent-encoded like `encodeURI`, and also `(`, `)`, `#` and `?`, which would
 * end the link or start its fragment (`Physics (1).notebook` -> `Physics%20%281%29.notebook`).
 */
export function encodeMarkdownPath(path: string): string {
	return encodeURI(path).replace(/[()#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Whether `path` is named like a sync conflicted copy (`Notes (1).notebook`, `Notes-DESKTOP-AB12.notebook`…) of another
 * notebook among `paths` in the same folder (storage/conflicts.ts). A link is never moved onto such a copy.
 */
export function isConflictedCopyPath(path: string, paths: Iterable<string>): boolean {
	const slash = path.lastIndexOf("/");
	const folder = path.slice(0, slash + 1);
	const stemOf = (name: string) => {
		const dot = name.lastIndexOf(".");
		return dot > 0 ? name.slice(0, dot) : name;
	};
	const bases = conflictBaseCandidates(stemOf(path.slice(slash + 1)));
	if (bases.length === 0) return false;
	for (const other of paths) {
		if (other === path || !other.startsWith(folder) || other.slice(folder.length).includes("/")) continue;
		if (bases.includes(stemOf(other.slice(folder.length)))) return true;
	}
	return false;
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

const WIKI = /(!?)\[\[([^[\]|#^\n]+)#([^[\]|\n]*)(?:\|[^[\]\n]*)?\]\]/g;
const MD = /(!?)\[[^\]\n]*\]\(<?([^)\s>#]+)#([^)\s>]*)>?\)/g;

/** Links with a page-like subpath (`#p3`, `#p3&id=…`, `#3`), wikilinks and Markdown links, outside code. The caller decides which of them name a notebook. */
export function scanPageLinks(text: string): LinkRef[] {
	const masked = maskCode(text);
	const out: LinkRef[] = [];
	for (const [re, kind] of [[WIKI, "wiki"], [MD, "md"]] as const) {
		re.lastIndex = 0;
		for (let m = re.exec(masked); m; m = re.exec(masked)) {
			const rawPath = m[2] ?? "";
			const fragment = m[3] ?? "";
			const params = parseSubpathParams(fragment);
			// Not a page subpath (a heading, a block id): not ours.
			if (params.bad !== null || !(parsePageFragment(params.head) !== null || (params.head === "" && params.pageId !== null))) continue;
			let pathStart: number;
			if (kind === "wiki") pathStart = m.index + (m[1] ?? "").length + 2;
			else {
				const open = m[0].indexOf("](") + 2;
				pathStart = m.index + open + (m[0][open] === "<" ? 1 : 0);
			}
			const fragStart = pathStart + rawPath.length + 1;
			let path = rawPath;
			if (kind === "md") {
				try {
					path = decodeURIComponent(rawPath);
				} catch {
					continue;
				}
			}
			out.push({
				kind, embed: m[1] === "!", path, pathStart, pathEnd: pathStart + rawPath.length, fragStart, fragEnd: fragStart + fragment.length,
				fragment, line: lineOf(text, m.index), lineText: lineTextAt(text, m.index),
			});
		}
	}
	return out.sort((a, b) => a.pathStart - b.pathStart);
}

/** The fragment with the page number and id replaced; any other parameter (a region) stays as written. */
export function rewriteFragment(fragment: string, page: number, pageId: string): string {
	const [, ...rest] = fragment.split("&");
	const kept = rest.filter((part) => (part.split("=")[0] ?? "").trim().toLowerCase() !== "id");
	return [`p${page}`, `id=${pageId}`, ...kept].join("&");
}

// ------------------------------------------------------------------------ plan

export interface NotebookLookup {
	/** The notebook a link path means (`source` = the note holding the link), or null if it is not a notebook. `ambiguous`: several notebooks could be meant. */
	resolve(linkPath: string, source: string): { path: string; ambiguous: boolean } | null;
	/** Page ids of a notebook in order; null when it cannot be read. */
	pageIds(path: string): Promise<readonly string[] | null>;
	/** Paths of the notebooks that have a page with this id (all of them, the linked one included). */
	notebooksWithPage(pageId: string): Promise<readonly string[]>;
	/** Link path to write for a notebook, from the note `source` (Obsidian's shortest unique name). */
	linkPathFor(path: string, source: string): string;
	/** Whether the notebook is a sync conflicted copy of another one: never the target of a relocation. */
	isConflictedCopy?(path: string): boolean;
	/**
	 * New ids of a page that "Move to notebook" had to give a new id (the target already had a page with its id), oldest
	 * move first. Empty when it never had to.
	 */
	movedPageIds?(pageId: string): Promise<readonly string[]>;
}

export type ChangeKind = "pin" | "renumber" | "relocate";

export interface LinkChange {
	notePath: string;
	line: number;
	/** The text of the line, trimmed (the list shows it). */
	lineText: string;
	kind: ChangeKind;
	/** Notebook the link points at after the change. */
	notebook: string;
	/** Replaces `text.slice(start, end)`, which must still read `before`. */
	start: number;
	end: number;
	before: string;
	after: string;
	/** The page number the link names after the change. */
	page: number;
}

export type SkipReason = "ambiguous-notebook" | "page-out-of-range" | "page-gone" | "id-in-several" | "unreadable";

export interface LinkSkip {
	notePath: string;
	line: number;
	reason: SkipReason;
	/** The link subpath as written. */
	text: string;
	/** The text of the line, trimmed. */
	lineText: string;
}

export interface LinkPlan {
	changes: LinkChange[];
	skipped: LinkSkip[];
}

/** Plans the changes for the links of one note. */
export async function planNoteLinks(notePath: string, text: string, lookup: NotebookLookup): Promise<LinkPlan> {
	const plan: LinkPlan = { changes: [], skipped: [] };
	for (const ref of scanPageLinks(text)) {
		const notebook = lookup.resolve(ref.path, notePath);
		if (!notebook) continue;
		const params = parseSubpathParams(ref.fragment);
		const page = parsePageFragment(params.head);
		const skip = (reason: SkipReason) => plan.skipped.push({ notePath, line: ref.line, lineText: ref.lineText, reason, text: `#${ref.fragment}` });
		const fragmentChange = (kind: ChangeKind, number: number, id: string): LinkChange => ({
			notePath, line: ref.line, lineText: ref.lineText, kind, notebook: notebook.path, start: ref.fragStart, end: ref.fragEnd, before: ref.fragment,
			after: rewriteFragment(ref.fragment, number, id), page: number,
		});

		const ids = await lookup.pageIds(notebook.path);
		if (params.pageId === null) {
			// An old link: a position. Pinned to the page that has this number now.
			if (notebook.ambiguous) skip("ambiguous-notebook");
			else if (!ids) skip("unreadable");
			else if (page === null || page > ids.length) skip("page-out-of-range");
			else plan.changes.push(fragmentChange("pin", page, ids[page - 1]!));
			continue;
		}
		if (!validPageId(params.pageId)) continue;
		if (notebook.ambiguous) {
			skip("ambiguous-notebook");
			continue;
		}
		const index = ids ? ids.indexOf(params.pageId) : -1;
		if (ids && index >= 0) {
			if (page !== index + 1) plan.changes.push(fragmentChange("renumber", index + 1, params.pageId));
			continue;
		}
		if (!ids) {
			skip("unreadable");
			continue;
		}
		// The page is not in the linked notebook: exactly one other notebook with that id is the answer. Conflicted copies of
		// a notebook hold the same ids and are never the answer. A page that "Move to notebook" gave a new id is found under it.
		const holders = async (id: string) =>
			(await lookup.notebooksWithPage(id)).filter((p) => p !== notebook.path && !lookup.isConflictedCopy?.(p));
		let pageId = params.pageId;
		let others = await holders(pageId);
		if (others.length === 0) {
			for (const renamed of (await lookup.movedPageIds?.(params.pageId)) ?? []) {
				const found = await holders(renamed);
				if (found.length === 0) continue;
				pageId = renamed;
				others = found;
				break;
			}
		}
		if (others.length === 0) {
			skip("page-gone");
			continue;
		}
		if (others.length > 1) {
			skip("id-in-several");
			continue;
		}
		const target = others[0]!;
		const targetIds = await lookup.pageIds(target);
		const at = targetIds ? targetIds.indexOf(pageId) : -1;
		if (at < 0) {
			skip("unreadable");
			continue;
		}
		const linkPath = lookup.linkPathFor(target, notePath);
		const written = ref.kind === "md" ? encodeMarkdownPath(linkPath) : linkPath;
		plan.changes.push({
			notePath, line: ref.line, lineText: ref.lineText, kind: "relocate", notebook: target, start: ref.pathStart, end: ref.fragEnd,
			// Exactly what the note has there now (a Markdown path can be encoded in more than one way).
			before: text.slice(ref.pathStart, ref.fragEnd),
			after: `${written}#${rewriteFragment(ref.fragment, at + 1, pageId)}`, page: at + 1,
		});
	}
	return plan;
}

/**
 * Applies the accepted changes to the text of a note. A change whose text is no longer where it was (the note was edited
 * since the plan) is left out and counted. Returns the new text.
 */
export function applyLinkChanges(text: string, changes: readonly LinkChange[]): { text: string; applied: number; stale: number } {
	let out = text;
	let applied = 0;
	let stale = 0;
	// From the end of the note, so earlier offsets stay valid.
	for (const c of [...changes].sort((a, b) => b.start - a.start)) {
		if (out.slice(c.start, c.end) !== c.before) {
			stale++;
			continue;
		}
		out = out.slice(0, c.start) + c.after + out.slice(c.end);
		applied++;
	}
	return { text: out, applied, stale };
}
