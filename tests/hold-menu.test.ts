import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import {
	FINGER_HOLD_MS, FINGER_HOLD_RADIUS_PX, HOLD_MS, HOLD_RADIUS_PX, StillHold, effectivePenHold, fingerHoldMayStart, noSignalYet, penHoldMayStart,
} from "../src/ink/pen-button";
import { PointerController, type MenuSource, type PointerHandlers } from "../src/ink/pointer-controller";
import { FINGER_GAP, fingerMenuCenter } from "../src/ink/radial";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { policySettings } from "../src/view/input-settings";

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
	const props = { pointerId: 1, pointerType: "pen", button: -1, buttons: 0, pressure: 0, width: 1, height: 1, clientX: 400, clientY: 300, timeStamp: 1000, ...init };
	for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
	el.dispatchEvent(e);
	return e;
}

function setup(settings: Partial<InputSettings> = {}) {
	const el = new FakeEl();
	const log: string[] = [];
	const menus: Array<[number, number, MenuSource]> = [];
	const handlers: PointerHandlers = {
		drawStart: () => (log.push("start"), true),
		drawMove: () => log.push("move"),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => log.push("pan"),
		zoom: () => log.push("zoom"),
		penMenu: (x, y, source) => (menus.push([x, y, source]), log.push(`menu:${source}`)),
	};
	const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500, penButton: "radial-eraser", ...settings });
	const controller = new PointerController(el as unknown as HTMLElement, policy, handlers);
	return { el, log, menus, policy, controller };
}

const penDown = (el: FakeEl, over: Record<string, unknown> = {}) => fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, timeStamp: 1000, ...over });
const penMove = (el: FakeEl, x: number, t: number, over: Record<string, unknown> = {}) => fire(el, "pointermove", { buttons: 1, pressure: 0.4, clientX: x, timeStamp: t, ...over });
const penUp = (el: FakeEl, t: number) => fire(el, "pointerup", { button: 0, buttons: 0, timeStamp: t });
const fingerDown = (el: FakeEl, id: number, x = 400, y = 300, t = 1000) => fire(el, "pointerdown", { pointerId: id, pointerType: "touch", button: 0, buttons: 1, pressure: 0.5, clientX: x, clientY: y, timeStamp: t });
const fingerMove = (el: FakeEl, id: number, x: number, y: number, t: number) => fire(el, "pointermove", { pointerId: id, pointerType: "touch", button: -1, buttons: 1, pressure: 0.5, clientX: x, clientY: y, timeStamp: t });
const fingerUp = (el: FakeEl, id: number, t: number) => fire(el, "pointerup", { pointerId: id, pointerType: "touch", button: 0, buttons: 0, timeStamp: t });

describe("effectivePenHold: the automatic default and the user's choice", () => {
	it("without a choice it is on only while the device never delivered a side-button signal", () => {
		expect(effectivePenHold(null, false)).toBe(true);
		expect(effectivePenHold(undefined, false)).toBe(true);
		expect(effectivePenHold(null, true)).toBe(false);
	});

	it("an explicit choice always wins", () => {
		expect(effectivePenHold(true, true)).toBe(true);
		expect(effectivePenHold(true, false)).toBe(true);
		expect(effectivePenHold(false, false)).toBe(false);
		expect(effectivePenHold(false, true)).toBe(false);
	});

	it("reaches the policy: default on, off once a signal was seen, explicit choice wins", () => {
		expect(policySettings(readSettings({})).penLongPress).toBe(true);
		expect(policySettings(readSettings({ penButtonSeen: true })).penLongPress).toBe(false);
		expect(policySettings(readSettings({ penButtonSeen: true, penHoldStill: true })).penLongPress).toBe(true);
		expect(policySettings(readSettings({ penHoldStill: false })).penLongPress).toBe(false);
	});

	it("settings: defaults, parsing, and the 0.5.1 key", () => {
		expect(DEFAULT_SETTINGS.penHoldStill).toBeNull();
		expect(DEFAULT_SETTINGS.penButtonSeen).toBe(false);
		expect(DEFAULT_SETTINGS.fingerLongPress).toBe(true);
		expect(readSettings({ penButtonSeen: "yes", fingerLongPress: 1 }).penButtonSeen).toBe(false);
		expect(readSettings({ fingerLongPress: false }).fingerLongPress).toBe(false);
		// 0.5.1 saved penLongPress: false for everyone: that is not a choice. An explicit true is kept.
		expect(readSettings({ penLongPress: false }).penHoldStill).toBeNull();
		expect(readSettings({ penLongPress: true }).penHoldStill).toBe(true);
		expect(policySettings(readSettings({ fingerLongPress: false })).fingerLongPress).toBe(false);
	});

	it("the pen test line shows until a signal arrived, here or earlier", () => {
		expect(noSignalYet(false, 0)).toBe(true);
		expect(noSignalYet(true, 0)).toBe(false);
		expect(noSignalYet(false, 1)).toBe(false);
	});
});

