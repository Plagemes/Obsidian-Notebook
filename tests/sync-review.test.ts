/**
 * Review fixes of wave 0.7 sync safety and resilience: empty and cut-off files, read-back after a save, a newer version
 * after a failing streak, large-file verification, restores, presence heartbeats, images that do not decode, and the
 * library index of the quick switcher. Storage tests run over the fake vault (VaultDocumentIO on FakeVault).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import type { NotebookDocument } from "../src/model/types";
import type { JournalSlotFile, JournalStore } from "../src/storage/journal";
import { journalKey } from "../src/storage/journal";
import type { AwaitingState, ExternalNewerInfo, SessionEvents, SessionOptions, Timers } from "../src/storage/session";
import { downloadState, isTruncatedJson, RECENT_WRITE_MS } from "../src/storage/sync-state";
import { isPartialOf } from "../src/storage/write-guard";
import { assessDisk, IntegrityLedger } from "../src/storage/integrity";
import { restoredText } from "../src/storage/history";
import { HEARTBEAT_MS, STALE_AFTER_MS } from "../src/storage/presence-logic";
import { FakeTFile, FakeVault } from "./fake-vault";
import { line, sampleDocument } from "./helpers";

vi.mock("obsidian", async () => {
	const mock = (await import("./fake-vault")).obsidianMock();
	type Node = { children?: Node[] };
	const walk = (f: Node, cb: (f: Node) => void): void => {
		cb(f);
		for (const c of f.children ?? []) walk(c, cb);
	};
	return { ...mock, Vault: { recurseChildren: walk } };
});

const { VaultDocumentIO } = await import("../src/storage/vault-io");
const { DocumentSession, PARTIAL_BACKUP_MAX_CHARS } = await import("../src/storage/session");
const { PresenceService } = await import("../src/storage/presence");
const { NotebookMedia } = await import("../src/view/media");
const { QuickNavService } = await import("../src/view/quick-switcher");
const { LibraryIndex, INDEX_VERSION } = await import("../src/library/index");

const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

const ROOT = "Notebooks";
const P = `${ROOT}/A.notebook`;
const BACKUPS = `${ROOT}/_backup`;

/** A journal store in memory (owners still writing are hidden from `read`, as in AdapterJournalStore). */
class MemJournal implements JournalStore {
	readonly files = new Map<string, string>();
	private readonly live = new Set<string>();
	async read(key: string): Promise<JournalSlotFile[]> {
		const out: JournalSlotFile[] = [];
		for (const [k, text] of this.files) {
			const [fileKey, owner, slot] = k.split("|") as [string, string, string];
			if (fileKey === key && !this.live.has(owner)) out.push({ owner, slot: slot === "0" ? 0 : 1, text });
		}
		return out;
	}
	async write(key: string, owner: string, slot: 0 | 1, text: string): Promise<void> {
		this.live.add(owner);
		this.files.set(`${key}|${owner}|${slot}`, text);
	}
	async remove(key: string, owner: string): Promise<void> {
		this.files.delete(`${key}|${owner}|0`);
		this.files.delete(`${key}|${owner}|1`);
	}
	release(owner: string): void {
		this.live.delete(owner);
	}
	count(docId: string, path: string): number {
		const prefix = `${journalKey(docId, path)}|`;
		return [...this.files.keys()].filter((k) => k.startsWith(prefix)).length;
	}
}

function setup(text: string, options: SessionOptions = {}, events: SessionEvents = {}, vault = new FakeVault({ [P]: text })) {
	const file = vault.vault.getFileByPath(P)!;
	const io = new VaultDocumentIO(vault.app, file as never, () => BACKUPS);
	const s = new DocumentSession(io, timers, events, { retryMs: 1000, retryMaxMs: 4000, ...options });
	const backups = () => [...vault.files.entries()]
		.filter(([p]) => p.startsWith(`${BACKUPS}/`))
		.map(([p, content]) => ({ reason: / ([a-z-]+) (?:\d+ )?[0-9a-f]{8}\.bak$/.exec(p)?.[1] ?? "?", content }));
	return { vault, file: file as unknown as FakeTFile, io, s, backups, disk: () => vault.files.get(P)! };
}

