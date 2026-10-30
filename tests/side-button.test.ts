import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputPolicy, heldToolOf, opensRadial, type InputSettings } from "../src/ink/input-policy";
import { BarrelDetector, ChordDetector, EventLog, formatEvent, type LoggedEvent } from "../src/ink/pen-button";
import { PointerController, type MenuSource, type PointerHandlers } from "../src/ink/pointer-controller";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { policySettings } from "../src/view/input-settings";
import { installFakeWindow, removeFakeWindow } from "./node-env";

// --- BarrelDetector: the Samsung pressure-0 press ---

describe("BarrelDetector: pressure-0 primary press (Samsung, pen hovering)", () => {
	const hover = (d: BarrelDetector, t: number, id = 1) => d.pointer("move", "pen", -1, 0, t, 0, id);

	it("a hovering pointer's pointerdown with button 0, buttons 1 and pressure 0 is a press; the lift ends it", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		expect(d.pointer("down", "pen", 0, 1, 116, 0, 1)).toBe(true);
		expect(d.transition).toBe("press");
		expect(d.zeroPressureHeld).toBe(true);
		expect(d.pointer("up", "pen", 0, 0, 300, 0, 1)).toBe(false);
		expect(d.transition).toBe("release-click");
		expect(d.zeroPressureHeld).toBe(false);
	});

	it("buttons going 0 -> 1 in a pen move with pressure 0 is a press too", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		expect(d.pointer("move", "pen", 0, 1, 116, 0, 1)).toBe(true);
		expect(d.pointer("move", "pen", -1, 1, 132, 0, 1)).toBe(false); // same press
		expect(d.pointer("move", "pen", 0, 0, 200, 0, 1)).toBe(false);
		expect(d.transition).toBe("release-click");
	});

	it("never from a pointer that was not hovering before, or another pointer id", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "pen", 0, 1, 100, 0, 1)).toBe(false);
		hover(d, 200, 1);
		expect(d.pointer("down", "pen", 0, 1, 300, 0, 2)).toBe(false);
	});

	it("never with pressure > 0 (a real contact) or when the setting is off", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		expect(d.pointer("down", "pen", 0, 1, 116, 0.4, 1)).toBe(false);
		d.pointer("up", "pen", 0, 0, 200, 0, 1);
		d.zeroPressureEnabled = false;
		hover(d, 300);
		expect(d.pointer("down", "pen", 0, 1, 316, 0, 1)).toBe(false);
	});

	it("a stroke that ends with pressure 0 (still in contact) is not a press", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		d.pointer("down", "pen", 0, 1, 116, 0.5, 1);
		expect(d.pointer("move", "pen", -1, 1, 132, 0, 1)).toBe(false);
	});

	it("the eraser bits are never the button", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		expect(d.pointer("down", "pen", 5, 33, 116, 0, 1)).toBe(false);
	});

	it("touching while held is contact, lifting is contact-end, the release after contact is not a click", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		d.pointer("down", "pen", 0, 1, 116, 0, 1);
		d.pointer("move", "pen", -1, 1, 132, 0.6, 1);
		expect(d.transition).toBe("contact-start");
		d.pointer("move", "pen", -1, 1, 148, 0.7, 1);
		expect(d.transition).toBe("none");
		d.pointer("move", "pen", -1, 1, 164, 0, 1);
		expect(d.transition).toBe("contact-end");
		d.pointer("move", "pen", -1, 1, 180, 0.5, 1);
		expect(d.transition).toBe("contact-start");
		d.pointer("up", "pen", 0, 0, 200, 0, 1);
		expect(d.transition).toBe("release");
	});

	it("a cancel is never a click", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		d.pointer("down", "pen", 0, 1, 116, 0, 1);
		d.pointer("cancel", "pen", 0, 0, 140, 0, 1);
		expect(d.transition).toBe("release");
	});

	it("a contextmenu / auxclick around the press is part of it", () => {
		const d = new BarrelDetector();
		hover(d, 100);
		d.pointer("down", "pen", 0, 1, 116, 0, 1);
		expect(d.contextMenu("pen", 2000)).toBe(false);
		d.pointer("up", "pen", 0, 0, 2100, 0, 1);
		expect(d.contextMenu("pen", 2200)).toBe(false);
		expect(d.auxClick("pen", 2, 2300)).toBe(false);
	});
});

