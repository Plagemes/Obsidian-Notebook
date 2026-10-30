import { describe, expect, it } from "vitest";
import { AutoScroller, autoScrollDistance, easeOutCubic, type AutoScrollClock } from "../src/ink/auto-scroll";
import { FingerTapDetector, tapActionFor } from "../src/ink/finger-taps";
import { DEFAULT_GESTURE_SETTINGS, readGestureSettings } from "../src/ink/gesture-settings";
import { InputPolicy, type InputSettings } from "../src/ink/input-policy";
import { LastTool } from "../src/ink/last-tool";
import { PointerController, type PointerHandlers } from "../src/ink/pointer-controller";
import { detectScribble, resamplePath, scribbleEraseCommand, scribbleEraseSteps, scribbleVictims } from "../src/ink/scribble";
import { createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import type { NotebookDocument, Point, Stroke } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { GestureInput } from "../src/view/gesture-input";
import { createDocument } from "../src/model/document";

// --- a fake stage and pointer events ---

class FakeEl extends EventTarget {
	captured = new Set<number>();
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 800, height: 1000, right: 800, bottom: 1000, x: 0, y: 0, toJSON() {} } as DOMRect;
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
	const props = { pointerId: 1, pointerType: "touch", button: 0, buttons: 0, pressure: 0.5, width: 1, height: 1, clientX: 400, clientY: 500, timeStamp: 1000, ...init };
	for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
	el.dispatchEvent(e);
	return e;
}

// --- finger taps ---

describe("tap gestures: mapping", () => {
	it("two fingers undo, three redo; swapped and off", () => {
		expect(tapActionFor(2, "undo-redo")).toBe("undo");
		expect(tapActionFor(3, "undo-redo")).toBe("redo");
		expect(tapActionFor(2, "redo-undo")).toBe("redo");
		expect(tapActionFor(3, "redo-undo")).toBe("undo");
		expect(tapActionFor(2, "off")).toBeNull();
		expect(tapActionFor(1, "undo-redo")).toBeNull();
		expect(tapActionFor(4, "undo-redo")).toBeNull();
	});
});

describe("FingerTapDetector", () => {
	/** Two or three fingers landing, optionally moving, and lifting. */
	function run(det: FingerTapDetector, fingers: Array<{ down: number; up: number; move?: number }>): number {
		let result = 0;
		const events: Array<{ t: number; fn: () => void }> = [];
		fingers.forEach((f, i) => {
			events.push({ t: f.down, fn: () => void det.down(i + 1, 100 * (i + 1), 300, f.down) });
			if (f.move) events.push({ t: (f.down + f.up) / 2, fn: () => det.move(i + 1, 100 * (i + 1) + f.move!, 300) });
			events.push({ t: f.up, fn: () => { result = det.up(i + 1, f.up) || result; } });
		});
		events.sort((a, b) => a.t - b.t);
		for (const e of events) e.fn();
		return result;
	}

	it("recognises a two-finger and a three-finger tap", () => {
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1100 }, { down: 1020, up: 1110 }])).toBe(2);
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1120 }, { down: 1030, up: 1130 }, { down: 1060, up: 1140 }])).toBe(3);
	});

	it("allows a few pixels of movement but not a pan or a pinch", () => {
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1100, move: 8 }, { down: 1020, up: 1110, move: -8 }])).toBe(2);
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1100, move: 40 }, { down: 1020, up: 1110, move: 40 }])).toBe(0);
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1100, move: 40 }, { down: 1020, up: 1110, move: -40 }])).toBe(0);
	});

	it("a slow contact is not a tap, however still", () => {
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1800 }, { down: 1020, up: 1810 }])).toBe(0);
	});

	it("fingers that land far apart in time, or lift far apart, are not a tap", () => {
		// The first finger is gone before the second lands: two single-finger touches.
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1200 }, { down: 1300, up: 1310 }])).not.toBe(2);
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1050 }, { down: 1010, up: 1300 }])).toBe(0);
	});

	it("a finger added after another lifted is not a tap", () => {
		const det = new FingerTapDetector();
		det.down(1, 100, 300, 1000);
		det.down(2, 200, 300, 1010);
		expect(det.up(1, 1050)).toBe(0);
		det.down(3, 300, 300, 1060);
		expect(det.up(2, 1090)).toBe(0);
		expect(det.up(3, 1100)).toBe(0);
	});

	it("a single finger tap and a cancelled contact are nothing", () => {
		expect(run(new FingerTapDetector(), [{ down: 1000, up: 1080 }])).toBe(1);
		const det = new FingerTapDetector();
		det.down(1, 100, 300, 1000);
		det.down(2, 200, 300, 1010);
		det.up(1, 1050, true);
		expect(det.up(2, 1060)).toBe(0);
	});

	it("an interruption (the pen) cancels the series; the next series starts clean", () => {
		const det = new FingerTapDetector();
		det.down(1, 100, 300, 1000);
		det.down(2, 200, 300, 1010);
		det.interrupt();
		det.up(1, 1050);
		expect(det.up(2, 1060)).toBe(0);
		expect(det.landed).toBe(0);
		expect(run(det, [{ down: 2000, up: 2100 }, { down: 2010, up: 2110 }])).toBe(2);
	});

	it("a contact that never ended does not block later taps", () => {
		const det = new FingerTapDetector();
		det.down(1, 100, 300, 1000); // never lifted
		det.down(5, 100, 300, 9000);
		det.down(6, 200, 300, 9010);
		det.up(5, 9100);
		expect(det.up(6, 9110)).toBe(2);
	});
});