function strokes(text: string): number {
	const r = parse(text);
	return r.ok ? r.doc.pages.reduce((n, p) => n + p.strokes.length, 0) : -1;
}

function addStroke(doc: NotebookDocument | null, x = 0): void {
	doc!.pages[0]!.strokes.push(line(x, 10, x + 40, 60));
}

function enospc(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("sync-state helpers (review)", () => {
	it("recognises JSON cut off at the end, and only that", () => {
		const text = serialize(sampleDocument(3));
		for (const n of [1, 2, 10, 57, 120, 333, text.trimEnd().length - 1]) expect(isTruncatedJson(text.slice(0, n)), String(n)).toBe(true);
		expect(isTruncatedJson(text)).toBe(false);
		expect(isTruncatedJson(`${text}x`)).toBe(false);
		expect(isTruncatedJson("")).toBe(false);
		expect(isTruncatedJson('{"a": ]')).toBe(false);
		expect(isTruncatedJson('{"a": tru')).toBe(true);
		expect(isTruncatedJson('{"a": 1.')).toBe(true);
		expect(isTruncatedJson('{"a": 1.,')).toBe(false);
		expect(isTruncatedJson('{"a": "\\u00')).toBe(true);
		expect(isTruncatedJson('{"a": "\\q')).toBe(false);
		expect(isTruncatedJson("\u0000\u0001\u0002")).toBe(false);
	});

	it("tells empty, arriving and damaged text apart", () => {
		const text = serialize(sampleDocument(2));
		expect(downloadState("")).toBe("empty");
		expect(downloadState("\0".repeat(100))).toBe("empty");
		expect(downloadState(text.slice(0, 200))).toBe("partial");
		expect(downloadState(`${text.slice(0, 200)}${"\0".repeat(300)}`)).toBe("partial");
		expect(downloadState('{"format": ]')).toBeNull();
		expect(downloadState('{"format": ]', { jsonError: true, changedAgoMs: 1000 })).toBe("partial");
		expect(downloadState('{"format": ]', { jsonError: true, changedAgoMs: RECENT_WRITE_MS + 1 })).toBeNull();
		// A complete JSON file with a bad schema is never "arriving", however recent.
		expect(downloadState('{"format": "x"}', { jsonError: false, changedAgoMs: 10 })).toBeNull();
	});

	it("only empty, NUL-padded or prefix read-backs are the remains of our own write", () => {
		const ours = serialize(sampleDocument(2));
		expect(isPartialOf(ours, "")).toBe(true);
		expect(isPartialOf(ours, "\0".repeat(50))).toBe(true);
		expect(isPartialOf(ours, ours.slice(0, 100))).toBe(true);
		expect(isPartialOf(ours, `${ours.slice(0, 100)}\0\0\0`)).toBe(true);
		expect(isPartialOf(ours, ours)).toBe(false);
		expect(isPartialOf(ours, `${ours.slice(0, 100)}garbage`)).toBe(false);
		expect(isPartialOf(ours, "{ someone else's text")).toBe(false);
	});
});

describe("#1 a 0-byte file that may be our damage (review)", () => {
	it("an open notebook keeps its document when this device wrote the file, backs it up, writes only after Write it back", async () => {
		const good = serialize(sampleDocument(2));
		const seen: Array<AwaitingState | null> = [];
		const { s, backups, disk, vault } = setup(good, { ownWrite: () => ({ id: "x" }) }, { onAwaiting: (a) => seen.push(a) });
		await s.load();
		vault.files.set(P, "");
		expect(await s.handleExternalChange()).toBe("kept-local");
		expect(s.mode).toBe("ok");
		expect(s.doc!.pages[0]!.strokes).toHaveLength(2);
		expect(s.awaiting).toEqual({ kind: "empty", damaged: true, kept: true });
		expect(seen).toEqual([{ kind: "empty", damaged: true, kept: true }]);
		expect(backups()).toEqual([{ reason: "integrity", content: good }]);
		// The same placeholder again is an echo.
		expect(await s.handleExternalChange()).toBe("echo");

		// Edits are kept (and journaled), not written over the file while it may still be arriving.
		addStroke(s.doc);
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(disk()).toBe("");
		expect(s.dirty).toBe(true);

		// "Write it back" (after the user's confirmation in the view).
		expect(await s.writeBack()).toBe(true);
		expect(strokes(disk())).toBe(3);
		expect(s.awaiting).toBeNull();
		expect(seen[seen.length - 1]).toBeNull();
		expect(s.dirty).toBe(false);
	});

	it("without evidence an open notebook waits for the download, after backing up the version that was open", async () => {
		for (const placeholder of ["", "\0".repeat(64)]) {
			const good = serialize(sampleDocument(1));
			const { s, backups, vault } = setup(good);
			await s.load();
			vault.files.set(P, placeholder);
			expect(await s.handleExternalChange()).toBe("reloaded");
			expect(s.mode).toBe("not-downloaded");
			expect(s.doc).toBeNull();
			expect(s.awaiting).toEqual({ kind: "empty", damaged: false, kept: false });
			expect(backups()).toEqual([{ reason: "integrity", content: good }]);
		}
	});

	it("a kept document: a version arriving while clean is loaded; while dirty it is backed up and ours is written", async () => {
		const good = serialize(sampleDocument(1));
		const theirsDoc = parse(good);
		if (!theirsDoc.ok) throw new Error("bad fixture");
		addStroke(theirsDoc.doc, 100);
		addStroke(theirsDoc.doc, 200);
		theirsDoc.doc.modifiedAt = "2026-10-30T11:00:00.000Z";
		const theirs = serialize(theirsDoc.doc);

		const clean = setup(good, { ownWrite: () => ({ id: "x" }) });
		await clean.s.load();
		clean.vault.files.set(P, "");
		await clean.s.handleExternalChange();
		clean.vault.files.set(P, theirs);
		expect(await clean.s.handleExternalChange()).toBe("reloaded");
		expect(clean.s.doc!.pages[0]!.strokes).toHaveLength(3);
		expect(clean.s.awaiting).toBeNull();

		const dirty = setup(good, { ownWrite: () => ({ id: "x" }) });
		await dirty.s.load();
		dirty.vault.files.set(P, "");
		await dirty.s.handleExternalChange();
		addStroke(dirty.s.doc, 300);
		dirty.s.markChanged();
		dirty.vault.files.set(P, theirs);
		expect(await dirty.s.handleExternalChange()).toBe("kept-local");
		expect(dirty.s.awaiting).toBeNull();
		await vi.advanceTimersByTimeAsync(2000);
		expect(strokes(dirty.disk())).toBe(2);
		expect(dirty.backups().map((b) => b.reason).sort()).toEqual(["conflict", "integrity"]);
		expect(dirty.backups().find((b) => b.reason === "conflict")!.content).toBe(theirs);
	});

	it("a 0-byte file with journal entries is not-downloaded but flagged as possible damage; the journal is kept and applied when content returns", async () => {
		const good = serialize(sampleDocument(2));
		const journal = new MemJournal();
		const vault = new FakeVault({ [P]: good });
		const first = setup(good, { journal }, {}, vault).s;
		await first.load();
		addStroke(first.doc, 50);
		first.markChanged();
		await vi.advanceTimersByTimeAsync(400);
		await first.journalIdle();
		const id = first.doc!.id;
		first.dispose(); // killed before the save
		await first.journalIdle();
		expect(journal.count(id, P)).toBeGreaterThan(0);

		vault.files.set(P, "");
		const recovered = vi.fn();
		const second = setup("", { journal }, { onRecovered: recovered }, vault).s;
		await second.load();
		expect(second.mode).toBe("not-downloaded");
		expect(second.awaiting).toEqual({ kind: "empty", damaged: false, kept: false });
		// The id comes from the ledger (ownWrite) when the file is empty: then the journal counts as evidence too.
		const third = setup("", { journal, ownWrite: () => ({ id }) }, {}, vault).s;
		await third.load();
		expect(third.awaiting).toMatchObject({ damaged: true });
		third.dispose();
		expect(journal.count(id, P)).toBeGreaterThan(0);

		vault.files.set(P, good);
		expect(await second.handleExternalChange()).toBe("reloaded");
		expect(second.mode).toBe("ok");
		expect(second.doc!.pages[0]!.strokes).toHaveLength(3);
		expect(recovered).toHaveBeenCalledTimes(1);
	});
});

describe("#2 a file that is still arriving (review)", () => {
	it("a cut-off file is not broken: no backup churn, polling goes on, and it opens when complete", async () => {
		const good = serialize(sampleDocument(3));
		const loaded: string[] = [];
		const { s, backups, vault } = setup(good.slice(0, 150), {}, { onLoaded: (_d, mode) => loaded.push(mode) });
		await s.load();
		expect(s.mode).toBe("not-downloaded");
		expect(s.awaiting).toEqual({ kind: "partial", damaged: false, kept: false });
		expect(backups().map((b) => b.reason)).toEqual(["unreadable"]);
		// The same partial content again: nothing new.
		expect(await s.handleExternalChange()).toBe("echo");
		// More of it, padded with NUL bytes: still arriving, one backup per distinct small content.
		vault.files.set(P, `${good.slice(0, 400)}${"\0".repeat(200)}`);
		await s.handleExternalChange();
		expect(s.mode).toBe("not-downloaded");
		expect(backups()).toHaveLength(2);
		// A large cut-off file is not copied into the synced backup folder.
		vault.files.set(P, `{"format": "obsidian-notebook", "id": "${"x".repeat(PARTIAL_BACKUP_MAX_CHARS + 10)}`);
		await s.handleExternalChange();
		expect(s.mode).toBe("not-downloaded");
		expect(backups()).toHaveLength(2);
		vault.files.set(P, good);
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.mode).toBe("ok");
		expect(s.awaiting).toBeNull();
		expect(loaded).toEqual(["not-downloaded", "not-downloaded", "not-downloaded", "ok"]);
	});

	it("a file that does not parse and changed seconds ago waits; after RECENT_WRITE_MS the same content counts as damage", async () => {
		const garbage = '{"format": "obsidian-notebook", ]';
		const { s, backups, file } = setup(garbage);
		file.stat.mtime = Date.now() - 1000;
		await s.load();
		expect(s.mode).toBe("not-downloaded");
		expect(s.awaiting).toMatchObject({ kind: "partial" });
		expect(backups().map((b) => b.reason)).toEqual(["unreadable"]); // small: one copy of this content
		expect(await s.handleExternalChange()).toBe("echo");
		await vi.advanceTimersByTimeAsync(RECENT_WRITE_MS);
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.mode).toBe("broken");
		expect(backups().map((b) => b.reason)).toEqual(["unreadable"]); // the same content is not copied twice
	});

	it("an open notebook whose file is cut off keeps the previous version as a backup before it waits", async () => {
		const good = serialize(sampleDocument(2));
		const { s, backups, vault } = setup(good);
		await s.load();
		vault.files.set(P, good.slice(0, 90));
		await s.handleExternalChange();
		expect(s.mode).toBe("not-downloaded");
		expect(backups().map((b) => b.reason).sort()).toEqual(["integrity", "unreadable"]);
		expect(backups().find((b) => b.reason === "integrity")!.content).toBe(good);
	});

	it("a dirty notebook never writes over a file being downloaded: it waits, then backs the complete version up and saves", async () => {
		const good = serialize(sampleDocument(1));
		const seen: Array<AwaitingState | null> = [];
		const { s, backups, vault, disk } = setup(good, {}, { onAwaiting: (a) => seen.push(a) });
		await s.load();
		addStroke(s.doc);
		s.markChanged();
		const incoming = sampleDocument(4);
		incoming.id = s.doc!.id;
		const theirs = serialize(incoming);
		vault.files.set(P, theirs.slice(0, 300));
		expect(await s.flush()).toBe(false);
		expect(disk()).toBe(theirs.slice(0, 300));
		expect(s.awaiting).toEqual({ kind: "partial", damaged: false, kept: true });
		expect(backups()).toHaveLength(0);
		vault.files.set(P, theirs);
		expect(await s.handleExternalChange()).toBe("kept-local");
		await vi.advanceTimersByTimeAsync(2000);
		expect(strokes(disk())).toBe(2);
		expect(backups()).toEqual([{ reason: "conflict", content: theirs }]);
		expect(seen[seen.length - 1]).toBeNull();
	});
});

