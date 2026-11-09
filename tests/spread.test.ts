import { describe, expect, it } from "vitest";
import { layoutPages, nearestPage, pageAt, pagesTouching, toPageLocal, visiblePages } from "../src/ink/layout";
import { isScrollMode, layoutForMode, SCROLL_MODES } from "../src/ink/page-mode";
import { pageAtOffset } from "../src/ink/scrollbar";
import {
	canSpread, DEFAULT_SPREAD, effectiveScrollMode, isSpreadLayout, layoutSpread, mateOf, pageUnderScreen, rowOf, scrollToPageViewport, SPREAD_GAP_H,
	relayoutStep, SPREAD_MIN_WIDTH, spreadRows, spreadTarget, stepRow,
} from "../src/ink/spread";
import { capturePosition, restoreViewport, zoomBase } from "../src/ink/view-position";
import { captureRegion, restoreRegion } from "../src/ink/view-region";
import { clampToPage, fitWidth, PAGE_MARGIN, screenToPage, type Size, type Viewport } from "../src/ink/viewport";
import { mapSize, viewRectOnMap, viewportCentredOn, visibleInPage } from "../src/model/minimap-geometry";
import { A4_HEIGHT, A4_WIDTH } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings, type NotebookSettings } from "../src/settings";
import { locateDrop } from "../src/view/drop-files-logic";
import { settingSpecs, settingsView, type SettingsContext } from "../src/view/settings-schema";

const A4 = { width: A4_WIDTH, height: A4_HEIGHT };
const LANDSCAPE = { width: A4_HEIGHT, height: A4_WIDTH };
const tablet: Size = { width: 1280, height: 800 };
const phone: Size = { width: 390, height: 780 };

describe("rows of a spread", () => {
	it("pairs 1-2, 3-4 without the first page alone", () => {
		expect(spreadRows(5, false)).toEqual([[0, 1], [2, 3], [4]]);
		expect(spreadRows(4, false)).toEqual([[0, 1], [2, 3]]);
	});

	it("puts the first page alone like a book, then 2-3, 4-5", () => {
		expect(spreadRows(5, true)).toEqual([[0], [1, 2], [3, 4]]);
		expect(spreadRows(4, true)).toEqual([[0], [1, 2], [3]]);
		expect(spreadRows(2, true)).toEqual([[0], [1]]);
	});

	it("handles none and one page", () => {
		expect(spreadRows(0, true)).toEqual([]);
		expect(spreadRows(1, true)).toEqual([[0]]);
		expect(spreadRows(1, false)).toEqual([[0]]);
	});
});

