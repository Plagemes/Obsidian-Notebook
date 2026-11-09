/**
 * Planner pages that show the vault's tasks (roadmap #266). Pure: no 'obsidian', no DOM. Nothing here is stored in the notebook
 * (no format change): the overlay is derived, per device, from the Markdown notes.
 *
 * - `plannerPageDates`: the days a planner page stands for, read from its title (the typed text the planner generator writes at
 *   the top: "Thursday, 12 March 2026", "Week 12 · 2–8 March 2026"), in English or Italian. Only pages on a planner paper count.
 * - `extractTasks`: the task lines (`- [ ] ...`) of a note that have a due date: the Tasks plugin's `📅 YYYY-MM-DD`, Dataview's
 *   `[due:: YYYY-MM-DD]` / `(due:: ...)`, or, for a task with none, the date in the name of its daily note (`2026-03-12.md`).
 * - `TaskIndex`: the tasks per note, bounded in notes, tasks per note and in total, and the lookup of the tasks due on some days.
 */
import { civil, dayNumber, daysInMonth, LANGS, monthName } from "../model/calendar";
import type { Page } from "../model/types";

/** A task of a note with its due day. */
export interface TaskEntry {
	path: string;
	/** 0-based line of the task in the note. */
	line: number;
	done: boolean;
	/** The text without the date markers and inline fields, cut to TASK_TEXT_MAX. */
	text: string;
	/** `YYYY-MM-DD`. */
	due: string;
}

export const MAX_FILE_TASKS = 300;
export const MAX_TOTAL_TASKS = 5000;
export const MAX_INDEXED_FILES = 4000;
/** Rows listed at most (the rest is counted: "+ n more"). */
export const MAX_SHOWN = 40;
export const TASK_TEXT_MAX = 140;

