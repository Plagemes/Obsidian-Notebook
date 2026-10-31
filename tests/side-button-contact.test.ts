import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ButtonContact, LATE_AFTER_LIFT_MS, RESUME_MS, barrelAtContact, describeDecision, describeSignal } from "../src/ink/button-contact";
import type { InputSettings } from "../src/ink/input-policy";
import { EventLog } from "../src/ink/pen-button";
import { DEFAULT_BUTTON_WINDOWS } from "../src/ink/pen-hover";
import { readSettings } from "../src/settings";

const LINK_BEFORE_MS = DEFAULT_BUTTON_WINDOWS.beforeMs;
import { installFakeWindow, removeFakeWindow } from "./node-env";
import { calls, committedInk, pageX, rig, type Rig } from "./pen-contact-rig";

// 0.12.4: the S Pen side button in Obsidian for Android, as the device shows it. Pressing the button with the pen in the
// air sends nothing the page can see. With the button already held, the nib touches, and the button shows only as a
// trace around that contact. The behaviour is two cases, whatever the form of the trace:
//   1. touch and lift without moving (a tap, within 12 px): the radial menu;
//   2. touch and move: the eraser for the whole contact, from its first sample, with no ink.
// A button pressed in the middle of an ordinary stroke keeps writing ink; no menu opens during or after a drag.

const L = 1000; // the landing, ms after T0
const X0 = 400; // client x of the landing

type Gesture = "tap" | "drag";
type Act = [number, () => void];

/** The signal forms: each schedules the events of one contact (landing at L) for a tap or a drag. */
interface Form {
	name: string;
	build(r: Rig, g: Gesture, acts: Act[]): void;
	/** The contextmenu comes after the pen up (the stroke is retracted before it is replayed). */
	late?: boolean;
	/** A pointercancel follows the contextmenu. */
	cancels?: boolean;
}

/** Samples of a drag: 20 samples 16 ms apart, 6 px each (120 px, far beyond the 12 px still radius). */
const dragSamples = (r: Rig, acts: Act[], extra: Record<string, unknown> = {}, id = 3, from = 1, to = 20): void => {
	for (let i = from; i <= to; i++) acts.push([L + i * 16, () => r.pen("pointermove", L + i * 16, X0 + i * 6, { pointerId: id, ...extra })]);
};
const down = (r: Rig, acts: Act[], extra: Record<string, unknown> = {}, id = 3): void => void acts.push([L, () => r.pen("pointerdown", L, X0, { pointerId: id, ...extra })]);
const up = (r: Rig, acts: Act[], t: number, x: number, id = 3): void => void acts.push([t, () => r.pen("pointerup", t, x, { pointerId: id })]);
const menuAt = (r: Rig, acts: Act[], t: number): void => void acts.push([t, () => r.bareMenu(t)]);

/** A contact that lasts `ms` for a tap (a few still jitters of 1 px), 20 samples for a drag. */
function contact(r: Rig, g: Gesture, acts: Act[], tapMs = 90, extra: Record<string, unknown> = {}): void {
	if (g === "tap") {
		for (const t of [30, 60]) if (t < tapMs) acts.push([L + t, () => r.pen("pointermove", L + t, X0 + (t % 2), extra)]);
		up(r, acts, L + tapMs, X0);
	} else {
		dragSamples(r, acts, extra);
		up(r, acts, L + 21 * 16, X0 + 126);
	}
}