describe("spread layout", () => {
	it("puts the two pages of a pair side by side with a gap, rows stacked", () => {
		const l = layoutSpread([A4, A4, A4, A4], { firstAlone: false });
		expect(l.boxes[0]).toEqual({ x: 0, y: 0, width: A4.width, height: A4.height });
		expect(l.boxes[1]!.x).toBeCloseTo(A4.width + SPREAD_GAP_H);
		expect(l.boxes[1]!.y).toBe(0);
		expect(l.boxes[2]!.x).toBe(0);
		expect(l.boxes[2]!.y).toBeGreaterThan(A4.height);
		expect(l.boxes[3]!.y).toBe(l.boxes[2]!.y);
		expect(l.width).toBeCloseTo(2 * A4.width + SPREAD_GAP_H);
		expect(l.height).toBeCloseTo(2 * A4.height + 24);
		expect(l.rows).toEqual([[0, 1], [2, 3]]);
	});

	it("keeps the first page alone on the right and the last of an odd count alone on the left", () => {
		const l = layoutSpread([A4, A4, A4, A4], { firstAlone: true });
		const right = A4.width + SPREAD_GAP_H;
		expect(l.boxes[0]!.x).toBeCloseTo(right);
		expect(l.boxes[1]!.x).toBe(0);
		expect(l.boxes[2]!.x).toBeCloseTo(right);
		expect(l.boxes[3]!.x).toBe(0); // 4 pages, first alone: the last is alone on the left
		expect(l.boxes[3]!.y).toBeGreaterThan(l.boxes[2]!.y);
		expect(l.width).toBeCloseTo(2 * A4.width + SPREAD_GAP_H);
		const paired = layoutSpread([A4, A4, A4, A4, A4], { firstAlone: true });
		expect(paired.rows).toEqual([[0], [1, 2], [3, 4]]);
		expect(paired.boxes[4]!.x).toBeCloseTo(right);
	});

	it("is just the page for one page and empty for none", () => {
		expect(layoutSpread([A4])).toEqual({ boxes: [{ x: 0, y: 0, width: A4.width, height: A4.height }], width: A4.width, height: A4.height, rows: [[0]] });
		expect(layoutSpread([])).toEqual({ boxes: [], width: 0, height: 0, rows: [] });
	});

	it("aligns pages of different sizes by the top, with the binding on the same line in every row", () => {
		const l = layoutSpread([A4, LANDSCAPE, A4, A4, LANDSCAPE, A4], { firstAlone: false });
		// row 0: portrait next to landscape
		expect(l.boxes[0]!.y).toBe(0);
		expect(l.boxes[1]!.y).toBe(0);
		// the row is as tall as the tallest page; the next row starts after it plus the gap
		expect(l.boxes[2]!.y).toBeCloseTo(Math.max(A4.height, LANDSCAPE.height) + 24);
		// the binding: every left page ends where the left slot ends, every right page starts after the gap
		const leftEnd = l.boxes[0]!.x + l.boxes[0]!.width;
		for (const i of [0, 2, 4]) expect(l.boxes[i]!.x + l.boxes[i]!.width).toBeCloseTo(leftEnd);
		const rightStart = l.boxes[1]!.x;
		for (const i of [1, 3, 5]) expect(l.boxes[i]!.x).toBeCloseTo(rightStart);
		expect(rightStart - leftEnd).toBeCloseTo(SPREAD_GAP_H);
		// a narrower page in a wide slot hugs the binding
		expect(l.boxes[2]!.x).toBeCloseTo(leftEnd - A4.width);
		// nothing sticks out of the layout
		for (const b of l.boxes) {
			expect(b.x).toBeGreaterThanOrEqual(0);
			expect(b.x + b.width).toBeLessThanOrEqual(l.width + 1e-9);
		}
		expect(l.boxes.map((b) => [b.width, b.height])).toEqual([A4, LANDSCAPE, A4, A4, LANDSCAPE, A4].map((p) => [p.width, p.height]));
	});

	it("never overlaps two pages", () => {
		const sizes = [A4, LANDSCAPE, A4, LANDSCAPE, LANDSCAPE, A4, A4];
		for (const firstAlone of [true, false]) {
			const l = layoutSpread(sizes, { firstAlone });
			for (let i = 0; i < l.boxes.length; i++) {
				for (let j = i + 1; j < l.boxes.length; j++) {
					const a = l.boxes[i]!, b = l.boxes[j]!;
					const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
					expect(apart, `${i} and ${j} (first alone: ${firstAlone})`).toBe(true);
				}
			}
		}
	});

	it("is chosen by layoutForMode and leaves the other modes alone", () => {
		const pages = [A4, A4, A4];
		expect(layoutForMode("spread", pages, (p) => layoutPages(p), DEFAULT_SPREAD).rows).toEqual([[0], [1, 2]]);
		expect(layoutForMode("spread", pages, (p) => layoutPages(p), { firstAlone: false }).rows).toEqual([[0, 1], [2]]);
		expect(layoutForMode("continuous", pages, (p) => layoutPages(p))).toEqual(layoutPages(pages));
		expect(layoutForMode("pages", pages, (p) => layoutPages(p)).boxes.map((b) => b.y)).toEqual([0, 0, 0]);
		expect(layoutForMode("pages", pages, (p) => layoutPages(p)).rows).toBeUndefined();
	});
});

