/**
 * Bulk import (0.16, roadmap #80): the planning rules, kept pure (no 'obsidian', no DOM) so they are tested in Node.
 * Which dropped files can become notebooks and why the others cannot, the names the notebooks get (editable, never
 * clashing with an existing notebook or with each other), and how images are grouped ("one notebook per file" or "all
 * images into one notebook"). The dialog (bulk-import-dialog.ts) shows this plan; the runner (bulk-import-run.ts) does it.
 */
import { MAX_IMAGE_BYTES } from "../integration/api-plan";
import { sniffImage } from "../scan/image-bytes";
import { hasTrailingDotOrSpace, isDeviceName, sanitizeName } from "../storage/names";

export type BulkKind = "pdf" | "image";

/** Why a file is left out. The dialog and the summary show a sentence for each. */
export type SkipReason = "unsupported" | "empty" | "heic" | "corrupt" | "tooBig" | "duplicate" | "unreadable";

/** A file offered to the import, wherever it comes from (a drop, the file picker). Its bytes are read only when needed. */
export interface BulkSource {
	name: string;
	size: number;
	/** MIME type when the platform knows it (may be empty on Android content URIs). */
	type: string;
	/** The first bytes (for a quick check), or null when they cannot be read. */
	head(): Promise<Uint8Array | null>;
	/** The whole file. */
	read(): Promise<ArrayBuffer>;
	/** A quick fingerprint of the first and last 64 KB (see `fingerprintOf`), or null when they cannot be read. Optional. */
	fingerprint?(): Promise<string | null>;
}

/** One file of the dialog's list: what it is and, if it cannot be imported, why. */
export interface BulkEntry {
	id: number;
	fileName: string;
	size: number;
	kind: BulkKind | null;
	skip: SkipReason | null;
}

/** Largest PDF taken: a bigger one risks the Android WebView running out of memory (it is read whole, then hashed). */
export const MAX_BULK_PDF_BYTES = 100 * 1024 * 1024;
/** Largest image taken: the limit of the plugin API and of the shared-files inbox (one decode on a canvas). */
export const MAX_BULK_IMAGE_BYTES = MAX_IMAGE_BYTES;

/** The size limit of a kind of file, in bytes. */
export function bulkLimit(kind: BulkKind): number {
	return kind === "pdf" ? MAX_BULK_PDF_BYTES : MAX_BULK_IMAGE_BYTES;
}

/** The size limit of a kind of file, in whole MB, for the message ("Larger than 100 MB"). */
export function bulkLimitMb(kind: BulkKind): number {
	return Math.round(bulkLimit(kind) / (1024 * 1024));
}
/** Longest notebook name, in characters (as the creation dialog). */
export const MAX_BULK_NAME = 120;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

/** The extension of a file name, lower case, without the dot ("" when there is none). */
export function extensionOf(fileName: string): string {
	const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
	const dot = base.lastIndexOf(".");
	return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** The file name without any folder part and without its extension. */
export function stemOf(fileName: string): string {
	const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
	const ext = extensionOf(base);
	return (ext === "" ? base : base.slice(0, base.length - ext.length - 1)).trim();
}

/** What a file claims to be from its name and MIME type alone. */
export function kindFromNameAndType(fileName: string, type: string): BulkKind | "heic" | null {
	const ext = extensionOf(fileName);
	if (ext === "pdf") return "pdf";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (HEIC_EXTENSIONS.has(ext)) return "heic";
	const mime = type.toLowerCase();
	if (mime === "application/pdf") return "pdf";
	if (mime === "image/heic" || mime === "image/heif") return "heic";
	if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) return "image";
	return null;
}

function hasPdfMarker(head: Uint8Array): boolean {
	// A PDF starts with "%PDF-"; readers accept it anywhere in the first kilobyte.
	const limit = Math.min(head.length, 1024) - 4;
	for (let i = 0; i < limit; i++) {
		if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return true;
	}
	return false;
}

/**
 * Whether a file can become a notebook: by its name and type first, then (when the first bytes could be read) by what it
 * really is, so a renamed or truncated file is left out with a reason instead of failing in the middle of the run.
 */
