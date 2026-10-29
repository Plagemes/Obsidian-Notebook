import { describe, expect, it } from "vitest";
import { growForInfinite } from "../src/ink/infinite";
import { elementBounds, elementsInLasso, hitElement, transformElement } from "../src/ink/elements";
import { strokeHit } from "../src/ink/hit-test";
import { isHold, recognizeShape, type RecognizedShape } from "../src/ink/recognize";
import { normalizeRulerAngle, projectToRuler, rulerEdge, rulerFromTwoTouches, rulerTicks } from "../src/ink/ruler";
import {
	arrowPoints, constrain, ellipsePoints, linePoints, polygonPoints, rectPoints, SHAPE_STEP,
} from "../src/ink/shapes";
import { strokeOutline } from "../src/ink/stroke-shape";
import { layoutText, textElementBounds } from "../src/ink/text-layout";
import { rotateAbout, scaleAbout, translate } from "../src/ink/transform";
import type { ImageElement, PageElement, Point, Stroke, TextElement } from "../src/model/types";
import { MM } from "../src/model/types";

type V = [number, number];

/** Deterministic pseudo-random numbers in [-1, 1). */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 0x80000000) - 1;
	};
}

const asPoints = (v: readonly V[]): Point[] => v.map(([x, y]) => [x, y, 0.5]);

/** Hand-like sampling of a polyline: ~2 pt steps, jitter, and a slow wobble. */
function trace(vertices: readonly V[], closed: boolean, jitter = 0, seed = 1, wobble = 0): Point[] {
	const rand = rng(seed);
	const verts = closed ? [...vertices, vertices[0]!] : vertices;
	const out: V[] = [];
	for (let i = 1; i < verts.length; i++) {
		const a = verts[i - 1]!, b = verts[i]!;
		const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
		for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
	}
	return asPoints(out.map(([x, y], i) => [
		x + jitter * rand() + wobble * Math.sin(i / 9),
		y + jitter * rand() + wobble * Math.cos(i / 11),
	]));
}

function ellipseTrace(c: V, rx: number, ry: number, rot = 0, jitter = 0, seed = 1, turns = 1.03, wobble = 0): Point[] {
	const rand = rng(seed);
	const n = 90;
	const out: V[] = [];
	for (let i = 0; i <= n * turns; i++) {
		const t = (2 * Math.PI * i) / n + 0.7;
		const k = 1 + wobble * Math.sin(2 * t + 1);
		const x = rx * k * Math.cos(t), y = ry * k * Math.sin(t);
		out.push([
			c[0] + x * Math.cos(rot) - y * Math.sin(rot) + jitter * rand(),
			c[1] + x * Math.sin(rot) + y * Math.cos(rot) + jitter * rand(),
		]);
	}
	return asPoints(out);
}

const rotateV = (p: V, a: number, c: V): V => [
	c[0] + (p[0] - c[0]) * Math.cos(a) - (p[1] - c[1]) * Math.sin(a),
	c[1] + (p[0] - c[0]) * Math.sin(a) + (p[1] - c[1]) * Math.cos(a),
];

function stroke(points: Point[], width = 2): Stroke {
	return { id: "s", tool: "shape", color: "#000000", width, points };
}

