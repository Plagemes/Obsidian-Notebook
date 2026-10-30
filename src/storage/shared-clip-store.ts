import type { ClipContent } from "../ink/clipboard";
import {
	addSharedEntry, emptySharedClip, listSharedItems, makeSharedEntry, MAX_SHARED_FILE_BYTES, parseSharedClip, serializeSharedClip, SHARED_CLIP_PREFIX,
	type SharedClipFile, type SharedClipItem,
} from "../ink/shared-clip";
import { deviceFileName, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "./device-files";
import { linksFolder } from "./pdf-links-store";

/** This device's clipboard file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class SharedClipBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "SharedClipBlockedError";
	}
}

/** The selection cannot be shared: too large, or it did not validate. Nothing was written. */
export class SharedClipRefusedError extends Error {
	constructor(message: string, readonly reason: "too-large" | "invalid") {
		super(message);
		this.name = "SharedClipRefusedError";
	}
}

export interface PublishResult {
	/** Entries now in this device's file. */
	entries: number;
	/** Older entries dropped to make room. */
	dropped: number;
}

export interface OthersResult {
	items: SharedClipItem[];
	/** Other devices' files that could not be read (`path: reason`); they are skipped and never touched. */
	unreadable: string[];
}

/**
 * The cross-device clipboard in the vault (roadmap 362): `<notebooks folder>/_meta/clipboard-<device>.json`, one file per
 * device (storage/device-files.ts), so two synced devices never write the same file. A device writes its own file only in
 * `publish`, which the "Copy to other devices" action calls: it reads the file again, adds the entry, serializes,
 * re-validates the text and writes. An own file that cannot be read, is empty (it may not have synced yet) or is from a
 * newer version is never overwritten: one copy is kept and the copy is refused. `listOthers` only reads.
 */
export class SharedClipStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly adapter: DeviceFileAdapter, private readonly notebooksFolder: () => string, readonly device: string) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	get ownPath(): string {
		return `${this.folder}/${deviceFileName(SHARED_CLIP_PREFIX, this.device)}`;
	}

	/** Puts the selection at the front of this device's clipboard file. */
	publish(clip: ClipContent, now: number = Date.now()): Promise<PublishResult> {
		return this.enqueue(async () => {
			const made = makeSharedEntry(clip, now);
			if (!made.ok) throw new SharedClipRefusedError(made.message, made.reason);
			const own = await this.readOwn();
			const added = addSharedEntry(own, made.entry);
			if (!added.ok) throw new SharedClipRefusedError(added.message, added.reason);
			const text = serializeSharedClip(added.data);
			const check = parseSharedClip(text);
			if (!check.ok) throw new Error(`clipboard file did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
			return { entries: added.data.entries.length, dropped: added.dropped };
		});
	}

	/** The entries of the other devices' files, newest first. Nothing is written. */
	listOthers(): Promise<OthersResult> {
		return this.enqueue(async () => {
			const files: Array<{ device: string; data: SharedClipFile }> = [];
			const unreadable: string[] = [];
			for (const { path, device } of await listDeviceFiles(this.adapter, this.folder, SHARED_CLIP_PREFIX)) {
				if (device === this.device) continue;
				try {
					// A file of another device is read whole: skip one that is far bigger than a clipboard file can be.
					const size = await this.adapter.size?.(path);
					if (size !== undefined && size !== null && size > MAX_SHARED_FILE_BYTES) {
						unreadable.push(`${path}: file too large (${size} bytes)`);
						continue;
					}
					const parsed = parseSharedClip(await this.adapter.read(path));
					if (parsed.ok) files.push({ device, data: parsed.data });
					else unreadable.push(`${path}: ${parsed.message}`);
				} catch (e) {
					unreadable.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			return { items: listSharedItems(files), unreadable };
		});
	}

	private async readOwn(): Promise<SharedClipFile> {
		if (!(await this.adapter.exists(this.ownPath))) return emptySharedClip();
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseSharedClip(text);
		if (!parsed.ok) {
			if (parsed.reason !== "empty") await keepUnreadableCopy(this.adapter, this.folder, SHARED_CLIP_PREFIX, text);
			throw new SharedClipBlockedError(parsed.message, parsed.reason);
		}
		return parsed.data;
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}
}
