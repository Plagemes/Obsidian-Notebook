import { describe, expect, it } from "vitest";
import { needsNextPage } from "../src/ink/auto-page";
import { cutOutsidePolygon, eraseAreaCommand } from "../src/ink/erase-area";
import { filterErasable, isEraseFilterKind, strokeMatchesFilter, type EraseFilter } from "../src/ink/erase-filter";
import { analyseSpace, planSpaceChange, spacePreview } from "../src/ink/space";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { pageContentCommand } from "../src/model/page-content";
import { freezeStroke, serializeChecked } from "../src/model/serialize";
import type { ImageElement, NotebookDocument, Point, Stroke, TextElement } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { line } from "./helpers";

const square = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function ink(tool: "pen" | "highlighter" | "shape", color: string, points: Point[], width = 2): Stroke {
	return freezeStroke(createStroke(color, width, points, tool));
}

function hline(y: number, x0 = 50, x1 = 200, color = "#1e1e1e"): Stroke {
	return freezeStroke({ ...line(x0, y, x1, y, 8), color });
}

describe("selective eraser filter", () => {
	const pen = ink("pen", "#1d4ed8", [[0, 0, 0.5], [10, 0, 0.5]]);
	const marker = ink("highlighter", "#facc15", [[0, 5, 0.5], [10, 5, 0.5]], 14);
	const shape = ink("shape", "#1d4ed8", [[0, 9, 0.5], [10, 9, 0.5]]);
	const red = ink("pen", "#DC2626", [[0, 12, 0.5], [10, 12, 0.5]]);
	const all = [pen, marker, shape, red];
	const f = (kind: EraseFilter["kind"], color = "#1d4ed8"): EraseFilter => ({ kind, color });

	it("lets everything through by default and returns the same array", () => {
		expect(filterErasable(all, f("all"))).toBe(all);
	});

	it("highlighter only", () => {
		expect(filterErasable(all, f("highlighter"))).toEqual([marker]);
	});

	it("pen only means everything that is not a highlighter (shapes included)", () => {
		expect(filterErasable(all, f("pen"))).toEqual([pen, shape, red]);
	});

	it("one colour, any tool, case-insensitively", () => {
		expect(filterErasable(all, f("color", "#1D4ED8"))).toEqual([pen, shape]);
		expect(strokeMatchesFilter(red, f("color", "#dc2626"))).toBe(true);
		expect(strokeMatchesFilter(marker, f("color", "#1d4ed8"))).toBe(false);
	});

	it("validates a persisted kind", () => {
		expect(isEraseFilterKind("color")).toBe(true);
		expect(isEraseFilterKind("everything")).toBe(false);
		expect(isEraseFilterKind(undefined)).toBe(false);
	});
});

describe("erase area: cutting a stroke", () => {
	it("returns null when the stroke is outside the outline", () => {
		expect(cutOutsidePolygon(line(0, 0, 50, 0), square(100, 100, 200, 200))).toBeNull();
		// Bounding boxes overlap, but no point of the stroke is inside.
		const l = ink("pen", "#000000", [[0, 0, 0.5], [0, 100, 0.5], [100, 100, 0.5]]);
		expect(cutOutsidePolygon(l, square(40, 20, 90, 80))).toBeNull();
	});

	it("removes a stroke that is entirely inside", () => {
		expect(cutOutsidePolygon(line(60, 60, 80, 60), square(0, 0, 100, 100))).toEqual([]);
	});

	it("keeps the parts outside and ends them on the outline", () => {
		const runs = cutOutsidePolygon(line(0, 50, 300, 50, 30), square(100, 0, 200, 100))!;
		expect(runs).toHaveLength(2);
		const [left, right] = runs as [Point[], Point[]];
		const lastLeft = left[left.length - 1]!;
		const firstRight = right[0]!;
		expect(lastLeft[0]).toBeGreaterThan(99);
		expect(lastLeft[0]).toBeLessThanOrEqual(100.01);
		expect(firstRight[0]).toBeGreaterThanOrEqual(199.99);
		expect(firstRight[0]).toBeLessThan(201);
		expect(left.every((p) => p[0] <= 100.01)).toBe(true);
		expect(right.every((p) => p[0] >= 199.99)).toBe(true);
	});

	it("cuts a stroke with only two far-apart points where it crosses the outline", () => {
		const runs = cutOutsidePolygon(ink("pen", "#000000", [[0, 50, 0.5], [300, 50, 0.5]]), square(100, 0, 200, 100))!;
		expect(runs).toHaveLength(2);
	});

	it("treats a dot as inside or outside", () => {
		const dot = ink("pen", "#000000", [[10, 10, 0.5]]);
		expect(cutOutsidePolygon(dot, square(0, 0, 20, 20))).toEqual([]);
		expect(cutOutsidePolygon(dot, square(50, 50, 60, 60))).toBeNull();
	});

	it("needs a real polygon", () => {
		expect(cutOutsidePolygon(line(0, 0, 10, 10), [[0, 0], [10, 10]])).toBeNull();
	});
});

