import { describe, expect, it } from "vitest";
import { ACTIVITY_DAYS, ACTIVITY_PAGES_PER_DAY, ActivityLog, dayKeyOf, pageKey } from "../src/library/activity-log";
import { buildStatsModel, filterEdits, subjectsOfEdits, todayPages, type RecentEdit } from "../src/library/home-data";
import {
	chooseContinue, currentStreak, groupByNotebook, pagesByFolder, pagesPerDay, pagesToday, splitMinutes, subjectShares, writingMinutes,
	type SubjectRef,
} from "../src/library/home-stats";

/** Local noon of 2026-10-31 and the days around it. */
const NOW = new Date(2026, 9, 31, 15, 20).getTime();
const day = (back: number, hour = 10, minute = 0) => new Date(2026, 9, 31 - back, hour, minute).getTime();

function logOf(...entries: Array<[back: number, nb: string, page: string, path?: string]>): ActivityLog {
	const log = new ActivityLog();
	for (const [back, nb, page, path] of entries) log.touch(nb, path ?? "N/A/x.notebook", page, day(back));
	return log;
}

describe("activity log", () => {
	it("records a page once per day and counts the pages of each day", () => {
		const log = logOf([0, "nb1", "p1"], [0, "nb1", "p1"], [0, "nb1", "p2"], [1, "nb1", "p1"]);
		const recs = log.records();
		expect(recs.filter((r) => r.day === dayKeyOf(NOW))).toHaveLength(2);
		expect(recs.filter((r) => r.day === dayKeyOf(day(1)))).toHaveLength(1);
	});

	it("tells pages apart by notebook and page together", () => {
		expect(pageKey("aaaaaaaa-1", "bbbbbbbb-2")).toBe("aaaaaaaa:bbbbbbbb");
		const log = logOf([0, "nbA", "p1"], [0, "nbB", "p1"]);
		expect(log.records()).toHaveLength(2);
	});

	it("counts minutes of the day in which something was written, once each", () => {
		const log = new ActivityLog();
		log.touch("nb", "N/a.notebook", "p1", day(0, 10, 5));
		log.touch("nb", "N/a.notebook", "p1", day(0, 10, 5));
		log.touch("nb", "N/a.notebook", "p2", day(0, 10, 6));
		log.touch("nb", "N/a.notebook", "p2", day(0, 14, 40));
		expect(log.minutesByDay()[dayKeyOf(NOW)]).toBe(3);
	});

	it("history from the recent pages log adds pages but no minutes", () => {
		const log = new ActivityLog();
		log.touch("nb", "N/a.notebook", "p1", day(2), false);
		expect(log.records()).toHaveLength(1);
		expect(log.minutesByDay()).toEqual({});
	});

	it("follows renames and keeps the days of a deleted notebook, under no subject", () => {
		const log = logOf([0, "nb", "p1", "N/A/x.notebook"], [1, "nb", "p1", "N/A/x.notebook"]);
		expect(log.rename("N/A", "N/B")).toBe(true);
		expect(log.records().every((r) => r.path === "N/B/x.notebook")).toBe(true);
		expect(log.forgetPath("N/B/x.notebook")).toBe(true);
		expect(log.records()).toHaveLength(2);
		expect(log.records().every((r) => r.path === "")).toBe(true);
	});

	it("drops days beyond the limit and caps the pages of a day", () => {
		const log = new ActivityLog(3);
		for (let i = 0; i < 6; i++) log.touch("nb", "N/a.notebook", `p${i}`, day(i));
		expect(new Set(log.records().map((r) => r.day)).size).toBe(3);
		expect(ACTIVITY_DAYS).toBeGreaterThan(30);
		const big = new ActivityLog();
		for (let i = 0; i < ACTIVITY_PAGES_PER_DAY + 20; i++) big.touch("nb", "N/a.notebook", `page-${i}`, day(0));
		expect(big.records()).toHaveLength(ACTIVITY_PAGES_PER_DAY);
	});

	it("round-trips through JSON and survives garbage", () => {
		const log = logOf([0, "nb1", "p1", "N/A/x.notebook"], [3, "nb2", "p9", "N/B/y.notebook"]);
		log.touch("nb1", "N/A/x.notebook", "p1", day(0, 11, 11));
		const back = ActivityLog.parse(JSON.stringify(log.toJSON()));
		expect(back.records()).toEqual(log.records());
		expect(back.minutesByDay()).toEqual(log.minutesByDay());
		for (const bad of [null, "not json", "{}", { version: 1 }, { paths: [], days: { "nope": {} } }, { paths: 3, days: {} }, 42]) {
			expect(ActivityLog.parse(bad).records()).toEqual([]);
		}
	});
});

