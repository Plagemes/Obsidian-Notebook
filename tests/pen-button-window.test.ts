import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import { BarrelDetector, ChordDetector, EventLog, PEN_TEST_EVENT_TYPES, describeSideButton, describeTarget, formatEvent, type LoggedEvent } from "../src/ink/pen-button";
import { PointerController, type MenuSource, type PointerHandlers } from "../src/ink/pointer-controller";
import { installFakeWindow, removeFakeWindow, sleep } from "./node-env";

// 0.11.1: the S Pen button as the user read it off the pen-tracker page (Chrome, Samsung tablet), and the
// window-level capture watch that also sees events that never reach the page element.

/** The user's three readings, as recorded event sequences: [type, button, buttons, pressure, t]. */
type Rec = [string, number, number, number, number];
const HOVER_NO_BUTTON: Rec[] = [
	["pointerover", -1, 0, 0, 0], ["pointerenter", -1, 0, 0, 0],
	["pointermove", -1, 0, 0, 16], ["pointermove", -1, 0, 0, 32], ["pointermove", -1, 0, 0, 48],
];
const HOVER_WITH_BUTTON: Rec[] = [
	...HOVER_NO_BUTTON,
	["pointerdown", 0, 1, 0, 64], ["pointermove", -1, 1, 0, 80], ["pointermove", -1, 1, 0, 96], ["pointerup", 0, 0, 0, 200],
];
const TOUCH_THEN_BUTTON: Rec[] = [
	...HOVER_NO_BUTTON,
	["pointerdown", 0, 1, 0.9, 64], ["pointermove", -1, 1, 1, 80], ["pointermove", -1, 1, 1, 120], ["pointermove", 0, 1, 0.92, 200],
	["pointermove", -1, 1, 0.9, 216], ["pointerup", 0, 0, 0, 300],
];
const KIND: Record<string, "down" | "move" | "up" | "cancel" | undefined> = { pointerdown: "down", pointermove: "move", pointerup: "up", pointercancel: "cancel" };

describe("the user's three pen-tracker readings (detector)", () => {
	const run = (seq: Rec[]) => {
		const d = new BarrelDetector();
		const c = new ChordDetector();
		const presses: number[] = [];
		const transitions: string[] = [];
		const chords: number[] = [];
		for (const [type, button, buttons, pressure, t] of seq) {
			const kind = KIND[type];
			if (!kind) continue;
			if (d.pointer(kind, "pen", button, buttons, t, pressure, 1)) presses.push(t);
			if (d.transition !== "none") transitions.push(d.transition);
			if (kind === "down" && pressure > 0) c.down(t);
			else if (kind === "up") c.up();
			else if (kind === "move" && c.move(button, buttons, pressure, t)) chords.push(t);
		}
		return { presses, transitions, chords };
	};

	it("hovering without the button (button -1, buttons 0, pressure 0): nothing", () => {
		expect(run(HOVER_NO_BUTTON)).toEqual({ presses: [], transitions: [], chords: [] });
	});

	it("hovering with the button held (pointerdown button 0, buttons 1, pressure 0): the side button, a click on release", () => {
		expect(run(HOVER_WITH_BUTTON)).toEqual({ presses: [64], transitions: ["press", "release-click"], chords: [] });
	});

	it("touching, then the button (a pointermove with button 0 instead of -1): no press, one chord toggle", () => {
		expect(run(TOUCH_THEN_BUTTON)).toEqual({ presses: [], transitions: [], chords: [200] });
	});
});