describe("GestureInput: taps on the stage", () => {
	const settings = (over: Partial<InputSettings> = {}): InputSettings => ({ fingerDrawing: false, palmRejectionMs: 500, ...over });

	function setup(mode: "off" | "undo-redo" | "redo-undo" = "undo-redo", input: InputSettings = settings()) {
		const el = new FakeEl();
		const policy = new InputPolicy(input);
		const log: string[] = [];
		let viewOffset = 0;
		const input2 = new GestureInput(el as unknown as HTMLElement, {
			policy,
			tapMode: () => mode,
			act: (a) => log.push(a),
			snapshotView: () => {
				const saved = viewOffset;
				return () => {
					viewOffset = saved;
					log.push("restore");
				};
			},
			drawing: () => false,
			autoScroll: { enabled: () => false, viewHeight: () => 1000, offsetY: () => 0, panBy: () => undefined },
		});
		return { el, policy, log, input: input2, nudge: () => (viewOffset = 99) };
	}

	const tap = (el: FakeEl, ids: number[], t0 = 1000, move = 0) => {
		ids.forEach((id, i) => fire(el, "pointerdown", { pointerId: id, clientX: 100 * (i + 1), clientY: 300, timeStamp: t0 + i * 15 }));
		if (move) ids.forEach((id, i) => fire(el, "pointermove", { pointerId: id, clientX: 100 * (i + 1) + move, clientY: 300 + move, timeStamp: t0 + 50 }));
		ids.forEach((id, i) => fire(el, "pointerup", { pointerId: id, clientX: 100 * (i + 1), clientY: 300, timeStamp: t0 + 100 + i * 10 }));
	};

	it("two fingers undo, three redo, and the view is put back first", () => {
		const { el, log } = setup();
		tap(el, [1, 2], 1000, 5);
		expect(log).toEqual(["restore", "undo"]);
		log.length = 0;
		tap(el, [3, 4, 5], 2000);
		expect(log).toEqual(["restore", "redo"]);
	});

	it("swapped: two fingers redo, three undo", () => {
		const { el, log } = setup("redo-undo");
		tap(el, [1, 2], 1000);
		tap(el, [3, 4, 5], 2000);
		expect(log.filter((x) => x !== "restore")).toEqual(["redo", "undo"]);
	});

	it("does nothing when off, for one finger, for four, or for a pan / pinch", () => {
		const off = setup("off");
		tap(off.el, [1, 2], 1000);
		expect(off.log).toEqual([]);
		const { el, log } = setup();
		tap(el, [1], 1000);
		tap(el, [2, 3, 4, 5], 2000);
		tap(el, [6, 7], 3000, 40); // moved 40 px: a pan or pinch
		expect(log).toEqual([]);
	});

	it("is ignored while the pen is near (palm rejection window) and while it is down", () => {
		const { el, log, policy } = setup();
		policy.notePen(900);
		tap(el, [1, 2], 1000); // within 500 ms of the pen
		expect(log).toEqual([]);
		tap(el, [3, 4], 2000); // pen long gone
		expect(log).toEqual(["restore", "undo"]);
		log.length = 0;
		policy.setPenDown(true, 3000);
		tap(el, [5, 6], 3100);
		expect(log).toEqual([]);
	});

	it("a pen touching down in the middle of the fingers spoils the tap", () => {
		const { el, log } = setup();
		fire(el, "pointerdown", { pointerId: 1, clientX: 100, clientY: 300, timeStamp: 1000 });
		fire(el, "pointerdown", { pointerId: 2, clientX: 200, clientY: 300, timeStamp: 1010 });
		fire(el, "pointerdown", { pointerId: 9, pointerType: "pen", clientX: 300, clientY: 300, timeStamp: 1020 });
		fire(el, "pointerup", { pointerId: 1, timeStamp: 1100 });
		fire(el, "pointerup", { pointerId: 2, timeStamp: 1110 });
		expect(log).toEqual([]);
	});

	it("a touch in an edge zone is not a finger of the tap", () => {
		const { el, log } = setup("undo-redo", settings({ edge: { enabled: true, widthPx: 24, left: true, right: true, top: true, bottom: true } }));
		fire(el, "pointerdown", { pointerId: 1, clientX: 10, clientY: 300, timeStamp: 1000 });
		fire(el, "pointerdown", { pointerId: 2, clientX: 200, clientY: 300, timeStamp: 1010 });
		fire(el, "pointerup", { pointerId: 1, timeStamp: 1100 });
		fire(el, "pointerup", { pointerId: 2, timeStamp: 1110 });
		expect(log).toEqual([]);
	});

	it("a cancelled pointer is not a tap", () => {
		const { el, log } = setup();
		fire(el, "pointerdown", { pointerId: 1, clientX: 100, clientY: 300, timeStamp: 1000 });
		fire(el, "pointerdown", { pointerId: 2, clientX: 200, clientY: 300, timeStamp: 1010 });
		fire(el, "pointercancel", { pointerId: 1, timeStamp: 1100 });
		fire(el, "pointerup", { pointerId: 2, timeStamp: 1110 });
		expect(log).toEqual([]);
	});
});

