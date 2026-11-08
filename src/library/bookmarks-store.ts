/**
 * The files of the global bookmarks (`<notebooks folder>/_meta/bookmarks-<device>.json`, see `bookmarks.ts`). No 'obsidian'
 * import: the vault is reached through an adapter, so this is testable in Node. The same rules as the quick tabs
 * (quicktabs-store.ts):
 *
 * - Written only by `add`, `remove`, `move`, `rename` and `retarget` (never by looking at a notebook).
 * - Only this device's own file is ever written. Each write reads every file again first, applies the change, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its
 *   content is kept next to it (only when it is damaged), and (for the device's own file) the write is refused with
 *   `BookmarksBlockedError`. The other devices' unreadable files are skipped and reported in `blocked`.
 * - When the own file is rewritten it adopts the winning state of the ids it holds, and removals older than 90 days are
 *   dropped from it unless another device's file still holds that bookmark live.
 */
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyBookmarkOps, bookmarkOrderAtEnd, bookmarkTwins, BOOKMARKS_PREFIX, emptyBookmarks, findBookmark, liveBookmarks, mergeBookmarkFiles, newBookmarkId, parseBookmarks,
	planBookmarkMove, pruneBookmarkTombstones, serializeBookmarks, type BookmarkOp, type BookmarksFile, type BookmarksMap, type GlobalBookmark,
} from "./bookmarks";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written. */
export class BookmarksBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "BookmarksBlockedError";
	}
}

export interface AddBookmarkRequest {
	docId: string;
	path: string;
	pageId: string;
	num: number;
	label?: string;
}

export class BookmarksStore {
	private cache: BookmarksMap = new Map();
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
		return `${this.folder}/${deviceFileName(BOOKMARKS_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the bookmarks (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${BOOKMARKS_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The bookmarks from the last read, in list order. */
	list(): GlobalBookmark[] {
		return liveBookmarks(this.cache);
	}

	/** The bookmark of this page, if any. */
	find(ref: { docId: string; path: string; pageId: string }, pathHolds?: (path: string, docId: string) => boolean): GlobalBookmark | null {
		return findBookmark(this.cache, ref, pathHolds);
	}

	/** Runs `fn` after the bookmarks changed. Returns the unsubscribe function. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** Reads every device's file and merges them. Nothing is written. */
	load(): Promise<void> {
		return this.enqueue(async () => {
			await this.readAll();
		});
	}

	/** Adds a page at the end of the list; returns the id (of the existing bookmark when the page is bookmarked already). */
	add(r: AddBookmarkRequest, pathHolds?: (path: string, docId: string) => boolean): Promise<string> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const there = findBookmark(merged, r, pathHolds);
			if (there) return there.id;
			const id = newBookmarkId(new Set(merged.keys()), this.random);
			await this.writeOps(own, merged, others, [{ kind: "add", id, ...r, order: bookmarkOrderAtEnd(liveBookmarks(merged)) }]);
			return id;
		});
	}

	/** Removes a bookmark (the page it points at is never touched). */
	remove(id: string): Promise<void> {
		// The same page bookmarked on two devices before they synced is one row with two ids: both go.
		return this.change((merged) => bookmarkTwins(merged, id).map((twin) => ({ kind: "remove" as const, id: twin })));
	}

	/** Gives the bookmark a name (empty: back to the default "<notebook> p. N"). */
	rename(id: string, label: string): Promise<void> {
		// Twins (the same page bookmarked on two devices before they synced) are one row: every id gets the name, so the row never shows another one.
		return this.change((merged) => bookmarkTwins(merged, id).map((twin) => ({ kind: "label" as const, id: twin, label })));
	}

	/** Moves the bookmark `id` so that it is at index `to` of the list. */
	move(id: string, to: number): Promise<void> {
		// The plan is made on the rows shown; each planned order is written to every twin of the row, so a hidden twin never becomes the first one.
		return this.change((merged) => planBookmarkMove(liveBookmarks(merged), id, to).flatMap((m) => bookmarkTwins(merged, m.id).map((twin) => ({ kind: "order" as const, id: twin, order: m.order }))));
	}

	/** The notebook at `from` was renamed or moved to `to`: the bookmarks that point at it follow. */
	retarget(from: string, to: string, docId?: string): Promise<void> {
		return this.retargetMany([{ from, to, ...(docId !== undefined ? { docId } : {}) }]);
	}

	/** Several renames, in order, in one read and one write (a renamed folder moves many notebooks at once). */
	retargetMany(renames: ReadonlyArray<{ from: string; to: string; docId?: string }>): Promise<void> {
		return this.change(() => renames.filter((r) => r.from !== r.to).map((r) => ({ kind: "retarget" as const, from: r.from, to: r.to, ...(r.docId !== undefined ? { docId: r.docId } : {}) })));
	}

	private change(ops: (merged: BookmarksMap) => BookmarkOp[]): Promise<void> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const list = ops(merged);
			if (list.length > 0) await this.writeOps(own, merged, others, list);
		});
	}

	private async writeOps(own: { data: BookmarksFile; exists: boolean }, merged: BookmarksMap, others: BookmarksFile[], ops: BookmarkOp[]): Promise<void> {
		const after = applyBookmarkOps(own.data, merged, ops, this.now());
		const text = serializeBookmarks(after);
		if (own.exists && text === serializeBookmarks(own.data)) return;
		if (!own.exists && after.items.length === 0) return;
		const pruned = pruneBookmarkTombstones(after, this.now(), others, this.blocked === null);
		const prunedText = pruned === after ? text : serializeBookmarks(pruned);
		const check = parseBookmarks(prunedText, this.device);
		if (!check.ok) throw new Error(`bookmarks did not validate: ${check.message}`);
		await ensureFolderPath(this.adapter, this.folder);
		await this.adapter.write(this.ownPath, prunedText);
		this.setCache(mergeBookmarkFiles([pruned, ...others]));
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private setCache(next: BookmarksMap): void {
		const before = JSON.stringify([...this.cache]);
		this.cache = next;
		if (before === JSON.stringify([...next])) return;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] bookmarks listener failed", e);
			}
		}
	}

	private async readOwn(): Promise<{ data: BookmarksFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyBookmarks(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseBookmarks(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			// A copy only of a file that is damaged; an empty file (it may not have synced yet) and a newer one are left as they are.
			if (parsed.reason === "json" || parsed.reason === "format") await keepUnreadableCopy(this.adapter, this.folder, BOOKMARKS_PREFIX, text);
			throw new BookmarksBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: BookmarksMap; others: BookmarksFile[] }> {
		const own: BookmarksFile[] = [];
		const others: BookmarksFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, BOOKMARKS_PREFIX)) {
			try {
				const parsed = parseBookmarks(await this.adapter.read(path), device);
				if (!parsed.ok) bad.push(`${path}: ${parsed.message}`);
				else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.loaded = true;
		this.setCache(mergeBookmarkFiles([...own, ...others]));
		return { merged: this.cache, others };
	}
}
