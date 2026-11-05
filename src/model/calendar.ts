/**
 * Calendar math for the planner generator (roadmap #118). Pure: no 'obsidian', no DOM, no `Date` (so it does not depend on the
 * device's time zone or on how a WebView treats years before 100): dates are proleptic Gregorian, and a day is a "day number",
 * the count of days since 1970-01-01 (day 0, a Thursday).
 *
 * Months are 1-12, weekdays 0-6 with 0 = Sunday, `WeekStart` is 0 (Sunday) or 1 (Monday).
 */

export type WeekStart = 0 | 1;

export interface CivilDate {
	y: number;
	m: number;
	d: number;
}

/** The years the planner offers (the generator itself works for any year the math below represents exactly). */
export const MIN_PLANNER_YEAR = 1900;
export const MAX_PLANNER_YEAR = 2200;

/** The month an academic year starts in (September to August). */
export const ACADEMIC_START_MONTH = 9;

export function isLeapYear(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Days in month `m` (1-12) of year `y`. */
export function daysInMonth(y: number, m: number): number {
	return m === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[m - 1]!;
}

/** Day number of the civil date (Hinnant's days_from_civil). */
export function dayNumber(y: number, m: number, d: number): number {
	const yy = m <= 2 ? y - 1 : y;
	const era = Math.floor(yy / 400);
	const yoe = yy - era * 400;
	const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** The civil date of a day number (Hinnant's civil_from_days). */
export function civil(dn: number): CivilDate {
	const z = dn + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const m = mp < 10 ? mp + 3 : mp - 9;
	return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Weekday of a day number: 0 = Sunday ... 6 = Saturday. */
export function weekday(dn: number): number {
	return (((dn + 4) % 7) + 7) % 7;
}

/** The first day of the week (from `weekStart`) that contains `dn`. */
export function weekStartOf(dn: number, weekStart: WeekStart): number {
	return dn - ((weekday(dn) - weekStart + 7) % 7);
}

/** 1-based day of the year. */
export function dayOfYear(dn: number): number {
	return dn - dayNumber(civil(dn).y, 1, 1) + 1;
}

/** ISO 8601 week of a day: Monday-based weeks, week 1 holds the year's first Thursday. `year` is the week-year. */
export function isoWeek(dn: number): { year: number; week: number } {
	const thursday = dn - ((weekday(dn) + 6) % 7) + 3;
	const year = civil(thursday).y;
	return { year, week: Math.floor((thursday - dayNumber(year, 1, 1)) / 7) + 1 };
}

/**
 * The number of the week that holds `dn`. Monday weeks use ISO 8601. Sunday weeks use the North American rule: week 1 is the
 * week that contains January 1st (so a week that holds both Dec 31 and Jan 1 is week 1 of the new year). `year` is the year
 * the number belongs to.
 */
export function weekNumber(dn: number, weekStart: WeekStart): { year: number; week: number } {
	if (weekStart === 1) return isoWeek(dn);
	const last = weekStartOf(dn, 0) + 6;
	const year = civil(last).y;
	return { year, week: Math.floor((last - dayNumber(year, 1, 1)) / 7) + 1 };
}

/** Number of ISO weeks (52 or 53) in a week-year. */
export function isoWeeksInYear(year: number): number {
	return isoWeek(dayNumber(year, 12, 28)).week;
}

/** A month of the plan. */
export interface MonthRef {
	y: number;
	m: number;
}

/** `count` months from (`y`, `m`). */
export function monthsFrom(y: number, m: number, count: number): MonthRef[] {
	const out: MonthRef[] = [];
	for (let i = 0; i < count; i++) {
		const index = y * 12 + (m - 1) + i;
		out.push({ y: Math.floor(index / 12), m: (index % 12) + 1 });
	}
	return out;
}

export interface PlanRange {
	/** The 12 months, in order. */
	months: MonthRef[];
	/** First and last day (day numbers, inclusive). */
	start: number;
	end: number;
}

/**
 * The twelve months a planner covers: a calendar year (`startMonth` 1) or any 12 months from `startMonth` of `year`
 * (an academic year: September of `year` to August of `year + 1`).
 */
export function planRange(year: number, startMonth: number): PlanRange {
	const months = monthsFrom(year, startMonth, 12);
	const first = months[0]!;
	const last = months[11]!;
	return { months, start: dayNumber(first.y, first.m, 1), end: dayNumber(last.y, last.m, daysInMonth(last.y, last.m)) };
}

/** Day numbers of the weeks (their first day) that cover the range, the first and last possibly partial. */
export function weekStartsIn(start: number, end: number, weekStart: WeekStart): number[] {
	const out: number[] = [];
	for (let w = weekStartOf(start, weekStart); w <= end; w += 7) out.push(w);
	return out;
}

/** Rows of a month calendar from `weekStart`: each row 7 entries, the day of the month or null outside the month. 4 to 6 rows. */
export function monthRows(y: number, m: number, weekStart: WeekStart): Array<Array<number | null>> {
	const first = dayNumber(y, m, 1);
	const lead = first - weekStartOf(first, weekStart);
	const count = daysInMonth(y, m);
	const rows: Array<Array<number | null>> = [];
	for (let r = 0; r * 7 < lead + count; r++) {
		rows.push(Array.from({ length: 7 }, (_, c) => {
			const day = r * 7 + c - lead + 1;
			return day >= 1 && day <= count ? day : null;
		}));
	}
	return rows;
}

/** The weekday (0-6) shown in column `c` of a calendar that starts its week on `weekStart`. */
export function columnWeekday(c: number, weekStart: WeekStart): number {
	return (c + weekStart) % 7;
}

/** The index (0-11) of the month of `dn` in the plan, or -1 when it is outside the range. */
export function monthIndexIn(range: PlanRange, dn: number): number {
	if (dn < range.start || dn > range.end) return -1;
	const { y, m } = civil(dn);
	const first = range.months[0]!;
	return (y - first.y) * 12 + (m - first.m);
}

/** The first day of the week (from `weekStart`) as the locale's default when nothing is chosen: Sunday for a few regions. */
export function weekStartForLocale(locale: string): WeekStart {
	const l = locale.toLowerCase();
	return /^(en-us|en-ca|pt-br|ja|he|ko|zh-tw|es-mx)/.test(l) || l === "en" ? 0 : 1;
}

export const LANGS = ["en", "it"] as const;
export type CalendarLang = (typeof LANGS)[number];

interface Names {
	months: readonly string[];
	monthsShort: readonly string[];
	/** Sunday first. */
	weekdays: readonly string[];
	weekdaysShort: readonly string[];
}

const NAMES: Record<CalendarLang, Names> = {
	en: {
		months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
		monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
		weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
		weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
	},
	it: {
		months: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
		monthsShort: ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"],
		weekdays: ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"],
		weekdaysShort: ["dom", "lun", "mar", "mer", "gio", "ven", "sab"],
	},
};

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Month name (`m` 1-12), capitalised for titles. */
export function monthName(lang: CalendarLang, m: number, short = false): string {
	const n = NAMES[lang];
	return upper((short ? n.monthsShort : n.months)[m - 1]!);
}

/** Weekday name (`wd` 0 = Sunday), capitalised. */
export function weekdayName(lang: CalendarLang, wd: number, short = false): string {
	const n = NAMES[lang];
	return upper((short ? n.weekdaysShort : n.weekdays)[wd]!);
}

/** The `plannerWeekStart` setting: follow the device language, or always Monday or Sunday. */
export const PLANNER_WEEK_STARTS = ["auto", "monday", "sunday"] as const;
export type PlannerWeekStart = (typeof PLANNER_WEEK_STARTS)[number];

export function isPlannerWeekStart(v: unknown): v is PlannerWeekStart {
	return typeof v === "string" && (PLANNER_WEEK_STARTS as readonly string[]).includes(v);
}

/** The first day of the week the setting means (`locale`: the device language, used by "auto"). */
export function resolveWeekStart(setting: PlannerWeekStart, locale: string): WeekStart {
	return setting === "monday" ? 1 : setting === "sunday" ? 0 : weekStartForLocale(locale);
}
