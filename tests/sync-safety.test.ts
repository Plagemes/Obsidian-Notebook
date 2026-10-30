import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18nSource from "../src/i18n.ts?raw";
import { serialize } from "../src/model/serialize";
import { DocumentSession, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import {
	assetAvailability, folderIssues, formatBytes, isAwaitingDownload, issueSignature, LARGE_FILE_BYTES, scanForSyncIssues,
	segmentIssue, sizeIssue, VERY_LARGE_FILE_BYTES, type SyncIssueKind,
} from "../src/storage/sync-state";
import {
	cleanDeviceName, deviceRecordDue, isFresh, minutesSince, newDeviceId, otherDevicesOpen, parseDevice, parsePresence,
	parsePresenceFileName, presenceFileName, presenceFolder, readIdentity, safeKey, serializeDevice, serializePresence,
	STALE_AFTER_MS, type PresenceRecord,
} from "../src/storage/presence-logic";
import { isReservedPath } from "../src/library/folders";
import { line, sampleDocument } from "./helpers";

const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

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
}

describe("#344 not downloaded yet", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("recognises placeholders: empty, whitespace, NUL bytes", () => {
		expect(isAwaitingDownload("")).toBe(true);
		expect(isAwaitingDownload("  \n\t")).toBe(true);
		expect(isAwaitingDownload("\0".repeat(4096))).toBe(true);
		expect(isAwaitingDownload("\0\0 \0")).toBe(true);
		expect(isAwaitingDownload("{")).toBe(false);
		expect(isAwaitingDownload("\u0000\u0001")).toBe(false);
	});

	for (const [label, content] of [["0 bytes", ""], ["NUL-filled", "\0".repeat(2048)], ["whitespace", "\n\n"]] as const) {
		it(`a ${label} file is not-downloaded: never broken, never backed up, never written`, async () => {
			const io = new FakeIO(content);
			const loaded: string[] = [];
			const s = new DocumentSession(io, timers, { onLoaded: (_d, mode) => loaded.push(mode) });
			await s.load();
			expect(s.mode).toBe("not-downloaded");
			expect(s.problem).toBeNull();
			expect(loaded).toEqual(["not-downloaded"]);
			expect(io.backups).toHaveLength(0);
			s.markChanged();
			expect(await s.flush()).toBe(true);
			expect(io.writes).toHaveLength(0);
			expect(io.content).toBe(content);
		});
	}

	it("opens normally once the content arrives", async () => {
		const io = new FakeIO("");
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(await s.handleExternalChange()).toBe("echo");
		io.content = serialize(sampleDocument(2));
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.mode).toBe("ok");
		expect(s.doc!.pages[0]!.strokes).toHaveLength(2);
		expect(io.backups).toHaveLength(0);
	});

	it("an open notebook whose file is emptied again by the sync client waits instead of breaking", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		const before = io.content;
		io.content = "";
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.mode).toBe("not-downloaded");
		// The version that was open is kept as a backup before it leaves memory (review fix).
		expect(io.backups).toEqual([{ content: before, reason: "integrity" }]);
	});

	it("a save over a NUL placeholder does not back the placeholder up as a conflict", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 50, 50));
		s.markChanged();
		io.content = "\0".repeat(100);
		expect(await s.flush()).toBe(true);
		expect(io.backups).toHaveLength(0);
		expect(io.writes).toHaveLength(1);
	});

	it("real damage is still broken and backed up", async () => {
		const io = new FakeIO("{\"format\": \"obsidian-notebook\", ]");
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.mode).toBe("broken");
		expect(io.backups.map((b) => b.reason)).toEqual(["unreadable"]);
	});
});

describe("#343 assets waiting for sync", () => {
	it("missing, empty or still-arriving files are waiting", () => {
		expect(assetAvailability(null, 1000)).toBe("waiting");
		expect(assetAvailability(0, 1000)).toBe("waiting");
		expect(assetAvailability(0, 0)).toBe("waiting");
		expect(assetAvailability(400, 1000)).toBe("waiting");
		expect(assetAvailability(1000, 1000)).toBe("present");
		expect(assetAvailability(1200, 1000)).toBe("present");
		expect(assetAvailability(500, 0)).toBe("present");
	});
});

