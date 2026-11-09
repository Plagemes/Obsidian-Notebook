/**
 * 0.26 gallery (#421): the `notebook-gallery` code block of a Markdown note. Pure: no 'obsidian', nothing is written anywhere.
 *
 *     ```notebook-gallery
 *     tag: #exam
 *     course: Analysis
 *     marked: question|homework
 *     bookmarked
 *     limit: 12
 *     sort: recent
 *     ```
 *
 * Each line is a condition and all conditions must hold for a page (several values of one line: `tag` needs all of them, `marked`
 * any of them). `tag` is a page tag, `bookmarked` a bookmark (the notebook's own titled bookmarks and the global ones), `marked`
 * a marker kind (gap, question, important, critical, star, homework: any marker of that kind on the page) or a kind of the
 * marked-pages filter (bookmark, global, marker, meaning, task, tag), `course` the timetable course a notebook belongs to,
 * `notebook` a notebook (its path or name, or a folder). Without a page condition the gallery shows the first page of every
 * matching notebook, or all the pages of the notebook when `notebook` names exactly one. `limit` defaults to 12 (at most 60),
 * `sort` to `recent` (the notebook changed last first; `title` sorts by notebook name).
 */
import type { LibraryEntry } from "../library/index";
import { normalizePageTag } from "../model/page-tags";
import { MARKER_KINDS, type Page } from "../model/types";
import { isMarkKind, MARK_KINDS, pageMarks, type MarkContext } from "../ui/nav-marked";

export const GALLERY_LANG = "notebook-gallery";
export const GALLERY_DEFAULT_LIMIT = 12;
export const GALLERY_MAX_LIMIT = 60;
/** Most notebooks read to look at their pages (marker conditions need the pages themselves, not the index). */
export const GALLERY_MAX_READS = 30;

export type GallerySort = "recent" | "title";

export interface GalleryQuery {
	tags: string[];
	bookmarked: boolean;
	courses: string[];
	notebooks: string[];
	/** Marker kinds and marked-pages kinds, any of which marks the page. */
	marked: string[];
	limit: number;
	sort: GallerySort;
}

export type GalleryError = "syntax" | "unknown-key" | "bad-value";
export type GalleryParse = { ok: true; query: GalleryQuery } | { ok: false; error: GalleryError; detail: string };

const KEYS: Record<string, "tag" | "bookmarked" | "course" | "notebook" | "marked" | "limit" | "sort"> = {
	tag: "tag", tags: "tag", bookmarked: "bookmarked", bookmark: "bookmarked", course: "course", notebook: "notebook",
	marked: "marked", mark: "marked", limit: "limit", sort: "sort",
};

const isMarker = (v: string): boolean => (MARKER_KINDS as readonly string[]).includes(v);
export const isGalleryMark = (v: string): boolean => isMarker(v) || isMarkKind(v);
/** Every value `marked:` accepts, markers first. */
export const GALLERY_MARKS: readonly string[] = [...MARKER_KINDS, ...MARK_KINDS];

export function emptyGalleryQuery(): GalleryQuery {
	return { tags: [], bookmarked: false, courses: [], notebooks: [], marked: [], limit: GALLERY_DEFAULT_LIMIT, sort: "recent" };
}

function unquote(v: string): string {
	const q = v[0];
	return (q === '"' || q === "'") && v.length >= 2 && v.endsWith(q) ? v.slice(1, -1).trim() : v;
}

