/**
 * The planner generator (roadmap #118). Pure: no 'obsidian', no DOM. Builds the document of a planner notebook from a few
 * choices, with no format change: only existing page papers and existing element types.
 *
 * - Pages: a year overview (twelve mini calendars), one calendar per month, one spread per week, one page per day, and some
 *   notes pages. Month pages sit on grid paper whose spacing is the calendar cell; weeks and days use the weekly and daily
 *   planner papers; so the rules are vector paper, never ink.
 * - Text: titles, weekday names, dates and hours are typed text boxes (never ink). Dates are plain text.
 * - Links: a text box that holds one `[[Notebook.notebook#p14&id=d71|label]]` link is the notebook's page link (ink/link-text.ts):
 *   tapping it opens that page. Every page links up (day -> week -> month -> year) and down (year -> months, month -> weeks or
 *   days, week -> days). The link text shows its markup on the page, as every link written in a text box does.
 * - Page ids are short and fixed (`y`, `m3`, `w12`, `d71`, `n1`), so a link keeps working when pages are inserted or moved.
 * - Outline: the year, every month (or the first week or day of it when months are left out) and the notes get a titled
 *   bookmark, which is the notebook outline.
 *
 * The page order is chronological: the year, then for each month its page, the weeks whose middle day falls in it and its
 * days, then the notes. Building 366 day pages is a few thousand small text boxes and takes a few milliseconds.
 */
import { linkMarkup } from "../ink/link-text";
import { estimateMeasure, LINE_HEIGHT, textElementBounds } from "../ink/text-layout";
import { stablePageSubpath } from "../integration/page-links";
import { setBookmark } from "./bookmarks";
import {
	civil, columnWeekday, dayNumber, daysInMonth, MAX_PLANNER_YEAR, MIN_PLANNER_YEAR, monthIndexIn, monthName, monthRows, planRange,
	weekday, weekdayName, weekNumber, weekStartOf, weekStartsIn, type CalendarLang, type PlanRange, type WeekStart,
} from "./calendar";
import { cloneMeta, createId } from "./document";
import { freezeElement } from "./serialize";
import { CURRENT_VERSION, DEFAULT_META, FORMAT_ID, MM, PAPER_SPACING, type NotebookDocument, type Page, type PageElement, type PaperKind, type TextElement } from "./types";

export interface PlannerSections {
	/** The year overview. */
	year: boolean;
	/** One calendar per month. */
	months: boolean;
	/** One spread per week. */
	weeks: boolean;
	/** One page per day. */
	days: boolean;
	/** Blank pages for notes at the end. */
	notes: boolean;
}

export interface PlannerOptions {
	/** The year the plan starts in. */
	year: number;
	/** 1 = a calendar year; 9 = an academic year (September of `year` to August of `year + 1`). */
	startMonth: number;
	/** The language of the names (months, weekdays, titles); independent of the interface language. */
	lang: CalendarLang;
	weekStart: WeekStart;
	size: { width: number; height: number };
	sections: PlannerSections;
	/** How many notes pages when `sections.notes` is on. */
	notesPages: number;
	/** What the links name: the notebook file as Obsidian resolves it (`Planner 2026.notebook`, or its vault path). */
	linkTarget: string;
	/** Ids of text boxes (default `createId`); tests pass a counter. */
	newId?: () => string;
}

export const NOTES_PAGES_MAX = 100;
export const NOTES_PAGES_DEFAULT = 6;
/** Above this many pages the dialog warns that the notebook is large. */
export const PLANNER_LARGE_PAGES = 200;

export type PlannerProblem = "year" | "month" | "sections" | "notes" | "size";

/** Why the choices cannot make a planner (null when they can). */
export function plannerProblem(o: Pick<PlannerOptions, "year" | "startMonth" | "sections" | "notesPages" | "size">): PlannerProblem | null {
	if (!Number.isInteger(o.year) || o.year < MIN_PLANNER_YEAR || o.year > MAX_PLANNER_YEAR) return "year";
	if (!Number.isInteger(o.startMonth) || o.startMonth < 1 || o.startMonth > 12) return "month";
	if (!(o.size.width >= 100 && o.size.height >= 100)) return "size";
	if (!Number.isInteger(o.notesPages) || o.notesPages < 0 || o.notesPages > NOTES_PAGES_MAX) return "notes";
	const s = o.sections;
	if (!(s.year || s.months || s.weeks || s.days || (s.notes && o.notesPages > 0))) return "sections";
	return null;
}

