import { describe, expect, it } from "vitest";
import { allPages, cleanCoverField, coverBlocks, coverPage, defaultHandInPages, handInCheck, isBlankForHandIn, openOnPage, togglePage, withoutPages } from "../src/model/hand-in";
import { pagesToPdf } from "../src/ink/export-pdf";
import { createPage, createStroke, quantizePoint } from "../src/model/document";
import { createCheckbox } from "../src/model/checklist";
import { createBox, createMarker } from "../src/model/markers";
import { PAGE_SIZES, type Page, type PageElement } from "../src/model/types";

const ink = (): ReturnType<typeof createStroke> => createStroke("#000000", 3, [quantizePoint(100, 100, 0.5), quantizePoint(140, 120, 0.5)]);
const written = (): Page => {
	const p = createPage(PAGE_SIZES.a4);
	p.strokes.push(ink());
	return p;
};
const withElements = (...els: PageElement[]): Page => {
	const p = written();
	p.elements = els;
	return p;
};
const text = (t: string, x = 50, y = 50): PageElement => ({ id: `t${t.length}-${x}-${y}`, type: "text", x, y, width: 200, text: t, fontSize: 14, color: "#000000" });

describe("page selection", () => {
	it("starts with the picked pages, else the current page", () => {
		expect(defaultHandInPages(6, 2, [4, 1, 4])).toEqual([1, 4]);
		expect(defaultHandInPages(6, 3)).toEqual([3]);
		expect(defaultHandInPages(6, 99)).toEqual([5]);
		expect(defaultHandInPages(6, -2)).toEqual([0]);
		expect(defaultHandInPages(0, 0)).toEqual([]);
	});
	it("ignores picked pages that do not exist", () => {
		expect(defaultHandInPages(3, 1, [7, -1, 2.5])).toEqual([1]);
	});
	it("toggles, selects all and leaves out pages, keeping the order", () => {
		expect(togglePage([0, 3], 1)).toEqual([0, 1, 3]);
		expect(togglePage([0, 1, 3], 1)).toEqual([0, 3]);
		expect(allPages(3)).toEqual([0, 1, 2]);
		expect(allPages(-1)).toEqual([]);
		expect(withoutPages([0, 1, 2, 3], [1, 3])).toEqual([0, 2]);
	});
});

describe("pre-flight", () => {
	it("finds blank pages among the chosen ones only", () => {
		const pages = [written(), createPage(PAGE_SIZES.a4), createPage(PAGE_SIZES.a4), written()];
		expect(handInCheck(pages, [0, 1, 3]).blank).toEqual([1]);
		expect(handInCheck(pages, [0, 3]).clean).toBe(true);
	});
	it("does not count hidden ink as written", () => {
		const p = createPage(PAGE_SIZES.a4);
		p.strokes.push({ ...ink(), hidden: true });
		expect(isBlankForHandIn(p)).toBe(true);
		expect(isBlankForHandIn(written())).toBe(false);
	});
	it("reports open gaps, questions and homework but not the done ones", () => {
		const p = withElements(
			createMarker("gap", 10, 10), { ...createMarker("gap", 10, 40), done: true },
			createMarker("question", 10, 70, { text: "Why is it so?" }), createMarker("homework", 10, 100), createMarker("star", 10, 130),
		);
		const f = openOnPage(p, 4);
		expect(f.map((x) => [x.kind, x.count, x.page])).toEqual([["gap", 1, 4], ["question", 1, 4], ["homework", 1, 4]]);
		expect(f[1]!.sample).toBe("Why is it so?");
	});
	it("reports unchecked checkboxes", () => {
		const open = createCheckbox(10, 10, PAGE_SIZES.a4);
		const done = { ...createCheckbox(10, 50, PAGE_SIZES.a4), checked: true as const };
		const f = openOnPage(withElements(open, done), 0);
		expect(f.map((x) => [x.kind, x.count])).toEqual([["checkbox", 1]]);
	});
	it("reports TODO notes, case-insensitive, with the line as sample", () => {
		const f = openOnPage(withElements(text("fine\nTodo: check the sign"), text("done, ok", 60, 90), text("what??? really", 60, 120)), 2);
		expect(f).toHaveLength(1);
		expect(f[0]).toMatchObject({ kind: "todo", count: 2, page: 2 });
		expect(f[0]!.sample).toBe("Todo: check the sign");
	});
	it("reports an empty template box, not one with ink or an element in it", () => {
		const empty = createBox("definition", { x: 100, y: 300, width: 200, height: 100 }, "Definition 1");
		const inked = createBox("theorem", { x: 100, y: 500, width: 200, height: 100 });
		const p = withElements(empty, inked);
		p.strokes.push(createStroke("#000000", 3, [quantizePoint(150, 550, 0.5), quantizePoint(180, 560, 0.5)]));
		expect(openOnPage(p, 0)).toEqual([{ page: 0, kind: "emptyBox", count: 1, sample: "Definition 1" }]);
		expect(openOnPage(withElements(empty, text("answer", 120, 320)), 0)).toEqual([]);
	});
	it("is clean when nothing is open, and ignores pages that are not chosen", () => {
		const pages = [written(), withElements(createMarker("gap", 10, 10))];
		expect(handInCheck(pages, [0])).toEqual({ blank: [], open: [], clean: true });
		expect(handInCheck(pages, [0, 1]).open).toHaveLength(1);
		expect(handInCheck(pages, [5, -1]).clean).toBe(true);
	});
	it("does not look for open items on a blank page", () => {
		const c = handInCheck([createPage(PAGE_SIZES.a4)], [0]);
		expect(c.blank).toEqual([0]);
		expect(c.open).toEqual([]);
	});
});

