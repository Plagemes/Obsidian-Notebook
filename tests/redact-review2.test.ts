// 0.26 privacy review, round 2 (#285): each fix has a SECRET marker test with its own positive control (without the box, or with the box
// elsewhere, the same output carries the marker).
import { describe, expect, it } from "vitest";
import { pageToSvg } from "../src/ink/export-svg";
import { charEm, elementKept, headerAfterRedaction, pessimisticMeasure, redactBounds, redactPage, redactPages, withExcerptChains } from "../src/ink/redact";
import type { HeaderLayout } from "../src/ink/page-header";
import { LINE_HEIGHT, estimateMeasure, layoutText } from "../src/ink/text-layout";
import { boxesOf, type Redactions } from "../src/model/redact";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, type ExcerptElement, type Page, type PageElement } from "../src/model/types";

function page(id: string, elements: PageElement[] = []): Page {
	return { id, width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled }, strokes: [], ...(elements.length ? { elements } : {}) };
}

function excerpt(id: string, at: { x: number; y: number }, asset: string, source: { page: string; x: number; y: number; width: number; height: number }): ExcerptElement {
	return { id, type: "excerpt", x: at.x, y: at.y, width: 200, height: 100, asset, source: { notebook: "Demo", doc: "d", ...source } };
}

const holds = (p: Page | undefined, marker: string): boolean => JSON.stringify(p ?? null).includes(marker);
const covered = { x: 100, y: 100, width: 100, height: 50 };
const far = { x: 450, y: 700, width: 40, height: 40 };

// ------------------------------------------------------------------------------------------------------------------------------ R1

