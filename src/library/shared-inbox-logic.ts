/**
 * 0.16 (roadmap #177): the shared-files inbox, decided from plain data. Pure: no 'obsidian', no DOM.
 *
 * On Android, sharing a PDF or an image to Obsidian saves it in the vault (the attachments location); the plugin cannot
 * register a share target of its own. This module decides which files in the chosen folder count as "received": PDFs and
 * images that sit directly in the folder, were not written by the plugin (assets, `_meta`, `_trash`, templates, exports)
 * and were not dismissed. The queue is kept in memory from `create` / `delete` / `rename` events and a scan of the folder.
 */
import { kindFromName } from "../pdf/assets";
import { isPluginPictureName } from "../storage/plugin-written";
import { isHiddenNotebookPath } from "../storage/trash-paths";

/** Most dismissals remembered on this device (the oldest are forgotten first). */
export const MAX_DISMISSED = 300;
/** Most received files listed; a folder with more shows the newest ones. */
export const MAX_ITEMS = 100;
/** Local storage key of the dismissals. */
export const DISMISSED_KEY = "notebook-shared-inbox-dismissed";
/** Local storage key of the time the inbox started watching each folder on this device. */
export const SINCE_KEY = "notebook-shared-inbox-since";
/** Folders remembered in the "since" record. */
export const MAX_SINCE = 8;

export type InboxKind = "pdf" | "image";

export interface InboxItem {
	path: string;
	name: string;
	kind: InboxKind;
	/** Bytes. */
	size: number;
	/** Creation time (ms); falls back to the modification time. */
	at: number;
}

/** What the filter knows about the vault. */
export interface InboxContext {
	/** Resolved inbox folder ("" = the vault root). */
	folder: string;
	/** Notebooks folder and the two template settings (to tell the plugin's own files). */
	notebooksFolder: string;
	templatesFolder: string;
	notebookTemplatesFolder: string;
	/** Lowercase base names of the notebooks sitting in the same folder (a PDF with the name of a notebook is its export). */
	siblingNotebooks?: ReadonlySet<string>;
	/** Lowercase paths the plugin wrote recently outside `_assets` (digest pictures, exports): never offered (storage/plugin-written.ts). */
	pluginWritten?: ReadonlySet<string>;
}

/** Forward slashes, no leading or trailing slash. */
export function cleanPath(p: string): string {
	return p.replace(/\\/g, "/").split("/").filter((s) => s.length > 0 && s !== ".").join("/");
}

/** Folder part of a vault path ("" at the root). */
export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The inbox folder from the setting and Obsidian's attachments setting. The setting wins; empty follows Obsidian:
 * `/` or nothing is the vault root, a plain path is that folder. "Same folder as the note" (`./`, `./sub`) has no fixed
 * place, so there is no inbox until a folder is chosen: null.
 */
export function resolveInboxFolder(setting: string, attachmentSetting: unknown): string | null {
	const typed = setting.trim();
	const chosen = cleanPath(typed);
	if (chosen !== "") return chosen.split("/").includes("..") ? null : chosen;
	if (typed !== "") return ""; // "/" typed: the vault root
	if (typeof attachmentSetting !== "string") return "";
	const a = attachmentSetting.trim();
	if (a === "" || a === "/") return "";
	if (a === "." || a.startsWith("./")) return null;
	const clean = cleanPath(a);
	return clean.split("/").includes("..") ? null : clean;
}

/** PDF or image (PNG, JPEG, GIF, WebP) by extension; anything else (HEIC, Office files...) is not offered. */
export function inboxKind(name: string): InboxKind | null {
	return kindFromName(name);
}

/** The path segments below `folder`, or null when `path` is not inside it. */
function below(path: string, folder: string): string[] | null {
	if (folder === "") return path.split("/");
	return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1).split("/") : null;
}

/** Whether a file in the vault is a received file: a PDF or image directly in the folder that the plugin did not write. */
export function isInboxCandidate(path: string, ctx: InboxContext): boolean {
	const rel = below(path, ctx.folder);
	if (!rel || rel.length !== 1) return false;
	const name = rel[0]!;
	if (name.startsWith(".") || !inboxKind(name)) return false;
	// Reserved folders of the library (assets, _meta, _trash, backups) and the templates folders.
	if (isHiddenNotebookPath(path, ctx.notebooksFolder, ctx.templatesFolder, ctx.notebookTemplatesFolder)) return false;
	// What the plugin itself wrote in this folder (a digest crop, an exported page picture or PDF): by its record and by its name.
	if (isPluginPictureName(name) || ctx.pluginWritten?.has(path.toLowerCase())) return false;
	// A `_` folder is the plugin's (or the user's) own storage, never a drop place.
	if (ctx.folder.split("/").some((s) => s.startsWith("_"))) return false;
	// An exported PDF is named after its notebook ("Maths.pdf", "Maths 2.pdf") and sits next to it.
	if (ctx.siblingNotebooks && ctx.siblingNotebooks.size > 0) {
		const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
		if (ctx.siblingNotebooks.has(stem) || ctx.siblingNotebooks.has(stem.replace(/ \d+$/, ""))) return false;
	}
	return true;
}

// ------------------------------------------------------------------------------------------------------ dismissals

