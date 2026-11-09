/**
 * Review fixes of the stroke taper (format v25, #351): the wet ink and the other live paths show the same taper the committed stroke has.
 * Z1 the provisional tip inside the start ramp, Z2/Z3 the wet canvas of a tapered stroke at the lift, Z4 thumbnails, Z5 the start taper by
 * arc length, Z6 the live fallback.
 */
import { describe, expect, it } from "vitest";
import { inkPath, inkRadius, InkBuilder, SvgPathSink } from "../src/ink/ink-geometry";
import { lodSvgPath, widenedTaper } from "../src/ink/lod";
import { strokeSvgPath } from "../src/ink/stroke-shape";
import { TAPER_TIP, taperFactor, taperLength, writingTaper } from "../src/model/taper";
import { RENDER_INK, type Point } from "../src/model/types";

/** A straight horizontal line of `n` points `step` pt apart, at a steady pressure. */
function line(n: number, step: number, pressure = 0.5): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < n; i++) out.push([10 + i * step, 20, pressure]);
	return out;
}

describe("Z1: the provisional tip follows the start taper", () => {
	it("the ballpoint tip is thin inside the start ramp, like the trail behind it", () => {
		const width = 2;
		const g = new InkBuilder();
		g.reset("pen", width, undefined, { start: 1, end: 0 });
		const ramp = taperLength(1, width);
		const pts = line(4, 2);
		for (const p of pts) g.add(p[0], p[1], p[2]);
		const full = inkRadius("pen", width, 0.5);
		const last = pts[pts.length - 1]!;
		const tip = g.tipRadius(0.5, last[0] + 1, last[1]);
		expect(tip).toBeLessThan(full * 0.6);
		// Never wider than the line will be there: the same factor as a stored point at that distance.
		const arc = 6 + 1;
		expect(tip).toBeCloseTo(full * taperFactor(arc / ramp), 9);
		// Without the position: the way travelled to the last stored point.
		expect(g.tipRadius(0.5)).toBeCloseTo(full * taperFactor(6 / ramp), 9);
		// Predicted points further on are not thinner than the ones before them.
		expect(g.tipRadius(0.5, last[0] + 6, last[1])).toBeGreaterThan(tip);
	});

	it("the first provisional tip (no stored point yet) is the thinnest, and the ramp ends at the full radius", () => {
		const g = new InkBuilder();
		g.reset("pen", 2, undefined, { start: 0.5, end: 0 });
		expect(g.tipRadius(0.5, 5, 5)).toBeCloseTo(inkRadius("pen", 2, 0.5) * TAPER_TIP, 9);
		const ramp = taperLength(0.5, 2);
		for (const p of line(40, 1)) g.add(p[0], p[1], p[2]);
		expect(ramp).toBe(12);
		expect(g.tipRadius(0.5, 60, 20)).toBe(inkRadius("pen", 2, 0.5));
	});

	it("is what it was without a start taper (an end taper alone, or none)", () => {
		for (const taper of [undefined, { start: 0, end: 1 }]) {
			const g = new InkBuilder();
			g.reset("pen", 2, undefined, taper);
			for (const p of line(3, 2)) g.add(p[0], p[1], p[2]);
			expect(g.tipRadius(0.7, 20, 20)).toBe(inkRadius("pen", 2, 0.7));
		}
	});
});

describe("Z5: the start taper does not depend on how far apart the points are", () => {
	it("a fast stroke thickens by the way travelled, like a slow one", () => {
		const width = 2;
		const taper = { start: 0.1, end: 0 };
		const ramp = taperLength(0.1, width);
		const slow = InkBuilder.fromPoints(line(60, 1), width, "pen", new InkBuilder(), undefined, taper);
		const fast = InkBuilder.fromPoints(line(12, 6), width, "pen", new InkBuilder(), undefined, taper);
		expect(ramp).toBeCloseTo(2.4, 9);
		const full = inkRadius("pen", width, 0.5);
		for (const g of [slow, fast]) {
			let inside = 0;
			for (let i = 0; i < g.nodeCount; i++) {
				const arc = g.nx[i]! - 10;
				if (arc >= ramp) continue;
				inside++;
				expect(g.nr[i]!, `x ${arc}`).toBeCloseTo(Math.max(0.01, full * taperFactor(arc / ramp)), 9);
			}
			expect(inside).toBeGreaterThan(0);
		}
		// The fast stroke has nodes inside a ramp that is shorter than its first segment (6 pt): they are thin at the start and grow.
		expect(fast.nr[0]!).toBeLessThan(fast.nr[1]!);
	});

	it("the radius grows along the ramp and meets the rest of the line at its full size", () => {
		const g = InkBuilder.fromPoints(line(12, 6), 2, "pen", new InkBuilder(), undefined, { start: 0.1, end: 0 });
		for (let i = 1; i < g.nodeCount; i++) expect(g.nr[i]!).toBeGreaterThanOrEqual(g.nr[i - 1]! - 1e-12);
		expect(g.nr[g.nodeCount - 1]).toBe(inkRadius("pen", 2, 0.5));
	});

	it("the wet and the committed stroke agree node for node (the brush's closed last sample included)", () => {
		const pts: Point[] = [];
		for (let i = 0; i < 40; i++) pts.push([10 + i * 3, 20 + Math.sin(i / 4) * 6, 0.3 + 0.6 * Math.abs(Math.sin(i / 7))]);
		for (const tool of ["pen", "fountain", "brush"] as const) {
			for (const taper of [{ start: 0.3, end: 0.4 }, { start: 1, end: 0 }]) {
				const committed = InkBuilder.fromPoints(pts, 2, tool, new InkBuilder(), undefined, taper);
				const live = new InkBuilder();
				live.reset(tool, 2, undefined, taper);
				for (const p of pts) live.add(p[0], p[1], p[2]);
				const midNodes = Array.from(live.nr.subarray(0, live.nodeCount));
				live.finish();
				expect(live.nodeCount, tool).toBe(committed.nodeCount);
				expect(Array.from(live.nr.subarray(0, live.nodeCount)), tool).toEqual(Array.from(committed.nr.subarray(0, committed.nodeCount)));
				// Nothing already built moved at the lift except the end taper's nodes at the tail.
				if (taper.end === 0) expect(Array.from(live.nr.subarray(0, midNodes.length - 2)), tool).toEqual(midNodes.slice(0, midNodes.length - 2));
			}
		}
		const brush = InkBuilder.fromPoints(pts, 2, "brush", new InkBuilder(), undefined, { start: 0.3, end: 0 });
		const plain = InkBuilder.fromPoints(pts, 2, "brush", new InkBuilder(), undefined, { start: 0, end: 0 });
		expect(brush.nr[brush.nodeCount - 1]).toBeCloseTo(plain.nr[plain.nodeCount - 1]!, 9);
	});
});

