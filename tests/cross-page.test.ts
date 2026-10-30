import { describe, expect, it } from "vitest";
import {
	captureCrossPageClip, frameOffset, pagesTouchedBy, pageUnder, partMatrix, partsBounds, planCrossPageTransform, polygonInFrame, selectAcrossPages,
} from "../src/ink/cross-page";
import { layoutPages, PAGE_GAP } from "../src/ink/layout";
import { apply, translate } from "../src/ink/transform";
import { createDocument, createId, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { createEquation, createGraph } from "../src/model/math-elements";
import { serializeChecked } from "../src/model/serialize";
import type { NotebookDocument, TextElement } from "../src/model/types";
import { line } from "./helpers";

/** Two pages of 200 x 300 stacked with the usual gap: page 1 starts at y = 300 + PAGE_GAP. */
function twoPages(): { doc: NotebookDocument; boxes: ReturnType<typeof layoutPages>["boxes"] } {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 200, height: 300 });
	doc.pages.push(createPage({ width: 200, height: 300 }));
	return { doc, boxes: layoutPages(doc.pages).boxes };
}

const text = (x: number, y: number): TextElement => ({ id: createId(), type: "text", x, y, width: 80, text: "hi", fontSize: 14, color: "#000000" });

// A lasso that starts on page 0 and ends on page 1: the points are in page 0's frame, so page 1 is 300 + gap further down.
const lassoOverSeam = (): Array<[number, number]> => [[20, 250], [180, 250], [180, 300 + PAGE_GAP + 60], [20, 300 + PAGE_GAP + 60]];

describe("frames of adjacent pages", () => {
	it("offsets between boxes and polygons moved into another frame", () => {
		const { boxes } = twoPages();
		expect(frameOffset(boxes, 0, 1)).toEqual([0, 300 + PAGE_GAP]);
		expect(frameOffset(boxes, 1, 0)).toEqual([0, -(300 + PAGE_GAP)]);
		expect(frameOffset(boxes, 0, 7)).toEqual([0, 0]);
		const moved = polygonInFrame([[10, 340]], boxes, 0, 1);
		expect(moved).toEqual([[10, 340 - (300 + PAGE_GAP)]]);
	});

	it("finds the pages a lasso touches", () => {
		const { boxes } = twoPages();
		expect(pagesTouchedBy(boxes, [[20, 20], [100, 20], [100, 100]], 0)).toEqual([0]);
		expect(pagesTouchedBy(boxes, lassoOverSeam(), 0)).toEqual([0, 1]);
		// Only the gap between two pages: no page is touched.
		expect(pagesTouchedBy(boxes, [[10, 305], [20, 310], [30, 306]], 0)).toEqual([]);
		expect(pagesTouchedBy(boxes, [], 0)).toEqual([]);
		expect(pageUnder(boxes, 50, 310)).toBe(-1);
		expect(pageUnder(boxes, 50, 340)).toBe(1);
	});

	it("moves a matrix of the primary frame into another page's frame", () => {
		const q = partMatrix(translate(5, 7), 0, 324);
		// A pure translation is the same in every frame.
		expect(apply(q, 10, 10)).toEqual([15, 17]);
		// Scaling by 2 about the primary origin: a point at the origin of a page 324 below stays 324 below plus its own offset.
		const [x, y] = apply(partMatrix([2, 0, 0, 2, 0, 0], 0, 324), 10, 0);
		expect([x, y]).toEqual([20, 324]);
	});
});

describe("selecting across pages", () => {
	it("selects the ink and the boxes inside the lasso on both pages, the starting page first", () => {
		const { doc, boxes } = twoPages();
		const a = line(40, 260, 160, 270);
		const outside = line(40, 20, 160, 30);
		const b = line(40, 20, 160, 30);
		const e = text(30, 20);
		doc.pages[0]!.strokes.push(a, outside);
		doc.pages[1]!.strokes.push(b);
		doc.pages[1]!.elements = [e];
		const parts = selectAcrossPages({
			boxes, origin: 0, polygon: lassoOverSeam(), strokesOf: (i) => doc.pages[i]!.strokes, elementsOf: (i) => doc.pages[i]!.elements ?? [],
		});
		expect(parts.map((p) => p.pageIndex)).toEqual([0, 1]);
		expect(parts[0]!.strokes).toEqual([a]);
		expect(parts[1]!.strokes).toEqual([b]);
		expect(parts[1]!.elements).toEqual([e]);
	});

	it("puts the origin first only when it has something, and is empty when nothing is inside", () => {
		const { doc, boxes } = twoPages();
		doc.pages[1]!.strokes.push(line(40, 20, 160, 30));
		const input = { boxes, origin: 0, polygon: lassoOverSeam(), strokesOf: (i: number) => doc.pages[i]!.strokes, elementsOf: () => [] };
		expect(selectAcrossPages(input).map((p) => p.pageIndex)).toEqual([1]);
		doc.pages[1]!.strokes.length = 0;
		expect(selectAcrossPages(input)).toEqual([]);
	});

	it("gives the same result as the single page rule when the lasso stays on one page", () => {
		const { doc, boxes } = twoPages();
		const a = line(40, 100, 160, 110);
		doc.pages[0]!.strokes.push(a);
		const parts = selectAcrossPages({
			boxes, origin: 0, polygon: [[20, 80], [180, 80], [180, 140], [20, 140]], strokesOf: (i) => doc.pages[i]!.strokes, elementsOf: () => [],
		});
		expect(parts).toEqual([{ pageIndex: 0, strokes: [a], elements: [] }]);
	});

	it("bounds the parts in the primary frame", () => {
		const { doc, boxes } = twoPages();
		const a = line(40, 260, 160, 270);
		const b = line(40, 20, 160, 30);
		doc.pages[0]!.strokes.push(a);
		doc.pages[1]!.strokes.push(b);
		const parts = [{ pageIndex: 0, strokes: [a], elements: [] }, { pageIndex: 1, strokes: [b], elements: [] }];
		const bounds = partsBounds(boxes, parts, 0)!;
		expect(bounds.minY).toBeLessThan(262);
		expect(bounds.maxY).toBeGreaterThan(300 + PAGE_GAP + 20);
		// Seen from page 1 the same selection starts above the page.
		expect(partsBounds(boxes, parts, 1)!.minY).toBeLessThan(0);
		expect(partsBounds(boxes, [], 0)).toBeNull();
	});
});

