/**
 * Review fixes of the stroke taper (format v25, #351): the wet ink and the other live paths show the same taper the committed stroke has.
 * Z1 the provisional tip inside the start ramp, Z2/Z3 the wet canvas of a tapered stroke at the lift, Z4 thumbnails, Z5 the start taper by
 * arc length, Z6 the live fallback.
 */
import { describe, expect, it } from "vitest";
import { inkRadius, InkBuilder } from "../src/ink/ink-geometry";
import { TAPER_TIP, taperFactor, taperLength } from "../src/model/taper";
import type { Point, Tool } from "../src/model/types";

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
