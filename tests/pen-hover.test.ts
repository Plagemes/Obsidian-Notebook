import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import {
	BUTTON_AFTER_MAX_MS, NIB_LONG_PRESS_MS, STILL_RADIUS_PX, TOUCH_RECENT_MS, clampWindows,
	ButtonTimeline, DEFAULT_BUTTON_WINDOWS, EraserNextArm, HoverClickTracker, LONG_PRESS_AFTER_MS, cleanWindowMs, contactVerdict, formatDelta, heldBeforeContact, STALE_POINTER_MS, capacitorInventory, capturedKey, cleanPenKey, formatCapacitorInventory,
	hotkeyConflicts, hoverClickAction, hoverMenuPosition, isPenKeyAction, isTextField, keyName, penKeyMatches, penKeyMayAct, type ContextMenuKind,
} from "../src/ink/pen-hover";
import { EventLog } from "../src/ink/pen-button";
import { PointerController, type MenuSource, type PointerHandlers } from "../src/ink/pointer-controller";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { installFakeWindow, removeFakeWindow } from "./node-env";

/** A bare contextmenu waits this long for a pen contact before it counts as a click while hovering (ms). */
const LINK_WAIT = DEFAULT_BUTTON_WINDOWS.beforeMs + 100;

// 0.11.2: the S Pen in Obsidian's Android app. Hover never reaches the WebView; a click of the side button while
// hovering leaves one bare `contextmenu` (no pointerType, button -1, buttons 0, from touch, no pointer in progress).

/** A recorded event: [type, pointerType, pointerId, buttons, t]. `contextmenu` rows are where the tracker is asked. */
type Rec = [string, string | undefined, number, number, number];
const KIND: Record<string, "down" | "move" | "up" | "cancel" | undefined> = { pointerdown: "down", pointermove: "move", pointerup: "up", pointercancel: "cancel" };

/** Feeds a recorded sequence and returns what each `contextmenu` was classified as. */
function classifyAll(seq: Rec[], textFocused = false): ContextMenuKind[] {
	const tr = new HoverClickTracker();
	const out: ContextMenuKind[] = [];
	for (const [type, pointerType, id, buttons, t] of seq) {
		const kind = KIND[type];
		if (kind) tr.pointer(kind, pointerType ?? "", id, t, buttons);
		else if (type === "contextmenu") out.push(tr.classify(pointerType, t, textFocused));
	}
	return out;
}

/** The device reading: the side button clicked while the pen hovers. Nothing but this. */
const DEVICE_HOVER_CLICK: Rec[] = [["contextmenu", undefined, 0, 0, 5000]];
/** A finger held on the page: the WebView's long-press `contextmenu` arrives while the finger is down. */
const FINGER_LONG_PRESS: Rec[] = [["pointerdown", "touch", 7, 1, 1000], ["contextmenu", undefined, 0, 0, 1520], ["pointerup", "touch", 7, 0, 1900]];
/** The same, from a WebView that reports it as a touch PointerEvent. */
const FINGER_LONG_PRESS_TYPED: Rec[] = [["pointerdown", "touch", 7, 1, 1000], ["contextmenu", "touch", 7, 0, 1520]];
/** A WebView that sends the long-press `contextmenu` on lift: just after a long contact. */
const FINGER_LONG_PRESS_ON_LIFT: Rec[] = [["pointerdown", "touch", 7, 1, 1000], ["pointerup", "touch", 7, 0, 1600], ["contextmenu", undefined, 0, 0, 1650]];

describe("HoverClickTracker: hover click or finger long-press (recorded sequences)", () => {
	it("the device's hover click: a bare contextmenu with nothing before it", () => {
		expect(classifyAll(DEVICE_HOVER_CLICK)).toEqual(["hover-click"]);
	});

	it("a finger long-press: while the finger is down, typed or not", () => {
		expect(classifyAll(FINGER_LONG_PRESS)).toEqual(["long-press"]);
		expect(classifyAll(FINGER_LONG_PRESS_TYPED)).toEqual(["long-press"]);
	});

	it("a finger long-press reported on lift: just after a long contact; a hover click later is a click again", () => {
		expect(classifyAll(FINGER_LONG_PRESS_ON_LIFT)).toEqual(["long-press"]);
		const later: Rec[] = [...FINGER_LONG_PRESS_ON_LIFT, ["contextmenu", undefined, 0, 0, 1600 + LONG_PRESS_AFTER_MS + 10]];
		expect(classifyAll(later)).toEqual(["long-press", "hover-click"]);
	});

	it("a short finger tap just before is no long-press: the click after it is the pen button", () => {
		const tap: Rec[] = [["pointerdown", "touch", 7, 1, 1000], ["pointerup", "touch", 7, 0, 1080], ["contextmenu", undefined, 0, 0, 1200]];
		expect(classifyAll(tap)).toEqual(["hover-click"]);
	});

	it("written, lifted, then clicked while hovering: a hover click; with the nib still down it is not", () => {
		const stroke: Rec[] = [
			["pointerdown", "pen", 3, 1, 1000], ["pointermove", "pen", 3, 1, 1016], ["pointermove", "pen", 3, 1, 1032],
			["contextmenu", "pen", 3, 1, 1040], ["pointerup", "pen", 3, 0, 1100], ["contextmenu", undefined, 0, 0, 2400],
		];
		expect(classifyAll(stroke)).toEqual(["pointer", "hover-click"]);
	});

	it("a pen whose up was swallowed (a menu) is healed by a move without the contact bit, or after a while", () => {
		const healed: Rec[] = [["pointerdown", "pen", 3, 1, 1000], ["pointermove", "pen", 3, 0, 1200], ["contextmenu", undefined, 0, 0, 1300]];
		expect(classifyAll(healed)).toEqual(["hover-click"]);
		const stale: Rec[] = [["pointerdown", "pen", 3, 1, 1000], ["contextmenu", undefined, 0, 0, 1000 + STALE_POINTER_MS + 1]];
		expect(classifyAll(stale)).toEqual(["hover-click"]);
	});

	it("a mouse right click (contextmenu on release, as on Windows) is the mouse's, typed or not", () => {
		const right: Rec[] = [["pointerdown", "mouse", 1, 2, 1000], ["pointerup", "mouse", 1, 0, 1090], ["contextmenu", undefined, 0, 0, 1095], ["contextmenu", "mouse", 1, 0, 1096]];
		expect(classifyAll(right)).toEqual(["mouse", "mouse"]);
	});

	it("a focused text field keeps its menu", () => {
		expect(classifyAll(DEVICE_HOVER_CLICK, true)).toEqual(["text"]);
	});

	it("the same event fed twice (window watch and element) changes nothing", () => {
		const twice: Rec[] = [
			["pointerdown", "touch", 7, 1, 1000], ["pointerdown", "touch", 7, 1, 1000], ["pointerup", "touch", 7, 0, 1600], ["pointerup", "touch", 7, 0, 1600],
			["contextmenu", undefined, 0, 0, 1650],
		];
		expect(classifyAll(twice)).toEqual(["long-press"]);
	});
});

