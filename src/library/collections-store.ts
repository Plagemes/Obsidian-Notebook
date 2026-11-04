/**
 * The files of the saved collections (`<notebooks folder>/_meta/collections-<device>.json`, see `collections.ts`). No
 * 'obsidian' import: the vault is reached through an adapter, so this is testable in Node.
 *
 * - Written only by `save` and `remove` (the collection editor); never by looking at the library.
 * - Only this device's own file is ever written. Each write reads every file again first, applies the change, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its
 *   content is kept next to it (only when it is damaged: an empty or newer file is left as it is, no copy), and (for the
 *   device's own file) the write is refused with `CollectionsBlockedError`. The other devices' unreadable files are skipped
 *   and reported in `blocked`.
 * - When the own file is rewritten, deletions (tombstones) older than 90 days are dropped from it.
 */
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyCollectionOps, COLLECTIONS_MAX, COLLECTIONS_PREFIX, emptyCollections, liveCollections, mergeCollectionFiles, newCollectionId,
	parseCollections, pruneTombstones, serializeCollections, type CollectionOp, type CollectionRules, type CollectionsFile, type CollectionsMap, type SavedCollection,
} from "./collections";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class CollectionsBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty" | "limit") {
		super(message);
		this.name = "CollectionsBlockedError";
	}
}

export class CollectionsStore {
	private cache: CollectionsMap = new Map();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
	/** The files were read at least once (before that the list is just the empty start). */
	loaded = false;
	/** Why some file cannot be used (the files and reasons), or null. */
	blocked: string | null = null;

	constructor(
		private readonly adapter: DeviceFileAdapter,
		private readonly notebooksFolder: () => string,
		readonly device: string,
		private readonly now: () => number = () => Date.now(),
		private readonly random: () => number = Math.random,
	) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	/** This device's file (the one the writes go to). */
	get ownPath(): string {
		return `${this.folder}/${deviceFileName(COLLECTIONS_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the collections (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${COLLECTIONS_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The saved collections from the last read, by name. */
	list(): SavedCollection[] {
		return liveCollections(this.cache);
	}

	get(id: string): SavedCollection | null {
		return this.list().find((c) => c.id === id) ?? null;
	}

	/** Runs `fn` after the collections changed. Returns the unsubscribe function. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** Reads every device's file and merges them. Nothing is written. */
	load(): Promise<SavedCollection[]> {
		return this.enqueue(async () => {
			await this.readAll();
			return this.list();
		});
	}

	/** Creates (no `id`) or changes a collection; returns its id. */
	save(c: { id?: string; name: string; rules: CollectionRules; color?: string | null }): Promise<string> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const id = c.id ?? newCollectionId(new Set(merged.keys()), this.random);
			if (c.id === undefined && liveCollections(merged).length >= COLLECTIONS_MAX) throw new CollectionsBlockedError("too many collections", "limit");
			await this.writeOps(own, merged, others, [{ kind: "upsert", id, name: c.name, rules: c.rules, color: c.color }]);
			return id;
		});
	}

	/** Deletes a collection (a notebook is never touched: a collection is only a saved filter). */
	remove(id: string): Promise<void> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			await this.writeOps(own, merged, others, [{ kind: "delete", id }]);
		});
	}

	private async writeOps(own: { data: CollectionsFile; exists: boolean }, merged: CollectionsMap, others: CollectionsFile[], ops: CollectionOp[]): Promise<void> {
		const after = applyCollectionOps(own.data, merged, ops, this.now());
		const text = serializeCollections(after);
		if (own.exists && text === serializeCollections(own.data)) return;
		if (!own.exists && after.items.length === 0) return;
		// The file is being rewritten anyway: deletions older than 90 days are dropped from it now.
		const pruned = pruneTombstones(after, this.now());
		const prunedText = pruned === after ? text : serializeCollections(pruned);
		const check = parseCollections(prunedText, this.device);
		if (!check.ok) throw new Error(`collections did not validate: ${check.message}`);
		await ensureFolderPath(this.adapter, this.folder);
		await this.adapter.write(this.ownPath, prunedText);
		this.setCache(mergeCollectionFiles([pruned, ...others]));
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private setCache(next: CollectionsMap): void {
		const before = JSON.stringify(liveCollections(this.cache));
		this.cache = next;
		if (before === JSON.stringify(liveCollections(next))) return;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] collections listener failed", e);
			}
		}
	}

	private async readOwn(): Promise<{ data: CollectionsFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyCollections(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseCollections(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			// A copy only of a file that is damaged (not JSON, or not a collections file). An empty file (it may not have synced
			// yet) and a newer one are fine as they are: copying them would only pile up files.
			if (parsed.reason === "json" || parsed.reason === "format") await keepUnreadableCopy(this.adapter, this.folder, COLLECTIONS_PREFIX, text);
			throw new CollectionsBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: CollectionsMap; others: CollectionsFile[] }> {
		const own: CollectionsFile[] = [];
		const others: CollectionsFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, COLLECTIONS_PREFIX)) {
			try {
				const parsed = parseCollections(await this.adapter.read(path), device);
				if (!parsed.ok) bad.push(`${path}: ${parsed.message}`);
				else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.loaded = true;
		this.setCache(mergeCollectionFiles([...own, ...others]));
		return { merged: this.cache, others };
	}
}
