import { describe, expect, it } from "vitest";
import { InkBuilder, SvgPathSink } from "../src/ink/ink-geometry";
import {
	addLodNodesPath, flattenOutline, LOD_MAX_SCALE, LOD_MIN_POINTS, LOD_TOLERANCE_PX, LOD_TOLERANCES_PT, lodLevel, lodNodes, lodPolygon, lodSvgPath,
	lodTolerance, simplifyRing,
} from "../src/ink/lod";
import { strokeOutline, strokeSvgPath } from "../src/ink/stroke-shape";
import { syntheticWriting } from "../src/ink/writing-bench";
import { quantizePoint } from "../src/model/document";
import { freezeStroke } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { RENDER_FREEHAND, RENDER_INK, type Point, type Stroke } from "../src/model/types";

function stroke(points: Point[], render: 1 | 2 = RENDER_FREEHAND, width = 1.6, tool: Stroke["tool"] = "pen"): Stroke {
	return freezeStroke({ id: "s", tool, color: "#000000", width, render, points });
}

/** Handwriting-like strokes sampled at 240 Hz (about 0.4 pt apart), in pt. */
function writing(): Point[][] {
	return syntheticWriting(240, 5, 0.8, 40, 60).map((s) => s.map((p) => quantizePoint(p.x, p.y, Math.min(1, Math.max(0, p.p)))));
}

function distToPolyline(px: number, py: number, poly: ReadonlyArray<readonly number[]>, closed: boolean): number {
	let best = Infinity;
	const n = poly.length;
	for (let i = 0; i < (closed ? n : n - 1); i++) {
		const a = poly[i]!, b = poly[(i + 1) % n]!;
		const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]!) * dx + (py - a[1]!) * dy) / len2));
		best = Math.min(best, Math.hypot(px - (a[0]! + t * dx), py - (a[1]! + t * dy)));
	}
	return best;
}

/** Largest distance (pt) from a vertex of one polyline to the other, both ways. */
function hausdorff(a: ReadonlyArray<readonly number[]>, b: ReadonlyArray<readonly number[]>, closed: boolean): number {
	let worst = 0;
	for (const p of a) worst = Math.max(worst, distToPolyline(p[0]!, p[1]!, b, closed));
	for (const p of b) worst = Math.max(worst, distToPolyline(p[0]!, p[1]!, a, closed));
	return worst;
}

function pairs(xy: readonly number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i + 1 < xy.length; i += 2) out.push([xy[i]!, xy[i + 1]!]);
	return out;
}

describe("LOD level", () => {
	it("is exact at normal zoom and picks the largest tolerance within the budget when zoomed out", () => {
		expect(lodLevel(1, 1)).toBe(0);
		expect(lodLevel(LOD_MAX_SCALE, 1)).toBe(0);
		expect(lodLevel(0.49, 1)).toBeGreaterThan(0);
		for (const dpr of [1, 1.5, 2, 2.625, 3]) {
			for (let scale = 0.25; scale < LOD_MAX_SCALE; scale += 0.01) {
				const level = lodLevel(scale, dpr);
				// Never above the budget, in device px.
				expect(lodTolerance(level) * scale * dpr).toBeLessThanOrEqual(LOD_TOLERANCE_PX + 1e-9);
				// And the next level up would be over it (the largest that fits).
				if (level < LOD_TOLERANCES_PT.length) expect(lodTolerance(level + 1) * scale * dpr).toBeGreaterThan(LOD_TOLERANCE_PX);
			}
		}
	});

	it("is exact on very dense screens (nothing would be gained within half a device pixel) and for bad input", () => {
		expect(lodLevel(0.45, 5)).toBe(0);
		expect(lodLevel(0, 1)).toBe(0);
		expect(lodLevel(NaN, 1)).toBe(0);
	});

	it("gets coarser as the page gets smaller", () => {
		expect(lodLevel(0.25, 1)).toBeGreaterThan(lodLevel(0.45, 1));
	});
});

