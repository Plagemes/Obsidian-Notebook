import { describe, expect, it } from "vitest";
import {
	applyPaperSuggestion, courseUsageOf, normaliseCoursePaperStore, paperCandidates, PROFILE_SCORE, rememberCoursePaper, suggestPaper,
	type PaperCandidate,
} from "../src/model/paper-suggest";
import type { PaperKind } from "../src/model/types";

const P = (s: string): PaperKind[] => s.split(" ") as PaperKind[];

describe("paper suggestion ranking", () => {
	it("follows a run of the same paper", () => {
		const s = suggestPaper({ pages: P("grid grid grid grid grid"), index: 4 });
		expect(s?.paper).toBe("grid");
		expect(s?.reason).toEqual({ kind: "recent", n: 5 });
	});

	it("follows an alternating pattern", () => {
		const s = suggestPaper({ pages: P("ruled grid ruled grid"), index: 3 });
		expect(s?.paper).toBe("ruled");
		expect(s?.reason.kind).toBe("pattern");
	});

	it("says most of the last pages when one paper dominates", () => {
		const s = suggestPaper({ pages: P("ruled ruled grid ruled ruled grid"), index: 5 });
		expect(s?.paper).toBe("ruled");
		expect(s?.reason.kind).toBe("recentMost");
	});

	it("suggests nothing for a short or mixed notebook", () => {
		expect(suggestPaper({ pages: P("grid"), index: 0 })).toBeNull();
		expect(suggestPaper({ pages: P("grid ruled"), index: 1 })).toBeNull();
		expect(suggestPaper({ pages: P("grid ruled dotted"), index: 2 })).toBeNull();
	});

	it("uses the course habit when the page in view says little", () => {
		const course = { name: "Analysis", usage: { grid: 8, ruled: 1 } };
		const s = suggestPaper({ pages: P("blank ruled dotted"), index: 2, course });
		expect(s?.paper).toBe("grid");
		expect(s?.reason).toEqual({ kind: "course", course: "Analysis" });
	});

	it("ignores a course with too little history", () => {
		expect(suggestPaper({ pages: P("blank ruled dotted"), index: 2, course: { name: "A", usage: { grid: 2 } } })).toBeNull();
	});

	it("a long run beats a weak course habit", () => {
		const s = suggestPaper({ pages: P("ruled ruled ruled ruled ruled ruled"), index: 5, course: { name: "A", usage: { grid: 3 } } });
		expect(s?.paper).toBe("ruled");
	});

	it("a profile candidate outranks every history signal", () => {
		const extra: PaperCandidate[] = [{ paper: "dotted", score: PROFILE_SCORE, reason: { kind: "profile" } }];
		const list = paperCandidates({ pages: P("grid grid grid grid grid"), index: 4, extra });
		expect(list[0]).toMatchObject({ paper: "dotted", reason: { kind: "profile" } });
		expect(list.some((c) => c.paper === "grid")).toBe(true);
	});

	it("the notebook as a whole counts when the recent pages do not", () => {
		const s = suggestPaper({ pages: P("ruled ruled ruled ruled ruled blank dotted grid"), index: 7 });
		expect(s?.paper).toBe("ruled");
		expect(s?.reason.kind).toBe("notebook");
	});

	it("is never empty, is deterministic and survives a bad index", () => {
		const a = paperCandidates({ pages: [], index: 5 });
		expect(a.length).toBeGreaterThan(0);
		const input = { pages: P("grid ruled grid ruled"), index: 3 };
		expect(paperCandidates(input)).toEqual(paperCandidates(input));
		expect(paperCandidates({ pages: P("grid"), index: -3 })[0]?.paper).toBe("grid");
	});

	it("drops candidates with an unknown paper", () => {
		const extra = [{ paper: "nope" as PaperKind, score: 500, reason: { kind: "profile" as const } }];
		expect(paperCandidates({ pages: P("grid"), index: 0, extra }).every((c) => c.paper === "grid")).toBe(true);
	});
});

describe("applying the suggestion to the strip", () => {
	interface C { id: string; paper?: PaperKind }
	const make = (paper: PaperKind): C => ({ id: "recent-paper", paper });
	const s = (paper: PaperKind): PaperCandidate => ({ paper, score: 80, reason: { kind: "recent", n: 5 } });

	it("highlights the same-paper choice and moves it up front", () => {
		const choices: C[] = [{ id: "exercise", paper: "grid" }, { id: "same", paper: "ruled" }, { id: "blank", paper: "blank" }];
		const r = applyPaperSuggestion(choices, s("ruled"), "ruled", 3, make);
		expect(r.highlight).toBe(0);
		expect(r.choices.map((c) => c.id)).toEqual(["same", "exercise", "blank"]);
	});

	it("adds a choice when there is room and replaces the weakest otherwise, keeping same", () => {
		const roomy = applyPaperSuggestion([{ id: "same", paper: "ruled" }], s("grid"), "ruled", 3, make);
		expect(roomy.choices.map((c) => c.paper)).toEqual(["grid", "ruled"]);
		const full: C[] = [{ id: "same", paper: "ruled" }, { id: "exercise", paper: "dotted" }, { id: "blank", paper: "blank" }];
		const r = applyPaperSuggestion(full, s("grid"), "ruled", 3, make);
		expect(r.choices).toHaveLength(3);
		expect(r.choices[0]).toMatchObject({ id: "recent-paper", paper: "grid" });
		expect(r.choices.some((c) => c.id === "same")).toBe(true);
	});

	it("keeps the slide choice first and does nothing without a suggestion", () => {
		const choices: C[] = [{ id: "slide" }, { id: "same", paper: "ruled" }];
		const r = applyPaperSuggestion(choices, s("ruled"), "ruled", 3, make);
		expect(r.choices.map((c) => c.id)).toEqual(["slide", "same"]);
		expect(r.highlight).toBe(1);
		expect(applyPaperSuggestion(choices, null, "ruled", 3, make)).toEqual({ choices, highlight: -1 });
	});
});

describe("course habit store", () => {
	it("counts, reads back and halves a long habit", () => {
		let store = normaliseCoursePaperStore(null);
		for (let i = 0; i < 5; i++) store = rememberCoursePaper(store, " Analysis ", "grid", 100 + i);
		expect(courseUsageOf(store, "analysis").grid).toBe(5);
		for (let i = 0; i < 60; i++) store = rememberCoursePaper(store, "Analysis", "grid", 200 + i);
		const total = Object.values(courseUsageOf(store, "Analysis")).reduce((a, b) => a + (b ?? 0), 0);
		expect(total).toBeLessThanOrEqual(41);
		expect(courseUsageOf(store, "Analysis").grid).toBeGreaterThan(5);
	});

	it("is bounded, lenient and forgets the oldest courses", () => {
		let store = normaliseCoursePaperStore(null);
		for (let i = 0; i < 50; i++) store = rememberCoursePaper(store, `c${i}`, "ruled", i);
		expect(Object.keys(store)).toHaveLength(40);
		expect(store["c49"]).toBeDefined();
		expect(store["c0"]).toBeUndefined();
		expect(normaliseCoursePaperStore("junk")).toEqual({});
		expect(normaliseCoursePaperStore({ a: { at: "x", name: "A", usage: { grid: -1, nope: 4, ruled: 2.7 } }, b: 5 })).toEqual({ a: { at: 0, name: "A", usage: { ruled: 2 } } });
		expect(rememberCoursePaper(store, "  ", "grid", 1)).toBe(store);
	});
});