describe("a finger tap leaves no ink", () => {
	it("with finger drawing on, the first finger's stroke is cancelled when the second lands", () => {
		const el = new FakeEl();
		const log: string[] = [];
		const handlers: PointerHandlers = {
			drawStart: () => (log.push("start"), true),
			drawMove: () => log.push("move"),
			drawEnd: (cancelled) => log.push(cancelled ? "cancel" : "end"),
			pan: () => log.push("pan"),
			zoom: () => log.push("zoom"),
		};
		new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: true, palmRejectionMs: 0 }), handlers);
		fire(el, "pointerdown", { pointerId: 1, clientX: 100, clientY: 300, timeStamp: 1000 });
		fire(el, "pointerdown", { pointerId: 2, clientX: 200, clientY: 300, timeStamp: 1015 });
		fire(el, "pointerdown", { pointerId: 3, clientX: 300, clientY: 300, timeStamp: 1030 });
		for (const id of [1, 2, 3]) fire(el, "pointerup", { pointerId: id, timeStamp: 1100 + id });
		// The first finger's stroke is cancelled by the second; the third joins the navigation instead of starting a stroke.
		expect(log).toEqual(["start", "cancel"]);
	});
});

// --- pen side button: lasso / previous tool while held ---

describe("pen side button: lasso and previous tool", () => {
	const base: InputSettings = { fingerDrawing: false, palmRejectionMs: 0 };

	it("the settings parse (key penSideButton); the default is radial + eraser; the old key is migrated", () => {
		expect(DEFAULT_SETTINGS.penSideButton).toBe("radial-eraser");
		expect(readSettings({ penSideButton: "lasso" }).penSideButton).toBe("lasso");
		expect(readSettings({ penSideButton: "previous" }).penSideButton).toBe("previous");
		expect(readSettings({ penSideButton: "scissors" }).penSideButton).toBe("radial-eraser");
		// wave 0.6 saved penButtonAction: "lasso" / "lastTool"; 0.5.x saved "radial" as its default.
		expect(readSettings({ penButtonAction: "lasso" }).penSideButton).toBe("lasso");
		expect(readSettings({ penButtonAction: "lastTool" }).penSideButton).toBe("previous");
		expect(readSettings({ penButtonAction: "radial" }).penSideButton).toBe("radial-eraser");
		expect(readSettings({ penButtonAction: "scissors" }).penSideButton).toBe("radial-eraser");
		expect(readSettings({ penButtonAction: "lasso", penSideButton: "off" }).penSideButton).toBe("off");
	});

	it("the side button draws (never opens the menu) and names the held tool", () => {
		for (const [penButton, held] of [["lasso", "lasso"], ["previous", "previous"]] as const) {
			const p = new InputPolicy({ ...base, penButton });
			expect(p.route("pen", 1000, 0, 0, 3)).toBe("draw");
			expect(p.route("pen", 1000, 2, 0, 2)).toBe("draw");
			expect(p.penHeld(0, 3)).toBe(held);
			expect(p.penHeld(0, 1)).toBeNull();
			expect(p.penErases(0, 3)).toBe(false);
		}
		for (const penButton of ["radial", "radial-eraser", "eraser", "off"] as const) {
			expect(new InputPolicy({ ...base, penButton }).penHeld(0, 3)).toBeNull();
		}
	});

	it("the controller passes the held tool to drawStart for the pen only", () => {
		const el = new FakeEl();
		const starts: Array<{ eraser: boolean; held?: string }> = [];
		const handlers: PointerHandlers = {
			drawStart: (_s, eraser, held) => (starts.push({ eraser, held }), true),
			drawMove: () => undefined,
			drawEnd: () => undefined,
			pan: () => undefined,
			zoom: () => undefined,
		};
		new PointerController(el as unknown as HTMLElement, new InputPolicy({ fingerDrawing: true, palmRejectionMs: 0, penButton: "lasso" }), handlers);
		fire(el, "pointerdown", { pointerId: 1, pointerType: "pen", buttons: 3 });
		fire(el, "pointerup", { pointerId: 1, pointerType: "pen" });
		fire(el, "pointerdown", { pointerId: 2, pointerType: "pen", buttons: 1 });
		fire(el, "pointerup", { pointerId: 2, pointerType: "pen" });
		expect(starts).toEqual([{ eraser: false, held: "lasso" }, { eraser: false, held: undefined }]);
	});

	it("LastTool remembers the tool used before the current one", () => {
		const last = new LastTool<string>();
		expect(last.previous()).toBeNull();
		last.note("pen");
		expect(last.previous()).toBeNull();
		last.note("pen");
		last.note("eraser");
		expect(last.previous()).toBe("pen");
		last.note("eraser");
		expect(last.previous()).toBe("pen");
		last.note("highlighter");
		last.note("pen");
		expect(last.previous()).toBe("highlighter");
	});
});