describe("#3 read-back after a save (review)", () => {
	it("a different valid notebook right after our write: ours is backed up as a conflict, theirs is loaded", async () => {
		const good = serialize(sampleDocument(1));
		const written = vi.fn();
		const { s, backups, vault } = setup(good, {}, { onWritten: written });
		await s.load();
		addStroke(s.doc);
		s.markChanged();
		const external = serialize(sampleDocument(4));
		const real = vault.vault.process;
		vault.vault.process = async (f, fn) => {
			const out = await real(f, fn);
			vault.files.set(P, external);
			return out;
		};
		expect(await s.flush()).toBe(true);
		vault.vault.process = real;
		const conflict = backups().filter((b) => b.reason === "conflict");
		expect(conflict).toHaveLength(1);
		expect(strokes(conflict[0]!.content)).toBe(2);
		expect(written).not.toHaveBeenCalled();
		await s.flush(); // runs after the queued external-change check
		expect(s.doc!.pages[0]!.strokes).toHaveLength(4);
	});

	it("another app writing the file in place is never 'repaired' over: the save fails and is retried", async () => {
		const good = serialize(sampleDocument(1));
		const { s, vault, disk } = setup(good);
		await s.load();
		addStroke(s.doc);
		s.markChanged();
		const real = vault.vault.process;
		let first = true;
		vault.vault.process = async (f, fn) => {
			const out = await real(f, fn);
			if (first) vault.files.set(P, "{\"format\": \"obsidian-notebook\", \"id\": \"other\", ]");
			first = false;
			return out;
		};
		const log = vault.log.length;
		expect(await s.flush()).toBe(false);
		expect(disk()).toContain("\"id\": \"other\"");
		expect(vault.log.length - log).toBe(1); // our write only: nothing written back over theirs
		expect(s.dirty).toBe(true);
	});
});

