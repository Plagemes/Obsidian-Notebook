import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import type { NotebookDocument } from "../src/model/types";
import {
	DELTA_MAX_EDITS,
	FULL_BELOW_CHARS,
	applyHunks,
	buildEntry,
	decodeEntry,
	diffLines,
	fingerprint,
	fullWriteGapMs,
	inspectJournal,
	splitLines,
	type JournalSlotFile,
	type JournalStore,
} from "../src/storage/journal";
import { DocumentSession, type BackupReason, type DocumentIO, type SessionEvents, type Timers } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";

const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

class FakeIO implements DocumentIO {
	writes: string[] = [];
	backups: Array<{ content: string; reason: BackupReason }> = [];
	failBackups = false;
	duringProcess: (() => void) | null = null;
	constructor(public content: string) {}
	async read(): Promise<string> {
		return this.content;
	}
	async process(fn: (current: string) => string): Promise<void> {
		this.duringProcess?.();
		const next = fn(this.content);
		if (next !== this.content) {
			this.content = next;
			this.writes.push(next);
		}
	}
	async backup(content: string, reason: BackupReason): Promise<string | null> {
		if (this.failBackups) throw new Error("backup folder not writable");
		this.backups.push({ content, reason });
		return `backup-${this.backups.length}.bak`;
	}
}

/** In-memory journal files that survive across sessions, like the plugin folder does. */
class FakeJournal implements JournalStore {
	files = new Map<string, string>();
	writeLog: Array<{ slot: 0 | 1; size: number }> = [];
	failWrites = false;
	failReads = false;
	private key(docId: string, slot: number) {
		return `${docId}.${slot}`;
	}
	async read(docId: string): Promise<JournalSlotFile[]> {
		if (this.failReads) throw new Error("plugin folder unreadable");
		const out: JournalSlotFile[] = [];
		for (const slot of [0, 1] as const) {
			const text = this.files.get(this.key(docId, slot));
			if (text !== undefined) out.push({ slot, text });
		}
		return out;
	}
	async write(docId: string, slot: 0 | 1, text: string): Promise<void> {
		if (this.failWrites) throw new Error("disk full");
		this.files.set(this.key(docId, slot), text);
		this.writeLog.push({ slot, size: text.length });
	}
	async remove(docId: string): Promise<void> {
		this.files.delete(this.key(docId, 0));
		this.files.delete(this.key(docId, 1));
	}
}

function bigDocument(strokes = 1400): NotebookDocument {
	const doc = sampleDocument(0);
	const page = doc.pages[0]!;
	for (let i = 0; i < strokes; i++) page.strokes.push(line(i % 500, i % 700, 700 - (i % 400), (i * 3) % 900, 40));
	return doc;
}

function strokeCount(text: string): number {
	const r = parse(text);
	if (!r.ok) throw new Error("not a notebook");
	return r.doc.pages.reduce((n, p) => n + p.strokes.length, 0);
}

describe("line diff", () => {
	it("round-trips random edits", () => {
		let seed = 12345;
		const rnd = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (let round = 0; round < 200; round++) {
			const base = Array.from({ length: 5 + rnd(60) }, (_, i) => `line ${i}`);
			const next = base.slice();
			for (let e = rnd(8); e > 0; e--) {
				const at = rnd(next.length + 1);
				if (rnd(2) === 0) next.splice(at, rnd(4), ...Array.from({ length: rnd(4) }, () => `new ${rnd(1000)}`));
				else next.splice(at, 1 + rnd(3));
			}
			const hunks = diffLines(base, next)!;
			expect(hunks).not.toBeNull();
			expect(applyHunks(base, hunks)).toEqual(next);
		}
	});

	it("describes an appended stroke as one tiny hunk", () => {
		const base = Array.from({ length: 5000 }, (_, i) => `stroke ${i}`);
		const next = [...base.slice(0, 4000), "new stroke", ...base.slice(4000)];
		expect(diffLines(base, next)).toEqual([[4000, 0, ["new stroke"]]]);
	});

	it("gives up when too many lines differ", () => {
		const base = Array.from({ length: 3000 }, (_, i) => `a${i}`);
		const next = Array.from({ length: 3000 }, (_, i) => `b${i}`);
		expect(diffLines(base, next, DELTA_MAX_EDITS)).toBeNull();
	});

	it("rejects hunks that do not fit the base", () => {
		expect(applyHunks(["a", "b"], [[1, 5, []]])).toBeNull();
		expect(applyHunks(["a", "b"], [[2, 0, ["x"]], [1, 0, []]])).toBeNull();
	});
});

