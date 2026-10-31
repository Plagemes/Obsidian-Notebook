/**
 * Folder metadata (wave 0.12): the colour, icon, description and art style of a library folder, shown on its card. Pure:
 * no 'obsidian'.
 *
 * A folder is a plain vault folder, so there is no file of its own to hold this. It lives in the notebooks folder's reserved
 * `_meta` folder, **one file per device** (`folders-<device>.json`), like the library state (library-state.ts): a device
 * only ever writes its own file, so two devices syncing through any service never write the same file and there is nothing
 * to conflict on. Reading merges every device's file.
 *
 * Merge rule (last writer wins, per folder and per field): every field carries the time it was set; the latest wins, a tie
 * goes to the larger device id. A field set to `null` is cleared (that is how a rename leaves the old path empty). A device
 * writing a field takes a time later than the one it has just read for that field, so clock skew does not make a change
 * lose to an older one.
 *
 * Folders are keyed by their vault path. A rename (or a move) is followed by the rename event of the vault: the fields of
 * the folder and of every folder inside it move to the new paths and are cleared at the old ones (`planRename`). Deleting a
 * folder clears nothing: a folder put back from the trash comes back by a rename, and the creation dialog writes every
 * field of a new folder explicitly, so a new folder never inherits the look of an old one with the same name.
 */

import { COVER_ART_STYLES, type CoverArtStyle } from "../model/types";
import { EMPTY_FILE_MESSAGE } from "../storage/device-files";

export const FOLDER_META_FORMAT = "obsidian-notebook-folder-meta";
export const FOLDER_META_VERSION = 1;
/** `_meta/folders-<device>.json` */
export const FOLDER_META_PREFIX = "folders";
/** Longest folder description, in characters. */
export const FOLDER_DESCRIPTION_MAX = 500;

export const FOLDER_FIELDS = ["color", "icon", "description", "art", "pinned"] as const;
export type FolderField = (typeof FOLDER_FIELDS)[number];

export interface Stamped<T> {
	/** The value; null = cleared. */
	v: T | null;
	/** When (ms since epoch) the field was set. */
	at: number;
}

export interface FolderItem {
	/** Vault path of the folder. */
	path: string;
	color?: Stamped<string>;
	icon?: Stamped<string>;
	description?: Stamped<string>;
	art?: Stamped<CoverArtStyle>;
	/** 0.13: pinned to the sidebar's "Pinned" section. The value is "1" (a boolean field kept as text like the others). */
	pinned?: Stamped<"1">;
}

/** What a folder card shows. Every field is optional: absent = the default (colour from the name, folder icon, …). */
export interface FolderMeta {
	/** `#rrggbb` */
	color?: string;
	/** Lucide icon name. */
	icon?: string;
	description?: string;
	/** Line-art style of the card background (`ArtStyle` of ui/art/generative-art.ts). */
	art?: CoverArtStyle;
	/** 0.13: the folder is pinned to the sidebar. */
	pinned?: boolean;
}

export interface ResolvedFolder extends Omit<FolderMeta, "pinned"> {
	/** "1" when pinned (the stored value). */
	pinned?: "1";
	/** When each field was last set (0 = never): the next change takes a later time. */
	stamps: Record<FolderField, number>;
}

export type FolderMetaMap = ReadonlyMap<string, ResolvedFolder>;