// --- ChordDetector ---

describe("ChordDetector: button 0 on a pen move during contact", () => {
	it("ordinary writing (button -1) never toggles, nor does the pointerdown", () => {
		const c = new ChordDetector();
		c.down(1000);
		for (let i = 1; i <= 200; i++) expect(c.move(-1, 1, 0.5, 1000 + i * 8)).toBe(false);
	});

	it("button 0 after ordinary moves toggles; debounced; needs pressure", () => {
		const c = new ChordDetector();
		c.down(1000);
		expect(c.move(-1, 1, 0.9, 1050)).toBe(false);
		expect(c.move(0, 1, 0.92, 1100)).toBe(true);
		expect(c.move(0, 1, 0.92, 1110)).toBe(false); // the same change seen as rawupdate + move
		expect(c.move(-1, 1, 0.9, 1200)).toBe(false);
		expect(c.move(0, 1, 0.92, 1400)).toBe(true);
		expect(c.move(0, 1, 0, 2000)).toBe(false);
	});

	it("not right after the landing, not before an ordinary move, not for a device whose moves all say button 0", () => {
		const c = new ChordDetector();
		c.down(1000);
		expect(c.move(0, 1, 0.5, 1010)).toBe(false);
		expect(c.move(0, 1, 0.5, 1100)).toBe(false); // no ordinary move yet
		const d = new ChordDetector();
		d.down(1000);
		for (let i = 1; i < 100; i++) expect(d.move(0, 1, 0.5, 1000 + i * 16)).toBe(false);
		const e = new ChordDetector();
		e.down(1000);
		e.move(-1, 1, 0.5, 1010);
		expect(e.move(0, 1, 0.5, 1020)).toBe(false); // 20 ms after the landing
	});

	it("not without contact, not the eraser, not after the lift", () => {
		const c = new ChordDetector();
		expect(c.move(0, 1, 0.5, 5000)).toBe(false);
		c.down(1000);
		c.move(-1, 1, 0.5, 1100);
		expect(c.move(5, 33, 0.5, 1200)).toBe(false);
		expect(c.move(0, 0, 0.5, 1300)).toBe(false); // buttons 0: not in contact
		c.up();
		expect(c.move(0, 1, 0.5, 1400)).toBe(false);
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
	const props = { pointerId: 1, pointerType: "pen", button: -1, buttons: 0, pressure: 0, width: 1, height: 1, clientX: 400, clientY: 300, timeStamp: 1000, ...init };
	for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
	el.dispatchEvent(e);
	return e;
}

function setup(settings: Partial<InputSettings> = {}) {
	const el = new FakeEl();
	const log: string[] = [];
	const menus: Array<[number, number, MenuSource]> = [];
	let seen = 0;
	const handlers: PointerHandlers = {
		drawStart: (_s, eraser, held) => (log.push(`start${eraser ? ":eraser" : ""}${held ? `:${held}` : ""}`), true),
		drawMove: () => log.push("move"),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => log.push("pan"),
		zoom: () => log.push("zoom"),
		penMenu: (x, y, source) => (menus.push([x, y, source]), log.push(`menu:${source}`)),
		sideButtonSeen: () => void seen++,
	};
	const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser", ...settings });
	const controller = new PointerController(el as unknown as HTMLElement, policy, handlers);
	return { el, log, menus, policy, controller, seen: () => seen };
}

/** Samsung sequences, as reported: hover moves, then the button as a pointerdown with button 0, buttons 1, pressure 0. */
const hover = (el: FakeEl, t: number, x = 400) => fire(el, "pointermove", { button: -1, buttons: 0, pressure: 0, clientX: x, timeStamp: t });
const press = (el: FakeEl, t: number, x = 400) => fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0, clientX: x, timeStamp: t });
const touchMove = (el: FakeEl, t: number, x: number, pressure = 0.6) => fire(el, "pointermove", { button: -1, buttons: 1, pressure, clientX: x, timeStamp: t });
const release = (el: FakeEl, t: number, x = 400) => fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, clientX: x, timeStamp: t });