describe("#6 a newer version found after a failing streak (review)", () => {
	function failingVault(good: string) {
		const vault = new FakeVault({ [P]: good });
		const real = vault.vault.process;
		const state = { fail: true };
		vault.vault.process = async (f, fn) => {
			if (state.fail) throw enospc();
			return real(f, fn);
		};
		return { vault, state };
	}

	it("is not written over: it is backed up and the user is asked; accept() saves on top of it", async () => {
		const good = serialize(sampleDocument(1));
		const { vault, state } = failingVault(good);
		const asked: ExternalNewerInfo[] = [];
		const { s, backups, disk } = setup(good, {}, { onExternalNewer: (i) => asked.push(i) }, vault);
		await s.load();
		addStroke(s.doc);
		s.markChanged();
		expect(await s.flush()).toBe(false);
		const newer = parse(good);
		if (!newer.ok) throw new Error("bad fixture");
		addStroke(newer.doc, 200);
		addStroke(newer.doc, 300);
		newer.doc.modifiedAt = new Date().toISOString();
		const theirs = serialize(newer.doc);
		vault.files.set(P, theirs);
		state.fail = false;
		expect(await s.flush()).toBe(false);
		expect(disk()).toBe(theirs);
		expect(asked).toHaveLength(1);
		expect(asked[0]!.text).toBe(theirs);
		expect(backups()).toEqual([{ reason: "conflict", content: theirs }]);
		// Retries wait for the choice.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(disk()).toBe(theirs);
		asked[0]!.accept();
		await vi.advanceTimersByTimeAsync(0);
		await s.flush();
		expect(strokes(disk())).toBe(2);
		expect(s.dirty).toBe(false);
	});

	it("an older external version is still backed up and replaced as before", async () => {
		const good = serialize(sampleDocument(1));
		const { vault, state } = failingVault(good);
		const asked = vi.fn();
		const { s, backups, disk } = setup(good, {}, { onExternalNewer: asked }, vault);
		await s.load();
		addStroke(s.doc);
		s.markChanged();
		await s.flush();
		const older = parse(good);
		if (!older.ok) throw new Error("bad fixture");
		older.doc.modifiedAt = "2026-10-01T00:00:00.000Z";
		addStroke(older.doc, 500);
		const theirs = serialize(older.doc);
		vault.files.set(P, theirs);
		state.fail = false;
		expect(await s.flush()).toBe(true);
		expect(asked).not.toHaveBeenCalled();
		expect(backups()).toEqual([{ reason: "conflict", content: theirs }]);
		expect(strokes(disk())).toBe(2);
	});
});