describe("hoverMenuPosition", () => {
	const rect = { left: 100, top: 50, width: 800, height: 600 };
	it("the event's position inside the page area", () => {
		expect(hoverMenuPosition({ x: 300, y: 200 }, null, rect)).toEqual({ x: 200, y: 150 });
	});
	it("(0, 0) or outside: the last pen position, else the centre", () => {
		expect(hoverMenuPosition({ x: 0, y: 0 }, { x: 500, y: 400 }, rect)).toEqual({ x: 400, y: 350 });
		expect(hoverMenuPosition({ x: 20, y: 10 }, { x: 500, y: 400 }, rect)).toEqual({ x: 400, y: 350 });
		expect(hoverMenuPosition({ x: 0, y: 0 }, { x: 5, y: 5 }, rect)).toEqual({ x: 400, y: 300 });
		expect(hoverMenuPosition(null, null, rect)).toEqual({ x: 400, y: 300 });
	});
});

describe("EraserNextArm and the click action", () => {
	it("toggles, is used by one stroke, and reports every change", () => {
		const changes: boolean[] = [];
		const a = new EraserNextArm((on) => changes.push(on));
		expect(a.toggle()).toBe(true);
		expect(a.toggle()).toBe(false); // a second click disarms
		a.toggle();
		expect(a.consume()).toBe(true);
		expect(a.consume()).toBe(false); // the next stroke only
		a.toggle();
		a.disarm();
		a.disarm();
		expect(changes).toEqual([true, false, true, false, true, false]);
	});

	it("the setting wins over the menu; the button set to Nothing does nothing", () => {
		expect(hoverClickAction({ eraserNext: false, opensMenu: true, off: false })).toBe("menu");
		expect(hoverClickAction({ eraserNext: true, opensMenu: true, off: false })).toBe("eraser-next");
		expect(hoverClickAction({ eraserNext: false, opensMenu: false, off: false })).toBe("none");
		expect(hoverClickAction({ eraserNext: true, opensMenu: true, off: true })).toBe("none");
	});
});

describe("the pen key", () => {
	it("matches the saved key, never a repeat or a shortcut with Ctrl, Alt or Meta", () => {
		expect(penKeyMatches({ key: "F9", code: "F9" }, "F9")).toBe(true);
		expect(penKeyMatches({ key: "F9", repeat: true }, "F9")).toBe(false);
		expect(penKeyMatches({ key: "F9", ctrlKey: true }, "F9")).toBe(false);
		expect(penKeyMatches({ key: "F10" }, "F9")).toBe(false);
		expect(penKeyMatches({ key: "F9" }, "")).toBe(false);
		expect(penKeyMatches({ key: "K" }, "k")).toBe(true);
		expect(penKeyMatches({ key: "Unidentified", code: "BrightnessUp" }, "BrightnessUp")).toBe(true);
	});

	it("capture: the key (or the code when the key is unidentified); never a modifier alone, Escape, Tab or Enter", () => {
		expect(capturedKey({ key: "F13", code: "F13" })).toBe("F13");
		expect(capturedKey({ key: "Unidentified", code: "MediaPlayPause" })).toBe("MediaPlayPause");
		for (const key of ["Shift", "Control", "Alt", "Meta", "Escape", "Tab", "Enter"]) expect(capturedKey({ key })).toBeNull();
		expect(capturedKey({ key: "a", ctrlKey: true })).toBeNull();
		expect(keyName({ key: "x", code: "KeyX" })).toBe("x");
	});

	it("acts only in the active view, with no text field focused and no modal open", () => {
		expect(penKeyMayAct({ viewActive: true, textFocused: false, modalOpen: false })).toBe(true);
		expect(penKeyMayAct({ viewActive: false, textFocused: false, modalOpen: false })).toBe(false);
		expect(penKeyMayAct({ viewActive: true, textFocused: true, modalOpen: false })).toBe(false);
		expect(penKeyMayAct({ viewActive: true, textFocused: false, modalOpen: true })).toBe(false);
		expect(isTextField({ tagName: "textarea" })).toBe(true);
		expect(isTextField({ tagName: "DIV", isContentEditable: true })).toBe(true);
		expect(isTextField({ tagName: "BUTTON" })).toBe(false);
		expect(isTextField(null)).toBe(false);
	});

	it("hotkey conflicts: bindings without modifiers, custom keys over defaults; anything unexpected gives none", () => {
		const manager = {
			customKeys: { "app:toggle-left": [{ modifiers: [], key: "F9" }], "editor:x": [] },
			defaultKeys: { "app:toggle-left": [{ modifiers: ["Mod"], key: "F9" }], "editor:x": [{ modifiers: [], key: "F9" }], "app:other": [{ modifiers: [], key: "F9" }], "app:mod": [{ modifiers: ["Shift"], key: "F9" }] },
		};
		expect(hotkeyConflicts(manager, "F9")).toEqual(["app:toggle-left", "app:other"]);
		expect(hotkeyConflicts(manager, "F10")).toEqual([]);
		expect(hotkeyConflicts(undefined, "F9")).toEqual([]);
		expect(hotkeyConflicts({ customKeys: 5, defaultKeys: [1] }, "F9")).toEqual([]);
		expect(hotkeyConflicts(manager, "")).toEqual([]);
	});
});

