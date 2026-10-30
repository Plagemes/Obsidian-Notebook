import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import {
	BarrelDetector, EventLog, HOLD_MS, LOG_LINES, StillHold, describeSideButton, formatEvent, isBarrelSignal, isEraserSignal, strokeIsYoung,
	type LoggedEvent,
} from "../src/ink/pen-button";
import { PointerController, type PointerHandlers } from "../src/ink/pointer-controller";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { policySettings } from "../src/view/input-settings";
import { installFakeWindow, removeFakeWindow } from "./node-env";

describe("signal shapes", () => {
	it("the side button is button 2 or bit 2; the eraser is never the side button", () => {
		expect(isBarrelSignal(2, 2)).toBe(true);
		expect(isBarrelSignal(0, 3)).toBe(true);
		expect(isBarrelSignal(2, 0)).toBe(true);
		expect(isBarrelSignal(0, 1)).toBe(false);
		expect(isBarrelSignal(-1, 0)).toBe(false);
		expect(isEraserSignal(5, 33)).toBe(true);
		expect(isEraserSignal(0, 32)).toBe(true);
		expect(isBarrelSignal(5, 34)).toBe(false);
		expect(isBarrelSignal(0, 34)).toBe(false);
	});
});

describe("BarrelDetector: pointer signals", () => {
	it("pointerdown with the button held is a press, once", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "pen", 2, 2, 100)).toBe(true);
		expect(d.pointer("move", "pen", -1, 2, 116)).toBe(false);
		expect(d.pointer("up", "pen", 2, 0, 200)).toBe(false);
		expect(d.isHeld).toBe(false);
		expect(d.pointer("down", "pen", 2, 2, 300)).toBe(true);
	});

	it("contact with the button: button 0, buttons 3 is a press", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "pen", 0, 3, 100)).toBe(true);
	});

	it("hover: buttons turning on during pointermove (and pointerrawupdate) is one press per press", () => {
		const d = new BarrelDetector();
		expect(d.pointer("move", "pen", -1, 0, 100)).toBe(false);
		expect(d.pointer("move", "pen", 2, 2, 116)).toBe(true);
		expect(d.pointer("move", "pen", -1, 2, 132)).toBe(false);
		expect(d.pointer("move", "pen", 2, 0, 148)).toBe(false); // released: button 2 but buttons 0
		expect(d.pointer("move", "pen", -1, 2, 164)).toBe(true);
	});

	it("a move that releases the button (button 2, buttons 0) is not a press", () => {
		const d = new BarrelDetector();
		expect(d.pointer("move", "pen", 2, 0, 100)).toBe(false);
	});

	it("the eraser bit is never a press", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "pen", 5, 33, 100)).toBe(false);
		expect(d.pointer("move", "pen", -1, 32, 116)).toBe(false);
		expect(d.pointer("move", "pen", -1, 34, 132)).toBe(false);
	});

	it("touch never presses; a mouse right button only right after pen activity", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "touch", 2, 2, 100)).toBe(false);
		expect(d.pointer("down", "mouse", 2, 2, 200)).toBe(false);
		expect(d.asPen("mouse", 2, 2, 200)).toBe(false);
		d.pointer("move", "pen", -1, 0, 1000);
		expect(d.asPen("mouse", 2, 2, 1100)).toBe(true);
		expect(d.asPen("mouse", 0, 1, 1100)).toBe(false);
		expect(d.pointer("down", "mouse", 2, 2, 1100)).toBe(true);
	});
});

