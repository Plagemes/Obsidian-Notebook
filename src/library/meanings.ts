/**
 * Per-notebook colour meanings (0.22, roadmap #101): a notebook may carry its own legend instead of the global one. It is
 * **not** part of the notebook file (the document format is untouched): it lives in `_meta/meanings-<device>.json`, **one file
 * per device**, like the quick tabs (`quicktabs.ts`): a device only writes its own file; reading merges every device's file.
 * Per notebook (`scope`, the document id) the latest `at` wins, a tie goes to the larger device id; removing the override is a
 * tombstone (`deleted: true`) so it wins over an older copy elsewhere. Pure: no 'obsidian'.
 *
 * Lenient reading: an entry this version cannot make sense of is kept in `unknown` and written back as it was; fields of an
 * entry it does not know are kept (`extra`). A file that cannot be read is never "fixed" (meanings-store.ts never overwrites it).
 */
import { parseLegend, type Meaning } from "../model/colour-meaning";

export const MEANINGS_FORMAT = "obsidian-notebook-meanings";
export const MEANINGS_VERSION = 1;
/** `_meta/meanings-<device>.json` */
export const MEANINGS_PREFIX = "meanings";
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A removed override is remembered this long (days) in the file that removed it. */
export const TOMBSTONE_DAYS = 90;

export interface StoredMeanings {
	/** The id of the notebook (document) this legend belongs to. */
	scope: string;
	legend: Meaning[];
	/** When (ms since epoch) it was last changed. */
	at: number;
	deleted?: boolean;
	extra?: Record<string, unknown>;
	/**
	 * Review fix (D9): the legend list exactly as it was read. Entries this version rejects and fields of an entry it does not know
	 * are written back unchanged, until this device edits the legend (a new entry has no `rawLegend`). Used only while `legend`
	 * is still what reading it gives, so it can never write something stale.
	 */
	rawLegend?: unknown[];
}

