/**
 * Class timetable: data model, parsing and pure scheduling logic (no DOM, no 'obsidian').
 * All times are local wall-clock times (`Date` getters), never UTC: a class at 09:00 is at 09:00 wherever the
 * device is. Dates are `YYYY-MM-DD`, times `HH:MM`, weekdays ISO numbers (1 = Monday ... 7 = Sunday).
 */
import { createId } from "../model/document";

export const TIMETABLE_VERSION = 1;
export const WEEK_PATTERNS = ["all", "odd", "even"] as const;
export type WeekPattern = (typeof WEEK_PATTERNS)[number];

export interface ClassEntry {
	id: string;
	course: string;
	/** ISO weekday: 1 = Monday ... 7 = Sunday. */
	day: number;
	/** `HH:MM`, local time. */
	start: string;
	/** `HH:MM`, local time; the class is over at this minute. */
	end: string;
	room?: string;
	/** Vault path of a notebook or of a course folder. */
	notebook?: string;
	/** `all` (every week), `odd` or `even` weeks (counted from `Timetable.weekOne`, else ISO week numbers). */
	weeks: WeekPattern;
	/** First and last day of the term (inclusive), optional. */
	from?: string;
	to?: string;
}

export interface Timetable {
	version: number;
	/** A date in the week that counts as week 1 (for alternating weeks); optional. */
	weekOne?: string;
	entries: ClassEntry[];
}

export function emptyTimetable(): Timetable {
	return { version: TIMETABLE_VERSION, entries: [] };
}

export function newEntry(): ClassEntry {
	return { id: createId(), course: "", day: 1, start: "09:00", end: "10:00", weeks: "all" };
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_MS = 86_400_000;

/** Local date as `YYYY-MM-DD`. */
export function isoDay(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Minutes since midnight for `HH:MM` (00:00-23:59); null when it is not a valid time. */
export function parseTime(value: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h <= 23 && min <= 59 ? h * 60 + min : null;
}

export function formatTime(minutes: number): string {
	return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Day number of a `YYYY-MM-DD` date (days since 1970-01-01, calendar arithmetic without time zones); null if invalid. */
function dayNumber(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const t = Date.UTC(y, mo - 1, d);
	const back = new Date(t);
	return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? Math.round(t / DAY_MS) : null;
}

export function isValidDay(value: string): boolean {
	return dayNumber(value) !== null;
}

const localDayNumber = (date: Date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);

/** ISO weekday of a local date (1 = Monday ... 7 = Sunday). */
export function isoWeekday(date: Date): number {
	return date.getDay() === 0 ? 7 : date.getDay();
}

/** Day number of the Monday of the week that contains `day` (1970-01-01 was a Thursday). */
const mondayOf = (day: number) => day - ((((day + 3) % 7) + 7) % 7);

/** ISO 8601 week number (1-53) of a local date. */
export function isoWeekNumber(date: Date): number {
	const day = localDayNumber(date);
	const thursday = mondayOf(day) + 3;
	const year = new Date(thursday * DAY_MS).getUTCFullYear();
	const jan1 = Math.round(Date.UTC(year, 0, 1) / DAY_MS);
	return Math.floor((thursday - jan1) / 7) + 1;
}

/** Week counter of `date`: 1 for the week of `weekOne`, 2 for the next one...; ISO week number without `weekOne`. */
export function weekNumber(date: Date, weekOne?: string): number {
	const one = weekOne ? dayNumber(weekOne) : null;
	if (one === null) return isoWeekNumber(date);
	return Math.round((mondayOf(localDayNumber(date)) - mondayOf(one)) / 7) + 1;
}

export function weekMatches(pattern: WeekPattern, date: Date, weekOne?: string): boolean {
	if (pattern === "all") return true;
	const odd = Math.abs(weekNumber(date, weekOne)) % 2 === 1;
	return pattern === "odd" ? odd : !odd;
}

/** True when the class takes place on that calendar day (weekday, term and alternating weeks). */
export function occursOn(entry: ClassEntry, date: Date, weekOne?: string): boolean {
	if (isoWeekday(date) !== entry.day) return false;
	const day = isoDay(date);
	if (entry.from && day < entry.from) return false;
	if (entry.to && day > entry.to) return false;
	return weekMatches(entry.weeks, date, weekOne);
}

const minutesOf = (date: Date) => date.getHours() * 60 + date.getMinutes();
const startOf = (e: ClassEntry) => parseTime(e.start) ?? 0;
const endOf = (e: ClassEntry) => parseTime(e.end) ?? 0;

/** Classes on that day, in time order. */
export function classesOn(tt: Timetable, date: Date): ClassEntry[] {
	return tt.entries.filter((e) => occursOn(e, date, tt.weekOne)).sort((a, b) => startOf(a) - startOf(b));
}

/**
 * Classes in progress at `now`. `leadMinutes` counts a class as in progress that long before it starts (so opening
 * the app a few minutes early still finds it). Overlapping classes: the one that started last comes first.
 */
export function classesAt(tt: Timetable, now: Date, leadMinutes = 0): ClassEntry[] {
	const m = minutesOf(now);
	return classesOn(tt, now)
		.filter((e) => m >= startOf(e) - leadMinutes && m < endOf(e))
		.sort((a, b) => startOf(b) - startOf(a));
}

/** The class in progress (see `classesAt`), or null. */
export function currentClass(tt: Timetable, now: Date, leadMinutes = 0): ClassEntry | null {
	return classesAt(tt, now, leadMinutes)[0] ?? null;
}

export interface ClassOccurrence {
	entry: ClassEntry;
	/** Start of this occurrence, local time. */
	start: Date;
}

/** The next class that starts after `now` (looking `searchDays` ahead); null when there is none. */
export function nextClass(tt: Timetable, now: Date, searchDays = 21): ClassOccurrence | null {
	for (let i = 0; i <= searchDays; i++) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 12, 0, 0);
		for (const entry of classesOn(tt, day)) {
			const s = startOf(entry);
			const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(s / 60), s % 60, 0);
			if (start.getTime() > now.getTime()) return { entry, start };
		}
	}
	return null;
}

