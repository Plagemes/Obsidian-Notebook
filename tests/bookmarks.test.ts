import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import {
	adoptBookmarkWinners, applyBookmarkOps, bookmarkOrderAtEnd, DAY_MS, emptyBookmarks, findBookmark, liveBookmarks, mergeBookmarkFiles, parseBookmarks, planBookmarkMove,
	pruneBookmarkTombstones, resolveBookmark, serializeBookmarks, TOMBSTONE_DAYS, type BookmarksFile, type GlobalBookmark, type StoredBookmark,
} from "../src/library/bookmarks";
import { BookmarksBlockedError, BookmarksStore } from "../src/library/bookmarks-store";
import { isNonHolderSidecar } from "../src/library/library-check";

const bm = (id: string, order: number, o: Partial<StoredBookmark> = {}): StoredBookmark => ({ id, docId: "doc1", path: "N/a.notebook", pageId: `p-${id}`, num: 3, order, at: 10, ...o });
const file = (device: string, items: StoredBookmark[], unknown: unknown[] = []): BookmarksFile => ({ ...emptyBookmarks(device), items, unknown });

describe("bookmarks file", () => {
	it("round-trips and keeps unknown fields and unknown entries", () => {
		const text = serializeBookmarks(file("0a000000", [bm("b1", 0, { label: "Exam", extra: { colour: "red" } })], [{ future: true }]));
		const parsed = parseBookmarks(text, "0a000000");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.items[0]).toMatchObject({ id: "b1", label: "Exam", docId: "doc1", extra: { colour: "red" } });
		expect(parsed.data.unknown).toEqual([{ future: true }]);
		expect(serializeBookmarks(parsed.data)).toBe(text);
	});

	it("reports files it cannot read instead of fixing them", () => {
		expect(parseBookmarks("", "0a000000")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseBookmarks("{broken", "0a000000")).toMatchObject({ ok: false, reason: "json" });
		expect(parseBookmarks('{"format":"other","version":1,"items":[]}', "0a000000")).toMatchObject({ ok: false, reason: "format" });
		expect(parseBookmarks('{"format":"obsidian-notebook-bookmarks","version":99,"items":[]}', "0a000000")).toMatchObject({ ok: false, reason: "future" });
	});

	it("an entry it cannot make sense of is kept as it was, not dropped", () => {
		const parsed = parseBookmarks('{"format":"obsidian-notebook-bookmarks","version":1,"items":[{"id":"x"},{"id":"b1","path":"p","pageId":"g","order":1,"at":2}]}', "0a000000");
		expect(parsed.ok && parsed.data.items.map((i) => i.id)).toEqual(["b1"]);
		expect(parsed.ok && parsed.data.unknown).toEqual([{ id: "x" }]);
	});

	it("is a sidecar the library check never counts as holding an asset", () => {
		expect(isNonHolderSidecar("Notebooks/_meta/bookmarks-0a000000.json", "Notebooks")).toBe(true);
		expect(isNonHolderSidecar("Notebooks/_meta/bookmarks.unreadable-0a000000.json", "Notebooks")).toBe(true);
	});
});

describe("merge across devices and tombstones", () => {
	it("the latest at wins per bookmark, a tie goes to the larger device, a removal is a tombstone that wins", () => {
		const a = file("0a000000", [bm("b1", 0, { at: 10, label: "old" }), bm("b2", 1, { at: 5 })]);
		const b = file("0b000000", [bm("b1", 0, { at: 20, label: "new" }), bm("b2", 1, { at: 5, label: "tie" }), bm("b3", 2, { at: 7, deleted: true })]);
		const merged = mergeBookmarkFiles([a, b]);
		expect(merged.get("b1")?.label).toBe("new");
		expect(merged.get("b2")?.label).toBe("tie");
		expect(liveBookmarks(merged).map((x) => x.id)).toEqual(["b1", "b2"]);
		const removedLater = mergeBookmarkFiles([a, file("0b000000", [bm("b1", 0, { at: 30, deleted: true })])]);
		expect(liveBookmarks(removedLater).map((x) => x.id)).toEqual(["b2"]);
	});

	it("a removal made elsewhere is adopted into this device's file, so the bookmark cannot come back from here", () => {
		const own = file("0a000000", [bm("b1", 0, { at: 10 })]);
		const merged = mergeBookmarkFiles([own, file("0b000000", [bm("b1", 0, { at: 20, deleted: true })])]);
		const adopted = adoptBookmarkWinners(own, merged);
		expect(adopted.items[0]).toMatchObject({ id: "b1", deleted: true, at: 20 });
		expect(adoptBookmarkWinners(adopted, merged)).toBe(adopted);
	});

	it("tombstones older than 90 days are dropped, live bookmarks and unknown entries never; one another device still holds live stays", () => {
		const now = 1000 * DAY_MS;
		const old = now - (TOMBSTONE_DAYS + 1) * DAY_MS;
		const f = file("0a000000", [bm("old", 0, { deleted: true, at: old }), bm("recent", 1, { deleted: true, at: now - DAY_MS }), bm("live", 2, { at: 1 }), bm("held", 3, { deleted: true, at: old })], [{ x: 1 }]);
		const other = file("0b000000", [bm("held", 3, { at: old - 5 })]);
		expect(pruneBookmarkTombstones(f, now, [other]).items.map((i) => i.id).sort()).toEqual(["held", "live", "recent"]);
		expect(pruneBookmarkTombstones(f, now, [other], false).items.map((i) => i.id).sort()).toEqual(["held", "live", "old", "recent"]);
		expect(pruneBookmarkTombstones(f, now).unknown).toEqual([{ x: 1 }]);
	});

	it("finds a page's bookmark by notebook id, so a moved notebook still matches", () => {
		const merged = mergeBookmarkFiles([file("0a000000", [bm("b1", 0, { path: "Old/a.notebook", pageId: "pg" })])]);
		expect(findBookmark(merged, { docId: "doc1", path: "New/a.notebook", pageId: "pg" })?.id).toBe("b1");
		expect(findBookmark(merged, { docId: "doc2", path: "Old/a.notebook", pageId: "pg" })).toBeNull();
		expect(findBookmark(merged, { docId: "", path: "Old/a.notebook", pageId: "pg" })?.id).toBe("b1");
		expect(findBookmark(merged, { docId: "", path: "New/a.notebook", pageId: "pg" })).toBeNull();
	});
});