/** A dismissal is tied to the path and the creation time, so a new file that gets the same name is offered again. */
export function dismissKey(item: Pick<InboxItem, "path" | "at">): string {
	return `${item.path}|${Math.round(item.at)}`;
}

/** Whatever was stored, as a valid, bounded list of keys (newest last). Anything else gives an empty list. */
export function normaliseDismissed(data: unknown): string[] {
	if (!Array.isArray(data)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of data) {
		if (typeof v !== "string" || v === "" || v.length > 400 || seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out.slice(-MAX_DISMISSED);
}

/** The list after dismissing `key` (a new array, bounded). */
export function addDismissed(list: readonly string[], key: string): string[] {
	return normaliseDismissed([...list.filter((k) => k !== key), key]);
}

/** Forgets the dismissals of files that are gone, so the list does not fill with dead keys. */
export function pruneDismissed(list: readonly string[], present: readonly InboxItem[]): string[] {
	const alive = new Set(present.map(dismissKey));
	return list.filter((k) => alive.has(k));
}

// ------------------------------------------------------------------------------------------------------ since

export type SinceMap = Readonly<Record<string, number>>;

/** Whatever was stored, as a valid, bounded folder -> time map. */
export function normaliseSince(data: unknown): SinceMap {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows = Object.entries(data as Record<string, unknown>)
		.filter(([k, v]) => k.length <= 300 && typeof v === "number" && Number.isFinite(v) && v > 0)
		.map(([k, v]) => [k, v as number] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_SINCE);
	return Object.fromEntries(rows);
}

/**
 * The time from which a scan offers files in `folder`: files that were already there when the inbox first watched the
 * folder on this device (a vault with PDFs in its root, say) are not offered; files that arrive later are. Returns the
 * time and the map to store (changed only the first time).
 */
export function sinceFor(map: SinceMap, folder: string, now: number): { since: number; map: SinceMap } {
	const known = map[folder];
	if (known !== undefined) return { since: known, map };
	return { since: now, map: normaliseSince({ ...map, [folder]: now }) };
}

/**
 * Whether a file belongs to what the inbox offers given the time it started watching its folder: a file created before that was
 * already there (or arrived with a sync of old files) and is not offered. Used by the scan and by the `create` events alike.
 */
export function isNewSince(item: Pick<InboxItem, "at">, since: number): boolean {
	return item.at >= since;
}

// ------------------------------------------------------------------------------------------------------ the queue

/**
 * The files received and not yet dealt with, newest first. Fed with the files of the folder (a scan) and with the vault's
 * events; a dismissed file stays in the vault and is only hidden.
 */
export class InboxQueue {
	private readonly files = new Map<string, InboxItem>();
	private dismissed: string[];

	constructor(dismissed: readonly string[] = []) {
		this.dismissed = normaliseDismissed(dismissed);
	}

	/** Replaces everything with the files of a scan. Returns true when the visible list changed. */
	reset(items: readonly InboxItem[]): boolean {
		const before = this.signature();
		this.files.clear();
		for (const it of items) this.files.set(it.path, it);
		return before !== this.signature();
	}

	add(item: InboxItem): boolean {
		const before = this.signature();
		this.files.set(item.path, item);
		return before !== this.signature();
	}

	remove(path: string): boolean {
		const before = this.signature();
		this.files.delete(path);
		return before !== this.signature();
	}

	/** A file renamed or moved: follows it when it stays a candidate (`next`), else drops it. */
	rename(oldPath: string, next: InboxItem | null): boolean {
		const before = this.signature();
		this.files.delete(oldPath);
		if (next) this.files.set(next.path, next);
		return before !== this.signature();
	}

	/** Hides the item; returns the list to store. */
	dismiss(item: Pick<InboxItem, "path" | "at">): string[] {
		this.dismissed = addDismissed(this.dismissed, dismissKey(item));
		return [...this.dismissed];
	}

	dismissedKeys(): string[] {
		return [...this.dismissed];
	}

	/** Forgets dismissals of files that are no longer in the folder; returns the list to store. */
	prune(): string[] {
		this.dismissed = pruneDismissed(this.dismissed, [...this.files.values()]);
		return [...this.dismissed];
	}

	/** Visible items: not dismissed, newest first (ties by name), at most MAX_ITEMS. */
	list(): InboxItem[] {
		const hidden = new Set(this.dismissed);
		return [...this.files.values()]
			.filter((it) => !hidden.has(dismissKey(it)))
			.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
			.slice(0, MAX_ITEMS);
	}

	count(): number {
		return this.list().length;
	}

	private signature(): string {
		return this.list().map((i) => `${i.path}|${i.at}|${i.size}`).join("\n");
	}
}

// ------------------------------------------------------------------------------------------------------ names

/** Notebook name for a received file: its name without the extension, tidied. */
export function notebookNameFor(fileName: string): string {
	const base = baseName(fileName).replace(/\.[^.]+$/, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
	return base || "Shared file";
}

/** Names of notes for a message: at most `max` file names (no folder, no `.md`), then the number left out. */
export function noteNames(paths: readonly string[], max = 4): { names: string[]; more: number } {
	const names = paths.slice(0, max).map((p) => baseName(p).replace(/\.md$/iu, ""));
	return { names, more: Math.max(0, paths.length - names.length) };
}

/** "1.4 MB", "320 KB". */
export function sizeLabel(bytes: number): string {
	if (!(bytes > 0)) return "";
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