describe("erase area: one undo step", () => {
	function pageWith(strokes: Stroke[]) {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		doc.pages[0]!.strokes.push(...strokes);
		return { doc, page: doc.pages[0]!, history: new History(() => doc) };
	}
	const all: EraseFilter = { kind: "all", color: "#000000" };
	const seq = () => {
		let n = 0;
		return () => `piece-${++n}`;
	};

	it("erases what is inside, cuts what crosses, keeps the rest, and undoes in one step", () => {
		const inside = hline(50, 120, 180);
		const crossing = hline(60, 0, 300);
		const outside = hline(400);
		const original = [outside, inside, crossing];
		const { doc, page, history } = pageWith([...original]);
		const cmd = eraseAreaCommand(page, square(100, 0, 200, 100), { filter: all, includeElements: false, newId: seq() })!;
		history.execute(cmd);
		expect(page.strokes[0]).toBe(outside);
		expect(page.strokes).toHaveLength(3);
		expect(page.strokes.slice(1).map((s) => s.id)).toEqual(["piece-1", "piece-2"]);
		expect(serializeChecked(doc)).toBeTruthy();
		history.undo();
		expect(page.strokes.length).toBe(3);
		expect(page.strokes.every((s, i) => s === original[i])).toBe(true);
		expect(history.canUndo()).toBe(false);
		history.redo();
		expect(page.strokes).toHaveLength(3);
		expect(page.strokes.slice(1).map((s) => s.id)).toEqual(["piece-1", "piece-2"]);
	});

	it("respects the selective filter: only the matching ink goes", () => {
		const pen = hline(30, 120, 180);
		const marker = freezeStroke({ ...hline(60, 120, 180), tool: "highlighter" });
		const { page, history } = pageWith([pen, marker]);
		history.execute(eraseAreaCommand(page, square(100, 0, 200, 100), { filter: { kind: "highlighter", color: "" }, includeElements: false })!);
		expect(page.strokes).toEqual([pen]);
		history.undo();
		expect(page.strokes).toEqual([pen, marker]);
	});

	it("returns null when nothing is inside", () => {
		const { page } = pageWith([hline(400)]);
		expect(eraseAreaCommand(page, square(100, 0, 200, 100), { filter: all, includeElements: true })).toBeNull();
	});

	it("removes elements inside only when asked, and not with a selective filter", () => {
		const text: TextElement = { id: "t1", type: "text", x: 120, y: 20, width: 40, text: "hi", fontSize: 10, color: "#000000" };
		const img: ImageElement = { id: "i1", type: "image", asset: "ab", x: 400, y: 400, width: 50, height: 50, rotation: 0 };
		const { page, history } = pageWith([hline(50, 120, 180)]);
		page.elements = [text, img];
		const poly = square(100, 0, 200, 100);
		history.execute(eraseAreaCommand(page, poly, { filter: { kind: "pen", color: "" }, includeElements: true })!);
		expect(page.elements).toEqual([text, img]);
		expect(page.strokes).toHaveLength(0);
		history.undo();
		history.execute(eraseAreaCommand(page, poly, { filter: all, includeElements: false })!);
		expect(page.elements).toEqual([text, img]);
		history.undo();
		history.execute(eraseAreaCommand(page, poly, { filter: all, includeElements: true })!);
		expect(page.elements).toEqual([img]);
		expect(page.strokes).toHaveLength(0);
		history.undo();
		expect(page.elements).toEqual([text, img]);
		expect(page.strokes).toHaveLength(1);
	});

	it("an area with only an element in it is still one step", () => {
		const text: TextElement = { id: "t1", type: "text", x: 120, y: 20, width: 40, text: "hi", fontSize: 10, color: "#000000" };
		const { page, history } = pageWith([]);
		page.elements = [text];
		history.execute(eraseAreaCommand(page, square(100, 0, 200, 100), { filter: all, includeElements: true })!);
		expect(page.elements).toEqual([]);
		history.undo();
		expect(page.elements).toEqual([text]);
	});
});

