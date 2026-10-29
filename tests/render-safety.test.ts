import { describe, expect, it, vi } from "vitest";
import { ErrorOnce } from "../src/ink/errors";
import { createWetContext } from "../src/ink/renderer";
import { InputPolicy } from "../src/ink/input-policy";
import { PointerController, type PointerHandlers } from "../src/ink/pointer-controller";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";

describe("ErrorOnce", () => {
	it("logs each scope once and keeps going", () => {
		const log = vi.fn();
		const errors = new ErrorOnce("render", log);
		expect(errors.run("stroke", () => {
			throw new Error("bad stroke");
		})).toBe(false);
		expect(errors.run("stroke", () => {
			throw new Error("bad stroke again");
		})).toBe(false);
		expect(errors.run("paper", () => undefined)).toBe(true);
		expect(errors.report("paper", new Error("x"))).toBe(true);
		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls[0]![0]).toBe("[notebook] render stroke");
	});
});

describe("low-latency ink setting", () => {
	it("is off by default and read as a boolean", () => {
		expect(DEFAULT_SETTINGS.lowLatencyInk).toBe(false);
		expect(readSettings({}).lowLatencyInk).toBe(false);
		expect(readSettings({ lowLatencyInk: true }).lowLatencyInk).toBe(true);
		expect(readSettings({ lowLatencyInk: "yes" }).lowLatencyInk).toBe(false);
	});
});

describe("createWetContext", () => {
	const fakeCanvas = (granted: boolean | "throw" | "null") => {
		const calls: unknown[] = [];
		const ctx = { getContextAttributes: () => ({ desynchronized: granted === true }) };
		const canvas = {
			getContext: (_type: string, attrs?: unknown) => {
				calls.push(attrs);
				if (attrs && granted === "throw") throw new Error("unsupported");
				if (attrs && granted === "null") return null;
				return ctx;
			},
		} as unknown as HTMLCanvasElement;
		return { canvas, calls, ctx };
	};

	it("asks for a regular context when low latency is off", () => {
		const { canvas, calls } = fakeCanvas(true);
		expect(createWetContext(canvas, false).desynchronized).toBe(false);
		expect(calls).toEqual([undefined]);
	});

	it("reports what the browser granted", () => {
		expect(createWetContext(fakeCanvas(true).canvas, true)).toMatchObject({ desynchronized: true });
		const notGranted = createWetContext(fakeCanvas(false).canvas, true);
		expect(notGranted.ctx).not.toBeNull();
		expect(notGranted.desynchronized).toBe(false);
	});

	it("returns no context (the caller makes a regular canvas) when the low-latency one fails", () => {
		expect(createWetContext(fakeCanvas("throw").canvas, true)).toEqual({ ctx: null, desynchronized: false });
		expect(createWetContext(fakeCanvas("null").canvas, true)).toEqual({ ctx: null, desynchronized: false });
	});
});

/** Element stub with just what PointerController uses. */
function fakeElement() {
	const listeners = new Map<string, Array<(e: unknown) => void>>();
	return {
		listeners,
		addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
		removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 1200 }),
		setPointerCapture: () => undefined,
		releasePointerCapture: () => undefined,
		hasPointerCapture: () => false,
		fire(type: string, init: Record<string, unknown>) {
			const e = { type, pointerId: 1, pointerType: "pen", button: 0, buttons: 1, pressure: 0.5, width: 1, height: 1, clientX: 10, clientY: 10, timeStamp: 0, preventDefault: () => undefined, stopPropagation: () => undefined, ...init };
			for (const fn of listeners.get(type) ?? []) fn(e);
		},
	};
}

describe("PointerController guards", () => {
	it("keeps working after a handler throws", () => {
		const el = fakeElement();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const events: string[] = [];
		let failMove = true;
		const handlers: PointerHandlers = {
			drawStart: () => (events.push("start"), true),
			drawMove: () => {
				events.push("move");
				if (failMove) throw new Error("bad sample");
			},
			drawEnd: () => events.push("end"),
			pan: () => undefined,
			zoom: () => undefined,
		};
		const c = new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500, palmContactPx: 0 }), handlers);
		expect(c.rawUpdates).toBe(false);
		el.fire("pointerdown", { timeStamp: 1 });
		el.fire("pointermove", { timeStamp: 2, clientX: 20 });
		el.fire("pointermove", { timeStamp: 3, clientX: 30 });
		el.fire("pointerup", { timeStamp: 4, buttons: 0 });
		expect(c.drawing).toBe(false);
		failMove = false;
		el.fire("pointerdown", { pointerId: 2, timeStamp: 5 });
		el.fire("pointermove", { pointerId: 2, timeStamp: 6, clientX: 40 });
		el.fire("pointerup", { pointerId: 2, timeStamp: 7, buttons: 0 });
		expect(events).toEqual(["start", "move", "move", "end", "start", "move", "end"]);
		// Logged once, not once per event.
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]![0]).toBe("[notebook] input pointermove");
		log.mockRestore();
		c.destroy();
	});

	it("does not listen to pointerrawupdate unless asked", () => {
		const el = fakeElement();
		const handlers = { drawStart: () => true, drawMove: () => undefined, drawEnd: () => undefined, pan: () => undefined, zoom: () => undefined };
		const c = new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500, palmContactPx: 0 }), handlers);
		expect(el.listeners.get("pointerrawupdate") ?? []).toHaveLength(0);
		c.destroy();
	});
});
