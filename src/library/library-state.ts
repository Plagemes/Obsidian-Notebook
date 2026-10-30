/**
 * Library state (roadmap 54): which notebooks are pinned, which are archived and the manual order. Pure: no 'obsidian'.
 *
 * Nothing about this is stored in a notebook (no format change) and notebook files are never moved or renamed to archive
 * them. The state lives in small JSON files in the notebooks folder's reserved `_meta` folder, **one file per device**
 * (`library-<device>.json`, like the Inbox, the practice copies and the textbook configuration): a device only ever
 * writes its own file, so two devices syncing through Google Drive or OneDrive never write the same file and the sync
 * service has nothing to conflict on. Reading merges every device's file.
 *
 * Merge rule (last writer wins, per notebook and per field): each field (`pinned`, `archived`, `rank`) carries the time
 * it was set; the latest wins, a tie goes to the larger device id. So pinning on the phone and archiving a different
 * notebook on the tablet both survive, and un-pinning on one device overrides an older pin written by another. A device
 * writing a field takes a time later than the one it has just read for that field (clock skew between devices does not
 * make a change lose to an older one).
 *
 * Notebooks are keyed by their document id (`id:<id>`), which survives renaming and moving the file on any device;
 * a notebook whose id is not known (unreadable, not downloaded yet) is keyed by its path (`path:<path>`).
 */

import { conflictBaseCandidates } from "../storage/conflicts";
import { EMPTY_FILE_MESSAGE } from "../storage/device-files";

export const LIBRARY_STATE_FORMAT = "obsidian-notebook-library-state";
export const LIBRARY_STATE_VERSION = 1;
/** `_meta/library-<device>.json` */
export const LIBRARY_STATE_PREFIX = "library";

/** Gap between ranks given to a whole list; a single move takes the middle of its neighbours. */
export const RANK_STEP = 1024;

export interface Stamped<T> {
	v: T;
	/** When (ms since epoch) the field was set. */
	at: number;
}

export interface LibraryItem {
	key: string;
	pinned?: Stamped<boolean>;
	archived?: Stamped<boolean>;
	rank?: Stamped<number>;
}

export type LibraryField = "pinned" | "archived" | "rank";

