import { describe, expect, it } from "vitest";
import { breadcrumb, buildFolderTree, flattenTree, isReservedPath } from "../src/library/folders";
import { relativeTime, uniquePath } from "../src/library/format";
import {
	folderOf, INDEX_VERSION, isInside, LibraryIndex, nameOf, normalizeText, RECENT_LIMIT, SNIPPET_RADIUS, type LibraryEntry,
} from "../src/library/index";
import { COVER_COLORS, DEFAULT_COVER, entryFromFile, filesToRead, metaFromDocument, parseTags, TEXT_CAP } from "../src/library/scan";
import { thumbnailSize } from "../src/library/thumbnail";
import { createDocument } from "../src/model/document";
import type { NotebookDocument } from "../src/model/types";
import { sampleDocument } from "./helpers";

function entry(path: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
	return {
		path, folder: folderOf(path), name: nameOf(path), mtime: 1000, size: 500,
		created: 1000, modified: 1000, pages: 1, tags: [], favorite: false, cover: DEFAULT_COVER, ...over,
	};
}

function sample(): LibraryIndex {
	const idx = new LibraryIndex();
	idx.upsert(entry("Notebooks/Zebra.notebook", { modified: 300, created: 100, tags: ["Work"] }));
	idx.upsert(entry("Notebooks/apple.notebook", { modified: 100, created: 300, favorite: true, tags: ["school", "Math"] }));
	idx.upsert(entry("Notebooks/École.notebook", { modified: 200, created: 200, tags: ["Idées"] }));
	idx.upsert(entry("Notebooks/Uni/Algebra.notebook", { modified: 250, created: 50, tags: ["math"], favorite: true }));
	idx.upsert(entry("Notebooks/Uni/Deep/Topology.notebook", { modified: 400, created: 10 }));
	return idx;
}

const names = (list: LibraryEntry[]) => list.map((e) => e.name);

describe("path helpers", () => {
	it("splits paths", () => {
		expect(folderOf("a/b/c.notebook")).toBe("a/b");
		expect(folderOf("c.notebook")).toBe("");
		expect(nameOf("a/b/c.notebook")).toBe("c");
		expect(nameOf("a/b/my.note.notebook")).toBe("my.note");
	});

	it("isInside treats the root as containing everything and does not confuse prefixes", () => {
		expect(isInside("a/b.notebook", "a")).toBe(true);
		expect(isInside("ab/c.notebook", "a")).toBe(false);
		expect(isInside("anything", "")).toBe(true);
		expect(isInside("a", "a")).toBe(true);
	});

	it("normalizeText removes case and diacritics", () => {
		expect(normalizeText("École Été")).toBe("ecole ete");
		expect(normalizeText("ÀÈÌÒÙ")).toBe("aeiou");
	});
});