export function classifyFile(fileName: string, size: number, type: string, head: Uint8Array | null): { kind: BulkKind | null; skip: SkipReason | null } {
	const claimed = kindFromNameAndType(fileName, type);
	if (claimed === null) return { kind: null, skip: "unsupported" };
	if (claimed === "heic") return { kind: null, skip: "heic" };
	if (size <= 0) return { kind: claimed, skip: "empty" };
	if (size > bulkLimit(claimed)) return { kind: claimed, skip: "tooBig" };
	if (head === null || head.length === 0) return { kind: claimed, skip: null };
	if (claimed === "pdf") return hasPdfMarker(head) ? { kind: "pdf", skip: null } : { kind: "pdf", skip: "corrupt" };
	const sniffed = sniffImage(head);
	if (sniffed === "heic") return { kind: "image", skip: "heic" };
	if (sniffed === "jpeg" || sniffed === "png" || sniffed === "gif" || sniffed === "webp") return { kind: "image", skip: null };
	return { kind: "image", skip: "corrupt" };
}

/** Bytes read from each end of a file for its quick fingerprint. */
export const FINGERPRINT_BYTES = 64 * 1024;

/**
 * A quick fingerprint of a file from its first and last 64 KB (FNV-1a over both, two independent 32-bit lanes): two files with
 * the same name and size but different content do not get the same one. Not a security hash; it only tells copies apart.
 */
export function fingerprintOf(head: Uint8Array, tail: Uint8Array, size: number): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ size;
	for (const part of [head, tail]) {
		for (let i = 0; i < part.length; i++) {
			a = Math.imul(a ^ part[i]!, 0x01000193) >>> 0;
			b = Math.imul(b + part[i]! + 1, 0x85ebca6b) >>> 0;
			b ^= b >>> 13;
		}
		a = Math.imul(a ^ 0xff, 0x01000193) >>> 0; // a boundary between the two parts
	}
	return `${size}-${a.toString(16)}-${(b >>> 0).toString(16)}`;
}

/**
 * Builds the list entries for dropped files. Two files with the same name and size count once (a double drop) unless their
 * fingerprints (`fingerprint`, read only for such pairs) differ: then they are two different files that share a name.
 */
export function buildEntries(files: ReadonlyArray<{ name: string; size: number; type: string; head: Uint8Array | null; fingerprint?: string | null }>): BulkEntry[] {
	const seen = new Set<string>();
	return files.map((f, id) => {
		const verdict = classifyFile(f.name, f.size, f.type, f.head);
		const key = `${f.name.toLowerCase()}|${f.size}|${f.fingerprint ?? ""}`;
		const duplicate = verdict.skip === null && seen.has(key);
		if (verdict.skip === null) seen.add(key);
		return { id, fileName: f.name, size: f.size, kind: verdict.kind, skip: duplicate ? "duplicate" : verdict.skip };
	});
}

/** Numeric-aware, case-insensitive order of file names ("page 2" before "page 10"): the order of a group of photos. */
export function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** A name a notebook file can have on every platform: the creation dialog's sanitising, plus the rules of Windows. */
export function safeNotebookName(raw: string, fallback: string): string {
	let name = sanitizeName(raw).replace(/[. ]+$/, "");
	if (name === "") name = fallback;
	if (isDeviceName(name) || hasTrailingDotOrSpace(name)) name = `${name} file`;
	if (name.length > MAX_BULK_NAME) name = name.slice(0, MAX_BULK_NAME).trim();
	return name;
}

/**
 * `name`, or `name 2`, `name 3`… the first one that is not taken. `taken` answers for the names already in the folder (any
 * case: the check is the caller's), `used` holds the names of the notebooks planned before this one (compared ignoring case).
 */
export function uniqueName(name: string, taken: (clean: string) => boolean, used: ReadonlySet<string>): string {
	const free = (n: string) => !taken(n) && !used.has(n.toLowerCase());
	if (free(name)) return name;
	for (let i = 2; i < 10_000; i++) {
		const candidate = `${name} ${i}`;
		if (free(candidate)) return candidate;
	}
	return `${name} ${Date.now()}`;
}

export type BulkMode = "per-file" | "images-together";

/** One notebook of the plan. */
export interface PlanItem {
	/** Stable id for the name the user typed: `f<id>` for a file, `images` for the group of images. */
	key: string;
	kind: BulkKind;
	/** Entry ids that become this notebook, in page order (a PDF or one image: one id; the image group: all images). */
	entries: number[];
	/** What the user typed, trimmed ("" when they did not change it). */
	typed: string;
	/** The name before uniqueness: typed, else the file name, else the fallback. */
	wanted: string;
	/** The name the notebook will really get. Differs from `wanted` when that name is taken. */
	name: string;
}

