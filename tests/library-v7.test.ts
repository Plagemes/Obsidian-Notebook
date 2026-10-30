/** v7 page tags in the library index and search (#119). */
import { describe, expect, it } from "vitest";
import { folderOf, INDEX_VERSION, LibraryIndex, nameOf, type LibraryEntry } from "../src/library/index";
import { DEFAULT_COVER, entryFromFile, metaFromDocument } from "../src/library/scan";
import { createPage } from "../src/model/document";
import { sampleDocument } from "./helpers";

function entry(path: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
	return {
		path, folder: folderOf(path), name: nameOf(path), mtime: 1000, size: 500,
		created: 1000, modified: 1000, pages: 3, tags: [], favorite: false, cover: DEFAULT_COVER, ...over,
	};
}

describe("library index: page tags", () => {
	it("the index entry lists the pages that have tags", () => {
		const doc = sampleDocument(1);
		doc.pages.push(createPage(), createPage());
		doc.pages[2]!.tags = ["Exam", "lab"];
		expect(metaFromDocument(doc).pageTags).toEqual([{ page: 2, tags: ["Exam", "lab"] }]);
		expect("pageTags" in metaFromDocument(sampleDocument(1))).toBe(false);
		const e = entryFromFile({ path: "N/a.notebook", mtime: 1, size: 1 }, doc);
		expect(e.pageTags).toEqual([{ page: 2, tags: ["Exam", "lab"] }]);
	});

	it("search finds a page tag and points at its page; title and notebook tags rank higher", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("N/Biology.notebook", { pageTags: [{ page: 4, tags: ["chapter 2"] }, { page: 7, tags: ["Exam"] }] }));
		idx.upsert(entry("N/Exams.notebook"));
		idx.upsert(entry("N/Chem.notebook", { tags: ["exam"] }));
		const hits = idx.search({ search: "exam", sort: "name" });
		expect(hits.map((h) => [h.entry.name, h.fields[0]])).toEqual([["Exams", "title"], ["Chem", "tag"], ["Biology", "pageTag"]]);
		const bio = hits[2]!;
		expect(bio.pageTag?.page).toBe(7);
		expect(bio.pageTag?.tag).toEqual({ text: "Exam", ranges: [[0, 4]] });
		// Several words may match different fields.
		expect(idx.search({ search: "biology chapter", sort: "name" }).map((h) => h.entry.name)).toEqual(["Biology"]);
		expect(idx.search({ search: "chapter", sort: "name" })[0]?.pageTag?.page).toBe(4);
	});

	it("the stored index keeps page tags and rejects malformed ones; older indexes are rebuilt", () => {
		const idx = new LibraryIndex();
		const e = entry("N/a.notebook", { pageTags: [{ page: 0, tags: ["x"] }] });
		idx.upsert(e);
		e.pageTags![0]!.tags.push("mutated");
		const json = JSON.parse(JSON.stringify(idx.toJSON())) as unknown;
		expect(LibraryIndex.fromJSON(json).get("N/a.notebook")?.pageTags).toEqual([{ page: 0, tags: ["x"] }]);
		const bad = { version: INDEX_VERSION, entries: [entry("N/b.notebook", { pageTags: [{ page: "1", tags: ["x"] }] as never })] };
		expect(LibraryIndex.fromJSON(bad).size).toBe(0);
		expect(LibraryIndex.fromJSON({ version: 2, entries: [entry("N/c.notebook")] }).size).toBe(0);
		expect(INDEX_VERSION).toBeGreaterThanOrEqual(4);
	});
});
