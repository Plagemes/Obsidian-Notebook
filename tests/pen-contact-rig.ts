import { vi } from "vitest";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import { PointerController, type MenuSource, type PointerHandlers } from "../src/ink/pointer-controller";

// A rig that replays recorded pen sequences, with realistic timestamps, against the real PointerController under fake
// timers, and says what the contact did: ink, eraser, menu. Used by the side-button contact tests (0.12.4).

export class FakeNode extends EventTarget {
	constructor(readonly name: string, readonly parent: FakeNode | null = null) {
		super();
	}
	contains(n: unknown): boolean {
		for (let p = n as FakeNode | null; p; p = p.parent) if (p === this) return true;
		return false;
	}
}

export class FakeStage extends FakeNode {
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

export interface RigOptions {
	settings?: Partial<InputSettings>;
	retractOk?: boolean;
}

/** Page x of a client x in the rig (the stage sits at left 100). */
export const pageX = (clientX: number): number => clientX - 100;

/** Time zero of every sequence: realistic `timeStamp`s are large. */
export const T0 = 10_000;

export function rig(opts: RigOptions = {}) {
	const win = new EventTarget();
	const view = new FakeNode("view");
	const stage = new FakeStage("stage", view);
	const canvas = new FakeNode("canvas", stage);
	const log: string[] = [];
	const menus: Array<[number, number, MenuSource]> = [];
	const starts: Array<{ x: number; eraser: boolean; held?: string; continued: boolean }> = [];
	const ctl = { retractOk: opts.retractOk ?? true };
	let seen = 0;
	const handlers: PointerHandlers = {
		drawStart: (s, eraser, held, cont) => (starts.push({ x: Math.round(s.x), eraser, held, continued: cont === true }), log.push(`start${eraser ? ":eraser" : held ? `:${held}` : ""}`), true),
		retractStroke: () => (log.push("retract"), ctl.retractOk),
		drawMove: () => void log.push("move"),
		drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
		pan: () => {},
		zoom: () => {},
		penMenu: (x, y, source) => (menus.push([x, y, source]), log.push(`menu:${source}`)),
		sideButtonSeen: () => void seen++,
	};
	const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 0, penButton: "radial-eraser", fingerLongPress: false, ...opts.settings });
	const controller = new PointerController(stage as unknown as HTMLElement, policy, handlers, { scope: view as unknown as Node, windowTarget: win });
	let now = 0;
	/** Advances the fake clock to `t` ms after `T0` (timers that fall due run on the way). */
	const at = (t: number): void => {
		if (t > now) vi.advanceTimersByTime(t - now);
		now = Math.max(now, t);
	};
	const fire = (type: string, init: Record<string, unknown>, target: FakeNode = canvas): Event => {
		const e = new Event(type, { cancelable: true });
		const props = { pointerId: 3, pointerType: "pen", button: -1, buttons: 0, pressure: 0, clientX: 400, clientY: 300, timeStamp: T0, ...init };
		for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
		Object.defineProperty(e, "target", { value: target });
		win.dispatchEvent(e);
		if (view.contains(target)) view.dispatchEvent(e);
		if (stage.contains(target)) stage.dispatchEvent(e);
		return e;
	};
	/** A pen event at `t` ms after T0 (advancing the clock first). */
	const pen = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", t: number, x: number, extra: Record<string, unknown> = {}): Event => {
		at(t);
		const contact = type === "pointerdown" || type === "pointermove";
		return fire(type, { button: type === "pointerdown" ? 0 : -1, buttons: contact ? 1 : 0, pressure: contact ? 0.6 : 0, clientX: x, timeStamp: T0 + t, ...extra });
	};
	/** The device's button signal: a contextmenu with an empty pointerType, button -1, buttons 0, not primary. */
	const bareMenu = (t: number, x = 0, y = 0): Event => {
		at(t);
		return fire("contextmenu", { pointerType: "", pointerId: undefined, isPrimary: false, button: -1, buttons: 0, pressure: 0, clientX: x, clientY: y, timeStamp: T0 + t });
	};
	return { stage, canvas, log, menus, starts, ctl, controller, fire, pen, bareMenu, at, seen: () => seen };
}
export type Rig = ReturnType<typeof rig>;

/** Handler calls without the `move`s. */
export const calls = (r: Rig): string[] => r.log.filter((l) => l !== "move");

/** How many ink strokes were committed (a plain `start` that was not cancelled). */
export function committedInk(r: Rig): number {
	const l = calls(r);
	let n = 0;
	for (let i = 0; i < l.length; i++) if (l[i] === "start" && l[i + 1] !== "cancel") n++;
	return n;
}