describe("ordering and resolving", () => {
	const list = (...orders: number[]): GlobalBookmark[] => orders.map((o, i) => bm(`b${i}`, o));
	it("appends after the last and moves with one value between the new neighbours", () => {
		expect(bookmarkOrderAtEnd([])).toBe(0);
		expect(bookmarkOrderAtEnd(list(0, 1, 5))).toBe(6);
		expect(planBookmarkMove(list(0, 1, 2), "b2", 0)).toEqual([{ id: "b2", order: -1 }]);
		expect(planBookmarkMove(list(0, 1, 2), "b0", 1)).toEqual([{ id: "b0", order: 1.5 }]);
		expect(planBookmarkMove(list(0, 1, 2), "b1", 1)).toEqual([]);
		expect(planBookmarkMove(list(0, 1, 2), "nope", 1)).toEqual([]);
	});

	it("finds the page by id after pages were reordered; a page that is gone lands on the nearest by its old number", () => {
		const b = bm("b1", 0, { pageId: "p9", num: 4 });
		expect(resolveBookmark(b, ["p1", "p9", "p2"])).toEqual({ kind: "page", index: 1 });
		expect(resolveBookmark(b, ["p1", "p2"])).toEqual({ kind: "gone", index: 1 });
		expect(resolveBookmark(b, [])).toEqual({ kind: "gone", index: 0 });
	});
});

describe("changes", () => {
	it("a change takes a time later than what any device said, and keeps unknown fields of the winner", () => {
		const merged = mergeBookmarkFiles([file("0b000000", [bm("b1", 0, { at: 500, extra: { keep: 1 } })])]);
		const after = applyBookmarkOps(emptyBookmarks("0a000000"), merged, [{ kind: "order", id: "b1", order: 4 }], 100);
		expect(after.items[0]).toMatchObject({ id: "b1", order: 4, at: 501, extra: { keep: 1 } });
	});

	it("renaming a notebook (or its folder) is followed for live bookmarks only", () => {
		const merged = mergeBookmarkFiles([file("0a000000", [bm("b1", 0), bm("b2", 1, { deleted: true }), bm("b3", 2, { path: "N/z.notebook" })])]);
		const after = applyBookmarkOps(emptyBookmarks("0a000000"), merged, [{ kind: "retarget", from: "N/a.notebook", to: "M/a.notebook" }], 100);
		expect(after.items.map((i) => [i.id, i.path])).toEqual([["b1", "M/a.notebook"]]);
	});

	it("a label is cleaned, and an empty one goes back to the default", () => {
		const merged = mergeBookmarkFiles([file("0a000000", [bm("b1", 0, { label: "x" })])]);
		const named = applyBookmarkOps(emptyBookmarks("0a000000"), merged, [{ kind: "label", id: "b1", label: "  Chapter\n 3  " }], 100);
		expect(named.items[0]?.label).toBe("Chapter 3");
		const cleared = applyBookmarkOps(named, mergeBookmarkFiles([named]), [{ kind: "label", id: "b1", label: " " }], 200);
		expect(cleared.items[0]?.label).toBeUndefined();
	});
});

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

