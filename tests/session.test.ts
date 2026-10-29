import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import { CURRENT_VERSION } from "../src/model/types";
import { DocumentSession, type BackupReason, type DocumentIO } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";

/** In-memory file with the same contract as the Vault-backed IO. */
class FakeIO implements DocumentIO {
	writes: string[] = [];
	backups: Array<{ content: string; reason: BackupReason }> = [];
	failNextWrite = false;
	/** Simulates another writer (Sync) changing the file between read and process. */
	beforeProcess: (() => void) | null = null;

	constructor(public content: string) {}

	async read(): Promise<string> {
		return this.content;
	}

	async process(fn: (current: string) => string): Promise<void> {
		this.beforeProcess?.();
		this.beforeProcess = null;
		if (this.failNextWrite) {
			this.failNextWrite = false;
			throw new Error("disk full");
		}
		this.content = fn(this.content);
		this.writes.push(this.content);
	}

	async backup(content: string, reason: BackupReason): Promise<string | null> {
		if (this.backups.some((b) => b.content === content)) return null;
		this.backups.push({ content, reason });
		return `backup-${this.backups.length}.bak`;
	}
}

const corrupt: Array<[string, string]> = [
	["truncated JSON", serialize(sampleDocument(3)).slice(0, 200)],
	["invalid schema", JSON.stringify({ format: "obsidian-notebook", version: 1, id: "x", pages: "nope" })],
	["not a notebook", JSON.stringify({ hello: "world" })],
	["garbage", "\u0000\u0001\u0002"],
];

describe("DocumentSession", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("loads, edits and saves a valid notebook that reopens identically", async () => {
		const io = new FakeIO(serialize(sampleDocument(2)));
		const s = new DocumentSession(io);
		await s.load();
		expect(s.mode).toBe("ok");
		s.doc!.pages[0]!.strokes.push(line(10, 10, 90, 90));
		s.markChanged();
		expect(s.dirty).toBe(true);
		expect(await s.flush()).toBe(true);
		expect(s.dirty).toBe(false);
		expect(io.writes).toHaveLength(1);

		const reopened = new DocumentSession(new FakeIO(io.content));
		await reopened.load();
		expect(reopened.doc).toEqual(s.doc);
		expect(serialize(reopened.doc!)).toBe(io.content);
	});

	it("does not write when nothing changed", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io);
		await s.load();
		await s.flush();
		expect(io.writes).toHaveLength(0);
	});

	it("debounces saves and caps the wait during continuous writing", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const s = new DocumentSession(io, {}, { debounceMs: 1000, maxWaitMs: 5000 });
		await s.load();
		const page = s.doc!.pages[0]!;
		// A stroke every 500 ms never lets the debounce expire...
		for (let i = 0; i < 12; i++) {
			page.strokes.push(line(i, 0, i, 10));
			s.markChanged();
			await vi.advanceTimersByTimeAsync(500);
		}
		// ...but the max wait forces a save after 5 s.
		expect(io.writes.length).toBeGreaterThanOrEqual(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.dirty).toBe(false);
		expect(parse(io.content).ok && (parse(io.content) as { doc: { pages: { strokes: unknown[] }[] } }).doc.pages[0]!.strokes).toHaveLength(12);
	});

	it.each(corrupt)("never overwrites an unreadable file (%s) and backs it up", async (_, content) => {
		const io = new FakeIO(content);
		const s = new DocumentSession(io);
		await s.load();
		expect(s.mode).toBe("broken");
		expect(s.doc).toBeNull();
		s.markChanged();
		await s.flush();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(io.writes).toHaveLength(0);
		expect(io.content).toBe(content);
		expect(io.backups).toEqual([{ content, reason: "unreadable" }]);
	});

	it("does not back up an empty file but still refuses to write it", async () => {
		const io = new FakeIO("");
		const s = new DocumentSession(io);
		await s.load();
		expect(s.mode).toBe("broken");
		await s.flush();
		expect(io.writes).toHaveLength(0);
		expect(io.backups).toHaveLength(0);
	});

	it("opens newer format versions read-only and never writes them", async () => {
		const future = JSON.stringify({ ...JSON.parse(serialize(sampleDocument(1))), version: CURRENT_VERSION + 1 });
		const io = new FakeIO(future);
		const s = new DocumentSession(io);
		await s.load();
		expect(s.mode).toBe("readonly");
		s.markChanged();
		await s.flush();
		expect(io.writes).toHaveLength(0);
		expect(io.backups[0]?.reason).toBe("future-version");
	});

	it("backs up an external change before overwriting it with local edits", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io);
		await s.load();
		const external = serialize(sampleDocument(4));
		io.content = external; // e.g. Sync from another device
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		expect(await s.handleExternalChange()).toBe("kept-local");
		await s.flush();
		expect(io.backups).toEqual([{ content: external, reason: "conflict" }]);
		expect(io.content).not.toBe(external);
	});

	it("backs up a change that lands between the pre-read and the write", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io);
		await s.load();
		const sneaky = serialize(sampleDocument(2));
		io.beforeProcess = () => (io.content = sneaky);
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		await s.flush();
		expect(io.backups.map((b) => b.content)).toContain(sneaky);
	});

	it("reloads an external change when there are no local edits", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const loaded = vi.fn();
		const s = new DocumentSession(io, { onLoaded: loaded });
		await s.load();
		io.content = serialize(sampleDocument(3));
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.doc!.pages[0]!.strokes).toHaveLength(3);
		expect(loaded).toHaveBeenCalledTimes(2);
	});

	it("ignores the echo of its own write", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		await s.flush();
		expect(await s.handleExternalChange()).toBe("echo");
	});

	it("an external change that is unreadable puts the session in broken mode without writing", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io);
		await s.load();
		io.content = "{ half a file";
		await s.handleExternalChange();
		expect(s.mode).toBe("broken");
		s.markChanged();
		await s.flush();
		expect(io.writes).toHaveLength(0);
		expect(io.content).toBe("{ half a file");
	});

	it("keeps changes and retries after a failed write", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const errors = vi.fn();
		const s = new DocumentSession(io, { onError: errors }, { retryMs: 1000 });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		io.failNextWrite = true;
		expect(await s.flush()).toBe(false);
		expect(s.dirty).toBe(true);
		expect(errors).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.dirty).toBe(false);
		expect(io.writes).toHaveLength(1);
	});

	it("refuses to write a document that fails re-validation", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io);
		await s.load();
		s.doc!.pages[0]!.strokes[0]!.points[0]![0] = Number.NaN; // would serialize as null
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(io.writes).toHaveLength(0);
		expect(s.dirty).toBe(true);
	});

	it("does not reschedule after dispose", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const s = new DocumentSession(io, {}, { debounceMs: 100 });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		s.dispose();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(io.writes).toHaveLength(0);
	});
});
