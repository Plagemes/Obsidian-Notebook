import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clampToAnchor, decideTurn, easeOutCubic, fitPageViewport, layoutPagesHorizontal, lerpViewport, nearestPageByX, PAGE_GAP_H,
	panRoom, recentVelocity, resistDrag, SwipeLock, turnViewport, TURN_DISTANCE,
} from "../src/ink/page-mode";
import { layoutPages } from "../src/ink/layout";
import { PAGE_MARGIN, screenToPage, type Size, type Viewport } from "../src/ink/viewport";
import { PageMode, type PageModeHost } from "../src/view/page-mode";
import { A4_HEIGHT, A4_WIDTH } from "../src/model/types";

const A4 = { width: A4_WIDTH, height: A4_HEIGHT };
const A5L = { width: A4_HEIGHT, height: A4_WIDTH }; // landscape page
const view: Size = { width: 800, height: 1000 };

describe("horizontal page layout", () => {
	it("puts pages side by side, top aligned, with a gap", () => {
		const l = layoutPagesHorizontal([A4, A4, A5L]);
		expect(l.boxes.map((b) => b.y)).toEqual([0, 0, 0]);
		expect(l.boxes[1]!.x).toBeCloseTo(A4.width + PAGE_GAP_H);
		expect(l.boxes[2]!.x).toBeCloseTo(2 * (A4.width + PAGE_GAP_H));
		expect(l.width).toBeCloseTo(2 * A4.width + A5L.width + 2 * PAGE_GAP_H);
		expect(l.height).toBe(Math.max(A4.height, A5L.height));
	});

	it("keeps the page sizes and has no pages for an empty document", () => {
		expect(layoutPagesHorizontal([])).toEqual({ boxes: [], width: 0, height: 0 });
		const vertical = layoutPages([A4, A4]);
		const horizontal = layoutPagesHorizontal([A4, A4]);
		expect(horizontal.boxes.map((b) => [b.width, b.height])).toEqual(vertical.boxes.map((b) => [b.width, b.height]));
	});

	it("finds the page nearest to an x coordinate", () => {
		const l = layoutPagesHorizontal([A4, A4, A4]);
		expect(nearestPageByX(l, 10)).toBe(0);
		expect(nearestPageByX(l, A4.width + PAGE_GAP_H + 5)).toBe(1);
		expect(nearestPageByX(l, A4.width + PAGE_GAP_H / 2 - 1)).toBe(0); // in the gap, closer to page 0
		expect(nearestPageByX(l, A4.width + PAGE_GAP_H / 2 + 1)).toBe(1);
		expect(nearestPageByX(l, -500)).toBe(0);
		expect(nearestPageByX(l, 1e6)).toBe(2);
		expect(nearestPageByX({ boxes: [], width: 0, height: 0 }, 0)).toBe(-1);
	});
});