export interface FolderMetaFile {
	version: number;
	device: string;
	items: FolderItem[];
	/** Items this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type FolderMetaParse =
	| { ok: true; data: FolderMetaFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

export function emptyFolderMeta(device: string): FolderMetaFile {
	return { version: FOLDER_META_VERSION, device, items: [], unknown: [] };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `v` is a valid value of `field` (null, the cleared value, always is). */
export function validFolderValue(field: FolderField, v: unknown): boolean {
	if (v === null) return true;
	if (typeof v !== "string") return false;
	switch (field) {
		case "color": return HEX.test(v);
		case "icon": return v.length <= 64 && ICON.test(v);
		case "description": return v.length > 0 && v.length <= FOLDER_DESCRIPTION_MAX;
		case "art": return (COVER_ART_STYLES as readonly string[]).includes(v);
		case "pinned": return v === "1";
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStamped(field: FolderField, v: unknown): Stamped<string> | null | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v) || !validFolderValue(field, v.v) || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
	return { v: v.v as string | null, at: v.at };
}

function setField(item: FolderItem, field: FolderField, s: Stamped<string>): void {
	(item as unknown as Record<FolderField, Stamped<string>>)[field] = s;
}

function getField(item: FolderItem, field: FolderField): Stamped<string> | undefined {
	return (item as unknown as Partial<Record<FolderField, Stamped<string>>>)[field];
}

function readItem(v: unknown): FolderItem | null {
	if (!isObject(v) || typeof v.path !== "string" || v.path === "") return null;
	const item: FolderItem = { path: v.path };
	for (const field of FOLDER_FIELDS) {
		const s = readStamped(field, v[field]);
		if (s === null) return null;
		if (s) setField(item, field, s);
	}
	return item;
}

const later = (a: Stamped<string> | undefined, b: Stamped<string> | undefined) => (!a ? b : !b ? a : b.at >= a.at ? b : a);

/** One item per path (the later value of each field). */
function dedupe(items: readonly FolderItem[]): FolderItem[] {
	const by = new Map<string, FolderItem>();
	for (const item of items) {
		const old = by.get(item.path);
		if (!old) {
			by.set(item.path, item);
			continue;
		}
		const merged: FolderItem = { path: item.path };
		for (const field of FOLDER_FIELDS) {
			const s = later(getField(old, field), getField(item, field));
			if (s) setField(merged, field, s);
		}
		by.set(item.path, merged);
	}
	return [...by.values()];
}

/**
 * Reads a device file. A file that is not ours or comes from a newer version is reported, never "fixed". An existing empty
 * file is reported too: a sync app may not have finished downloading it (a missing file is the empty state).
 */
export function parseFolderMeta(text: string, device: string): FolderMetaParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_FILE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== FOLDER_META_FORMAT) return { ok: false, reason: "format", message: "not a folder metadata file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > FOLDER_META_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const items: FolderItem[] = [];
	const unknown: unknown[] = [];
	for (const v of raw.items) {
		const item = readItem(v);
		if (item) items.push(item);
		else unknown.push(v);
	}
	const named = typeof raw.device === "string" && /^[0-9a-f]{8}$/.test(raw.device) ? raw.device : device;
	return { ok: true, data: { version: FOLDER_META_VERSION, device: named, items: dedupe(items), unknown } };
}

