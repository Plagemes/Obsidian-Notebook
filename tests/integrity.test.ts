import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchNotebookMeta } from "../src/library/host-logic";
import { parse, serialize } from "../src/model/serialize";
import { CURRENT_VERSION, type NotebookDocument } from "../src/model/types";
import {
	assessDisk, bodyFingerprint, checkNotebookText, headerField, IntegrityLedger, isSuspicious, LEDGER_SAVE_DELAY_MS, MAX_LEDGER_FILES,
	restoredSince, RING_SIZE, writtenRecord, type DiskState,
} from "../src/storage/integrity";
import { DocumentSession, type BackupReason, type DiskContentInfo, type DocumentIO, type Timers } from "../src/storage/session";
import type { LocalSlot } from "../src/storage/safe-mode";
import { line, sampleDocument } from "./helpers";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

class Slot implements LocalSlot {
	data: unknown = null;
	saves = 0;
	load(): unknown {
		return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
	}
	save(data: unknown): void {
		this.saves++;
		this.data = JSON.parse(JSON.stringify(data));
	}
}

const P = "Notebooks/Physics.notebook";

function disk(text: string): DiskState {
	const r = parse(text);
	return r.ok ? { text, doc: r.doc, failure: null } : { text, doc: null, failure: r.reason };
}

/** A save by this plugin: new content and a new modifiedAt. */
function edit(doc: NotebookDocument, at: string, x = 0): string {
	doc.pages[0]!.strokes.push(line(x, 0, x + 40, 40));
	doc.modifiedAt = at;
	return serialize(doc);
}

function clone(text: string): NotebookDocument {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r.doc;
}