describe("LibraryIndex queries", () => {
	it("all, sorted by modified (newest first) by default", () => {
		expect(names(sample().query({ scope: "all", sort: "modified" }))).toEqual(["Topology", "Zebra", "Algebra", "École", "apple"]);
	});

	it("sorts by name ignoring case and accents, and by created", () => {
		const idx = sample();
		expect(names(idx.query({ scope: "all", sort: "name" }))).toEqual(["Algebra", "apple", "École", "Topology", "Zebra"]);
		expect(names(idx.query({ scope: "all", sort: "created" }))).toEqual(["apple", "École", "Zebra", "Algebra", "Topology"]);
	});

	it("sorts numbers naturally", () => {
		const idx = new LibraryIndex();
		for (const n of ["Note 10", "Note 2", "Note 1"]) idx.upsert(entry(`${n}.notebook`));
		expect(names(idx.query({ scope: "all", sort: "name" }))).toEqual(["Note 1", "Note 2", "Note 10"]);
	});

	it("favorites", () => {
		expect(names(sample().query({ scope: "favorites", sort: "name" }))).toEqual(["Algebra", "apple"]);
	});

	it("recent is the top 20 by modified, then sorted as requested", () => {
		const idx = new LibraryIndex();
		for (let i = 0; i < 30; i++) idx.upsert(entry(`n${String(i).padStart(2, "0")}.notebook`, { modified: i }));
		const recent = idx.query({ scope: "recent", sort: "modified" });
		expect(recent).toHaveLength(RECENT_LIMIT);
		expect(recent[0]!.name).toBe("n29");
		expect(recent[recent.length - 1]!.name).toBe("n10");
		expect(names(idx.query({ scope: "recent", sort: "name" }))[0]).toBe("n10");
	});

	it("folder scope is non-recursive unless asked", () => {
		const idx = sample();
		expect(names(idx.query({ scope: { folder: "Notebooks/Uni" }, sort: "name" }))).toEqual(["Algebra"]);
		expect(names(idx.query({ scope: { folder: "Notebooks/Uni", recursive: true }, sort: "name" }))).toEqual(["Algebra", "Topology"]);
		expect(idx.query({ scope: { folder: "Notebooks" }, sort: "name" })).toHaveLength(3);
		expect(idx.query({ scope: { folder: "Notebooks", recursive: true }, sort: "name" })).toHaveLength(5);
		expect(idx.query({ scope: { folder: "Note", recursive: true }, sort: "name" })).toHaveLength(0);
	});

	it("tag scope is case and accent insensitive and exact", () => {
		const idx = sample();
		expect(names(idx.query({ scope: { tag: "MATH" }, sort: "name" }))).toEqual(["Algebra", "apple"]);
		expect(names(idx.query({ scope: { tag: "idees" }, sort: "name" }))).toEqual(["École"]);
		expect(idx.query({ scope: { tag: "mat" }, sort: "name" })).toHaveLength(0);
	});

	it("search matches name and tags without accents or case", () => {
		const idx = sample();
		expect(names(idx.query({ scope: "all", sort: "name", search: "ecole" }))).toEqual(["École"]);
		expect(names(idx.query({ scope: "all", sort: "name", search: "ÉCOLE" }))).toEqual(["École"]);
		expect(names(idx.query({ scope: "all", sort: "name", search: "idee" }))).toEqual(["École"]);
		expect(names(idx.query({ scope: "all", sort: "name", search: "math" }))).toEqual(["Algebra", "apple"]);
		expect(names(idx.query({ scope: "all", sort: "name", search: "alg" }))).toEqual(["Algebra"]);
	});

	it("every search term must match (name or tag)", () => {
		const idx = sample();
		expect(names(idx.query({ scope: "all", sort: "name", search: "apple school" }))).toEqual(["apple"]);
		expect(idx.query({ scope: "all", sort: "name", search: "apple work" })).toHaveLength(0);
		expect(idx.query({ scope: "all", sort: "name", search: "   " })).toHaveLength(5);
	});

	it("search combines with the scope", () => {
		expect(names(sample().query({ scope: "favorites", sort: "name", search: "alg" }))).toEqual(["Algebra"]);
	});
});

