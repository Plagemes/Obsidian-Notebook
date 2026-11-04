/**
 * 0.17 (#23): the optional PDF copy kept next to a notebook (sharing, NotebookLM). Pure logic, no 'obsidian' import (tested in
 * Node): the settings, where the copy goes, which file the plugin may overwrite, the record of what it wrote, the content
 * fingerprint that lets an unchanged notebook skip the work, the follow-the-notebook rules and the timers.
 *
 * DATA SAFETY: the plugin only ever overwrites a PDF it wrote itself. It proves that with a record (path, size, SHA-256 of the
 * bytes it wrote); a file at the path that does not match is the user's, and is never touched: the copy then goes to
 * "<name> (copy 2).pdf" and so on.
 */

/** When the copy is brought up to date. `auto`: after a quiet moment on desktop, only on close or in the background on a phone or tablet. */
export const PDF_COPY_WHEN = ["auto", "idle", "close"] as const;
export type PdfCopyWhen = (typeof PDF_COPY_WHEN)[number];

export interface PdfCopySettings {
	/** Keep a PDF copy of every notebook (a notebook can override it from its menu). Off by default. */
	pdfCopy: boolean;
	/** Vault folder the copies go to; empty: next to each notebook. */
	pdfCopyFolder: string;
	pdfCopyWhen: PdfCopyWhen;
	/** Notebook path -> the copy is on (true) or off (false) for that notebook, whatever `pdfCopy` says. */
	pdfCopyNotebooks: Record<string, boolean>;
}

export const DEFAULT_PDF_COPY_SETTINGS: PdfCopySettings = { pdfCopy: false, pdfCopyFolder: "", pdfCopyWhen: "auto", pdfCopyNotebooks: {} };

/** Most per-notebook overrides remembered. */
export const MAX_PDF_COPY_OVERRIDES = 500;
/** A notebook is saved and left alone this long (ms) before its copy is rebuilt. */
export const PDF_COPY_IDLE_MS = 30_000;
/** Version of the PDF writer's output as far as the copy is concerned: bump it to rebuild every copy once. */
export const PDF_COPY_VERSION = 1;

export function isPdfCopyWhen(v: unknown): v is PdfCopyWhen {
	return typeof v === "string" && (PDF_COPY_WHEN as readonly string[]).includes(v);
}

/** The per-notebook overrides from whatever was stored: bad rows dropped, bounded. */
export function normaliseOverrides(data: unknown): Record<string, boolean> {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
		if (k === "" || k.length > 500 || typeof v !== "boolean") continue;
		if (Object.keys(out).length >= MAX_PDF_COPY_OVERRIDES) break;
		out[k] = v;
	}
	return out;
}

export function readPdfCopySettings(data: Record<string, unknown>): PdfCopySettings {
	const s: PdfCopySettings = { ...DEFAULT_PDF_COPY_SETTINGS, pdfCopyNotebooks: {} };
	if (typeof data.pdfCopy === "boolean") s.pdfCopy = data.pdfCopy;
	if (typeof data.pdfCopyFolder === "string") s.pdfCopyFolder = cleanFolder(data.pdfCopyFolder);
	if (isPdfCopyWhen(data.pdfCopyWhen)) s.pdfCopyWhen = data.pdfCopyWhen;
	s.pdfCopyNotebooks = normaliseOverrides(data.pdfCopyNotebooks);
	return s;
}

/** A vault folder as typed: no leading or trailing slashes, no empty parts, no `..`. */
export function cleanFolder(folder: string): string {
	return folder.split("/").map((p) => p.trim()).filter((p) => p !== "" && p !== "." && p !== "..").join("/");
}

/** The copy is kept for this notebook: its own choice, else the global one. */
export function copyEnabled(s: Pick<PdfCopySettings, "pdfCopy" | "pdfCopyNotebooks">, notebookPath: string): boolean {
	const own = Object.prototype.hasOwnProperty.call(s.pdfCopyNotebooks, notebookPath) ? s.pdfCopyNotebooks[notebookPath] : undefined;
	return own ?? s.pdfCopy;
}

