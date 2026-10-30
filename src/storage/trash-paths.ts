/**
 * Layout, metadata and naming rules of the plugin trash (roadmap #160, #26). Pure: no 'obsidian'.
 *
 * Everything lives in `<notebooks folder>/_trash/`:
 *
 *   _trash/items/<id>/meta.json          where the item came from, and when it was deleted
 *   _trash/items/<id>/<original name>    the notebook file, or the folder with everything in it
 *   _trash/pages/<notebook id>/<entry id>.json   one deleted page of a notebook, written once (see model/page-trash.ts)
 *   _trash/pages/<notebook id>.json      first layout: every deleted page of a notebook in one file (read, then moved over)
 *
 * Every trashed item gets a folder of its own, so two items with the same name never meet, a trashed
 * notebook is never a sibling of another notebook (conflicted-copy detection finds nothing to compare)
 * and nothing is renamed on the way in: the item comes back exactly as it left.
 */
import { isReservedPath } from "../library/folders";

export const TRASH_DIRNAME = "_trash";
export const TEMPLATES_DIRNAME = "_templates";
const ITEMS = "items";
const PAGES = "pages";

/** The trash folder or one of its subfolders, whatever the notebooks folder is. */
const IN_TRASH = new RegExp(`(^|/)${TRASH_DIRNAME}/(${ITEMS}|${PAGES})(/|$)`);

const join = (...parts: string[]) => parts.filter((p) => p.length > 0).join("/");

export function isInTrash(path: string): boolean {
	return IN_TRASH.test(path);
}

export function trashFolder(root: string): string {
	return join(root, TRASH_DIRNAME);
}
export function trashItemsFolder(root: string): string {
	return join(trashFolder(root), ITEMS);
}
export function trashItemFolder(root: string, id: string): string {
	return join(trashItemsFolder(root), id);
}
export function trashItemPath(root: string, id: string, name: string): string {
	return join(trashItemFolder(root, id), name);
}
export function trashMetaPath(root: string, id: string): string {
	return join(trashItemFolder(root, id), "meta.json");
}
export function pageTrashFolder(root: string): string {
	return join(trashFolder(root), PAGES);
}
/** First layout (0.6 previews): one file with every entry of a notebook. Only read now, then moved over. */
export function pageTrashPath(root: string, notebookId: string): string {
	return join(pageTrashFolder(root), `${notebookId}.json`);
}
/** An id as a file name: as it is when it is a plain one (generated ids are), else encoded (only hand-edited files). */
function idFileName(id: string): string {
	if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) return id;
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
	return `x-${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${(h >>> 0).toString(16)}`;
}
/** Folder of a notebook's page trash entries (current layout). */
export function pageTrashEntriesFolder(root: string, notebookId: string): string {
	return join(pageTrashFolder(root), idFileName(notebookId));
}
/** File of one entry. */
export function pageTrashEntryPath(root: string, notebookId: string, entryId: string): string {
	return join(pageTrashEntriesFolder(root, notebookId), `${idFileName(entryId)}.json`);
}

/**
 * True for a notebook path the library does not list (same rule as storage `listNotebooks`): inside a reserved folder
 * of the notebooks folder, inside the plugin trash wherever it is, or inside the templates folder.
 */
export function isHiddenNotebookPath(path: string, notebooksFolder: string, templatesSetting: string): boolean {
	if (isInTrash(path)) return true;
	const root = notebooksFolder.replace(/^\/+|\/+$/g, "");
	if (isReservedPath(path, root)) return true;
	return isWithin(path, templatesFolderPath(templatesSetting, root));
}

/** Where templates are stored: the setting, or `<notebooks folder>/_templates`. */
export function templatesFolderPath(setting: string, root: string): string {
	const s = setting.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter((p) => p.length > 0 && p !== "." && p !== "..").join("/");
	return s || join(root, TEMPLATES_DIRNAME);
}

// ---------------------------------------------------------------- items

export type TrashKind = "notebook" | "folder";

export interface TrashMeta {
	v: 1;
	id: string;
	kind: TrashKind;
	/** File or folder name as it was (with the extension for a notebook). */
	name: string;
	/** Vault path it had before it was deleted. */
	originalPath: string;
	/** Epoch ms. */
	deletedAt: number;
}

/** Ids name a folder on disk: lowercase letters, digits and dashes only. */
export function isValidTrashId(id: string): boolean {
	return /^[a-z0-9]{1,12}-[a-z0-9]{4,32}$/.test(id);
}

export function newTrashId(now: number, random: string): string {
	return `${Math.max(0, Math.floor(now)).toString(36)}-${random.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).padEnd(6, "0")}`;
}

export function serializeTrashMeta(meta: TrashMeta): string {
	return `${JSON.stringify(meta, null, 2)}\n`;
}

/** Reads a meta file; null when it is not one (the item is then left alone, never deleted). */
export function parseTrashMeta(text: string): TrashMeta | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1 || typeof r.id !== "string" || !isValidTrashId(r.id)) return null;
	if (r.kind !== "notebook" && r.kind !== "folder") return null;
	if (typeof r.name !== "string" || r.name === "" || r.name.includes("/")) return null;
	if (typeof r.originalPath !== "string" || r.originalPath === "") return null;
	if (typeof r.deletedAt !== "number" || !Number.isFinite(r.deletedAt)) return null;
	return { v: 1, id: r.id, kind: r.kind, name: r.name, originalPath: r.originalPath, deletedAt: r.deletedAt };
}

/** Newest first. */
export function sortTrash<T extends { deletedAt: number }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => b.deletedAt - a.deletedAt);
}

const DAY_MS = 86_400_000;

/** Ids of the items deleted `days` or more days ago. `days <= 0` (auto-empty off) never expires anything. */
export function expiredIds(items: ReadonlyArray<{ id: string; deletedAt: number }>, now: number, days: number): string[] {
	if (!(days > 0)) return [];
	return items.filter((i) => now - i.deletedAt >= days * DAY_MS).map((i) => i.id);
}

/** Whole days until the item is emptied by auto-empty, or null when auto-empty is off. */
export function daysLeft(deletedAt: number, now: number, days: number): number | null {
	if (!(days > 0)) return null;
	return Math.max(0, Math.ceil((deletedAt + days * DAY_MS - now) / DAY_MS));
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Where an item goes back to: its original path, or the same name with " 2", " 3"… when something
 * else has taken it meanwhile. A notebook keeps its extension (`Physics 2.notebook`).
 */
export function restorePath(originalPath: string, kind: TrashKind, exists: (path: string) => boolean): string {
	if (!exists(originalPath)) return originalPath;
	const dir = dirOf(originalPath);
	const name = nameOf(originalPath);
	const dot = kind === "notebook" ? name.lastIndexOf(".") : -1;
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let i = 2; ; i++) {
		const candidate = join(dir, `${base} ${i}${ext}`);
		if (!exists(candidate)) return candidate;
	}
}

/** True if `path` is `folder` or inside it. */
export function isWithin(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}