describe("#345 sync check", () => {
	it("flags the notebooks folder inside the config folder or a hidden folder", () => {
		expect(folderIssues(".obsidian/Notebooks", ".obsidian").map((i) => i.kind)).toEqual(["config-folder"]);
		expect(folderIssues(".private/Notebooks", ".obsidian").map((i) => i.kind)).toEqual(["hidden-folder"]);
		expect(folderIssues("School/Notes.nosync", ".obsidian").map((i) => i.kind)).toEqual(["nosync-folder"]);
		expect(folderIssues("Notebooks", ".obsidian")).toEqual([]);
		expect(folderIssues("", ".obsidian")).toEqual([]);
		expect(folderIssues(".obsidianx/N", ".obsidian").map((i) => i.kind)).toEqual(["hidden-folder"]);
	});

	it("flags names OneDrive, Windows or Android storage refuse", () => {
		const cases: Array<[string, SyncIssueKind | null]> = [
			["Math: chapter 2.notebook", "bad-chars"],
			["What?.notebook", "bad-chars"],
			["a|b", "bad-chars"],
			["tab\there", "bad-chars"],
			[" leading", "edge-space-dot"],
			["trailing ", "edge-space-dot"],
			["dot.", "edge-space-dot"],
			["CON", "reserved-name"],
			["nul.notebook", "reserved-name"],
			["COM1.txt", "reserved-name"],
			["desktop.ini", "reserved-name"],
			["~$draft.notebook", "reserved-name"],
			["my_vti_file", "reserved-name"],
			["x".repeat(256), "long-name"],
			["Analisi 1 – appunti (2026).notebook", null],
			["Città #3 & più.notebook", null],
			["console.notebook", null],
		];
		for (const [name, kind] of cases) expect(segmentIssue(name), name).toBe(kind);
	});

	it("sizes", () => {
		expect(sizeIssue("a", LARGE_FILE_BYTES - 1)).toBeNull();
		expect(sizeIssue("a", LARGE_FILE_BYTES)?.kind).toBe("large-file");
		expect(sizeIssue("a", VERY_LARGE_FILE_BYTES)?.kind).toBe("very-large-file");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(12.5 * 1024 * 1024)).toBe("13 MB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
	});

	it("scans a folder: each bad folder once, case clashes, long paths and sizes", () => {
		const files = [
			{ path: "N/Good.notebook", size: 100 },
			{ path: "N/Bad: folder/a.notebook", size: 1 },
			{ path: "N/Bad: folder/b.notebook", size: 1 },
			{ path: "N/Notes.notebook", size: 1 },
			{ path: "N/notes.notebook", size: 1 },
			{ path: "N/_assets/big.pdf", size: 20 * 1024 * 1024 },
			{ path: `N/${"deep/".repeat(40)}x.notebook`, size: 1 },
		];
		const issues = scanForSyncIssues("N", ".obsidian", files);
		const kinds = issues.map((i) => `${i.kind}:${i.path}`);
		expect(kinds).toContain("bad-chars:N/Bad: folder");
		expect(kinds.filter((k) => k.startsWith("bad-chars"))).toHaveLength(1);
		expect(issues.find((i) => i.kind === "case-clash")?.other).toBeDefined();
		expect(kinds).toContain("large-file:N/_assets/big.pdf");
		expect(issues.some((i) => i.kind === "long-path")).toBe(true);
		expect(issues.some((i) => i.path === "N/Good.notebook")).toBe(false);
		expect(issueSignature(issues)).toBe(issueSignature([...issues].reverse()));
	});

	it("has a message for every issue kind in English and Italian", () => {
		const kinds: SyncIssueKind[] = ["config-folder", "hidden-folder", "nosync-folder", "bad-chars", "edge-space-dot", "reserved-name",
			"long-path", "long-name", "case-clash", "large-file", "very-large-file"];
		for (const k of kinds) {
			// once in the English table, once in the Italian one
			expect(i18nSource.split(`"sync.issue.${k}":`).length - 1, k).toBe(2);
		}
	});
});