describe("StillHold radius", () => {
	it("the finger radius is wider than the pen's", () => {
		expect(HOLD_RADIUS_PX).toBeLessThan(FINGER_HOLD_RADIUS_PX);
		const f = new StillHold(FINGER_HOLD_RADIUS_PX);
		f.begin(0, 0);
		f.move(8, 6);
		expect(f.still).toBe(true);
		f.move(11, 0);
		expect(f.still).toBe(false);
	});
});

describe("decision helpers", () => {
	it("pen hold needs the setting, the radial action and a non-eraser contact", () => {
		expect(penHoldMayStart({ enabled: true, radialAction: true, eraser: false })).toBe(true);
		expect(penHoldMayStart({ enabled: false, radialAction: true, eraser: false })).toBe(false);
		expect(penHoldMayStart({ enabled: true, radialAction: false, eraser: false })).toBe(false);
		expect(penHoldMayStart({ enabled: true, radialAction: true, eraser: true })).toBe(false);
	});

	it("finger long-press needs: enabled, finger drawing off, no pen near, exactly one finger", () => {
		const ok = { enabled: true, fingerDrawing: false, penNear: false, fingersDown: 1 };
		expect(fingerHoldMayStart(ok)).toBe(true);
		expect(fingerHoldMayStart({ ...ok, enabled: false })).toBe(false);
		expect(fingerHoldMayStart({ ...ok, fingerDrawing: true })).toBe(false);
		expect(fingerHoldMayStart({ ...ok, penNear: true })).toBe(false);
		expect(fingerHoldMayStart({ ...ok, fingersDown: 2 })).toBe(false);
	});
});