describe("insert or remove space", () => {
	function doc3(): NotebookDocument {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 400, height: 600 });
		doc.pages.push(createPage({ width: 400, height: 600 }), createPage({ width: 400, height: 600 }));
		return doc;
	}
	const ys = (strokes: readonly Stroke[]) => strokes.map((s) => Math.round(s.points[0]![1]));
	const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

	function apply(doc: NotebookDocument, pageIndex: number, y: number, delta: number) {
		const plan = planSpaceChange(doc.pages, pageIndex, y, delta);
		if (!plan) return null;
		const history = new History(() => doc);
		history.execute(pageContentCommand(doc, plan, "Insert space"));
		return { plan, history };
	}

	it("moves what is below the line down on the same page and leaves what is above", () => {
		const doc = doc3();
		const p = doc.pages[0]!;
		const a = hline(100), b = hline(200), c = hline(300);
		p.strokes.push(a, b, c);
		const r = apply(doc, 0, 150, 80)!;
		expect(r.plan.appended).toHaveLength(0);
		expect(ys(p.strokes)).toEqual([100, 280, 380]);
		expect(p.strokes[0]).toBe(a);
		expect(p.strokes[1]!.id).toBe(b.id);
		expect(serializeChecked(doc)).toBeTruthy();
		r.history.undo();
		expect(p.strokes[0]).toBe(a);
		expect(p.strokes[1]).toBe(b);
		expect(p.strokes[2]).toBe(c);
		r.history.redo();
		expect(ys(p.strokes)).toEqual([100, 280, 380]);
	});

	it("continues on the next page what no longer fits, pushing that page's own content down", () => {
		const doc = doc3();
		const p0 = doc.pages[0]!, p1 = doc.pages[1]!;
		const a = hline(100), low = hline(500), n = hline(50);
		p0.strokes.push(a, low);
		p1.strokes.push(n);
		const r = apply(doc, 0, 150, 200)!;
		expect(ys(p0.strokes)).toEqual([100]);
		// 500 + 200 = 700 > 600: 100 pt into the next page; the old first line of page 2 moved 200 down.
		expect(sorted(ys(p1.strokes))).toEqual([100, 250]);
		expect(doc.pages).toHaveLength(3);
		r.history.undo();
		expect(p0.strokes[1]).toBe(low);
		expect(p1.strokes[0]).toBe(n);
		expect(p1.strokes).toHaveLength(1);
	});

	it("creates the missing page, with the size and paper of the last one, and removes it on undo", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 400, height: 600 }, { kind: "ruled", spacing: 22.67 });
		const p = doc.pages[0]!;
		const low = hline(550);
		p.strokes.push(hline(100), low);
		const r = apply(doc, 0, 300, 100)!;
		expect(r.plan.appended).toHaveLength(1);
		expect(doc.pages).toHaveLength(2);
		const added = doc.pages[1]!;
		expect(added.width).toBe(400);
		expect(added.height).toBe(600);
		expect(added.paper.kind).toBe("ruled");
		expect(ys(added.strokes)).toEqual([50]);
		expect(serializeChecked(doc)).toBeTruthy();
		r.history.undo();
		expect(doc.pages).toHaveLength(1);
		expect(p.strokes[1]).toBe(low);
		r.history.redo();
		expect(doc.pages).toHaveLength(2);
		expect(ys(doc.pages[1]!.strokes)).toEqual([50]);
	});

	it("removes space but never more than the empty gap, so ink does not overlap", () => {
		const doc = doc3();
		const p0 = doc.pages[0]!, p1 = doc.pages[1]!;
		const a = hline(100), b = hline(300), c = hline(560);
		p0.strokes.push(a, b);
		p1.strokes.push(c);
		const r = apply(doc, 0, 150, -500)!;
		// Gap = top of what moves (299) - bottom of what stays (101).
		expect(r.plan.delta).toBeCloseTo(-198, 1);
		expect(p0.strokes.find((s) => s.id === b.id)!.points[0]![1]).toBeCloseTo(102, 1);
		// The next page's content moves up by the same amount.
		expect(p1.strokes[0]!.points[0]![1]).toBeCloseTo(560 - 198, 1);
		r.history.undo();
		expect(p0.strokes[0]).toBe(a);
		expect(p0.strokes[1]).toBe(b);
		expect(p1.strokes[0]).toBe(c);
	});

	it("content of a later page can come back to the page where the space was removed", () => {
		const doc = doc3();
		const p0 = doc.pages[0]!, p1 = doc.pages[1]!;
		p0.strokes.push(hline(100));
		const c = hline(30);
		p1.strokes.push(c);
		const r = apply(doc, 0, 200, -300)!;
		expect(r.plan.delta).toBe(-300);
		expect(sorted(ys(p0.strokes))).toEqual([100, 330]);
		expect(p1.strokes).toHaveLength(0);
		r.history.undo();
		expect(p1.strokes[0]).toBe(c);
		expect(p0.strokes).toHaveLength(1);
	});

	it("insert then remove the same amount restores the positions", () => {
		const doc = doc3();
		const p0 = doc.pages[0]!, p1 = doc.pages[1]!;
		p0.strokes.push(hline(100), hline(400), hline(550));
		p1.strokes.push(hline(40), hline(300));
		const before = doc.pages.map((p) => ys(p.strokes));
		apply(doc, 0, 250, 200);
		expect(doc.pages.length).toBeGreaterThanOrEqual(2);
		apply(doc, 0, 250, -200);
		expect(doc.pages.slice(0, 2).map((p) => sorted(ys(p.strokes)))).toEqual(before.slice(0, 2).map(sorted));
		expect(doc.pages.slice(2).every((p) => p.strokes.length === 0)).toBe(true);
	});

	it("does nothing when there is nothing below the line, no room to remove, or a tiny change", () => {
		const doc = doc3();
		doc.pages[0]!.strokes.push(hline(100));
		expect(planSpaceChange(doc.pages, 0, 300, 50)).toBeNull();
		doc.pages[0]!.strokes.push(hline(102, 50, 200));
		expect(planSpaceChange(doc.pages, 0, 101, -50)).toBeNull();
		expect(planSpaceChange(doc.pages, 0, 101, 0.1)).toBeNull();
		expect(planSpaceChange(doc.pages, 5, 125, 50)).toBeNull();
		expect(planSpaceChange(doc.pages, 0, Number.NaN, 50)).toBeNull();
	});

	it("moves text boxes and images with the ink, keeps their ids and order", () => {
		const doc = doc3();
		const p = doc.pages[0]!;
		const text: TextElement = { id: "t", type: "text", x: 40, y: 400, width: 100, text: "x", fontSize: 12, color: "#000000" };
		const img: ImageElement = { id: "i", type: "image", asset: "ab", x: 40, y: 50, width: 40, height: 40, rotation: 0 };
		p.elements = [text, img];
		p.strokes.push(hline(100), hline(500));
		const r = apply(doc, 0, 200, 60)!;
		const t = p.elements.find((e) => e.id === "t")!;
		expect(t.type === "text" && t.y).toBe(460);
		expect(p.elements[1]).toBe(img);
		r.history.undo();
		expect(p.elements[0]).toBe(text);
		expect(p.elements[1]).toBe(img);
	});

	it("an element pushed onto the next page leaves its page without elements; undo restores both", () => {
		const doc = doc3();
		const p = doc.pages[0]!;
		const text: TextElement = { id: "t", type: "text", x: 40, y: 400, width: 100, text: "x", fontSize: 12, color: "#000000" };
		p.elements = [text];
		p.strokes.push(hline(100));
		const r = apply(doc, 0, 200, 300)!;
		expect(p.elements).toBeUndefined();
		expect(doc.pages[1]!.elements).toHaveLength(1);
		expect(serializeChecked(doc)).toBeTruthy();
		r.history.undo();
		expect(p.elements[0]).toBe(text);
		expect(doc.pages[1]!.elements).toBeUndefined();
	});

	it("an infinite page grows instead of overflowing, and the pages after it stay put", () => {
		const doc = doc3();
		const p = doc.pages[0]!;
		p.infinite = true;
		p.strokes.push(hline(100), hline(560));
		const later = hline(30);
		doc.pages[1]!.strokes.push(later);
		const r = apply(doc, 0, 200, 300)!;
		expect(r.plan.appended).toHaveLength(0);
		expect(p.height).toBeGreaterThan(600);
		expect(ys(p.strokes)).toEqual([100, 860]);
		expect(doc.pages[1]!.strokes[0]).toBe(later);
		r.history.undo();
		expect(p.height).toBe(600);
		expect(ys(p.strokes)).toEqual([100, 560]);
	});

	it("keeps the document valid and every stroke exactly once after a long cascade", () => {
		const doc = doc3();
		for (const [i, page] of doc.pages.entries()) page.strokes.push(hline(100 + i), hline(580));
		const idsBefore = doc.pages.flatMap((pg) => pg.strokes.map((s) => s.id)).sort();
		const r = apply(doc, 0, 50, 590)!;
		expect(doc.pages).toHaveLength(4);
		expect(doc.pages.flatMap((pg) => pg.strokes.map((s) => s.id)).sort()).toEqual(idsBefore);
		expect(serializeChecked(doc)).toBeTruthy();
		r.history.undo();
		expect(doc.pages).toHaveLength(3);
		expect(doc.pages.flatMap((pg) => pg.strokes.map((s) => s.id)).sort()).toEqual(idsBefore);
	});

	it("keeps x and quantisation when moving", () => {
		const doc = doc3();
		doc.pages[0]!.strokes.push(ink("pen", "#000000", [quantizePoint(10.5, 300, 0.4), quantizePoint(90.25, 310.5, 0.6)]));
		apply(doc, 0, 100, 40);
		const moved = doc.pages[0]!.strokes[0]!;
		expect(moved.points.map((p) => p[0])).toEqual([10.5, 90.25]);
		expect(moved.points.map((p) => p[1])).toEqual([340, 350.5]);
	});
});