const forms: Form[] = [
	...[-60, -150, -300, -450].map((d): Form => ({
		name: `bare contextmenu ${Math.abs(d)} ms BEFORE the pen down`,
		build: (r, g, a) => {
			menuAt(r, a, L + d);
			down(r, a);
			contact(r, g, a);
		},
	})),
	...[20, 40, 150, 300].map((d): Form => ({
		name: `bare contextmenu ${d} ms AFTER the pen down`,
		build: (r, g, a) => {
			down(r, a);
			menuAt(r, a, L + d);
			contact(r, g, a, d + 30);
		},
	})),
	...[20, 150].map((d): Form => ({
		name: `bare contextmenu ${d} ms after the pen UP`,
		late: true,
		build: (r, g, a) => {
			down(r, a);
			if (g === "tap") {
				up(r, a, L + 90, X0);
				menuAt(r, a, L + 90 + d);
			} else {
				dragSamples(r, a, {}, 3, 1, 5);
				up(r, a, L + 100, X0 + 30);
				menuAt(r, a, L + 100 + d);
			}
		},
	})),
	{ name: "pointerdown with buttons=3 (button 0)", build: (r, g, a) => (down(r, a, { buttons: 3 }), contact(r, g, a, 90, { buttons: 3 })) },
	{ name: "pointerdown with button=2, buttons=3", build: (r, g, a) => (down(r, a, { button: 2, buttons: 3 }), contact(r, g, a, 90, { buttons: 3 })) },
	{ name: "pointerdown with button=2, buttons=2", build: (r, g, a) => (down(r, a, { button: 2, buttons: 2 }), contact(r, g, a, 90, { buttons: 2 })) },
	{
		name: "pointermove with buttons=3 right after a plain pen down",
		build: (r, g, a) => {
			down(r, a);
			a.push([L + 30, () => r.pen("pointermove", L + 30, X0 + 1, { buttons: 3 })]);
			contact(r, g, a, 90, { buttons: 3 });
		},
	},
	{
		name: "pointermove with button=0 (the chord event) 60 ms after the landing",
		build: (r, g, a) => {
			down(r, a);
			a.push([L + 30, () => r.pen("pointermove", L + 30, X0 + 1, { button: -1, pressure: 0.9 })]);
			a.push([L + 60, () => r.pen("pointermove", L + 60, X0 + 1, { button: 0, pressure: 0.92 })]);
			contact(r, g, a, 90);
		},
	},
	{
		name: "pointercancel right after the contextmenu, the contact goes on as a new pointer",
		cancels: true,
		build: (r, g, a) => {
			down(r, a);
			menuAt(r, a, L + 40);
			a.push([L + 42, () => r.pen("pointercancel", L + 42, X0 + 2)]);
			if (g === "drag") {
				a.push([L + 70, () => r.pen("pointerdown", L + 70, X0 + 12, { pointerId: 4 })]);
				for (let i = 5; i <= 20; i++) a.push([L + i * 16, () => r.pen("pointermove", L + i * 16, X0 + 12 + (i - 4) * 6, { pointerId: 4 })]);
				up(r, a, L + 21 * 16, X0 + 90, 4);
			}
		},
	},
];

/** Runs a form, then lets every timer fall due. */
function run(r: Rig, form: Form, g: Gesture): void {
	const acts: Act[] = [];
	form.build(r, g, acts);
	acts.sort((x, y) => x[0] - y[0]);
	for (const [, fn] of acts) fn();
	r.at(L + 3000);
}

const inkLeft = (r: Rig): number => committedInk(r) - r.log.filter((l) => l === "retract").length;
const eraserStarts = (r: Rig) => r.starts.filter((s) => s.eraser);

beforeEach(() => {
	installFakeWindow();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	removeFakeWindow();
});

