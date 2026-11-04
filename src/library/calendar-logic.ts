/**
 * The Calendar view's data (0.15, roadmap #162): which notebooks and pages were written on which day. Pure: no 'obsidian',
 * no DOM, and it never opens a notebook.
 *
 * Two sources, both already at hand:
 * - the library index: every notebook's creation and last-change time (`created`, `modified`). The document has no
 *   per-page times, so this says "this notebook changed that day" (also for edits made on another device);
 * - this device's activity log (activity-log.ts): the pages edited on each of the last 90 days, by short page key.
 *
 * Per day and notebook the result says what happened: `written` (these pages), `modified` (the notebook changed, no page
 * detail) and `created`. A notebook that has page detail for a day does not also show a bare "modified" for it.
 */
import type { ActivityRecord } from "./activity-log";
import { dayKeyOf } from "./activity-log";

/** The part of a library entry the calendar reads. */
export interface CalendarEntry {
	path: string;
	name: string;
	created: number;
	modified: number;
}

export interface DayItem {
	path: string;
	name: string;
	/** Short page keys (the second half of an activity key) written that day; empty without page detail. */
	pages: string[];
	written: boolean;
	modified: boolean;
	created: boolean;
}

export interface DaySummary {
	day: string;
	items: DayItem[];
	/** Pages written (distinct) that day on this device. */
	pageCount: number;
}

export type CalendarMap = ReadonlyMap<string, DaySummary>;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The part of an activity key that names the page (`<notebook 8>:<page 8>`). */
export function pageOfKey(key: string): string {
	const i = key.indexOf(":");
	return i < 0 ? key : key.slice(i + 1);
}

/** Builds the days that have anything from the index entries and the activity records. Days in `[from, to]` only when given. */
export function aggregateCalendar(
	entries: readonly CalendarEntry[], records: readonly ActivityRecord[], range?: { from?: string; to?: string },
): Map<string, DaySummary> {
	const byPath = new Map(entries.map((e) => [e.path, e]));
	const days = new Map<string, Map<string, DayItem>>();
	const inRange = (day: string) => (!range?.from || day >= range.from) && (!range?.to || day <= range.to);
	const item = (day: string, path: string): DayItem | null => {
		const e = byPath.get(path);
		if (!e || !inRange(day)) return null;
		let d = days.get(day);
		if (!d) days.set(day, (d = new Map<string, DayItem>()));
		let it = d.get(path);
		if (!it) d.set(path, (it = { path, name: e.name, pages: [], written: false, modified: false, created: false }));
		return it;
	};
	for (const r of records) {
		if (!r.path || !DAY_RE.test(r.day)) continue;
		const it = item(r.day, r.path);
		if (!it) continue;
		it.written = true;
		const page = pageOfKey(r.key);
		if (!it.pages.includes(page)) it.pages.push(page);
	}
	for (const e of entries) {
		if (Number.isFinite(e.created) && e.created > 0) {
			const it = item(dayKeyOf(e.created), e.path);
			if (it) it.created = true;
		}
		if (Number.isFinite(e.modified) && e.modified > 0) {
			const day = dayKeyOf(e.modified);
			const it = item(day, e.path);
			// A notebook created and last changed on the same day has nothing more to say than "created".
			if (it && !it.written && !(it.created && day === dayKeyOf(e.created))) it.modified = true;
		}
	}
	const out = new Map<string, DaySummary>();
	for (const [day, d] of days) {
		const items = [...d.values()].filter((i) => i.written || i.modified || i.created);
		if (items.length === 0) continue;
		items.sort((a, b) => Number(b.written) - Number(a.written) || Number(b.modified) - Number(a.modified) || a.name.localeCompare(b.name));
		out.set(day, { day, items, pageCount: items.reduce((n, i) => n + i.pages.length, 0) });
	}
	return out;
}

/** 0 (nothing) to 4: how strongly a day is marked in the month grid. */
export function dayLevel(s: DaySummary | undefined): 0 | 1 | 2 | 3 | 4 {
	if (!s) return 0;
	const n = Math.max(s.pageCount, s.items.length);
	return n >= 12 ? 4 : n >= 6 ? 3 : n >= 3 ? 2 : 1;
}

// ------------------------------------------------------------------ dates (local time)

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(y: number, m: number, d: number): string {
	return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/** The local date of a day key, at noon (so a daylight-saving shift cannot move it to another day), or null. */
export function parseDay(key: string): Date | null {
	const m = DAY_RE.exec(key);
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
	return Number.isNaN(d.getTime()) || dayKeyOf(d.getTime()) !== key ? null : d;
}

export function addDays(key: string, n: number): string {
	const d = parseDay(key) ?? new Date();
	d.setDate(d.getDate() + n);
	return dayKeyOf(d.getTime());
}

/** The first day of the month `delta` months from the one containing `key`. */
export function shiftMonth(key: string, delta: number): string {
	const d = parseDay(key) ?? new Date();
	const t = new Date(d.getFullYear(), d.getMonth() + delta, 1, 12);
	return dayKey(t.getFullYear(), t.getMonth(), 1);
}

export interface GridDay {
	day: string;
	inMonth: boolean;
}

/** The weeks of the month containing `key`, as rows of 7 days from `weekStart` (0 = Sunday, 1 = Monday); 5 or 6 rows. */
export function monthGrid(key: string, weekStart: 0 | 1 = 1): GridDay[][] {
	const d = parseDay(key) ?? new Date();
	const y = d.getFullYear();
	const m = d.getMonth();
	const first = new Date(y, m, 1, 12);
	const lead = (first.getDay() - weekStart + 7) % 7;
	const start = new Date(y, m, 1 - lead, 12);
	const rows: GridDay[][] = [];
	for (let w = 0; w < 6; w++) {
		const row: GridDay[] = [];
		for (let i = 0; i < 7; i++) {
			const x = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i, 12);
			row.push({ day: dayKeyOf(x.getTime()), inMonth: x.getMonth() === m });
		}
		if (w >= 4 && !row.some((c) => c.inMonth)) break;
		rows.push(row);
	}
	return rows;
}

/** The 7 days of the week containing `key`. */
export function weekOf(key: string, weekStart: 0 | 1 = 1): string[] {
	const d = parseDay(key) ?? new Date();
	const lead = (d.getDay() - weekStart + 7) % 7;
	const first = addDays(dayKeyOf(d.getTime()), -lead);
	return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** First day of the week for a locale: Sunday for the US and a few others, Monday elsewhere. */
export function weekStartFor(locale: string): 0 | 1 {
	return /^(en-US|en-CA|pt-BR|ja|he|ko|zh-TW|es-MX)/i.test(locale) || locale.toLowerCase() === "en" ? 0 : 1;
}
