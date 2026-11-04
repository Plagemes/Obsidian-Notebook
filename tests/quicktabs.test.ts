import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import {
	applyQuickTabOps, emptyQuickTabs, findPin, mergeQuickTabFiles, orderAtEnd, parseQuickTabs, planMove, pruneQuickTabTombstones, QUICKTABS_MAX,
	resolveTab, serializeQuickTabs, tabsFor, tabText, DAY_MS, TOMBSTONE_DAYS, type QuickTab, type QuickTabsFile, type StoredQuickTab,
} from "../src/library/quicktabs";
import { QuickTabsBlockedError, QuickTabsStore } from "../src/library/quicktabs-store";

const tab = (id: string, order: number, o: Partial<StoredQuickTab> = {}): StoredQuickTab => ({ id, scope: "nb1", path: "N/a.notebook", pageId: `p-${id}`, num: 3, order, at: 10, ...o });
const file = (device: string, items: StoredQuickTab[], unknown: unknown[] = []): QuickTabsFile => ({ ...emptyQuickTabs(device), items, unknown });

describe("quick tabs file", () => {
	it("round-trips and keeps unknown fields and unknown entries", () => {
		const text = serializeQuickTabs(file("0a000000", [tab("q1", 0, { label: "Formulas", extra: { colour: "red" } })], [{ future: true }]));
		const parsed = parseQuickTabs(text, "0a000000");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.items[0]).toMatchObject({ id: "q1", label: "Formulas", extra: { colour: "red" } });
		expect(parsed.data.unknown).toEqual([{ future: true }]);
		expect(serializeQuickTabs(parsed.data)).toBe(text);
	});

	it("reports files it cannot read instead of fixing them", () => {
		expect(parseQuickTabs("", "0a000000")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseQuickTabs("{broken", "0a000000")).toMatchObject({ ok: false, reason: "json" });
		expect(parseQuickTabs('{"format":"other","version":1,"items":[]}', "0a000000")).toMatchObject({ ok: false, reason: "format" });
		expect(parseQuickTabs('{"format":"obsidian-notebook-quicktabs","version":99,"items":[]}', "0a000000")).toMatchObject({ ok: false, reason: "future" });
	});

	it("a damaged entry is kept as it was, not dropped", () => {
		const parsed = parseQuickTabs('{"format":"obsidian-notebook-quicktabs","version":1,"items":[{"id":"x"},{"id":"q1","scope":"s","path":"p","pageId":"g","order":1,"at":2}]}', "0a000000");
		expect(parsed.ok && parsed.data.items.map((i) => i.id)).toEqual(["q1"]);
		expect(parsed.ok && parsed.data.unknown).toEqual([{ id: "x" }]);
	});
});

describe("merge across devices", () => {
	it("the latest at wins per pin, a tie goes to the larger device, an unpin is a tombstone that wins", () => {
		const a = file("0a000000", [tab("q1", 0, { at: 10, label: "old" }), tab("q2", 1, { at: 5 })]);
		const b = file("0b000000", [tab("q1", 0, { at: 20, label: "new" }), tab("q2", 1, { at: 5, label: "tie" }), tab("q3", 2, { at: 7, deleted: true })]);
		const merged = mergeQuickTabFiles([a, b]);
		expect(merged.get("q1")?.label).toBe("new");
		expect(merged.get("q2")?.label).toBe("tie");
		expect(tabsFor(merged, "nb1").map((t) => t.id)).toEqual(["q1", "q2"]);
		const unpinnedLater = mergeQuickTabFiles([a, file("0b000000", [tab("q1", 0, { at: 30, deleted: true })])]);
		expect(tabsFor(unpinnedLater, "nb1").map((t) => t.id)).toEqual(["q2"]);
	});

	it("tabs are per notebook and ordered", () => {
		const merged = mergeQuickTabFiles([file("0a000000", [tab("q1", 2), tab("q2", 1), tab("q3", 0, { scope: "nb2" })])]);
		expect(tabsFor(merged, "nb1").map((t) => t.id)).toEqual(["q2", "q1"]);
		expect(tabsFor(merged, "nb2").map((t) => t.id)).toEqual(["q3"]);
		expect(findPin(merged, "nb1", "N/a.notebook", "p-q1")?.id).toBe("q1");
		expect(findPin(merged, "nb1", "N/other.notebook", "p-q1")).toBeNull();
	});
});