describe("shape generators", () => {
	it("lines include both ends and are dense", () => {
		const p = linePoints([0, 0], [100, 0]);
		expect(p[0]).toEqual([0, 0, 0.5]);
		expect(p[p.length - 1]).toEqual([100, 0, 0.5]);
		for (let i = 1; i < p.length; i++) expect(Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1])).toBeLessThanOrEqual(SHAPE_STEP + 0.02);
		expect(linePoints([5, 5], [5, 5]).length).toBe(2);
	});

	it("closed shapes start where they end, with dense sampling", () => {
		const shapes = [
			rectPoints([10, 10], [110, 60]),
			ellipsePoints([50, 50], 40, 20, 0.3),
			polygonPoints([[0, 0], [50, 0], [25, 40]], true),
		];
		for (const p of shapes) {
			expect(p[0]).toEqual(p[p.length - 1]);
			for (let i = 1; i < p.length; i++) {
				expect(Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1])).toBeLessThanOrEqual(SHAPE_STEP + 0.02);
			}
		}
		const open = polygonPoints([[0, 0], [50, 0], [25, 40]], false);
		expect(open[0]).not.toEqual(open[open.length - 1]);
	});

	it("rectangle covers its four corners and stays axis-aligned", () => {
		const p = rectPoints([100, 80], [10, 20]);
		for (const c of [[100, 80], [10, 80], [10, 20], [100, 20]]) expect(p.some(([x, y]) => x === c[0] && y === c[1])).toBe(true);
		expect(Math.min(...p.map((q) => q[0]))).toBe(10);
		expect(Math.max(...p.map((q) => q[1]))).toBe(80);
	});

	it("ellipse points lie on the ellipse and are quantized", () => {
		const p = ellipsePoints([100, 100], 60, 30, Math.PI / 6);
		const cos = Math.cos(Math.PI / 6), sin = Math.sin(Math.PI / 6);
		for (const [x, y] of p) {
			const lx = (x - 100) * cos + (y - 100) * sin, ly = -(x - 100) * sin + (y - 100) * cos;
			expect(Math.abs(Math.hypot(lx / 60, ly / 30) - 1)).toBeLessThan(0.01);
			expect(Math.round(x * 100) / 100).toBe(x);
		}
		expect(p.length).toBeGreaterThan(40);
	});

	it("an arrow is a single polyline that ends with a head at the tip", () => {
		const p = arrowPoints([0, 0], [100, 0], 20);
		expect(p[0]).toEqual([0, 0, 0.5]);
		const tipIdx = p.findIndex(([x, y]) => x === 100 && y === 0);
		expect(tipIdx).toBeGreaterThan(0);
		// Both wings are behind the tip (smaller x) and on opposite sides of the shaft.
		const wings = p.slice(tipIdx).filter(([x, y]) => Math.hypot(x - 100, y) > 19.9);
		expect(wings.length).toBe(2);
		expect(wings.every(([x]) => x < 100)).toBe(true);
		expect(wings[0]![1]! * wings[1]![1]!).toBeLessThan(0);
		// Head capped at 60 % of a short shaft.
		const short = arrowPoints([0, 0], [10, 0], 50);
		expect(Math.min(...short.map((q) => q[0]))).toBeGreaterThanOrEqual(-0.01);
		expect(Math.max(...short.map((q) => Math.abs(q[1])))).toBeLessThanOrEqual(6);
	});

	it("generated strokes are hit by an eraser crossing their edge and render with constant width", () => {
		const s = stroke(rectPoints([0, 0], [100, 60]));
		expect(strokeHit(s, 50, -10, 50, 10, 3)).toBe(true); // crosses the top edge
		expect(strokeHit(s, 50, 20, 50, 40, 3)).toBe(false); // wanders inside the rectangle, touches nothing
		const outline = strokeOutline(linePoints([0, 0], [100, 0]), 4, true, "shape");
		const ys = outline.map((p) => p[1]!);
		expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 0);
		expect(outline.length).toBeGreaterThan(10);
		// Pen and highlighter outlines are unchanged by the new tool.
		expect(strokeOutline(linePoints([0, 0], [100, 0]), 4, true, "pen")).not.toEqual(outline);
	});
});

describe("constrain", () => {
	it("returns the end point unchanged without the flag", () => {
		expect(constrain([0, 0], [37, 11], "line", false)).toEqual([37, 11]);
	});

	it("snaps lines and arrows to 15° steps and keeps the length", () => {
		const [x, y] = constrain([10, 10], [10 + 100 * Math.cos(0.1), 10 + 100 * Math.sin(0.1)], "line");
		expect(x).toBeCloseTo(110, 6);
		expect(y).toBeCloseTo(10, 6);
		const [x2, y2] = constrain([0, 0], [80, 83], "arrow");
		expect(Math.hypot(x2, y2)).toBeCloseTo(Math.hypot(80, 83), 6);
		expect(Math.atan2(y2, x2)).toBeCloseTo(Math.PI / 4, 6);
		const [x3, y3] = constrain([0, 0], [0.5, -50], "line");
		expect(x3).toBeCloseTo(0, 6);
		expect(y3).toBeCloseTo(-Math.hypot(0.5, 50), 6);
	});

	it("makes squares and circles with the larger drag, in any direction", () => {
		expect(constrain([0, 0], [100, 40], "rect")).toEqual([100, 100]);
		expect(constrain([0, 0], [-30, 80], "ellipse")).toEqual([-80, 80]);
		expect(constrain([50, 50], [20, 45], "rect")).toEqual([20, 20]);
	});
});

