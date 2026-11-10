/**
 * 0.28 review of rotate/crop (#76): Q2 elements that keep their orientation, Q3 excerpts and saved views that point into a changed page, Q4 cache keys,
 * Q5 a crop hides text and links, Q6 repair, Q7 precision, Q8 the top edge, Q9 an atomic "all pages", Q11 states, Q12 a frame that is not a crop.
 */
import { describe, expect, it } from "vitest";
import { elementBounds } from "../src/ink/elements";
import { createDocument, createStroke } from "../src/model/document";
import { Batch, History } from "../src/model/history";
import { planPdfView, pointInView } from "../src/model/pdf-view";
import { buildViewCommands, skippedReasons } from "../src/model/pdf-view-ops";
import { placedItems, planPageView, SetPdfView } from "../src/model/pdf-view-command";
import { repairNotebookText } from "../src/model/repair";
import { freezeStroke, serialize } from "../src/model/serialize";
import type { ExcerptElement, NotebookDocument, Page, PageStates, SavedView, StickyElement, TextElement } from "../src/model/types";
import { assemblePageText } from "../src/pdf/text-search";
import { visibleOf } from "../src/pdf/text-index";
import { frameToCrop, wholeFrame } from "../src/view/pdf-crop-logic";
import { searchTargets } from "../src/view/reading-logic";
import { pageSignature } from "../src/view/view-helpers";
import { parseRaw, setAt } from "./raw-json";

const ASSET = "abcdef0123456789abcdef01";
const SOURCE = { width: 600, height: 800 };

function pdfDoc(extra: Partial<Page> = {}): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date("2026-11-10T10:00:00.000Z"));
	doc.id = "doc";
	doc.assets = { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } };
	const page = doc.pages[0]!;
	page.id = "p1";
	page.width = SOURCE.width;
	page.height = SOURCE.height;
	page.background = { kind: "pdf", asset: ASSET, page: 1 };
	Object.assign(page, extra);
	return { doc, page };
}

