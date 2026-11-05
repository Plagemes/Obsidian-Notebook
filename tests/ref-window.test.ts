import { describe, expect, it } from "vitest";
import {
	chipRect, clampOpacity, clampRect, defaultRect, EDGE_GAP, EMPTY_MEMORY, fromPlacement, initialRect, minSize, moveRect, normaliseMemory, orientationOf, placementFor,
	remember, resizeRect, restoredRect, snapRect, toPlacement, type Rect,
} from "../src/ui/ref-window-geometry";
import { clampView, FIT, MAX_RASTER_SIDE, MAX_ZOOM, MIN_ZOOM, panView, pinchFactor, rasterWidth, shouldRedraw, zoomView } from "../src/ui/ref-window-pan";
import { movesContent, pageLabel, referenceKind, requestedIndex, stepIndex } from "../src/view/ref-window-logic";

const VIEW = { width: 1000, height: 700 };
const inside = (r: Rect, view = VIEW): boolean =>
	r.x >= EDGE_GAP && r.y >= EDGE_GAP && r.x + r.width <= view.width - EDGE_GAP && r.y + r.height <= view.height - EDGE_GAP;

describe("reference window geometry", () => {
	it("keeps a window inside the view, whatever it is given", () => {
		for (const r of [
			{ x: -50, y: -50, width: 300, height: 200 }, { x: 900, y: 650, width: 300, height: 200 }, { x: 10, y: 10, width: 5000, height: 5000 },
			{ x: 10, y: 10, width: 1, height: 1 }, { x: NaN, y: Infinity, width: NaN, height: -3 },
		]) expect(inside(clampRect(r, VIEW)), JSON.stringify(r)).toBe(true);
	});

	it("never makes the window smaller than its minimum, unless the view is smaller", () => {
		const r = clampRect({ x: 0, y: 0, width: 10, height: 10 }, VIEW);
		expect(r.width).toBeGreaterThanOrEqual(minSize(VIEW).width);
		expect(r.height).toBeGreaterThanOrEqual(minSize(VIEW).height);
		const tiny = { width: 150, height: 120 };
		expect(inside(clampRect({ x: 0, y: 0, width: 400, height: 400 }, tiny), tiny)).toBe(true);
	});

	it("opens in the bottom-right corner by default and inside the view, also in a phone-size view", () => {
		const r = defaultRect(VIEW);
		expect(inside(r)).toBe(true);
		expect(r.x + r.width).toBe(VIEW.width - EDGE_GAP);
		expect(r.y + r.height).toBe(VIEW.height - EDGE_GAP);
		const phone = { width: 360, height: 640 };
		expect(inside(defaultRect(phone), phone)).toBe(true);
	});

	it("drags without leaving the view and resizes from the corner with the top-left kept", () => {
		const r: Rect = { x: 100, y: 100, width: 300, height: 200 };
		expect(moveRect(r, -500, -500, VIEW)).toMatchObject({ x: EDGE_GAP, y: EDGE_GAP, width: 300, height: 200 });
		expect(inside(moveRect(r, 5000, 5000, VIEW))).toBe(true);
		const big = resizeRect(r, 4000, 4000, VIEW);
		expect(big).toMatchObject({ x: 100, y: 100 });
		expect(inside(big)).toBe(true);
		const small = resizeRect(r, -4000, -4000, VIEW);
		expect(small.width).toBe(minSize(VIEW).width);
	});

	it("snaps an edge that is near the edge of the view, and only that one", () => {
		const near = snapRect({ x: 20, y: 300, width: 300, height: 200 }, VIEW);
		expect(near.x).toBe(EDGE_GAP);
		expect(near.y).toBe(300);
		const right = snapRect({ x: 1000 - EDGE_GAP - 300 - 10, y: 300, width: 300, height: 200 }, VIEW);
		expect(right.x + right.width).toBe(VIEW.width - EDGE_GAP);
		const bottom = snapRect({ x: 300, y: 700 - EDGE_GAP - 200 - 12, width: 300, height: 200 }, VIEW);
		expect(bottom.y + bottom.height).toBe(VIEW.height - EDGE_GAP);
		const far = snapRect({ x: 300, y: 250, width: 300, height: 200 }, VIEW);
		expect(far).toEqual({ x: 300, y: 250, width: 300, height: 200 });
	});

	it("places the chip at the window corner, inside the view, and restores the window from it", () => {
		const r: Rect = { x: 900, y: 650, width: 300, height: 200 };
		const w = clampRect(r, VIEW);
		const chip = chipRect(w, VIEW);
		expect(inside(chip)).toBe(true);
		const back = restoredRect(w, { ...chip, x: 200, y: 100 }, VIEW);
		expect(back).toMatchObject({ x: 200, y: 100, width: w.width, height: w.height });
	});
});