describe("Samsung button: click -> menu on release", () => {
	beforeEach(() => {
		installFakeWindow();
	});
	afterEach(() => {
		removeFakeWindow();
	});

	it("press and release while hovering: nothing on the press, the menu on the release at the pen position, no ink", () => {
		const { el, log, menus, seen } = setup();
		hover(el, 1000);
		hover(el, 1016, 410);
		press(el, 1032, 410);
		expect(log).toEqual([]);
		expect(seen()).toBe(1);
		release(el, 1200, 412);
		expect(log).toEqual(["menu:click"]);
		expect(menus).toEqual([[312, 250, "click"]]);
	});

	it("the release may come as a pointermove with buttons 0 (no pointerup)", () => {
		const { el, log } = setup();
		hover(el, 1000);
		press(el, 1032);
		fire(el, "pointermove", { button: 0, buttons: 0, pressure: 0, timeStamp: 1300 });
		expect(log).toEqual(["menu:click"]);
	});

	it("the press as a pointermove (buttons 0 -> 1, pressure 0) works the same", () => {
		const { el, log } = setup();
		hover(el, 1000);
		fire(el, "pointermove", { button: 0, buttons: 1, pressure: 0, timeStamp: 1016 });
		fire(el, "pointermove", { button: -1, buttons: 1, pressure: 0, timeStamp: 1032 });
		release(el, 1200);
		expect(log).toEqual(["menu:click"]);
	});

	it("holding the button with the pen moving above the page (pressure 0) never draws; the click still opens", () => {
		const { el, log } = setup();
		hover(el, 1000);
		press(el, 1016);
		for (let i = 1; i <= 10; i++) fire(el, "pointermove", { button: -1, buttons: 1, pressure: 0, clientX: 400 + i * 5, timeStamp: 1016 + i * 16 });
		release(el, 1400, 450);
		expect(log).toEqual(["menu:click"]);
	});

	it("repeated quick clicks open the menu each time", () => {
		const { el, menus } = setup();
		hover(el, 1000);
		for (let i = 0; i < 4; i++) {
			press(el, 1100 + i * 150);
			release(el, 1150 + i * 150);
		}
		expect(menus.length).toBe(4);
	});

	it("a trailing contextmenu / auxclick of the click does not open a second menu", () => {
		const { el, menus } = setup();
		hover(el, 1000);
		press(el, 1016);
		fire(el, "contextmenu", { pointerType: "pen", timeStamp: 1030 });
		release(el, 1200);
		fire(el, "contextmenu", { pointerType: "pen", timeStamp: 1210 });
		fire(el, "auxclick", { pointerType: "pen", button: 2, timeStamp: 1220 });
		expect(menus.length).toBe(1);
	});

	it("also with the eraser-only, lasso, previous and off actions the click does not open the menu", () => {
		for (const penButton of ["eraser", "lasso", "previous", "off"] as const) {
			const { el, menus, log } = setup({ penButton });
			hover(el, 1000);
			press(el, 1016);
			release(el, 1100);
			expect(menus.length).toBe(0);
			expect(log).toEqual([]);
		}
	});

	it("the radial-only action also opens on release", () => {
		const { el, log } = setup({ penButton: "radial" });
		hover(el, 1000);
		press(el, 1016);
		release(el, 1100);
		expect(log).toEqual(["menu:click"]);
	});
});