function expectShape(r: RecognizedShape | null, kind: RecognizedShape["kind"]): RecognizedShape {
	expect(r).not.toBeNull();
	expect(r!.kind).toBe(kind);
	expect(r!.score).toBeGreaterThan(0);
	expect(r!.score).toBeLessThanOrEqual(1);
	expect(r!.points.length).toBe(1);
	expect(r!.points[0]!.length).toBeGreaterThan(1);
	return r!;
}

function bounds(p: readonly Point[]) {
	return {
		minX: Math.min(...p.map((q) => q[0])), maxX: Math.max(...p.map((q) => q[0])),
		minY: Math.min(...p.map((q) => q[1])), maxY: Math.max(...p.map((q) => q[1])),
	};
}

describe("shape recognition: clean shapes", () => {
	it("recognizes a line, snapping the ends", () => {
		const r = expectShape(recognizeShape(trace([[10, 10], [210, 60]], false, 0.8, 3, 1.2)), "line");
		const p = r.points[0]!;
		expect(Math.hypot(p[0]![0] - 10, p[0]![1] - 10)).toBeLessThan(3);
		expect(Math.hypot(p[p.length - 1]![0] - 210, p[p.length - 1]![1] - 60)).toBeLessThan(3);
		// It is exactly straight.
		const slope = (60 - 10) / (210 - 10);
		const y0 = p[0]![1]!, x0 = p[0]![0]!;
		for (const [x, y] of p) expect(Math.abs(y - (y0 + (x - x0) * ((p[p.length - 1]![1]! - y0) / (p[p.length - 1]![0]! - x0))))).toBeLessThan(0.02);
		expect(slope).toBeGreaterThan(0);
	});

	it("recognizes vertical and short lines but not a tiny scribble", () => {
		expectShape(recognizeShape(trace([[50, 20], [52, 120]], false, 0.5, 2)), "line");
		expectShape(recognizeShape(trace([[0, 0], [30, 0]], false, 0.2, 2)), "line");
		expect(recognizeShape(trace([[0, 0], [10, 3]], false, 0, 2))).toBeNull();
		expect(recognizeShape(asPoints([[5, 5]]))).toBeNull();
		expect(recognizeShape([])).toBeNull();
	});

	it("recognizes axis-aligned rectangles and squares, with noise and a gap at the closing", () => {
		const r = expectShape(recognizeShape(trace([[20, 30], [220, 30], [220, 130], [20, 130]], true, 1, 4, 1.5)), "rectangle");
		const b = bounds(r.points[0]!);
		expect(b.minX).toBeCloseTo(20, -1);
		expect(b.maxX).toBeCloseTo(220, -1);
		expect(b.minY).toBeCloseTo(30, -1);
		expect(b.maxY).toBeCloseTo(130, -1);
		// Closed output.
		expect(r.points[0]![0]).toEqual(r.points[0]![r.points[0]!.length - 1]);
		expectShape(recognizeShape(trace([[0, 0], [100, 0], [100, 100], [0, 100]], true, 1, 5, 1)), "rectangle");
		// Open with a gap (does not quite return to the start).
		const gap = trace([[0, 0], [100, 0], [100, 100], [0, 100], [0, 12]], false, 0.6, 6);
		expectShape(recognizeShape(gap), "rectangle");
		// Overshoot at the start.
		const over = trace([[0, 0], [100, 0], [100, 100], [0, 100], [0, -8]], false, 0.6, 7);
		expectShape(recognizeShape(over), "rectangle");
	});

	it("recognizes rotated rectangles", () => {
		for (const deg of [20, 45, 75, -30]) {
			const c: V = [150, 150];
			const a = (deg * Math.PI) / 180;
			const verts = ([[90, 110], [210, 110], [210, 190], [90, 190]] as V[]).map((q) => rotateV(q, a, c));
			expectShape(recognizeShape(trace(verts, true, 0.8, 8, 1)), "rectangle");
		}
	});

	it("recognizes circles and ellipses, with the right centre and radii", () => {
		const c = expectShape(recognizeShape(ellipseTrace([100, 100], 50, 50, 0, 0.8, 9, 1.04, 0.03)), "ellipse");
		const b = bounds(c.points[0]!);
		expect((b.minX + b.maxX) / 2).toBeCloseTo(100, -1);
		expect((b.maxX - b.minX) / 2).toBeGreaterThan(46);
		expect((b.maxX - b.minX) / 2).toBeLessThan(54);
		const e = expectShape(recognizeShape(ellipseTrace([200, 80], 90, 35, 0.5, 0.8, 10, 1.02, 0.02)), "ellipse");
		expect(e.points[0]![0]).toEqual(e.points[0]![e.points[0]!.length - 1]);
		expectShape(recognizeShape(ellipseTrace([0, 0], 30, 30, 0, 0.3, 11, 0.97)), "ellipse");
		expectShape(recognizeShape(ellipseTrace([0, 0], 120, 20, -0.7, 0.5, 12)), "ellipse");
	});

	it("recognizes triangles (equilateral, scalene, rotated)", () => {
		expectShape(recognizeShape(trace([[100, 20], [180, 160], [20, 160]], true, 0.8, 13, 1)), "triangle");
		expectShape(recognizeShape(trace([[0, 0], [160, 30], [40, 90]], true, 0.8, 14, 1)), "triangle");
		const c: V = [100, 100];
		const verts = ([[100, 30], [170, 150], [30, 150]] as V[]).map((q) => rotateV(q, 1.1, c));
		expectShape(recognizeShape(trace(verts, true, 0.8, 15, 1)), "triangle");
		// Start in the middle of a side.
		expectShape(recognizeShape(trace([[100, 160], [20, 160], [100, 20], [180, 160]], true, 0.6, 16)), "triangle");
	});

	it("recognizes an arrow drawn in one stroke", () => {
		const tail: V = [20, 100], tip: V = [220, 100];
		const w1: V = [195, 84], w2: V = [195, 116];
		const r = expectShape(recognizeShape(trace([tail, tip, w1, tip, w2], false, 0.6, 17)), "arrow");
		const p = r.points[0]!;
		expect(Math.hypot(p[0]![0] - 20, p[0]![1] - 100)).toBeLessThan(4);
		expect(p.some(([x, y]) => Math.hypot(x - 220, y - 100) < 3)).toBe(true);
		// Rotated.
		const verts = ([tail, tip, w1, tip, w2] as V[]).map((q) => rotateV(q, 2.2, [120, 100]));
		expectShape(recognizeShape(trace(verts, false, 0.6, 18)), "arrow");
	});

	it("scores a cleaner shape higher", () => {
		const clean = recognizeShape(trace([[0, 0], [200, 0], [200, 100], [0, 100]], true, 0.2, 19, 0))!;
		const sloppy = recognizeShape(trace([[0, 0], [200, 0], [200, 100], [0, 100]], true, 1.5, 19, 2.5))!;
		expect(clean.kind).toBe("rectangle");
		expect(sloppy.kind).toBe("rectangle");
		expect(clean.score).toBeGreaterThan(sloppy.score);
	});
});