describe("BarrelDetector: a press that comes only as a mouse event", () => {
	const hover = (d: BarrelDetector, t: number) => d.pointer("move", "pen", -1, 0, t, 0, 1);

	it("a mousedown with no pointerdown just before, the pen hovering, is a press, once", () => {
		const d = new BarrelDetector();
		hover(d, 1000);
		expect(d.mouseDown(0, 1, 1100)).toBe(true);
		expect(d.mouseDown(0, 1, 1200)).toBe(false); // the same press
		expect(d.contextMenu("pen", 1300)).toBe(false); // its trailing contextmenu
	});

	it("button 2 also; never the eraser, a middle button or without the pen near", () => {
		const d = new BarrelDetector();
		hover(d, 1000);
		expect(d.mouseDown(1, 4, 1100)).toBe(false);
		expect(d.mouseDown(5, 32, 1100)).toBe(false);
		expect(d.mouseDown(2, 2, 1100)).toBe(true);
		const far = new BarrelDetector();
		hover(far, 1000);
		expect(far.mouseDown(0, 1, 3000)).toBe(false);
	});

	it("never the compatibility mousedown of a pointerdown, of a finger, or while the nib touches", () => {
		const d = new BarrelDetector();
		hover(d, 1000);
		d.noteAny("down", "pen", 1100);
		expect(d.mouseDown(0, 1, 1110)).toBe(false);
		const f = new BarrelDetector();
		hover(f, 1000);
		f.noteAny("move", "touch", 1050);
		expect(f.mouseDown(0, 1, 1700)).toBe(false);
		expect(f.mouseDown(0, 1, 1500, true)).toBe(false);
		const c = new BarrelDetector();
		hover(c, 1000);
		c.pointer("down", "pen", 0, 1, 1010, 0.6, 1);
		expect(c.mouseDown(0, 1, 1600)).toBe(false);
	});

	it("never during a pressure-0 press (its own compatibility events)", () => {
		const d = new BarrelDetector();
		hover(d, 1000);
		d.pointer("down", "pen", 0, 1, 1016, 0, 1);
		expect(d.zeroPressureHeld).toBe(true);
		expect(d.mouseDown(0, 1, 1600)).toBe(false);
	});
});

// --- PointerController: the window-level watch ---

class FakeNode extends EventTarget {
	constructor(readonly name: string, readonly parent: FakeNode | null = null) {
		super();
	}
	contains(n: unknown): boolean {
		for (let p = n as FakeNode | null; p; p = p.parent) if (p === this) return true;
		return false;
	}
}

