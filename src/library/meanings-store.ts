/**
 * The files of the per-notebook colour meanings (`<notebooks folder>/_meta/meanings-<device>.json`, see `meanings.ts`). No
 * 'obsidian' import: the vault is reached through an adapter, so this is testable in Node. The same rules as the quick tabs:
 *
 * - Written only by `set` (never by looking at a notebook).
 * - Only this device's own file is ever written. Each write reads every file again first, applies the change, serialises,
 *   re-validates the text and writes only if it differs.
 * - A file that cannot be read, or is empty (it may not have synced yet), is never overwritten: one copy named by its content
 *   is kept next to it (only when damaged), and (for the device's own file) the write is refused with `MeaningsBlockedError`.
 *   The other devices' unreadable files are skipped and reported in `blocked`.
 */
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "../storage/device-files";
import { linksFolder } from "../storage/pdf-links-store";
import type { Meaning } from "../model/colour-meaning";
import {
	applyMeaningOps, emptyMeanings, mergeMeaningFiles, overrideOf, parseMeanings, pruneMeaningTombstones, serializeMeanings,
	MEANINGS_PREFIX, type MeaningsFile, type MeaningsMap,
} from "./meanings";

/** This device's file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class MeaningsBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "MeaningsBlockedError";
	}
}

export class MeaningsStore {
	private cache: MeaningsMap = new Map();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
	loaded = false;
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

	get ownPath(): string {
		return `${this.folder}/${deviceFileName(MEANINGS_PREFIX, this.device)}`;
	}

	/** Whether a change to `path` can change the legends (any device's file). */
	watches(path: string): boolean {
		const prefix = `${this.folder}/${MEANINGS_PREFIX}-`;
		return path.startsWith(prefix) && /^[0-9a-f]{8}\.json$/.test(path.slice(prefix.length));
	}

	/** The notebook's own legend from the last read, or null (it uses the global one). */
	get(scope: string): Meaning[] | null {
		return overrideOf(this.cache, scope);
	}

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

	/** Sets the notebook's own legend (null: back to the global one). */
	set(scope: string, legend: Meaning[] | null): Promise<void> {
		return this.enqueue(async () => {
			const own = await this.readOwn();
			const { merged, others } = await this.readAll();
			const after = applyMeaningOps(own.data, merged, [{ kind: "set", scope, legend }], this.now());
			const text = serializeMeanings(after);
			if (own.exists && text === serializeMeanings(own.data)) return;
			if (!own.exists && after.items.length === 0) return;
			const pruned = pruneMeaningTombstones(after, this.now(), others, this.blocked === null);
			const prunedText = pruned === after ? text : serializeMeanings(pruned);
			const check = parseMeanings(prunedText, this.device);
			if (!check.ok) throw new Error(`colour meanings did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, prunedText);
			this.setCache(mergeMeaningFiles([pruned, ...others]));
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private setCache(next: MeaningsMap): void {
		const before = JSON.stringify([...this.cache]);
		this.cache = next;
		if (before === JSON.stringify([...next])) return;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] colour meanings listener failed", e);
			}
		}
	}

	private async readOwn(): Promise<{ data: MeaningsFile; exists: boolean }> {
		if (!(await this.adapter.exists(this.ownPath))) return { data: emptyMeanings(this.device), exists: false };
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseMeanings(text, this.device);
		if (!parsed.ok) {
			this.blocked = `${this.ownPath}: ${parsed.message}`;
			if (parsed.reason === "json" || parsed.reason === "format") await keepUnreadableCopy(this.adapter, this.folder, MEANINGS_PREFIX, text);
			throw new MeaningsBlockedError(parsed.message, parsed.reason);
		}
		return { data: { ...parsed.data, device: this.device }, exists: true };
	}

	private async readAll(): Promise<{ merged: MeaningsMap; others: MeaningsFile[] }> {
		const own: MeaningsFile[] = [];
		const others: MeaningsFile[] = [];
		const bad: string[] = [];
		for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, MEANINGS_PREFIX)) {
			try {
				const parsed = parseMeanings(await this.adapter.read(path), device);
				if (!parsed.ok) bad.push(`${path}: ${parsed.message}`);
				else (path === this.ownPath ? own : others).push({ ...parsed.data, device });
			} catch (e) {
				bad.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.blocked = bad.length > 0 ? bad.join("; ") : null;
		this.loaded = true;
		this.setCache(mergeMeaningFiles([...own, ...others]));
		return { merged: this.cache, others };
	}
}