/** Densified curve through control points. */
function curve(f: (t: number) => V, n: number, jitter = 0.4, seed = 1): Point[] {
	const rand = rng(seed);
	return asPoints(Array.from({ length: n + 1 }, (_, i): V => {
		const [x, y] = f(i / n);
		return [x + jitter * rand(), y + jitter * rand()];
	}));
}

const deg = (d: number) => (d * Math.PI) / 180;

describe("shape recognition: handwriting is left alone", () => {
	const s = curve((t) => {
		if (t < 0.5) { const a = deg(-20 - 250 * (t / 0.5)); return [10 * Math.cos(a), 10 * Math.sin(a)]; }
		const a = deg(-90 + 250 * ((t - 0.5) / 0.5));
		return [10 * Math.cos(a), 20 + 10 * Math.sin(a)];
	}, 120);

	const e = curve((t) => {
		if (t < 0.15) return [-10 + (20 * t) / 0.15, 0];
		const a = deg(-300 * ((t - 0.15) / 0.85));
		return [10 * Math.cos(a), 10 * Math.sin(a)];
	}, 120);

	// "m": stem down, back up and over two humps.
	const arch = (x0: number, n = 16): V[] => Array.from({ length: n + 1 }, (_, i): V => [x0 + (15 * i) / n, 6 - 6 * Math.sin((Math.PI * i) / n)]);
	const mPath: V[] = [
		...Array.from({ length: 11 }, (_, i): V => [0, 2 * i]),
		...Array.from({ length: 8 }, (_, i): V => [0, 20 - 2 * i]),
		...arch(0),
		...Array.from({ length: 8 }, (_, i): V => [15, 6 + 2 * i]),
		...Array.from({ length: 8 }, (_, i): V => [15, 20 - 2 * i]),
		...arch(15),
		...Array.from({ length: 8 }, (_, i): V => [30, 6 + 2 * i]),
	];
	const mRand = rng(21);
	const mLetter = asPoints(mPath.map(([x, y]): V => [x + 0.3 * mRand(), y + 0.3 * mRand()]));

	const zigzag = trace(
		[[0, 0], [20, -30], [35, 10], [50, -25], [70, 15], [90, -20], [120, 0], [150, -12], [170, 8]], false, 0.8, 23,
	);

	const word = curve((t) => {
		const a = 6 * Math.PI * t * 2.5; // 7.5 loops: "lllllll"
		return [4 * a - 10 * Math.sin(a), 10 - 12 * Math.cos(a)];
	}, 400, 0.5, 24);

	const cases: Array<[string, Point[]]> = [
		["s", s], ["e", e], ["m", mLetter], ["signature zigzag", zigzag], ["cursive word", word],
		["sine wave", curve((t) => [t * 200, 20 * Math.sin(t * 6 * Math.PI)], 200, 0.5, 25)],
		["spiral", curve((t) => [(5 + 40 * t) * Math.cos(t * 8 * Math.PI), (5 + 40 * t) * Math.sin(t * 8 * Math.PI)], 300, 0.4, 26)],
		["figure eight", curve((t) => [40 * Math.sin(2 * Math.PI * t), 25 * Math.sin(4 * Math.PI * t)], 200, 0.5, 27)],
		["letter C", curve((t) => [30 * Math.cos(deg(40 + 280 * t)), 30 * Math.sin(deg(40 + 280 * t))], 100, 0.4, 28)],
		["letter W", trace([[0, 0], [15, 30], [30, 5], [45, 30], [60, 0]], false, 0.6, 29)],
		["letter N", trace([[0, 30], [0, 0], [25, 30], [25, 0]], false, 0.6, 30)],
		["scribble", trace([[0, 0], [40, 8], [5, 18], [45, 28], [0, 40], [50, 50]], false, 0.5, 31)],
		["lightning bolt", trace([[30, 0], [5, 30], [25, 30], [0, 70]], false, 0.5, 32)],
	];

	for (const [name, pts] of cases) {
		it(`returns null for ${name}`, () => {
			expect(recognizeShape(pts)).toBeNull();
		});
	}

});