describe("rows and mates", () => {
	const l = layoutSpread([A4, A4, A4, A4, A4], { firstAlone: true });

	it("finds the other page of a pair", () => {
		expect(rowOf(l, 2)).toEqual([1, 2]);
		expect(mateOf(l, 1)).toBe(2);
		expect(mateOf(l, 2)).toBe(1);
		expect(mateOf(l, 0)).toBe(-1); // alone
		expect(mateOf(l, 99)).toBe(-1);
		expect(mateOf(layoutPages([A4, A4]), 0)).toBe(-1); // no spread
		expect(isSpreadLayout(l)).toBe(true);
		expect(isSpreadLayout(layoutPages([A4, A4]))).toBe(false);
		expect(isSpreadLayout(layoutSpread([A4]))).toBe(false);
	});

	it("turns by pair", () => {
		expect(stepRow(l, 0, 1)).toBe(1);
		expect(stepRow(l, 1, 1)).toBe(3);
		expect(stepRow(l, 2, 1)).toBe(3); // from the right page of the pair: the next pair
		expect(stepRow(l, 4, 1)).toBe(3); // already on the last row
		expect(stepRow(l, 3, -1)).toBe(1);
		expect(stepRow(l, 2, -1)).toBe(0);
		expect(stepRow(l, 0, -1)).toBe(0);
		expect(stepRow(layoutPages([A4, A4, A4]), 1, 1)).toBe(2);
		expect(stepRow(layoutPages([A4, A4, A4]), 2, 5)).toBe(2);
	});
});

describe("when the view has room", () => {
	it("needs a wide landscape view", () => {
		expect(canSpread(tablet)).toBe(true);
		expect(canSpread({ width: SPREAD_MIN_WIDTH, height: 600 })).toBe(true);
		expect(canSpread({ width: SPREAD_MIN_WIDTH - 1, height: 600 })).toBe(false);
		expect(canSpread({ width: 800, height: 1280 })).toBe(false); // a portrait tablet
		expect(canSpread(phone)).toBe(false);
		expect(canSpread({ width: 0, height: 0 })).toBe(false);
	});

	it("falls back to one column on a phone, and honours the automatic setting only in continuous mode", () => {
		expect(effectiveScrollMode("spread", false, tablet)).toBe("spread");
		expect(effectiveScrollMode("spread", false, phone)).toBe("continuous");
		expect(effectiveScrollMode("continuous", false, tablet)).toBe("continuous");
		expect(effectiveScrollMode("continuous", true, tablet)).toBe("spread");
		expect(effectiveScrollMode("continuous", true, phone)).toBe("continuous");
		expect(effectiveScrollMode("pages", true, tablet)).toBe("pages");
		expect(effectiveScrollMode("pages", false, phone)).toBe("pages");
	});

	it("knows the new mode", () => {
		expect(SCROLL_MODES).toContain("spread");
		expect(isScrollMode("spread")).toBe(true);
		expect(isScrollMode("double")).toBe(false);
	});
});