/** The overrides after the notebook's choice became `on` (an override that says what the global setting says is dropped). */
export function withNotebookChoice(s: Pick<PdfCopySettings, "pdfCopy" | "pdfCopyNotebooks">, notebookPath: string, on: boolean): Record<string, boolean> {
	const next = { ...s.pdfCopyNotebooks };
	if (on === s.pdfCopy) delete next[notebookPath];
	else next[notebookPath] = on;
	return normaliseOverrides(next);
}

/** The overrides after a notebook moved (or a folder holding notebooks moved: `from` / `to` are then folder paths). */
export function moveOverrides(overrides: Readonly<Record<string, boolean>>, from: string, to: string): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(overrides)) out[movedPath(k, from, to) ?? k] = v;
	return out;
}

/** `path` after `from` became `to`: itself, or a file inside the folder `from`; null when `path` is elsewhere. */
export function movedPath(path: string, from: string, to: string): string | null {
	if (path === from) return to;
	return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

/** What `pdfCopyWhen` means on this device. */
export function resolveWhen(when: PdfCopyWhen, mobile: boolean): "idle" | "close" {
	if (when === "auto") return mobile ? "close" : "idle";
	return when;
}

// ---------------------------------------------------------------------------------------------------------------- paths

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

function join(dir: string, name: string): string {
	return dir === "" ? name : `${dir}/${name}`;
}

/** Where the copy of a notebook goes first: `<folder or the notebook's folder>/<notebook name>.pdf`. */
export function copyBasePath(notebookPath: string, folder: string): string {
	const dir = cleanFolder(folder);
	return join(dir === "" ? dirOf(notebookPath) : dir, `${baseOf(notebookPath)}.pdf`);
}

/** The n-th choice (n >= 2) when the first is taken: `<name> (copy 2).pdf`. */
export function alternativePath(base: string, n: number): string {
	return base.replace(/\.pdf$/iu, "") + ` (copy ${n}).pdf`;
}

/** Most alternatives tried before giving up. */
export const MAX_ALTERNATIVES = 50;

/** What is at a path: nothing, a file the plugin wrote as this notebook's copy and has not been changed, or somebody else's file. */
export type Occupant = "none" | "ours" | "foreign";

export interface Target {
	path: string;
	/** The file is the plugin's own copy and is replaced; false: a new file. */
	overwrite: boolean;
	/** The preferred name was taken by a file that is not ours, so another name was chosen. */
	diverted: boolean;
}

/**
 * Where to write. The path recorded last time is reused when the file there is still exactly what the plugin wrote; otherwise
 * the first free name among `<name>.pdf`, `<name> (copy 2).pdf`, ... . A file that is not ours is never a target. Null: no free name.
 */
export async function chooseTarget(base: string, recorded: string | null, occupant: (path: string) => Promise<Occupant>): Promise<Target | null> {
	if (recorded !== null && (await occupant(recorded)) === "ours") return { path: recorded, overwrite: true, diverted: recorded !== base };
	let diverted = false;
	for (let n = 1; n <= MAX_ALTERNATIVES; n++) {
		const path = n === 1 ? base : alternativePath(base, n);
		const here = await occupant(path);
		if (here === "none") return { path, overwrite: false, diverted };
		if (here === "ours") return { path, overwrite: true, diverted };
		diverted = true;
	}
	return null;
}

/**
 * The path of the copy after the notebook moved or was renamed from `oldNotebook` to `newNotebook`: same folder as before when a
 * folder is configured, else the notebook's new folder; the name follows the notebook and keeps a " (copy N)" suffix.
 * Null: the copy's name does not look like it came from the notebook, so it is left where it is.
 */
export function renamedCopyPath(oldNotebook: string, newNotebook: string, oldPdf: string, folder: string): string | null {
	const oldName = `${baseOf(oldNotebook)}`;
	const file = oldPdf.slice(oldPdf.lastIndexOf("/") + 1);
	const m = /^(.*?)((?: \(copy \d+\))?)\.pdf$/iu.exec(file);
	if (!m || m[1] !== oldName) return null;
	const dir = cleanFolder(folder) === "" ? dirOf(newNotebook) : dirOf(oldPdf);
	return join(dir, `${baseOf(newNotebook)}${m[2]}.pdf`);
}

// ----------------------------------------------------------------------------------------------------------------- record

/** What the plugin remembers about the copy of one notebook. */
export interface CopyRecord {
	/** The notebook the copy is of (its path when last seen). */
	notebook: string;
	/** Path of the copy. */
	pdf: string;
	/** SHA-256 (hex) and size of the bytes written: the proof that a file at `pdf` is still ours. */
	hash: string;
	size: number;
	/** Fingerprint of the content the copy was built from. */
	fingerprint: string;
	/** When it was written (ms). */
	at: number;
	/** The notebook was deleted: the copy stays where it is and is no longer updated. */
	stopped?: boolean;
	/** Fields this version does not know, kept on rewrite. */
	extra?: Record<string, unknown>;
}

export interface CopiesFile {
	version: 1;
	copies: Record<string, CopyRecord>;
	extra: Record<string, unknown>;
}

export type ParsedCopies = { ok: true; data: CopiesFile } | { ok: false; reason: "json" | "format" | "future"; message: string };

export const COPIES_VERSION = 1;
const RECORD_FIELDS = ["notebook", "pdf", "hash", "size", "fingerprint", "at", "stopped"];

export function emptyCopies(): CopiesFile {
	return { version: COPIES_VERSION, copies: {}, extra: {} };
}

/** Reads the sidecar leniently: unknown fields are kept, rows that make no sense are dropped, a newer version or broken JSON is refused. */
export function parseCopies(text: string): ParsedCopies {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: (e as Error).message };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "format", message: "not an object" };
	const o = raw as Record<string, unknown>;
	if (typeof o.version === "number" && o.version > COPIES_VERSION) return { ok: false, reason: "future", message: `version ${o.version} is newer than this plugin understands` };
	const data = emptyCopies();
	for (const [k, v] of Object.entries(o)) if (k !== "version" && k !== "copies") data.extra[k] = v;
	const rows = typeof o.copies === "object" && o.copies !== null && !Array.isArray(o.copies) ? (o.copies as Record<string, unknown>) : {};
	for (const [key, v] of Object.entries(rows)) {
		const r = readRecord(v);
		if (r && key !== "") data.copies[key] = r;
	}
	return { ok: true, data };
}

