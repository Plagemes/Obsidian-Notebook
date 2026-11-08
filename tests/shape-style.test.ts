/**
 * Filled shapes and dashed or dotted lines (#37): the geometry (dash pattern scaled by the line width, closed shapes, the fill polygon, picking by
 * interior) and every place a shape is drawn: the SVG (and so the HTML and the area export), the PDF, the page raster (PNG) and the thumbnail path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStroke } from "../src/model/document";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, type Page, type Point, type Stroke } from "../src/model/types";
import { rectPoints, ellipsePoints, linePoints } from "../src/ink/shapes";
import { dashPattern, dashRuns, fillAlpha, fillPathD, FILL_TINT_ALPHA, insideShape, isClosedShape, isFilled } from "../src/ink/shape-style";
import { strokeSvgPath, strokePath } from "../src/ink/stroke-shape";
import { lodSvgPath } from "../src/ink/lod";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { drawPageRaster } from "../src/ink/page-raster";
import { areaSvg, planArea } from "../src/ink/export-area";
import { pickStrokeAt } from "../src/ink/colour";

function shape(id: string, points: Point[], extra: Partial<Stroke> = {}, width = 2): Stroke {
	return { ...createStroke("#1e1e1e", width, points, "shape"), id, ...extra };
}

function page(strokes: Stroke[]): Page {
	return { id: "p1", width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "blank", spacing: PAPER_SPACING.blank }, strokes };
}

const rect = () => rectPoints([20, 20], [120, 80]);
const length = (run: readonly Point[]) => run.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - run[i]![0], p[1] - run[i]![1]), 0);

describe("dash pattern", () => {
	it("scales with the line width", () => {
		const a = dashPattern("dashed", 2);
		const b = dashPattern("dashed", 4);
		expect(b.on).toBeCloseTo(2 * a.on);
		expect(b.off).toBeCloseTo(2 * a.off);
		expect(dashPattern("dotted", 6).off).toBeCloseTo(2 * dashPattern("dotted", 3).off);
	});

	it("never goes below the minimum unit, so a hairline still shows dashes", () => {
		expect(dashPattern("dashed", 0.2).on).toBeCloseTo(dashPattern("dashed", 1.5).on);
	});

	it("cuts a straight line into runs of the dash length with gaps between", () => {
		const line = linePoints([0, 0], [100, 0]);
		const { on, off } = dashPattern("dashed", 2);
		const runs = dashRuns(line, "dashed", 2);
		expect(runs.length).toBe(Math.ceil(100 / (on + off)));
		expect(length(runs[0]!)).toBeCloseTo(on, 1);
		expect(runs[1]![0]![0]).toBeCloseTo(on + off, 1);
		for (const r of runs.slice(0, -1)) expect(length(r)).toBeCloseTo(on, 1);
	});

	it("makes a dot (a tiny run) every two widths for a dotted line", () => {
		const runs = dashRuns(linePoints([0, 0], [100, 0]), "dotted", 3);
		expect(runs.length).toBeGreaterThan(15);
		expect(length(runs[0]!)).toBeLessThan(0.1);
		expect(runs[1]![0]![0] - runs[0]![0]![0]).toBeCloseTo(6.05, 1);
	});

	it("goes round the corners of a shape and keeps the path length", () => {
		const runs = dashRuns(rect(), "dashed", 2);
		const total = runs.reduce((n, r) => n + length(r), 0);
		const { on, off } = dashPattern("dashed", 2);
		const perimeter = 2 * (100 + 60);
		expect(total).toBeGreaterThan(perimeter * (on / (on + off)) - on);
		expect(total).toBeLessThan(perimeter * (on / (on + off)) + on);
		// A run that crosses a corner contains it.
		expect(runs.some((r) => r.some((p) => p[0] === 120 && p[1] === 20))).toBe(true);
	});

	it("falls back to a solid line when the pattern would make an absurd number of runs", () => {
		const long = linePoints([0, 0], [400000, 0]);
		expect(dashRuns(long, "dotted", 1)).toHaveLength(1);
	});
});

describe("closed shapes, fill and picking", () => {
	it("knows a closed shape from an open one", () => {
		expect(isClosedShape(rect())).toBe(true);
		expect(isClosedShape(ellipsePoints([50, 50], 30, 20))).toBe(true);
		expect(isClosedShape(linePoints([0, 0], [50, 50]))).toBe(false);
		expect(isClosedShape(rect().slice(0, -1))).toBe(false);
		expect(isClosedShape([[0, 0, 0.5], [1, 1, 0.5]])).toBe(false);
	});

	it("only a closed shape-tool stroke with a fill colour is filled", () => {
		expect(isFilled(shape("a", rect(), { fill: "#2563eb" }))).toBe(true);
		expect(isFilled(shape("a", rect()))).toBe(false);
		expect(isFilled(shape("a", linePoints([0, 0], [50, 50]), { fill: "#2563eb" }))).toBe(false);
		expect(isFilled({ ...createStroke("#000000", 2, rect(), "pen"), fill: "#2563eb" })).toBe(false);
	});

	it("tint is translucent and solid is not", () => {
		expect(fillAlpha({})).toBe(1);
		expect(fillAlpha({ fillTint: true })).toBe(FILL_TINT_ALPHA);
		expect(FILL_TINT_ALPHA).toBeLessThan(0.5);
	});

	it("the fill polygon goes through the points of the shape", () => {
		const d = fillPathD(rect());
		expect(d.startsWith("M20 20")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		expect(d).toContain("L120 20");
	});

	it("picks a filled shape by its interior, a plain one only by its line", () => {
		const filled = shape("f", rect(), { fill: "#2563eb", fillTint: true });
		const plain = shape("p", rect());
		expect(insideShape(rect(), 70, 50)).toBe(true);
		expect(insideShape(rect(), 200, 50)).toBe(false);
		expect(pickStrokeAt([filled], 70, 50, 4)).toBe(filled);
		expect(pickStrokeAt([plain], 70, 50, 4)).toBeNull();
		expect(pickStrokeAt([filled], 70, 200, 4)).toBeNull();
		// The topmost stroke under the point wins.
		const above = shape("a", linePoints([60, 50], [80, 50]));
		expect(pickStrokeAt([filled, above], 70, 50, 4)).toBe(above);
	});
});

describe("the outline path", () => {
	it("a plain shape is exactly what it was before v22", () => {
		const s = shape("a", rect());
		expect(strokeSvgPath(s)).toBe(strokePath(s.points, s.width, true, "shape"));
	});

	it("a dashed or dotted shape is several outlines, a fill changes nothing about the line", () => {
		const solid = strokeSvgPath(shape("a", rect()));
		const dashed = strokeSvgPath(shape("a", rect(), { dash: "dashed" }));
		const dotted = strokeSvgPath(shape("a", rect(), { dash: "dotted" }));
		const count = (d: string) => d.split("M").length - 1;
		expect(count(solid)).toBe(1);
		expect(count(dashed)).toBeGreaterThan(10);
		expect(count(dotted)).toBeGreaterThan(count(dashed));
		expect(strokeSvgPath(shape("a", rect(), { fill: "#ff0000" }))).toBe(solid);
	});

	it("a thicker line has longer dashes (fewer of them)", () => {
		const thin = strokeSvgPath(shape("a", rect(), { dash: "dashed" }, 2)).split("M").length;
		const thick = strokeSvgPath(shape("a", rect(), { dash: "dashed" }, 6)).split("M").length;
		expect(thick).toBeLessThan(thin);
	});

	it("thumbnails use the same dashed outline", () => {
		const s = shape("a", rect(), { dash: "dashed" });
		expect(lodSvgPath(s, s.width, 2)).toBe(strokeSvgPath(s));
	});
});

describe("SVG export (also the HTML export and the area export)", () => {
	const filled = shape("f", rect(), { fill: "#2563eb", fillTint: true, dash: "dashed" });

	it("draws a tint fill under the line, translucent", () => {
		const svg = pageToSvg(page([filled]));
		const fillAt = svg.indexOf('fill="#2563eb" fill-opacity="0.25"');
		const lineAt = svg.indexOf('fill="#1e1e1e"');
		expect(fillAt).toBeGreaterThan(0);
		expect(lineAt).toBeGreaterThan(fillAt);
	});

	it("draws a solid fill without an opacity", () => {
		const svg = pageToSvg(page([shape("s", rect(), { fill: "#ff0000" })]));
		expect(svg).toContain('fill="#ff0000"/>');
		expect(svg).not.toContain("fill-opacity");
	});

	it("draws the dashes as an outline with many sub-paths", () => {
		const svg = pageToSvg(page([shape("d", rect(), { dash: "dotted" })]));
		const d = /<path d="([^"]+)" fill="#1e1e1e"/.exec(svg)![1]!;
		expect(d.split("M").length).toBeGreaterThan(20);
	});

	it("leaves a plain shape and an open filled one as they were", () => {
		const plain = pageToSvg(page([shape("a", rect())]));
		expect(plain).not.toContain("fill-opacity");
		expect((plain.match(/<path d=/g) ?? []).length).toBe(1);
		const open = pageToSvg(page([shape("a", linePoints([0, 0], [50, 50]), { fill: "#ff0000" })]));
		expect(open).not.toContain("#ff0000");
	});

	it("the export of the written area carries the fill and the dashes", () => {
		const p = page([filled]);
		const plan = planArea(p, null)!;
		expect(plan).not.toBeNull();
		const svg = areaSvg(pageToSvg(p, { layers: "ink" }), plan.rect)!;
		expect(svg).toContain('fill-opacity="0.25"');
	});
});

describe("PDF export", () => {
	const decode = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

	it("paints a solid fill and the line, and declares a graphics state for a tint", () => {
		const solid = decode(pagesToPdf([page([shape("s", rect(), { fill: "#ff0000" })])]));
		expect(solid).toContain("1 0 0 rg");
		expect(solid).not.toContain("/GS4");
		const tint = decode(pagesToPdf([page([shape("t", rect(), { fill: "#ff0000", fillTint: true })])]));
		expect(tint).toContain("/GS4 gs");
		expect(tint).toContain(`/GS4 << /Type /ExtGState /ca ${FILL_TINT_ALPHA} >>`);
	});

	it("draws the runs of a dashed line as separate fills", () => {
		const count = (t: string) => (t.match(/ f\b/g) ?? []).length;
		const plain = decode(pagesToPdf([page([shape("a", rect())])]));
		const dashed = decode(pagesToPdf([page([shape("a", rect(), { dash: "dashed" })])]));
		expect(count(dashed)).toBeGreaterThan(count(plain) + 10);
	});
});

describe("page raster (PNG export)", () => {
	interface Call { op: string; style: unknown; alpha: unknown }
	const calls: Call[] = [];

	beforeEach(() => {
		calls.length = 0;
		vi.stubGlobal("Path2D", class { constructor(readonly d?: string) {} });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function ctx(): CanvasRenderingContext2D {
		const state: Record<string, unknown> = { fillStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
		return new Proxy(state, {
			get(t, k: string) {
				if (k in t) return t[k];
				if (k === "fill") return (path: { d?: string }) => calls.push({ op: path?.d ?? "?", style: t.fillStyle, alpha: t.globalAlpha });
				return () => undefined;
			},
			set(t, k: string, v) {
				t[k] = v;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}

	it("fills the shape under its line, with the tint opacity, then draws the line", () => {
		drawPageRaster(ctx(), page([shape("f", rect(), { fill: "#2563eb", fillTint: true })]), 1, { background: null, images: new Map() });
		const fills = calls.filter((c) => c.style === "#2563eb");
		expect(fills).toHaveLength(1);
		expect(fills[0]!.alpha).toBe(FILL_TINT_ALPHA);
		expect(fills[0]!.op).toBe(fillPathD(rect()));
		const lineAt = calls.findIndex((c) => c.style === "#1e1e1e" && c.alpha === 1);
		expect(lineAt).toBeGreaterThan(calls.indexOf(fills[0]!));
	});

	it("draws a dashed line as one path of many runs", () => {
		drawPageRaster(ctx(), page([shape("d", rect(), { dash: "dashed" })]), 1, { background: null, images: new Map() });
		const line = calls.find((c) => c.style === "#1e1e1e")!;
		expect(line.op.split("M").length).toBeGreaterThan(10);
	});
});
