/**
 * The files of the quick tabs (`<notebooks folder>/_meta/quicktabs-<device>.json`, see `quicktabs.ts`). No 'obsidian'
 * import: the vault is reached through an adapter, so this is testable in Node. The same rules as the saved collections
 * (collections-store.ts):
 *
 * - Written only by `pin`, `unpin`, `move` and `retarget` (never by looking at a notebook).
 * - Only this device's own file is ever written. Each write reads every file again first, applies the change, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its
 *   content is kept next to it (only when it is damaged), and (for the device's own file) the write is refused with
 *   `QuickTabsBlockedError`. The other devices' unreadable files are skipped and reported in `blocked`.
 * - When the own file is rewritten, it adopts the winning state of the ids it holds (an unpin made elsewhere), and unpins older than
 *   90 days are dropped from it unless another device's file still holds that pin live.
 */
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyQuickTabOps, emptyQuickTabs, findPin, mergeQuickTabFiles, newQuickTabId, orderAtEnd, parseQuickTabs, planMove, pruneQuickTabTombstones,
	QUICKTABS_MAX, QUICKTABS_PREFIX, serializeQuickTabs, tabsFor, type QuickTab, type QuickTabOp, type QuickTabsFile, type QuickTabsMap,
} from "./quicktabs";

/** This device's file cannot be read, is empty or is from a newer version, or the notebook has too many tabs: nothing is written. */
export class QuickTabsBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty" | "limit") {
		super(message);
		this.name = "QuickTabsBlockedError";
	}
}

export interface PinRequest {
	scope: string;
	path: string;
	pageId: string;
	num: number;
	label?: string;
}

export class QuickTabsStore {
	private cache: QuickTabsMap = new Map();
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
		return `${this.folder}/${deviceFileName(QUICKTABS_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the tabs (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${QUICKTABS_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The tabs of the notebook `scope` from the last read, in strip order. */
	list(scope: string): QuickTab[] {
		return tabsFor(this.cache, scope);
	}

	/** Runs `fn` after the tabs changed. Returns the unsubscribe function. */
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

	/** Pins a page at the end of the strip of `scope`; returns the id (of the existing tab when the page is pinned already). */
	pin(r: PinRequest): Promise<string> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const there = findPin(merged, r.scope, r.path, r.pageId);
			if (there) return there.id;
			const tabs = tabsFor(merged, r.scope);
			if (tabs.length >= QUICKTABS_MAX) throw new QuickTabsBlockedError("too many quick tabs", "limit");
			const id = newQuickTabId(new Set(merged.keys()), this.random);
			await this.writeOps(own, merged, others, [{ kind: "pin", id, ...r, order: orderAtEnd(tabs) }]);
			return id;
		});
	}

	/** Removes a tab (the page it points at is never touched). */
	unpin(id: string): Promise<void> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			await this.writeOps(own, merged, others, [{ kind: "unpin", id }]);
		});
	}

	/** Moves the tab `id` of `scope` so that it is at index `to` of the strip. */
	move(scope: string, id: string, to: number): Promise<void> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const ops: QuickTabOp[] = planMove(tabsFor(merged, scope), id, to).map((m) => ({ kind: "order", ...m }));
			if (ops.length > 0) await this.writeOps(own, merged, others, ops);
		});
	}

	/** The notebook at `from` was renamed or moved to `to`: the tabs that point at it follow. */
	retarget(from: string, to: string): Promise<void> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			await this.writeOps(own, merged, others, [{ kind: "retarget", from, to }]);
		});
	}

	private async writeOps(own: { data: QuickTabsFile; exists: boolean }, merged: QuickTabsMap, others: QuickTabsFile[], ops: QuickTabOp[]): Promise<void> {
		const after = applyQuickTabOps(own.data, merged, ops, this.now());
		const text = serializeQuickTabs(after);
		if (own.exists && text === serializeQuickTabs(own.data)) return;
		if (!own.exists && after.items.length === 0) return;
		const pruned = pruneQuickTabTombstones(after, this.now(), others, this.blocked === null);
		const prunedText = pruned === after ? text : serializeQuickTabs(pruned);
		const check = parseQuickTabs(prunedText, this.device);
		if (!check.ok) throw new Error(`quick tabs did not validate: ${check.message}`);
		await ensureFolderPath(this.adapter, this.folder);
		await this.adapter.write(this.ownPath, prunedText);
		this.setCache(mergeQuickTabFiles([pruned, ...others]));
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private setCache(next: QuickTabsMap): void {
		const before = JSON.stringify([...this.cache]);
		this.cache = next;
		if (before === JSON.stringify([...next])) return;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] quick tabs listener failed", e);
			}
		}
	}

	private async readOwn(): Promise<{ data: QuickTabsFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyQuickTabs(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseQuickTabs(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			// A copy only of a file that is damaged; an empty file (it may not have synced yet) and a newer one are left as they are.
			if (parsed.reason === "json" || parsed.reason === "format") await keepUnreadableCopy(this.adapter, this.folder, QUICKTABS_PREFIX, text);
			throw new QuickTabsBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: QuickTabsMap; others: QuickTabsFile[] }> {
		const own: QuickTabsFile[] = [];
		const others: QuickTabsFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, QUICKTABS_PREFIX)) {
			try {
				const parsed = parseQuickTabs(await this.adapter.read(path), device);
				if (!parsed.ok) bad.push(`${path}: ${parsed.message}`);
				else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.loaded = true;
		this.setCache(mergeQuickTabFiles([...own, ...others]));
		return { merged: this.cache, others };
	}
}