// --- settings ---

describe("gesture settings", () => {
	it("defaults: taps on, scribble and auto-scroll off", () => {
		expect(DEFAULT_GESTURE_SETTINGS).toEqual({ tapGestures: "undo-redo", scribbleErase: false, autoScrollWriting: false });
		const s = readSettings({});
		expect([s.tapGestures, s.scribbleErase, s.autoScrollWriting]).toEqual(["undo-redo", false, false]);
	});

	it("reads valid values and ignores the wrong type", () => {
		expect(readGestureSettings({ tapGestures: "redo-undo", scribbleErase: true, autoScrollWriting: true })).toEqual({ tapGestures: "redo-undo", scribbleErase: true, autoScrollWriting: true });
		expect(readGestureSettings({ tapGestures: "three", scribbleErase: "yes", autoScrollWriting: 1 })).toEqual(DEFAULT_GESTURE_SETTINGS);
		expect(readSettings({ tapGestures: "off" }).tapGestures).toBe("off");
	});
});

// --- auto-scroll ---

describe("auto-scroll distance", () => {
	it("scrolls only when the tip is in the bottom band", () => {
		expect(autoScrollDistance(500, 1000)).toBe(0);
		expect(autoScrollDistance(810, 1000)).toBe(0);
		expect(autoScrollDistance(830, 1000)).toBe(430); // to 40 % of the height
		expect(autoScrollDistance(990, 1000)).toBe(590);
	});

	it("ignores nonsense and caps the distance", () => {
		expect(autoScrollDistance(NaN, 1000)).toBe(0);
		expect(autoScrollDistance(900, 0)).toBe(0);
		expect(autoScrollDistance(2000, 1000)).toBe(0);
		expect(autoScrollDistance(90, 100, 0.5, 0)).toBe(80);
	});

	it("eases out from 0 to 1", () => {
		expect(easeOutCubic(0)).toBe(0);
		expect(easeOutCubic(1)).toBe(1);
		expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
		expect(easeOutCubic(2)).toBe(1);
	});
});

