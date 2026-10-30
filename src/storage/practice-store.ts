import {
	applyPracticeOp, emptyPractice, parsePractice, serializePractice, type PracticeData, type PracticeOp,
} from "../model/practice";
import { linksFolder, type LinkFileAdapter } from "./pdf-links-store";

export const PRACTICE_FILE = "practice.json";

/** The file cannot be read or is from a newer version: nothing is written and the file is left as it is. */
export class PracticeBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future") {
		super(message);
		this.name = "PracticeBlockedError";
	}
}

function textHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Sidecar of the practice copies (`<notebooks folder>/_meta/practice.json`, a vault file in the reserved `_meta` folder,
 * so it syncs with the notebooks). Written only by `update`, which explicit actions call. Every update reads the file
 * again first (another device may have synced a newer one), applies the operations to that, serialises, re-validates
 * the text and writes only if it differs. A file that cannot be parsed is never overwritten; one copy of it is kept
 * next to it. Same file operations as the PDF links store, so it works on any vault adapter.
 */
export class PracticeStore {
	private cache: PracticeData = emptyPractice();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly folderOf: () => string;

	constructor(private readonly adapter: LinkFileAdapter, folder: string | (() => string)) {
		this.folderOf = typeof folder === "string" ? () => folder : folder;
	}

	get path(): string {
		return `${linksFolder(this.folderOf())}/${PRACTICE_FILE}`;
	}

	private get folder(): string {
		return linksFolder(this.folderOf());
	}

	/** The data as last read or written. */
	snapshot(): PracticeData {
		return this.cache;
	}

	/** Reads the file into the cache. A missing file is an empty set; an unreadable one throws `PracticeBlockedError`. */
	async load(): Promise<PracticeData> {
		return this.enqueue(() => this.readCurrent());
	}

	/** Applies operations to the file as it is now, writes it, and returns the new data. */
	async update(ops: PracticeOp | PracticeOp[]): Promise<PracticeData> {
		const list = Array.isArray(ops) ? ops : [ops];
		return this.enqueue(async () => {
			const before = await this.readCurrent();
			const after = list.reduce(applyPracticeOp, before);
			const text = serializePractice(after);
			if (text === serializePractice(before) && (await this.adapter.exists(this.path))) return before;
			const check = parsePractice(text);
			if (!check.ok) throw new Error(`practice file did not validate: ${check.message}`);
			await this.ensureFolder();
			await this.adapter.write(this.path, text);
			this.cache = after;
			return after;
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readCurrent(): Promise<PracticeData> {
		if (!(await this.adapter.exists(this.path))) {
			this.cache = emptyPractice();
			return this.cache;
		}
		const text = await this.adapter.read(this.path);
		const parsed = parsePractice(text);
		if (!parsed.ok) {
			await this.keepCopy(text);
			throw new PracticeBlockedError(parsed.message, parsed.reason);
		}
		this.cache = parsed.data;
		return parsed.data;
	}

	/** One copy of an unreadable file, named by its content, so repeated failures do not pile up files. */
	private async keepCopy(text: string): Promise<void> {
		const copy = `${this.folder}/practice.unreadable-${textHash(text)}.json`;
		try {
			if (!(await this.adapter.exists(copy))) await this.adapter.write(copy, text);
		} catch {
			/* the original is untouched either way */
		}
	}

	private async ensureFolder(): Promise<void> {
		let current = "";
		for (const part of this.folder.split("/").filter(Boolean)) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
		}
	}
}
