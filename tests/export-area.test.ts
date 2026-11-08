// 0.23 (#280): export of the written area or the selection (pure parts): bounding box, selection cut, SVG of every pen, refusal when empty.
import { describe, expect, it } from "vitest";
import { AREA_MARGIN, areaBounds, areaRect, areaSuffix, areaSvg, planArea, selectionPage } from "../src/ink/export-area";
import { pageToSvg } from "../src/ink/export-svg";
import { HIGHLIGHTER_ALPHA, MARKER_ALPHA } from "../src/ink/stroke-shape";
import { createPage, createStroke, quantizePoint } from "../src/model/document";
import type { Page, StickyElement, TextElement, Tool } from "../src/model/types";
import { line } from "./helpers";

const blank = (): Page => createPage({ width: 400, height: 600 }, { kind: "grid", spacing: 20 });
const pointsOf = (x0: number, y0: number, x1: number, y1: number) =>
	Array.from({ length: 8 }, (_, i) => quantizePoint(x0 + ((x1 - x0) * i) / 7, y0 + ((y1 - y0) * i) / 7, 0.5));

describe("written area bounds", () => {
	it("is null for an empty page", () => {
		expect(areaBounds(blank())).toBeNull();
		expect(planArea(blank(), null)).toBeNull();
	});

	it("covers the ink and the elements, and the rect adds the margin", () => {
		const p = blank();
		p.strokes.push(line(100, 100, 200, 100, 8, 2));
		const text: TextElement = { id: "t", type: "text", x: 50, y: 300, width: 100, text: "Hello", fontSize: 14, color: "#000000" };
		p.elements = [text];
		const b = areaBounds(p)!;
		expect(b.minX).toBeLessThanOrEqual(50);
		expect(b.minY).toBeLessThanOrEqual(100);
		expect(b.maxX).toBeGreaterThanOrEqual(200);
		expect(b.maxY).toBeGreaterThan(300);
		const r = areaRect(b);
		expect(r.x).toBe(b.minX - AREA_MARGIN);
		expect(r.width).toBeCloseTo(b.maxX - b.minX + 2 * AREA_MARGIN);
	});

	it("leaves out hidden ink (unless shown) and the ink a collapsed note keeps hidden", () => {
		const p = blank();
		const far = line(10, 500, 20, 500, 4, 2);
		const hidden = { ...line(10, 20, 20, 20, 4, 2), hidden: true as const };
		p.strokes.push(line(100, 100, 120, 100, 4, 2), hidden, far);
		const sticky: StickyElement = { id: "s", type: "sticky", x: 100, y: 100, width: 80, height: 60, color: "yellow", fontSize: 12, collapsed: true, ink: [far.id] };
		p.elements = [sticky];
		const b = areaBounds(p)!;
		expect(b.maxY).toBeLessThan(300);
		expect(b.minY).toBeGreaterThan(60);
		expect(areaBounds(p, true)!.minY).toBeLessThan(40);
	});
});

describe("selection page", () => {
	it("keeps only the selected items, pinned ink of a selected collapsed note, and drops the background", () => {
		const p = blank();
		p.background = { kind: "image", asset: "a.png" } as never;
		const a = line(10, 10, 60, 10, 5, 2);
		const b = line(300, 400, 350, 400, 5, 2);
		const pinned = line(200, 200, 220, 200, 4, 2);
		const sticky: StickyElement = { id: "s", type: "sticky", x: 190, y: 190, width: 40, height: 40, color: "yellow", fontSize: 12, collapsed: true, ink: [pinned.id] };
		p.strokes.push(a, b, pinned);
		p.elements = [sticky, { id: "t", type: "text", x: 0, y: 500, width: 50, text: "x", fontSize: 10, color: "#000000" }];
		const cut = selectionPage(p, [a], [sticky]);
		expect(cut.strokes.map((s) => s.id)).toEqual([a.id, pinned.id]);
		expect(cut.elements?.map((e) => e.id)).toEqual(["s"]);
		expect(cut.background).toBeUndefined();
		expect(p.background).toBeDefined(); // the document page is untouched
		const plan = planArea(p, { strokes: [a], elements: [] })!;
		expect(plan.rect.x + plan.rect.width).toBeLessThan(100);
		expect(planArea(p, { strokes: [], elements: [] })).toBeNull();
	});
});

describe("SVG of the area", () => {
	const tools: Tool[] = ["pen", "highlighter", "fountain", "brush", "marker"];
	for (const tool of tools) {
		it(`draws a ${tool} stroke as a transparent vector cropped to the area`, () => {
			const p = blank();
			p.strokes.push(createStroke("#2255cc", 4, pointsOf(120, 140, 220, 180), tool));
			const plan = planArea(p, null)!;
			const svg = pageToSvg(plan.page, { paper: false, layers: "ink" });
			expect(svg).not.toContain('fill="#ffffff"/>\n'); // no white sheet
			expect(svg).toContain("<path");
			expect(svg).toContain('fill="#2255cc"');
			if (tool === "highlighter") expect(svg).toContain(`fill-opacity="${HIGHLIGHTER_ALPHA}"`);
			if (tool === "marker") expect(svg).toContain(`fill-opacity="${MARKER_ALPHA}"`);
			const cropped = areaSvg(svg, plan.rect)!;
			expect(cropped).toContain(`viewBox="${Math.round(plan.rect.x * 100) / 100} ${Math.round(plan.rect.y * 100) / 100}`);
			expect(cropped.startsWith("<svg")).toBe(true);
			expect(cropped).not.toContain("<rect width=");
		});
	}

	it("shows the label of a wikilink, not its source", () => {
		const p = blank();
		p.elements = [{ id: "t", type: "text", x: 20, y: 20, width: 300, text: "see [[Some Note|the label]]", fontSize: 14, color: "#000000" }];
		const svg = pageToSvg(planArea(p, null)!.page, { paper: false, layers: "ink" });
		expect(svg).toContain("the label");
		expect(svg).not.toContain("Some Note|");
	});
});

describe("file names", () => {
	it("tells the page area from the selection", () => {
		expect(areaSuffix(3, "page")).toBe(" p3 area");
		expect(areaSuffix(3, "selection")).toBe(" p3 selection");
	});
});