describe("LibraryIndex maintenance", () => {
	it("isStale: unknown, changed mtime, changed size, unchanged", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("a.notebook", { mtime: 10, size: 20 }));
		expect(idx.isStale("a.notebook", 10, 20)).toBe(false);
		expect(idx.isStale("a.notebook", 11, 20)).toBe(true);
		expect(idx.isStale("a.notebook", 10, 21)).toBe(true);
		expect(idx.isStale("b.notebook", 10, 20)).toBe(true);
	});

	it("upsert replaces and copies the tags array", () => {
		const idx = new LibraryIndex();
		const tags = ["a"];
		idx.upsert(entry("a.notebook", { tags }));
		tags.push("b");
		expect(idx.get("a.notebook")!.tags).toEqual(["a"]);
		idx.upsert(entry("a.notebook", { pages: 9 }));
		expect(idx.size).toBe(1);
		expect(idx.get("a.notebook")!.pages).toBe(9);
	});

	it("remove", () => {
		const idx = sample();
		expect(idx.remove("Notebooks/Zebra.notebook")).toBe(true);
		expect(idx.remove("Notebooks/Zebra.notebook")).toBe(false);
		expect(idx.size).toBe(4);
	});

	it("rename moves the entry, updates folder and name, keeps the rest", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("A/x.notebook", { thumb: "data:image/png;base64,AAA", thumbMtime: 1000, tags: ["t"] }));
		expect(idx.rename("A/x.notebook", "B/C/y.notebook")).toBe(true);
		expect(idx.has("A/x.notebook")).toBe(false);
		const e = idx.get("B/C/y.notebook")!;
		expect(e).toMatchObject({ path: "B/C/y.notebook", folder: "B/C", name: "y", mtime: 1000, thumb: "data:image/png;base64,AAA", tags: ["t"] });
		expect(idx.rename("nope.notebook", "z.notebook")).toBe(false);
		expect(idx.rename("B/C/y.notebook", "B/C/y.notebook")).toBe(false);
		expect(idx.isStale("B/C/y.notebook", 1000, 500)).toBe(false);
	});

	it("renameFolder moves everything inside, nested too, and only exact folder prefixes", () => {
		const idx = sample();
		idx.upsert(entry("Notebooks/UniX/Other.notebook"));
		expect(idx.renameFolder("Notebooks/Uni", "Notebooks/College")).toBe(2);
		expect(idx.has("Notebooks/College/Algebra.notebook")).toBe(true);
		expect(idx.get("Notebooks/College/Deep/Topology.notebook")!.folder).toBe("Notebooks/College/Deep");
		expect(idx.has("Notebooks/UniX/Other.notebook")).toBe(true);
		expect(idx.has("Notebooks/Uni/Algebra.notebook")).toBe(false);
	});

	it("prune drops entries of deleted files and reports them", () => {
		const idx = sample();
		const removed = idx.prune(["Notebooks/Zebra.notebook", "Notebooks/apple.notebook", "unknown.notebook"]);
		expect(removed.sort()).toEqual(["Notebooks/Uni/Algebra.notebook", "Notebooks/Uni/Deep/Topology.notebook", "Notebooks/École.notebook"].sort());
		expect(idx.size).toBe(2);
		expect(idx.prune([])).toHaveLength(2);
		expect(idx.size).toBe(0);
	});

	it("patch merges fields", () => {
		const idx = sample();
		expect(idx.patch("Notebooks/Zebra.notebook", { favorite: true })).toBe(true);
		expect(idx.get("Notebooks/Zebra.notebook")!.favorite).toBe(true);
		expect(idx.patch("missing", { favorite: true })).toBe(false);
	});

	it("needsThumb: missing, stale, fresh, and unreadable files", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("a.notebook"));
		expect(idx.needsThumb("a.notebook")).toBe(true);
		idx.patch("a.notebook", { thumb: "data:x", thumbMtime: 999 });
		expect(idx.needsThumb("a.notebook")).toBe(true);
		idx.patch("a.notebook", { thumbMtime: 1000 });
		expect(idx.needsThumb("a.notebook")).toBe(false);
		idx.upsert(entry("b.notebook", { pages: 0 }));
		expect(idx.needsThumb("b.notebook")).toBe(false);
		expect(idx.needsThumb("zzz.notebook")).toBe(false);
	});
});

describe("tags", () => {
	it("counts per notebook, case-insensitively, most used first", () => {
		const idx = sample();
		idx.upsert(entry("x.notebook", { tags: ["MATH", "math", "Extra"] }));
		const tags = idx.tags();
		expect(tags[0]).toEqual({ tag: "Math", count: 3 });
		expect(tags.map((x) => x.tag)).toContain("Extra");
		expect(tags.find((x) => x.tag === "Extra")!.count).toBe(1);
		expect(tags.filter((x) => x.tag.toLowerCase() === "math")).toHaveLength(1);
	});

	it("is empty without tags", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("a.notebook"));
		expect(idx.tags()).toEqual([]);
	});

	it("parseTags splits, strips #, trims and removes duplicates", () => {
		expect(parseTags(" #math, Math ,, physics;\n  #  lab ")).toEqual(["math", "physics", "lab"]);
		expect(parseTags("")).toEqual([]);
	});
});

describe("JSON", () => {
	it("round-trips", () => {
		const idx = sample();
		idx.patch("Notebooks/Zebra.notebook", { thumb: "data:image/jpeg;base64,AAAA", thumbMtime: 1000 });
		const copy = LibraryIndex.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())));
		expect(copy.size).toBe(5);
		expect(copy.all().sort((a, b) => a.path.localeCompare(b.path))).toEqual(idx.all().sort((a, b) => a.path.localeCompare(b.path)));
	});

	it("writes the version", () => {
		expect(new LibraryIndex().toJSON()).toEqual({ version: INDEX_VERSION, entries: [] });
	});

	it("unknown or old version, or garbage, gives an empty index", () => {
		const data = sample().toJSON();
		expect(LibraryIndex.fromJSON({ ...data, version: INDEX_VERSION + 1 }).size).toBe(0);
		expect(LibraryIndex.fromJSON({ ...data, version: 0 }).size).toBe(0);
		expect(LibraryIndex.fromJSON({ entries: data.entries }).size).toBe(0);
		for (const junk of [null, undefined, 42, "x", [], { version: INDEX_VERSION }, { version: INDEX_VERSION, entries: "no" }]) {
			expect(LibraryIndex.fromJSON(junk).size).toBe(0);
		}
	});

	it("skips malformed entries but keeps the good ones", () => {
		const data = sample().toJSON();
		const bad = [{ path: "x" }, null, 3, { ...data.entries[0]!, tags: "nope" }, { ...data.entries[1]!, pages: "2" }];
		const idx = LibraryIndex.fromJSON({ version: INDEX_VERSION, entries: [...bad, ...data.entries.slice(2)] });
		expect(idx.size).toBe(3);
	});
});

