import { describe, expect, it } from "vitest";
import { createId, createPage } from "../src/model/document";
import {
	countStates, filterByState, isNearlyEmpty, mapLecture, mapPage, NEARLY_EMPTY_STROKES, NotebookMapCache, openItems,
} from "../src/model/notebook-map";
import type { MarkerElement, Page, Stroke, TextElement } from "../src/model/types";

const stroke = (hidden = false): Stroke => ({ id: createId(), tool: "pen", color: "#000", width: 2, render: 1, points: [[0, 0, 0.5], [5, 5, 0.5]], ...(hidden ? { hidden: true as const } : {}) });
const marker = (kind: MarkerElement["kind"], extra: Partial<MarkerElement> = {}): MarkerElement => ({ id: createId(), type: "marker", kind, x: 10, y: 10, ...extra });
const inked = (n = NEARLY_EMPTY_STROKES + 2): Page => {
	const p = createPage();
	p.strokes = Array.from({ length: n }, () => stroke());
	return p;
};
const header = (text: string): TextElement => ({ id: createId(), type: "text", x: 20, y: 20, width: 200, text, fontSize: 16, color: "#000" });

describe("notebook map", () => {
	it("a written page with nothing open is clear", () => {
		expect(mapPage(inked(), 0).states).toEqual([]);
	});

	it("counts only open questions, gaps and homework; resolved ones are not states", () => {
		const p = inked();
		p.elements = [marker("question", { text: "Why?" }), marker("question", { done: true }), marker("gap"), marker("homework", { due: "2026-11-05" }), marker("homework", { due: "2026-11-02" })];
		const m = mapPage(p, 3);
		expect(m.states).toEqual(["question", "gap", "homework"]);
		expect(m.open).toMatchObject({ question: 1, gap: 1, homework: 2 });
		expect(m.due).toBe("2026-11-02");
		expect(m.hint).toBe("Why?");
		expect(m.index).toBe(3);
	});

	it("importance markers make a key-point page, never resolved", () => {
		const p = inked();
		p.elements = [marker("star"), marker("important")];
		expect(mapPage(p, 0)).toMatchObject({ states: ["key"], open: { key: 2 } });
	});

	it("a page with few strokes and nothing else is nearly empty; hidden ink does not count", () => {
		const p = createPage();
		p.strokes = [stroke(), stroke(), stroke(true)];
		expect(isNearlyEmpty(p)).toBe(true);
		p.strokes = Array.from({ length: NEARLY_EMPTY_STROKES + 1 }, () => stroke());
		expect(isNearlyEmpty(p)).toBe(false);
		p.strokes = Array.from({ length: NEARLY_EMPTY_STROKES + 5 }, () => stroke(true));
		expect(isNearlyEmpty(p)).toBe(true);
	});

	it("text, a background or any non-marker element make a page non-empty; a marker alone does not", () => {
		const text = createPage();
		text.elements = [header("hello")];
		expect(isNearlyEmpty(text)).toBe(false);
		const bg = createPage();
		bg.background = { kind: "pdf", asset: "a", page: 1 };
		expect(isNearlyEmpty(bg)).toBe(false);
		const only = createPage();
		only.elements = [marker("question")];
		expect(mapPage(only, 0).states).toEqual(["question", "empty"]);
	});

	it("practice: unfinished until written, or until the device says it is done", () => {
		const blank = createPage();
		blank.tags = ["practice", "attempt/1"];
		expect(mapPage(blank, 0).states).toEqual(["practice"]);
		const written = inked();
		written.tags = ["practice", "attempt/1"];
		expect(mapPage(written, 0).states).toEqual([]);
		expect(mapPage(written, 0, { practiceDone: new Set() }).states).toEqual(["practice"]);
		expect(mapPage(written, 0, { practiceDone: new Set([written.id]) }).states).toEqual([]);
	});

	it("counts per state and filters", () => {
		const a = inked();
		a.elements = [marker("question")];
		const b = inked();
		b.elements = [marker("question"), marker("gap")];
		const c = createPage();
		const d = inked();
		const pages = [a, b, c, d].map((p, i) => mapPage(p, i));
		const counts = countStates(pages);
		expect(counts.pages).toMatchObject({ question: 2, gap: 1, empty: 1, homework: 0 });
		expect(counts.clear).toBe(1);
		expect(counts.total).toBe(4);
		expect(filterByState(pages, "question").map((p) => p.index)).toEqual([0, 1]);
		expect(filterByState(pages, null)).toHaveLength(4);
		expect(openItems(pages)).toBe(3);
	});

	it("marks lecture starts and narrows the map to one lecture", () => {
		const p0 = inked();
		p0.elements = [header("Calculus — 2026-10-29"), marker("question")];
		const p1 = inked();
		p1.elements = [marker("gap")];
		const p2 = inked();
		p2.elements = [header("Calculus — 2026-10-30"), marker("homework")];
		const pages = [p0, p1, p2];
		const cache = new NotebookMapCache();
		const map = cache.build(pages);
		expect(map.pages.map((p) => p.lectureStart)).toEqual([true, false, true]);
		expect(openItems(mapLecture(map, pages, 1))).toBe(2);
		expect(openItems(mapLecture(map, pages, 2))).toBe(1);
	});

	it("the cache recomputes only the pages whose revision changed", () => {
		const pages = [inked(), inked(), inked()];
		const cache = new NotebookMapCache();
		cache.build(pages);
		expect(cache.computed).toBe(3);
		cache.build(pages);
		expect(cache.computed).toBe(3);
		pages[1]!.elements = [marker("question")];
		const map = cache.build(pages);
		expect(cache.computed).toBe(4);
		expect(map.pages[1]!.states).toEqual(["question"]);
		// resolving it changes the key as well
		(pages[1]!.elements[0] as MarkerElement).done = true;
		expect(cache.build(pages).pages[1]!.states).toEqual([]);
		expect(cache.computed).toBe(5);
	});

	it("moving a page refreshes its index without recomputing; deleted pages leave the cache", () => {
		const [a, b, c] = [inked(), inked(), inked()];
		b.elements = [marker("gap")];
		const cache = new NotebookMapCache();
		cache.build([a, b, c]);
		const before = cache.computed;
		const moved = cache.build([b, a]);
		expect(cache.computed).toBe(before);
		expect(moved.pages.map((p) => p.pageId)).toEqual([b.id, a.id]);
		expect(moved.pages[0]!.index).toBe(0);
		expect(moved.pages[0]!.states).toEqual(["gap"]);
	});
});
