/**
 * Saved collections (roadmap #120): named rules over the library, combined with AND. Pure: no 'obsidian'.
 *
 * Two parts:
 * - Rule evaluation (`matchesRules`, `filterByRules`, `countMatches`): tags (any / all), a folder (with its subfolders), a
 *   period on the modified or created time (last N days, or a date range), favourite, and "has a PDF".
 * - The sidecar file (`_meta/collections-<device>.json`): **one file per device**, like `library-<device>.json` and
 *   `folders-<device>.json`, rather than one shared `collections.json`. A device only writes its own file, so two devices
 *   syncing through Drive or OneDrive never write the same file and the sync service has nothing to conflict on; reading
 *   merges every device's file. Per collection (by id) the latest `at` wins, a tie goes to the larger device id; a deleted
 *   collection is kept as a tombstone (`deleted: true`) so the delete wins over an older copy on another device.
 *
 * Lenient reading: a collection this version cannot make sense of is kept in `unknown` and written back as it was; fields
 * of a collection or of its rules that this version does not know are kept (`extra`, `ruleExtra`). A file that cannot be
 * read is never "fixed" (collections-store.ts never overwrites it).
 */
import { tagAncestors } from "../model/tags";
import { isInside, normalizeText, type LibraryEntry } from "./index";

export const COLLECTIONS_FORMAT = "obsidian-notebook-collections";
export const COLLECTIONS_VERSION = 1;
/** `_meta/collections-<device>.json` */
export const COLLECTIONS_PREFIX = "collections";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const COLLECTION_NAME_MAX = 40;
export const COLLECTIONS_MAX = 50;
export const PERIOD_DAYS = [7, 30] as const;

export type PeriodField = "modified" | "created";
export type CollectionPeriod =
	| { field: PeriodField; kind: "days"; days: number }
	/** `from` and `to` are times (ms): the start of the first day and the end of the last one, inclusive; either may be open. */
	| { field: PeriodField; kind: "range"; from?: number; to?: number };

export interface CollectionRules {
	/** Tags to look for (a nested tag also matches under its parents: `math` matches `math/algebra`). */
	tags?: string[];
	/** `any` (default): at least one of the tags; `all`: every one. */
	tagMode?: "any" | "all";
	/** A folder path; the notebooks in it and in its subfolders. */
	folder?: string;
	period?: CollectionPeriod;
	/** Starred or pinned (what the Favourites collection means). */
	favourite?: boolean;
	/** `yes`: has pages with a PDF background; `no`: has none. */
	pdf?: "yes" | "no";
}

export interface SavedCollection {
	id: string;
	name: string;
	rules: CollectionRules;
	/** Palette colour (#rrggbb), optional. */
	color?: string;
	/** When (ms since epoch) it was last changed. */
	at: number;
	/** Fields of the collection this version does not know, written back as they were. */
	extra?: Record<string, unknown>;
	/** Fields of the rules this version does not know. */
	ruleExtra?: Record<string, unknown>;
}

// ------------------------------------------------------------------ evaluation

export interface RuleContext {
	now: number;
	/** Pinned in the library: counts as a favourite (like the Favourites collection). */
	pinned?: (e: LibraryEntry) => boolean;
}

const tagKey = (t: string): string => normalizeText(t.trim().replace(/^#/, ""));

/** Whether the rules constrain anything. */
export function hasRules(r: CollectionRules): boolean {
	return !!((r.tags && r.tags.length > 0) || r.folder || r.period || r.favourite !== undefined || r.pdf);
}

function entryTagKeys(e: LibraryEntry): Set<string> {
	const keys = new Set<string>();
	for (const tag of [...e.tags, ...(e.pageTags ?? []).flatMap((p) => p.tags)]) {
		for (const x of [...tagAncestors(tag), tag]) keys.add(tagKey(x));
	}
	return keys;
}

/** Whether a notebook meets every rule. No rules: every notebook. */
export function matchesRules(r: CollectionRules, e: LibraryEntry, c: RuleContext): boolean {
	if (r.folder && !isInside(e.path, r.folder)) return false;
	if (r.tags && r.tags.length > 0) {
		const have = entryTagKeys(e);
		const want = r.tags.map(tagKey).filter(Boolean);
		if (want.length > 0 && !(r.tagMode === "all" ? want.every((k) => have.has(k)) : want.some((k) => have.has(k)))) return false;
	}
	if (r.favourite !== undefined && (e.favorite || (c.pinned?.(e) ?? false)) !== r.favourite) return false;
	if (r.pdf && ((e.pdfPages ?? 0) > 0) !== (r.pdf === "yes")) return false;
	const p = r.period;
	if (p) {
		const at = p.field === "created" ? e.created : e.modified;
		if (p.kind === "days") {
			if (!(at >= c.now - p.days * DAY_MS)) return false;
		} else {
			if (p.from !== undefined && !(at >= p.from)) return false;
			if (p.to !== undefined && !(at <= p.to)) return false;
		}
	}
	return true;
}

export function filterByRules<E extends LibraryEntry>(r: CollectionRules, entries: readonly E[], c: RuleContext): E[] {
	return entries.filter((e) => matchesRules(r, e, c));
}

export function countMatches(r: CollectionRules, entries: readonly LibraryEntry[], c: RuleContext): number {
	let n = 0;
	for (const e of entries) if (matchesRules(r, e, c)) n++;
	return n;
}

/** Start and end (ms, local time) of the day a `yyyy-mm-dd` string names; null when it is not a date. */
export function dayBounds(ymd: string): { start: number; end: number } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
	if (!m) return null;
	const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
	const start = new Date(y, mo, d, 0, 0, 0, 0);
	if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) return null;
	return { start: start.getTime(), end: new Date(y, mo, d, 23, 59, 59, 999).getTime() };
}

