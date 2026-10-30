import { describe, expect, it } from "vitest";
import { collectionsOf, deltaPercent, inCollection, stampTime, statsOf, subjectsOf, topFolderOf } from "../src/library/dashboard";
import { INDEX_VERSION, LibraryIndex, type LibraryEntry } from "../src/library/index";
import { entryFromFile, extractStudyCounts } from "../src/library/scan";
import { createDocument, createPage } from "../src/model/document";

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12);

function entry(path: string, patch: Partial<LibraryEntry> = {}): LibraryEntry {
	const folder = path.slice(0, path.lastIndexOf("/"));
	return {
		path, folder, name: path.slice(path.lastIndexOf("/") + 1).replace(/\.notebook$/, ""), mtime: 1, size: 1,
		created: NOW - 100 * DAY, modified: NOW - 100 * DAY, pages: 2, tags: [], favorite: false, cover: "#3b82f6", ...patch,
	};
}

const ctx = { now: NOW, pinned: (e: LibraryEntry) => e.path.includes("pinned") };

describe("dashboard: subjects", () => {
	it("finds the top-level folder under the notebooks root", () => {
		expect(topFolderOf("N/Anatomia/a.notebook", "N")).toBe("N/Anatomia");
		expect(topFolderOf("N/Anatomia/Osso/a.notebook", "N")).toBe("N/Anatomia");
		expect(topFolderOf("N/a.notebook", "N")).toBeNull();
		expect(topFolderOf("Other/x/a.notebook", "N")).toBeNull();
		expect(topFolderOf("Anatomia/a.notebook", "")).toBe("Anatomia");
	});

	it("counts notebooks and pages per subject, recursively, and keeps empty subjects", () => {
		const entries = [
			entry("N/Anatomia/a.notebook", { pages: 3, modified: NOW - DAY }),
			entry("N/Anatomia/Osso/b.notebook", { pages: 4 }),
			entry("N/Fisiologia/c.notebook", { pages: 1 }),
			entry("N/root.notebook", { pages: 9 }),
		];
		const subjects = subjectsOf(entries, "N", ["N/Anatomia", "N/Fisiologia", "N/Matematica"]);
		expect(subjects.map((s) => [s.name, s.notebooks, s.pages])).toEqual([["Anatomia", 2, 7], ["Fisiologia", 1, 1], ["Matematica", 0, 0]]);
		expect(subjects[0]!.modified).toBe(NOW - DAY);
	});
});

describe("dashboard: smart collections", () => {
	it("puts notebooks in the collections by their markers, tags, PDF pages, stars, pins and dates", () => {
		expect(inCollection("study", entry("N/a.notebook", { openMarkers: 2 }), ctx)).toBe(true);
		expect(inCollection("study", entry("N/a.notebook", { tags: ["corso/Da studiare"] }), ctx)).toBe(true);
		expect(inCollection("study", entry("N/a.notebook", { tags: ["studiato"] }), ctx)).toBe(false);
		expect(inCollection("exams", entry("N/a.notebook", { tags: ["Esame"] }), ctx)).toBe(true);
		expect(inCollection("exams", entry("N/a.notebook", { pageTags: [{ page: 0, tags: ["exam"] }] }), ctx)).toBe(true);
		expect(inCollection("pdf", entry("N/a.notebook", { pdfPages: 3 }), ctx)).toBe(true);
		expect(inCollection("favourites", entry("N/a.notebook", { favorite: true }), ctx)).toBe(true);
		expect(inCollection("favourites", entry("N/pinned.notebook"), ctx)).toBe(true);
		expect(inCollection("recent", entry("N/a.notebook", { modified: NOW - 2 * DAY }), ctx)).toBe(true);
		expect(inCollection("recent", entry("N/a.notebook", { modified: NOW - 9 * DAY }), ctx)).toBe(false);
	});

	it("hides empty collections and keeps the display order", () => {
		const list = collectionsOf([entry("N/a.notebook", { pdfPages: 1, favorite: true }), entry("N/b.notebook", { favorite: true })], ctx);
		expect(list).toEqual([{ id: "favourites", count: 2 }, { id: "pdf", count: 1 }]);
	});
});

