/** 0.16 review fixes on the shared-files inbox (C1 - C4). */
import { describe, expect, it } from "vitest";
import { isInboxCandidate, type InboxContext } from "../src/library/shared-inbox-logic";
import {
	MAX_WRITTEN, WRITTEN_TTL_MS, WRITTEN_KEY, addWritten, isPluginPictureName, loadWritten, normaliseWritten, recordPluginWrite, writtenSet,
} from "../src/storage/plugin-written";

const ctx = (over: Partial<InboxContext> = {}): InboxContext => ({
	folder: "Attachments", notebooksFolder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "", ...over,
});

describe("C1: the inbox never offers the plugin's own files", () => {
	const NOW = 1_800_000_000_000;

	it("recognises the names of digest crops and exported page pictures", () => {
		expect(isPluginPictureName("Maths highlight p3-2.png")).toBe(true);
		expect(isPluginPictureName("Maths highlight p12-10 2.png")).toBe(true);
		expect(isPluginPictureName("My notes — Chapter 2 highlight p1-1.PNG")).toBe(true);
		expect(isPluginPictureName("page-001.png")).toBe(true);
		expect(isPluginPictureName("page-1200 3.png")).toBe(true);
		expect(isPluginPictureName("photo.png")).toBe(false);
		expect(isPluginPictureName("page-1.png")).toBe(false);
		expect(isPluginPictureName("highlight p1-1.jpg")).toBe(false);
	});

	it("skips files by name and by the record, in any case; other files still count", () => {
		const written = writtenSet(addWritten({}, ["Attachments/Exam.pdf", "Attachments/Maths highlight p1-1.png"], NOW));
		expect(isInboxCandidate("Attachments/Exam.pdf", ctx({ pluginWritten: written }))).toBe(false);
		expect(isInboxCandidate("Attachments/exam.PDF", ctx({ pluginWritten: written }))).toBe(false);
		expect(isInboxCandidate("Attachments/Exam.pdf", ctx())).toBe(true);
		expect(isInboxCandidate("Attachments/Maths highlight p4-1.png", ctx())).toBe(false);
		expect(isInboxCandidate("Attachments/page-002.png", ctx())).toBe(false);
		expect(isInboxCandidate("Attachments/Other.pdf", ctx({ pluginWritten: written }))).toBe(true);
	});

	it("keeps a bounded, recent record and reads corrupt data as empty", () => {
		expect(normaliseWritten("junk", NOW)).toEqual({});
		expect(normaliseWritten([1, 2], NOW)).toEqual({});
		expect(normaliseWritten({ a: "x", b: -1, c: NaN, "": NOW }, NOW)).toEqual({});
		// older than the window is forgotten
		expect(Object.keys(normaliseWritten({ old: NOW - WRITTEN_TTL_MS - 1, fresh: NOW - 1000 }, NOW))).toEqual(["fresh"]);
		// bounded: the newest survive
		const many: Record<string, number> = {};
		for (let i = 0; i < MAX_WRITTEN + 50; i++) many[`p${i}.pdf`] = NOW - (MAX_WRITTEN + 50 - i);
		const kept = normaliseWritten(many, NOW);
		expect(Object.keys(kept)).toHaveLength(MAX_WRITTEN);
		expect(kept[`p${MAX_WRITTEN + 49}.pdf`]).toBeDefined();
		expect(kept["p0.pdf"]).toBeUndefined();
	});

	it("records through local storage and survives a failing store", () => {
		const store = new Map<string, unknown>();
		const app = { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => void store.set(k, v) };
		recordPluginWrite(app, ["A/x.pdf"], NOW);
		recordPluginWrite(app, ["A/y.png", "A/x.pdf"], NOW + 5);
		expect(Object.keys(loadWritten(app, NOW + 10)).sort()).toEqual(["A/x.pdf", "A/y.png"]);
		expect(store.has(WRITTEN_KEY)).toBe(true);
		const broken = { loadLocalStorage: () => { throw new Error("no"); }, saveLocalStorage: () => { throw new Error("no"); } };
		expect(loadWritten(broken, NOW)).toEqual({});
		expect(() => recordPluginWrite(broken, ["x.pdf"], NOW)).not.toThrow();
	});
});