describe("settings", () => {
	it("defaults: no change for existing users", () => {
		expect(DEFAULT_SETTINGS.penButtonEraserNext).toBe(false);
		expect(DEFAULT_SETTINGS.penButtonKey).toBe("");
		expect(DEFAULT_SETTINGS.penButtonKeyAction).toBe("eraser-next");
		expect(readSettings({})).toMatchObject({ penButtonEraserNext: false, penButtonKey: "", penButtonKeyAction: "eraser-next" });
	});

	it("loads valid values and ignores invalid ones", () => {
		expect(readSettings({ penButtonEraserNext: true, penButtonKey: "F10", penButtonKeyAction: "menu" })).toMatchObject({ penButtonEraserNext: true, penButtonKey: "F10", penButtonKeyAction: "menu" });
		expect(readSettings({ penButtonEraserNext: "yes", penButtonKey: 9, penButtonKeyAction: "erase" })).toMatchObject({ penButtonEraserNext: false, penButtonKey: "", penButtonKeyAction: "eraser-next" });
		expect(readSettings({ penButtonKey: "x".repeat(40) }).penButtonKey).toBe("");
		expect(readSettings({ penButtonKey: "a\nb" }).penButtonKey).toBe("");
		expect(cleanPenKey("")).toBe("");
		expect(isPenKeyAction("menu")).toBe(true);
	});
});

describe("the button or the eraser with the nib touching (InputPolicy)", () => {
	const base: InputSettings = { fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser" };
	it("buttons & 2 or button 2 with pressure: the button's tool (eraser); without pressure: the menu", () => {
		const p = new InputPolicy(base);
		expect(p.route("pen", 0, 0, 0, 3, 0.4)).toBe("draw");
		expect(p.route("pen", 0, 2, 0, 2, 0.4)).toBe("draw");
		expect(p.penErases(0, 3, 0.4)).toBe(true);
		expect(p.penErases(2, 2, 0.4)).toBe(true);
		expect(p.route("pen", 0, 2, 0, 2, 0)).toBe("menu");
		expect(p.penErases(2, 2, 0)).toBe(false);
	});
	it("buttons & 32 or button 5: always the eraser", () => {
		const p = new InputPolicy({ ...base, penButton: "off" });
		expect(p.penErases(0, 33, 0.5)).toBe(true);
		expect(p.penErases(5, 32, 0.5)).toBe(true);
		expect(p.route("pen", 0, 5, 0, 33, 0.5)).toBe("draw");
	});
	it("the radial-only action keeps the menu (it has no tool to hold)", () => {
		expect(new InputPolicy({ ...base, penButton: "radial" }).route("pen", 0, 0, 0, 3, 0.4)).toBe("menu");
	});
});

describe("Capacitor inventory (read only)", () => {
	it("absent", () => {
		expect(capacitorInventory({})).toEqual({ present: false });
		expect(formatCapacitorInventory({ present: false })).toBe("Capacitor: not present");
	});

	it("reads platform, headers, plugin keys and bridge-like globals, and never calls a plugin", () => {
		const calls: string[] = [];
		const plugin = new Proxy({}, { get: (_t, k) => (calls.push(String(k)), () => calls.push(`call:${String(k)}`)) });
		const win = {
			Capacitor: {
				getPlatform: () => "android",
				PluginHeaders: [{ name: "App", methods: [{ name: "exitApp", rtype: "promise" }] }, { name: "Haptics", methods: [] }],
				Plugins: { App: plugin, Haptics: plugin },
			},
			androidBridge: {},
			other: 1,
		};
		const o = capacitorInventory(win);
		expect(o).toMatchObject({ present: true, platform: "android", headers: { App: ["exitApp:promise"], Haptics: [] }, pluginKeys: ["App", "Haptics"] });
		expect(o.globals).toEqual(["Capacitor", "androidBridge"]);
		expect(calls).toEqual([]);
		expect(formatCapacitorInventory(o)).toContain("platform=android");
		expect(formatCapacitorInventory(o)).toContain("App[exitApp:promise]");
	});

	it("errors are reported, not thrown", () => {
		const win = { Capacitor: { get PluginHeaders(): unknown { throw new Error("no"); }, Plugins: null } };
		const o = capacitorInventory(win);
		expect(o.headersErr).toContain("no");
		expect(o.pluginKeys).toEqual([]);
	});
});

// --- PointerController: the hover click, eraser-next, the pen key, the button with the nib touching ---

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
	ownerDocument: { activeElement: unknown } | undefined = undefined;
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

function setup(settings: Partial<InputSettings> = {}) {
	const win = new EventTarget();
	const view = new FakeNode("view");
	const stage = new FakeStage("stage", view);
	const canvas = new FakeNode("canvas", stage);
	const log: string[] = [];
	const menus: Array<[number, number, MenuSource]> = [];
	const armed: boolean[] = [];
	const moves: number[] = [];
	const starts: number[] = [];
	/** The `continued` flag of each drawStart (the same contact goes on after its ink was committed). */
	const continued: boolean[] = [];
	/** What retractStroke answers (the view: the stroke's undo step is still the latest one). */
	const ctl = { retractOk: true };
	const handlers: PointerHandlers = {
		drawStart: (smp, eraser, held, cont) => (starts.push(Math.round(smp.x)), continued.push(cont === true), log.push(`start${eraser ? ":eraser" : held ? `:${held}` : ""}`), true),
		retractStroke: () => (log.push("retract"), ctl.retractOk),
		drawMove: (b) => moves.push(...Array.from({ length: b.count }, (_v, i) => Math.round(b.x[i]!))),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => {},
		zoom: () => {},
		penMenu: (x, y, source) => (menus.push([x, y, source]), log.push(`menu:${source}`)),
		eraserNextChanged: (on) => armed.push(on),
	};
	const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser", fingerLongPress: false, ...settings });
	const controller = new PointerController(stage as unknown as HTMLElement, policy, handlers, { scope: view as unknown as Node, windowTarget: win });
	const fire = (target: FakeNode, type: string, init: Record<string, unknown>): Event => {
		const e = new Event(type, { cancelable: true });
		const props = { pointerId: 1, pointerType: "pen", button: -1, buttons: 0, pressure: 0, clientX: 400, clientY: 300, timeStamp: 1000, ...init };
		for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
		Object.defineProperty(e, "target", { value: target });
		win.dispatchEvent(e);
		if (view.contains(target)) view.dispatchEvent(e);
		if (stage.contains(target)) stage.dispatchEvent(e);
		return e;
	};
	/** The device's hover click: no pointerType, button -1, buttons 0, position (0, 0). */
	/** The device's button signal: a contextmenu with an empty pointerType, button -1, buttons 0, not primary. */
	const bareMenu = (t: number, x = 0, y = 0) => fire(canvas, "contextmenu", { pointerType: "", pointerId: undefined, isPrimary: false, button: -1, buttons: 0, pressure: 0, clientX: x, clientY: y, timeStamp: t });
	/** A hover click: the bare contextmenu, and no pen contact within the before-window. */
	const hoverClick = (t: number, x = 0, y = 0) => {
		const e = bareMenu(t, x, y);
		vi.advanceTimersByTime(LINK_WAIT);
		return e;
	};
	const stroke = (t: number, init: Record<string, unknown> = {}) => {
		fire(canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, timeStamp: t, ...init });
		fire(canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: t + 100, clientX: init.clientX ?? 400, clientY: init.clientY ?? 300 });
	};
	return { stage, canvas, log, menus, armed, moves, starts, continued, ctl, controller, fire, bareMenu, hoverClick, stroke };
}

