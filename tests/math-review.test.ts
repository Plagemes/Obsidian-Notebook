/**
 * Review fixes of wave 0.9 (equations and graphs): edits the writer would refuse are never kept, transforms stay
 * within the format's limits, graphs have a work limit, ink on a graph stays bound to it, Markdown export escapes text
 * boxes, unsafe LaTeX commands are refused, the typeset cache is least-recently-used.
 */
import { describe, expect, it } from "vitest";
import { attachedInk, boundGraphId, boundTo } from "../src/ink/attach";
import { transformElement } from "../src/ink/elements";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { graphEditCommand, zoomView } from "../src/ink/graph-ink";
import { LruCache } from "../src/ink/math-render";
import { scaleAbout } from "../src/ink/transform";
import { graphScene } from "../src/math/graph-scene";
import { unsafeLatexCommand } from "../src/math/layout";
import { createBudget, sampleFunction, sampleImplicit } from "../src/math/sample";
import { createDocument } from "../src/model/document";
import { escapeMarkdownLine, pageTexts } from "../src/model/export-markdown";
import { AddElement, History } from "../src/model/history";
import { createGraph, EQUATION_OUTLINE_MAX, GRAPH_MAX_SIDE, normalizeGraph } from "../src/model/math-elements";
import { checkContent, checkElement, MAX_FONT_SIZE, parse, serialize, serializeChecked } from "../src/model/serialize";
import type { EquationElement, GraphElement, TextElement } from "../src/model/types";
import { line } from "./helpers";

const stamp = new Date("2026-10-30T10:00:00.000Z");

describe("edits the writer would refuse are never kept", () => {
	it("normalises graph drafts: ranges in order, empty areas removed, steps and tables checked", () => {
		const g = createGraph(0, 0, 200, 100);
		const bad: GraphElement = {
			...g,
			functions: [
				{ id: "p", kind: "parametric", color: "#000000", x: "cos(t)", y: "sin(t)", min: 5, max: 1 },
				{ id: "q", kind: "polar", color: "#000000", expr: "1", min: 2, max: 2 },
				{ id: "c", kind: "cartesian", color: "#000000", expr: "x", area: { from: 1, to: 1 }, tangent: NaN, width: 0 },
			],
			params: [{ name: "a", value: 1, min: 3, max: -3, step: -1 }, { name: "sin", value: 1, min: 0, max: 1 }],
			xStep: 0, table: { fn: "c", from: 0, step: 0, rows: 3 },
		};
		expect(checkElement(bad)).not.toBeNull();
		const fixed = normalizeGraph(bad);
		expect(checkElement(fixed)).toBeNull();
		expect(fixed.functions[0]).toMatchObject({ min: 1, max: 5 });
		expect(fixed.functions[1]!.min).toBeUndefined();
		expect(fixed.functions[2]!.area).toBeUndefined();
		expect(fixed.functions[2]!.tangent).toBeUndefined();
		expect(fixed.params).toEqual([{ name: "a", value: 1, min: -3, max: 3 }]);
		expect(fixed.xStep).toBeUndefined();
		expect(fixed.table).toBeUndefined();
	});

	it("the history refuses (and undoes) a command whose result the writer rejects, with a message", () => {
		const doc = createDocument(stamp);
		const refused: string[] = [];
		const history = new History(() => doc, 500, checkContent, (m) => refused.push(m));
		const good = createGraph(10, 10);
		expect(history.execute(new AddElement(doc.pages[0]!.id, good, 0))).toBe(true);
		const bad = { ...createGraph(10, 10), functions: [{ id: "f", kind: "parametric", color: "#000000", x: "t", y: "t", min: 3, max: 1 }] } as GraphElement;
		expect(history.execute(new AddElement(doc.pages[0]!.id, bad, 1))).toBe(false);
		expect(refused).toHaveLength(1);
		expect(doc.pages[0]!.elements).toEqual([good]);
		expect(history.canUndo()).toBe(true);
		history.undo();
		expect(history.canUndo()).toBe(false);
		expect(serializeChecked(doc).ok).toBe(true);
		expect(checkContent(doc)).toBeNull();
	});
});

