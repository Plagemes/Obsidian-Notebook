/**
 * v7 reading position (#125): stored only together with a content save (DocumentSession.beforeSerialize),
 * never as a write of its own; and the start-page rules of the view (position-sync.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import { positionAt, updatePosition } from "../src/model/position";
import type { NotebookDocument } from "../src/model/types";
import type { JournalSlotFile, JournalStore } from "../src/storage/journal";
import { DocumentSession, type DocumentIO, type Timers } from "../src/storage/session";
import { PAGE_AT_KEY, pageAtFromState, pageState, startPosition } from "../src/view/position-sync";
import { line, sampleDocument } from "./helpers";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

const timers: Timers = {
	set: (fn, ms) => nodeSetTimeout(fn, ms),
	clear: (h) => nodeClearTimeout(h),
};

class FakeIO implements DocumentIO {
	writes: string[] = [];
	constructor(public content: string) {}
	async read(): Promise<string> {
		return this.content;
	}
	async process(fn: (current: string) => string): Promise<void> {
		const next = fn(this.content);
		if (next !== this.content) {
			this.content = next;
			this.writes.push(next);
		}
	}
	async backup(): Promise<string | null> {
		return null;
	}
}

class MemoryJournal implements JournalStore {
	files = new Map<string, string>();
	async read(): Promise<JournalSlotFile[]> {
		return [];
	}
	async write(key: string, owner: string, slot: 0 | 1, text: string): Promise<void> {
		this.files.set(`${key}|${owner}|${slot}`, text);
	}
	async remove(key: string, owner: string): Promise<void> {
		this.files.delete(`${key}|${owner}|0`);
		this.files.delete(`${key}|${owner}|1`);
	}
	release(): void {}
}

function twoPages(): NotebookDocument {
	const doc = sampleDocument(1);
	doc.pages.push({ ...doc.pages[0]!, id: "second", strokes: [] });
	return doc;
}

describe("the reading position travels with content saves only", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("is written with a content change and never on its own", async () => {
		const io = new FakeIO(serialize(twoPages()));
		let reader = { index: 1, y: 50 };
		let calls = 0;
		const s = new DocumentSession(io, timers, {}, {
			beforeSerialize: (doc) => {
				calls++;
				updatePosition(doc, positionAt(doc, reader.index, reader.y, new Date("2026-10-29T12:00:00.000Z")));
			},
		});
		await s.load();
		// Scrolling alone: nothing is written, also when the view closes.
		reader = { index: 0, y: 10 };
		expect(await s.flush()).toBe(true);
		expect(await s.flushForClose()).toBe(true);
		expect(io.writes).toHaveLength(0);
		expect(calls).toBe(0);
		// A real edit: the save carries the current position.
		s.doc!.pages[0]!.strokes.push(line(10, 10, 90, 90));
		s.markChanged();
		await s.flush();
		expect(io.writes).toHaveLength(1);
		const saved = parse(io.content);
		expect(saved.ok && saved.doc.position).toEqual({ page: s.doc!.pages[0]!.id, y: 10, at: "2026-10-29T12:00:00.000Z" });
		// Moving again without editing: still one write.
		reader = { index: 1, y: 0 };
		await s.flushForClose();
		expect(io.writes).toHaveLength(1);
		s.dispose();
	});

	it("the journal and the save that follows it write the same text (one serialization per revision)", async () => {
		const io = new FakeIO(serialize(twoPages()));
		const journal = new MemoryJournal();
		let y = 5;
		const s = new DocumentSession(io, timers, {}, {
			journal, journalDelayMs: 10, debounceMs: 100_000, maxWaitMs: 100_000,
			now: () => new Date("2026-10-29T12:00:00.000Z"),
			beforeSerialize: (doc) => updatePosition(doc, positionAt(doc, 0, y, new Date("2026-10-29T12:00:00.000Z"))),
		});
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(10, 10, 90, 90));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(2000);
		await s.journalIdle();
		const entries = [...journal.files.values()];
		expect(entries.length).toBeGreaterThan(0);
		// The reader moved after the journal entry: the save of the same revision keeps the journaled text.
		y = 300;
		await s.flush();
		const saved = parse(io.content);
		expect(saved.ok && saved.doc.position?.y).toBe(5);
		s.dispose();
	});
});

describe("start position of a freshly opened notebook", () => {
	const doc = (): NotebookDocument => {
		const d = twoPages();
		d.position = { page: "second", y: 40, at: "2026-10-29T11:00:00.000Z" };
		return d;
	};

	it("view state carries when the page was in view", () => {
		const state = pageState(3, new Date("2026-10-29T10:00:00.000Z"));
		expect(state).toEqual({ page: 3, [PAGE_AT_KEY]: "2026-10-29T10:00:00.000Z" });
		expect(pageAtFromState(state)).toBe("2026-10-29T10:00:00.000Z");
		expect(pageAtFromState({ page: 3 })).toBeNull();
		expect(pageAtFromState(null)).toBeNull();
	});

	it("no page asked: the stored position", () => {
		expect(startPosition(doc(), null, null)).toEqual({ index: 1, y: 40 });
	});

	it("an explicit page (link, search hit, continue) always wins", () => {
		expect(startPosition(doc(), 1, null)).toEqual({ index: 0, y: 0 });
	});

	it("the restored layout page wins unless another device was in the notebook later", () => {
		expect(startPosition(doc(), 1, "2026-10-29T12:00:00.000Z")).toEqual({ index: 0, y: 0 });
		expect(startPosition(doc(), 1, "2026-10-29T10:00:00.000Z")).toEqual({ index: 1, y: 40 });
	});
});