export interface MeaningsFile {
	version: number;
	device: string;
	items: StoredMeanings[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type MeaningsParse =
	| { ok: true; data: MeaningsFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

export type MeaningsMap = ReadonlyMap<string, StoredMeanings>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function emptyMeanings(device: string): MeaningsFile {
	return { version: MEANINGS_VERSION, device, items: [], unknown: [] };
}

const KNOWN = new Set(["scope", "legend", "at", "deleted"]);

function readItem(v: unknown): StoredMeanings | null {
	if (!isObject(v) || typeof v.scope !== "string" || v.scope === "" || !finite(v.at) || !Array.isArray(v.legend)) return null;
	const extra: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) if (!KNOWN.has(k)) extra[k] = x;
	const item: StoredMeanings = { scope: v.scope, legend: parseLegend(v.legend), at: v.at };
	if (v.deleted === true) item.deleted = true;
	if (Object.keys(extra).length > 0) item.extra = extra;
	item.rawLegend = v.legend;
	return item;
}

/** What is written for the legend: the list as read while it still means what this version understood of it, else the legend. */
function legendJson(i: StoredMeanings): unknown {
	if (i.rawLegend && JSON.stringify(parseLegend(i.rawLegend)) === JSON.stringify(i.legend)) return i.rawLegend;
	return i.legend;
}

/** Reads a device file. A file that is not ours, is empty (a sync may not have finished) or is newer is reported, never "fixed". */
export function parseMeanings(text: string, device: string): MeaningsParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== MEANINGS_FORMAT) return { ok: false, reason: "format", message: "not a colour meanings file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > MEANINGS_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const byScope = new Map<string, StoredMeanings>();
	const unknown: unknown[] = [];
	for (const v of raw.items) {
		const item = readItem(v);
		if (!item) unknown.push(v);
		else {
			const old = byScope.get(item.scope);
			if (!old || item.at >= old.at) byScope.set(item.scope, item);
		}
	}
	const named = typeof raw.device === "string" && /^[0-9a-f]{8}$/.test(raw.device) ? raw.device : device;
	return { ok: true, data: { version: MEANINGS_VERSION, device: named, items: [...byScope.values()], unknown } };
}

function itemJson(i: StoredMeanings): string {
	const o: Record<string, unknown> = { ...(i.extra ?? {}), scope: i.scope, legend: legendJson(i), at: i.at };
	if (i.deleted) o.deleted = true;
	return JSON.stringify(o);
}

/** Deterministic text: one notebook per line, sorted by scope. */
export function serializeMeanings(data: MeaningsFile): string {
	const head = `{"format":${JSON.stringify(MEANINGS_FORMAT)},"version":${MEANINGS_VERSION},"device":${JSON.stringify(data.device)},"items":[`;
	const lines = [
		...[...data.items].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)).map(itemJson),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** What every device's files say: per notebook, the latest wins (a tie goes to the larger device id). Removed ones stay as tombstones. */
export function mergeMeaningFiles(files: readonly MeaningsFile[]): Map<string, StoredMeanings> {
	const best = new Map<string, { item: StoredMeanings; device: string }>();
	for (const f of files) {
		for (const item of f.items) {
			const cur = best.get(item.scope);
			if (!cur || item.at > cur.item.at || (item.at === cur.item.at && f.device > cur.device)) best.set(item.scope, { item, device: f.device });
		}
	}
	return new Map([...best].map(([k, b]) => [k, b.item]));
}

/** The notebook's own legend, or null when it has none (it uses the global one). */
export function overrideOf(map: MeaningsMap, scope: string): Meaning[] | null {
	const e = map.get(scope);
	return e && !e.deleted ? e.legend.map((m) => ({ ...m })) : null;
}

/** `file` without the removed overrides older than `TOMBSTONE_DAYS` (kept while another device still holds a live one it does not win over). */
export function pruneMeaningTombstones(file: MeaningsFile, now: number, others: readonly MeaningsFile[] = [], othersComplete = true): MeaningsFile {
	const limit = now - TOMBSTONE_DAYS * DAY_MS;
	const stillHeld = (i: StoredMeanings): boolean => others.some((f) => f.items.some((o) => o.scope === i.scope && o.deleted !== true && o.at <= i.at));
	const items = file.items.filter((i) => !(i.deleted === true && i.at < limit && othersComplete && !stillHeld(i)));
	return items.length === file.items.length ? file : { ...file, items };
}

/** This device's file with the winning state of the notebooks it holds (a change made elsewhere is carried when it is rewritten). */
export function adoptMeaningWinners(own: MeaningsFile, merged: MeaningsMap): MeaningsFile {
	let changed = false;
	const items = own.items.map((i) => {
		const w = merged.get(i.scope);
		if (!w || w === i || !(w.at > i.at || (w.at === i.at && itemJson(w) !== itemJson(i)))) return i;
		changed = true;
		return w;
	});
	return changed ? { ...own, items } : own;
}

export type MeaningsOp =
	/** `legend` null removes the override. */
	| { kind: "set"; scope: string; legend: Meaning[] | null };

/** Applies changes to this device's file; a written entry takes a time later than the merged one and this device's previous one. */
export function applyMeaningOps(ownFile: MeaningsFile, merged: MeaningsMap, ops: readonly MeaningsOp[], now: number): MeaningsFile {
	const own = adoptMeaningWinners(ownFile, merged);
	const items = new Map(own.items.map((i) => [i.scope, i]));
	for (const op of ops) {
		const seen = merged.get(op.scope);
		const mine = items.get(op.scope);
		const base = seen && (!mine || seen.at >= mine.at) ? seen : mine;
		const at = Math.max(now, (seen?.at ?? 0) + 1, (mine?.at ?? 0) + 1);
		const next: StoredMeanings = { scope: op.scope, legend: op.legend ? parseLegend(op.legend) : [], at };
		if (op.legend === null) next.deleted = true;
		if (base?.extra) next.extra = base.extra;
		items.set(op.scope, next);
	}
	return { ...own, items: [...items.values()] };
}