export interface LibraryStateFile {
	version: number;
	device: string;
	items: LibraryItem[];
	/** Items this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type LibraryStateParse =
	| { ok: true; data: LibraryStateFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

/** The merged state of one notebook. */
export interface ResolvedItem {
	pinned: boolean;
	archived: boolean;
	/** Position in the manual order; undefined when the notebook was never placed by hand. */
	rank?: number;
	/** When each field was last set (0 = never): the next change takes a later time. */
	stamps: Record<LibraryField, number>;
}

export type LibraryMap = ReadonlyMap<string, ResolvedItem>;

export function emptyLibraryState(device: string): LibraryStateFile {
	return { version: LIBRARY_STATE_VERSION, device, items: [], unknown: [] };
}

/** The state key of a notebook: its document id when known, else its path. */
export function notebookKey(entry: { id?: string; path: string }): string {
	return entry.id ? `id:${entry.id}` : `path:${entry.path}`;
}

const stemOf = (path: string): string => {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
};
const folderPart = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The state key of every notebook, given all of them. Files that share a document id (a sync conflict copy, an explorer copy)
 * would share one state, so archiving a notebook would hide its copy too, and a conflicted copy hidden that way is never
 * seen and never merged. So one file of each group keeps the plain `id:<id>` key (state set before the copy appeared stays
 * with it) and the others are keyed by id and path (`copy:<id>:<path>`). The one that keeps it is, among the files that do
 * not look like a conflicted copy of another in the group (same folder, a conflict-style name: storage/conflicts.ts), the
 * first by path; when all of them look like copies, the first by path. A copy keyed this way is never hidden by the state
 * of the original. Notebooks whose id is not known keep their path key. Returns path to key.
 */
export function stateKeys(entries: readonly { id?: string; path: string }[]): Map<string, string> {
	const out = new Map<string, string>();
	const groups = new Map<string, string[]>();
	for (const e of entries) {
		if (!e.id) {
			out.set(e.path, notebookKey(e));
			continue;
		}
		const g = groups.get(e.id);
		if (g) g.push(e.path);
		else groups.set(e.id, [e.path]);
	}
	for (const [id, paths] of groups) {
		paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		if (paths.length === 1) {
			out.set(paths[0]!, `id:${id}`);
			continue;
		}
		const stems = new Set(paths.map((p) => `${folderPart(p)}/${stemOf(p)}`));
		const looksLikeCopy = (p: string): boolean =>
			conflictBaseCandidates(stemOf(p)).some((base) => stems.has(`${folderPart(p)}/${base}`));
		const primary = paths.find((p) => !looksLikeCopy(p)) ?? paths[0]!;
		for (const p of paths) out.set(p, p === primary ? `id:${id}` : `copy:${id}:${p}`);
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStamped<T>(v: unknown, ok: (x: unknown) => x is T): Stamped<T> | null | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v) || !ok(v.v) || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
	return { v: v.v, at: v.at };
}

const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isRank = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function readItem(v: unknown): LibraryItem | null {
	if (!isObject(v) || typeof v.key !== "string" || v.key === "") return null;
	const pinned = readStamped(v.pinned, isBool);
	const archived = readStamped(v.archived, isBool);
	const rank = readStamped(v.rank, isRank);
	if (pinned === null || archived === null || rank === null) return null;
	const item: LibraryItem = { key: v.key };
	if (pinned) item.pinned = pinned;
	if (archived) item.archived = archived;
	if (rank) item.rank = rank;
	return item;
}

function laterOf<T>(a: Stamped<T> | undefined, b: Stamped<T> | undefined): Stamped<T> | undefined {
	if (!a) return b;
	if (!b) return a;
	return b.at >= a.at ? b : a;
}

/** One item per key (the later value of each field). */
function dedupe(items: readonly LibraryItem[]): LibraryItem[] {
	const by = new Map<string, LibraryItem>();
	for (const item of items) {
		const old = by.get(item.key);
		if (!old) {
			by.set(item.key, item);
			continue;
		}
		const merged: LibraryItem = { key: item.key };
		const pinned = laterOf(old.pinned, item.pinned);
		const archived = laterOf(old.archived, item.archived);
		const rank = laterOf(old.rank, item.rank);
		if (pinned) merged.pinned = pinned;
		if (archived) merged.archived = archived;
		if (rank) merged.rank = rank;
		by.set(item.key, merged);
	}
	return [...by.values()];
}

/**
 * Reads a device file. A file that is not ours or comes from a newer version is reported, never "fixed". An existing empty
 * file is not "nothing pinned": a sync app may not have finished downloading it, so it is reported too (a missing file is
 * the empty state; the store never asks this for one).
 */
export function parseLibraryState(text: string, device: string): LibraryStateParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_FILE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== LIBRARY_STATE_FORMAT) return { ok: false, reason: "format", message: "not a library state file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > LIBRARY_STATE_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const items: LibraryItem[] = [];
	const unknown: unknown[] = [];
	for (const v of raw.items) {
		const item = readItem(v);
		if (item) items.push(item);
		else unknown.push(v);
	}
	const named = typeof raw.device === "string" && /^[0-9a-f]{8}$/.test(raw.device) ? raw.device : device;
	return { ok: true, data: { version: LIBRARY_STATE_VERSION, device: named, items: dedupe(items), unknown } };
}

