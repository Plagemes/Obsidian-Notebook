import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutPages } from "../src/ink/layout";
import { layoutPagesHorizontal } from "../src/ink/page-mode";
import {
	capturePosition, FIT_EPSILON, fitScale, parsePosition, positionEquals, positionFromState, restoreViewport, type SavedPosition,
} from "../src/ink/view-position";
import { clampToPage, fitWidth, screenToPage, type Size, type Viewport } from "../src/ink/viewport";
import { A4_HEIGHT, A4_WIDTH } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { LocationKeeper } from "../src/view/last-location";
import type { Timers } from "../src/storage/session";

const A4 = { width: A4_WIDTH, height: A4_HEIGHT };
const pages = Array.from({ length: 6 }, () => A4);
const vertical = layoutPages(pages);
const horizontal = layoutPagesHorizontal(pages);
const tablet: Size = { width: 800, height: 1280 };
const landscape: Size = { width: 1280, height: 800 };

/** A viewport on page `index` (0-based) at `zoom` x the fit scale, showing the page point (x, y) at the top-left corner. */
function viewportAt(layout = vertical, view = tablet, index = 2, zoom = 2, x = 100, y = 300): Viewport {
	const fit = fitWidth(view, layout).scale;
	const box = layout.boxes[index]!;
	const scale = fit * zoom;
	return { scale, offsetX: -(box.x + x) * scale, offsetY: -(box.y + y) * scale };
}

describe("capturing and restoring the position", () => {
	it("round-trips in the same view", () => {
		const v = viewportAt();
		const pos = capturePosition("continuous", v, tablet, vertical, 2)!;
		expect(pos).toEqual({ page: 3, zoom: 2, x: 100, y: 300 });
		const back = restoreViewport(pos, "continuous", tablet, vertical)!;
		expect(back.pageIndex).toBe(2);
		expect(back.fit).toBe(false);
		expect(back.viewport.scale).toBeCloseTo(v.scale, 6);
		expect(back.viewport.offsetX).toBeCloseTo(v.offsetX, 3);
		expect(back.viewport.offsetY).toBeCloseTo(v.offsetY, 3);
	});

	it("keeps the zoom relative to the fit and the same page point at the corner in a different view size", () => {
		const pos = capturePosition("continuous", viewportAt(vertical, tablet, 4, 2.5, 40, 520), tablet, vertical, 4)!;
		const restored = restoreViewport(pos, "continuous", landscape, vertical)!;
		const fit = fitWidth(landscape, vertical).scale;
		expect(restored.viewport.scale).toBeCloseTo(fit * 2.5, 6);
		const [px, py] = screenToPage(restored.viewport, 0, 0);
		expect(px - vertical.boxes[4]!.x).toBeCloseTo(40, 1);
		expect(py - vertical.boxes[4]!.y).toBeCloseTo(520, 1);
	});

	it("knows when the page was simply fitted", () => {
		const fitted = { ...fitWidth(tablet, vertical) };
		const box = vertical.boxes[3]!;
		fitted.offsetY = -box.y * fitted.scale - 120 * fitted.scale;
		const pos = capturePosition("continuous", fitted, tablet, vertical, 3)!;
		expect(pos.zoom).toBeCloseTo(1, 3);
		expect(Math.abs(pos.zoom - 1)).toBeLessThan(FIT_EPSILON);
		const restored = restoreViewport(pos, "continuous", landscape, vertical)!;
		expect(restored.fit).toBe(true);
		// Restored viewport, as the view clamps it, shows the same line of the page at the top.
		const clamped = clampToPage(restored.viewport, landscape, vertical);
		expect(clamped.scale).toBeCloseTo(fitWidth(landscape, vertical).scale, 6);
		expect(screenToPage(clamped, 0, 0)[1] - box.y).toBeCloseTo(pos.y, 1);
	});

	it("works in the page-by-page layout, where the zoom is relative to that page's own fit", () => {
		const mixed = layoutPagesHorizontal([A4, { width: A4_HEIGHT, height: A4_WIDTH }]);
		const fit1 = fitScale("pages", tablet, mixed, 1);
		const v: Viewport = { scale: fit1 * 1.5, offsetX: -(mixed.boxes[1]!.x + 60) * fit1 * 1.5, offsetY: -200 * fit1 * 1.5 };
		const pos = capturePosition("pages", v, tablet, mixed, 1)!;
		expect(pos).toEqual({ page: 2, zoom: 1.5, x: 60, y: 200 });
		const back = restoreViewport(pos, "pages", landscape, mixed)!;
		expect(back.pageIndex).toBe(1);
		expect(back.viewport.scale).toBeCloseTo(fitScale("pages", landscape, mixed, 1) * 1.5, 6);
		// Saved in one mode, restored in the other: same page, zoom relative to that mode's fit.
		expect(restoreViewport(pos, "continuous", tablet, layoutPages([A4, A4]))!.pageIndex).toBe(1);
		expect(horizontal.boxes.length).toBe(6);
	});

	it("clamps a page that no longer exists and a zoom beyond the limits", () => {
		const r = restoreViewport({ page: 99, zoom: 30, x: 0, y: 0 }, "continuous", tablet, vertical)!;
		expect(r.pageIndex).toBe(5);
		expect(r.viewport.scale).toBeLessThanOrEqual(8);
		expect(restoreViewport({ page: 1, zoom: 1, x: 0, y: 0 }, "continuous", { width: 0, height: 0 }, vertical)).toBeNull();
		expect(restoreViewport({ page: 1, zoom: 1, x: 0, y: 0 }, "continuous", tablet, { boxes: [], width: 0, height: 0 })).toBeNull();
	});

	it("captures nothing without a page or a view", () => {
		expect(capturePosition("continuous", viewportAt(), { width: 0, height: 0 }, vertical, 0)).toBeNull();
		expect(capturePosition("continuous", viewportAt(), tablet, vertical, 40)).toBeNull();
		expect(capturePosition("continuous", { scale: 0, offsetX: 0, offsetY: 0 }, tablet, vertical, 0)).toBeNull();
	});
});