describe("PointerController: the side button clicked while hovering (bare contextmenu)", () => {
	beforeEach(() => {
		installFakeWindow();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		removeFakeWindow();
	});

	it("opens the radial menu, once, at the centre when nothing tells where the pen is", () => {
		const s = setup();
		const e = s.hoverClick(5000);
		expect(e.defaultPrevented).toBe(true);
		expect(s.log).toEqual(["menu:click"]);
		expect(s.menus).toEqual([[400, 300, "click"]]);
	});

	it("at the event's position when it has one, else where the pen last touched", () => {
		const s = setup();
		s.hoverClick(5000, 300, 200);
		s.stroke(8000, { clientX: 600, clientY: 500 });
		s.hoverClick(12000);
		expect(s.menus).toEqual([[200, 150, "click"], [500, 450, "click"]]);
	});

	it("a finger long-press keeps its behaviour: no menu from the contextmenu while the finger is down or just after a long contact", () => {
		const s = setup();
		s.fire(s.canvas, "pointerdown", { pointerType: "touch", pointerId: 7, button: 0, buttons: 1, timeStamp: 1000 });
		s.hoverClick(1520);
		s.fire(s.canvas, "pointerup", { pointerType: "touch", pointerId: 7, button: 0, buttons: 0, timeStamp: 1900 });
		s.hoverClick(2000);
		expect(s.log).toEqual([]);
		s.hoverClick(3000);
		expect(s.log).toEqual(["menu:click"]);
	});

	it("a focused text field keeps its menu", () => {
		const s = setup();
		s.stage.ownerDocument = { activeElement: { tagName: "TEXTAREA" } };
		const e = s.fire(s.canvas, "contextmenu", { pointerType: undefined, button: -1, timeStamp: 5000 });
		expect(s.log).toEqual([]);
		expect(e.defaultPrevented).toBe(true); // the page's own native menu is still cancelled, as before
	});

	it("a click already handled by its pointer events (Chrome: buttons & 2 while hovering) is not repeated", () => {
		const s = setup();
		s.fire(s.canvas, "pointermove", { buttons: 0, timeStamp: 1000 });
		s.fire(s.canvas, "pointermove", { buttons: 2, timeStamp: 1016 });
		s.hoverClick(1050);
		expect(s.log).toEqual(["menu:button"]);
	});

	it("with the side button set to Nothing, nothing opens", () => {
		const s = setup({ penButton: "off" });
		s.hoverClick(5000);
		expect(s.log).toEqual([]);
	});
});

describe("PointerController: Button click: next stroke erases", () => {
	beforeEach(() => {
		installFakeWindow();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		removeFakeWindow();
	});

	it("a hover click arms the eraser for the next pen stroke only, instead of the menu", () => {
		const s = setup({ eraserNextOnClick: true });
		s.hoverClick(5000);
		expect(s.log).toEqual([]);
		expect(s.controller.eraserNextArmed).toBe(true);
		s.stroke(6000);
		s.stroke(7000);
		expect(s.log).toEqual(["start:eraser", "end", "start", "end"]);
		expect(s.armed).toEqual([true, false]);
	});

	it("a second click disarms it; so does disarmEraserNext (tool change, Escape)", () => {
		const s = setup({ eraserNextOnClick: true });
		s.hoverClick(5000);
		s.hoverClick(8000);
		expect(s.controller.eraserNextArmed).toBe(false);
		s.hoverClick(11000);
		s.controller.disarmEraserNext();
		s.stroke(12000);
		expect(s.log).toEqual(["start", "end"]);
		expect(s.armed).toEqual([true, false, true, false]);
	});

	it("a finger does not use it up", () => {
		const s = setup({ eraserNextOnClick: true, fingerDrawing: true });
		s.hoverClick(5000);
		s.fire(s.canvas, "pointerdown", { pointerType: "touch", pointerId: 7, button: 0, buttons: 1, timeStamp: 9000 });
		s.fire(s.canvas, "pointerup", { pointerType: "touch", pointerId: 7, button: 0, buttons: 0, timeStamp: 9100 });
		expect(s.controller.eraserNextArmed).toBe(true);
	});
});

describe("PointerController: the pen key", () => {
	beforeEach(() => {
		installFakeWindow();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		removeFakeWindow();
	});

	it("menu: the radial menu at the last pen position (or the centre); eraser-next: toggles", () => {
		const s = setup();
		s.controller.penKey("menu");
		s.stroke(2000, { clientX: 300, clientY: 150 });
		s.controller.penKey("menu");
		expect(s.menus).toEqual([[400, 300, "click"], [200, 100, "click"]]);
		s.controller.penKey("eraser-next");
		expect(s.controller.eraserNextArmed).toBe(true);
		s.controller.penKey("eraser-next");
		expect(s.controller.eraserNextArmed).toBe(false);
	});

	it("the menu never opens in the middle of a stroke", () => {
		const s = setup();
		s.fire(s.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, timeStamp: 1000 });
		s.controller.penKey("menu");
		expect(s.menus).toEqual([]);
	});
});

