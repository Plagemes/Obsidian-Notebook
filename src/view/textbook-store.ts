import { linksFolder, type LinkFileAdapter } from "../storage/pdf-links-store";
import {
	applyTextbookOp, emptyTextbooks, parseTextbooks, serializeTextbooks, TEXTBOOKS_FILE,
	type TextbookData, type TextbookOp,
} from "./textbook-ref";

/** The textbooks file cannot be read or is from a newer version: nothing is written and the file is left as it is. */
export class TextbooksBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future") {
		super(message);
		this.name = "TextbooksBlockedError";
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
 * The textbook configuration file (`<notebooks folder>/_meta/textbooks.json`, roadmap 208). Same rules as the PDF links
 * file: written only by `update` (an explicit *Set textbook* / *Remove textbook*), which reads the file again first, applies
 * the operation, re-validates the text and writes only if it differs; a file that cannot be parsed is never overwritten
 * (one copy named by its content is kept next to it). Reading never writes.
 */
export class TextbookStore {
	private cache: TextbookData = emptyTextbooks();
	private queue: Promise<unknown> = Promise.resolve();
	/** Why the file cannot be used, or null. */
	blocked: string | null = null;

	constructor(private readonly adapter: LinkFileAdapter, private readonly notebooksFolder: () => string) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	get path(): string {
		return `${this.folder}/${TEXTBOOKS_FILE}`;
	}

	snapshot(): TextbookData {
		return this.cache;
	}

	/** Reads the file. A missing file is an empty configuration; an unreadable one is reported in `blocked` and gives none. */
	load(): Promise<TextbookData> {
		return this.enqueue(async () => {
			try {
				return await this.readCurrent(false);
			} catch (e) {
				if (e instanceof TextbooksBlockedError) return emptyTextbooks();
				throw e;
			}
		});
	}

	update(ops: TextbookOp | TextbookOp[]): Promise<TextbookData> {
		const list = Array.isArray(ops) ? ops : [ops];
		return this.enqueue(async () => {
			const before = await this.readCurrent(true);
			const after = list.reduce(applyTextbookOp, before);
			const text = serializeTextbooks(after);
			if (text === serializeTextbooks(before) && (await this.adapter.exists(this.path))) return before;
			const check = parseTextbooks(text);
			if (!check.ok) throw new Error(`textbooks did not validate: ${check.message}`);
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

	private async readCurrent(keep: boolean): Promise<TextbookData> {
		if (!(await this.adapter.exists(this.path))) {
			this.blocked = null;
			this.cache = emptyTextbooks();
			return this.cache;
		}
		const text = await this.adapter.read(this.path);
		const parsed = parseTextbooks(text);
		if (!parsed.ok) {
			this.blocked = parsed.message;
			if (keep) await this.keepCopy(text);
			throw new TextbooksBlockedError(parsed.message, parsed.reason);
		}
		this.blocked = null;
		this.cache = parsed.data;
		return parsed.data;
	}

	private async keepCopy(text: string): Promise<void> {
		const copy = `${this.folder}/textbooks.unreadable-${textHash(text)}.json`;
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
