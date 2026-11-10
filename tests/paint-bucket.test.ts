/**
 * 0.28 (#184): the paint bucket's geometry. A hand-made mask (1 = ink) stands in for the rasterised page: closed shapes, gaps, nested shapes,
 * the ways a tap can fail, the polygon that comes out (page coordinates, closed, simplified) and the stroke that is stored for it.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createStroke } from "../src/model/document";
import { parse, serialize } from "../src/model/serialize";
import {
	BUCKET_LINE_WIDTH, MAX_CELLS, MAX_POINTS, bucketInsertIndex, bucketStroke, bucketWindow, dilate, floodRegion, isBucketFill, maskFromAlpha,
	paintBucket, polygonArea, simplifyClosed, traceOutline,
} from "../src/ink/paint-bucket";
import { isFilled } from "../src/ink/shape-style";
import type { Point } from "../src/model/types";

interface Grid {
	mask: Uint8Array;
	cols: number;
	rows: number;
}

function grid(cols: number, rows: number): Grid {
	return { mask: new Uint8Array(cols * rows), cols, rows };
}

/** An outline of a rectangle `t` cells thick; `gap` cells are left out of the middle of the top side. */
function frame(g: Grid, x0: number, y0: number, x1: number, y1: number, t = 2, gap = 0): void {
	const mid = Math.floor((x0 + x1) / 2);
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const edge = x < x0 + t || x > x1 - t || y < y0 + t || y > y1 - t;
			if (!edge) continue;
			if (gap > 0 && y < y0 + t && Math.abs(x - mid) <= gap / 2) continue;
			g.mask[y * g.cols + x] = 1;
		}
	}
}

function ring(g: Grid, cx: number, cy: number, radius: number, t = 2): void {
	for (let y = 0; y < g.rows; y++) {
		for (let x = 0; x < g.cols; x++) {
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			if (d >= radius - t / 2 && d <= radius + t / 2) g.mask[y * g.cols + x] = 1;
		}
	}
}

function run(g: Grid, x: number, y: number, extra: Partial<Parameters<typeof paintBucket>[0]> = {}) {
	return paintBucket({ mask: g.mask, cols: g.cols, rows: g.rows, scale: 1, originX: 0, originY: 0, x, y, ...extra });
}

function bounds(points: Point[]) {
	return {
		minX: Math.min(...points.map((p) => p[0])), maxX: Math.max(...points.map((p) => p[0])),
		minY: Math.min(...points.map((p) => p[1])), maxY: Math.max(...points.map((p) => p[1])),
	};
}

