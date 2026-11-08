/**
 * The id → path index both providers keep for the sync root (#126). Drive's changes feed and OneDrive's delta speak in
 * item ids and parent ids, never in paths, and report a renamed folder without its children; the contract wants paths
 * relative to the root. So each provider normalises its items to `TreeItem`s and this module:
 *  - builds the index from a full listing (`buildFull`), and
 *  - applies a delta to it (`applyDelta`): new and changed files become upserts, deleted files and files moved out of the
 *    root become deletions of their old path, a file moved inside the root is both.
 * When the index cannot answer safely it asks for a full listing instead (`needFull`): the first delta after a restart
 * (the index lives in memory only), and any change to a folder already inside the root (rename, move, delete), because its
 * descendants' paths change without being listed. A full listing is always correct; it only costs more requests.
 *
 * Review W22: two files with one path (Google Drive allows it) are all kept in the index and all listed whenever any of them
 * is, so the engine keeps both instead of seeing only the newest (S4); a path still held by another file is never reported
 * deleted. A name the contract cannot carry (a "/" inside a Drive name) is listed with "\" in its place, which the engine
 * skips with a note, instead of being dropped (which read as a deletion, S10).
 * Pure: no `obsidian` import.
 */
import { TransientRemoteError, type RemoteEntry } from "../provider-types";

/** The sync root folder is gone (deleted or trashed on the remote): nothing is listed or deleted until the user acts. */
export class RootMissingError extends TransientRemoteError {
	constructor() {
		super("The sync folder is missing on the remote (deleted or in the trash)");
		this.name = "RootMissingError";
	}
}

/** One item of a listing or of a delta, provider-neutral. */
export interface TreeItem {
	id: string;
	folder: boolean;
	/** Deleted, trashed, or no longer visible. */
	removed: boolean;
	name?: string;
	/** Parent id (the first parent on Drive). */
	parent?: string;
	/** For a file that is not removed: everything but the path. */
	entry?: Omit<RemoteEntry, "path">;
}

/** The current location of a folder the index does not know, fetched from the remote; null when it is gone. */
export type FolderLookup = (id: string) => Promise<{ name: string; parent?: string } | null>;

export interface DeltaResult {
	upserts: RemoteEntry[];
	deletions: string[];
	needFull: boolean;
}

/** A path segment the connector can store: not empty, no "/", not "." or "..". */
export function validName(name: string | undefined): name is string {
	return !!name && !name.includes("/") && name !== "." && name !== "..";
}

/**
 * The path segment of a listed name: undefined only when there is none. A "/" inside the name (allowed on Drive) becomes "\",
 * which no contract path may contain: the engine then skips that file with a note (never a deletion of its old path).
 */
