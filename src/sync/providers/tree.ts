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
	noteFile(id: string, path: string | undefined): void {
		if (path === undefined) this.files.delete(id);
		else this.files.set(id, path);
	}

	noteFolder(id: string, name: string, parent: string): void {
		this.folders.set(id, { name, parent });
	}

	/**
	 * Rebuilds the index from a full listing (every folder and file reachable under the root) and returns the files.
	 * Two files at the same path (Drive allows it) keep only the newest.
	 */
	buildFull(items: TreeItem[]): RemoteEntry[] {
		this.folders.clear();
		this.files.clear();
		for (const it of items) if (it.folder && !it.removed && it.id !== this.rootId && validName(it.name)) this.folders.set(it.id, { name: it.name, parent: it.parent });
		// A listing of the whole drive (OneDrive's fallback) also has folders outside the root: keep only the root's.
		for (const id of [...this.folders.keys()]) if (this.folderPath(id) === undefined) this.folders.delete(id);
		const byPath = new Map<string, RemoteEntry & { id: string }>();
		for (const it of items) {
			if (it.folder || it.removed || !it.entry || !validName(it.name)) continue;
			const dir = this.folderPath(it.parent);
			if (dir === undefined) continue;
			const path = joinPath(dir, it.name);
			const prev = byPath.get(path);
			if (prev && prev.mtime >= it.entry.mtime) continue;
			byPath.set(path, { ...it.entry, path });
		}
		for (const e of byPath.values()) this.files.set(e.id, e.path);
		this.complete = true;
		return [...byPath.values()];
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
			if (!f || !validName(f.name)) {
				outside.add(id);
				return undefined;
			}
			const dir = await resolve(f.parent, depth + 1);
			if (dir === undefined) {
				outside.add(id);
				return undefined;
			}
			this.folders.set(id, { name: f.name, parent: f.parent });
			return joinPath(dir, f.name);
		};

		for (const it of latest.values()) {
			if (!it.folder) continue;
			if (it.id === this.rootId) {
				if (it.removed) throw new RootMissingError();
				continue;
			}
			const known = this.folders.get(it.id);
			if (known) {
				if (it.removed || known.name !== it.name || known.parent !== it.parent) return { ...none, needFull: true };
				continue;
			}
			if (it.removed || !validName(it.name)) continue;
			const dir = await resolve(it.parent);
			if (dir !== undefined) this.folders.set(it.id, { name: it.name, parent: it.parent });
		}

		const upserts = new Map<string, RemoteEntry>();
		const deletions = new Set<string>();
		for (const it of latest.values()) {
			if (it.folder) continue;
			const old = this.files.get(it.id);
			const dir = it.removed || !it.entry || !validName(it.name) ? undefined : await resolve(it.parent);
			if (dir === undefined || !it.entry || !it.name) {
				if (old !== undefined) {
					deletions.add(old);
					this.files.delete(it.id);
				}
				continue;
			}
			const path = joinPath(dir, it.name);
			if (old !== undefined && old !== path) deletions.add(old);
			this.files.set(it.id, path);
			const prev = upserts.get(path);
			if (!prev || prev.mtime <= it.entry.mtime) upserts.set(path, { ...it.entry, path });
		}
		for (const p of upserts.keys()) deletions.delete(p);
		return { upserts: [...upserts.values()], deletions: [...deletions], needFull: false };
	}
}
