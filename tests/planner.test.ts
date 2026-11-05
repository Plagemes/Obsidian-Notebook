import { describe, expect, it } from "vitest";
import { parseLinks, soleLink } from "../src/ink/link-text";
import { textElementBounds } from "../src/ink/text-layout";
import { pageTargetFromSubpath } from "../src/integration/page-links";
import { civil, dayNumber, weekStartOf, type WeekStart } from "../src/model/calendar";
import {
	buildPlanner, dayTitle, plannerDocument, plannerPageCount, plannerProblem, planPlanner, weekRangeLabel, yearTitle,
	type PlannerOptions, type PlannerSections,
} from "../src/model/planner";
import { parse, serializeChecked } from "../src/model/serialize";
import { PAGE_SIZES, type Page, type TextElement } from "../src/model/types";
import { planRange } from "../src/model/calendar";

const ALL: PlannerSections = { year: true, months: true, weeks: true, days: true, notes: true };
const TARGET = "Planner 2026.notebook";

function options(over: Partial<PlannerOptions> = {}): PlannerOptions {
	let n = 0;
	return {
		year: 2026, startMonth: 1, lang: "en", weekStart: 1, size: PAGE_SIZES.a4, sections: ALL, notesPages: 6, linkTarget: TARGET,
		newId: () => `e${++n}`, ...over,
	};
}

const texts = (p: Page): TextElement[] => (p.elements ?? []).filter((e): e is TextElement => e.type === "text");
const linksOf = (p: Page) => texts(p).flatMap((e) => { const l = soleLink(e.text); return l ? [l] : []; });

/** The page a link points at (by id, checked against the number too). */
function targetOf(pages: Page[], text: string): Page {
	const link = parseLinks(text)[0]!;
	expect(link.target).toBe(TARGET);
	const t = pageTargetFromSubpath(link.subpath)!;
	const byId = pages.findIndex((p) => p.id === t.pageId);
	expect(byId).toBeGreaterThanOrEqual(0);
	expect(t.page).toBe(byId + 1);
	return pages[byId]!;
}