describe("remembered place", () => {
	it("follows the view as fractions: a rotation puts the window in the same relative place, inside the view", () => {
		const rect: Rect = { x: 600, y: 350, width: 380, height: 330 };
		const memory = remember(EMPTY_MEMORY, rect, VIEW, false);
		expect(orientationOf(VIEW)).toBe("landscape");
		const portrait = { width: 700, height: 1000 };
		const p = placementFor(memory, portrait);
		expect(p).not.toBeNull();
		expect(inside(fromPlacement(p!, portrait), portrait)).toBe(true);
	});

	it("keeps one place per orientation", () => {
		const landscape: Rect = { x: 600, y: 350, width: 380, height: 330 };
		const portraitView = { width: 700, height: 1000 };
		const portrait: Rect = { x: 20, y: 20, width: 300, height: 400 };
		let m = remember(EMPTY_MEMORY, landscape, VIEW, false);
		m = remember(m, portrait, portraitView, false);
		expect(initialRect(m, VIEW)).toEqual(clampRect(landscape, VIEW));
		expect(initialRect(m, portraitView)).toEqual(clampRect(portrait, portraitView));
	});

	it("falls back to the default place when nothing is remembered", () => {
		expect(initialRect(EMPTY_MEMORY, VIEW)).toEqual(defaultRect(VIEW));
	});

	it("round-trips a rectangle through a placement", () => {
		const rect: Rect = { x: 120, y: 80, width: 400, height: 300 };
		expect(fromPlacement(toPlacement(rect, VIEW, false), VIEW)).toEqual(rect);
	});

	it("reads corrupt storage as nothing remembered and keeps the stored values bounded", () => {
		for (const bad of [null, undefined, 5, "x", [], { landscape: "x" }, { landscape: { fx: 0, fy: 0, fw: 0, fh: 1 } }, { portrait: { fx: NaN, fy: 0, fw: 0.5, fh: 0.5 } }]) {
			const m = normaliseMemory(bad);
			expect(m.landscape).toBeNull();
			expect(m.portrait).toBeNull();
		}
		const odd = normaliseMemory({ landscape: { fx: 0.1, fy: 0.2, fw: 0.4, fh: 0.5, minimised: "yes", junk: [1, 2, 3] }, extra: new Array(1000).fill(1), opacity: 7 });
		expect(odd.landscape).toEqual({ fx: 0.1, fy: 0.2, fw: 0.4, fh: 0.5, minimised: false });
		expect(Object.keys(odd).sort()).toEqual(["landscape", "opacity", "portrait"]);
		expect(odd.opacity).toBe(1);
	});

	it("clamps the opacity", () => {
		expect(clampOpacity(0)).toBeGreaterThan(0.3);
		expect(clampOpacity(5)).toBe(1);
		expect(clampOpacity("a")).toBeGreaterThan(0.9);
	});
});