describe.each([
	["Radial menu on click, erase while held (radial-eraser)", "radial-eraser"],
	["Radial menu on click (radial)", "radial"],
] as const)("side button set to %s: tap opens the menu, drag erases", (_name, penButton) => {
	const settings: Partial<InputSettings> = { penButton };

	describe.each(forms)("$name", (form) => {
		it("tap (lifts without moving): the radial menu where the nib landed, no ink, no eraser", () => {
			const r = rig({ settings });
			run(r, form, "tap");
			expect(r.menus).toHaveLength(1);
			expect(r.menus[0]![2]).toBe("click");
			// Where it landed (page coordinates), give or take the 1 px jitter.
			expect(Math.abs(r.menus[0]![0] - pageX(X0))).toBeLessThanOrEqual(3);
			expect(inkLeft(r)).toBe(0);
			expect(eraserStarts(r)).toHaveLength(0);
			expect(r.seen()).toBeGreaterThan(0);
		});

		it("drag (moves beyond 12 px): the eraser for the whole contact from its first sample, no ink, no menu", () => {
			const r = rig({ settings });
			run(r, form, "drag");
			expect(r.menus).toEqual([]);
			expect(inkLeft(r)).toBe(0);
			const erasers = eraserStarts(r);
			expect(erasers.length).toBeGreaterThanOrEqual(1);
			// From the first sample: the eraser starts where the nib landed.
			expect(erasers[0]!.x).toBe(pageX(X0));
			if (!form.late && !form.cancels) expect(erasers).toHaveLength(1);
			// One stroke of the tool, ended (not cancelled) once at the end.
			expect(calls(r)[calls(r).length - 1]).toBe("end");
			expect(r.log.filter((l) => l === "retract")).toHaveLength(form.late ? 1 : 0);
		});
	});

	it("no button at all: tap and drag are ordinary ink", () => {
		for (const g of ["tap", "drag"] as const) {
			const r = rig({ settings });
			const acts: Act[] = [];
			down(r, acts);
			contact(r, g, acts);
			acts.sort((x, y) => x[0] - y[0]);
			for (const [, fn] of acts) fn();
			r.at(L + 3000);
			expect(calls(r)).toEqual(["start", "end"]);
			expect(r.menus).toEqual([]);
		}
	});

	it("a button signal in the middle of an ordinary stroke keeps writing ink (contextmenu, buttons & 2, chord)", () => {
		const signals: Array<[string, (r: Rig) => void]> = [
			["contextmenu", (r) => r.bareMenu(L + 700)],
			["buttons & 2", (r) => r.pen("pointermove", L + 700, X0 + 6 * 40, { buttons: 3 })],
			["chord", (r) => r.pen("pointermove", L + 700, X0 + 6 * 40, { button: 0, pressure: 0.9 })],
		];
		for (const [, signal] of signals) {
			const r = rig({ settings });
			r.pen("pointerdown", L, X0);
			for (let i = 1; i <= 60; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
			r.at(L + 696);
			signal(r);
			for (let i = 44; i <= 60; i++) r.pen("pointermove", L + i * 16 + 1000, X0 + i * 6 + 100);
			r.pen("pointerup", L + 2200, X0 + 500);
			r.at(L + 5000);
			expect(calls(r)).toEqual(["start", "end"]);
			expect(r.menus).toEqual([]);
			expect(eraserStarts(r)).toHaveLength(0);
		}
	});

	it("a contextmenu long after a drag lifted never opens the menu (nothing is retracted either)", () => {
		const r = rig({ settings });
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 40; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
		r.pen("pointerup", L + 41 * 16, X0 + 246);
		r.bareMenu(L + 41 * 16 + 120);
		r.at(L + 5000);
		expect(calls(r)).toEqual(["start", "end"]);
		expect(r.menus).toEqual([]);
	});

	it("a nib resting on the page for a long-press time is not the button: its contextmenu changes nothing", () => {
		const r = rig({ settings });
		r.pen("pointerdown", L, X0);
		r.pen("pointermove", L + 100, X0 + 2);
		r.bareMenu(L + 480);
		r.pen("pointerup", L + 600, X0 + 2);
		r.at(L + 4000);
		expect(calls(r)).toEqual(["start", "end"]);
		expect(r.menus).toEqual([]);
	});

	it("the tool is back to ink for the next stroke after a button contact", () => {
		for (const g of ["tap", "drag"] as const) {
			const r = rig({ settings });
			run(r, forms[2]!, g);
			r.pen("pointerdown", 9000, X0, { pointerId: 8 });
			r.pen("pointerup", 9100, X0, { pointerId: 8 });
			expect(calls(r).slice(-2)).toEqual(["start", "end"]);
		}
	});
});

describe("side button set to Erase while held (no menu in the setting)", () => {
	const settings: Partial<InputSettings> = { penButton: "eraser" };

	it.each(forms)("$name: tap and drag are the eraser, never the menu", (form) => {
		for (const g of ["tap", "drag"] as const) {
			const r = rig({ settings });
			run(r, form, g);
			expect(r.menus).toEqual([]);
			expect(inkLeft(r)).toBe(0);
			expect(eraserStarts(r).length).toBeGreaterThanOrEqual(1);
		}
	});
});

describe("side button set to Lasso while held", () => {
	it("a drag with the button is the lasso from the first sample; a tap opens nothing", () => {
		const r = rig({ settings: { penButton: "lasso" } });
		run(r, forms[0]!, "drag");
		expect(r.starts[0]!.held).toBe("lasso");
		expect(r.menus).toEqual([]);
		expect(inkLeft(r)).toBe(0);
	});
});

describe("side button set to Nothing", () => {
	it.each(forms)("$name: ink, no menu, no eraser, whatever the signal", (form) => {
		for (const g of ["tap", "drag"] as const) {
			const r = rig({ settings: { penButton: "off" } });
			run(r, form, g);
			expect(r.menus).toEqual([]);
			expect(eraserStarts(r)).toHaveLength(0);
			if (!form.cancels) expect(r.log.filter((l) => l === "retract")).toHaveLength(0);
		}
	});
});

describe("the button clicked with no pen contact at all (a bare contextmenu)", () => {
	it("opens the menu only after the link window, so a contact that follows within it is never a hover click", () => {
		const r = rig();
		r.bareMenu(L);
		r.at(L + LINK_BEFORE_MS - 20);
		expect(r.menus).toEqual([]);
		r.at(L + LINK_BEFORE_MS + 50);
		expect(r.menus).toHaveLength(1);
	});

	it("a pen contact that lands within the link window: no hover menu, no eraser-next arming, the contact decides", () => {
		const r = rig({ settings: { eraserNextOnClick: true } });
		r.bareMenu(L);
		r.pen("pointerdown", L + 400, X0);
		r.pen("pointerup", L + 480, X0);
		r.at(L + 4000);
		expect(r.menus).toHaveLength(1); // the tap's menu, once
		expect(r.menus[0]![2]).toBe("click");
		expect(r.controller.eraserNextArmed).toBe(false);
	});
});

describe("two button contacts in a row (the button pressed again within 1.5 s)", () => {
	it.each([
		["bare contextmenu before the pen down", (r: Rig, t: number) => (r.bareMenu(t), r.pen("pointerdown", t + 60, X0))],
		["bare contextmenu after the pen down", (r: Rig, t: number) => (r.pen("pointerdown", t, X0), r.bareMenu(t + 40))],
	])("%s: a tap, then a drag, both decided", (_name, land) => {
		const r = rig();
		land(r, L);
		r.pen("pointerup", L + 200, X0);
		land(r, L + 900);
		for (let i = 1; i <= 20; i++) r.pen("pointermove", L + 900 + 60 + i * 16, X0 + i * 6);
		r.pen("pointerup", L + 1400, X0 + 120);
		r.at(L + 4000);
		expect(r.menus).toHaveLength(1);
		expect(eraserStarts(r)).toHaveLength(1);
		expect(inkLeft(r)).toBe(0);
	});
});

describe("pointercancel: the contact goes on, or settles", () => {
	const cancelled = (settings: Partial<InputSettings> = {}) => {
		const r = rig({ settings });
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 40);
		r.pen("pointercancel", L + 42, X0 + 1);
		return r;
	};

	it("a new pen pointerdown within the window continues the contact (a drag: the eraser from the first sample)", () => {
		const r = cancelled();
		r.pen("pointerdown", L + 42 + RESUME_MS - 50, X0 + 10, { pointerId: 5 });
		r.pen("pointermove", L + 400, X0 + 80, { pointerId: 5 });
		r.pen("pointerup", L + 450, X0 + 90, { pointerId: 5 });
		r.at(L + 4000);
		expect(eraserStarts(r)).toHaveLength(1);
		expect(eraserStarts(r)[0]!.x).toBe(pageX(X0));
		expect(inkLeft(r)).toBe(0);
		expect(r.menus).toEqual([]);
	});

	it("later pen events of the same pointer (no new pointerdown) continue it too", () => {
		const r = cancelled();
		r.pen("pointermove", L + 80, X0 + 10);
		r.pen("pointermove", L + 100, X0 + 70);
		r.pen("pointerup", L + 120, X0 + 70);
		r.at(L + 4000);
		expect(eraserStarts(r)).toHaveLength(1);
		expect(eraserStarts(r)[0]!.x).toBe(pageX(X0));
		expect(r.menus).toEqual([]);
		expect(inkLeft(r)).toBe(0);
	});

	it("nothing continues a contact that never moved: a tap, the menu, once", () => {
		const r = cancelled();
		r.at(L + 2000);
		expect(r.menus).toHaveLength(1);
		expect(inkLeft(r)).toBe(0);
	});

	it("a contact that was already the eraser goes on as the eraser (its erasure so far stays)", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 5; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
		r.bareMenu(L + 100);
		r.pen("pointercancel", L + 102, X0 + 30);
		r.pen("pointerdown", L + 130, X0 + 36, { pointerId: 6 });
		r.pen("pointermove", L + 150, X0 + 60, { pointerId: 6 });
		r.pen("pointerup", L + 170, X0 + 60, { pointerId: 6 });
		r.at(L + 4000);
		expect(calls(r)).toEqual(["start", "cancel", "start:eraser", "end", "start:eraser", "end"]);
		expect(r.menus).toEqual([]);
	});

	it("a pen landing after the window is a new ordinary stroke", () => {
		const r = cancelled();
		r.pen("pointerdown", L + 42 + RESUME_MS + 400, X0 + 200, { pointerId: 7 });
		r.pen("pointerup", L + 1000, X0 + 200, { pointerId: 7 });
		r.at(L + 4000);
		expect(inkLeft(r)).toBe(1);
	});
});