describe("dashboard: statistics", () => {
	const entries = [
		entry("N/new1.notebook", { created: NOW - 2 * DAY, modified: NOW - DAY, tags: ["A", "b"], pdfPages: 2 }),
		entry("N/new2.notebook", { created: NOW - 20 * DAY, modified: NOW - 20 * DAY, tags: ["a"] }),
		entry("N/old.notebook", { created: NOW - 40 * DAY, modified: NOW - 3 * DAY, tags: ["c"] }),
		entry("N/older.notebook", { created: NOW - 50 * DAY, modified: NOW - 60 * DAY, tags: ["d"] }),
	];
	const edits = [
		{ path: "N/new1.notebook", page: "p1", at: NOW - DAY },
		{ path: "N/new1.notebook", page: "p2", at: NOW - 2 * DAY },
		{ path: "N/old.notebook", page: "p1", at: NOW - 40 * DAY },
	];

	it("counts over the period, with half-week bars for four weeks", () => {
		const [created, edited, pdf, tags] = statsOf(entries, edits, NOW, 4);
		expect(created).toMatchObject({ id: "created", value: 2, previous: 2 });
		expect(created!.series).toHaveLength(8);
		expect(created!.series.reduce((a, b) => a + b, 0)).toBe(2);
		expect(edited).toMatchObject({ value: 2, previous: null });
		expect(pdf!.value).toBe(1);
		// Distinct tags of the notebooks changed in the period, case-insensitive: A/a, b, c.
		expect(tags!.value).toBe(3);
		expect(deltaPercent(created!)).toBe(0);
		expect(deltaPercent(edited!)).toBeNull();
	});

	it("uses daily bars for one week and weekly bars for twelve", () => {
		expect(statsOf(entries, edits, NOW, 1)[0]!.series).toHaveLength(7);
		expect(statsOf(entries, edits, NOW, 12)[0]!.series).toHaveLength(12);
		expect(statsOf(entries, edits, NOW, 12)[0]!.value).toBe(4);
	});

	it("shows no delta without an earlier value", () => {
		expect(deltaPercent({ id: "created", value: 3, previous: 0, series: [] })).toBeNull();
		expect(deltaPercent({ id: "created", value: 3, previous: 2, series: [] })).toBe(50);
	});
});

describe("dashboard: times", () => {
	it("says today and yesterday, then the date", () => {
		const now = new Date(2026, 9, 30, 15, 0).getTime();
		expect(stampTime(new Date(2026, 9, 30, 10, 24).getTime(), now, "en")).toMatch(/^Today, /);
		expect(stampTime(new Date(2026, 9, 29, 18, 6).getTime(), now, "it")).toMatch(/^Ieri, /);
		expect(stampTime(new Date(2026, 0, 12, 14, 32).getTime(), now, "it")).toMatch(/^12 gen/);
		expect(stampTime(new Date(2025, 0, 12, 14, 32).getTime(), now, "en")).toMatch(/2025/);
	});
});

describe("index v5: PDF pages and open markers", () => {
	it("counts PDF pages and open gap, question and homework markers", () => {
		const doc = createDocument();
		const pdf = createPage();
		pdf.background = { kind: "pdf", asset: "a", page: 1 };
		doc.pages.push(pdf);
		doc.pages[0]!.elements = [
			{ id: "m1", type: "marker", kind: "question", x: 0, y: 0 },
			{ id: "m2", type: "marker", kind: "homework", x: 0, y: 0, done: true },
			{ id: "m3", type: "marker", kind: "important", x: 0, y: 0 },
			{ id: "m4", type: "marker", kind: "gap", x: 0, y: 0 },
		];
		expect(extractStudyCounts(doc)).toEqual({ pdfPages: 1, openMarkers: 2 });
		const e = entryFromFile({ path: "N/a.notebook", mtime: 1, size: 1 }, doc);
		expect(e.pdfPages).toBe(1);
		expect(e.openMarkers).toBe(2);
		expect(entryFromFile({ path: "N/b.notebook", mtime: 1, size: 1 }, createDocument())).not.toHaveProperty("pdfPages");
	});

	it("keeps the counts through the saved index and rebuilds an index of version 4", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("N/a.notebook", { pdfPages: 2, openMarkers: 1 }));
		const back = LibraryIndex.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())));
		expect(back.get("N/a.notebook")).toMatchObject({ pdfPages: 2, openMarkers: 1 });
		expect(LibraryIndex.fromJSON({ version: 4, entries: idx.toJSON().entries }).size).toBe(0);
		expect(INDEX_VERSION).toBe(5);
	});
});