const inside = (page: Page, b: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
	b.minX >= -0.01 && b.minY >= -0.01 && b.maxX <= page.width + 0.01 && b.maxY <= page.height + 0.01;

describe("Q2: the plan measures items the way the command places them", () => {
	function withText(): { doc: NotebookDocument; page: Page } {
		const r = pdfDoc();
		const wide: TextElement = { id: "t1", type: "text", x: 50, y: 0, width: 500, text: "a wide line of text", fontSize: 14, color: "#000000" };
		r.page.elements = [Object.freeze(wide)];
		return r;
	}

	it("a wide text box turned a quarter turn keeps its size and ends up on the page (the margins grow to hold it)", () => {
		for (const turns of [1, -1]) {
			const { doc, page } = withText();
			const next = turns === 1 ? { rotate: 90 as const } : { rotate: 270 as const };
			const plan = planPageView(page, SOURCE, next)!;
			expect(plan.above, `${turns}`).toBe(0);
			expect(new History(() => doc).execute(new SetPdfView(page.id, plan))).toBe(true);
			const t = page.elements![0] as TextElement;
			expect(t.width).toBe(500);
			expect(inside(page, elementBounds(t))).toBe(true);
			expect(page.margins).toBeDefined();
		}
	});

	it("a tall sticky note that would end up above the page refuses the change, whatever way the turn goes", () => {
		const { page } = pdfDoc();
		const tall: StickyElement = { id: "n1", type: "sticky", x: 0, y: 0, width: 100, height: 400, color: "#ffd966", fontSize: 12, text: "tall" };
		page.elements = [Object.freeze(tall)];
		const plan = planPageView(page, SOURCE, { rotate: 90 })!;
		expect(plan.above).toBe(1);
		const build = buildViewCommands([{ page, source: SOURCE }], { turns: 1 });
		expect(build.blocked).toBe(1);
		expect(build.commands).toHaveLength(0);
	});

	it("every kind that keeps its orientation is placed by the same rule the plan used", () => {
		const { page } = pdfDoc();
		const kinds = [
			{ id: "e1", type: "equation", x: 20, y: 700, width: 300, height: 40, latex: "x^2", fontSize: 14, color: "#000000" },
			{ id: "c1", type: "checkbox", x: 30, y: 650, size: 20, color: "#000000" },
			{ id: "x1", type: "excerpt", x: 40, y: 600, width: 240, height: 30, source: { notebook: "N.notebook", doc: "other", page: "z", x: 0, y: 0, width: 50, height: 50 } },
		] as unknown as TextElement[];
		page.elements = kinds.map((k) => Object.freeze(k));
		const plan = planPageView(page, SOURCE, { rotate: 270 })!;
		const items = placedItems(page, plan.matrix);
		expect(items).toHaveLength(kinds.length);
		for (const item of items) {
			// Not turned: width and height are what they were.
			expect(item.now.maxX - item.now.minX).toBeCloseTo(item.old.maxX - item.old.minX, 6);
			expect(item.now.maxY - item.now.minY).toBeCloseTo(item.old.maxY - item.old.minY, 6);
		}
	});
});

describe("Q3: excerpts and saved views that point into a changed page follow it", () => {
	function twoPages() {
		const { doc, page } = pdfDoc();
		const other: Page = { ...structuredClone(page), id: "p2", background: undefined, elements: [], strokes: [] };
		delete other.background;
		const excerpt: ExcerptElement = {
			id: "x1", type: "excerpt", x: 20, y: 20, width: 200, height: 150,
			source: { notebook: "N.notebook", doc: doc.id, page: "p1", x: 50, y: 400, width: 200, height: 150 },
		};
		const foreign: ExcerptElement = { ...excerpt, id: "x2", source: { ...excerpt.source, doc: "another-notebook" } };
		other.elements = [Object.freeze(excerpt), Object.freeze(foreign)];
		doc.pages.push(other);
		const view: SavedView = { id: "v1", name: "Figure", page: "p1", x: 50, y: 400, width: 200, height: 150, zoom: 2 };
		doc.views = [view, { ...view, id: "v2", name: "Elsewhere", page: "p2" }];
		return { doc, page, other, excerpt, foreign };
	}

	it("carries a same-notebook excerpt source and a saved view in the same undo step, and leaves others alone", () => {
		const { doc, page, other, excerpt, foreign } = twoPages();
		const build = buildViewCommands([{ page, source: SOURCE }], { turns: 1 }, { doc });
		expect(build.ordered.length).toBe(3);
		const history = new History(() => doc);
		expect(history.execute(new Batch("Rotate or crop PDF page", build.ordered))).toBe(true);
		const moved = other.elements![0] as ExcerptElement;
		// The source rectangle (50, 400, 200, 150) turned a quarter turn on the 600 x 800 page: (250, 50, 150, 200).
		expect([moved.source.x, moved.source.y, moved.source.width, moved.source.height]).toEqual([250, 50, 150, 200]);
		expect(other.elements![1]).toBe(foreign);
		expect(doc.views![0]).toMatchObject({ id: "v1", x: 250, y: 50, width: 150, height: 200, zoom: 2 });
		expect(doc.views![1]).toMatchObject({ id: "v2", x: 50, y: 400 });
		history.undo();
		expect(other.elements![0]).toBe(excerpt);
		expect(doc.views![0]).toMatchObject({ x: 50, y: 400, width: 200, height: 150 });
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
	});

	it("an excerpt of the page on a locked page stops that page's change (it could not follow), the others go on", () => {
		const { doc, page, other } = twoPages();
		other.locked = true;
		const build = buildViewCommands([{ page, source: SOURCE }], { turns: 1 }, { doc });
		expect(build.sources).toBe(1);
		expect(build.commands).toHaveLength(0);
		expect(skippedReasons(build)).toEqual([["sources", 1]]);
	});
});

describe("Q4: the keys of the caches know the turn and the crop", () => {
	it("pageSignature tells a half turn, and two crops of the same size, apart from the whole page", () => {
		const { page } = pdfDoc();
		const plain = pageSignature(page);
		const half = { ...page, background: { kind: "pdf" as const, asset: ASSET, page: 1, rotate: 180 as const } };
		const a = { ...page, background: { kind: "pdf" as const, asset: ASSET, page: 1, crop: { x: 0, y: 0, width: 300, height: 300 } } };
		const b = { ...page, background: { kind: "pdf" as const, asset: ASSET, page: 1, crop: { x: 100, y: 0, width: 300, height: 300 } } };
		expect(new Set([plain, pageSignature(half), pageSignature(a), pageSignature(b)]).size).toBe(4);
	});
});

describe("Q5: what a crop leaves out is not searched, selected, copied or followed", () => {
	const content = { width: 600, height: 800, items: [{ str: "Header http://example.com", x: 20, y: 10, width: 200, height: 12 }, { str: "Body text", x: 20, y: 300, width: 80, height: 12 }] };
	const base = { content, text: assemblePageText(content.items) };

	it("assembles the text again from the runs the crop keeps", () => {
		expect(visibleOf(base, undefined)).toBe(base);
		expect(visibleOf(base, { rotate: 90 })).toBe(base);
		const shown = visibleOf(base, { crop: { x: 0, y: 100, width: 600, height: 600 } });
		expect(shown.content.items.map((i) => i.str)).toEqual(["Body text"]);
		expect(shown.text.text).toBe("Body text");
		expect(shown.text.text).not.toContain("Header");
		// A crop that keeps every run changes nothing.
		expect(visibleOf(base, { crop: { x: 0, y: 0, width: 600, height: 800 } })).toBe(base);
	});

	it("knows which points of the PDF page the view shows", () => {
		const view = { crop: { x: 0, y: 100, width: 600, height: 600 } };
		expect(pointInView(view, SOURCE, { x: 100, y: 12 })).toBe(false);
		expect(pointInView(view, SOURCE, { x: 100, y: 300 })).toBe(true);
		expect(pointInView({ rotate: 90 }, SOURCE, { x: 100, y: 12 })).toBe(true);
	});

	it("the search targets carry the view of their page", () => {
		const { page } = pdfDoc();
		const cropped = { ...page, background: { kind: "pdf" as const, asset: ASSET, page: 1, crop: { x: 0, y: 100, width: 600, height: 600 } } };
		expect(searchTargets([cropped], 0)[0]!.view).toEqual({ crop: { x: 0, y: 100, width: 600, height: 600 } });
		expect(searchTargets([page], 0)[0]!.view).toBeUndefined();
	});
});

describe("Q6: repair keeps a valid turn when only the crop is invalid, and the other way round", () => {
	function broken(key: "rotate" | "crop", value: unknown) {
		const { doc, page } = pdfDoc();
		page.background = { kind: "pdf", asset: ASSET, page: 1, rotate: 90, crop: { x: 10, y: 10, width: 300, height: 300 } };
		const raw = parseRaw(serialize(doc));
		setAt(raw, ["pages", 0, "background", key], value);
		setAt(raw, ["pages", 0, "width"], "wide");
		return repairNotebookText(JSON.stringify(raw));
	}

	it("an invalid crop leaves the turn", () => {
		const r = broken("crop", { x: -5 });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, rotate: 90 });
	});

	it("an invalid turn leaves the crop", () => {
		const r = broken("rotate", 45);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, crop: { x: 10, y: 10, width: 300, height: 300 } });
	});
});