describe("hold still with the button, then lift: a tap too (the nib is not a long-press until 350 ms)", () => {
	it("a tap of 300 ms with the contextmenu at 60 ms opens the menu on the lift", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 60);
		r.pen("pointermove", L + 150, X0 + 3);
		r.pen("pointerup", L + 300, X0 + 3);
		r.at(L + 3000);
		expect(calls(r)).toEqual(["start", "cancel", "menu:click"]);
	});

	it("no menu appears before the lift (and none after a drag)", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 60);
		r.at(L + 900);
		expect(r.menus).toEqual([]);
	});
});

describe("the before-window", () => {
	it("is 500 ms by default; the old default of 150 ms (saved by every earlier version) reads as the new one", () => {
		expect(readSettings({}).penButtonContactBeforeMs).toBe(500);
		expect(readSettings({ penButtonContactBeforeMs: 150 }).penButtonContactBeforeMs).toBe(500);
		expect(readSettings({ penButtonContactBeforeMs: 200 }).penButtonContactBeforeMs).toBe(200);
	});

	it("is the window the user sets: with 100 ms a contact 300 ms after a bare contextmenu is no longer linked to it", () => {
		const r = rig({ settings: { buttonWindows: { beforeMs: 100, afterMs: 350 } } });
		r.bareMenu(L);
		r.pen("pointerdown", L + 300, X0);
		r.pen("pointerup", L + 400, X0);
		r.at(L + 3000);
		// The hover click fired at 100 ms; the contact is ordinary ink.
		expect(r.menus).toHaveLength(1);
		expect(committedInk(r)).toBe(1);
	});
});

