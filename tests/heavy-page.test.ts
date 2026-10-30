import { describe, expect, it } from "vitest";
import { HEAVY_LIMITS, heavyReasons, pageLoad, planPageSplit, SPLIT_TOP_MARGIN } from "../src/ink/heavy-page";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { pageContentCommand } from "../src/model/page-content";
import { freezeStroke, serialize, serializeChecked } from "../src/model/serialize";
import type { ImageElement, NotebookDocument, Page, Point, Stroke, TextElement } from "../src/model/types";

const ASSET = "abcdef0123456789abcdef01";

/** A short horizontal stroke ("a word") of `n` points at height y. */
function word(x: number, y: number, n = 10, id?: string): Stroke {
	const points: Point[] = [];
	for (let i = 0; i < n; i++) points.push(quantizePoint(x + i * 2, y + (i % 2), 0.5));
	const s = freezeStroke(createStroke("#1e1e1e", 2, points));
	return id ? { ...s, id } : s;
}

/** `lines` lines of `perLine` words, 30 pt apart from y = 60. */
function textPage(lines: number, perLine = 4): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	const page = doc.pages[0]!;
	for (let l = 0; l < lines; l++) for (let w = 0; w < perLine; w++) page.strokes.push(word(50 + w * 60, 60 + l * 30, 10, `s-${l}-${w}`));
	return { doc, page };
}

function image(id: string, y: number): ImageElement {
	return Object.freeze({ id, type: "image", asset: ASSET, x: 100, y, width: 80, height: 40, rotation: 0 } as ImageElement);
}

describe("heavy page thresholds", () => {
	it("counts strokes, points and the distinct image assets of a page", () => {
		const { page } = textPage(2, 3);
		page.elements = [image("i1", 10), image("i2", 100), { id: "t", type: "text", x: 0, y: 0, width: 50, text: "x", fontSize: 12, color: "#000000" } as TextElement];
		const load = pageLoad(page, { [ASSET]: { bytes: 5000 } });
		expect(load).toEqual({ strokes: 6, points: 60, assetBytes: 5000 });
		// A PDF background is shared by the pages of the PDF and not counted; an image background is.
		page.background = { kind: "pdf", asset: "ff00", page: 1 };
		expect(pageLoad(page, { ff00: { bytes: 9e6 }, [ASSET]: { bytes: 5000 } }).assetBytes).toBe(5000);
		page.background = { kind: "image", asset: "ff00" };
		expect(pageLoad(page, { ff00: { bytes: 9e6 }, [ASSET]: { bytes: 5000 } }).assetBytes).toBe(9e6 + 5000);
		expect(pageLoad(page, undefined).assetBytes).toBe(0);
	});

	it("warns only when a limit is exceeded, and says which", () => {
		const L = HEAVY_LIMITS;
		expect(heavyReasons({ strokes: L.strokes, points: L.points, assetBytes: L.assetBytes })).toEqual([]);
		expect(heavyReasons({ strokes: L.strokes + 1, points: 0, assetBytes: 0 })).toEqual(["strokes"]);
		expect(heavyReasons({ strokes: 0, points: L.points + 1, assetBytes: 0 })).toEqual(["points"]);
		expect(heavyReasons({ strokes: 0, points: 0, assetBytes: L.assetBytes + 1 })).toEqual(["assets"]);
		expect(heavyReasons({ strokes: 9e9, points: 9e9, assetBytes: 9e9 })).toEqual(["strokes", "points", "assets"]);
		expect(heavyReasons({ strokes: 5, points: 5, assetBytes: 5 }, { strokes: 4, points: 9, assetBytes: 9 })).toEqual(["strokes"]);
	});
});