describe("Q7: a page of an odd size comes back to its own size after four turns", () => {
	it("A4 (595.276 x 841.89) is 595.276 x 841.89 again, with no drift", () => {
		const source = { width: 595.276, height: 841.89 };
		const { doc, page } = pdfDoc({ width: 595.276, height: 841.89 });
		page.strokes.push(freezeStroke({ ...createStroke("#112233", 2, [[100.25, 200.5, 0.5], [150, 260, 0.5]]), id: "s1" }));
		const first = page.strokes[0]!.points.map(([x, y]) => [x, y]);
		const history = new History(() => doc);
		let view: { rotate?: 90 | 180 | 270 } | undefined;
		for (let i = 0; i < 8; i++) {
			view = { rotate: (((view?.rotate ?? 0) + 90) % 360) as 0 | 90 | 180 | 270 } as { rotate?: 90 | 180 | 270 };
			if (view.rotate === (0 as unknown)) view = undefined;
			history.execute(new SetPdfView(page.id, planPageView(page, source, view)!));
		}
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		expect(page.width).toBeCloseTo(595.276, 4);
		expect(page.height).toBeCloseTo(841.89, 4);
		const last = page.strokes[0]!.points.map(([x, y]) => [x, y]);
		for (let i = 0; i < first.length; i++) {
			expect(Math.abs(last[i]![0]! - first[i]![0]!)).toBeLessThanOrEqual(0.01);
			expect(Math.abs(last[i]![1]! - first[i]![1]!)).toBeLessThanOrEqual(0.01);
		}
	});
});