describe("hold detection", () => {
	const still = (n: number, t0: number, dt: number, x = 100, y = 100) =>
		Array.from({ length: n }, (_, i) => ({ x: x + (i % 2) * 0.5, y, t: t0 + i * dt }));

	it("detects a pen held still long enough", () => {
		const moving = Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: 100, t: i * 16 }));
		const held = [...moving, ...still(8, 160, 100, 100)];
		expect(isHold(held, 160 + 8 * 100)).toBe(true);
	});

	it("needs the pen to stay still for holdMs", () => {
		const moving = Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 10, y: 100, t: i * 16 }));
		const held = [...moving, { x: 190, y: 100, t: 160 }, { x: 191, y: 100, t: 400 }];
		expect(isHold(held, 500)).toBe(false);
		expect(isHold(held, 800)).toBe(true);
		expect(isHold(held, 800, 700)).toBe(false);
	});

	it("counts the silence after the last sample, and is false when the pen is still moving or for no samples", () => {
		expect(isHold([{ x: 0, y: 0, t: 1000 }], 1700)).toBe(true);
		expect(isHold([{ x: 0, y: 0, t: 1000 }], 1100)).toBe(false);
		const slow = Array.from({ length: 50 }, (_, i) => ({ x: i * 6, y: 0, t: i * 30 }));
		expect(isHold(slow, 49 * 30 + 10)).toBe(false);
		expect(isHold([], 5000)).toBe(false);
	});

	it("respects the radius", () => {
		const jitter = [{ x: 0, y: 0, t: 0 }, { x: 3, y: 0, t: 300 }, { x: 0, y: 2, t: 650 }];
		expect(isHold(jitter, 700)).toBe(true);
		expect(isHold(jitter, 700, 600, 2)).toBe(false);
	});
});