describe("Samsung button held while the nib touches: erase", () => {
	beforeEach(() => {
		installFakeWindow();
	});
	afterEach(() => {
		removeFakeWindow();
	});

	it("button, then contact: the contact erases for as long as it lasts; no menu on release", () => {
		const { el, log, menus } = setup();
		hover(el, 1000);
		press(el, 1016);
		touchMove(el, 1032, 420);
		touchMove(el, 1048, 440);
		touchMove(el, 1064, 460);
		release(el, 1200, 460);
		expect(log).toEqual(["start:eraser", "move", "move", "end"]);
		expect(menus.length).toBe(0);
	});

	it("the pressure-0 phase itself never draws or erases", () => {
		const { el, log } = setup();
		hover(el, 1000);
		press(el, 1016);
		fire(el, "pointermove", { button: -1, buttons: 1, pressure: 0, clientX: 420, timeStamp: 1032 });
		expect(log).toEqual([]);
	});

	it("the nib may leave and touch again while the button stays down: two erase strokes, still no menu", () => {
		const { el, log } = setup();
		hover(el, 1000);
		press(el, 1016);
		touchMove(el, 1032, 420);
		touchMove(el, 1048, 430);
		touchMove(el, 1064, 440, 0); // lifted, button still down
		touchMove(el, 1080, 500);
		touchMove(el, 1096, 510);
		release(el, 1200, 510);
		expect(log).toEqual(["start:eraser", "move", "end", "start:eraser", "move", "end"]);
	});

	it("a pointerdown with pressure while the button is held also erases", () => {
		const { el, log } = setup();
		hover(el, 1000);
		press(el, 1016);
		fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, clientX: 430, timeStamp: 1032 });
		touchMove(el, 1048, 440);
		release(el, 1100, 440);
		expect(log).toEqual(["start:eraser", "move", "end"]);
	});

	it("the previous tool is active again afterwards: the next contact without the button is ink", () => {
		const { el, log } = setup();
		hover(el, 1000);
		press(el, 1016);
		touchMove(el, 1032, 420);
		release(el, 1100, 420);
		hover(el, 1200);
		fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, timeStamp: 1300 });
		touchMove(el, 1316, 420);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1400 });
		expect(log).toEqual(["start:eraser", "end", "start", "move", "end"]);
	});

	it("contact without the button: normal ink, no menu", () => {
		const { el, log, menus } = setup();
		hover(el, 1000);
		fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, timeStamp: 1016 });
		touchMove(el, 1032, 420);
		touchMove(el, 1048, 430);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1100 });
		expect(log).toEqual(["start", "move", "move", "end"]);
		expect(menus.length).toBe(0);
	});

	it("eraser-only, lasso and previous actions act as that tool while held; radial-only and off ignore the contact", () => {
		const cases: Array<[InputSettings["penButton"], string[]]> = [
			["eraser", ["start:eraser", "move", "end"]],
			["lasso", ["start:lasso", "move", "end"]],
			["previous", ["start:previous", "move", "end"]],
			["radial", []],
			["off", []],
		];
		for (const [penButton, expected] of cases) {
			const { el, log, menus } = setup({ penButton });
			hover(el, 1000);
			press(el, 1016);
			touchMove(el, 1032, 420);
			touchMove(el, 1048, 430);
			release(el, 1100, 430);
			expect(log).toEqual(expected);
			expect(menus.length).toBe(0); // contact in the session: no menu on release
		}
	});

	it("nothing is erased by the pressure-0 phase after the contact ends with a cancel", () => {
		const { el, log, menus } = setup();
		hover(el, 1000);
		press(el, 1016);
		touchMove(el, 1032, 420);
		fire(el, "pointercancel", { button: 0, buttons: 0, pressure: 0, timeStamp: 1100 });
		expect(log).toEqual(["start:eraser", "end"]);
		expect(menus.length).toBe(0);
	});
});

describe("a real contact that starts at pressure 0 still draws", () => {
	beforeEach(() => {
		installFakeWindow();
	});
	afterEach(() => {
		removeFakeWindow();
	});

	it("no hover seen for the pointer before: ink", () => {
		const { el, log, menus } = setup();
		press(el, 1000);
		touchMove(el, 1016, 420, 0);
		touchMove(el, 1032, 430, 0);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1100 });
		expect(log).toEqual(["start", "move", "move", "end"]);
		expect(menus.length).toBe(0);
	});

	it("another pointer id than the hovering one: ink", () => {
		const { el, log } = setup();
		hover(el, 1000);
		fire(el, "pointerdown", { pointerId: 2, button: 0, buttons: 1, pressure: 0, timeStamp: 1016 });
		fire(el, "pointerup", { pointerId: 2, button: 0, buttons: 0, pressure: 0, timeStamp: 1100 });
		expect(log).toEqual(["start", "end"]);
	});

	it("with the zero-pressure setting off: ink", () => {
		const { el, log, menus } = setup({ zeroPressureButton: false });
		hover(el, 1000);
		press(el, 1016);
		release(el, 1100);
		expect(log).toEqual(["start", "end"]);
		expect(menus.length).toBe(0);
	});
});