describe("transforms stay within the format's limits", () => {
	const eq: EquationElement = { id: "e", type: "equation", x: 0, y: 0, width: 50, height: 20, latex: "x", fontSize: 16, color: "#000000", outline: "M0 0L10 0L10 10Z" };

	it("an equation or a text box never scales past MAX_FONT_SIZE", () => {
		const big = transformElement(eq, scaleAbout(100, 100, 0, 0)) as EquationElement;
		expect(big.fontSize).toBe(MAX_FONT_SIZE);
		expect(big.width).toBe(50 * MAX_FONT_SIZE / 16);
		expect(checkElement(big)).toBeNull();
		const text: TextElement = { id: "t", type: "text", x: 0, y: 0, width: 100, text: "hi", fontSize: 30, color: "#000000" };
		const t2 = transformElement(text, scaleAbout(50, 50, 0, 0)) as TextElement;
		expect(t2.fontSize).toBe(MAX_FONT_SIZE);
		expect(checkElement(t2)).toBeNull();
	});

	it("a scaled outline the writer would refuse (too long) is dropped", () => {
		const pts: string[] = [];
		for (let i = 0; i < 140_000; i++) pts.push(`L${i % 9 + 1} ${i % 7 + 1}`);
		const outline = `M0 0${pts.join("")}Z`;
		expect(outline.length).toBeLessThan(EQUATION_OUTLINE_MAX);
		const scaled = transformElement({ ...eq, outline }, scaleAbout(1.37, 1.37, 0, 0)) as EquationElement;
		expect(scaled.outline).toBeUndefined();
		expect(checkElement(scaled)).toBeNull();
	});

	it("a graph frame never grows past GRAPH_MAX_SIDE; a larger one in a file is clamped and counted (strict write refuses it)", () => {
		const g = createGraph(0, 0, 300, 200);
		const huge = transformElement(g, scaleAbout(100, 100, 0, 0)) as GraphElement;
		expect(huge.width).toBe(GRAPH_MAX_SIDE);
		const doc = createDocument(stamp);
		doc.pages[0]!.elements = [{ ...g, width: 100_000 }];
		expect(serializeChecked(doc).ok).toBe(false);
		const r = parse(serialize(doc));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dropped).toBe(1);
			expect((r.doc.pages[0]!.elements![0] as GraphElement).width).toBe(GRAPH_MAX_SIDE);
		}
	});
});

describe("graphs have a work limit", () => {
	it("twelve very fast oscillations on the largest frame finish quickly, simplified", () => {
		const g: GraphElement = {
			...createGraph(0, 0, GRAPH_MAX_SIDE, GRAPH_MAX_SIDE),
			functions: Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, kind: "cartesian" as const, color: "#000000", expr: `sin(99999x + ${i})`, roots: true as const, extrema: true as const, intersections: true as const })),
		};
		const t0 = performance.now();
		const s = graphScene(g);
		const ms = performance.now() - t0;
		expect(s.simplified).toBe(true);
		expect(s.curves.length).toBeGreaterThanOrEqual(12);
		expect(s.texts.some((t) => t.text === "≈")).toBe(true);
		expect(ms).toBeLessThan(1500);
	});

	it("sampling stops refining when the budget is spent, and implicit grids are bounded", () => {
		const budget = createBudget(500);
		const lines = sampleFunction((x) => Math.sin(1000 * x), { xMin: -5, xMax: 5, yMin: -2, yMax: 2 }, { width: 4000, height: 300, budget });
		expect(budget.simplified).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
		let calls = 0;
		const b2 = createBudget(1_000_000);
		sampleImplicit((x, y) => (calls++, x * x + y * y - 1), { xMin: -2, xMax: 2, yMin: -2, yMax: 2 }, { width: 4000, height: 1, budget: b2 });
		expect(calls).toBeLessThan(410 * 410 * 2);
		expect(sampleFunction(Math.sin, { xMin: -5, xMax: 5, yMin: -2, yMax: 2 }, { width: 300, height: 200 })).toHaveLength(1);
	});
});

