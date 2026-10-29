import { describe, expect, it } from "vitest";
import { layoutPages, nearestPage, PAGE_GAP, pageAt, visiblePages } from "../src/ink/layout";
import { pointInPolygon, selectionBounds, strokesInLasso, transformStroke } from "../src/ink/lasso";
import { pointSegmentDistance } from "../src/ink/hit-test";
import { INK_MAX_STEPS, INK_STEP_PT, InkBuilder, inkCurveAt } from "../src/ink/ink-geometry";
import { densify, eraseSegment } from "../src/ink/segment-erase";
import { Stabilizer } from "../src/ink/stabilizer";
import { apply, IDENTITY, isIdentity, multiply, rotateAbout, scaleAbout, scaleFactor, translate } from "../src/ink/transform";
import { createStroke } from "../src/model/document";
import { A4_HEIGHT, A4_WIDTH, RENDER_FREEHAND, RENDER_INK, type Point } from "../src/model/types";
import { line } from "./helpers";

describe("page layout", () => {
	const a4 = { width: A4_WIDTH, height: A4_HEIGHT };
	const layout = layoutPages([a4, a4, a4]);

	it("stacks pages with a gap", () => {
		expect(layout.boxes.map((b) => b.y)).toEqual([0, A4_HEIGHT + PAGE_GAP, 2 * (A4_HEIGHT + PAGE_GAP)]);
		expect(layout.height).toBeCloseTo(3 * A4_HEIGHT + 2 * PAGE_GAP);
		expect(layout.width).toBe(A4_WIDTH);
	});

	it("finds the page under a point, and nothing in the gap", () => {
		expect(pageAt(layout, 100, 100)).toBe(0);
		expect(pageAt(layout, 100, A4_HEIGHT + PAGE_GAP + 5)).toBe(1);
		expect(pageAt(layout, 100, A4_HEIGHT + PAGE_GAP / 2)).toBe(-1);
		expect(pageAt(layout, 100, A4_HEIGHT + 3, 4)).toBe(0); // tolerance
	});

	it("reports the nearest and the visible pages", () => {
		expect(nearestPage(layout, A4_HEIGHT * 1.5)).toBe(1);
		expect(nearestPage(layout, 1e6)).toBe(2);
		expect(visiblePages(layout, { minX: 0, minY: A4_HEIGHT - 10, maxX: 10, maxY: A4_HEIGHT + PAGE_GAP + 10 })).toEqual([0, 1]);
		expect(visiblePages(layout, { minX: 0, minY: 1e6, maxX: 10, maxY: 1e6 + 1 })).toEqual([]);
	});

	it("handles an empty document", () => {
		expect(layoutPages([]).height).toBe(0);
	});
});