class FakeStage extends FakeNode {
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

function setup(settings: Partial<InputSettings> = {}, accept = true) {
	const win = new EventTarget();
	const view = new FakeNode("view");
	const stage = new FakeStage("stage", view);
	const canvas = new FakeNode("canvas", stage);
	const toolbar = new FakeNode("toolbar", view);
	const modal = new FakeNode("modal");
	const log: string[] = [];
	const menus: Array<[number, number, MenuSource]> = [];
	let seen = 0;
	const handlers: PointerHandlers = {
		drawStart: (_s, eraser) => (log.push(`start${eraser ? ":eraser" : ""}`), accept),
		drawMove: () => log.push("move"),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => log.push("pan"),
		zoom: () => log.push("zoom"),
		penMenu: (x, y, source) => (menus.push([x, y, source]), log.push(`menu:${source}`)),
		sideButtonSeen: () => void seen++,
	};
	const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser", ...settings });
	const controller = new PointerController(stage as unknown as HTMLElement, policy, handlers, {
		scope: view as unknown as Node, windowTarget: win,
	});
	/**
	 * Dispatches like a browser would: window (capture), then the stage (capture marker and its listeners) when the
	 * target is inside it and nothing stopped the event above it.
	 */
	const fire = (target: FakeNode, type: string, init: Record<string, unknown>, reachesStage = true): Event => {
		const e = new Event(type, { cancelable: true });
		const props = { pointerId: 1, pointerType: "pen", button: -1, buttons: 0, pressure: 0, clientX: 400, clientY: 300, timeStamp: 1000, ...init };
		for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
		Object.defineProperty(e, "target", { value: target });
		win.dispatchEvent(e);
		if (view.contains(target)) view.dispatchEvent(e);
		if (reachesStage && stage.contains(target)) stage.dispatchEvent(e);
		return e;
	};
	const flush = () => sleep(5);
	return { win, view, stage, canvas, toolbar, modal, log, menus, controller, fire, flush, seen: () => seen };
}

describe("PointerController: side button at window level (capture phase)", () => {
	beforeEach(() => {
		installFakeWindow();
	});
	afterEach(() => {
		removeFakeWindow();
	});

	const click = (s: ReturnType<typeof setup>, target: FakeNode, reaches = true, x = 400) => {
		s.fire(target, "pointermove", { timeStamp: 1000, clientX: x }, reaches);
		s.fire(target, "pointermove", { timeStamp: 1016, clientX: x }, reaches);
		s.fire(target, "pointerdown", { button: 0, buttons: 1, pressure: 0, timeStamp: 1032, clientX: x }, reaches);
		s.fire(target, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1200, clientX: x }, reaches);
	};

	it("events that reach the page are handled once, by the page's own listeners (no second menu)", async () => {
		const s = setup();
		click(s, s.canvas);
		await s.flush();
		expect(s.log).toEqual(["menu:click"]);
		expect(s.seen()).toBe(1);
	});

	it("a click over the page that a handler above it stopped still opens the menu, and never draws", async () => {
		const s = setup();
		click(s, s.canvas, false);
		await s.flush();
		expect(s.log).toEqual(["menu:click"]);
		expect(s.menus).toEqual([[300, 250, "click"]]);
	});

	it("a click over another part of the view lying on the page (toolbar, bar) opens the menu", () => {
		const s = setup();
		click(s, s.toolbar);
		expect(s.log).toEqual(["menu:click"]);
	});

	it("the press is counted but no menu opens when the pen is outside the page area", () => {
		const s = setup();
		click(s, s.toolbar, true, 50);
		expect(s.log).toEqual([]);
		expect(s.seen()).toBe(1);
	});

	it("events outside the view (a modal, another view) are ignored", () => {
		const s = setup();
		click(s, s.modal);
		expect(s.log).toEqual([]);
		expect(s.seen()).toBe(0);
	});

	it("a mousedown that no pointer event announced, the pen hovering over the page: the menu, once", () => {
		const s = setup();
		s.fire(s.canvas, "pointermove", { timeStamp: 1000 });
		s.fire(s.canvas, "mousedown", { pointerType: undefined, button: 0, buttons: 1, timeStamp: 1100 });
		s.fire(s.canvas, "contextmenu", { pointerType: undefined, button: 2, buttons: 0, timeStamp: 1150 });
		expect(s.log).toEqual(["menu:button"]);
	});

	it("the compatibility mousedown of an ordinary pen contact is not a press", () => {
		const s = setup();
		s.fire(s.canvas, "pointermove", { timeStamp: 1000 });
		s.fire(s.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, timeStamp: 1016 });
		s.fire(s.canvas, "mousedown", { pointerType: undefined, button: 0, buttons: 1, timeStamp: 1017 });
		s.fire(s.canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1100 });
		expect(s.log).toEqual(["start", "end"]);
	});

	it("a mousedown after a finger touched the toolbar is not a press", () => {
		const s = setup();
		s.fire(s.canvas, "pointermove", { timeStamp: 1000 });
		s.fire(s.toolbar, "pointerdown", { pointerType: "touch", pointerId: 7, button: 0, buttons: 1, pressure: 1, timeStamp: 1100 });
		s.fire(s.toolbar, "pointerup", { pointerType: "touch", pointerId: 7, button: 0, buttons: 0, timeStamp: 1150 });
		s.fire(s.canvas, "mousedown", { pointerType: undefined, button: 0, buttons: 1, timeStamp: 1700 });
		expect(s.log).toEqual([]);
	});

	it("the user's hover press on the page itself: pressure-0 pointerdown is the button, not a stroke start", () => {
		const s = setup();
		for (const [type, button, buttons, pressure, t] of HOVER_WITH_BUTTON) {
			s.fire(s.canvas, type, { button, buttons, pressure, timeStamp: 1000 + t });
		}
		expect(s.log).toEqual(["menu:click"]);
	});

	it("touching, then pressing: the stroke so far is kept and the contact erases (experimental chord)", () => {
		const s = setup();
		for (const [type, button, buttons, pressure, t] of TOUCH_THEN_BUTTON) {
			s.fire(s.canvas, type, { button, buttons, pressure, timeStamp: 1000 + t });
		}
		expect(s.log.filter((l) => l !== "move")).toEqual(["start", "end", "start:eraser", "end"]);
	});

	it("listeners are removed on destroy", () => {
		const s = setup();
		s.controller.destroy();
		click(s, s.toolbar);
		expect(s.log).toEqual([]);
	});
});

