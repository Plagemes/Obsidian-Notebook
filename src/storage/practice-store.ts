import {
	applyDeviceOp, emptyPractice, mergePractice, parsePractice, serializePractice, type PracticeData, type PracticeOp,
} from "../model/practice";
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "./device-files";
import { linksFolder } from "./pdf-links-store";

/** The single shared file of earlier versions: still read (merged in), never written again. */
export const PRACTICE_FILE = "practice.json";
/** Per-device files: `practice-<device>.json`. */
export const PRACTICE_PREFIX = "practice";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written and the file is left as it is. */
export class PracticeBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "PracticeBlockedError";
	}
}

/**
 * Sidecar of the practice copies, one file per device (`<notebooks folder>/_meta/practice-<device>.json`, vault files in
 * the reserved `_meta` folder, so they sync with the notebooks). A device writes only its own file, so two devices never
 * write the same file and a sync service has nothing to conflict on; reading merges every device's file and the old shared
 * `practice.json` (model/practice.ts, mergePractice), which is migrated lazily: it is read as one more source and never
 * written or deleted, so no record of it is lost.
 *
 * Written only by `update`, which explicit actions call. Every update reads the files again first (another device may
 * have synced), applies the operations to this device's file, serialises, re-validates the text and writes only if it
 * differs. This device's file is never overwritten when it cannot be read or is empty (it may not have synced yet): one
 * copy of it is kept and the update is refused. Other files that cannot be read are skipped and reported in `unreadable`.
 */
export class PracticeStore {
	private cache: PracticeData = emptyPractice();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly folderOf: () => string;
	/** Files that could not be read at the last load or update (`path: reason`). */
	unreadable: string[] = [];

	constructor(private readonly adapter: DeviceFileAdapter, folder: string | (() => string), readonly device: string) {
		this.folderOf = typeof folder === "string" ? () => folder : folder;
	}

	/** The old shared file. */
	get legacyPath(): string {
		return `${this.folder}/${PRACTICE_FILE}`;
	}

	/** This device's file. */
	get ownPath(): string {
		return `${this.folder}/${deviceFileName(PRACTICE_PREFIX, this.device)}`;
	}

	private get folder(): string {
		return linksFolder(this.folderOf());
	}

	/** Whether a change to `path` can change the data (any device's file, or the old shared one). */
	watches(path: string): boolean {
		if (path === this.legacyPath) return true;
		const prefix = `${this.folder}/${PRACTICE_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The merged data as last read or written. */
	snapshot(): PracticeData {
		return this.cache;
	}

	/** Reads every file and merges them. Nothing is written; files that cannot be read are listed in `unreadable`. */
	async load(): Promise<PracticeData> {
		return this.enqueue(async () => (await this.readAll()).merged);
	}

	/** Applies operations to this device's file as it is now, writes it, and returns the merged data. */
	async update(ops: PracticeOp | PracticeOp[]): Promise<PracticeData> {
		const list = Array.isArray(ops) ? ops : [ops];
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			let after = own.data;
			for (const op of list) after = applyDeviceOp(after, mergePractice([after, ...others]), op);
			const text = serializePractice(after);
			if (text === serializePractice(own.data) && own.exists) return merged;
			const check = parsePractice(text);
			if (!check.ok) throw new Error(`practice file did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
			this.cache = mergePractice([after, ...others]);
			return this.cache;
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readOwn(): Promise<{ data: PracticeData; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyPractice(), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parsePractice(text);
		if (!parsed.ok) {
			await keepUnreadableCopy(this.adapter, this.folder, PRACTICE_PREFIX, text);
			throw new PracticeBlockedError(parsed.message, parsed.reason);
		}
		return { data: parsed.data, exists: true };
	}

	/** Every file: this device's first, then the other devices' and the old shared file last. */
	private async readAll(): Promise<{ merged: PracticeData; others: PracticeData[] }> {
		const own: PracticeData[] = [];
		const others: PracticeData[] = [];
		const bad: string[] = [];
		const read = async (path: string, into: PracticeData[]) => {
			try {
				const parsed = parsePractice(await this.adapter.read(path));
				if (parsed.ok) into.push(parsed.data);
				else bad.push(`${path}: ${parsed.message}`);
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		for (const { path } of await listDeviceFiles(this.adapter, this.folder, PRACTICE_PREFIX)) await read(path, path === this.ownPath ? own : others);
		if (await this.adapter.exists(this.legacyPath)) await read(this.legacyPath, others);
		this.unreadable = bad;
		this.cache = mergePractice([...own, ...others]);
		return { merged: this.cache, others };
	}
}
