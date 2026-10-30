/** Do not disturb while writing (wave 0.8, 374). */
import { describe, expect, it } from "vitest";
import { QUIET_AFTER_MS, STUCK_PEN_MS, WritingGuard, type Scheduler } from "../src/ink/writing-guard";

/** A clock and timers the test drives by hand. */
function rig() {
	let now = 10_000;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const scheduler: Scheduler = {
		set(fn, ms) {
			const id = ++seq;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clear(handle) {
			timers.delete(handle as number);
		},
	};
	const guard = new WritingGuard(() => now, scheduler);
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			timers.delete(next[0]);
			now = Math.max(now, next[1].at);
			next[1].fn();
		}
		now = end;
	};
	return { guard, advance, timers: () => timers.size };
}

describe("WritingGuard", () => {
	it("is writing while a pen is down and for 1.5 s after it is lifted", () => {
		const { guard, advance } = rig();
		expect(guard.writing()).toBe(false);
		guard.penDown(1);
		expect(guard.writing()).toBe(true);
		advance(5000);
		expect(guard.writing()).toBe(true);
		guard.penUp(1);
		expect(guard.writing()).toBe(true);
		advance(QUIET_AFTER_MS - 1);
		expect(guard.writing()).toBe(true);
		advance(2);
		expect(guard.writing()).toBe(false);
	});

	it("runs a task at once when quiet, and holds it while writing until the pause", () => {
		const { guard, advance } = rig();
		const log: string[] = [];
		guard.whenQuiet(() => log.push("now"));
		expect(log).toEqual(["now"]);
		guard.penDown(7);
		guard.whenQuiet(() => log.push("a"));
		guard.whenQuiet(() => log.push("b"));
		advance(10_000);
		expect(log).toEqual(["now"]);
		guard.penUp(7);
		advance(QUIET_AFTER_MS - 10);
		expect(log).toEqual(["now"]);
		advance(200);
		expect(log).toEqual(["now", "a", "b"]);
		expect(guard.waiting).toBe(0);
	});

	it("a second stroke inside the pause pushes the queue back again", () => {
		const { guard, advance } = rig();
		const log: string[] = [];
		guard.penDown(1);
		guard.penUp(1);
		guard.whenQuiet(() => log.push("x"));
		advance(1000);
		guard.penDown(1);
		guard.penUp(1);
		advance(1400);
		expect(log).toEqual([]);
		advance(300);
		expect(log).toEqual(["x"]);
	});

	it("a task queued under the same key replaces the earlier one", () => {
		const { guard, advance } = rig();
		const log: string[] = [];
		guard.penDown(1);
		guard.whenQuiet(() => log.push("first"), "k");
		guard.whenQuiet(() => log.push("other"), "o");
		guard.whenQuiet(() => log.push("second"), "k");
		guard.penUp(1);
		advance(QUIET_AFTER_MS + 100);
		expect(log).toEqual(["other", "second"]);
	});

	it("a pen that never comes up does not hold work for ever", () => {
		const { guard, advance } = rig();
		const log: string[] = [];
		guard.penDown(3);
		guard.whenQuiet(() => log.push("late"));
		advance(STUCK_PEN_MS - 100);
		expect(log).toEqual([]);
		// Declared lost after STUCK_PEN_MS, then the usual pause.
		advance(100 + 2 * QUIET_AFTER_MS + 500);
		expect(log).toEqual(["late"]);
		expect(guard.writing()).toBe(false);
	});

	it("losing the window ends the writing; a task that throws does not stop the others", () => {
		const { guard, advance } = rig();
		const log: string[] = [];
		const quiet = console.error;
		console.error = () => undefined;
		try {
			guard.penDown(1);
			guard.whenQuiet(() => {
				throw new Error("boom");
			});
			guard.whenQuiet(() => log.push("after"));
			guard.penLost();
			advance(QUIET_AFTER_MS + 100);
		} finally {
			console.error = quiet;
		}
		expect(log).toEqual(["after"]);
	});

	it("idle() resolves at the first pause, and reset() drops what waits", async () => {
		const { guard, advance, timers } = rig();
		await expect(guard.idle()).resolves.toBeUndefined();
		guard.penDown(1);
		let resolved = false;
		void guard.idle().then(() => (resolved = true));
		guard.penUp(1);
		advance(QUIET_AFTER_MS + 100);
		await Promise.resolve();
		expect(resolved).toBe(true);

		const log: string[] = [];
		guard.penDown(2);
		guard.whenQuiet(() => log.push("never"));
		guard.reset();
		advance(60_000);
		expect(log).toEqual([]);
		expect(timers()).toBe(0);
		expect(guard.writing()).toBe(false);
	});
});
