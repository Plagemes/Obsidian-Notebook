/**
 * Quick tabs (roadmap #227): pages pinned in a notebook (the formula sheet during a lecture) that are one tap away.
 * Pure: no 'obsidian'. The pins are **not** part of the notebook file (the document format is untouched): they live in
 * `_meta/quicktabs-<device>.json`, **one file per device**, like the saved collections (`collections.ts`): a device only
 * writes its own file, so two devices syncing through Drive or OneDrive never write the same file; reading merges every
 * device's file. Per pin (by id) the latest `at` wins, a tie goes to the larger device id; an unpinned pin is kept as a
 * tombstone (`deleted: true`) so the unpin wins over an older copy on another device.
 *
 * A pin belongs to a `scope` (the id of the notebook whose strip shows it) and points at a page by **page id** (so it
 * survives moving pages) in a notebook at `path` (the same notebook or another one, e.g. a formula-sheet notebook). `num`
 * (the page number when pinned) and `label` are only a fallback for showing it and for the page that is gone.
 *
 * Lenient reading: an entry this version cannot make sense of is kept in `unknown` and written back as it was; fields of an
 * entry that this version does not know are kept (`extra`). A file that cannot be read is never "fixed"
 * (quicktabs-store.ts never overwrites it).
 */

export const QUICKTABS_FORMAT = "obsidian-notebook-quicktabs";
export const QUICKTABS_VERSION = 1;
/** `_meta/quicktabs-<device>.json` */
export const QUICKTABS_PREFIX = "quicktabs";
/** Pins per notebook. */
export const QUICKTABS_MAX = 12;
export const QUICKTAB_LABEL_MAX = 24;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** An unpinned pin is remembered this long (days) in the file that unpinned it. */
export const TOMBSTONE_DAYS = 90;

export interface QuickTab {
	id: string;
	/** The id of the notebook (document) whose strip shows this tab. */
	scope: string;
	/** Vault path of the notebook the tab opens (may be the scope's own notebook, or another one). */
	path: string;
	pageId: string;
	/** The page number (1-based) when it was pinned: the place to land when the page is gone. */
	num: number;
	/** What the tab says (a bookmark title, or empty: "p. N"). */
	label?: string;
	/** Position in the strip (ascending; fractions allow moving one tab with one write). */
	order: number;
	/** When (ms since epoch) it was last changed. */
	at: number;
	extra?: Record<string, unknown>;
}

export interface StoredQuickTab extends QuickTab {
	deleted?: boolean;
}

export interface QuickTabsFile {
	version: number;
	device: string;
	items: StoredQuickTab[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type QuickTabsParse =
	| { ok: true; data: QuickTabsFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function emptyQuickTabs(device: string): QuickTabsFile {
	return { version: QUICKTABS_VERSION, device, items: [], unknown: [] };
}

/** A label that fits: one line, trimmed, at most `QUICKTAB_LABEL_MAX` characters. */
export function cleanLabel(label: string | undefined): string {
	return (label ?? "").replace(/\s+/g, " ").trim().slice(0, QUICKTAB_LABEL_MAX);
}

/** A fresh pin id that is not in `taken`. */
export function newQuickTabId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		const id = `q${Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0")}`;
		if (!taken.has(id)) return id;
	}
}

const KNOWN_ITEM = new Set(["id", "scope", "path", "pageId", "num", "label", "order", "at", "deleted"]);

function readItem(v: unknown): StoredQuickTab | null {
	if (!isObject(v) || typeof v.id !== "string" || v.id === "" || typeof v.scope !== "string" || v.scope === "" || typeof v.path !== "string" || v.path === "") return null;
	if (typeof v.pageId !== "string" || v.pageId === "" || !finite(v.at) || !finite(v.order)) return null;
	const extra: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) if (!KNOWN_ITEM.has(k)) extra[k] = x;
	const item: StoredQuickTab = { id: v.id, scope: v.scope, path: v.path, pageId: v.pageId, num: finite(v.num) && v.num >= 1 ? Math.trunc(v.num) : 1, order: v.order, at: v.at };
	const label = typeof v.label === "string" ? cleanLabel(v.label) : "";
	if (label) item.label = label;
	if (v.deleted === true) item.deleted = true;
	if (Object.keys(extra).length > 0) item.extra = extra;
	return item;
}

/** Reads a device file. A file that is not ours, is empty (a sync may not have finished) or is newer is reported, never "fixed". */
export function parseQuickTabs(text: string, device: string): QuickTabsParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== QUICKTABS_FORMAT) return { ok: false, reason: "format", message: "not a quick tabs file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > QUICKTABS_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.items)) return { ok: false, reason: "format", message: "items is not a list" };
	const byId = new Map<string, StoredQuickTab>();
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
	return { ok: true, data: { version: QUICKTABS_VERSION, device: named, items: [...byId.values()], unknown } };
}