describe("PointerController: the button or the eraser with the nib touching", () => {
	beforeEach(() => {
		installFakeWindow();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		removeFakeWindow();
	});

	it("pointerdown with buttons & 2 or button 2 (pressure above 0): a tap opens the menu, a drag erases from the first sample", () => {
		for (const [button, buttons] of [[0, 3], [2, 2], [2, 3]] as const) {
			const tap = setup();
			tap.fire(tap.canvas, "pointerdown", { button, buttons, pressure: 0.5, timeStamp: 1000 });
			tap.fire(tap.canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1090 });
			expect(tap.log, `tap: button ${button} buttons ${buttons}`).toEqual(["start", "cancel", "menu:click"]);
			const drag = setup();
			drag.fire(drag.canvas, "pointerdown", { button, buttons, pressure: 0.5, clientX: 400, timeStamp: 1000 });
			drag.fire(drag.canvas, "pointermove", { button: -1, buttons, pressure: 0.5, clientX: 440, timeStamp: 1050 });
			drag.fire(drag.canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1100 });
			expect(drag.log, `drag: button ${button} buttons ${buttons}`).toEqual(["start", "cancel", "start:eraser", "end"]);
			expect(drag.starts[1]).toBe(300); // the eraser starts where the nib landed
		}
	});

	it("pointerdown with the eraser bit (buttons & 32 or button 5): an eraser stroke at once", () => {
		for (const [button, buttons] of [[0, 33], [5, 32]] as const) {
			const s = setup();
			s.fire(s.canvas, "pointerdown", { button, buttons, pressure: 0.5, timeStamp: 1000 });
			expect(s.log, `button ${button} buttons ${buttons}`).toEqual(["start:eraser"]);
		}
	});

	it("the eraser end appearing during a written stroke: the ink is kept, the rest erases; the side button in the middle of a stroke does nothing", () => {
		for (const [button, buttons] of [[-1, 33], [5, 33]] as const) {
			const s = setup();
			s.fire(s.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, clientX: 400, timeStamp: 1000 });
			s.fire(s.canvas, "pointermove", { button: -1, buttons: 1, pressure: 0.6, clientX: 440, timeStamp: 1400 });
			s.fire(s.canvas, "pointermove", { button, buttons, pressure: 0.6, clientX: 460, timeStamp: 1500 });
			s.fire(s.canvas, "pointermove", { button: -1, buttons, pressure: 0.6, clientX: 480, timeStamp: 1516 });
			s.fire(s.canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1600 });
			expect(s.log, `button ${button} buttons ${buttons}`).toEqual(["start", "end", "start:eraser", "end"]);
		}
		for (const [button, buttons] of [[-1, 3], [2, 3]] as const) {
			const s = setup();
			s.fire(s.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, clientX: 400, timeStamp: 1000 });
			s.fire(s.canvas, "pointermove", { button: -1, buttons: 1, pressure: 0.6, clientX: 440, timeStamp: 1400 });
			s.fire(s.canvas, "pointermove", { button, buttons, pressure: 0.6, clientX: 460, timeStamp: 1500 });
			s.fire(s.canvas, "pointermove", { button: -1, buttons, pressure: 0.6, clientX: 480, timeStamp: 1516 });
			s.fire(s.canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1600 });
			expect(s.log, `mid-stroke button ${button} buttons ${buttons}`).toEqual(["start", "end"]);
		}
	});

	it("with the lasso as the button's tool, a contact with the button held at the landing is the lasso from the first sample", () => {
		const s = setup({ penButton: "lasso" });
		s.fire(s.canvas, "pointerdown", { button: 0, buttons: 3, pressure: 0.6, timeStamp: 1000 });
		s.fire(s.canvas, "pointermove", { button: -1, buttons: 3, pressure: 0.6, clientX: 440, timeStamp: 1400 });
		expect(s.log).toEqual(["start:lasso"]);
		// Pressed in the middle of an ordinary stroke: ink goes on.
		const m = setup({ penButton: "lasso" });
		m.fire(m.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, timeStamp: 1000 });
		m.fire(m.canvas, "pointermove", { button: -1, buttons: 1, pressure: 0.6, clientX: 440, timeStamp: 1400 });
		m.fire(m.canvas, "pointermove", { button: -1, buttons: 3, pressure: 0.6, clientX: 460, timeStamp: 1500 });
		expect(m.log).toEqual(["start"]);
	});

	it("an ordinary stroke (buttons 1 only) is never split", () => {
		const s = setup();
		s.fire(s.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, timeStamp: 1000 });
		for (let i = 1; i <= 20; i++) s.fire(s.canvas, "pointermove", { button: -1, buttons: 1, pressure: 0.6, clientX: 400 + i, timeStamp: 1000 + i * 16 });
		s.fire(s.canvas, "pointerup", { button: 0, buttons: 0, pressure: 0, timeStamp: 1400 });
		expect(s.log).toEqual(["start", "end"]);
	});
});

// --- device finding: the button seen only as a bare contextmenu at or during a pen contact ---

