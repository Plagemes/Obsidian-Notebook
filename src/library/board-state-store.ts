/**
 * The files of the board statuses (`<notebooks folder>/_meta/board-<device>.json`, see `board-state.ts`). No 'obsidian'
 * import: the vault is reached through an adapter, so this is testable in Node.
 *
 * - Written only by `setStatus` (a drop on a column, "Move to…"); never by looking at the board.
 * - Only this device's own file is ever written. Each write reads every file again first (an older copy of the own file may
 *   have been synced in, and the other devices' files give the times to be later than), applies the change, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its
 *   content is kept next to it, and (for the device's own file) the write is refused with `BoardBlockedError`. The other
 *   devices' unreadable files are skipped and reported in `blocked`.
 */
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyBoardOps, BOARD_PREFIX, emptyBoard, mergeBoardFiles, parseBoard, pruneBoardFile, serializeBoard,
	type BoardFile, type BoardMap, type BoardOp,
} from "./board-state";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class BoardBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "BoardBlockedError";
	}
}

export class BoardStateStore {
	private cache: BoardMap = new Map();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
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
		return `${this.folder}/${deviceFileName(BOARD_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the statuses (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${BOARD_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The merged statuses as last read or written. */
	snapshot(): BoardMap {
		return this.cache;
	}

	/** Runs `fn` after the merged statuses changed (a write here, or another device's file read). Returns the unsubscribe function. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** Reads every device's file and merges them. Nothing is written. */
	load(): Promise<BoardMap> {
		return this.enqueue(async () => (await this.readAll()).merged);
	}

	/** Moves notebooks to statuses (or clears them) in this device's file as it is now, and returns the merged statuses. */
	setStatus(ops: BoardOp | readonly BoardOp[]): Promise<BoardMap> {
		const list = Array.isArray(ops) ? (ops as readonly BoardOp[]) : [ops as BoardOp];
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			// The own file is rewritten anyway: cleared statuses nobody contradicts are dropped with it.
			const after = pruneBoardFile(applyBoardOps(own.data, merged, list, this.now()), others, null, this.now());
			const text = serializeBoard(after);
			if (own.exists ? text === serializeBoard(own.data) : after.items.length === 0) return merged;
			const check = parseBoard(text, this.device);
			if (!check.ok) throw new Error(`board file did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
			this.setCache(mergeBoardFiles([after, ...others]));
			return this.cache;
		});
	}

	/**
	 * Drops from this device's file the statuses of notebooks that no longer exist (`live`: every state key of the library,
	 * given only when the library has read all its notebooks) and cleared statuses nobody contradicts. Writes only when
	 * something goes, only the own file, after the same re-validation as a status change. Returns whether it wrote.
	 */
	prune(live: ReadonlySet<string> | null): Promise<boolean> {
		return this.enqueue(async () => {
			if (!(await this.adapter.exists(this.ownPath))) return false;
			const own = await this.readOwn();
			const { others } = await this.readAll();
			const after = pruneBoardFile(own.data, others, live, this.now());
			if (after === own.data) return false;
			const text = serializeBoard(after);
			const check = parseBoard(text, this.device);
			if (!check.ok) throw new Error(`board file did not validate: ${check.message}`);
			await this.adapter.write(this.ownPath, text);
			await this.readAll();
			return true;
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private setCache(next: BoardMap): void {
		const before = this.cache;
		this.cache = next;
		if (same(before, next)) return;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] board listener failed", e);
			}
		}
	}

	private async readOwn(): Promise<{ data: BoardFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyBoard(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseBoard(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			await keepUnreadableCopy(this.adapter, this.folder, BOARD_PREFIX, text);
			throw new BoardBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: BoardMap; others: BoardFile[] }> {
		const own: BoardFile[] = [];
		const others: BoardFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, BOARD_PREFIX)) {
			try {
				const text = await this.adapter.read(path);
				const parsed = parseBoard(text, device);
				if (!parsed.ok) {
					bad.push(`${path}: ${parsed.message}`);
					if (path === this.ownPath) await keepUnreadableCopy(this.adapter, this.folder, BOARD_PREFIX, text);
				} else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.setCache(mergeBoardFiles([...own, ...others]));
		return { merged: this.cache, others };
	}
}

function same(a: BoardMap, b: BoardMap): boolean {
	if (a.size !== b.size) return false;
	for (const [key, x] of a) {
		const y = b.get(key);
		if (!y || x.status !== y.status) return false;
	}
	return true;
}