/** The values of one line: split at commas (and `|` for marked), tags also at a `#`. */
function listOf(value: string, key: "tag" | "marked" | "other"): string[] {
	const text = unquote(value.trim());
	if (key === "other") return text === "" ? [] : [text];
	const sep = key === "marked" ? /[|,;\s]+/ : /[,;]|\s+(?=#)/;
	return text.split(sep).map((s) => s.trim()).filter(Boolean);
}

const lower = (s: string) => s.toLowerCase();
const pushUnique = (list: string[], v: string) => {
	if (!list.some((x) => lower(x) === lower(v))) list.push(v);
};

/** Reads the lines of a gallery block. A line it cannot read is an error that names it (never guessed). */
export function parseGalleryQuery(source: string): GalleryParse {
	const q = emptyGalleryQuery();
	for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
		const text = line.trim();
		if (text === "" || text.startsWith("//")) continue;
		const m = /^([A-Za-z]+)\s*(?:[:=]\s*(.*))?$/.exec(text);
		if (!m) return { ok: false, error: "syntax", detail: text };
		const key = KEYS[lower(m[1]!)];
		if (!key) return { ok: false, error: "unknown-key", detail: m[1]! };
		const value = (m[2] ?? "").trim();
		switch (key) {
			case "bookmarked": {
				if (value === "" || /^(true|yes|on|1)$/i.test(value)) q.bookmarked = true;
				else if (/^(false|no|off|0)$/i.test(value)) q.bookmarked = false;
				else return { ok: false, error: "bad-value", detail: `${m[1]}: ${value}` };
				break;
			}
			case "tag": {
				const tags = listOf(value, "tag").map(normalizePageTag).filter((x): x is string => x !== null);
				if (tags.length === 0) return { ok: false, error: "bad-value", detail: `${m[1]}: ${value}` };
				for (const t of tags) pushUnique(q.tags, t);
				break;
			}
			case "marked": {
				const kinds = listOf(value, "marked").map(lower);
				const bad = kinds.find((k) => !isGalleryMark(k));
				if (kinds.length === 0 || bad !== undefined) return { ok: false, error: "bad-value", detail: bad ?? `${m[1]}: ${value}` };
				for (const k of kinds) pushUnique(q.marked, k);
				break;
			}
			case "course":
			case "notebook": {
				const v = listOf(value, "other")[0];
				if (!v) return { ok: false, error: "bad-value", detail: `${m[1]}: ${value}` };
				pushUnique(key === "course" ? q.courses : q.notebooks, v);
				break;
			}
			case "limit": {
				const n = /^\d{1,4}$/.test(value) ? Number(value) : 0;
				if (n < 1) return { ok: false, error: "bad-value", detail: `${m[1]}: ${value}` };
				q.limit = Math.min(n, GALLERY_MAX_LIMIT);
				break;
			}
			case "sort": {
				const v = lower(unquote(value));
				if (v !== "recent" && v !== "title") return { ok: false, error: "bad-value", detail: `${m[1]}: ${value}` };
				q.sort = v;
				break;
			}
		}
	}
	return { ok: true, query: q };
}