describe("ButtonTimeline and contactVerdict (Pen button test timing)", () => {
	it("contextmenu before the pen down, within the window: button held at contact", () => {
		const tl = new ButtonTimeline();
		expect(tl.contextMenu(1000)).toContain("button while hovering");
		expect(tl.penDown(1060, 10, 10)).toBe("pen down Δ=+60 ms after contextmenu: button held at contact");
		expect(tl.penMove(1076, 12, 10)).toBe("first pointermove Δ=+16 ms after pen down");
		expect(tl.penMove(1092, 14, 10)).toBeNull();
		expect(tl.verdict).toBe("held-at-contact");
	});

	it("contextmenu after the pen down: within the window held at contact, later during stroke; a resting nib is not the button", () => {
		const a = new ButtonTimeline();
		a.penDown(1000, 0, 0);
		expect(a.contextMenu(1042)).toBe("contextmenu Δ=+42 ms after pen down: button held at contact");
		const b = new ButtonTimeline();
		b.penDown(1000, 0, 0);
		b.penMove(1200, 40, 0);
		expect(b.contextMenu(1600)).toContain("button during stroke");
		const c = new ButtonTimeline();
		c.penDown(1000, 0, 0);
		c.penMove(1200, 2, 1);
		expect(c.contextMenu(1600)).toContain("not the button");
	});

	it("a contextmenu with no contact and no pen down soon after stays a hover click", () => {
		const tl = new ButtonTimeline({ beforeMs: 150, afterMs: 350 });
		tl.contextMenu(1000);
		expect(tl.penDown(1400, 0, 0)).toBeNull();
		expect(tl.verdict).toBe("hovering");
		const narrow = { beforeMs: 150, afterMs: 350 };
		expect(heldBeforeContact(1000, 1150, narrow)).toBe(true);
		expect(heldBeforeContact(1000, 1151, narrow)).toBe(false);
		expect(heldBeforeContact(1000, 990, narrow)).toBe(false);
		expect(heldBeforeContact(1000, 1500)).toBe(true); // the default before-window is 500 ms (0.12.4)
		expect(heldBeforeContact(1000, 1501)).toBe(false);
		expect(contactVerdict(350, false)).toBe("held-at-contact");
		expect(contactVerdict(351, false)).toBe("during-stroke");
		expect(contactVerdict(351, true)).toBe("none");
	});

	it("the Pen button test log notes the gaps and keeps the verdict", () => {
		const log = new EventLog();
		log.add({ kind: "contextmenu", pointerType: "", button: -1, buttons: 0, t: 1000 });
		log.add({ kind: "pointerdown", pointerType: "pen", pointerId: 3, button: 0, buttons: 1, pressure: 0.5, t: 1042, x: 0, y: 0 });
		log.add({ kind: "pointermove", pointerType: "pen", pointerId: 3, button: -1, buttons: 1, pressure: 0.5, t: 1058, x: 20, y: 0 });
		expect(log.text()).toContain("pen down Δ=+42 ms after contextmenu: button held at contact");
		expect(log.text()).toContain("first pointermove Δ=+16 ms after pen down");
		expect(log.verdict).toBe("button held at contact");
		log.add({ kind: "contextmenu", pointerType: "", button: -1, buttons: 0, t: 1700 });
		expect(log.verdict).toBe("button during stroke");
		log.add({ kind: "pointerup", pointerType: "pen", pointerId: 3, button: 0, buttons: 0, pressure: 0, t: 1800 });
		log.add({ kind: "contextmenu", pointerType: "", button: -1, buttons: 0, t: 5000 });
		expect(log.verdict).toBe("button while hovering");
		expect(formatDelta(-30)).toBe("-30 ms");
	});

	it("window settings: defaults 500 / 350 ms, validated, the after-window clamped to 400 ms on read", () => {
		expect(DEFAULT_BUTTON_WINDOWS).toEqual({ beforeMs: 500, afterMs: 350 });
		expect(BUTTON_AFTER_MAX_MS).toBe(400);
		expect(readSettings({})).toMatchObject({ penButtonContactBeforeMs: 500, penButtonContactAfterMs: 350 });
		// Saved by 0.5.x to 0.12.3 as the default of the time (150 ms): it is not a choice, it reads as the new default.
		expect(readSettings({ penButtonContactBeforeMs: 150 })).toMatchObject({ penButtonContactBeforeMs: 500 });
		expect(readSettings({ penButtonContactBeforeMs: 80, penButtonContactAfterMs: 300 })).toMatchObject({ penButtonContactBeforeMs: 80, penButtonContactAfterMs: 300 });
		// A value saved by 0.11.2 (range up to 1000 ms) reads as the new maximum.
		expect(readSettings({ penButtonContactAfterMs: 1000 })).toMatchObject({ penButtonContactAfterMs: 400 });
		expect(readSettings({ penButtonContactBeforeMs: -1, penButtonContactAfterMs: 5000 })).toMatchObject({ penButtonContactBeforeMs: 500, penButtonContactAfterMs: 400 });
		expect(cleanWindowMs(12.5, 500)).toBeNull();
		expect(cleanWindowMs(1000, 400)).toBe(400);
		expect(clampWindows({ beforeMs: 900, afterMs: 1000 })).toEqual({ beforeMs: 500, afterMs: 400 });
	});

	it("a nib resting still for 350 ms is a long-press, whatever the after-window; the still radius is above Android's slop", () => {
		expect(STILL_RADIUS_PX).toBeGreaterThanOrEqual(10);
		expect(NIB_LONG_PRESS_MS).toBe(350);
		expect(contactVerdict(349, true)).toBe("held-at-contact");
		expect(contactVerdict(350, true)).toBe("none");
		expect(contactVerdict(350, false)).toBe("held-at-contact");
		// An after-window saved larger than the cap is used as 400 ms.
		const wide = { beforeMs: 150, afterMs: 1000 };
		expect(contactVerdict(380, false, wide)).toBe("held-at-contact");
		expect(contactVerdict(450, false, wide)).toBe("during-stroke");
		expect(contactVerdict(600, true, wide)).toBe("none");
		// The Pen button test judges the same way: a nib drifting 8 px (Android's slop) still rests.
		const tl = new ButtonTimeline(wide);
		tl.penDown(1000, 0, 0);
		tl.penMove(1100, 8, 0);
		expect(tl.contextMenu(1450)).toContain("not the button");
	});
});