describe("ink on a graph stays bound to it", () => {
	it("is bound by id when the view moves, comes back exactly after zooming out again, and is clipped in exports", () => {
		const doc = createDocument(stamp);
		const page = doc.pages[0]!;
		const g = createGraph(100, 100, 200, 200);
		const ink = { ...line(150, 150, 160, 160), id: "ink" };
		page.elements = [g];
		page.strokes = [ink];
		const history = new History(() => doc);
		// Zoom in 10× about the frame's corner: the ink leaves the frame.
		const zoomed: GraphElement = { ...g, view: zoomView(g, 10, 100, 100) };
		history.execute(graphEditCommand(page, g, zoomed, [ink])!);
		const moved = page.strokes[0]!;
		expect(boundGraphId(moved)).toBe(g.id);
		expect(boundTo(moved, zoomed)).toBe(true);
		expect(moved.points[0]![0]).toBeGreaterThan(300);
		// Still the graph's ink although it is outside the frame.
		expect(attachedInk(page.strokes, page.elements, [zoomed])).toEqual([moved]);
		const back: GraphElement = { ...zoomed, view: g.view };
		history.execute(graphEditCommand(page, zoomed, back, [moved])!);
		expect(page.strokes[0]!.points).toEqual(ink.points);
		expect(serializeChecked(doc).ok).toBe(true);
		// Exports clip it to the frame.
		history.undo();
		const svg = pageToSvg(page, { paper: false });
		expect(svg).toMatch(/<path d="[^"]+" fill="#1e1e1e" clip-path="url\(#nb-graph-1\)"\/>/);
		const pdf = new TextDecoder().decode(pagesToPdf([page], { paper: false }));
		expect(pdf).toContain("q 100 100 200 200 re W n");
	});
});

describe("Markdown export escapes text boxes", () => {
	it("keeps links, embeds, tags, maths, comments, HTML and tables literal", () => {
		expect(escapeMarkdownLine("[[Note]] ![[img.png]] #tag $x$ %%c%% <b>&amp;</b> a|b ^id ==hi== ~~no~~ `code` *em*"))
			.toBe("\\[\\[Note\\]\\] \\!\\[\\[img.png\\]\\] \\#tag \\$x\\$ \\%\\%c\\%\\% \\<b\\>\\&amp;\\</b\\> a\\|b \\^id \\=\\=hi\\=\\= \\~\\~no\\~\\~ \\`code\\` \\*em\\*");
		expect(escapeMarkdownLine("- item")).toBe("\\- item");
		expect(escapeMarkdownLine("```")).toBe("\\`\\`\\`");
		const t: TextElement = { id: "t", type: "text", x: 0, y: 0, width: 100, text: "$$\n# x", fontSize: 12, color: "#000000" };
		expect(pageTexts({ elements: [t] })).toEqual(["\\$\\$  \n\\# x"]);
	});
});

describe("LaTeX and the typeset cache", () => {
	it("refuses commands that link out, style the page or load extensions", () => {
		for (const bad of ["\\href{https://x}{a}", "x \\url{y}", "\\style{color:red}{x}", "\\class{a}{x}", "\\cssId{a}{x}", "\\require{action}", "\\unicode{x41}", "\\html{a}", "\\data{a}{b}"]) {
			expect(unsafeLatexCommand(bad), bad).not.toBeNull();
		}
		expect(unsafeLatexCommand("\\frac{a}{b} + \\sqrt{x} \\hrefx")).toBeNull();
	});

	it("keeps the most recently used outlines", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.get("a")).toBe(1);
		c.set("c", 3);
		expect(c.get("b")).toBeUndefined();
		expect(c.get("a")).toBe(1);
		expect(c.size).toBe(2);
	});
});