describe("#7 large writes are read back too (review)", () => {
	it("a silent partial write of a file above the full-compare limit is caught and undone", async () => {
		const good = serialize(sampleDocument(3));
		const { s, vault, disk } = setup(good, { verifyLimitChars: 100 });
		await s.load();
		addStroke(s.doc);
		s.markChanged();
		const real = vault.vault.process;
		let first = true;
		vault.vault.process = async (f, fn) => real(f, (d) => {
			const out = fn(d);
			if (!first || out === d) return out;
			first = false;
			return out.slice(0, out.length - 40);
		});
		expect(await s.flush()).toBe(false);
		expect(disk()).toBe(good);
		vault.vault.process = real;
		await vi.advanceTimersByTimeAsync(1500);
		expect(strokes(disk())).toBe(4);
	});
});

describe("#4 a version restore is a new edit (review)", () => {
	it("the restored text carries a new modifiedAt, so another device's ledger does not see a rollback", () => {
		const ledger = new IntegrityLedger({ load: () => null, save: () => undefined }, () => 1);
		const doc = sampleDocument(1);
		doc.modifiedAt = "2026-10-29T10:01:00.000Z";
		const v1 = serialize(doc);
		addStroke(doc);
		doc.modifiedAt = "2026-10-29T10:02:00.000Z";
		const v2 = serialize(doc);
		ledger.recordWrite(P, v1);
		ledger.recordWrite(P, v2);
		const disk = (text: string) => {
			const r = parse(text);
			return { text, doc: r.ok ? r.doc : null, failure: null };
		};
		expect(assessDisk(ledger.records(P), disk(v1)).kind).toBe("rolled-back");
		const restored = restoredText(v1, new Date("2026-10-30T09:00:00.000Z"));
		const back = parse(restored);
		expect(back.ok && back.doc.modifiedAt).toBe("2026-10-30T09:00:00.000Z");
		expect(back.ok && back.doc.pages[0]!.strokes).toHaveLength(1);
		expect(assessDisk(ledger.records(P), disk(restored)).kind).toBe("changed");
		expect(restoredText("not json", new Date())).toBe("not json");
	});
});