describe("BarrelDetector: contextmenu and auxclick", () => {
	it("a contextmenu from the pen while hovering is a press", () => {
		const d = new BarrelDetector();
		d.pointer("move", "pen", -1, 0, 100);
		expect(d.contextMenu("pen", 110)).toBe(true);
		// the click that closes the press is consumed, not a second press
		expect(d.auxClick("pen", 2, 400)).toBe(false);
		expect(d.contextMenu("pen", 2000)).toBe(true);
	});

	it("a plain MouseEvent contextmenu counts only right after pen activity", () => {
		const d = new BarrelDetector();
		expect(d.contextMenu(undefined, 100)).toBe(false);
		d.pointer("move", "pen", -1, 0, 1000);
		expect(d.contextMenu(undefined, 1100)).toBe(true);
		expect(d.contextMenu(undefined, 3000)).toBe(false); // pen idle for a while
	});

	it("never from a touch long-press, even with a pen hovering nearby", () => {
		const d = new BarrelDetector();
		d.pointer("move", "pen", -1, 0, 1000);
		expect(d.contextMenu("touch", 1100)).toBe(false);
		d.pointer("down", "touch", 0, 1, 1200);
		d.pointer("move", "pen", -1, 0, 1700);
		expect(d.contextMenu(undefined, 1750)).toBe(false); // plain event while a finger is down
		d.pointer("up", "touch", 0, 0, 1800);
		expect(d.contextMenu("touch", 1850)).toBe(false);
	});

	it("a pen long-press on the page (contact, no barrel signal) is not the button", () => {
		const d = new BarrelDetector();
		d.pointer("down", "pen", 0, 1, 1000);
		expect(d.contextMenu("pen", 1600)).toBe(false);
		expect(d.contextMenu(undefined, 1600)).toBe(false);
	});

	it("a lift swallowed by the menu does not leave the pen in contact: the next hover press still works through contextmenu", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "pen", 0, 3, 1000)).toBe(true);
		// no pointerup is ever seen (the menu took it)
		d.pointer("move", "pen", -1, 0, 5000);
		expect(d.contextMenu("pen", 5010)).toBe(true);
	});

	it("a contextmenu after a barrel signal during contact is the button; a pointer press is not repeated", () => {
		const d = new BarrelDetector();
		expect(d.pointer("down", "pen", 0, 3, 1000)).toBe(true);
		expect(d.contextMenu("pen", 1010)).toBe(false); // already handled by the pointer events
		expect(d.auxClick("pen", 2, 1500)).toBe(false);
	});

	it("auxclick alone (button 2, pen) is a press; other buttons, touch and mouse are not", () => {
		const d = new BarrelDetector();
		expect(d.auxClick("pen", 2, 100)).toBe(true);
		expect(d.auxClick("pen", 1, 200)).toBe(false);
		expect(d.auxClick("touch", 2, 300)).toBe(false);
		expect(d.auxClick("mouse", 2, 400)).toBe(false);
		expect(d.auxClick(undefined, 2, 500)).toBe(false); // no recent pen
	});

	it("the same press seen as pointer events, contextmenu and auxclick opens once; the next press opens again", () => {
		const d = new BarrelDetector();
		let opens = 0;
		const press = (t: number) => {
			if (d.pointer("move", "pen", 2, 2, t)) opens++;
			if (d.contextMenu("pen", t + 1)) opens++;
			d.pointer("move", "pen", 2, 0, t + 100);
			if (d.auxClick("pen", 2, t + 101)) opens++;
		};
		press(1000);
		expect(opens).toBe(1);
		press(5000);
		expect(opens).toBe(2);
	});
});

describe("StillHold and young strokes", () => {
	it("stays still within the radius and stops being still when it moves out", () => {
		const h = new StillHold();
		expect(h.still).toBe(false);
		h.begin(100, 100);
		h.move(103, 102);
		expect(h.still).toBe(true);
		h.move(120, 100);
		expect(h.still).toBe(false);
		h.move(100, 100);
		expect(h.still).toBe(false); // it does not come back
		h.begin(0, 0);
		expect(h.still).toBe(true);
		h.end();
		expect(h.still).toBe(false);
	});

	it("only a stroke that just landed and did not move is young", () => {
		expect(strokeIsYoung(1000, 1200, false)).toBe(true);
		expect(strokeIsYoung(1000, 1200, true)).toBe(false);
		expect(strokeIsYoung(1000, 1500, false)).toBe(false);
	});
});

