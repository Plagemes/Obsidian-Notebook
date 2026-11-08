/**
 * Review fixes of the global bookmarks (W6-W10): resolving a bookmark to a notebook (path trusted only when the id agrees, never written while
 * looking, one scan per session), copies of a notebook (same id) told apart by path, every unknown field kept on rewrite, and the same page
 * bookmarked on two devices being one row.
 */
import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import { BookmarkResolver } from "../src/library/bookmark-resolve";
import {
	applyBookmarkOps, bookmarkTwins, emptyBookmarks, findBookmark, liveBookmarks, mergeBookmarkFiles, parseBookmarks, serializeBookmarks,
	type BookmarksFile, type StoredBookmark,
} from "../src/library/bookmarks";
import { BookmarksStore } from "../src/library/bookmarks-store";

const bm = (id: string, order: number, o: Partial<StoredBookmark> = {}): StoredBookmark => ({ id, docId: "doc1", path: "N/a.notebook", pageId: "pg1", num: 3, order, at: 10, ...o });
const file = (device: string, items: StoredBookmark[], unknown: unknown[] = []): BookmarksFile => ({ ...emptyBookmarks(device), items, unknown });

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	writes: string[] = [];
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); this.writes.push(p); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

describe("W6/W7: resolving a bookmark to a notebook", () => {
	interface F { path: string }
	function world(ids: Record<string, string | null>) {
		const reads: string[] = [];
		const files: F[] = Object.keys(ids).map((path) => ({ path }));
		const resolver = new BookmarkResolver<F>({
			fileAt: (p) => files.find((f) => f.path === p) ?? null,
			notebooks: () => files,
			idOf: async (f) => {
				reads.push(f.path);
				return ids[f.path] ?? null;
			},
		});
		return { resolver, reads };
	}

	it("trusts the file at the path when its id agrees, or when there is no id to compare", async () => {
		const { resolver } = world({ "N/a.notebook": "doc1", "N/u.notebook": null });
		expect(await resolver.resolve({ path: "N/a.notebook", docId: "doc1" })).toMatchObject({ byId: false });
		expect(await resolver.resolve({ path: "N/u.notebook", docId: "doc1" })).toMatchObject({ byId: false });
		expect(await resolver.resolve({ path: "N/a.notebook", docId: "" })).toMatchObject({ byId: false });
	});

	it("a different notebook now at the old path is not mistaken for the bookmark's notebook: it is found by id", async () => {
		const { resolver } = world({ "N/a.notebook": "other", "M/moved.notebook": "doc1" });
		const r = await resolver.resolve({ path: "N/a.notebook", docId: "doc1" });
		expect(r).toMatchObject({ byId: true, unique: true, file: { path: "M/moved.notebook" } });
	});

	it("with the notebook not there at all, a bookmark finds nothing (and a path-only one finds nothing either)", async () => {
		const { resolver } = world({ "N/a.notebook": "other" });
		expect(await resolver.resolve({ path: "N/a.notebook", docId: "doc1" })).toBeNull();
		expect(await resolver.resolve({ path: "N/gone.notebook", docId: "" })).toBeNull();
	});

	it("says when more than one notebook carries the id (a copy), so the caller does not move the bookmark", async () => {
		const { resolver } = world({ "A/x (conflict).notebook": "doc1", "B/y.notebook": "doc1" });
		const r = await resolver.resolve({ path: "N/gone.notebook", docId: "doc1" });
		expect(r).toMatchObject({ byId: true, unique: false });
	});

	it("reads each notebook's id once for a whole list of missing bookmarks, 'not found' included", async () => {
		const { resolver, reads } = world({ "A.notebook": "d1", "B.notebook": "d2", "C.notebook": "d3" });
		for (let i = 0; i < 5; i++) {
			expect(await resolver.resolve({ path: `gone${i}.notebook`, docId: "nobody" })).toBeNull();
			expect(await resolver.resolve({ path: `gone${i}.notebook`, docId: "d2" })).toMatchObject({ file: { path: "B.notebook" } });
		}
		expect(reads.sort()).toEqual(["A.notebook", "B.notebook", "C.notebook"]);
	});

	it("resolving never writes anything to the bookmarks (it has no way to)", async () => {
		const adapter = new MemoryAdapter();
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", () => 1);
		await store.add({ docId: "doc1", path: "N/a.notebook", pageId: "pg1", num: 1 });
		const writes = adapter.writes.length;
		const { resolver } = world({ "M/moved.notebook": "doc1" });
		await resolver.resolve(store.list()[0]!);
		expect(adapter.writes.length).toBe(writes);
		expect(store.list()[0]!.path).toBe("N/a.notebook");
	});
});