describe("integrity ledger and verdicts (#390)", () => {
	let now = 1_000_000;
	const clock = () => now;

	it("reads the id and modifiedAt from the serialized header", () => {
		const text = serialize(sampleDocument(1));
		const doc = clone(text);
		expect(headerField(text, "id")).toBe(doc.id);
		expect(headerField(text, "modifiedAt")).toBe(doc.modifiedAt);
		expect(writtenRecord("not a notebook", 1)).toBeNull();
	});

	it("the content fingerprint ignores metadata and the reading position, not the pages", () => {
		const text = serialize(sampleDocument(2));
		const patched = patchNotebookMeta(text, { favorite: true, tags: ["exam"] });
		expect(patched.ok && patched.changed).toBe(true);
		if (!patched.ok) return;
		expect(bodyFingerprint(patched.text)).toBe(bodyFingerprint(text));
		const doc = clone(text);
		doc.pages[0]!.strokes.pop();
		expect(bodyFingerprint(serialize(doc))).not.toBe(bodyFingerprint(text));
	});

	it("nothing recorded: unknown; our last write: intact", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const text = serialize(sampleDocument(1));
		expect(assessDisk(ledger.records(P), disk(text)).kind).toBe("unknown");
		ledger.recordWrite(P, text);
		expect(assessDisk(ledger.records(P), disk(text)).kind).toBe("intact");
	});

	it("never flags a normal edit synced from another device", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const doc = sampleDocument(1);
		const ours = edit(doc, "2026-10-29T10:05:00.000Z");
		ledger.recordWrite(P, ours);
		// The tablet opens our version and writes a stroke later.
		const theirs = edit(clone(ours), "2026-10-29T10:09:00.000Z", 100);
		expect(assessDisk(ledger.records(P), disk(theirs)).kind).toBe("changed");
		// ...also when the tablet's clock runs behind ours.
		const skewed = edit(clone(ours), "2026-10-29T10:01:00.000Z", 200);
		expect(assessDisk(ledger.records(P), disk(skewed)).kind).toBe("changed");
		// ...and when it deleted strokes.
		const smaller = clone(ours);
		smaller.pages[0]!.strokes = [];
		smaller.modifiedAt = "2026-10-29T10:10:00.000Z";
		expect(assessDisk(ledger.records(P), disk(serialize(smaller))).kind).toBe("changed");
	});

	it("never flags a metadata patch (library tags or favourite) that keeps modifiedAt", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const ours = edit(sampleDocument(1), "2026-10-29T10:05:00.000Z");
		ledger.recordWrite(P, ours);
		const patched = patchNotebookMeta(ours, { tags: ["physics"] });
		if (!patched.ok) throw new Error("patch failed");
		expect(assessDisk(ledger.records(P), disk(patched.text)).kind).toBe("changed");
	});

	it("flags a sync client putting back an older version this device wrote", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const doc = sampleDocument(1);
		const v1 = edit(doc, "2026-10-29T10:01:00.000Z", 10);
		now += 60_000;
		ledger.recordWrite(P, v1);
		const v2 = edit(doc, "2026-10-29T10:02:00.000Z", 20);
		now += 60_000;
		ledger.recordWrite(P, v2);
		const verdict = assessDisk(ledger.records(P), disk(v1));
		expect(verdict.kind).toBe("rolled-back");
		expect(isSuspicious(verdict)).toBe(true);
		if (verdict.kind === "rolled-back") {
			expect(verdict.version.modifiedAt).toBe("2026-10-29T10:01:00.000Z");
			expect(verdict.lastWrite.modifiedAt).toBe("2026-10-29T10:02:00.000Z");
		}
	});

	it("a version-history restore after our last write explains an older version", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const doc = sampleDocument(1);
		const v1 = edit(doc, "2026-10-29T10:01:00.000Z", 10);
		ledger.recordWrite(P, v1);
		ledger.recordWrite(P, edit(doc, "2026-10-29T10:02:00.000Z", 20));
		const since: number[] = [];
		const verdict = assessDisk(ledger.records(P), disk(v1), (t) => (since.push(t), true));
		expect(verdict.kind).toBe("changed");
		expect(since).toEqual([now]);
	});

	it("flags content that changed under the same modifiedAt as our last write", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const ours = edit(sampleDocument(2), "2026-10-29T10:05:00.000Z");
		ledger.recordWrite(P, ours);
		const mangled = clone(ours);
		mangled.pages[0]!.strokes.splice(1, 1); // a stroke gone, but the edit stamp says nothing happened
		const verdict = assessDisk(ledger.records(P), disk(serialize(mangled)));
		expect(verdict.kind).toBe("altered");
	});

	it("a text that no longer parses after our write is unreadable; a newer format version is not damage", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const ours = serialize(sampleDocument(3));
		ledger.recordWrite(P, ours);
		expect(assessDisk(ledger.records(P), disk(ours.slice(0, ours.length / 2))).kind).toBe("unreadable");
		expect(assessDisk(ledger.records(P), disk("")).kind).toBe("unreadable");
		const future = ours.replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		expect(disk(future).failure).toBe("future-version");
		expect(assessDisk(ledger.records(P), disk(future)).kind).toBe("changed");
	});

	it("another notebook under the same path is not reported", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		ledger.recordWrite(P, serialize(sampleDocument(1)));
		const other = sampleDocument(1);
		other.id = "another-notebook";
		expect(assessDisk(ledger.records(P), disk(serialize(other))).kind).toBe("changed");
	});

	it("'Keep this version' makes the text on disk the reference", () => {
		const ledger = new IntegrityLedger(new Slot(), clock);
		const doc = sampleDocument(1);
		const v1 = edit(doc, "2026-10-29T10:01:00.000Z", 10);
		ledger.recordWrite(P, v1);
		ledger.recordWrite(P, edit(doc, "2026-10-29T10:02:00.000Z", 20));
		expect(assessDisk(ledger.records(P), disk(v1)).kind).toBe("rolled-back");
		ledger.accept(P, v1);
		expect(assessDisk(ledger.records(P), disk(v1)).kind).toBe("intact");
		ledger.accept(P, "garbage");
		expect(assessDisk(ledger.records(P), disk(v1)).kind).toBe("intact");
	});

	it("persists per device, keeps a few versions per notebook and a bounded number of notebooks", () => {
		const slot = new Slot();
		const ledger = new IntegrityLedger(slot, clock);
		const doc = sampleDocument(0);
		for (let i = 0; i < RING_SIZE + 3; i++) ledger.recordWrite(P, edit(doc, `2026-10-29T10:${String(10 + i)}:00.000Z`, i));
		expect(ledger.records(P)).toHaveLength(RING_SIZE);
		// Writing the same text twice does not push older versions out.
		const latest = serialize(doc);
		ledger.recordWrite(P, latest);
		expect(ledger.records(P)).toHaveLength(RING_SIZE);
		const reread = new IntegrityLedger(slot, clock);
		expect(reread.records(P)).toEqual(ledger.records(P));
		for (let i = 0; i < MAX_LEDGER_FILES + 5; i++) {
			now++;
			reread.recordWrite(`n${i}.notebook`, latest);
		}
		expect(new IntegrityLedger(slot, clock).records(P)).toHaveLength(0); // the least recently written went first
		expect(new IntegrityLedger(slot, clock).records(`n${MAX_LEDGER_FILES + 4}.notebook`)).toHaveLength(1);
	});

	it("follows renames, forgets deleted notebooks and ignores unreadable stored data", () => {
		const slot = new Slot();
		const ledger = new IntegrityLedger(slot, clock);
		const text = serialize(sampleDocument(1));
		ledger.recordWrite(P, text);
		ledger.rename(P, "Notebooks/Renamed.notebook");
		expect(ledger.records(P)).toHaveLength(0);
		expect(ledger.records("Notebooks/Renamed.notebook")).toHaveLength(1);
		ledger.forget("Notebooks/Renamed.notebook");
		expect(new IntegrityLedger(slot, clock).records("Notebooks/Renamed.notebook")).toHaveLength(0);
		for (const data of [7, { v: 2, files: {} }, { v: 1, files: { [P]: "x" } }, { v: 1, files: { [P]: [{ fp: 1 }] } }]) {
			const s = new Slot();
			s.data = data;
			expect(new IntegrityLedger(s, clock).records(P)).toHaveLength(0);
		}
		const throwing: LocalSlot = { load: () => { throw new Error("no"); }, save: () => { throw new Error("quota"); } };
		expect(() => new IntegrityLedger(throwing, clock).recordWrite(P, text)).not.toThrow();
	});

	it("saves are throttled when a scheduler is given, and flush() saves at once", () => {
		const slot = new Slot();
		const pending: Array<() => void> = [];
		const ledger = new IntegrityLedger(slot, clock, (fn, ms) => {
			expect(ms).toBe(LEDGER_SAVE_DELAY_MS);
			pending.push(fn);
			return pending.length;
		});
		const doc = sampleDocument(0);
		for (let i = 0; i < 5; i++) ledger.recordWrite(P, edit(doc, `2026-10-29T11:0${i}:00.000Z`, i));
		expect(slot.saves).toBe(0);
		expect(pending).toHaveLength(1);
		pending[0]!();
		expect(slot.saves).toBe(1);
		ledger.recordWrite(P, edit(doc, "2026-10-29T11:09:00.000Z", 9));
		ledger.flush();
		expect(slot.saves).toBe(2);
	});

	it("recognises version-history restore backups of the notebook made after a time", () => {
		const since = new Date(2026, 9, 29, 10, 0, 0).getTime();
		const names = [
			"Physics 20261029-095000 before-restore 1a2b3c4d.bak",
			"Physics 2 20261029-101000 before-restore 1a2b3c4d.bak",
			"Physics 20261029-101000 conflict 1a2b3c4d.bak",
		];
		expect(restoredSince(names, "Physics", since)).toBe(false);
		expect(restoredSince([...names, "Physics 20261029-100500 before-restore 2 0badf00d.bak"], "Physics", since)).toBe(true);
		// A minute of slack for the second-resolution, local-time name.
		expect(restoredSince(["Physics 20261029-095930 before-restore 0badf00d.bak"], "Physics", since)).toBe(true);
	});
});