describe("ButtonContact (the decision, and what the Pen button test shows)", () => {
	const mk = () => new ButtonContact();

	it("tap: waits, then the menu on the lift; the diagnostic says what it saw and decided", () => {
		const b = mk();
		b.contextMenuNoContact(940);
		expect(b.penDown(1000, 10, 10, null)).toBe("pending");
		expect(describeSignal(b.signal!)).toBe("contextmenu Δ=-60 ms");
		expect(b.penMove(12, 11)).toBe(false);
		expect(b.penUp(1090)).toBe("menu");
		expect(describeDecision(b.decision!)).toBe("menu (tap)");
	});

	it("drag: the eraser as soon as the nib leaves the 12 px radius", () => {
		const b = mk();
		expect(b.penDown(1000, 10, 10, 3)).toBe("pending");
		expect(describeSignal(b.signal!)).toBe("pointerdown buttons=3");
		expect(b.penMove(20, 10)).toBe(false);
		expect(b.penMove(23, 10)).toBe(true);
		expect(describeDecision(b.decision!)).toBe("eraser (drag)");
		expect(b.penUp(1200)).toBe("none");
	});

	it("ignored decisions name their reason", () => {
		const b = mk();
		b.penDown(1000, 0, 0, null);
		expect(b.contextMenuDuring(1500)).toBe("ignore");
		expect(describeDecision(b.decision!)).toBe("ignored: nib resting (a long-press, not the button)");
		const m = mk();
		m.penDown(1000, 0, 0, null);
		m.penMove(50, 0);
		expect(m.contextMenuDuring(1600)).toBe("ignore");
		expect(describeDecision(m.decision!)).toBe("ignored: pressed in the middle of a stroke");
		const off = mk();
		off.enabled = false;
		off.penDown(1000, 0, 0, 3);
		expect(describeDecision(off.decision!)).toBe("ignored: side button set to Nothing");
	});

	it("pointercancel after a contextmenu is named in the diagnostic", () => {
		const b = mk();
		b.penDown(1000, 0, 0, null);
		b.contextMenuDuring(1040);
		expect(b.penCancel(1042)).toBe("orphan");
		b.penDown(1070, 15, 0, null);
		expect(describeSignal(b.signal!)).toBe("pointercancel after contextmenu");
		expect(b.state).toBe("eraser");
	});

	it("a late contextmenu is linked only to a contact that just lifted", () => {
		const b = mk();
		b.penDown(1000, 0, 0, null);
		b.penUp(1090);
		expect(b.contextMenuAfter(1090 + LATE_AFTER_LIFT_MS + 10)).toBe("unlinked");
		expect(b.contextMenuAfter(1200)).toBe("menu-late");
	});

	it("barrelAtContact: the barrel bit with the nib touching only", () => {
		expect(barrelAtContact(0, 3, 0.5)).toBe(true);
		expect(barrelAtContact(2, 1, 0.5)).toBe(true);
		expect(barrelAtContact(0, 3, 0)).toBe(false); // pressed while hovering
		expect(barrelAtContact(5, 33, 0.5)).toBe(false); // the eraser end
		expect(barrelAtContact(0, 1, 0.5)).toBe(false);
	});

	it("EventLog (Pen button test) reports the signal and the decision for a recorded contact", () => {
		const log = new EventLog();
		const ev = (kind: string, t: number, x: number, over: Record<string, unknown> = {}) =>
			log.add({ kind, t, pointerType: "pen", pointerId: 3, button: kind === "pointerdown" ? 0 : -1, buttons: kind === "pointerup" ? 0 : 1, pressure: kind === "pointerup" ? 0 : 0.6, x, y: 300, ...over });
		ev("pointerdown", 1000, 400);
		log.add({ kind: "contextmenu", t: 1040, pointerType: "", button: -1, buttons: 0 });
		expect(log.signalText).toBe("contextmenu Δ=+40 ms");
		expect(log.decisionText).toBe("waiting (tap: menu, drag: eraser)");
		ev("pointerup", 1090, 401);
		expect(log.decisionText).toBe("menu (tap)");
		ev("pointerdown", 2000, 400);
		ev("pointermove", 2020, 430);
		log.add({ kind: "contextmenu", t: 2900, pointerType: "", button: -1, buttons: 0 });
		expect(log.decisionText).toBe("ignored: pressed in the middle of a stroke");
	});
});

