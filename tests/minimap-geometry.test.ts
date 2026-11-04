import { describe, expect, it } from "vitest";
import {
	AUTO_ZOOM_FACTOR, fitScaleFor, mapSize, nearestCorner, normaliseMinimapPrefs, refreshDelay, shouldShowMinimap,
	viewportCentredOn, viewRectOnMap, visibleInPage, wholePageVisible,
} from "../src/model/minimap-geometry";

const box = { x: 0, y: 0, width: 600, height: 6000 };
const view = { width: 800, height: 600 };

describe("minimap geometry (roadmap #173)", () => {
	it("fits the map to its box with the page's proportions", () => {
		const m = mapSize({ width: 600, height: 6000 });
		expect(m.height).toBeLessThanOrEqual(232);
		expect(m.width / m.height).toBeCloseTo(0.1, 1);
		const a4 = mapSize({ width: 595, height: 842 });
		expect(a4.width).toBeLessThanOrEqual(168);
		expect(mapSize({ width: 0, height: 0 })).toEqual({ width: 1, height: 1, scale: 1 });
	});

	it("maps the view to a rectangle on the map, clipped", () => {
		const map = mapSize(box);
		const vp = { scale: 1, offsetX: 100, offsetY: -1000 };
		expect(visibleInPage(vp, view, box)).toEqual({ x: -100, y: 1000, width: 800, height: 600 });
		const r = viewRectOnMap(vp, view, box, map);
		expect(r.x).toBe(0);
		expect(r.width).toBeCloseTo(map.width, 5);
		expect(r.y).toBeCloseTo(1000 * map.scale, 5);
		expect(r.height).toBeCloseTo(600 * map.scale, 5);
		expect(viewRectOnMap({ scale: 1, offsetX: 0, offsetY: -9000 }, view, box, map).height).toBe(0);
	});

	it("centres the view on a map point", () => {
		const map = mapSize(box);
		const vp = { scale: 2, offsetX: 0, offsetY: 0 };
		const next = viewportCentredOn(vp, view, box, map, map.width / 2, map.height / 2);
		expect(next.scale).toBe(2);
		const v = visibleInPage(next, view, box);
		expect(v.y + v.height / 2).toBeCloseTo(3000, -1);
		expect(v.x + v.width / 2).toBeCloseTo(300, -1);
		// a point outside the map is clamped to its edge
		const edge = viewportCentredOn(vp, view, box, map, -50, 9999);
		expect(edge.offsetY).toBeCloseTo(view.height / 2 - 6000 * 2, 3);
	});

	it("honours the box position in document space", () => {
		const placed = { x: 100, y: 5000, width: 600, height: 800 };
		const map = mapSize(placed);
		const vp = { scale: 1, offsetX: -100, offsetY: -5000 };
		expect(visibleInPage(vp, view, placed)).toMatchObject({ x: 0, y: 0 });
		const next = viewportCentredOn(vp, view, placed, map, 0, 0);
		expect(next.offsetX).toBeCloseTo(view.width / 2 - 100, 5);
		expect(next.offsetY).toBeCloseTo(view.height / 2 - 5000, 5);
	});

	it("knows when the whole page is visible", () => {
		const page = { x: 0, y: 0, width: 400, height: 500 };
		expect(wholePageVisible({ scale: 1, offsetX: 0, offsetY: 0 }, view, page)).toBe(true);
		expect(wholePageVisible({ scale: 2, offsetX: 0, offsetY: 0 }, view, page)).toBe(false);
	});

	it("shows by mode: never / always / auto on infinite pages and at high zoom", () => {
		const base = { infinite: false, scale: 1, fitScale: 1, whole: false };
		expect(shouldShowMinimap({ ...base, mode: "never", infinite: true })).toBe(false);
		expect(shouldShowMinimap({ ...base, mode: "always", whole: true })).toBe(true);
		expect(shouldShowMinimap({ ...base, mode: "auto" })).toBe(false);
		expect(shouldShowMinimap({ ...base, mode: "auto", infinite: true })).toBe(true);
		expect(shouldShowMinimap({ ...base, mode: "auto", infinite: true, whole: true })).toBe(false);
		expect(shouldShowMinimap({ ...base, mode: "auto", scale: AUTO_ZOOM_FACTOR })).toBe(true);
		expect(shouldShowMinimap({ ...base, mode: "auto", scale: AUTO_ZOOM_FACTOR - 0.1 })).toBe(false);
		expect(fitScaleFor(832, 800, 16)).toBe(1);
	});

	it("settles a dragged map in the nearest corner", () => {
		const c = { width: 1000, height: 700 };
		expect(nearestCorner(100, 100, c)).toBe("tl");
		expect(nearestCorner(900, 100, c)).toBe("tr");
		expect(nearestCorner(100, 600, c)).toBe("bl");
		expect(nearestCorner(900, 600, c)).toBe("br");
	});

	it("throttles the picture refresh", () => {
		expect(refreshDelay(-Infinity, 5000)).toBe(0);
		expect(refreshDelay(1000, 1500, 1200)).toBe(700);
		expect(refreshDelay(1000, 3000, 1200)).toBe(0);
	});

	it("reads stored preferences leniently", () => {
		expect(normaliseMinimapPrefs(null)).toEqual({ corner: "br", collapsed: false });
		expect(normaliseMinimapPrefs({ corner: "tl", collapsed: true })).toEqual({ corner: "tl", collapsed: true });
		expect(normaliseMinimapPrefs({ corner: "middle", collapsed: "yes" })).toEqual({ corner: "br", collapsed: false });
	});
});