/** The block as text (what the builder inserts); lines in a fixed order, defaults left out. */
export function formatGalleryQuery(q: Partial<GalleryQuery>): string {
	const lines: string[] = [];
	if (q.tags?.length) lines.push(`tag: ${q.tags.map((t) => `#${t}`).join(" ")}`);
	for (const c of q.courses ?? []) lines.push(`course: ${c}`);
	for (const n of q.notebooks ?? []) lines.push(`notebook: ${n}`);
	if (q.marked?.length) lines.push(`marked: ${q.marked.join("|")}`);
	if (q.bookmarked) lines.push("bookmarked");
	if (q.limit !== undefined && q.limit !== GALLERY_DEFAULT_LIMIT) lines.push(`limit: ${q.limit}`);
	if (q.sort && q.sort !== "recent") lines.push(`sort: ${q.sort}`);
	return `\`\`\`${GALLERY_LANG}\n${lines.join("\n")}${lines.length ? "\n" : ""}\`\`\``;
}

// ------------------------------------------------------------------------------------------------------------ selecting

/** What the selection needs besides the index. */
export interface GalleryContext {
	/** The timetable courses a notebook belongs to (empty: none). */
	courseOf(path: string): readonly string[];
	/** The global bookmarks that open this notebook (page id and the number the page had). */
	globalBookmarks(path: string): ReadonlyArray<{ pageId: string; num: number }>;
}

/** One page of the gallery. `page` is 0-based; `pageId` is known for pages found by their id. */
export interface GalleryItem {
	path: string;
	name: string;
	page: number;
	pageId?: string;
	modified: number;
}

/** A notebook's pages as marker conditions need them. */
export interface NotebookPages {
	pages: readonly Page[];
	markCtx: MarkContext;
}

/** Does the notebook `entry` pass the `notebook` and `course` conditions? */
export function notebookMatches(entry: Pick<LibraryEntry, "path" | "name">, q: GalleryQuery, ctx: Pick<GalleryContext, "courseOf">): boolean {
	if (q.notebooks.length > 0) {
		const path = lower(entry.path);
		const bare = path.replace(/\.[^./]+$/, "");
		const ok = q.notebooks.some((n) => {
			const w = lower(n.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
			const wBare = w.replace(/\.[^./]+$/, "");
			return path === w || bare === wBare || lower(entry.name) === wBare || path.startsWith(`${w}/`);
		});
		if (!ok) return false;
	}
	if (q.courses.length > 0) {
		const mine = ctx.courseOf(entry.path).map(lower);
		if (!q.courses.some((c) => mine.includes(lower(c)))) return false;
	}
	return true;
}

/** Does the page satisfy `marked`? (Markers of any state; the marked-pages kinds as the navigator counts them.) */
export function pageMatchesMarked(page: Page, wanted: readonly string[], mctx: MarkContext): boolean {
	if (wanted.length === 0) return true;
	const markers = wanted.filter(isMarker);
	if (markers.length > 0 && (page.elements ?? []).some((e) => e.type === "marker" && markers.includes(e.kind))) return true;
	const kinds = wanted.filter(isMarkKind);
	return kinds.length > 0 && pageMarks(page, mctx, kinds).length > 0;
}

/** The mark context of a notebook for `pageMatchesMarked`: its own bookmarks, the global ones, no colour legend. */
export function notebookPagesOf(doc: { pages: readonly Page[]; bookmarks?: readonly string[] }, globalPageIds: readonly string[]): NotebookPages {
	return { pages: doc.pages, markCtx: { bookmarks: new Set(doc.bookmarks ?? []), globalBookmarks: new Set(globalPageIds), legend: [] } };
}

interface Candidate {
	entry: LibraryEntry;
	/** 0-based pages that pass the index conditions (ascending); null: every page. */
	pages: number[] | null;
	ids: Map<number, string>;
}

function inOrder(entries: readonly LibraryEntry[], q: GalleryQuery): LibraryEntry[] {
	const out = [...entries];
	if (q.sort === "title") out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	else out.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	return out;
}

/** The notebooks that pass, in gallery order, each with the pages the library index already narrows down. */
function candidates(entries: readonly LibraryEntry[], q: GalleryQuery, ctx: GalleryContext): Candidate[] {
	const out: Candidate[] = [];
	for (const entry of inOrder(entries, q)) {
		if (!notebookMatches(entry, q, ctx)) continue;
		let pages: Set<number> | null = null;
		const ids = new Map<number, string>();
		if (q.tags.length > 0) {
			const want = q.tags.map(lower);
			pages = new Set((entry.pageTags ?? []).filter((p) => want.every((t) => p.tags.some((x) => lower(x) === t))).map((p) => p.page));
		}
		if (q.bookmarked) {
			const marks = new Set<number>((entry.bookmarks ?? []).map((b) => b.page));
			for (const g of ctx.globalBookmarks(entry.path)) {
				const at = Math.min(Math.max(g.num - 1, 0), Math.max(entry.pages - 1, 0));
				marks.add(at);
				if (!ids.has(at)) ids.set(at, g.pageId);
			}
			pages = pages ? new Set([...pages].filter((p) => marks.has(p))) : marks;
		}
		const list = pages ? [...pages].filter((p) => p >= 0 && p < entry.pages).sort((a, b) => a - b) : null;
		if (list && list.length === 0) continue;
		out.push({ entry, pages: list, ids });
	}
	return out;
}

/**
 * The pages of the gallery, in order, at most `q.limit`. `pagesOf` gives a notebook's pages for the marker conditions (it is only
 * asked for when `marked` is given, notebook by notebook in gallery order, and not more than `GALLERY_MAX_READS` times); null
 * means the notebook could not be read and is skipped.
 */
export async function resolveGallery(
	entries: readonly LibraryEntry[], q: GalleryQuery, ctx: GalleryContext,
	pagesOf: (entry: LibraryEntry) => Promise<NotebookPages | null>,
): Promise<GalleryItem[]> {
	const cands = candidates(entries, q, ctx);
	const items: GalleryItem[] = [];
	const add = (c: Candidate, page: number, pageId?: string) => {
		const id = pageId ?? c.ids.get(page);
		items.push({ path: c.entry.path, name: c.entry.name, page, modified: c.entry.modified, ...(id ? { pageId: id } : {}) });
	};
	if (q.marked.length > 0) {
		let reads = 0;
		for (const c of cands) {
			if (items.length >= q.limit || reads >= GALLERY_MAX_READS) break;
			reads++;
			const np = await pagesOf(c.entry);
			if (!np) continue;
			const wanted = c.pages ?? np.pages.map((_, i) => i);
			for (const i of wanted) {
				const page = np.pages[i];
				if (page && pageMatchesMarked(page, q.marked, np.markCtx)) add(c, i, page.id);
				if (items.length >= q.limit) break;
			}
		}
		return items;
	}
	const pageFilter = q.tags.length > 0 || q.bookmarked;
	// One notebook named and no page condition: its pages, from the first.
	const single = !pageFilter && q.notebooks.length > 0 && cands.length === 1 ? cands[0]! : null;
	if (single) {
		for (let i = 0; i < single.entry.pages && items.length < q.limit; i++) add(single, i);
		return items;
	}
	for (const c of cands) {
		for (const i of c.pages ?? [0]) {
			if (items.length >= q.limit) return items;
			add(c, i);
		}
	}
	return items;
}

/** The query with something to show for it: a short description for the empty state and the card's label. */
export function describeGalleryQuery(q: GalleryQuery): string[] {
	const out: string[] = [];
	for (const t of q.tags) out.push(`#${t}`);
	if (q.bookmarked) out.push("bookmarked");
	for (const c of q.courses) out.push(c);
	for (const n of q.notebooks) out.push(n);
	if (q.marked.length > 0) out.push(q.marked.join("|"));
	return out;
}
