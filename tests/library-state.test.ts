import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import { folderOf, LibraryIndex, nameOf, SORTS, type LibraryEntry } from "../src/library/index";
import {
	applyLibraryOps, arrangeEntries, emptyLibraryState, LIBRARY_STATE_FORMAT, mergeLibraryFiles, notebookKey, parseLibraryState, planMove,
	rankOrder, RANK_STEP, serializeLibraryState, stateKeys, type LibraryItem, type LibraryStateFile,
} from "../src/library/library-state";
import { LibraryStateBlockedError, LibraryStateStore } from "../src/library/library-state-store";
import { DEFAULT_COVER, metaFromDocument } from "../src/library/scan";
import { sampleDocument } from "./helpers";

function file(device: string, ...items: LibraryItem[]): LibraryStateFile {
	return { ...emptyLibraryState(device), items };
}

function entry(path: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
	return {
		path, folder: folderOf(path), name: nameOf(path), mtime: 1000, size: 500,
		created: 1000, modified: 1000, pages: 1, tags: [], favorite: false, cover: DEFAULT_COVER, ...over,
	};
}

describe("library state file", () => {
	it("round-trips and is deterministic (sorted by key, one item per line)", () => {
		const data = file("0a1b2c3d",
			{ key: "id:b", pinned: { v: true, at: 5 } },
			{ key: "id:a", archived: { v: false, at: 3 }, rank: { v: 2048, at: 4 } },
		);
		const text = serializeLibraryState(data);
		expect(text.indexOf('"id:a"')).toBeLessThan(text.indexOf('"id:b"'));
		expect(text.endsWith("\n")).toBe(true);
		const back = parseLibraryState(text, "0a1b2c3d");
		expect(back.ok).toBe(true);
		if (back.ok) expect(serializeLibraryState(back.data)).toBe(text);
	});

	it("refuses what is not ours, is empty, is damaged or is from a newer version (never 'fixes' it)", () => {
		expect(parseLibraryState("", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseLibraryState("  \n", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseLibraryState("{ nope", "0a1b2c3d")).toMatchObject({ ok: false, reason: "json" });
		expect(parseLibraryState('{"format":"x","version":1,"items":[]}', "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
		expect(parseLibraryState(`{"format":"${LIBRARY_STATE_FORMAT}","version":2,"items":[]}`, "0a1b2c3d")).toMatchObject({ ok: false, reason: "future" });
		expect(parseLibraryState(`{"format":"${LIBRARY_STATE_FORMAT}","version":1,"items":"no"}`, "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
	});

	it("keeps items it does not understand and writes them back", () => {
		const odd = { key: "id:z", pinned: { v: "yes", at: 1 } };
		const text = `{"format":"${LIBRARY_STATE_FORMAT}","version":1,"device":"0a1b2c3d","items":[${JSON.stringify(odd)},{"key":"id:a","pinned":{"v":true,"at":2}}]}`;
		const r = parseLibraryState(text, "0a1b2c3d");
		expect(r.ok && r.data.unknown).toEqual([odd]);
		expect(r.ok && r.data.items.map((i) => i.key)).toEqual(["id:a"]);
		if (r.ok) expect(serializeLibraryState(r.data)).toContain('"yes"');
	});

	it("collapses a duplicated key to the later value of each field", () => {
		const text = `{"format":"${LIBRARY_STATE_FORMAT}","version":1,"device":"0a1b2c3d","items":[`
			+ `{"key":"id:a","pinned":{"v":true,"at":5},"rank":{"v":1,"at":1}},{"key":"id:a","pinned":{"v":false,"at":3},"rank":{"v":9,"at":8}}]}`;
		const r = parseLibraryState(text, "0a1b2c3d");
		expect(r.ok && r.data.items).toEqual([{ key: "id:a", pinned: { v: true, at: 5 }, rank: { v: 9, at: 8 } }]);
	});

	it("keys a notebook by its document id, or by its path while the id is unknown", () => {
		expect(notebookKey({ id: "abc", path: "N/a.notebook" })).toBe("id:abc");
		expect(notebookKey({ path: "N/a.notebook" })).toBe("path:N/a.notebook");
	});
});

describe("merging the devices' files", () => {
	it("the latest value of each field wins, per notebook", () => {
		const phone = file("aaaaaaaa", { key: "id:1", pinned: { v: true, at: 10 } }, { key: "id:2", archived: { v: true, at: 10 } });
		const tablet = file("bbbbbbbb", { key: "id:1", pinned: { v: false, at: 20 } }, { key: "id:3", rank: { v: 5, at: 1 } });
		const m = mergeLibraryFiles([phone, tablet]);
		expect(m.get("id:1")?.pinned).toBe(false); // the tablet un-pinned it later
		expect(m.get("id:2")?.archived).toBe(true); // only the phone knew
		expect(m.get("id:3")?.rank).toBe(5);
		expect(m.get("id:3")?.pinned).toBe(false);
	});

	it("fields of one notebook set on different devices both survive", () => {
		const m = mergeLibraryFiles([
			file("aaaaaaaa", { key: "id:1", pinned: { v: true, at: 10 } }),
			file("bbbbbbbb", { key: "id:1", archived: { v: true, at: 11 } }),
		]);
		expect(m.get("id:1")).toMatchObject({ pinned: true, archived: true });
	});

	it("a tie goes to the larger device id, whatever the order of the files", () => {
		const a = file("aaaaaaaa", { key: "id:1", pinned: { v: true, at: 7 } });
		const b = file("bbbbbbbb", { key: "id:1", pinned: { v: false, at: 7 } });
		expect(mergeLibraryFiles([a, b]).get("id:1")?.pinned).toBe(false);
		expect(mergeLibraryFiles([b, a]).get("id:1")?.pinned).toBe(false);
	});
});

describe("changes", () => {
	it("writes only what differs from the merged state", () => {
		const merged = mergeLibraryFiles([file("bbbbbbbb", { key: "id:1", pinned: { v: true, at: 10 } })]);
		const own = emptyLibraryState("aaaaaaaa");
		const same = applyLibraryOps(own, merged, [{ kind: "pinned", key: "id:1", value: true }], 100);
		expect(same.items).toEqual([]);
		const unpin = applyLibraryOps(own, merged, [{ kind: "pinned", key: "id:1", value: false }], 100);
		expect(unpin.items).toEqual([{ key: "id:1", pinned: { v: false, at: 100 } }]);
	});

	it("takes a time later than the one it read, so a device with a slow clock still wins with a later change", () => {
		const other = file("bbbbbbbb", { key: "id:1", pinned: { v: true, at: 5000 } });
		const merged = mergeLibraryFiles([other]);
		const after = applyLibraryOps(emptyLibraryState("aaaaaaaa"), merged, [{ kind: "pinned", key: "id:1", value: false }], 100);
		expect(after.items[0]!.pinned!.at).toBe(5001);
		expect(mergeLibraryFiles([after, other]).get("id:1")?.pinned).toBe(false);
	});

	it("its own later change is later than its own earlier one even within the same millisecond", () => {
		let own = emptyLibraryState("aaaaaaaa");
		let merged = mergeLibraryFiles([own]);
		for (const value of [true, false, true]) {
			own = applyLibraryOps(own, merged, [{ kind: "pinned", key: "id:1", value }], 50);
			merged = mergeLibraryFiles([own]);
		}
		expect(merged.get("id:1")?.pinned).toBe(true);
		expect(own.items[0]!.pinned!.at).toBe(52);
	});

	it("ranks must be finite numbers", () => {
		const after = applyLibraryOps(emptyLibraryState("aaaaaaaa"), new Map(), [{ kind: "rank", key: "id:1", value: Number.NaN }], 1);
		expect(after.items).toEqual([]);
	});
});

describe("order", () => {
	const keyOf = (s: string) => s;

	it("rankOrder puts notebooks never placed first, in the order given, then the placed ones by rank (a tie by key)", () => {
		const ranks: Record<string, number> = { d: 2, a: 1, c: 1 };
		expect(rankOrder(["x", "d", "y", "a", "c"], keyOf, (k) => ranks[k])).toEqual(["x", "y", "a", "c", "d"]);
	});

	it("arrangeEntries: pinned first as a group of their own, each group in manual order when asked", () => {
		const state = mergeLibraryFiles([file("aaaaaaaa",
			{ key: "p", pinned: { v: true, at: 1 }, rank: { v: 20, at: 1 } },
			{ key: "q", pinned: { v: true, at: 1 }, rank: { v: 10, at: 1 } },
			{ key: "r", rank: { v: 2, at: 1 } },
			{ key: "s", rank: { v: 1, at: 1 } },
		)]);
		const list = ["r", "s", "t", "p", "q"];
		expect(arrangeEntries(list, keyOf, state, { manual: false, pinnedFirst: true })).toEqual({ pinned: ["p", "q"], rest: ["r", "s", "t"] });
		expect(arrangeEntries(list, keyOf, state, { manual: true, pinnedFirst: true })).toEqual({ pinned: ["q", "p"], rest: ["t", "s", "r"] });
		expect(arrangeEntries(list, keyOf, state, { manual: false, pinnedFirst: false })).toEqual({ pinned: [], rest: list });
	});

	/** Applies a plan and shows the list the way the library does. */
	function show(order: string[], ranks: Map<string, number>, plan: Array<{ key: string; rank: number }>): string[] {
		const next = new Map(ranks);
		for (const c of plan) next.set(c.key, c.rank);
		return rankOrder(order, keyOf, (k) => next.get(k));
	}

	it("planMove between ranked neighbours changes one rank", () => {
		const ranks = new Map([["a", 1024], ["b", 2048], ["c", 3072]]);
		const plan = planMove(["a", "b", "c"], "c", 1, (k) => ranks.get(k));
		expect(plan).toEqual([{ key: "c", rank: 1536 }]);
		expect(show(["a", "b", "c"], ranks, plan)).toEqual(["a", "c", "b"]);
	});

	it("planMove to the ends takes a step beyond the neighbour", () => {
		const ranks = new Map([["a", 1024], ["b", 2048], ["c", 3072]]);
		expect(planMove(["a", "b", "c"], "a", 2, (k) => ranks.get(k))).toEqual([{ key: "a", rank: 3072 + RANK_STEP }]);
		expect(planMove(["a", "b", "c"], "c", 0, (k) => ranks.get(k))).toEqual([{ key: "c", rank: 1024 - RANK_STEP }]);
	});

	it("planMove numbers the whole list when the notebooks were never placed (switching to manual order)", () => {
		const plan = planMove(["a", "b", "c", "d"], "d", 0, () => undefined);
		expect(show(["a", "b", "c", "d"], new Map(), plan)).toEqual(["d", "a", "b", "c"]);
		expect(plan).toHaveLength(4);
	});

	it("planMove does nothing for a move to the same place, a missing key, and clamps the target", () => {
		const ranks = new Map([["a", 1], ["b", 2]]);
		expect(planMove(["a", "b"], "a", 0, (k) => ranks.get(k))).toEqual([]);
		expect(planMove(["a", "b"], "z", 0, (k) => ranks.get(k))).toEqual([]);
		expect(planMove(["a", "b"], "a", 99, (k) => ranks.get(k))).toEqual([{ key: "a", rank: 2 + RANK_STEP }]);
	});

	it("planMove numbers the list afresh when two ranks have no room between them", () => {
		const ranks = new Map([["a", 1], ["b", 1 + Number.EPSILON], ["c", 5]]);
		const plan = planMove(["a", "b", "c"], "c", 1, (k) => ranks.get(k));
		expect(show(["a", "b", "c"], ranks, plan)).toEqual(["a", "c", "b"]);
	});

	it("a long random series of moves always shows the order that was asked for", () => {
		let seed = 12345;
		const rnd = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return seed % n;
		};
		let order = Array.from({ length: 9 }, (_, i) => `n${i}`);
		let ranks = new Map<string, number>();
		for (let step = 0; step < 400; step++) {
			const key = order[rnd(order.length)]!;
			const to = rnd(order.length);
			const expected = order.filter((k) => k !== key);
			expected.splice(to, 0, key);
			const plan = planMove(order, key, to, (k) => ranks.get(k));
			for (const c of plan) ranks = new Map(ranks).set(c.key, c.rank);
			const shown = rankOrder(order, keyOf, (k) => ranks.get(k));
			expect(shown, `step ${step}`).toEqual(order.indexOf(key) === to ? order : expected);
			order = shown;
			// A new notebook shows up unplaced: it goes first, as in the library.
			if (step % 50 === 49) order = [`new${step}`, ...order];
		}
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

describe("library state store", () => {
	const make = (device = "0a1b2c3d", adapter = new MemoryAdapter(), now = () => 1000) => ({ adapter, store: new LibraryStateStore(adapter, () => "Notebooks", device, now) });

	it("looking never writes; a change writes only this device's file in _meta", async () => {
		const { adapter, store } = make();
		expect((await store.load()).size).toBe(0);
		expect(adapter.writes).toEqual([]);
		await store.update({ kind: "pinned", key: "id:1", value: true });
		expect(adapter.writes).toEqual(["Notebooks/_meta/library-0a1b2c3d.json"]);
		expect(store.snapshot().get("id:1")?.pinned).toBe(true);
		await store.update({ kind: "pinned", key: "id:1", value: true });
		expect(adapter.writes).toHaveLength(1); // nothing changed: nothing written
	});

	it("two devices never write the same file and each sees the other's changes", async () => {
		const adapter = new MemoryAdapter();
		const phone = make("aaaaaaaa", adapter).store;
		const tablet = make("bbbbbbbb", adapter, () => 2000).store;
		await phone.update([{ kind: "pinned", key: "id:1", value: true }, { kind: "rank", key: "id:1", value: 5 }]);
		await tablet.update({ kind: "archived", key: "id:2", value: true });
		expect(new Set(adapter.writes)).toEqual(new Set(["Notebooks/_meta/library-aaaaaaaa.json", "Notebooks/_meta/library-bbbbbbbb.json"]));
		const seen = await phone.load();
		expect(seen.get("id:1")).toMatchObject({ pinned: true, rank: 5 });
		expect(seen.get("id:2")?.archived).toBe(true);
		// The tablet un-pins what the phone pinned: its file says so, the phone's file is untouched.
		const before = adapter.files.get(phone.ownPath);
		await tablet.update({ kind: "pinned", key: "id:1", value: false });
		expect(adapter.files.get(phone.ownPath)).toBe(before);
		expect((await phone.load()).get("id:1")?.pinned).toBe(false);
	});

	it("a change made with a slow clock after a later change elsewhere still wins", async () => {
		const adapter = new MemoryAdapter();
		const fast = make("bbbbbbbb", adapter, () => 90_000).store;
		const slow = make("aaaaaaaa", adapter, () => 10).store;
		await fast.update({ kind: "pinned", key: "id:1", value: true });
		await slow.update({ kind: "pinned", key: "id:1", value: false });
		expect((await fast.load()).get("id:1")?.pinned).toBe(false);
	});

	it("never overwrites its own file when it cannot be read: keeps one copy and refuses", async () => {
		const { adapter, store } = make();
		adapter.files.set(store.ownPath, "{ not json");
		await expect(store.update({ kind: "pinned", key: "id:1", value: true })).rejects.toBeInstanceOf(LibraryStateBlockedError);
		await expect(store.update({ kind: "pinned", key: "id:1", value: true })).rejects.toBeInstanceOf(LibraryStateBlockedError);
		expect(adapter.files.get(store.ownPath)).toBe("{ not json");
		expect([...adapter.files.keys()].filter((k) => k.includes("unreadable"))).toHaveLength(1);
	});

	it("an empty own file may be one that has not finished syncing: not overwritten either", async () => {
		const { adapter, store } = make();
		adapter.files.set(store.ownPath, "");
		await expect(store.update({ kind: "archived", key: "id:1", value: true })).rejects.toMatchObject({ reason: "empty" });
		expect(adapter.files.get(store.ownPath)).toBe("");
	});

	it("a file from a newer version is left as it is", async () => {
		const { adapter, store } = make();
		const future = `{"format":"${LIBRARY_STATE_FORMAT}","version":9,"items":[]}`;
		adapter.files.set(store.ownPath, future);
		await expect(store.update({ kind: "pinned", key: "id:1", value: true })).rejects.toMatchObject({ reason: "future" });
		expect(adapter.files.get(store.ownPath)).toBe(future);
	});

	it("another device's unreadable file is skipped and reported, never written", async () => {
		const { adapter, store } = make();
		adapter.files.set("Notebooks/_meta/library-bbbbbbbb.json", "garbage");
		adapter.files.set("Notebooks/_meta/library-cccccccc.json", serializeLibraryState(file("cccccccc", { key: "id:9", archived: { v: true, at: 3 } })));
		const merged = await store.load();
		expect(merged.get("id:9")?.archived).toBe(true);
		expect(store.blocked).toContain("library-bbbbbbbb.json");
		expect(adapter.writes).toEqual([]);
		await store.update({ kind: "pinned", key: "id:1", value: true });
		expect(adapter.files.get("Notebooks/_meta/library-bbbbbbbb.json")).toBe("garbage");
	});

	it("watches only the library files of the devices", () => {
		const { store } = make();
		expect(store.watches("Notebooks/_meta/library-0a1b2c3d.json")).toBe(true);
		expect(store.watches("Notebooks/_meta/library-xyz.json")).toBe(false);
		expect(store.watches("Notebooks/_meta/inbox-0a1b2c3d.json")).toBe(false);
		expect(store.watches("Other/_meta/library-0a1b2c3d.json")).toBe(false);
	});

	it("the vault root works too (no leading slash)", async () => {
		const adapter = new MemoryAdapter();
		const store = new LibraryStateStore(adapter, () => "", "0a1b2c3d", () => 1);
		await store.update({ kind: "pinned", key: "id:1", value: true });
		expect(adapter.writes).toEqual(["_meta/library-0a1b2c3d.json"]);
	});
});

describe("index support", () => {
	function sample(): LibraryIndex {
		const idx = new LibraryIndex();
		idx.upsert(entry("N/a.notebook", { modified: 100, id: "A", tags: ["x"], favorite: true }));
		idx.upsert(entry("N/b.notebook", { modified: 300, id: "B", tags: ["x", "y"] }));
		idx.upsert(entry("N/c.notebook", { modified: 200 }));
		return idx;
	}

	it("keeps the document id of an entry and of a saved index", () => {
		const doc = sampleDocument(1);
		expect(metaFromDocument(doc).id).toBe(doc.id);
		const idx = LibraryIndex.fromJSON(JSON.parse(JSON.stringify(sample().toJSON())));
		expect(idx.get("N/a.notebook")?.id).toBe("A");
		expect(idx.get("N/c.notebook")?.id).toBeUndefined();
		// an id of the wrong type is a malformed entry
		const bad = { ...sample().toJSON(), entries: [entry("N/z.notebook", { id: 5 as never })] };
		expect(LibraryIndex.fromJSON(bad).size).toBe(0);
	});

	it("needsId: read notebooks without an id (an older index), not placeholders or unreadable ones", () => {
		const idx = sample();
		expect(idx.needsId("N/a.notebook")).toBe(false);
		expect(idx.needsId("N/c.notebook")).toBe(true);
		idx.upsert(entry("N/d.notebook", { pages: 0 }));
		idx.upsert(entry("N/e.notebook", { mtime: -1, size: -1 }));
		expect(idx.needsId("N/d.notebook")).toBe(false);
		expect(idx.needsId("N/e.notebook")).toBe(false);
		expect(idx.needsId("missing")).toBe(false);
	});

	it("a filter hides entries from every view, before Recent is cut, and from search and tags", () => {
		const idx = sample();
		const hide = (e: LibraryEntry) => e.id !== "B";
		expect(idx.query({ scope: "all", sort: "name", filter: hide }).map((e) => e.name)).toEqual(["a", "c"]);
		expect(idx.query({ scope: "favorites", sort: "name", filter: (e) => e.id === "B" }).map((e) => e.name)).toEqual([]);
		expect(idx.query({ scope: "recent", sort: "modified", filter: hide }).map((e) => e.name)).toEqual(["c", "a"]);
		expect(idx.query({ scope: { tag: "y" }, sort: "name", filter: hide })).toEqual([]);
		expect(idx.tags(hide)).toEqual([{ tag: "x", count: 1 }]);
		expect(idx.tags().map((t) => t.tag)).toEqual(["x", "y"]);
		expect(idx.search({ search: "b", sort: "name", filter: hide })).toEqual([]);
		expect(idx.search({ search: "b", sort: "name" })).toHaveLength(1);
	});

	it("the archived scope returns everything for the view's filter to pick from; manual sorts like modified", () => {
		const idx = sample();
		expect(idx.query({ scope: "archived", sort: "name", filter: (e) => e.id === "A" }).map((e) => e.name)).toEqual(["a"]);
		expect(SORTS).toContain("manual");
		expect(idx.query({ scope: "all", sort: "manual" }).map((e) => e.name)).toEqual(["b", "c", "a"]);
	});
});

describe("files that share a document id (sync conflict copies)", () => {
	it("keeps the plain id key for the original and keys the copy by id and path", () => {
		const keys = stateKeys([
			{ id: "d1", path: "Notebooks/Maths (1).notebook" },
			{ id: "d1", path: "Notebooks/Maths.notebook" },
			{ id: "d2", path: "Notebooks/Physics.notebook" },
			{ path: "Notebooks/Unread.notebook" },
		]);
		expect(keys.get("Notebooks/Maths.notebook")).toBe("id:d1");
		expect(keys.get("Notebooks/Maths (1).notebook")).toBe("copy:d1:Notebooks/Maths (1).notebook");
		expect(keys.get("Notebooks/Physics.notebook")).toBe("id:d2");
		expect(keys.get("Notebooks/Unread.notebook")).toBe("path:Notebooks/Unread.notebook");
	});

	it("recognises the conflict names of Google Drive, OneDrive and Syncthing", () => {
		for (const copy of ["Maths (1)", "Maths-DESKTOP-AB12CD", "[Conflict] Maths", "Maths.sync-conflict-20261029-140500-ABCDEFG", "Maths (conflicted copy)"]) {
			const keys = stateKeys([{ id: "d1", path: `A/${copy}.notebook` }, { id: "d1", path: "A/Maths.notebook" }]);
			expect(keys.get("A/Maths.notebook")).toBe("id:d1");
			expect(keys.get(`A/${copy}.notebook`)).toBe(`copy:d1:A/${copy}.notebook`);
		}
	});

	it("two copies with ordinary names (a folder copied in the explorer): one keeps the id key, the other never shares it", () => {
		const keys = stateKeys([{ id: "d1", path: "B/Maths.notebook" }, { id: "d1", path: "A/Maths.notebook" }]);
		expect(keys.get("A/Maths.notebook")).toBe("id:d1");
		expect(keys.get("B/Maths.notebook")).toBe("copy:d1:B/Maths.notebook");
	});

	it("archiving the original does not hide the conflicted copy", () => {
		const index = new LibraryIndex();
		index.upsert(entry("Notebooks/Maths.notebook", { id: "d1" }));
		index.upsert(entry("Notebooks/Maths (1).notebook", { id: "d1" }));
		const state = mergeLibraryFiles([file("0a1b2c3d", { key: index.stateKey({ id: "d1", path: "Notebooks/Maths.notebook" }), archived: { v: true, at: 5 } })]);
		const archived = (path: string, id: string) => state.get(index.stateKey({ id, path }))?.archived === true;
		expect(archived("Notebooks/Maths.notebook", "d1")).toBe(true);
		expect(archived("Notebooks/Maths (1).notebook", "d1")).toBe(false);
		// archiving the copy does not hide the original either
		const both = mergeLibraryFiles([file("0a1b2c3d", { key: index.stateKey({ id: "d1", path: "Notebooks/Maths (1).notebook" }), archived: { v: true, at: 6 } })]);
		expect(both.get(index.stateKey({ id: "d1", path: "Notebooks/Maths.notebook" }))?.archived).toBeUndefined();
	});

	it("the index follows changes: the copy is keyed alone again once the other file is gone", () => {
		const index = new LibraryIndex();
		index.upsert(entry("Notebooks/Maths.notebook", { id: "d1" }));
		index.upsert(entry("Notebooks/Maths (1).notebook", { id: "d1" }));
		expect(index.stateKey({ id: "d1", path: "Notebooks/Maths (1).notebook" })).toBe("copy:d1:Notebooks/Maths (1).notebook");
		index.remove("Notebooks/Maths.notebook");
		expect(index.stateKey({ id: "d1", path: "Notebooks/Maths (1).notebook" })).toBe("id:d1");
		// an entry the index does not have keeps the plain key
		expect(index.stateKey({ id: "d9", path: "Elsewhere.notebook" })).toBe("id:d9");
		expect(index.stateKey({ path: "Elsewhere.notebook" })).toBe("path:Elsewhere.notebook");
	});
});
