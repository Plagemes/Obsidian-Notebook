// Timers through `window` (popout windows, the Scorecard). Where there is no window (Node, in tests) a zero delay runs
// as a microtask and a longer one never fires: the timeouts that use them are only safety nets for a real browser.

/** `window.setTimeout`; the handle is opaque. */
export function setTimer(fn: () => void, ms: number): number {
	if (typeof window !== "undefined") return window.setTimeout(fn, ms);
	if (ms <= 0) void Promise.resolve().then(fn);
	return -1;
}

/** `window.clearTimeout`. */
export function clearTimer(handle: number | null | undefined): void {
	if (typeof window !== "undefined" && handle !== null && handle !== undefined && handle >= 0) window.clearTimeout(handle);
}
