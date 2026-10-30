import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyDeviceTextbookOp, emptyTextbooks, mergeTextbooks, parseTextbooks, serializeTextbooks, TEXTBOOKS_FILE,
	type TextbookData, type TextbookOp,
} from "./textbook-ref";

/** Per-device files: `textbooks-<device>.json`. */
export const TEXTBOOKS_PREFIX = "textbooks";

/** This device's textbooks file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class TextbooksBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "TextbooksBlockedError";
	}
}

/**
 * The textbook configuration (roadmap 208), one file per device: `<notebooks folder>/_meta/textbooks-<device>.json`. A
 * device writes only its own file, so two devices never write the same file and a sync service has nothing to conflict
 * on; reading merges every device's file and the old shared `textbooks.json` of earlier versions, which is migrated lazily:
 * read as the oldest source, never written or deleted, so nothing it holds is lost (per textbook the latest setting or
 * removal wins, see mergeTextbooks).
 *
 * Written only by `update` (an explicit *Set textbook* / *Remove textbook*), which reads the files again first, applies the
 * operation to this device's file, re-validates the text and writes only if it differs. This device's file is never
 * overwritten when it cannot be read or is empty (it may not have synced yet): one copy named by its content is kept next
 * to it and the update is refused. Reading never writes; files that cannot be read are skipped and reported in `blocked`.
 */
export class TextbookStore {
	private cache: TextbookData = emptyTextbooks();
	private queue: Promise<unknown> = Promise.resolve();
	/** Why some file cannot be used (the files and reasons), or null. */
	blocked: string | null = null;

	constructor(private readonly adapter: DeviceFileAdapter, private readonly notebooksFolder: () => string, readonly device: string) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	/** This device's file (the one `update` writes). */
	get path(): string {
		return `${this.folder}/${deviceFileName(TEXTBOOKS_PREFIX, this.device)}`;
	}

	/** The old shared file: read, never written. */
	get legacyPath(): string {
		return `${this.folder}/${TEXTBOOKS_FILE}`;
	}

	/** Whether a change to `path` can change the configuration. */
	watches(path: string): boolean {
		if (path === this.legacyPath) return true;
		const prefix = `${this.folder}/${TEXTBOOKS_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	snapshot(): TextbookData {
		return this.cache;
	}

	/** Reads every file and merges them. A missing file is no textbooks; an unreadable one is reported in `blocked` and skipped. */
	load(): Promise<TextbookData> {
		return this.enqueue(async () => (await this.readAll()).merged);
	}

	update(ops: TextbookOp | TextbookOp[]): Promise<TextbookData> {
		const list = Array.isArray(ops) ? ops : [ops];
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const after = list.reduce((d, op) => applyDeviceTextbookOp(d, op), own.data);
			const text = serializeTextbooks(after);
			if (text === serializeTextbooks(own.data) && own.exists) return merged;
			const check = parseTextbooks(text);
			if (!check.ok) throw new Error(`textbooks did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.path, text);
			this.cache = mergeTextbooks([after, ...others]);
			return this.cache;
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readOwn(): Promise<{ data: TextbookData; exists: boolean }> {
		if (!(await this.adapter.exists(this.path))) return { data: emptyTextbooks(), exists: false };
		const text = await this.adapter.read(this.path);
		const parsed = parseTextbooks(text);
		if (!parsed.ok) {
			this.blocked = `${this.path}: ${parsed.message}`;
			await keepUnreadableCopy(this.adapter, this.folder, TEXTBOOKS_PREFIX, text);
			throw new TextbooksBlockedError(parsed.message, parsed.reason);
		}
		return { data: parsed.data, exists: true };
	}

	/** Every file: this device's first, then the other devices' and the old shared file last. */
	private async readAll(): Promise<{ merged: TextbookData; others: TextbookData[] }> {
		const own: TextbookData[] = [];
		const others: TextbookData[] = [];
		const bad: string[] = [];
		const read = async (path: string, into: TextbookData[]) => {
			try {
				const parsed = parseTextbooks(await this.adapter.read(path));
				if (parsed.ok) into.push(parsed.data);
				else bad.push(`${path}: ${parsed.message}`);
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		for (const { path } of await listDeviceFiles(this.adapter, this.folder, TEXTBOOKS_PREFIX)) await read(path, path === this.path ? own : others);
		if (await this.adapter.exists(this.legacyPath)) await read(this.legacyPath, others);
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.cache = mergeTextbooks([...own, ...others]);
		return { merged: this.cache, others };
	}
}
