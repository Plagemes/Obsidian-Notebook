import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import type { JournalSlotFile, JournalStore } from "../src/storage/journal";
import { DocumentSession, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import {
	assessAfterFailure, backoffDelay, classifyWriteError, probeSize, PROBE_MARGIN_CHARS, TornWriteError, WriteHealth,
	type SpaceProbe, type WriteHealthState,
} from "../src/storage/write-guard";
import { line, sampleDocument } from "./helpers";

const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

function enospc(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}

/**
 * A vault file on a device whose storage can fill up. `freeChars` is the room left: a write that needs more than the
 * room throws ENOSPC; with `tearOnFull` it first truncates the file and writes what fits (as fs.writeFile does).
 */
class FullDiskIO implements DocumentIO {
	processCalls = 0;
	backups: Array<{ content: string; reason: BackupReason }> = [];
	freeChars = Number.POSITIVE_INFINITY;
	tearOnFull = false;
	/** Writes "succeed" but store only this many characters (a silent partial write). */
	silentTruncateTo: number | null = null;
	/** Any other error to throw from process(). */
	failWith: Error | null = null;
	failBackups = false;

	constructor(public content: string) {}

	async read(): Promise<string> {
		return this.content;
	}

	async process(fn: (current: string) => string): Promise<void> {
		this.processCalls++;
		if (this.failWith) throw this.failWith;
		const next = fn(this.content);
		if (next === this.content) return;
		const room = this.freeChars + this.content.length;
		if (next.length > room) {
			if (this.tearOnFull) {
				this.content = next.slice(0, Math.max(0, room));
				this.freeChars = 0;
			}
			throw enospc();
		}
		this.freeChars -= next.length - this.content.length;
		this.content = this.silentTruncateTo !== null ? next.slice(0, this.silentTruncateTo) : next;
	}

	async backup(content: string, reason: BackupReason): Promise<string | null> {
		if (this.failBackups || content.length > this.freeChars) throw enospc();
		this.freeChars -= content.length;
		this.backups.push({ content, reason });
		return `backup-${this.backups.length}.bak`;
	}
}

class MemJournal implements JournalStore {
	files = new Map<string, string>();
	fail = false;
	async read(): Promise<JournalSlotFile[]> {
		return [];
	}
	async write(key: string, owner: string, slot: 0 | 1, text: string): Promise<void> {
		if (this.fail) throw enospc();
		this.files.set(`${key}|${owner}|${slot}`, text);
	}
	async remove(key: string, owner: string): Promise<void> {
		this.files.delete(`${key}|${owner}|0`);
		this.files.delete(`${key}|${owner}|1`);
	}
	release(): void {}
}

function addStroke(s: DocumentSession, x = 0): void {
	s.doc!.pages[0]!.strokes.push(line(x, 0, x + 50, 50, 40));
	s.markChanged();
}

describe("write-guard (pure)", () => {
	it("classifies full-storage errors from Node, Capacitor, the browser and SQLite", () => {
		expect(classifyWriteError(enospc())).toBe("no-space");
		expect(classifyWriteError(new Error("Error: No space left on device"))).toBe("no-space");
		expect(classifyWriteError({ name: "QuotaExceededError", message: "The quota has been exceeded." })).toBe("no-space");
		expect(classifyWriteError(new Error("SQLITE_FULL: database or disk is full"))).toBe("no-space");
		expect(classifyWriteError(new Error("Not enough storage is available to process this command"))).toBe("no-space");
		expect(classifyWriteError("ENOSPC")).toBe("no-space");
	});

	it("classifies read-only and permission errors, and never guesses a full disk", () => {
		expect(classifyWriteError(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }))).toBe("read-only");
		expect(classifyWriteError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))).toBe("permission");
		expect(classifyWriteError(new Error("Operation not permitted"))).toBe("permission");
		expect(classifyWriteError(new Error("the file keeps changing on disk"))).toBe("other");
		expect(classifyWriteError(null)).toBe("other");
		expect(classifyWriteError(new TornWriteError())).toBe("torn");
	});

	it("backs off exponentially up to the cap", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n, 5000, 60000))).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000]);
		expect(backoffDelay(0, 1000, 8000)).toBe(1000);
		expect(backoffDelay(1e9, 1000, 8000)).toBe(8000);
		// A cap below the base never shortens the first wait.
		expect(backoffDelay(3, 5000, 1000)).toBe(5000);
	});

	it("probes for the growth of the file plus a margin", () => {
		expect(probeSize("aaaa", "aaaaaaaaaa")).toBe(6 + PROBE_MARGIN_CHARS);
		expect(probeSize("aaaaaaaaaa", "aa")).toBe(PROBE_MARGIN_CHARS);
	});

	it("tells an untouched file, a write that landed and a partial file apart", () => {
		expect(assessAfterFailure("old", "new text", "old")).toBe("unchanged");
		expect(assessAfterFailure("old", "new text", "new text")).toBe("written");
		expect(assessAfterFailure("old", "new text", "new t")).toBe("torn");
		expect(assessAfterFailure("old", "new text", "")).toBe("torn");
	});

	it("WriteHealth tracks a streak, its kind and when to retry", () => {
		const h = new WriteHealth(1000, 4000);
		expect(h.failing).toBe(false);
		expect(h.retryDue(0)).toBe(true);
		expect(h.recordFailure(enospc(), 100)).toEqual({ delayMs: 1000, changed: true });
		expect(h.needsProbe).toBe(true);
		expect(h.retryDue(500)).toBe(false);
		expect(h.retryDue(1100)).toBe(true);
		expect(h.recordFailure(enospc(), 1100)).toEqual({ delayMs: 2000, changed: false });
		// An unspecific error during a full-disk streak keeps the known cause.
		expect(h.recordFailure(new Error("weird"), 3100)).toEqual({ delayMs: 4000, changed: false });
		const st = h.state();
		expect(st).toMatchObject({ failing: true, kind: "no-space", failures: 3, since: 100, nextRetryAt: 7100 });
		expect(h.recordSuccess()).toBe(true);
		expect(h.state()).toMatchObject({ failing: false, kind: null, failures: 0, nextRetryAt: null });
		expect(h.recordSuccess()).toBe(false);
		expect(h.recordFailure(new Error("EACCES: permission denied"), 0).changed).toBe(true);
		expect(h.needsProbe).toBe(false);
	});
});