describe("reading a position from untrusted data", () => {
	const good: SavedPosition = { page: 4, zoom: 1.75, x: 12.5, y: -8 };

	it("accepts a well-formed position", () => {
		expect(parsePosition(good)).toEqual(good);
		expect(parsePosition({ ...good, extra: true })).toEqual(good);
	});

	it.each([
		null, undefined, 3, "x", [],
		{ page: 0, zoom: 1, x: 0, y: 0 },
		{ page: 1.5, zoom: 1, x: 0, y: 0 },
		{ page: 1, zoom: 0, x: 0, y: 0 },
		{ page: 1, zoom: -2, x: 0, y: 0 },
		{ page: 1, zoom: 1e9, x: 0, y: 0 },
		{ page: 1, zoom: NaN, x: 0, y: 0 },
		{ page: 1, zoom: 1, x: Infinity, y: 0 },
		{ page: 1, zoom: 1, x: 0, y: 1e12 },
		{ page: "1", zoom: 1, x: 0, y: 0 },
		{ page: 1, zoom: 1, x: 0 },
	])("rejects %j", (raw) => {
		expect(parsePosition(raw)).toBeNull();
	});

	it("reads it from a view state only for the page the state names", () => {
		expect(positionFromState({ file: "A.notebook", page: 4, view: good })).toEqual(good);
		// A link or the page panel changed the page but left an old position behind: ignore it.
		expect(positionFromState({ file: "A.notebook", page: 5, view: good })).toBeNull();
		expect(positionFromState({ file: "A.notebook", page: 4 })).toBeNull();
		expect(positionFromState({ page: 4, view: "nonsense" })).toBeNull();
		expect(positionFromState(null)).toBeNull();
	});

	it("compares positions with a tolerance", () => {
		expect(positionEquals(good, { ...good, x: good.x + 0.4, zoom: good.zoom + 0.001 })).toBe(true);
		expect(positionEquals(good, { ...good, y: good.y + 3 })).toBe(false);
		expect(positionEquals(good, { ...good, page: 5 })).toBe(false);
		expect(positionEquals(null, null)).toBe(true);
		expect(positionEquals(good, null)).toBe(false);
	});
});

describe("plugin settings", () => {
	it("starts without a saved position and ignores a damaged one", () => {
		expect(DEFAULT_SETTINGS.lastNotebookPos).toBeNull();
		expect(readSettings({ lastNotebookPos: { page: 2, zoom: "big", x: 0, y: 0 } }).lastNotebookPos).toBeNull();
		expect(readSettings({ lastNotebookPos: { page: 2, zoom: 1.2, x: 3, y: 4 } }).lastNotebookPos).toEqual({ page: 2, zoom: 1.2, x: 3, y: 4 });
	});

	it("reads the scroll mode and falls back to continuous", () => {
		expect(DEFAULT_SETTINGS.scrollMode).toBe("continuous");
		expect(readSettings({ scrollMode: "pages" }).scrollMode).toBe("pages");
		expect(readSettings({ scrollMode: "sideways" }).scrollMode).toBe("continuous");
		expect(readSettings({ scrollMode: 3 }).scrollMode).toBe("continuous");
	});
});

describe("LocationKeeper carries the position", () => {
	const timers: Timers = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (h) => clearTimeout(h) };
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("saves the last position once things have settled, with the page", () => {
		const saved: Array<[string, number, SavedPosition | null]> = [];
		const k = new LocationKeeper(timers, (path, page, pos) => saved.push([path, page, pos]), 1000);
		const at = (y: number): SavedPosition => ({ page: 3, zoom: 2, x: 10, y });
		k.note("A.notebook", 3, at(100));
		k.note("A.notebook", 3, at(200));
		k.note("A.notebook", 3, at(300));
		vi.advanceTimersByTime(1001);
		expect(saved).toEqual([["A.notebook", 3, at(300)]]);
		k.note("A.notebook", 3);
		k.flush();
		expect(saved[1]).toEqual(["A.notebook", 3, null]);
	});
});