describe("paint bucket: a closed shape", () => {
	const g = grid(200, 200);
	frame(g, 40, 40, 159, 159);

	it("fills the inside of a square as a closed polygon in page coordinates", () => {
		const r = run(g, 100, 100);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const first = r.points[0]!, last = r.points[r.points.length - 1]!;
		expect([first[0], first[1]]).toEqual([last[0], last[1]]);
		const b = bounds(r.points);
		// The inside is 42..157; the fill goes one cell under the ink (41..158), so it lies under the edge of the line.
		expect(b.minX).toBeGreaterThanOrEqual(40);
		expect(b.minX).toBeLessThanOrEqual(43);
		expect(b.maxX).toBeLessThanOrEqual(160);
		expect(b.maxX).toBeGreaterThanOrEqual(157);
		expect(b.minY).toBeGreaterThanOrEqual(40);
		expect(b.maxY).toBeLessThanOrEqual(160);
		expect(r.area).toBeGreaterThan(110 * 110);
		expect(r.area).toBeLessThan(120 * 120);
		// A square is four corners (plus the closing point), not a staircase.
		expect(r.points.length).toBeLessThanOrEqual(6);
	});

	it("the polygon is vector data: finite numbers, pressure 0.5, at most MAX_POINTS", () => {
		const r = run(g, 60, 70);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.points.length).toBeLessThanOrEqual(MAX_POINTS + 1);
		for (const p of r.points) {
			expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
			expect(p[2]).toBe(0.5);
		}
	});

	it("converts through the origin and the scale of the mask", () => {
		const r = run(g, 100 / 2 + 10, 100 / 2 + 20, { scale: 2, originX: 10, originY: 20 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const b = bounds(r.points);
		expect(b.minX).toBeGreaterThanOrEqual(10 + 40 / 2 - 0.5);
		expect(b.maxX).toBeLessThanOrEqual(10 + 160 / 2 + 0.5);
		expect(b.minY).toBeGreaterThanOrEqual(20 + 40 / 2 - 0.5);
		expect(b.maxY).toBeLessThanOrEqual(20 + 160 / 2 + 0.5);
	});

	it("a tap outside the square reaches the edge: not enclosed", () => {
		expect(run(g, 10, 10)).toEqual({ ok: false, reason: "open" });
	});

	it("a tap on the line itself is refused", () => {
		expect(run(g, 40.5, 100)).toEqual({ ok: false, reason: "onInk" });
	});
});

describe("paint bucket: gaps", () => {
	it("closes a gap smaller than the tolerance", () => {
		const g = grid(300, 300);
		frame(g, 60, 60, 239, 239, 2, 4); // a 4-cell gap at scale 2 = 2 pt, tolerance 1.5 pt each side
		const r = run(g, 75, 75, { scale: 2, originX: 0, originY: 0 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// The fill stays inside the square: it does not run out through the gap.
		const b = bounds(r.points);
		expect(b.minY).toBeGreaterThanOrEqual(60 / 2 - 0.5);
		expect(b.maxY).toBeLessThanOrEqual(240 / 2 + 0.5);
	});

	it("does not close a gap wider than the tolerance", () => {
		const g = grid(300, 300);
		frame(g, 60, 60, 239, 239, 2, 24);
		expect(run(g, 75, 75, { scale: 2 })).toEqual({ ok: false, reason: "open" });
	});

	it("a tap close to the line, in the band the tolerance took, still fills the area", () => {
		const g = grid(300, 300);
		frame(g, 60, 60, 239, 239, 2);
		const r = run(g, 62.5 / 2, 75, { scale: 2 });
		expect(r.ok).toBe(true);
	});
});

describe("paint bucket: nested shapes", () => {
	const g = grid(300, 300);
	frame(g, 20, 20, 279, 279);
	frame(g, 100, 100, 199, 199);

	it("a tap between the two squares fills the outer area; the inner square is an island, covered by its own ink", () => {
		const r = run(g, 50, 50);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const b = bounds(r.points);
		expect(b.minX).toBeGreaterThanOrEqual(20);
		expect(b.maxX).toBeLessThanOrEqual(280);
		// Decision: the stored polygon is the outer outline only (the shape fill is one nonzero polygon, it has no holes), so the island is
		// inside it: the area counts the island too.
		expect(r.area).toBeGreaterThan(250 * 250);
	});

	it("a tap inside the inner square fills just that one", () => {
		const r = run(g, 150, 150);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const b = bounds(r.points);
		expect(b.minX).toBeGreaterThanOrEqual(100);
		expect(b.maxX).toBeLessThanOrEqual(200);
		expect(r.area).toBeLessThan(100 * 100);
	});
});

describe("paint bucket: a round shape", () => {
	it("fills a circle with a simplified outline", () => {
		const g = grid(200, 200);
		ring(g, 100, 100, 70);
		const r = run(g, 100, 100);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.points.length).toBeGreaterThan(8);
		expect(r.points.length).toBeLessThan(150);
		expect(r.area).toBeGreaterThan(Math.PI * 66 * 66);
		expect(r.area).toBeLessThan(Math.PI * 72 * 72);
	});
});

describe("paint bucket: refusals", () => {
	it("a very small area is refused", () => {
		const g = grid(100, 100);
		frame(g, 40, 40, 48, 48, 2); // 5x5 cells inside = about 1.5 pt wide at 4 cells per pt
		expect(run(g, 44.5 / 4, 44.5 / 4, { scale: 4 })).toEqual({ ok: false, reason: "tooSmall" });
	});

	it("an area that is nearly the whole mask is refused as too large", () => {
		const g = grid(200, 200);
		frame(g, 2, 2, 197, 197, 2);
		expect(run(g, 100, 100)).toEqual({ ok: false, reason: "tooBig" });
	});

	it("an empty page is open", () => {
		const g = grid(100, 100);
		expect(run(g, 50, 50)).toEqual({ ok: false, reason: "open" });
	});

	it("gives up when the time budget is spent", () => {
		const g = grid(400, 400);
		frame(g, 30, 30, 330, 330, 2);
		let t = 0;
		const now = () => (t += 200);
		expect(run(g, 200, 200, { now, budget: 500 })).toEqual({ ok: false, reason: "busy" });
	});

	it("a tap outside the mask is open", () => {
		const g = grid(50, 50);
		expect(run(g, -5, 10)).toEqual({ ok: false, reason: "open" });
	});
});

describe("the pieces", () => {
	it("maskFromAlpha reads the alpha channel against a threshold", () => {
		const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 47, 0, 0, 0, 48, 9, 9, 9, 255]);
		expect(Array.from(maskFromAlpha(rgba, 5, 1))).toEqual([0, 0, 0, 1, 1]);
	});

	it("dilate grows a point by the radius in a square", () => {
		const m = new Uint8Array(11 * 11);
		m[5 * 11 + 5] = 1;
		const d = dilate(m, 11, 11, 2);
		expect(d.reduce((a, b) => a + b, 0)).toBe(25);
		expect(d[3 * 11 + 3]).toBe(1);
		expect(d[2 * 11 + 5]).toBe(0);
		expect(Array.from(dilate(m, 11, 11, 0))).toEqual(Array.from(m));
	});

	it("floodRegion stops at the edge of the mask", () => {
		const walls = new Uint8Array(9 * 9);
		const r = floodRegion(walls, 9, 9, 4, 4, 0, () => 0, 1);
		expect(r.kind).toBe("open");
	});

	it("traceOutline walks the outer corners of an L shape", () => {
		const cols = 6, rows = 6;
		const region = new Uint8Array(cols * rows);
		for (let y = 1; y < 5; y++) for (let x = 1; x < 3; x++) region[y * cols + x] = 1;
		for (let x = 3; x < 5; x++) region[4 * cols + x] = 1;
		const out = traceOutline(region, cols, rows);
		expect(out).toEqual([[1, 1], [3, 1], [3, 4], [5, 4], [5, 5], [1, 5]]);
		expect(polygonArea(out)).toBe(8 + 2);
	});

	it("simplifyClosed drops the points within the tolerance and keeps the corners", () => {
		const ring2: Array<[number, number]> = [];
		for (let x = 0; x < 10; x++) ring2.push([x, x % 2 === 0 ? 0 : 0.2]);
		ring2.push([10, 0], [10, 10], [0, 10]);
		const s = simplifyClosed(ring2, 0.5);
		expect(s.length).toBeLessThanOrEqual(5);
		expect(s.some((p) => p[0] === 10 && p[1] === 10)).toBe(true);
	});
});