export interface PlanOptions {
	mode: BulkMode;
	/** Names the user typed, by plan key. */
	typed: Readonly<Record<string, string>>;
	/** The default name of the group of images. */
	groupName: string;
	/** Fallback names for a file without a usable name. */
	fallbackPdf: string;
	fallbackImage: string;
	/** Whether a notebook with this name is already in the target folder (ignoring case). */
	taken: (clean: string) => boolean;
}

/**
 * The notebooks the import will make. Skipped entries make none. In `per-file` mode every file is a notebook; in
 * `images-together` mode every PDF is still a notebook and all the images become one, their pages in natural file-name order.
 * Names are made unique against the folder and against each other, in list order.
 */
export function planNotebooks(entries: readonly BulkEntry[], o: PlanOptions): PlanItem[] {
	const ok = entries.filter((e) => e.skip === null && e.kind !== null);
	const images = ok.filter((e) => e.kind === "image");
	const grouped = o.mode === "images-together" && images.length > 0;
	const used = new Set<string>();
	const items: PlanItem[] = [];
	const add = (key: string, kind: BulkKind, ids: number[], derived: string, fallback: string) => {
		const typed = (o.typed[key] ?? "").trim();
		const wanted = safeNotebookName(typed !== "" ? typed : derived, fallback);
		const name = uniqueName(wanted, o.taken, used);
		used.add(name.toLowerCase());
		items.push({ key, kind, entries: ids, typed, wanted, name });
	};
	let groupAdded = false;
	for (const e of ok) {
		if (e.kind === "pdf") add(`f${e.id}`, "pdf", [e.id], stemOf(e.fileName), o.fallbackPdf);
		else if (grouped) {
			// The group takes the place of its first image in the list.
			if (groupAdded) continue;
			groupAdded = true;
			const ordered = [...images].sort((a, b) => naturalCompare(a.fileName, b.fileName)).map((i) => i.id);
			add("images", "image", ordered, o.groupName, o.fallbackImage);
		} else add(`f${e.id}`, "image", [e.id], stemOf(e.fileName), o.fallbackImage);
	}
	return items;
}

/** How many files will be left out, by reason. */
export function skipCounts(entries: readonly BulkEntry[]): Map<SkipReason, number> {
	const out = new Map<SkipReason, number>();
	for (const e of entries) if (e.skip !== null) out.set(e.skip, (out.get(e.skip) ?? 0) + 1);
	return out;
}

/** What happened to one notebook of the run. */
export interface BulkOutcome {
	key: string;
	name: string;
	/** Vault path of the notebook, when it was made. */
	path: string | null;
	pages: number;
	/** Files of this notebook that were left out during the run, with the reason. */
	skipped: Array<{ file: string; reason: SkipReason; detail?: string }>;
	/** Why the notebook was not made, when it was not. */
	failed: string | null;
	/** True when the run was cancelled before every image of the group was added. */
	partial: boolean;
}

export interface BulkSummary {
	created: number;
	pages: number;
	/** Notebooks that could not be made. */
	failed: number;
	/** Files left out, before and during the run. */
	skipped: number;
	/** Not tried because the run was cancelled. */
	notStarted: number;
	cancelled: boolean;
	/** The notebook "Open" goes to: the first one made. */
	first: string | null;
}

/** The totals the final summary shows. `listSkipped`: the files left out before the run (the dialog's list). */
export function summarize(outcomes: readonly BulkOutcome[], listSkipped: number, notStarted: number, cancelled: boolean): BulkSummary {
	let created = 0;
	let pages = 0;
	let failed = 0;
	let skipped = listSkipped;
	let first: string | null = null;
	for (const o of outcomes) {
		skipped += o.skipped.length;
		if (o.path !== null) {
			created++;
			pages += o.pages;
			first ??= o.path;
		} else if (o.skipped.length === 0) failed++;
	}
	return { created, pages, failed, skipped, notStarted, cancelled, first };
}

/** A file size for the list: "812 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
	if (!(bytes > 0)) return "0 KB";
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
