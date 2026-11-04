/**
 * Board statuses (0.15, roadmap #161): the column a notebook is in on the library's Board view (To do, In progress, Done,
 * To print, or any column the user added). Pure: no 'obsidian'.
 *
 * Nothing about this is stored in a notebook (no format change). It follows the folder pins and the library state: small
 * JSON files in the notebooks folder's reserved `_meta` folder, **one file per device** (`board-<device>.json`). A device
 * only ever writes its own file, so two devices syncing through any service never write the same file and there is
 * nothing to conflict on; reading merges every device's file.
 *
 * Merge rule (last writer wins, per notebook): the status carries the time it was set; the latest wins, a tie goes to the
 * larger device id. A status set to `null` is "cleared" (the notebook is back in the first column). A device writing a
 * status takes a time later than the one it has just read for that notebook, so clock skew does not make a change lose
 * to an older one.
 *
 * Notebooks are keyed like the library state: their document id (`id:<id>`, which survives renames and moves on any
 * device), or their path (`path:<path>`) while the id is not known. A status stored under the path key is still found
 * for a notebook whose id became known later (`statusOf`).
 *
 * Reading is lenient: an item this version cannot read is kept as it was and written back, and so are the fields it does not
 * know (of an item and of the file). A file that cannot be read is never overwritten.
 */
import { EMPTY_FILE_MESSAGE } from "../storage/device-files";
import { notebookKey } from "./library-state";

export const BOARD_FORMAT = "obsidian-notebook-board";
export const BOARD_VERSION = 1;
/** `_meta/board-<device>.json` */
export const BOARD_PREFIX = "board";
/** Longest status id. */
export const STATUS_ID_MAX = 64;

export interface Stamped {
	/** The status id; null = cleared. */
	v: string | null;
	/** When (ms since epoch) the status was set. */
	at: number;
}

export interface BoardItem {
	key: string;
	status: Stamped;
	/** Fields of the item this version does not know, written back as they were. */
	extra: Record<string, unknown>;
}

export interface BoardFile {
	version: number;
	device: string;
	items: BoardItem[];
	/** Items this version does not understand: kept and written back as they were. */
	unknown: unknown[];
	/** Top-level fields this version does not know. */
	extra: Record<string, unknown>;
}

export type BoardParse =
	| { ok: true; data: BoardFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

/** The merged status of one notebook. */
export interface ResolvedStatus {
	status: string | null;
	/** When it was set (0 = never): the next change takes a later time. */
	at: number;
}

export type BoardMap = ReadonlyMap<string, ResolvedStatus>;

export function emptyBoard(device: string): BoardFile {
	return { version: BOARD_VERSION, device, items: [], unknown: [], extra: {} };
}

/** Whether `v` can be stored as a status id. */
export function validStatusId(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= STATUS_ID_MAX && [...v].every((ch) => ch.charCodeAt(0) >= 32);
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readItem(v: unknown): BoardItem | null {
	if (!isObject(v) || typeof v.key !== "string" || v.key === "") return null;
	const s = v.status;
	if (!isObject(s) || typeof s.at !== "number" || !Number.isFinite(s.at)) return null;
	if (s.v !== null && !validStatusId(s.v)) return null;
	const extra: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(v)) if (k !== "key" && k !== "status") extra[k] = val;
	return { key: v.key, status: { v: s.v, at: s.at }, extra };
}

/** One item per key (the later status). */
function dedupe(items: readonly BoardItem[]): BoardItem[] {
	const by = new Map<string, BoardItem>();
	for (const item of items) {
		const old = by.get(item.key);
		if (!old || item.status.at >= old.status.at) by.set(item.key, old ? { ...item, extra: { ...old.extra, ...item.extra } } : item);
	}
	return [...by.values()];
}

/**
 * Reads a device file. A file that is not ours or comes from a newer version is reported, never "fixed". An existing empty
 * file is not "nothing is set": a sync app may not have finished downloading it, so it is reported too.
 */
export function parseBoard(text: string, device: string): BoardParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_FILE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== BOARD_FORMAT) return { ok: false, reason: "format", message: "not a board file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > BOARD_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const items: BoardItem[] = [];
	const unknown: unknown[] = [];
	for (const v of raw.items) {
		const item = readItem(v);
		if (item) items.push(item);
		else unknown.push(v);
	}
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) if (k !== "format" && k !== "version" && k !== "device" && k !== "items") extra[k] = v;
	const named = typeof raw.device === "string" && /^[0-9a-f]{8}$/.test(raw.device) ? raw.device : device;
	return { ok: true, data: { version: BOARD_VERSION, device: named, items: dedupe(items), unknown, extra } };
}

