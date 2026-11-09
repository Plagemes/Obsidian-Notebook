import { describe, expect, it } from "vitest";
import { buildPlanner } from "../src/model/planner";
import {
	cleanTaskText, dailyDateOf, datesInTitle, dueOf, extractTasks, hasTaskItems, isIsoDay, MAX_FILE_TASKS, MAX_INDEXED_FILES, MAX_SHOWN,
	MAX_TOTAL_TASKS, plannerPageDates, TaskIndex, type TaskEntry,
} from "../src/integration/planner-tasks";
import type { Page } from "../src/model/types";

const entry = (path: string, line: number, due: string, done = false, text = "t"): TaskEntry => ({ path, line, done, text, due });

describe("isIsoDay / dailyDateOf", () => {
	it("accepts real days only", () => {
		expect(isIsoDay("2026-03-12")).toBe(true);
		expect(isIsoDay("2026-02-30")).toBe(false);
		expect(isIsoDay("2026-13-01")).toBe(false);
		expect(isIsoDay("26-03-12")).toBe(false);
	});
	it("reads the day a daily note is named after", () => {
		expect(dailyDateOf("Daily/2026-03-12.md")).toBe("2026-03-12");
		expect(dailyDateOf("2026-03-12 Thursday.md")).toBe("2026-03-12");
		expect(dailyDateOf("Daily/2026-03-12-extra.md")).toBe("2026-03-12");
		expect(dailyDateOf("Projects/Plan.md")).toBeNull();
		expect(dailyDateOf("2026-02-31.md")).toBeNull();
	});
});

describe("dueOf / cleanTaskText", () => {
	it("finds the common due markers", () => {
		expect(dueOf("Pay rent 📅 2026-03-12")).toBe("2026-03-12");
		expect(dueOf("Pay rent 📅2026-03-12 ⏫")).toBe("2026-03-12");
		expect(dueOf("Pay rent [due:: 2026-03-12]")).toBe("2026-03-12");
		expect(dueOf("Pay rent (due:: 2026-03-12)")).toBe("2026-03-12");
		expect(dueOf("Pay rent due:: 2026-03-12")).toBe("2026-03-12");
		expect(dueOf("Pay rent ⏳ 2026-03-12")).toBeNull();
		expect(dueOf("Pay rent 📅 2026-02-30")).toBeNull();
		expect(dueOf("Pay rent")).toBeNull();
	});
	it("strips the markers from the shown text", () => {
		expect(cleanTaskText("Pay rent 📅 2026-03-12 ⏳ 2026-03-10 [project:: home] ^abc12")).toBe("Pay rent");
		expect(cleanTaskText("x".repeat(300)).length).toBeLessThanOrEqual(140);
	});
});

describe("extractTasks", () => {
	const note = [
		"---", "- [ ] in frontmatter 📅 2026-03-12", "---", "- [ ] a 📅 2026-03-12", "- [x] b [due:: 2026-03-13]", "* [ ] no date",
		"```", "- [ ] in code 📅 2026-03-12", "```", "  - [/] c 📅 2026-03-14", "- [-] cancelled 📅 2026-03-12", "> - [ ] quoted 📅 2026-03-15", "1. [ ] numbered 📅 2026-03-16",
	].join("\n");
	it("keeps due tasks, skipping frontmatter, code, cancelled and undated lines", () => {
		const got = extractTasks("Notes/n.md", note);
		expect(got.map((e) => [e.line, e.done, e.text, e.due])).toEqual([
			[3, false, "a", "2026-03-12"], [4, true, "b", "2026-03-13"], [9, false, "c", "2026-03-14"], [11, false, "quoted", "2026-03-15"], [12, false, "numbered", "2026-03-16"],
		]);
	});
	it("gives a task in a daily note its day when it has no date of its own", () => {
		const got = extractTasks("Daily/2026-03-12.md", "- [ ] plain\n- [ ] other 📅 2026-03-20");
		expect(got.map((e) => e.due)).toEqual(["2026-03-12", "2026-03-20"]);
	});
	it("handles CRLF and is bounded per note", () => {
		expect(extractTasks("n.md", "- [ ] a 📅 2026-03-12\r\n")).toHaveLength(1);
		const many = Array.from({ length: MAX_FILE_TASKS + 50 }, (_, i) => `- [ ] t${i} 📅 2026-03-12`).join("\n");
		expect(extractTasks("n.md", many)).toHaveLength(MAX_FILE_TASKS);
	});
	it("tells which notes have task items", () => {
		expect(hasTaskItems(undefined)).toBe(false);
		expect(hasTaskItems([{}, {}])).toBe(false);
		expect(hasTaskItems([{}, { task: " " }])).toBe(true);
	});
});

