import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REST_CLAIM_MS } from "../src/ink/button-contact";
import { DWELL_MS } from "../src/ink/gestures/trigger";
import { HOLD_MS } from "../src/ink/pen-button";
import { readSettings } from "../src/settings";
import { policySettings } from "../src/view/input-settings";
import { installFakeWindow, removeFakeWindow } from "./node-env";
import { calls, rig, type Rig } from "./pen-contact-rig";

const L = 1000;
const X0 = 400;

beforeEach(() => {
	installFakeWindow();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	removeFakeWindow();
});

/** Hold the nib still for `holdMs`, then draw a sign of 20 samples (120 px), then lift. Extra events via `mid`. */
function holdThenDraw(r: Rig, holdMs: number, mid?: (r: Rig) => void): void {
	r.pen("pointerdown", L, X0);
	for (let t = 40; t < holdMs; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0));
	mid?.(r);
	const d = L + holdMs;
	for (let i = 1; i <= 20; i++) r.pen("pointermove", d + i * 16, X0 + i * 6);
	r.pen("pointerup", d + 21 * 16, X0 + 126);
	r.at(L + holdMs + 3000);
}

describe("hold then draw (no side button) reaches the view as one contact", () => {
	it("plain still hold of 800 ms then a sign", () => {
		const r = rig({ settings: { penButton: "radial-eraser" } });
		holdThenDraw(r, 800);
		expect(calls(r)).toEqual(["start", "end"]);
	});

	for (const [name, type, pid] of [["empty pointerType", "", undefined], ["pen pointerType", "pen", 3]] as const) {
		for (const at of [380, 450, 520, 620]) {
			it(`long-press contextmenu (${name}) ${at} ms into the hold is ignored`, () => {
				const r = rig({ settings: { penButton: "radial-eraser" } });
				holdThenDraw(r, 800, (rr) => {
					rr.at(at);
					rr.fire("contextmenu", { pointerType: type, pointerId: pid, isPrimary: type === "pen", button: -1, buttons: 0, pressure: 0, clientX: X0, clientY: 300, timeStamp: 10_000 + at + L });
				});
				expect(calls(r)).toEqual(["start", "end"]);
				expect(r.menus).toEqual([]);
			});
		}
	}
});

describe("side button with the Gesture action", () => {
	for (const penButton of ["gesture", "radial-gesture"] as const) {
		for (const [name, extra] of [["buttons=3", { buttons: 3 }], ["button=2 buttons=2", { button: 2, buttons: 2 }]] as const) {
			it(`${penButton}: drag with the button (${name}) is a gesture contact`, () => {
				const r = rig({ settings: { penButton } });
				r.pen("pointerdown", L, X0, extra);
				for (let i = 1; i <= 20; i++) r.pen("pointermove", L + i * 16, X0 + i * 6, extra);
				r.pen("pointerup", L + 21 * 16, X0 + 126);
				r.at(L + 3000);
				expect(r.starts.map((s) => s.held)).toContain("gesture");
				expect(r.menus).toEqual([]);
			});
		}
	}
});

/** The gesture trigger (rest the nib, then draw) when a stray bare contextmenu just before the landing made the contact "button held". */
describe("a resting nib is a long-press, not the button, whatever signal came before", () => {
	for (const penButton of ["radial-eraser", "radial", "radial-gesture"] as const) {
		for (const before of [100, 300, 450]) {
			it(`${penButton}: contextmenu ${before} ms before the landing, nib rests 800 ms, then a sign: one ink contact`, () => {
				const r = rig({ settings: { penButton, penLongPress: false, restGesture: true } });
				r.bareMenu(L - before);
				holdThenDraw(r, 800);
				expect(calls(r)).toEqual(["start", "end"]);
				expect(r.starts).toHaveLength(1);
				expect(r.starts[0]!.eraser).toBe(false);
				expect(r.starts[0]!.held).toBeUndefined();
				expect(r.menus).toEqual([]);
			});
		}
	}
});