describe("journal entries", () => {
	it("uses full snapshots for small documents and compact deltas for large ones", () => {
		const small = serialize(sampleDocument(3));
		const smallNext = serialize({ ...sampleDocument(3) });
		const s = buildEntry("d", 1, "t", small, splitLines(small), smallNext)!;
		expect(s.full).toBe(true);

		const big = bigDocument();
		const base = serialize(big);
		expect(base.length).toBeGreaterThan(FULL_BELOW_CHARS);
		big.pages[0]!.strokes.push(line(1, 2, 3, 4, 40));
		const next = serialize(big);
		const d = buildEntry(big.id, 2, "t", base, splitLines(base), next)!;
		expect(d.full).toBe(false);
		expect(d.text.length).toBeLessThan(2000);
		const decoded = decodeEntry(d.text)!;
		expect(applyHunks(splitLines(base), decoded.hunks!)!.join("\n")).toBe(next);
	});

	it("falls back to a full snapshot when the change is huge, and skips absurdly large documents", () => {
		const big = bigDocument();
		const base = serialize(big);
		big.pages[0]!.strokes = big.pages[0]!.strokes.map((s) => line(s.points.length, 1, 2, 3, 40));
		const next = serialize(big);
		expect(buildEntry(big.id, 1, "t", base, splitLines(base), next)!.full).toBe(true);
		expect(buildEntry(big.id, 1, "t", base, splitLines(base), "x".repeat(9_000_000))).toBeNull();
	});

	it("rejects malformed entries", () => {
		expect(decodeEntry("nope")).toBeNull();
		expect(decodeEntry("{}")).toBeNull();
		expect(decodeEntry(JSON.stringify({ format: "notebook-journal", v: 1, doc: "d", seq: 1, savedAt: "t", base: "b", result: "r" }))).toBeNull();
	});

	it("throttles full writes in proportion to size", () => {
		expect(fullWriteGapMs(10_000)).toBeLessThan(10);
		expect(fullWriteGapMs(2_000_000)).toBeGreaterThan(300);
		expect(fullWriteGapMs(8_000_000)).toBeLessThanOrEqual(3000);
	});

	it("fingerprints differ for different texts", () => {
		expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
		expect(fingerprint("abc")).toBe(fingerprint("abc"));
	});

	it("inspect ignores entries of another document", () => {
		const doc = sampleDocument(1);
		const text = serialize(doc);
		const entry = buildEntry("other", 1, "t", text, splitLines(text), text + " ")!;
		const r = inspectJournal([{ slot: 0, text: entry.text }], doc.id, text);
		expect(r.recovery.kind).toBe("none");
	});
});