describe("scan", () => {
	it("filesToRead returns new and changed files only", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("a.notebook", { mtime: 1, size: 1 }));
		idx.upsert(entry("b.notebook", { mtime: 2, size: 2 }));
		const files = [
			{ path: "a.notebook", mtime: 1, size: 1 },
			{ path: "b.notebook", mtime: 3, size: 2 },
			{ path: "c.notebook", mtime: 1, size: 1 },
		];
		expect(filesToRead(files, idx).map((f) => f.path)).toEqual(["b.notebook", "c.notebook"]);
		expect(filesToRead([], idx)).toEqual([]);
	});

	it("placeholder entries (mtime -1) are always stale", () => {
		const idx = new LibraryIndex();
		idx.upsert({ ...entryFromFile({ path: "a.notebook", mtime: 5, size: 5 }, null), mtime: -1, size: -1 });
		expect(filesToRead([{ path: "a.notebook", mtime: 5, size: 5 }], idx)).toHaveLength(1);
	});

	it("metaFromDocument tolerates a document without v4 meta", () => {
		const doc = sampleDocument();
		const m = metaFromDocument(doc);
		expect(m).toEqual({
			id: doc.id, pages: 1, tags: [], favorite: false, cover: DEFAULT_COVER,
			created: Date.parse("2026-10-29T10:00:00.000Z"), modified: Date.parse("2026-10-29T10:00:00.000Z"),
		});
	});

	it("metaFromDocument reads meta and sanitises it", () => {
		const doc: NotebookDocument = {
			...createDocument(new Date("2026-01-01T00:00:00.000Z")),
			modifiedAt: "2026-02-01T00:00:00.000Z",
			meta: { tags: [" a ", "A", "", "b"], favorite: true, cover: "#112233", bookmarks: [] },
		};
		const m = metaFromDocument(doc);
		expect(m.tags).toEqual(["a", "b"]);
		expect(m.favorite).toBe(true);
		expect(m.cover).toBe("#112233");
		expect(m.modified).toBeGreaterThan(m.created);
	});

	it("metaFromDocument survives odd meta and bad dates", () => {
		const doc = {
			...createDocument(),
			createdAt: "not a date",
			modifiedAt: 5,
			meta: { tags: "x", favorite: "yes", cover: "red" },
		} as unknown as NotebookDocument;
		const m = metaFromDocument(doc, 777);
		expect(m).toMatchObject({ tags: [], favorite: false, cover: DEFAULT_COVER, created: 777, modified: 777, pages: 1 });
	});

	it("entryFromFile builds path-derived fields, keeps the previous thumbnail, and handles unreadable files", () => {
		const doc = sampleDocument();
		const prev = entry("F/n.notebook", { thumb: "data:old", thumbMtime: 5 });
		const e = entryFromFile({ path: "F/n.notebook", mtime: 99, size: 7 }, doc, prev);
		expect(e).toMatchObject({ path: "F/n.notebook", folder: "F", name: "n", mtime: 99, size: 7, pages: 1, thumb: "data:old", thumbMtime: 5 });
		const idx = new LibraryIndex();
		idx.upsert(e);
		expect(idx.needsThumb("F/n.notebook")).toBe(true);

		const broken = entryFromFile({ path: "n.notebook", mtime: 4, size: 1 }, null);
		expect(broken).toMatchObject({ pages: 0, folder: "", name: "n", created: 4, modified: 4, favorite: false });
		expect(broken.thumb).toBeUndefined();
	});

	it("cover colours are valid and the default is one of them", () => {
		for (const c of COVER_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
		expect(COVER_COLORS).toContain(DEFAULT_COVER);
	});
});