describe("split plan", () => {
	it("cuts a page of text lines in the blank gap near the middle and moves the lower lines to a new page after it", () => {
		const { doc, page } = textPage(10);
		const plan = planPageSplit(page, 0)!;
		expect(plan).not.toBeNull();
		expect(plan.clean).toBe(true);
		expect(plan.staying).toBe(20);
		expect(plan.moved).toBe(20);
		expect(plan.insertAt).toBe(1);
		// Between the 5th line (y = 60 + 4 * 30) and the 6th (y = 60 + 5 * 30).
		expect(plan.splitY).toBeGreaterThan(60 + 4 * 30 + 2);
		expect(plan.splitY).toBeLessThan(60 + 5 * 30);

		const history = new History(() => doc);
		const before = serialize(doc);
		history.execute(pageContentCommand(doc, plan, "Split page"));
		expect(doc.pages).toHaveLength(2);
		const [first, second] = doc.pages as [Page, Page];
		expect(first.strokes).toHaveLength(20);
		expect(second.strokes).toHaveLength(20);
		// Same size and paper as the page it continues.
		expect({ w: second.width, h: second.height, paper: second.paper }).toEqual({ w: page.width, h: page.height, paper: first.paper });
		// Nothing lost or duplicated; the order of strokes on each page is the original order.
		expect([...first.strokes, ...second.strokes].map((s) => s.id)).toEqual(textPage(10).page.strokes.map((s) => s.id));
		// Horizontal positions are unchanged; vertical distances between moved strokes are unchanged; the first starts at the top margin.
		const original = textPage(10).page.strokes.slice(20);
		const dy = second.strokes[0]!.points[0]![1] - original[0]!.points[0]![1];
		expect(dy).toBeCloseTo(plan.dy, 2);
		second.strokes.forEach((s, i) => {
			s.points.forEach((p, j) => {
				expect(p[0]).toBe(original[i]!.points[j]![0]);
				expect(p[1]).toBeCloseTo(original[i]!.points[j]![1] + dy, 2);
				expect(p[2]).toBe(original[i]!.points[j]![2]);
			});
		});
		// The box of the first moved line (its points minus half the stroke width) starts at the top margin.
		expect(Math.min(...second.strokes.flatMap((s) => s.points.map((p) => p[1] - s.width / 2)))).toBeCloseTo(SPLIT_TOP_MARGIN, 1);
		// Still a valid notebook that serializes.
		expect(serializeChecked(doc).ok).toBe(true);

		// One undo step puts everything back, and redo does it again.
		expect(history.canUndo()).toBe(true);
		history.undo();
		expect(history.canUndo()).toBe(false);
		expect(serialize(doc)).toBe(before);
		history.redo();
		expect(doc.pages).toHaveLength(2);
		expect(doc.pages[1]!.strokes).toHaveLength(20);
	});

	it("splits by load, not by number of strokes: one dense line weighs like many sparse ones", () => {
		const { page } = textPage(8, 1);
		// Line 1 holds 400 points, the others 10 each.
		page.strokes[0] = word(50, 60, 400, "dense");
		const plan = planPageSplit(page, 0)!;
		// The first stroke alone is more than half of the load: it stays alone above the cut.
		expect(plan.staying).toBe(1);
		expect(plan.moved).toBe(7);
	});

	it("moves text boxes and images with the strokes on their side, and images weigh by size", () => {
		const { doc, page } = textPage(4, 2);
		const text: TextElement = Object.freeze({ id: "t1", type: "text", x: 60, y: 500, width: 100, text: "later", fontSize: 14, color: "#000000" });
		page.elements = [image("i1", 70), text, image("i2", 520)];
		const plan = planPageSplit(page, 0, { [ASSET]: { bytes: 1_000_000 } })!;
		history(doc, plan);
		const ids = (p: Page) => (p.elements ?? []).map((e) => e.id);
		expect(ids(doc.pages[0]!)).toContain("i1");
		expect(ids(doc.pages[1]!)).toEqual(expect.arrayContaining(["t1", "i2"]));
		expect(ids(doc.pages[0]!).concat(ids(doc.pages[1]!)).sort()).toEqual(["i1", "i2", "t1"]);
		const moved = doc.pages[1]!.elements!.find((e) => e.id === "t1")!;
		expect(moved.x).toBe(60);
		expect(moved.y).toBeLessThanOrEqual(500);
	});

	it("a stroke that crosses the cut goes whole to the side of its middle", () => {
		const { page } = textPage(6, 1);
		// A tall stroke from line 1 down to line 6: its middle is in the lower half.
		page.strokes.push(freezeStroke(createStroke("#1e1e1e", 2, [[10, 60, 0.5], [12, 240, 0.5]])), freezeStroke(createStroke("#1e1e1e", 2, [[10, 100, 0.5], [12, 120, 0.5]])));
		const plan = planPageSplit(page, 0)!;
		expect(plan.moved + plan.staying).toBe(page.strokes.length);
		expect(plan.clean).toBe(false);
		const movedIds = new Set(plan.appended[0]!.strokes.map((s) => s.id));
		const stayIds = new Set(plan.changes[0]!.strokes.map((s) => s.id));
		for (const s of page.strokes) expect(movedIds.has(s.id) !== stayIds.has(s.id)).toBe(true);
	});

	it("is deterministic and does not modify the page it reads", () => {
		const { page } = textPage(10);
		const snapshot = JSON.stringify(page);
		const a = planPageSplit(page, 0)!;
		const b = planPageSplit(page, 0)!;
		expect(JSON.stringify(page)).toBe(snapshot);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("does not split a page with nothing to share, or one that shows a PDF or a scan", () => {
		const { page } = textPage(1, 1);
		expect(planPageSplit(page, 0)).toBeNull();
		expect(planPageSplit({ id: "p", strokes: [] }, 0)).toBeNull();
		const full = textPage(6).page;
		full.background = { kind: "pdf", asset: ASSET, page: 1 };
		expect(planPageSplit(full, 0)).toBeNull();
		full.background = { kind: "image", asset: ASSET };
		expect(planPageSplit(full, 0)).toBeNull();
	});

	it("splits content that is stacked at the same height (no gap to cut in)", () => {
		const { doc, page } = textPage(1, 1);
		for (let i = 0; i < 9; i++) page.strokes.push(word(50 + i, 60, 10, `x${i}`));
		const plan = planPageSplit(page, 0)!;
		expect(plan.staying + plan.moved).toBe(10);
		expect(plan.staying).toBeGreaterThan(0);
		expect(plan.moved).toBeGreaterThan(0);
		history(doc, plan);
		expect(doc.pages[0]!.strokes.length + doc.pages[1]!.strokes.length).toBe(10);
	});

	it("inserts the new page right after the split page, in the middle of a notebook", () => {
		const { doc, page } = textPage(6);
		doc.pages.push({ ...doc.pages[0]!, id: "last", strokes: [] });
		const plan = planPageSplit(page, 0)!;
		history(doc, plan);
		expect(doc.pages.map((p) => p.id)).toEqual([page.id, expect.any(String), "last"]);
	});
});

function history(doc: NotebookDocument, plan: NonNullable<ReturnType<typeof planPageSplit>>): void {
	new History(() => doc).execute(pageContentCommand(doc, plan, "Split page"));
}