describe("other rest-based features keep working next to the side-button decision (non-regression guards: they pass on 0.12.3 and 0.12.4 too)", () => {
	it("guard: hold to open the radial menu with a stray contextmenu before the landing opens the menu once, with no ink", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: true } });
		r.bareMenu(L - 200);
		r.pen("pointerdown", L, X0);
		for (let t = 40; t <= 900; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0));
		r.pen("pointerup", L + 940, X0);
		r.at(L + 4000);
		expect(r.menus.map((m) => m[2])).toEqual(["pen-hold"]);
		expect(r.starts.every((s) => !s.eraser)).toBe(true);
		expect(calls(r)).not.toContain("end");
	});

	it("guard: hold to open the radial menu with no signal at all", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: true } });
		r.pen("pointerdown", L, X0);
		for (let t = 40; t <= 900; t += 40) r.pen("pointermove", L + t, X0);
		r.pen("pointerup", L + 940, X0);
		r.at(L + 4000);
		expect(r.menus.map((m) => m[2])).toEqual(["pen-hold"]);
		expect(calls(r)).toEqual(["start", "cancel", "menu:pen-hold"]);
	});

	it("a contextmenu right after the landing, then a long rest, then a sign: ink (the rest is spoken for)", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: false, restGesture: true } });
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 120);
		holdFrom(r, 800);
		expect(calls(r)).toEqual(["start", "end"]);
		expect(r.starts[0]!.eraser).toBe(false);
		expect(r.menus).toEqual([]);
	});

	it("the WebView cancels the contact after that contextmenu and it goes on: the rest still counts, the sign is not the eraser", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: false, restGesture: true } });
		r.pen("pointerdown", L, X0);
		r.bareMenu(L + 40);
		r.pen("pointercancel", L + 42, X0);
		r.pen("pointerdown", L + 70, X0, { pointerId: 4 });
		for (let t = 110; t < 800; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0), { pointerId: 4 });
		for (let i = 1; i <= 20; i++) r.pen("pointermove", L + 800 + i * 16, X0 + i * 6, { pointerId: 4 });
		r.pen("pointerup", L + 800 + 21 * 16, X0 + 126, { pointerId: 4 });
		r.at(L + 5000);
		expect(r.starts.some((s) => s.eraser)).toBe(false);
		expect(r.menus).toEqual([]);
	});

	it("the barrel bit on the landing is the button for sure: a long rest then a drag is still the eraser", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: false, restGesture: true } });
		r.pen("pointerdown", L, X0, { buttons: 3 });
		for (let t = 40; t < 800; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0), { buttons: 3 });
		for (let i = 1; i <= 20; i++) r.pen("pointermove", L + 800 + i * 16, X0 + i * 6, { buttons: 3 });
		r.pen("pointerup", L + 800 + 21 * 16, X0 + 126);
		r.at(L + 5000);
		expect(r.starts.some((s) => s.eraser)).toBe(true);
		expect(r.menus).toEqual([]);
	});

	it("without a rest feature a slow drag with a stray contextmenu is still the eraser (unchanged from 0.12.4)", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: false, restGesture: false } });
		r.bareMenu(L - 60);
		holdThenDraw(r, 800);
		expect(r.starts.some((s) => s.eraser)).toBe(true);
	});

	it("tap with the button, short: still the radial menu on the lift, no ink", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: false, restGesture: true } });
		r.bareMenu(L - 60);
		r.pen("pointerdown", L, X0);
		r.pen("pointerup", L + 90, X0);
		r.at(L + 3000);
		expect(r.menus.map((m) => m[2])).toEqual(["click"]);
		expect(calls(r)).not.toContain("end");
	});
});

/** Continues a contact that landed at (L, X0): jitter until `holdMs` after the landing, then a sign of 20 samples, then the lift. */
function holdFrom(r: Rig, holdMs: number): void {
	for (let t = 40; t < holdMs; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0));
	for (let i = 1; i <= 20; i++) r.pen("pointermove", L + holdMs + i * 16, X0 + i * 6);
	r.pen("pointerup", L + holdMs + 21 * 16, X0 + 126);
	r.at(L + holdMs + 3000);
}