describe("segment eraser", () => {
	const horizontal = line(0, 100, 200, 100, 40, 2);

	it("cuts a stroke in two", () => {
		const runs = eraseSegment(horizontal, 100, 80, 100, 120, 5);
		expect(runs).toHaveLength(2);
		const [left, right] = runs!;
		expect(Math.max(...left!.map((p) => p[0]))).toBeLessThan(100 - 5);
		expect(Math.min(...right!.map((p) => p[0]))).toBeGreaterThan(100 + 5);
	});

	it("returns null when untouched and [] when everything is erased", () => {
		expect(eraseSegment(horizontal, 100, 150, 120, 150, 5)).toBeNull();
		expect(eraseSegment(horizontal, -10, 100, 210, 100, 5)).toEqual([]);
	});

	it("cuts between two distant points thanks to densify", () => {
		const sparse = createStroke("#000000", 1, [[0, 0, 0.5], [100, 0, 0.5]]);
		const runs = eraseSegment(sparse, 50, -10, 50, 10, 2);
		expect(runs).toHaveLength(2);
	});

	it("densify keeps the original points and interpolates pressure", () => {
		const d = densify([[0, 0, 0], [10, 0, 1]], 2.5);
		expect(d[0]).toEqual([0, 0, 0]);
		expect(d[d.length - 1]).toEqual([10, 0, 1]);
		expect(d.length).toBe(5);
		expect(d[2]).toEqual([5, 0, 0.5]);
	});

	it("returns null instead of a no-op cut when no point is within reach", () => {
		const s = createStroke("#000000", 1, [[0, 0, 0.5], [0.2, 0, 0.5]]);
		// The bounding test passes (reach 1.5) but every point is farther than that from the eraser.
		const r = eraseSegment(s, 0.1, 1.6, 0.1, 1.6, 1);
		expect(r === null || r.length !== 1 || r[0]!.length !== 2).toBe(true);
	});

	it("render 2: the pieces of a fast curved stroke stay on the drawn curve", () => {
		// A quarter-ish circle of radius 100 sampled every 0.3 rad (30 pt chords): a fast stroke.
		const R = 100;
		const pts: Point[] = [];
		for (let i = 0; i <= 8; i++) pts.push([Math.round(R * Math.cos(i * 0.3) * 100) / 100, Math.round(R * Math.sin(i * 0.3) * 100) / 100, 0.5]);
		const ink = createStroke("#000000", 2, pts, "pen", RENDER_INK);
		const old = createStroke("#000000", 2, pts, "pen", RENDER_FREEHAND);
		const b = InkBuilder.fromPoints(pts, 2, "pen");
		const nodes: Array<[number, number]> = [];
		for (let i = 0; i < b.nodeCount; i++) nodes.push([b.nx[i]!, b.ny[i]!]);
		const away = (runs: Point[][]) => {
			let worst = 0;
			for (const r of runs) for (const p of r) worst = Math.max(worst, distanceToPolyline(p[0], p[1], nodes));
			return worst;
		};
		// Cut across the middle of the curve (between two stored points).
		const a = 1.05;
		const cut = (stroke: typeof ink) => eraseSegment(stroke, (R - 8) * Math.cos(a), (R - 8) * Math.sin(a), (R + 8) * Math.cos(a), (R + 8) * Math.sin(a), 3)!;
		const runsInk = cut(ink);
		expect(runsInk).toHaveLength(2);
		expect(away(runsInk)).toBeLessThan(0.05);
		// Render 1 keeps its behaviour: the inserted points lie on the chords, off the curve.
		expect(away(cut(old))).toBeGreaterThan(0.3);
	});

	it("inkCurveAt follows exactly the nodes InkBuilder builds", () => {
		const pts: Point[] = [[0, 0, 0.5], [30, 12, 0.5], [41, 50, 0.5], [90, 61.5, 0.5], [95, 20, 0.5]];
		const b = InkBuilder.fromPoints(pts, 2, "pen");
		let node = 1;
		for (let k = 0; k + 1 < pts.length; k++) {
			const len = Math.hypot(pts[k + 1]![0] - pts[k]![0], pts[k + 1]![1] - pts[k]![1]);
			const steps = Math.min(INK_MAX_STEPS, Math.max(1, Math.ceil(len / INK_STEP_PT)));
			for (let j = 1; j < steps; j++, node++) {
				const [x, y] = inkCurveAt(pts, k, j / steps);
				expect(x).toBeCloseTo(b.nx[node]!, 9);
				expect(y).toBeCloseTo(b.ny[node]!, 9);
			}
			node++; // the node on point k + 1
		}
		expect(node).toBe(b.nodeCount);
	});

	it("does not leave single-point crumbs", () => {
		const runs = eraseSegment(line(0, 0, 10, 0, 10, 1), 1.5, -5, 1.5, 5, 1)!;
		for (const r of runs) expect(r.length).toBeGreaterThanOrEqual(2);
	});
});

/** Distance from (x, y) to the polyline through `poly`. */
function distanceToPolyline(x: number, y: number, poly: ReadonlyArray<readonly [number, number]>): number {
	let best = Infinity;
	for (let i = 1; i < poly.length; i++) {
		best = Math.min(best, pointSegmentDistance(x, y, poly[i - 1]![0], poly[i - 1]![1], poly[i]![0], poly[i]![1]));
	}
	return best;
}