/** Deterministic text: one item per line, sorted by key; unknown fields and items are written back. */
export function serializeBoard(data: BoardFile): string {
	const top = Object.entries(data.extra).map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`).join("");
	const head = `{"format":${JSON.stringify(BOARD_FORMAT)},"version":${BOARD_VERSION},"device":${JSON.stringify(data.device)}${top},"items":[`;
	const line = (i: BoardItem) => JSON.stringify({ key: i.key, status: { v: i.status.v, at: i.status.at }, ...i.extra });
	const lines = [
		...[...data.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(line),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** Every device's files together: per notebook, the latest status wins (a tie goes to the larger device id). */
export function mergeBoardFiles(files: readonly BoardFile[]): Map<string, ResolvedStatus> {
	const best = new Map<string, { s: Stamped; device: string }>();
	for (const file of files) {
		for (const item of file.items) {
			const cur = best.get(item.key);
			if (!cur || item.status.at > cur.s.at || (item.status.at === cur.s.at && file.device > cur.device)) best.set(item.key, { s: item.status, device: file.device });
		}
	}
	const out = new Map<string, ResolvedStatus>();
	for (const [key, w] of best) out.set(key, { status: w.s.v, at: w.s.at });
	return out;
}

/** The status of a notebook (its id key, else the path key it was stored under before its id was known), or null = none set. */
export function statusOf(map: BoardMap, key: string, path?: string): string | null {
	const own = map.get(key);
	if (own) return own.status;
	if (path !== undefined && !key.startsWith("path:")) return map.get(notebookKey({ path }))?.status ?? null;
	return null;
}

// ------------------------------------------------------------------ changes

export interface BoardOp {
	key: string;
	/** The new status id; null clears it. */
	status: string | null;
	/** The path key the notebook may have been stored under before its id was known: read as the current value and replaced. */
	path?: string;
}

/**
 * Applies changes to this device's file. `merged` is what every device's files say now: a change that equals it is not
 * written, and a written status takes a time later than both the merged one and this device's own previous one. Invalid
 * statuses are skipped.
 */
export function applyBoardOps(own: BoardFile, merged: BoardMap, ops: readonly BoardOp[], now: number): BoardFile {
	const items = new Map(own.items.map((i) => [i.key, { ...i, status: { ...i.status } }]));
	for (const op of ops) {
		if (op.status !== null && !validStatusId(op.status)) continue;
		const seen = merged.get(op.key);
		const current = statusOf(merged, op.key, op.path);
		if (current === op.status) continue;
		const item = items.get(op.key) ?? { key: op.key, status: { v: null, at: 0 }, extra: {} };
		const at = Math.max(now, (seen?.at ?? 0) + 1, item.status.at + 1);
		item.status = { v: op.status, at };
		items.set(op.key, item);
	}
	return { ...own, items: [...items.values()] };
}

// ------------------------------------------------------------------ pruning

/** A status of a notebook that is not in the library is kept at least this long (a sync that is late, a restore from the Trash). */
export const BOARD_PRUNE_GRACE_MS = 30 * 86_400_000;

/**
 * This device's file without what no longer says anything (only its own items are ever touched; other devices' files are
 * read to decide, never changed):
 * - a **cleared** status (`v: null`) that no other device's file contradicts with a status of its own (it would come back
 *   if the clear were dropped) and that does not hide a status stored under the path key (`statusOf` falls back to it);
 * - when `live` is given (the library has read every notebook, so it is the complete set of state keys), a status of a notebook that is not in it and
 *   was set more than BOARD_PRUNE_GRACE_MS ago. A notebook deleted for good no longer keeps a line in the file.
 * Returns `own` itself when nothing is dropped.
 */
export function pruneBoardFile(own: BoardFile, others: readonly BoardFile[], live: ReadonlySet<string> | null, now: number): BoardFile {
	const named = (key: string): boolean => others.some((f) => f.items.some((i) => i.key === key && i.status.v !== null));
	const pathStatuses = [own, ...others].some((f) => f.items.some((i) => i.key.startsWith("path:") && i.status.v !== null));
	const keep = own.items.filter((i) => {
		if (i.status.v === null) return named(i.key) || (pathStatuses && !i.key.startsWith("path:"));
		return live === null || live.has(i.key) || now - i.status.at <= BOARD_PRUNE_GRACE_MS;
	});
	return keep.length === own.items.length ? own : { ...own, items: keep };
}