class FakeClock implements AutoScrollClock {
	time = 0;
	private nextId = 1;
	timers = new Map<number, { at: number; fn: () => void }>();
	frames = new Map<number, () => void>();
	now() {
		return this.time;
	}
	setTimeout(fn: () => void, ms: number) {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + ms, fn });
		return id;
	}
	clearTimeout(h: number) {
		this.timers.delete(h);
	}
	requestFrame(fn: () => void) {
		const id = this.nextId++;
		this.frames.set(id, fn);
		return id;
	}
	cancelFrame(h: number) {
		this.frames.delete(h);
	}
	/** Advances time in 16 ms steps, firing due timers and one round of frames per step. */
	advance(ms: number) {
		const end = this.time + ms;
		while (this.time < end) {
			this.time = Math.min(end, this.time + 16);
			for (const [id, t] of [...this.timers]) {
				if (t.at <= this.time) {
					this.timers.delete(id);
					t.fn();
				}
			}
			const frames = [...this.frames];
			this.frames.clear();
			for (const [, fn] of frames) fn();
		}
	}
}

describe("AutoScroller", () => {
	function setup(over: { enabled?: boolean; busy?: boolean; limit?: number } = {}) {
		const clock = new FakeClock();
		const state = { offset: 0, enabled: over.enabled ?? true, busy: over.busy ?? false, moves: [] as number[] };
		const limit = over.limit ?? -Infinity;
		const scroller = new AutoScroller({
			enabled: () => state.enabled,
			viewHeight: () => 1000,
			offsetY: () => state.offset,
			panBy: (dy) => {
				state.offset = Math.max(limit, state.offset + dy);
				state.moves.push(dy);
			},
			busy: () => state.busy,
		}, clock, 700, 320);
		return { clock, state, scroller };
	}

	it("waits for a pause, then scrolls smoothly up to the target and stops", () => {
		const { clock, state, scroller } = setup();
		scroller.strokeEnded(900);
		clock.advance(600);
		expect(state.moves).toEqual([]); // not during the pause
		clock.advance(1000);
		expect(state.offset).toBeCloseTo(-500, 5);
		expect(state.moves.length).toBeGreaterThan(5); // spread over several frames
		expect(state.moves.every((m) => m <= 0)).toBe(true);
		expect(scroller.pending).toBe(false);
	});

	it("does nothing outside the band, when off, or when a new stroke ends before the pause is over", () => {
		const a = setup();
		a.scroller.strokeEnded(400);
		a.clock.advance(3000);
		expect(a.state.moves).toEqual([]);
		const b = setup({ enabled: false });
		b.scroller.strokeEnded(950);
		b.clock.advance(3000);
		expect(b.state.moves).toEqual([]);
		const c = setup();
		c.scroller.strokeEnded(950);
		c.clock.advance(500);
		c.scroller.strokeEnded(300); // the next stroke ended higher: nothing is due any more
		c.clock.advance(3000);
		expect(c.state.moves).toEqual([]);
	});

	it("never moves while a contact is active, and cancel stops it for good", () => {
		const a = setup();
		a.scroller.strokeEnded(950);
		a.clock.advance(600);
		a.state.busy = true; // the pen came down during the pause
		a.clock.advance(2000);
		expect(a.state.moves).toEqual([]);
		const b = setup();
		b.scroller.strokeEnded(950);
		b.clock.advance(800);
		b.scroller.cancel();
		const moved = b.state.moves.length;
		b.clock.advance(2000);
		expect(b.state.moves.length).toBe(moved);
		expect(b.scroller.pending).toBe(false);
	});

	it("stops at the end of the document", () => {
		const { clock, state, scroller } = setup({ limit: -100 });
		scroller.strokeEnded(950);
		clock.advance(3000);
		expect(state.offset).toBe(-100);
		expect(scroller.pending).toBe(false);
	});
});