describe("ruler", () => {
	const r = { x: 100, y: 100, angle: 0, length: 200 };

	it("has edge end points along its angle", () => {
		const [a, b] = rulerEdge(r);
		expect(a).toEqual([0, 100]);
		expect(b).toEqual([200, 100]);
		const [c, d] = rulerEdge({ ...r, angle: Math.PI / 2 });
		expect(c[0]).toBeCloseTo(100);
		expect(c[1]).toBeCloseTo(0);
		expect(d[1]).toBeCloseTo(200);
	});

	it("projects points within the snap distance onto the edge", () => {
		expect(projectToRuler(r, [150, 108], 12)).toEqual([150, 100]);
		expect(projectToRuler(r, [150, 90], 12)).toEqual([150, 100]);
		expect(projectToRuler(r, [150, 130], 12)).toBeNull();
		// Beyond the end, but within the snap distance: clamped to the end.
		expect(projectToRuler(r, [205, 100], 12)).toEqual([200, 100]);
		expect(projectToRuler(r, [250, 100], 12)).toBeNull();
		const tilted = { x: 0, y: 0, angle: Math.PI / 4, length: 100 };
		const p = projectToRuler(tilted, [10, 14], 5)!;
		expect(p[0]).toBeCloseTo(12, 6);
		expect(p[1]).toBeCloseTo(12, 6);
	});

	it("is placed by two fingers: centre and angle, not flipping with the finger order", () => {
		const a = rulerFromTwoTouches([100, 100], [200, 100]);
		expect(a.x).toBe(150);
		expect(a.y).toBe(100);
		expect(a.angle).toBeCloseTo(0);
		const b = rulerFromTwoTouches([200, 200], [100, 100]);
		expect(b.angle).toBeCloseTo(Math.PI / 4);
		const c = rulerFromTwoTouches([100, 100], [100, 200]);
		expect(c.angle).toBeCloseTo(Math.PI / 2);
		const d = rulerFromTwoTouches([100, 200], [100, 100]);
		expect(d.angle).toBeCloseTo(Math.PI / 2);
		expect(rulerFromTwoTouches([0, 0], [1, 1], 123).length).toBe(123);
		expect(normalizeRulerAngle(Math.PI + 0.2)).toBeCloseTo(0.2);
	});

	it("draws ticks every mm with half and cm marks", () => {
		const ticks = rulerTicks({ x: 0, y: 0, angle: 0, length: 50 * MM }); // 5 cm
		expect(ticks.length).toBe(51);
		expect(ticks[0]).toMatchObject({ kind: "cm", label: 0, x: -25 * MM });
		expect(ticks[5]!.kind).toBe("half");
		expect(ticks[1]!.kind).toBe("mm");
		expect(ticks[10]).toMatchObject({ kind: "cm", label: 1 });
		expect(ticks[10]!.along).toBeCloseTo(10 * MM);
		expect(ticks[50]!.x).toBeCloseTo(25 * MM, 6);
		expect(ticks.filter((t) => t.kind === "cm").length).toBe(6);
		const big = rulerTicks({ x: 0, y: 0, angle: 0, length: 50 * MM }, 5);
		expect(big.map((t) => t.kind)).toEqual(["cm", "half", "cm", "half", "cm", "half", "cm", "half", "cm", "half", "cm"]);
		expect(rulerTicks(r0(), 0)).toEqual([]);
	});
});

