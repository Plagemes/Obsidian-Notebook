import { renamedPath } from "./checklist";

/**
 * Notes that were renamed or moved, remembered on this device for a while (0.19, #103): a notebook that is closed when its task
 * note is renamed keeps the old path in its links, and finds the note again from this record when it is opened or when a tick
 * would otherwise find no note. Pure: the storage is in storage/renamed-notes.ts. Bounded; bad rows are dropped.
 */

/** One rename: `from` (a note or a folder) became `to`, at time `at` (ms). */
export interface RenameRow {
	from: string;
	to: string;
	at: number;
}

/** Most renames remembered (the oldest go first). */
export const RENAME_MAP_MAX = 200;
/** A rename is remembered this long, ms. */
export const RENAME_MAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Longest path kept. */
const PATH_MAX = 500;
/** Renames followed one after another at most (a note renamed several times). */
const HOPS_MAX = 8;

function good(row: unknown, now: number): row is RenameRow {
	if (typeof row !== "object" || row === null) return false;
	const r = row as Record<string, unknown>;
	return (
		typeof r.from === "string" && r.from !== "" && r.from.length <= PATH_MAX &&
		typeof r.to === "string" && r.to !== "" && r.to.length <= PATH_MAX && r.from !== r.to &&
		typeof r.at === "number" && Number.isFinite(r.at) && r.at > 0 && now - r.at <= RENAME_MAP_TTL_MS
	);
}

/** Whatever was stored, as a valid, bounded list in the order it happened: bad rows and old ones dropped, the newest kept. */
export function normaliseRenames(data: unknown, now: number): RenameRow[] {
	if (!Array.isArray(data)) return [];
	const rows: RenameRow[] = [];
	for (const row of data) if (good(row, now)) rows.push({ from: row.from, to: row.to, at: row.at });
	rows.sort((a, b) => a.at - b.at);
	return rows.slice(-RENAME_MAP_MAX);
}

/**
 * The list after `from` became `to` at `at`. A rename that an earlier folder rename already explains (every note in a renamed
 * folder is reported too) is not stored again.
 */
export function addRename(list: readonly RenameRow[], from: string, to: string, at: number): readonly RenameRow[] {
	// (the same list, not a copy, when there is nothing to add)
	if (from === "" || to === "" || from === to) return list;
	if (list.some((r) => r.at >= at - 60_000 && renamedPath(from, r.from, r.to) === to)) return list;
	return normaliseRenames([...list, { from, to, at }], at);
}

/**
 * Where `path` is now: every rename that happened since `since` (ms; the time the link was made) applied in the order it happened,
 * folders included. The same path when none applies.
 */
export function resolveRenamed(list: readonly RenameRow[], path: string, since = 0): string {
	let now = path;
	let hops = 0;
	for (const r of list) {
		if (r.at < since) continue;
		const next = renamedPath(now, r.from, r.to);
		if (next === null) continue;
		now = next;
		if (++hops >= HOPS_MAX) break;
	}
	return now;
}
