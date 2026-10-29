import { describe, expect, it } from "vitest";
import { createPage, createStroke } from "../src/model/document";
import { rulerFromTwoTouches } from "../src/ink/ruler";
import { estimateMeasure } from "../src/ink/text-layout";
import { A4_HEIGHT, A4_WIDTH, DEFAULT_META, type ImageElement, type TextElement } from "../src/model/types";
import {
	centredPosition, fitInside, imageElementSize, imagePageSize, mergeMeta, metaEquals, newTextBox, pageSignature, parsePageRange,
	shapePoints, shouldGrabRuler, toggleBookmark, unionBounds,
} from "../src/view/view-helpers";

describe("parsePageRange", () => {
	it("accepts whole numbers inside the document with from <= to", () => {
		expect(parsePageRange("2", "5", 10)).toEqual({ from: 2, to: 5 });
		expect(parsePageRange(" 3 ", 3, 3)).toEqual({ from: 3, to: 3 });
	});
	it("rejects everything else", () => {
		expect(parsePageRange("0", "2", 10)).toBeNull();
		expect(parsePageRange("5", "2", 10)).toBeNull();
		expect(parsePageRange("1", "11", 10)).toBeNull();
		expect(parsePageRange("a", "2", 10)).toBeNull();
		expect(parsePageRange("1.5", "2", 10)).toBeNull();
		expect(parsePageRange("", "", 10)).toBeNull();
		expect(parsePageRange("-1", "2", 10)).toBeNull();
	});
});

describe("image sizes", () => {
	it("fitInside keeps the aspect ratio and can avoid enlarging", () => {
		expect(fitInside(200, 100, 100, 100)).toEqual({ width: 100, height: 50 });
		expect(fitInside(50, 25, 100, 100)).toEqual({ width: 100, height: 50 });
		expect(fitInside(50, 25, 100, 100, false)).toEqual({ width: 50, height: 25 });
	});

	it("an image page is A4 portrait or landscape by aspect, with the image's proportions", () => {
		const portrait = imagePageSize(3000, 4000);
		expect(portrait.height).toBeGreaterThan(portrait.width);
		expect(portrait.width).toBeLessThanOrEqual(A4_WIDTH + 0.01);
		expect(portrait.height).toBeLessThanOrEqual(A4_HEIGHT + 0.01);
		expect(portrait.width / portrait.height).toBeCloseTo(0.75, 2);
		const landscape = imagePageSize(4000, 3000);
		expect(landscape.width).toBeGreaterThan(landscape.height);
		expect(landscape.width).toBeLessThanOrEqual(A4_HEIGHT + 0.01);
		expect(landscape.width / landscape.height).toBeCloseTo(4 / 3, 2);
		const a4 = imagePageSize(2100, 2970);
		expect(a4.width).toBeCloseTo(A4_WIDTH, 0);
		expect(a4.height).toBeCloseTo(A4_HEIGHT, 0);
		expect(imagePageSize(0, 0)).toEqual({ width: A4_WIDTH, height: A4_HEIGHT });
	});

	it("an image element fits in 60 % of the page and is not enlarged beyond 96 dpi", () => {
		const big = imageElementSize(4000, 3000, 595, 842);
		expect(big.width).toBeCloseTo(595 * 0.6, 1);
		expect(big.height).toBeCloseTo(595 * 0.6 * 0.75, 1);
		expect(imageElementSize(100, 80, 595, 842)).toEqual({ width: 75, height: 60 });
	});

	it("centredPosition keeps the box inside the page", () => {
		expect(centredPosition(300, 400, { width: 100, height: 50 }, { width: 600, height: 800 })).toEqual([250, 375]);
		expect(centredPosition(-50, 900, { width: 100, height: 50 }, { width: 600, height: 800 })).toEqual([0, 750]);
		expect(centredPosition(10, 10, { width: 700, height: 50 }, { width: 600, height: 800 })[0]).toBe(0);
	});
});

describe("newTextBox", () => {
	it("is about 60 % of the page wide and stays inside it", () => {
		const b = newTextBox(600, 100, 50);
		expect(b).toEqual({ x: 100, y: 50, width: 360 });
		const edge = newTextBox(600, 590, 50);
		expect(edge.x + edge.width).toBeLessThanOrEqual(600 - 8 + 1e-6);
		expect(edge.width).toBeGreaterThanOrEqual(80);
	});
});