describe("lasso", () => {
	const square = [[0, 0], [100, 0], [100, 100], [0, 100]] as const;

	it("point in polygon", () => {
		expect(pointInPolygon(50, 50, square)).toBe(true);
		expect(pointInPolygon(150, 50, square)).toBe(false);
	});

	it("selects strokes mostly inside", () => {
		const inside = line(10, 10, 90, 90);
		const half = line(50, 50, 250, 50, 10); // ~ a quarter inside
		const outside = line(200, 200, 300, 300);
		expect(strokesInLasso([inside, half, outside], square)).toEqual([inside]);
		expect(strokesInLasso([inside], [[0, 0], [1, 1]])).toEqual([]);
	});

	it("bounds of a selection", () => {
		expect(selectionBounds([])).toBeNull();
		expect(selectionBounds([line(10, 10, 20, 30, 4, 2), line(50, 0, 60, 5, 4, 2)])).toEqual({ minX: 9, minY: -1, maxX: 61, maxY: 31 });
	});

	it("transforms a stroke and scales its width", () => {
		const s = createStroke("#000000", 2, [[10, 10, 0.4], [20, 10, 0.6]]);
		const moved = transformStroke(s, translate(5, -5));
		expect(moved.points).toEqual([[15, 5, 0.4], [25, 5, 0.6]]);
		expect(moved.id).toBe(s.id);
		expect(transformStroke(s, scaleAbout(2, 2, 0, 0)).width).toBe(4);
	});
});

describe("affine transforms", () => {
	it("compose and apply", () => {
		const m = multiply(translate(10, 0), scaleAbout(2, 2, 0, 0)); // scale, then move
		expect(apply(m, 1, 1)).toEqual([12, 2]);
		expect(isIdentity(IDENTITY)).toBe(true);
	});

	it("rotate about a point keeps the point fixed", () => {
		const m = rotateAbout(Math.PI / 2, 5, 5);
		const [x, y] = apply(m, 5, 5);
		expect(x).toBeCloseTo(5);
		expect(y).toBeCloseTo(5);
		const [rx, ry] = apply(m, 10, 5);
		expect(rx).toBeCloseTo(5);
		expect(ry).toBeCloseTo(10);
		expect(scaleFactor(m)).toBeCloseTo(1);
	});

	it("scale about a point", () => {
		expect(apply(scaleAbout(3, 3, 10, 10), 10, 10)).toEqual([10, 10]);
		expect(scaleFactor(scaleAbout(3, 3, 0, 0))).toBeCloseTo(3);
	});
});

describe("stabilizer", () => {
	it("level 0 passes points through", () => {
		const s = new Stabilizer(0);
		s.reset(0, 0);
		expect(s.push(10, 5)).toEqual([10, 5]);
		expect(s.finish()).toEqual([]);
	});

	it("smooths a jittery line and catches up on finish", () => {
		const s = new Stabilizer(5);
		s.reset(0, 0);
		const ys: number[] = [];
		for (let i = 1; i <= 40; i++) ys.push(s.push(i, i % 2 ? 2 : -2)[1]);
		// Raw jitter is ±2; the stabilized line moves much less.
		expect(Math.max(...ys.slice(10).map(Math.abs))).toBeLessThan(1);
		const tail = s.finish();
		expect(tail.length).toBeGreaterThan(0);
		expect(tail[tail.length - 1]).toEqual([40, -2]);
	});
});

describe("selection geometry", () => {
	it("corners and handles follow the transform", async () => {
		const { selectionCorners, selectionHandles } = await import("../src/ink/renderer");
		const b = { minX: 0, minY: 0, maxX: 10, maxY: 20 };
		expect(selectionCorners(b, IDENTITY)).toEqual([[0, 0], [10, 0], [10, 20], [0, 20]]);
		const h = selectionHandles(b, IDENTITY, 2);
		expect(h.scale).toEqual([10, 20]);
		expect(h.rotate[0]).toBeCloseTo(5);
		expect(h.rotate[1]).toBeLessThan(0); // above the top edge
		const moved = selectionHandles(b, translate(100, 50), 2);
		expect(moved.scale).toEqual([110, 70]);
	});

	it("invert undoes a transform", async () => {
		const { invert } = await import("../src/ink/transform");
		const m = multiply(rotateAbout(0.7, 3, 4), scaleAbout(2.5, 2.5, 1, 1));
		const [x, y] = apply(m, 12, -7);
		const [bx, by] = apply(invert(m), x, y);
		expect(bx).toBeCloseTo(12);
		expect(by).toBeCloseTo(-7);
	});
});