function itemJson(i: StoredQuickTab): string {
	const o: Record<string, unknown> = { ...(i.extra ?? {}), id: i.id, scope: i.scope, path: i.path, pageId: i.pageId, num: i.num, order: i.order, at: i.at };
	if (i.label) o.label = i.label;
	if (i.deleted) o.deleted = true;
	return JSON.stringify(o);
}

/** Deterministic text: one pin per line, sorted by id. */
export function serializeQuickTabs(data: QuickTabsFile): string {
	const head = `{"format":${JSON.stringify(QUICKTABS_FORMAT)},"version":${QUICKTABS_VERSION},"device":${JSON.stringify(data.device)},"items":[`;
	const lines = [
		...[...data.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(itemJson),
		...data.unknown.map((u) => JSON.stringify(u)),
	];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** What every device's files say: per id, the latest wins (a tie goes to the larger device id). Unpinned ones stay as tombstones. */
export type QuickTabsMap = ReadonlyMap<string, StoredQuickTab>;

export function mergeQuickTabFiles(files: readonly QuickTabsFile[]): Map<string, StoredQuickTab> {
	const best = new Map<string, { item: StoredQuickTab; device: string }>();
	for (const f of files) {
		for (const item of f.items) {
			const cur = best.get(item.id);
			if (!cur || item.at > cur.item.at || (item.at === cur.item.at && f.device > cur.device)) best.set(item.id, { item, device: f.device });
		}
	}
	return new Map([...best].map(([id, b]) => [id, b.item]));
}

const byOrder = (a: QuickTab, b: QuickTab): number => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function live(map: QuickTabsMap): QuickTab[] {
	return [...map.values()].filter((t) => !t.deleted).map(({ deleted: _d, ...t }) => t);
}

/** The live tabs of the notebook `scope`, in strip order. */
export function tabsFor(map: QuickTabsMap, scope: string): QuickTab[] {
	return live(map).filter((t) => t.scope === scope).sort(byOrder);
}

/** Every live tab (any notebook), in strip order. */
export function liveQuickTabs(map: QuickTabsMap): QuickTab[] {
	return live(map).sort(byOrder);
}

/** The live tab of `scope` that already points at this page, if any (pinning twice does nothing). */
export function findPin(map: QuickTabsMap, scope: string, path: string, pageId: string): QuickTab | null {
	return tabsFor(map, scope).find((t) => t.path === path && t.pageId === pageId) ?? null;
}

/**
 * `file` without the tombstones older than `TOMBSTONE_DAYS` at `now`. Live pins and unknown entries are never dropped. A
 * tombstone is kept while another device's file still holds a live pin with that id that it does not win over (that pin
 * would come back): `others` are the other devices' files, and `othersComplete` is false when one of them could not be read
 * (then nothing is pruned, because what it holds is not known).
 */
export function pruneQuickTabTombstones(file: QuickTabsFile, now: number, others: readonly QuickTabsFile[] = [], othersComplete = true): QuickTabsFile {
	const limit = now - TOMBSTONE_DAYS * DAY_MS;
	const stillHeld = (i: StoredQuickTab): boolean => others.some((f) => f.items.some((o) => o.id === i.id && o.deleted !== true && o.at <= i.at));
	const items = file.items.filter((i) => !(i.deleted === true && i.at < limit && othersComplete && !stillHeld(i)));
	return items.length === file.items.length ? file : { ...file, items };
}

/**
 * This device's file with the winning state of the ids it holds: an unpin made on another device is written into this file
 * too (when it is rewritten), so the pin cannot come back from here once the other device forgets its tombstone.
 */
export function adoptQuickTabWinners(own: QuickTabsFile, merged: QuickTabsMap): QuickTabsFile {
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

/** The order for a tab put at the end of `tabs`. */
export function orderAtEnd(tabs: readonly QuickTab[]): number {
	return tabs.length === 0 ? 0 : Math.max(...tabs.map((t) => t.order)) + 1;
}

/**
 * Moves the tab `id` so that it ends up at index `to` (0-based, counted in the list as it is afterwards): the new `order`
 * values to write. Normally one value (between its new neighbours); when the neighbours are too close to split, every tab
 * is numbered again (0, 1, 2, ...). Empty when nothing would change or `id` is not in `tabs`.
 */
export function planMove(tabs: readonly QuickTab[], id: string, to: number): Array<{ id: string; order: number }> {
	const sorted = [...tabs].sort(byOrder);
	const from = sorted.findIndex((t) => t.id === id);
	if (from < 0) return [];
	const target = Math.max(0, Math.min(sorted.length - 1, Math.trunc(to)));
	if (target === from) return [];
	const rest = sorted.filter((t) => t.id !== id);
	const prev = rest[target - 1]?.order;
	const next = rest[target]?.order;
	let order: number;
	if (prev !== undefined && next !== undefined) order = (prev + next) / 2;
	else if (prev !== undefined) order = prev + 1;
	else if (next !== undefined) order = next - 1;
	else order = 0;
	const crowded = (prev !== undefined && !(order > prev)) || (next !== undefined && !(order < next));
	if (!crowded) return [{ id, order }];
	const ids = rest.map((t) => t.id);
	ids.splice(target, 0, id);
	return ids.map((x, i) => ({ id: x, order: i }));
}

// ------------------------------------------------------------------ resolving a tab

export type TabTarget =
	/** In the notebook in view and the page is there: `index` (0-based). */
	| { kind: "here"; index: number }
	/** The page is gone from the notebook in view: lands on `index`, the nearest page by the number it had. */
	| { kind: "gone"; index: number }
	/** In another notebook: opening it switches the notebook (its page is found once it is open). */
	| { kind: "other" };

/** Where a tap on `tab` goes, given the notebook in view (`path` and the ids of its pages in order). */
export function resolveTab(tab: QuickTab, view: { path: string | null; pageIds: readonly string[] }): TabTarget {
	if (tab.path !== view.path) return { kind: "other" };
	const index = view.pageIds.indexOf(tab.pageId);
	if (index >= 0) return { kind: "here", index };
	return { kind: "gone", index: Math.max(0, Math.min(view.pageIds.length - 1, tab.num - 1)) };
}

/** What a tab says: its label, else "p. N" (N: the page's number now when known, else the number it had). */
export function tabText(tab: QuickTab, index: number | null, page: (n: number) => string): string {
	return tab.label ? tab.label : page(index !== null ? index + 1 : tab.num);
}

// ------------------------------------------------------------------ renames

/**
 * Collects the renames of a burst (a folder renamed with N notebooks in it fires N events) and hands them over together, once
 * `delay` ms after the last one, in the order they happened, so the store reads and writes its files once for all of them.
 * `schedule` starts a timer and returns what cancels it (tests give a fake one).
 */
export class RenameBatcher {
	private pending: Array<{ from: string; to: string }> = [];
	private cancel: (() => void) | null = null;

	constructor(
		private readonly flushTo: (renames: Array<{ from: string; to: string }>) => void,
		private readonly schedule: (fn: () => void, ms: number) => () => void,
		private readonly delay = 400,
	) {}

	add(from: string, to: string): void {
		if (from === to) return;
		this.pending.push({ from, to });
		this.cancel?.();
		this.cancel = this.schedule(() => this.flush(), this.delay);
	}

	/** Hands over what is waiting now (also used when the plugin unloads). */
	flush(): void {
		this.cancel?.();
		this.cancel = null;
		const renames = this.pending;
		this.pending = [];
		if (renames.length > 0) this.flushTo(renames);
	}
}

// ------------------------------------------------------------------ changes

export type QuickTabOp =
	| { kind: "pin"; id: string; scope: string; path: string; pageId: string; num: number; label?: string; order: number }
	| { kind: "unpin"; id: string }
	| { kind: "order"; id: string; order: number }
	/** The notebook at `from` was renamed or moved to `to`: every live pin that points at it follows. */
	| { kind: "retarget"; from: string; to: string };

/**
 * Applies changes to this device's file. `merged` is what every device's files say now: a written pin takes a time later
 * than both the merged one and this device's own previous one; unknown fields of the merged winner are carried over.
 */
export function applyQuickTabOps(ownFile: QuickTabsFile, merged: QuickTabsMap, ops: readonly QuickTabOp[], now: number): QuickTabsFile {
	const own = adoptQuickTabWinners(ownFile, merged);
	const items = new Map(own.items.map((i) => [i.id, i]));
	const current = (id: string): StoredQuickTab | undefined => {
		const seen = merged.get(id);
		const mine = items.get(id);
		return seen && (!mine || seen.at >= mine.at) ? seen : mine;
	};
	const put = (base: StoredQuickTab, change: Partial<StoredQuickTab>): void => {
		const at = Math.max(now, (merged.get(base.id)?.at ?? 0) + 1, (items.get(base.id)?.at ?? 0) + 1);
		const next: StoredQuickTab = { ...base, ...change, at };
		if (!next.label) delete next.label;
		if (!next.deleted) delete next.deleted;
		items.set(base.id, next);
	};
	for (const op of ops) {
		if (op.kind === "retarget") {
			for (const id of [...new Set([...merged.keys(), ...items.keys()])]) {
				const base = current(id);
				if (base && !base.deleted && base.path === op.from) put(base, { path: op.to });
			}
			continue;
		}
		const base = current(op.id);
		if (op.kind === "unpin") {
			if (base && !base.deleted) put(base, { deleted: true });
		} else if (op.kind === "order") {
			if (base && !base.deleted) put(base, { order: op.order });
		} else {
			const label = cleanLabel(op.label);
			const fresh: StoredQuickTab = { id: op.id, scope: op.scope, path: op.path, pageId: op.pageId, num: Math.max(1, Math.trunc(op.num)), order: op.order, at: 0 };
			if (label) fresh.label = label;
			if (base?.extra) fresh.extra = base.extra;
			put(fresh, {});
		}
	}
	return { ...own, items: [...items.values()] };
}
