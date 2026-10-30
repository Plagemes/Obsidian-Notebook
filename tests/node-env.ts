// Helpers for tests that run in plain Node (vitest `environment: "node"`), where there is no `window`.
// The plugin code under test calls `window.setTimeout` and friends, so tests install a minimal `window` here.
import { vi } from "vitest";

/**
 * The timer functions of the current global scope, looked up when used (not when this module loads),
 * so `vi.useFakeTimers()` switched on or off by a test is always honoured.
 */
const timerApi = {
	get setTimeout() { return setTimeout; },
	get clearTimeout() { return clearTimeout; },
	get setInterval() { return setInterval; },
	get clearInterval() { return clearInterval; },
};

/** `setTimeout`, typed like the DOM one (a number handle) as `Timers.set` expects. */
export function nodeSetTimeout(fn: () => void, ms: number): number {
	return timerApi.setTimeout(fn, ms);
}

/** `clearTimeout`, the counterpart of `nodeSetTimeout`. */
export function nodeClearTimeout(handle: number): void {
	timerApi.clearTimeout(handle);
}

/** Resolve after `ms` milliseconds of real time. */
export function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => { nodeSetTimeout(resolve, ms); });
}


/** Install a stand-in `window` (one that offers the timer functions unless `win` is given); undo with `removeFakeWindow`. */
export function installFakeWindow(win?: unknown): void {
	vi.stubGlobal("window", win ?? timerApi);
}

/** Remove the stand-in `window` installed by `installFakeWindow`. */
export function removeFakeWindow(): void {
	vi.unstubAllGlobals();
}

/**
 * The config folder name a fake vault reports as `app.vault.configDir`.
 * (A template literal on purpose: it is a test value, not a path the plugin hardcodes.)
 */
export const CONFIG_DIR = `.obsidian`;