describe("which page a point is on", () => {
	const l = layoutSpread([A4, A4, A4, A4], { firstAlone: false });
	const right = l.boxes[1]!;

	it("finds the page and the point in its own coordinates", () => {
		expect(pageAt(l, 10, 10)).toBe(0);
		expect(pageAt(l, right.x + 10, 10)).toBe(1);
		const [x, y] = toPageLocal(right, right.x + 40, 25);
		expect([x, y]).toEqual([40, 25]);
		expect(pageAt(l, 10, l.boxes[2]!.y + 5)).toBe(2);
		expect(pageAt(l, right.x + 10, l.boxes[3]!.y + 5)).toBe(3);
	});

	it("gives a point in the gap to the nearer page, and none to a point far away", () => {
		const mid = A4.width + SPREAD_GAP_H / 2;
		expect(pageAt(l, mid - 5, 10, 8)).toBe(0);
		expect(pageAt(l, mid + 5, 10, 8)).toBe(1);
		expect(pageAt(l, mid, 10, 0)).toBe(-1);
		expect(pageAt(l, -500, 10, 8)).toBe(-1);
	});

	it("keeps a stroke on the page it started on: its points are in that page's coordinates, also past its edge", () => {
		// a stroke that starts on the left page and ends over the right one
		const start = pageAt(l, A4.width - 20, 300, 8);
		expect(start).toBe(0);
		const box = l.boxes[start]!;
		const endDoc = right.x + 30;
		const [px] = toPageLocal(box, endDoc, 300);
		expect(px).toBeGreaterThan(A4.width); // beyond the page's own right edge (the page clips it)
		// ...and the same point on the right page would be at 30: the two coordinate systems never mix
		expect(toPageLocal(right, endDoc, 300)[0]).toBe(30);
	});

	it("tells the page and local point under a screen point", () => {
		const fit = fitWidth(tablet, l);
		const hit = pageUnderScreen(l, fit, fit.offsetX + (right.x + 50) * fit.scale, fit.offsetY + 80 * fit.scale);
		expect(hit?.index).toBe(1);
		expect(hit?.x).toBeCloseTo(50);
		expect(hit?.y).toBeCloseTo(80);
		expect(pageUnderScreen(l, fit, -100, -100)).toBeNull();
		expect(pageUnderScreen(l, fit, Number.NaN, 5)).toBeNull();
	});

	it("tells the current page of a row apart by the side", () => {
		const mid = A4.width + SPREAD_GAP_H / 2;
		expect(nearestPage(l, 100)).toBe(0); // without x, the first of the row
		expect(nearestPage(l, 100, mid - 1)).toBe(0);
		expect(nearestPage(l, 100, mid + 1)).toBe(1);
		expect(nearestPage(l, 100, right.x + 100)).toBe(1);
		expect(nearestPage(l, l.boxes[2]!.y + 100, right.x + 100)).toBe(3);
		// below the last row: the last row's page nearer sideways
		expect(nearestPage(l, 1e6, right.x + 100)).toBe(3);
		expect(nearestPage(l, 1e6, 10)).toBe(2);
	});

	it("with both pages of a pair in view, the page last touched is the page; zoomed in on one, that one is (S1)", () => {
		const mid = A4.width + SPREAD_GAP_H / 2;
		// the middle of the view in the binding: a point either way would flip the nearest page, so the touched page decides
		for (const cx of [mid - 1, mid, mid + 1]) {
			const nearest = nearestPage(l, 100, cx);
			expect(spreadTarget(l, cx, nearest, 1)).toBe(1);
			expect(spreadTarget(l, cx, nearest, 0)).toBe(0);
			expect(spreadTarget(l, cx, nearest, -1)).toBe(nearest); // nothing touched: as before
		}
		// a page of another row, or of no pair, does not move the target
		expect(spreadTarget(l, mid, 0, 2)).toBe(0);
		expect(spreadTarget(l, mid, 1, 3)).toBe(1);
		// zoomed in on the left page (the middle well inside it): it wins even when the right page was touched
		expect(spreadTarget(l, 100, 0, 1)).toBe(0);
		expect(spreadTarget(l, right.x + 300, 1, 0)).toBe(1);
		// near the binding but inside the zone still counts as both in view
		expect(spreadTarget(l, A4.width - 0.2 * A4.width, 0, 1)).toBe(1);
		// a lone page (first alone, last of an odd count) is just itself
		const odd = layoutSpread([A4, A4, A4], DEFAULT_SPREAD);
		expect(spreadTarget(odd, A4.width / 2, 0, 1)).toBe(0);
	});

	it("the eraser by the binding reaches both pages of the pair, away from it only one (S4)", () => {
		const mid = A4.width + SPREAD_GAP_H / 2;
		// a large eraser (radius 20 pt) over the right page, a little right of the binding: the left page is within reach too
		expect(pagesTouching(l, mid + 6, 100, 20)).toEqual([0, 1]);
		expect(pagesTouching(l, mid - 6, 100, 20)).toEqual([0, 1]);
		// a small one (radius 4 pt) only the page it is over
		expect(pagesTouching(l, mid + 6, 100, 4)).toEqual([]);
		expect(pagesTouching(l, right.x + 2, 100, 4)).toEqual([1]);
		// well inside a page: that page alone
		expect(pagesTouching(l, 200, 100, 20)).toEqual([0]);
		expect(pagesTouching(l, right.x + 200, 100, 20)).toEqual([1]);
		// the next row is far below
		expect(pagesTouching(l, mid, l.boxes[2]!.y + 50, 20)).toEqual([2, 3]);
		// the circle, not the square: a corner just out of reach is not touched
		expect(pagesTouching(l, mid, A4.height + 100, 10)).toEqual([]);
		expect(pagesTouching({ boxes: [], width: 0, height: 0 }, 0, 0, 10)).toEqual([]);
	});

	it("a resize waits for the stroke in progress, then lays out once (S3)", () => {
		expect(relayoutStep(false, false)).toBe("idle");
		expect(relayoutStep(false, true)).toBe("idle");
		expect(relayoutStep(true, true)).toBe("wait");
		expect(relayoutStep(true, false)).toBe("now");
	});

	it("is unchanged for a single column", () => {
		const v = layoutPages([A4, A4, A4]);
		expect(nearestPage(v, 900)).toBe(nearestPage(v, 900, 10));
		expect(nearestPage(v, 1e6, 5000)).toBe(2);
	});

	it("shows the page in the middle of the scrollbar bubble", () => {
		const fit = fitWidth(tablet, l);
		const atRight: Viewport = { ...fit, offsetX: fit.offsetX };
		const centre = screenToPage(atRight, tablet.width / 2, tablet.height / 2);
		const expected = centre[0] > A4.width + SPREAD_GAP_H / 2 ? 1 : 0;
		expect(pageAtOffset(l, atRight, tablet, atRight.offsetY)).toBe(expected);
		// zoomed on the right page
		const zoomed: Viewport = { scale: fit.scale * 2, offsetX: tablet.width / 2 - (right.x + 200) * fit.scale * 2, offsetY: 0 };
		expect(pageAtOffset(l, zoomed, tablet, zoomed.offsetY)).toBe(1);
	});

	it("lists both pages of the row in view", () => {
		const fit = fitWidth(tablet, l);
		const rect = { minX: -fit.offsetX / fit.scale, minY: 0, maxX: (tablet.width - fit.offsetX) / fit.scale, maxY: 10 };
		expect(visiblePages(l, rect)).toEqual([0, 1]);
	});
});