describe("W8: a copy of a notebook is not the original", () => {
	const map = mergeBookmarkFiles([file("0a000000", [bm("b1", 0)])]);
	it("the copy (same id and page ids, another path that exists) has no bookmark on that page", () => {
		const exists = (p: string) => p === "N/a.notebook" || p === "N/copy.notebook";
		expect(findBookmark(map, { docId: "doc1", path: "N/copy.notebook", pageId: "pg1" }, exists)).toBeNull();
		expect(findBookmark(map, { docId: "doc1", path: "N/a.notebook", pageId: "pg1" }, exists)?.id).toBe("b1");
	});
	it("a notebook renamed where no rename was seen (the old path is gone) still matches by id", () => {
		const exists = (p: string) => p === "N/renamed.notebook";
		expect(findBookmark(map, { docId: "doc1", path: "N/renamed.notebook", pageId: "pg1" }, exists)?.id).toBe("b1");
	});
	it("the path wins over the id when both notebooks are bookmarked", () => {
		const both = mergeBookmarkFiles([file("0a000000", [bm("b1", 0), bm("b2", 1, { path: "N/copy.notebook" })])]);
		expect(findBookmark(both, { docId: "doc1", path: "N/copy.notebook", pageId: "pg1" }, () => true)?.id).toBe("b2");
	});
	it("toggling the copy adds its own bookmark instead of removing the original's", async () => {
		const store = new BookmarksStore(new MemoryAdapter(), () => "Notebooks", "0a000000", () => 1);
		const exists = () => true;
		const a = await store.add({ docId: "doc1", path: "N/a.notebook", pageId: "pg1", num: 1 }, exists);
		const c = await store.add({ docId: "doc1", path: "N/copy.notebook", pageId: "pg1", num: 1 }, exists);
		expect(c).not.toBe(a);
		expect(store.list()).toHaveLength(2);
	});
});

