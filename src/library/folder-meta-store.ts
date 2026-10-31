/**
 * The files of the folder metadata (`<notebooks folder>/_meta/folders-<device>.json`, see `folder-meta.ts`) and the small
 * read API the library uses for folder cards. No 'obsidian' import: the vault is reached through an adapter, so this is
 * testable in Node.
 *
 * - Written only by `set` and `rename` (the creation dialog, a folder's edit, the vault's rename event); never by looking.
 * - Only this device's own file is ever written. Each write reads every file again first, applies the changes, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its
 *   content is kept next to it, and (for the device's own file) the write is refused with `FolderMetaBlockedError`. The
 *   other devices' unreadable files are skipped and reported in `blocked`.
 *
 * Read API (for the library and the home screen):
 * - `getFolderMeta(path)`: what the folder's card shows (colour, icon, description, art style), or null; synchronous, from
 *   the last read (call `load()` once at start).
 * - `onFolderMetaChange(fn)`: `fn` runs after the merged state changed (a write here, or another device's file synced in
 *   and `reload()` was called by the vault events in folder-meta-events.ts). Returns the unsubscribe function.
 */
import {
	deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter,
} from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyFolderOps, emptyFolderMeta, FOLDER_META_PREFIX, folderMetaOf, mergeFolderFiles, parseFolderMeta, patchOps, planRename,
	serializeFolderMeta, type FolderField, type FolderMeta, type FolderMetaFile, type FolderMetaMap, type FolderMetaOp,
} from "./folder-meta";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class FolderMetaBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "FolderMetaBlockedError";
	}
}

export class FolderMetaStore {
	private cache: FolderMetaMap = new Map();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
	/** The files were read at least once (the cache is not just the empty start). */
	private loaded = false;
	/** Why some file cannot be used (the files and reasons), or null. */
	blocked: string | null = null;

	constructor(
		private readonly adapter: DeviceFileAdapter,
		private readonly notebooksFolder: () => string,
		readonly device: string,
		private readonly now: () => number = () => Date.now(),
	) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	/** This device's file (the one the writes go to). */
	get ownPath(): string {
		return `${this.folder}/${deviceFileName(FOLDER_META_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the metadata (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${FOLDER_META_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** What the folder's card shows, from the last read; null when nothing was set for it. */
	getFolderMeta(path: string): FolderMeta | null {
		return folderMetaOf(this.cache.get(path));
	}

	/** Runs `fn` after the merged metadata changed. Returns the unsubscribe function. */
	onFolderMetaChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** The merged metadata as last read or written. */
	snapshot(): FolderMetaMap {
		return this.cache;
	}

	/** Reads every device's file and merges them. Nothing is written. */
	load(): Promise<FolderMetaMap> {
		return this.enqueue(async () => (await this.readAll()).merged);
	}

	/** Reads again (another device's file changed) and tells the listeners when the result differs. */
	reload(): Promise<FolderMetaMap> {
		return this.load();
	}

	/** Sets (a string) or clears (null) fields of the folder at `path`; `undefined` fields are left as they are. */
	set(path: string, patch: Partial<Record<FolderField, string | null>>): Promise<FolderMetaMap> {
		return this.write(() => patchOps(path, patch));
	}

	/** 0.13: pins a folder to the sidebar (or unpins it). */
	setPinned(path: string, pinned: boolean): Promise<FolderMetaMap> {
		return this.set(path, { pinned: pinned ? "1" : null });
	}

	/** 0.13: the pinned folders (merged from every device), sorted by path. */
	pinnedFolders(): string[] {
		return [...this.cache].filter(([, f]) => f.pinned === "1").map(([path]) => path).sort();
	}

	/** Follows a folder rename or move: its metadata, and that of the folders inside it, moves to the new paths. */
	rename(from: string, to: string): Promise<FolderMetaMap> {
		// Most renames concern folders without metadata: those read and write nothing (the files are read again otherwise).
		if (this.loaded && planRename(this.cache, from, to).length === 0) return Promise.resolve(this.cache);
		return this.write((merged) => planRename(merged, from, to));
	}

	private write(plan: (merged: FolderMetaMap) => FolderMetaOp[]): Promise<FolderMetaMap> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const ops = plan(merged);
			if (ops.length === 0) return merged;
			const after = applyFolderOps(own.data, merged, ops, this.now());
			const text = serializeFolderMeta(after);
			if (own.exists && text === serializeFolderMeta(own.data)) return merged;
			if (!own.exists && after.items.length === 0) return merged;
			const check = parseFolderMeta(text, this.device);
			if (!check.ok) throw new Error(`folder metadata did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
			this.setCache(mergeFolderFiles([after, ...others]));
			return this.cache;
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private setCache(next: FolderMetaMap): void {
		const before = this.cache;
		this.cache = next;
		if (sameMeta(before, next)) return;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] folder metadata listener failed", e);
			}
		}
	}

	private async readOwn(): Promise<{ data: FolderMetaFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyFolderMeta(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseFolderMeta(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			await keepUnreadableCopy(this.adapter, this.folder, FOLDER_META_PREFIX, text);
			throw new FolderMetaBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: FolderMetaMap; others: FolderMetaFile[] }> {
		const own: FolderMetaFile[] = [];
		const others: FolderMetaFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, FOLDER_META_PREFIX)) {
			try {
				const text = await this.adapter.read(path);
				const parsed = parseFolderMeta(text, device);
				if (!parsed.ok) {
					bad.push(`${path}: ${parsed.message}`);
					// Kept for whoever looks into it; the original is never written by another device.
					if (path === this.ownPath) await keepUnreadableCopy(this.adapter, this.folder, FOLDER_META_PREFIX, text);
				} else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.loaded = true;
		this.setCache(mergeFolderFiles([...own, ...others]));
		return { merged: this.cache, others };
	}
}

function sameMeta(a: FolderMetaMap, b: FolderMetaMap): boolean {
	if (a.size !== b.size) return false;
	for (const [path, x] of a) {
		const y = b.get(path);
		if (!y || x.color !== y.color || x.icon !== y.icon || x.description !== y.description || x.art !== y.art || x.pinned !== y.pinned) return false;
	}
	return true;
}