/** Deterministic text: one item per line, sorted by path, fields in a fixed order. */
export function serializeFolderMeta(data: FolderMetaFile): string {
	const head = `{"format":${JSON.stringify(FOLDER_META_FORMAT)},"version":${FOLDER_META_VERSION},"device":${JSON.stringify(data.device)},"items":[`;
	const line = (item: FolderItem) => {
		const parts = [`"path":${JSON.stringify(item.path)}`];
		for (const field of FOLDER_FIELDS) {
			const s = getField(item, field);
			if (s) parts.push(`${JSON.stringify(field)}:{"v":${JSON.stringify(s.v)},"at":${JSON.stringify(s.at)}}`);
		}
		return `{${parts.join(",")}}`;
	};
	const lines = [
		...[...data.items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(line),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** Every device's files together: per folder and field, the latest value wins (a tie goes to the larger device id). */
export function mergeFolderFiles(files: readonly FolderMetaFile[]): Map<string, ResolvedFolder> {
	type Winner = { s: Stamped<string>; device: string };
	const best = new Map<string, Partial<Record<FolderField, Winner>>>();
	const beats = (cand: Winner, cur: Winner | undefined) => !cur || cand.s.at > cur.s.at || (cand.s.at === cur.s.at && cand.device > cur.device);
	for (const file of files) {
		for (const item of file.items) {
			const slot = best.get(item.path) ?? {};
			for (const field of FOLDER_FIELDS) {
				const s = getField(item, field);
				if (s && beats({ s, device: file.device }, slot[field])) slot[field] = { s, device: file.device };
			}
			best.set(item.path, slot);
		}
	}
	const out = new Map<string, ResolvedFolder>();
	for (const [path, slot] of best) {
		const resolved: ResolvedFolder = { stamps: { color: 0, icon: 0, description: 0, art: 0, pinned: 0 } };
		for (const field of FOLDER_FIELDS) {
			const w = slot[field];
			if (!w) continue;
			resolved.stamps[field] = w.s.at;
			if (w.s.v !== null) (resolved as unknown as Record<FolderField, string>)[field] = w.s.v;
		}
		out.set(path, resolved);
	}
	return out;
}

/** The fields of a resolved folder that hold a value (what a card shows), or null when none does. */
export function folderMetaOf(resolved: ResolvedFolder | undefined): FolderMeta | null {
	if (!resolved) return null;
	const out: FolderMeta = {};
	if (resolved.color !== undefined) out.color = resolved.color;
	if (resolved.icon !== undefined) out.icon = resolved.icon;
	if (resolved.description !== undefined) out.description = resolved.description;
	if (resolved.art !== undefined) out.art = resolved.art;
	if (resolved.pinned === "1") out.pinned = true;
	return Object.keys(out).length > 0 ? out : null;
}

// ------------------------------------------------------------------ changes

/** Sets (a string) or clears (null) one field of one folder. */
export interface FolderMetaOp {
	path: string;
	field: FolderField;
	value: string | null;
}

/** The ops that write `patch` for `path`: a field that is `undefined` in the patch is left alone, `null` clears it. */
export function patchOps(path: string, patch: Partial<Record<FolderField, string | null>>): FolderMetaOp[] {
	const ops: FolderMetaOp[] = [];
	for (const field of FOLDER_FIELDS) {
		const v = patch[field];
		if (v === undefined) continue;
		ops.push({ path, field, value: field === "description" && typeof v === "string" && v.trim() === "" ? null : v });
	}
	return ops;
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The ops that follow a rename of the folder `from` to `to`: every field with a value of `from` and of each folder inside it
 * is set at the new path and cleared at the old one. Empty when nothing there has metadata (so most renames write nothing).
 */
export function planRename(merged: FolderMetaMap, from: string, to: string): FolderMetaOp[] {
	if (from === to || from === "") return [];
	const ops: FolderMetaOp[] = [];
	for (const [path, folder] of merged) {
		if (!inside(path, from)) continue;
		const target = to + path.slice(from.length);
		for (const field of FOLDER_FIELDS) {
			const v = folder[field];
			if (v === undefined) continue;
			ops.push({ path: target, field, value: v });
			ops.push({ path, field, value: null });
		}
	}
	return ops;
}

/**
 * Applies changes to this device's file. `merged` is what every device's files say now: a change that equals it is not
 * written, and a written field takes a time later than both the merged one and this device's own previous one. Invalid
 * values are skipped (never written).
 */
export function applyFolderOps(own: FolderMetaFile, merged: FolderMetaMap, ops: readonly FolderMetaOp[], now: number): FolderMetaFile {
	const items = new Map(own.items.map((i) => [i.path, { ...i }]));
	for (const op of ops) {
		if (!op.path || !validFolderValue(op.field, op.value)) continue;
		const seen = merged.get(op.path);
		const current = seen?.[op.field] ?? null;
		const item = items.get(op.path) ?? { path: op.path };
		const ownStamp = getField(item, op.field);
		// Nothing to do when every device already agrees (a field never set counts as cleared), unless this device's own
		// file says otherwise (an older value of its own that lost to another device stays harmless either way).
		if (current === op.value && (seen?.stamps[op.field] ?? 0) > 0) continue;
		if (current === op.value && op.value === null && !ownStamp) continue;
		const at = Math.max(now, (seen?.stamps[op.field] ?? 0) + 1, (ownStamp?.at ?? 0) + 1);
		setField(item, op.field, { v: op.value, at });
		items.set(op.path, item);
	}
	return { ...own, items: [...items.values()] };
}
