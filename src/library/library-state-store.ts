/**
 * The files of the library state (`<notebooks folder>/_meta/library-<device>.json`, see `library-state.ts`). No 'obsidian'
 * import: the vault is reached through an adapter, so this is testable in Node.
 *
 * - Written only by `update`, which the explicit actions (pin, archive, restore, move) call; never by looking at the library.
 * - Only this device's own file is ever written. `update` reads every file again first (an older copy of the own file may
 *   have been synced in, and the other devices' files give the times to be later than), applies the changes, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its
 *   content is kept next to it, and (for the device's own file) `update` refuses with `LibraryStateBlockedError`. The other
 *   devices' unreadable files are skipped and reported in `blocked`.
 */
import {
	deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter,
} from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyLibraryOps, emptyLibraryState, LIBRARY_STATE_PREFIX, mergeLibraryFiles, parseLibraryState, serializeLibraryState,
	type LibraryMap, type LibraryOp, type LibraryStateFile,
} from "./library-state";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class LibraryStateBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "LibraryStateBlockedError";
	}
}

export class LibraryStateStore {
	private cache: LibraryMap = new Map();
	private queue: Promise<unknown> = Promise.resolve();
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

	/** This device's file (the one `update` writes). */
	get ownPath(): string {
		return `${this.folder}/${deviceFileName(LIBRARY_STATE_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the state (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${LIBRARY_STATE_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The merged state as last read or written. */
	snapshot(): LibraryMap {
		return this.cache;
	}

	/** Reads every device's file and merges them. Nothing is written. */
	load(): Promise<LibraryMap> {
		return this.enqueue(async () => (await this.readAll()).merged);
	}

	/** Applies changes to this device's file as it is now, writes it, and returns the merged state. */
	update(ops: LibraryOp | readonly LibraryOp[]): Promise<LibraryMap> {
		const list = Array.isArray(ops) ? (ops as readonly LibraryOp[]) : [ops as LibraryOp];
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const after = applyLibraryOps(own.data, merged, list, this.now());
			const text = serializeLibraryState(after);
			if (own.exists && text === serializeLibraryState(own.data)) return merged;
			const check = parseLibraryState(text, this.device);
			if (!check.ok) throw new Error(`library state did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
			this.cache = mergeLibraryFiles([after, ...others]);
			return this.cache;
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readOwn(): Promise<{ data: LibraryStateFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyLibraryState(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseLibraryState(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			await keepUnreadableCopy(this.adapter, this.folder, LIBRARY_STATE_PREFIX, text);
			throw new LibraryStateBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: LibraryMap; others: LibraryStateFile[] }> {
		const own: LibraryStateFile[] = [];
		const others: LibraryStateFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, LIBRARY_STATE_PREFIX)) {
			try {
				const parsed = parseLibraryState(await this.adapter.read(path), device);
				if (!parsed.ok) bad.push(`${path}: ${parsed.message}`);
				else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.cache = mergeLibraryFiles([...own, ...others]);
		return { merged: this.cache, others };
	}
}
