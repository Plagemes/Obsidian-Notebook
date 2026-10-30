import { describe, expect, it } from "vitest";
import { layoutPages } from "../src/ink/layout";
import { MIN_THUMB_PX, offsetForPosition, pageAtOffset, positionAtPointer, scrollMetrics, thumbBox } from "../src/ink/scrollbar";
import { clampToPage, PAGE_MARGIN, screenToPage } from "../src/ink/viewport";

const view = { width: 800, height: 600 };
/** 20 pages of 600 x 800 pt at scale 1. */
const layout = layoutPages(Array.from({ length: 20 }, () => ({ width: 600, height: 800 })));
const at = (offsetY: number) => ({ scale: 1, offsetX: 100, offsetY });
const bottom = view.height - layout.height - PAGE_MARGIN;

describe("fast scrollbar geometry (roadmap 50)", () => {
	it("is not scrollable when the document fits the view", () => {
		const one = layoutPages([{ width: 600, height: 400 }]);
		expect(scrollMetrics(one, at(PAGE_MARGIN), view).scrollable).toBe(false);
		expect(scrollMetrics(layoutPages([]), at(0), view).scrollable).toBe(false);
		expect(offsetForPosition(0.5, one, 1, view)).toBeNull();
	});

	it("maps the scroll offset to a position from 0 (top) to 1 (bottom)", () => {
		expect(scrollMetrics(layout, at(PAGE_MARGIN), view).position).toBe(0);
		expect(scrollMetrics(layout, at(bottom), view).position).toBe(1);
		const mid = scrollMetrics(layout, at((PAGE_MARGIN + bottom) / 2), view);
		expect(mid.position).toBeCloseTo(0.5, 6);
		expect(mid.scrollable).toBe(true);
	});

	it("clamps positions outside the range", () => {
		expect(scrollMetrics(layout, at(500), view).position).toBe(0);
		expect(scrollMetrics(layout, at(-1e9), view).position).toBe(1);
	});

	it("sizes the thumb by the share of the document in view, never below the minimum", () => {
		const m = scrollMetrics(layout, at(PAGE_MARGIN), view);
		expect(m.size).toBeCloseTo(600 / (layout.height + 2 * PAGE_MARGIN), 6);
		const track = 584;
		const box = thumbBox(m, track);
		expect(box.length).toBe(MIN_THUMB_PX);
		expect(box.top).toBe(0);
		expect(thumbBox({ ...m, position: 1 }, track).top).toBeCloseTo(track - MIN_THUMB_PX, 6);
		// a short document gets a long thumb
		const few = layoutPages(Array.from({ length: 2 }, () => ({ width: 600, height: 800 })));
		const fm = scrollMetrics(few, at(PAGE_MARGIN), view);
		expect(thumbBox(fm, track).length).toBeGreaterThan(MIN_THUMB_PX);
		expect(thumbBox(fm, track).length).toBeLessThanOrEqual(track);
		expect(thumbBox(m, 0)).toEqual({ top: 0, length: 0 });
	});

	it("turns a pointer position back into a scroll position (the grabbed point stays under the pointer)", () => {
		const track = 584, length = 44;
		expect(positionAtPointer(0, 10, track, length)).toBe(0);
		expect(positionAtPointer(track, 10, track, length)).toBe(1);
		expect(positionAtPointer(10 + (track - length) / 2, 10, track, length)).toBeCloseTo(0.5, 6);
		expect(positionAtPointer(100, 0, 40, 40)).toBe(0);
	});

	it("round-trips position and offset, and every offset it returns is one the view allows", () => {
		for (const p of [0, 0.1, 0.37, 0.5, 0.99, 1]) {
			const offset = offsetForPosition(p, layout, 1, view)!;
			expect(scrollMetrics(layout, at(offset), view).position).toBeCloseTo(p, 6);
			expect(clampToPage(at(offset), view, layout).offsetY).toBeCloseTo(offset, 6);
		}
		expect(offsetForPosition(-3, layout, 1, view)).toBe(PAGE_MARGIN);
		expect(offsetForPosition(7, layout, 1, view)).toBeCloseTo(bottom, 6);
	});

	it("works at other zooms", () => {
		const v = { ...at(PAGE_MARGIN), scale: 0.5 };
		const m = scrollMetrics(layout, v, view);
		expect(m.scrollable).toBe(true);
		const offset = offsetForPosition(1, layout, 0.5, view)!;
		expect(offset).toBeCloseTo(view.height - layout.height * 0.5 - PAGE_MARGIN, 6);
	});

	it("names the page the page indicator shows (the one in the middle of the view)", () => {
		expect(pageAtOffset(layout, at(PAGE_MARGIN), view, PAGE_MARGIN)).toBe(0);
		expect(pageAtOffset(layout, at(PAGE_MARGIN), view, bottom)).toBe(19);
		const mid = pageAtOffset(layout, at(PAGE_MARGIN), view, offsetForPosition(0.5, layout, 1, view)!);
		expect(mid).toBeGreaterThanOrEqual(9);
		expect(mid).toBeLessThanOrEqual(10);
		// the same page the view reports for that offset
		const [, y] = screenToPage(at(offsetForPosition(0.5, layout, 1, view)!), view.width / 2, view.height / 2);
		expect(layout.boxes[mid]!.y - 24).toBeLessThanOrEqual(y);
	});

	it("passes every page while the thumb goes from top to bottom, in order", () => {
		let last = -1;
		for (let i = 0; i <= 200; i++) {
			const page = pageAtOffset(layout, at(PAGE_MARGIN), view, offsetForPosition(i / 200, layout, 1, view)!);
			expect(page).toBeGreaterThanOrEqual(last);
			last = page;
		}
		expect(last).toBe(19);
	});
});
