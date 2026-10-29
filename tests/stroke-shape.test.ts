import { describe, expect, it } from "vitest";
import { outlineToPath, strokeOutline, strokePath } from "../src/ink/stroke-shape";
import { line } from "./helpers";

describe("stroke shape", () => {
	it("produces a closed outline around the points", () => {
		const s = line(10, 10, 110, 10, 20, 4);
		const outline = strokeOutline(s.points, s.width);
		expect(outline.length).toBeGreaterThan(10);
		const ys = outline.map((p) => p[1]!);
		expect(Math.max(...ys)).toBeGreaterThan(10);
		expect(Math.min(...ys)).toBeLessThan(10);
	});

	it("renders a dot for a single point", () => {
		expect(strokePath([[5, 5, 0.5]], 3)).toMatch(/^M.*Z$/);
	});

	it("builds an SVG path through the outline midpoints", () => {
		expect(outlineToPath([])).toBe("");
		expect(outlineToPath([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe("M0 0Q10 0 10 5T5 10 Z");
	});
});
