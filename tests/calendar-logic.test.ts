import { describe, expect, it } from "vitest";
import { dayKeyOf, type ActivityRecord } from "../src/library/activity-log";
import {
	addDays, aggregateCalendar, dayLevel, monthGrid, pageOfKey, parseDay, shiftMonth, weekOf, weekStartFor, type CalendarEntry,
} from "../src/library/calendar-logic";

const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).getTime();
const entry = (path: string, created: number, modified: number): CalendarEntry => ({ path, name: path.replace(/\.notebook$/, ""), created, modified });
const rec = (day: string, key: string, path: string): ActivityRecord => ({ day, key, path });

describe("calendar aggregation", () => {
	const a = entry("A.notebook", at(2026, 10, 1), at(2026, 10, 20));
	const b = entry("B.notebook", at(2026, 10, 5), at(2026, 10, 5));
	const c = entry("C.notebook", at(2026, 9, 28), at(2026, 10, 21));

	it("uses the library index alone: creation and last change, without opening anything", () => {
		const m = aggregateCalendar([a, b, c], []);
		expect(m.get("2026-10-01")?.items).toEqual([{ path: "A.notebook", name: "A", pages: [], written: false, modified: false, created: true }]);
		expect(m.get("2026-10-20")?.items[0]).toMatchObject({ path: "A.notebook", modified: true, written: false });
		expect(m.get("2026-09-28")?.items[0]).toMatchObject({ path: "C.notebook", created: true });
		expect(m.get("2026-10-21")?.items[0]).toMatchObject({ path: "C.notebook", modified: true });
		// Created and last changed the same day: just "created".
		expect(m.get("2026-10-05")?.items).toEqual([expect.objectContaining({ path: "B.notebook", created: true, modified: false })]);
	});

	it("adds the pages of the activity log, and a day with pages does not also show a bare 'modified'", () => {
		const records = [rec("2026-10-20", "aaaaaaaa:p1", "A.notebook"), rec("2026-10-20", "aaaaaaaa:p2", "A.notebook"), rec("2026-10-12", "cccccccc:p9", "C.notebook")];
		const m = aggregateCalendar([a, b, c], records);
		const day = m.get("2026-10-20")!;
		expect(day.items).toEqual([{ path: "A.notebook", name: "A", pages: ["p1", "p2"], written: true, modified: false, created: false }]);
		expect(day.pageCount).toBe(2);
		expect(m.get("2026-10-12")?.items[0]).toMatchObject({ path: "C.notebook", pages: ["p9"], written: true });
	});

	it("lists written notebooks before changed ones, then by name", () => {
		const x = entry("X.notebook", at(2026, 1, 1), at(2026, 10, 20));
		const y = entry("Y.notebook", at(2026, 1, 1), at(2026, 10, 20));
		const m = aggregateCalendar([x, y], [rec("2026-10-20", "yyyyyyyy:p1", "Y.notebook")]);
		expect(m.get("2026-10-20")!.items.map((i) => i.path)).toEqual(["Y.notebook", "X.notebook"]);
	});

	it("drops activity of notebooks that are gone or have no path, and bad days", () => {
		const m = aggregateCalendar([a], [rec("2026-10-02", "x:p", "Gone.notebook"), rec("2026-10-02", "x:p", ""), rec("bad", "x:p", "A.notebook")]);
		expect(m.has("2026-10-02")).toBe(false);
		expect(m.has("bad")).toBe(false);
	});

	it("follows a renamed notebook (the activity record carries the new path) and counts a page once a day", () => {
		const m = aggregateCalendar([entry("New.notebook", at(2026, 1, 1), at(2026, 1, 1))], [rec("2026-10-02", "k:p1", "New.notebook"), rec("2026-10-02", "k:p1", "New.notebook")]);
		expect(m.get("2026-10-02")!.items[0]!.pages).toEqual(["p1"]);
	});

	it("limits to a range", () => {
		const m = aggregateCalendar([a, b, c], [], { from: "2026-10-01", to: "2026-10-10" });
		expect([...m.keys()].sort()).toEqual(["2026-10-01", "2026-10-05"]);
	});

	it("survives entries without usable times", () => {
		const m = aggregateCalendar([entry("Z.notebook", NaN, 0)], []);
		expect(m.size).toBe(0);
	});

	it("scales a day's mark by its pages", () => {
		const mk = (pageCount: number, items = 1) => ({ day: "d", pageCount, items: Array.from({ length: items }, () => ({}) as never) });
		expect(dayLevel(undefined)).toBe(0);
		expect(dayLevel(mk(1))).toBe(1);
		expect(dayLevel(mk(3))).toBe(2);
		expect(dayLevel(mk(6))).toBe(3);
		expect(dayLevel(mk(40))).toBe(4);
	});

	it("reads the page part of an activity key", () => {
		expect(pageOfKey("abcdefgh:12345678")).toBe("12345678");
		expect(pageOfKey("nocolon")).toBe("nocolon");
	});
});

describe("calendar dates", () => {
	it("builds the month grid from Monday or Sunday, with the days of the neighbour months greyed", () => {
		const mon = monthGrid("2026-10-15", 1);
		expect(mon[0]![0]!.day).toBe("2026-09-28");
		expect(mon[0]![0]!.inMonth).toBe(false);
		expect(mon[0]![3]!.day).toBe("2026-10-01");
		expect(mon.every((r) => r.length === 7)).toBe(true);
		expect(mon.flat().filter((c) => c.inMonth)).toHaveLength(31);
		const sun = monthGrid("2026-10-15", 0);
		expect(sun[0]![0]!.day).toBe("2026-09-27");
	});

	it("a month that fits five weeks has five rows; one that needs six has six", () => {
		expect(monthGrid("2027-02-10", 1)).toHaveLength(4);
		expect(monthGrid("2026-10-10", 1)).toHaveLength(5);
		expect(monthGrid("2026-08-10", 1)).toHaveLength(6);
	});

	it("moves by months and days across year ends", () => {
		expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-01");
		expect(shiftMonth("2026-01-31", -1)).toBe("2025-12-01");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});

	it("is not thrown by the daylight-saving changes", () => {
		expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
		expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
		expect(weekOf("2026-10-28", 1)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
	});

	it("gives the week of a day from Monday or Sunday", () => {
		expect(weekOf("2026-10-25", 1)[0]).toBe("2026-10-19");
		expect(weekOf("2026-10-25", 0)[0]).toBe("2026-10-25");
		expect(weekOf("2026-10-25", 1)).toHaveLength(7);
	});

	it("rejects impossible day keys", () => {
		expect(parseDay("2026-02-30")).toBeNull();
		expect(parseDay("nope")).toBeNull();
		expect(dayKeyOf(parseDay("2026-10-29")!.getTime())).toBe("2026-10-29");
	});

	it("starts the week on Monday except in the few locales that use Sunday", () => {
		expect(weekStartFor("it-IT")).toBe(1);
		expect(weekStartFor("de")).toBe(1);
		expect(weekStartFor("en-US")).toBe(0);
		expect(weekStartFor("en")).toBe(0);
		expect(weekStartFor("en-GB")).toBe(1);
	});
});