describe("R1: a single element is copied only when the export would keep it", () => {
	const p2 = page("p2");
	const p5 = page("p5", [excerpt("A", { x: 50, y: 50 }, "snapSECRET-A", { page: "p2", x: 120, y: 120, width: 50, height: 20 })]);

	it("an excerpt on a page with no box, whose source region is covered on another page, is refused; the control is copied", () => {
		expect(elementKept(p5, "A", {})).toBe(true);
		expect(elementKept(p5, "A", { p2: [covered] })).toBe(false);
		// T1: a box anywhere on the source page refuses it too (the snapshot is never refreshed).
		expect(elementKept(p5, "A", { p2: [far] })).toBe(false);
		// What the copy guard looked at before (boxes of the figure's own page only) saw nothing.
		expect(boxesOf({ p2: [covered] }, "p5")).toHaveLength(0);
		void p2;
	});

	it("a picture 2 pt from a box (dropped by every export) is refused too; one far away is copied", () => {
		const pic: PageElement = { id: "I", type: "image", asset: "photoSECRET", x: 100, y: 152, width: 80, height: 40, rotation: 0 };
		const p = page("p1", [pic]);
		expect(elementKept(p, "I", { p1: [far] })).toBe(true);
		expect(elementKept(p, "I", { p1: [covered] })).toBe(false); // the box ends at y 150, the picture starts at 152
		expect(holds(redactPage(p, [covered]), "photoSECRET")).toBe(false);
	});

	it("an element the page does not have is never reported as kept", () => {
		expect(elementKept(page("p1"), "missing", undefined)).toBe(false);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ R2

describe("R2: the header is measured like a text box", () => {
	const header = (text: string): HeaderLayout => ({ text, x: 28, align: "left", y: 13, size: 9, maxWidth: 520, footer: false });
	const svg = (p: Page, h: HeaderLayout, boxes: Redactions["x"]): string => {
		const drawn = redactPage(p, boxes);
		return pageToSvg(drawn, { header: headerAfterRedaction(h, drawn) });
	};

	for (const [name, text] of [
		["capitals", "ACME CORPORATION CONFIDENTIAL CLIENT SECRET-HDR"],
		["CJK", "機密顧客名前機密顧客名前機密顧客名前機密顧客名前 SECRET-HDR"],
	] as const) {
		it(`${name}: a box over the tail only (past the old 0.55 em estimate) leaves the header out; the control keeps it`, () => {
			const h = header(text);
			const old = estimateMeasure(text, h.size) + 2;
			const real = pessimisticMeasure(text, h.size);
			expect(real).toBeGreaterThan(old + 30); // the tail is past what was measured before
			const tail = { x: h.x + old + 10, y: 4, width: 20, height: 16 };
			expect(svg(page("p1"), h, [far])).toContain("SECRET-HDR");
			expect(svg(page("p1"), h, [tail])).not.toContain("SECRET-HDR");
		});
	}

	it("a centred header grows on both sides", () => {
		const h: HeaderLayout = { text: "ACME CORPORATION CONFIDENTIAL SECRET-HDR", x: A4_WIDTH / 2, align: "centre", y: 13, size: 9, maxWidth: 520, footer: false };
		const half = pessimisticMeasure(h.text, h.size) / 2;
		const leftEdge = { x: h.x - half + 2, y: 4, width: 6, height: 16 };
		expect(svg(page("p1"), h, [far])).toContain("SECRET-HDR");
		expect(svg(page("p1"), h, [leftEdge])).not.toContain("SECRET-HDR");
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ R5

describe("R5: excerpts of excerpts of a covered region, at any depth, and cycles", () => {
	// p2 has the box; B (p3) shows the covered region of p2; A (p5) shows the part of p3 that holds B; Z (p6) shows the part of p5 with A.
	const p2 = page("p2");
	const p3 = page("p3", [excerpt("B", { x: 50, y: 300 }, "snapB", { page: "p2", x: 120, y: 120, width: 50, height: 20 })]);
	const p5 = page("p5", [excerpt("A", { x: 50, y: 50 }, "snapSECRET-A", { page: "p3", x: 60, y: 310, width: 50, height: 30 })]);
	const p6 = page("p6", [excerpt("Z", { x: 300, y: 500 }, "snapSECRET-Z", { page: "p5", x: 60, y: 60, width: 40, height: 40 })]);
	const all = [p2, p3, p5, p6];

	it("every excerpt in the chain is left out; with no box in the notebook every one is kept", () => {
		const control = redactPages(all, {});
		expect(holds(control[2], "snapSECRET-A")).toBe(true);
		expect(holds(control[3], "snapSECRET-Z")).toBe(true);
		const out = redactPages(all, { p2: [covered] });
		expect(holds(out[1], "snapB")).toBe(false);
		expect(holds(out[2], "snapSECRET-A")).toBe(false);
		expect(holds(out[3], "snapSECRET-Z")).toBe(false);
	});

	it("a writer given one page knows the chain found over the whole notebook", () => {
		const set = withExcerptChains(all, { p2: [covered] });
		expect(holds(redactPages([p6], set)[0], "snapSECRET-Z")).toBe(false);
		expect(holds(redactPages([p6], withExcerptChains(all, {}))[0], "snapSECRET-Z")).toBe(true);
		// T1: the set knows the notebook's pages, so a box anywhere in it drops an excerpt of any of them, also given one page.
		expect(holds(redactPages([p6], withExcerptChains(all, { p2: [far] }))[0], "snapSECRET-Z")).toBe(false);
		// The chain never becomes a box: page p3 keeps its own ink and gets no black rectangle.
		expect(boxesOf(set, "p3")).toHaveLength(0);
		expect(JSON.parse(JSON.stringify(set))).toEqual({ p2: [covered] });
	});

	it("excerpts that show each other end (a cycle), covered or not", () => {
		const c = page("c", [excerpt("C", { x: 50, y: 50 }, "snapSECRET-C", { page: "d", x: 50, y: 50, width: 40, height: 40 })]);
		const d = page("d", [excerpt("D", { x: 50, y: 50 }, "snapSECRET-D", { page: "c", x: 50, y: 50, width: 40, height: 40 })]);
		const kept = redactPages([c, d], {});
		expect(holds(kept[0], "snapSECRET-C") && holds(kept[1], "snapSECRET-D")).toBe(true);
		const gone = redactPages([c, d], { d: [{ x: 60, y: 60, width: 10, height: 10 }] });
		expect(holds(gone[0], "snapSECRET-C")).toBe(false);
		expect(holds(gone[1], "snapSECRET-D")).toBe(false);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ R6

describe("R6: the width of a character is a true upper bound, unknown ones count as the widest", () => {
	it("the measured widths are at least the real ones (Indic letters, two- and three-em dashes, the bismillah ligature, digraphs)", () => {
		expect(charEm("ஔ")).toBeGreaterThanOrEqual(1.6);
		expect(charEm("ൌ")).toBeGreaterThanOrEqual(1.6);
		expect(charEm("ǅ")).toBeGreaterThanOrEqual(1.3);
		expect(charEm("⸺")).toBeGreaterThanOrEqual(2);
		expect(charEm("⸻")).toBeGreaterThanOrEqual(3);
		expect(charEm("﷽")).toBeGreaterThanOrEqual(4.5);
		// A script or symbol with no checked range: the widest bound.
		expect(charEm("ꙮ")).toBe(charEm("﷽"));
		expect(charEm("\u{1D11E}")).toBe(charEm("﷽"));
		// Control: ordinary text keeps its tighter bounds.
		expect(charEm("a")).toBe(0.9);
		expect(charEm("é")).toBe(1.25);
	});

	it("a text box of three-em dashes: a box over its real last line drops it; the control keeps it", () => {
		const text = `SECRET-dash ${"⸻".repeat(40)}`;
		const el: PageElement = { id: "t", type: "text", x: 100, y: 100, width: 200, text, fontSize: 14, color: "#000000" };
		const realHeight = layoutText(text, 14, 200, (s) => [...s].reduce((n, ch) => n + (ch === "⸻" ? 3 : 0.6) * 14, 0)).height;
		const oldHeight = layoutText(text, 14, 200, (s) => [...s].reduce((n, ch) => n + (ch === "⸻" ? 1.5 : 0.8) * 14, 0)).height;
		expect(realHeight).toBeGreaterThan(oldHeight + 2 * LINE_HEIGHT * 14);
		const lastLine = { x: 120, y: 100 + realHeight - LINE_HEIGHT * 14, width: 40, height: 10 };
		expect(redactBounds(el).maxY).toBeGreaterThan(lastLine.y);
		const p = page("p1", [el]);
		expect(pageToSvg(redactPage(p, [far]))).toContain("SECRET-dash");
		expect(pageToSvg(redactPage(p, [lastLine]))).not.toContain("SECRET-dash");
	});

	it("one bismillah ligature in a narrow box: a box beside it (where the glyph reaches) drops it; the control keeps it", () => {
		const el: PageElement = { id: "t", type: "text", x: 100, y: 100, width: 20, text: "﷽ SECRET-wide", fontSize: 14, color: "#000000" };
		const beside = { x: 100 + 20 + 30, y: 100, width: 10, height: 10 }; // past 1.5 em, within the glyph's 4.5 em
		const p = page("p1", [el]);
		// The narrow box wraps the marker word across lines; the ligature itself is the marker searched.
		expect(pageToSvg(redactPage(p, [far]))).toContain("﷽");
		expect(pageToSvg(redactPage(p, [beside]))).not.toContain("﷽");
		expect(pageToSvg(redactPage(p, [beside]))).not.toContain("SEC");
	});
});
