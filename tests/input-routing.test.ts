import { describe, expect, it } from "vitest";
import { effectiveEdgeWidth, inEdgeZone, type EdgeZones } from "../src/ink/edge-zones";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import { PointerController, type InkSample, type PointerHandlers } from "../src/ink/pointer-controller";
import { clampCenter, pushRecentColor, recentColors, sectorAngle, sectorAt, sectorPath, sectorPoint } from "../src/ink/radial";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { policySettings } from "../src/view/input-settings";

const zones = (over: Partial<EdgeZones> = {}): EdgeZones => ({ enabled: true, widthPx: 24, left: true, right: true, top: true, bottom: true, ...over });

describe("edge rejection zones", () => {
	it("rejects points within the width of an enabled edge only", () => {
		const z = zones({ top: false });
		expect(inEdgeZone(z, 10, 300, 800, 600)).toBe(true); // left
		expect(inEdgeZone(z, 790, 300, 800, 600)).toBe(true); // right
		expect(inEdgeZone(z, 400, 590, 800, 600)).toBe(true); // bottom
		expect(inEdgeZone(z, 400, 5, 800, 600)).toBe(false); // top is off
		expect(inEdgeZone(z, 400, 300, 800, 600)).toBe(false); // middle
		expect(inEdgeZone(z, 24, 300, 800, 600)).toBe(false); // exactly the width is outside
		expect(inEdgeZone(z, 23.9, 300, 800, 600)).toBe(true);
	});

	it("does nothing when off, undefined or the area is empty", () => {
		expect(inEdgeZone(zones({ enabled: false }), 1, 1, 800, 600)).toBe(false);
		expect(inEdgeZone(undefined, 1, 1, 800, 600)).toBe(false);
		expect(inEdgeZone(zones(), 1, 1, 0, 600)).toBe(false);
		expect(inEdgeZone(zones({ widthPx: 0 }), 1, 1, 800, 600)).toBe(false);
	});

	it("never takes more than a third of the shorter side", () => {
		expect(effectiveEdgeWidth({ widthPx: 80 }, 800, 600)).toBe(80);
		expect(effectiveEdgeWidth({ widthPx: 80 }, 120, 600)).toBe(40);
		// A tiny area keeps its middle usable.
		expect(inEdgeZone(zones({ widthPx: 80 }), 60, 300, 120, 600)).toBe(false);
		expect(inEdgeZone(zones({ widthPx: 80 }), 30, 300, 120, 600)).toBe(true);
	});
});

describe("InputPolicy: edge zones and the pen side button", () => {
	const base: InputSettings = { fingerDrawing: true, palmRejectionMs: 0 };

	it("edge zones reject touch, never pen or mouse", () => {
		const p = new InputPolicy({ ...base, edge: zones() });
		expect(p.edgeRejects("touch", 3, 300, 800, 600)).toBe(true);
		expect(p.edgeRejects("touch", 400, 300, 800, 600)).toBe(false);
		expect(p.edgeRejects("pen", 3, 300, 800, 600)).toBe(false);
		expect(p.edgeRejects("mouse", 3, 300, 800, 600)).toBe(false);
		p.settings = { ...base };
		expect(p.edgeRejects("touch", 3, 300, 800, 600)).toBe(false);
	});

	it("default behaviour of the pen buttons is unchanged", () => {
		const p = new InputPolicy({ ...base });
		expect(p.route("pen", 0, 0, 0, 1)).toBe("draw");
		expect(p.route("pen", 0, 0, 0, 3)).toBe("draw"); // contact with the side button held: draws as before
		expect(p.route("pen", 0, 2, 0, 2)).toBe("ignore");
		expect(p.route("pen", 0, 5, 0, 33)).toBe("draw");
		expect(p.penErases(5, 33)).toBe(true);
		expect(p.penErases(0, 32)).toBe(true);
		expect(p.penErases(0, 3)).toBe(false);
	});

	it("radial action: the side button opens the menu instead of drawing", () => {
		const p = new InputPolicy({ ...base, penButton: "radial" });
		expect(p.route("pen", 0, 2, 0, 2)).toBe("menu");
		expect(p.route("pen", 0, 0, 0, 3)).toBe("menu");
		expect(p.route("pen", 0, 0, 0, 1)).toBe("draw");
		// The eraser end/button still erases and draws as before.
		expect(p.route("pen", 0, 5, 0, 33)).toBe("draw");
		expect(p.penErases(5, 33)).toBe(true);
		expect(p.penErases(0, 3)).toBe(false);
		// Touch and mouse are not affected.
		expect(p.route("mouse", 0, 2, 0, 2)).toBe("ignore");
	});

	it("eraser action: the side button erases while held", () => {
		const p = new InputPolicy({ ...base, penButton: "eraser" });
		expect(p.route("pen", 0, 0, 0, 3)).toBe("draw");
		expect(p.route("pen", 0, 2, 0, 2)).toBe("draw");
		expect(p.penErases(0, 3)).toBe(true);
		expect(p.penErases(0, 1)).toBe(false);
	});
});