// -------------------------------------------------------------------------------------------------------------- dates

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isIsoDay(s: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (!m) return false;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** `YYYY-MM-DD` of a day number (model/calendar). */
export function isoOf(dn: number): string {
	const { y, m, d } = civil(dn);
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The day a daily note's file name starts with (`2026-03-12.md`, `2026-03-12 Thursday.md`), or null. */
export function dailyDateOf(path: string): string | null {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const m = /^(\d{4}-\d{2}-\d{2})(?![\d])/.exec(base);
	return m && isIsoDay(m[1]!) ? m[1]! : null;
}

const MONTH_WORDS: ReadonlyMap<string, number> = (() => {
	const map = new Map<string, number>();
	for (const lang of LANGS) {
		for (let m = 1; m <= 12; m++) {
			map.set(monthName(lang, m).toLowerCase(), m);
			map.set(monthName(lang, m, true).toLowerCase(), m);
		}
	}
	return map;
})();

interface Dmy {
	d: number;
	m: number | null;
	y: number | null;
}

/** "2", "30 Mar", "29 Dec 2025", "12 marzo 2026" (the whole text). */
function parseDmy(s: string): Dmy | null {
	const m = /^\s*(\d{1,2})(?:\s+(\p{L}+)\.?)?(?:\s+(\d{4}))?\s*$/u.exec(s);
	if (!m) return null;
	let month: number | null = null;
	if (m[2] !== undefined) {
		month = MONTH_WORDS.get(m[2].toLowerCase()) ?? null;
		if (month === null) return null;
	}
	return { d: Number(m[1]), m: month, y: m[3] !== undefined ? Number(m[3]) : null };
}

function valid(y: number, m: number, d: number): boolean {
	return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** The day or days a planner title names: one day, or the seven (at most 14) of a week range; [] when it names none. */
export function datesInTitle(text: string): string[] {
	const t = text.replace(/\s+/g, " ").trim();
	const dot = t.lastIndexOf("·");
	const body = dot >= 0 ? t.slice(dot + 1).trim() : t;
	const split = /^(\d.*?)\s*[–—-]\s*(\d.*)$/u.exec(body);
	if (split) {
		const right = parseDmy(split[2]!);
		const left = parseDmy(split[1]!);
		if (!right || right.m === null || right.y === null || !left) return [];
		const lm = left.m ?? right.m;
		let ly = left.y ?? right.y;
		// "29 Dec – 4 Jan 2026" has no year on the left and crosses the new year.
		if (left.y === null && left.m !== null && left.m > right.m) ly = right.y - 1;
		if (!valid(ly, lm, left.d) || !valid(right.y, right.m, right.d)) return [];
		const a = dayNumber(ly, lm, left.d);
		const b = dayNumber(right.y, right.m, right.d);
		if (b < a || b - a > 13) return [];
		const out: string[] = [];
		for (let dn = a; dn <= b; dn++) out.push(isoOf(dn));
		return out;
	}
	const one = /(\d{1,2})\s+(\p{L}+)\.?\s+(\d{4})/u.exec(body);
	if (!one) return [];
	const m = MONTH_WORDS.get(one[2]!.toLowerCase());
	if (m === undefined) return [];
	const d = Number(one[1]);
	const y = Number(one[3]);
	return valid(y, m, d) ? [isoOf(dayNumber(y, m, d))] : [];
}

/** Texts above this page y (pt) are the title of a planner page. */
const TITLE_Y = 40;

/** The days a planner page stands for (daily or weekly planner paper with a title the generator wrote); [] for any other page. */
export function plannerPageDates(page: Pick<Page, "paper" | "elements"> | null | undefined): string[] {
	if (!page) return [];
	const kind = page.paper.kind;
	if (kind !== "planner-day" && kind !== "planner-week") return [];
	for (const el of page.elements ?? []) {
		if (el.type !== "text" || el.y > TITLE_Y) continue;
		const days = datesInTitle(el.text);
		if (days.length > 0) return days;
	}
	return [];
}

// -------------------------------------------------------------------------------------------------------------- tasks

const TASK_LINE = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[(.)\][ \t]+(.*)$/u;
const TASKS_DUE = /📅️?\s*(\d{4}-\d{2}-\d{2})/u;
const DATAVIEW_DUE = /(?:[[(]\s*due\s*::\s*(\d{4}-\d{2}-\d{2})[^\])]*[\])])|(?:\bdue\s*::\s*(\d{4}-\d{2}-\d{2}))/iu;

/** The due day written on a task line (the text after the checkbox), or null. */
export function dueOf(rest: string): string | null {
	const a = TASKS_DUE.exec(rest);
	if (a && isIsoDay(a[1]!)) return a[1]!;
	const b = DATAVIEW_DUE.exec(rest);
	const day = b ? (b[1] ?? b[2]) : undefined;
	return day !== undefined && isIsoDay(day) ? day : null;
}

/** The task text without date markers (📅 ⏳ 🛫 ✅ ➕ ❌ + day), inline fields `[key:: value]` and a trailing block id. */
export function cleanTaskText(rest: string): string {
	const s = rest
		.replace(/[📅⏳🛫✅➕❌]️?\s*\d{4}-\d{2}-\d{2}/gu, " ")
		.replace(/[[(]\s*[\p{L}_-]+\s*::[^\])]*[\])]/gu, " ")
		.replace(/\s\^[\w-]+\s*$/u, " ")
		.replace(/\s+/g, " ")
		.trim();
	return s.length > TASK_TEXT_MAX ? `${s.slice(0, TASK_TEXT_MAX - 1).trimEnd()}…` : s;
}