describe("cover", () => {
	const fields = { name: "Ada Lovelace", course: "Analysis 2", title: "Assignment 3: series", date: "8 November 2026", footer: "5 pages" };
	const size = PAGE_SIZES.a4;
	it("lays out title, then label/value pairs, without overlap and inside the margins", () => {
		const blocks = coverBlocks(fields, size);
		expect(blocks.map((b) => b.kind)).toEqual(["title", "label", "value", "label", "value", "label", "value", "footer"]);
		for (const b of blocks) {
			expect(b.x).toBeGreaterThan(0);
			expect(b.x + b.width).toBeLessThan(size.width);
			expect(b.y + b.height).toBeLessThan(size.height);
		}
		const flow = blocks.filter((b) => b.kind !== "footer");
		for (let i = 1; i < flow.length; i++) expect(flow[i]!.y).toBeGreaterThanOrEqual(flow[i - 1]!.y + flow[i - 1]!.height);
		const last = flow[flow.length - 1]!;
		expect(blocks[blocks.length - 1]!.y).toBeGreaterThan(last.y + last.height);
	});
	it("leaves out empty fields and wraps a long title instead of overflowing", () => {
		const blocks = coverBlocks({ ...fields, name: "  ", course: "", title: "A very long assignment title ".repeat(8) }, size);
		expect(blocks.filter((b) => b.kind === "value").map((b) => b.text)).toEqual(["8 November 2026"]);
		const title = blocks.find((b) => b.kind === "title")!;
		expect(title.height).toBeGreaterThan(30 * 1.25 * 1.5);
		const next = blocks.find((b) => b.kind === "label")!;
		expect(next.y).toBeGreaterThan(title.y + title.height);
	});
	it("cleans a field to one bounded line", () => {
		expect(cleanCoverField("  a \n b\t c ")).toBe("a b c");
		expect(cleanCoverField("x".repeat(500))).toHaveLength(120);
	});
	it("takes the size of a finite chosen page and A4 for an infinite one", () => {
		const labels = { name: "Name", course: "Course", date: "Date" };
		expect(coverPage(fields, labels, { width: 400, height: 500 })).toMatchObject({ width: 400, height: 500 });
		expect(coverPage(fields, labels, { width: 400, height: 5000, infinite: true })).toMatchObject({ width: size.width, height: size.height });
		expect(coverPage(fields, labels)).toMatchObject({ width: size.width });
	});
	it("is a page of text boxes and one rule, captions in capitals", () => {
		const page = coverPage(fields, { name: "Name", course: "Course", date: "Date" });
		const texts = (page.elements ?? []).flatMap((e) => (e.type === "text" ? [e.text] : []));
		expect(texts).toContain("NAME");
		expect(texts).toContain("Ada Lovelace");
		expect(texts).toContain("Assignment 3: series");
		expect(page.strokes).toHaveLength(1);
	});
	it("goes through the PDF export as the first page", () => {
		const cover = coverPage(fields, { name: "Name", course: "Course", date: "Date" });
		const bytes = pagesToPdf([cover, written()], { paper: true, title: "x" });
		const s = new TextDecoder("latin1").decode(bytes);
		expect(s.startsWith("%PDF-")).toBe(true);
		expect((s.match(/\/Type \/Page\b/g) ?? []).length).toBe(2);
	});
});