describe("moving a cross-page selection", () => {
	function setup() {
		const { doc, boxes } = twoPages();
		const a = line(40, 260, 160, 270);
		const b = line(40, 20, 160, 30);
		const e = text(30, 20);
		doc.pages[0]!.strokes.push(a);
		doc.pages[1]!.strokes.push(b);
		doc.pages[1]!.elements = [e];
		const parts = [
			{ pageIndex: 0, strokes: [a], elements: [] },
			{ pageIndex: 1, strokes: [b], elements: [e] },
		];
		return { doc, boxes, a, b, e, parts };
	}

	it("keeps each item on its page for a small move and undoes it in one step", () => {
		const { doc, boxes, a, b, parts } = setup();
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix: translate(5, -10) })!;
		expect(plan.reparented).toBe(0);
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(doc.pages[0]!.strokes).toHaveLength(1);
		expect(doc.pages[1]!.strokes).toHaveLength(1);
		expect(doc.pages[0]!.strokes[0]!.points[0]![0]).toBeCloseTo(45, 1);
		expect(doc.pages[1]!.strokes[0]!.points[0]![1]).toBeCloseTo(10, 1);
		expect(doc.pages[1]!.elements![0]!.type).toBe("text");
		expect(plan.parts.map((p) => p.pageIndex)).toEqual([0, 1]);
		hist.undo();
		expect(doc.pages[0]!.strokes[0]).toBe(a);
		expect(doc.pages[1]!.strokes[0]).toBe(b);
		expect(hist.canUndo()).toBe(false);
		expect(() => serializeChecked(doc)).not.toThrow();
	});

	it("moves an item that ends under the other page onto it, in that page's coordinates, as one undo step", () => {
		const { doc, boxes, a, b, parts } = setup();
		// Down by one page: the stroke of page 0 ends on page 1, the items of page 1 end below every page (they stay).
		const dy = 300 + PAGE_GAP;
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix: translate(0, dy) })!;
		expect(plan.reparented).toBe(1);
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(doc.pages[0]!.strokes).toHaveLength(0);
		expect(doc.pages[1]!.strokes).toHaveLength(2);
		const arrived = doc.pages[1]!.strokes.find((s) => s.id === a.id)!;
		// It was at y 260..270 on page 0; one page down it is at the same place in page 1's own coordinates.
		expect(arrived.points[0]![1]).toBeCloseTo(260, 1);
		expect(arrived.points[0]![0]).toBeCloseTo(40, 1);
		expect(doc.pages[1]!.strokes.find((s) => s.id === b.id)!.points[0]![1]).toBeCloseTo(20 + dy, 1);
		expect(plan.parts.map((p) => [p.pageIndex, p.strokes.length])).toEqual([[1, 2]]);
		hist.undo();
		expect(doc.pages[0]!.strokes[0]).toBe(a);
		expect(doc.pages[1]!.strokes).toEqual([b]);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(doc.pages[0]!.strokes).toHaveLength(0);
		expect(doc.pages[1]!.strokes).toHaveLength(2);
		expect(() => serializeChecked(doc)).not.toThrow();
	});

	it("re-parents text boxes too and keeps ids", () => {
		const { doc, boxes, e } = setup();
		const dy = -(300 + PAGE_GAP);
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts: [{ pageIndex: 1, strokes: [], elements: [e] }], matrix: translate(0, dy) })!;
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(doc.pages[1]!.elements ?? []).toHaveLength(0);
		expect(doc.pages[0]!.elements).toHaveLength(1);
		expect(doc.pages[0]!.elements![0]!.id).toBe(e.id);
		expect((doc.pages[0]!.elements![0] as TextElement).y).toBeCloseTo(20, 1);
		hist.undo();
		expect(doc.pages[1]!.elements).toEqual([e]);
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
	});

	it("skips items that are no longer on their page and returns null when nothing is left", () => {
		const { doc, boxes, parts } = setup();
		doc.pages[0]!.strokes.length = 0;
		expect(planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts: [parts[0]!], matrix: translate(1, 1) })).toBeNull();
	});

	it("restores several removals of one page in their original order on undo", () => {
		const { doc, boxes } = setup();
		const s1 = line(40, 250, 160, 255);
		const s2 = line(40, 270, 160, 275);
		const s3 = line(40, 290, 160, 295);
		doc.pages[0]!.strokes = [s1, s2, s3];
		const plan = planCrossPageTransform({
			boxes, pages: doc.pages, primary: 0, parts: [{ pageIndex: 0, strokes: [s1, s3], elements: [] }], matrix: translate(0, 300 + PAGE_GAP),
		})!;
		expect(plan.reparented).toBe(2);
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(doc.pages[0]!.strokes).toEqual([s2]);
		hist.undo();
		expect(doc.pages[0]!.strokes).toEqual([s1, s2, s3]);
	});
});

