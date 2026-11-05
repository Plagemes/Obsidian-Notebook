import { describe, expect, it } from "vitest";
import {
	ACADEMIC_START_MONTH, civil, columnWeekday, dayNumber, dayOfYear, daysInMonth, isLeapYear, isoWeek, isoWeeksInYear, monthIndexIn,
	monthName, monthRows, monthsFrom, planRange, weekday, weekdayName, weekNumber, weekStartForLocale, weekStartOf, weekStartsIn,
} from "../src/model/calendar";

describe("leap years and month lengths", () => {
	it("follows the Gregorian rule", () => {
		expect([1900, 2023, 2100, 2200].map(isLeapYear)).toEqual([false, false, false, false]);
		expect([2000, 2024, 2028, 2400].map(isLeapYear)).toEqual([true, true, true, true]);
	});

	it("gives the days of every month", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2023, m))).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(1900, 2)).toBe(28);
		expect(daysInMonth(2000, 2)).toBe(29);
	});
});

describe("day numbers", () => {
	it("counts from 1970-01-01", () => {
		expect(dayNumber(1970, 1, 1)).toBe(0);
		expect(dayNumber(1970, 1, 2)).toBe(1);
		expect(dayNumber(1969, 12, 31)).toBe(-1);
		expect(dayNumber(2000, 3, 1)).toBe(11017);
		expect(dayNumber(2026, 11, 5)).toBe(Math.round(Date.UTC(2026, 10, 5) / 86400000));
	});

	it("round-trips every day of four centuries' worth of samples", () => {
		for (let dn = dayNumber(1900, 1, 1); dn <= dayNumber(2200, 12, 31); dn += 37) {
			const c = civil(dn);
			expect(dayNumber(c.y, c.m, c.d)).toBe(dn);
			expect(c.d).toBeGreaterThanOrEqual(1);
			expect(c.d).toBeLessThanOrEqual(daysInMonth(c.y, c.m));
		}
	});

	it("agrees with Date over a full leap year", () => {
		for (let dn = dayNumber(2024, 1, 1); dn <= dayNumber(2024, 12, 31); dn++) {
			const d = new Date(dn * 86400000);
			expect(civil(dn)).toEqual({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
			expect(weekday(dn)).toBe(d.getUTCDay());
		}
	});

	it("knows the weekday and the day of the year", () => {
		expect(weekday(dayNumber(1970, 1, 1))).toBe(4);
		expect(weekday(dayNumber(2026, 3, 12))).toBe(4); // a Thursday
		expect(dayOfYear(dayNumber(2026, 1, 1))).toBe(1);
		expect(dayOfYear(dayNumber(2024, 12, 31))).toBe(366);
		expect(dayOfYear(dayNumber(2026, 12, 31))).toBe(365);
	});
});

describe("weeks", () => {
	it("finds the first day of a week for both week starts", () => {
		const thu = dayNumber(2026, 3, 12);
		expect(civil(weekStartOf(thu, 1))).toEqual({ y: 2026, m: 3, d: 9 });
		expect(civil(weekStartOf(thu, 0))).toEqual({ y: 2026, m: 3, d: 8 });
		const sun = dayNumber(2026, 3, 8);
		expect(weekStartOf(sun, 0)).toBe(sun);
		expect(civil(weekStartOf(sun, 1))).toEqual({ y: 2026, m: 3, d: 2 });
	});

	it("numbers ISO weeks", () => {
		expect(isoWeek(dayNumber(2026, 1, 1))).toEqual({ year: 2026, week: 1 });
		expect(isoWeek(dayNumber(2021, 1, 3))).toEqual({ year: 2020, week: 53 });
		expect(isoWeek(dayNumber(2024, 12, 30))).toEqual({ year: 2025, week: 1 });
		expect(isoWeek(dayNumber(2026, 12, 31))).toEqual({ year: 2026, week: 53 });
		expect(isoWeek(dayNumber(2027, 1, 3))).toEqual({ year: 2026, week: 53 });
		expect(isoWeek(dayNumber(2027, 1, 4))).toEqual({ year: 2027, week: 1 });
		expect(isoWeek(dayNumber(2026, 3, 9))).toEqual({ year: 2026, week: 11 });
		expect(isoWeek(dayNumber(2016, 1, 1))).toEqual({ year: 2015, week: 53 });
	});

	it("has 53 ISO weeks in the long years only", () => {
		expect([2015, 2020, 2026, 2032].map(isoWeeksInYear)).toEqual([53, 53, 53, 53]);
		expect([2016, 2021, 2024, 2025, 2027].map(isoWeeksInYear)).toEqual([52, 52, 52, 52, 52]);
	});

	it("numbers Sunday-start weeks by the week that holds January 1st", () => {
		// 2026-01-01 is a Thursday: the week of Sun 2025-12-28 is week 1 of 2026.
		expect(weekNumber(dayNumber(2025, 12, 28), 0)).toEqual({ year: 2026, week: 1 });
		expect(weekNumber(dayNumber(2026, 1, 1), 0)).toEqual({ year: 2026, week: 1 });
		expect(weekNumber(dayNumber(2026, 1, 3), 0)).toEqual({ year: 2026, week: 1 });
		expect(weekNumber(dayNumber(2026, 1, 4), 0)).toEqual({ year: 2026, week: 2 });
		// The week of Thu 2026-12-31 also holds 2027-01-01, so it is week 1 of 2027.
		expect(weekNumber(dayNumber(2026, 12, 31), 0)).toEqual({ year: 2027, week: 1 });
		expect(weekNumber(dayNumber(2026, 12, 26), 0)).toEqual({ year: 2026, week: 52 });
		// 2023-01-01 is a Sunday: week 1 starts that day.
		expect(weekNumber(dayNumber(2023, 1, 1), 0)).toEqual({ year: 2023, week: 1 });
		expect(weekNumber(dayNumber(2022, 12, 31), 0)).toEqual({ year: 2022, week: 53 });
	});

	it("uses ISO for Monday weeks", () => {
		expect(weekNumber(dayNumber(2026, 3, 12), 1)).toEqual(isoWeek(dayNumber(2026, 3, 12)));
	});

	it("lists the weeks that cover a range, the edges partial", () => {
		const start = dayNumber(2026, 1, 1);
		const end = dayNumber(2026, 12, 31);
		const monday = weekStartsIn(start, end, 1);
		expect(monday[0]).toBe(dayNumber(2025, 12, 29));
		expect(monday).toHaveLength(53);
		expect(monday[monday.length - 1]! + 6).toBeGreaterThanOrEqual(end);
		const sunday = weekStartsIn(start, end, 0);
		expect(sunday[0]).toBe(dayNumber(2025, 12, 28));
		expect(sunday).toHaveLength(53);
		for (let i = 1; i < monday.length; i++) expect(monday[i]! - monday[i - 1]!).toBe(7);
	});
});

describe("month calendars", () => {
	it("pads the first week from the week start", () => {
		// March 2026 starts on a Sunday.
		const monday = monthRows(2026, 3, 1);
		expect(monday[0]).toEqual([null, null, null, null, null, null, 1]);
		expect(monday[monday.length - 1]!.filter((d) => d !== null).length).toBeGreaterThan(0);
		const sunday = monthRows(2026, 3, 0);
		expect(sunday[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("holds every day once, in 4 to 6 rows", () => {
		for (const ws of [0, 1] as const) {
			for (let m = 1; m <= 12; m++) {
				const rows = monthRows(2026, m, ws);
				expect(rows.length).toBeGreaterThanOrEqual(4);
				expect(rows.length).toBeLessThanOrEqual(6);
				expect(rows.flat().filter((d): d is number => d !== null)).toEqual(Array.from({ length: daysInMonth(2026, m) }, (_, i) => i + 1));
			}
		}
		// February 2026 starts on Sunday: four rows with Sunday-start weeks, five with Monday.
		expect(monthRows(2026, 2, 0)).toHaveLength(4);
		expect(monthRows(2026, 2, 1)).toHaveLength(5);
	});

	it("puts a day in the column of its weekday", () => {
		for (const ws of [0, 1] as const) {
			monthRows(2026, 3, ws).forEach((row) => row.forEach((d, c) => {
				if (d !== null) expect(weekday(dayNumber(2026, 3, d))).toBe(columnWeekday(c, ws));
			}));
		}
	});
});

describe("plan ranges", () => {
	it("covers a calendar year", () => {
		const r = planRange(2026, 1);
		expect(r.months[0]).toEqual({ y: 2026, m: 1 });
		expect(r.months[11]).toEqual({ y: 2026, m: 12 });
		expect(r.end - r.start + 1).toBe(365);
		expect(planRange(2024, 1).end - planRange(2024, 1).start + 1).toBe(366);
	});

	it("covers an academic year from September to August", () => {
		const r = planRange(2025, ACADEMIC_START_MONTH);
		expect(r.months[0]).toEqual({ y: 2025, m: 9 });
		expect(r.months[3]).toEqual({ y: 2025, m: 12 });
		expect(r.months[4]).toEqual({ y: 2026, m: 1 });
		expect(r.months[11]).toEqual({ y: 2026, m: 8 });
		expect(civil(r.start)).toEqual({ y: 2025, m: 9, d: 1 });
		expect(civil(r.end)).toEqual({ y: 2026, m: 8, d: 31 });
		// Leap day inside an academic year counts.
		const leap = planRange(2023, 9);
		expect(leap.end - leap.start + 1).toBe(366);
	});

	it("finds the month of a day inside the plan", () => {
		const r = planRange(2025, 9);
		expect(monthIndexIn(r, dayNumber(2025, 9, 1))).toBe(0);
		expect(monthIndexIn(r, dayNumber(2026, 1, 15))).toBe(4);
		expect(monthIndexIn(r, dayNumber(2026, 8, 31))).toBe(11);
		expect(monthIndexIn(r, dayNumber(2025, 8, 31))).toBe(-1);
		expect(monthIndexIn(r, dayNumber(2026, 9, 1))).toBe(-1);
	});

	it("counts months across the year end", () => {
		expect(monthsFrom(2025, 11, 4)).toEqual([{ y: 2025, m: 11 }, { y: 2025, m: 12 }, { y: 2026, m: 1 }, { y: 2026, m: 2 }]);
	});
});

describe("names and locale", () => {
	it("names months and weekdays in both languages", () => {
		expect(monthName("en", 3)).toBe("March");
		expect(monthName("it", 3)).toBe("Marzo");
		expect(monthName("it", 3, true)).toBe("Mar");
		expect(weekdayName("it", 4)).toBe("Giovedì");
		expect(weekdayName("en", 0, true)).toBe("Sun");
	});

	it("starts the week on Sunday only where the locale does", () => {
		expect(weekStartForLocale("en-US")).toBe(0);
		expect(weekStartForLocale("en")).toBe(0);
		expect(weekStartForLocale("it")).toBe(1);
		expect(weekStartForLocale("en-GB")).toBe(1);
		expect(weekStartForLocale("de-DE")).toBe(1);
	});
});