describe("pages per day and the greeting's count", () => {
	it("gives one bar per day, oldest first, today last, zeros included", () => {
		const log = logOf([0, "nb", "a"], [0, "nb", "b"], [2, "nb", "a"], [9, "nb", "a"]);
		const days = pagesPerDay(log.records(), NOW, 7);
		expect(days).toHaveLength(7);
		expect(days.map((d) => d.pages)).toEqual([0, 0, 0, 0, 1, 0, 2]);
		expect(days[6]!.day).toBe(dayKeyOf(NOW));
		expect(pagesPerDay(log.records(), NOW, 14).map((d) => d.pages).slice(-14)[4]).toBe(1);
	});

	it("counts today's pages for the greeting", () => {
		const log = logOf([0, "nb", "a"], [0, "nb", "b"], [1, "nb", "c"]);
		expect(pagesToday(log.records(), NOW)).toBe(2);
		expect(todayPages(log.records(), NOW)).toBe(2);
		expect(pagesToday([], NOW)).toBe(0);
	});
});

describe("streak", () => {
	it("counts the days in a row up to today", () => {
		const log = logOf([0, "nb", "a"], [1, "nb", "a"], [2, "nb", "a"], [4, "nb", "a"]);
		expect(currentStreak(log.records(), NOW)).toBe(3);
	});

	it("is still alive when today has no page yet", () => {
		const log = logOf([1, "nb", "a"], [2, "nb", "a"]);
		expect(currentStreak(log.records(), NOW)).toBe(2);
	});

	it("is broken by a missed day, and is 0 with nothing recent", () => {
		expect(currentStreak(logOf([2, "nb", "a"], [3, "nb", "a"]).records(), NOW)).toBe(0);
		expect(currentStreak([], NOW)).toBe(0);
	});

	it("crosses a month boundary", () => {
		const first = new Date(2026, 10, 2, 9).getTime();
		const log = new ActivityLog();
		for (const d of [new Date(2026, 9, 30, 9), new Date(2026, 9, 31, 9), new Date(2026, 10, 1, 9), new Date(2026, 10, 2, 9)]) log.touch("nb", "N/a.notebook", "p", d.getTime());
		expect(currentStreak(log.records(), first)).toBe(4);
	});
});

describe("split by subject and writing time", () => {
	const subjects: Record<string, SubjectRef> = {
		"N/Anatomia/a.notebook": { key: "N/Anatomia", label: "Anatomia", color: "#f00" },
		"N/Fisiologia/b.notebook": { key: "N/Fisiologia", label: "Fisiologia", color: "#00f" },
	};
	const subjectOf = (path: string) => subjects[path] ?? null;

	it("ranks subjects by pages written in the period, with their share", () => {
		const log = logOf(
			[0, "n1", "a", "N/Anatomia/a.notebook"], [0, "n1", "b", "N/Anatomia/a.notebook"], [1, "n1", "c", "N/Anatomia/a.notebook"],
			[1, "n2", "a", "N/Fisiologia/b.notebook"], [20, "n2", "z", "N/Fisiologia/b.notebook"], [0, "n3", "a", "N/loose.notebook"],
		);
		const split = subjectShares(log.records(), NOW, 7, subjectOf);
		expect(split.map((s) => [s.label, s.pages])).toEqual([["Anatomia", 3], ["Fisiologia", 1]]);
		expect(split[0]!.share).toBeCloseTo(0.75);
		expect(split[1]!.share).toBeCloseTo(0.25);
	});

	it("is empty when nothing belongs to a subject", () => {
		expect(subjectShares(logOf([0, "n", "a", "N/loose.notebook"]).records(), NOW, 7, subjectOf)).toEqual([]);
	});

	it("estimates the writing time as the minutes in which something was written", () => {
		const minutes = { [dayKeyOf(day(0))]: 40, [dayKeyOf(day(3))]: 95, [dayKeyOf(day(10))]: 500 };
		expect(writingMinutes(minutes, NOW, 7)).toBe(135);
		expect(writingMinutes(minutes, NOW, 14)).toBe(635);
		expect(splitMinutes(135)).toEqual({ hours: 2, minutes: 15 });
		expect(splitMinutes(45)).toEqual({ hours: 0, minutes: 45 });
	});
});

describe("statistics model: what is shown and what is hidden", () => {
	const base = { minutesByDay: {}, now: NOW, days: 7, subjectOf: () => null, pdfNotebooks: 0, notebooks: 4 };

	it("a library with notebooks but no writing yet: an empty chart, no streak, no time, no split", () => {
		const m = buildStatsModel({ ...base, records: [] });
		expect(m.visible).toBe(true);
		expect(m.chartEmpty).toBe(true);
		expect([m.streak, m.minutes, m.split.length, m.pdf]).toEqual([0, 0, 0, 0]);
	});

	it("an empty library shows no statistics", () => {
		expect(buildStatsModel({ ...base, records: [], notebooks: 0 }).visible).toBe(false);
	});

	it("totals the period and averages it per day", () => {
		const log = logOf([0, "n", "a"], [0, "n", "b"], [1, "n", "a"], [2, "n", "a"], [3, "n", "a"], [4, "n", "a"], [5, "n", "a"], [6, "n", "a"], [6, "n", "b"]);
		const m = buildStatsModel({ ...base, records: log.records(), minutesByDay: { [dayKeyOf(NOW)]: 30 } });
		expect(m.total).toBe(9);
		expect(m.average).toBe(1.3);
		expect(m.streak).toBe(7);
		expect(m.minutes).toBe(30);
		expect(m.chartEmpty).toBe(false);
	});
});