describe("diagnostic log", () => {
	const ev = (over: Partial<LoggedEvent>): LoggedEvent => ({ kind: "pointermove", t: 0, pointerType: "pen", button: -1, buttons: 0, pressure: 0, isPrimary: true, ...over });

	it("says whether the plugin would treat each event as the side button", () => {
		expect(describeSideButton(ev({ kind: "pointerdown", button: 2, buttons: 2 }))).toBe("side-button");
		expect(describeSideButton(ev({ kind: "pointermove", buttons: 2 }))).toBe("side-button");
		expect(describeSideButton(ev({ kind: "pointermove", button: 2, buttons: 0 }))).toBe("no");
		expect(describeSideButton(ev({ kind: "pointerup", button: 2, buttons: 0 }))).toBe("no");
		expect(describeSideButton(ev({ kind: "pointerdown", button: 5, buttons: 33 }))).toBe("eraser");
		expect(describeSideButton(ev({ kind: "pointerdown", pointerType: "touch", button: 0, buttons: 1 }))).toBe("no");
		expect(describeSideButton(ev({ kind: "contextmenu", pointerType: "pen" }))).toBe("side-button");
		expect(describeSideButton(ev({ kind: "contextmenu", pointerType: "touch" }))).toBe("no");
		expect(describeSideButton(ev({ kind: "auxclick", pointerType: "pen", button: 2 }))).toBe("side-button");
		expect(describeSideButton(ev({ kind: "keydown" }))).toBe("no");
	});

	it("formats pointer and key lines in plain text", () => {
		const line = formatEvent(ev({ kind: "pointerdown", t: 1234, button: 2, buttons: 3, pressure: 0.5 }));
		expect(line).toBe("1.234s pointerdown type=pen button=2 buttons=3 pressure=0.50 primary=true => SIDE BUTTON");
		expect(formatEvent({ kind: "keydown", t: 50, key: "F13", code: "F13" })).toBe('0.050s keydown key="F13" code=F13');
	});

	it("keeps the last LOG_LINES lines, folds repeated moves and counts side-button events", () => {
		const log = new EventLog();
		for (let i = 0; i < 100; i++) log.add(ev({ t: i }));
		expect(log.length).toBe(1);
		expect(log.text()).toContain("(x100)");
		log.add(ev({ kind: "pointermove", buttons: 2, t: 101 }));
		expect(log.sideButtonCount).toBe(1);
		for (let i = 0; i < LOG_LINES + 10; i++) log.add(ev({ kind: "contextmenu", t: 200 + i }));
		expect(log.length).toBe(LOG_LINES);
		expect(log.text().split("\n").length).toBe(LOG_LINES);
		log.clear();
		expect(log.length).toBe(0);
		expect(log.sideButtonCount).toBe(0);
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
	const menus: Array<[number, number]> = [];
	const handlers: PointerHandlers = {
		drawStart: () => (log.push("start"), true),
		drawMove: () => log.push("move"),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => log.push("pan"),
		zoom: () => log.push("zoom"),
		penMenu: (x, y) => (menus.push([x, y]), log.push("menu")),
	};
	const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial", ...settings });
	const controller = new PointerController(el as unknown as HTMLElement, policy, handlers);
	return { el, log, menus, policy, controller };
}

describe("PointerController: every signal opens the menu once and draws nothing", () => {
	beforeEach(() => {
		// The controller uses window.setTimeout; in Node the global object stands in for window.
		installFakeWindow();
	});
	afterEach(() => {
		vi.useRealTimers();
		removeFakeWindow();
	});

	it("hover press as pointermove with buttons 2", () => {
		const { el, log, menus } = setup();
		fire(el, "pointermove", { buttons: 0 });
		fire(el, "pointermove", { buttons: 2, button: 2, timeStamp: 1016 });
		fire(el, "pointermove", { buttons: 2, timeStamp: 1032 });
		expect(menus.length).toBe(1);
		expect(log).toEqual(["menu"]);
	});

	it("hover press seen only as a pointerrawupdate (when listened)", () => {
		const el = new FakeEl();
		const menus: number[] = [];
		const handlers: PointerHandlers = {
			drawStart: () => true, drawMove: () => {}, drawEnd: () => {}, pan: () => {}, zoom: () => {}, penMenu: () => void menus.push(1),
		};
		const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial" });
		const controller = new PointerController(el as unknown as HTMLElement, policy, handlers);
		// pointerrawupdate needs `window`; install the listener directly the way setRawUpdates would.
		installFakeWindow({ onpointerrawupdate: null });
		try {
			controller.setRawUpdates(true);
			fire(el, "pointerrawupdate", { buttons: 2, button: 2 });
			fire(el, "pointerrawupdate", { buttons: 2 });
			expect(menus.length).toBe(1);
			controller.setRawUpdates(false);
		} finally {
			removeFakeWindow();
		}
	});

	it("contextmenu from the pen opens the menu and is prevented; one from touch does not open it", () => {
		vi.useFakeTimers();
		const { el, log, menus } = setup();
		fire(el, "pointermove", { buttons: 0 });
		const pen = fire(el, "contextmenu", { pointerType: "pen", clientX: 300, clientY: 200, timeStamp: 1010 });
		expect(pen.defaultPrevented).toBe(true);
		// 0.11.2: with no contact it is a hover click, acted on once no pen contact follows within the before-window.
		vi.advanceTimersByTime(200);
		expect(menus).toEqual([[200, 150]]);
		const touch = fire(el, "contextmenu", { pointerType: "touch", timeStamp: 5000 });
		expect(touch.defaultPrevented).toBe(true);
		vi.advanceTimersByTime(200);
		expect(log).toEqual(["menu"]);
		vi.useRealTimers();
	});

	it("a plain contextmenu (no pointerType) after pen hover opens the menu; with a finger down it does not", () => {
		vi.useFakeTimers();
		const a = setup();
		fire(a.el, "pointermove", { buttons: 0 });
		fire(a.el, "contextmenu", { pointerType: undefined, timeStamp: 1100 });
		vi.advanceTimersByTime(200);
		vi.useRealTimers();
		expect(a.menus.length).toBe(1);
		const b = setup();
		fire(b.el, "pointermove", { buttons: 0 });
		fire(b.el, "pointerdown", { pointerId: 5, pointerType: "touch", button: 0, buttons: 1, timeStamp: 1100 });
		fire(b.el, "contextmenu", { pointerType: undefined, timeStamp: 1200 });
		expect(b.menus.length).toBe(0);
	});

	it("auxclick button 2 from the pen opens the menu", () => {
		const { el, menus } = setup();
		fire(el, "auxclick", { pointerType: "pen", button: 2 });
		expect(menus.length).toBe(1);
	});

	it("pointerdown + contextmenu + auxclick of one contact press open it once", () => {
		const { el, log, menus } = setup();
		fire(el, "pointerdown", { button: 2, buttons: 3, pressure: 0.5, timeStamp: 1000 });
		fire(el, "contextmenu", { pointerType: "pen", timeStamp: 1005 });
		fire(el, "pointerup", { button: 2, buttons: 0, timeStamp: 1100 });
		fire(el, "auxclick", { pointerType: "pen", button: 2, timeStamp: 1101 });
		expect(menus.length).toBe(1);
		expect(log).toEqual(["menu"]);
	});

	it("the pen's button reported as a mouse right button right after pen activity opens the menu", () => {
		const { el, log, menus } = setup();
		fire(el, "pointermove", { buttons: 0, timeStamp: 1000 });
		fire(el, "pointerdown", { pointerType: "mouse", pointerId: 9, button: 2, buttons: 2, timeStamp: 1100 });
		expect(menus.length).toBe(1);
		expect(log).toEqual(["menu"]);
		// A real mouse right click with no pen around still does nothing.
		const b = setup();
		fire(b.el, "pointerdown", { pointerType: "mouse", pointerId: 9, button: 2, buttons: 2, timeStamp: 1100 });
		expect(b.menus.length).toBe(0);
	});

	it("a button pressed just after the nib landed discards that stroke (no dot) and opens the menu", () => {
		const { el, log, menus } = setup();
		fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, timeStamp: 1000 });
		fire(el, "pointermove", { button: 2, buttons: 3, pressure: 0.4, timeStamp: 1100 });
		expect(log).toEqual(["start", "cancel", "menu"]);
		expect(menus.length).toBe(1);
	});

	it("never interrupts real writing: a button brushed during a stroke does nothing", () => {
		const a = setup();
		fire(a.el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, timeStamp: 1000 });
		fire(a.el, "pointermove", { buttons: 1, clientX: 440, timeStamp: 1050 });
		fire(a.el, "pointermove", { buttons: 3, clientX: 441, timeStamp: 1100 });
		expect(a.menus.length).toBe(0);
		expect(a.log).not.toContain("cancel");
		// stationary but old: also left alone
		const b = setup();
		fire(b.el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, timeStamp: 1000 });
		fire(b.el, "pointermove", { buttons: 3, timeStamp: 2000 });
		expect(b.menus.length).toBe(0);
		// a contextmenu in the middle of a stroke does not steal it either
		const c = setup();
		fire(c.el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, timeStamp: 1000 });
		fire(c.el, "pointermove", { buttons: 1, clientX: 440, timeStamp: 1050 });
		fire(c.el, "contextmenu", { pointerType: "pen", timeStamp: 1060 });
		expect(c.menus.length).toBe(0);
	});

	it("nothing opens when the action is not the radial menu", () => {
		for (const penButton of ["off", "eraser"] as const) {
			const { el, menus } = setup({ penButton });
			fire(el, "pointermove", { buttons: 2, button: 2 });
			fire(el, "contextmenu", { pointerType: "pen" });
			fire(el, "auxclick", { pointerType: "pen", button: 2 });
			expect(menus.length).toBe(0);
		}
	});

	it("the eraser button keeps erasing and never opens the menu", () => {
		const el = new FakeEl();
		const starts: boolean[] = [];
		const menus: number[] = [];
		const handlers: PointerHandlers = {
			drawStart: (_s, eraser) => (starts.push(eraser), true), drawMove: () => {}, drawEnd: () => {}, pan: () => {}, zoom: () => {}, penMenu: () => void menus.push(1),
		};
		new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial" }), handlers);
		fire(el, "pointerdown", { button: 5, buttons: 33, pressure: 0.5 });
		expect(starts).toEqual([true]);
		expect(menus.length).toBe(0);
	});

	it("normal writing is untouched: down, moves, up", () => {
		const { el, log } = setup();
		fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, timeStamp: 1000 });
		fire(el, "pointermove", { buttons: 1, pressure: 0.5, clientX: 410, timeStamp: 1016 });
		fire(el, "pointerup", { button: 0, buttons: 0, timeStamp: 1032 });
		expect(log).toEqual(["start", "move", "end"]);
	});

	describe("still-hold fallback", () => {
		it("a pen held still HOLD_MS opens the menu and discards the stroke", () => {
			vi.useFakeTimers();
			const { el, log, menus } = setup({ penLongPress: true });
			fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, clientX: 400, clientY: 300 });
			vi.advanceTimersByTime(HOLD_MS - 1);
			expect(log).toEqual(["start"]);
			vi.advanceTimersByTime(2);
			expect(log).toEqual(["start", "cancel", "menu"]);
			expect(menus).toEqual([[300, 250]]);
			// the lift that follows does nothing
			fire(el, "pointerup", { button: 0, buttons: 0, timeStamp: 1700 });
			expect(log).toEqual(["start", "cancel", "menu"]);
		});

		it("any real movement cancels it: slow writing never opens the menu", () => {
			vi.useFakeTimers();
			const { el, log, menus } = setup({ penLongPress: true });
			fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4, clientX: 400, clientY: 300 });
			fire(el, "pointermove", { buttons: 1, pressure: 0.4, clientX: 412, clientY: 300, timeStamp: 1100 });
			vi.advanceTimersByTime(5000);
			expect(menus.length).toBe(0);
			expect(log).toEqual(["start", "move"]);
		});

		it("a dot (short tap) and a lifted pen never open it", () => {
			vi.useFakeTimers();
			const { el, log, menus } = setup({ penLongPress: true });
			fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4 });
			vi.advanceTimersByTime(200);
			fire(el, "pointerup", { button: 0, buttons: 0, timeStamp: 1200 });
			vi.advanceTimersByTime(5000);
			expect(menus.length).toBe(0);
			expect(log).toEqual(["start", "end"]);
		});

		it("is off in the policy by default and when the side button is not the radial menu", () => {
			vi.useFakeTimers();
			for (const s of [{}, { penLongPress: true, penButton: "off" as const }, { penLongPress: true, penButton: "eraser" as const }]) {
				const { el, menus } = setup(s);
				fire(el, "pointerdown", { button: 0, buttons: 1, pressure: 0.4 });
				vi.advanceTimersByTime(5000);
				expect(menus.length).toBe(0);
			}
		});

		it("does not apply to touch or mouse strokes", () => {
			vi.useFakeTimers();
			const { el, menus } = setup({ penLongPress: true, fingerDrawing: true });
			fire(el, "pointerdown", { pointerId: 4, pointerType: "touch", button: 0, buttons: 1 });
			fire(el, "pointerup", { pointerId: 4, pointerType: "touch", button: 0, buttons: 0 });
			fire(el, "pointerdown", { pointerId: 5, pointerType: "mouse", button: 0, buttons: 1 });
			vi.advanceTimersByTime(5000);
			expect(menus.length).toBe(0);
		});
	});
});

describe("settings", () => {
	it("penHoldStill is a tri-state (null = automatic), parses booleans only and reaches the input policy", () => {
		expect(DEFAULT_SETTINGS.penHoldStill).toBeNull();
		expect(readSettings({ penHoldStill: true }).penHoldStill).toBe(true);
		expect(readSettings({ penHoldStill: false }).penHoldStill).toBe(false);
		expect(readSettings({ penHoldStill: "yes" }).penHoldStill).toBeNull();
		expect(policySettings(readSettings({ penHoldStill: true })).penLongPress).toBe(true);
		expect(policySettings(readSettings({ penHoldStill: false })).penLongPress).toBe(false);
	});

	it("the eraser bit stays an eraser in every mode and is never a menu route", () => {
		for (const penButton of ["radial", "eraser", "off"] as const) {
			const p = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton });
			expect(p.route("pen", 0, 5, 0, 34)).toBe("draw");
			expect(p.penErases(5, 34)).toBe(true);
			expect(p.penErases(0, 32)).toBe(true);
		}
	});
});