describe("W9: every unknown field survives a rewrite", () => {
	it("keeps unknown top-level members of the file", () => {
		const text = '{"format":"obsidian-notebook-bookmarks","version":1,"device":"0a000000","colour":"red","meta":{"a":[1,2]},"items":[]}';
		const parsed = parseBookmarks(text, "0a000000");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.extra).toEqual({ colour: "red", meta: { a: [1, 2] } });
		const again = parseBookmarks(serializeBookmarks(parsed.data), "0a000000");
		expect(again.ok && again.data.extra).toEqual({ colour: "red", meta: { a: [1, 2] } });
	});

	it("keeps a long label and a fractional or odd page number as the file had them, while showing the normalised ones", () => {
		const long = `  ${"x".repeat(80)}  `;
		const text = `{"format":"obsidian-notebook-bookmarks","version":1,"device":"0a000000","items":[{"id":"b1","docId":"d","path":"p","pageId":"g","num":2.5,"label":${JSON.stringify(long)},"order":0,"at":5},{"id":"b2","docId":7,"path":"p","pageId":"h","num":"4","order":1,"at":5}]}`;
		const parsed = parseBookmarks(text, "0a000000");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const [b1, b2] = parsed.data.items;
		expect(b1).toMatchObject({ num: 2, label: "x".repeat(60) });
		expect(b2).toMatchObject({ num: 1, docId: "" });
		const out = serializeBookmarks(parsed.data);
		const back = JSON.parse(out) as { items: Array<Record<string, unknown>> };
		expect(back.items[0]).toMatchObject({ num: 2.5, label: long });
		expect(back.items[1]).toMatchObject({ num: "4", docId: 7 });
		// The listed bookmark carries no raw bookkeeping.
		const listed = liveBookmarks(mergeBookmarkFiles([parsed.data]));
		expect(Object.keys(listed[0]!)).not.toContain("rawKept");
	});

	it("a field this version changes itself is written normalised, the others stay raw", () => {
		const long = "y".repeat(80);
		const parsed = parseBookmarks(`{"format":"obsidian-notebook-bookmarks","version":1,"items":[{"id":"b1","docId":"d","path":"p","pageId":"g","num":2.5,"label":${JSON.stringify(long)},"order":0,"at":5}]}`, "0a000000");
		if (!parsed.ok) throw new Error("parse");
		const merged = mergeBookmarkFiles([parsed.data]);
		const after = applyBookmarkOps(parsed.data, merged, [{ kind: "label", id: "b1", label: "Short" }], 100);
		const out = JSON.parse(serializeBookmarks(after)) as { items: Array<Record<string, unknown>> };
		expect(out.items[0]).toMatchObject({ label: "Short", num: 2.5 });
	});

	it("the store rewrites a file without losing its unknown members", async () => {
		const adapter = new MemoryAdapter();
		const own = "Notebooks/_meta/bookmarks-0a000000.json";
		adapter.files.set(own, '{"format":"obsidian-notebook-bookmarks","version":1,"device":"0a000000","future":{"x":1},"items":[]}');
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", () => 50);
		await store.add({ docId: "d", path: "p.notebook", pageId: "g", num: 1 });
		expect((JSON.parse(adapter.files.get(own)!) as Record<string, unknown>).future).toEqual({ x: 1 });
	});
});

describe("W10: the same page bookmarked on two devices is one row", () => {
	const phone = file("0a000000", [bm("bA", 0, { at: 10 })]);
	const tablet = file("0b000000", [bm("bB", 0, { at: 12 })]);
	it("collapses to one live row, the same one on every device", () => {
		const map = mergeBookmarkFiles([phone, tablet]);
		expect(liveBookmarks(map).map((b) => b.id)).toEqual(["bA"]);
		expect(liveBookmarks(mergeBookmarkFiles([tablet, phone])).map((b) => b.id)).toEqual(["bA"]);
		expect(findBookmark(map, { docId: "doc1", path: "N/a.notebook", pageId: "pg1" })?.id).toBe("bA");
	});
	it("two different pages are two rows", () => {
		const map = mergeBookmarkFiles([phone, file("0b000000", [bm("bC", 1, { pageId: "pg2" })])]);
		expect(liveBookmarks(map)).toHaveLength(2);
	});
	it("removing it removes both ids, so the page is no longer bookmarked", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/bookmarks-0b000000.json", serializeBookmarks(tablet));
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", () => 100);
		adapter.files.set("Notebooks/_meta/bookmarks-0a000000.json", serializeBookmarks(file("0a000000", [bm("bA", 0, { at: 10 }), bm("bZ", 1, { pageId: "z" })])));
		await store.load();
		expect(store.find({ docId: "doc1", path: "N/a.notebook", pageId: "pg1" })?.id).toBe("bA");
		expect(bookmarkTwins(mergeBookmarkFiles([phone, tablet]), "bA").sort()).toEqual(["bA", "bB"]);
		await store.remove("bA");
		expect(store.find({ docId: "doc1", path: "N/a.notebook", pageId: "pg1" })).toBeNull();
		expect(store.list().map((b) => b.pageId)).toEqual(["z"]);
	});
});