describe("simplification", () => {
	it("simplifies a closed ring, keeps its corners, and leaves tiny rings alone", () => {
		// A 100×10 rectangle with many collinear vertices on each side.
		const xy: number[] = [];
		for (let x = 0; x < 100; x += 5) xy.push(x, 0);
		for (let y = 0; y < 10; y += 2) xy.push(100, y);
		for (let x = 100; x > 0; x -= 5) xy.push(x, 10);
		for (let y = 10; y > 0; y -= 2) xy.push(0, y);
		const out = simplifyRing(xy, 0.1);
		expect(out.length / 2).toBeLessThanOrEqual(6);
		const corners = pairs(out).map((p) => `${p[0]},${p[1]}`);
		for (const c of ["0,0", "100,0", "100,10", "0,10"]) expect(corners).toContain(c);
		expect(simplifyRing([0, 0, 1, 0, 1, 1], 5)).toEqual([0, 0, 1, 0, 1, 1]);
	});

	it("does not touch the saved points and returns null when there is nothing to gain", () => {
		const pts = writing()[0]!;
		const copy = JSON.stringify(pts);
		expect(lodPolygon(pts, 1.6, "pen", 3)).not.toBeNull();
		expect(lodNodes(pts, 1.6, "pen", 3)).not.toBeNull();
		expect(JSON.stringify(pts)).toBe(copy);
		expect(lodPolygon(pts, 1.6, "pen", 0)).toBeNull();
		expect(lodNodes(pts, 1.6, "pen", 0)).toBeNull();
		const few = Array.from({ length: LOD_MIN_POINTS - 1 }, (_, i) => [i * 3, 0, 0.5] as Point);
		expect(lodPolygon(few, 1.6, "pen", 2)).toBeNull();
		expect(lodNodes(few, 1.6, "pen", 2)).toBeNull();
	});

	it("reduces a dense straight line to its two end nodes", () => {
		const line = Array.from({ length: 60 }, (_, i) => [i, 2 * i, 0.5] as Point);
		const nodes = lodNodes(line, 1.6, "pen", 2)!;
		expect(nodes.length / 3).toBe(2);
		expect([nodes[0], nodes[1]]).toEqual([0, 0]);
		expect([nodes[3], nodes[4]]).toEqual([59, 118]);
	});

	it("keeps nodes where only the pressure changes (the pen width follows it); the highlighter ignores pressure", () => {
		const line = Array.from({ length: 40 }, (_, i) => [i * 2, 0, i < 20 ? 0.1 : 0.9] as Point);
		expect(lodNodes(line, 6, "pen", 2)!.length / 3).toBeGreaterThan(2);
		expect(lodNodes(line, 6, "highlighter", 2)!.length / 3).toBe(2);
	});
});

