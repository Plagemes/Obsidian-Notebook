/** Library index: a disposable cache of notebook metadata and thumbnails. Pure, no 'obsidian'. */

import { tagAncestors, tagIsWithin } from "../model/tags";

/** v4: entries also carry the titled bookmarks (quick switcher); v3 added the page tags. Older indexes are rebuilt. */
export const INDEX_VERSION = 4;
/** "Recent" shows this many notebooks. */
export const RECENT_LIMIT = 20;

export interface LibraryEntry {
	/** Vault path of the notebook file. */
	path: string;
	/** Parent folder path ("" for the vault root). */
	folder: string;
	/** File name without extension. */
	name: string;
	/** File mtime (ms) and size (bytes) the entry was read at; used for staleness. */
	mtime: number;
	size: number;
	/** Document creation / modification time (ms since epoch). */
	created: number;
	modified: number;
	pages: number;
	/** Text of the text boxes of all pages (whitespace collapsed, capped), for search. Absent when there is none. */
	text?: string;
	/** Flat pairs `[pageIndex, start, ...]`: the offset in `text` where each page with text begins (0-based pages). */
	textPages?: number[];
	/** v7 page tags: the 0-based pages that have tags, with their tags. Absent when no page has any. */
	pageTags?: Array<{ page: number; tags: string[] }>;
	/** Titled bookmarks: 0-based page and title. Absent when there is none. */
	bookmarks?: Array<{ page: number; title: string }>;
	tags: string[];
	favorite: boolean;
	/** Cover colour #rrggbb. */
	cover: string;
	/** First-page thumbnail as a data URL. */
	thumb?: string;
	/** File mtime the thumbnail was rendered from; the thumbnail is stale when it differs from `mtime`. */
	thumbMtime?: number;
}

export type LibrarySort = "modified" | "name" | "created";
export type LibraryScope = "all" | "favorites" | "recent" | { folder: string; recursive?: boolean } | { tag: string };

export interface LibraryQuery {
	scope: LibraryScope;
	search?: string;
	sort: LibrarySort;
}

export const SORTS: readonly LibrarySort[] = ["modified", "name", "created"];

/** Lower-case, accent-free form used for searching and comparing. */
export function normalizeText(text: string): string {
	return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/**
 * Like `normalizeText`, but every code point maps to one of the same length, so offsets in the result
 * are valid offsets in the original string (used to find and highlight matches).
 */
export function foldText(text: string): string {
	let out = "";
	for (const ch of text) {
		const f = ch.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
		if (f.length === ch.length) out += f;
		else {
			const l = ch.toLowerCase();
			out += l.length === ch.length ? l : ch;
		}
	}
	return out;
}

export type SearchField = "title" | "tag" | "pageTag" | "text";

/** A string with the `[start, end)` ranges to highlight (sorted, non-overlapping). */
export interface Highlight {
	text: string;
	ranges: Array<[number, number]>;
}

export interface SearchHit {
	entry: LibraryEntry;
	/** Fields that matched, best first: title, tag, text. */
	fields: SearchField[];
	title?: Highlight;
	tag?: Highlight;
	/** v7: a page tag that matched, on the 0-based page `page` (the first page with a matching tag). */
	pageTag?: { tag: Highlight; page: number };
	/** `page` is the 0-based page of the first match. */
	text?: { snippet: Highlight; page: number };
}

export interface SearchQuery {
	search: string;
	/** Where to look; default: every notebook. */
	scope?: LibraryScope;
	sort: LibrarySort;
}

/** Characters of context kept on each side of a text match. */
export const SNIPPET_RADIUS = 40;

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const sorted = ranges.filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

function rangesOf(folded: string, terms: readonly string[], from = 0, to = folded.length): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const term of terms) {
		let i = folded.indexOf(term, from);
		while (i >= 0 && i + term.length <= to) {
			out.push([i, i + term.length]);
			i = folded.indexOf(term, i + term.length);
		}
	}
	return mergeRanges(out);
}