describe("#342 presence files", () => {
	const now = Date.parse("2026-10-30T10:00:00.000Z");
	const rec = (device: string, minutesAgo: number, notebookId = "nb-1"): PresenceRecord => ({
		notebookId, deviceId: device, deviceName: `Device ${device}`, path: "Notebooks/A.notebook",
		openedAt: new Date(now - 3_600_000).toISOString(), heartbeat: new Date(now - minutesAgo * 60_000).toISOString(),
	});

	it("names one file per notebook and device, in the reserved _meta folder", () => {
		expect(presenceFolder("Notebooks")).toBe("Notebooks/_meta/presence");
		expect(presenceFolder("")).toBe("_meta/presence");
		const name = presenceFileName("1b4e28ba-2fa1-11d2-883f-0016d3cca427", "abc123def456");
		expect(name).toBe("1b4e28ba-2fa1-11d2-883f-0016d3cca427.abc123def456.json");
		expect(parsePresenceFileName(name)).toEqual({ notebook: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", device: "abc123def456" });
		expect(parsePresenceFileName("x.y (1).json")).toBeNull();
		expect(safeKey("a/b:c")).toBe("a_b_c");
		expect(isReservedPath("Notebooks/_meta/presence/x.y.json", "Notebooks")).toBe(true);
	});

	it("round-trips records and rejects anything else", () => {
		const r = rec("dev1", 1);
		expect(parsePresence(serializePresence(r))).toEqual(r);
		expect(parsePresence("")).toBeNull();
		expect(parsePresence("{\"kind\":\"notebook-presence\",\"version\":2}")).toBeNull();
		expect(parsePresence("{\"kind\":\"notebook-presence\",\"version\":1,\"notebookId\":\"a\",\"deviceId\":\"b\",\"heartbeat\":\"nope\"}")).toBeNull();
		const d = { deviceId: "dev1", deviceName: "Tablet", lastSeen: new Date(now).toISOString() };
		expect(parseDevice(serializeDevice(d))).toEqual(d);
	});

	it("fresh = heartbeat within the window, not from a clock far in the future", () => {
		expect(isFresh(rec("a", 1), now)).toBe(true);
		expect(isFresh(rec("a", STALE_AFTER_MS / 60_000 + 1), now)).toBe(false);
		expect(isFresh(rec("a", -5), now)).toBe(true);
		expect(isFresh(rec("a", -60), now)).toBe(false);
	});

	it("lists other devices only, one per device, newest first", () => {
		const records = [rec("me", 0), rec("b", 5), rec("c", 1), rec("b", 2), rec("old", 60), rec("d", 0, "other-notebook")];
		const others = otherDevicesOpen(records, "nb-1", "me", now);
		expect(others.map((r) => `${r.deviceId}:${minutesSince(r.heartbeat, now)}`)).toEqual(["c:1", "b:2"]);
	});

	it("device identity: random id, cleaned name, stored shape validated", () => {
		let i = 0;
		const id = newDeviceId(() => i++ * 7);
		expect(id).toMatch(/^[a-z0-9]{12}$/);
		expect(cleanDeviceName("  My   tablet  ", "x")).toBe("My tablet");
		expect(cleanDeviceName("   ", "fallback")).toBe("fallback");
		expect(cleanDeviceName("y".repeat(80), "x")).toHaveLength(40);
		expect(readIdentity({ id: "abc123def456", name: "Tab" })).toEqual({ id: "abc123def456", name: "Tab" });
		expect(readIdentity({ id: "../../x", name: "Tab" })).toBeNull();
		expect(readIdentity(null)).toBeNull();
	});

	it("the device file is refreshed when old or renamed", () => {
		const me = { id: "abc123def456", name: "Tab" };
		const fresh = { deviceId: me.id, deviceName: "Tab", lastSeen: new Date(now - 60_000).toISOString() };
		expect(deviceRecordDue(null, me, now)).toBe(true);
		expect(deviceRecordDue(fresh, me, now)).toBe(false);
		expect(deviceRecordDue({ ...fresh, deviceName: "Old" }, me, now)).toBe(true);
		expect(deviceRecordDue({ ...fresh, lastSeen: new Date(now - 13 * 3_600_000).toISOString() }, me, now)).toBe(true);
	});
});
