import { deviceFileName, deviceOfFileName, EMPTY_FILE_MESSAGE, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter } from "./device-files";
import { linksFolder } from "./pdf-links-store";
import { emptyCopies, mergeCopies, parseCopies, serializeCopies, type CopiesFile, type CopyRecord } from "./pdf-copy-logic";

/** Prefix of the sidecar files: `<notebooks folder>/_meta/pdfcopy-<device>.json`. */
export const PDF_COPY_PREFIX = "pdfcopy";

/** This device's record file cannot be read, is empty or is from a newer version: nothing is written and it is left as it is. */
export class PdfCopyBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "PdfCopyBlockedError";
	}
}

/**
 * What the plugin remembers about the PDF copies it wrote (path, size and hash of the bytes, fingerprint, time), one file per
 * device like the other `_meta` sidecars (storage/device-files.ts): a device only writes its own file, reading looks at every
 * device's file. `update` reads the own file again, applies the change, serializes, re-validates the text and writes only if it
 * differs; an own file that cannot be read, is empty (it may not have synced yet) or is newer is never overwritten.
 */
export class PdfCopyStore {
	private queue: Promise<unknown> = Promise.resolve();
	private all: CopyRecord[] = [];
	private merged: Record<string, CopyRecord> = {};

	constructor(private readonly adapter: DeviceFileAdapter, private readonly notebooksFolder: () => string, readonly device: string) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	get ownPath(): string {
		return `${this.folder}/${deviceFileName(PDF_COPY_PREFIX, this.device)}`;
	}

	/** The newest record per notebook, as last read. */
	records(): Readonly<Record<string, CopyRecord>> {
		return this.merged;
	}

	/** Every record of every device, as last read: a file is ours when any of them describes it. */
	allRecords(): readonly CopyRecord[] {
		return this.all;
	}

	/** Reads every device's file. A file that cannot be read is skipped (never changed). */
	load(): Promise<Record<string, CopyRecord>> {
		return this.enqueue(() => this.readAll());
	}

	/**
	 * Throws a PdfCopyBlockedError when this device's file cannot be written to: it cannot be read, is empty or is newer (never
	 * touched), and creates it (empty, valid) when there is none, which proves the folder takes a write. The service calls it
	 * before it writes a PDF: a copy whose record cannot be kept would be written again at every build.
	 */
	ensureWritable(): Promise<void> {
		return this.enqueue(async () => {
			await this.readAll();
			const own = await this.readOwn();
			if (await this.adapter.exists(this.ownPath)) return;
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, serializeCopies(own));
			await this.readAll();
		});
	}

	/** Applies `change` to this device's file. Returns the new merged records. */
	update(change: (own: CopiesFile, merged: Readonly<Record<string, CopyRecord>>) => CopiesFile): Promise<Record<string, CopyRecord>> {
		return this.enqueue(async () => {
			await this.readAll();
			const own = await this.readOwn();
			const next = change(own, this.merged);
			if (next === own) return this.merged;
			const text = serializeCopies(next);
			if (!parseCopies(text).ok) throw new Error("the PDF copy record did not validate");
			if (text === serializeCopies(own) && (await this.adapter.exists(this.ownPath))) return this.merged;
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
			return this.readAll();
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readOwn(): Promise<CopiesFile> {
		if (!(await this.adapter.exists(this.ownPath))) return emptyCopies();
		const text = await this.adapter.read(this.ownPath);
		if (text.trim() === "") throw new PdfCopyBlockedError(EMPTY_FILE_MESSAGE, "empty");
		const parsed = parseCopies(text);
		if (!parsed.ok) {
			if (parsed.reason !== "future") await keepUnreadableCopy(this.adapter, this.folder, PDF_COPY_PREFIX, text);
			throw new PdfCopyBlockedError(parsed.message, parsed.reason);
		}
		return parsed.data;
	}

	private async readAll(): Promise<Record<string, CopyRecord>> {
		const files: CopiesFile[] = [];
		let listed: Array<{ path: string; device: string }> = [];
		try {
			listed = await listDeviceFiles(this.adapter, this.folder, PDF_COPY_PREFIX);
		} catch (e) {
			console.warn("[notebook] PDF copy records not listed", e);
		}
		for (const { path } of listed) {
			if (deviceOfFileName(PDF_COPY_PREFIX, path.slice(path.lastIndexOf("/") + 1)) === null) continue;
			try {
				const text = await this.adapter.read(path);
				if (text.trim() === "") continue;
				const parsed = parseCopies(text);
				if (parsed.ok) files.push(parsed.data);
			} catch (e) {
				console.warn("[notebook] PDF copy record not read", path, e);
			}
		}
		this.all = files.flatMap((f) => Object.values(f.copies));
		this.merged = mergeCopies(files);
		return this.merged;
	}
}
