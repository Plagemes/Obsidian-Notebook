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

describe("round 2: a notebook that took the old path of a moved one (R1, R2, R3)", () => {
	const A = "doc-A";
	const B = "doc-B";
	const phone = (items: StoredBookmark[]) => file("0a000000", items);
	const tablet = (items: StoredBookmark[]) => file("0b000000", items);
	const bA = (id: string, order: number, o: Partial<StoredBookmark> = {}) => bm(id, order, { docId: A, path: "N/Untitled.notebook", pageId: "pgA", ...o });
	const bB = (id: string, order: number, o: Partial<StoredBookmark> = {}) => bm(id, order, { docId: B, path: "N/Untitled.notebook", pageId: "pgB", ...o });

	it("R1: retargeting A's bookmarks by id never moves B's, which share the old path", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/bookmarks-0b000000.json", serializeBookmarks(tablet([bB("bb", 1)])));
		adapter.files.set("Notebooks/_meta/bookmarks-0a000000.json", serializeBookmarks(phone([bA("ba", 0)])));
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", (() => { let c = 100; return () => c++; })());
		await store.load();
		// A was renamed to Physics where no rename was seen; a new notebook B sits at the old path. The tap on A's bookmark retargets by id.
		await store.retarget("N/Untitled.notebook", "N/Physics.notebook", A);
		const byId = Object.fromEntries(store.list().map((b) => [b.id, b.path]));
		expect(byId).toEqual({ ba: "N/Physics.notebook", bb: "N/Untitled.notebook" });
		// Tapping B's bookmark (found at its own path) retargets nothing and drags nothing back: no ping-pong.
		const writes = adapter.writes.length;
		await store.retarget("N/Untitled.notebook", "N/Untitled.notebook", B);
		expect(adapter.writes.length).toBe(writes);
		expect(Object.fromEntries(store.list().map((b) => [b.id, b.path]))).toEqual(byId);
	});

	it("a retarget without an id (a rename event) still moves everything at the path", () => {
		const map = mergeBookmarkFiles([phone([bA("ba", 0), bB("bb", 1)])]);
		const after = applyBookmarkOps(phone([bA("ba", 0), bB("bb", 1)]), map, [{ kind: "retarget", from: "N/Untitled.notebook", to: "N/Moved.notebook" }], 500);
		expect(after.items.map((i) => i.path)).toEqual(["N/Moved.notebook", "N/Moved.notebook"]);
	});

	it("R3: A's page shows as bookmarked (no duplicate on toggle) while B sits at A's old path", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/bookmarks-0a000000.json", serializeBookmarks(phone([bA("ba", 0)])));
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", () => 100);
		await store.load();
		const ref = { docId: A, path: "N/Physics.notebook", pageId: "pgA" };
		// The file at the old path is B (a different id): it does not hold A's bookmark.
		const holds = (path: string, docId: string) => !(path === "N/Untitled.notebook" && docId === A);
		expect(store.find(ref, holds)?.id).toBe("ba");
		expect(await store.add({ ...ref, num: 1 }, holds)).toBe("ba");
		expect(store.list()).toHaveLength(1);
		// Without knowing the id, an existing file at the path is taken to be the notebook (the copy rule of W8 stays).
		expect(store.find(ref, () => true)).toBeNull();
	});

	it("R2: move and rename act on every twin, so the row never jumps back or shows another name", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/bookmarks-0b000000.json", serializeBookmarks(tablet([bA("t1", 2, { label: "tablet" }), bB("x", 1)])));
		adapter.files.set("Notebooks/_meta/bookmarks-0a000000.json", serializeBookmarks(phone([bA("p1", 0, { label: "phone" }), bB("y", 3, { pageId: "pgB2" })])));
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", (() => { let c = 100; return () => c++; })());
		await store.load();
		// Rows: p1 (A twins p1,t1) order 0, x order 1, y order 3.
		expect(store.list().map((b) => b.id)).toEqual(["p1", "x", "y"]);
		await store.move("p1", 2);
		expect(store.list().map((b) => b.id)).toEqual(["x", "y", "p1"]);
		await store.rename("p1", "Exam");
		expect(store.list().find((b) => b.pageId === "pgA")?.label).toBe("Exam");
		const again = new BookmarksStore(adapter, () => "Notebooks", "0b000000", () => 900);
		await again.load();
		expect(again.list().map((b) => b.pageId)).toEqual(["pgB", "pgB2", "pgA"]);
		expect(again.list()[2]?.label).toBe("Exam");
	});
});

describe("round 2: the W6 scenario end to end (two notebooks, two devices)", () => {
	it("tapping A's bookmark opens A and moves only A's bookmarks; tapping B's moves nothing; the toggle adds no duplicate", async () => {
		const adapter = new MemoryAdapter();
		const mk = (id: string, docId: string, pageId: string, order: number, device: string): StoredBookmark => ({ id, docId, path: "N/Untitled.notebook", pageId, num: 1, order, at: 10, ...(device ? {} : {}) });
		adapter.files.set("Notebooks/_meta/bookmarks-0a000000.json", serializeBookmarks(file("0a000000", [mk("ba", "doc-A", "pgA", 0, "a")])));
		adapter.files.set("Notebooks/_meta/bookmarks-0b000000.json", serializeBookmarks(file("0b000000", [mk("bb", "doc-B", "pgB", 1, "b")])));
		const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000", (() => { let c = 100; return () => c++; })());
		await store.load();
		// The vault: A now lives at Physics, a new notebook B sits at the old path.
		const ids: Record<string, string> = { "N/Physics.notebook": "doc-A", "N/Untitled.notebook": "doc-B" };
		const resolver = () => new BookmarkResolver<{ path: string }>({
			fileAt: (p) => (ids[p] ? { path: p } : null),
			notebooks: () => Object.keys(ids).map((path) => ({ path })),
			idOf: async (f) => ids[f.path] ?? null,
		});
		const tap = async (id: string) => {
			const b = store.list().find((x) => x.id === id)!;
			const found = await resolver().resolve(b);
			if (found?.byId && found.unique) await store.retarget(b.path, found.file.path, b.docId);
			return found!.file.path;
		};
		expect(await tap("ba")).toBe("N/Physics.notebook");
		expect(await tap("bb")).toBe("N/Untitled.notebook");
		expect(await tap("ba")).toBe("N/Physics.notebook");
		expect(Object.fromEntries(store.list().map((b) => [b.id, b.path]))).toEqual({ ba: "N/Physics.notebook", bb: "N/Untitled.notebook" });
		// Toggling A's page and B's page finds the existing bookmarks (the other device's file agrees after a reload).
		const holds = (path: string, docId: string) => ids[path] === docId;
		expect(store.find({ docId: "doc-A", path: "N/Physics.notebook", pageId: "pgA" }, holds)?.id).toBe("ba");
		expect(store.find({ docId: "doc-B", path: "N/Untitled.notebook", pageId: "pgB" }, holds)?.id).toBe("bb");
		const other = new BookmarksStore(adapter, () => "Notebooks", "0b000000", () => 900);
		await other.load();
		expect(Object.fromEntries(other.list().map((b) => [b.id, b.path]))).toEqual({ ba: "N/Physics.notebook", bb: "N/Untitled.notebook" });
		expect(store.list()).toHaveLength(2);
	});
});