describe("DocumentSession on a full or failing disk (#347)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function open(io: FullDiskIO, extra: { journal?: JournalStore; spaceProbe?: SpaceProbe; retryMaxMs?: number } = {}) {
		const health: WriteHealthState[] = [];
		const errors: string[] = [];
		const written: string[] = [];
		const s = new DocumentSession(io, timers, {
			onWriteHealth: (st) => health.push(st),
			onError: (m) => errors.push(m),
			onWritten: (t) => written.push(t),
		}, { retryMs: 1000, retryMaxMs: extra.retryMaxMs ?? 8000, journal: extra.journal, spaceProbe: extra.spaceProbe });
		return { s, health, errors, written };
	}

	it("keeps the edits in memory and in the journal, warns once and retries with backoff until space is freed", async () => {
		const good = serialize(sampleDocument(1));
		const io = new FullDiskIO(good);
		const journal = new MemJournal();
		const { s, health, errors, written } = open(io, { journal });
		await s.load();
		io.freeChars = 0;
		addStroke(s);
		expect(await s.flush()).toBe(false);
		expect(io.content).toBe(good);
		expect(s.dirty).toBe(true);
		expect(s.doc!.pages[0]!.strokes).toHaveLength(2);
		expect(health[health.length - 1]).toMatchObject({ failing: true, kind: "no-space", failures: 1 });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/storage is full/);
		// The journal still got the edit (it lives elsewhere and may have room).
		await vi.advanceTimersByTimeAsync(300);
		await s.journalIdle();
		expect(journal.files.size).toBe(1);

		const calls = () => io.processCalls;
		const before = calls();
		await vi.advanceTimersByTimeAsync(699); // 1st retry 1 s after the failure
		expect(calls()).toBe(before);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls()).toBe(before + 1);
		await vi.advanceTimersByTimeAsync(1999); // 2nd retry is 2 s later
		expect(calls()).toBe(before + 1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls()).toBe(before + 2);
		expect(errors).toHaveLength(1); // one warning for the whole streak
		expect(health[health.length - 1]).toMatchObject({ failing: true, failures: 3 });

		io.freeChars = Number.POSITIVE_INFINITY;
		await vi.advanceTimersByTimeAsync(4000);
		expect(s.dirty).toBe(false);
		expect(health[health.length - 1]).toMatchObject({ failing: false, failures: 0 });
		const reread = parse(io.content);
		expect(reread.ok && reread.doc.pages[0]!.strokes).toHaveLength(2);
		expect(written).toEqual([io.content]);
		await s.journalIdle();
		expect(journal.files.size).toBe(0);
	});

	it("timed saves of new edits wait for the backoff instead of hammering a full disk", async () => {
		const io = new FullDiskIO(serialize(sampleDocument(1)));
		const { s } = open(io, { retryMaxMs: 60000 });
		await s.load();
		io.freeChars = 0;
		addStroke(s);
		await s.flush();
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(2000);
		const calls = io.processCalls; // 3 attempts, next due in 4 s
		for (let i = 0; i < 6; i++) {
			addStroke(s, i * 10);
			await vi.advanceTimersByTimeAsync(500); // edits every 0.5 s; the 1.5 s debounce never wins
		}
		expect(io.processCalls).toBe(calls); // nothing before the backoff retry, due 4 s after the 3rd attempt
		await vi.advanceTimersByTimeAsync(1000);
		expect(io.processCalls).toBe(calls + 1);
		expect(s.doc!.pages[0]!.strokes).toHaveLength(8);
	});

	it("never leaves a partial file: a torn write is undone by writing the previous content back", async () => {
		const good = serialize(sampleDocument(3));
		const io = new FullDiskIO(good);
		io.tearOnFull = true;
		const { s, health } = open(io);
		await s.load();
		io.freeChars = 2000; // the old file fits again, the bigger new one does not
		for (let i = 0; i < 20; i++) addStroke(s, i);
		expect(await s.flush()).toBe(false);
		expect(io.content).toBe(good);
		expect(parse(io.content).ok).toBe(true);
		expect(health[health.length - 1]).toMatchObject({ failing: true, kind: "no-space", diskDamaged: false });
		expect(s.dirty).toBe(true);
		expect(io.backups).toHaveLength(0);
	});

	it("a partial file that cannot be undone is recognised as ours, never backed up as a conflict, and replaced once there is room", async () => {
		const good = serialize(sampleDocument(3));
		const io = new FullDiskIO(good);
		io.tearOnFull = true;
		const { s, health } = open(io);
		await s.load();
		io.freeChars = 10;
		// The restore fails too: process() always throws while the disk is full.
		const realProcess = io.process.bind(io);
		let restoreBlocked = true;
		io.process = async (fn) => {
			if (io.processCalls > 0 && restoreBlocked && io.content !== good && !parse(io.content).ok) {
				io.processCalls++;
				throw enospc();
			}
			return realProcess(fn);
		};
		for (let i = 0; i < 5; i++) addStroke(s, i);
		expect(await s.flush()).toBe(false);
		const torn = io.content;
		expect(torn).not.toBe(good);
		expect(parse(torn).ok).toBe(false);
		expect(health[health.length - 1]).toMatchObject({ failing: true, diskDamaged: true });
		// Its 'modify' event is the echo of our own partial write, not someone else's version.
		expect(await s.handleExternalChange()).toBe("echo");
		// While still full: no conflict backup of our own partial file.
		expect(await s.flush()).toBe(false);
		expect(io.backups).toHaveLength(0);
		restoreBlocked = false;
		io.freeChars = Number.POSITIVE_INFINITY;
		expect(await s.flush()).toBe(true);
		expect(io.backups).toHaveLength(0);
		const back = parse(io.content);
		expect(back.ok && back.doc.pages[0]!.strokes).toHaveLength(8);
		expect(health[health.length - 1]).toMatchObject({ failing: false, diskDamaged: false });
	});

	it("echo of our own partial file is not reloaded when there are no other changes", async () => {
		const good = serialize(sampleDocument(1));
		const io = new FullDiskIO(good);
		const { s } = open(io);
		await s.load();
		addStroke(s);
		io.silentTruncateTo = 50;
		const realProcess = io.process.bind(io);
		// The repair write also lands truncated: the partial file stays.
		io.process = async (fn) => realProcess(fn);
		expect(await s.flush()).toBe(false);
		expect(io.content.length).toBe(50);
		// The session still holds the edits; the partial file is not an external version.
		expect(await s.handleExternalChange()).toBe("echo");
		expect(s.doc!.pages[0]!.strokes).toHaveLength(2);
	});

	it("a write that returns but stores a partial file is caught by the read-back, undone and retried", async () => {
		const good = serialize(sampleDocument(2));
		const io = new FullDiskIO(good);
		const { s, health } = open(io);
		await s.load();
		addStroke(s);
		let first = true;
		const realProcess = io.process.bind(io);
		io.process = async (fn) => {
			if (first) {
				first = false;
				io.silentTruncateTo = 100;
				try {
					return await realProcess(fn);
				} finally {
					io.silentTruncateTo = null;
				}
			}
			return realProcess(fn);
		};
		expect(await s.flush()).toBe(false);
		expect(io.content).toBe(good);
		expect(health[health.length - 1]).toMatchObject({ failing: true, kind: "torn" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.dirty).toBe(false);
		expect(parse(io.content).ok).toBe(true);
	});

	it("after a full disk, the file is not touched until the space probe succeeds", async () => {
		const good = serialize(sampleDocument(1));
		const io = new FullDiskIO(good);
		const probes: number[] = [];
		let room = false;
		const spaceProbe: SpaceProbe = {
			probe: async (chars) => {
				probes.push(chars);
				if (!room) throw enospc();
			},
		};
		const { s, health } = open(io, { spaceProbe });
		await s.load();
		io.freeChars = 0;
		addStroke(s);
		await s.flush(); // first failure: no probe yet (nothing was known)
		expect(probes).toHaveLength(0);
		const calls = io.processCalls;
		await s.flush();
		await s.flush();
		expect(probes).toHaveLength(2);
		expect(probes[0]).toBeGreaterThanOrEqual(PROBE_MARGIN_CHARS);
		expect(io.processCalls).toBe(calls); // never written while the probe fails
		expect(health[health.length - 1]).toMatchObject({ kind: "no-space", failures: 3 });
		room = true;
		io.freeChars = Number.POSITIVE_INFINITY;
		expect(await s.flush()).toBe(true);
		expect(io.content).not.toBe(good);
		// Healthy again: no more probes.
		addStroke(s, 30);
		await s.flush();
		expect(probes).toHaveLength(3);
	});

	it("reports read-only and permission problems by kind", async () => {
		const io = new FullDiskIO(serialize(sampleDocument(1)));
		const { s, health, errors } = open(io);
		await s.load();
		io.failWith = Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
		addStroke(s);
		await s.flush();
		expect(health[health.length - 1]?.kind).toBe("permission");
		expect(errors[0]).toMatch(/cannot be written/);
	});

	it("closing on a full disk keeps the document in memory and reports that nothing could be kept", async () => {
		const good = serialize(sampleDocument(1));
		const io = new FullDiskIO(good);
		const { s } = open(io);
		await s.load();
		io.freeChars = 0;
		addStroke(s);
		expect(await s.flushForClose()).toBe(false);
		expect(io.content).toBe(good);
		expect(s.doc!.pages[0]!.strokes).toHaveLength(2);
		expect(s.dirty).toBe(true);
	});

	it("closing with room for a backup but not for the file keeps an unsaved backup", async () => {
		const good = serialize(sampleDocument(1));
		const io = new FullDiskIO(good);
		const { s } = open(io);
		await s.load();
		addStroke(s);
		io.failWith = enospc();
		expect(await s.flushForClose()).toBe(true);
		expect(io.backups.map((b) => b.reason)).toEqual(["unsaved"]);
		expect(io.content).toBe(good);
	});

	it("a valid version written by someone else right after our write is not a partial write", async () => {
		const io = new FullDiskIO(serialize(sampleDocument(1)));
		const { s, health } = open(io);
		await s.load();
		addStroke(s);
		const external = serialize(sampleDocument(4));
		const realProcess = io.process.bind(io);
		io.process = async (fn) => {
			await realProcess(fn);
			io.content = external;
		};
		expect(await s.flush()).toBe(true);
		expect(health.filter((h) => h.failing)).toHaveLength(0);
		expect(s.dirty).toBe(false);
	});
});
