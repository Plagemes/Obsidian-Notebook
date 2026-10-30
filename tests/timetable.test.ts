import { describe, expect, it } from "vitest";
import { buildLecturePage } from "../src/view/lecture-logic";
import { findLecturePage } from "../src/timetable/lecture-open";
import { applyCourseTag, PAGE_TAG_HOOK_ACTIVE } from "../src/timetable/page-tag";
import { createDocument } from "../src/model/document";
import { AddPage, History } from "../src/model/history";
import { setLectureCourseProvider, suggestedCourse } from "../src/timetable/current";
import {
	classesAt, classesOn, courseForNotebook, currentClass, entryProblem, findOverlaps, isoWeekNumber, isoWeekday, linkCovers,
	nextClass, occurrenceKey, occursOn, parseTime, parseTimetable, pickTarget, serializeChecked, serializeTimetable,
	weekNumber, type ClassEntry, type Timetable,
} from "../src/timetable/schedule";
import { readSettings } from "../src/settings";

let n = 0;
function entry(over: Partial<ClassEntry> = {}): ClassEntry {
	return { id: `e${++n}`, course: "Physics", day: 1, start: "09:00", end: "10:30", weeks: "all", ...over };
}
const tt = (entries: ClassEntry[], weekOne?: string): Timetable => ({ version: 1, entries, ...(weekOne ? { weekOne } : {}) });
// 2026-11-02 is a Monday.
const at = (day: number, h = 0, m = 0) => new Date(2026, 10, day, h, m, 0);

describe("time and calendar helpers", () => {
	it("parses HH:MM", () => {
		expect(parseTime("09:05")).toBe(545);
		expect(parseTime("9:05")).toBe(545);
		expect(parseTime("24:00")).toBeNull();
		expect(parseTime("12:60")).toBeNull();
		expect(parseTime("noon")).toBeNull();
	});
	it("ISO weekday and week number", () => {
		expect(isoWeekday(at(2))).toBe(1);
		expect(isoWeekday(at(8))).toBe(7);
		expect(isoWeekNumber(new Date(2026, 0, 1))).toBe(1);
		expect(isoWeekNumber(new Date(2021, 0, 3))).toBe(53);
		expect(isoWeekNumber(new Date(2026, 11, 31))).toBe(53);
		expect(isoWeekNumber(at(2))).toBe(45);
	});
	it("counts weeks from weekOne, any day of that week", () => {
		expect(weekNumber(at(4), "2026-11-02")).toBe(1);
		expect(weekNumber(at(8), "2026-11-04")).toBe(1);
		expect(weekNumber(at(9), "2026-11-04")).toBe(2);
		expect(weekNumber(at(1), "2026-11-04")).toBe(0);
	});
	it("week counting survives daylight saving changes", () => {
		// Europe/US clocks change in late October / early November / March.
		expect(weekNumber(new Date(2026, 9, 26, 0, 30), "2026-10-19")).toBe(2);
		expect(weekNumber(new Date(2026, 10, 2, 23, 30), "2026-10-19")).toBe(3);
		expect(weekNumber(new Date(2026, 2, 30, 0, 5), "2026-03-16")).toBe(3);
	});
});

