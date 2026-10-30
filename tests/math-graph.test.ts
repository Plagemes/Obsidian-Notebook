/**
 * Function graphs (#113) and equation outlines (#110), pure parts: adaptive sampling and discontinuities, marching
 * squares, numerical roots, extrema, intersections, derivatives and integrals, the graph scene, the outline path and
 * its tracing, and "Convert to ink".
 */
import { describe, expect, it } from "vitest";
import { contours, simplify } from "../src/math/contour";
import { compileExpr } from "../src/math/expr";
import { formatTick, formatValue, functionOfX, graphMapping, graphScene, niceStep } from "../src/math/graph-scene";
import { derivative, findExtrema, findIntersections, findRoots, integrate } from "../src/math/numeric";
import { formatOutline, outlineBounds, parseOutline, polygonArea, rasterize, scaleOutline, traceCoverage } from "../src/math/outline";
import { clipPolylines, sampleFunction, sampleImplicit, sampleParametric, samplePolar } from "../src/math/sample";
import { outlineToInk } from "../src/math/skeleton";
import { createGraph } from "../src/model/math-elements";
import type { GraphElement } from "../src/model/types";

const view = { xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
const frame = { width: 300, height: 300 };

function f(src: string): (x: number) => number {
	const r = compileExpr(src, { variables: ["x"] });
	if (!r.ok) throw new Error(r.error);
	const v = [0];
	return (x) => ((v[0] = x), r.fn(v));
}

const allPoints = (lines: Array<Array<[number, number]>>) => lines.flat();

describe("sampling", () => {
	it("draws a smooth function as one line, within tolerance of the curve", () => {
		const lines = sampleFunction(Math.sin, view, frame);
		expect(lines).toHaveLength(1);
		for (const [x, y] of lines[0]!) expect(Math.abs(y - Math.sin(x))).toBeLessThan(1e-12);
		// Between samples the chord stays within 0.15 pt (0.005 units here) of the curve.
		const l = lines[0]!;
		for (let i = 0; i + 1 < l.length; i++) {
			const xm = (l[i]![0] + l[i + 1]![0]) / 2;
			expect(Math.abs((l[i]![1] + l[i + 1]![1]) / 2 - Math.sin(xm))).toBeLessThan(0.006);
		}
	});

	it("breaks at the poles of tan and never joins +∞ to −∞", () => {
		const lines = sampleFunction(Math.tan, view, frame);
		// Poles at ±π/2 and ±3π/2 in [−5, 5]: five branches.
		expect(lines.length).toBe(5);
		for (const line of lines) {
			for (let i = 0; i + 1 < line.length; i++) {
				// No segment crosses a pole (a jump from the top band to the bottom band).
				expect(Math.abs(line[i + 1]![1] - line[i]![1])).toBeLessThan(10);
			}
		}
		// Clipped to a band around the view: no huge coordinates.
		for (const [, y] of allPoints(lines)) expect(Math.abs(y)).toBeLessThanOrEqual(15 + 1e-9);
	});

	it("breaks at 1/x (also when a sample lands on 0) and at the jumps of floor", () => {
		expect(sampleFunction(f("1/x"), view, frame).length).toBe(2);
		expect(sampleFunction(f("1/x"), { ...view, xMin: -4, xMax: 4 }, frame, -4, 4).length).toBe(2);
		const steps = sampleFunction(Math.floor, view, frame);
		// floor(5) = 5 is a single point at the right edge.
		expect(steps.length).toBe(11);
		for (const line of steps) {
			const ys = new Set(line.map(([, y]) => y));
			expect(ys.size).toBe(1);
		}
	});

	it("keeps steep but continuous functions in one piece (cube root at 0)", () => {
		expect(sampleFunction(Math.cbrt, view, frame)).toHaveLength(1);
	});

	it("leaves out where the function is undefined", () => {
		const lines = sampleFunction(Math.sqrt, view, frame);
		expect(lines).toHaveLength(1);
		expect(Math.min(...lines[0]!.map(([x]) => x))).toBeGreaterThanOrEqual(0);
		expect(Math.min(...lines[0]!.map(([x]) => x))).toBeLessThan(0.01);
		expect(sampleFunction(() => NaN, view, frame)).toHaveLength(0);
	});

	it("parametric and polar curves", () => {
		const circle = sampleParametric(Math.cos, Math.sin, 0, 2 * Math.PI, view, frame);
		expect(circle).toHaveLength(1);
		for (const [x, y] of circle[0]!) expect(Math.hypot(x, y)).toBeCloseTo(1, 12);
		const cardioid = samplePolar((t) => 1 + Math.cos(t), 0, 2 * Math.PI, view, frame);
		for (const [x, y] of cardioid[0]!) {
			const t = Math.atan2(y, x);
			expect(Math.hypot(x, y)).toBeCloseTo(1 + Math.cos(t), 6);
		}
		const deg = samplePolar(() => 2, 0, 360, view, frame, true);
		for (const [x, y] of deg[0]!) expect(Math.hypot(x, y)).toBeCloseTo(2, 12);
	});

	it("implicit curves by marching squares: a circle closes on itself", () => {
		const lines = sampleImplicit((x, y) => x * x + y * y - 4, view, frame);
		expect(lines).toHaveLength(1);
		const l = lines[0]!;
		expect(l[0]).toEqual(l[l.length - 1]);
		for (const [x, y] of l) expect(Math.abs(Math.hypot(x, y) - 2)).toBeLessThan(0.01);
	});

	it("implicit curves are not drawn across poles", () => {
		// 1/(x − y) = 1 is the line y = x − 1; the sign change across y = x is a pole, not a curve.
		const lines = sampleImplicit((x, y) => 1 / (x - y) - 1, view, frame);
		for (const [x, y] of allPoints(lines)) expect(Math.abs(y - (x - 1))).toBeLessThan(0.05);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("clips polylines to a rectangle", () => {
		const out = clipPolylines([[[-2, 0], [2, 0], [2, 3], [0, 3]]], { xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
		expect(out).toEqual([[[-1, 0], [1, 0]]]);
	});
});

describe("marching squares and simplification", () => {
	it("traces a closed square level line and handles saddles", () => {
		const nx = 5, ny = 5;
		const values = Array.from({ length: nx * ny }, (_, k) => (k % nx >= 1 && k % nx <= 3 && Math.floor(k / nx) >= 1 && Math.floor(k / nx) <= 3 ? 1 : 0));
		const lines = contours({ nx, ny, values }, 0.5);
		expect(lines).toHaveLength(1);
		expect(lines[0]![0]).toEqual(lines[0]![lines[0]!.length - 1]);
		const saddle = contours({ nx: 2, ny: 2, values: [1, 0, 0, 1] }, 0.5);
		expect(saddle).toHaveLength(2);
	});

	it("simplifies collinear points away", () => {
		expect(simplify([[0, 0], [1, 0.001], [2, 0], [3, 0]], 0.01)).toEqual([[0, 0], [3, 0]]);
	});
});

describe("numerical analysis", () => {
	it("finds roots accurately, including touching ones, and not at poles", () => {
		const r = findRoots(f("x^2 - 2"), -3, 3);
		expect(r).toHaveLength(2);
		expect(r[0]).toBeCloseTo(-Math.SQRT2, 12);
		expect(r[1]).toBeCloseTo(Math.SQRT2, 12);
		const sinRoots = findRoots(Math.sin, -7, 7);
		expect(sinRoots.map((x) => x / Math.PI)).toEqual([-2, -1, 0, 1, 2].map((k) => expect.closeTo(k, 10) as unknown as number));
		const touch = findRoots(f("(x - 1)^2"), -3, 3);
		expect(touch).toHaveLength(1);
		expect(touch[0]).toBeCloseTo(1, 5);
		expect(findRoots(Math.tan, 1, 2)).toHaveLength(0);
		expect(findRoots(f("1/x"), -1, 1)).toHaveLength(0);
	});

	it("finds maxima and minima", () => {
		const e = findExtrema(Math.sin, -4, 4);
		expect(e.map((p) => p.kind)).toEqual(["min", "max"]);
		const max = e.find((p) => p.kind === "max" && p.x > 0)!;
		expect(max.x).toBeCloseTo(Math.PI / 2, 6);
		expect(max.y).toBeCloseTo(1, 12);
		const cubic = findExtrema(f("x^3 - 3x"), -3, 3);
		expect(cubic).toHaveLength(2);
		expect(cubic[0]).toMatchObject({ kind: "max" });
		expect(cubic[0]!.x).toBeCloseTo(-1, 6);
		expect(cubic[1]!.y).toBeCloseTo(-2, 10);
		expect(findExtrema(Math.floor, -3, 3)).toHaveLength(0);
	});

	it("finds intersections", () => {
		const xs = findIntersections(f("x^2"), f("x + 2"), -5, 5);
		expect(xs).toHaveLength(2);
		expect(xs[0]).toBeCloseTo(-1, 12);
		expect(xs[1]).toBeCloseTo(2, 12);
	});

	it("derivatives and integrals", () => {
		expect(derivative(Math.sin, 1)).toBeCloseTo(Math.cos(1), 9);
		expect(derivative(f("x^3"), 2)).toBeCloseTo(12, 8);
		expect(integrate(f("x^2"), 0, 3)).toBeCloseTo(9, 10);
		expect(integrate(Math.sin, 0, Math.PI)).toBeCloseTo(2, 10);
		expect(integrate(Math.exp, 1, 0)).toBeCloseTo(-(Math.E - 1), 10);
		expect(integrate(f("1/x"), -1, 1)).toBeNaN();
	});
});

describe("graph scene", () => {
	const g: GraphElement = {
		...createGraph(0, 0, 300, 200),
		view: { xMin: -4, xMax: 4, yMin: -3, yMax: 3 },
		functions: [
			{ id: "f1", kind: "cartesian", color: "#2563eb", expr: "y = x^2 - 1", roots: true, extrema: true, tangent: 1, area: { from: -1, to: 1 }, intersections: true },
			{ id: "f2", kind: "cartesian", color: "#dc2626", expr: "a x", label: "line" },
			{ id: "f3", kind: "implicit", color: "#16a34a", expr: "x^2 + y^2 = 4" },
			{ id: "f4", kind: "cartesian", color: "#000000", expr: "sin(" },
			{ id: "f5", kind: "piecewise", color: "#9333ea", pieces: [{ expr: "-1", when: "x < 0" }, { expr: "1" }] },
		],
		params: [{ name: "a", value: 1, min: -2, max: 2 }],
		table: { fn: "f1", from: 0, step: 1, rows: 3 },
	};

	it("maps graph units to the frame and back", () => {
		const m = graphMapping(g);
		expect(m.toPage(-4, 3)).toEqual([0, 0]);
		expect(m.toPage(4, -3)).toEqual([300, 200]);
		expect(m.toGraph(150, 100)).toEqual([0, 0]);
	});

	it("has grid, axes, curves, marked points, a tangent, a shaded area, a table and a legend with the error", () => {
		const s = graphScene(g);
		expect(graphScene(g)).toBe(s);
		expect(s.grid.length).toBeGreaterThan(5);
		expect(s.axes.length).toBeGreaterThanOrEqual(2);
		expect(s.errors).toEqual([{ fn: "f4", message: expect.stringMatching(/unexpected end/) as unknown as string }]);
		// f1, f2, f3, f5 and the dashed tangent.
		expect(s.curves.filter((c) => !c.dash)).toHaveLength(4);
		expect(s.curves.filter((c) => c.dash)).toHaveLength(1);
		expect(s.areas).toHaveLength(1);
		// Roots ±1, the minimum (0, −1), the tangent point (1, 0) and the intersections of x² − 1 with x and with the step.
		expect(s.points.length).toBeGreaterThanOrEqual(5);
		expect(s.texts.some((t) => t.text === "∫ = " + formatValue(-4 / 3))).toBe(true);
		expect(s.texts.some((t) => t.text === "y = 2x − 2")).toBe(true);
		expect(s.texts.filter((t) => t.text === "line")).toHaveLength(1);
		expect(s.panels).toHaveLength(2);
		for (const p of s.points) {
			expect(p.x).toBeGreaterThanOrEqual(0);
			expect(p.x).toBeLessThanOrEqual(300);
		}
		// The piecewise step breaks at 0.
		const step = s.curves.find((c) => c.color === "#9333ea")!;
		expect(step.lines).toHaveLength(2);
	});

	it("piecewise functions and domain restrictions", () => {
		const r = functionOfX({ id: "p", kind: "piecewise", color: "#000000", pieces: [{ expr: "x^2", when: "x >= 0" }, { expr: "-x" }], min: -1, max: 2 }, new Map(), false);
		if ("error" in r) throw new Error(r.error);
		expect(r.f(-0.5)).toBe(0.5);
		expect(r.f(1.5)).toBe(2.25);
		expect(r.f(3)).toBeNaN();
		const bad = functionOfX({ id: "p", kind: "piecewise", color: "#000000", pieces: [{ expr: "x", when: "x <" }] }, new Map(), false);
		expect("error" in bad).toBe(true);
	});

	it("nice steps and labels", () => {
		expect(niceStep(0.37)).toBe(0.5);
		expect(niceStep(7.6)).toBe(10);
		expect(niceStep(1.2)).toBe(1);
		expect(formatTick(0.30000000000000004, 0.1)).toBe("0.3");
		expect(formatTick(-1e-17, 0.5)).toBe("0");
		expect(formatTick(2500000, 500000)).toBe("2.5e+6");
		expect(formatValue(Math.SQRT2)).toBe("1.414");
		expect(formatValue(-0)).toBe("0");
		expect(formatValue(1200)).toBe("1200");
	});
});

describe("equation outlines", () => {
	it("formats, parses and scales the path grammar, and rejects anything else", () => {
		const d = formatOutline([[[0, 0], [10.004, 0], [10, -5.5]]]);
		expect(d).toBe("M0 0L10 0L10 -5.5Z");
		expect(parseOutline(d)).toEqual([[[0, 0], [10, 0], [10, -5.5]]]);
		for (const bad of ["M0 0L1 1", "M0 0L1 1Z", "m0 0L1 0L1 1Z", "M0 0 L1 0L1 1Z", "M0,0L1 0L1 1Z", "M1e3 0L1 0L1 1Z", "MNaN 0L1 0L1 1Z", "M0 0L1 0L1 1Zx", "<script>"]) {
			expect(parseOutline(bad), bad).toBeNull();
		}
		expect(parseOutline("")).toEqual([]);
		expect(scaleOutline("M0 0L10 0L10 10Z", 0.5, 2)).toBe("M0 0L5 0L5 20Z");
		expect(outlineBounds(parseOutline("M1 2L5 2L5 9Z")!)).toEqual({ minX: 1, minY: 2, maxX: 5, maxY: 9 });
	});

	it("traces a coverage raster into closed polygons in pt, holes included", () => {
		// A 20 × 20 px ring (outer square 2..17, hole 7..12) at 4 px per pt.
		const w = 20, h = 20;
		const cov = new Uint8Array(w * h);
		for (let j = 2; j < 18; j++) for (let i = 2; i < 18; i++) if (!(i >= 7 && i < 13 && j >= 7 && j < 13)) cov[j * w + i] = 255;
		const polys = traceCoverage(cov, w, h, 4, 0.01);
		expect(polys).toHaveLength(2);
		const areas = polys.map((p) => Math.abs(polygonArea(p))).sort((a, b) => b - a);
		expect(areas[0]).toBeCloseTo((16 / 4) ** 2, 0);
		expect(areas[1]).toBeCloseTo((6 / 4) ** 2, 0);
		// Even-odd rasterisation of the traced outline gives the ring back.
		const back = rasterize(polys, 5, 5, 4);
		expect(back.data[10 * back.w + 4]).toBe(1);
		expect(back.data[10 * back.w + 10]).toBe(0);
		expect(back.data[0]).toBe(0);
	});

	it("converts an outline to ink along the middle of its strokes, as wide as they are", () => {
		// A horizontal bar 20 pt long and 2 pt thick, and a ring.
		const bar = formatOutline([[[2, 4], [22, 4], [22, 6], [2, 6]]]);
		const ink = outlineToInk(bar, 24, 10, 6);
		expect(ink).toHaveLength(1);
		const s = ink[0]!;
		expect(s.width).toBeGreaterThan(1.5);
		expect(s.width).toBeLessThan(2.5);
		for (const [, y] of s.points) expect(Math.abs(y - 5)).toBeLessThan(0.4);
		const xs = s.points.map(([x]) => x);
		expect(Math.min(...xs)).toBeLessThan(5);
		expect(Math.max(...xs)).toBeGreaterThan(19);
		const ring: Array<[number, number]> = [];
		const hole: Array<[number, number]> = [];
		for (let k = 0; k < 48; k++) {
			const a = (k / 48) * 2 * Math.PI;
			ring.push([10 + 6 * Math.cos(a), 10 + 6 * Math.sin(a)]);
			hole.push([10 + 4.5 * Math.cos(a), 10 + 4.5 * Math.sin(a)]);
		}
		const loops = outlineToInk(formatOutline([ring, hole]), 20, 20, 6);
		expect(loops.length).toBeGreaterThanOrEqual(1);
		const pts = loops.flatMap((l) => l.points);
		for (const [x, y] of pts) expect(Math.abs(Math.hypot(x - 10, y - 10) - 5.25)).toBeLessThan(0.6);
		expect(outlineToInk("bad", 10, 10)).toEqual([]);
	});
});
