import { describe, expect, it } from "vitest";
import { createPage, createStroke } from "../src/model/document";
import { DIFF_MAX_MARKS, diffMarks } from "../src/ink/diff-render";
import { diffPageContent, type PageDiff } from "../src/model/version-diff";
import type { Page, Point, TextElement } from "../src/model/types";

const stroke = (id: string, pts: Point[] = [[10, 10, 0.5], [20, 20, 0.5]]) => ({ ...createStroke("#000000", 2, pts), id });
const text = (id: string, x: number): TextElement => ({ id, type: "text", x, y: 50, width: 100, text: "hi", fontSize: 14, color: "#000000" });

function pageOf(strokes: ReturnType<typeof stroke>[], elements: TextElement[] = []): Page {
	const p = createPage();
	p.id = "p";
	p.strokes = strokes;
	p.elements = elements;
	return p;
}

function diffOf(before: Page, after: Page): PageDiff {
	const { items, counts } = diffPageContent(before, after);
	return { id: "p", status: "modified", beforeIndex: 0, afterIndex: 0, reordered: false, items, counts, props: [] };
}

describe("diffMarks", () => {
	const before = pageOf([stroke("keep"), stroke("gone", [[100, 100, 0.5], [120, 120, 0.5]]), stroke("shift")], [text("t", 10)]);
	const after = pageOf([stroke("keep"), stroke("new", [[200, 200, 0.5], [220, 220, 0.5]]), stroke("shift", [[40, 40, 0.5], [50, 50, 0.5]])], [text("t", 80)]);
	const pd = diffOf(before, after);
	const key = (m: { id: string; change: string }) => `${m.id}:${m.change}`;

	it("before shows removed and changed items as they were", () => {
		const marks = diffMarks(before, after, pd, "before");
		expect(marks.map(key).sort()).toEqual(["gone:removed", "shift:moved", "t:moved"]);
		expect(marks.find((m) => m.id === "shift")!.box.minX).toBeLessThan(15);
		expect(marks.find((m) => m.id === "gone")!.stroke).toBe(before.strokes[1]);
	});

	it("after shows added and changed items as they are", () => {
		const marks = diffMarks(before, after, pd, "after");
		expect(marks.map(key).sort()).toEqual(["new:added", "shift:moved", "t:moved"]);
		expect(marks.find((m) => m.id === "shift")!.box.minX).toBeGreaterThan(35);
		expect(marks.find((m) => m.id === "new")!.stroke).toBe(after.strokes[1]);
	});

	it("overlay shows everything and remembers where a moved item was", () => {
		const marks = diffMarks(before, after, pd, "overlay");
		expect(marks.map(key).sort()).toEqual(["gone:removed", "new:added", "shift:moved", "t:moved"]);
		const t = marks.find((m) => m.id === "t")!;
		expect(t.oldBox!.minX).toBeLessThan(t.box.minX);
		expect(marks.find((m) => m.id === "gone")!.box.minX).toBeGreaterThan(90);
		expect(marks.find((m) => m.id === "new")!.oldBox).toBeUndefined();
	});

	it("has no marks when a page is missing on one side", () => {
		expect(diffMarks(null, after, pd, "overlay")).toEqual([]);
		expect(diffMarks(before, null, pd, "after")).toEqual([]);
	});

	it("caps the marks of one page", () => {
		const many = Array.from({ length: DIFF_MAX_MARKS + 50 }, (_, i) => stroke(`n${i}`));
		const big = diffOf(pageOf([]), pageOf(many));
		expect(diffMarks(pageOf([]), pageOf(many), big, "after")).toHaveLength(DIFF_MAX_MARKS);
	});
});