/** `yyyy-mm-dd` of a time (local), for a date input. */
export function ymdOf(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ rules: cleaning

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const KNOWN_RULES = new Set(["tags", "tagMode", "folder", "period", "favourite", "pdf"]);

function readPeriod(v: unknown): CollectionPeriod | undefined {
	if (!isObject(v)) return undefined;
	const field: PeriodField = v.field === "created" ? "created" : "modified";
	if (v.kind === "days" && finite(v.days) && v.days >= 1 && v.days <= 3650) return { field, kind: "days", days: Math.trunc(v.days) };
	if (v.kind === "range") {
		const from = finite(v.from) ? v.from : undefined;
		const to = finite(v.to) ? v.to : undefined;
		if (from === undefined && to === undefined) return undefined;
		if (from !== undefined && to !== undefined && from > to) return { field, kind: "range", from: to, to: from };
		return { field, kind: "range", ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
	}
	return undefined;
}

/** Rules read from anything: unusable parts are dropped, the unknown ones are returned in `extra`. */
export function readRules(v: unknown): { rules: CollectionRules; extra: Record<string, unknown> } {
	const rules: CollectionRules = {};
	const extra: Record<string, unknown> = {};
	if (!isObject(v)) return { rules, extra };
	for (const [k, x] of Object.entries(v)) if (!KNOWN_RULES.has(k)) extra[k] = x;
	if (Array.isArray(v.tags)) {
		const seen = new Set<string>();
		const tags: string[] = [];
		for (const raw of v.tags) {
			const tag = typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
			const key = tagKey(tag);
			if (tag && !seen.has(key)) {
				seen.add(key);
				tags.push(tag);
			}
		}
		if (tags.length > 0) rules.tags = tags;
	}
	if (v.tagMode === "all" || v.tagMode === "any") rules.tagMode = v.tagMode;
	if (typeof v.folder === "string" && v.folder.trim() !== "") rules.folder = v.folder.trim().replace(/\/+$/, "");
	const period = readPeriod(v.period);
	if (period) rules.period = period;
	if (typeof v.favourite === "boolean") rules.favourite = v.favourite;
	if (v.pdf === "yes" || v.pdf === "no") rules.pdf = v.pdf;
	return { rules, extra };
}

/** The rules as stored: only what constrains something. */
export function cleanRules(r: CollectionRules): CollectionRules {
	return readRules(r).rules;
}

/** A name that fits: trimmed, one line, at most `COLLECTION_NAME_MAX` characters. */
export function cleanName(name: string): string {
	return name.replace(/\s+/g, " ").trim().slice(0, COLLECTION_NAME_MAX);
}

/** A fresh id that is not in `taken`. */
export function newCollectionId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		const id = `c${Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0")}`;
		if (!taken.has(id)) return id;
	}
}

// ------------------------------------------------------------------ the file

interface StoredCollection extends SavedCollection {
	deleted?: boolean;
}

export interface CollectionsFile {
	version: number;
	device: string;
	items: StoredCollection[];
	/** Items this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type CollectionsParse =
	| { ok: true; data: CollectionsFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

export function emptyCollections(device: string): CollectionsFile {
	return { version: COLLECTIONS_VERSION, device, items: [], unknown: [] };
}

const KNOWN_ITEM = new Set(["id", "name", "rules", "color", "at", "deleted"]);
const HEX = /^#[0-9a-fA-F]{6}$/;

function readItem(v: unknown): StoredCollection | null {
	if (!isObject(v) || typeof v.id !== "string" || v.id === "" || typeof v.name !== "string" || !finite(v.at)) return null;
	if (v.rules !== undefined && !isObject(v.rules)) return null;
	const { rules, extra: ruleExtra } = readRules(v.rules);
	const extra: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) if (!KNOWN_ITEM.has(k)) extra[k] = x;
	const item: StoredCollection = { id: v.id, name: v.name, rules, at: v.at };
	if (typeof v.color === "string" && HEX.test(v.color)) item.color = v.color;
	if (v.deleted === true) item.deleted = true;
	if (Object.keys(extra).length > 0) item.extra = extra;
	if (Object.keys(ruleExtra).length > 0) item.ruleExtra = ruleExtra;
	return item;
}

/** Reads a device file. A file that is not ours, is empty (a sync may not have finished) or is newer is reported, never "fixed". */
export function parseCollections(text: string, device: string): CollectionsParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== COLLECTIONS_FORMAT) return { ok: false, reason: "format", message: "not a collections file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > COLLECTIONS_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const byId = new Map<string, StoredCollection>();
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
	return { ok: true, data: { version: COLLECTIONS_VERSION, device: named, items: [...byId.values()], unknown } };
}

