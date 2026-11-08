import { describe, expect, it } from "vitest";
import { baseWindow, centeredCrop, clampCrop, COVER_ASPECT, COVER_ZOOM_MAX, cropWindow, downscaleSize, panCrop, zoomCrop } from "../src/model/cover-crop";

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("cover crop maths", () => {
	it("the base window is the biggest 3:4 rectangle of the source", () => {
		expect(baseWindow(4000, 3000)).toEqual({ w: 2250, h: 3000 });
		const tall = baseWindow(600, 2000);
		near(tall.w, 600);
		near(tall.h, 800);
		expect(baseWindow(0, 100)).toEqual({ w: 0, h: 0 });
	});

	it("the centred crop shows the middle", () => {
		const r = cropWindow(4000, 3000, centeredCrop());
		near(r.x, 875);
		near(r.y, 0);
		near(r.w / r.h, COVER_ASPECT);
	});

	it("the window never leaves the source, whatever the crop says", () => {
		for (const crop of [{ cx: -3, cy: 9, zoom: 1 }, { cx: 0, cy: 0, zoom: 4 }, { cx: 1, cy: 1, zoom: 99 }, { cx: NaN, cy: NaN, zoom: NaN }]) {
			const r = cropWindow(1000, 1500, crop);
			expect(r.x).toBeGreaterThanOrEqual(0);
			expect(r.y).toBeGreaterThanOrEqual(0);
			expect(r.x + r.w).toBeLessThanOrEqual(1000 + 1e-6);
			expect(r.y + r.h).toBeLessThanOrEqual(1500 + 1e-6);
			near(r.w / r.h, COVER_ASPECT);
		}
		expect(clampCrop(1000, 1500, { cx: 5, cy: 5, zoom: 99 }).zoom).toBe(COVER_ZOOM_MAX);
		expect(clampCrop(0, 0, { cx: 1, cy: 1, zoom: 3 })).toEqual(centeredCrop());
	});

	it("dragging moves the picture with the finger and stops at the edge", () => {
		const start = { cx: 0.5, cy: 0.5, zoom: 1 };
		const moved = panCrop(4000, 3000, start, 30, 0, 300);
		// The window was 2250 wide in a frame 300 wide: 30 px of finger is 225 source pixels, window goes left.
		near(cropWindow(4000, 3000, moved).x, 875 - 225);
		const far = panCrop(4000, 3000, start, 100000, 0, 300);
		near(cropWindow(4000, 3000, far).x, 0);
		// Nothing to pan at zoom 1 on the short axis.
		near(cropWindow(4000, 3000, panCrop(4000, 3000, start, 0, 500, 300)).y, 0);
		expect(panCrop(4000, 3000, start, 5, 5, 0)).toEqual(clampCrop(4000, 3000, start));
	});

	it("zooming keeps the point under the finger in place", () => {
		const crop = { cx: 0.5, cy: 0.5, zoom: 1.5 };
		const before = cropWindow(4000, 3000, crop);
		const fx = 0.25;
		const fy = 0.75;
		const px = before.x + before.w * fx;
		const py = before.y + before.h * fy;
		const next = zoomCrop(4000, 3000, crop, 3, fx, fy);
		const after = cropWindow(4000, 3000, next);
		near(after.x + after.w * fx, px);
		near(after.y + after.h * fy, py);
		expect(next.zoom).toBe(3);
		expect(zoomCrop(4000, 3000, crop, 0.2).zoom).toBe(1);
	});

	it("large pictures are scaled down for the editor, small ones are left alone", () => {
		expect(downscaleSize(4000, 3000, 1600)).toEqual({ w: 1600, h: 1200, scaled: true });
		expect(downscaleSize(3000, 4000, 1600)).toEqual({ w: 1200, h: 1600, scaled: true });
		expect(downscaleSize(800, 600, 1600)).toEqual({ w: 800, h: 600, scaled: false });
		expect(downscaleSize(0, 600)).toEqual({ w: 0, h: 0, scaled: false });
	});
});