describe("GestureInput: a touch on the stage cancels a pending auto-scroll", () => {
	it("pointerdown takes the view back; pen hover does not", () => {
		const el = new FakeEl();
		const clock = new FakeClock();
		let offset = 0;
		const gi = new GestureInput(el as unknown as HTMLElement, {
			policy: new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500 }),
			tapMode: () => "off",
			act: () => undefined,
			snapshotView: () => () => undefined,
			drawing: () => false,
			autoScroll: { enabled: () => true, viewHeight: () => 1000, offsetY: () => offset, panBy: (dy) => (offset += dy) },
		}, clock);
		gi.strokeEnded(950);
		fire(el, "pointermove", { pointerType: "pen", pointerId: 4 });
		clock.advance(2000);
		expect(offset).toBeLessThan(-100);
		offset = 0;
		gi.strokeEnded(950);
		clock.advance(300);
		fire(el, "pointerdown", { pointerType: "pen", pointerId: 4, timeStamp: 5000 });
		fire(el, "pointerup", { pointerType: "pen", pointerId: 4, timeStamp: 5100 });
		clock.advance(3000);
		expect(offset).toBe(0);
		gi.destroy();
	});
});

// --- scribble to erase ---

interface ZigOptions {
	cx?: number;
	cy?: number;
	half?: number;
	legs?: number;
	pitch?: number;
	angle?: number;
	noise?: number;
}

/** A synthetic zig-zag path sampled every ~1 pt, with the turns rounded a little by a moving average. */
function zigzag({ cx = 200, cy = 100, half = 40, legs = 7, pitch = 4, angle = 0, noise = 0 }: ZigOptions = {}): Point[] {
	const vertices: Array<[number, number]> = [];
	for (let i = 0; i <= legs; i++) vertices.push([i % 2 === 0 ? -half : half, (i - legs / 2) * pitch]);
	return densifyRounded(vertices.map(([a, b]) => rotate(a, b, angle, cx, cy)), noise);
}

function rotate(a: number, b: number, deg: number, cx: number, cy: number): [number, number] {
	const r = (deg * Math.PI) / 180;
	return [cx + a * Math.cos(r) - b * Math.sin(r), cy + a * Math.sin(r) + b * Math.cos(r)];
}

function densifyRounded(vertices: Array<[number, number]>, noise: number): Point[] {
	const raw: Array<[number, number]> = [];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!, [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = i === 1 ? 0 : 1; k <= n; k++) raw.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
	}
	const out: Point[] = [];
	const w = 2;
	for (let i = 0; i < raw.length; i++) {
		let sx = 0, sy = 0, c = 0;
		for (let j = Math.max(0, i - w); j <= Math.min(raw.length - 1, i + w); j++) {
			sx += raw[j]![0];
			sy += raw[j]![1];
			c++;
		}
		const jx = noise ? Math.sin(i * 12.9898) * noise : 0;
		const jy = noise ? Math.cos(i * 78.233) * noise : 0;
		out.push([sx / c + jx, sy / c + jy, 0.5]);
	}
	return out;
}

/** "mmm": rectified sine arches advancing along the line. */
function arches(count: number, width: number, height: number): Point[] {
	const out: Point[] = [];
	for (let x = 0; x <= count * width; x++) out.push([100 + x, 200 - height * Math.abs(Math.sin((Math.PI * x) / width)), 0.5]);
	return out;
}

/** A triangle wave advancing along the line: the worst case for "mmm" (sharp turns, long legs). */
function sharpMmm(humps: number, width: number, height: number): Point[] {
	const vertices: Array<[number, number]> = [];
	for (let i = 0; i <= humps * 2; i++) vertices.push([100 + (i * width) / 2, 200 - (i % 2 === 1 ? height : 0)]);
	return densifyRounded(vertices, 0);
}

function stroke(points: Array<[number, number]>, width = 2): Stroke {
	return createStroke("#1e1e1e", width, points.map(([x, y]) => [x, y, 0.5] as Point));
}

/** A handwritten word: tall strokes side by side. */
function word(x0: number, y0: number, n = 6): Stroke[] {
	return Array.from({ length: n }, (_, i) => stroke([[x0 + i * 14, y0 - 10], [x0 + i * 14 + 1, y0], [x0 + i * 14, y0 + 10]]));
}