describe("occurrence and current class", () => {
	it("matches weekday and time, end exclusive", () => {
		const t = tt([entry()]);
		expect(currentClass(t, at(2, 8, 59))).toBeNull();
		expect(currentClass(t, at(2, 9, 0))?.course).toBe("Physics");
		expect(currentClass(t, at(2, 10, 29))?.course).toBe("Physics");
		expect(currentClass(t, at(2, 10, 30))).toBeNull();
		expect(currentClass(t, at(3, 9, 30))).toBeNull();
	});
	it("lead minutes make the class current a little before it starts", () => {
		const t = tt([entry()]);
		expect(currentClass(t, at(2, 8, 54), 5)).toBeNull();
		expect(currentClass(t, at(2, 8, 55), 5)?.course).toBe("Physics");
	});
	it("alternating weeks follow weekOne", () => {
		const odd = entry({ weeks: "odd", course: "Odd" });
		const even = entry({ weeks: "even", course: "Even" });
		const t = tt([odd, even], "2026-11-02");
		expect(currentClass(t, at(2, 9, 30))?.course).toBe("Odd");
		expect(currentClass(t, at(9, 9, 30))?.course).toBe("Even");
		expect(currentClass(t, at(16, 9, 30))?.course).toBe("Odd");
		expect(currentClass(t, at(23, 9, 30))?.course).toBe("Even");
		// week 0 (the week before week 1) is even.
		expect(currentClass(t, new Date(2026, 9, 26, 9, 30))?.course).toBe("Even");
	});
	it("alternating weeks use ISO week numbers without weekOne", () => {
		const t = tt([entry({ weeks: "odd" })]);
		expect(occursOn(t.entries[0]!, at(2))).toBe(true); // week 45
		expect(occursOn(t.entries[0]!, at(9))).toBe(false); // week 46
	});
	it("term start and end are inclusive", () => {
		const e = entry({ from: "2026-11-09", to: "2026-11-16" });
		expect(occursOn(e, at(2))).toBe(false);
		expect(occursOn(e, at(9))).toBe(true);
		expect(occursOn(e, at(16))).toBe(true);
		expect(occursOn(e, at(23))).toBe(false);
	});
	it("overlapping classes: the one that started last is current", () => {
		const a = entry({ course: "A", start: "09:00", end: "11:00" });
		const b = entry({ course: "B", start: "10:00", end: "12:00" });
		const t = tt([a, b]);
		expect(classesAt(t, at(2, 10, 30)).map((e) => e.course)).toEqual(["B", "A"]);
		expect(currentClass(t, at(2, 9, 30))?.course).toBe("A");
		expect(currentClass(t, at(2, 11, 30))?.course).toBe("B");
	});
	it("classesOn is sorted by start", () => {
		const t = tt([entry({ course: "Late", start: "14:00", end: "15:00" }), entry({ course: "Early", start: "08:00", end: "09:00" })]);
		expect(classesOn(t, at(2)).map((e) => e.course)).toEqual(["Early", "Late"]);
	});
});

describe("next class", () => {
	it("later today, then another day, skipping weeks that do not match", () => {
		const t = tt([entry({ course: "Mon", start: "09:00", end: "10:00" }), entry({ course: "Wed", day: 3, weeks: "even", start: "11:00", end: "12:00" })], "2026-11-02");
		expect(nextClass(t, at(2, 8, 0))?.entry.course).toBe("Mon");
		expect(nextClass(t, at(2, 9, 0))?.entry.course).toBe("Mon"); // next Monday, not the one starting now
		expect(nextClass(t, at(2, 9, 0))?.start.getDate()).toBe(9);
		const wed = nextClass(t, at(3, 8, 0));
		expect(wed?.entry.course).toBe("Mon");
		const after = nextClass(tt([t.entries[1]!], "2026-11-02"), at(2, 12, 0));
		expect(after?.entry.course).toBe("Wed");
		expect(after?.start.getDate()).toBe(11); // week 2 (even)
		expect(after?.start.getHours()).toBe(11);
	});
	it("returns null with nothing to come", () => {
		expect(nextClass(tt([]), at(2))).toBeNull();
		expect(nextClass(tt([entry({ to: "2026-10-01" })]), at(2))).toBeNull();
	});
});

describe("overlaps", () => {
	it("flags same-day overlapping hours only when weeks and terms can coincide", () => {
		const a = entry({ start: "09:00", end: "10:00" });
		expect(findOverlaps([a, entry({ start: "09:30", end: "11:00" })])).toHaveLength(1);
		expect(findOverlaps([a, entry({ start: "10:00", end: "11:00" })])).toHaveLength(0);
		expect(findOverlaps([a, entry({ day: 2, start: "09:30", end: "11:00" })])).toHaveLength(0);
		expect(findOverlaps([entry({ weeks: "odd" }), entry({ weeks: "even" })])).toHaveLength(0);
		expect(findOverlaps([entry({ weeks: "odd" }), entry({ weeks: "all" })])).toHaveLength(1);
		expect(findOverlaps([entry({ to: "2026-10-01" }), entry({ from: "2026-10-02" })])).toHaveLength(0);
	});
});

