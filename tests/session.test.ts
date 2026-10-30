import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import { CURRENT_VERSION } from "../src/model/types";
import { DocumentSession, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";

/** Node timers, resolved at call time so vitest's fake timers apply. */
const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

/** In-memory file with the same contract as the Vault-backed IO. */
class FakeIO implements DocumentIO {
	/** Contents actually changed by process(). */
	writes: string[] = [];
	backups: Array<{ content: string; reason: BackupReason }> = [];
	log: string[] = [];
	failWrites = 0;
	failBackups = false;
	/** Simulates another writer (Sync) changing the file between read and process. */
	beforeProcess: (() => void) | null = null;
	keepBeforeProcess = false;

	constructor(public content: string) {}

	set failNextWrite(v: boolean) {
		this.failWrites = v ? 1 : 0;
	}

	async read(): Promise<string> {
		return this.content;
	}

	async process(fn: (current: string) => string): Promise<void> {
		this.beforeProcess?.();
		if (!this.keepBeforeProcess) this.beforeProcess = null;
		if (this.failWrites > 0) {
			this.failWrites--;
			throw new Error("disk full");
		}
		const next = fn(this.content);
		if (next !== this.content) {
			this.content = next;
			this.writes.push(next);
			this.log.push("write");
		}
	}

	async backup(content: string, reason: BackupReason): Promise<string | null> {
		if (this.failBackups) throw new Error("backup folder not writable");
		if (this.backups.some((b) => b.content === content)) return null;
		this.backups.push({ content, reason });
		this.log.push(`backup:${reason}`);
		return `backup-${this.backups.length}.bak`;
	}
}

const corrupt: Array<[string, string]> = [
	// A cut-off file is "still arriving" (sync safety): tests/sync-review.test.ts.
	// A syntax error in the middle of a complete text (not a cut-off one, whatever the length of the header).
	["broken JSON", serialize(sampleDocument(3)).replace('"pages": [', '"pages": [}')],
	["invalid schema", JSON.stringify({ format: "obsidian-notebook", version: 1, id: "x", pages: "nope" })],
	["not a notebook", JSON.stringify({ hello: "world" })],
	["garbage", "\u0000\u0001\u0002"],
];

describe("DocumentSession", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("loads, edits and saves a valid notebook that reopens identically", async () => {
		const io = new FakeIO(serialize(sampleDocument(2)));
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.mode).toBe("ok");
		s.doc!.pages[0]!.strokes.push(line(10, 10, 90, 90));
		s.markChanged();
		expect(s.dirty).toBe(true);
		expect(await s.flush()).toBe(true);
		expect(s.dirty).toBe(false);
		expect(io.writes).toHaveLength(1);

		const reopened = new DocumentSession(new FakeIO(io.content), timers);
		await reopened.load();
		expect(reopened.doc).toEqual(s.doc);
		expect(serialize(reopened.doc!)).toBe(io.content);
	});

	it("does not write when nothing changed", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		await s.flush();
		expect(io.writes).toHaveLength(0);
	});

	it("debounces saves and caps the wait during continuous writing", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const s = new DocumentSession(io, timers, {}, { debounceMs: 1000, maxWaitMs: 5000 });
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
		const s = new DocumentSession(io, timers);
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
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.mode).toBe("not-downloaded"); // wave 0.7 (#344): an empty file is not damaged, it is not downloaded yet
		await s.flush();
		expect(io.writes).toHaveLength(0);
		expect(io.backups).toHaveLength(0);
	});

	it("opens newer format versions read-only and never writes them", async () => {
		const future = JSON.stringify({ ...JSON.parse(serialize(sampleDocument(1))), version: CURRENT_VERSION + 1 });
		const io = new FakeIO(future);
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.mode).toBe("readonly");
		s.markChanged();
		await s.flush();
		expect(io.writes).toHaveLength(0);
		expect(io.backups[0]?.reason).toBe("future-version");
	});

	it("backs up an external change before overwriting it with local edits", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
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
		const s = new DocumentSession(io, timers);
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
		const s = new DocumentSession(io, timers, { onLoaded: loaded });
		await s.load();
		io.content = serialize(sampleDocument(3));
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.doc!.pages[0]!.strokes).toHaveLength(3);
		expect(loaded).toHaveBeenCalledTimes(2);
	});

	it("ignores the echo of its own write", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		await s.flush();
		expect(await s.handleExternalChange()).toBe("echo");
	});

	it("an external change that is unreadable puts the session in broken mode without writing", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
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
		const s = new DocumentSession(io, timers, { onError: errors }, { retryMs: 1000 });
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
		const s = new DocumentSession(io, timers);
		await s.load();
		// Committed strokes are frozen, so a corrupt stroke can only come from a bug that builds one.
		s.doc!.pages[0]!.strokes.push({ ...line(0, 0, 1, 1), points: [[Number.NaN, 0, 0.5]] }); // NaN serializes as null
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(io.writes).toHaveLength(0);
		expect(s.dirty).toBe(true);
	});

	it("backs up a racing external version before overwriting it", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		const sneaky = serialize(sampleDocument(2));
		io.beforeProcess = () => (io.content = sneaky);
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		expect(await s.flush()).toBe(true);
		expect(io.log).toEqual(["backup:conflict", "write"]);
	});

	it("gives up without overwriting if the file keeps changing", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers, { onError: vi.fn() });
		await s.load();
		let n = 0;
		io.keepBeforeProcess = true;
		io.beforeProcess = () => (io.content = serialize(sampleDocument(2 + (n++ % 5))));
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(io.writes).toHaveLength(0);
		expect(s.dirty).toBe(true);
	});

	it("does not overwrite an external version it could not back up", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers, { onError: vi.fn() });
		await s.load();
		const external = serialize(sampleDocument(3));
		io.content = external;
		io.failBackups = true;
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(io.content).toBe(external);
	});

	it("an external change seen during a flush is checked after it and is not reloaded over newer local data", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		const external = serialize(sampleDocument(4));
		// Sync writes between our pre-read and our write; its 'modify' event arrives meanwhile.
		io.beforeProcess = () => {
			io.content = external;
			void s.handleExternalChange();
		};
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		await s.flush();
		const verdict = await s.handleExternalChange();
		expect(verdict).toBe("echo");
		expect(s.doc!.pages[0]!.strokes).toHaveLength(2);
		expect(io.content).toBe(serialize(s.doc!));
		expect(io.backups.map((b) => b.content)).toContain(external);
	});

	it("flushForClose retries transient failures", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const s = new DocumentSession(io, timers, { onError: vi.fn() });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		io.failWrites = 2;
		expect(await s.flushForClose()).toBe(true);
		expect(s.dirty).toBe(false);
		expect(io.backups).toHaveLength(0);
	});

	it("flushForClose keeps unsaved changes as a backup when writing keeps failing", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const s = new DocumentSession(io, timers, { onError: vi.fn() });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		io.failWrites = 99;
		expect(await s.flushForClose()).toBe(true);
		expect(io.backups).toHaveLength(1);
		expect(io.backups[0]!.reason).toBe("unsaved");
		const kept = parse(io.backups[0]!.content);
		expect(kept.ok && kept.doc.pages[0]!.strokes).toHaveLength(1);
	});

	it("a deleted file is never written again; unsaved changes go to a backup", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		await s.markDeleted();
		expect(s.mode).toBe("deleted");
		await s.flush();
		await s.flushForClose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(io.writes).toHaveLength(0);
		expect(io.backups.map((b) => b.reason)).toEqual(["unsaved"]);
		expect(await s.handleExternalChange()).toBe("ignored");
	});

	it("does not reload an external change while a gesture is in progress", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		let busy = true;
		const s = new DocumentSession(io, timers, {}, { busy: () => busy });
		await s.load();
		const external = serialize(sampleDocument(3));
		io.content = external;
		expect(await s.handleExternalChange()).toBe("kept-local");
		busy = false;
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5)); // the gesture is committed
		s.markChanged();
		await s.flush();
		expect(io.backups.map((b) => b.content)).toEqual([external]);
		expect(parse(io.content).ok).toBe(true);
	});

	it("re-checks an external change deferred during a gesture that changed nothing", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		let busy = true;
		const s = new DocumentSession(io, timers, {}, { busy: () => busy });
		await s.load();
		const external = serialize(sampleDocument(3));
		io.content = external;
		expect(await s.handleExternalChange()).toBe("kept-local");
		busy = false; // e.g. a palm stroke that was cancelled
		s.gestureEnded();
		await s.flush(); // waits for the queued check
		expect(s.doc!.pages[0]!.strokes).toHaveLength(3);
		expect(io.writes).toHaveLength(0);
	});

	it("stops before writing if the file is deleted during a flush", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		const flushing = s.flush();
		void s.markDeleted();
		await flushing;
		expect(io.writes).toHaveLength(0);
	});

	it("a session disposed while loading does not report the load", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const loaded = vi.fn();
		const s = new DocumentSession(io, timers, { onLoaded: loaded });
		const p = s.load();
		s.dispose();
		await p;
		expect(loaded).not.toHaveBeenCalled();
	});

	it("does not reschedule after dispose", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const s = new DocumentSession(io, timers, {}, { debounceMs: 100 });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(0, 0, 5, 5));
		s.markChanged();
		s.dispose();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(io.writes).toHaveLength(0);
	});
});