// --- review fixes (0.12.4) ---

describe("two signals from one contact: the second never reaches the next contact", () => {
	const ctxBefore = (r: Rig) => (r.bareMenu(L - 60), r.pen("pointerdown", L, X0));
	const ctxAfter = (r: Rig) => (r.pen("pointerdown", L, X0), r.bareMenu(L + 40));
	const plainDrag = (r: Rig, t: number) => {
		r.pen("pointerdown", t, X0, { pointerId: 9 });
		for (let i = 1; i <= 20; i++) r.pen("pointermove", t + i * 16, X0 + i * 6, { pointerId: 9 });
		r.pen("pointerup", t + 340, X0 + 126, { pointerId: 9 });
	};

	it.each([["before", ctxBefore], ["after", ctxAfter]] as const)("a tap (contextmenu %s the landing), a stray contextmenu 20 ms after the lift, then a plain drag: the drag is ink", (_n, land) => {
		const r = rig();
		land(r);
		r.pen("pointerup", L + 90, X0);
		expect(r.menus).toHaveLength(1);
		r.bareMenu(L + 110);
		plainDrag(r, L + 400);
		r.at(L + 4000);
		expect(r.menus).toHaveLength(1);
		expect(eraserStarts(r)).toHaveLength(0);
		expect(inkLeft(r)).toBe(1);
	});

	it("a decided eraser drag, a stray contextmenu 20 ms after its lift, then a plain drag: the drag is ink", () => {
		const r = rig();
		r.bareMenu(L - 60);
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 20; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
		r.pen("pointerup", L + 340, X0 + 126);
		r.bareMenu(L + 360);
		plainDrag(r, L + 700);
		r.at(L + 4000);
		expect(eraserStarts(r)).toHaveLength(1);
		expect(inkLeft(r)).toBe(1);
		expect(r.menus).toEqual([]);
	});

	it("a cancelled contact that settled as a tap, then a stray contextmenu: also nothing for the next contact", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 40);
		r.pen("pointercancel", L + 42, X0);
		r.at(L + 325); // the orphan settled: the menu
		r.bareMenu(L + 340);
		plainDrag(r, L + 800);
		r.at(L + 4000);
		expect(r.menus).toHaveLength(1);
		expect(eraserStarts(r)).toHaveLength(0);
		expect(inkLeft(r)).toBe(1);
	});

	it("when the stroke cannot be retracted the menu still opens for a late tap", () => {
		const r = rig({ retractOk: false });
		r.pen("pointerdown", L, X0);
		r.pen("pointerup", L + 90, X0);
		r.bareMenu(L + 200);
		r.at(L + 3000);
		expect(r.menus).toHaveLength(1);
		expect(r.log).toContain("retract");
	});
});

