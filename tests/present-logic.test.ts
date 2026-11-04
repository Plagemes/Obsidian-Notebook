import { describe, expect, it } from "vitest";
import {
	classifyGesture, counterText, fitPage, LaserTrail, nextPos, prevPos, presentKeyAction, readPresentSettings, startPos, stepOrder, tapZone,
	type PresentPos,
} from "../src/view/present-logic";

const plain = { states: undefined };
const withStates = (n: number) => ({ states: { parts: [], list: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, name: `State ${i + 1}`, poses: [] })) } }) as never;

describe("presentation: the sequence of pages and states", () => {
	const pages = [plain, withStates(2), plain] as never[];

	it("a page with states is one step per state, preceded by the drawing as drawn", () => {
		expect(stepOrder(pages[1], true)).toEqual([null, "s1", "s2"]);
		expect(stepOrder(pages[1], false)).toEqual([null]);
		expect(stepOrder(pages[0], true)).toEqual([null]);
	});

	it("next steps through the states, then turns the page", () => {
		const seen: PresentPos[] = [];
		let pos: PresentPos | null = startPos(pages, 0, true);
		while (pos) {
			seen.push(pos);
			pos = nextPos(pages, pos, true);
		}
		expect(seen).toEqual([
			{ page: 0, state: null }, { page: 1, state: null }, { page: 1, state: "s1" }, { page: 1, state: "s2" }, { page: 2, state: null },
		]);
	});

	it("previous is the exact reverse, landing on the last state of a page it comes back to", () => {
		expect(prevPos(pages, { page: 2, state: null }, true)).toEqual({ page: 1, state: "s2" });
		expect(prevPos(pages, { page: 1, state: "s2" }, true)).toEqual({ page: 1, state: "s1" });
		expect(prevPos(pages, { page: 1, state: null }, true)).toEqual({ page: 0, state: null });
		expect(prevPos(pages, { page: 0, state: null }, true)).toBeNull();
	});

	it("with stepping off, pages only", () => {
		expect(nextPos(pages, { page: 0, state: null }, false)).toEqual({ page: 1, state: null });
		expect(nextPos(pages, { page: 1, state: null }, false)).toEqual({ page: 2, state: null });
		expect(nextPos(pages, { page: 2, state: null }, false)).toBeNull();
		expect(prevPos(pages, { page: 2, state: null }, false)).toEqual({ page: 1, state: null });
	});

	it("ends are null, an unknown state counts as the first step, the start is clamped", () => {
		expect(nextPos(pages, { page: 2, state: null }, true)).toBeNull();
		expect(nextPos(pages, { page: 1, state: "gone" }, true)).toEqual({ page: 1, state: "s1" });
		expect(startPos(pages, 99, true)).toEqual({ page: 2, state: null });
		expect(startPos(pages, -3, true)).toEqual({ page: 0, state: null });
		expect(startPos(pages, Number.NaN, true)).toEqual({ page: 0, state: null });
	});

	it("the counter shows the step only for a drawing with states", () => {
		expect(counterText(pages, { page: 0, state: null }, true)).toBe("1 / 3");
		expect(counterText(pages, { page: 1, state: "s1" }, true)).toBe("2 / 3 · 2/3");
		expect(counterText(pages, { page: 1, state: "s1" }, false)).toBe("2 / 3");
	});
});

describe("presentation: input", () => {
	it("maps the keys of a keyboard and of a presenter remote", () => {
		const a = (key: string, extra: object = {}) => presentKeyAction({ key, ...extra });
		expect(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].map((k) => a(k))).toEqual(Array(5).fill("next"));
		expect(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].map((k) => a(k))).toEqual(Array(4).fill("prev"));
		expect(a(" ", { shiftKey: true })).toBe("prev");
		expect([a("Home"), a("End"), a("Escape"), a("b"), a("."), a("x")]).toEqual(["first", "last", "exit", "blank", "blank", null]);
		expect(a("ArrowRight", { ctrlKey: true })).toBeNull();
	});

	it("tap zones: the top strip reveals the controls, the left third goes back, the rest goes on", () => {
		expect(tapZone(10, 10, 900)).toBe("reveal");
		expect(tapZone(100, 300, 900)).toBe("prev");
		expect(tapZone(400, 300, 900)).toBe("next");
		expect(tapZone(880, 300, 900)).toBe("next");
	});

	it("tells taps from swipes", () => {
		expect(classifyGesture(2, 3, 120)).toBe("tap");
		expect(classifyGesture(2, 3, 900)).toBeNull();
		expect(classifyGesture(-120, 10, 200)).toBe("swipe-next");
		expect(classifyGesture(120, -10, 200)).toBe("swipe-prev");
		expect(classifyGesture(-120, 100, 200)).toBeNull();
		expect(classifyGesture(-30, 0, 100)).toBeNull();
		expect(classifyGesture(-200, 0, 2000)).toBeNull();
	});
});

describe("presentation: geometry, laser and settings", () => {
	it("fits a page to the screen without cropping, centred", () => {
		expect(fitPage(1000, 500, 800, 800)).toEqual({ x: 0, y: 200, width: 800, height: 400 });
		const tall = fitPage(500, 700, 1600, 800);
		expect(tall.height).toBeCloseTo(800);
		expect(tall.width).toBeCloseTo(800 / 1.4);
		expect(tall.x).toBeCloseTo((1600 - 800 / 1.4) / 2);
		const infinite = fitPage(500, 20000, 800, 800);
		expect(infinite.height / infinite.width).toBeCloseTo(1.5);
	});

	it("the laser trail fades out and stays bounded", () => {
		const trail = new LaserTrail(500);
		trail.add(1, 1, 0);
		trail.add(2, 2, 300);
		expect(trail.alive(400).length).toBe(2);
		expect(trail.alpha(0, 250)).toBeCloseTo(0.5);
		expect(trail.alive(600).map((p) => p.x)).toEqual([2]);
		expect(trail.alive(900).length).toBe(0);
		for (let i = 0; i < 500; i++) trail.add(i, i, 1000);
		expect(trail.size).toBeLessThanOrEqual(96);
	});

	it("reads the settings leniently", () => {
		expect(readPresentSettings({})).toEqual({ presentSteps: true, presentLaser: true });
		expect(readPresentSettings({ presentSteps: false, presentLaser: "no" })).toEqual({ presentSteps: false, presentLaser: true });
	});
});