describe("fit and clamp on one page", () => {
	const layout = layoutPagesHorizontal([A4, A4, A5L]);

	it("fits each page to the view width, centred, at its top", () => {
		const v0 = fitPageViewport(view, layout, 0);
		const v2 = fitPageViewport(view, layout, 2);
		expect(v0.scale).toBeCloseTo((view.width - 2 * PAGE_MARGIN) / A4.width);
		expect(v2.scale).toBeCloseTo((view.width - 2 * PAGE_MARGIN) / A5L.width);
		const [x] = screenToPage(v0, view.width / 2, 0);
		expect(x).toBeCloseTo(A4.width / 2);
		expect(layout.boxes[2]!.x * v2.scale + v2.offsetX).toBeCloseTo(PAGE_MARGIN);
		expect(v0.offsetY).toBe(PAGE_MARGIN);
	});

	it("does not show the neighbouring page at rest", () => {
		const v = fitPageViewport(view, layout, 1);
		const b0 = layout.boxes[0]!;
		const b2 = layout.boxes[2]!;
		expect((b0.x + b0.width) * v.scale + v.offsetX).toBeLessThan(0);
		expect(b2.x * v.scale + v.offsetX).toBeGreaterThan(view.width);
	});

	it("clamps to the anchor page only", () => {
		const fitted = fitPageViewport(view, layout, 1);
		// Trying to pan far to the left on a page that fits: stays centred.
		const moved = clampToAnchor({ ...fitted, offsetX: fitted.offsetX - 5000 }, view, layout, 1);
		expect(moved.offsetX).toBeCloseTo(fitted.offsetX);
		// Zoomed in: the right edge of the page cannot pass the right margin.
		const zoomed: Viewport = { scale: fitted.scale * 3, offsetX: 0, offsetY: 0 };
		const clamped = clampToAnchor({ ...zoomed, offsetX: -1e6 }, view, layout, 1);
		const box = layout.boxes[1]!;
		expect((box.x + box.width) * zoomed.scale + clamped.offsetX).toBeCloseTo(view.width - PAGE_MARGIN);
		const clampedLeft = clampToAnchor({ ...zoomed, offsetX: 1e6 }, view, layout, 1);
		expect(box.x * zoomed.scale + clampedLeft.offsetX).toBeCloseTo(PAGE_MARGIN);
	});

	it("tells whether the page can be panned at this zoom", () => {
		const fitted = fitPageViewport(view, layout, 0);
		expect(panRoom(fitted, view, layout, 0).x).toBe(false);
		expect(panRoom({ ...fitted, scale: fitted.scale * 2 }, view, layout, 0).x).toBe(true);
		// A4 at fit width on a 800x1000 view is taller than the view.
		expect(panRoom(fitted, view, layout, 0).y).toBe(fitted.scale * A4.height + 2 * PAGE_MARGIN > view.height);
		expect(panRoom(fitted, view, { boxes: [], width: 0, height: 0 }, 0)).toEqual({ x: false, y: false });
	});
});

describe("turning", () => {
	const layout = layoutPagesHorizontal([A4, A4, A4]);
	const fitted = fitPageViewport(view, layout, 0);

	it("fit mode: the next page is fitted at its top", () => {
		const to = turnViewport({ ...fitted, offsetY: -300 }, view, layout, 0, 1, true);
		expect(to).toEqual(clampToAnchor(fitPageViewport(view, layout, 1), view, layout, 1));
		expect(to.offsetY).toBe(PAGE_MARGIN);
	});

	it("zoomed in: lands on the near edge of the new page at the same height and zoom", () => {
		const scale = fitted.scale * 2.5;
		const at: Viewport = { scale, offsetX: PAGE_MARGIN, offsetY: -700 };
		const forward = turnViewport(at, view, layout, 0, 1, false);
		expect(forward.scale).toBe(scale);
		expect(layout.boxes[1]!.x * scale + forward.offsetX).toBeCloseTo(PAGE_MARGIN);
		expect(forward.offsetY).toBeCloseTo(-700);
		const back = turnViewport(forward, view, layout, 1, 0, false);
		expect((layout.boxes[0]!.x + A4.width) * scale + back.offsetX).toBeCloseTo(view.width - PAGE_MARGIN);
	});

	it("decides when a drag or a flick turns the page", () => {
		const w = view.width;
		expect(decideTurn(-w * TURN_DISTANCE - 1, 0, w, true, true)).toBe(1);
		expect(decideTurn(w * TURN_DISTANCE + 1, 0, w, true, true)).toBe(-1);
		expect(decideTurn(-w * TURN_DISTANCE + 20, 0, w, true, true)).toBe(0);
		// A short fast flick turns; a fast movement that ends in the other direction does not.
		expect(decideTurn(-50, -0.8, w, true, true)).toBe(1);
		expect(decideTurn(-50, 0.8, w, true, true)).toBe(0);
		expect(decideTurn(-20, -2, w, true, true)).toBe(0);
		// No page beyond the ends.
		expect(decideTurn(-w, -2, w, true, false)).toBe(0);
		expect(decideTurn(w, 2, w, false, true)).toBe(0);
	});

	it("measures the velocity of the last moves only", () => {
		expect(recentVelocity([])).toBe(0);
		const slowThenFast = [{ t: 0, dx: 5 }, { t: 400, dx: 5 }, { t: 410, dx: -20 }, { t: 420, dx: -20 }];
		expect(recentVelocity(slowThenFast)).toBeLessThan(-1);
		expect(recentVelocity([{ t: 100, dx: 30 }])).toBeCloseTo(30 / 16);
	});

	it("resists dragging past the first and last page", () => {
		expect(resistDrag(100, false, true)).toBeLessThan(100);
		expect(resistDrag(100, true, true)).toBe(100);
		expect(resistDrag(-100, true, false)).toBeGreaterThan(-100);
		expect(resistDrag(-100, false, true)).toBe(-100);
	});

	it("eases and interpolates", () => {
		expect(easeOutCubic(0)).toBe(0);
		expect(easeOutCubic(1)).toBe(1);
		expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
		const mid = lerpViewport({ scale: 1, offsetX: 0, offsetY: 0 }, { scale: 3, offsetX: 100, offsetY: -50 }, 0.5);
		expect(mid).toEqual({ scale: 2, offsetX: 50, offsetY: -25 });
	});
});