describe("scrolling to a page", () => {
	const l = layoutSpread([A4, A4, A4, A4, A4, A4], { firstAlone: false });
	const fit = fitWidth(tablet, l);

	it("puts the row's top at the margin, for either page of the pair", () => {
		const a = scrollToPageViewport(l, fit, tablet, 2);
		const b = scrollToPageViewport(l, fit, tablet, 3);
		expect(a.offsetY).toBeCloseTo(PAGE_MARGIN - l.boxes[2]!.y * fit.scale);
		expect(b.offsetY).toBeCloseTo(a.offsetY);
		// at fit zoom the spread is centred whichever page is asked for: no sideways move
		expect(a.offsetX).toBe(fit.offsetX);
		expect(b.offsetX).toBe(fit.offsetX);
	});

	it("goes to a line of the page", () => {
		const v = scrollToPageViewport(l, fit, tablet, 3, 300);
		expect(v.offsetY).toBeCloseTo(-(l.boxes[3]!.y + 300) * fit.scale);
	});

	it("brings the other page into the middle when zoomed in on one of them", () => {
		const zoom = fit.scale * 2.5;
		const onLeft: Viewport = { scale: zoom, offsetX: tablet.width / 2 - (l.boxes[0]!.x + 300) * zoom, offsetY: 0 };
		const toRight = scrollToPageViewport(l, onLeft, tablet, 1);
		const centre = screenToPage(toRight, tablet.width / 2, 0)[0];
		expect(centre).toBeCloseTo(l.boxes[1]!.x + A4.width / 2);
		// the same page: only vertical
		const same = scrollToPageViewport(l, onLeft, tablet, 2);
		expect(same.offsetX).toBe(onLeft.offsetX);
		// after the view's clamp the page is on screen
		const clamped = clampToPage(toRight, tablet, l);
		const [x] = screenToPage(clamped, tablet.width / 2, 0);
		expect(x).toBeGreaterThan(l.boxes[1]!.x);
	});

	it("is the old vertical scroll in a single column", () => {
		const col = layoutPages([A4, A4, A4]);
		const v: Viewport = { scale: 1, offsetX: 12, offsetY: 0 };
		expect(scrollToPageViewport(col, v, tablet, 2)).toEqual({ scale: 1, offsetX: 12, offsetY: PAGE_MARGIN - col.boxes[2]!.y });
		expect(scrollToPageViewport(col, v, tablet, 2, 100).offsetY).toBe(-(col.boxes[2]!.y + 100));
		expect(scrollToPageViewport(col, v, tablet, 9)).toBe(v);
	});
});

