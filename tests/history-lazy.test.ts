import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ setIcon: () => undefined, getLanguage: () => "en" }));

import { PathLock } from "../src/storage/path-lock";
import { snapshotLabel } from "../src/view/history-ui";

describe("the restore list does not parse every copy", () => {
	it("a row without a page count shows the date and the size only; a read count still shows", () => {
		const base = { date: new Date(2026, 10, 4, 11, 0), lecture: false, course: null, size: 2048 };
		const lazy = snapshotLabel(base);
		expect(lazy).toBe("2026-11-04 11:00 · 2 KB");
		expect(snapshotLabel({ ...base, pages: 3 })).toContain("3");
		expect(snapshotLabel({ ...base, pages: null })).not.toBe(lazy);
	});
});

describe("a lecture snapshot waits for a running snapshot of the same file instead of being dropped", () => {
	it("acquireWhenFree resumes after the holder released, one waiter at a time", async () => {
		const lock = new PathLock();
		const release = lock.acquire("A.notebook");
		expect(lock.has("A.notebook")).toBe(true);
		const order: string[] = [];
		const first = lock.acquireWhenFree("A.notebook").then(async (free) => {
			order.push("first");
			for (let i = 0; i < 5; i++) await Promise.resolve();
			order.push("first-done");
			free();
		});
		const second = lock.acquireWhenFree("A.notebook").then((free) => {
			order.push("second");
			free();
		});
		await Promise.resolve();
		expect(order).toEqual([]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "first-done", "second"]);
		expect(lock.has("A.notebook")).toBe(false);
	});

	it("another file is never held up, and a free path is taken at once", async () => {
		const lock = new PathLock();
		lock.acquire("A.notebook");
		const free = await lock.acquireWhenFree("B.notebook");
		expect(lock.has("B.notebook")).toBe(true);
		free();
		expect(lock.has("B.notebook")).toBe(false);
	});
});