export function segmentOf(name: string | undefined): string | undefined {
	return name ? name.replace(/\//g, "\\") : undefined;
}

/** Splits a contract path ("a/b/c.notebook") into segments; throws for a path the contract does not allow. */
export function splitPath(path: string): string[] {
	const parts = path.split("/");
	if (!path || path.startsWith("/") || parts.some((p) => !validName(p))) throw new Error(`Invalid sync path: ${JSON.stringify(path)}`);
	return parts;
}

export function joinPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

export class TreeIndex {
	/** Folders strictly inside the root: id → name and parent id. */
	readonly folders = new Map<string, { name: string; parent: string | undefined }>();
	/** Files under the root: id → path. */
	readonly files = new Map<string, string>();
	/** What the last listing said about each file (to list every file that shares a path, review W22 S4). */
	private readonly entries = new Map<string, Omit<RemoteEntry, "path">>();
	/** True once a full listing filled the index in this session. */
	complete = false;

	constructor(readonly rootId: string) {}

	/** Path of a known folder ("" for the root), undefined when its chain does not reach the root. */
	folderPath(id: string | undefined): string | undefined {
		const parts: string[] = [];
		const seen = new Set<string>();
		let cur = id;
		while (cur !== undefined && cur !== this.rootId) {
			if (seen.has(cur)) return undefined;
			seen.add(cur);
			const f = this.folders.get(cur);
			if (!f) return undefined;
			parts.unshift(f.name);
			cur = f.parent;
		}
		return cur === this.rootId ? parts.join("/") : undefined;
	}

	/** The id of a known file at `path`, if any. */
	fileAt(path: string): string | undefined {
		for (const [id, p] of this.files) if (p === path) return id;
		return undefined;
	}

	/** The id of a known folder at `path` ("" is the root), if any. */
	folderAt(path: string): string | undefined {
		if (path === "") return this.rootId;
		for (const id of this.folders.keys()) if (this.folderPath(id) === path) return id;
		return undefined;
	}

	/** Records an item the provider just wrote (upload, folder create, remove). */
	noteFile(id: string, path: string | undefined, entry?: Omit<RemoteEntry, "path">): void {
		if (path === undefined) {
			this.files.delete(id);
			this.entries.delete(id);
			return;
		}
		this.files.set(id, path);
		if (entry) this.entries.set(id, { ...entry });
	}

	noteFolder(id: string, name: string, parent: string): void {
		this.folders.set(id, { name, parent });
	}

	/**
	 * Rebuilds the index from a full listing (every folder and file reachable under the root) and returns the files.
	 * Two files at the same path (Drive allows it) are both returned (review W22 S4).
	 */
	buildFull(items: TreeItem[]): RemoteEntry[] {
		this.folders.clear();
		this.files.clear();
		this.entries.clear();
		for (const it of items) {
			const seg = segmentOf(it.name);
			if (it.folder && !it.removed && it.id !== this.rootId && seg !== undefined) this.folders.set(it.id, { name: seg, parent: it.parent });
		}
		// A listing of more than the root also has folders outside it: keep only the root's.
		for (const id of [...this.folders.keys()]) if (this.folderPath(id) === undefined) this.folders.delete(id);
		const out = new Map<string, RemoteEntry>();
		for (const it of items) {
			const seg = segmentOf(it.name);
			if (it.folder || it.removed || !it.entry || seg === undefined) continue;
			const dir = this.folderPath(it.parent);
			if (dir === undefined) continue;
			const path = joinPath(dir, seg);
			out.set(it.id, { ...it.entry, path });
			this.files.set(it.id, path);
			this.entries.set(it.id, it.entry);
		}
		this.complete = true;
		return [...out.values()];
	}

	/** File ids by path (the reverse of `files`). */
	private idsByPath(): Map<string, string[]> {
		const out = new Map<string, string[]>();
		for (const [id, p] of this.files) {
			const list = out.get(p);
			if (list) list.push(id);
			else out.set(p, [id]);
		}
		return out;
	}

	/** Applies a delta (see the module comment). `lookup` fetches a parent folder the index does not know. */
	async applyDelta(items: TreeItem[], lookup: FolderLookup): Promise<DeltaResult> {
		const none: DeltaResult = { upserts: [], deletions: [], needFull: false };
		if (items.length === 0) return none;
		if (!this.complete) return { ...none, needFull: true };
		// The same item may appear more than once: the last occurrence is its current state.
		const latest = new Map<string, TreeItem>();
		for (const it of items) {
			latest.delete(it.id);
			latest.set(it.id, it);
		}
		const outside = new Set<string>();
		const resolve = async (id: string | undefined, depth = 0): Promise<string | undefined> => {
			if (id === undefined || depth > 64) return undefined;
			const known = this.folderPath(id);
			if (known !== undefined) return known;
			if (outside.has(id) || this.folders.has(id)) return undefined;
			const f = await lookup(id);
			const seg = segmentOf(f?.name);
			if (!f || seg === undefined) {
				outside.add(id);
				return undefined;
			}
			const dir = await resolve(f.parent, depth + 1);
			if (dir === undefined) {
				outside.add(id);
				return undefined;
			}
			this.folders.set(id, { name: seg, parent: f.parent });
			return joinPath(dir, seg);
		};

		for (const it of latest.values()) {
			if (!it.folder) continue;
			if (it.id === this.rootId) {
				if (it.removed) throw new RootMissingError();
				continue;
			}
			const known = this.folders.get(it.id);
			const seg = segmentOf(it.name);
			if (known) {
				if (it.removed || known.name !== seg || known.parent !== it.parent) return { ...none, needFull: true };
				continue;
			}
			if (it.removed || seg === undefined) continue;
			const dir = await resolve(it.parent);
			if (dir !== undefined) this.folders.set(it.id, { name: seg, parent: it.parent });
		}

		const upserts = new Map<string, RemoteEntry>();
		const deletions = new Set<string>();
		const touched = new Set<string>();
		for (const it of latest.values()) {
			if (it.folder) continue;
			const old = this.files.get(it.id);
			const seg = it.removed || !it.entry ? undefined : segmentOf(it.name);
			const dir = seg === undefined ? undefined : await resolve(it.parent);
			if (dir === undefined || seg === undefined || !it.entry) {
				if (old !== undefined) {
					deletions.add(old);
					this.files.delete(it.id);
					this.entries.delete(it.id);
				}
				continue;
			}
			const path = joinPath(dir, seg);
			if (old !== undefined && old !== path) deletions.add(old);
			this.files.set(it.id, path);
			this.entries.set(it.id, it.entry);
			upserts.set(it.id, { ...it.entry, path });
			touched.add(path);
		}
		// Review W22 S4: a path another file still holds is not deleted (that file is listed instead), and every file that shares a
		// listed path is listed with it, so the engine sees them all.
		const byPath = this.idsByPath();
		for (const p of deletions) {
			if (!byPath.has(p)) continue;
			deletions.delete(p);
			touched.add(p);
		}
		for (const p of touched) {
			for (const id of byPath.get(p) ?? []) {
				const e = this.entries.get(id);
				if (e && !upserts.has(id)) upserts.set(id, { ...e, path: p });
			}
		}
		return { upserts: [...upserts.values()], deletions: [...deletions], needFull: false };
	}
}