describe("planner problems and counts", () => {
	it("accepts sensible choices and refuses the rest", () => {
		const o = options();
		expect(plannerProblem(o)).toBeNull();
		expect(plannerProblem({ ...o, year: 1800 })).toBe("year");
		expect(plannerProblem({ ...o, year: 2026.5 })).toBe("year");
		expect(plannerProblem({ ...o, startMonth: 13 })).toBe("month");
		expect(plannerProblem({ ...o, sections: { year: false, months: false, weeks: false, days: false, notes: false } })).toBe("sections");
		expect(plannerProblem({ ...o, sections: { year: false, months: false, weeks: false, days: false, notes: true }, notesPages: 0 })).toBe("sections");
		expect(plannerProblem({ ...o, notesPages: 101 })).toBe("notes");
		expect(plannerProblem({ ...o, size: { width: 10, height: 10 } })).toBe("size");
	});

	it("counts the pages of every section", () => {
		const o = options();
		expect(plannerPageCount(o)).toBe(1 + 12 + 53 + 365 + 6);
		expect(plannerPageCount({ ...o, year: 2024 })).toBe(1 + 12 + 53 + 366 + 6);
		expect(plannerPageCount({ ...o, sections: { ...ALL, days: false, weeks: false, notes: false } })).toBe(13);
		expect(plannerPageCount({ ...o, sections: { ...ALL, days: false, weeks: false }, notesPages: 3 })).toBe(16);
		expect(plannerPageCount({ ...o, year: 1800 })).toBe(0);
		// Sunday-start weeks cover the same year in 53 weeks too.
		expect(planPlanner({ ...o, weekStart: 0 }).weeks.size).toBe(53);
	});

	it("covers an academic year across the new year", () => {
		const o = options({ year: 2025, startMonth: 9 });
		const plan = planPlanner(o);
		expect(plan.days.size).toBe(365);
		expect(plan.months.map((s) => s?.id)).toEqual(["m9", "m10", "m11", "m12", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
		expect(yearTitle(planRange(2025, 9))).toBe("2025–2026");
		expect(yearTitle(planRange(2026, 1))).toBe("2026");
		expect(planPlanner(options({ year: 2023, startMonth: 9 })).days.size).toBe(366);
	});
});

describe("the generated pages", () => {
	const o = options();
	const { pages, bookmarks } = buildPlanner(o);

	it("has the pages in chronological order with short stable ids", () => {
		expect(pages).toHaveLength(437);
		expect(pages[0]!.id).toBe("y");
		expect(pages[1]!.id).toBe("m1");
		expect(pages[pages.length - 1]!.id).toBe("n6");
		expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
		for (const p of pages) expect(p.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		// January is followed by its five weeks (the week of Mon 2025-12-29 belongs to January) and then its days.
		expect(pages.slice(1, 7).map((p) => p.paper.kind)).toEqual(["grid", "planner-week", "planner-week", "planner-week", "planner-week", "planner-week"]);
		expect(pages[7]!.paper.kind).toBe("planner-day");
		expect(pages.filter((p) => p.paper.kind === "planner-day")).toHaveLength(365);
	});

	it("uses existing papers only and never ink", () => {
		const kinds = new Set(pages.map((p) => p.paper.kind));
		expect([...kinds].sort()).toEqual(["blank", "dotted", "grid", "planner-day", "planner-week"]);
		for (const p of pages) {
			expect(p.strokes).toEqual([]);
			expect(p.width).toBe(PAGE_SIZES.a4.width);
		}
		const elementTypes = new Set(pages.flatMap((p) => (p.elements ?? []).map((e) => e.type)));
		expect([...elementTypes]).toEqual(["text"]);
	});

	it("sets the month grid paper to the calendar cell", () => {
		const month = pages.find((p) => p.id === "m3")!;
		expect(month.paper.kind).toBe("grid");
		expect(month.paper.spacing * 7).toBeLessThanOrEqual(month.width + 1e-6);
		expect(month.paper.spacing * 7).toBeGreaterThan(month.width - 1);
	});

	it("types every date of a month as text", () => {
		const month = pages.find((p) => p.id === "m2")!;
		const numbers = texts(month).map((e) => e.text).filter((s) => /^\d{1,2}$/.test(s)).map(Number);
		expect(numbers).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
		expect(texts(month)[0]!.text).toBe("February 2026");
		const day = pages.find((p) => p.id === "d71")!; // 2026-03-12
		expect(texts(day)[0]!.text).toBe("Thursday, 12 March 2026");
		const week = pages.find((p) => p.id === "w11")!;
		expect(texts(week)[0]!.text).toBe("Week 11 · 9–15 March 2026");
	});

	it("links every page up and the levels down, by page id", () => {
		const byId = new Map(pages.map((p) => [p.id, p]));
		// Year -> its twelve months, and notes.
		const yearTargets = linksOf(pages[0]!).map((l) => targetOf(pages, `[[${l.inner}]]`).id);
		expect(yearTargets).toEqual(["n1", ...Array.from({ length: 12 }, (_, i) => `m${i + 1}`)]);
		// Month -> its weeks; week -> its seven days; day -> its week.
		const march = byId.get("m3")!;
		const weekIds = linksOf(march).map((l) => targetOf(pages, `[[${l.inner}]]`).id).filter((id) => id.startsWith("w"));
		expect(weekIds.length).toBeGreaterThanOrEqual(5);
		const w = byId.get("w11")!;
		const down = linksOf(w).map((l) => targetOf(pages, `[[${l.inner}]]`).id);
		expect(down.filter((id) => id.startsWith("d"))).toEqual(Array.from({ length: 7 }, (_, i) => `d${71 - 3 + i}`));
		expect(down.filter((id) => id.startsWith("m"))).toEqual(["m3"]);
		const day = byId.get("d71")!;
		expect(linksOf(day).map((l) => targetOf(pages, `[[${l.inner}]]`).id)).toEqual(["w11"]);
		for (const p of pages) {
			if (p.id === "y") continue;
			expect(linksOf(p).length, p.id).toBeGreaterThan(0);
		}
	});

	it("makes each link a sole link whose box is the tap area", () => {
		for (const p of pages.slice(0, 20)) {
			for (const e of texts(p)) {
				if (!e.text.includes("[[")) continue;
				expect(soleLink(e.text), e.text).not.toBeNull();
				expect(e.text).toMatch(/^\[\[Planner 2026\.notebook#p\d+&id=[A-Za-z0-9]+\|[^[\]|]+\]\]$/);
			}
		}
	});

	it("puts an outline bookmark on the year, every month and the notes", () => {
		expect(bookmarks.map((b) => b.title)).toEqual([
			"2026", "January 2026", "February 2026", "March 2026", "April 2026", "May 2026", "June 2026", "July 2026", "August 2026",
			"September 2026", "October 2026", "November 2026", "December 2026", "Notes",
		]);
		expect(bookmarks.map((b) => b.id)).toEqual(["y", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "n1"]);
	});

	it("keeps every box on the page, for every size, orientation and mix of sections", () => {
		const sizes = [PAGE_SIZES.a4, PAGE_SIZES.a5, PAGE_SIZES.b5, PAGE_SIZES.letter];
		const mixes: PlannerSections[] = [
			ALL,
			{ year: true, months: true, weeks: false, days: false, notes: false },
			{ year: true, months: false, weeks: true, days: false, notes: true },
			{ year: true, months: true, weeks: false, days: true, notes: false },
			{ year: false, months: true, weeks: true, days: true, notes: true },
			{ year: true, months: false, weeks: false, days: true, notes: false },
		];
		for (const base of sizes) {
			for (const landscape of [false, true]) {
				const size = landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
				for (const sections of mixes) {
					for (const weekStart of [0, 1] as WeekStart[]) {
						const built = buildPlanner(options({ size, sections, weekStart })).pages;
						for (const p of built.filter((_, i) => i < 45 || i % 25 === 0)) {
							for (const e of texts(p)) {
								const b = textElementBounds(e);
								const where = `${size.width}x${size.height} ${p.id} "${e.text.slice(0, 30)}"`;
								expect(b.minX, where).toBeGreaterThanOrEqual(0);
								expect(b.minY, where).toBeGreaterThanOrEqual(0);
								expect(b.maxX, where).toBeLessThanOrEqual(p.width + 0.5);
								expect(b.maxY, where).toBeLessThanOrEqual(p.height + 0.5);
							}
						}
					}
				}
			}
		}
	});
});

describe("sections left out", () => {
	it("links a day straight up to its month when there are no weeks", () => {
		const { pages } = buildPlanner(options({ sections: { year: true, months: true, weeks: false, days: true, notes: false } }));
		const day = pages.find((p) => p.id === "d71")!;
		expect(linksOf(day).map((l) => targetOf(pages, `[[${l.inner}]]`).id)).toEqual(["m3"]);
		// The month lists its days instead of its weeks.
		const march = pages.find((p) => p.id === "m3")!;
		expect(linksOf(march).filter((l) => /^\d+ /.test(l.alias ?? "")).length).toBe(31 + 0);
	});

	it("bookmarks the first week or day of a month when month pages are left out", () => {
		const { bookmarks } = buildPlanner(options({ sections: { year: true, months: false, weeks: false, days: true, notes: false } }));
		expect(bookmarks.map((b) => b.id)).toEqual(["y", "d1", "d32", "d60", "d91", "d121", "d152", "d182", "d213", "d244", "d274", "d305", "d335"]);
	});

	it("lets the year page reach the first week or day when there are no months", () => {
		const { pages } = buildPlanner(options({ sections: { year: true, months: false, weeks: true, days: false, notes: false } }));
		expect(linksOf(pages[0]!).map((l) => targetOf(pages, `[[${l.inner}]]`).id)).toEqual(["w1"]);
	});

	it("makes notes only", () => {
		const { pages } = buildPlanner(options({ sections: { year: false, months: false, weeks: false, days: false, notes: true }, notesPages: 2 }));
		expect(pages.map((p) => p.id)).toEqual(["n1", "n2"]);
		expect(linksOf(pages[1]!).map((l) => targetOf(pages, `[[${l.inner}]]`).id)).toEqual(["n1"]);
	});
});

describe("languages and week start", () => {
	it("writes the names in Italian", () => {
		const { pages } = buildPlanner(options({ lang: "it" }));
		expect(texts(pages.find((p) => p.id === "m3")!)[0]!.text).toBe("Marzo 2026");
		expect(texts(pages.find((p) => p.id === "d71")!)[0]!.text).toBe("Giovedì 12 marzo 2026");
		expect(texts(pages.find((p) => p.id === "w11")!)[0]!.text).toBe("Settimana 11 · 9–15 marzo 2026");
		expect(dayTitle("en", dayNumber(2026, 1, 1))).toBe("Thursday, 1 January 2026");
	});

	it("labels weeks that cross a month or a year", () => {
		expect(weekRangeLabel("en", dayNumber(2026, 3, 30))).toBe("30 Mar – 5 Apr 2026");
		expect(weekRangeLabel("en", dayNumber(2025, 12, 29))).toBe("29 Dec 2025 – 4 Jan 2026");
		expect(weekRangeLabel("it", dayNumber(2026, 3, 30))).toBe("30 mar – 5 apr 2026");
	});

	it("starts the month columns on the chosen day", () => {
		const header = (weekStart: WeekStart) => {
			const { pages } = buildPlanner(options({ weekStart, sections: { ...ALL, weeks: false, days: false } }));
			return texts(pages.find((p) => p.id === "m3")!).slice(2, 9).map((e) => e.text);
		};
		expect(header(1)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
		expect(header(0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
	});

	it("puts a week in the month of its middle day", () => {
		const plan = planPlanner(options());
		expect(plan.weeks.get(dayNumber(2025, 12, 29))!.mi).toBe(0);
		expect(plan.weeks.get(dayNumber(2026, 3, 30))!.mi).toBe(3);
		expect(plan.weeks.get(dayNumber(2026, 12, 28))!.mi).toBe(11);
		// Every day finds its week.
		for (const [dn] of plan.days) expect(plan.weeks.has(weekStartOf(dn, 1))).toBe(true);
	});
});

describe("the document", () => {
	it("is a valid notebook with the outline bookmarks and writes and reads back", () => {
		const doc = plannerDocument(options(), new Date("2026-01-01T00:00:00Z"));
		expect(doc.pages).toHaveLength(437);
		expect(doc.meta!.bookmarks).toHaveLength(14);
		expect(doc.meta!.bookmarkInfo!["m3"]).toEqual({ title: "March 2026" });
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		const back = parse(checked.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.doc.pages).toHaveLength(437);
		expect(back.doc.pages[0]!.id).toBe("y");
		expect(back.doc.meta!.bookmarks).toEqual(doc.meta!.bookmarks);
	});

	it("builds a full year of day pages quickly", () => {
		const start = Date.now();
		const doc = plannerDocument(options({ newId: undefined }));
		const built = Date.now() - start;
		expect(doc.pages.length).toBe(437);
		expect(built).toBeLessThan(2000);
		const ids = new Set<string>();
		for (const p of doc.pages) for (const e of p.elements ?? []) {
			expect(ids.has(e.id)).toBe(false);
			ids.add(e.id);
		}
	});

	it("is deterministic apart from ids", () => {
		const strip = (o: PlannerOptions) => buildPlanner(o).pages.map((p) => ({ ...p, elements: texts(p).map((e) => ({ ...e, id: "" })) }));
		expect(strip(options())).toEqual(strip(options()));
		expect(civil(dayNumber(2026, 3, 12)).d).toBe(12);
	});
});