describe("validation and file format", () => {
	it("entry problems", () => {
		expect(entryProblem(entry())).toBeNull();
		expect(entryProblem(entry({ course: " " }))).toBe("course");
		expect(entryProblem(entry({ day: 8 }))).toBe("day");
		expect(entryProblem(entry({ start: "9am" }))).toBe("time");
		expect(entryProblem(entry({ start: "10:00", end: "10:00" }))).toBe("order");
		expect(entryProblem(entry({ from: "2026-02-30" }))).toBe("date");
		expect(entryProblem(entry({ from: "2026-05-01", to: "2026-04-01" }))).toBe("term");
	});
	it("round-trips, with stable key order", () => {
		const t = tt([entry({ room: "B12", notebook: "Notebooks/Physics", from: "2026-09-01", to: "2026-12-20", weeks: "odd" })], "2026-09-07");
		const text = serializeChecked(t);
		const back = parseTimetable(text);
		expect(back.ok && serializeTimetable(back.timetable)).toBe(text);
		expect(text.startsWith("{\n  \"version\": 1,\n  \"weekOne\"")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
	});
	it("an empty file is an empty timetable", () => {
		expect(parseTimetable("")).toEqual({ ok: true, timetable: { version: 1, entries: [] } });
	});
	it("a hand-written minimal entry is accepted (id and weeks optional)", () => {
		const r = parseTimetable('{"entries":[{"course":"Chem","day":2,"start":"8:15","end":"9:45"}]}');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.timetable.entries[0]!.weeks).toBe("all");
			expect(r.timetable.entries[0]!.id).toBeTruthy();
		}
	});
	it("refuses what it cannot understand instead of dropping it", () => {
		expect(parseTimetable("{nope").ok).toBe(false);
		expect(parseTimetable("[]").ok).toBe(false);
		expect(parseTimetable('{"version":2,"entries":[]}').ok).toBe(false);
		expect(parseTimetable('{"entries":[{"course":"X","day":9,"start":"08:00","end":"09:00"}]}').ok).toBe(false);
		expect(parseTimetable('{"entries":[{"course":"X","day":1,"start":"08:00","end":"09:00","weeks":"third"}]}').ok).toBe(false);
		expect(parseTimetable('{"weekOne":"soon","entries":[]}').ok).toBe(false);
	});
	it("duplicate ids are made unique", () => {
		const r = parseTimetable('{"entries":[{"id":"a","course":"X","day":1,"start":"08:00","end":"09:00"},{"id":"a","course":"Y","day":2,"start":"08:00","end":"09:00"}]}');
		expect(r.ok && new Set(r.timetable.entries.map((e) => e.id)).size).toBe(2);
	});
});

describe("links to notebooks", () => {
	it("a link covers a notebook or the folder around it", () => {
		expect(linkCovers("Notebooks/Physics.notebook", "Notebooks/Physics.notebook")).toBe(true);
		expect(linkCovers("Notebooks/Physics", "Notebooks/Physics/Week 1.notebook")).toBe(true);
		expect(linkCovers("Notebooks/Phys", "Notebooks/Physics/Week 1.notebook")).toBe(false);
		expect(linkCovers(undefined, "x")).toBe(false);
	});
	it("course for New lecture", () => {
		const phys = entry({ course: "Physics", notebook: "Notebooks/Physics" });
		const free = entry({ course: "Free" });
		expect(courseForNotebook([phys], "Notebooks/Physics/Lectures.notebook")).toBe("Physics");
		expect(courseForNotebook([phys], "Notebooks/Other.notebook")).toBeNull();
		expect(courseForNotebook([free], "Notebooks/Other.notebook")).toBe("Free");
		expect(courseForNotebook([free], null)).toBe("Free");
		// the open notebook belongs to a class that is not on now: do not claim the current one.
		const maths = entry({ course: "Maths", notebook: "Notebooks/Maths.notebook" });
		expect(courseForNotebook([free], "Notebooks/Maths.notebook", [free, maths])).toBeNull();
		expect(courseForNotebook([], "x")).toBeNull();
	});
	it("which notebook a class opens", () => {
		const books = [
			{ path: "Notebooks/Physics/Notes.notebook", basename: "Notes", mtime: 5 },
			{ path: "Notebooks/Physics/Physics.notebook", basename: "Physics", mtime: 1 },
			{ path: "Notebooks/Maths.notebook", basename: "Maths", mtime: 9 },
		];
		expect(pickTarget(entry({ notebook: "Notebooks/Maths.notebook" }), books, "Notebooks")).toEqual({ kind: "open", path: "Notebooks/Maths.notebook" });
		expect(pickTarget(entry({ notebook: "Notebooks/Physics/" }), books, "Notebooks")).toEqual({ kind: "open", path: "Notebooks/Physics/Physics.notebook" });
		expect(pickTarget(entry({ course: "Optics", notebook: "Notebooks/Physics" }), books, "Notebooks")).toEqual({ kind: "open", path: "Notebooks/Physics/Notes.notebook" });
		expect(pickTarget(entry({ course: "Chem", notebook: "Notebooks/Chem" }), books, "Notebooks")).toEqual({ kind: "create", folder: "Notebooks/Chem", name: "Chem" });
		expect(pickTarget(entry({ course: "maths" }), books, "Notebooks")).toEqual({ kind: "open", path: "Notebooks/Maths.notebook" });
		expect(pickTarget(entry({ course: "Art" }), books, "Notebooks/")).toEqual({ kind: "create", folder: "Notebooks", name: "Art" });
		expect(pickTarget(entry({ notebook: "Notebooks/Art/Sketches.notebook" }), books, "Notebooks")).toEqual({ kind: "create", folder: "Notebooks/Art", name: "Sketches" });
	});
	it("occurrence key is per class and day", () => {
		const e = entry();
		expect(occurrenceKey(e, at(2, 9))).toBe(occurrenceKey(e, at(2, 17)));
		expect(occurrenceKey(e, at(2))).not.toBe(occurrenceKey(e, at(9)));
	});
});