describe("ordering", () => {
	const tabs = (...orders: number[]): QuickTab[] => orders.map((o, i) => tab(`q${i}`, o));
	it("appends after the last", () => {
		expect(orderAtEnd([])).toBe(0);
		expect(orderAtEnd(tabs(0, 1, 5))).toBe(6);
	});

	it("moves with one value between the new neighbours", () => {
		expect(planMove(tabs(0, 1, 2), "q2", 0)).toEqual([{ id: "q2", order: -1 }]);
		expect(planMove(tabs(0, 1, 2), "q0", 1)).toEqual([{ id: "q0", order: 1.5 }]);
		expect(planMove(tabs(0, 1, 2), "q0", 2)).toEqual([{ id: "q0", order: 3 }]);
		expect(planMove(tabs(0, 1, 2), "q1", 1)).toEqual([]);
		expect(planMove(tabs(0, 1, 2), "nope", 1)).toEqual([]);
		expect(planMove(tabs(0, 1, 2), "q0", 99)).toEqual([{ id: "q0", order: 3 }]);
	});

	it("renumbers everything when two neighbours cannot be split", () => {
		const close = [tab("a", 1), tab("b", 1 + Number.EPSILON), tab("c", 5)];
		const plan = planMove(close, "c", 1);
		expect(plan.map((p) => p.id)).toEqual(["a", "c", "b"]);
		expect(plan.map((p) => p.order)).toEqual([0, 1, 2]);
	});
});

describe("resolving a tab", () => {
	const t = tab("q1", 0, { path: "N/a.notebook", pageId: "p9", num: 4 });
	it("finds the page by id even after pages were reordered", () => {
		expect(resolveTab(t, { path: "N/a.notebook", pageIds: ["p1", "p9", "p2"] })).toEqual({ kind: "here", index: 1 });
		expect(resolveTab(t, { path: "N/a.notebook", pageIds: ["p9", "p1"] })).toEqual({ kind: "here", index: 0 });
	});
	it("a page that is gone lands on the nearest page by its old number", () => {
		expect(resolveTab(t, { path: "N/a.notebook", pageIds: ["p1", "p2"] })).toEqual({ kind: "gone", index: 1 });
		expect(resolveTab(t, { path: "N/a.notebook", pageIds: ["p1", "p2", "p3", "p4", "p5"] })).toEqual({ kind: "gone", index: 3 });
		expect(resolveTab(t, { path: "N/a.notebook", pageIds: [] })).toEqual({ kind: "gone", index: 0 });
	});
	it("another notebook switches notebook", () => {
		expect(resolveTab(t, { path: "N/b.notebook", pageIds: ["p9"] })).toEqual({ kind: "other" });
		expect(resolveTab(t, { path: null, pageIds: [] })).toEqual({ kind: "other" });
	});
	it("says the label, else the page number now, else the number it had", () => {
		const p = (n: number) => `p. ${n}`;
		expect(tabText(tab("q", 0, { label: "Formulas" }), 1, p)).toBe("Formulas");
		expect(tabText(tab("q", 0), 6, p)).toBe("p. 7");
		expect(tabText(tab("q", 0, { num: 4 }), null, p)).toBe("p. 4");
	});
});

