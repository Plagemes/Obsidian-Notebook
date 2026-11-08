/**
 * Global bookmarks (roadmap #265): pages of different notebooks in one list. Pure: no 'obsidian'. Like the quick tabs
 * (`quicktabs.ts`) they are **not** part of any notebook file (the document format is untouched): they live in
 * `_meta/bookmarks-<device>.json`, **one file per device**; a device only writes its own file and reading merges every
 * device's file. Per bookmark (by id) the latest `at` wins, a tie goes to the larger device id; a removed bookmark is kept
 * as a tombstone (`deleted: true`) so the removal wins over an older copy on another device.
 *
 * A bookmark names its notebook by `docId` (the notebook's own id, which survives renames and moves) and by `path` (where
 * to open it; kept in step with vault renames and used first), and the page by **page id** (survives moving pages). `num`
 * (the page number when added) and `label` are only a fallback for showing it and for a page that is gone.
 *
 * Lenient reading: an entry this version cannot make sense of is kept in `unknown` and written back as it was; fields of an
 * entry that this version does not know are kept (`extra`). A file that cannot be read is never "fixed"
 * (bookmarks-store.ts never overwrites it).
 */
import { DAY_MS, TOMBSTONE_DAYS } from "./quicktabs";

export { DAY_MS, TOMBSTONE_DAYS };
export const BOOKMARKS_FORMAT = "obsidian-notebook-bookmarks";
export const BOOKMARKS_VERSION = 1;
/** `_meta/bookmarks-<device>.json` */
export const BOOKMARKS_PREFIX = "bookmarks";
export const BOOKMARK_LABEL_MAX = 60;

export interface GlobalBookmark {
	id: string;
	/** The notebook's own id (document id); empty when the notebook has none yet. */
	docId: string;
	/** Vault path of the notebook it opens. */
	path: string;
	pageId: string;
	/** The page number (1-based) when it was added: where to land when the page is gone. */
	num: number;
	/** What the row says (the page's bookmark title, or whatever the reader typed); empty: "<notebook> p. N". */
	label?: string;
	/** Position in the list (ascending; fractions allow moving one bookmark with one write). */
	order: number;
	/** When (ms since epoch) it was last changed. */
	at: number;
	extra?: Record<string, unknown>;
}

export interface StoredBookmark extends GlobalBookmark {
	deleted?: boolean;
	/**
	 * What the file said for `docId`, `num` or `label` when this version had to normalise it to show it (a label cut to 60 characters, a
	 * fractional or out-of-range page number): written back as it was until this version changes that field itself.
	 */
	rawKept?: Record<string, unknown>;
}

export interface BookmarksFile {
	version: number;
	device: string;
	items: StoredBookmark[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
	/** Top-level members of the file this version does not know: kept and written back. */
	extra?: Record<string, unknown>;
}

export type BookmarksParse =
	| { ok: true; data: BookmarksFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function emptyBookmarks(device: string): BookmarksFile {
	return { version: BOOKMARKS_VERSION, device, items: [], unknown: [] };
}

/** A label that fits: one line, trimmed, at most `BOOKMARK_LABEL_MAX` characters. */
export function cleanBookmarkLabel(label: string | undefined): string {
	return (label ?? "").replace(/\s+/g, " ").trim().slice(0, BOOKMARK_LABEL_MAX);
}

/** A fresh bookmark id that is not in `taken`. */
export function newBookmarkId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		const id = `b${Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0")}`;
		if (!taken.has(id)) return id;
	}
}

const KNOWN_FILE = new Set(["format", "version", "device", "items"]);
const KNOWN_ITEM = new Set(["id", "docId", "path", "pageId", "num", "label", "order", "at", "deleted"]);