describe("scribble detector: positive cases", () => {
	it("finds a fast horizontal scratch", () => {
		const s = detectScribble(zigzag(), 500);
		expect(s).not.toBeNull();
		expect(s!.reversals).toBeGreaterThanOrEqual(5);
	});

	it("works at any angle, with jitter, and for different numbers of legs", () => {
		for (const angle of [0, 30, 90, 135, -50]) {
			expect(detectScribble(zigzag({ angle, noise: 0.8 }), 600), `angle ${angle}`).not.toBeNull();
		}
		for (const legs of [5, 6, 9, 14]) expect(detectScribble(zigzag({ legs, pitch: 3 }), 90 * legs), `legs ${legs}`).not.toBeNull();
	});

	it("tolerates a lead-in line before the scratch", () => {
		const lead: Point[] = Array.from({ length: 20 }, (_, i) => [140 + i, 100 + i * 0.1, 0.5] as Point);
		expect(detectScribble([...lead, ...zigzag({ cx: 200 })], 700)).not.toBeNull();
	});
});

describe("scribble detector: negative cases", () => {
	it("small handwriting zig-zags such as \"mmm\" are not scribbles", () => {
		expect(detectScribble(arches(6, 8, 10), 900)).toBeNull();
		expect(detectScribble(arches(9, 5, 8), 800)).toBeNull();
	});

	it("neither is big, fast \"mmm\" that travels along the line, even with sharp tops", () => {
		expect(detectScribble(arches(6, 10, 24), 700)).toBeNull();
		expect(detectScribble(sharpMmm(8, 10, 24), 700)).toBeNull();
		expect(detectScribble(sharpMmm(8, 14, 16), 600)).toBeNull();
	});

	it("each guard is what rejects its case (relax it and the case is accepted)", () => {
		const shortLegs = zigzag({ half: 10, legs: 8, pitch: 0.5 }); // 20 pt legs
		expect(detectScribble(shortLegs, 500)).not.toBeNull();
		expect(detectScribble(shortLegs, 500, { minLeg: 30 })).toBeNull(); // the leg length guard
		expect(detectScribble(sharpMmm(8, 10, 24), 700, { maxDrift: 100 })).not.toBeNull(); // travelling along the line
		expect(detectScribble(zigzag({ half: 15, legs: 20, pitch: 4 }), 1500, { maxDrift: 100 })).not.toBeNull(); // sweeping shading
		expect(detectScribble(zigzag(), 4000, { maxLegMs: 10_000 })).not.toBeNull(); // slow
	});

	it("zig-zag shading that sweeps across an area is not a scribble", () => {
		expect(detectScribble(zigzag({ half: 15, legs: 20, pitch: 4 }), 1500)).toBeNull();
		expect(detectScribble(zigzag({ half: 20, legs: 12, pitch: 8, angle: 45 }), 1000)).toBeNull();
	});

	it("hatching drawn as separate strokes is not a scribble", () => {
		for (let i = 0; i < 8; i++) {
			const line: Point[] = Array.from({ length: 41 }, (_, k) => [100 + k + i * 5, 100 - k + i * 5, 0.5] as Point);
			expect(detectScribble(line, 200)).toBeNull();
		}
	});

	it("a slow back-and-forth is not a scribble", () => {
		expect(detectScribble(zigzag(), 4000)).toBeNull();
	});

	it("too few reversals or too small legs are not a scribble", () => {
		expect(detectScribble(zigzag({ legs: 3 }), 300)).toBeNull();
		expect(detectScribble(zigzag({ half: 4, legs: 8, pitch: 0.5 }), 500)).toBeNull();
	});

	it("lines, circles and spirals are not scribbles", () => {
		const line: Point[] = Array.from({ length: 100 }, (_, i) => [100 + i, 100, 0.5] as Point);
		const circle: Point[] = Array.from({ length: 120 }, (_, i) => [200 + 30 * Math.cos(i / 10), 200 + 30 * Math.sin(i / 10), 0.5] as Point);
		const spiral: Point[] = Array.from({ length: 300 }, (_, i) => [200 + (i / 10) * Math.cos(i / 6), 200 + (i / 10) * Math.sin(i / 6), 0.5] as Point);
		for (const pts of [line, circle, spiral]) expect(detectScribble(pts, 400)).toBeNull();
	});

	it("degenerate input is safe", () => {
		expect(detectScribble([], 500)).toBeNull();
		expect(detectScribble([[1, 1, 0.5]], 500)).toBeNull();
		expect(detectScribble(zigzag(), 0)).toBeNull();
		expect(detectScribble(zigzag(), NaN)).toBeNull();
		expect(resamplePath([], 2)).toEqual([]);
		expect(detectScribble(Array.from({ length: 40 }, () => [5, 5, 0.5] as Point), 300)).toBeNull();
	});
});