describe("changes", () => {
	it("a change takes a time later than what any device said, and keeps unknown fields of the winner", () => {
		const merged = mergeQuickTabFiles([file("0b000000", [tab("q1", 0, { at: 500, extra: { keep: 1 } })])]);
		const after = applyQuickTabOps(emptyQuickTabs("0a000000"), merged, [{ kind: "order", id: "q1", order: 4 }], 100);
		expect(after.items[0]).toMatchObject({ id: "q1", order: 4, at: 501, extra: { keep: 1 } });
	});

	it("retarget follows a renamed notebook for live pins only", () => {
		const merged = mergeQuickTabFiles([file("0a000000", [tab("q1", 0), tab("q2", 1, { deleted: true }), tab("q3", 2, { path: "N/z.notebook" })])]);
		const after = applyQuickTabOps(emptyQuickTabs("0a000000"), merged, [{ kind: "retarget", from: "N/a.notebook", to: "M/a.notebook" }], 100);
		expect(after.items.map((i) => [i.id, i.path])).toEqual([["q1", "M/a.notebook"]]);
	});

	it("tombstones older than 90 days are dropped, live pins and unknown entries never", () => {
		const now = 1000 * DAY_MS;
		const f = file("0a000000", [tab("old", 0, { deleted: true, at: now - (TOMBSTONE_DAYS + 1) * DAY_MS }), tab("recent", 1, { deleted: true, at: now - DAY_MS }), tab("live", 2, { at: 1 })], [{ x: 1 }]);
		const pruned = pruneQuickTabTombstones(f, now);
		expect(pruned.items.map((i) => i.id).sort()).toEqual(["live", "recent"]);
		expect(pruned.unknown).toEqual([{ x: 1 }]);
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

describe("quick tabs store", () => {
	const OWN = "Notebooks/_meta/quicktabs-0a000000.json";
	let clock = 1000;
	const make = (adapter = new MemoryAdapter(), device = "0a000000") => new QuickTabsStore(adapter, () => "Notebooks", device, () => clock++);
	const pin = (n: number) => ({ scope: "nb1", path: "N/a.notebook", pageId: `pg${n}`, num: n });

	it("pins, orders, moves and unpins, writing only this device's file", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/quicktabs-0b000000.json", serializeQuickTabs(file("0b000000", [tab("qb", 0, { scope: "nb1", pageId: "other" })])));
		const store = make(adapter);
		await store.load();
		const a = await store.pin(pin(1));
		const b = await store.pin({ ...pin(2), label: "  Formulas  " });
		expect(new Set(adapter.writes)).toEqual(new Set([OWN]));
		expect(store.list("nb1").map((t) => t.id)).toEqual(["qb", a, b]);
		expect(store.list("nb1")[2]?.label).toBe("Formulas");
		await store.move("nb1", b, 0);
		expect(store.list("nb1").map((t) => t.id)).toEqual([b, "qb", a]);
		await store.unpin("qb");
		expect(store.list("nb1").map((t) => t.id)).toEqual([b, a]);
		// another store (another start of the app) reads the same thing back
		const again = make(adapter, "0c000000");
		await again.load();
		expect(again.list("nb1").map((t) => t.id)).toEqual([b, a]);
	});

	it("pinning the same page twice keeps one tab", async () => {
		const store = make();
		const a = await store.pin(pin(1));
		expect(await store.pin(pin(1))).toBe(a);
		expect(store.list("nb1")).toHaveLength(1);
	});

	it("refuses more than the limit per notebook, but other notebooks have their own", async () => {
		const store = make();
		for (let i = 0; i < QUICKTABS_MAX; i++) await store.pin(pin(i));
		await expect(store.pin(pin(99))).rejects.toMatchObject({ reason: "limit" });
		await store.pin({ ...pin(99), scope: "nb2" });
		expect(store.list("nb2")).toHaveLength(1);
	});

	it("follows a renamed notebook", async () => {
		const store = make();
		await store.pin(pin(1));
		await store.retarget("N/a.notebook", "N/b.notebook");
		expect(store.list("nb1")[0]?.path).toBe("N/b.notebook");
	});

	it("never overwrites an own file it cannot read; keeps a copy only of a damaged one", async () => {
		for (const [text, copies] of [["{broken", 1], ["", 0], ['{"format":"obsidian-notebook-quicktabs","version":99,"items":[]}', 0]] as const) {
			const adapter = new MemoryAdapter();
			adapter.files.set(OWN, text);
			await expect(make(adapter).pin(pin(1))).rejects.toBeInstanceOf(QuickTabsBlockedError);
			await expect(make(adapter).unpin("q1")).rejects.toBeInstanceOf(QuickTabsBlockedError);
			expect(adapter.files.get(OWN)).toBe(text);
			expect([...adapter.files.keys()].filter((k) => k.includes("quicktabs.unreadable-"))).toHaveLength(copies);
		}
	});

	it("skips another device's unreadable file and reports it", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/quicktabs-0b000000.json", "{broken");
		const store = make(adapter);
		await store.pin(pin(1));
		expect(store.blocked).toContain("quicktabs-0b000000.json");
		expect(adapter.files.get("Notebooks/_meta/quicktabs-0b000000.json")).toBe("{broken");
		expect(store.list("nb1")).toHaveLength(1);
	});

	it("writes nothing when nothing changes, and keeps unknown entries and fields of its own file", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(OWN, serializeQuickTabs(file("0a000000", [tab("q1", 0, { extra: { keep: true } })], [{ future: 1 }])));
		const store = make(adapter);
		await store.load();
		await store.unpin("nope");
		expect(adapter.writes).toEqual([]);
		await store.move("nb1", "q1", 0);
		expect(adapter.writes).toEqual([]);
		await store.pin(pin(7));
		const text = adapter.files.get(OWN)!;
		expect(text).toContain('"keep":true');
		expect(text).toContain('"future":1');
	});

	it("watches only the quicktabs device files", () => {
		const store = make();
		expect(store.watches("Notebooks/_meta/quicktabs-0b000000.json")).toBe(true);
		expect(store.watches("Notebooks/_meta/collections-0b000000.json")).toBe(false);
		expect(store.watches("Notebooks/_meta/quicktabs.unreadable-deadbeef.json")).toBe(false);
	});
});