/** Deterministic text: one item per line, sorted by key. */
export function serializeLibraryState(data: LibraryStateFile): string {
	const head = `{"format":${JSON.stringify(LIBRARY_STATE_FORMAT)},"version":${LIBRARY_STATE_VERSION},"device":${JSON.stringify(data.device)},"items":[`;
	const lines = [
		...[...data.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((i) => JSON.stringify(i)),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** Every device's files together: per notebook and field, the latest value wins (a tie goes to the larger device id). */
export function mergeLibraryFiles(files: readonly LibraryStateFile[]): Map<string, ResolvedItem> {
	type Winner<T> = { w: Stamped<T>; device: string };
	const best = new Map<string, { pinned?: Winner<boolean>; archived?: Winner<boolean>; rank?: Winner<number> }>();
	const beats = <T>(cand: Winner<T>, cur: Winner<T> | undefined) => !cur || cand.w.at > cur.w.at || (cand.w.at === cur.w.at && cand.device > cur.device);
	for (const file of files) {
		for (const item of file.items) {
			const slot = best.get(item.key) ?? {};
			if (item.pinned && beats({ w: item.pinned, device: file.device }, slot.pinned)) slot.pinned = { w: item.pinned, device: file.device };
			if (item.archived && beats({ w: item.archived, device: file.device }, slot.archived)) slot.archived = { w: item.archived, device: file.device };
			if (item.rank && beats({ w: item.rank, device: file.device }, slot.rank)) slot.rank = { w: item.rank, device: file.device };
			best.set(item.key, slot);
		}
	}
	const out = new Map<string, ResolvedItem>();
	for (const [key, s] of best) {
		const resolved: ResolvedItem = {
			pinned: s.pinned?.w.v ?? false,
			archived: s.archived?.w.v ?? false,
			stamps: { pinned: s.pinned?.w.at ?? 0, archived: s.archived?.w.at ?? 0, rank: s.rank?.w.at ?? 0 },
		};
		if (s.rank) resolved.rank = s.rank.w.v;
		out.set(key, resolved);
	}
	return out;
}

// ------------------------------------------------------------------ changes

export type LibraryOp =
	| { kind: "pinned" | "archived"; key: string; value: boolean }
	| { kind: "rank"; key: string; value: number };

/**
 * Applies changes to this device's file. `merged` is what every device's files say now: a change that equals it is not
 * written, and a written field takes a time later than both the merged one and this device's own previous one.
 */
export function applyLibraryOps(own: LibraryStateFile, merged: LibraryMap, ops: readonly LibraryOp[], now: number): LibraryStateFile {
	const items = new Map(own.items.map((i) => [i.key, { ...i }]));
	for (const op of ops) {
		const seen = merged.get(op.key);
		if (op.kind === "rank") {
			if (!isRank(op.value) || seen?.rank === op.value) continue;
		} else if ((seen?.[op.kind] ?? false) === op.value) continue;
		const item = items.get(op.key) ?? { key: op.key };
		const ownAt = item[op.kind]?.at ?? 0;
		const at = Math.max(now, (seen?.stamps[op.kind] ?? 0) + 1, ownAt + 1);
		if (op.kind === "rank") item.rank = { v: op.value, at };
		else item[op.kind] = { v: op.value, at };
		items.set(op.key, item);
	}
	return { ...own, items: [...items.values()] };
}

// ------------------------------------------------------------------ order

/** Notebooks never placed by hand first (in the order given), then the placed ones by rank (a tie goes to the key). */
export function rankOrder<E>(items: readonly E[], keyOf: (e: E) => string, rankOf: (key: string) => number | undefined): E[] {
	const unranked: E[] = [];
	const ranked: Array<{ e: E; key: string; rank: number }> = [];
	for (const e of items) {
		const key = keyOf(e);
		const rank = rankOf(key);
		if (rank === undefined) unranked.push(e);
		else ranked.push({ e, key, rank });
	}
	ranked.sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return [...unranked, ...ranked.map((r) => r.e)];
}

export interface ArrangeOptions {
	/** Order by hand (rank) inside each group; otherwise the given order is kept. */
	manual: boolean;
	/** Put the pinned notebooks first, as a group of their own. */
	pinnedFirst: boolean;
}

/** Splits a list that is already in its base order into the pinned group and the rest, each in manual order when asked. */
export function arrangeEntries<E>(entries: readonly E[], keyOf: (e: E) => string, state: LibraryMap, o: ArrangeOptions): { pinned: E[]; rest: E[] } {
	const pinned: E[] = [];
	const rest: E[] = [];
	for (const e of entries) (o.pinnedFirst && state.get(keyOf(e))?.pinned ? pinned : rest).push(e);
	if (!o.manual) return { pinned, rest };
	const rankOf = (key: string) => state.get(key)?.rank;
	return { pinned: rankOrder(pinned, keyOf, rankOf), rest: rankOrder(rest, keyOf, rankOf) };
}

/**
 * The rank changes that put `key` at `toIndex` of the list `order` (the keys of one group as shown now). One rank in the
 * middle of its neighbours when that gives the wanted order; otherwise the whole list is numbered afresh (and only the
 * ranks that change are returned). Empty when nothing moves.
 */
export function planMove(order: readonly string[], key: string, toIndex: number, rankOf: (key: string) => number | undefined): Array<{ key: string; rank: number }> {
	const from = order.indexOf(key);
	if (from < 0) return [];
	const target = Math.max(0, Math.min(order.length - 1, Math.trunc(toIndex)));
	if (target === from) return [];
	const wanted = order.filter((k) => k !== key);
	wanted.splice(target, 0, key);

	const prev = target > 0 ? wanted[target - 1] : undefined;
	const next = target < wanted.length - 1 ? wanted[target + 1] : undefined;
	const pr = prev === undefined ? undefined : rankOf(prev);
	const nr = next === undefined ? undefined : rankOf(next);
	let candidate: number | undefined;
	if (pr !== undefined && nr !== undefined) {
		const mid = (pr + nr) / 2;
		if (mid > pr && mid < nr) candidate = mid;
	} else if (pr !== undefined && next === undefined) candidate = pr + RANK_STEP;
	else if (nr !== undefined && pr === undefined) candidate = nr - RANK_STEP;
	if (candidate !== undefined) {
		const cand = candidate;
		const shown = rankOrder(wanted, (k) => k, (k) => (k === key ? cand : rankOf(k)));
		if (shown.every((k, i) => k === wanted[i])) return [{ key, rank: cand }];
	}
	const out: Array<{ key: string; rank: number }> = [];
	wanted.forEach((k, i) => {
		const rank = (i + 1) * RANK_STEP;
		if (rankOf(k) !== rank) out.push({ key: k, rank });
	});
	return out;
}
