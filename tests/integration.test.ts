import { describe, expect, it } from "vitest";
import {
	buildEmbedBlock, candidatePaths, embedInsertText, embedPixelWidth, notebookUri, pageFromState, parseEmbedSource,
	parsePageFragment, parseProtocolParams,
} from "../src/integration/links";
import { createDocument } from "../src/model/document";
import { serialize } from "../src/model/serialize";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import {
	extractDocId, formatBytes, formatSnapshotDate, historyRoot, parseSnapshotName, safeDocId, shouldSnapshot, snapshotFileName,
	snapshotFolder, snapshotPageCount, snapshotsToPrune, sortSnapshots,
} from "../src/storage/history";

describe("parseEmbedSource", () => {
	it("reads path and page lines", () => {
		expect(parseEmbedSource("path: Notebooks/Physics.notebook\npage: 3")).toEqual({
			ok: true, target: { kind: "path", value: "Notebooks/Physics.notebook" }, page: 3,
		});
	});

	it("defaults to page 1 and ignores blank lines and key case", () => {
		expect(parseEmbedSource("\n  PATH:  Notebooks/A.notebook \n\n")).toEqual({
			ok: true, target: { kind: "path", value: "Notebooks/A.notebook" }, page: 1,
		});
	});

	it("accepts a single line with a page suffix", () => {
		expect(parseEmbedSource("Notebooks/Physics.notebook#3")).toEqual({
			ok: true, target: { kind: "path", value: "Notebooks/Physics.notebook" }, page: 3,
		});
		expect(parseEmbedSource("Notebooks/Physics.notebook#p12")).toMatchObject({ page: 12 });
		expect(parseEmbedSource("Notebooks/Physics.notebook#page=4")).toMatchObject({ page: 4 });
	});

	it("accepts wikilinks, with alias and embed marker", () => {
		expect(parseEmbedSource("[[Physics#p3]]")).toEqual({ ok: true, target: { kind: "link", value: "Physics" }, page: 3 });
		expect(parseEmbedSource("![[Physics#3|my page]]")).toEqual({ ok: true, target: { kind: "link", value: "Physics" }, page: 3 });
		expect(parseEmbedSource("path: [[Physics]]")).toEqual({ ok: true, target: { kind: "link", value: "Physics" }, page: 1 });
	});

	it("lets an explicit page line win over the suffix", () => {
		expect(parseEmbedSource("[[Physics#p3]]\npage: 5")).toMatchObject({ ok: true, page: 5 });
	});

	it("rejects an empty block and bad pages", () => {
		expect(parseEmbedSource("")).toMatchObject({ ok: false, error: "empty" });
		expect(parseEmbedSource("page: 2")).toMatchObject({ ok: false, error: "empty" });
		expect(parseEmbedSource("path: A.notebook\npage: 0")).toMatchObject({ ok: false, error: "badPage" });
		expect(parseEmbedSource("path: A.notebook\npage: two")).toMatchObject({ ok: false, error: "badPage", detail: "two" });
		expect(parseEmbedSource("[[A#Heading]]")).toMatchObject({ ok: false, error: "badPage" });
	});
});

describe("page fragments", () => {
	it("parses the accepted spellings only", () => {
		expect(parsePageFragment("7")).toBe(7);
		expect(parsePageFragment("p7")).toBe(7);
		expect(parsePageFragment("page 7")).toBe(7);
		expect(parsePageFragment("0")).toBeNull();
		expect(parsePageFragment("intro")).toBeNull();
		expect(parsePageFragment("")).toBeNull();
	});
});