function readItem(v: unknown): StoredBookmark | null {
	if (!isObject(v) || typeof v.id !== "string" || v.id === "" || typeof v.path !== "string" || v.path === "") return null;
	if (typeof v.pageId !== "string" || v.pageId === "" || !finite(v.at) || !finite(v.order)) return null;
	const extra: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) if (!KNOWN_ITEM.has(k)) extra[k] = x;
	const item: StoredBookmark = {
		id: v.id, docId: typeof v.docId === "string" ? v.docId : "", path: v.path, pageId: v.pageId,
		num: finite(v.num) && v.num >= 1 ? Math.trunc(v.num) : 1, order: v.order, at: v.at,
	};
	const label = typeof v.label === "string" ? cleanBookmarkLabel(v.label) : "";
	if (label) item.label = label;
	if (v.deleted === true) item.deleted = true;
	// A field this version only normalised to show it keeps what the file said (a later plugin may use it as it is).
	const rawKept: Record<string, unknown> = {};
	if ("docId" in v && v.docId !== item.docId) rawKept.docId = v.docId;
	if ("num" in v && v.num !== item.num) rawKept.num = v.num;
	if ("label" in v && v.label !== (item.label ?? "")) rawKept.label = v.label;
	if (Object.keys(rawKept).length > 0) item.rawKept = rawKept;
	if (Object.keys(extra).length > 0) item.extra = extra;
	return item;
}

/** Reads a device file. A file that is not ours, is empty (a sync may not have finished) or is newer is reported, never "fixed". */
export function parseBookmarks(text: string, device: string): BookmarksParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== BOOKMARKS_FORMAT) return { ok: false, reason: "format", message: "not a bookmarks file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > BOOKMARKS_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const byId = new Map<string, StoredBookmark>();
	const unknown: unknown[] = [];
	for (const v of raw.items) {
		const item = readItem(v);
		if (!item) unknown.push(v);
		else {
			const old = byId.get(item.id);
			if (!old || item.at >= old.at) byId.set(item.id, item);
		}
	}
	const named = typeof raw.device === "string" && /^[0-9a-f]{8}$/.test(raw.device) ? raw.device : device;
	const extra: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(raw)) if (!KNOWN_FILE.has(k)) extra[k] = x;
	const data: BookmarksFile = { version: BOOKMARKS_VERSION, device: named, items: [...byId.values()], unknown };
	if (Object.keys(extra).length > 0) data.extra = extra;
	return { ok: true, data };
}

function itemJson(i: StoredBookmark): string {
	const o: Record<string, unknown> = { ...(i.extra ?? {}), id: i.id, docId: i.docId, path: i.path, pageId: i.pageId, num: i.num, order: i.order, at: i.at };
	if (i.label) o.label = i.label;
	if (i.deleted) o.deleted = true;
	if (i.rawKept) Object.assign(o, i.rawKept);
	return JSON.stringify(o);
}