describe("scribble erase: which strokes go", () => {
	const page = (strokes: Stroke[]) => ({ id: "p1", strokes });

	it("deletes the strokes it crosses and leaves the rest", () => {
		const w = word(150, 100);
		const far = stroke([[400, 300], [420, 320]]);
		const target = [...w, far];
		const doc: NotebookDocument = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		const p = doc.pages[0]!;
		p.strokes.push(...target);
		const cmd = scribbleEraseCommand(p, zigzag({ cx: 190, cy: 100, half: 50, legs: 7, pitch: 4 }), 500, 2);
		expect(cmd).not.toBeNull();
		const history = new History(() => doc);
		history.execute(cmd!);
		expect(p.strokes).toEqual([far]);
		// One undo step brings everything back, in order.
		expect(history.undo()).toBeTruthy();
		expect(p.strokes).toEqual(target);
	});

	it("as two undo steps: one Undo gives back the erased strokes and the scribble itself", () => {
		const w = word(150, 100);
		const doc: NotebookDocument = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		const p = doc.pages[0]!;
		p.strokes.push(...w);
		const scratch = stroke(zigzag({ cx: 190, cy: 100, half: 50, legs: 7, pitch: 4 }).map((q) => [q[0], q[1]] as [number, number]));
		const steps = scribbleEraseSteps(p, scratch, 500)!;
		expect(steps).not.toBeNull();
		const history = new History(() => doc);
		history.execute(steps.keep);
		history.execute(steps.erase);
		expect(p.strokes).toEqual([]);
		history.undo();
		expect(p.strokes).toEqual([...w, scratch]);
		history.undo();
		expect(p.strokes).toEqual(w);
		expect(scribbleEraseSteps({ id: "p1", strokes: [] }, scratch, 500)).toBeNull();
	});

	it("keeps a stroke that is only grazed by one leg", () => {
		const w = word(150, 100);
		// Touches only the last leg, near the bottom edge of the scratch.
		const graze = stroke([[190, 112.5], [191, 113.5]]);
		const scribble = detectScribble(zigzag({ cx: 190, cy: 100, half: 50, legs: 7, pitch: 4 }), 500)!;
		const victims = scribbleVictims(scribble, [...w, graze], 2);
		expect(victims).toEqual(w);
	});

	it("leaves a long ruling that runs through the scratch", () => {
		const w = word(150, 100, 4);
		const ruling = stroke([[0, 100], [300, 100], [600, 100]]);
		const cmd = scribbleEraseCommand(page([...w, ruling]), zigzag({ cx: 175, cy: 100, half: 40, pitch: 4 }), 500, 2);
		expect(cmd).not.toBeNull();
		const scribble = detectScribble(zigzag({ cx: 175, cy: 100, half: 40, pitch: 4 }), 500)!;
		expect(scribbleVictims(scribble, [...w, ruling], 2)).toEqual(w);
	});

	it("a scratch over empty paper, or beside the ink, deletes nothing and stays ink", () => {
		expect(scribbleEraseCommand(page([]), zigzag(), 500, 2)).toBeNull();
		expect(scribbleEraseCommand(page(word(400, 400)), zigzag(), 500, 2)).toBeNull();
		// Dense zig-zag shading on a blank page is kept as ink.
		expect(scribbleEraseCommand(page([]), zigzag({ half: 15, legs: 12, pitch: 1.5 }), 700, 2)).toBeNull();
	});

	it("writing over existing ink is not erased (\"mmm\" and wide shading over a word)", () => {
		const w = word(100, 200);
		expect(scribbleEraseCommand(page(w), arches(6, 8, 10), 900, 2)).toBeNull();
		expect(scribbleEraseCommand(page(w), zigzag({ cx: 140, cy: 200, half: 30, legs: 20, pitch: 4 }), 1500, 2)).toBeNull();
	});
});