// ------------------------------------------------------------------------------------------------------------- texts

interface Words {
	week: string;
	notes: string;
	schedule: string;
	weeksList: string;
	daysList: string;
	up: { year: string; month: string; week: string };
}

const WORDS: Record<CalendarLang, Words> = {
	en: { week: "Week", notes: "Notes", schedule: "Schedule", weeksList: "Weeks", daysList: "Days", up: { year: "Year", month: "Month", week: "Week" } },
	it: { week: "Settimana", notes: "Note", schedule: "Programma", weeksList: "Settimane", daysList: "Giorni", up: { year: "Anno", month: "Mese", week: "Settimana" } },
};

/** Title of the year page: `2026`, or `2025–2026` for a plan that crosses the new year. */
export function yearTitle(range: PlanRange): string {
	const a = range.months[0]!.y;
	const b = range.months[11]!.y;
	return a === b ? String(a) : `${a}–${b}`;
}

/** `Thursday, 12 March 2026` / `Giovedì 12 marzo 2026`. */
export function dayTitle(lang: CalendarLang, dn: number): string {
	const { y, m, d } = civil(dn);
	const wd = weekdayName(lang, weekday(dn));
	const month = lang === "en" ? monthName(lang, m) : monthName(lang, m).toLowerCase();
	return lang === "en" ? `${wd}, ${d} ${month} ${y}` : `${wd} ${d} ${month} ${y}`;
}

