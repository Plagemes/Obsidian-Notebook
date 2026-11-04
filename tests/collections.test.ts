import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import {
	adoptCollectionWinners, applyCollectionOps, countMatches, dayBounds, DAY_MS, emptyCollections, filterByRules, liveCollections, matchesRules, mergeCollectionFiles,
	parseCollections, pruneTombstones, readRules, serializeCollections, TOMBSTONE_DAYS, type CollectionRules, type CollectionsFile,
} from "../src/library/collections";
import { CollectionsBlockedError, CollectionsStore } from "../src/library/collections-store";
import type { LibraryEntry } from "../src/library/index";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function entry(path: string, o: Partial<LibraryEntry> = {}): LibraryEntry {
	const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	return { path, folder, name: path.slice(path.lastIndexOf("/") + 1), mtime: 1, size: 1, created: NOW - 100 * DAY_MS, modified: NOW - 50 * DAY_MS, pages: 1, tags: [], favorite: false, cover: "#fff", ...o };
}
const ctx = { now: NOW };
const ok = (rules: CollectionRules, e: LibraryEntry, c = ctx) => matchesRules(rules, e, c);

describe("collection rules", () => {
	it("no rules matches everything", () => {
		expect(ok({}, entry("N/a.notebook"))).toBe(true);
	});

	it("tags: any / all, nested tags match under their parents, case and accents ignored", () => {
		const e = entry("N/a", { tags: ["math/Algebra", "Esame"] });
		expect(ok({ tags: ["math"] }, e)).toBe(true);
		expect(ok({ tags: ["#MATH/algebra"] }, e)).toBe(true);
		expect(ok({ tags: ["math/geometry"] }, e)).toBe(false);
		expect(ok({ tags: ["math", "physics"], tagMode: "any" }, e)).toBe(true);
		expect(ok({ tags: ["math", "physics"], tagMode: "all" }, e)).toBe(false);
		expect(ok({ tags: ["math", "esame"], tagMode: "all" }, e)).toBe(true);
		expect(ok({ tags: ["x"] }, entry("N/b", { pageTags: [{ page: 0, tags: ["x"] }] }))).toBe(true);
	});

	it("folder includes subfolders but not siblings that share a prefix", () => {
		expect(ok({ folder: "N/Math" }, entry("N/Math/a"))).toBe(true);
		expect(ok({ folder: "N/Math" }, entry("N/Math/sub/a"))).toBe(true);
		expect(ok({ folder: "N/Math" }, entry("N/Mathematics/a"))).toBe(false);
		expect(ok({ folder: "N/Math" }, entry("N/b"))).toBe(false);
	});

	it("period: last N days on modified or created", () => {
		const recent = entry("N/a", { modified: NOW - 3 * DAY_MS });
		const old = entry("N/b", { modified: NOW - 40 * DAY_MS, created: NOW - 5 * DAY_MS });
		expect(ok({ period: { field: "modified", kind: "days", days: 7 } }, recent)).toBe(true);
		expect(ok({ period: { field: "modified", kind: "days", days: 30 } }, old)).toBe(false);
		expect(ok({ period: { field: "created", kind: "days", days: 7 } }, old)).toBe(true);
	});

	it("period: a date range, open at either end, inclusive", () => {
		const day = dayBounds("2026-10-01")!;
		const e = entry("N/a", { modified: day.end });
		expect(ok({ period: { field: "modified", kind: "range", from: day.start, to: day.end } }, e)).toBe(true);
		expect(ok({ period: { field: "modified", kind: "range", from: day.end + 1 } }, e)).toBe(false);
		expect(ok({ period: { field: "modified", kind: "range", to: day.start - 1 } }, e)).toBe(false);
		expect(dayBounds("2026-02-30")).toBeNull();
		expect(dayBounds("nope")).toBeNull();
	});

	it("favourite (starred or pinned) and has-PDF", () => {
		const starred = entry("N/a", { favorite: true });
		const pinned = entry("N/b");
		const c = { now: NOW, pinned: (e: LibraryEntry) => e.path === "N/b" };
		expect(ok({ favourite: true }, starred, c)).toBe(true);
		expect(ok({ favourite: true }, pinned, c)).toBe(true);
		expect(ok({ favourite: false }, pinned, c)).toBe(false);
		expect(ok({ favourite: false }, entry("N/c"), c)).toBe(true);
		expect(ok({ pdf: "yes" }, entry("N/d", { pdfPages: 3 }))).toBe(true);
		expect(ok({ pdf: "yes" }, entry("N/d"))).toBe(false);
		expect(ok({ pdf: "no" }, entry("N/d"))).toBe(true);
	});

	it("rules combine with AND, and the count follows", () => {
		const list = [
			entry("N/Math/a", { tags: ["exam"], favorite: true, modified: NOW - DAY_MS }),
			entry("N/Math/b", { tags: ["exam"], modified: NOW - DAY_MS }),
			entry("N/Art/c", { tags: ["exam"], favorite: true, modified: NOW - DAY_MS }),
		];
		const rules: CollectionRules = { tags: ["exam"], folder: "N/Math", favourite: true, period: { field: "modified", kind: "days", days: 7 } };
		expect(filterByRules(rules, list, ctx).map((e) => e.path)).toEqual(["N/Math/a"]);
		expect(countMatches({}, list, ctx)).toBe(3);
	});

	it("readRules drops what is unusable and returns the unknown fields", () => {
		const { rules, extra } = readRules({ tags: ["a", "A", " ", 3], tagMode: "weird", folder: "N/x/", period: { kind: "days", days: 0 }, favourite: "yes", pdf: "maybe", future: { a: 1 } });
		expect(rules).toEqual({ tags: ["a"], folder: "N/x" });
		expect(extra).toEqual({ future: { a: 1 } });
		expect(readRules({ period: { kind: "range", field: "created", from: 5, to: 2 } }).rules.period).toEqual({ field: "created", kind: "range", from: 2, to: 5 });
	});
});