describe("embed block text", () => {
	it("builds a block that parses back to the same target", () => {
		const block = buildEmbedBlock("Notebooks/My notes.notebook", 4);
		expect(block).toBe("```notebook\npath: Notebooks/My notes.notebook\npage: 4\n```\n");
		const source = block.split("\n").slice(1, -2).join("\n");
		expect(parseEmbedSource(source)).toEqual({ ok: true, target: { kind: "path", value: "Notebooks/My notes.notebook" }, page: 4 });
	});

	it("starts on its own line", () => {
		expect(embedInsertText("A.notebook", 1, true).startsWith("```")).toBe(true);
		expect(embedInsertText("A.notebook", 1, false).startsWith("\n```")).toBe(true);
	});

	it("lists paths to try without doubling the extension", () => {
		expect(candidatePaths("/Notebooks/A", ["notebook"])).toEqual(["Notebooks/A", "Notebooks/A.notebook"]);
		expect(candidatePaths("Notebooks/A.notebook", ["notebook"])).toEqual(["Notebooks/A.notebook"]);
	});

	it("sizes the preview for the device pixel ratio", () => {
		expect(embedPixelWidth(400, 2)).toBe(800);
		expect(embedPixelWidth(0, 1)).toBe(600);
		expect(embedPixelWidth(5000, 3)).toBe(2048);
		expect(embedPixelWidth(10, 1)).toBe(64);
		expect(embedPixelWidth(400, Number.NaN)).toBe(400);
	});
});

describe("obsidian:// links", () => {
	it("builds a link with an encoded vault name and path", () => {
		expect(notebookUri("My vault", "Notebooks/Physics 1.notebook", 3))
			.toBe("obsidian://notebook?vault=My%20vault&path=Notebooks%2FPhysics%201.notebook&page=3");
	});

	it("omits a page that is not a positive integer", () => {
		expect(notebookUri("v", "a.notebook")).toBe("obsidian://notebook?vault=v&path=a.notebook");
		expect(notebookUri("v", "a.notebook", 0)).not.toContain("page");
		expect(notebookUri("v", "a.notebook", 2.5)).not.toContain("page");
	});

	it("round-trips through URL parsing", () => {
		const url = new URL(notebookUri("Vault & more", "Dir/é #1.notebook", 12));
		const params = Object.fromEntries(url.searchParams.entries());
		expect(params.vault).toBe("Vault & more");
		expect(parseProtocolParams(params)).toEqual({ ok: true, path: "Dir/é #1.notebook", page: 12, pageId: null });
	});

	it("reads protocol parameters leniently", () => {
		expect(parseProtocolParams({ path: "/A.notebook", page: "x" })).toEqual({ ok: true, path: "A.notebook", page: null, pageId: null });
		expect(parseProtocolParams({ file: "B.notebook", page: "0" })).toEqual({ ok: true, path: "B.notebook", page: null, pageId: null });
		expect(parseProtocolParams({ page: "2" })).toEqual({ ok: false });
		expect(parseProtocolParams({ path: "  " })).toEqual({ ok: false });
	});

	it("reads the page from a view state", () => {
		expect(pageFromState({ file: "a", page: 4 })).toBe(4);
		expect(pageFromState({ page: 0 })).toBeNull();
		expect(pageFromState({ page: "4" })).toBeNull();
		expect(pageFromState(null)).toBeNull();
	});
});

describe("snapshot names", () => {
	it("encodes local time to the minute and parses it back", () => {
		const d = new Date(2026, 9, 29, 14, 5, 33);
		expect(snapshotFileName(d)).toBe("20261029-1405.snapshot");
		expect(parseSnapshotName("20261029-1405.snapshot")?.getTime()).toBe(new Date(2026, 9, 29, 14, 5).getTime());
		expect(formatSnapshotDate(d)).toBe("2026-10-29 14:05");
	});

	it("rejects names that are not snapshots or not real dates", () => {
		for (const name of ["", "x.snapshot", "20261329-1405.snapshot", "20261029-2505.snapshot", "20261029-1405.bak", "20261029-1405.snapshot.md"]) {
			expect(parseSnapshotName(name)).toBeNull();
		}
	});

	it("lays out the folders under the backup folder", () => {
		expect(historyRoot("Notebooks/_backup")).toBe("Notebooks/_backup/history");
		expect(snapshotFolder("Notebooks/_backup/", "abc-123")).toBe("Notebooks/_backup/history/abc-123");
		expect(safeDocId("../x/y")).toBe("___x_y");
		expect(safeDocId("")).toBe("unknown");
	});
});