describe("folders", () => {
	it("builds a sorted tree, fills in missing parents and skips reserved folders", () => {
		const tree = buildFolderTree("Notebooks", [
			"Notebooks/b", "Notebooks/a/deep/er", "Notebooks/_assets", "Notebooks/_backup/x", "Notebooks/A2", "Other/x",
		]);
		expect(tree.name).toBe("Notebooks");
		expect(tree.children.map((c) => c.name)).toEqual(["a", "A2", "b"]);
		expect(flattenTree(tree).map((n) => n.path)).toEqual([
			"Notebooks", "Notebooks/a", "Notebooks/a/deep", "Notebooks/a/deep/er", "Notebooks/A2", "Notebooks/b",
		]);
	});

	it("works with the vault root as the notebooks folder", () => {
		const tree = buildFolderTree("", ["x", "x/y", "_assets", "z"]);
		expect(flattenTree(tree).map((n) => n.path)).toEqual(["", "x", "x/y", "z"]);
	});

	it("isReservedPath", () => {
		expect(isReservedPath("Notebooks/_assets", "Notebooks")).toBe(true);
		expect(isReservedPath("Notebooks/_backup/a.bak", "Notebooks")).toBe(true);
		expect(isReservedPath("Notebooks/sub/_assets", "Notebooks")).toBe(false);
		expect(isReservedPath("Notebooks", "Notebooks")).toBe(false);
		expect(isReservedPath("_assets/x", "")).toBe(true);
	});

	it("breadcrumb lists ancestors from the root", () => {
		expect(breadcrumb("Notebooks", "Notebooks/a/b")).toEqual([
			{ path: "Notebooks", name: "Notebooks" }, { path: "Notebooks/a", name: "a" }, { path: "Notebooks/a/b", name: "b" },
		]);
		expect(breadcrumb("Notebooks", "Notebooks")).toHaveLength(1);
		expect(breadcrumb("", "a/b").map((p) => p.path)).toEqual(["", "a", "a/b"]);
	});
});

describe("format", () => {
	const now = Date.UTC(2026, 9, 29, 12, 0, 0);

	it("relativeTime", () => {
		expect(relativeTime(now - 5_000, now, "en")).toBe("now");
		expect(relativeTime(now - 3 * 3600_000, now, "en")).toBe("3 hours ago");
		expect(relativeTime(now - 24 * 3600_000, now, "en")).toBe("yesterday");
		expect(relativeTime(now - 3 * 24 * 3600_000, now, "en")).toBe("3 days ago");
		expect(relativeTime(now - 40 * 24 * 3600_000, now, "en")).toBe("last month");
		expect(relativeTime(now - 3 * 3600_000, now, "it")).toBe("3 ore fa");
	});

	it("uniquePath adds a counter until the path is free", () => {
		const taken = new Set(["F/a.notebook", "F/a 2.notebook"]);
		expect(uniquePath("F", "a", "notebook", (p) => taken.has(p))).toBe("F/a 3.notebook");
		expect(uniquePath("F", "b", "notebook", (p) => taken.has(p))).toBe("F/b.notebook");
		expect(uniquePath("", "a", "notebook", () => false)).toBe("a.notebook");
	});
});

describe("thumbnail size", () => {
	const page = (width: number, height: number) => ({ ...sampleDocument().pages[0]!, width, height });

	it("keeps the aspect ratio", () => {
		const s = thumbnailSize(page(600, 800), 300);
		expect(s).toEqual({ width: 300, height: 400, scale: 0.5 });
	});

	it("caps very tall (infinite) pages", () => {
		const s = thumbnailSize(page(500, 5000), 250);
		expect(s.height).toBe(375);
	});

	it("never returns an empty canvas", () => {
		const s = thumbnailSize(page(0, 0), 0);
		expect(s.width).toBeGreaterThan(0);
		expect(s.height).toBeGreaterThan(0);
	});
});