function itemJson(i: StoredCollection): string {
	const o: Record<string, unknown> = { ...(i.extra ?? {}), id: i.id, name: i.name, rules: { ...(i.ruleExtra ?? {}), ...i.rules }, at: i.at };
	if (i.color) o.color = i.color;
	if (i.deleted) o.deleted = true;
	return JSON.stringify(o);
}

/** Deterministic text: one collection per line, sorted by id. */
export function serializeCollections(data: CollectionsFile): string {
	const head = `{"format":${JSON.stringify(COLLECTIONS_FORMAT)},"version":${COLLECTIONS_VERSION},"device":${JSON.stringify(data.device)},"items":[`;
	const lines = [
		...[...data.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(itemJson),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** What every device's files say: per id, the latest wins (a tie goes to the larger device id). Deleted ones stay as tombstones. */
export type CollectionsMap = ReadonlyMap<string, StoredCollection>;

export function mergeCollectionFiles(files: readonly CollectionsFile[]): Map<string, StoredCollection> {
	const best = new Map<string, { item: StoredCollection; device: string }>();
	for (const f of files) {
		for (const item of f.items) {
			const cur = best.get(item.id);
			if (!cur || item.at > cur.item.at || (item.at === cur.item.at && f.device > cur.device)) best.set(item.id, { item, device: f.device });
		}
	}
	return new Map([...best].map(([id, b]) => [id, b.item]));
}

/** The live collections of a merged map, in the order they were made (by id of creation time is unknown: by name, then id). */
export function liveCollections(map: CollectionsMap): SavedCollection[] {
	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
	return [...map.values()].filter((c) => !c.deleted).map(({ deleted: _d, ...c }) => c).sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

/** A deleted collection is remembered this long (days) in the file that deleted it; after that the entry is dropped when the file is rewritten. */
export const TOMBSTONE_DAYS = 90;

/** `file` without the tombstones older than `TOMBSTONE_DAYS` at `now`. Live collections and unknown items are never dropped. */
export function pruneTombstones(file: CollectionsFile, now: number): CollectionsFile {
	const limit = now - TOMBSTONE_DAYS * DAY_MS;
	const items = file.items.filter((i) => !(i.deleted === true && i.at < limit));
	return items.length === file.items.length ? file : { ...file, items };
}

export type CollectionOp =
	| { kind: "upsert"; id: string; name: string; rules: CollectionRules; color?: string | null }
	| { kind: "delete"; id: string };

/**
 * Applies changes to this device's file. `merged` is what every device's files say now: a written collection takes a time
 * later than both the merged one and this device's own previous one; unknown fields of the merged winner are carried over.
 */
export function applyCollectionOps(own: CollectionsFile, merged: CollectionsMap, ops: readonly CollectionOp[], now: number): CollectionsFile {
	const items = new Map(own.items.map((i) => [i.id, i]));
	for (const op of ops) {
		const seen = merged.get(op.id);
		const mine = items.get(op.id);
		const at = Math.max(now, (seen?.at ?? 0) + 1, (mine?.at ?? 0) + 1);
		if (op.kind === "delete") {
			if (!seen || seen.deleted) continue;
			items.set(op.id, { id: op.id, name: seen.name, rules: seen.rules, at, deleted: true, ...(seen.color ? { color: seen.color } : {}), ...(seen.extra ? { extra: seen.extra } : {}), ...(seen.ruleExtra ? { ruleExtra: seen.ruleExtra } : {}) });
			continue;
		}
		const name = cleanName(op.name);
		if (name === "") continue;
		const rules = cleanRules(op.rules);
		const color = op.color === null ? undefined : op.color ?? seen?.color;
		const item: StoredCollection = { id: op.id, name, rules, at };
		if (color && HEX.test(color)) item.color = color;
		if (seen?.extra) item.extra = seen.extra;
		if (seen?.ruleExtra) item.ruleExtra = seen.ruleExtra;
		items.set(op.id, item);
	}
	return { ...own, items: [...items.values()] };
}