describe("retention", () => {
	const names = ["20261001-0900.snapshot", "20261003-0900.snapshot", "20261002-0900.snapshot", "20261004-0900.snapshot", "notes.txt", "20260930-0900.snapshot"];

	it("sorts newest first and ignores foreign files", () => {
		expect(sortSnapshots(names).map((s) => s.name)).toEqual([
			"20261004-0900.snapshot", "20261003-0900.snapshot", "20261002-0900.snapshot", "20261001-0900.snapshot", "20260930-0900.snapshot",
		]);
	});

	it("keeps the newest N and never touches foreign files", () => {
		expect(snapshotsToPrune(names, 3)).toEqual(["20261001-0900.snapshot", "20260930-0900.snapshot"]);
		expect(snapshotsToPrune(names, 10)).toEqual([]);
		expect(snapshotsToPrune(names, 0)).toHaveLength(4); // at least one is always kept
		expect(snapshotsToPrune([], 3)).toEqual([]);
	});
});

describe("shouldSnapshot", () => {
	const now = new Date(2026, 9, 29, 12, 0);
	const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

	it("snapshots when there is none yet", () => {
		expect(shouldSnapshot(null, now, 24)).toBe(true);
	});

	it("waits for the interval", () => {
		expect(shouldSnapshot(hoursAgo(1), now, 24)).toBe(false);
		expect(shouldSnapshot(hoursAgo(23), now, 24)).toBe(false);
		expect(shouldSnapshot(hoursAgo(24), now, 24)).toBe(true);
		expect(shouldSnapshot(hoursAgo(48), now, 24)).toBe(true);
	});

	it("is off when the interval is 0 or invalid", () => {
		expect(shouldSnapshot(null, now, 0)).toBe(false);
		expect(shouldSnapshot(null, now, Number.NaN)).toBe(false);
	});

	it("is not blocked by a snapshot dated in the future", () => {
		expect(shouldSnapshot(hoursAgo(-5), now, 24)).toBe(true);
	});
});

describe("document identity", () => {
	const doc = createDocument();
	const text = serialize(doc);

	it("reads the id of a valid notebook and counts its pages", () => {
		expect(extractDocId(text)).toBe(doc.id);
		expect(snapshotPageCount(text)).toBe(1);
	});

	it("still finds the id of a file that no longer parses", () => {
		const broken = text.slice(0, text.length - 40);
		expect(snapshotPageCount(broken)).toBeNull();
		expect(extractDocId(broken)).toBe(doc.id);
		expect(extractDocId("not a notebook")).toBeNull();
		expect(extractDocId("")).toBeNull();
	});

	it("formats sizes", () => {
		expect(formatBytes(500)).toBe("500 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
	});
});

describe("snapshot settings", () => {
	it("has defaults of 24 hours and 10 snapshots", () => {
		expect(DEFAULT_SETTINGS.snapshotIntervalHours).toBe(24);
		expect(DEFAULT_SETTINGS.snapshotsToKeep).toBe(10);
	});

	it("accepts valid values and ignores the rest", () => {
		expect(readSettings({ snapshotIntervalHours: 6, snapshotsToKeep: 3 })).toMatchObject({ snapshotIntervalHours: 6, snapshotsToKeep: 3 });
		expect(readSettings({ snapshotIntervalHours: 0 }).snapshotIntervalHours).toBe(0);
		const bad = readSettings({ snapshotIntervalHours: -1, snapshotsToKeep: 0 });
		expect(bad.snapshotIntervalHours).toBe(24);
		expect(bad.snapshotsToKeep).toBe(10);
		expect(readSettings({ snapshotIntervalHours: "6", snapshotsToKeep: 2.5 })).toMatchObject({ snapshotIntervalHours: 24, snapshotsToKeep: 10 });
		expect(readSettings({ snapshotsToKeep: 1000 }).snapshotsToKeep).toBe(10);
	});
});