describe("check of a notebook (command Check notebooks integrity)", () => {
	const pdf = { id: "a".repeat(64), kind: "pdf" as const, path: "Notebooks/_assets/aaa.pdf", name: "Slides.pdf", bytes: 1000 };
	const img = { id: "b".repeat(64), kind: "image" as const, path: "Notebooks/_assets/bbb.png", name: "Photo.png", bytes: 500 };

	function withAssets(): string {
		const doc = sampleDocument(1);
		doc.assets = { [pdf.id]: pdf, [img.id]: img };
		doc.pages[0]!.background = { kind: "pdf", asset: pdf.id, page: 1 };
		return serialize(doc);
	}

	it("a healthy notebook has no issues", () => {
		const r = checkNotebookText(withAssets(), { assetFile: (a) => ({ size: a.bytes }) });
		expect(r.issues).toEqual([]);
		expect(r.pages).toBe(1);
		expect(r.docId).not.toBeNull();
	});

	it("reports missing asset files and asset files of the wrong size", () => {
		const r = checkNotebookText(withAssets(), { assetFile: (a) => (a.kind === "pdf" ? null : { size: a.bytes + 12 }) });
		expect(r.issues).toEqual([{ kind: "missing-asset", detail: "Slides.pdf" }, { kind: "damaged-asset", detail: "Photo.png" }]);
	});

	it("review: an empty or smaller asset file is still arriving, not damaged", () => {
		const small = checkNotebookText(withAssets(), { assetFile: (a) => ({ size: a.kind === "pdf" ? 0 : Math.max(1, a.bytes - 1) }) });
		expect(small.issues).toEqual([{ kind: "waiting-asset", detail: "Slides.pdf" }, { kind: "waiting-asset", detail: "Photo.png" }]);
	});

	it("review: a 0-byte or NUL-filled notebook is reported as not downloaded, not as unreadable", () => {
		for (const text of ["", "\0".repeat(64), "  \n"]) {
			const r = checkNotebookText(text, { assetFile: () => null });
			expect(r.issues).toEqual([{ kind: "not-downloaded" }]);
		}
	});

	it("reports unreadable and newer-version files with the parse message", () => {
		const text = withAssets();
		const r = checkNotebookText(text.slice(0, 300), { assetFile: () => null });
		expect(r.issues[0]?.kind).toBe("unreadable");
		expect(r.issues[0]?.detail).toBeTruthy();
		expect(r.docId).toBe(headerField(text, "id"));
		const future = text.replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		expect(checkNotebookText(future, { assetFile: () => null }).issues.map((i) => i.kind)).toEqual(["future-version"]);
	});

	it("reports a rolled-back version from the ledger", () => {
		const ledger = new IntegrityLedger(new Slot(), () => 5);
		const doc = sampleDocument(1);
		const v1 = edit(doc, "2026-10-29T10:01:00.000Z", 1);
		ledger.recordWrite(P, v1);
		ledger.recordWrite(P, edit(doc, "2026-10-29T10:02:00.000Z", 2));
		const r = checkNotebookText(v1, { assetFile: () => null, records: ledger.records(P) });
		expect(r.issues.map((i) => i.kind)).toEqual(["rolled-back"]);
		expect(checkNotebookText(v1, { assetFile: () => null, records: ledger.records(P), explainedByRestore: () => true }).issues).toEqual([]);
	});
});