describe("insert or remove space with PDF or image pages", () => {
	const bg = { kind: "pdf", asset: "ab", page: 1 } as const;
	function docWith(...backgrounds: boolean[]): NotebookDocument {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 400, height: 600 });
		doc.pages = backgrounds.map((b) => {
			const p = createPage({ width: 400, height: 600 });
			if (b) p.background = bg;
			return p;
		});
		return doc;
	}
	const ys = (strokes: readonly Stroke[]) => strokes.map((s) => Math.round(s.points[0]![1]));
	function apply(doc: NotebookDocument, pageIndex: number, y: number, delta: number) {
		const plan = planSpaceChange(doc.pages, pageIndex, y, delta);
		if (!plan) return null;
		const history = new History(() => doc);
		history.execute(pageContentCommand(doc, plan, "space"));
		return { plan, history };
	}

	it("removing never pulls content onto an earlier page when the later page has a background", () => {
		const doc = docWith(false, true);
		const c = hline(40);
		doc.pages[0]!.strokes.push(hline(100));
		doc.pages[1]!.strokes.push(c);
		expect(planSpaceChange(doc.pages, 0, 200, -300)).toBeNull();
		expect(doc.pages[1]!.strokes[0]).toBe(c);
	});

	it("removing never pulls content onto an earlier page when the earlier page has a background", () => {
		const doc = docWith(true, false);
		const c = hline(40);
		doc.pages[0]!.strokes.push(hline(100));
		doc.pages[1]!.strokes.push(c);
		expect(planSpaceChange(doc.pages, 0, 200, -300)).toBeNull();
		expect(doc.pages[1]!.strokes[0]).toBe(c);
	});

	it("removing on a plain page leaves the background page after it alone, but still works within the page", () => {
		const doc = docWith(false, true);
		const b = hline(300);
		const slide = hline(30);
		doc.pages[0]!.strokes.push(hline(100), b);
		doc.pages[1]!.strokes.push(slide);
		const r = apply(doc, 0, 150, -500)!;
		expect(r.plan.delta).toBeCloseTo(-198, 1);
		expect(doc.pages[1]!.strokes[0]).toBe(slide);
		expect(doc.pages).toHaveLength(2);
	});

	it("removing on a background page moves only that page's own ink", () => {
		const doc = docWith(true, false);
		const slide = hline(30);
		doc.pages[0]!.strokes.push(hline(100), hline(300));
		doc.pages[1]!.strokes.push(slide);
		apply(doc, 0, 150, -500);
		expect(doc.pages[1]!.strokes[0]).toBe(slide);
	});

	it("insert: overflow from a plain page does not land on the next background page; a blank page is inserted before it", () => {
		const doc = docWith(false, true);
		const slide = hline(50);
		doc.pages[0]!.strokes.push(hline(100), hline(500));
		doc.pages[1]!.strokes.push(slide);
		const r = apply(doc, 0, 150, 200)!;
		expect(doc.pages).toHaveLength(3);
		expect(doc.pages[2]!.background).toBeDefined();
		expect(doc.pages[2]!.strokes[0]).toBe(slide);
		const added = doc.pages[1]!;
		expect(added.background).toBeUndefined();
		expect(ys(added.strokes)).toEqual([100]);
		expect(serializeChecked(doc)).toBeTruthy();
		r.history.undo();
		expect(doc.pages).toHaveLength(2);
		expect(doc.pages[1]!.strokes[0]).toBe(slide);
		expect(ys(doc.pages[0]!.strokes)).toEqual([100, 500]);
	});

	it("insert: overflow from a background page goes to a new blank page right after it, not onto the next slide", () => {
		const doc = docWith(true, true);
		doc.pages[0]!.paper = { kind: "ruled", spacing: 22.67 };
		const next = hline(20);
		doc.pages[0]!.strokes.push(hline(100), hline(550));
		doc.pages[1]!.strokes.push(next);
		apply(doc, 0, 300, 100);
		expect(doc.pages).toHaveLength(3);
		expect(doc.pages[0]!.background).toBeDefined();
		expect(doc.pages[1]!.background).toBeUndefined();
		expect(doc.pages[1]!.paper.kind).toBe("ruled");
		expect(ys(doc.pages[1]!.strokes)).toEqual([50]);
		expect(doc.pages[2]!.strokes[0]).toBe(next);
		expect(ys(doc.pages[0]!.strokes)).toEqual([100]);
	});

	it("a plain cascade still runs through plain pages and stops before a background page", () => {
		const doc = docWith(false, false, true);
		const slide = hline(20);
		doc.pages[0]!.strokes.push(hline(550));
		doc.pages[1]!.strokes.push(hline(100), hline(570));
		doc.pages[2]!.strokes.push(slide);
		apply(doc, 0, 100, 100);
		expect(doc.pages).toHaveLength(4);
		expect(doc.pages[3]!.strokes[0]).toBe(slide);
		expect(doc.pages[3]!.background).toBeDefined();
		expect(doc.pages[2]!.background).toBeUndefined();
		expect(ys(doc.pages[2]!.strokes)).toEqual([70]);
	});
});

