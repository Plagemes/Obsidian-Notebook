/** 0.16 review fixes on the shared-files inbox (C1 - C4). */
import { describe, expect, it, vi } from "vitest";
import { isInboxCandidate, isNewSince, noteNames, normaliseSince, sinceFor, type InboxContext } from "../src/library/shared-inbox-logic";
import { planClosedEdit } from "../src/integration/api-plan";
import { prepareAppendImagePage, prepareImageElement } from "../src/library/shared-inbox-plan";
import { createDocument, createPage } from "../src/model/document";
import { serialize } from "../src/model/serialize";
import type { Asset } from "../src/model/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeTFile } from "./fake-vault";
import { backlinksOf, linkingNotes } from "../src/storage/backlinks";
import {
	MAX_WRITTEN, WRITTEN_TTL_MS, WRITTEN_KEY, addWritten, isPluginPictureName, loadWritten, normaliseWritten, recordPluginWrite, writtenSet,
} from "../src/storage/plugin-written";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());
const { EditPendingSaveError, editNotebook, elementPageLocked } = await import("../src/library/shared-inbox-edit");

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

describe("C2: a file that notes link to is not offered for the trash", () => {
	const resolved = {
		"Notes/Exam.md": { "Attachments/scan.pdf": 2, "Notes/Other.md": 1 },
		"Notes/Other.md": { "Attachments/pic.png": 1 },
		"Daily/2026-11-04.md": { "Attachments/scan.pdf": 1, "Attachments/zero.png": 0 },
		"Attachments/scan.pdf": { "Attachments/scan.pdf": 1 },
	};

	it("finds the notes that link or embed a file (sorted, never the file itself, zero counts ignored)", () => {
		expect(linkingNotes(resolved, "Attachments/scan.pdf")).toEqual(["Daily/2026-11-04.md", "Notes/Exam.md"]);
		expect(linkingNotes(resolved, "Attachments/pic.png")).toEqual(["Notes/Other.md"]);
		expect(linkingNotes(resolved, "Attachments/zero.png")).toEqual([]);
		expect(linkingNotes(resolved, "Attachments/none.pdf")).toEqual([]);
		expect(linkingNotes({}, "x")).toEqual([]);
	});

	it("reads Obsidian's link index and treats a missing one as no links", () => {
		const app = { metadataCache: { resolvedLinks: resolved } } as unknown as Parameters<typeof backlinksOf>[0];
		expect(backlinksOf(app, "Attachments/pic.png")).toEqual(["Notes/Other.md"]);
		const broken = { metadataCache: {} } as unknown as Parameters<typeof backlinksOf>[0];
		expect(backlinksOf(broken, "Attachments/pic.png")).toEqual([]);
	});

	it("lists a few note names and counts the rest", () => {
		expect(noteNames(["A/One.md", "Two.md"])).toEqual({ names: ["One", "Two"], more: 0 });
		const six = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"];
		expect(noteNames(six)).toEqual({ names: ["a", "b", "c", "d"], more: 2 });
		expect(noteNames([])).toEqual({ names: [], more: 0 });
	});
});

describe("C3: events apply the same 'since' rule as the scan", () => {
	it("a file older than the moment the folder was first watched is not new", () => {
		const first = sinceFor({}, "Attachments", 5000);
		expect(first.since).toBe(5000);
		expect(isNewSince({ at: 4999 }, first.since)).toBe(false);
		expect(isNewSince({ at: 5000 }, first.since)).toBe(true);
		expect(isNewSince({ at: 9000 }, first.since)).toBe(true);
		// The moment is remembered: a later look does not move it.
		const again = sinceFor(normaliseSince(first.map), "Attachments", 90_000);
		expect(again.since).toBe(5000);
	});
});

describe("C4: a locked page and a pending save", () => {
	const asset: Asset = { id: "a".repeat(64), kind: "image", path: `Notebooks/_assets/${"a".repeat(64)}.png`, name: "a.png", bytes: 10 };
	const docText = (lockLast: boolean): string => {
		const doc = createDocument();
		const a = createPage();
		const b = createPage();
		if (lockLast) b.locked = true;
		doc.pages = [a, b];
		return serialize(doc);
	};

	it("a closed notebook's image element on a locked page is refused by the plan; a new page is not", () => {
		const text = docText(true);
		const onLocked = planClosedEdit(text, prepareImageElement(asset, { width: 100, height: 100 }, 1), new Date(1));
		expect(onLocked.ok).toBe(false);
		if (!onLocked.ok) expect(onLocked.error.code).toBe("page-locked");
		expect(planClosedEdit(text, prepareAppendImagePage(asset, { width: 100, height: 100 }), new Date(1)).ok).toBe(true);
	});

	const rig = (text: string, flush: () => Promise<boolean>, open: boolean, currentPage = 0) => {
		const file = new FakeTFile("Notebooks/N.notebook");
		const edits: string[] = [];
		const view = (() => {
			let live: ReturnType<typeof createDocument> | null = null;
			return {
				file,
				editContext: () => {
					if (!live) return null;
					return {
						doc: live, currentPage: () => currentPage, addPending: () => undefined, removePending: () => undefined,
						execute: (cmd: { apply(d: unknown): void; label: string }) => (edits.push(cmd.label), cmd.apply(live), true),
						flush,
					};
				},
				load(d: ReturnType<typeof createDocument>) { live = d; },
			};
		})();
		const app = {
			workspace: { getLeavesOfType: () => (open ? [{ view }] : []) },
			vault: { read: async () => text },
		} as never;
		return { app, view, file: file as never, edits };
	};

	it("elementPageLocked sees the page in view of an open notebook and the last page of a closed one", async () => {
		const text = docText(true);
		const closed = rig(text, async () => true, false);
		expect(await elementPageLocked(closed.app, closed.file)).toBe(true);
		const unlocked = rig(docText(false), async () => true, false);
		expect(await elementPageLocked(unlocked.app, unlocked.file)).toBe(false);
		const open = rig(text, async () => true, true, 0);
		const doc = createDocument();
		const a = createPage();
		const b = createPage();
		b.locked = true;
		doc.pages = [a, b];
		open.view.load(doc);
		expect(await elementPageLocked(open.app, open.file)).toBe(false); // page 0 (unlocked) is in view
		const inView = rig(text, async () => true, true, 1);
		inView.view.load(doc);
		expect(await elementPageLocked(inView.app, inView.file)).toBe(true);
	});

	it("an edit applied to an open notebook whose save fails is reported as pending, not as a failure to retry", async () => {
		const r = rig(docText(false), async () => false, true);
		const doc = createDocument();
		doc.pages = [createPage()];
		r.view.load(doc);
		await expect(editNotebook(r.app, DEFAULT_SETTINGS, r.file, () => prepareAppendImagePage(asset, { width: 100, height: 100 }), "Insert image page", asset))
			.rejects.toBeInstanceOf(EditPendingSaveError);
		expect(r.edits.length).toBe(1); // applied once; the caller marks the file used so it is not added twice
		expect(doc.pages.length).toBe(2);
	});
});