describe("DocumentSession hooks for the ledger", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const timers: Timers = { set: (fn, ms) => nodeSetTimeout(fn, ms), clear: (h) => nodeClearTimeout(h) };

	class IO implements DocumentIO {
		constructor(public content: string) {}
		async read(): Promise<string> {
			return this.content;
		}
		async process(fn: (c: string) => string): Promise<void> {
			this.content = fn(this.content);
		}
		async backup(content: string, reason: BackupReason): Promise<string | null> {
			void content;
			void reason;
			return null;
		}
	}

	it("onWritten reports exactly the saved file text, and the next open of it is intact", async () => {
		const io = new IO(serialize(sampleDocument(1)));
		const ledger = new IntegrityLedger(new Slot());
		const seen: DiskContentInfo[] = [];
		const s = new DocumentSession(io, timers, {
			onWritten: (text) => ledger.recordWrite(P, text),
			onDiskContent: (info) => seen.push(info),
		});
		await s.load();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ initial: true, previous: null, failure: null });
		s.doc!.pages[0]!.strokes.push(line(1, 1, 9, 9));
		s.markChanged();
		await s.flush();
		expect(ledger.records(P)[0]?.fp).toBe(writtenRecord(io.content, 0)?.fp);
		const next = new DocumentSession(new IO(io.content), timers, {
			onDiskContent: (info) => seen.push(info),
		});
		await next.load();
		const info = seen[1]!;
		expect(assessDisk(ledger.records(P), { text: info.content, doc: info.doc, failure: info.failure }).kind).toBe("intact");
	});

	it("onDiskContent on a reload carries the version being replaced", async () => {
		const io = new IO(serialize(sampleDocument(1)));
		const seen: DiskContentInfo[] = [];
		const s = new DocumentSession(io, timers, { onDiskContent: (info) => seen.push(info) });
		await s.load();
		const first = io.content;
		io.content = serialize(sampleDocument(4));
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(seen[1]).toMatchObject({ initial: false, previous: first, content: io.content });
		io.content = "{ broken";
		await s.handleExternalChange();
		expect(seen[2]).toMatchObject({ initial: false, doc: null, failure: "json" });
	});
});

