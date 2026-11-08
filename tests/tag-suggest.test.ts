import { describe, expect, it } from "vitest";
import { contentWords, isStopWord, suggestFromContext, tagForKind } from "../src/model/tag-suggest";

describe("contentWords", () => {
	it("drops English and Italian stop-words, short words and numbers", () => {
		expect(contentWords("The derivative of a function and the 2026 limit")).toEqual(["derivative", "function", "limit"]);
		expect(contentWords("La derivata della funzione è uguale")).toEqual(["derivata", "funzione", "uguale"]);
	});
	it("knows stop-words with or without accents", () => {
		expect(isStopWord("perché")).toBe(true);
		expect(isStopWord("perche")).toBe(true);
		expect(isStopWord("entropy")).toBe(false);
	});
});

describe("suggestFromContext", () => {
	it("ranks course, siblings, kinds, then words", () => {
		const out = suggestFromContext({
			course: "Organic Chemistry",
			siblingTags: [["exam"], ["exam"]],
			kinds: ["question", "gap", "definition"],
			text: ["enzyme enzyme enzyme binds substrate"],
		});
		expect(out[0]).toBe("Organic-Chemistry");
		expect(out[1]).toBe("exam");
		expect(out).toContain("questions");
		expect(out).toContain("definitions");
		expect(out).toContain("enzyme");
		expect(out).not.toContain("binds");
		expect(out.length).toBeLessThanOrEqual(6);
	});
	it("normalises to Obsidian tag syntax and keeps spaces for page tags", () => {
		expect(suggestFromContext({ course: "Fisica 2/Lab" })).toEqual(["Fisica-2/Lab"]);
		expect(suggestFromContext({ course: "Fisica 2", style: "page" })).toEqual(["Fisica 2"]);
		expect(suggestFromContext({ course: "2026" })).toEqual([]);
	});
	it("never suggests tags already there (any case, any spelling)", () => {
		expect(suggestFromContext({ course: "Physics", siblingTags: [["exam"]], existing: ["physics", "#Exam"] })).toEqual([]);
		expect(suggestFromContext({ course: "Fisica 2", existing: ["Fisica-2"] })).toEqual([]);
	});
	it("needs a word to repeat (or be a heading) before suggesting it", () => {
		expect(suggestFromContext({ text: ["entropy once"] })).toEqual([]);
		expect(suggestFromContext({ headings: ["Entropy"] })).toEqual(["entropy"]);
		expect(suggestFromContext({ text: ["entropy entropy entropy"] })).toEqual(["entropy"]);
	});
	it("counts one vote per sibling notebook and merges case", () => {
		const out = suggestFromContext({ siblingTags: [["Exam", "exam"], ["EXAM"], ["lab"]] });
		expect(out).toEqual(["Exam", "lab"]);
	});
	it("honours the limit and is empty without context", () => {
		expect(suggestFromContext({})).toEqual([]);
		const siblingTags = [["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1"]];
		expect(suggestFromContext({ siblingTags }).length).toBe(6);
		expect(suggestFromContext({ siblingTags, limit: 2 }).length).toBe(2);
	});
	it("maps only meaningful kinds", () => {
		expect(tagForKind("gap")).toBeNull();
		expect(tagForKind("star")).toBeNull();
		expect(tagForKind("theorem")).toBe("theorems");
	});
});

import { courseForTags, documentSignals, pageSignals, siblingTagLists, tagSuggestionsFor } from "../src/model/tag-context";
import type { Timetable } from "../src/timetable/schedule";

const entry = (course: string, notebook?: string) => ({ id: course, course, day: 1, start: "09:00", end: "10:00", ...(notebook ? { notebook } : {}) });
const tt = (entries: ReturnType<typeof entry>[]) => ({ version: 1, entries }) as unknown as Timetable;

describe("tag context", () => {
	it("finds the course linked to the notebook, the closest link first", () => {
		const t = tt([entry("Physics", "Uni"), entry("Optics", "Uni/Physics"), entry("Art")]);
		expect(courseForTags(t, "Uni/Physics/week1.nb")).toBe("Optics");
		expect(courseForTags(t, "Uni/Other/x.nb")).toBe("Physics");
		expect(courseForTags(t, "Elsewhere/x.nb")).toBeNull();
		expect(courseForTags(null, "x.nb")).toBeNull();
	});
	it("collects the tags of sibling notebooks only", () => {
		const entries = [{ path: "A/a.nb", tags: ["x"] }, { path: "A/b.nb", tags: ["y"] }, { path: "B/c.nb", tags: ["z"] }, { path: "A/d.nb", tags: [] }];
		expect(siblingTagLists(entries, "A/a.nb")).toEqual([["y"]]);
	});
	it("reads text, box titles and kinds of a page", () => {
		const page = { elements: [{ type: "text", text: "hello" }, { type: "marker", kind: "question" }, { type: "box", kind: "definition", title: "Entropy" }] } as never;
		expect(pageSignals(page)).toEqual({ text: ["hello"], headings: ["Entropy"], kinds: ["question", "definition"] });
		expect(documentSignals({ pages: [page], meta: { bookmarkInfo: { p: { title: "Chapter" } } } } as never).headings).toEqual(["Entropy", "Chapter"]);
	});
	it("gives nothing when suggestions are off", () => {
		expect(tagSuggestionsFor({ enabled: false, timetable: tt([entry("Physics")]), notebookPath: "x.nb" })).toEqual([]);
		expect(tagSuggestionsFor({ enabled: true, timetable: tt([entry("Physics", "x.nb")]), notebookPath: "x.nb", existing: ["physics"] })).toEqual([]);
	});
});
