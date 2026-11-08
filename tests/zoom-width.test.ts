import { describe, expect, it } from "vitest";
import { effectiveScreenWidth, ZOOM_WIDTH_MAX, ZOOM_WIDTH_MAX_HIGHLIGHTER, ZOOM_WIDTH_MIN, zoomedWidth } from "../src/ink/zoom-width";
import { MAX_SCALE, MIN_SCALE } from "../src/ink/viewport";
import { InkBuilder } from "../src/ink/ink-geometry";

describe("zoomedWidth", () => {
	it("is the identity when off, at any zoom", () => {
		for (const s of [0.25, 1, 2, 8]) expect(zoomedWidth(3.2, s, false)).toBe(3.2);
	});
	it("divides by the zoom when on", () => {
		expect(zoomedWidth(2, 1, true)).toBe(2);
		expect(zoomedWidth(2, 2, true)).toBe(1);
		expect(zoomedWidth(2, 4, true)).toBe(0.5);
		expect(zoomedWidth(1.2, 0.5, true)).toBeCloseTo(2.4);
	});
	it("looks the chosen width on screen when not clamped", () => {
		for (const s of [0.5, 1, 1.5, 3, 5]) expect(effectiveScreenWidth(2, s, true)).toBeCloseTo(2);
	});
	it("clamps at the extremes of the zoom range", () => {
		expect(zoomedWidth(0.8, MAX_SCALE, true)).toBe(ZOOM_WIDTH_MIN);
		expect(zoomedWidth(5, MIN_SCALE, true)).toBeCloseTo(20);
		expect(zoomedWidth(20, MIN_SCALE, true)).toBe(ZOOM_WIDTH_MAX);
		expect(zoomedWidth(40, MIN_SCALE, true, true)).toBe(ZOOM_WIDTH_MAX_HIGHLIGHTER);
	});
	it("ignores bad input", () => {
		expect(zoomedWidth(2, 0, true)).toBe(2);
		expect(zoomedWidth(2, NaN, true)).toBe(2);
		expect(zoomedWidth(0, 2, true)).toBe(0);
	});
	it("feeds the stroke builder for pens with a nib and tilt like any other width", () => {
		for (const [tool, nib] of [["fountain", 30], ["brush", undefined], ["marker", 45]] as const) {
			const b = new InkBuilder();
			b.reset(tool, zoomedWidth(2, 4, true), nib);
			b.add(0, 0, 0.5);
			b.add(10, 4, 0.6);
			b.finish();
			expect(b.toPoints().length).toBeGreaterThan(0);
		}
	});
});