describe("barrel bit signals keep working", () => {
	it("radial + eraser opens on the press for buttons & 2, as the radial action does", () => {
		const { el, log } = setup();
		hover(el, 1000);
		fire(el, "pointermove", { button: 2, buttons: 2, pressure: 0, timeStamp: 1016 });
		expect(log).toEqual(["menu:button"]);
	});

	it("a pen contact with the barrel bit opens the menu on the press", () => {
		const { el, log } = setup();
		fire(el, "pointerdown", { button: 2, buttons: 3, pressure: 0.5, timeStamp: 1000 });
		expect(log).toEqual(["menu:button"]);
	});

	it("lasso / previous with the barrel bit held at the landing pass the held tool", () => {
		for (const penButton of ["lasso", "previous"] as const) {
			const { el, log } = setup({ penButton });
			fire(el, "pointerdown", { button: 0, buttons: 3, pressure: 0.5, timeStamp: 1000 });
			expect(log).toEqual([`start:${penButton}`]);
		}
	});
});

describe("side button pressed during contact (chord event)", () => {
	beforeEach(() => {
		installFakeWindow();
	});
	afterEach(() => {
		removeFakeWindow();
	});

	const land = (el: FakeEl, t = 1000) => fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, clientX: 400, timeStamp: t });
	const ink = (el: FakeEl, t: number, x: number, button = -1) => fire(el, "pointermove", { button, buttons: 1, pressure: 0.9, clientX: x, timeStamp: t });

	it("ordinary writing never toggles, whatever its coalesced events say", () => {
		const { el, log, menus } = setup();
		land(el);
		for (let i = 1; i <= 60; i++) {
			const t = 1000 + i * 8;
			const coalesced = [{ clientX: 400 + i * 3 - 1, clientY: 300, pressure: 0.8, timeStamp: t - 4, button: 0 }, { clientX: 400 + i * 3, clientY: 300, pressure: 0.8, timeStamp: t, button: 0 }];
			fire(el, "pointermove", { button: -1, buttons: 1, pressure: 0.8, clientX: 400 + i * 3, timeStamp: t, getCoalescedEvents: () => coalesced });
		}
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 2000 });
		expect(log.filter((x) => x !== "move")).toEqual(["start", "end"]);
		expect(menus.length).toBe(0);
	});

	it("a device whose moves all carry button 0 never toggles", () => {
		const { el, log } = setup();
		land(el);
		for (let i = 1; i <= 40; i++) ink(el, 1000 + i * 16, 400 + i * 3, 0);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 2000 });
		expect(log.filter((x) => x !== "move")).toEqual(["start", "end"]);
	});

	it("button 0 on a move finishes the stroke (kept, not discarded) and the contact then erases", () => {
		const { el, log } = setup();
		land(el);
		ink(el, 1050, 410);
		ink(el, 1100, 420);
		ink(el, 1150, 430, 0); // the side button goes down
		ink(el, 1166, 440);
		ink(el, 1182, 450);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1300 });
		expect(log).toEqual(["start", "move", "move", "move", "end", "start:eraser", "move", "move", "end"]);
		expect(log).not.toContain("cancel");
	});

	it("the next such event goes back to ink; the lift resets", () => {
		const { el, log } = setup();
		land(el);
		ink(el, 1050, 410);
		ink(el, 1150, 430, 0);
		ink(el, 1166, 440);
		ink(el, 1400, 450, 0);
		ink(el, 1416, 460);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1500 });
		land(el, 2000);
		ink(el, 2050, 410);
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 2100 });
		expect(log.filter((x) => x.startsWith("start") || x === "end" || x === "cancel")).toEqual(["start", "end", "start:eraser", "end", "start", "end", "start", "end"]);
	});

	it("pointerdown (button 0) and an early button 0 move never toggle", () => {
		const { el, log } = setup();
		land(el);
		ink(el, 1010, 405, 0); // before any ordinary move
		ink(el, 1030, 408);
		ink(el, 1035, 410, 0); // 35 ms after the landing
		expect(log.filter((x) => x === "end" || x === "cancel" || x.startsWith("start:"))).toEqual([]);
	});

	it("pointerrawupdate and pointermove reporting the same change toggle once", () => {
		const el = new FakeEl();
		installFakeWindow({ onpointerrawupdate: null });
		const { log, controller } = (() => {
			const l: string[] = [];
			const handlers: PointerHandlers = {
				drawStart: (_s, eraser) => (l.push(eraser ? "start:eraser" : "start"), true), drawMove: () => {}, drawEnd: (c) => l.push(c ? "cancel" : "end"), pan: () => {}, zoom: () => {},
			};
			const c = new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser" }), handlers);
			return { log: l, controller: c };
		})();
		controller.setRawUpdates(true);
		land(el);
		fire(el, "pointerrawupdate", { button: -1, buttons: 1, pressure: 0.9, clientX: 410, timeStamp: 1050 });
		fire(el, "pointermove", { button: -1, buttons: 1, pressure: 0.9, clientX: 410, timeStamp: 1052 });
		fire(el, "pointerrawupdate", { button: 0, buttons: 1, pressure: 0.9, clientX: 420, timeStamp: 1150 });
		fire(el, "pointermove", { button: 0, buttons: 1, pressure: 0.9, clientX: 420, timeStamp: 1152 });
		fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1300 });
		expect(log).toEqual(["start", "end", "start:eraser", "end"]);
		controller.setRawUpdates(false);
	});

	it("does nothing when the setting is off, for the 'off' action and for the eraser end", () => {
		for (const s of [{ chordButton: false }, { penButton: "off" as const }]) {
			const { el, log } = setup(s);
			land(el);
			ink(el, 1050, 410);
			ink(el, 1150, 430, 0);
			fire(el, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1300 });
			expect(log.filter((x) => x.startsWith("start") || x === "end")).toEqual(["start", "end"]);
		}
		const { el, log } = setup();
		fire(el, "pointerdown", { button: 5, buttons: 33, pressure: 0.6, timeStamp: 1000 });
		fire(el, "pointermove", { button: -1, buttons: 33, pressure: 0.6, timeStamp: 1050 });
		fire(el, "pointermove", { button: 0, buttons: 33, pressure: 0.6, timeStamp: 1200 });
		expect(log.filter((x) => x.startsWith("start"))).toEqual(["start:eraser"]);
	});

	it("the radial-only action: the stroke is finished and the menu opens", () => {
		const { el, log, menus } = setup({ penButton: "radial" });
		land(el);
		ink(el, 1050, 410);
		ink(el, 1150, 430, 0);
		expect(log.filter((x) => x !== "move")).toEqual(["start", "end", "menu:button"]);
		expect(menus.length).toBe(1);
	});
});