/** A window of `text` around `[start, end)` (at most 2 * SNIPPET_RADIUS plus the match, plus ellipses), with highlights. */
function snippetAround(text: string, folded: string, terms: readonly string[], start: number, end: number): Highlight {
	let from = Math.max(0, start - SNIPPET_RADIUS);
	let to = Math.min(text.length, Math.max(end, start) + SNIPPET_RADIUS);
	const isLow = (i: number) => { const c = text.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
	if (from > 0 && isLow(from)) from++;
	if (to < text.length && isLow(to)) to--;
	const prefix = from > 0 ? "…" : "";
	const suffix = to < text.length ? "…" : "";
	const shift = prefix.length - from;
	const ranges = rangesOf(folded, terms, from, to).map((r): [number, number] => [r[0] + shift, r[1] + shift]);
	return { text: prefix + text.slice(from, to) + suffix, ranges };
}

export function folderOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** File name without the last extension. */
export function nameOf(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(0, dot) : file;
}

/** True if `path` is `folder` or lies inside it. "" is the vault root and contains everything. */
export function isInside(path: string, folder: string): boolean {
	return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(sort: LibrarySort): (a: LibraryEntry, b: LibraryEntry) => number {
	const byName = (a: LibraryEntry, b: LibraryEntry) => collator.compare(a.name, b.name) || a.path.localeCompare(b.path);
	switch (sort) {
		case "name":
			return byName;
		case "created":
			return (a, b) => b.created - a.created || byName(a, b);
		default:
			return (a, b) => b.modified - a.modified || byName(a, b);
	}
}

function isEntry(v: unknown): v is LibraryEntry {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	return (
		typeof e.path === "string" && typeof e.folder === "string" && typeof e.name === "string" &&
		Number.isFinite(e.mtime) && Number.isFinite(e.size) && Number.isFinite(e.created) && Number.isFinite(e.modified) &&
		Number.isFinite(e.pages) && Array.isArray(e.tags) && e.tags.every((x) => typeof x === "string") &&
		typeof e.favorite === "boolean" && typeof e.cover === "string" &&
		(e.text === undefined || typeof e.text === "string") &&
		(e.textPages === undefined || (Array.isArray(e.textPages) && e.textPages.length % 2 === 0 && e.textPages.every((n) => Number.isFinite(n)))) &&
		(e.pageTags === undefined || (Array.isArray(e.pageTags) && e.pageTags.every((p: unknown) => {
			const o = p as { page?: unknown; tags?: unknown } | null;
			return typeof o === "object" && o !== null && Number.isInteger(o.page) && Array.isArray(o.tags) && o.tags.every((x) => typeof x === "string");
		}))) &&
		(e.bookmarks === undefined || (Array.isArray(e.bookmarks) && e.bookmarks.every((b: unknown) => {
			const o = b as { page?: unknown; title?: unknown } | null;
			return typeof o === "object" && o !== null && Number.isInteger(o.page) && typeof o.title === "string";
		}))) &&
		(e.thumb === undefined || typeof e.thumb === "string") &&
		(e.thumbMtime === undefined || Number.isFinite(e.thumbMtime))
	);
}

export class LibraryIndex {
	private readonly map = new Map<string, LibraryEntry>();
	/**
	 * Saved data of a newer index version (a newer plugin version on another device syncs the same plugin
	 * folder). Kept as read and returned by `toJSON`, so saving does not overwrite that device's index; this
	 * device works from an index rebuilt in memory.
	 */
	private newer: { version: number; entries: LibraryEntry[] } | null = null;

	/** True when the saved data was a newer index version, which `toJSON` hands back unchanged. */
	get keepsNewerVersion(): boolean {
		return this.newer !== null;
	}

	get size(): number {
		return this.map.size;
	}

	get(path: string): LibraryEntry | undefined {
		return this.map.get(path);
	}

	has(path: string): boolean {
		return this.map.has(path);
	}

	all(): LibraryEntry[] {
		return [...this.map.values()];
	}

	/** Inserts or replaces the entry stored under `entry.path`. */
	upsert(entry: LibraryEntry): void {
		const copy: LibraryEntry = { ...entry, tags: [...entry.tags] };
		if (entry.bookmarks) copy.bookmarks = entry.bookmarks.map((b) => ({ ...b }));
		if (entry.pageTags) copy.pageTags = entry.pageTags.map((p) => ({ page: p.page, tags: [...p.tags] }));
		this.map.set(entry.path, copy);
	}

	/** Merges fields into an existing entry; returns false if the path is unknown. */
	patch(path: string, patch: Partial<Omit<LibraryEntry, "path">>): boolean {
		const e = this.map.get(path);
		if (!e) return false;
		this.map.set(path, { ...e, ...patch });
		return true;
	}

	remove(path: string): boolean {
		return this.map.delete(path);
	}

	/** Moves an entry to a new path (folder and name follow), keeping mtime and the thumbnail. */
	rename(oldPath: string, newPath: string): boolean {
		const e = this.map.get(oldPath);
		if (!e || oldPath === newPath) return false;
		this.map.delete(oldPath);
		this.map.set(newPath, { ...e, path: newPath, folder: folderOf(newPath), name: nameOf(newPath) });
		return true;
	}

	/** Renames every entry inside a folder that was renamed or moved. Returns how many entries moved. */
	renameFolder(oldFolder: string, newFolder: string): number {
		if (oldFolder === newFolder || oldFolder === "") return 0;
		let moved = 0;
		for (const e of this.all()) {
			if (e.path.startsWith(`${oldFolder}/`)) {
				if (this.rename(e.path, `${newFolder}/${e.path.slice(oldFolder.length + 1)}`)) moved++;
			}
		}
		return moved;
	}

	/** True when the file must be read again: unknown, or its mtime or size changed. */
	isStale(path: string, mtime: number, size: number): boolean {
		const e = this.map.get(path);
		return !e || e.mtime !== mtime || e.size !== size;
	}

	/** True when the thumbnail is missing or was rendered from an older version of the file. */
	needsThumb(path: string): boolean {
		const e = this.map.get(path);
		return !!e && e.pages > 0 && (!e.thumb || e.thumbMtime !== e.mtime);
	}

	/** Drops entries whose file no longer exists. Returns the removed paths. */
	prune(existingPaths: Iterable<string>): string[] {
		const keep = new Set(existingPaths);
		const removed: string[] = [];
		for (const path of this.map.keys()) {
			if (!keep.has(path)) removed.push(path);
		}
		for (const path of removed) this.map.delete(path);
		return removed;
	}

	private inScope(scope: LibraryScope): LibraryEntry[] {
		let list = this.all();
		if (scope === "favorites") {
			list = list.filter((e) => e.favorite);
		} else if (scope === "recent") {
			list = list.sort(compare("modified")).slice(0, RECENT_LIMIT);
		} else if (typeof scope === "object" && "folder" in scope) {
			const { folder, recursive } = scope;
			list = list.filter((e) => (recursive ? isInside(e.path, folder) && e.path !== folder : e.folder === folder));
		} else if (typeof scope === "object" && "tag" in scope) {
			const tag = normalizeText(scope.tag);
			// Like Obsidian's tag search: `a` also finds the notebooks tagged `a/b`.
			list = list.filter((e) => e.tags.some((x) => tagIsWithin(normalizeText(x), tag)));
		}
		return list;
	}

	query(q: LibraryQuery): LibraryEntry[] {
		let list = this.inScope(q.scope);
		const terms = normalizeText(q.search ?? "").split(/\s+/).filter(Boolean);
		if (terms.length > 0) {
			list = list.filter((e) => {
				const name = normalizeText(e.name);
				const tags = e.tags.map(normalizeText);
				return terms.every((term) => name.includes(term) || tags.some((tag) => tag.includes(term)));
			});
		}
		return list.sort(compare(q.sort));
	}

	private readonly foldCache = new Map<string, { text: string; folded: string }>();

	private foldedText(e: LibraryEntry): string {
		if (!e.text) return "";
		const c = this.foldCache.get(e.path);
		if (c && c.text === e.text) return c.folded;
		const folded = foldText(e.text);
		this.foldCache.set(e.path, { text: e.text, folded });
		return folded;
	}

	/**
	 * Global search over title, tags, page tags (v7) and text boxes, on the in-memory index only. Accent and case
	 * insensitive; several words must all match (each in any field). Title hits come first, then tag
	 * hits, then page-tag hits, then text hits; ties follow `sort`.
	 */
	search(q: SearchQuery): SearchHit[] {
		const terms = [...new Set(normalizeText(q.search).split(/\s+/).filter(Boolean))];
		if (terms.length === 0) return [];
		const ranked: Array<{ hit: SearchHit; rank: number }> = [];
		for (const e of this.inScope(q.scope ?? "all")) {
			const name = normalizeText(e.name);
			const tags = e.tags.map(normalizeText);
			const folded = this.foldedText(e);
			const inTitle = terms.filter((t) => name.includes(t));
			const inTags = terms.filter((t) => tags.some((tag) => tag.includes(t)));
			const pageTags = (e.pageTags ?? []).flatMap((p) => p.tags.map((tag) => ({ page: p.page, tag, norm: normalizeText(tag) })));
			const inPageTags = terms.filter((t) => pageTags.some((p) => p.norm.includes(t)));
			const textPos = terms.map((t) => folded.indexOf(t));
			if (!terms.every((t, i) => name.includes(t) || tags.some((tag) => tag.includes(t)) || inPageTags.includes(t) || textPos[i]! >= 0)) continue;

			const fields: SearchField[] = [];
			const hit: SearchHit = { entry: e, fields };
			if (inTitle.length > 0) {
				fields.push("title");
				hit.title = { text: e.name, ranges: rangesOf(foldText(e.name), terms) };
			}
			if (inTags.length > 0) {
				fields.push("tag");
				const i = tags.findIndex((tag) => inTags.some((t) => tag.includes(t)));
				const tagText = e.tags[i]!;
				hit.tag = { text: tagText, ranges: rangesOf(foldText(tagText), terms) };
			}
			if (inPageTags.length > 0) {
				fields.push("pageTag");
				const first = pageTags.find((p) => inPageTags.some((t) => p.norm.includes(t)))!;
				hit.pageTag = { tag: { text: first.tag, ranges: rangesOf(foldText(first.tag), terms) }, page: first.page };
			}
			let first = -1;
			let firstTerm = "";
			textPos.forEach((pos, i) => {
				if (pos >= 0 && (first < 0 || pos < first)) {
					first = pos;
					firstTerm = terms[i]!;
				}
			});
			if (first >= 0 && e.text) {
				fields.push("text");
				let page = 0;
				const tp = e.textPages ?? [];
				for (let k = 0; k + 1 < tp.length; k += 2) {
					if (tp[k + 1]! <= first) page = tp[k]!;
					else break;
				}
				hit.text = { snippet: snippetAround(e.text, folded, terms, first, first + firstTerm.length), page };
			}
			ranked.push({ hit, rank: fields[0] === "title" ? 0 : fields[0] === "tag" ? 1 : fields[0] === "pageTag" ? 2 : 3 });
		}
		const cmp = compare(q.sort);
		return ranked.sort((a, b) => a.rank - b.rank || cmp(a.hit.entry, b.hit.entry)).map((r) => r.hit);
	}

	/**
	 * Tags with the number of notebooks using them, most used first (ties alphabetically). Case-insensitive. A nested tag
	 * `a/b` also counts for its parent `a` (as in Obsidian's Tags pane), so the parent can be chosen as a filter.
	 */
	tags(): Array<{ tag: string; count: number }> {
		const counts = new Map<string, { tag: string; count: number }>();
		for (const e of this.map.values()) {
			const seen = new Set<string>();
			for (const full of e.tags) {
				for (const tag of [...tagAncestors(full), full]) {
					const key = normalizeText(tag);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					const c = counts.get(key);
					if (c) c.count++;
					else counts.set(key, { tag, count: 1 });
				}
			}
		}
		return [...counts.values()].sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag));
	}

	toJSON(): { version: number; entries: LibraryEntry[] } {
		if (this.newer) return this.newer;
		return { version: INDEX_VERSION, entries: this.all() };
	}

	/**
	 * Reads saved data. Anything unknown, old or malformed gives an empty index (it is rebuilt lazily). A newer
	 * index version also gives an empty index, but is not overwritten: `toJSON` returns it as it was read.
	 */
	static fromJSON(data: unknown): LibraryIndex {
		const index = new LibraryIndex();
		if (typeof data !== "object" || data === null) return index;
		const d = data as { version?: unknown; entries?: unknown };
		if (typeof d.version === "number" && Number.isInteger(d.version) && d.version > INDEX_VERSION) {
			// Only handed back to be saved again: never read by this version.
			index.newer = data as { version: number; entries: LibraryEntry[] };
			return index;
		}
		if (d.version !== INDEX_VERSION || !Array.isArray(d.entries)) return index;
		for (const e of d.entries) {
			if (isEntry(e)) index.upsert(e);
		}
		return index;
	}
}

