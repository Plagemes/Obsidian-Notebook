/**
 * The Calendar view of the library (0.15, roadmap #162): what was written on each day. Drawn from the data the library
 * view gives it (`CalendarDeps`, built by calendar-logic.ts from the index and the activity log): it reads nothing itself,
 * and so never opens a notebook to draw.
 *
 * - Wide and medium: a month grid, each day marked with dots in the colours of the notebooks written that day, and the
 *   selected day's notebooks and pages beside it (under it on a narrow tablet).
 * - Phone: a week strip and an agenda of the week.
 * - Tapping a notebook of a day opens it at the page written that day; a page chip opens that page.
 */
import { t } from "../i18n";
import { iconButton, pressable, setIconSafe } from "../ui/components/dom";
import {
	addDays, dayLevel, monthGrid, parseDay, shiftMonth, weekOf,
	type CalendarMap, type DayItem, type DaySummary,
} from "./calendar-logic";

export interface CalendarDeps {
	phone: boolean;
	/** Any day of the month (or, on a phone, of the week) shown. */
	cursor: string;
	selected: string | null;
	today: string;
	data: CalendarMap;
	weekStart: 0 | 1;
	locale: string;
	colorOf(path: string): string;
	/** The 1-based page a written page key is known to be (from this device's recent edits), or null. */
	pageNumber(path: string, pageKey: string): number | null;
	setCursor(day: string): void;
	select(day: string): void;
	/** Opens the notebook at a page (its short key) or, without one, the notebook. */
	open(item: DayItem, pageKey: string | null): void;
}

const MAX_DOTS = 3;

const fmt = (locale: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, o);

export function renderCalendar(el: HTMLElement, d: CalendarDeps): void {
	const root = el.createDiv({ cls: "nb-cal" });
	root.toggleClass("is-phone", d.phone);
	const cursorDate = parseDay(d.cursor) ?? new Date();
	const week = weekOf(d.cursor, d.weekStart);

	const bar = root.createDiv({ cls: "nb-cal-bar" });
	const title = d.phone
		? `${fmt(d.locale, { day: "numeric", month: "short" }).format(parseDay(week[0]!) ?? cursorDate)} – ${fmt(d.locale, { day: "numeric", month: "short", year: "numeric" }).format(parseDay(week[6]!) ?? cursorDate)}`
		: fmt(d.locale, { month: "long", year: "numeric" }).format(cursorDate);
	const step = (dir: -1 | 1) => d.setCursor(d.phone ? addDays(d.cursor, 7 * dir) : shiftMonth(d.cursor, dir));
	const prev = iconButton(bar, "chevron-left", t(d.phone ? "cal.prevWeek" : "cal.prevMonth"), () => step(-1), "nb-cal-prev");
	prev.dataset.key = "cal:prev";
	bar.createEl("h2", { cls: "nb-cal-title", text: title, attr: { "aria-live": "polite" } });
	const next = iconButton(bar, "chevron-right", t(d.phone ? "cal.nextWeek" : "cal.nextMonth"), () => step(1), "nb-cal-next");
	next.dataset.key = "cal:next";
	const todayBtn = bar.createEl("button", { cls: "nb-chip nb-cal-today", text: t("cal.today"), attr: { type: "button", "data-key": "cal:today" } });
	todayBtn.addEventListener("click", () => {
		d.setCursor(d.today);
		d.select(d.today);
	});

	if (d.data.size === 0) root.createDiv({ cls: "nb-cal-none", text: t("cal.none") });

	const body = root.createDiv({ cls: "nb-cal-body" });
	if (d.phone) {
		strip(body, week, d);
		agenda(body, week, d);
	} else {
		month(body, d);
		const day = d.selected ?? (d.today.slice(0, 7) === d.cursor.slice(0, 7) ? d.today : null);
		dayPanel(body.createDiv({ cls: "nb-cal-day" }), day, d);
	}
}

function weekdayNames(d: CalendarDeps, style: "short" | "narrow"): string[] {
	const f = fmt(d.locale, { weekday: style });
	return weekOf(d.cursor, d.weekStart).map((k) => f.format(parseDay(k) ?? new Date()));
}

/** "3 notebooks · 5 pages" (the pages only when this device has page detail for the day). */
function summary(s: DaySummary): string {
	const nb = s.items.length === 1 ? t("library.notebooks.one") : t("library.notebooks.many", { count: String(s.items.length) });
	if (s.pageCount === 0) return nb;
	return `${nb} · ${s.pageCount === 1 ? t("library.pages.one") : t("library.pages.many", { count: String(s.pageCount) })}`;
}

function dayAria(day: string, s: DaySummary | undefined, d: CalendarDeps): string {
	const date = fmt(d.locale, { weekday: "long", day: "numeric", month: "long" }).format(parseDay(day) ?? new Date());
	if (!s) return `${date}, ${t("cal.nothing")}`;
	return `${date}, ${summary(s)}`;
}