describe("PointerController: the button seen only as a contextmenu around a pen contact (recorded sequences)", () => {
	beforeEach(() => {
		installFakeWindow();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		removeFakeWindow();
	});

	const pen = (s: ReturnType<typeof setup>, type: string, t: number, x: number, extra: Record<string, unknown> = {}) =>
		s.fire(s.canvas, type, { pointerId: 3, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, pressure: type === "pointerup" ? 0 : 0.6, clientX: x, clientY: 300, timeStamp: t, ...extra });

	it("case 1, contextmenu BEFORE the pen down (button held, then touch): a drag erases the whole stroke, no menu", () => {
		const s = setup();
		const e = s.bareMenu(1000, 400, 300);
		expect(e.defaultPrevented).toBe(true);
		pen(s, "pointerdown", 1080, 400);
		pen(s, "pointermove", 1096, 440);
		pen(s, "pointerup", 1200, 440);
		vi.advanceTimersByTime(500);
		expect(s.log).toEqual(["start", "cancel", "start:eraser", "end"]);
		expect(s.starts).toEqual([300, 300]);
		expect(s.menus).toEqual([]);
		pen(s, "pointerdown", 3000, 400, { pointerId: 4 });
		expect(s.log[s.log.length - 1]).toBe("start"); // the tool is back for the next stroke
	});

	it("case 1, contextmenu AFTER the pen down: the live ink is dropped and the samples so far are replayed as the eraser", () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		pen(s, "pointermove", 1016, 410);
		pen(s, "pointermove", 1032, 420);
		const e = s.bareMenu(1042);
		expect(e.defaultPrevented).toBe(true);
		pen(s, "pointermove", 1048, 430);
		pen(s, "pointerup", 1100, 430);
		vi.advanceTimersByTime(500);
		expect(s.log).toEqual(["start", "cancel", "start:eraser", "end"]);
		expect(s.starts).toEqual([300, 300]); // the eraser starts where the nib landed
		expect(s.moves).toEqual([310, 320, 310, 320, 330]); // ink, then the same path replayed as the eraser, then on
		expect(s.menus).toEqual([]);
	});

	it("case 2, the button pressed mid-stroke: ink goes on, nothing switches", () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		for (let i = 1; i <= 10; i++) pen(s, "pointermove", 1000 + i * 50, 400 + i * 10);
		s.bareMenu(1520);
		pen(s, "pointermove", 1550, 510);
		pen(s, "pointerup", 1600, 510);
		expect(s.log).toEqual(["start", "end"]);
		expect(s.starts).toEqual([300]);
		pen(s, "pointerdown", 3000, 400, { pointerId: 4 });
		expect(s.log[s.log.length - 1]).toBe("start");
	});

	it("case 3, no contact and no pen down soon after: a hover click (the radial menu)", () => {
		const s = setup();
		s.bareMenu(1000, 300, 200);
		expect(s.menus).toEqual([]); // waits for the before-window
		vi.advanceTimersByTime(LINK_WAIT);
		expect(s.menus).toEqual([[200, 150, "click"]]);
	});

	it("a finger long-press never triggers the eraser (nor the menu); the next pen stroke is ink", () => {
		const s = setup();
		s.fire(s.canvas, "pointerdown", { pointerType: "touch", pointerId: 7, button: 0, buttons: 1, timeStamp: 1000 });
		s.bareMenu(1520);
		s.fire(s.canvas, "contextmenu", { pointerType: "touch", pointerId: 7, button: -1, buttons: 0, timeStamp: 1530 });
		s.fire(s.canvas, "pointerup", { pointerType: "touch", pointerId: 7, button: 0, buttons: 0, timeStamp: 1900 });
		vi.advanceTimersByTime(500);
		pen(s, "pointerdown", 1950, 400);
		pen(s, "pointerup", 2050, 400);
		expect(s.log).toEqual(["start", "end"]);
		expect(s.menus).toEqual([]);
	});

	it("a plain pen stroke without any contextmenu is unchanged", () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		for (let i = 1; i <= 30; i++) pen(s, "pointermove", 1000 + i * 16, 400 + i);
		pen(s, "pointerup", 1600, 430);
		vi.advanceTimersByTime(500);
		expect(s.log).toEqual(["start", "end"]);
		expect(s.moves).toHaveLength(30);
	});

	it("a nib resting still is a long-press, not the button; the side button set to Nothing ignores it", () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		s.bareMenu(1600);
		expect(s.log).toEqual(["start"]);
		const off = setup({ penButton: "off" });
		pen(off, "pointerdown", 1000, 400);
		off.bareMenu(1040);
		expect(off.log).toEqual(["start"]);
	});

	it("configurable windows: with a 0 ms after-window a contextmenu just after the landing is during the stroke: ink goes on", () => {
		const s = setup({ buttonWindows: { beforeMs: 150, afterMs: 0 } });
		pen(s, "pointerdown", 1000, 400);
		pen(s, "pointermove", 1016, 420);
		s.bareMenu(1040);
		expect(s.log).toEqual(["start"]);
	});

	// --- review fixes (wave 0.12) ---

	it("a button signal in the middle of a stroke (contextmenu, buttons & 2, chord) never switches it; held at contact, nothing is committed as ink", () => {
		// contextmenu while writing (case 2)
		const a = setup();
		pen(a, "pointerdown", 1000, 400);
		for (let i = 1; i <= 10; i++) pen(a, "pointermove", 1000 + i * 50, 400 + i * 10);
		a.bareMenu(1520);
		expect(a.log).toEqual(["start"]);
		// buttons & 2 appearing on a move
		const b = setup();
		b.fire(b.canvas, "pointerdown", { button: 0, buttons: 1, pressure: 0.6, clientX: 400, timeStamp: 1000 });
		b.fire(b.canvas, "pointermove", { button: -1, buttons: 1, pressure: 0.6, clientX: 440, timeStamp: 1400 });
		b.fire(b.canvas, "pointermove", { button: -1, buttons: 3, pressure: 0.6, clientX: 460, timeStamp: 1500 });
		expect(b.log).toEqual(["start"]);
		// the chord event (a move with button 0 instead of -1 while touching), late in the stroke
		const c = setup();
		for (const [type, button, buttons, pressure, t, x] of [
			["pointerdown", 0, 1, 0.9, 1064, 400], ["pointermove", -1, 1, 1, 1080, 430], ["pointermove", -1, 1, 1, 1620, 460], ["pointermove", 0, 1, 0.92, 1700, 470],
		] as const) c.fire(c.canvas, type, { button, buttons, pressure, timeStamp: t, clientX: x });
		expect(c.log).toEqual(["start"]);
		// the button held at contact: nothing was committed (the live ink is dropped), so nothing is spared
		const d = setup();
		pen(d, "pointerdown", 1000, 400);
		pen(d, "pointermove", 1016, 440);
		d.bareMenu(1042);
		expect(d.log).toEqual(["start", "cancel", "start:eraser"]);
		expect(d.continued).toEqual([false, false]);
	});

	it("a short flick with the button held, its contextmenu after the pen up: the stroke is retracted and replayed as the eraser", () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		pen(s, "pointermove", 1016, 410);
		pen(s, "pointermove", 1032, 420);
		pen(s, "pointerup", 1080, 420);
		const e = s.bareMenu(1200);
		expect(e.defaultPrevented).toBe(true);
		vi.advanceTimersByTime(500);
		// One retract (the view undoes the stroke's single step), then the same path as one eraser stroke.
		expect(s.log).toEqual(["start", "end", "retract", "start:eraser", "end"]);
		expect(s.starts).toEqual([300, 300]);
		expect(s.moves).toEqual([310, 320, 310, 320]);
		expect(s.menus).toEqual([]);
		pen(s, "pointerdown", 3000, 400, { pointerId: 4 });
		expect(s.log[s.log.length - 1]).toBe("start"); // the tool is back for the next stroke
	});

	it("a late contextmenu: no replay when the stroke cannot be retracted, a hover click once the after-window has passed", () => {
		const s = setup();
		s.ctl.retractOk = false;
		pen(s, "pointerdown", 1000, 400);
		pen(s, "pointermove", 1016, 440);
		pen(s, "pointerup", 1080, 440);
		s.bareMenu(1150);
		vi.advanceTimersByTime(500);
		expect(s.log).toEqual(["start", "end", "retract"]);
		expect(s.menus).toEqual([]);
		// A tap whose contextmenu comes after the lift: the dot is retracted and the menu opens (the tap with the button).
		const late = setup();
		pen(late, "pointerdown", 1000, 400);
		pen(late, "pointerup", 1080, 400);
		late.bareMenu(1400); // 320 ms after the lift
		vi.advanceTimersByTime(500);
		expect(late.log).toEqual(["start", "end", "retract", "menu:click"]);
		// A drag whose contextmenu comes after the after-window: it opens nothing and changes nothing (no menu after a drag).
		const old = setup();
		pen(old, "pointerdown", 1000, 400);
		pen(old, "pointermove", 1100, 440);
		pen(old, "pointerup", 1200, 440);
		old.bareMenu(1450);
		vi.advanceTimersByTime(1500);
		expect(old.log).toEqual(["start", "end"]);
		expect(old.menus).toEqual([]);
		// A contact that already was the eraser (contextmenu before it): a late one changes nothing and opens nothing.
		const held = setup();
		held.bareMenu(1000);
		pen(held, "pointerdown", 1080, 400);
		pen(held, "pointermove", 1096, 440);
		pen(held, "pointerup", 1200, 440);
		held.bareMenu(1300);
		vi.advanceTimersByTime(500);
		expect(held.log).toEqual(["start", "cancel", "start:eraser", "end"]);
		expect(held.menus).toEqual([]);
	});

	it("a nib long-press is not the button, even with an after-window saved above the cap and a drift up to Android's slop", () => {
		const s = setup({ buttonWindows: { beforeMs: 150, afterMs: 1000 } });
		pen(s, "pointerdown", 1000, 400);
		pen(s, "pointermove", 1100, 408);
		const e = s.bareMenu(1380);
		expect(e.defaultPrevented).toBe(true);
		pen(s, "pointerup", 1500, 408);
		vi.advanceTimersByTime(500);
		expect(s.log).toEqual(["start", "end"]);
		expect(s.menus).toEqual([]);
		// A nib that moved is still the button held at contact within the window.
		const m = setup();
		pen(m, "pointerdown", 1000, 400);
		pen(m, "pointermove", 1100, 440);
		m.bareMenu(1300);
		expect(m.log).toEqual(["start", "cancel", "start:eraser"]);
	});

	it("a palm or finger on the page while the pen writes: its contextmenu never turns the stroke into the eraser", () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		for (let i = 1; i <= 10; i++) pen(s, "pointermove", 1000 + i * 50, 400 + i * 10);
		s.fire(s.canvas, "pointerdown", { pointerType: "touch", pointerId: 7, button: 0, buttons: 1, clientX: 700, clientY: 500, timeStamp: 1200 });
		const e = s.bareMenu(1700);
		expect(e.defaultPrevented).toBe(true);
		s.fire(s.canvas, "pointerup", { pointerType: "touch", pointerId: 7, button: 0, buttons: 0, clientX: 700, clientY: 500, timeStamp: 1800 });
		pen(s, "pointermove", 1850, 520);
		pen(s, "pointerup", 1900, 520);
		vi.advanceTimersByTime(500);
		expect(s.log).toEqual(["start", "end"]);
		expect(s.menus).toEqual([]);
	});

	it(`a finger lifted less than ${TOUCH_RECENT_MS} ms before still explains it; later a mid-stroke press still never switches`, () => {
		const s = setup();
		pen(s, "pointerdown", 1000, 400);
		for (let i = 1; i <= 24; i++) pen(s, "pointermove", 1000 + i * 50, 400 + i * 5);
		s.fire(s.canvas, "pointerdown", { pointerType: "touch", pointerId: 7, button: 0, buttons: 1, clientX: 700, clientY: 500, timeStamp: 1100 });
		s.fire(s.canvas, "pointerup", { pointerType: "touch", pointerId: 7, button: 0, buttons: 0, clientX: 700, clientY: 500, timeStamp: 1300 });
		s.bareMenu(1600);
		expect(s.log).toEqual(["start"]);
		s.bareMenu(1950);
		expect(s.log).toEqual(["start"]);
		expect(s.menus).toEqual([]);
	});
});