describe("the window", () => {
	it("an ordinary page is rasterised whole, within the cell cap", () => {
		const w = bucketWindow(595, 842, 100, 100);
		expect(w.x).toBe(0);
		expect(w.y).toBe(0);
		expect(w.width).toBe(595);
		expect(w.height).toBe(842);
		expect(w.cols * w.rows).toBeLessThanOrEqual(MAX_CELLS);
		expect(w.scale).toBeGreaterThanOrEqual(1.5);
		expect(w.scale).toBeLessThanOrEqual(4);
	});

	it("a small page uses at most 4 cells per pt", () => {
		expect(bucketWindow(100, 100, 50, 50).scale).toBe(4);
	});

	it("a very long page gives a bounded window around the tap, inside the page", () => {
		const w = bucketWindow(595, 40000, 300, 30000);
		expect(w.cols * w.rows).toBeLessThanOrEqual(MAX_CELLS);
		expect(w.y).toBeLessThanOrEqual(30000);
		expect(w.y + w.height).toBeGreaterThanOrEqual(30000);
		expect(w.x).toBeGreaterThanOrEqual(0);
		expect(w.x + w.width).toBeLessThanOrEqual(595);
		expect(w.y + w.height).toBeLessThanOrEqual(40000);
	});
});

describe("the stored fill", () => {
	const square: Point[] = [[10, 10, 0.5], [90, 10, 0.5], [90, 90, 0.5], [10, 90, 0.5], [10, 10, 0.5]];

	it("is a filled shape stroke with a hairline, solid or tint, with the pen's opacity", () => {
		const solid = bucketStroke(square, "#E03131", false, undefined, "a");
		expect(solid).toMatchObject({ tool: "shape", color: "#e03131", fill: "#e03131", width: BUCKET_LINE_WIDTH });
		expect(solid.fillTint).toBeUndefined();
		expect(solid.opacity).toBeUndefined();
		const tint = bucketStroke(square, "#e03131", true, 0.5, "b");
		expect(tint.fillTint).toBe(true);
		expect(tint.opacity).toBe(0.5);
		expect(isFilled(solid)).toBe(true);
		expect(isBucketFill(solid)).toBe(true);
	});

	it("survives saving and reading the notebook", () => {
		const doc = createDocument();
		doc.pages[0]!.strokes.push(bucketStroke(square, "#2f9e44", true, 0.8, "fill-1"));
		const back = parse(serialize(doc));
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		const s = back.doc.pages[0]!.strokes[0]!;
		expect(s).toMatchObject({ id: "fill-1", tool: "shape", fill: "#2f9e44", fillTint: true, opacity: 0.8 });
		expect(s.points).toHaveLength(5);
	});

	it("goes after the fills at the start of the page and before all the ink", () => {
		const ink = createStroke("#000000", 2, [[0, 0, 0.5], [5, 5, 0.5]]);
		const plainShape = { ...createStroke("#000000", 2, square, "shape"), fill: "#ff0000" };
		const a = bucketStroke(square, "#ff0000", false, undefined, "a");
		const b = bucketStroke(square, "#00ff00", false, undefined, "b");
		expect(bucketInsertIndex([])).toBe(0);
		expect(bucketInsertIndex([ink])).toBe(0);
		expect(bucketInsertIndex([a, b, ink])).toBe(2);
		// A filled shape the person drew (an ordinary line width) is ink, not a bucket fill.
		expect(isBucketFill(plainShape)).toBe(false);
		expect(bucketInsertIndex([a, plainShape, b])).toBe(1);
	});
});

describe("work is bounded", () => {
	it("a whole A4 page of ink and nested frames is filled well inside the budget", () => {
		const w = bucketWindow(595, 842, 300, 400);
		const g = grid(w.cols, w.rows);
		const s = w.scale;
		frame(g, Math.floor(40 * s), Math.floor(40 * s), Math.floor(550 * s), Math.floor(800 * s), Math.ceil(1.5 * s));
		for (let i = 0; i < 12; i++) frame(g, Math.floor((80 + i * 5) * s), Math.floor((100 + i * 40) * s), Math.floor((300 + i * 5) * s), Math.floor((130 + i * 40) * s));
		const t0 = Date.now();
		const r = paintBucket({ mask: g.mask, cols: g.cols, rows: g.rows, scale: s, originX: 0, originY: 0, x: 400, y: 400 });
		const ms = Date.now() - t0;
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.points.length).toBeLessThanOrEqual(MAX_POINTS + 1);
		expect(ms).toBeLessThan(5000);
	});
});