describe("DocumentSession journal", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function open(io: FakeIO, journal: FakeJournal, events: SessionEvents = {}, extra: { busy?: () => boolean } = {}) {
		return new DocumentSession(io, timers, events, { journal, ...extra });
	}

	it("records a change within the journal delay, long before the regular save", async () => {
		const io = new FakeIO(serialize(sampleDocument(2)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 50, 50));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(150);
		expect(journal.files.size).toBe(0);
		await vi.advanceTimersByTimeAsync(100);
		expect(journal.files.size).toBe(1);
		expect(io.writes).toHaveLength(0);
	});

	it("a change in a continuous stream of strokes is never older than the journal delay", async () => {
		const io = new FakeIO(serialize(sampleDocument(0)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		for (let i = 0; i < 10; i++) {
			s.doc!.pages[0]!.strokes.push(line(i, 0, i, 20));
			s.markChanged();
			await vi.advanceTimersByTimeAsync(100);
		}
		await vi.advanceTimersByTimeAsync(300);
		await s.journalIdle();
		// Alternating slots, so a torn write always leaves the previous entry intact.
		expect(new Set(journal.writeLog.map((w) => w.slot)).size).toBe(2);
		for (let i = 1; i < journal.writeLog.length; i++) expect(journal.writeLog[i]!.slot).not.toBe(journal.writeLog[i - 1]!.slot);
	});

	it("crash: edits journaled but never saved are restored when the notebook is opened again", async () => {
		const original = serialize(sampleDocument(2));
		const io = new FakeIO(original);
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		const lost = [line(5, 5, 60, 60), line(7, 9, 80, 30)];
		first.doc!.pages[0]!.strokes.push(...lost);
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		// Android kills the app here: no flush, the timers are gone.
		expect(io.content).toBe(original);
		first.dispose();

		const events = { onRecovered: vi.fn(), onSaveState: vi.fn(), onLoaded: vi.fn() };
		const second = open(io, journal, events);
		await second.load();
		expect(second.mode).toBe("ok");
		expect(second.dirty).toBe(true);
		expect(second.doc!.pages[0]!.strokes.map((s) => s.id)).toEqual([...sampleStrokeIds(original), ...lost.map((s) => s.id)]);
		expect(events.onRecovered).toHaveBeenCalledTimes(1);
		expect(events.onLoaded).toHaveBeenCalledTimes(1);
		expect(events.onSaveState).toHaveBeenLastCalledWith("pending");
		// The journal is kept until the regular save succeeded.
		expect(journal.files.size).toBeGreaterThan(0);

		await vi.advanceTimersByTimeAsync(2000);
		await second.journalIdle();
		expect(second.dirty).toBe(false);
		expect(strokeCount(io.content)).toBe(4);
		expect(journal.files.size).toBe(0);
	});

	it("crash with a large notebook: the delta journal restores the lost stroke", async () => {
		const big = bigDocument();
		const original = serialize(big);
		const io = new FakeIO(original);
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		const lost = line(9, 9, 99, 99, 40);
		first.doc!.pages[0]!.strokes.push(lost);
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		const size = [...journal.files.values()].reduce((n, t) => n + t.length, 0);
		expect(size).toBeLessThan(5000); // a 7-stroke-line change, not a 400 KB snapshot
		first.dispose();

		const second = open(io, journal);
		await second.load();
		const restored = second.doc!.pages[0]!.strokes;
		expect(restored[restored.length - 1]!.id).toBe(lost.id);
		expect(second.doc!.pages[0]!.strokes).toHaveLength(1401);
		await second.flush();
		expect(strokeCount(io.content)).toBe(1401);
		expect(journal.files.size).toBe(0);
	});

	it("restores edits that include erased and replaced strokes", async () => {
		const big = bigDocument();
		const io = new FakeIO(serialize(big));
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		const strokes = first.doc!.pages[0]!.strokes;
		strokes.splice(10, 3);
		strokes.splice(700, 1, line(1, 1, 2, 2, 40), line(3, 3, 4, 4, 40));
		const expected = strokes.map((s) => s.id);
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		first.dispose();

		const second = open(io, journal);
		await second.load();
		expect(second.doc!.pages[0]!.strokes.map((s) => s.id)).toEqual(expected);
	});

	it("uses the newest complete entry when the last write was torn", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		first.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		first.doc!.pages[0]!.strokes.push(line(2, 2, 6, 6));
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		first.dispose();
		// The second write was cut short by the kill.
		const newest = journal.writeLog[journal.writeLog.length - 1]!.slot;
		journal.files.set(`${first.doc!.id}.${newest}`, journal.files.get(`${first.doc!.id}.${newest}`)!.slice(0, 40));

		const second = open(io, journal);
		await second.load();
		expect(second.doc!.pages[0]!.strokes).toHaveLength(2); // original + first journaled stroke
		expect(second.dirty).toBe(true);
	});

	it("never applies a journal whose base is not the file on disk; keeps a copy and reports it", async () => {
		const io = new FakeIO(serialize(sampleDocument(2)));
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		const lost = line(5, 5, 60, 60);
		first.doc!.pages[0]!.strokes.push(lost);
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		first.dispose();

		// Meanwhile another device changed the file (Sync).
		const other = parse(io.content);
		if (!other.ok) throw new Error("unreachable");
		other.doc.pages[0]!.strokes.push(line(100, 100, 200, 200));
		io.content = serialize(other.doc);
		const external = io.content;

		const onBackup = vi.fn();
		const second = open(io, journal, { onBackup });
		await second.load();
		expect(second.dirty).toBe(false);
		expect(serialize(second.doc!)).toBe(external);
		expect(io.writes).toHaveLength(0);
		expect(io.backups).toHaveLength(1);
		expect(io.backups[0]!.reason).toBe("journal");
		// The copy is a complete notebook containing the lost stroke.
		const copy = parse(io.backups[0]!.content);
		expect(copy.ok && copy.doc.pages[0]!.strokes.some((s) => s.id === lost.id)).toBe(true);
		expect(onBackup).toHaveBeenCalledWith("backup-1.bak", "journal");
		expect(journal.files.size).toBe(0);
	});

	it("a delta journal that no longer fits keeps its raw entry as the backup", async () => {
		const io = new FakeIO(serialize(bigDocument()));
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		first.doc!.pages[0]!.strokes.push(line(9, 9, 99, 99, 40));
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		first.dispose();
		const rawEntry = [...journal.files.values()][0]!;

		const other = parse(io.content);
		if (!other.ok) throw new Error("unreachable");
		other.doc.pages[0]!.strokes.shift();
		io.content = serialize(other.doc);

		const second = open(io, journal);
		await second.load();
		expect(second.dirty).toBe(false);
		expect(io.backups).toEqual([{ content: rawEntry, reason: "journal" }]);
		expect(journal.files.size).toBe(0);
	});

	it("keeps the journal when the copy of a stale one cannot be made", async () => {
		const io = new FakeIO(serialize(sampleDocument(2)));
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		first.doc!.pages[0]!.strokes.push(line(5, 5, 60, 60));
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		first.dispose();
		const before = new Map(journal.files);

		io.content = io.content.replace('"modifiedAt"', '"modifiedAt"') + "\n";
		const other = parse(io.content);
		if (!other.ok) throw new Error("unreachable");
		other.doc.pages[0]!.strokes.pop();
		io.content = serialize(other.doc);
		io.failBackups = true;

		const onError = vi.fn();
		const second = open(io, journal, { onError });
		await second.load();
		expect(second.mode).toBe("ok");
		second.doc!.pages[0]!.strokes.push(line(1, 2, 3, 4));
		second.markChanged();
		await vi.advanceTimersByTimeAsync(2500);
		await second.journalIdle();
		expect(onError).toHaveBeenCalled();
		expect(journal.files).toEqual(before); // untouched, even after the regular save
	});

	it("a journal already contained in the file (crash after the save) is just deleted", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		first.doc!.pages[0]!.strokes.push(line(5, 5, 60, 60));
		first.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		await first.journalIdle();
		const saved = new Map(journal.files);
		await first.flush();
		await first.journalIdle();
		expect(journal.files.size).toBe(0);
		first.dispose();
		// The kill happened between the file write and the cleanup: the entry is still there.
		for (const [k, v] of saved) journal.files.set(k, v);
		const entry = decodeEntry([...saved.values()][0]!)!;
		// Make the file equal to what the journal produces (as if the save had landed).
		io.content = entry.full!;

		const events = { onRecovered: vi.fn() };
		const second = open(io, journal, events);
		await second.load();
		expect(second.dirty).toBe(false);
		expect(events.onRecovered).not.toHaveBeenCalled();
		expect(io.backups).toHaveLength(0);
		expect(journal.files.size).toBe(0);
	});

	it("removes the journal after a successful flush, and not before", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(5, 5, 60, 60));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		expect(journal.files.size).toBe(1);
		await vi.advanceTimersByTimeAsync(1500);
		await s.journalIdle();
		expect(io.writes).toHaveLength(1);
		expect(journal.files.size).toBe(0);
	});

	it("keeps the journal if the regular save fails", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		io.process = async () => {
			throw new Error("disk full");
		};
		s.doc!.pages[0]!.strokes.push(line(5, 5, 60, 60));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(2000);
		await s.journalIdle();
		expect(s.dirty).toBe(true);
		expect(journal.files.size).toBe(1);
	});

	it("changes made while a save is running are re-journaled against the new file", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		s.markChanged();
		io.duringProcess = () => {
			io.duringProcess = null;
			s.doc!.pages[0]!.strokes.push(line(2, 2, 6, 6));
			s.markChanged();
		};
		await s.flush();
		await s.journalIdle();
		expect(s.dirty).toBe(true);
		const entries = [...journal.files.values()].map((t) => decodeEntry(t)!);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.base).toBe(fingerprint(io.content));
		s.dispose();

		const second = open(io, journal);
		await second.load();
		expect(second.doc!.pages[0]!.strokes).toHaveLength(3);
	});

	it("a failing journal never blocks or breaks the regular save", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		journal.failWrites = true;
		const onError = vi.fn();
		const s = open(io, journal, { onError });
		await s.load();
		for (let i = 0; i < 4; i++) {
			s.doc!.pages[0]!.strokes.push(line(i, i, 50, 50));
			s.markChanged();
			await vi.advanceTimersByTimeAsync(400);
		}
		await vi.advanceTimersByTimeAsync(2000);
		expect(s.dirty).toBe(false);
		expect(strokeCount(io.content)).toBe(5);
		// One notice, not one per attempt.
		expect(onError.mock.calls.filter(([m]) => String(m).includes("journal"))).toHaveLength(1);
	});

	it("starts normally when the journal cannot be read", async () => {
		const io = new FakeIO(serialize(sampleDocument(2)));
		const journal = new FakeJournal();
		journal.failReads = true;
		const onError = vi.fn();
		const s = open(io, journal, { onError });
		await s.load();
		expect(s.mode).toBe("ok");
		expect(s.dirty).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("ignores an unreadable journal safely, keeping a copy of it", async () => {
		const original = serialize(sampleDocument(2));
		const io = new FakeIO(original);
		const doc = parse(original);
		if (!doc.ok) throw new Error("unreachable");
		const journal = new FakeJournal();
		journal.files.set(`${doc.doc.id}.0`, "\u0000garbage{{{");
		const s = open(io, journal);
		await s.load();
		expect(s.mode).toBe("ok");
		expect(s.dirty).toBe(false);
		expect(serialize(s.doc!)).toBe(original);
		expect(io.writes).toHaveLength(0);
		expect(io.backups).toEqual([{ content: "\u0000garbage{{{", reason: "journal" }]);
		expect(journal.files.size).toBe(0);
	});

	it("rejects a well-formed entry whose content does not match its fingerprint", async () => {
		const original = serialize(sampleDocument(1));
		const io = new FakeIO(original);
		const doc = parse(original);
		if (!doc.ok) throw new Error("unreachable");
		const forged = buildEntry(doc.doc.id, 5, "t", original, splitLines(original), original.replace('"pen"', '"highlighter"'))!;
		const tampered = { ...forged.entry, full: original.replace('"pen"', '"highlighter"').slice(0, -5) };
		const journal = new FakeJournal();
		journal.files.set(`${doc.doc.id}.0`, JSON.stringify(tampered));
		const s = open(io, journal);
		await s.load();
		expect(s.dirty).toBe(false);
		expect(serialize(s.doc!)).toBe(original);
	});

	it("large documents: full snapshots for huge changes are throttled", async () => {
		const big = bigDocument(1800);
		const io = new FakeIO(serialize(big));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		const rewrite = () => {
			s.doc!.pages[0]!.strokes = s.doc!.pages[0]!.strokes.map((st, i) => line(i % 300, 1, 2, 3, 40));
			s.markChanged();
		};
		rewrite();
		await vi.advanceTimersByTimeAsync(300);
		await s.journalIdle();
		expect(journal.writeLog).toHaveLength(1);
		const first = decodeEntry([...journal.files.values()][0]!)!;
		expect(first.full).toBeDefined();
		rewrite();
		await vi.advanceTimersByTimeAsync(150);
		await s.journalIdle();
		// Written a full snapshot ~500 KB just now: the next one waits for the throttle gap.
		const gap = fullWriteGapMs(first.full!.length);
		expect(gap).toBeGreaterThan(100);
		expect(journal.writeLog).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(gap + 500);
		await s.journalIdle();
		expect(journal.writeLog.length).toBeGreaterThanOrEqual(2);
	});

	it("does not serialize while a gesture is in progress", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		let busy = true;
		const s = open(io, journal, {}, { busy: () => busy });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(600);
		expect(journal.files.size).toBe(0);
		busy = false;
		await vi.advanceTimersByTimeAsync(150);
		await s.journalIdle();
		expect(journal.files.size).toBe(1);
	});

	it("a deleted notebook loses its journal; unsaved changes go to the backup", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		expect(journal.files.size).toBe(1);
		await s.markDeleted();
		expect(io.backups.map((b) => b.reason)).toEqual(["unsaved"]);
		expect(journal.files.size).toBe(0);
	});

	it("flushForClose leaves no journal behind", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(300);
		expect(await s.flushForClose()).toBe(true);
		s.dispose();
		expect(journal.files.size).toBe(0);
		expect(strokeCount(io.content)).toBe(2);
	});

	it("without a journal the session behaves as before", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		s.markChanged();
		await vi.advanceTimersByTimeAsync(2000);
		expect(strokeCount(io.content)).toBe(2);
		await s.journalIdle();
	});
});

function sampleStrokeIds(text: string): string[] {
	const r = parse(text);
	if (!r.ok) throw new Error("not a notebook");
	return r.doc.pages[0]!.strokes.map((s) => s.id);
}