function file(device: string, items: CollectionsFile["items"], unknown: unknown[] = []): CollectionsFile {
	return { ...emptyCollections(device), items, unknown };
}
const item = (id: string, name: string, at: number, extra: Record<string, unknown> = {}) => ({ id, name, rules: {}, at, ...extra });

describe("collections file", () => {
	it("round-trips deterministically and keeps unknown fields and unknown items", () => {
		const text = `{"format":"obsidian-notebook-collections","version":1,"device":"0a1b2c3d","items":[{"id":"c2","name":"B","rules":{"tags":["x"],"later":1},"at":2,"shiny":true},{"id":"c1","name":"A","rules":{},"at":1},"junk"]}`;
		const p = parseCollections(text, "0a1b2c3d");
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(p.data.unknown).toEqual(["junk"]);
		const out = serializeCollections(p.data);
		expect(out.indexOf('"c1"')).toBeLessThan(out.indexOf('"c2"'));
		expect(out).toContain('"shiny":true');
		expect(out).toContain('"later":1');
		expect(out).toContain('"junk"');
		const again = parseCollections(out, "0a1b2c3d");
		expect(again.ok && serializeCollections(again.data)).toBe(out);
	});

	it("reports files it must not fix: empty, bad JSON, not ours, newer", () => {
		expect(parseCollections("  ", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseCollections("{", "0a1b2c3d")).toMatchObject({ ok: false, reason: "json" });
		expect(parseCollections('{"format":"other","version":1,"items":[]}', "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
		expect(parseCollections('{"format":"obsidian-notebook-collections","version":2,"items":[]}', "0a1b2c3d")).toMatchObject({ ok: false, reason: "future" });
	});

	it("merges devices: latest wins, a tie goes to the larger device, a delete wins over an older copy", () => {
		const a = file("0a000000", [item("c1", "old", 1), item("c2", "same", 5), item("c3", "x", 1)]);
		const b = file("0b000000", [item("c1", "new", 2), item("c2", "same-b", 5), item("c3", "x", 2, { deleted: true })]);
		const m = mergeCollectionFiles([a, b]);
		expect(m.get("c1")?.name).toBe("new");
		expect(m.get("c2")?.name).toBe("same-b");
		expect(liveCollections(m).map((c) => c.id)).toEqual(["c1", "c2"]);
	});

	it("applyCollectionOps takes a later time than the merged one and carries unknown fields over", () => {
		const other = file("0b000000", [item("c1", "A", 5000, { extra: { keep: 1 } })]);
		const merged = mergeCollectionFiles([other]);
		const after = applyCollectionOps(emptyCollections("0a000000"), merged, [{ kind: "upsert", id: "c1", name: "  A2  ", rules: { favourite: true } }], 1000);
		expect(after.items[0]).toMatchObject({ id: "c1", name: "A2", at: 5001, rules: { favourite: true }, extra: { keep: 1 } });
		const del = applyCollectionOps(after, mergeCollectionFiles([other, after]), [{ kind: "delete", id: "c1" }], 1000);
		expect(del.items[0]).toMatchObject({ deleted: true, at: 5002 });
		expect(applyCollectionOps(emptyCollections("0a000000"), new Map(), [{ kind: "upsert", id: "x", name: "   ", rules: {} }], 1).items).toHaveLength(0);
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

describe("collections store", () => {
	const make = (adapter = new MemoryAdapter(), device = "0a000000", now = () => 1000) => new CollectionsStore(adapter, () => "Notebooks", device, now);

	it("saves to this device's file only, lists, edits and deletes", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/collections-0b000000.json", serializeCollections(file("0b000000", [item("cb", "Other", 10)])));
		const store = make(adapter);
		await store.load();
		const id = await store.save({ name: "Exams", rules: { tags: ["exam"] } });
		expect(adapter.writes).toEqual(["Notebooks/_meta/collections-0a000000.json"]);
		expect(store.list().map((c) => c.name)).toEqual(["Exams", "Other"]);
		await store.save({ id, name: "Exams 2", rules: { tags: ["exam"], pdf: "yes" } });
		expect(store.get(id)?.rules.pdf).toBe("yes");
		await store.remove(id);
		expect(store.list().map((c) => c.name)).toEqual(["Other"]);
		expect(adapter.files.get("Notebooks/_meta/collections-0b000000.json")).toContain('"cb"');
	});

	it("never overwrites an unreadable own file and keeps a copy", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/collections-0a000000.json", "{broken");
		const store = make(adapter);
		await expect(store.save({ name: "X", rules: {} })).rejects.toBeInstanceOf(CollectionsBlockedError);
		expect(adapter.files.get("Notebooks/_meta/collections-0a000000.json")).toBe("{broken");
		expect([...adapter.files.keys()].some((k) => k.includes("collections.unreadable-"))).toBe(true);
		const empty = new MemoryAdapter();
		empty.files.set("Notebooks/_meta/collections-0a000000.json", "");
		await expect(make(empty).save({ name: "X", rules: {} })).rejects.toBeInstanceOf(CollectionsBlockedError);
		expect(empty.files.get("Notebooks/_meta/collections-0a000000.json")).toBe("");
	});

	it("F8: keeps a copy of a damaged own file only, not of an empty or newer one", async () => {
		const unreadable = (a: MemoryAdapter) => [...a.files.keys()].filter((k) => k.includes("collections.unreadable-"));
		const OWN = "Notebooks/_meta/collections-0a000000.json";
		for (const [text, copies] of [["", 0], ['{"format":"obsidian-notebook-collections","version":2,"items":[]}', 0], ["{broken", 1], ['{"format":"other","version":1}', 1]] as const) {
			const adapter = new MemoryAdapter();
			adapter.files.set(OWN, text);
			await expect(make(adapter).save({ name: "X", rules: {} })).rejects.toBeInstanceOf(CollectionsBlockedError);
			await expect(make(adapter).remove("c1")).rejects.toBeInstanceOf(CollectionsBlockedError);
			expect(adapter.files.get(OWN)).toBe(text);
			expect(unreadable(adapter)).toHaveLength(copies);
		}
	});

	it("F8: drops tombstones older than 90 days when the own file is rewritten, and only then", async () => {
		const day = 24 * 60 * 60 * 1000;
		const now = 200 * day;
		const OWN = "Notebooks/_meta/collections-0a000000.json";
		const adapter = new MemoryAdapter();
		const old = item("old", "Old", now - 100 * day, { deleted: true });
		const recent = item("recent", "Recent", now - 10 * day, { deleted: true });
		const live = item("live", "Live", now - 150 * day);
		adapter.files.set(OWN, serializeCollections(file("0a000000", [old, recent, live])));
		const store = make(adapter, "0a000000", () => now);
		// nothing to change: the file is not rewritten, the old tombstone is still there
		await store.remove("old");
		expect(adapter.writes).toEqual([]);
		expect(adapter.files.get(OWN)).toContain('"old"');
		// a real change rewrites it, without the old tombstone
		await store.save({ name: "Fresh", rules: {} });
		const text = adapter.files.get(OWN)!;
		expect(text).not.toContain('"old"');
		expect(text).toContain('"recent"');
		expect(text).toContain('"live"');
		expect(text).toContain("Fresh");
		expect(store.list().map((c) => c.id)).toContain("live");
	});

	it("a deletion does not come back after the tombstone's 90 days (two devices)", async () => {
		const OWN = "Notebooks/_meta/collections-0a000000.json";
		const BOWN = "Notebooks/_meta/collections-0b000000.json";
		for (const bRewrites of [false, true]) {
			let now = 1000 * DAY_MS;
			const adapter = new MemoryAdapter();
			const a = new CollectionsStore(adapter, () => "Notebooks", "0a000000", () => now);
			const b = new CollectionsStore(adapter, () => "Notebooks", "0b000000", () => now);
			const id = await b.save({ name: "Exams", rules: {} });
			now += DAY_MS;
			await a.load();
			await a.remove(id);
			expect(adapter.files.get(BOWN)).not.toContain('"deleted"');
			if (bRewrites) {
				now += DAY_MS;
				await b.save({ name: "Other", rules: {} });
				expect(adapter.files.get(BOWN)).toContain('"deleted":true');
			}
			now += (TOMBSTONE_DAYS + 10) * DAY_MS;
			await a.save({ name: "Fresh", rules: {} });
			expect(adapter.files.get(OWN)!.includes(id)).toBe(!bRewrites);
			const fresh = new CollectionsStore(adapter, () => "Notebooks", "0c000000", () => now);
			await fresh.load();
			expect(fresh.list().some((c) => c.id === id)).toBe(false);
		}
	});

	it("a deletion made elsewhere is adopted; a tombstone is not pruned while another file holds the collection live", () => {
		const now = 1000 * DAY_MS;
		const old = now - (TOMBSTONE_DAYS + 1) * DAY_MS;
		const mine = file("0a000000", [item("c1", "A", 5), item("c2", "B", 5)]);
		const theirs = file("0b000000", [item("c1", "A", 9, { deleted: true })]);
		const after = adoptCollectionWinners(mine, mergeCollectionFiles([mine, theirs]));
		expect(after.items.find((i) => i.id === "c1")).toMatchObject({ at: 9, deleted: true });
		expect(after.items.find((i) => i.id === "c2")).toBe(mine.items[1]);
		const tomb = file("0a000000", [item("c1", "A", old, { deleted: true })]);
		expect(pruneTombstones(tomb, now, [file("0b000000", [item("c1", "A", old - 1)])]).items).toHaveLength(1);
		expect(pruneTombstones(tomb, now, [], false).items).toHaveLength(1);
		expect(pruneTombstones(tomb, now, [file("0b000000", [item("c1", "A", old, { deleted: true })])]).items).toHaveLength(0);
	});

	it("F8: pruneTombstones keeps live collections and unknown items whatever their age", () => {
		const now = 1_000 * DAY_MS;
		const data = file("0a000000", [item("a", "A", 1, { deleted: true }), item("b", "B", 1), item("c", "C", now - (TOMBSTONE_DAYS - 1) * DAY_MS, { deleted: true })], ["junk"]);
		const out = pruneTombstones(data, now);
		expect(out.items.map((i) => i.id)).toEqual(["b", "c"]);
		expect(out.unknown).toEqual(["junk"]);
		expect(pruneTombstones(out, now)).toBe(out);
	});

	it("an unreadable file of another device is skipped and reported, not touched", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/collections-0b000000.json", "nope");
		const store = make(adapter);
		await store.save({ name: "Mine", rules: {} });
		expect(store.blocked).toContain("collections-0b000000.json");
		expect(adapter.files.get("Notebooks/_meta/collections-0b000000.json")).toBe("nope");
	});

	it("notifies listeners only when the list changed", async () => {
		const store = make();
		let n = 0;
		store.onChange(() => n++);
		await store.load();
		expect(n).toBe(0);
		await store.save({ name: "A", rules: {} });
		expect(n).toBe(1);
		await store.load();
		expect(n).toBe(1);
		expect(store.watches("Notebooks/_meta/collections-0b000000.json")).toBe(true);
		expect(store.watches("Notebooks/_meta/library-0b000000.json")).toBe(false);
	});
});