/** The task lines of a note that have a due day (see the file header). Frontmatter and fenced code are skipped; cancelled tasks (`[-]`) too. */
export function extractTasks(path: string, text: string): TaskEntry[] {
	const daily = dailyDateOf(path);
	const lines = text.split("\n");
	const out: TaskEntry[] = [];
	let i = 0;
	if (lines[0]?.trimEnd() === "---") {
		let end = -1;
		for (let k = 1; k < lines.length && k < 200; k++) {
			const l = lines[k]!.trimEnd();
			if (l === "---" || l === "...") {
				end = k;
				break;
			}
		}
		if (end > 0) i = end + 1;
	}
	let fence: string | null = null;
	for (; i < lines.length && out.length < MAX_FILE_TASKS; i++) {
		const raw = lines[i]!;
		const f = /^[ \t]*(`{3,}|~{3,})/.exec(raw);
		if (f) {
			const mark = f[1]![0]!;
			if (fence === null) fence = mark;
			else if (fence === mark) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const m = TASK_LINE.exec(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
		if (!m) continue;
		const status = m[1]!;
		if (status === "-") continue;
		const due = dueOf(m[2]!) ?? daily;
		if (due === null) continue;
		const clean = cleanTaskText(m[2]!);
		if (clean === "") continue;
		out.push({ path, line: i, done: status === "x" || status === "X", text: clean, due });
	}
	return out;
}

/** True when the metadata cache says a note has at least one task item (so reading it is worth it). */
export function hasTaskItems(listItems: ReadonlyArray<{ task?: string }> | undefined): boolean {
	return !!listItems && listItems.some((li) => li.task !== undefined);
}

// -------------------------------------------------------------------------------------------------------------- index

export interface DueTasks {
	/** Open tasks first, then done ones; by day, note, line. At most `MAX_SHOWN`. */
	items: TaskEntry[];
	/** Tasks found (before the cut). */
	total: number;
	open: number;
}

export class TaskIndex {
	private readonly files = new Map<string, { stamp: number; entries: TaskEntry[] }>();
	private byDay: Map<string, TaskEntry[]> | null = null;
	private count = 0;
	/** True once a note was left out or cut because of a bound. */
	truncated = false;

	/** The stamp (modified time) the note was indexed at, or null. */
	stampOf(path: string): number | null {
		return this.files.get(path)?.stamp ?? null;
	}

	get fileCount(): number {
		return this.files.size;
	}

	get taskCount(): number {
		return this.count;
	}

	/** Replaces the tasks of one note. Returns false (nothing stored) when the bounds forbid a new note. */
	set(path: string, stamp: number, entries: readonly TaskEntry[]): boolean {
		const old = this.files.get(path);
		const oldN = old?.entries.length ?? 0;
		if (!old && this.files.size >= MAX_INDEXED_FILES) {
			this.truncated = true;
			return false;
		}
		let list = entries.slice(0, MAX_FILE_TASKS);
		if (this.count - oldN + list.length > MAX_TOTAL_TASKS) {
			this.truncated = true;
			list = list.slice(0, Math.max(0, MAX_TOTAL_TASKS - (this.count - oldN)));
		}
		this.count += list.length - oldN;
		if (list.length === 0) this.files.delete(path);
		else this.files.set(path, { stamp, entries: list });
		this.byDay = null;
		return true;
	}

	remove(path: string): boolean {
		const old = this.files.get(path);
		if (!old) return false;
		this.count -= old.entries.length;
		this.files.delete(path);
		this.byDay = null;
		return true;
	}

	clear(): void {
		this.files.clear();
		this.byDay = null;
		this.count = 0;
		this.truncated = false;
	}

	/** The tasks due on any of these days (`YYYY-MM-DD`). */
	dueOn(days: readonly string[]): DueTasks {
		if (!this.byDay) {
			const map = new Map<string, TaskEntry[]>();
			for (const f of this.files.values()) for (const e of f.entries) (map.get(e.due) ?? map.set(e.due, []).get(e.due)!).push(e);
			this.byDay = map;
		}
		const all: TaskEntry[] = [];
		for (const d of new Set(days)) {
			const list = this.byDay.get(d);
			if (list) all.push(...list);
		}
		all.sort((a, b) => Number(a.done) - Number(b.done) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
		return { items: all.slice(0, MAX_SHOWN), total: all.length, open: all.reduce((n, e) => n + (e.done ? 0 : 1), 0) };
	}
}