describe("pen hold-still on the controller", () => {
	beforeEach(() => {
		(globalThis as { window?: unknown }).window = globalThis;
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		delete (globalThis as { window?: unknown }).window;
	});

	it("opens at HOLD_MS from the first contact, discards the stroke (no dot, nothing to undo) and releases the pen", () => {
		const { el, log, menus, policy } = setup({ penLongPress: true });
		penDown(el);
		vi.advanceTimersByTime(HOLD_MS - 1);
		expect(log).toEqual(["start"]);
		vi.advanceTimersByTime(2);
		expect(log).toEqual(["start", "cancel", "menu:pen-hold"]);
		expect(menus).toEqual([[300, 250, "pen-hold"]]);
		// The lift is swallowed by the menu: the pen must not stay "down" for the palm rejection.
		expect(policy.penRecentlyActive(1e9)).toBe(false);
		penUp(el, 1900);
		expect(log).toEqual(["start", "cancel", "menu:pen-hold"]);
		expect(log).not.toContain("end");
	});

	it("jitter inside the radius still counts as still", () => {
		const { el, menus } = setup({ penLongPress: true });
		penDown(el);
		penMove(el, 402, 1100);
		penMove(el, 398, 1200, { clientY: 303 });
		penMove(el, 403, 1300, { clientY: 297 });
		vi.advanceTimersByTime(HOLD_MS + 10);
		expect(menus.length).toBe(1);
	});

	it("writing a dot (a short tap) never opens it", () => {
		const { el, log, menus } = setup({ penLongPress: true });
		penDown(el);
		vi.advanceTimersByTime(250);
		penUp(el, 1250);
		vi.advanceTimersByTime(5000);
		expect(menus.length).toBe(0);
		expect(log).toEqual(["start", "end"]);
	});

	it("slow, careful strokes never open it", () => {
		const { el, menus, log } = setup({ penLongPress: true });
		penDown(el);
		// 20 px/s: 8 px in the first 400 ms already leaves the radius.
		for (let i = 1; i <= 40; i++) {
			vi.advanceTimersByTime(100);
			penMove(el, 400 + i * 2, 1000 + i * 100);
		}
		vi.advanceTimersByTime(5000);
		expect(menus.length).toBe(0);
		expect(log).not.toContain("cancel");
	});

	it("a pause in the middle of a stroke, after it moved, never opens it, however long", () => {
		const { el, menus, log } = setup({ penLongPress: true });
		penDown(el);
		vi.advanceTimersByTime(100);
		penMove(el, 420, 1100);
		vi.advanceTimersByTime(60_000);
		expect(menus.length).toBe(0);
		expect(log).toEqual(["start", "move"]);
	});

	it("a stroke that went out and came back to where it started never opens it", () => {
		const { el, menus } = setup({ penLongPress: true });
		penDown(el);
		penMove(el, 440, 1050);
		penMove(el, 400, 1100);
		vi.advanceTimersByTime(5000);
		expect(menus.length).toBe(0);
	});

	it("a move seen only inside a coalesced list counts", () => {
		const { el, menus } = setup({ penLongPress: true });
		penDown(el);
		const coalesced = [{ clientX: 430, clientY: 300, pressure: 0.4, timeStamp: 1010 }, { clientX: 401, clientY: 300, pressure: 0.4, timeStamp: 1016 }];
		penMove(el, 401, 1016, { getCoalescedEvents: () => coalesced });
		vi.advanceTimersByTime(5000);
		expect(menus.length).toBe(0);
	});

	it("resting the pen above the page (hover) never opens it", () => {
		const { el, menus } = setup({ penLongPress: true });
		fire(el, "pointermove", { buttons: 0, button: -1, pressure: 0, timeStamp: 1000 });
		vi.advanceTimersByTime(60_000);
		expect(menus.length).toBe(0);
	});

	it("the eraser end never opens it, nor does a setting turned off before the time is up", () => {
		const a = setup({ penLongPress: true });
		fire(a.el, "pointerdown", { button: 5, buttons: 33, pressure: 0.4 });
		vi.advanceTimersByTime(5000);
		expect(a.menus.length).toBe(0);
		const b = setup({ penLongPress: true });
		penDown(b.el);
		b.policy.settings = { ...b.policy.settings, penLongPress: false };
		vi.advanceTimersByTime(5000);
		expect(b.menus.length).toBe(0);
	});

	it("needs the radial action: eraser, lasso, previous and off never open it", () => {
		for (const penButton of ["eraser", "lasso", "previous", "off"] as const) {
			const { el, menus } = setup({ penLongPress: true, penButton });
			penDown(el);
			vi.advanceTimersByTime(5000);
			expect(menus.length).toBe(0);
		}
		for (const penButton of ["radial", "radial-eraser"] as const) {
			const { el, menus } = setup({ penLongPress: true, penButton });
			penDown(el);
			vi.advanceTimersByTime(5000);
			expect(menus.length).toBe(1);
		}
	});

	it("the effective default (no choice, no signal seen yet) opens it; once a signal was seen it does not", () => {
		for (const [seen, opens] of [[false, 1], [true, 0]] as const) {
			const policySettingsFor = policySettings(readSettings({ penButtonSeen: seen }));
			const { el, menus } = setup({ ...policySettingsFor, palmRejectionMs: 0 });
			penDown(el);
			vi.advanceTimersByTime(5000);
			expect(menus.length).toBe(opens);
		}
	});

	it("the side-button seen callback is called by a button signal and not by writing or by the hold", () => {
		let seen = 0;
		const el = new FakeEl();
		const handlers: PointerHandlers = {
			drawStart: () => true, drawMove: () => {}, drawEnd: () => {}, pan: () => {}, zoom: () => {}, penMenu: () => {}, sideButtonSeen: () => void seen++,
		};
		new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser", penLongPress: true }), handlers);
		penDown(el);
		penMove(el, 410, 1050);
		penUp(el, 1100);
		penDown(el, { pointerId: 2, timeStamp: 2000 });
		vi.advanceTimersByTime(HOLD_MS + 10); // opens via the hold
		expect(seen).toBe(0);
		fire(el, "pointermove", { pointerId: 3, button: 2, buttons: 2, pressure: 0, timeStamp: 5000 });
		expect(seen).toBe(1);
	});
});