describe("a slow move that leaves the radius late still erases from the first sample", () => {
	it("button held at the landing, the nib rests 600 ms, then moves: the eraser starts where it landed", () => {
		const r = rig();
		r.bareMenu(L - 60);
		r.pen("pointerdown", L, X0);
		r.pen("pointermove", L + 300, X0 + 2);
		r.pen("pointermove", L + 620, X0 + 30);
		r.pen("pointerup", L + 700, X0 + 40);
		r.at(L + 3000);
		expect(eraserStarts(r)).toHaveLength(1);
		expect(eraserStarts(r)[0]!.x).toBe(pageX(X0));
		expect(inkLeft(r)).toBe(0);
	});
});

describe("a pointercancel followed by a pointerdown far away is a new contact", () => {
	it("an eraser contact: the new landing 400 px away is ink, no eraser segment is drawn between", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 5; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
		r.bareMenu(L + 100);
		r.pen("pointercancel", L + 102, X0 + 30);
		r.pen("pointerdown", L + 140, X0 + 400, { pointerId: 6 });
		r.pen("pointermove", L + 160, X0 + 410, { pointerId: 6 });
		r.pen("pointerup", L + 180, X0 + 410, { pointerId: 6 });
		r.at(L + 4000);
		expect(eraserStarts(r)).toHaveLength(1);
		expect(eraserStarts(r)[0]!.x).toBe(pageX(X0));
		expect(inkLeft(r)).toBe(1);
	});

	it("a still (waiting) contact: the far landing is ink, and the dropped contact opens no menu", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 40);
		r.pen("pointercancel", L + 42, X0 + 1);
		r.pen("pointerdown", L + 100, X0 + 400, { pointerId: 6 });
		r.pen("pointermove", L + 120, X0 + 440, { pointerId: 6 });
		r.pen("pointerup", L + 200, X0 + 440, { pointerId: 6 });
		r.at(L + 4000);
		expect(eraserStarts(r)).toHaveLength(0);
		expect(r.menus).toEqual([]);
		expect(inkLeft(r)).toBe(1);
	});

	it("a landing close to where the contact was cancelled still continues it", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 5; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
		r.bareMenu(L + 100);
		r.pen("pointercancel", L + 102, X0 + 30);
		r.pen("pointerdown", L + 140, X0 + 45, { pointerId: 6 });
		r.pen("pointerup", L + 180, X0 + 60, { pointerId: 6 });
		r.at(L + 4000);
		expect(inkLeft(r)).toBe(0);
		expect(r.menus).toEqual([]);
	});
});