describe("position and region in a spread", () => {
	const pages = Array.from({ length: 8 }, () => A4);
	const l = layoutSpread(pages, { firstAlone: true });

	function viewportOn(layout = l, view = tablet, index = 3, zoom = 2, x = 100, y = 300): Viewport {
		const fit = fitWidth(view, layout).scale;
		const box = layout.boxes[index]!;
		const scale = fit * zoom;
		return { scale, offsetX: -(box.x + x) * scale, offsetY: -(box.y + y) * scale };
	}

	it("measures the zoom against the page-wide fit, and a fitted spread is still fitted (S2)", () => {
		const fit = fitWidth(tablet, l);
		const pos = capturePosition("spread", fit, tablet, l, 1)!;
		expect(pos.zoom).toBeCloseTo(fit.scale / zoomBase("spread", tablet, l, 1), 3);
		expect(pos.zoom).toBeLessThan(0.6); // the pair fits at about half the zoom of one page
		expect(restoreViewport(pos, "spread", tablet, l)!.fit).toBe(true);
		// a page that fills the width is not the fit of a spread
		const page = capturePosition("spread", { ...fit, scale: zoomBase("spread", tablet, l, 1) }, tablet, l, 1)!;
		expect(page.zoom).toBeCloseTo(1, 3);
		expect(restoreViewport(page, "spread", tablet, l)!.fit).toBe(false);
	});

	it("a position saved in a spread comes back at the same page size in a single column, and the reverse (S2)", () => {
		const column = layoutPages(pages);
		const v = viewportOn(l, tablet, 4, 2, 80, 200); // twice the pair fit: about one page wide
		const pos = capturePosition("spread", v, tablet, l, 4)!;
		const inColumn = restoreViewport(pos, "continuous", tablet, column)!;
		// the page is as wide on the screen in both modes
		expect(inColumn.viewport.scale).toBeCloseTo(v.scale, 3);
		expect(inColumn.pageIndex).toBe(4);
		const [px, py] = screenToPage(inColumn.viewport, 0, 0);
		expect(px - column.boxes[4]!.x).toBeCloseTo(80, 0);
		expect(py - column.boxes[4]!.y).toBeCloseTo(200, 0);
		// ...and back
		const again = restoreViewport(capturePosition("continuous", inColumn.viewport, tablet, column, 4)!, "spread", tablet, l)!;
		expect(again.viewport.scale).toBeCloseTo(v.scale, 3);
		// a fitted column is a page-wide zoom in the spread (not the pair fit): the page keeps its size
		const fitted = capturePosition("continuous", fitWidth(tablet, column), tablet, column, 2)!;
		expect(fitted.zoom).toBeCloseTo(1, 3);
		expect(restoreViewport(fitted, "spread", tablet, l)!.viewport.scale).toBeCloseTo(fitWidth(tablet, column).scale, 3);
		expect(restoreViewport(fitted, "continuous", tablet, column)!.fit).toBe(true);
	});

	it("a region saved in a spread comes back at the same page size in a single column (S2)", () => {
		const column = layoutPages(pages);
		const v = viewportOn(l, tablet, 2, 3, 150, 220);
		const region = captureRegion("spread", v, tablet, l, 2)!;
		const back = restoreRegion(region, 2, "continuous", tablet, column)!;
		expect(back.viewport.scale).toBeCloseTo(v.scale, 3);
		const [mx] = screenToPage(back.viewport, tablet.width / 2, tablet.height / 2);
		expect(mx).toBeCloseTo(column.boxes[2]!.x + region.x + region.width / 2, 3);
	});

	it("round-trips the position on either page of a pair", () => {
		for (const index of [1, 2, 6, 7]) {
			const v = viewportOn(l, tablet, index);
			const pos = capturePosition("spread", v, tablet, l, index)!;
			expect(pos.page).toBe(index + 1);
			const back = restoreViewport(pos, "spread", tablet, l)!;
			expect(back.pageIndex).toBe(index);
			expect(back.fit).toBe(false);
			expect(back.viewport.scale).toBeCloseTo(v.scale, 5);
			expect(back.viewport.offsetX).toBeCloseTo(v.offsetX, 2);
			expect(back.viewport.offsetY).toBeCloseTo(v.offsetY, 2);
		}
	});

	it("restores the same part of the page on a different view size", () => {
		const v = viewportOn(l, tablet, 4, 2.5, 80, 200);
		const pos = capturePosition("spread", v, tablet, l, 4)!;
		const other: Size = { width: 1920, height: 1080 };
		const back = restoreViewport(pos, "spread", other, l)!;
		const [px, py] = screenToPage(back.viewport, 0, 0);
		expect(px - l.boxes[4]!.x).toBeCloseTo(80, 0);
		expect(py - l.boxes[4]!.y).toBeCloseTo(200, 0);
		expect(back.viewport.scale / zoomBase("spread", other, l, 4)).toBeCloseTo(pos.zoom, 3);
	});

	it("round-trips a region on the right page and centres it", () => {
		const v = viewportOn(l, tablet, 2, 3, 150, 220);
		const region = captureRegion("spread", v, tablet, l, 2)!;
		expect(region.pageIndex).toBe(2);
		const back = restoreRegion(region, 2, "spread", tablet, l)!;
		expect(back.pageIndex).toBe(2);
		// the middle of the region is the middle of the view
		const cx = region.x + region.width / 2 + l.boxes[2]!.x;
		const cy = region.y + region.height / 2 + l.boxes[2]!.y;
		const [mx, my] = screenToPage(back.viewport, tablet.width / 2, tablet.height / 2);
		expect(mx).toBeCloseTo(cx, 3);
		expect(my).toBeCloseTo(cy, 3);
		expect(back.viewport.scale).toBeCloseTo(v.scale, 6);
	});

	it("restores a region saved in a spread, on a view of another size, as the same part of the page", () => {
		const v = viewportOn(l, tablet, 5, 4, 60, 100);
		const region = captureRegion("spread", v, tablet, l, 5)!;
		const other: Size = { width: 1024, height: 768 };
		const back = restoreRegion(region, 5, "spread", other, l)!;
		const [mx] = screenToPage(back.viewport, other.width / 2, other.height / 2);
		expect(mx).toBeCloseTo(l.boxes[5]!.x + region.x + region.width / 2, 3);
		expect(back.viewport.scale / zoomBase("spread", other, l, 5)).toBeCloseTo(region.zoom, 4);
	});

	it("falls back to the pages that exist", () => {
		const pos = { page: 99, zoom: 1, x: 0, y: 0 };
		expect(restoreViewport(pos, "spread", tablet, l)!.pageIndex).toBe(7);
		expect(restoreRegion({ x: 0, y: 0, width: 100, height: 100, zoom: 1 }, 40, "spread", tablet, l)).toBeNull();
	});
});