describe("finger long-press on the controller", () => {
	beforeEach(() => {
		(globalThis as { window?: unknown }).window = globalThis;
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		delete (globalThis as { window?: unknown }).window;
	});

	const on = { fingerLongPress: true };

	it("opens at FINGER_HOLD_MS at the finger position, as a finger menu, with nothing drawn and no pan", () => {
		const { el, log, menus } = setup(on);
		fingerDown(el, 4, 500, 400);
		vi.advanceTimersByTime(FINGER_HOLD_MS - 1);
		expect(menus.length).toBe(0);
		vi.advanceTimersByTime(2);
		expect(menus).toEqual([[400, 350, "finger"]]);
		expect(log).toEqual(["menu:finger"]);
		// The lift is swallowed by the menu; if it reaches the page it does nothing.
		fingerUp(el, 4, 1600);
		expect(log).toEqual(["menu:finger"]);
	});

	it("small drift (within the radius) still opens it", () => {
		const { el, menus } = setup(on);
		fingerDown(el, 4, 500, 400);
		fingerMove(el, 4, 504, 395, 1100);
		fingerMove(el, 4, 507, 402, 1200);
		vi.advanceTimersByTime(FINGER_HOLD_MS + 10);
		expect(menus.length).toBe(1);
	});

	it("a pan that starts within the time never opens it; a pause before the pan (shorter than the time) is fine", () => {
		const { el, menus, log } = setup(on);
		fingerDown(el, 4, 500, 400);
		vi.advanceTimersByTime(FINGER_HOLD_MS - 100);
		fingerMove(el, 4, 540, 400, 1400);
		vi.advanceTimersByTime(10_000);
		expect(menus.length).toBe(0);
		expect(log).toEqual(["pan"]);
		// And the pan goes on afterwards.
		fingerMove(el, 4, 580, 400, 1500);
		expect(log).toEqual(["pan", "pan"]);
	});

	it("a pan that begins slowly (more than the radius) cancels it for good", () => {
		const { el, menus } = setup(on);
		fingerDown(el, 4, 500, 400);
		fingerMove(el, 4, 515, 400, 1050);
		fingerMove(el, 4, 500, 400, 1100); // back at the start
		vi.advanceTimersByTime(10_000);
		expect(menus.length).toBe(0);
	});

	it("a tap (lifted before the time) never opens it", () => {
		const { el, menus } = setup(on);
		fingerDown(el, 4);
		vi.advanceTimersByTime(200);
		fingerUp(el, 4, 1200);
		vi.advanceTimersByTime(10_000);
		expect(menus.length).toBe(0);
	});

	it("a second finger (pinch, two-finger tap) cancels it, also when it lands first", () => {
		const a = setup(on);
		fingerDown(a.el, 4, 500, 400);
		vi.advanceTimersByTime(200);
		fingerDown(a.el, 5, 600, 400, 1200);
		vi.advanceTimersByTime(10_000);
		expect(a.menus.length).toBe(0);
		// two fingers at the same time: neither starts one
		const b = setup(on);
		fingerDown(b.el, 4, 500, 400);
		fingerDown(b.el, 5, 600, 400);
		fingerUp(b.el, 5, 1100);
		vi.advanceTimersByTime(10_000);
		expect(b.menus.length).toBe(0);
	});

	it("never with finger drawing on, or when the setting is off", () => {
		const a = setup({ ...on, fingerDrawing: true });
		fingerDown(a.el, 4);
		vi.advanceTimersByTime(5000);
		expect(a.menus.length).toBe(0);
		expect(a.log).toEqual(["start"]);
		const b = setup({ fingerLongPress: false });
		fingerDown(b.el, 4);
		vi.advanceTimersByTime(5000);
		expect(b.menus.length).toBe(0);
		const c = setup({});
		fingerDown(c.el, 4);
		vi.advanceTimersByTime(5000);
		expect(c.menus.length).toBe(0);
	});

	it("not when the palm-rejection window says a pen is near, before or after the finger lands", () => {
		const a = setup(on);
		fire(a.el, "pointermove", { buttons: 0, button: -1, pointerType: "pen", timeStamp: 900 });
		fingerDown(a.el, 4, 500, 400, 1000);
		vi.advanceTimersByTime(5000);
		expect(a.menus.length).toBe(0);
		const b = setup(on);
		fingerDown(b.el, 4, 500, 400, 1000);
		vi.advanceTimersByTime(200);
		fire(b.el, "pointermove", { buttons: 0, button: -1, pointerType: "pen", pointerId: 9, timeStamp: 1200 });
		vi.advanceTimersByTime(5000);
		expect(b.menus.length).toBe(0);
		// A pen that was away for longer than the window does not block it.
		const c = setup(on);
		fire(c.el, "pointermove", { buttons: 0, button: -1, pointerType: "pen", timeStamp: 100 });
		fingerDown(c.el, 4, 500, 400, 1000);
		vi.advanceTimersByTime(FINGER_HOLD_MS + 10);
		expect(c.menus.length).toBe(1);
	});

	it("a palm (large contact) or an edge zone touch is ignored and does not start it", () => {
		const a = setup({ ...on, palmContactPx: 30 });
		fire(a.el, "pointerdown", { pointerId: 4, pointerType: "touch", button: 0, buttons: 1, width: 80, height: 80, timeStamp: 1000 });
		vi.advanceTimersByTime(5000);
		expect(a.menus.length).toBe(0);
		const b = setup({ ...on, edge: { enabled: true, widthPx: 24, left: true, right: true, top: false, bottom: true } });
		fingerDown(b.el, 4, 105, 300, 1000);
		vi.advanceTimersByTime(5000);
		expect(b.menus.length).toBe(0);
	});

	it("a pen stroke is not disturbed and its own contextmenu detection still works after the finger menu", () => {
		const { el, menus } = setup(on);
		fingerDown(el, 4, 500, 400);
		vi.advanceTimersByTime(FINGER_HOLD_MS + 10);
		expect(menus.length).toBe(1);
		// the finger is no longer a finger down: a pen contextmenu after pen hover is a side-button press again
		fire(el, "pointermove", { buttons: 0, button: -1, pointerType: "pen", pointerId: 9, timeStamp: 3000 });
		fire(el, "contextmenu", { pointerType: undefined, timeStamp: 3100 });
		expect(menus.length).toBe(2);
	});

	it("destroy() cancels a pending long-press", () => {
		const { el, menus, controller } = setup(on);
		fingerDown(el, 4);
		controller.destroy();
		vi.advanceTimersByTime(5000);
		expect(menus.length).toBe(0);
	});
});