describe("lecture page, tag hook, provider, settings", () => {
	it("finds the page that already has the lecture header", () => {
		const a = buildLecturePage(undefined, "Physics", at(2));
		const b = buildLecturePage(undefined, "Physics", at(9));
		expect(findLecturePage([a, b], "Physics", at(9))).toBe(1);
		expect(findLecturePage([a, b], "Physics", at(16))).toBe(-1);
		expect(findLecturePage([a, b], "Maths", at(2))).toBe(-1);
	});
	it("the page tag hook tags a new lecture page with the course, in the same undo step", () => {
		expect(PAGE_TAG_HOOK_ACTIVE).toBe(true);
		const page = buildLecturePage(undefined, "Quantum  Physics", at(2));
		const tagged = applyCourseTag(page, " #Quantum  Physics ");
		expect(tagged.tags).toEqual(["Quantum Physics"]);
		// A copy: the page passed in is not changed.
		expect(page.tags).toBeUndefined();
		expect(tagged.strokes).toBe(page.strokes);
		// Existing tags stay first; the course is not added twice (ignoring case).
		expect(applyCourseTag({ ...page, tags: ["exam"] }, "Physics").tags).toEqual(["exam", "Physics"]);
		expect(applyCourseTag({ ...page, tags: ["physics"] }, "Physics").tags).toEqual(["physics"]);
		// Nothing left after normalising: the page as it is.
		expect(applyCourseTag(page, " # ")).toBe(page);
		// Inserted with AddPage, undo removes the page together with its tag.
		const doc = createDocument(at(2));
		const history = new History(() => doc);
		history.execute(new AddPage(tagged, doc.pages.length));
		expect(doc.pages[1]?.tags).toEqual(["Quantum Physics"]);
		history.undo();
		expect(doc.pages).toHaveLength(1);
		expect(doc.pages[0]?.tags).toBeUndefined();
	});
	it("provider failures never break New lecture", () => {
		expect(suggestedCourse("x")).toBeNull();
		setLectureCourseProvider(() => "Physics");
		expect(suggestedCourse("x")).toBe("Physics");
		setLectureCourseProvider(() => {
			throw new Error("boom");
		});
		expect(suggestedCourse("x")).toBeNull();
		setLectureCourseProvider(null);
	});
	it("settings defaults and validation", () => {
		const s = readSettings({});
		expect([s.timetableOffer, s.timetableAutoOpen, s.timetableLeadMinutes]).toEqual([true, false, 5]);
		const t = readSettings({ timetableOffer: false, timetableAutoOpen: true, timetableLeadMinutes: 15 });
		expect([t.timetableOffer, t.timetableAutoOpen, t.timetableLeadMinutes]).toEqual([false, true, 15]);
		expect(readSettings({ timetableLeadMinutes: 999 }).timetableLeadMinutes).toBe(5);
	});
});