describe("space preview", () => {
	it("describes the same moves as the plan, with the clamped amount, grouped by page", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 400, height: 600 });
		doc.pages.push(createPage({ width: 400, height: 600 }));
		const a = hline(100), b = hline(300), low = hline(550), n = hline(40);
		doc.pages[0]!.strokes.push(a, b, low);
		doc.pages[1]!.strokes.push(n);
		const ins = analyseSpace(doc.pages, 0, 200, 100)!;
		const entries = spacePreview(ins);
		const flat = (pi: number) => entries.filter((e) => e.pageIndex === pi).flatMap((e) => e.strokes);
		expect(flat(0)).toEqual([b]);
		expect(flat(1)).toEqual([low, n]);
		expect(entries.find((e) => e.strokes.includes(b))!.dy).toBe(100);
		expect(entries.find((e) => e.strokes.includes(low))!.dy).toBe(100 - 600);
		const rem = analyseSpace(doc.pages, 0, 200, -900)!;
		expect(rem.delta).toBeGreaterThan(-300);
		expect(rem.delta).toBeLessThan(-190);
	});

	it("marks content that falls on a page that does not exist yet", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 400, height: 600 });
		doc.pages[0]!.strokes.push(hline(100), hline(550));
		const entries = spacePreview(analyseSpace(doc.pages, 0, 300, 100)!);
		expect(entries.some((e) => e.pageIndex === -1 && e.strokes.length === 1)).toBe(true);
	});

	it("is null when nothing would move", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 400, height: 600 });
		doc.pages[0]!.strokes.push(hline(100));
		expect(analyseSpace(doc.pages, 0, 300, 50)).toBeNull();
	});
});

