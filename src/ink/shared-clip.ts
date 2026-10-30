import { createId } from "../model/document";
import type { ClipContent } from "./clipboard";
import { readStamp, serializeStamp } from "./stamps";

/**
 * wave 0.10 (362): the clipboard shared between devices through the vault (pure: the file format and the rules; the
 * store that reads and writes the files is storage/shared-clip-store.ts).
 *
 * Each device writes only its own file, `<notebooks folder>/_meta/clipboard-<device>.json`, when the user copies "to other
 * devices"; the other devices list the entries of all the other files, newest first, and paste one with fresh ids. An
 * entry holds the selection as the text of a one-page notebook document (the format of personal stamps, ink/stamps.ts):
 * the strokes and elements in page coordinates, validated by the notebook parser, plus the records of the pictures it
 * uses. The picture files are not copied: they are already content-addressed files in the notebooks' `_assets` folder,
 * which the vault syncs on its own. No format change: this is a sidecar file, like the Inbox or the practice copies.
 */

export const SHARED_CLIP_FORMAT = "notebook-shared-clipboard";
export const SHARED_CLIP_VERSION = 1;
/** Files are `clipboard-<device>.json`. */
export const SHARED_CLIP_PREFIX = "clipboard";
/** Entries kept in a device's file: the newest ones; an older one is dropped when a new one is written. */
export const MAX_SHARED_ENTRIES = 5;
/**
 * Largest file written (characters, about the same as bytes for ink): a clipboard is meant for a few strokes and
 * pictures, not for a notebook, and Google Drive or OneDrive upload it every time it changes.
 */
export const MAX_SHARED_CHARS = 3_000_000;
/** Biggest side (pt) of a copied selection: several pages of ink still fit. */
export const MAX_SHARED_SIDE = 20_000;
/** How many entries of other devices the paste list shows. */
export const MAX_LISTED_CLIPS = 20;

export const EMPTY_SHARED_CLIP_MESSAGE = "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced";

/** One copy. `text` is a notebook document (see above); the counts are what the list shows without parsing it. */
export interface SharedClipEntry {
	id: string;
	/** When it was copied (ms since the epoch). */
	at: number;
	strokes: number;
	images: number;
	texts: number;
	text: string;
}

export interface SharedClipFile {
	entries: SharedClipEntry[];
	/** Entries this version cannot read (a newer one wrote them): written back untouched. */
	unknown: unknown[];
}

export type SharedClipParse =
	| { ok: true; data: SharedClipFile }
	| { ok: false; reason: "empty" | "json" | "format" | "future"; message: string };

export function emptySharedClip(): SharedClipFile {
	return { entries: [], unknown: [] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function readEntry(v: unknown): SharedClipEntry | null {
	if (!isObject(v)) return null;
	if (typeof v.id !== "string" || v.id === "" || typeof v.text !== "string" || v.text === "") return null;
	if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
	if (!count(v.strokes) || !count(v.images) || !count(v.texts)) return null;
	return { id: v.id, at: v.at, strokes: v.strokes, images: v.images, texts: v.texts, text: v.text };
}

export function parseSharedClip(text: string): SharedClipParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_SHARED_CLIP_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== SHARED_CLIP_FORMAT || typeof raw.version !== "number" || !Array.isArray(raw.entries)) {
		return { ok: false, reason: "format", message: "not a Notebook shared clipboard file" };
	}
	if (raw.version > SHARED_CLIP_VERSION) {
		return { ok: false, reason: "future", message: `clipboard file version ${raw.version} is newer than this plugin supports` };
	}
	const data = emptySharedClip();
	const seen = new Set<string>();
	for (const entry of raw.entries) {
		const e = readEntry(entry);
		if (!e) data.unknown.push(entry);
		else if (!seen.has(e.id)) {
			seen.add(e.id);
			data.entries.push(e);
		}
	}
	return { ok: true, data };
}

export function serializeSharedClip(data: SharedClipFile): string {
	return JSON.stringify({ format: SHARED_CLIP_FORMAT, version: SHARED_CLIP_VERSION, entries: [...data.entries, ...data.unknown] });
}

export type MakeEntry = { ok: true; entry: SharedClipEntry } | { ok: false; reason: "invalid" | "too-large"; message: string };

/** The entry for a copied selection: serialized and validated by the notebook parser before it is returned. */
export function makeSharedEntry(clip: ClipContent, at: number): MakeEntry {
	const saved = serializeStamp(clip, new Date(at), MAX_SHARED_SIDE);
	if (!saved.ok) return { ok: false, reason: saved.message.includes("too large") ? "too-large" : "invalid", message: saved.message };
	const images = clip.elements.filter((e) => e.type === "image").length;
	const entry: SharedClipEntry = {
		id: createId(), at, strokes: clip.strokes.length, images, texts: clip.elements.length - images, text: saved.text,
	};
	// Read it back the way another device will.
	const back = readStamp(entry.text);
	if (!back.ok) return { ok: false, reason: "invalid", message: back.message };
	return { ok: true, entry };
}

export type AddedEntry = { ok: true; data: SharedClipFile; dropped: number } | { ok: false; reason: "too-large"; message: string };

/**
 * `entry` at the front of `data`, the oldest entries dropped to stay within MAX_SHARED_ENTRIES and the size cap. Refused
 * (nothing changes) when the entry alone does not fit.
 */
export function addSharedEntry(data: SharedClipFile, entry: SharedClipEntry, maxChars: number = MAX_SHARED_CHARS): AddedEntry {
	let entries = [entry, ...data.entries.filter((e) => e.id !== entry.id)];
	const total = (list: SharedClipEntry[]) => serializeSharedClip({ entries: list, unknown: data.unknown }).length;
	if (total([entry]) > maxChars) return { ok: false, reason: "too-large", message: "the selection is too large to share between devices" };
	const before = entries.length;
	entries = entries.slice(0, MAX_SHARED_ENTRIES);
	while (entries.length > 1 && total(entries) > maxChars) entries.pop();
	return { ok: true, data: { entries, unknown: data.unknown }, dropped: before - entries.length };
}

/** An entry of another device's file, as the paste list shows it. */
export interface SharedClipItem {
	device: string;
	entry: SharedClipEntry;
}

/** The entries of the other devices' files, newest first, at most `limit`. */
export function listSharedItems(files: ReadonlyArray<{ device: string; data: SharedClipFile }>, limit: number = MAX_LISTED_CLIPS): SharedClipItem[] {
	const items: SharedClipItem[] = [];
	for (const f of files) for (const entry of f.data.entries) items.push({ device: f.device, entry });
	items.sort((a, b) => b.entry.at - a.entry.at || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
	return items.slice(0, limit);
}

/** The content of an entry, or why it cannot be used (damaged, empty). Pasting gives every item a new id. */
export function readSharedEntry(entry: SharedClipEntry): { ok: true; clip: ClipContent } | { ok: false; message: string } {
	return readStamp(entry.text);
}

/** How long ago a copy was made, in the unit the list shows ("now" under a minute). A clock that went backwards reads "now". */
export function clipAge(now: number, at: number): { unit: "now" | "minutes" | "hours" | "days"; n: number } {
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return { unit: "now", n: 0 };
	if (minutes < 60) return { unit: "minutes", n: minutes };
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return { unit: "hours", n: hours };
	return { unit: "days", n: Math.floor(hours / 24) };
}