describe("#5 presence heartbeat (review)", () => {
	beforeEach(() => {
		(globalThis as { window?: unknown }).window = globalThis;
	});

	it("writes on open, every 5 minutes, and on resume only when the last write is that old", async () => {
		expect(HEARTBEAT_MS).toBe(5 * 60_000);
		expect(STALE_AFTER_MS).toBe(3 * HEARTBEAT_MS);
		const vault = new FakeVault();
		let stored: unknown = null;
		const presence = new PresenceService(vault.app, () => ROOT, { load: () => stored, save: (v) => (stored = v) });
		const writes = () => vault.log.filter((l) => l.includes("_meta/presence/")).length;
		presence.acquire("nb1", P);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes()).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(writes()).toBe(1); // nothing after one minute (it used to be every 60 s)
		presence.setVisible(false);
		presence.setVisible(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes()).toBe(1); // a quick app switch does not upload again
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		expect(writes()).toBe(2);
		presence.setVisible(false);
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
		expect(writes()).toBe(2); // nothing in the background
		presence.setVisible(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes()).toBe(3); // resume after a long pause refreshes at once
		await presence.dispose();
	});
});

describe("#9 an image that does not decode is reloaded when its file changes (review)", () => {
	it("is waiting, and assetFileChanged forgets it", async () => {
		const vault = new FakeVault({ [`${ROOT}/_assets/abc.png`]: "x" });
		const assetFile = vault.vault.getFileByPath(`${ROOT}/_assets/abc.png`)!;
		assetFile.stat.size = 10;
		const app = { vault: { ...vault.vault, readBinary: async () => new ArrayBuffer(10) } } as never;
		const doc = sampleDocument(0);
		doc.assets = { abc: { id: "abc", kind: "image", path: `${ROOT}/_assets/abc.png`, name: "Photo.png", bytes: 10 } };
		const changed = vi.fn();
		const media = new NotebookMedia(app, () => doc, () => ROOT, changed);
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(media.image("abc")).toBeNull();
			await vi.advanceTimersByTimeAsync(0);
			expect(changed).toHaveBeenCalled();
			expect(media.isWaiting("abc")).toBe(true);
			expect(media.assetFileChanged(assetFile as never)).toBe(true);
			expect(media.isWaiting("abc")).toBe(false);
		} finally {
			errors.mockRestore();
		}
	});
});