describe("integrity verdicts and other serializers", () => {
	it("the same content written with another layout under the same edit stamp is not reported", () => {
		const ledger = new IntegrityLedger(new Slot(), () => 1);
		const ours = edit(sampleDocument(2), "2026-10-29T10:05:00.000Z");
		ledger.recordWrite(P, ours);
		const reformatted = JSON.stringify(JSON.parse(ours) as unknown, null, 1);
		expect(reformatted).not.toBe(ours);
		expect(assessDisk(ledger.records(P), disk(reformatted)).kind).toBe("changed");
		// Accepting a reformatted text makes exactly that text the reference.
		ledger.accept(P, reformatted);
		expect(assessDisk(ledger.records(P), disk(reformatted)).kind).toBe("intact");
	});
});

describe("resilience and files not downloaded yet (sync safety)", () => {
	const timers: Timers = { set: (fn, ms) => nodeSetTimeout(fn, ms), clear: (h) => nodeClearTimeout(h) };

	class IO implements DocumentIO {
		backups: BackupReason[] = [];
		constructor(public content: string) {}
		async read(): Promise<string> {
			return this.content;
		}
		async process(fn: (c: string) => string): Promise<void> {
			this.content = fn(this.content);
		}
		async backup(content: string, reason: BackupReason): Promise<string | null> {
			void content;
			this.backups.push(reason);
			return "b.bak";
		}
	}

	it("a 0-byte or NUL placeholder is never reported to the integrity check, backed up or counted as a write failure", async () => {
		for (const placeholder of ["", "\0\0\0\0"]) {
			const io = new IO(placeholder);
			const seen: DiskContentInfo[] = [];
			const health: unknown[] = [];
			const s = new DocumentSession(io, timers, { onDiskContent: (i) => seen.push(i), onWriteHealth: (h) => health.push(h) });
			await s.load();
			expect(s.mode).toBe("not-downloaded");
			expect(seen).toHaveLength(0);
			expect(io.backups).toHaveLength(0);
			expect(await s.flush()).toBe(true);
			expect(health).toHaveLength(0);
			// The content arrives: now it is assessed, as a reload of the placeholder.
			io.content = serialize(sampleDocument(1));
			await s.handleExternalChange();
			expect(s.mode).toBe("ok");
			expect(seen).toHaveLength(1);
			expect(seen[0]!.doc).not.toBeNull();
		}
	});
});
