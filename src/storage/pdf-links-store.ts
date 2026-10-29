import { applyLinkOp, emptyLinks, parseLinks, serializeLinks, type LinksData, type LinksOp } from "../pdf/sync-links";

/** The slice of Obsidian's DataAdapter the store uses; declared here so the store is testable without Obsidian. */
export interface LinkFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export const LINKS_FILE = "pdf-links.json";

/** The file cannot be read or is from a newer version: nothing is written and the file is left as it is. */
export class LinksBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future") {
		super(message);
		this.name = "LinksBlockedError";
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
 * Sidecar of the PDF links (`<plugin folder>/pdf-links.json`). Written only by `update`, which is called by explicit
 * link actions. Every update reads the file again first (another device may have synced a newer one) and applies
 * the operation to that, serialises, re-validates the text and writes only if it differs. A file that cannot be
 * parsed is never overwritten; a copy of it is kept next to it once.
 */
export class PdfLinkStore {
	private cache: LinksData = emptyLinks();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly adapter: LinkFileAdapter, private readonly folder: string) {}

	get path(): string {
		return `${this.folder}/${LINKS_FILE}`;
	}

	/** The links as last read or written. */
	snapshot(): LinksData {
		return this.cache;
	}

	/** Reads the file into the cache. A missing file is an empty set; an unreadable one throws `LinksBlockedError`. */
	async load(): Promise<LinksData> {
		return this.enqueue(() => this.readCurrent());
	}

	/** Applies operations to the file as it is now, writes it, and returns the new data. */
	async update(ops: LinksOp | LinksOp[]): Promise<LinksData> {
		const list = Array.isArray(ops) ? ops : [ops];
		return this.enqueue(async () => {
			const before = await this.readCurrent();
			const after = list.reduce(applyLinkOp, before);
			const text = serializeLinks(after);
			if (text === serializeLinks(before) && (await this.adapter.exists(this.path))) return before;
			const check = parseLinks(text);
			if (!check.ok) throw new Error(`links did not validate: ${check.message}`);
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

	private async readCurrent(): Promise<LinksData> {
		if (!(await this.adapter.exists(this.path))) {
			this.cache = emptyLinks();
			return this.cache;
		}
		const text = await this.adapter.read(this.path);
		const parsed = parseLinks(text);
		if (!parsed.ok) {
			await this.keepCopy(text);
			throw new LinksBlockedError(parsed.message, parsed.reason);
		}
		this.cache = parsed.data;
		return parsed.data;
	}

	/** One copy of an unreadable file, named by its content, so repeated failures do not pile up files. */
	private async keepCopy(text: string): Promise<void> {
		const copy = `${this.folder}/pdf-links.unreadable-${textHash(text)}.json`;
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