describe("Pen button test log: window-level events", () => {
	const ev = (over: Partial<LoggedEvent>): LoggedEvent => ({ kind: "pointermove", t: 0, pointerType: "pen", pointerId: 3, button: -1, buttons: 0, pressure: 0, isPrimary: true, ...over });

	it("records pointer, mouse, touch, contextmenu, auxclick, capture and key events", () => {
		for (const type of ["pointerdown", "pointerover", "pointerenter", "gotpointercapture", "mousedown", "mouseup", "click", "contextmenu", "auxclick", "touchstart", "keydown"]) {
			expect(PEN_TEST_EVENT_TYPES).toContain(type);
		}
	});

	it("shows the target and the event's own timestamp", () => {
		const line = formatEvent(ev({ kind: "pointerdown", t: 16, button: 0, buttons: 1, target: "div.notebook-pentest-area(area)", timeStamp: 1234.56 }));
		expect(line).toContain(" @div.notebook-pentest-area(area) ts=1234.6 ");
	});

	it("labels an unannounced mousedown with the pen hovering as a possible side button and counts it", () => {
		const log = new EventLog();
		log.add(ev({ t: 0 }));
		log.add(ev({ kind: "mousedown", pointerType: "", t: 100, button: 0, buttons: 1 }));
		expect(log.text()).toContain("SIDE BUTTON? (mousedown with no pointerdown, pen hovering)");
		expect(log.sideButtonCount).toBe(1);
		const compat = new EventLog();
		compat.add(ev({ t: 0 }));
		compat.add(ev({ kind: "pointerdown", t: 90, button: 0, buttons: 1, pressure: 0.5 }));
		compat.add(ev({ kind: "mousedown", pointerType: "", t: 91, button: 0, buttons: 1 }));
		expect(compat.sideButtonCount).toBe(0);
	});

	it("enter / over / capture events are never a press of their own", () => {
		expect(describeSideButton(ev({ kind: "pointerover", buttons: 2 }))).toBe("no");
		expect(describeSideButton(ev({ kind: "gotpointercapture", buttons: 2 }))).toBe("no");
	});

	it("interleaved hover moves (pointer, mouse, rawupdate) fold; counts per type are kept", () => {
		const log = new EventLog();
		for (let i = 0; i < 50; i++) {
			log.add(ev({ kind: "pointerrawupdate", t: i * 16 }));
			log.add(ev({ kind: "pointermove", t: i * 16 + 1 }));
			log.add(ev({ kind: "mousemove", pointerType: "", t: i * 16 + 2, button: 0, buttons: 0 }));
		}
		expect(log.length).toBe(3);
		expect(log.text()).toContain("(x50)");
		expect(log.countsText()).toBe("mousemove 50, pointermove 50, pointerrawupdate 50");
		log.add(ev({ kind: "pointerdown", t: 900, button: 0, buttons: 1 }));
		expect(log.length).toBe(4);
		log.clear();
		expect(log.total).toBe(0);
		expect(log.countsText()).toBe("");
	});

	it("names targets briefly", () => {
		const win = {}, doc = {};
		const area = new FakeNode("area");
		const inside = Object.assign(new FakeNode("x", area), { tagName: "SPAN", className: "a b" });
		expect(describeTarget(win as EventTarget, null, win, doc)).toBe("window");
		expect(describeTarget(doc as EventTarget, null, win, doc)).toBe("document");
		expect(describeTarget(inside, area, win, doc)).toBe("span.a(area)");
		expect(describeTarget({ tagName: "CANVAS", className: "" } as unknown as EventTarget, area, win, doc)).toBe("canvas");
		expect(describeTarget(null, null, win, doc)).toBe("-");
	});
});

