import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { clampOffset, planMoveToPage, targetPages } from "../src/model/selection-move";
import { makePart } from "../src/model/states";
import type { ImageElement, NotebookDocument, PageElement, TextElement } from "../src/model/types";
import { line, sampleDocument } from "./helpers";

function twoPages(strokes = 3): NotebookDocument {
	const doc = sampleDocument(strokes);
	doc.pages.push(createPage());
	return doc;
}

const text = (id: string, x = 100, y = 100): TextElement => ({ id, type: "text", x, y, width: 120, text: "hi", fontSize: 14, color: "#000000" });

describe("move a selection to another page", () => {
	it("moves strokes with the same ids as one undo step and puts them back", () => {
		const doc = twoPages();
		const [a, b, c] = doc.pages[0]!.strokes;
		const history = new History(() => doc);
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [a!, c!], elements: [], mode: "move" });
		if ("refused" in plan) throw new Error("refused");
		history.execute(plan.command);
		expect(doc.pages[0]!.strokes.map((s) => s.id)).toEqual([b!.id]);
		expect(doc.pages[1]!.strokes.map((s) => s.id)).toEqual([a!.id, c!.id]);
		expect(plan.strokes.every((s) => doc.pages[1]!.strokes.includes(s))).toBe(true);
		history.undo();
		expect(doc.pages[0]!.strokes.map((s) => s.id)).toEqual([a!.id, b!.id, c!.id]);
		expect(doc.pages[1]!.strokes).toEqual([]);
		history.redo();
		expect(doc.pages[1]!.strokes.map((s) => s.id)).toEqual([a!.id, c!.id]);
		expect(doc.pages[0]!.strokes.map((s) => s.id)).toEqual([b!.id]);
	});

	it("moves elements and keeps their ids", () => {
		const doc = twoPages(0);
		const t = text("t1");
		doc.pages[0]!.elements = [t];
		const history = new History(() => doc);
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [t], mode: "move" });
		if ("refused" in plan) throw new Error("refused");
		history.execute(plan.command);
		expect(doc.pages[0]!.elements).toEqual([]);
		expect(doc.pages[1]!.elements?.map((e) => e.id)).toEqual(["t1"]);
		history.undo();
		expect(doc.pages[0]!.elements?.map((e) => e.id)).toEqual(["t1"]);
		expect(doc.pages[1]!.elements ?? []).toEqual([]);
	});

	it("keeps the position when it fits and clamps it into a smaller page", () => {
		const doc = twoPages(0);
		const s = line(100, 50, 250, 60);
		doc.pages[0]!.strokes.push(s);
		doc.pages[1] = createPage({ width: 200, height: 200 });
		const keep = planMoveToPage({ doc, from: 0, to: 1, strokes: [s], elements: [], mode: "move" });
		if ("refused" in keep) throw new Error("refused");
		const xs = keep.strokes[0]!.points.map((p) => p[0]);
		expect(Math.max(...xs)).toBeLessThanOrEqual(200);
		expect(keep.dx).toBeLessThan(0);
		const exact = planMoveToPage({ doc, from: 0, to: 1, strokes: [s], elements: [], mode: "move", exact: true });
		if ("refused" in exact) throw new Error("refused");
		expect(exact.dx).toBe(0);
		expect(exact.strokes[0]).toBe(s);
		expect(clampOffset({ minX: -5, minY: 10, maxX: 20, maxY: 30 }, { width: 100, height: 100 })).toEqual([5, 0]);
	});

	it("keeps slide links valid (the table is notebook-wide)", () => {
		const doc = twoPages(0);
		doc.slides = [{ id: "sl1", source: "x.pdf", page: 2 }];
		const s = { ...line(10, 10, 40, 40), slide: "sl1" };
		doc.pages[0]!.strokes.push(s);
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [s], elements: [], mode: "move" });
		if ("refused" in plan) throw new Error("refused");
		new History(() => doc).execute(plan.command);
		expect(doc.pages[1]!.strokes[0]!.slide).toBe("sl1");
		expect(doc.slides).toHaveLength(1);
	});

	it("removes moved members from their part of a drawing with states, and undo restores the part", () => {
		const doc = twoPages();
		const page = doc.pages[0]!;
		const [a, b] = page.strokes;
		page.states = makePart(undefined, [a!, b!])!.states;
		const before = page.states;
		const history = new History(() => doc);
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [a!], elements: [], mode: "move" });
		if ("refused" in plan) throw new Error("refused");
		expect(plan.leftParts).toBe(1);
		history.execute(plan.command);
		expect(page.states?.parts[0]?.items).toEqual([b!.id]);
		expect(doc.pages[1]!.states).toBeUndefined();
		history.undo();
		expect(page.states).toBe(before);
		expect(page.states?.parts[0]?.items).toEqual([a!.id, b!.id]);
	});

	it("a part that loses every member goes away; ink outside any part reports none", () => {
		const doc = twoPages();
		const page = doc.pages[0]!;
		const [a, , c] = page.strokes;
		page.states = makePart(undefined, [a!])!.states;
		const one = planMoveToPage({ doc, from: 0, to: 1, strokes: [c!], elements: [], mode: "move" });
		if ("refused" in one) throw new Error("refused");
		expect(one.leftParts).toBe(0);
		const all = planMoveToPage({ doc, from: 0, to: 1, strokes: [a!], elements: [], mode: "move" });
		if ("refused" in all) throw new Error("refused");
		new History(() => doc).execute(all.command);
		expect(page.states?.parts ?? []).toEqual([]);
	});

	it("moves a graph together with its bound ink and refuses ink bound to a graph left behind", () => {
		const doc = twoPages(0);
		const page = doc.pages[0]!;
		const graph = { id: "g1", type: "graph", x: 20, y: 20, width: 100, height: 100, view: { xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, functions: [] } as unknown as PageElement;
		page.elements = [graph];
		const bound = { ...line(30, 30, 60, 60), id: "g1~a" };
		page.strokes.push(bound);
		const withGraph = planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [graph], mode: "move", exact: true });
		if ("refused" in withGraph) throw new Error("refused");
		expect(withGraph.strokes.map((s) => s.id)).toEqual(["g1~a"]);
		const alone = planMoveToPage({ doc, from: 0, to: 1, strokes: [bound], elements: [], mode: "move" });
		expect(alone).toEqual({ refused: "bound-ink" });
	});

	it("copies with new ids and leaves the source alone", () => {
		const doc = twoPages();
		const [a] = doc.pages[0]!.strokes;
		const t = text("t1");
		doc.pages[0]!.elements = [t];
		const history = new History(() => doc);
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [a!], elements: [t], mode: "copy" });
		if ("refused" in plan) throw new Error("refused");
		history.execute(plan.command);
		expect(doc.pages[0]!.strokes).toHaveLength(3);
		expect(doc.pages[1]!.strokes).toHaveLength(1);
		expect(doc.pages[1]!.strokes[0]!.id).not.toBe(a!.id);
		expect(doc.pages[1]!.elements?.[0]?.id).not.toBe("t1");
		history.undo();
		expect(doc.pages[1]!.strokes).toEqual([]);
		expect(doc.pages[1]!.elements ?? []).toEqual([]);
	});

	it("copies a picture and keeps its asset record", () => {
		const doc = twoPages(0);
		const img: ImageElement = { id: "i1", type: "image", asset: "as1", x: 10, y: 10, width: 50, height: 50, rotation: 0 };
		doc.pages[0]!.elements = [img];
		doc.assets = { as1: { id: "as1", path: "a.png", mime: "image/png", width: 5, height: 5 } as never };
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [img], mode: "copy" });
		if ("refused" in plan) throw new Error("refused");
		new History(() => doc).execute(plan.command);
		expect((doc.pages[1]!.elements?.[0] as ImageElement).asset).toBe("as1");
	});

	it("refuses the same page, a missing page and an empty or stale selection", () => {
		const doc = twoPages();
		const [a] = doc.pages[0]!.strokes;
		expect(planMoveToPage({ doc, from: 0, to: 0, strokes: [a!], elements: [], mode: "move" })).toEqual({ refused: "same-page" });
		expect(planMoveToPage({ doc, from: 0, to: 9, strokes: [a!], elements: [], mode: "move" })).toEqual({ refused: "missing-page" });
		expect(planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [], mode: "move" })).toEqual({ refused: "nothing" });
		expect(planMoveToPage({ doc, from: 1, to: 0, strokes: [a!], elements: [], mode: "move" })).toEqual({ refused: "nothing" });
		expect(targetPages(doc, 0)).toEqual([1]);
	});
});
