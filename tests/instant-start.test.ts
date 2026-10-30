import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageFromState } from "../src/integration/links";
import { serialize } from "../src/model/serialize";
import { whenIdle, type IdleScheduler } from "../src/storage/idle";
import { DocumentSession, WARM_UP_DELAY_MS, type DocumentIO, type Timers } from "../src/storage/session";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { LocationKeeper } from "../src/view/last-location";
import { sampleDocument } from "./helpers";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

const timers: Timers = {
	set: (fn, ms) => nodeSetTimeout(fn, ms),
	clear: (h) => nodeClearTimeout(h),
};

describe("LocationKeeper (remember the page being read)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("saves the last place once things have settled", () => {
		const saved: Array<[string, number]> = [];
		const k = new LocationKeeper(timers, (path, page) => saved.push([path, page]), 1000);
		k.note("Notebooks/A.notebook", 1);
		k.note("Notebooks/A.notebook", 2);
		k.note("Notebooks/A.notebook", 3);
		expect(saved).toEqual([]);
		vi.advanceTimersByTime(999);
		expect(saved).toEqual([]);
		vi.advanceTimersByTime(2);
		expect(saved).toEqual([["Notebooks/A.notebook", 3]]);
		vi.advanceTimersByTime(5000);
		expect(saved.length).toBe(1);
	});

	it("flush saves a pending place at once (view closing), and only once", () => {
		const saved: Array<[string, number]> = [];
		const k = new LocationKeeper(timers, (path, page) => saved.push([path, page]));
		k.note("B.notebook", 4);
		k.flush();
		k.flush();
		vi.advanceTimersByTime(10_000);
		expect(saved).toEqual([["B.notebook", 4]]);
	});

	it("ignores impossible pages and can be cancelled", () => {
		const saved: Array<[string, number]> = [];
		const k = new LocationKeeper(timers, (path, page) => saved.push([path, page]));
		k.note("C.notebook", 0);
		k.note("C.notebook", 1.5);
		k.note("C.notebook", NaN);
		k.flush();
		k.note("C.notebook", 2);
		k.cancel();
		vi.advanceTimersByTime(10_000);
		expect(saved).toEqual([]);
	});
});

describe("whenIdle", () => {
	it("waits the delay, then an idle moment", async () => {
		const calls: string[] = [];
		let runDelay: (() => void) | null = null;
		let runIdle: (() => void) | null = null;
		const scheduler: IdleScheduler = {
			delay: (fn, ms) => {
				calls.push(`delay ${ms}`);
				runDelay = fn;
			},
			idle: (fn, timeout) => {
				calls.push(`idle ${timeout}`);
				runIdle = fn;
			},
		};
		let done = false;
		const p = whenIdle(300, 5000, scheduler).then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		runDelay!();
		await Promise.resolve();
		expect(done).toBe(false);
		runIdle!();
		await p;
		expect(done).toBe(true);
		expect(calls).toEqual(["delay 300", "idle 5000"]);
	});

	it("resolves after the delay when there are no idle callbacks", async () => {
		let runDelay: (() => void) | null = null;
		const p = whenIdle(10, 100, { delay: (fn) => (runDelay = fn), idle: null });
		runDelay!();
		await expect(p).resolves.toBeUndefined();
	});
});

describe("DocumentSession warm-up", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts a moment after the load, so the first paint comes first, and never blocks a save", async () => {
		const text = serialize(sampleDocument(3));
		const delays: number[] = [];
		const recording: Timers = {
			set: (fn, ms) => {
				delays.push(ms);
				return nodeSetTimeout(fn, ms);
			},
			clear: (h) => nodeClearTimeout(h),
		};
		let disk = text;
		const io: DocumentIO = {
			read: async () => disk,
			process: async (fn) => {
				disk = fn(disk);
			},
			backup: async () => null,
		};
		const s = new DocumentSession(io, recording, {});
		await s.load();
		// The first timer after the load is the warm-up, not a zero-delay tick.
		expect(delays[0]).toBe(WARM_UP_DELAY_MS);
		expect(WARM_UP_DELAY_MS).toBeGreaterThan(0);
		// Saving before the warm-up ran works: it computes what it needs itself.
		s.markChanged();
		expect(await s.flush()).toBe(true);
		s.dispose();
	});
});

describe("remembered place", () => {
	it("settings keep the last notebook and page, and ignore bad values", () => {
		expect(DEFAULT_SETTINGS.lastNotebookPath).toBe("");
		expect(DEFAULT_SETTINGS.lastNotebookPage).toBe(1);
		const s = readSettings({ lastNotebookPath: "Notebooks/A.notebook", lastNotebookPage: 7 });
		expect(s.lastNotebookPath).toBe("Notebooks/A.notebook");
		expect(s.lastNotebookPage).toBe(7);
		const bad = readSettings({ lastNotebookPath: 5, lastNotebookPage: 0 });
		expect(bad.lastNotebookPath).toBe("");
		expect(bad.lastNotebookPage).toBe(1);
		expect(readSettings({ lastNotebookPage: 2.5 }).lastNotebookPage).toBe(1);
	});

	it("the view state page (written by getState) is read back by the same parser as link pages", () => {
		expect(pageFromState({ file: "A.notebook", page: 7 })).toBe(7);
		expect(pageFromState({ file: "A.notebook" })).toBeNull();
		expect(pageFromState({ page: 0 })).toBeNull();
	});
});