describe("pageSignature", () => {
	it("changes with strokes, element edits, moves and backgrounds", () => {
		const page = createPage();
		const base = pageSignature(page);
		page.strokes.push(createStroke("#000000", 2, [[1, 1, 0.5], [5, 5, 0.5]]));
		const withStroke = pageSignature(page);
		expect(withStroke).not.toBe(base);
		const moved = createPage();
		moved.strokes.push({ ...page.strokes[0]!, points: [[10, 10, 0.5], [15, 15, 0.5]] });
		expect(pageSignature(moved)).not.toBe(pageSignature({ ...moved, strokes: [{ ...moved.strokes[0]!, points: [[20, 10, 0.5], [15, 15, 0.5]] }] }));
		const text: TextElement = { id: "t", type: "text", x: 0, y: 0, width: 100, text: "a", fontSize: 12, color: "#000000" };
		page.elements = [text];
		const s1 = pageSignature(page);
		page.elements = [{ ...text, text: "ab" }];
		expect(pageSignature(page)).not.toBe(s1);
		page.background = { kind: "pdf", asset: "x", page: 3 };
		expect(pageSignature(page)).toContain("pdf|x|3");
	});

	it("stays cheap on a page with many strokes", () => {
		const page = createPage();
		for (let i = 0; i < 5000; i++) page.strokes.push(createStroke("#000000", 2, [[i, i, 0.5], [i + 1, i, 0.5]]));
		const t0 = performance.now();
		pageSignature(page);
		expect(performance.now() - t0).toBeLessThan(50);
	});
});

describe("metadata helpers", () => {
	it("toggles a bookmark both ways without touching the source", () => {
		const on = toggleBookmark(DEFAULT_META, "p1");
		expect(on.bookmarks).toEqual(["p1"]);
		expect(DEFAULT_META.bookmarks).toEqual([]);
		expect(toggleBookmark(on, "p1").bookmarks).toEqual([]);
		expect(toggleBookmark(on, "p2").bookmarks).toEqual(["p1", "p2"]);
	});

	it("mergeMeta replaces only the given fields and copies arrays", () => {
		const tags = ["a"];
		const m = mergeMeta(DEFAULT_META, { favorite: true, tags });
		expect(m.favorite).toBe(true);
		expect(m.cover).toBe(DEFAULT_META.cover);
		tags.push("b");
		expect(m.tags).toEqual(["a"]);
		expect(metaEquals(m, mergeMeta(m, {}))).toBe(true);
		expect(metaEquals(m, mergeMeta(m, { cover: "#ffffff" }))).toBe(false);
	});
});

describe("shapePoints", () => {
	const A: [number, number] = [10, 10];
	it("generates each shape from a drag and nothing for a tap", () => {
		expect(shapePoints("line", A, [110, 10], 2).length).toBeGreaterThan(30);
		const rect = shapePoints("rectangle", A, [110, 60], 2);
		expect(rect[0]).toEqual(rect[rect.length - 1]);
		const ell = shapePoints("ellipse", A, [110, 60], 2);
		expect(ell[0]).toEqual(ell[ell.length - 1]);
		expect(shapePoints("arrow", A, [110, 10], 2).length).toBeGreaterThan(shapePoints("line", A, [110, 10], 2).length);
		for (const kind of ["line", "arrow", "rectangle", "ellipse"] as const) expect(shapePoints(kind, A, [10.5, 10.5], 2)).toEqual([]);
	});

	it("perfect mode makes squares and snaps lines to 15 degrees", () => {
		const sq = shapePoints("rectangle", A, [110, 40], 2, true);
		const xs = sq.map((p) => p[0]);
		const ys = sq.map((p) => p[1]);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 1);
		const line = shapePoints("line", A, [110, 20], 2, true);
		const end = line[line.length - 1]!;
		expect(Math.atan2(end[1] - 10, end[0] - 10) % (Math.PI / 12)).toBeCloseTo(0, 1);
	});
});

describe("unionBounds", () => {
	it("covers strokes and elements, and is null when both are empty", () => {
		expect(unionBounds([], [], estimateMeasure)).toBeNull();
		const stroke = createStroke("#000000", 2, [[0, 0, 0.5], [10, 10, 0.5]]);
		const img: ImageElement = { id: "i", type: "image", asset: "a", x: 50, y: 60, width: 20, height: 10, rotation: 0 };
		const b = unionBounds([stroke], [img], estimateMeasure)!;
		expect(b.minX).toBeLessThanOrEqual(0);
		expect(b.maxX).toBeCloseTo(70, 5);
		expect(b.maxY).toBeCloseTo(70, 5);
		expect(unionBounds([], [img], estimateMeasure)).toEqual({ minX: 50, minY: 60, maxX: 70, maxY: 70 });
	});
});

describe("shouldGrabRuler", () => {
	const ruler = rulerFromTwoTouches([100, 100], [300, 100]);
	it("grabs near the ruler, lets far-away fingers zoom, and always grabs a ruler that is out of view", () => {
		expect(shouldGrabRuler(ruler, [200, 120], 1, true)).toBe(true);
		expect(shouldGrabRuler(ruler, [200, 600], 1, true)).toBe(false);
		expect(shouldGrabRuler(ruler, [200, 600], 1, false)).toBe(true);
	});
});