function readRecord(v: unknown): CopyRecord | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.notebook !== "string" || typeof o.pdf !== "string" || o.pdf === "") return null;
	if (typeof o.hash !== "string" || !/^[0-9a-f]{64}$/u.test(o.hash)) return null;
	if (typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0) return null;
	if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
	const rec: CopyRecord = { notebook: o.notebook, pdf: o.pdf, hash: o.hash, size: o.size, fingerprint: typeof o.fingerprint === "string" ? o.fingerprint : "", at: o.at };
	if (o.stopped === true) rec.stopped = true;
	const extra = Object.fromEntries(Object.entries(o).filter(([k]) => !RECORD_FIELDS.includes(k)));
	if (Object.keys(extra).length > 0) rec.extra = extra;
	return rec;
}

export function serializeCopies(data: CopiesFile): string {
	const copies: Record<string, unknown> = {};
	for (const [key, r] of Object.entries(data.copies)) {
		copies[key] = { ...(r.extra ?? {}), notebook: r.notebook, pdf: r.pdf, hash: r.hash, size: r.size, fingerprint: r.fingerprint, at: r.at, ...(r.stopped ? { stopped: true } : {}) };
	}
	return JSON.stringify({ ...data.extra, version: COPIES_VERSION, copies }, null, "\t");
}

/** The record of the newest write per notebook over the files of every device. */
export function mergeCopies(files: readonly CopiesFile[]): Record<string, CopyRecord> {
	const out: Record<string, CopyRecord> = {};
	for (const f of files) for (const [k, r] of Object.entries(f.copies)) if (!out[k] || r.at >= out[k].at) out[k] = r;
	return out;
}

/** The file at `pdf` is one the plugin wrote: some record names this path with exactly this size and hash. */
export function isOurs(records: Iterable<CopyRecord>, pdf: string, size: number, hash: string): boolean {
	for (const r of records) if (r.pdf === pdf && r.size === size && r.hash === hash) return true;
	return false;
}

