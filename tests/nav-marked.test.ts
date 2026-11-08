import { describe, expect, it } from "vitest";
import {
	isMarkKind, markCounts, markedOf, markedPages, MARK_KINDS, MAX_MARKED_NOTEBOOKS, normaliseMarked, pageMarks, toggleKind, withMarked, type MarkContext,
} from "../src/ui/nav-marked";
import type { Page, PageElement, Stroke } from "../src/model/types";

const stroke = (id: string, color: string, extra: Partial<Stroke> = {}): Stroke => ({ id, tool: "pen", color, width: 2, points: [[0, 0, 0.5]], ...extra }) as Stroke;
const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, width: 600, height: 800, paper: { kind: "blank", spacing: 30 }, strokes: [], ...extra });
const marker = (id: string, kind: string): PageElement => ({ id, type: "marker", kind, x: 0, y: 0 }) as PageElement;
const box = (id: string, checked?: true): PageElement => ({ id, type: "checkbox", x: 0, y: 0, size: 20, label: "", ...(checked ? { checked } : {}) }) as unknown as PageElement;

const ctx = (over: Partial<MarkContext> = {}): MarkContext => ({ bookmarks: new Set(), globalBookmarks: new Set(), legend: [], ...over });

describe("pageMarks", () => {
	it("an empty page is not marked", () => expect(pageMarks(page("a"), ctx())).toEqual([]));
	it("in-notebook and global bookmarks", () => {
		const c = ctx({ bookmarks: new Set(["a"]), globalBookmarks: new Set(["a", "b"]) });
		expect(pageMarks(page("a"), c).map((m) => m.kind)).toEqual(["bookmark", "global"]);
		expect(pageMarks(page("b"), c).map((m) => m.kind)).toEqual(["global"]);
	});
	it("markers of every kind, each listed once", () => {
		const p = page("a", { elements: [marker("1", "question"), marker("2", "gap"), marker("3", "question"), marker("4", "homework")] });
		expect(pageMarks(p, ctx())).toEqual([{ kind: "marker", detail: "question,gap,homework" }]);
	});
	it("colours with a meaning, hidden ink and unmatched colours left out", () => {
		const legend = [{ colour: "#ff0000", label: "Key" }, { colour: "#0000ff", label: "Doubt" }];
		const p = page("a", { strokes: [stroke("1", "#ff0000"), stroke("2", "#ff0000"), stroke("3", "#00ff00"), stroke("4", "#0000ff", { hidden: true })] });
		expect(pageMarks(p, ctx({ legend }))).toEqual([{ kind: "meaning", detail: "Key" }]);
		expect(pageMarks(p, ctx())).toEqual([]);
	});
	it("open checkboxes count, ticked ones do not", () => {
		expect(pageMarks(page("a", { elements: [box("1", true)] }), ctx())).toEqual([]);
		expect(pageMarks(page("a", { elements: [box("1", true), box("2")] }), ctx())).toEqual([{ kind: "task", detail: "1" }]);
	});
	it("page tags", () => expect(pageMarks(page("a", { tags: ["exam", "ch1"] }), ctx())).toEqual([{ kind: "tag", detail: "#exam #ch1" }]));
	it("a wanted list limits the kinds looked at", () => {
		const p = page("a", { tags: ["x"], elements: [marker("1", "gap")] });
		expect(pageMarks(p, ctx(), ["tag"]).map((m) => m.kind)).toEqual(["tag"]);
		expect(pageMarks(p, ctx(), []).map((m) => m.kind)).toEqual(["marker", "tag"]);
	});
});

describe("markedPages", () => {
	const pages = [page("a"), page("b", { tags: ["t"] }), page("c"), page("d", { elements: [marker("1", "question")] })];
	it("keeps the real page numbers", () => {
		expect(markedPages(pages, ctx()).map((e) => e.index)).toEqual([1, 3]);
	});
	it("a sub-filter narrows it", () => {
		expect(markedPages(pages, ctx(), ["marker"]).map((e) => e.page.id)).toEqual(["d"]);
	});
	it("nothing marked gives an empty list", () => expect(markedPages([page("a")], ctx())).toEqual([]));
	it("counts per kind", () => {
		expect(markCounts(pages, ctx({ bookmarks: new Set(["a"]) }))).toEqual({ bookmark: 1, global: 0, marker: 1, meaning: 0, task: 0, tag: 1 });
	});
});

describe("toggleKind", () => {
	it("adds in canonical order and removes", () => {
		expect(toggleKind([], "tag")).toEqual(["tag"]);
		expect(toggleKind(["tag"], "bookmark")).toEqual(["bookmark", "tag"]);
		expect(toggleKind(["bookmark", "tag"], "tag")).toEqual(["bookmark"]);
	});
	it("every kind on is the same as none picked", () => {
		const almost = MARK_KINDS.filter((k) => k !== "tag");
		expect(toggleKind(almost, "tag")).toEqual([]);
	});
	it("recognises kinds", () => {
		expect(isMarkKind("marker")).toBe(true);
		expect(isMarkKind("nope")).toBe(false);
	});
});

describe("local storage", () => {
	it("survives garbage", () => {
		expect(normaliseMarked("x")).toEqual([]);
		expect(normaliseMarked(null)).toEqual([]);
		expect(normaliseMarked({ a: 1 })).toEqual([]);
		expect(normaliseMarked([["bad id!", []], ["ok", "no"], [5, []], ["good", ["tag", "zzz"]], "junk"])).toEqual([["good", ["tag"]]]);
	});
	it("sets and clears a notebook's choice, newest last", () => {
		let s = withMarked([], "a", []);
		s = withMarked(s, "b", ["tag"]);
		s = withMarked(s, "a", ["marker"]);
		expect(s).toEqual([["b", ["tag"]], ["a", ["marker"]]]);
		expect(markedOf(s, "a")).toEqual(["marker"]);
		expect(markedOf(s, "z")).toBeNull();
		expect(markedOf(s, null)).toBeNull();
		s = withMarked(s, "a", null);
		expect(markedOf(s, "a")).toBeNull();
	});
	it("is bounded and forgets the oldest", () => {
		let s = withMarked([], "n0", []);
		for (let i = 1; i < MAX_MARKED_NOTEBOOKS + 20; i++) s = withMarked(s, `n${i}`, []);
		expect(s.length).toBe(MAX_MARKED_NOTEBOOKS);
		expect(markedOf(s, "n0")).toBeNull();
		expect(markedOf(s, `n${MAX_MARKED_NOTEBOOKS + 19}`)).toEqual([]);
	});
	it("an id that could not be a key is refused", () => expect(withMarked([], "bad id", [])).toEqual([]));
});
