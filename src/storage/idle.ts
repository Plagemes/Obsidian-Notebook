/**
 * Waiting for a quiet moment, for work that nobody is looking at (version-history snapshot, stroke-line
 * warm-up) so it does not compete with the first paint of a notebook that was just opened.
 * Wave 0.8 (374): `whenIdle` also waits while the pen is on the screen (ink/writing-guard.ts).
 */
import { writing } from "../ink/writing-guard";

export interface IdleScheduler {
	/** Calls `fn` after about `ms` milliseconds. */
	delay(fn: () => void, ms: number): void;
	/** Calls `fn` when the browser is idle, or after `timeoutMs` at the latest; null when idle callbacks do not exist. */
	idle: ((fn: () => void, timeoutMs: number) => void) | null;
}

type IdleWindow = {
	setTimeout(fn: () => void, ms: number): number;
	requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number;
};

export function windowScheduler(w: IdleWindow = window): IdleScheduler {
	const ric = w.requestIdleCallback;
	return {
		delay: (fn, ms) => void w.setTimeout(fn, ms),
		idle: ric ? (fn, timeoutMs) => void ric.call(w, fn, { timeout: timeoutMs }) : null,
	};
}

/**
 * Resolves `delayMs` from now, and then at the next idle moment (at most `timeoutMs` later). Never rejects,
 * so a caller that awaits it always gets to run.
 */
export function whenIdle(delayMs = 1500, timeoutMs = 10_000, scheduler: IdleScheduler = windowScheduler()): Promise<void> {
	return new Promise((resolve) => {
		scheduler.delay(() => {
			const quiet = () => writing.whenQuiet(resolve);
			if (scheduler.idle) scheduler.idle(quiet, timeoutMs);
			else quiet();
		}, delayMs);
	});
}

/**
 * Runs `fn` in a new task, after what is already queued (input, painting) has had its turn. Unlike
 * `setTimeout(fn, 0)` it is not held back to 4 ms once calls are nested, which matters for work done in many short
 * slices (the staged load of a large notebook). Falls back to the timer where there is no MessageChannel.
 */
export function nextTask(fn: () => void): void {
	if (typeof MessageChannel === "undefined") {
		window.setTimeout(fn, 0);
		return;
	}
	const channel = new MessageChannel();
	channel.port1.onmessage = () => {
		channel.port1.close();
		fn();
	};
	channel.port2.postMessage(null);
}
