import { applyLinkOp, emptyLinks, parseLinks, serializeLinks, type LinksData, type LinksOp } from "../pdf/sync-links";

/** The file operations the store uses (vault-backed at runtime, see `vaultLinkFileAdapter`); testable without Obsidian. */
export interface LinkFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export const LINKS_FILE = "pdf-links.json";
/** Reserved folder of the notebooks folder that holds the links file (`<notebooks folder>/_meta/pdf-links.json`). */
export const META_DIRNAME = "_meta";

/** Folder of the links file for a notebooks folder ("" = vault root). */
export function linksFolder(notebooksFolder: string): string {
	const root = notebooksFolder.replace(/^\/+|\/+$/g, "");
	return root ? `${root}/${META_DIRNAME}` : META_DIRNAME;
}

/** Where 0.6 previews kept the file (`<config dir>/plugins/<id>/pdf-links.json`): read once to move it, never written. */
export interface LegacyLinksFile {
	adapter: Pick<LinkFileAdapter, "exists" | "read">;
	path: string;
}

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
 * Sidecar of the PDF links (`<notebooks folder>/_meta/pdf-links.json`, a vault file, so it syncs with the notebooks).
 * Written only by `update`, which is called by explicit link actions. Every update reads the file again first (another
 * device may have synced a newer one) and applies the operation to that, serialises, re-validates the text and writes
 * only if it differs. A file that cannot be parsed is never overwritten; a copy of it is kept next to it once.
 * When the file does not exist yet, the file of the old location (`legacy`) is copied over if it can be read; the old
 * file itself is left as it is.
 */
export class PdfLinkStore {
	private cache: LinksData = emptyLinks();
	private queue: Promise<unknown> = Promise.resolve();

	private readonly folderOf: () => string;

	constructor(private readonly adapter: LinkFileAdapter, folder: string | (() => string), private readonly legacy: LegacyLinksFile | null = null) {
		this.folderOf = typeof folder === "string" ? () => folder : folder;
	}

	private get folder(): string {
		return this.folderOf();
	}

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
			this.cache = (await this.migrateLegacy()) ?? emptyLinks();
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

	/**
	 * Copies the old file to the new place (re-validated; the new file then exists, so this runs once). An unreadable
	 * old file is not used: a copy of it is kept next to the new file and the old one stays untouched.
	 */
	private async migrateLegacy(): Promise<LinksData | null> {
		const legacy = this.legacy;
		if (!legacy) return null;
		let text: string;
		try {
			if (!(await legacy.adapter.exists(legacy.path))) return null;
			text = await legacy.adapter.read(legacy.path);
		} catch (e) {
			console.warn("[notebook] old PDF links file not read", e);
			return null;
		}
		const parsed = parseLinks(text);
		if (!parsed.ok) {
			await this.ensureFolder().catch(() => undefined);
			await this.keepCopy(text);
			return null;
		}
		const out = serializeLinks(parsed.data);
		if (!parseLinks(out).ok) return null;
		await this.ensureFolder();
		await this.adapter.write(this.path, out);
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
