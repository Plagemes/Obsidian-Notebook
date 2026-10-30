import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stressDocument } from "../src/model/stress";
import { parse, parseStaged, serialize, STAGED_MIN_CHARS, StagedParse } from "../src/model/serialize";
import { CURRENT_VERSION, type NotebookDocument } from "../src/model/types";
import { journalKey, type JournalSlotFile, type JournalStore } from "../src/storage/journal";
import { DocumentSession, type BackupReason, type DocumentIO, type SessionMode, type Timers } from "../src/storage/session";

const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

const BIG_STROKES = 3300;

/** 6 pages, a little over the limit for staged loading. */
function bigText(strokes = BIG_STROKES, pages = 6): string {
	const text = serialize(stressDocument(strokes, pages));
	expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
	return text;
}

function strokeIds(doc: NotebookDocument): string[][] {
	return doc.pages.map((p) => p.strokes.map((s) => s.id));
}

describe("parseStaged", () => {
	const text = bigText();
	const full = parse(text);

	it("parses small files in one go", () => {
		const small = serialize(stressDocument(20, 2));
		const r = parseStaged(small, 2);
		expect(r instanceof StagedParse).toBe(false);
		expect(r).toEqual(parse(small));
	});

	it("returns a staged parse for a large file: the wanted page in full, stand-ins elsewhere", () => {
		const staged = parseStaged(text, 3);
		if (!(staged instanceof StagedParse)) throw new Error("expected a staged parse");
		if (!full.ok) throw new Error("fixture does not parse");
		expect(staged.doc.pages).toHaveLength(full.doc.pages.length);
		expect(staged.pending).toBe(full.doc.pages.length - 1);
		expect(staged.done).toBe(false);
		staged.doc.pages.forEach((p, i) => {
			const whole = full.doc.pages[i]!;
			// Every page has its id, size and paper from the start.
			expect([p.id, p.width, p.height, p.paper]).toEqual([whole.id, whole.width, whole.height, whole.paper]);
			if (i === 2) expect(p.strokes.length).toBe(whole.strokes.length);
			else expect(p.strokes).toHaveLength(0);
		});
		expect(staged.doc.meta).toEqual(full.doc.meta);
		expect(staged.doc.assets).toEqual(full.doc.assets);
	});

	it("reads the other pages nearest first and ends with exactly the document a full parse gives", () => {
		const staged = parseStaged(text, 3);
		if (!(staged instanceof StagedParse)) throw new Error("expected a staged parse");
		const order: number[] = [];
		let guard = 0;
		for (; !staged.done && guard < 20; guard++) {
			const step = staged.step(0);
			if (!step.ok) throw new Error(step.failure.message);
			order.push(...step.changed);
		}
		// Page 3 (index 2) first, then forward and back alternately.
		expect(order).toEqual([3, 1, 4, 0, 5]);
		if (!full.ok) throw new Error("fixture does not parse");
		expect(serialize(staged.doc)).toBe(serialize(full.doc));
		expect(strokeIds(staged.doc)).toEqual(strokeIds(full.doc));
		expect(staged.done).toBe(true);
	});

	it("step keeps to its time budget but always reads at least one page", () => {
		const staged = parseStaged(text, null);
		if (!(staged instanceof StagedParse)) throw new Error("expected a staged parse");
		let t = 0;
		const clock = () => (t += 1);
		const first = staged.step(1000, clock);
		expect(first.ok && first.changed.length).toBe(5); // plenty of budget: all of them
		const again = parseStaged(text, null) as StagedParse;
		t = 0;
		const one = again.step(0, clock);
		expect(one.ok && one.changed.length).toBe(1);
	});

	it("finish reads what is left", () => {
		const staged = parseStaged(text, 6) as StagedParse;
		const r = staged.finish();
		expect(r.ok).toBe(true);
		if (r.ok && full.ok) expect(serialize(r.doc)).toBe(serialize(full.doc));
		expect(staged.pending).toBe(0);
	});

	it("clamps a page that does not exist", () => {
		expect(parseStaged(text, 99) instanceof StagedParse).toBe(true);
		expect(parseStaged(text, 0) instanceof StagedParse).toBe(true);
	});

	it("a damaged page is found no later than the end of the load, with the same verdict as a full parse", () => {
		const doc = stressDocument(BIG_STROKES, 6);
		doc.pages[4]!.strokes[3] = { ...doc.pages[4]!.strokes[3]!, color: "red" };
		const broken = serialize(doc);
		expect(parse(broken).ok).toBe(false);
		const staged = parseStaged(broken, 1);
		if (!(staged instanceof StagedParse)) throw new Error("the first page is fine: expected a staged parse");
		const r = staged.finish();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("invalid");
			expect(r.message).toContain("pages[4].strokes[3].color");
		}
		// Asking again keeps failing.
		expect(staged.step(5).ok).toBe(false);
		expect(staged.done).toBe(false);
	});

	it("a damaged wanted page fails at once, like a full parse", () => {
		const broken = text.replace(/"color": ?"#[0-9a-fA-F]{6}"/, '"color": "red"');
		const r = parseStaged(broken, 1);
		expect(r instanceof StagedParse).toBe(false);
		expect((r as { ok: boolean }).ok).toBe(false);
		expect(parse(broken).ok).toBe(false);
	});

	it("still finds a stroke id used on two pages", () => {
		const doc = stressDocument(BIG_STROKES, 6);
		doc.pages[4]!.strokes[0] = { ...doc.pages[4]!.strokes[0]!, id: doc.pages[0]!.strokes[0]!.id };
		const dup = serialize(doc);
		expect(parse(dup).ok).toBe(false);
		const staged = parseStaged(dup, 2) as StagedParse;
		const r = staged.finish();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/duplicate id/);
	});

	it("still finds two pages with one id, before anything is shown", () => {
		const doc = stressDocument(BIG_STROKES, 6);
		doc.pages[3]!.id = doc.pages[1]!.id;
		const r = parseStaged(serialize(doc), 1);
		expect(r instanceof StagedParse).toBe(false);
		expect((r as { ok: boolean }).ok).toBe(false);
	});

	it("v7 fields (reading position, page tags) are validated and kept exactly as a full parse does", () => {
		const doc = stressDocument(BIG_STROKES, 6);
		doc.pages[2]!.tags = ["exam", "chapter 2"];
		doc.position = { page: doc.pages[4]!.id, y: 120.5, at: "2026-10-30T10:00:00.000Z" };
		const text = serialize(doc);
		const full = parse(text);
		if (!full.ok) throw new Error("fixture");
		expect(full.doc.position).toEqual(doc.position);
		const staged = parseStaged(text, 2) as StagedParse;
		// The document-level fields are there at once; page tags arrive with the page.
		expect(staged.doc.position).toEqual(doc.position);
		expect(staged.finish().ok).toBe(true);
		expect(serialize(staged.doc)).toBe(serialize(full.doc));
		expect(staged.doc.pages[2]!.tags).toEqual(["exam", "chapter 2"]);
		// A position on a page that does not exist is dropped, as in a full parse.
		const stray = text.replace(doc.pages[4]!.id + '"', "gone-page" + '"');
		expect(stray).not.toBe(text);
		const a = parse(stray);
		const b = parseStaged(stray, 1);
		const bDoc = b instanceof StagedParse ? (b.finish(), b.doc) : null;
		expect(a.ok).toBe(true);
		expect(bDoc).not.toBeNull();
	});

	it("invalid optional v7 details are dropped and counted exactly like the lenient full parse; everything else still fails", () => {
		const raw = JSON.parse(text);
		const firstId = raw.pages[0].id as string;
		raw.meta.bookmarkInfo = { [firstId]: { title: 3, color: "red", category: "x" } };
		raw.position = { page: firstId, y: "far", at: "2026-10-30T10:00:00.000Z" };
		const damaged = JSON.stringify(raw, null, 1);
		expect(damaged.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const whole = parse(damaged);
		if (!whole.ok) throw new Error("the lenient parse should accept it");
		expect(whole.dropped).toBeGreaterThan(0);
		const staged = parseStaged(damaged, 3) as StagedParse;
		const result = staged.finish();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dropped).toBe(whole.dropped);
		expect(serialize(result.doc)).toBe(serialize(whole.doc));
		// A damaged required field is still fatal.
		raw.pages[2].width = -1;
		expect(parse(JSON.stringify(raw, null, 1)).ok).toBe(false);
		expect((parseStaged(JSON.stringify(raw, null, 1), 3) as { ok: boolean }).ok).toBe(false);
	});

	it("an older format that needs migrating is parsed completely", () => {
		// v10: v9 files are staged too (tests/excerpt-live.test.ts); v8 and older still need the full migration.
		const old = text.replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION - 2}`);
		const r = parseStaged(old, 2);
		expect(r instanceof StagedParse).toBe(false);
		expect(r).toMatchObject({ ok: true, migratedFrom: CURRENT_VERSION - 2 });
	});

	it("files from a newer version and damaged files are reported without staging", () => {
		expect(parseStaged(text.replace(`"version": ${CURRENT_VERSION}`, '"version": 99'), 1)).toMatchObject({ ok: false, reason: "future-version" });
		expect(parseStaged(text.slice(0, text.length - 40), 1)).toMatchObject({ ok: false, reason: "json" });
	});
});

class FakeIO implements DocumentIO {
	writes: string[] = [];
	backups: Array<{ content: string; reason: BackupReason }> = [];
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
	async backup(content: string, reason: BackupReason): Promise<string | null> {
		this.backups.push({ content, reason });
		return `backup-${this.backups.length}.bak`;
	}
	path(): string {
		return "Notebooks/Big.notebook";
	}
}

describe("DocumentSession staged load", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	/** Lets the load run up to the point where the partial document is out and the first slice is waiting. */
	async function untilPartial(partials: unknown[]): Promise<void> {
		for (let i = 0; i < 50 && partials.length === 0; i++) await Promise.resolve();
		expect(partials).toHaveLength(1);
	}

	function record(io: FakeIO, journal?: JournalStore) {
		const log: string[] = [];
		const partials: NotebookDocument[] = [];
		const progress: number[][] = [];
		const loaded: Array<{ doc: NotebookDocument | null; mode: SessionMode; problem: string | null }> = [];
		const s = new DocumentSession(io, timers, {
			onPartial: (doc) => {
				log.push("partial");
				partials.push(doc);
			},
			onPartialProgress: (pages) => {
				log.push("progress");
				progress.push(pages);
			},
			onLoaded: (doc, mode, problem) => {
				log.push(`loaded:${mode}`);
				loaded.push({ doc, mode, problem });
			},
		}, { journal });
		return { s, log, partials, progress, loaded };
	}

	it("shows the page first, then reads the rest, then becomes editable with the complete document", async () => {
		const text = bigText();
		const io = new FakeIO(text);
		const { s, log, partials, progress, loaded } = record(io);
		const loading = s.load({ staged: true, page: 4 });
		await untilPartial(partials);
		// The partial document is out, nothing else yet.
		expect(log).toEqual(["partial"]);
		expect(s.mode).toBe("loading");
		expect(s.doc).toBeNull();
		expect(s.partialDoc).toBe(partials[0]);
		expect(partials[0]!.pages[3]!.strokes.length).toBeGreaterThan(0);
		expect(partials[0]!.pages[0]!.strokes).toHaveLength(0);
		await vi.runAllTimersAsync();
		await loading;
		expect(s.mode).toBe("ok");
		expect(s.partialDoc).toBeNull();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]!.mode).toBe("ok");
		// The same document object the view was already showing, now complete and equal to a full parse.
		expect(s.doc).toBe(partials[0]);
		const full = parse(text);
		if (!full.ok) throw new Error("fixture");
		expect(serialize(s.doc!)).toBe(serialize(full.doc));
		expect(progress.flat().sort()).toEqual([0, 1, 2, 4, 5]);
		expect(log.indexOf("partial")).toBeLessThan(log.indexOf("progress"));
		expect(log[log.length - 1]).toBe("loaded:ok");
		expect(io.writes).toHaveLength(0);
		// It saves like any other session once loaded, and the saved file is complete.
		s.doc!.pages[0]!.strokes.length = 0;
		s.markChanged();
		expect(await s.flush()).toBe(true);
		expect(io.writes).toHaveLength(1);
		expect(parse(io.content).ok).toBe(true);
		s.dispose();
	});

	it("cannot be edited or saved while it is still loading", async () => {
		const io = new FakeIO(bigText());
		const { s, partials } = record(io);
		const loading = s.load({ staged: true, page: 1 });
		await untilPartial(partials);
		s.markChanged();
		expect(s.dirty).toBe(false);
		const flushed = s.flush();
		await vi.runAllTimersAsync();
		await loading;
		expect(await flushed).toBe(true);
		expect(io.writes).toHaveLength(0);
		s.dispose();
	});

	it("a page that turns out to be damaged ends the load like a damaged file: backup, no document, nothing written", async () => {
		const doc = stressDocument(BIG_STROKES, 6);
		// Page 6 has a stroke without points.
		doc.pages[5]!.strokes[0] = { ...doc.pages[5]!.strokes[0]!, points: [] };
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const io = new FakeIO(text);
		const { s, loaded, log } = record(io);
		const loading = s.load({ staged: true, page: 1 });
		await vi.runAllTimersAsync();
		await loading;
		expect(log[0]).toBe("partial");
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toMatchObject({ doc: null, mode: "broken" });
		expect(loaded[0]!.problem).toMatch(/points/);
		expect(s.doc).toBeNull();
		expect(s.partialDoc).toBeNull();
		expect(io.backups).toEqual([{ content: text, reason: "unreadable" }]);
		expect(io.writes).toHaveLength(0);
		s.dispose();
	});

	it("closing during the load stops it without waiting and without writing", async () => {
		const io = new FakeIO(bigText());
		const { s, loaded, partials } = record(io);
		const loading = s.load({ staged: true, page: 1 });
		await untilPartial(partials);
		const closed = s.flushForClose();
		await vi.runAllTimersAsync();
		expect(await closed).toBe(true);
		await loading;
		expect(loaded).toHaveLength(0);
		expect(s.doc).toBeNull();
		expect(io.writes).toHaveLength(0);
		s.dispose();
	});

	it("without the staged option, or for a small file, nothing is announced early", async () => {
		const { s, log } = record(new FakeIO(bigText()));
		await s.load();
		expect(log).toEqual(["loaded:ok"]);
		s.dispose();
		const small = record(new FakeIO(serialize(stressDocument(30, 2))));
		await small.s.load({ staged: true, page: 2 });
		expect(small.log).toEqual(["loaded:ok"]);
		small.s.dispose();
	});

	it("a notebook with edits in the journal is loaded completely, so they can be merged", async () => {
		const text = bigText();
		const full = parse(text);
		if (!full.ok) throw new Error("fixture");
		const asked: string[] = [];
		const journal: JournalStore = {
			async read(key: string): Promise<JournalSlotFile[]> {
				asked.push(key);
				// A leftover file that is not a valid entry: the session backs it up and goes on.
				return [{ owner: "dead", slot: 0, text: "not a journal entry" }];
			},
			async write() { /* not needed */ },
			async remove() { /* not needed */ },
			release() { /* not needed */ },
		};
		const io = new FakeIO(text);
		const { s, log } = record(io, journal);
		await s.load({ staged: true, page: 3 });
		expect(asked[0]).toBe(journalKey(full.doc.id, "Notebooks/Big.notebook"));
		expect(log).not.toContain("partial");
		expect(s.mode).toBe("ok");
		expect(serialize(s.doc!)).toBe(serialize(full.doc));
		s.dispose();
	});

	it("an empty journal does not stop the staged load", async () => {
		const journal: JournalStore = {
			async read() { return []; },
			async write() { /* not needed */ },
			async remove() { /* not needed */ },
			release() { /* not needed */ },
		};
		const { s, log } = record(new FakeIO(bigText()), journal);
		const loading = s.load({ staged: true, page: 2 });
		await vi.runAllTimersAsync();
		await loading;
		expect(log[0]).toBe("partial");
		expect(s.mode).toBe("ok");
		s.dispose();
	});
});

describe("DocumentSession staged load: robustness", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("a close that comes before the first slice, even before the file is read, is not forgotten", async () => {
		const io = new FakeIO(bigText());
		const loaded: string[] = [];
		const s = new DocumentSession(io, timers, { onLoaded: (_d, mode) => loaded.push(mode) });
		const loading = s.load({ staged: true, page: 1 });
		const closed = s.flushForClose(); // the load has not even started reading
		await vi.runAllTimersAsync();
		expect(await closed).toBe(true);
		await loading;
		expect(loaded).toHaveLength(0);
		expect(s.doc).toBeNull();
		expect(io.writes).toHaveLength(0);
		s.dispose();
	});

	it("a view callback that throws does not leave the load hanging", async () => {
		const io = new FakeIO(bigText());
		const errors: string[] = [];
		const loaded: string[] = [];
		const s = new DocumentSession(io, timers, {
			onPartial: () => {
				throw new Error("view broke");
			},
			onPartialProgress: () => {
				throw new Error("view broke again");
			},
			onLoaded: (_d, mode) => loaded.push(mode),
			onError: (m) => errors.push(m),
		});
		const loading = s.load({ staged: true, page: 2 });
		await vi.runAllTimersAsync();
		await loading;
		expect(loaded).toEqual(["ok"]);
		expect(s.mode).toBe("ok");
		expect(errors.length).toBeGreaterThan(0);
		s.dispose();
	});

	it("staging is only for the first load: a reload of an open session is parsed completely", async () => {
		const text = bigText();
		const io = new FakeIO(text);
		const partials: unknown[] = [];
		const s = new DocumentSession(io, timers, { onPartial: (d) => partials.push(d) });
		const first = s.load({ staged: true, page: 1 });
		await vi.runAllTimersAsync();
		await first;
		expect(partials).toHaveLength(1);
		const again = s.load({ staged: true, page: 1 });
		await vi.runAllTimersAsync();
		await again;
		expect(partials).toHaveLength(1);
		s.dispose();
	});
});