describe("bookmarks store", () => {
	const OWN = "Notebooks/_meta/bookmarks-0a000000.json";
	let clock = 1000;
	const make = (adapter = new MemoryAdapter(), device = "0a000000") => new BookmarksStore(adapter, () => "Notebooks", device, () => clock++);
	const page = (n: number, path = "N/a.notebook", docId = "doc1") => ({ docId, path, pageId: `pg${n}`, num: n });

	it("adds pages of different notebooks, renames, moves and removes, writing only this device's file", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/bookmarks-0b000000.json", serializeBookmarks(file("0b000000", [bm("bb", 0, { pageId: "other" })])));
		const store = make(adapter);
		await store.load();
		const a = await store.add(page(1));
		const b = await store.add({ ...page(2, "M/b.notebook", "doc2"), label: "  Formulas  " });
		expect(await store.add(page(1))).toBe(a);
		expect(new Set(adapter.writes)).toEqual(new Set([OWN]));
		expect(store.list().map((x) => x.id)).toEqual(["bb", a, b]);
		expect(store.list()[2]).toMatchObject({ label: "Formulas", path: "M/b.notebook", docId: "doc2" });
		await store.move(b, 0);
		expect(store.list().map((x) => x.id)).toEqual([b, "bb", a]);
		await store.rename(a, "Midterm");
		expect(store.find(page(1))?.label).toBe("Midterm");
		await store.remove("bb");
		expect(store.list().map((x) => x.id)).toEqual([b, a]);
		expect(new Set(adapter.writes)).toEqual(new Set([OWN]));
		// A fresh store (another start of the app) reads the same list.
		const again = make(adapter);
		await again.load();
		expect(again.list().map((x) => x.id)).toEqual([b, a]);
	});

	it("follows a renamed notebook and a renamed folder in one write", async () => {
		const adapter = new MemoryAdapter();
		const store = make(adapter);
		const a = await store.add(page(1, "Maths/a.notebook"));
		const b = await store.add(page(2, "Maths/b.notebook", "doc2"));
		const c = await store.add(page(3, "Other/c.notebook", "doc3"));
		const before = adapter.writes.length;
		await store.retargetMany([{ from: "Maths/a.notebook", to: "Algebra/a.notebook" }, { from: "Maths/b.notebook", to: "Algebra/b.notebook" }]);
		expect(adapter.writes.length).toBe(before + 1);
		expect(store.list().map((x) => [x.id, x.path])).toEqual([[a, "Algebra/a.notebook"], [b, "Algebra/b.notebook"], [c, "Other/c.notebook"]]);
		// The page is still the same bookmark after the move: the toggle finds it by the notebook's id.
		expect(store.find({ docId: "doc1", path: "Algebra/a.notebook", pageId: "pg1" })?.id).toBe(a);
		await store.retarget("Algebra/a.notebook", "Algebra/a2.notebook");
		expect(store.list()[0]?.path).toBe("Algebra/a2.notebook");
	});

	it("a bookmark whose page is deleted stays in the list and can be removed", async () => {
		const store = make();
		const id = await store.add(page(9));
		expect(resolveBookmark(store.list()[0]!, ["p1", "p2"]).kind).toBe("gone");
		await store.remove(id);
		expect(store.list()).toEqual([]);
	});

	it("an unpin on another device wins after both sync", async () => {
		const adapter = new MemoryAdapter();
		const phone = make(adapter, "0a000000");
		const id = await phone.add(page(1));
		const tablet = make(adapter, "0b000000");
		await tablet.load();
		await tablet.remove(id);
		await phone.load();
		expect(phone.list()).toEqual([]);
	});

	it("never overwrites an unreadable own file: it keeps a copy of a damaged one and refuses the write", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(OWN, "{broken");
		const store = make(adapter);
		await expect(store.add(page(1))).rejects.toBeInstanceOf(BookmarksBlockedError);
		expect(adapter.files.get(OWN)).toBe("{broken");
		expect([...adapter.files.keys()].some((k) => k.includes("bookmarks.unreadable-"))).toBe(true);
		expect(store.blocked).toContain("invalid JSON");
	});

	it("an empty own file (not synced yet) is left as it is and no copy is made", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(OWN, "");
		const store = make(adapter);
		await expect(store.add(page(1))).rejects.toMatchObject({ reason: "empty" });
		expect(adapter.files.get(OWN)).toBe("");
		expect(adapter.files.size).toBe(1);
	});

	it("an unreadable file of another device is skipped and reported, the rest still works", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/bookmarks-0b000000.json", "nonsense");
		const store = make(adapter);
		await store.add(page(1));
		expect(store.list()).toHaveLength(1);
		expect(store.blocked).toContain("bookmarks-0b000000.json");
		expect(adapter.files.get("Notebooks/_meta/bookmarks-0b000000.json")).toBe("nonsense");
	});

	it("keeps entries and fields it does not know when it rewrites its file", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(OWN, serializeBookmarks(file("0a000000", [bm("b1", 0, { extra: { colour: "red" } })], [{ future: 1 }])));
		const store = make(adapter);
		await store.add(page(5));
		const text = adapter.files.get(OWN) ?? "";
		expect(text).toContain('"colour":"red"');
		expect(text).toContain('{"future":1}');
	});
});
