/** Library index: a disposable cache of notebook metadata and thumbnails. Pure, no 'obsidian'. */

export const INDEX_VERSION = 1;
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
		(e.thumb === undefined || typeof e.thumb === "string") &&
		(e.thumbMtime === undefined || Number.isFinite(e.thumbMtime))
	);
}

export class LibraryIndex {
	private readonly map = new Map<string, LibraryEntry>();

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
		this.map.set(entry.path, { ...entry, tags: [...entry.tags] });
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

	query(q: LibraryQuery): LibraryEntry[] {
		const { scope } = q;
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
			list = list.filter((e) => e.tags.some((x) => normalizeText(x) === tag));
		}
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

	/** Tags with the number of notebooks using them, most used first (ties alphabetically). Case-insensitive. */
	tags(): Array<{ tag: string; count: number }> {
		const counts = new Map<string, { tag: string; count: number }>();
		for (const e of this.map.values()) {
			const seen = new Set<string>();
			for (const tag of e.tags) {
				const key = normalizeText(tag);
				if (!key || seen.has(key)) continue;
				seen.add(key);
				const c = counts.get(key);
				if (c) c.count++;
				else counts.set(key, { tag, count: 1 });
			}
		}
		return [...counts.values()].sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag));
	}

	toJSON(): { version: number; entries: LibraryEntry[] } {
		return { version: INDEX_VERSION, entries: this.all() };
	}

	/** Reads saved data. Anything unknown, old or malformed gives an empty index (it is rebuilt lazily). */
	static fromJSON(data: unknown): LibraryIndex {
		const index = new LibraryIndex();
		if (typeof data !== "object" || data === null) return index;
		const d = data as { version?: unknown; entries?: unknown };
		if (d.version !== INDEX_VERSION || !Array.isArray(d.entries)) return index;
		for (const e of d.entries) {
			if (isEntry(e)) index.upsert(e);
		}
		return index;
	}
}
