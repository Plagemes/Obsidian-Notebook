/**
 * 0.16 review (C1): the files the plugin itself wrote outside its `_assets` folder (exported PDFs and page pictures, the pictures
 * of a highlights digest), remembered on this device for a while. The shared-files inbox never offers them, whatever folder they
 * were written to. Bounded, in Obsidian's per-device local storage; corrupt data reads as empty. Pure helpers plus two thin
 * functions over `loadLocalStorage` / `saveLocalStorage`.
 */

/** Local storage key of the record. */
export const WRITTEN_KEY = "notebook-plugin-written-files";
/** Most paths remembered (the oldest are forgotten first). */
export const MAX_WRITTEN = 400;
/** A path is remembered this long, ms (the inbox only offers files that are new). */
export const WRITTEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** path -> time written (ms). */
export type WrittenMap = Readonly<Record<string, number>>;

/** Whatever was stored, as a valid, bounded map: bad rows and rows older than the window are dropped, the oldest overflow goes. */
export function normaliseWritten(data: unknown, now: number): WrittenMap {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows = Object.entries(data as Record<string, unknown>)
		.filter(([k, v]) => k !== "" && k.length <= 400 && typeof v === "number" && Number.isFinite(v) && v > 0 && now - v <= WRITTEN_TTL_MS)
		.map(([k, v]) => [k, v as number] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_WRITTEN);
	return Object.fromEntries(rows);
}

/** The record after `paths` were written at `now` (a new object). */
export function addWritten(map: WrittenMap, paths: readonly string[], now: number): WrittenMap {
	const next: Record<string, number> = { ...map };
	for (const p of paths) if (typeof p === "string" && p !== "") next[p] = now;
	return normaliseWritten(next, now);
}

/** The paths to skip, lowercased for a case-insensitive comparison. */
export function writtenSet(map: WrittenMap): Set<string> {
	return new Set(Object.keys(map).map((p) => p.toLowerCase()));
}

/**
 * The file name the plugin gives a digest crop (`<Notebook> highlight p3-2.png`, with Obsidian's ` 2` suffix when the name was
 * taken). Recognised by name, so it is never offered even when the record is gone (another device, cleared data, older than the
 * window). Exported page pictures (`page-001.png`) are NOT recognised by name: a user may own a file called that, so they are
 * kept out of the inbox by the record of what the plugin wrote alone.
 */
export function isPluginPictureName(name: string): boolean {
	return /^.* (?:highlight|task) p\d+-\d+(?: \d+)?\.png$/iu.test(name);
}

/** The part of Obsidian's App that holds per-device values. */
interface LocalStore {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

/** The record on this device (empty when missing or unreadable). */
export function loadWritten(app: LocalStore, now = Date.now()): WrittenMap {
	try {
		return normaliseWritten(app.loadLocalStorage(WRITTEN_KEY), now);
	} catch {
		return {};
	}
}

/**
 * Remembers paths the plugin is about to write or just wrote. Call it BEFORE the write when the path is known: the vault's
 * `create` event fires while the write is still pending. Never throws.
 */
export function recordPluginWrite(app: LocalStore, paths: readonly string[], now = Date.now()): void {
	if (paths.length === 0) return;
	try {
		app.saveLocalStorage(WRITTEN_KEY, addWritten(loadWritten(app, now), paths, now));
	} catch (e) {
		console.error("[notebook] could not store the written files record", e);
	}
}