describe("swipe direction lock", () => {
	it("waits for a few pixels, then applies what it held back along the chosen axis", () => {
		const lock = new SwipeLock();
		expect(lock.add(3, 1, { panX: false, panY: true })).toEqual({ panX: 0, panY: 0, dragX: 0 });
		const step = lock.add(12, 2, { panX: false, panY: true });
		expect(lock.axis).toBe("x");
		expect(step.dragX).toBe(15);
		expect(lock.add(-4, 9, { panX: false, panY: true })).toEqual({ panX: 0, panY: 0, dragX: -4 });
	});

	it("scrolls inside a tall page when the finger moves mostly up or down", () => {
		const lock = new SwipeLock();
		const step = lock.add(4, -30, { panX: false, panY: true });
		expect(lock.axis).toBe("y");
		expect(step).toEqual({ panX: 0, panY: -30, dragX: 0 });
		// A crooked finger afterwards still only scrolls.
		expect(lock.add(20, -5, { panX: false, panY: true })).toEqual({ panX: 0, panY: -5, dragX: 0 });
	});

	it("any sideways movement is a page drag when the page does not scroll vertically", () => {
		const lock = new SwipeLock();
		lock.add(2, 14, { panX: false, panY: false });
		expect(lock.axis).toBe("x");
	});

	it("pans freely when the page is zoomed wider than the view", () => {
		const lock = new SwipeLock();
		const step = lock.add(20, 20, { panX: true, panY: true });
		expect(lock.axis).toBe("free");
		expect(step).toEqual({ panX: 20, panY: 20, dragX: 0 });
	});

	it("starts over after reset", () => {
		const lock = new SwipeLock();
		lock.add(50, 0, { panX: false, panY: true });
		lock.reset();
		expect(lock.axis).toBe("none");
		expect(lock.add(1, 1, { panX: false, panY: true }).dragX).toBe(0);
	});
});

// --- the controller, with a fake stage and a fake host ---

interface FakeStage {
	listeners: Map<string, Array<(e: unknown) => void>>;
	addEventListener(type: string, fn: (e: unknown) => void): void;
	removeEventListener(type: string, fn: (e: unknown) => void): void;
	fire(type: string, e: unknown): void;
}

function fakeStage(): FakeStage {
	const listeners = new Map<string, Array<(e: unknown) => void>>();
	return {
		listeners,
		addEventListener(type, fn) {
			listeners.set(type, [...(listeners.get(type) ?? []), fn]);
		},
		removeEventListener(type, fn) {
			listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
		},
		fire(type, e) {
			for (const fn of listeners.get(type) ?? []) fn(e);
		},
	};
}