/** Deterministic text: one bookmark per line, sorted by id. */
export function serializeBookmarks(data: BookmarksFile): string {
	const extra = Object.entries(data.extra ?? {}).filter(([k]) => !KNOWN_FILE.has(k)).map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`).join("");
	const head = `{"format":${JSON.stringify(BOOKMARKS_FORMAT)},"version":${BOOKMARKS_VERSION},"device":${JSON.stringify(data.device)}${extra},"items":[`;
	const lines = [
		...[...data.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(itemJson),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** What every device's files say: per id, the latest wins (a tie goes to the larger device id). Removed ones stay as tombstones. */
export type BookmarksMap = ReadonlyMap<string, StoredBookmark>;

export function mergeBookmarkFiles(files: readonly BookmarksFile[]): Map<string, StoredBookmark> {
	const best = new Map<string, { item: StoredBookmark; device: string }>();
	for (const f of files) {
		for (const item of f.items) {
			const cur = best.get(item.id);
			if (!cur || item.at > cur.item.at || (item.at === cur.item.at && f.device > cur.device)) best.set(item.id, { item, device: f.device });
		}
	}
	return new Map([...best].map(([id, b]) => [id, b.item]));
}

const byOrder = (a: GlobalBookmark, b: GlobalBookmark): number => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The same page of the same notebook at the same path: what makes two rows one bookmark. */
const pageKey = (b: Pick<GlobalBookmark, "docId" | "path" | "pageId">): string => `${b.docId}\u0000${b.path}\u0000${b.pageId}`;

/**
 * Every live bookmark, in list order. The same page bookmarked on two devices before their files synced has two ids: it is one row (the one first in
 * list order, the same on every device); `bookmarkTwins` finds the others when the bookmark is removed.
 */
export function liveBookmarks(map: BookmarksMap): GlobalBookmark[] {
	const live = [...map.values()].filter((b) => !b.deleted).map(({ deleted: _d, rawKept: _r, ...b }) => b).sort(byOrder);
	const seen = new Set<string>();
	return live.filter((b) => {
		const key = pageKey(b);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The ids of every live bookmark that is the same page as the bookmark `id` (itself included): removing one removes them all. */
export function bookmarkTwins(map: BookmarksMap, id: string): string[] {
	const one = map.get(id);
	if (!one || one.deleted) return [];
	const key = pageKey(one);
	return [...map.values()].filter((b) => !b.deleted && pageKey(b) === key).map((b) => b.id);
}

/**
 * The live bookmark of this page of this notebook, if any. A notebook with an id is found by it AND its path, so a copy of a notebook (same id, same
 * page ids) is not mistaken for the original; a bookmark whose path no longer holds that notebook (`pathHolds` says so: no file there, or a different notebook now sits there: it was renamed where no rename was seen) still matches by id alone. Without an id the path decides.
 */
export function findBookmark(map: BookmarksMap, ref: { docId: string; path: string; pageId: string }, pathHolds?: (path: string, docId: string) => boolean): GlobalBookmark | null {
	const onPage = liveBookmarks(map).filter((b) => b.pageId === ref.pageId);
	if (!ref.docId) return onPage.find((b) => b.path === ref.path) ?? null;
	const sameId = onPage.filter((b) => b.docId === ref.docId);
	return sameId.find((b) => b.path === ref.path) ?? sameId.find((b) => !pathHolds || !pathHolds(b.path, b.docId)) ?? null;
}

/** `file` without the tombstones older than `TOMBSTONE_DAYS` (same rule as the quick tabs: see `pruneQuickTabTombstones`). */
export function pruneBookmarkTombstones(file: BookmarksFile, now: number, others: readonly BookmarksFile[] = [], othersComplete = true): BookmarksFile {
	const limit = now - TOMBSTONE_DAYS * DAY_MS;
	const stillHeld = (i: StoredBookmark): boolean => others.some((f) => f.items.some((o) => o.id === i.id && o.deleted !== true && o.at <= i.at));
	const items = file.items.filter((i) => !(i.deleted === true && i.at < limit && othersComplete && !stillHeld(i)));
	return items.length === file.items.length ? file : { ...file, items };
}

/** This device's file with the winning state of the ids it holds (a removal made on another device is written here too). */
export function adoptBookmarkWinners(own: BookmarksFile, merged: BookmarksMap): BookmarksFile {
	let changed = false;
	const items = own.items.map((i) => {
		const w = merged.get(i.id);
		if (!w || w === i || !(w.at > i.at || (w.at === i.at && itemJson(w) !== itemJson(i)))) return i;
		changed = true;
		return w;
	});
	return changed ? { ...own, items } : own;
}

// ------------------------------------------------------------------ ordering

/** The order for a bookmark put at the end of `list`. */
export function bookmarkOrderAtEnd(list: readonly GlobalBookmark[]): number {
	return list.length === 0 ? 0 : Math.max(...list.map((b) => b.order)) + 1;
}

/**
 * Moves the bookmark `id` so that it ends up at index `to` (0-based, counted in the list as it is afterwards): the new
 * `order` values to write. Normally one value (between its new neighbours); when the neighbours are too close to split,
 * every bookmark is numbered again. Empty when nothing would change or `id` is not in `list`.
 */
export function planBookmarkMove(list: readonly GlobalBookmark[], id: string, to: number): Array<{ id: string; order: number }> {
	const sorted = [...list].sort(byOrder);
	const from = sorted.findIndex((b) => b.id === id);
	if (from < 0) return [];
	const target = Math.max(0, Math.min(sorted.length - 1, Math.trunc(to)));
	if (target === from) return [];
	const rest = sorted.filter((b) => b.id !== id);
	const prev = rest[target - 1]?.order;
	const next = rest[target]?.order;
	let order: number;
	if (prev !== undefined && next !== undefined) order = (prev + next) / 2;
	else if (prev !== undefined) order = prev + 1;
	else if (next !== undefined) order = next - 1;
	else order = 0;
	const crowded = (prev !== undefined && !(order > prev)) || (next !== undefined && !(order < next));
	if (!crowded) return [{ id, order }];
	const ids = rest.map((b) => b.id);
	ids.splice(target, 0, id);
	return ids.map((x, i) => ({ id: x, order: i }));
}

// ------------------------------------------------------------------ resolving a bookmark

export type BookmarkTarget =
	/** The page is in the notebook: `index` (0-based). */
	| { kind: "page"; index: number }
	/** The notebook is there but the page is gone: it would land on `index`, the nearest page by the number it had. */
	| { kind: "gone"; index: number };

/** Where a bookmark goes, given the ids of the pages of its notebook in order. */
export function resolveBookmark(b: GlobalBookmark, pageIds: readonly string[]): BookmarkTarget {
	const index = pageIds.indexOf(b.pageId);
	if (index >= 0) return { kind: "page", index };
	return { kind: "gone", index: Math.max(0, Math.min(pageIds.length - 1, b.num - 1)) };
}

// ------------------------------------------------------------------ changes

export type BookmarkOp =
	| { kind: "add"; id: string; docId: string; path: string; pageId: string; num: number; label?: string; order: number }
	| { kind: "remove"; id: string }
	| { kind: "order"; id: string; order: number }
	| { kind: "label"; id: string; label: string }
	/** The notebook at `from` was renamed or moved to `to`: every live bookmark that points at it follows; with `docId` (found by its id) only that notebook's bookmarks, never those of another notebook now at the old path. */
	| { kind: "retarget"; from: string; to: string; docId?: string };

/**
 * Applies changes to this device's file. `merged` is what every device's files say now: a written bookmark takes a time
 * later than both the merged one and this device's own previous one; unknown fields of the merged winner are carried over.
 */
export function applyBookmarkOps(ownFile: BookmarksFile, merged: BookmarksMap, ops: readonly BookmarkOp[], now: number): BookmarksFile {
	const own = adoptBookmarkWinners(ownFile, merged);
	const items = new Map(own.items.map((i) => [i.id, i]));
	const current = (id: string): StoredBookmark | undefined => {
		const seen = merged.get(id);
		const mine = items.get(id);
		return seen && (!mine || seen.at >= mine.at) ? seen : mine;
	};
	const put = (base: StoredBookmark, change: Partial<StoredBookmark>): void => {
		const at = Math.max(now, (merged.get(base.id)?.at ?? 0) + 1, (items.get(base.id)?.at ?? 0) + 1);
		const next: StoredBookmark = { ...base, ...change, at };
		// A field this version sets itself no longer keeps what an older file said for it.
		if (next.rawKept && ("label" in change || "docId" in change || "num" in change)) {
			const kept = { ...next.rawKept };
			for (const k of ["label", "docId", "num"] as const) if (k in change) delete kept[k];
			if (Object.keys(kept).length > 0) next.rawKept = kept;
			else delete next.rawKept;
		}
		if (!next.label) delete next.label;
		if (!next.deleted) delete next.deleted;
		items.set(base.id, next);
	};
	for (const op of ops) {
		if (op.kind === "retarget") {
			for (const id of [...new Set([...merged.keys(), ...items.keys()])]) {
				const base = current(id);
				if (base && !base.deleted && base.path === op.from && (op.docId === undefined || base.docId === op.docId)) put(base, { path: op.to });
			}
			continue;
		}
		const base = current(op.id);
		if (op.kind === "remove") {
			if (base && !base.deleted) put(base, { deleted: true });
		} else if (op.kind === "order") {
			if (base && !base.deleted) put(base, { order: op.order });
		} else if (op.kind === "label") {
			if (base && !base.deleted) put(base, { label: cleanBookmarkLabel(op.label) });
		} else {
			const label = cleanBookmarkLabel(op.label);
			const fresh: StoredBookmark = { id: op.id, docId: op.docId, path: op.path, pageId: op.pageId, num: Math.max(1, Math.trunc(op.num)), order: op.order, at: 0 };
			if (label) fresh.label = label;
			if (base?.extra) fresh.extra = base.extra;
			put(fresh, {});
		}
	}
	return { ...own, items: [...items.values()] };
}