describe("Q8: ink that already touches the top edge is not 'above' it", () => {
	it("a crop that keeps the top does not refuse because of a stroke whose width reaches over the edge", () => {
		const { page } = pdfDoc();
		const edge = { minX: 100, minY: -1.2, maxX: 200, maxY: 3 };
		const plan = planPdfView(page, SOURCE, { crop: { x: 0, y: 0, width: 400, height: 700 } }, [edge])!;
		expect(plan.above).toBe(0);
		// Ink that would be moved above the edge by the change still counts.
		const low = { minX: 100, minY: 20, maxX: 200, maxY: 60 };
		expect(planPdfView(page, SOURCE, { crop: { x: 0, y: 100, width: 400, height: 600 } }, [low])!.above).toBe(1);
	});
});

describe("Q9: 'all pages' skips what cannot change, in one consistent way", () => {
	it("a locked page is skipped and counted, the others change in one step", () => {
		const { doc, page } = pdfDoc();
		const second = { ...structuredClone(page), id: "p2", background: { kind: "pdf" as const, asset: ASSET, page: 2 }, elements: [] } as Page;
		const third = { ...structuredClone(page), id: "p3", background: { kind: "pdf" as const, asset: ASSET, page: 3 }, elements: [], locked: true as const } as Page;
		doc.pages.push(second, third);
		const build = buildViewCommands([page, second, third].map((p) => ({ page: p, source: SOURCE })), { turns: 1 }, { doc });
		expect(build.locked).toBe(1);
		expect(build.commands.map((c) => c.pageId)).toEqual(["p1", "p2"]);
		expect(new History(() => doc).execute(new Batch("Rotate or crop PDF page", build.ordered))).toBe(true);
		expect(doc.pages.map((p) => (p.background as { rotate?: number }).rotate)).toEqual([90, 90, undefined]);
		expect(skippedReasons(build)).toEqual([["locked", 1]]);
	});
});

describe("Q11: a part of a drawing with states turns about the point its strokes went to", () => {
	it("a part made of ink written on a text box only moves with the box", () => {
		const { doc, page } = pdfDoc();
		const box: TextElement = { id: "t1", type: "text", x: 100, y: 100, width: 200, text: "label label label", fontSize: 14, color: "#000000" };
		page.elements = [Object.freeze(box)];
		// Ink written on the text box (inside its bounds).
		page.strokes.push(freezeStroke({ ...createStroke("#112233", 2, [[120, 110, 0.5], [180, 112, 0.5]]), id: "ink" }));
		const states: PageStates = { parts: [{ id: "pa", pivot: [150, 111], items: ["ink"] }], list: [{ id: "st1", name: "A", poses: [{ part: "pa", dx: 30, dy: 10 }] }] };
		page.states = states;
		const plan = planPageView(page, SOURCE, { rotate: 90 })!;
		expect(new History(() => doc).execute(new SetPdfView(page.id, plan))).toBe(true);
		const stroke = page.strokes.find((s) => s.id === "ink")!;
		const t = page.elements[0] as TextElement;
		// The ink moved by the translation of the box, not by the turn.
		const dx = t.x - 100, dy = t.y - 100;
		expect(stroke.points[0]![0]).toBeCloseTo(120 + dx, 1);
		expect(stroke.points[0]![1]).toBeCloseTo(110 + dy, 1);
		const part = page.states.parts[0]!;
		expect(part.pivot[0]).toBeCloseTo(150 + dx, 1);
		expect(part.pivot[1]).toBeCloseTo(111 + dy, 1);
		// Its pose shift is not turned.
		expect(page.states.list[0]!.poses[0]).toMatchObject({ dx: 30, dy: 10 });
	});
});

describe("Q12: a frame that cannot be stored as a crop is not 'no crop'", () => {
	it("is undefined for a sliver, null for the whole page and a crop otherwise", () => {
		expect(frameToCrop(wholeFrame(SOURCE), 0, SOURCE)).toBeNull();
		expect(frameToCrop({ x: 10, y: 10, width: 4, height: 300 }, 0, SOURCE)).toBeUndefined();
		expect(frameToCrop({ x: 10, y: 10, width: 300, height: 300 }, 0, SOURCE)).toEqual({ x: 10, y: 10, width: 300, height: 300 });
	});
});