function cell(parent: HTMLElement, day: string, d: CalendarDeps, cls: string): HTMLButtonElement {
	const s = d.data.get(day);
	const b = parent.createEl("button", { cls: `nb-cal-cell ${cls}`.trim(), attr: { type: "button", "aria-label": dayAria(day, s, d), "aria-pressed": String(d.selected === day), "data-day": day, "data-key": `cal:${day}` } });
	b.toggleClass("is-today", day === d.today);
	b.toggleClass("is-selected", d.selected === day);
	b.toggleClass("has-data", !!s);
	const lvl = dayLevel(s);
	if (lvl > 0) b.addClass(`lvl-${lvl}`);
	b.createSpan({ cls: "nb-cal-num", text: String(Number(day.slice(8))) });
	if (s) {
		const dots = b.createSpan({ cls: "nb-cal-dots", attr: { "aria-hidden": "true" } });
		const seen = new Set<string>();
		for (const item of s.items) {
			if (dots.childElementCount >= MAX_DOTS) break;
			const color = d.colorOf(item.path);
			if (seen.has(color)) continue;
			seen.add(color);
			dots.createSpan({ cls: "nb-cal-dot" }).setCssProps({ "--nb-dot": color });
		}
	}
	b.addEventListener("click", () => d.select(day));
	return b;
}

function month(body: HTMLElement, d: CalendarDeps): void {
	const grid = body.createDiv({ cls: "nb-cal-month", attr: { role: "group", "aria-label": t("cal.month") } });
	const head = grid.createDiv({ cls: "nb-cal-weekdays", attr: { "aria-hidden": "true" } });
	for (const name of weekdayNames(d, "short")) head.createSpan({ cls: "nb-cal-weekday", text: name });
	for (const row of monthGrid(d.cursor, d.weekStart)) {
		const r = grid.createDiv({ cls: "nb-cal-week" });
		for (const c of row) cell(r, c.day, d, c.inMonth ? "" : "is-out");
	}
}

function strip(body: HTMLElement, week: readonly string[], d: CalendarDeps): void {
	const names = weekdayNames(d, "short");
	const row = body.createDiv({ cls: "nb-cal-strip", attr: { role: "group", "aria-label": t("cal.week") } });
	week.forEach((day, i) => {
		const col = row.createDiv({ cls: "nb-cal-strip-day" });
		col.createSpan({ cls: "nb-cal-weekday", text: names[i], attr: { "aria-hidden": "true" } });
		cell(col, day, d, "");
	});
}

function agenda(body: HTMLElement, week: readonly string[], d: CalendarDeps): void {
	const list = body.createDiv({ cls: "nb-cal-agenda" });
	const selected = d.selected && week.includes(d.selected) ? d.selected : null;
	let any = false;
	for (const day of week) {
		const s = d.data.get(day);
		if (!s && day !== selected) continue;
		any = true;
		const sec = list.createDiv({ cls: "nb-cal-agenda-day" });
		sec.toggleClass("is-selected", day === selected);
		sec.dataset.day = day;
		dayPanel(sec, day, d);
	}
	if (!any) list.createDiv({ cls: "nb-cal-empty", text: t("cal.weekEmpty") });
}

/** A day's heading and the notebooks (and pages) written that day. */
function dayPanel(el: HTMLElement, day: string | null, d: CalendarDeps): void {
	if (!day) {
		el.createDiv({ cls: "nb-cal-empty", text: t("cal.pick") });
		return;
	}
	const s = d.data.get(day);
	const head = el.createDiv({ cls: "nb-cal-day-head" });
	head.createEl("h3", { cls: "nb-cal-day-title", text: fmt(d.locale, { weekday: "long", day: "numeric", month: "long" }).format(parseDay(day) ?? new Date()) });
	if (s) head.createSpan({ cls: "nb-cal-day-sum", text: summary(s) });
	if (!s) {
		el.createDiv({ cls: "nb-cal-empty", text: t("cal.nothing") });
		return;
	}
	const list = el.createDiv({ cls: "nb-cal-items", attr: { role: "list" } });
	for (const item of s.items) itemRow(list, item, d);
}

function itemRow(list: HTMLElement, item: DayItem, d: CalendarDeps): void {
	const row = list.createDiv({ cls: "nb-cal-item", attr: { role: "listitem" } });
	const main = row.createDiv({ cls: "nb-cal-item-main", attr: { "data-key": `cal-item:${item.path}` } });
	const known = item.pages.map((p) => ({ key: p, n: d.pageNumber(item.path, p) })).filter((x): x is { key: string; n: number } => x.n !== null).sort((a, b) => a.n - b.n);
	const what = item.written ? t(item.pages.length === 1 ? "cal.pages.one" : "cal.pages.many", { count: String(item.pages.length) })
		: item.created ? t("cal.created") : t("cal.modified");
	pressable(main, () => d.open(item, known[0]?.key ?? item.pages[0] ?? null), t("cal.open", { name: item.name, what }));
	const swatch = main.createSpan({ cls: "nb-cal-swatch", attr: { "aria-hidden": "true" } });
	swatch.setCssProps({ "--notebook-cover": d.colorOf(item.path) });
	const text = main.createDiv({ cls: "nb-cal-item-text" });
	text.createDiv({ cls: "nb-cal-item-title", text: item.name, attr: { title: item.name } });
	const parts = [what];
	if (item.written && item.created) parts.push(t("cal.created"));
	text.createDiv({ cls: "nb-cal-item-meta", text: parts.join(" · ") });
	setIconSafe(main.createSpan({ cls: "nb-cal-item-go", attr: { "aria-hidden": "true" } }), "chevron-right");
	if (known.length > 0) {
		const chips = row.createDiv({ cls: "nb-cal-pages" });
		for (const p of known.slice(0, 12)) {
			const b = chips.createEl("button", { cls: "nb-chip nb-cal-page", text: t("cal.page", { page: String(p.n) }), attr: { type: "button", "data-key": `cal-page:${item.path}:${p.key}` } });
			b.addEventListener("click", () => d.open(item, p.key));
		}
	}
}