function r0() {
	return { x: 0, y: 0, angle: 0, length: 100 };
}

describe("text layout", () => {
	const m = (s: string) => s.length * 10; // fixed pitch, 10 per character

	it("wraps at spaces", () => {
		const l = layoutText("hello big world", 10, 100, m);
		expect(l.lines).toEqual(["hello big", "world"]);
		expect(l.lineHeight).toBe(12.5);
		expect(l.height).toBe(25);
	});

	it("keeps explicit newlines and empty lines", () => {
		const l = layoutText("a\n\nb\r\nc", 10, 100, m);
		expect(l.lines).toEqual(["a", "", "b", "c"]);
		expect(layoutText("", 16, 100, m).lines).toEqual([""]);
		expect(layoutText("", 16, 100, m).height).toBe(20);
	});

	it("breaks words wider than the box", () => {
		const l = layoutText("abcdefghijkl mn", 10, 50, m);
		expect(l.lines).toEqual(["abcde", "fghij", "kl mn"]);
		expect(layoutText("abcdefgh", 10, 5, m).lines.join("")).toBe("abcdefgh"); // narrower than a character
		expect(layoutText("xx supercalifragilistic", 10, 60, m).lines.every((x) => x.length <= 6)).toBe(true);
	});

	it("drops the space at a wrap point and keeps inner spaces", () => {
		expect(layoutText("aaaaa bbbbb", 10, 50, m).lines).toEqual(["aaaaa", "bbbbb"]);
		expect(layoutText("a  b", 10, 100, m).lines).toEqual(["a  b"]);
	});

	it("computes text element bounds from the layout", () => {
		const el: TextElement = { id: "t", type: "text", x: 10, y: 20, width: 100, text: "hello big world", fontSize: 10, color: "#000000" };
		const b = textElementBounds(el, (s, fs) => s.length * fs);
		expect(b).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 45 });
	});
});