describe("cancelling the native long-press / context menu, as pen-tracker does", () => {
	beforeEach(() => {
		installFakeWindow();
	});
	afterEach(() => {
		removeFakeWindow();
	});

	it("blocksContextMenu: from the pen, with no pointerType, or with the pen near; not a finger or mouse far from the pen", () => {
		const d = new BarrelDetector();
		expect(d.blocksContextMenu("pen", 0)).toBe(true);
		expect(d.blocksContextMenu(undefined, 0)).toBe(true);
		expect(d.blocksContextMenu("", 0)).toBe(true);
		expect(d.blocksContextMenu("touch", 5000)).toBe(false);
		expect(d.blocksContextMenu("mouse", 5000)).toBe(false);
		d.pointer("move", "pen", -1, 0, 5000, 0, 1);
		expect(d.blocksContextMenu("touch", 5100)).toBe(true);
		expect(d.blocksContextMenu("touch", 6000)).toBe(false);
	});

	it("a pen contextmenu over the toolbar is cancelled and is a button signal (the menu, once)", async () => {
		const s = setup();
		s.fire(s.canvas, "pointermove", { timeStamp: 1000 });
		const e = s.fire(s.toolbar, "contextmenu", { button: 2, buttons: 0, timeStamp: 1100 });
		expect(e.defaultPrevented).toBe(true);
		await sleep(200); // a hover click waits for the before-window (no pen contact follows)
		// 0.11.2: no pointer is down, so it is a click of the button while hovering (the button is already up).
		expect(s.log).toEqual(["menu:click"]);
		expect(s.seen()).toBe(1);
	});

	it("a plain MouseEvent contextmenu (no pointerType) is cancelled too; one from a finger with the pen away is not", async () => {
		const s = setup();
		const plain = s.fire(s.toolbar, "contextmenu", { pointerType: undefined, button: 2, timeStamp: 1000 });
		expect(plain.defaultPrevented).toBe(true);
		const finger = s.fire(s.toolbar, "contextmenu", { pointerType: "touch", button: 2, timeStamp: 9000 });
		expect(finger.defaultPrevented).toBe(false);
		await sleep(200);
		// 0.11.2: the plain one, with no pointer down, is the side button clicked while hovering; the finger's is not.
		expect(s.log).toEqual(["menu:click"]);
	});

	it("a text field keeps its native menu, and events outside the view are left alone", () => {
		const s = setup();
		const field = Object.assign(new FakeNode("textarea", s.stage), { tagName: "TEXTAREA", closest: (sel: string) => (sel.includes("textarea") ? field : null) });
		s.fire(s.canvas, "pointermove", { timeStamp: 1000 });
		expect(s.fire(field, "contextmenu", { button: 2, timeStamp: 1100 }, false).defaultPrevented).toBe(false);
		expect(s.fire(s.modal, "contextmenu", { button: 2, timeStamp: 1200 }).defaultPrevented).toBe(false);
	});

	it("a pen contextmenu on the page (while a bare nib rests on it) is cancelled but not taken for the button", () => {
		const s = setup();
		s.fire(s.canvas, "pointermove", { timeStamp: 1000 });
		s.fire(s.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, timeStamp: 1016 });
		const e = s.fire(s.canvas, "contextmenu", { button: 2, buttons: 1, timeStamp: 1800 });
		expect(e.defaultPrevented).toBe(true);
		expect(s.log).toEqual(["start"]);
	});

	it("the pen's pointerdown on the page is cancelled even when it draws nothing (read-only); strokes are unchanged", () => {
		const ro = setup({}, false);
		const canvasEl = Object.assign(new FakeNode("c2", ro.stage), { tagName: "CANVAS" });
		expect(ro.fire(canvasEl, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, timeStamp: 1000 }).defaultPrevented).toBe(true);
		expect(ro.log).toEqual(["start"]); // asked, refused: no stroke
		const rw = setup();
		expect(rw.fire(rw.stage, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, timeStamp: 1000 }).defaultPrevented).toBe(true);
		expect(rw.log).toEqual(["start"]);
	});

	it("not for a control placed on the page (it keeps its own default handling)", () => {
		const s = setup({}, false);
		const control = Object.assign(new FakeNode("button", s.stage), { tagName: "BUTTON" });
		expect(s.fire(control, "pointerdown", { button: 0, buttons: 1, pressure: 0.5, timeStamp: 1000 }).defaultPrevented).toBe(false);
	});
});
