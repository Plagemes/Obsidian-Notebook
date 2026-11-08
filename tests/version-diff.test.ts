import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import {
	changedPageCount, compareElement, compareStroke, diffDocuments, diffPageContent, isChangedPage, longestIncreasing, sameValue, totalChanges,
} from "../src/model/version-diff";
import type { BoxElement, NotebookDocument, Page, Point, StickyElement, TextElement } from "../src/model/types";

const stroke = (id: string, pts: Point[] = [[10, 10, 0.5], [20, 20, 0.5]], color = "#000000") => ({ ...createStroke(color, 2, pts), id });
const text = (id: string, x = 10, y = 10, t = "hi"): TextElement => ({ id, type: "text", x, y, width: 100, text: t, fontSize: 14, color: "#000000" });
const box = (id: string): BoxElement => ({ id, type: "box", kind: "definition", x: 10, y: 10, width: 50, height: 50 });

function page(id: string, strokes = [] as ReturnType<typeof stroke>[], elements?: Page["elements"]): Page {
	const p = createPage();
	p.id = id;
	p.strokes = strokes;
	if (elements) p.elements = elements;
	return p;
}

function doc(pages: Page[]): NotebookDocument {
	const d = createDocument();
	d.pages = pages;
	return d;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("sameValue", () => {
	it("ignores key order and undefined fields", () => {
		expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
		expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
		expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
		expect(sameValue({ a: 1, skip: 5 }, { a: 1 }, new Set(["skip"]))).toBe(true);
		expect(sameValue(null, {})).toBe(false);
	});
});

describe("compareStroke", () => {
	it("is same for equal ink", () => {
		expect(compareStroke(stroke("a"), stroke("a"))).toBe("same");
	});
	it("is moved when the whole stroke shifted", () => {
		expect(compareStroke(stroke("a"), stroke("a", [[15, 30, 0.5], [25, 40, 0.5]]))).toBe("moved");
	});
	it("is changed for a different shape, colour, width or tool", () => {
		expect(compareStroke(stroke("a"), stroke("a", [[10, 10, 0.5], [20, 25, 0.5]]))).toBe("changed");
		expect(compareStroke(stroke("a"), stroke("a", undefined, "#ff0000"))).toBe("changed");
		expect(compareStroke(stroke("a"), { ...stroke("a"), width: 4 })).toBe("changed");
		expect(compareStroke(stroke("a"), { ...stroke("a"), tool: "highlighter" })).toBe("changed");
		expect(compareStroke(stroke("a"), { ...stroke("a"), hidden: true })).toBe("changed");
	});
	it("is changed when only the fill, its tint, the dash or the nib differ", () => {
		const shape = { ...stroke("a"), tool: "shape" as const };
		expect(compareStroke(shape, { ...shape })).toBe("same");
		expect(compareStroke(shape, { ...shape, fill: "#2563eb" })).toBe("changed");
		expect(compareStroke({ ...shape, fill: "#2563eb" }, { ...shape, fill: "#2563eb", fillTint: true })).toBe("changed");
		expect(compareStroke(shape, { ...shape, dash: "dashed" })).toBe("changed");
		expect(compareStroke({ ...shape, dash: "dashed" }, { ...shape, dash: "dotted" })).toBe("changed");
		expect(compareStroke(stroke("a"), { ...stroke("a"), nib: 90 })).toBe("changed");
	});
	it("is changed when the point count differs, or when shifted and reshaped", () => {
		expect(compareStroke(stroke("a"), stroke("a", [[10, 10, 0.5]]))).toBe("changed");
		expect(compareStroke(stroke("a"), stroke("a", [[15, 15, 0.5], [30, 25, 0.5]]))).toBe("changed");
	});
	it("a pressure change is a change, not a move", () => {
		expect(compareStroke(stroke("a"), stroke("a", [[10, 10, 0.9], [20, 20, 0.5]]))).toBe("changed");
	});
	it("two empty strokes are the same", () => {
		expect(compareStroke(stroke("a", []), stroke("a", []))).toBe("same");
	});
});

describe("compareElement", () => {
	it("same, moved, changed", () => {
		expect(compareElement(text("t"), text("t"))).toBe("same");
		expect(compareElement(text("t"), text("t", 50, 60))).toBe("moved");
		expect(compareElement(text("t"), text("t", 10, 10, "changed text"))).toBe("changed");
		expect(compareElement(text("t"), text("t", 50, 60, "other"))).toBe("changed");
	});
	it("a resized box is changed, a type change is changed", () => {
		expect(compareElement(box("b"), { ...box("b"), width: 80 })).toBe("changed");
		expect(compareElement(box("b"), { ...text("b") })).toBe("changed");
	});
	it("a cached equation outline is not a change", () => {
		const eq = { id: "e", type: "equation" as const, x: 1, y: 2, width: 10, height: 10, latex: "x", fontSize: 12, color: "#000000" };
		expect(compareElement(eq, { ...eq, outline: "M0 0Z" })).toBe("same");
	});
	it("a collapsed sticky that lists other ink is changed even when it did not move", () => {
		const s: StickyElement = { id: "s", type: "sticky", x: 1, y: 1, width: 50, height: 50, color: "#fde68a", fontSize: 12, collapsed: true, ink: ["a"] };
		expect(compareElement(s, { ...s, ink: ["a", "b"] })).toBe("changed");
		expect(compareElement(s, { ...s, x: 30 })).toBe("moved");
	});
});

describe("diffPageContent", () => {
	it("finds added, removed, changed and moved strokes and elements by id", () => {
		const before = page("p", [stroke("keep"), stroke("gone"), stroke("shift"), stroke("edit")], [text("t1"), text("t2"), text("t3")]);
		const after = page("p", [stroke("keep"), stroke("shift", [[15, 15, 0.5], [25, 25, 0.5]]), stroke("edit", undefined, "#ff0000"), stroke("new")], [text("t1"), text("t2", 40, 40), text("t4")]);
		const { items, counts } = diffPageContent(before, after);
		const by = (kind: string, id: string) => items.find((i) => i.kind === kind && i.id === id)?.change;
		expect(by("stroke", "keep")).toBeUndefined();
		expect(by("stroke", "gone")).toBe("removed");
		expect(by("stroke", "shift")).toBe("moved");
		expect(by("stroke", "edit")).toBe("changed");
		expect(by("stroke", "new")).toBe("added");
		expect(by("element", "t1")).toBeUndefined();
		expect(by("element", "t2")).toBe("moved");
		expect(by("element", "t3")).toBe("removed");
		expect(by("element", "t4")).toBe("added");
		expect(counts).toEqual({ added: 2, removed: 2, changed: 1, moved: 2 });
		expect(totalChanges(counts)).toBe(7);
	});
	it("an identical page has no items", () => {
		const a = page("p", [stroke("a")], [text("t")]);
		expect(diffPageContent(a, clone(a)).items).toEqual([]);
	});
	it("a duplicate stroke id on the later side is not counted twice", () => {
		const { items } = diffPageContent(page("p", [stroke("a")]), page("p", [stroke("a"), stroke("a")]));
		expect(items).toEqual([]);
	});
});

describe("diffDocuments", () => {
	it("an identical copy has no change", () => {
		const d = doc([page("a", [stroke("s")]), page("b")]);
		const r = diffDocuments(d, clone(d));
		expect(r.summary.pagesUnchanged).toBe(2);
		expect(r.summary.pagesModified + r.summary.pagesAdded + r.summary.pagesRemoved + r.summary.pagesReordered).toBe(0);
		expect(changedPageCount(r)).toBe(0);
		expect(r.truncated).toBe(false);
	});

	it("matches pages by id: added, removed and modified pages with counts", () => {
		const before = doc([page("a", [stroke("s1")]), page("b", [stroke("s2")]), page("c")]);
		const after = doc([page("a", [stroke("s1"), stroke("s3")]), page("c"), page("d", [stroke("s4"), stroke("s5")], [text("t")])]);
		const r = diffDocuments(before, after);
		expect(r.pages.map((p) => `${p.id}:${p.status}`)).toEqual(["a:modified", "b:removed", "c:unchanged", "d:added"]);
		expect(r.summary).toMatchObject({ pagesAdded: 1, pagesRemoved: 1, pagesModified: 1, pagesUnchanged: 1, pagesUnchecked: 0 });
		expect(r.pages[1]!.counts.removed).toBe(1);
		expect(r.pages[3]!.counts.added).toBe(3);
		expect(r.summary.counts).toEqual({ added: 4, removed: 1, changed: 0, moved: 0 });
		expect(r.pages[1]!.beforeIndex).toBe(1);
		expect(r.pages[1]!.afterIndex).toBe(-1);
		expect(r.pages[3]!.beforeIndex).toBe(-1);
		expect(changedPageCount(r)).toBe(3);
	});

	it("puts a removed first page first and keeps removed pages after the page that preceded them", () => {
		const before = doc([page("x"), page("a"), page("y"), page("z"), page("b")]);
		const after = doc([page("a"), page("b")]);
		const r = diffDocuments(before, after);
		expect(r.pages.map((p) => p.id)).toEqual(["x", "a", "y", "z", "b"]);
		expect(r.pages.filter((p) => p.status === "removed").map((p) => p.id)).toEqual(["x", "y", "z"]);
	});

	it("flags pages that changed position and only those", () => {
		const before = doc([page("a"), page("b"), page("c"), page("d")]);
		const after = doc([page("b"), page("c"), page("d"), page("a")]);
		const r = diffDocuments(before, after);
		expect(r.pages.filter((p) => p.reordered).map((p) => p.id)).toEqual(["a"]);
		expect(r.summary.pagesReordered).toBe(1);
		expect(isChangedPage(r.pages.find((p) => p.id === "a")!)).toBe(true);
		expect(isChangedPage(r.pages.find((p) => p.id === "b")!)).toBe(false);
	});

	it("a page whose only difference is a property is modified and lists the property", () => {
		const before = doc([page("a")]);
		const after = doc([page("a")]);
		after.pages[0]!.paper = { kind: "ruled", spacing: 22 };
		after.pages[0]!.tags = ["exam"];
		after.pages[0]!.locked = true;
		const r = diffDocuments(before, after);
		expect(r.pages[0]!.status).toBe("modified");
		expect(r.pages[0]!.items).toEqual([]);
		expect(r.pages[0]!.props).toEqual(["paper", "tags", "locked"]);
	});

	it("caps the work: pages beyond the cap are unchecked, never unchanged", () => {
		const mk = () => doc(Array.from({ length: 5 }, (_, i) => page(`p${i}`, Array.from({ length: 10 }, (_, j) => stroke(`s${i}-${j}`)))));
		const before = mk();
		const after = clone(before);
		after.pages[4]!.strokes.pop();
		const r = diffDocuments(before, after, { maxItems: 45 });
		// each page costs 20 (10 on each side): two fit in 45, the rest are not compared
		expect(r.truncated).toBe(true);
		expect(r.pages.map((p) => p.status)).toEqual(["unchanged", "unchanged", "unchecked", "unchecked", "unchecked"]);
		expect(r.summary.pagesUnchecked).toBe(3);
		expect(diffDocuments(before, after).pages[4]!.status).toBe("modified");
	});

	it("added and removed pages cost nothing against the cap", () => {
		const big = page("big", Array.from({ length: 500 }, (_, i) => stroke(`s${i}`)));
		const r = diffDocuments(doc([page("a")]), doc([page("a"), big]), { maxItems: 1 });
		expect(r.truncated).toBe(false);
		expect(r.pages[1]!.status).toBe("added");
		expect(r.pages[1]!.counts.added).toBe(500);
	});

	it("a duplicated page id on the later side counts the second as added", () => {
		const r = diffDocuments(doc([page("a")]), doc([page("a"), page("a")]));
		expect(r.pages.map((p) => p.status)).toEqual(["unchanged", "added"]);
	});

	it("does not modify its inputs", () => {
		const before = doc([page("a", [stroke("s")]), page("b")]);
		const after = doc([page("a", [stroke("s"), stroke("t")])]);
		const snapshot = JSON.stringify([before, after]);
		diffDocuments(before, after);
		expect(JSON.stringify([before, after])).toBe(snapshot);
	});

	it("handles empty notebooks", () => {
		const r = diffDocuments(doc([]), doc([]));
		expect(r.pages).toEqual([]);
		expect(diffDocuments(doc([]), doc([page("a")])).summary.pagesAdded).toBe(1);
		expect(diffDocuments(doc([page("a")]), doc([])).summary.pagesRemoved).toBe(1);
	});
});

describe("longestIncreasing", () => {
	it("keeps a longest increasing run", () => {
		expect([...longestIncreasing([1, 2, 3, 0])].sort()).toEqual([0, 1, 2]);
		expect(longestIncreasing([]).size).toBe(0);
		expect(longestIncreasing([3, 2, 1]).size).toBe(1);
		expect(longestIncreasing([0, 1, 2, 3]).size).toBe(4);
	});
});