describe("automatic next page", () => {
	const page = { height: 800 };
	it("triggers near the bottom of the last page when enabled", () => {
		expect(needsNextPage(page, true, 760, true)).toBe(true);
		expect(needsNextPage(page, true, 720, true)).toBe(true);
		expect(needsNextPage(page, true, 719, true)).toBe(false);
	});
	it("not when disabled, on an earlier page, on an infinite page or on a PDF/image page", () => {
		expect(needsNextPage(page, true, 790, false)).toBe(false);
		expect(needsNextPage(page, false, 790, true)).toBe(false);
		expect(needsNextPage({ ...page, infinite: true }, true, 790, true)).toBe(false);
		expect(needsNextPage({ ...page, background: { kind: "image", asset: "ab" } }, true, 790, true)).toBe(false);
	});
	it("ignores a non-finite position", () => {
		expect(needsNextPage(page, true, Number.NaN, true)).toBe(false);
	});
});

describe("settings for the ink tools", () => {
	it("auto next page is on by default, area erase leaves elements alone by default", () => {
		expect(DEFAULT_SETTINGS.autoNextPage).toBe(true);
		expect(DEFAULT_SETTINGS.eraseAreaElements).toBe(false);
	});
	it("reads and validates them", () => {
		expect(readSettings({ autoNextPage: false }).autoNextPage).toBe(false);
		expect(readSettings({ autoNextPage: "no" }).autoNextPage).toBe(true);
		expect(readSettings({ eraseAreaElements: true }).eraseAreaElements).toBe(true);
		expect(readSettings({ eraseAreaElements: 1 }).eraseAreaElements).toBe(false);
	});
});
