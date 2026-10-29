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
	journalKey,
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
	/** Vault path of the file; change it to simulate a rename. */
	filePath = "Notebooks/a.notebook";
	constructor(public content: string) {}
	path(): string {
		return this.filePath;
	}
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
	/** `<key>|<owner>|<slot>` -> text */
	files = new Map<string, string>();
	writeLog: Array<{ key: string; owner: string; slot: 0 | 1; size: number }> = [];
	failWrites = false;
	failReads = false;
	private readonly live = new Set<string>();
	private fileKey(key: string, owner: string, slot: number) {
		return `${key}|${owner}|${slot}`;
	}
	async read(key: string): Promise<JournalSlotFile[]> {
		if (this.failReads) throw new Error("plugin folder unreadable");
		const out: JournalSlotFile[] = [];
		for (const [k, text] of this.files) {
			const [fileKey, owner, slot] = k.split("|") as [string, string, string];
			if (fileKey === key && !this.live.has(owner)) out.push({ owner, slot: slot === "0" ? 0 : 1, text });
		}
		return out;
	}
	async write(key: string, owner: string, slot: 0 | 1, text: string): Promise<void> {
		if (this.failWrites) throw new Error("disk full");
		this.live.add(owner);
		this.files.set(this.fileKey(key, owner, slot), text);
		this.writeLog.push({ key, owner, slot, size: text.length });
	}
	async remove(key: string, owner: string): Promise<void> {
		this.files.delete(this.fileKey(key, owner, 0));
		this.files.delete(this.fileKey(key, owner, 1));
	}
	release(owner: string): void {
		this.live.delete(owner);
	}
	/** Plants a file as left by a session that died (not live). */
	put(docId: string, slot: 0 | 1, text: string, path = "", owner = "dead"): void {
		this.files.set(this.fileKey(journalKey(docId, path), owner, slot), text);
	}
	/** Files under one key. */
	under(docId: string, path = ""): string[] {
		const prefix = `${journalKey(docId, path)}|`;
		return [...this.files.keys()].filter((k) => k.startsWith(prefix));
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
		const r = inspectJournal([{ owner: "o", slot: 0, text: entry.text }], doc.id, text);
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
		const newestKey = [...journal.files.keys()].find((k) => k.endsWith(`|${newest}`))!;
		journal.files.set(newestKey, journal.files.get(newestKey)!.slice(0, 40));

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
		// The file now holds what the save wrote: byte for byte what the journal entry produces.
		expect(fingerprint(io.content)).toBe(decodeEntry([...saved.values()][0]!)!.result);

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
		journal.put(doc.doc.id, 0, "\u0000garbage{{{", io.filePath);
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
		journal.put(doc.doc.id, 0, JSON.stringify(tampered), io.filePath);
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

describe("journal review fixes", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const open = (io: FakeIO, journal: FakeJournal, events: SessionEvents = {}) => new DocumentSession(io, timers, events, { journal });
	const settle = async (...sessions: DocumentSession[]) => {
		await vi.advanceTimersByTimeAsync(300);
		for (const s of sessions) await s.journalIdle();
	};

	it("the same notebook open in two leaves: neither session deletes or overwrites the other's entries", async () => {
		const original = serialize(sampleDocument(1));
		const ioA = new FakeIO(original);
		const ioB = new FakeIO(original);
		const journal = new FakeJournal();
		const a = open(ioA, journal);
		const b = open(ioB, journal);
		await a.load();
		await b.load();
		a.doc!.pages[0]!.strokes.push(line(1, 1, 10, 10));
		a.markChanged();
		await settle(a);
		const aFiles = journal.under(a.doc!.id, ioA.filePath);
		expect(aFiles).toHaveLength(1);

		// B edits and saves; its cleanup must leave A's pending entry alone.
		b.doc!.pages[0]!.strokes.push(line(2, 2, 20, 20));
		b.markChanged();
		await b.flush();
		await b.journalIdle();
		expect(journal.under(a.doc!.id, ioA.filePath)).toEqual(aFiles);

		// A crashes (never flushes). The file was changed by B, so A's entry no longer fits: it is kept as a
		// backup copy, not applied to the wrong content.
		a.dispose();
		const c = open(ioB, journal);
		await c.load();
		expect(c.doc!.pages[0]!.strokes).toHaveLength(2);
		expect(ioB.backups.map((x) => x.reason)).toEqual(["journal"]);
	});

	it("a live session's entries are not offered to a session that opens the same file", async () => {
		const original = serialize(sampleDocument(1));
		const io = new FakeIO(original);
		const journal = new FakeJournal();
		const a = open(io, journal);
		await a.load();
		a.doc!.pages[0]!.strokes.push(line(1, 1, 10, 10));
		a.markChanged();
		await settle(a);
		const b = open(new FakeIO(original), journal);
		await b.load();
		expect(b.dirty).toBe(false);
		expect(journal.under(a.doc!.id, io.filePath)).toHaveLength(1);
	});

	it("two files with the same document id (a copy) have separate journals", async () => {
		const original = serialize(sampleDocument(1));
		const orig = new FakeIO(original);
		const copy = new FakeIO(original);
		copy.filePath = "Notebooks/a (copy).notebook";
		const journal = new FakeJournal();
		const a = open(orig, journal);
		const b = open(copy, journal);
		await a.load();
		await b.load();
		a.doc!.pages[0]!.strokes.push(line(1, 1, 10, 10));
		a.markChanged();
		b.doc!.pages[0]!.strokes.push(line(9, 9, 90, 90));
		b.markChanged();
		await settle(a, b);
		const id = a.doc!.id;
		expect(journal.under(id, orig.filePath)).toHaveLength(1);
		expect(journal.under(id, copy.filePath)).toHaveLength(1);
		const lostB = b.doc!.pages[0]!.strokes[1]!.id;
		a.dispose();
		b.dispose();

		// Crash: each file recovers its own edits.
		const a2 = open(orig, journal);
		const b2 = open(copy, journal);
		await a2.load();
		await b2.load();
		expect(a2.doc!.pages[0]!.strokes.some((s) => s.id === lostB)).toBe(false);
		expect(b2.doc!.pages[0]!.strokes.some((s) => s.id === lostB)).toBe(true);
	});

	it("inspect ignores an entry recorded for another path", () => {
		const doc = sampleDocument(1);
		const text = serialize(doc);
		const next = text + " ";
		const foreign = buildEntry(doc.id, 1, "t", text, splitLines(text), next, "Notebooks/other.notebook")!;
		expect(inspectJournal([{ owner: "o", slot: 0, text: foreign.text }], doc.id, text, "Notebooks/a.notebook").recovery.kind).toBe("none");
		const mine = buildEntry(doc.id, 1, "t", text, splitLines(text), next, "Notebooks/a.notebook")!;
		expect(inspectJournal([{ owner: "o", slot: 0, text: mine.text }], doc.id, text, "Notebooks/a.notebook").recovery.kind).not.toBe("none");
		expect(journalKey(doc.id, "a")).not.toBe(journalKey(doc.id, "b"));
	});

	it("a rename moves the journal to the new key at the next entry, and recovery finds it there", async () => {
		const original = serialize(sampleDocument(1));
		const io = new FakeIO(original);
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		const id = s.doc!.id;
		const oldPath = io.filePath;
		s.doc!.pages[0]!.strokes.push(line(1, 1, 10, 10));
		s.markChanged();
		await settle(s);
		expect(journal.under(id, oldPath)).toHaveLength(1);

		io.filePath = "Notebooks/renamed.notebook";
		const lost = line(5, 5, 50, 50);
		s.doc!.pages[0]!.strokes.push(lost);
		s.markChanged();
		await settle(s);
		expect(journal.under(id, oldPath)).toHaveLength(0);
		expect(journal.under(id, io.filePath)).toHaveLength(1);
		s.dispose();

		const second = open(io, journal);
		await second.load();
		expect(second.dirty).toBe(true);
		expect(second.doc!.pages[0]!.strokes.some((x) => x.id === lost.id)).toBe(true);
	});

	it("a rename followed by a save leaves no journal behind", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 10, 10));
		s.markChanged();
		await settle(s);
		io.filePath = "Notebooks/renamed.notebook";
		await s.flush();
		await s.journalIdle();
		expect(journal.files.size).toBe(0);
	});

	it("a file that goes from broken to readable is recovered from the journal", async () => {
		const original = serialize(sampleDocument(2));
		const io = new FakeIO(original);
		const journal = new FakeJournal();
		const first = open(io, journal);
		await first.load();
		const lost = line(5, 5, 60, 60);
		first.doc!.pages[0]!.strokes.push(lost);
		first.markChanged();
		await settle(first);
		first.dispose();

		// Sync truncated the file; the notebook opens as broken.
		io.content = original.slice(0, 120);
		const events = { onRecovered: vi.fn() };
		const second = open(io, journal, events);
		await second.load();
		expect(second.mode).toBe("broken");
		expect(journal.under(first.doc!.id, io.filePath)).toHaveLength(1);

		// Sync brings back the complete file.
		io.content = original;
		expect(await second.handleExternalChange()).toBe("reloaded");
		expect(second.mode).toBe("ok");
		expect(second.dirty).toBe(true);
		expect(second.doc!.pages[0]!.strokes.some((x) => x.id === lost.id)).toBe(true);
		expect(events.onRecovered).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		await second.journalIdle();
		expect(strokeCount(io.content)).toBe(3);
		expect(journal.files.size).toBe(0);
	});

	it("a deleted notebook whose unsaved changes could not be backed up keeps its journal", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = open(io, journal);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 5, 5));
		s.markChanged();
		await settle(s);
		expect(journal.files.size).toBe(1);
		io.failBackups = true;
		await s.markDeleted();
		expect(io.backups).toHaveLength(0);
		expect(journal.files.size).toBe(1);
	});

	describe("inspect with several entries", () => {
		function setup() {
			const base = serialize(sampleDocument(2));
			const parsed = parse(base);
			if (!parsed.ok) throw new Error("unreachable");
			const doc = parsed.doc;
			const lines = splitLines(base);
			const memo = new Map<number, string>();
			const withStroke = (n: number) => {
				if (!memo.has(n)) {
					const d = structuredClone(doc);
					d.pages[0]!.strokes.push(line(n, n, n + 40, n + 40));
					memo.set(n, serialize(d));
				}
				return memo.get(n)!;
			};
			return { base, doc, lines, withStroke };
		}

		it("applies the newest entry even when an older one equals the file", () => {
			const { doc, withStroke } = setup();
			const saved = withStroke(1);
			const older = buildEntry(doc.id, 1, "t", withStroke(0), splitLines(withStroke(0)), saved)!; // result == the file
			const newest = buildEntry(doc.id, 2, "t", saved, splitLines(saved), withStroke(2))!; // written after the save
			const r = inspectJournal(
				[{ owner: "o", slot: 0, text: older.text }, { owner: "o", slot: 1, text: newest.text }],
				doc.id, saved,
			).recovery;
			expect(r.kind).toBe("apply");
			if (r.kind === "apply") expect(r.text).toBe(withStroke(2));
		});

		it("backs up the newest entry when an older one is applied", () => {
			const { base, doc, lines, withStroke } = setup();
			const older = buildEntry(doc.id, 1, "t", base, lines, withStroke(1))!;
			// The newest entry was written against some other file content.
			const other = withStroke(7);
			const newest = buildEntry(doc.id, 2, "t", other, splitLines(other), withStroke(8))!;
			const r = inspectJournal(
				[{ owner: "o", slot: 0, text: older.text }, { owner: "o", slot: 1, text: newest.text }],
				doc.id, base,
			).recovery;
			expect(r.kind).toBe("apply");
			if (r.kind !== "apply") return;
			expect(r.backupText).toBe(withStroke(8));
		});

		it("backs up the newest entry when an older one is already merged", () => {
			const { base, doc, lines, withStroke } = setup();
			const saved = withStroke(1);
			const older = buildEntry(doc.id, 1, "t", base, lines, saved)!;
			const other = withStroke(7);
			const newest = buildEntry(doc.id, 2, "t", other, splitLines(other), withStroke(8))!;
			const r = inspectJournal(
				[{ owner: "o", slot: 0, text: older.text }, { owner: "o", slot: 1, text: newest.text }],
				doc.id, saved,
			).recovery;
			expect(r.kind).toBe("merged");
			if (r.kind !== "merged") return;
			expect(r.backupText).toBe(withStroke(8));
		});

		it("the session keeps that copy in the backup folder before deleting the journal", async () => {
			const { base, doc, lines, withStroke } = setup();
			const older = buildEntry(doc.id, 1, "t", base, lines, withStroke(1))!;
			const other = withStroke(7);
			const newest = buildEntry(doc.id, 2, "t", other, splitLines(other), withStroke(8))!;
			const io = new FakeIO(base);
			const journal = new FakeJournal();
			journal.put(doc.id, 0, older.text, io.filePath);
			journal.put(doc.id, 1, newest.text, io.filePath);
			const s = open(io, journal);
			await s.load();
			expect(s.dirty).toBe(true); // the older entry was applied
			expect(io.backups).toEqual([{ content: withStroke(8), reason: "journal" }]);
			await vi.advanceTimersByTimeAsync(2000);
			await s.journalIdle();
			expect(journal.files.size).toBe(0);
		});
	});

	it("a crash between the save and the journal cleanup is recognised as merged (no spurious backup)", async () => {
		// modifiedAt is set by the save: the journal entry must carry the same value as the saved file.
		let t = Date.parse("2026-10-29T12:00:00.000Z");
		const now = () => new Date((t += 50));
		const io = new FakeIO(serialize(sampleDocument(1)));
		const journal = new FakeJournal();
		const s = new DocumentSession(io, timers, {}, { journal, now });
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 10, 10));
		s.markChanged();
		await settle(s);
		const entryText = [...journal.files.values()][0]!;
		await s.flush();
		await s.journalIdle();
		expect(fingerprint(io.content)).toBe(decodeEntry(entryText)!.result);
		s.dispose();
		journal.put(s.doc!.id, 0, entryText, io.filePath);

		const second = open(io, journal);
		await second.load();
		expect(io.backups).toHaveLength(0);
		expect(second.dirty).toBe(false);
		expect(journal.files.size).toBe(0);
	});
});

function sampleStrokeIds(text: string): string[] {
	const r = parse(text);
	if (!r.ok) throw new Error("not a notebook");
	return r.doc.pages[0]!.strokes.map((s) => s.id);
}