describe("recent notes: grouping and the subject filter", () => {
	const edits: RecentEdit[] = [
		{ path: "N/A/one.notebook", pageId: "p1", num: 1, at: 100 },
		{ path: "N/B/two.notebook", pageId: "q1", num: 4, at: 90 },
		{ path: "N/A/one.notebook", pageId: "p2", num: 2, at: 80 },
		{ path: "N/A/one.notebook", pageId: "p3", num: 3, at: 70 },
		{ path: "N/C/three.notebook", pageId: "r1", num: 1, at: 60 },
	];

	it("groups by notebook, newest group first, newest pages first, capped", () => {
		const g = groupByNotebook(edits, 2, 2);
		expect(g.map((x) => x.path)).toEqual(["N/A/one.notebook", "N/B/two.notebook"]);
		expect(g[0]!.items.map((i) => i.pageId)).toEqual(["p1", "p2"]);
		expect(groupByNotebook(edits).map((x) => x.path)).toHaveLength(3);
		expect(groupByNotebook([])).toEqual([]);
	});

	it("lists the subjects present and filters to one", () => {
		const subjectOf = (p: string): SubjectRef | null => {
			const top = p.split("/").slice(0, 2).join("/");
			return p.includes("/C/") ? null : { key: top, label: top.slice(2), color: "#000" };
		};
		expect(subjectsOfEdits(edits, subjectOf).map((s) => s.label)).toEqual(["A", "B"]);
		expect(filterEdits(edits, "N/B", subjectOf)).toHaveLength(1);
		expect(filterEdits(edits, null, subjectOf)).toHaveLength(5);
		expect(filterEdits(edits, "N/Z", subjectOf)).toEqual([]);
	});
});

describe("pages per folder (the sidebar)", () => {
	it("adds the pages of every notebook to its folder and to the folders above", () => {
		const entries = [
			{ folder: "N/Anatomia", pages: 6 }, { folder: "N/Anatomia/Osso", pages: 4 }, { folder: "N/Fisiologia", pages: 5 }, { folder: "N", pages: 1 },
		];
		const m = pagesByFolder(entries, "N");
		expect(m.get("N/Anatomia")).toBe(10);
		expect(m.get("N/Anatomia/Osso")).toBe(4);
		expect(m.get("N/Fisiologia")).toBe(5);
		expect(m.get("N")).toBe(16);
	});

	it("works with the vault root as the notebooks folder", () => {
		const m = pagesByFolder([{ folder: "A/B", pages: 2 }, { folder: "", pages: 3 }], "");
		expect(m.get("A")).toBe(2);
		expect(m.get("A/B")).toBe(2);
		expect(m.get("")).toBe(5);
	});
});

describe("the Continue card", () => {
	const exists = (p: string) => p.startsWith("N/");

	it("shows the lecture in progress with its notebook", () => {
		const c = chooseContinue({ course: "Anatomia", room: "B2", target: { kind: "open", path: "N/Anatomia/Lezioni.notebook" } }, "N/last.notebook", null, exists);
		expect(c).toEqual({ kind: "lecture", course: "Anatomia", room: "B2", path: "N/Anatomia/Lezioni.notebook", folder: "N/Anatomia", name: "Anatomia" });
	});

	it("offers to make a notebook in the course's folder when there is none yet", () => {
		const c = chooseContinue({ course: "Chimica", target: { kind: "create", folder: "N/Chimica", name: "Chimica" } }, "N/last.notebook", null, exists);
		expect(c).toMatchObject({ kind: "lecture", course: "Chimica", path: null, folder: "N/Chimica", name: "Chimica" });
	});

	it("without a lecture, goes back to the last notebook opened", () => {
		expect(chooseContinue(null, "N/last.notebook", "N/new.notebook", exists)).toEqual({ kind: "last", path: "N/last.notebook" });
	});

	it("falls back to the newest notebook when the last one is gone", () => {
		expect(chooseContinue(null, "Gone/x.notebook", "N/new.notebook", exists)).toEqual({ kind: "last", path: "N/new.notebook" });
		expect(chooseContinue(null, null, "N/new.notebook", exists)).toEqual({ kind: "last", path: "N/new.notebook" });
	});

	it("has nothing to continue in an empty library", () => {
		expect(chooseContinue(null, null, null, exists)).toEqual({ kind: "none" });
		expect(chooseContinue(null, "Gone/x.notebook", "Gone/y.notebook", exists)).toEqual({ kind: "none" });
	});
});