function termsOverlap(a: ClassEntry, b: ClassEntry): boolean {
	return (!a.to || !b.from || a.to >= b.from) && (!b.to || !a.from || b.to >= a.from);
}

/** Pairs of classes that can be on at the same time (same weekday, overlapping hours, terms and week patterns). */
export function findOverlaps(entries: readonly ClassEntry[]): Array<[ClassEntry, ClassEntry]> {
	const out: Array<[ClassEntry, ClassEntry]> = [];
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i]!;
			const b = entries[j]!;
			if (a.day !== b.day) continue;
			if (a.weeks !== "all" && b.weeks !== "all" && a.weeks !== b.weeks) continue;
			if (!termsOverlap(a, b)) continue;
			if (startOf(a) < endOf(b) && startOf(b) < endOf(a)) out.push([a, b]);
		}
	}
	return out;
}

/** First problem with an entry (a short code the UI turns into a message), or null when it is fine. */
export type EntryProblem = "course" | "day" | "time" | "order" | "weeks" | "date" | "term";
export function entryProblem(e: ClassEntry): EntryProblem | null {
	if (!e.course.trim()) return "course";
	if (!Number.isInteger(e.day) || e.day < 1 || e.day > 7) return "day";
	const s = parseTime(e.start);
	const f = parseTime(e.end);
	if (s === null || f === null) return "time";
	if (f <= s) return "order";
	if (!WEEK_PATTERNS.includes(e.weeks)) return "weeks";
	if ((e.from && !isValidDay(e.from)) || (e.to && !isValidDay(e.to))) return "date";
	if (e.from && e.to && e.to < e.from) return "term";
	return null;
}

export type ParseResult = { ok: true; timetable: Timetable } | { ok: false; error: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Reads the timetable file. Strict on purpose: anything that cannot be understood is an error (never silently
 * dropped), so the caller leaves the file alone instead of overwriting what the user wrote by hand.
 */
export function parseTimetable(text: string): ParseResult {
	if (!text.trim()) return { ok: true, timetable: emptyTimetable() };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "the top level must be an object" };
	const o = raw as Record<string, unknown>;
	const version = o.version ?? TIMETABLE_VERSION;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, error: "bad version" };
	if (version > TIMETABLE_VERSION) return { ok: false, error: `version ${version} is newer than this plugin understands` };
	if (!Array.isArray(o.entries)) return { ok: false, error: "\"entries\" must be a list" };
	const weekOne = str(o.weekOne);
	if (weekOne && !isValidDay(weekOne)) return { ok: false, error: `weekOne "${weekOne}" is not a YYYY-MM-DD date` };
	const entries: ClassEntry[] = [];
	const ids = new Set<string>();
	for (const [i, item] of o.entries.entries()) {
		if (typeof item !== "object" || item === null) return { ok: false, error: `entry ${i + 1} is not an object` };
		const r = item as Record<string, unknown>;
		let id = str(r.id) ?? createId();
		if (ids.has(id)) id = createId();
		ids.add(id);
		const entry: ClassEntry = {
			id,
			course: typeof r.course === "string" ? r.course.trim() : "",
			day: typeof r.day === "number" ? r.day : NaN,
			start: typeof r.start === "string" ? r.start.trim() : "",
			end: typeof r.end === "string" ? r.end.trim() : "",
			weeks: (r.weeks ?? "all") as WeekPattern,
		};
		const room = str(r.room);
		const notebook = str(r.notebook);
		const from = str(r.from);
		const to = str(r.to);
		if (room) entry.room = room;
		if (notebook) entry.notebook = notebook;
		if (from) entry.from = from;
		if (to) entry.to = to;
		const problem = entryProblem(entry);
		if (problem) return { ok: false, error: `entry ${i + 1} ("${entry.course}") has a bad ${problem}` };
		entries.push(entry);
	}
	const timetable: Timetable = { version: TIMETABLE_VERSION, entries };
	if (weekOne) timetable.weekOne = weekOne;
	return { ok: true, timetable };
}

