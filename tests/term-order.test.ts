import { describe, expect, it } from "vitest";
import { hasActiveTerm, hasTimetable, inActiveTerm, orderByTerm } from "../src/library/term-order";
import type { ClassEntry, Timetable } from "../src/timetable/schedule";

let n = 0;
const entry = (over: Partial<ClassEntry>): ClassEntry => ({ id: `e${++n}`, course: "C", day: 1, start: "09:00", end: "10:00", weeks: "all", ...over });
const tt = (entries: ClassEntry[]): Timetable => ({ version: 1, entries });
// 2026-11-04 is a Wednesday (day 3).
const now = new Date(2026, 10, 4, 12, 0, 0);
const term = { from: "2026-09-01", to: "2027-01-31" };
const old = { from: "2026-02-01", to: "2026-06-30" };
const path = (s: string) => s;

describe("active term", () => {
	it("a class is in the term when today is inside its dates; no dates always counts", () => {
		expect(inActiveTerm(entry(term), "2026-11-04")).toBe(true);
		expect(inActiveTerm(entry(old), "2026-11-04")).toBe(false);
		expect(inActiveTerm(entry({ from: "2026-12-01" }), "2026-11-04")).toBe(false);
		expect(inActiveTerm(entry({}), "2026-11-04")).toBe(true);
	});

	it("a term is active only with a dated class around today", () => {
		expect(hasActiveTerm(tt([entry(term)]), now)).toBe(true);
		expect(hasActiveTerm(tt([entry(old)]), now)).toBe(false);
		expect(hasActiveTerm(tt([entry({})]), now)).toBe(false);
		expect(hasActiveTerm(null, now)).toBe(false);
		expect(hasTimetable(tt([]))).toBe(false);
		expect(hasTimetable(tt([entry({})]))).toBe(true);
	});
});

describe("orderByTerm", () => {
	const items = ["Other/x", "Old/a", "Bio/a", "Chem/a", "Bio/b", "Free/z"];
	const table = tt([
		entry({ course: "Chem", day: 5, notebook: "Chem", ...term }), // Friday
		entry({ course: "Bio", day: 4, notebook: "Bio", ...term }), // Thursday: sooner
		entry({ course: "Old", day: 2, notebook: "Old", ...old }),
	]);

	it("active courses by next class, then other courses, then the rest; ties keep the incoming order", () => {
		expect(orderByTerm(items, path, table, now)).toEqual(["Bio/a", "Bio/b", "Chem/a", "Old/a", "Other/x", "Free/z"]);
	});

	it("falls back to course order when there is no next class (all in the past)", () => {
		const past = tt([entry({ course: "B", notebook: "B", day: 1, from: "2026-01-01", to: "2026-12-31" }), entry({ course: "A", notebook: "A", day: 1, from: "2026-01-01", to: "2026-12-31", weeks: "odd" })]);
		const r = orderByTerm(["A/1", "B/1"], path, past, new Date(2026, 11, 30, 23, 0, 0));
		expect(r).toHaveLength(2);
	});

	it("a notebook linked directly counts, and the best (active) link wins over an old one", () => {
		const t2 = tt([entry({ notebook: "Chem/a", ...old }), entry({ notebook: "Chem", ...term })]);
		expect(orderByTerm(["Z/z", "Chem/a"], path, t2, now)).toEqual(["Chem/a", "Z/z"]);
	});

	it("no timetable: unchanged copy", () => {
		expect(orderByTerm(items, path, null, now)).toEqual(items);
		expect(orderByTerm(items, path, tt([]), now)).toEqual(items);
	});
});