describe("PageMode controller", () => {
	let frames: Array<(t: number) => void> = [];
	let clock = 1000;

	beforeEach(() => {
		frames = [];
		clock = 1000;
		vi.stubGlobal("window", {
			requestAnimationFrame: (fn: (t: number) => void) => frames.push(fn),
			cancelAnimationFrame: () => undefined,
			matchMedia: () => ({ matches: false }),
		});
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function setup(pages = 3, fit = true) {
		const layout = layoutPagesHorizontal(Array.from({ length: pages }, () => A4));
		const stage = fakeStage();
		let viewport = fitPageViewport(view, layout, 0);
		let fitMode = fit;
		const ref: { pm: PageMode | null } = { pm: null };
		const applied: Array<{ v: Viewport; interactive: boolean }> = [];
		const host: PageModeHost = {
			viewport: () => viewport,
			viewSize: () => view,
			layout: () => layout,
			setViewport: (v, interactive) => {
				viewport = ref.pm!.clamp(v);
				applied.push({ v: viewport, interactive });
			},
			fitMode: () => fitMode,
		};
		const pm = new PageMode(stage as unknown as HTMLElement, host);
		ref.pm = pm;
		pm.setEnabled(true);
		pm.goTo(0);
		return {
			pm, stage, layout, applied,
			get viewport() {
				return viewport;
			},
			setFit(f: boolean) {
				fitMode = f;
			},
			down(id = 1, type = "touch") {
				stage.fire("pointerdown", { pointerId: id, pointerType: type, button: 0 });
			},
			up(id = 1, type = "touch") {
				stage.fire("pointerup", { pointerId: id, pointerType: type, button: 0 });
			},
			/** Runs the turn animation to its end. */
			settle() {
				for (let i = 0; i < 40 && frames.length > 0; i++) {
					clock += 100;
					const f = frames.shift()!;
					f(clock);
				}
			},
		};
	}

	/** Pan steps of `dx` each, 10 ms apart. */
	function swipe(s: ReturnType<typeof setup>, dx: number, steps: number, dy = 0): void {
		for (let i = 0; i < steps; i++) {
			clock += 10;
			s.pm.pan(dx, dy);
		}
	}

	it("starts on the first page, fitted, and reports it as current", () => {
		const s = setup();
		expect(s.pm.current()).toBe(0);
		expect(s.viewport).toEqual(clampToAnchor(fitPageViewport(view, s.layout, 0), view, s.layout, 0));
	});

	it("a long finger swipe to the left turns to the next page, which snaps into place", () => {
		const s = setup();
		const start = s.viewport;
		s.down();
		swipe(s, -40, 8); // 320 px > 22% of 800
		expect(s.pm.dragging).toBe(true);
		expect(s.viewport.offsetX).toBeLessThan(start.offsetX - 100); // the page follows the finger
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(1);
		expect(s.pm.busy).toBe(false);
		expect(s.viewport).toEqual(clampToAnchor(fitPageViewport(view, s.layout, 1), view, s.layout, 1));
	});

	it("a short slow drag springs back to the same page", () => {
		const s = setup();
		const start = s.viewport;
		s.down();
		swipe(s, 5, 8); // 40 px to the right, slow
		clock += 400;
		s.pm.pan(0.1, 0); // the finger rested before lifting
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(0);
		expect(s.viewport).toEqual(start);
	});

	it("a quick flick turns even when short", () => {
		const s = setup();
		s.down();
		swipe(s, 15, 4); // 60 px right in 40 ms = 1.5 px/ms
		s.up();
		s.settle();
		// Page 0 has no previous page: stays. Flick the other way from page 1.
		expect(s.pm.current()).toBe(0);
		s.down();
		swipe(s, -15, 4);
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(1);
	});

	it("cannot go past the last page or before the first", () => {
		const s = setup(2);
		s.down();
		swipe(s, 60, 10);
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(0);
		s.pm.goTo(1);
		s.down();
		swipe(s, -60, 10);
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(1);
	});

	it("a mostly vertical drag scrolls inside the page and never turns it", () => {
		const s = setup();
		const start = s.viewport;
		s.down();
		swipe(s, 6, 10, -30); // wobbling sideways while scrolling
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(0);
		expect(s.viewport.offsetX).toBe(start.offsetX);
		expect(s.viewport.offsetY).toBeLessThan(start.offsetY);
	});

	it("the fling the controller adds after a sideways swipe does not move the page", () => {
		const s = setup();
		s.down();
		swipe(s, -40, 8);
		s.up();
		s.settle();
		const at = s.viewport;
		// Inertia: pans arrive with no finger down.
		clock += 500;
		s.pm.pan(-30, 0);
		s.pm.pan(-20, 10);
		expect(s.viewport).toEqual(at);
	});

	it("a pinch cancels a sideways drag", () => {
		const s = setup();
		const start = s.viewport;
		s.down(1);
		s.down(2);
		swipe(s, -40, 3);
		expect(s.pm.dragging).toBe(true);
		s.pm.zoomed(1.2);
		expect(s.pm.dragging).toBe(false);
		expect(s.viewport.offsetX).toBeCloseTo(start.offsetX);
		s.up(1);
		s.up(2);
		s.settle();
		expect(s.pm.current()).toBe(0);
	});

	it("zoomed in, panning stays inside the page; going on past its edge turns it", () => {
		const s = setup(3, false);
		const zoomed = { ...s.viewport, scale: s.viewport.scale * 3 };
		s.pm.setEnabled(true);
		// Zoom in on page 0 with its right edge at the right margin.
		const box = s.layout.boxes[0]!;
		const v: Viewport = { ...zoomed, offsetX: view.width - PAGE_MARGIN - (box.x + box.width) * zoomed.scale, offsetY: PAGE_MARGIN };
		(s as unknown as { applied: unknown[] }).applied.length = 0;
		// Go through the host so the clamp runs.
		const host = (s.pm as unknown as { host: PageModeHost }).host;
		host.setViewport(v, false);
		expect(s.viewport.offsetX).toBeCloseTo(v.offsetX);
		s.down();
		swipe(s, -8, 3); // pan to the left inside the page: already at the right edge, so this is overscroll
		const overscroll = s.pm.dragging;
		s.up();
		s.settle();
		// 24 px of overscroll is far from enough to turn.
		expect(overscroll).toBe(true);
		expect(s.pm.current()).toBe(0);
		s.down();
		swipe(s, -40, 8);
		s.up();
		s.settle();
		expect(s.pm.current()).toBe(1);
		// Landed at the left edge of page 1, same zoom.
		expect(s.viewport.scale).toBeCloseTo(zoomed.scale);
		expect(s.layout.boxes[1]!.x * zoomed.scale + s.viewport.offsetX).toBeCloseTo(PAGE_MARGIN);
	});

	it("the wheel: sideways travel turns the page once, then ignores the rest of the trackpad inertia", () => {
		const s = setup();
		const wheel = (dx: number, dy = 0) => {
			s.stage.fire("wheel", {});
			clock += 5;
			s.pm.pan(dx, dy);
		};
		wheel(-30);
		expect(s.pm.current()).toBe(0);
		wheel(-30);
		wheel(-30);
		s.settle();
		expect(s.pm.current()).toBe(1);
		for (let i = 0; i < 20; i++) wheel(-30);
		s.settle();
		expect(s.pm.current()).toBe(1);
	});

	it("next, previous and goTo (the commands and the page panel)", () => {
		const s = setup();
		expect(s.pm.previous()).toBe(false);
		expect(s.pm.next()).toBe(true);
		s.settle();
		expect(s.pm.current()).toBe(1);
		s.pm.goTo(2);
		expect(s.pm.current()).toBe(2);
		expect(s.pm.next()).toBe(false);
		s.pm.goTo(99);
		expect(s.pm.current()).toBe(2);
		s.pm.goTo(0);
		expect(s.pm.current()).toBe(0);
	});

	it("pen events never reach the gesture: only touch and the middle mouse button count as contacts", () => {
		const s = setup();
		s.down(1, "pen");
		s.down(2, "mouse"); // left button
		clock += 10;
		// A pan with no contacts is a fling or a wheel, not a drag.
		s.pm.pan(-300, 0);
		expect(s.pm.dragging).toBe(false);
		expect(s.pm.current()).toBe(0);
	});

	it("a finger put down during the animation finishes it first", () => {
		const s = setup();
		s.pm.next();
		expect(s.pm.busy).toBe(true);
		s.down();
		expect(s.pm.busy).toBe(false);
		expect(s.pm.current()).toBe(1);
	});

	it("keeps the anchor in range when pages are removed", () => {
		const s = setup(3);
		s.pm.goTo(2);
		const layout = layoutPagesHorizontal([A4]);
		(s.pm as unknown as { host: { layout: () => unknown } }).host.layout = () => layout;
		expect(s.pm.current()).toBe(0);
	});
});