/** The file text: pretty-printed JSON with a stable key order, so a synced or hand-edited file diffs cleanly. */
export function serializeTimetable(tt: Timetable): string {
	const entries = tt.entries.map((e) => {
		const out: Record<string, unknown> = { id: e.id, course: e.course.trim(), day: e.day, start: e.start, end: e.end };
		if (e.room?.trim()) out.room = e.room.trim();
		if (e.notebook?.trim()) out.notebook = e.notebook.trim();
		out.weeks = e.weeks;
		if (e.from) out.from = e.from;
		if (e.to) out.to = e.to;
		return out;
	});
	const head: Record<string, unknown> = { version: TIMETABLE_VERSION };
	if (tt.weekOne) head.weekOne = tt.weekOne;
	return `${JSON.stringify({ ...head, entries }, null, 2)}\n`;
}

/** Writes are checked: the text must read back as the same timetable. */
export function serializeChecked(tt: Timetable): string {
	const text = serializeTimetable(tt);
	const back = parseTimetable(text);
	if (!back.ok) throw new Error(`timetable would not read back: ${back.error}`);
	if (serializeTimetable(back.timetable) !== text) throw new Error("timetable does not round-trip");
	return text;
}

// --- links between a class and notebooks ---

const folderPrefix = (folder: string) => `${folder.replace(/\/+$/, "")}/`;

/** True when the class's link is the notebook itself or a folder that contains it. */
export function linkCovers(link: string | undefined, notebookPath: string): boolean {
	if (!link) return false;
	return link === notebookPath || notebookPath.startsWith(folderPrefix(link));
}

/**
 * Course to prefill in "New lecture" for a notebook: the class in progress that is linked to it; failing that,
 * the class in progress that is linked to nothing (a link to another notebook never applies); null otherwise
 * (the notebook name is used then). `all` is every class of the timetable.
 */
export function courseForNotebook(current: readonly ClassEntry[], notebookPath: string | null | undefined, all: readonly ClassEntry[] = current): string | null {
	if (!current.length) return null;
	if (notebookPath) {
		const linked = current.find((e) => linkCovers(e.notebook, notebookPath));
		if (linked) return linked.course;
		if (all.some((e) => linkCovers(e.notebook, notebookPath))) return null;
	}
	const unlinked = current.find((e) => !e.notebook);
	return unlinked ? unlinked.course : null;
}

export interface NotebookRef {
	path: string;
	basename: string;
	mtime: number;
}

export type OpenTarget = { kind: "open"; path: string } | { kind: "create"; folder: string; name: string };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which notebook a class opens. Linked to a notebook file: that one. Linked to a folder (or unlinked: the notebooks
 * folder): the notebook named like the course, else (folder link only) the most recently changed one in the folder,
 * else a new notebook named like the course.
 */
export function pickTarget(entry: ClassEntry, notebooks: readonly NotebookRef[], root: string): OpenTarget {
	const link = entry.notebook?.replace(/\/+$/, "");
	const exact = link ? notebooks.find((n) => n.path === link) : undefined;
	if (exact) return { kind: "open", path: exact.path };
	const looksLikeFile = !!link && /\.[A-Za-z0-9]+$/.test(link.slice(link.lastIndexOf("/") + 1));
	if (link && looksLikeFile) {
		const cut = link.lastIndexOf("/");
		const base = link.slice(cut + 1).replace(/\.[^.]+$/, "");
		return { kind: "create", folder: cut < 0 ? "" : link.slice(0, cut), name: base };
	}
	const folder = link ?? root.replace(/\/+$/, "");
	const inside = link ? notebooks.filter((n) => n.path.startsWith(folderPrefix(folder))) : [...notebooks];
	const byName = inside.filter((n) => sameName(n.basename, entry.course)).sort((a, b) => b.mtime - a.mtime)[0];
	if (byName) return { kind: "open", path: byName.path };
	if (link) {
		const latest = [...inside].sort((a, b) => b.mtime - a.mtime)[0];
		if (latest) return { kind: "open", path: latest.path };
	}
	return { kind: "create", folder, name: entry.course.trim() };
}

/** Key that identifies one occurrence of a class on a day, to offer it only once. */
export function occurrenceKey(entry: ClassEntry, date: Date): string {
	return `${entry.id}@${isoDay(date)}`;
}
