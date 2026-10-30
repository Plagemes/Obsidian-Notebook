/**
 * Page ids given out by "Move to notebook…" (library/page-move.ts). A moved page keeps its id, so a stable link
 * (`#p3&id=X`) can follow it to its new notebook ("Update links to notebook pages"). Only when the target already has a
 * page with that id (a copy of the notebook, a page moved there before) does the moved page get a new id; that old → new
 * pair is recorded here so that "Update links" still finds the page.
 *
 * One file per device, `<notebooks folder>/_meta/page-moves-<device>.json` (storage/device-files.ts): a device only writes
 * its own file, reading merges them all. A file that cannot be read (or is empty) is never overwritten: a copy is kept and
 * the record is refused. Reading never writes. No 'obsidian' import.
 */
import { linksFolder } from "./pdf-links-store";
import {
	deviceFileName, EMPTY_FILE_MESSAGE, ensureFolderPath, keepUnreadableCopy, listDeviceFiles, type DeviceFileAdapter,
} from "./device-files";

export const PAGE_MOVES_FORMAT = "obsidian-notebook-page-moves";
export const PAGE_MOVES_VERSION = 1;
export const PAGE_MOVES_PREFIX = "page-moves";

export interface PageIdMove {
	/** The page id before the move (the one links name). */
	from: string;
	/** The id the page has in the target. */
	to: string;
	/** Document id of the target notebook. */
	doc: string;
	/** When it was moved (ISO time). */
	at: string;
}

export interface PageMovesFile {
	moves: PageIdMove[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type PageMovesParse =
	| { ok: true; data: PageMovesFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readMove(v: unknown): PageIdMove | null {
	if (!isObject(v)) return null;
	const { from, to, doc, at } = v;
	if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "" || from === to) return null;
	if (typeof doc !== "string" || doc === "" || typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
	return { from, to, doc, at };
}

/** Reads a device file. An empty one is not "no moves": it may not be downloaded yet. */
export function parsePageMoves(text: string): PageMovesParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_FILE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== PAGE_MOVES_FORMAT || !Array.isArray(raw.moves)) return { ok: false, reason: "format", message: "not a page moves file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > PAGE_MOVES_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	const moves: PageIdMove[] = [];
	const unknown: unknown[] = [];
	for (const v of raw.moves) {
		const m = readMove(v);
		if (m) moves.push(m);
		else unknown.push(v);
	}
	return { ok: true, data: { moves, unknown } };
}

function byTime(a: PageIdMove, b: PageIdMove): number {
	return a.at.localeCompare(b.at) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}

export function serializePageMoves(data: PageMovesFile): string {
	const head = `{"format":${JSON.stringify(PAGE_MOVES_FORMAT)},"version":${PAGE_MOVES_VERSION},"moves":[`;
	const lines = [...[...data.moves].sort(byTime).map((m) => JSON.stringify({ from: m.from, to: m.to, doc: m.doc, at: m.at })), ...data.unknown.map((u) => JSON.stringify(u))];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** Every device's moves together: for each old id, the new ids in the order they were given. */
export function mergePageMoves(files: readonly PageMovesFile[]): Map<string, string[]> {
	const all = files.flatMap((f) => f.moves).sort(byTime);
	const out = new Map<string, string[]>();
	for (const m of all) {
		const list = out.get(m.from) ?? [];
		if (!list.includes(m.to)) list.push(m.to);
		out.set(m.from, list);
	}
	return out;
}

export class PageMovesBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future" | "empty") {
		super(message);
		this.name = "PageMovesBlockedError";
	}
}

export class PageMoveStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly adapter: DeviceFileAdapter, private readonly notebooksFolder: () => string, readonly device: string) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	get ownPath(): string {
		return `${this.folder}/${deviceFileName(PAGE_MOVES_PREFIX, this.device)}`;
	}

	/** Adds moves to this device's file (read again first). Refuses with `PageMovesBlockedError` when it cannot be read. */
	record(moves: readonly PageIdMove[]): Promise<void> {
		return this.enqueue(async () => {
			if (moves.length === 0) return;
			let before: PageMovesFile = { moves: [], unknown: [] };
			if (await this.adapter.exists(this.ownPath)) {
				const text = await this.adapter.read(this.ownPath);
				const parsed = parsePageMoves(text);
				if (!parsed.ok) {
					await keepUnreadableCopy(this.adapter, this.folder, PAGE_MOVES_PREFIX, text);
					throw new PageMovesBlockedError(parsed.message, parsed.reason);
				}
				before = parsed.data;
			}
			const known = new Set(before.moves.map((m) => `${m.from}>${m.to}`));
			const after = { ...before, moves: [...before.moves, ...moves.filter((m) => !known.has(`${m.from}>${m.to}`))] };
			const text = serializePageMoves(after);
			const check = parsePageMoves(text);
			if (!check.ok) throw new Error(`page moves did not validate: ${check.message}`);
			await ensureFolderPath(this.adapter, this.folder);
			await this.adapter.write(this.ownPath, text);
		});
	}

	/** Every device's moves merged (files that cannot be read are skipped). Nothing is written. */
	load(): Promise<Map<string, string[]>> {
		return this.enqueue(async () => {
			const files: PageMovesFile[] = [];
			for (const { path } of await listDeviceFiles(this.adapter, this.folder, PAGE_MOVES_PREFIX)) {
				try {
					const parsed = parsePageMoves(await this.adapter.read(path));
					if (parsed.ok) files.push(parsed.data);
				} catch {
					/* skipped: looking never writes */
				}
			}
			return mergePageMoves(files);
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}
}