describe("HoverClickTracker: the last pen contact and recent touches", () => {
	it("remembers the last pen contact once it lifted, within the after-window of its landing", () => {
		const h = new HoverClickTracker();
		h.pointer("down", "pen", 3, 1000);
		expect(h.liftedPenContact(1100, 350)).toBeNull(); // still down
		h.pointer("up", "pen", 3, 1080);
		expect(h.liftedPenContact(1200, 350)).toBe(1000);
		expect(h.liftedPenContact(1351, 350)).toBeNull();
		h.pointer("down", "pen", 4, 2000);
		h.pointer("move", "pen", 4, 2050, 0); // a move without the contact bit: lifted (up swallowed)
		expect(h.liftedPenContact(2100, 350)).toBe(2000);
	});

	it("a finger on the view, or lifted less than 600 ms before, is recent", () => {
		const h = new HoverClickTracker();
		expect(h.touchRecent(1000)).toBe(false);
		h.pointer("down", "touch", 7, 1000);
		expect(h.touchRecent(5000)).toBe(true);
		h.pointer("up", "touch", 7, 5100);
		expect(h.touchRecent(5100 + TOUCH_RECENT_MS - 1)).toBe(true);
		expect(h.touchRecent(5100 + TOUCH_RECENT_MS)).toBe(false);
	});
});