describe("minimap in a spread", () => {
	const l = layoutSpread([A4, A4, A4, A4], { firstAlone: false });
	const right = l.boxes[1]!;

	it("maps the view onto the page it is on, whichever side of the pair", () => {
		const fit = fitWidth(tablet, l);
		const v: Viewport = { scale: fit.scale * 2, offsetX: tablet.width / 2 - (right.x + 100) * fit.scale * 2, offsetY: -50 * fit.scale * 2 };
		const seen = visibleInPage(v, tablet, right);
		expect(seen.x + seen.width / 2).toBeCloseTo(100, 3);
		const map = mapSize(right);
		const rect = viewRectOnMap(v, tablet, right, map);
		expect(rect.width).toBeGreaterThan(0);
		expect(rect.x + rect.width).toBeLessThanOrEqual(map.width);
	});

	it("centres the view on a point of the right page", () => {
		const fit = fitWidth(tablet, l);
		const map = mapSize(right);
		const v: Viewport = { scale: fit.scale * 2, offsetX: 0, offsetY: 0 };
		const next = viewportCentredOn(v, tablet, right, map, map.width / 2, map.height / 2);
		const [cx, cy] = screenToPage(next, tablet.width / 2, tablet.height / 2);
		expect(cx).toBeCloseTo(right.x + A4.width / 2, 0);
		expect(cy).toBeCloseTo(right.y + A4.height / 2, 0);
	});
});

