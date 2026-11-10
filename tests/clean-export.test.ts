import { describe, expect, it } from "vitest";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { cleanPageForExport, cleanPagesForExport, hasCleanableContent, resolveCleanOptions } from "../src/model/clean-export";
import { createMarker } from "../src/model/markers";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, type Page, type PageElement, type Stroke, type StickyElement, type TextElement } from "../src/model/types";

function stroke(id: string): Stroke {
	return { id, tool: "pen", color: "#1e1e1e", width: 2, render: 1, points: [[50, 60, 0.5], [90, 80, 0.5], [120, 70, 0.5]] };
}
const text: TextElement = { id: "t1", type: "text", x: 40, y: 200, width: 200, text: "Lecture", fontSize: 14, color: "#000000" };
const sticky = (id: string, extra: Partial<StickyElement> = {}): StickyElement => ({ id, type: "sticky", x: 300, y: 300, width: 100, height: 80, color: "#ffd966", fontSize: 12, ...extra });

function page(elements?: PageElement[], strokes: Stroke[] = [stroke("a"), stroke("b")]): Page {
	return { id: "p1", width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled }, strokes, ...(elements ? { elements } : {}) };
}
const comment = { id: "c1", region: { x: 10, y: 10, width: 50, height: 20 }, text: "hm", author: "tab", created: 1 };

describe("cleanPageForExport", () => {
	it("returns the very same page when there is nothing to leave out", () => {
		const p = page([text]);
		expect(cleanPageForExport(p)).toBe(p);
		expect(cleanPageForExport(page())).toBeDefined();
		expect(hasCleanableContent(p)).toBe(false);
	});

	it("leaves out every marker kind and keeps the other elements", () => {
		const markers = (["gap", "question", "important", "critical", "star", "homework"] as const).map((k, i) => createMarker(k, 10 + i, 10));
		const box: PageElement = { id: "b1", type: "box", kind: "definition", x: 10, y: 400, width: 100, height: 50 };
		const p = page([text, ...markers, box]);
		const out = cleanPageForExport(p);
		expect(out.elements).toEqual([text, box]);
		expect(hasCleanableContent(p)).toBe(true);
	});

	it("can keep the markers", () => {
		const p = page([text, createMarker("gap", 10, 10)]);
		expect(cleanPageForExport(p, { markers: false })).toBe(p);
	});

	it("drops margin comments", () => {
		const p = { ...page([text]), comments: [comment] };
		const out = cleanPageForExport(p);
		expect(out.comments).toBeUndefined();
		expect(out.elements).toEqual([text]);
		expect(cleanPageForExport(p, { comments: false })).toBe(p);
	});

	it("drops a collapsed sticky note with the ink it hides, and keeps the other ink", () => {
		const p = page([sticky("s1", { collapsed: true, ink: ["a"] })]);
		const out = cleanPageForExport(p);
		expect(out.elements).toBeUndefined();
		expect(out.strokes.map((s) => s.id)).toEqual(["b"]);
	});

	it("keeps open notes by default and leaves them out on request (the ink written over them stays)", () => {
		const p = page([sticky("open"), sticky("closed", { collapsed: true, ink: ["a"] })]);
		expect(cleanPageForExport(p).elements?.map((e) => e.id)).toEqual(["open"]);
		const all = cleanPageForExport(p, { openStickies: true });
		expect(all.elements).toBeUndefined();
		expect(all.strokes.map((s) => s.id)).toEqual(["b"]);
		const onlyOpen = cleanPageForExport(p, { openStickies: true, collapsedStickies: false });
		expect(onlyOpen.elements?.map((e) => e.id)).toEqual(["closed"]);
		expect(onlyOpen.strokes.map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("never mutates the document", () => {
		const p = { ...page([text, createMarker("gap", 1, 1), sticky("s", { collapsed: true, ink: ["a"] })]), comments: [comment] };
		const before = JSON.stringify(p);
		const elements = p.elements;
		const strokes = p.strokes;
		cleanPageForExport(p, { openStickies: true });
		cleanPagesForExport([p, p]);
		expect(JSON.stringify(p)).toBe(before);
		expect(p.elements).toBe(elements);
		expect(p.strokes).toBe(strokes);
	});

	it("keeps the page id, order and unchanged pages", () => {
		const a = page([text]);
		const b = { ...page([createMarker("star", 1, 1)]), id: "p2" };
		const out = cleanPagesForExport([a, b]);
		expect(out[0]).toBe(a);
		expect(out[1]?.id).toBe("p2");
		expect(out[1]?.elements).toBeUndefined();
	});

	it("resolves defaults", () => {
		expect(resolveCleanOptions()).toEqual({ markers: true, comments: true, collapsedStickies: true, openStickies: false, tapes: true, struck: false });
	});

	it("a clean page is drawn without the markers, and a page without study layers is byte-identical", () => {
		const plain = page([text]);
		expect(pageToSvg(cleanPageForExport(plain), { paper: true })).toBe(pageToSvg(plain, { paper: true }));
		expect(Array.from(pagesToPdf([cleanPageForExport(plain)], { paper: true }))).toEqual(Array.from(pagesToPdf([plain], { paper: true })));
		const marked = page([text, createMarker("gap", 80, 80)]);
		expect(pageToSvg(cleanPageForExport(marked), { paper: true })).toBe(pageToSvg(plain, { paper: true }));
		expect(pageToSvg(marked, { paper: true })).not.toBe(pageToSvg(plain, { paper: true }));
	});
});