describe("copying a cross-page selection", () => {
	it("puts every item in the primary frame so that it pastes as one piece", () => {
		const { doc, boxes } = twoPages();
		const a = line(40, 260, 160, 270);
		const b = line(40, 20, 160, 30);
		doc.pages[0]!.strokes.push(a);
		doc.pages[1]!.strokes.push(b);
		const parts = [{ pageIndex: 0, strokes: [a], elements: [] }, { pageIndex: 1, strokes: [b], elements: [] }];
		const clip = captureCrossPageClip(boxes, doc.pages, parts, 0, undefined)!;
		expect(clip.strokes).toHaveLength(2);
		expect(clip.bounds.maxY).toBeGreaterThan(300 + PAGE_GAP + 20);
		expect(clip.strokes[1]!.points[0]![1]).toBeCloseTo(20 + 300 + PAGE_GAP, 1);
		// Items that left their page are not copied; nothing left: no clip.
		doc.pages[0]!.strokes.length = 0;
		doc.pages[1]!.strokes.length = 0;
		expect(captureCrossPageClip(boxes, doc.pages, parts, 0, undefined)).toBeNull();
	});
});

describe("cross-page selection with equations and graphs", () => {
	it("moves an equation and a graph (with its bound ink) to the page under them and keeps the document valid", () => {
		const { doc, boxes } = twoPages();
		const eq = createEquation(30, 250, "x^2", 14, "#000000", { width: 40, height: 16 });
		const graph = createGraph(20, 200, 120, 80);
		const ink = { ...line(40, 220, 100, 260), id: `${graph.id}~${createId()}` };
		doc.pages[0]!.elements = [eq, graph];
		doc.pages[0]!.strokes.push(ink);
		const parts = [{ pageIndex: 0, strokes: [ink], elements: [eq, graph] }];
		// Down by one page: everything ends up on page 1, the ids (and the binding of the ink) are kept.
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix: translate(0, 300 + PAGE_GAP) })!;
		expect(plan.reparented).toBe(3);
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(doc.pages[0]!.elements).toEqual([]);
		expect(doc.pages[1]!.elements!.map((e) => e.type).sort()).toEqual(["equation", "graph"]);
		expect(doc.pages[1]!.strokes[0]!.id).toBe(ink.id);
		expect(serializeChecked(doc, true).ok).toBe(true);
		hist.undo();
		expect(doc.pages[0]!.elements).toHaveLength(2);
		expect(doc.pages[1]!.elements ?? []).toHaveLength(0);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("selects them with a lasso over the seam and copies them as one clip", () => {
		const { doc, boxes } = twoPages();
		const eq = createEquation(30, 270, "y", 14, "#000000", { width: 30, height: 16 });
		const graph = createGraph(20, 10, 120, 80);
		doc.pages[0]!.elements = [eq];
		doc.pages[1]!.elements = [graph];
		const parts = selectAcrossPages({
			boxes, origin: 0, polygon: [[10, 250], [190, 250], [190, 300 + PAGE_GAP + 100], [10, 300 + PAGE_GAP + 100]],
			strokesOf: (i) => doc.pages[i]!.strokes, elementsOf: (i) => doc.pages[i]!.elements ?? [],
		});
		expect(parts.map((p) => p.elements.map((e) => e.type))).toEqual([["equation"], ["graph"]]);
		const clip = captureCrossPageClip(boxes, doc.pages, parts, 0, doc.assets)!;
		expect(clip.elements.map((e) => e.type).sort()).toEqual(["equation", "graph"]);
		expect(clip.elements.find((e) => e.type === "graph")).toMatchObject({ y: 10 + 300 + PAGE_GAP });
	});
});