describe("library search", () => {
	function docWithText(pagesText: string[][]): NotebookDocument {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		doc.pages = pagesText.map((texts, i) => ({
			...doc.pages[0]!,
			id: `p${i}`,
			elements: texts.map((text, j) => ({ id: `t${i}-${j}`, type: "text" as const, x: 0, y: 0, width: 100, text, fontSize: 16, color: "#000000" })),
		}));
		return doc;
	}
	const info = { path: "N/Notes.notebook", mtime: 5, size: 9 };

	it("indexes the text of all pages with the page of each start", () => {
		const e = entryFromFile(info, docWithText([["Hello  world", ""], [], ["Second\n page"]]));
		expect(e.text).toBe("Hello world\nSecond page");
		expect(e.textPages).toEqual([0, 0, 2, 12]);
		expect(e.pages).toBe(3);
	});

	it("caps the indexed text", () => {
		const e = entryFromFile(info, docWithText([["x".repeat(30_000)]]));
		expect(e.text!.length).toBe(TEXT_CAP);
	});

	it("omits text fields when there is no text", () => {
		const e = entryFromFile(info, docWithText([[]]));
		expect(e.text).toBeUndefined();
		expect(e.textPages).toBeUndefined();
	});

	it("round-trips text through JSON and discards an old index version", () => {
		const idx = new LibraryIndex();
		idx.upsert(entryFromFile(info, docWithText([["alpha"]])));
		const copy = LibraryIndex.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())));
		expect(copy.get(info.path)?.text).toBe("alpha");
		const old = { ...idx.toJSON(), version: INDEX_VERSION - 1 };
		expect(LibraryIndex.fromJSON(old).size).toBe(0);
		expect(INDEX_VERSION).toBeGreaterThanOrEqual(2);
	});

	it("rejects a malformed textPages", () => {
		const j = JSON.parse(JSON.stringify({ version: INDEX_VERSION, entries: [{ ...entry("a.notebook"), text: "x", textPages: [0] }] }));
		expect(LibraryIndex.fromJSON(j).size).toBe(0);
	});

	function searchable(): LibraryIndex {
		const idx = new LibraryIndex();
		idx.upsert(entryFromFile({ path: "N/Chimica.notebook", mtime: 1, size: 1 }, docWithText([["intro"], ["La reazione è esotermica"]])));
		idx.upsert(entryFromFile({ path: "N/Fisica/Termo.notebook", mtime: 1, size: 1 }, docWithText([["Entropia e calore"], ["x"], ["Reazione inversa"]])));
		idx.patch("N/Fisica/Termo.notebook", { tags: ["Calore"] });
		return idx;
	}

	it("matches case- and accent-insensitively and finds the first page", () => {
		const hits = searchable().search({ search: "ESOTERMICA", sort: "name" });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.fields).toEqual(["text"]);
		expect(hits[0]!.text!.page).toBe(1);
		const h = hits[0]!.text!.snippet;
		expect(h.text.slice(h.ranges[0]![0], h.ranges[0]![1])).toBe("esotermica");
		expect(searchable().search({ search: "è", sort: "name" })).toHaveLength(2);
	});

	it("requires every word, each in any field", () => {
		const idx = searchable();
		expect(idx.search({ search: "reazione termo", sort: "name" }).map((h) => h.entry.name)).toEqual(["Termo"]);
		expect(idx.search({ search: "reazione chimica", sort: "name" }).map((h) => h.entry.name)).toEqual(["Chimica"]);
		expect(idx.search({ search: "reazione zzz", sort: "name" })).toEqual([]);
		expect(idx.search({ search: "   ", sort: "name" })).toEqual([]);
	});

	it("reports title and tag matches with highlights and ranks title first", () => {
		const idx = searchable();
		const hits = idx.search({ search: "calore", sort: "name" });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.fields).toEqual(["tag", "text"]);
		expect(hits[0]!.tag).toEqual({ text: "Calore", ranges: [[0, 6]] });
		expect(hits[0]!.text!.page).toBe(0);
		const title = idx.search({ search: "chim", sort: "name" })[0]!;
		expect(title.fields[0]).toBe("title");
		expect(title.title).toEqual({ text: "Chimica", ranges: [[0, 4]] });
	});

	it("page of first match follows the earliest occurrence", () => {
		const hit = searchable().search({ search: "reazione", scope: { folder: "N/Fisica", recursive: true }, sort: "name" })[0]!;
		expect(hit.text!.page).toBe(2);
	});

	it("keeps snippets short and ellipsised", () => {
		const long = `${"a ".repeat(200)}needle${" b".repeat(200)}`;
		const idx = new LibraryIndex();
		idx.upsert(entryFromFile(info, docWithText([[long]])));
		const s = idx.search({ search: "needle", sort: "name" })[0]!.text!.snippet;
		expect(s.text.length).toBeLessThanOrEqual(2 * SNIPPET_RADIUS + "needle".length + 2);
		expect(s.text.startsWith("…")).toBe(true);
		expect(s.text.endsWith("…")).toBe(true);
		const [a, b] = s.ranges[0]!;
		expect(s.text.slice(a, b)).toBe("needle");
	});

	it("limits the search to a scope", () => {
		const idx = searchable();
		expect(idx.search({ search: "reazione", scope: { folder: "N/Fisica", recursive: true }, sort: "name" })).toHaveLength(1);
		expect(idx.search({ search: "reazione", scope: "favorites", sort: "name" })).toHaveLength(0);
	});
});