describe("review fixes (0.12.5)", () => {
	const settings = { penButton: "radial-eraser" as const, penLongPress: false, restGesture: true };

	it("REST_CLAIM_MS is the dwell time of the long-press gesture and not longer than the hold-still menu", () => {
		expect(REST_CLAIM_MS).toBe(DWELL_MS);
		expect(REST_CLAIM_MS).toBeLessThanOrEqual(HOLD_MS);
	});

	it("a weak contact that rests, then is cancelled by the WebView, then lifts: no menu after a long-press (cancel applies the rest rule)", () => {
		const r = rig({ settings });
		r.bareMenu(L - 60);
		r.pen("pointerdown", L, X0);
		for (let t = 40; t <= 700; t += 40) r.pen("pointermove", L + t, X0);
		r.bareMenu(L + 720);
		r.pen("pointercancel", L + 722, X0);
		r.at(L + 4000);
		expect(r.menus).toEqual([]);
		expect(r.starts.some((s) => s.eraser)).toBe(false);
	});

	it("a tap with a contextmenu-only button held 400-640 ms with a rest feature on still opens the menu on the lift, no ink", () => {
		for (const hold of [400, 500, 640]) {
			const r = rig({ settings });
			r.bareMenu(L - 60);
			r.pen("pointerdown", L, X0);
			for (let t = 40; t < hold; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0));
			r.pen("pointerup", L + hold, X0);
			r.at(L + 4000);
			expect(r.menus.map((m) => m[2])).toEqual(["click"]);
			expect(calls(r)).not.toContain("end");
		}
	});

	it("a drag with the button after a 500 ms rest (before the rest was taken) is still the eraser", () => {
		const r = rig({ settings });
		r.bareMenu(L - 60);
		holdThenDraw(r, 500);
		expect(r.starts.some((s) => s.eraser)).toBe(true);
	});

	it("once the rest is taken, a later signal cannot turn the ink into the eraser (terminal state)", () => {
		const r = rig({ settings: { ...settings } });
		r.bareMenu(L - 60);
		r.pen("pointerdown", L, X0);
		for (let t = 40; t <= 700; t += 40) r.pen("pointermove", L + t, X0 + (t % 80 === 0 ? 1 : 0));
		for (let i = 1; i <= 8; i++) r.pen("pointermove", L + 700 + i * 16, X0 + i * 6);
		// The late signals of the old rules: a contextmenu inside a widened after-window, a barrel move, a post-lift contextmenu.
		r.pen("pointermove", L + 840, X0 + 60, { buttons: 3 });
		r.bareMenu(L + 850);
		r.pen("pointerup", L + 860, X0 + 70);
		r.bareMenu(L + 900);
		r.at(L + 4000);
		expect(r.starts.some((s) => s.eraser)).toBe(false);
		expect(r.menus).toEqual([]);
		expect(r.log).not.toContain("retract");
	});

	it("the rest is claimed only while a rest feature can start: no gesture armed (mode on, other tool) means a slow drag with the button erases", () => {
		const r = rig({ settings: { penButton: "radial-eraser", penLongPress: false }, restGestureArmed: () => false });
		r.bareMenu(L - 60);
		holdThenDraw(r, 800);
		expect(r.starts.some((s) => s.eraser)).toBe(true);
		const r2 = rig({ settings: { penButton: "radial-eraser", penLongPress: false }, restGestureArmed: () => true });
		r2.bareMenu(L - 60);
		holdThenDraw(r2, 800);
		expect(r2.starts.some((s) => s.eraser)).toBe(false);
	});

	it("using the side button never switches the long-press gesture off: a button tap first, then rest and draw, is ink for the gesture", () => {
		const saved = readSettings({ penGestureLongPress: true });
		const r = rig({ settings: policySettings(saved) });
		// A tap with the button: menu; the app notes that the button was seen (the automatic hold-still default goes off).
		r.bareMenu(L - 60);
		r.pen("pointerdown", L, X0);
		r.pen("pointerup", L + 90, X0);
		r.at(L + 1500);
		expect(r.menus).toHaveLength(1);
		expect(r.seen()).toBeGreaterThan(0);
		const after = policySettings(readSettings({ penGestureLongPress: true, penButtonSeen: true }));
		expect(after.restGesture).toBe(true);
		expect(after.penLongPress).toBe(false);
		expect(policySettings(readSettings({ penGestureLongPress: true })).penLongPress).toBe(false);
		// The long-press gesture is independent of penButtonSeen; and the rest of the next contact is ink for the dwell timer.
		const r2 = rig({ settings: { ...after, palmRejectionMs: 0, fingerDrawing: false } });
		holdThenDraw(r2, 800);
		expect(calls(r2)).toEqual(["start", "end"]);
		expect(r2.starts[0]!.eraser).toBe(false);
	});
});
