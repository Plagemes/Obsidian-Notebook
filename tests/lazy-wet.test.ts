import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazyWet, WET_IDLE_MS } from "../src/ink/lazy-wet";

vi.mock("obsidian", () => ({}));
import { Renderer } from "../src/ink/renderer";

// Review fix (D4): the marker's full-viewport wet canvas exists only around marker strokes.
describe("lazy wet canvas", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout, navigator: {} });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function make() {
		const live = new Set<number>();
		let made = 0;
		let busy = false;
		const wet = new LazyWet<{ id: number }>({
			create: () => {
				const item = { id: ++made };
				live.add(item.id);
				return item;
			},
			dispose: (item) => live.delete(item.id),
			busy: () => busy,
		});
		return { wet, live, made: () => made, setBusy: (b: boolean) => (busy = b) };
	}

	it("allocates nothing until a marker stroke asks, and nothing at all for the other pens", () => {
		const { wet, live, made } = make();
		expect(wet.peek()).toBeNull();
		wet.idle(); // a pen stroke ended: nothing to release
		vi.advanceTimersByTime(60_000);
		expect(made()).toBe(0);
		expect(live.size).toBe(0);
	});

	it("keeps the canvas across marker strokes that follow each other, then releases it after the idle time", () => {
		const { wet, live, made } = make();
		const a = wet.acquire();
		wet.idle();
		vi.advanceTimersByTime(WET_IDLE_MS - 1);
		expect(wet.acquire()).toBe(a); // the next marker stroke: same canvas, no new allocation
		wet.idle();
		vi.advanceTimersByTime(WET_IDLE_MS - 1);
		expect(live.size).toBe(1);
		vi.advanceTimersByTime(2);
		expect(live.size).toBe(0);
		expect(wet.peek()).toBeNull();
		expect(made()).toBe(1);
		// A marker stroke after the release allocates again, once.
		wet.acquire();
		expect(made()).toBe(2);
	});

	it("never releases a canvas that still holds ink; tries again later", () => {
		const { wet, live, setBusy } = make();
		wet.acquire();
		setBusy(true);
		wet.idle();
		vi.advanceTimersByTime(WET_IDLE_MS * 3);
		expect(live.size).toBe(1);
		setBusy(false);
		vi.advanceTimersByTime(WET_IDLE_MS + 1);
		expect(live.size).toBe(0);
	});

	it("destroy releases it at once and cancels the timer", () => {
		const { wet, live } = make();
		wet.acquire();
		wet.idle();
		wet.destroy();
		expect(live.size).toBe(0);
		vi.advanceTimersByTime(WET_IDLE_MS * 2);
		expect(live.size).toBe(0);
	});
});

// Review fix (D6): the colour filter dims the marker's ink like every other ink.
describe("setInk and the colour-meaning dimming", () => {
	const setInk = (Renderer.prototype as unknown as { setInk: (this: object, ctx: object, tool: string, color: string) => void }).setInk;
	const draw = (tool: string, dimNow: boolean, night = false) => {
		const ctx = { fillStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
		setInk.call({ inkColor: (_t: string, c: string) => c, dimNow, night }, ctx, tool, "#112233");
		return ctx;
	};

	it("multiplies the dimming into the marker, the highlighter and every pen", async () => {
		const { DIM_ALPHA } = await import("../src/model/colour-meaning");
		const { MARKER_ALPHA } = await import("../src/ink/stroke-shape");
		expect(draw("marker", false).globalAlpha).toBe(MARKER_ALPHA);
		expect(draw("marker", true).globalAlpha).toBeCloseTo(MARKER_ALPHA * DIM_ALPHA, 10);
		for (const tool of ["pen", "fountain", "brush", "shape"]) {
			expect(draw(tool, false).globalAlpha).toBe(1);
			expect(draw(tool, true).globalAlpha).toBe(DIM_ALPHA);
		}
		expect(draw("highlighter", true).globalAlpha).toBeLessThan(draw("highlighter", false).globalAlpha);
	});
});