/** `2–8 March 2026`, `30 Mar – 5 Apr 2026`, `29 Dec 2025 – 4 Jan 2026`. */
export function weekRangeLabel(lang: CalendarLang, first: number): string {
	const a = civil(first);
	const b = civil(first + 6);
	const mon = (m: number, short: boolean) => (lang === "en" ? monthName(lang, m, short) : monthName(lang, m, short).toLowerCase());
	if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${mon(a.m, false)} ${a.y}`;
	if (a.y === b.y) return `${a.d} ${mon(a.m, true)} – ${b.d} ${mon(b.m, true)} ${b.y}`;
	return `${a.d} ${mon(a.m, true)} ${a.y} – ${b.d} ${mon(b.m, true)} ${b.y}`;
}

// ------------------------------------------------------------------------------------------------------------- plan

export type SlotKind = "year" | "month" | "week" | "day" | "notes";

/** One page of the plan: what it is, its id, and its 1-based position. */
export interface Slot {
	kind: SlotKind;
	id: string;
	/** 1-based page number. */
	page: number;
	/** Week: its first day. Day: the day. */
	dn?: number;
	/** Index of the month in the plan (0-11); for a week, the month it belongs to. */
	mi?: number;
	/** Notes: 1-based number. */
	n?: number;
}

export interface Plan {
	range: PlanRange;
	slots: Slot[];
	year?: Slot;
	months: Array<Slot | undefined>;
	/** Weeks by their first day. */
	weeks: Map<number, Slot>;
	/** Days by day number. */
	days: Map<number, Slot>;
	notes: Slot[];
}

/** The pages a planner holds, in order. */
export function planPlanner(o: Pick<PlannerOptions, "year" | "startMonth" | "weekStart" | "sections" | "notesPages">): Plan {
	const range = planRange(o.year, o.startMonth);
	const slots: Slot[] = [];
	const add = (slot: Omit<Slot, "page">): Slot => {
		const full: Slot = { ...slot, page: slots.length + 1 };
		slots.push(full);
		return full;
	};
	const plan: Plan = { range, slots, months: new Array<Slot | undefined>(12).fill(undefined), weeks: new Map(), days: new Map(), notes: [] };
	if (o.sections.year) plan.year = add({ kind: "year", id: "y" });
	// Weeks belong to the month of their middle day (inside the plan), so a week never needs two pages.
	const weekMonth = new Map<number, number>();
	if (o.sections.weeks) {
		for (const w of weekStartsIn(range.start, range.end, o.weekStart)) {
			const mid = Math.min(range.end, Math.max(range.start, w + 3));
			weekMonth.set(w, monthIndexIn(range, mid));
		}
	}
	const weekList = [...weekMonth.keys()];
	let weekCursor = 0;
	let weekNo = 0;
	let dayNo = 0;
	for (let mi = 0; mi < 12; mi++) {
		const { y, m } = range.months[mi]!;
		if (o.sections.months) plan.months[mi] = add({ kind: "month", id: `m${m}`, mi });
		while (weekCursor < weekList.length && weekMonth.get(weekList[weekCursor]!) === mi) {
			const dn = weekList[weekCursor++]!;
			plan.weeks.set(dn, add({ kind: "week", id: `w${++weekNo}`, dn, mi }));
		}
		if (o.sections.days) {
			const first = dayNumber(y, m, 1);
			for (let d = 0; d < daysInMonth(y, m); d++) plan.days.set(first + d, add({ kind: "day", id: `d${++dayNo}`, dn: first + d, mi }));
		}
	}
	if (o.sections.notes) for (let n = 1; n <= o.notesPages; n++) plan.notes.push(add({ kind: "notes", id: `n${n}`, n }));
	return plan;
}

/** How many pages the choices make (0 when they are not valid). */
export function plannerPageCount(o: Pick<PlannerOptions, "year" | "startMonth" | "weekStart" | "sections" | "notesPages" | "size">): number {
	return plannerProblem(o) === null ? planPlanner(o).slots.length : 0;
}

// ------------------------------------------------------------------------------------------------------------- build

const INK = "#1f2937";
const MUTED = "#6b7280";
const SOFT = "#9ca3af";
const LINK = "#2563eb";
const MARGIN = 10 * MM;
/** Most links listed on a page; above it the page links to the first one only. */
const MAX_LIST = 60;

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const textWidth = (s: string, fs: number) => Math.max(...s.split("\n").map((l) => estimateMeasure(l, fs)), 0);

interface Build {
	o: PlannerOptions;
	plan: Plan;
	W: number;
	H: number;
	words: Words;
	newId: () => string;
}

function plain(b: Build, x: number, y: number, maxWidth: number, text: string, fs: number, color = INK, exact = false): TextElement {
	const width = exact ? maxWidth : Math.min(maxWidth, Math.ceil(textWidth(text, fs) * 1.15) + 4);
	return freezeElement({ id: b.newId(), type: "text", x: round2(x), y: round2(y), width: round2(Math.max(4, width)), text, fontSize: round2(fs), color });
}

/** The markup of a link to `slot`. */
function markup(b: Build, slot: Slot, label: string): string {
	return linkMarkup(`${b.o.linkTarget}${stablePageSubpath(slot.page, slot.id)}`, label);
}

/** The largest font size in [min, max] at which `length` characters of a link fit in `width` (min when none does). */
function fitFont(length: number, width: number, max: number, min: number): number {
	const fs = Math.floor((width / (length * 0.55 + 0.3)) * 2) / 2;
	return clamp(fs, min, max);
}

/** A text box that is one page link: tapping it opens the page. Its box is the tap area. */
function link(b: Build, slot: Slot, label: string, x: number, y: number, width: number, maxFs = 8, minFs = 6): TextElement {
	const text = markup(b, slot, label);
	const fs = fitFont(Array.from(text).length, width, maxFs, minFs);
	return freezeElement({ id: b.newId(), type: "text", x: round2(x), y: round2(y), width: round2(Math.max(10, width)), text, fontSize: fs, color: LINK });
}

const height = (el: TextElement) => textElementBounds(el).maxY - el.y;

interface Area {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface LinkItem {
	slot: Slot;
	label: string;
}

/** How a list of links fits an area: font size, columns and rows. */
function listShape(items: readonly LinkItem[], b: Build, w: number, h: number, maxFs = 7.5): { fs: number; cols: number; rows: number; rowH: number } {
	const longest = Math.max(...items.map((i) => Array.from(markup(b, i.slot, i.label)).length), 1);
	let shape = { fs: 6, cols: 1, rows: 1, rowH: 6 * LINE_HEIGHT + 3 };
	for (let fs = maxFs; fs >= 6; fs -= 0.5) {
		const itemW = Math.ceil(longest * 0.55 * fs) + 10;
		const cols = Math.max(1, Math.floor(w / itemW));
		const rowH = fs * LINE_HEIGHT + 3;
		const rows = Math.max(1, Math.floor(h / rowH));
		shape = { fs, cols, rows, rowH };
		if (cols * rows >= items.length) break;
	}
	return shape;
}

/** Height a list of `count` links needs in a width, at the preferred size. */
function listHeight(items: readonly LinkItem[], b: Build, w: number): number {
	const longest = Math.max(...items.map((i) => Array.from(markup(b, i.slot, i.label)).length), 1);
	const fs = 7;
	const cols = Math.max(1, Math.floor(w / (Math.ceil(longest * 0.55 * fs) + 10)));
	return Math.ceil(items.length / cols) * (fs * LINE_HEIGHT + 3);
}

/** Lays links out in columns (column-major) inside the area, under a small heading; returns the boxes. */
function linkList(b: Build, area: Area, heading: string, items: readonly LinkItem[]): TextElement[] {
	if (items.length === 0) return [];
	const out: TextElement[] = [];
	let y = area.y;
	let h = area.h;
	if (heading) {
		out.push(plain(b, area.x, y, area.w, heading, 9, MUTED));
		y += 9 * LINE_HEIGHT + 3;
		h -= 9 * LINE_HEIGHT + 3;
	}
	const { fs, cols, rows, rowH } = listShape(items, b, area.w, h);
	const colW = area.w / cols;
	items.slice(0, cols * rows).forEach((item, i) => {
		const c = Math.floor(i / rows);
		const r = i % rows;
		out.push(link(b, item.slot, item.label, area.x + c * colW, y + r * rowH, colW - 4, fs, fs));
	});
	return out;
}

/** The text of a link list: the first slot only when the list is too long to be useful. */
function listOf(items: LinkItem[], first: LinkItem | undefined): LinkItem[] {
	return items.length <= MAX_LIST ? items : first ? [first] : [];
}

function page(b: Build, slot: Slot, paper: PaperKind, spacing: number, elements: PageElement[]): Page {
	return { id: slot.id, width: b.W, height: b.H, paper: { kind: paper, spacing: round2(spacing) }, strokes: [], elements };
}

/** The slot a page links up to: the nearest coarser level that exists. */
function parentOf(b: Build, slot: Slot): { slot: Slot; label: string } | null {
	const { plan, words } = b;
	const week = (dn: number) => plan.weeks.get(weekStartOf(dn, b.o.weekStart));
	const month = (mi: number | undefined) => (mi === undefined ? undefined : plan.months[mi]);
	const pick = (...c: Array<[Slot | undefined, string]>): { slot: Slot; label: string } | null => {
		for (const [s, label] of c) if (s) return { slot: s, label };
		return null;
	};
	switch (slot.kind) {
		case "day": return pick([week(slot.dn!), words.up.week], [month(slot.mi), words.up.month], [plan.year, words.up.year]);
		case "week": return pick([month(slot.mi), words.up.month], [plan.year, words.up.year]);
		case "month": return pick([plan.year, words.up.year]);
		case "notes": return pick([plan.year, words.up.year], [plan.slots[0] !== slot ? plan.slots[0] : undefined, words.up.year]);
		default: return null;
	}
}

/** The up link of a page, as a small link under its title. */
function upLink(b: Build, slot: Slot, x: number, y: number, width: number): TextElement[] {
	const parent = parentOf(b, slot);
	return parent ? [link(b, parent.slot, `‹ ${parent.label}`, x, y, width, 8, 6)] : [];
}

// ---- year

function yearPage(b: Build, slot: Slot): Page {
	const { W, H, o, plan } = b;
	const els: PageElement[] = [];
	const m = MARGIN;
	els.push(plain(b, m, 16, W - 2 * m, yearTitle(plan.range), clamp(W * 0.045, 18, 30), INK));
	// Links down that the tiles cannot carry: the first week or day when there are no month pages, and the notes.
	const navY = 16 + 30 * LINE_HEIGHT + 2;
	const nav: Array<[Slot, string]> = [];
	if (!plan.months.some((s) => s !== undefined)) {
		const firstWeek = [...plan.weeks.values()][0];
		const firstDay = [...plan.days.values()][0];
		if (firstWeek) nav.push([firstWeek, b.words.weeksList]);
		else if (firstDay) nav.push([firstDay, b.words.daysList]);
	}
	if (plan.notes[0]) nav.push([plan.notes[0], b.words.notes]);
	nav.forEach(([s, label], i) => els.push(link(b, s, label, m + i * ((W - 2 * m) / 3), navY, (W - 2 * m) / 3 - 6, 8, 6)));
	const top = navY + 24;
	const cols = W > H ? 4 : 3;
	const rows = 12 / cols;
	const tw = (W - 2 * m) / cols;
	const th = (H - m - top) / rows;
	plan.range.months.forEach(({ y, m: mo }, i) => {
		const tx = m + (i % cols) * tw;
		const tileTop = top + Math.floor(i / cols) * th;
		let ty = tileTop;
		const inner = tw - 8;
		els.push(plain(b, tx + 2, ty, inner, monthName(o.lang, mo), 11, INK));
		ty += 11 * LINE_HEIGHT + 1;
		const monthSlot = plan.months[i];
		if (monthSlot) {
			const el = link(b, monthSlot, monthName(o.lang, mo, true), tx + 2, ty, inner, 7, 5.5);
			els.push(el);
			ty += height(el) + 3;
		}
		const rowsOfMonth = monthRows(y, mo, o.weekStart);
		const colW = inner / 7;
		const fs = clamp(Math.min(colW / 2.1, (th - (ty - tileTop) - 4) / ((rowsOfMonth.length + 1) * LINE_HEIGHT)), 4.5, 8.5);
		for (let c = 0; c < 7; c++) {
			const wd = columnWeekday(c, o.weekStart);
			const lines = [Array.from(weekdayName(o.lang, wd))[0]!.toUpperCase(), ...rowsOfMonth.map((r) => (r[c] === null ? "" : String(r[c])))];
			while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			els.push(plain(b, tx + 2 + c * colW, ty, colW, lines.join("\n"), fs, wd === 0 || wd === 6 ? SOFT : INK, true));
		}
	});
	return page(b, slot, "blank", PAPER_SPACING.blank, els);
}

// ---- month

function monthPage(b: Build, slot: Slot): Page {
	const { W, H, o, plan, words } = b;
	const { y, m } = plan.range.months[slot.mi!]!;
	const els: PageElement[] = [];
	const landscape = W > H * 1.15;
	// The children of the month: its weeks, else its days.
	let children: LinkItem[] = [];
	let heading = "";
	const first = dayNumber(y, m, 1);
	const last = first + daysInMonth(y, m) - 1;
	if (o.sections.weeks) {
		heading = words.weeksList;
		for (const w of weekStartsIn(first, last, o.weekStart)) {
			const ws = plan.weeks.get(w);
			if (!ws) continue;
			const num = weekNumber(w, o.weekStart).week;
			const a = civil(Math.max(w, first));
			const z = civil(Math.min(w + 6, last));
			children.push({ slot: ws, label: `${words.week.charAt(0)}${num}  ${a.d}–${z.d}` });
		}
		children = listOf(children, children[0]);
	} else if (o.sections.days) {
		heading = words.daysList;
		for (let dn = first; dn <= last; dn++) {
			const ds = plan.days.get(dn);
			if (ds) children.push({ slot: ds, label: `${civil(dn).d} ${weekdayName(o.lang, weekday(dn), true)}` });
		}
		children = listOf(children, children[0]);
	}
	let cell: number;
	let area: Area;
	if (landscape) {
		cell = Math.floor(Math.min(H / 8, (W * 0.66) / 7) * 100) / 100;
		const x0 = 7 * cell + 14;
		area = { x: x0, y: 10, w: W - x0 - 10, h: H - 20 };
	} else {
		const w = W - 16;
		const need = children.length > 0 ? listHeight(children, b, w) + 9 * LINE_HEIGHT + 3 + 14 : 0;
		cell = Math.floor(Math.max(28, Math.min(W / 7, (H - need) / 8)) * 100) / 100;
		const y0 = 8 * cell + 8;
		area = { x: 8, y: y0, w, h: H - y0 - 8 };
	}
	const titleFs = clamp(cell * 0.3, 12, 26);
	els.push(plain(b, 8, 8, 7 * cell - 12, `${monthName(o.lang, m)} ${y}`, titleFs, INK));
	els.push(...upLink(b, slot, 8, 8 + titleFs * LINE_HEIGHT + 3, 7 * cell - 12));
	for (let c = 0; c < 7; c++) {
		const wd = columnWeekday(c, o.weekStart);
		els.push(plain(b, c * cell + 5, cell + (cell - 10 * LINE_HEIGHT) / 2, cell - 8, weekdayName(o.lang, wd, true), 10, wd === 0 || wd === 6 ? SOFT : MUTED));
	}
	monthRows(y, m, o.weekStart).forEach((row, r) => {
		row.forEach((day, c) => {
			if (day === null) return;
			const wd = columnWeekday(c, o.weekStart);
			els.push(plain(b, c * cell + 5, (2 + r) * cell + 4, cell - 8, String(day), clamp(cell * 0.17, 8, 14), wd === 0 || wd === 6 ? SOFT : INK));
		});
	});
	els.push(...linkList(b, area, heading, children));
	return page(b, slot, "grid", cell, els);
}

// ---- week

const SPACING_WEEK = PAPER_SPACING["planner-week"];
const SPACING_DAY = PAPER_SPACING["planner-day"];
const HEADER_ROWS = 3;

function weekPage(b: Build, slot: Slot): Page {
	const { W, H, o, plan, words } = b;
	const els: PageElement[] = [];
	const sp = SPACING_WEEK;
	const first = slot.dn!;
	const num = weekNumber(first, o.weekStart).week;
	els.push(plain(b, 8, 5, W - 16, `${words.week} ${num} · ${weekRangeLabel(o.lang, first)}`, 16, INK));
	els.push(...upLink(b, slot, 8, 5 + 16 * LINE_HEIGHT + 4, 140));
	// The boxes of the weekly planner paper (ink/paper-kinds.ts): 2 x 4 portrait, 4 x 2 landscape; seven days and a notes box.
	const header = HEADER_ROWS * sp;
	const bottom = H - sp;
	const cols = W > H ? 4 : 2;
	const rows = 8 / cols;
	const boxW = W / cols;
	const boxH = (bottom - header) / rows;
	for (let i = 0; i < 8; i++) {
		const bx = (i % cols) * boxW;
		const by = header + Math.floor(i / cols) * boxH;
		if (i === 7) {
			els.push(plain(b, bx + 5, by + 3, boxW - 10, words.notes, 9, MUTED));
			continue;
		}
		const dn = first + i;
		const { d } = civil(dn);
		const name = weekdayName(o.lang, weekday(dn), true);
		const label = i === 0 || d === 1 ? `${name} ${d} ${monthName(o.lang, civil(dn).m, true)}` : `${name} ${d}`;
		const day = plan.days.get(dn);
		const weekend = weekday(dn) === 0 || weekday(dn) === 6;
		if (day) els.push(link(b, day, label, bx + 5, by + 2, boxW - 10, 9, 6));
		else els.push(plain(b, bx + 5, by + 3, boxW - 10, label, 9, weekend ? SOFT : INK));
	}
	return page(b, slot, "planner-week", sp, els);
}

// ---- day

function dayPage(b: Build, slot: Slot): Page {
	const { W, H, o, words } = b;
	const els: PageElement[] = [];
	const sp = SPACING_DAY;
	const header = HEADER_ROWS * sp;
	els.push(plain(b, 8, 8, W - 16, dayTitle(o.lang, slot.dn!), 17, INK));
	els.push(...upLink(b, slot, 8, 8 + 17 * LINE_HEIGHT + 5, 160));
	// Column captions above the schedule and the notes column (ink/paper-kinds.ts plannerDay).
	const timeCol = 20 * MM;
	const split = W * 0.62;
	els.push(plain(b, timeCol + 4, header - 8 * LINE_HEIGHT - 3, split - timeCol - 8, words.schedule, 8, MUTED));
	els.push(plain(b, split + 6, header - 8 * LINE_HEIGHT - 3, W - split - 12, words.notes, 8, MUTED));
	// Hours down the time column: one line per paper row (an hour is two rows), from 6.
	const rowCount = Math.floor((H - sp - header) / sp + 1e-6);
	const hours = clamp(Math.floor(rowCount / 2), 0, 18);
	if (hours > 0) {
		const lines: string[] = [];
		for (let h = 0; h < hours; h++) lines.push(String(6 + h), "");
		lines.pop();
		els.push(plain(b, 6, header, timeCol - 8, lines.join("\n"), round2(sp / LINE_HEIGHT), SOFT, true));
	}
	return page(b, slot, "planner-day", sp, els);
}

// ---- notes

function notesPage(b: Build, slot: Slot): Page {
	const els: PageElement[] = [plain(b, MARGIN, 14, b.W - 2 * MARGIN, `${b.words.notes} ${slot.n}`, 22, INK)];
	els.push(...upLink(b, slot, MARGIN, 14 + 22 * LINE_HEIGHT + 4, 160));
	return page(b, slot, "dotted", PAPER_SPACING.dotted, els);
}

// ---- document

/** The pages of the planner, in order, and the outline bookmarks (page id and title). */
export function buildPlanner(o: PlannerOptions): { pages: Page[]; bookmarks: Array<{ id: string; title: string }> } {
	const problem = plannerProblem(o);
	if (problem) throw new Error(`Invalid planner: ${problem}`);
	const plan = planPlanner(o);
	const b: Build = { o, plan, W: o.size.width, H: o.size.height, words: WORDS[o.lang], newId: o.newId ?? createId };
	const pages = plan.slots.map((slot): Page => {
		switch (slot.kind) {
			case "year": return yearPage(b, slot);
			case "month": return monthPage(b, slot);
			case "week": return weekPage(b, slot);
			case "day": return dayPage(b, slot);
			case "notes": return notesPage(b, slot);
		}
	});
	const bookmarks: Array<{ id: string; title: string }> = [];
	if (plan.year) bookmarks.push({ id: plan.year.id, title: yearTitle(plan.range) });
	plan.range.months.forEach(({ y, m }, mi) => {
		const title = `${monthName(o.lang, m)} ${y}`;
		const target = plan.months[mi] ?? firstOfMonth(plan, mi);
		if (target) bookmarks.push({ id: target.id, title });
	});
	if (plan.notes[0]) bookmarks.push({ id: plan.notes[0].id, title: b.words.notes });
	return { pages, bookmarks };
}

function firstOfMonth(plan: Plan, mi: number): Slot | undefined {
	return plan.slots.find((s) => (s.kind === "week" || s.kind === "day") && s.mi === mi);
}

/** The notebook document of a planner. The caller sets the cover (`applyNotebookMeta`). */
export function plannerDocument(o: PlannerOptions, now: Date = new Date()): NotebookDocument {
	const { pages, bookmarks } = buildPlanner(o);
	const iso = now.toISOString();
	let meta = cloneMeta(DEFAULT_META);
	for (const bm of bookmarks) meta = setBookmark(meta, bm.id, { title: bm.title });
	return { format: FORMAT_ID, version: CURRENT_VERSION, id: createId(), createdAt: iso, modifiedAt: iso, pages, meta, assets: {} };
}