describe("finger menu placement", () => {
	const outer = 108;

	it("the ring sits above the finger, not under it", () => {
		const [cx, cy] = fingerMenuCenter(400, 400, 800, 600, outer);
		expect(cx).toBe(400);
		expect(cy).toBe(400 - outer - FINGER_GAP);
		expect(Math.hypot(400 - cx, 400 - cy)).toBeGreaterThan(outer + 20);
	});

	it("near the top it goes below; near the sides it is clamped and still clear of the finger", () => {
		const below = fingerMenuCenter(400, 60, 800, 600, outer);
		expect(below[1]).toBeGreaterThan(60 + outer);
		const left = fingerMenuCenter(10, 400, 800, 600, outer);
		expect(left[0]).toBeGreaterThanOrEqual(outer + 8);
		expect(Math.hypot(10 - left[0], 400 - left[1])).toBeGreaterThan(outer);
	});

	it("for every position of a roomy area the ring is whole and the fingertip is outside it", () => {
		for (let x = 0; x <= 800; x += 40) {
			for (let y = 0; y <= 600; y += 40) {
				const [cx, cy] = fingerMenuCenter(x, y, 800, 600, outer);
				expect(cx).toBeGreaterThanOrEqual(outer + 8 - 1e-9);
				expect(cx).toBeLessThanOrEqual(800 - outer - 8 + 1e-9);
				expect(cy).toBeGreaterThanOrEqual(outer + 8 - 1e-9);
				expect(cy).toBeLessThanOrEqual(600 - outer - 8 + 1e-9);
				expect(Math.hypot(x - cx, y - cy)).toBeGreaterThan(outer);
			}
		}
	});

	it("an area too small for any side falls back to a whole ring (clamped)", () => {
		const [cx, cy] = fingerMenuCenter(150, 120, 300, 240, outer);
		expect(cx).toBeGreaterThanOrEqual(outer + 8);
		expect(cx).toBeLessThanOrEqual(300 - outer - 8);
		expect(cy).toBeGreaterThanOrEqual(outer + 8);
		expect(cy).toBeLessThanOrEqual(240 - outer - 8);
		expect(Number.isFinite(cx) && Number.isFinite(cy)).toBe(true);
	});
});