describe("accuracy: the simplified stroke stays within half a device pixel", () => {
	const views: Array<[number, number]> = [[0.49, 1], [0.4, 1], [0.3, 1], [0.25, 1], [0.45, 2], [0.3, 2], [0.45, 1.5], [0.4, 2.625], [0.25, 3]];

	function outlineError(pts: Point[], width: number, scale: number, dpr: number, tool: Stroke["tool"] = "pen"): { px: number; kept: number; total: number } | null {
		const poly = lodPolygon(pts, width, tool, lodLevel(scale, dpr));
		if (!poly) return null;
		const outline = strokeOutline(pts, width, true, tool);
		// Fine samples of the closed curve that outlineToPath draws.
		return { px: hausdorff(pairs(flattenOutline(outline, 12)), pairs(poly), true) * scale * dpr, kept: poly.length / 2, total: outline.length };
	}

	it("perfect-freehand outlines (render 1) on handwriting", () => {
		let worstPx = 0, kept = 0, total = 0;
		for (const [scale, dpr] of views) {
			for (const pts of writing()) {
				const r = outlineError(pts, 1.6, scale, dpr);
				if (!r) continue;
				worstPx = Math.max(worstPx, r.px);
				kept += r.kept;
				total += r.total;
			}
		}
		console.debug(`LOD render 1, handwriting: worst outline difference ${worstPx.toFixed(3)} device px, ${(100 * kept / total).toFixed(0)}% of outline vertices kept`);
		expect(worstPx).toBeLessThanOrEqual(LOD_TOLERANCE_PX);
	});

	it("perfect-freehand outlines on strokes of the stress notebook: pen, highlighter and shape", () => {
		const doc = stressDocument(600, 2);
		let worstPx = 0;
		for (const [scale, dpr] of views.slice(0, 5)) {
			for (const s of doc.pages[0]!.strokes.slice(0, 12)) {
				for (const tool of ["pen", "highlighter", "shape"] as const) {
					const r = outlineError(s.points, tool === "highlighter" ? 14 : s.width, scale, dpr, tool);
					if (r) worstPx = Math.max(worstPx, r.px);
				}
			}
		}
		console.debug(`LOD stress strokes (pen, highlighter, shape): worst ${worstPx.toFixed(3)} device px`);
		expect(worstPx).toBeLessThanOrEqual(LOD_TOLERANCE_PX);
	});

	it("wet-ink nodes (render 2): the discs of the exact geometry stay within the tolerance of the simplified chain", () => {
		let worstPx = 0, kept = 0, total = 0;
		const exact = new InkBuilder();
		for (const [scale, dpr] of views) {
			const level = lodLevel(scale, dpr);
			if (level === 0) continue;
			for (const pts of writing()) {
				const nodes = lodNodes(pts, 1.6, "pen", level);
				if (!nodes) continue;
				InkBuilder.fromPoints(pts, 1.6, "pen", exact);
				// Radius of the simplified chain at a point: interpolated along the segment it is nearest to.
				const radiusAt = (x: number, y: number): { d: number; r: number } => {
					let best = { d: Infinity, r: 0 };
					for (let i = 0; i + 3 < nodes.length; i += 3) {
						const ax = nodes[i]!, ay = nodes[i + 1]!, bx = nodes[i + 3]!, by = nodes[i + 4]!;
						const dx = bx - ax, dy = by - ay;
						const len2 = dx * dx + dy * dy;
						const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
						const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
						if (d < best.d) best = { d, r: nodes[i + 2]! + (nodes[i + 5]! - nodes[i + 2]!) * t };
					}
					return best;
				};
				for (let i = 0; i < exact.nodeCount; i++) {
					const { d, r } = radiusAt(exact.nx[i]!, exact.ny[i]!);
					// The outline of the exact disc is within the centre distance plus the radius difference.
					worstPx = Math.max(worstPx, (d + Math.abs(exact.nr[i]! - r)) * scale * dpr);
				}
				kept += nodes.length / 3;
				total += exact.nodeCount;
			}
		}
		console.debug(`LOD render 2: worst outline difference ${worstPx.toFixed(3)} device px, ${(100 * kept / total).toFixed(0)}% of nodes kept`);
		expect(worstPx).toBeLessThanOrEqual(LOD_TOLERANCE_PX);
	});

	it("simplifies the polygon of a stroke to a fraction of its outline", () => {
		const r = outlineError(writing()[0]!, 1.6, 0.25, 1)!;
		expect(r.kept).toBeLessThan(r.total / 4);
	});

	it("SVG paths for thumbnails: a closed polygon for render 1, a shorter path for render 2, the exact path at level 0", () => {
		const pts = writing()[2]!;
		const s1 = stroke(pts, RENDER_FREEHAND);
		const s2 = stroke(pts, RENDER_INK);
		expect(lodSvgPath(s1, 1.6, 3)).toMatch(/^M[-\d.]+ [-\d.]+(L[-\d.]+ [-\d.]+)+Z$/);
		expect(lodSvgPath(s1, 1.6, 3).length).toBeLessThan(strokeSvgPath(s1).length / 4);
		expect(lodSvgPath(s1, 1.6, 0)).toBe(strokeSvgPath(s1));
		expect(lodSvgPath(s2, 1.6, 3).length).toBeLessThan(strokeSvgPath(s2).length / 3);
		expect(lodSvgPath(s2, 1.6, 0)).toBe(strokeSvgPath(s2));
	});

	it("builds a render-2 path from simplified nodes with the exact construction", () => {
		const line = Array.from({ length: 60 }, (_, i) => [i, 0, 0.5] as Point);
		const sink = new SvgPathSink();
		addLodNodesPath(sink, lodNodes(line, 2, "pen", 2)!);
		expect(sink.d.startsWith("M")).toBe(true);
		expect(sink.d.length).toBeLessThan(strokeSvgPath(stroke(line, RENDER_INK, 2)).length / 5);
	});
});