describe("dropping onto a spread", () => {
	const l = layoutSpread([A4, A4, A4, A4], { firstAlone: false });
	const fit = fitWidth(tablet, l);
	const stage = { left: 0, top: 0, right: tablet.width, bottom: tablet.height };

	it("lands on the page under the pointer, in that page's coordinates", () => {
		const right = l.boxes[1]!;
		const at = locateDrop(l, fit, stage, fit.offsetX + (right.x + 40) * fit.scale, fit.offsetY + 90 * fit.scale)!;
		expect(at.pageIndex).toBe(1);
		expect(at.x).toBeCloseTo(40, 1);
		expect(at.y).toBeCloseTo(90, 1);
	});

	it("in the gap goes to the page nearer sideways", () => {
		const mid = A4.width + SPREAD_GAP_H / 2;
		const y = fit.offsetY + 100 * fit.scale;
		expect(locateDrop(l, fit, stage, fit.offsetX + (mid + 2) * fit.scale, y)!.pageIndex).toBe(1);
		expect(locateDrop(l, fit, stage, fit.offsetX + (mid - 2) * fit.scale, y)!.pageIndex).toBe(0);
	});
});

describe("settings", () => {
	it("default to the book layout, with the automatic spread off", () => {
		expect(DEFAULT_SETTINGS.spreadFirstAlone).toBe(true);
		expect(DEFAULT_SETTINGS.spreadAuto).toBe(false);
	});

	it("are read leniently", () => {
		expect(readSettings({ scrollMode: "spread", spreadFirstAlone: false, spreadAuto: true })).toMatchObject({ scrollMode: "spread", spreadFirstAlone: false, spreadAuto: true });
		const bad = readSettings({ scrollMode: "double", spreadFirstAlone: "yes", spreadAuto: 1 });
		expect(bad.scrollMode).toBe(DEFAULT_SETTINGS.scrollMode);
		expect(bad.spreadFirstAlone).toBe(true);
		expect(bad.spreadAuto).toBe(false);
	});

	it("show the spread options under the scrolling choice where they apply", () => {
		const context: SettingsContext = { sync: true, timetable: true, timetableInUse: false, timetablePath: "Notebooks/_timetable.json" };
		const shown = (patch: Partial<NotebookSettings>) => {
			const view = settingsView(settingSpecs(), { settings: { ...DEFAULT_SETTINGS, ...patch }, context, query: "", groupOverrides: new Map() });
			return new Set([...view.rows].filter(([, on]) => on).map(([id]) => id));
		};
		expect(shown({ scrollMode: "spread" }).has("spreadFirstAlone")).toBe(true);
		expect(shown({ scrollMode: "spread" }).has("spreadAuto")).toBe(false);
		expect(shown({ scrollMode: "continuous" }).has("spreadAuto")).toBe(true);
		expect(shown({ scrollMode: "continuous" }).has("spreadFirstAlone")).toBe(false);
		expect(shown({ scrollMode: "continuous", spreadAuto: true }).has("spreadFirstAlone")).toBe(true);
		expect(shown({ scrollMode: "pages" }).has("spreadAuto")).toBe(false);
		expect(shown({ scrollMode: "spread" }).has("fastScrollbar")).toBe(true);
		expect(shown({ scrollMode: "pages" }).has("fastScrollbar")).toBe(false);
	});
});
