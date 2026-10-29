import { describe, expect, it } from "vitest";
import {
	clampToPage, fitWidth, MAX_SCALE, MIN_SCALE, pageToScreen, PAGE_MARGIN, pan, screenToPage, zoomAt, type Viewport,
} from "../src/ink/viewport";
import { A4_HEIGHT, A4_WIDTH } from "../src/model/types";

const page = { width: A4_WIDTH, height: A4_HEIGHT };

describe("screen ↔ page transform", () => {
	it.each([0.25, 0.5, 1, 1.37, 2, 4, 8])("round-trips at scale %f", (scale) => {
		const v: Viewport = { scale, offsetX: 23.5, offsetY: -410 };
		for (const [x, y] of [[0, 0], [120.25, 700.5], [-5, 3000]] as const) {
			const [sx, sy] = pageToScreen(v, x, y);
			const [px, py] = screenToPage(v, sx, sy);
			expect(px).toBeCloseTo(x, 9);
			expect(py).toBeCloseTo(y, 9);
		}
	});

	it("maps the page origin to the offset and scales distances", () => {
		const v: Viewport = { scale: 2, offsetX: 10, offsetY: 20 };
		expect(pageToScreen(v, 0, 0)).toEqual([10, 20]);
		expect(pageToScreen(v, 100, 50)).toEqual([210, 120]);
		expect(screenToPage(v, 210, 120)).toEqual([100, 50]);
	});
});

describe("fit to width", () => {
	it.each([[360, 640], [800, 1280], [1280, 800], [2560, 1600]])("fills a %ipx wide view", (w, h) => {
		const v = fitWidth({ width: w, height: h }, page);
		expect(A4_WIDTH * v.scale).toBeCloseTo(w - 2 * PAGE_MARGIN);
		expect(v.offsetX).toBeCloseTo(PAGE_MARGIN);
		expect(v.offsetY).toBe(PAGE_MARGIN);
	});

	it("respects the scale limits", () => {
		expect(fitWidth({ width: 40, height: 100 }, page).scale).toBe(MIN_SCALE);
		expect(fitWidth({ width: 100000, height: 100 }, page).scale).toBe(MAX_SCALE);
	});
});

describe("zoom and pan", () => {
	it("zooming keeps the focal point fixed on the page", () => {
		const v: Viewport = { scale: 1.2, offsetX: 16, offsetY: -200 };
		const before = screenToPage(v, 300, 400);
		for (const factor of [0.5, 1.1, 2, 3]) {
			const after = screenToPage(zoomAt(v, factor, 300, 400), 300, 400);
			expect(after[0]).toBeCloseTo(before[0], 9);
			expect(after[1]).toBeCloseTo(before[1], 9);
		}
	});

	it("clamps the zoom", () => {
		const v: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
		expect(zoomAt(v, 100, 0, 0).scale).toBe(MAX_SCALE);
		expect(zoomAt(v, 0.001, 0, 0).scale).toBe(MIN_SCALE);
	});

	it("pans the offset", () => {
		expect(pan({ scale: 1, offsetX: 1, offsetY: 2 }, 3, -4)).toEqual({ scale: 1, offsetX: 4, offsetY: -2 });
	});

	it("keeps the page reachable", () => {
		const view = { width: 400, height: 300 };
		const fitted = fitWidth(view, page);
		const down = clampToPage(pan(fitted, 0, -1e6), view, page);
		expect(down.offsetY + A4_HEIGHT * down.scale).toBeCloseTo(view.height - PAGE_MARGIN);
		expect(clampToPage(pan(fitted, 0, 1e6), view, page).offsetY).toBe(PAGE_MARGIN);
		const small = clampToPage({ scale: 0.3, offsetX: -500, offsetY: 0 }, view, page);
		expect(small.offsetX).toBeCloseTo((view.width - A4_WIDTH * 0.3) / 2);
	});
});