describe("#10 library index of the quick switcher (review)", () => {
	beforeEach(() => {
		(globalThis as { window?: unknown }).window = globalThis;
	});

	async function refresh(service: { dir: { refresh(p: () => void): Promise<void> } }): Promise<void> {
		const done = service.dir.refresh(() => undefined);
		await vi.advanceTimersByTimeAsync(50);
		await done;
	}

	function host(vault: FakeVault, saved: { data: unknown; reads: number }) {
		return {
			root: () => ROOT,
			loadIndex: async () => saved.data,
			saveIndex: async (data: unknown) => {
				saved.data = JSON.parse(JSON.stringify(data)) as unknown;
			},
			readNotebook: async (f: { path: string }) => {
				saved.reads++;
				const r = parse(vault.files.get(f.path) ?? "");
				return r.ok ? r.doc : null;
			},
			thumbnailBackground: async () => null,
		};
	}

	it("saves what it read through the library host, so the next session reads nothing again", async () => {
		const vault = new FakeVault({ [P]: serialize(sampleDocument(1)), [`${ROOT}/B.notebook`]: serialize(sampleDocument(2)) });
		const saved = { data: null as unknown, reads: 0 };
		const first = new QuickNavService(vault.app, host(vault, saved) as never, {} as never);
		await refresh(first);
		expect(saved.reads).toBe(2);
		expect((saved.data as { version: number }).version).toBe(INDEX_VERSION);
		const second = new QuickNavService(vault.app, host(vault, saved) as never, {} as never);
		await refresh(second);
		expect(saved.reads).toBe(2);
		expect(second.dir.index.size).toBe(2);
	});

	it("never saves over an index written by a newer plugin version", async () => {
		const vault = new FakeVault({ [P]: serialize(sampleDocument(1)) });
		const newer = { version: INDEX_VERSION + 1, entries: [{ future: true }] };
		const saved = { data: newer as unknown, reads: 0 };
		const service = new QuickNavService(vault.app, host(vault, saved) as never, {} as never);
		await refresh(service);
		expect(saved.reads).toBe(1);
		expect(saved.data).toBe(newer);
		expect(LibraryIndex.fromJSON(newer).keepsNewerVersion).toBe(true);
	});
});