describe("no menu after a drag, however late its contextmenu comes", () => {
	const longDrag = (r: Rig) => {
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 40; i++) r.pen("pointermove", L + i * 16, X0 + i * 6);
		r.pen("pointerup", L + 650, X0 + 240);
	};

	it("a contextmenu 450 ms after a 650 ms drag lifted opens nothing (neither at once nor later)", () => {
		const r = rig();
		longDrag(r);
		r.bareMenu(L + 650 + 450);
		r.at(L + 6000);
		expect(r.menus).toEqual([]);
		expect(calls(r)).toEqual(["start", "end"]);
	});

	it("but a button contact that lands right after it is still linked to it (tap: menu)", () => {
		const r = rig();
		longDrag(r);
		r.bareMenu(L + 650 + 450);
		r.pen("pointerdown", L + 650 + 520, X0);
		r.pen("pointerup", L + 650 + 600, X0);
		r.at(L + 6000);
		expect(r.menus).toHaveLength(1);
	});

	it("an ordinary click while hovering long after a stroke still opens the menu (other devices)", () => {
		const r = rig();
		longDrag(r);
		r.bareMenu(L + 650 + 2000);
		r.at(L + 8000);
		expect(r.menus).toHaveLength(1);
	});
});

describe("a pen-typed contextmenu is a hover click, not the button of the last contact (Windows)", () => {
	it("after a quick dash it retracts nothing and keeps the ink", () => {
		const r = rig();
		r.pen("pointerdown", L, X0);
		for (let i = 1; i <= 5; i++) r.pen("pointermove", L + i * 16, X0 + i * 8);
		r.pen("pointerup", L + 100, X0 + 40);
		r.at(L + 200);
		r.fire("contextmenu", { pointerType: "pen", button: 2, buttons: 0, clientX: X0 + 40, clientY: 300, timeStamp: 10_000 + L + 200 });
		r.at(L + 3000);
		expect(r.log).not.toContain("retract");
		expect(inkLeft(r)).toBe(1);
		expect(eraserStarts(r)).toHaveLength(0);
	});
});

describe("the 150 ms to 500 ms migration of the before-window runs once", () => {
	it("a file saved before 0.12.4 reads 150 as 500 and is marked; afterwards 150 is the user's choice", () => {
		const first = readSettings({ penButtonContactBeforeMs: 150 });
		expect(first.penButtonContactBeforeMs).toBe(500);
		expect(first.penButtonWindowsMigrated).toBe(true);
		const later = readSettings({ penButtonContactBeforeMs: 150, penButtonWindowsMigrated: true });
		expect(later.penButtonContactBeforeMs).toBe(150);
		expect(readSettings({}).penButtonContactBeforeMs).toBe(500);
	});
});