// --- Pen button test log ---

describe("Pen button test log", () => {
	const ev = (over: Partial<LoggedEvent>): LoggedEvent => ({ kind: "pointermove", t: 0, pointerType: "pen", pointerId: 3, button: -1, buttons: 0, pressure: 0, isPrimary: true, ...over });

	it("shows the event type and pointer id on every line", () => {
		const line = formatEvent(ev({ kind: "pointerrawupdate", t: 1234, buttons: 1, pressure: 0.5 }));
		expect(line).toContain(" pointerrawupdate type=pen id=3 ");
	});

	it("labels the pressure-0 press, the touch while held, the lift, and the click on release", () => {
		const log = new EventLog();
		log.add(ev({ t: 0 }));
		log.add(ev({ kind: "pointerdown", t: 16, button: 0, buttons: 1 }));
		expect(log.text()).toContain("SIDE BUTTON (pressure 0 primary press)");
		expect(log.sideButtonCount).toBe(1);
		log.add(ev({ kind: "pointermove", t: 32, buttons: 1, pressure: 0.7 }));
		expect(log.text()).toContain("nib touches while the button is held");
		log.add(ev({ kind: "pointermove", t: 48, buttons: 1, pressure: 0 }));
		expect(log.text()).toContain("nib lifted, button still held");
		log.add(ev({ kind: "pointerup", t: 64, button: 0, buttons: 0 }));
		expect(log.text()).toContain("button released");
		const click = new EventLog();
		click.add(ev({ t: 0 }));
		click.add(ev({ kind: "pointerdown", t: 16, button: 0, buttons: 1 }));
		click.add(ev({ kind: "pointerup", t: 100, button: 0, buttons: 0 }));
		expect(click.text()).toContain("click: opens the menu");
	});

	it("does not call an ordinary contact a side button, and a pressure-0 down without hover is not one", () => {
		const log = new EventLog();
		log.add(ev({ t: 0 }));
		log.add(ev({ kind: "pointerdown", t: 16, button: 0, buttons: 1, pressure: 0.5 }));
		log.add(ev({ kind: "pointermove", t: 40, buttons: 1, pressure: 0.6 }));
		log.add(ev({ kind: "pointerup", t: 80, button: 0, buttons: 0 }));
		expect(log.sideButtonCount).toBe(0);
		const noHover = new EventLog();
		noHover.add(ev({ kind: "pointerdown", t: 16, button: 0, buttons: 1, pressure: 0, pointerId: 9 }));
		expect(noHover.sideButtonCount).toBe(0);
	});

	it("labels a pen move with button 0 during contact as a possible side button, but not ordinary moves", () => {
		const log = new EventLog();
		log.add(ev({ t: 0 }));
		log.add(ev({ kind: "pointerdown", t: 16, button: 0, buttons: 1, pressure: 0.6 }));
		log.add(ev({ kind: "pointermove", t: 60, button: -1, buttons: 1, pressure: 1 }));
		expect(log.text()).not.toContain("possible side button");
		log.add(ev({ kind: "pointermove", t: 120, button: 0, buttons: 1, pressure: 0.92 }));
		expect(log.text()).toContain("pointermove with button 0 during contact (possible side button)");
		expect(log.sideButtonCount).toBe(0);
	});
});