describe("pan and zoom inside the window", () => {
	const content = { width: 400, height: 560 };
	const frame = { width: 400, height: 300 };

	it("fits at zoom 1: full width, centred when shorter than the frame", () => {
		expect(clampView(FIT, content, frame)).toEqual({ scale: 1, x: 0, y: 0 });
		expect(clampView(FIT, { width: 400, height: 100 }, frame).y).toBe(100);
	});

	it("limits zoom and keeps the content over the frame", () => {
		const z = zoomView(FIT, 100, 200, 150, content, frame);
		expect(z.scale).toBe(MAX_ZOOM);
		expect(zoomView(FIT, 0.01, 0, 0, content, frame).scale).toBe(MIN_ZOOM);
		expect(z.x).toBeLessThanOrEqual(0);
		expect(z.x).toBeGreaterThanOrEqual(frame.width - content.width * z.scale);
		const dragged = panView(z, 99999, 99999, content, frame);
		expect(dragged.x).toBe(0);
		expect(dragged.y).toBe(0);
		const other = panView(z, -99999, -99999, content, frame);
		expect(other.x).toBe(frame.width - content.width * z.scale);
		expect(other.y).toBe(frame.height - content.height * z.scale);
	});

	it("keeps the point under the fingers while zooming", () => {
		const start = panView(zoomView(FIT, 2, 0, 0, content, frame), -50, -80, content, frame);
		const at = { x: 150, y: 120 };
		const under = { x: (at.x - start.x) / start.scale, y: (at.y - start.y) / start.scale };
		const next = zoomView(start, 1.5, at.x, at.y, content, frame);
		expect((at.x - next.x) / next.scale).toBeCloseTo(under.x, 5);
		expect((at.y - next.y) / next.scale).toBeCloseTo(under.y, 5);
	});

	it("survives nonsense numbers", () => {
		const v = clampView({ scale: NaN, x: NaN, y: Infinity }, content, frame);
		expect(Number.isFinite(v.scale + v.x + v.y)).toBe(true);
		expect(pinchFactor(0, 10)).toBe(1);
		expect(pinchFactor(10, 20)).toBe(2);
	});

	it("draws a picture again only when the difference is clear, and never beyond the memory limit", () => {
		expect(shouldRedraw(0, 500)).toBe(true);
		expect(shouldRedraw(800, 900)).toBe(false);
		expect(shouldRedraw(800, 1200)).toBe(true);
		expect(shouldRedraw(800, 100)).toBe(true);
		expect(shouldRedraw(800, 600)).toBe(false);
		expect(rasterWidth(400, 1, 2, 1.4)).toBe(800);
		expect(rasterWidth(400, 6, 3, 1.4)).toBeLessThanOrEqual(Math.round(MAX_RASTER_SIDE / 1.4));
		expect(rasterWidth(400, 6, 3, 1.4)).toBeGreaterThan(0);
	});
});

describe("reference window logic", () => {
	it("tells what the window can show", () => {
		const nb = ["notebook"];
		expect(referenceKind("notebook", nb)).toBe("notebook");
		expect(referenceKind("PDF", nb)).toBe("pdf");
		expect(referenceKind("md", nb)).toBe("markdown");
		for (const ext of ["png", "jpg", "JPEG", "webp", "svg"]) expect(referenceKind(ext, nb), ext).toBe("image");
		for (const ext of ["", "docx", "canvas", "mp3", "base"]) expect(referenceKind(ext, nb), ext).toBeNull();
	});

	it("finds the page a request names", () => {
		const ids = ["a", "b", "c"];
		expect(requestedIndex(3, ids, { page: null, pageId: null })).toBe(0);
		expect(requestedIndex(3, ids, { page: 2, pageId: null })).toBe(1);
		expect(requestedIndex(3, ids, { page: 9, pageId: null })).toBe(2);
		expect(requestedIndex(3, ids, { page: 1, pageId: "c" })).toBe(2);
		expect(requestedIndex(3, ids, { page: 1, pageId: "gone" })).toBe(0);
		expect(requestedIndex(5, null, { page: 4, pageId: null })).toBe(3);
		expect(requestedIndex(5, null, { page: 0, pageId: null })).toBe(0);
		expect(requestedIndex(0, null, { page: 3, pageId: null })).toBe(0);
	});

	it("steps within the pages and labels them", () => {
		expect(stepIndex(0, -1, 5)).toBe(0);
		expect(stepIndex(4, 1, 5)).toBe(4);
		expect(stepIndex(2, 1, 5)).toBe(3);
		expect(pageLabel(2, 12)).toBe("3 / 12");
		expect(pageLabel(0, 0)).toBe("1 / 1");
	});

	it("lets fingers and the mouse move the reference, never the pen", () => {
		expect(movesContent("touch")).toBe(true);
		expect(movesContent("mouse")).toBe(true);
		expect(movesContent("pen")).toBe(false);
		expect(movesContent("")).toBe(false);
	});
});
