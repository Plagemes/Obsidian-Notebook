import { describe, expect, it } from "vitest";
import { findHitStrokes, pointSegmentDistance, segmentDistance, strokeBounds, strokeHit } from "../src/ink/hit-test";
import { createStroke } from "../src/model/document";
import { line } from "./helpers";

describe("geometry", () => {
	it("point–segment distance", () => {
		expect(pointSegmentDistance(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
		expect(pointSegmentDistance(-3, 4, 0, 0, 10, 0)).toBeCloseTo(5);
		expect(pointSegmentDistance(1, 1, 0, 0, 0, 0)).toBeCloseTo(Math.SQRT2);
	});

	it("segment–segment distance", () => {
		expect(segmentDistance(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0); // crossing
		expect(segmentDistance(0, 0, 10, 0, 0, 3, 10, 3)).toBeCloseTo(3); // parallel
		expect(segmentDistance(0, 0, 1, 0, 4, 4, 5, 5)).toBeCloseTo(5);
	});

	it("bounds include half the stroke width", () => {
		expect(strokeBounds(line(10, 10, 20, 30, 4, 4))).toEqual({ minX: 8, minY: 8, maxX: 22, maxY: 32 });
	});
});

describe("whole-stroke eraser hit test", () => {
	const horizontal = line(100, 100, 200, 100, 20, 2);

	it("hits when the eraser touches the stroke", () => {
		expect(strokeHit(horizontal, 150, 104, 150, 104, 4)).toBe(true); // radius 4 + half width 1 ≥ 4
	});

	it("misses when the eraser passes nearby", () => {
		expect(strokeHit(horizontal, 150, 110, 160, 110, 4)).toBe(false);
		expect(strokeHit(horizontal, 300, 100, 400, 100, 4)).toBe(false);
	});

	it("hits a stroke crossed by a fast eraser movement between two samples", () => {
		// Both samples are far from the stroke, but the movement crosses it.
		expect(strokeHit(horizontal, 150, 50, 150, 150, 2)).toBe(true);
	});

	it("hits single-point strokes (dots)", () => {
		const dot = createStroke("#000000", 3, [[50, 50, 0.5]]);
		expect(strokeHit(dot, 53, 50, 53, 50, 2)).toBe(true);
		expect(strokeHit(dot, 60, 50, 60, 50, 2)).toBe(false);
	});

	it("finds only the strokes that were touched, in document order", () => {
		const a = line(0, 0, 100, 0);
		const b = line(0, 50, 100, 50);
		const c = line(0, 100, 100, 100);
		expect(findHitStrokes([a, b, c], 50, -10, 50, 60, 1)).toEqual([a, b]);
	});
});