/** The record of a notebook moved from `from` to `to` (and the paths inside it when they are folders). */
export function moveRecords(data: CopiesFile, from: string, to: string): CopiesFile {
	const copies: Record<string, CopyRecord> = {};
	for (const [k, r] of Object.entries(data.copies)) {
		const moved = movedPath(k, from, to);
		copies[moved ?? k] = moved === null ? r : { ...r, notebook: moved };
	}
	return { ...data, copies };
}

/** The records after the copy file itself was moved by someone else (`from` -> `to`). */
export function moveCopyFile(data: CopiesFile, from: string, to: string): CopiesFile {
	const copies: Record<string, CopyRecord> = {};
	for (const [k, r] of Object.entries(data.copies)) {
		const moved = movedPath(r.pdf, from, to);
		copies[k] = moved === null ? r : { ...r, pdf: moved };
	}
	return { ...data, copies };
}

/** The record with its notebook marked deleted (no change when there is none). */
export function stopRecord(data: CopiesFile, notebook: string): CopiesFile {
	const r = data.copies[notebook];
	if (!r || r.stopped) return data;
	return { ...data, copies: { ...data.copies, [notebook]: { ...r, stopped: true } } };
}

// ----------------------------------------------------------------------------------------------------------- fingerprint

/** What besides the pages shapes the PDF. */
export interface FingerprintExtras {
	title: string;
	/** JSON of the page headers the export draws. */
	headers: string;
	pageCount: number;
}

/** The text hashed for one page. */
export function pageText(page: unknown): string {
	return JSON.stringify(page);
}

/** The text hashed to make the fingerprint from the hash of each page. */
export function fingerprintText(pageHashes: readonly string[], extras: FingerprintExtras): string {
	return JSON.stringify({ v: PDF_COPY_VERSION, title: extras.title, headers: extras.headers, n: extras.pageCount, pages: pageHashes });
}

/** The bytes look like a complete PDF of this writer (header and end-of-file marker): a cheap check before anything is replaced. */
export function looksLikePdf(bytes: Uint8Array): boolean {
	if (bytes.length < 32) return false;
	const head = String.fromCharCode(...bytes.subarray(0, 5));
	const tail = String.fromCharCode(...bytes.subarray(bytes.length - 6));
	return head === "%PDF-" && tail.trimEnd().endsWith("%%EOF");
}

// -------------------------------------------------------------------------------------------------------------- status

export type CopyStatus =
	| { kind: "updated"; at: number }
	| { kind: "stopped"; at: number }
	| { kind: "waiting" }
	| { kind: "failed"; message: string }
	| { kind: "off" };

/** `hh:mm` on a 24 hour clock, local time. */
export function clockText(at: number): string {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** What the notebook menu says about the copy. */
export function statusOf(enabled: boolean, record: CopyRecord | undefined, failure: string | null): CopyStatus {
	if (failure !== null && enabled) return { kind: "failed", message: failure };
	if (record?.stopped) return { kind: "stopped", at: record.at };
	if (!enabled) return { kind: "off" };
	return record ? { kind: "updated", at: record.at } : { kind: "waiting" };
}

// ------------------------------------------------------------------------------------------------------------- timers

export interface TimerApi {
	set(fn: () => void, ms: number): number;
	clear(handle: number): void;
}

/** One pending timer per key (a notebook path): scheduling again restarts it. */
export class KeyedTimers {
	private readonly pending = new Map<string, number>();

	constructor(private readonly timers: TimerApi) {}

	schedule(key: string, ms: number, fn: () => void): void {
		this.cancel(key);
		this.pending.set(key, this.timers.set(() => {
			this.pending.delete(key);
			fn();
		}, ms));
	}

	cancel(key: string): void {
		const h = this.pending.get(key);
		if (h === undefined) return;
		this.timers.clear(h);
		this.pending.delete(key);
	}

	/** A timer is pending for the key. */
	has(key: string): boolean {
		return this.pending.has(key);
	}

	clearAll(): void {
		for (const h of this.pending.values()) this.timers.clear(h);
		this.pending.clear();
	}
}