describe("Z6: the live fallback draws no end taper while the pen is down", () => {
	it("writingTaper keeps the start and drops the end", () => {
		expect(writingTaper(undefined)).toBeUndefined();
		expect(writingTaper({ start: 0.4, end: 1 })).toEqual({ start: 0.4, end: 0 });
		expect(writingTaper({ start: 0, end: 0.5 })).toEqual({ start: 0, end: 0 });
	});

	it("the stroke built with it keeps a full-width end, the finished one gets its point", () => {
		const pts = line(40, 3);
		const taper = { start: 0.3, end: 1 };
		const live = InkBuilder.fromPoints(pts, 2, "pen", new InkBuilder(), undefined, writingTaper(taper));
		const done = InkBuilder.fromPoints(pts, 2, "pen", new InkBuilder(), undefined, taper);
		const full = inkRadius("pen", 2, 0.5);
		expect(live.nr[live.nodeCount - 1]).toBe(full);
		expect(done.nr[done.nodeCount - 1]).toBeLessThan(full * 0.1);
		// The start is the same in both.
		expect(live.nr[0]).toBe(done.nr[0]);
	});
});

describe("Z4: a line drawn wider than the stroke (thumbnails) keeps its taper length in pt", () => {
  it("widenedTaper scales the values back", () => {
    expect(widenedTaper(undefined, 0.8, 5)).toBeUndefined();
    const same = { start: 0.5, end: 1 };
    expect(widenedTaper(same, 2, 2)).toBe(same);
    const t = widenedTaper({ start: 0.5, end: 1 }, 0.8, 5)!;
    expect(taperLength(t.start, 5)).toBeCloseTo(taperLength(0.5, 0.8), 9);
    expect(taperLength(t.end, 5)).toBeCloseTo(taperLength(1, 0.8), 9);
  });

  it("a thin pen with a full end taper on a small card is not drawn as a spindle", () => {
    const pts = line(80, 3);
    const stroke = { points: pts, width: 0.8, tool: "pen" as const, render: RENDER_INK, taperEnd: 1 };
    const drawn = 5;
    const pageLength = taperLength(1, 0.8);
    expect(pageLength).toBeCloseTo(9.6, 9);
    const sink = new SvgPathSink();
    inkPath(sink, pts, drawn, "pen", undefined, widenedTaper({ start: 0, end: 1 }, 0.8, drawn));
    // Exact path (level 0) and a simplified one (level 3) both use it; the old lengthened taper (60 pt) gives another path.
    expect(lodSvgPath(stroke, drawn, 0)).toBe(sink.d);
    const lengthened = new SvgPathSink();
    inkPath(lengthened, pts, drawn, "pen", undefined, { start: 0, end: 1 });
    expect(lodSvgPath(stroke, drawn, 0)).not.toBe(lengthened.d);
    const g = InkBuilder.fromPoints(pts, drawn, "pen", new InkBuilder(), undefined, widenedTaper({ start: 0, end: 1 }, 0.8, drawn));
    const endX = g.nx[g.nodeCount - 1]!;
    let full = 0;
    for (let i = 0; i < g.nodeCount; i++) if (endX - g.nx[i]! >= pageLength + 0.5) full = Math.max(full, g.nr[i]!);
    expect(full).toBe(inkRadius("pen", drawn, 0.5));
    expect(lodSvgPath(stroke, drawn, 3)).not.toBe(lodSvgPath({ ...stroke, taperEnd: undefined }, drawn, 3));
  });

  it("at the stroke's own width nothing changes", () => {
    const pts = line(80, 3);
    const stroke = { points: pts, width: 2, tool: "pen" as const, render: RENDER_INK, taperStart: 0.3, taperEnd: 0.6 };
    expect(lodSvgPath(stroke, 2, 0)).toBe(strokeSvgPath(stroke));
  });
});
