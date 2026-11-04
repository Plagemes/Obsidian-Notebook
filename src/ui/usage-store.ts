// 0.14 generative UI (393): what is used, per notebook. Kept in Obsidian's per-device local storage, never in the
// notebook file, never in the vault, never synced or sent anywhere, and bounded: the document format is untouched.
//
// The toolbar ranks its quick slots by the use counts of the notebook in view once that notebook has enough history;
// until then it falls back to the counts of the whole device (ui/usage.ts), so a new notebook is not a blank toolbar.
import { normaliseUsage, recordUse, USAGE_KEY, type UsageMap } from "./usage";

/** Local storage key of the per-notebook counts. */
export const NOTEBOOK_USAGE_KEY = "notebook-ui-usage-by-notebook";
/** Notebooks remembered (the least recently used are forgotten first). */
export const MAX_NOTEBOOKS = 60;
/** Actions remembered per notebook. */
export const MAX_ACTIONS_PER_NOTEBOOK = 60;
/** A notebook ranks by its own counts once its actions have been used this many times in total. */
export const MIN_NOTEBOOK_USES = 8;

export type NotebookUsage = Readonly<Record<string, UsageMap>>;

const NOTEBOOK_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/** The newest use of a notebook's map (0 when empty). */
function lastUse(map: UsageMap): number {
	return Object.values(map).reduce((m, e) => Math.max(m, e.last), 0);
}

/** Whatever was stored, as a valid, bounded store: bad ids and entries are dropped, the oldest notebooks are forgotten. */
export function normaliseNotebookUsage(data: unknown): NotebookUsage {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows = Object.entries(data as Record<string, unknown>)
		.filter(([id]) => NOTEBOOK_ID.test(id))
		.map(([id, v]) => [id, normaliseUsage(v, MAX_ACTIONS_PER_NOTEBOOK)] as const)
		.filter(([, map]) => Object.keys(map).length > 0)
		.sort((a, b) => lastUse(b[1]) - lastUse(a[1]))
		.slice(0, MAX_NOTEBOOKS);
	return Object.fromEntries(rows);
}

/** The store after one more use of action `actionId` in notebook `notebookId` (a new object). */
export function recordNotebookUse(store: NotebookUsage, notebookId: string, actionId: string, now: number): NotebookUsage {
	if (!NOTEBOOK_ID.test(notebookId)) return store;
	const next = recordUse(normaliseUsage(store[notebookId], MAX_ACTIONS_PER_NOTEBOOK), actionId, now);
	return normaliseNotebookUsage({ ...store, [notebookId]: next });
}

/** Total number of uses in a map. */
export function totalUses(map: UsageMap | undefined): number {
	return map ? Object.values(map).reduce((n, e) => n + e.n, 0) : 0;
}

/**
 * The counts the toolbar ranks by. Learning off: none (the designed order). A notebook with enough history: its own
 * counts. Otherwise: the device's counts.
 */
export function effectiveUsage(device: UsageMap, store: NotebookUsage, notebookId: string | null, learn: boolean): UsageMap {
	if (!learn) return {};
	const mine = notebookId ? store[notebookId] : undefined;
	return mine && totalUses(mine) >= MIN_NOTEBOOK_USES ? mine : device;
}

// ------------------------------------------------------------------------------------------------------ local storage

/** The part of Obsidian's App that holds per-device values. */
export interface LocalStore {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

/** Bumped when the stored counts were erased, so open views reload them. */
let generation = 0;

export function usageGeneration(): number {
	return generation;
}

function load(app: LocalStore, key: string): unknown {
	try {
		return app.loadLocalStorage(key);
	} catch {
		return null;
	}
}

function save(app: LocalStore, key: string, value: unknown): void {
	try {
		app.saveLocalStorage(key, value);
	} catch (e) {
		console.error("[notebook] could not store the UI preferences", e);
	}
}

export function loadDeviceUsage(app: LocalStore): UsageMap {
	return normaliseUsage(load(app, USAGE_KEY));
}

export function loadNotebookUsage(app: LocalStore): NotebookUsage {
	return normaliseNotebookUsage(load(app, NOTEBOOK_USAGE_KEY));
}

/** Counts one use: read again from storage first (another notebook view may have written since), then written back. */
export function recordStoredUse(app: LocalStore, actionId: string, notebookId: string | null, learn: boolean, now: number): { device: UsageMap; notebooks: NotebookUsage } {
	const device = recordUse(loadDeviceUsage(app), actionId, now);
	save(app, USAGE_KEY, device);
	let notebooks = loadNotebookUsage(app);
	if (learn && notebookId) {
		notebooks = recordNotebookUse(notebooks, notebookId, actionId, now);
		save(app, NOTEBOOK_USAGE_KEY, notebooks);
	}
	return { device, notebooks };
}

/** Settings: forget everything the toolbar learned, on this device. */
export function clearStoredUsage(app: LocalStore): void {
	save(app, USAGE_KEY, {});
	save(app, NOTEBOOK_USAGE_KEY, {});
	generation++;
}
