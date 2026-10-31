/**
 * 0.13: the pure logic behind Home's revised dashboard: pages written per day, the streak, the split by subject, the
 * estimated writing time, the grouping of recent notes, pages per folder and what the "Continue" card shows.
 * No 'obsidian', no DOM: testable in Node.
 */
import { dayKeyOf, type ActivityRecord } from "./activity-log";
import { isInside } from "./index";

/** The days offered by the pages chart. */
export const CHART_DAYS = [7, 14] as const;
export type ChartDays = typeof CHART_DAYS[number];

/** The local day `n` days before `now`'s day, as a time inside that day (noon, so a change of clock cannot skip it). */
function dayBefore(now: number, n: number): number {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime();
}

export interface DayCount {
	/** `YYYY-MM-DD` */
	day: string;
	/** A time inside that day (noon), for the weekday label. */
	at: number;
	pages: number;
}

/** Pages written on each of the last `days` days, oldest first; the last one is today. */
export function pagesPerDay(records: readonly ActivityRecord[], now: number, days: number): DayCount[] {
	const counts = new Map<string, number>();
	for (const r of records) counts.set(r.day, (counts.get(r.day) ?? 0) + 1);
	const out: DayCount[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const at = dayBefore(now, i);
		const day = dayKeyOf(at);
		out.push({ day, at, pages: counts.get(day) ?? 0 });
	}
	return out;
}

/** Pages written today. */
export function pagesToday(records: readonly ActivityRecord[], now: number): number {
	const today = dayKeyOf(now);
	let n = 0;
	for (const r of records) if (r.day === today) n++;
	return n;
}

/**
 * Days in a row with at least one page written, counting back from today. A day that has not had its page yet does not
 * break a streak: with nothing written today, it counts back from yesterday (the streak is still alive until the day ends).
 */
export function currentStreak(records: readonly ActivityRecord[], now: number): number {
	const active = new Set(records.map((r) => r.day));
	let i = active.has(dayKeyOf(now)) ? 0 : 1;
	let streak = 0;
	while (active.has(dayKeyOf(dayBefore(now, i)))) {
		streak++;
		i++;
		if (i > 4000) break;
	}
	return streak;
}

export interface SubjectRef {
	/** Stable key (the subject's folder path). */
	key: string;
	label: string;
	color: string;
}

export interface SubjectShare extends SubjectRef {
	pages: number;
	/** 0–1 of the pages that belong to a subject. */
	share: number;
}

/**
 * Pages written in the last `days` days, by subject, most pages first. `subjectOf` maps a notebook path to its subject (null
 * for a notebook that belongs to none: it is left out). Ties go to the label.
 */
export function subjectShares(records: readonly ActivityRecord[], now: number, days: number, subjectOf: (path: string) => SubjectRef | null): SubjectShare[] {
	const first = dayKeyOf(dayBefore(now, days - 1));
	const last = dayKeyOf(now);
	const by = new Map<string, SubjectShare>();
	let total = 0;
	for (const r of records) {
		if (r.day < first || r.day > last || !r.path) continue;
		const s = subjectOf(r.path);
		if (!s) continue;
		const cur = by.get(s.key) ?? { ...s, pages: 0, share: 0 };
		cur.pages++;
		by.set(s.key, cur);
		total++;
	}
	const out = [...by.values()].sort((a, b) => b.pages - a.pages || a.label.localeCompare(b.label));
	for (const s of out) s.share = total > 0 ? s.pages / total : 0;
	return out;
}

/** Minutes in which something was written during the last `days` days: the estimate of the writing time. */
export function writingMinutes(minutesByDay: Readonly<Record<string, number>>, now: number, days: number): number {
	const first = dayKeyOf(dayBefore(now, days - 1));
	const last = dayKeyOf(now);
	let sum = 0;
	for (const [day, m] of Object.entries(minutesByDay)) if (day >= first && day <= last && m > 0) sum += m;
	return sum;
}

/** 135 → { hours: 2, minutes: 15 } */
export function splitMinutes(total: number): { hours: number; minutes: number } {
	const t = Math.max(0, Math.round(total));
	return { hours: Math.floor(t / 60), minutes: t % 60 };
}

// ------------------------------------------------------------------ recent notes

export interface RecentGroup<T> {
	/** Notebook path. */
	path: string;
	/** Newest first. */
	items: T[];
	/** Time of the newest item. */
	at: number;
}

/**
 * Groups page edits (newest first, as the recent pages log lists them) by notebook: groups ordered by their newest edit,
 * pages of a group newest first, at most `perGroup` pages and `groups` groups.
 */
export function groupByNotebook<T extends { path: string; at: number }>(items: readonly T[], groups = 5, perGroup = 3): Array<RecentGroup<T>> {
	const by = new Map<string, RecentGroup<T>>();
	for (const item of [...items].sort((a, b) => b.at - a.at)) {
		let g = by.get(item.path);
		if (!g) {
			if (by.size >= groups) continue;
			g = { path: item.path, items: [], at: item.at };
			by.set(item.path, g);
		}
		if (g.items.length < perGroup) g.items.push(item);
	}
	return [...by.values()];
}

// ------------------------------------------------------------------ pages per folder

/** Pages in each folder, recursively (a folder counts the pages of every notebook inside it); `root` counts them all. */
export function pagesByFolder(entries: ReadonlyArray<{ folder: string; pages: number }>, root: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of entries) {
		let p = e.folder;
		for (let guard = 0; guard < 64; guard++) {
			out.set(p, (out.get(p) ?? 0) + e.pages);
			if (p === root || p === "" || !isInside(p, root)) break;
			const cut = p.lastIndexOf("/");
			p = cut < 0 ? "" : p.slice(0, cut);
		}
	}
	return out;
}

// ------------------------------------------------------------------ the "Continue" card

/** The class in progress, resolved to the notebook it opens (timetable/service.ts `nowTarget`). */
export interface LectureTarget {
	course: string;
	room?: string;
	/** The notebook the class opens, or the folder (and name) of the notebook it creates when there is none yet. */
	target: { kind: "open"; path: string } | { kind: "create"; folder: string; name: string };
}

export type ContinueChoice =
	| { kind: "lecture"; course: string; room?: string; path: string | null; folder: string; name: string }
	| { kind: "last"; path: string }
	| { kind: "none" };

/**
 * What the Continue card shows: the lecture in progress (its notebook, or a notebook to create), else the notebook that was
 * open last (`last`, when it still exists in the library), else the notebook changed most recently, else nothing.
 * `exists` tells whether a path is a notebook of the library.
 */
export function chooseContinue(
	lecture: LectureTarget | null, last: string | null, newest: string | null, exists: (path: string) => boolean,
): ContinueChoice {
	if (lecture) {
		const t = lecture.target;
		const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
		// An "open" target is a file the timetable service found in the vault; the library may not have read it yet.
		if (t.kind === "open") return { kind: "lecture", course: lecture.course, room: lecture.room, path: t.path, folder: dir(t.path), name: lecture.course };
		return { kind: "lecture", course: lecture.course, room: lecture.room, path: null, folder: t.folder, name: t.name };
	}
	if (last && exists(last)) return { kind: "last", path: last };
	if (newest && exists(newest)) return { kind: "last", path: newest };
	return { kind: "none" };
}