describe("page elements", () => {
	const measure = (s: string, fs: number) => s.length * fs;
	const text: TextElement = { id: "t", type: "text", x: 10, y: 10, width: 100, text: "hello big world", fontSize: 10, color: "#000000" };
	const image: ImageElement = { id: "i", type: "image", asset: "abc", x: 50, y: 50, width: 100, height: 40, rotation: 0 };
	const els: PageElement[] = [text, image];

	it("bounds of text follow the wrapped height; images are their (rotated) bounding box", () => {
		expect(elementBounds(text, measure)).toEqual({ minX: 10, minY: 10, maxX: 110, maxY: 35 });
		expect(elementBounds(image)).toEqual({ minX: 50, minY: 50, maxX: 150, maxY: 90 });
		const b = elementBounds({ ...image, rotation: Math.PI / 2 });
		expect(b.minX).toBeCloseTo(80);
		expect(b.maxX).toBeCloseTo(120);
		expect(b.minY).toBeCloseTo(20);
		expect(b.maxY).toBeCloseTo(120);
		const t45 = elementBounds({ ...image, rotation: Math.PI / 4 });
		expect((t45.maxX - t45.minX)).toBeCloseTo((100 + 40) / Math.SQRT2);
	});

	it("hits the topmost element, with tolerance", () => {
		expect(hitElement(els, 60, 20, 0, measure)).toBe(text);
		expect(hitElement(els, 60, 60, 0, measure)).toBe(image);
		expect(hitElement(els, 300, 300, 5, measure)).toBeNull();
		expect(hitElement(els, 154, 70, 0, measure)).toBeNull();
		expect(hitElement(els, 154, 70, 5, measure)).toBe(image);
		// Overlap: later elements are on top.
		const over: ImageElement = { ...image, id: "i2", x: 20, y: 5, width: 60, height: 20 };
		expect(hitElement([...els, over], 30, 15, 0, measure)).toBe(over);
		expect(hitElement([over, ...els], 30, 15, 0, measure)).toBe(text);
	});

	it("hit area of a rotated image follows the rotation", () => {
		const rot: ImageElement = { ...image, x: 0, y: 0, width: 100, height: 10, rotation: Math.PI / 2 };
		// Centre (50, 5): now a vertical bar 10 wide and 100 tall.
		expect(hitElement([rot], 50, 50, 0)).toBe(rot);
		expect(hitElement([rot], 90, 5, 0)).toBeNull();
		expect(hitElement([rot], 50, -40, 0)).toBe(rot);
	});

	it("selects elements whose centre is inside the lasso", () => {
		const poly: Array<[number, number]> = [[40, 40], [200, 40], [200, 120], [40, 120]];
		expect(elementsInLasso(els, poly, measure)).toEqual([image]);
		expect(elementsInLasso(els, [[0, 0], [300, 0], [300, 300], [0, 300]], measure)).toEqual(els);
		expect(elementsInLasso(els, [[0, 0], [1, 1]], measure)).toEqual([]);
	});

	it("moves elements without mutating them", () => {
		const moved = transformElement(image, translate(10, -5)) as ImageElement;
		expect(moved).toMatchObject({ x: 60, y: 45, width: 100, height: 40, rotation: 0, asset: "abc", id: "i" });
		expect(image.x).toBe(50);
		const t2 = transformElement(text, translate(5, 5), measure) as TextElement;
		expect(t2).toMatchObject({ x: 15, y: 15, width: 100, fontSize: 10, text: text.text });
		expect(text.x).toBe(10);
	});

	it("scales text uniformly and images by size", () => {
		const t = transformElement(text, scaleAbout(2, 2, 0, 0), measure) as TextElement;
		expect(t).toMatchObject({ x: 20, y: 20, width: 200, fontSize: 20 });
		const i = transformElement(image, scaleAbout(0.5, 0.5, 50, 50)) as ImageElement;
		expect(i).toMatchObject({ x: 50, y: 50, width: 50, height: 20 });
	});

	it("rotates images and keeps text upright around its centre", () => {
		const i = transformElement(image, rotateAbout(Math.PI / 2, 100, 70)) as ImageElement;
		expect(i.rotation).toBeCloseTo(Math.PI / 2);
		expect(i.x + i.width / 2).toBeCloseTo(100);
		expect(i.y + i.height / 2).toBeCloseTo(70);
		expect(i.width).toBe(100);
		const t = transformElement(text, rotateAbout(Math.PI, 60, 22.5), measure) as TextElement;
		// A half turn about the box centre maps the box onto itself.
		expect(t.x).toBeCloseTo(10);
		expect(t.y).toBeCloseTo(10);
		expect(t.fontSize).toBeCloseTo(10);
	});
});

describe("infinite page", () => {
	const page = { width: 600, height: 800, infinite: true };

	it("does nothing for finite pages or ink above the bottom fifth", () => {
		expect(growForInfinite({ ...page, infinite: false }, { maxY: 790 })).toBeNull();
		expect(growForInfinite(page, { maxY: 100 })).toBeNull();
		expect(growForInfinite(page, { maxY: 639 })).toBeNull();
	});

	it("grows by half a page when ink reaches the bottom fifth", () => {
		const h = growForInfinite(page, { maxY: 650 })!;
		expect(h).toBeGreaterThan(800);
		expect(h).toBeCloseTo(800 + (600 * (841.89 / 595.28)) / 2, 1);
		// New height leaves the ink out of the margin.
		expect(650).toBeLessThan(h * 0.8);
	});

	it("grows repeatedly for ink far below, and honours a custom margin", () => {
		const h = growForInfinite(page, { maxY: 2000 })!;
		expect(2000).toBeLessThan(h * 0.8);
		expect(growForInfinite(page, { maxY: 700 }, 0.05)).toBeNull();
		expect(growForInfinite(page, { maxY: 790 }, 0.05)).not.toBeNull();
	});

	it("never grows beyond 20 times the width", () => {
		expect(growForInfinite(page, { maxY: 1e9 })).toBe(12000);
		expect(growForInfinite({ ...page, height: 12000 }, { maxY: 11990 })).toBeNull();
		expect(growForInfinite({ ...page, height: 11900 }, { maxY: 11900 })).toBe(12000);
	});
});