// --- settings ---

describe("pen side button settings", () => {
	it("the default is radial + eraser; the values are validated; old saved values are migrated", () => {
		expect(DEFAULT_SETTINGS.penSideButton).toBe("radial-eraser");
		for (const v of ["radial-eraser", "radial", "eraser", "lasso", "previous", "off"]) expect(readSettings({ penSideButton: v }).penSideButton).toBe(v);
		expect(readSettings({ penSideButton: "nonsense" }).penSideButton).toBe("radial-eraser");
		expect(readSettings({ penButtonAction: "radial" }).penSideButton).toBe("radial-eraser");
		expect(readSettings({ penButtonAction: "off" }).penSideButton).toBe("off");
	});

	it("zero-pressure and chord settings default on, parse booleans only and reach the policy", () => {
		expect(DEFAULT_SETTINGS.penZeroPressureButton).toBe(true);
		expect(DEFAULT_SETTINGS.penChordButton).toBe(true);
		expect(readSettings({ penZeroPressureButton: "no", penChordButton: 0 }).penZeroPressureButton).toBe(true);
		const p = policySettings(readSettings({ penZeroPressureButton: false, penChordButton: false }));
		expect(p.zeroPressureButton).toBe(false);
		expect(p.chordButton).toBe(false);
	});

	it("action helpers", () => {
		expect(opensRadial("radial-eraser") && opensRadial("radial")).toBe(true);
		expect(opensRadial("eraser") || opensRadial("off") || opensRadial(undefined)).toBe(false);
		expect(heldToolOf("radial-eraser")).toBe("eraser");
		expect(heldToolOf("eraser")).toBe("eraser");
		expect(heldToolOf("lasso")).toBe("lasso");
		expect(heldToolOf("previous")).toBe("previous");
		expect(heldToolOf("radial")).toBeNull();
		expect(heldToolOf("off")).toBeNull();
	});

	it("policy routing of the barrel bit for the new actions", () => {
		const base: InputSettings = { fingerDrawing: false, palmRejectionMs: 0 };
		expect(new InputPolicy({ ...base, penButton: "radial-eraser" }).route("pen", 0, 2, 0, 2)).toBe("menu");
		expect(new InputPolicy({ ...base, penButton: "lasso" }).route("pen", 0, 0, 0, 3)).toBe("draw");
		expect(new InputPolicy({ ...base, penButton: "lasso" }).penHeld(0, 3)).toBe("lasso");
		expect(new InputPolicy({ ...base, penButton: "lasso" }).penHeld(0, 1)).toBeNull();
		expect(new InputPolicy({ ...base, penButton: "radial-eraser" }).penErases(0, 3)).toBe(false);
	});
});
