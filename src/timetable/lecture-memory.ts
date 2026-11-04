/**
 * What lecture mode remembers about today's classes in one notebook, on this device (0.14): the occurrences the user turned
 * down or left ("Not now", End) and those whose lecture page was added. Kept in Obsidian's per-device local storage, never
 * in the notebook file and never synced; bounded (today's occurrences only, a few notebooks); unreadable data reads as empty.
 * Pure: no DOM and no 'obsidian'. Without it, reopening a notebook during a class would add the lecture page again after it
 * was deleted or its header edited, and would ask again about a class the user had just turned down.
 */

/** Local storage key. */
export const LECTURE_MEMORY_KEY = "notebook-lecture-memory";
/** Notebooks remembered (the oldest are forgotten first). */
export const LECTURE_MEMORY_NOTEBOOKS = 40;
/** Occurrences remembered per notebook and per kind. */
export const LECTURE_MEMORY_KEYS = 24;

export type LectureMemoryKind = "declined" | "paged";

export interface LectureMemoryEntry {
	/** Local day (`YYYY-MM-DD`) of the occurrences below. */
	day: string;
	declined: string[];
	paged: string[];
}

/** Notebook path -> what is remembered. Insertion order is age: the first notebook is the oldest. */
export type LectureMemory = Readonly<Record<string, LectureMemoryEntry>>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PATH = 400;

/** The occurrence keys (`<class id>@<day>`) of `day`, without repeats, at most `LECTURE_MEMORY_KEYS` (the newest kept). */
function keysOf(v: unknown, day: string): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const k of v) {
		if (typeof k === "string" && k.length <= 200 && k.endsWith(`@${day}`) && !out.includes(k)) out.push(k);
	}
	return out.slice(-LECTURE_MEMORY_KEYS);
}

/** Whatever was stored, as a valid, bounded memory: only `today`'s occurrences, bad rows dropped. */
export function normaliseLectureMemory(data: unknown, today: string): LectureMemory {
	if (typeof data !== "object" || data === null || Array.isArray(data) || !DAY.test(today)) return {};
	const rows: Array<[string, LectureMemoryEntry]> = [];
	for (const [path, v] of Object.entries(data as Record<string, unknown>)) {
		if (!path || path.length > MAX_PATH || path === "__proto__" || typeof v !== "object" || v === null) continue;
		const row = v as { day?: unknown; declined?: unknown; paged?: unknown };
		if (row.day !== today) continue;
		const declined = keysOf(row.declined, today);
		const paged = keysOf(row.paged, today);
		if (declined.length + paged.length === 0) continue;
		rows.push([path, { day: today, declined, paged }]);
	}
	return Object.fromEntries(rows.slice(-LECTURE_MEMORY_NOTEBOOKS));
}

/** What is remembered for the notebook at `path` today. */
export function lectureMemoryOf(memory: LectureMemory, path: string): { declined: Set<string>; paged: Set<string> } {
	const e = Object.prototype.hasOwnProperty.call(memory, path) ? memory[path] : undefined;
	return { declined: new Set(e?.declined), paged: new Set(e?.paged) };
}

/** The memory after `key` was added to `kind` for the notebook at `path` (a new object; the notebook becomes the newest). */
export function rememberLecture(memory: LectureMemory, path: string, kind: LectureMemoryKind, key: string, today: string): LectureMemory {
	const rest = Object.fromEntries(Object.entries(memory).filter(([p]) => p !== path));
	const e = Object.prototype.hasOwnProperty.call(memory, path) ? memory[path] : undefined;
	const next: LectureMemoryEntry = { day: today, declined: [...(e?.declined ?? [])], paged: [...(e?.paged ?? [])] };
	if (!next[kind].includes(key)) next[kind].push(key);
	return normaliseLectureMemory({ ...rest, [path]: next }, today);
}