describe("datesInTitle / plannerPageDates", () => {
	it("reads a day title in both languages", () => {
		expect(datesInTitle("Thursday, 12 March 2026")).toEqual(["2026-03-12"]);
		expect(datesInTitle("Giovedì 12 marzo 2026")).toEqual(["2026-03-12"]);
		expect(datesInTitle("Notes for 31 February 2026")).toEqual([]);
		expect(datesInTitle("Just a title")).toEqual([]);
	});
	it("reads a week range, also across a month and a year", () => {
		expect(datesInTitle("Week 10 · 2–8 March 2026")).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"]);
		expect(datesInTitle("Settimana 14 · 30 mar – 5 apr 2026")[0]).toBe("2026-03-30");
		expect(datesInTitle("Settimana 14 · 30 mar – 5 apr 2026")[6]).toBe("2026-04-05");
		const wrap = datesInTitle("Week 1 · 29 Dec 2025 – 4 Jan 2026");
		expect(wrap).toHaveLength(7);
		expect(wrap[0]).toBe("2025-12-29");
		expect(wrap[6]).toBe("2026-01-04");
		expect(datesInTitle("Week 1 · 29 Dec – 4 Jan 2026")[0]).toBe("2025-12-29");
		expect(datesInTitle("8–2 March 2026")).toEqual([]);
	});
	it("reads the pages the planner generator writes", () => {
		for (const lang of ["en", "it"] as const) {
			const { pages } = buildPlanner({
				year: 2026, startMonth: 1, lang, weekStart: 1, size: { width: 595, height: 842 },
				sections: { year: true, months: true, weeks: true, days: true, notes: false }, notesPages: 0, linkTarget: "P.notebook",
			});
			const day = pages.find((p) => p.paper.kind === "planner-day" && plannerPageDates(p)[0] === "2026-03-12");
			expect(day, lang).toBeTruthy();
			expect(plannerPageDates(day)).toEqual(["2026-03-12"]);
			const weeks = pages.filter((p) => p.paper.kind === "planner-week").map((p) => plannerPageDates(p));
			expect(weeks.length).toBeGreaterThan(50);
			expect(weeks.every((w) => w.length === 7), lang).toBe(true);
			expect(weeks.some((w) => w.includes("2026-03-12"))).toBe(true);
			expect(pages.filter((p) => p.paper.kind !== "planner-day" && p.paper.kind !== "planner-week").every((p) => plannerPageDates(p).length === 0)).toBe(true);
		}
	});
	it("ignores a date typed on an ordinary page or lower on the page", () => {
		const text = (y: number) => ({ id: "t", type: "text" as const, x: 0, y, width: 100, text: "Thursday, 12 March 2026", fontSize: 16, color: "#000" });
		const page = (kind: string, y: number) => ({ id: "p", width: 100, height: 100, paper: { kind, spacing: 8 }, strokes: [], elements: [text(y)] }) as unknown as Page;
		expect(plannerPageDates(page("lined", 8))).toEqual([]);
		expect(plannerPageDates(page("planner-day", 300))).toEqual([]);
		expect(plannerPageDates(page("planner-day", 8))).toEqual(["2026-03-12"]);
		expect(plannerPageDates(null)).toEqual([]);
	});
});

describe("TaskIndex", () => {
	it("looks up the tasks due on some days, open first", () => {
		const ix = new TaskIndex();
		ix.set("a.md", 1, [entry("a.md", 5, "2026-03-13", true), entry("a.md", 1, "2026-03-12")]);
		ix.set("b.md", 1, [entry("b.md", 2, "2026-03-12"), entry("b.md", 3, "2026-04-01")]);
		const r = ix.dueOn(["2026-03-12", "2026-03-13", "2026-03-12"]);
		expect(r.items.map((e) => `${e.path}:${e.line}`)).toEqual(["a.md:1", "b.md:2", "a.md:5"]);
		expect(r.total).toBe(3);
		expect(r.open).toBe(2);
		expect(ix.dueOn(["2030-01-01"]).items).toEqual([]);
	});
	it("updates one note at a time and forgets removed ones", () => {
		const ix = new TaskIndex();
		ix.set("a.md", 1, [entry("a.md", 1, "2026-03-12")]);
		expect(ix.stampOf("a.md")).toBe(1);
		expect(ix.dueOn(["2026-03-12"]).total).toBe(1);
		ix.set("a.md", 2, [entry("a.md", 1, "2026-03-20")]);
		expect(ix.dueOn(["2026-03-12"]).total).toBe(0);
		expect(ix.dueOn(["2026-03-20"]).total).toBe(1);
		ix.set("a.md", 3, []);
		expect(ix.fileCount).toBe(0);
		ix.set("b.md", 1, [entry("b.md", 1, "2026-03-12")]);
		expect(ix.remove("b.md")).toBe(true);
		expect(ix.remove("b.md")).toBe(false);
		expect(ix.taskCount).toBe(0);
	});
	it("is bounded in notes, tasks in all and rows shown", () => {
		const ix = new TaskIndex();
		for (let i = 0; i < MAX_INDEXED_FILES + 5; i++) ix.set(`n${i}.md`, 1, [entry(`n${i}.md`, 0, "2026-03-12")]);
		expect(ix.fileCount).toBe(MAX_INDEXED_FILES);
		expect(ix.truncated).toBe(true);
		const ix2 = new TaskIndex();
		for (let i = 0; i < 30; i++) ix2.set(`m${i}.md`, 1, Array.from({ length: 300 }, (_, k) => entry(`m${i}.md`, k, "2026-03-12")));
		expect(ix2.taskCount).toBe(MAX_TOTAL_TASKS);
		const r = ix2.dueOn(["2026-03-12"]);
		expect(r.items).toHaveLength(MAX_SHOWN);
		expect(r.total).toBe(MAX_TOTAL_TASKS);
	});
});