describe("radial menu geometry", () => {
	const shape = { inner: 30, outer: 100, count: 8 };

	it("sector 0 is centred on the top and the others follow clockwise", () => {
		const c = 100;
		expect(sectorAt(shape, c, c, c, c - 60)).toBe(0); // straight up
		expect(sectorAt(shape, c, c, c + 60, c)).toBe(2); // right
		expect(sectorAt(shape, c, c, c, c + 60)).toBe(4); // down
		expect(sectorAt(shape, c, c, c - 60, c)).toBe(6); // left
		expect(sectorAt(shape, c, c, c + 42, c - 42)).toBe(1); // up-right
		expect(sectorAt(shape, c, c, c - 42, c - 42)).toBe(7); // up-left
	});

	it("boundaries lie half a sector either side of the middle", () => {
		const at = (deg: number, r = 60) => sectorAt(shape, 0, 0, Math.sin((deg * Math.PI) / 180) * r, -Math.cos((deg * Math.PI) / 180) * r);
		expect(at(-22)).toBe(0);
		expect(at(22)).toBe(0);
		expect(at(23)).toBe(1);
		expect(at(-23)).toBe(7);
		expect(at(359)).toBe(0);
	});

	it("dead zone and outside the ring are -1", () => {
		expect(sectorAt(shape, 0, 0, 0, 0)).toBe(-1);
		expect(sectorAt(shape, 0, 0, 0, -29)).toBe(-1);
		expect(sectorAt(shape, 0, 0, 0, -31)).toBe(0);
		expect(sectorAt(shape, 0, 0, 0, -101)).toBe(-1);
		expect(sectorAt(shape, 0, 0, NaN, 0)).toBe(-1);
		expect(sectorAt({ ...shape, count: 0 }, 0, 0, 0, -60)).toBe(-1);
	});

	it("sectorPoint agrees with sectorAt for every sector, for any count", () => {
		for (const count of [1, 2, 3, 5, 8, 12]) {
			const s = { inner: 20, outer: 90, count };
			for (let i = 0; i < count; i++) {
				const [x, y] = sectorPoint(50, 50, 55, i, count);
				expect(sectorAt(s, 50, 50, x, y)).toBe(i);
			}
		}
		expect(sectorAngle(2, 8)).toBeCloseTo(Math.PI / 2);
	});

	it("keeps the whole ring inside the area", () => {
		expect(clampCenter(5, 5, 800, 600, 100)).toEqual([108, 108]);
		expect(clampCenter(795, 595, 800, 600, 100)).toEqual([692, 492]);
		expect(clampCenter(400, 300, 800, 600, 100)).toEqual([400, 300]);
		// An area smaller than the ring: centred.
		expect(clampCenter(5, 5, 100, 100, 100)).toEqual([50, 50]);
	});

	it("builds a closed path per sector", () => {
		for (const count of [1, 4, 8]) {
			const d = sectorPath({ inner: 30, outer: 100, count }, 100, 100, 0);
			expect(d.startsWith("M ")).toBe(true);
			expect(d.trim().endsWith("Z")).toBe(true);
			expect(d).not.toContain("NaN");
		}
	});

	it("keeps recent colours most-recent first, without duplicates", () => {
		let r: string[] = [];
		r = pushRecentColor(r, "#111111");
		r = pushRecentColor(r, "#222222");
		r = pushRecentColor(r, "#111111");
		expect(r).toEqual(["#111111", "#222222"]);
		expect(pushRecentColor(["#AAAAAA", "#bbbbbb"], "#aaaaaa")).toEqual(["#aaaaaa", "#bbbbbb"]);
		expect(pushRecentColor(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
		expect(recentColors(["#111111"], ["#111111", "#222222", "#333333", "#444444"], 3)).toEqual(["#111111", "#222222", "#333333"]);
		expect(recentColors([], ["#1"], 3)).toEqual(["#1"]);
	});
});

describe("settings for input routing", () => {
	it("has safe defaults and ignores bad values", () => {
		expect(DEFAULT_SETTINGS.edgeRejection).toBe(false);
		expect(DEFAULT_SETTINGS.penSideButton).toBe("radial-eraser");
		const s = readSettings({ edgeRejection: true, edgeRejectionPx: 1000, edgeLeft: "yes", penSideButton: "launch" });
		expect(s.edgeRejection).toBe(true);
		expect(s.edgeRejectionPx).toBe(DEFAULT_SETTINGS.edgeRejectionPx);
		expect(s.edgeLeft).toBe(DEFAULT_SETTINGS.edgeLeft);
		expect(s.penSideButton).toBe("radial-eraser");
		expect(readSettings({ penSideButton: "eraser", edgeRejectionPx: 40, edgeTop: true }).penSideButton).toBe("eraser");
		// 0.5.x saved its default "radial" for everyone: it does not stick; an explicit "eraser" / "off" does.
		expect(readSettings({ penButtonAction: "radial" }).penSideButton).toBe("radial-eraser");
		expect(readSettings({ penButtonAction: "eraser" }).penSideButton).toBe("eraser");
		expect(readSettings({ penButtonAction: "off" }).penSideButton).toBe("off");
	});

	it("maps to the policy settings", () => {
		const p = policySettings(readSettings({ edgeRejection: true, edgeRejectionPx: 30, edgeBottom: false, penSideButton: "off" }));
		expect(p.edge).toEqual({ enabled: true, widthPx: 30, left: true, right: true, top: false, bottom: false });
		expect(p.penButton).toBe("off");
	});
});

// --- PointerController with a fake element ---

class FakeEl extends EventTarget {
	captured = new Set<number>();
	getBoundingClientRect() {
		return { left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50, toJSON() {} } as DOMRect;
	}
	setPointerCapture(id: number) {
		this.captured.add(id);
	}
	releasePointerCapture(id: number) {
		this.captured.delete(id);
	}
	hasPointerCapture(id: number) {
		return this.captured.has(id);
	}
}

function fire(el: FakeEl, type: string, init: Record<string, unknown>): Event {
	const e = new Event(type, { cancelable: true });
	const props = { pointerId: 1, pointerType: "pen", button: 0, buttons: 0, pressure: 0.5, width: 1, height: 1, clientX: 400, clientY: 300, timeStamp: 1000, ...init };
	for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
	el.dispatchEvent(e);
	return e;
}

function setup(settings: InputSettings) {
	const el = new FakeEl();
	const log: string[] = [];
	const starts: Array<{ eraser: boolean; s: InkSample }> = [];
	const menus: Array<[number, number]> = [];
	const handlers: PointerHandlers = {
		drawStart: (s, eraser) => (starts.push({ eraser, s }), log.push("start"), true),
		drawMove: () => log.push("move"),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => log.push("pan"),
		zoom: () => log.push("zoom"),
		penMenu: (x, y) => (menus.push([x, y]), log.push("menu")),
	};
	const policy = new InputPolicy(settings);
	const controller = new PointerController(el as unknown as HTMLElement, policy, handlers);
	return { el, log, starts, menus, policy, controller };
}

describe("PointerController routing", () => {
	it("ignores a touch that starts in an edge zone, and one that starts inside still pans", () => {
		const { el, log } = setup({ fingerDrawing: false, palmRejectionMs: 0, edge: zones() });
		// clientX 105 is x = 5 (left edge zone); the touch moves but nothing happens.
		fire(el, "pointerdown", { pointerId: 7, pointerType: "touch", clientX: 105, clientY: 300 });
		fire(el, "pointermove", { pointerId: 7, pointerType: "touch", clientX: 120, clientY: 330, timeStamp: 1016 });
		fire(el, "pointerup", { pointerId: 7, pointerType: "touch", clientX: 120, clientY: 330, timeStamp: 1032 });
		expect(log).toEqual([]);
		// Starts well inside: panned as usual.
		fire(el, "pointerdown", { pointerId: 8, pointerType: "touch", clientX: 500, clientY: 300 });
		fire(el, "pointermove", { pointerId: 8, pointerType: "touch", clientX: 510, clientY: 330, timeStamp: 1100 });
		expect(log).toEqual(["pan"]);
	});

	it("an edge zone never stops the pen", () => {
		const { el, log } = setup({ fingerDrawing: false, palmRejectionMs: 0, edge: zones() });
		fire(el, "pointerdown", { pointerType: "pen", clientX: 102, clientY: 300 });
		expect(log).toEqual(["start"]);
	});

	it("with the radial action the side button opens the menu and draws nothing", () => {
		const { el, log, menus } = setup({ fingerDrawing: true, palmRejectionMs: 0, penButton: "radial" });
		const down = fire(el, "pointerdown", { pointerType: "pen", button: 2, buttons: 2, clientX: 300, clientY: 200 });
		expect(down.defaultPrevented).toBe(true);
		fire(el, "pointermove", { pointerType: "pen", buttons: 2, clientX: 310, clientY: 210, timeStamp: 1016 });
		fire(el, "pointerup", { pointerType: "pen", button: 2, buttons: 0, timeStamp: 1032 });
		expect(log).toEqual(["menu"]);
		expect(menus).toEqual([[200, 150]]);
	});

	it("the menu does not leave the pen down: a finger works right after, with finger drawing on", () => {
		const { el, log, policy } = setup({ fingerDrawing: true, palmRejectionMs: 0, penButton: "radial" });
		fire(el, "pointerdown", { pointerType: "pen", button: 0, buttons: 3, timeStamp: 2000 });
		expect(policy.penRecentlyActive(2001)).toBe(false);
		fire(el, "pointerdown", { pointerId: 9, pointerType: "touch", clientX: 500, clientY: 300, timeStamp: 2500 });
		expect(log).toEqual(["menu", "start"]);
	});

	it("pressing the side button while hovering opens the menu once per press", () => {
		const { el, log, menus } = setup({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial" });
		fire(el, "pointermove", { pointerType: "pen", buttons: 0, pressure: 0, clientX: 300, clientY: 200 });
		fire(el, "pointermove", { pointerType: "pen", buttons: 2, pressure: 0, clientX: 302, clientY: 200, timeStamp: 1016 });
		fire(el, "pointermove", { pointerType: "pen", buttons: 2, pressure: 0, clientX: 304, clientY: 200, timeStamp: 1032 });
		expect(menus).toEqual([[202, 150]]);
		fire(el, "pointermove", { pointerType: "pen", buttons: 0, pressure: 0, timeStamp: 1048 });
		fire(el, "pointermove", { pointerType: "pen", buttons: 2, pressure: 0, clientX: 310, clientY: 220, timeStamp: 1064 });
		expect(menus.length).toBe(2);
		expect(log).toEqual(["menu", "menu"]);
	});

	it("hover with the side button does nothing when the action is not the radial menu", () => {
		for (const penButton of ["off", "eraser"] as const) {
			const { el, log } = setup({ fingerDrawing: false, palmRejectionMs: 0, penButton });
			fire(el, "pointermove", { pointerType: "pen", buttons: 2, pressure: 0 });
			expect(log).toEqual([]);
		}
	});

	it("with the eraser action the side button erases; the eraser button still does", () => {
		const a = setup({ fingerDrawing: false, palmRejectionMs: 0, penButton: "eraser" });
		fire(a.el, "pointerdown", { pointerType: "pen", button: 0, buttons: 3 });
		expect(a.starts[0]!.eraser).toBe(true);
		const b = setup({ fingerDrawing: false, palmRejectionMs: 0, penButton: "off" });
		fire(b.el, "pointerdown", { pointerType: "pen", button: 5, buttons: 33 });
		expect(b.starts[0]!.eraser).toBe(true);
		const c = setup({ fingerDrawing: false, palmRejectionMs: 0, penButton: "off" });
		fire(c.el, "pointerdown", { pointerType: "pen", button: 0, buttons: 3 });
		expect(c.starts[0]!.eraser).toBe(false);
	});
});
