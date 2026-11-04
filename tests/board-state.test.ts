import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import {
	applyBoardOps, BOARD_FORMAT, BOARD_PRUNE_GRACE_MS, emptyBoard, mergeBoardFiles, parseBoard, pruneBoardFile, serializeBoard, statusOf, validStatusId,
	type BoardFile, type BoardItem,
} from "../src/library/board-state";
import { BoardBlockedError, BoardStateStore } from "../src/library/board-state-store";

const item = (key: string, v: string | null, at: number, extra: Record<string, unknown> = {}): BoardItem => ({ key, status: { v, at }, extra });
const file = (device: string, ...items: BoardItem[]): BoardFile => ({ ...emptyBoard(device), items });

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
	async write(p: string, d: string) { this.writes.push(p); this.files.set(p, d); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

describe("board file", () => {
	it("round-trips, is deterministic and sorted by key", () => {
		const text = serializeBoard(file("0a1b2c3d", item("id:b", "done", 5), item("id:a", "doing", 3)));
		expect(text.indexOf('"id:a"')).toBeLessThan(text.indexOf('"id:b"'));
		expect(text.endsWith("\n")).toBe(true);
		const back = parseBoard(text, "0a1b2c3d");
		expect(back.ok).toBe(true);
		if (back.ok) expect(serializeBoard(back.data)).toBe(text);
	});

	it("refuses what is not ours, is empty, is damaged or is from a newer version", () => {
		expect(parseBoard("", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseBoard("{ nope", "0a1b2c3d")).toMatchObject({ ok: false, reason: "json" });
		expect(parseBoard('{"format":"other","version":1,"items":[]}', "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
		expect(parseBoard(`{"format":"${BOARD_FORMAT}","version":1}`, "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
		expect(parseBoard(`{"format":"${BOARD_FORMAT}","version":9,"items":[]}`, "0a1b2c3d")).toMatchObject({ ok: false, reason: "future" });
	});

	it("keeps what it does not understand: items, fields of items and fields of the file", () => {
		const text = `{"format":"${BOARD_FORMAT}","version":1,"device":"0a1b2c3d","note":{"x":1},"items":[
{"key":"id:a","status":{"v":"done","at":7},"label":"keep me"},
{"key":"id:b","status":"broken"},
{"weird":true}
]}`;
		const parsed = parseBoard(text, "0a1b2c3d");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.items).toHaveLength(1);
		expect(parsed.data.unknown).toHaveLength(2);
		const out = serializeBoard(parsed.data);
		expect(out).toContain('"label":"keep me"');
		expect(out).toContain('"note":{"x":1}');
		expect(out).toContain('{"weird":true}');
		expect(out).toContain('"status":"broken"');
		// And a rewrite after a change keeps them too.
		const changed = applyBoardOps(parsed.data, new Map(), [{ key: "id:c", status: "todo" }], 100);
		const again = serializeBoard(changed);
		expect(again).toContain('"label":"keep me"');
		expect(again).toContain('"note":{"x":1}');
		expect(again).toContain('{"weird":true}');
	});

	it("validates status ids", () => {
		expect(validStatusId("todo")).toBe(true);
		expect(validStatusId("")).toBe(false);
		expect(validStatusId("a".repeat(65))).toBe(false);
		expect(validStatusId("a\nb")).toBe(false);
		expect(validStatusId(3)).toBe(false);
	});

	it("an item with an invalid status is kept as unknown, not read", () => {
		const parsed = parseBoard(`{"format":"${BOARD_FORMAT}","version":1,"items":[{"key":"id:a","status":{"v":"","at":1}}]}`, "0a1b2c3d");
		expect(parsed.ok && parsed.data.items.length).toBe(0);
		expect(parsed.ok && parsed.data.unknown.length).toBe(1);
	});
});

describe("board merge", () => {
	it("the latest status of a notebook wins; a tie goes to the larger device id", () => {
		const a = file("0a000000", item("id:x", "doing", 10), item("id:y", "done", 5));
		const b = file("0b000000", item("id:x", "done", 20), item("id:z", "todo", 1));
		const m = mergeBoardFiles([a, b]);
		expect(m.get("id:x")).toEqual({ status: "done", at: 20 });
		expect(m.get("id:y")).toEqual({ status: "done", at: 5 });
		expect(m.get("id:z")).toEqual({ status: "todo", at: 1 });
		const tie = mergeBoardFiles([file("0a000000", item("id:x", "doing", 10)), file("0b000000", item("id:x", "done", 10))]);
		expect(tie.get("id:x")?.status).toBe("done");
		// The order the files are given in does not matter.
		expect(mergeBoardFiles([b, a])).toEqual(m);
	});

	it("a cleared status (null) written later beats an older status of another device", () => {
		const m = mergeBoardFiles([file("0a000000", item("id:x", "doing", 10)), file("0b000000", item("id:x", null, 11))]);
		expect(m.get("id:x")?.status).toBeNull();
	});

	it("moves on two devices to different notebooks both survive", () => {
		const phone = file("0a000000", item("id:a", "doing", 100));
		const tablet = file("0b000000", item("id:b", "print", 101));
		const m = mergeBoardFiles([phone, tablet]);
		expect(statusOf(m, "id:a")).toBe("doing");
		expect(statusOf(m, "id:b")).toBe("print");
	});

	it("a status stored under the path key is found for the same notebook once its id is known", () => {
		const m = mergeBoardFiles([file("0a000000", item("path:Notebooks/A.notebook", "done", 3))]);
		expect(statusOf(m, "id:abc", "Notebooks/A.notebook")).toBe("done");
		expect(statusOf(m, "id:abc", "Notebooks/B.notebook")).toBeNull();
		expect(statusOf(m, "path:Notebooks/A.notebook")).toBe("done");
	});
});

describe("board changes", () => {
	it("a change takes a time later than the merged and the own previous one (clock skew)", () => {
		const merged = new Map([["id:x", { status: "doing", at: 5000 }]]);
		const own = file("0a000000", item("id:x", "todo", 5200));
		const after = applyBoardOps(own, merged, [{ key: "id:x", status: "done" }], 100);
		expect(after.items.find((i) => i.key === "id:x")?.status).toEqual({ v: "done", at: 5201 });
	});

	it("a change that equals what every device already says is not written", () => {
		const merged = new Map([["id:x", { status: "done", at: 5 }]]);
		const after = applyBoardOps(emptyBoard("0a000000"), merged, [{ key: "id:x", status: "done" }, { key: "id:none", status: null }], 100);
		expect(after.items).toHaveLength(0);
	});

	it("skips invalid statuses", () => {
		const after = applyBoardOps(emptyBoard("0a000000"), new Map(), [{ key: "id:x", status: "" }], 100);
		expect(after.items).toHaveLength(0);
	});

	it("moving a notebook whose status sits under its path key is written under the id key", () => {
		const merged = new Map([["path:A.notebook", { status: "todo", at: 3 }]]);
		const same = applyBoardOps(emptyBoard("0a000000"), merged, [{ key: "id:x", status: "todo", path: "A.notebook" }], 100);
		expect(same.items).toHaveLength(0);
		const moved = applyBoardOps(emptyBoard("0a000000"), merged, [{ key: "id:x", status: "done", path: "A.notebook" }], 100);
		expect(moved.items.map((i) => [i.key, i.status.v])).toEqual([["id:x", "done"]]);
	});
});

describe("board store", () => {
	const make = (adapter = new MemoryAdapter(), device = "0a000000", now = () => 1000) => new BoardStateStore(adapter, () => "Notebooks", device, now);

	it("writes only its own file and merges the other devices' files on read", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/board-0b000000.json", serializeBoard(file("0b000000", item("id:a", "doing", 500))));
		const store = make(adapter);
		const merged = await store.setStatus({ key: "id:b", status: "done" });
		expect(adapter.writes).toEqual(["Notebooks/_meta/board-0a000000.json"]);
		expect(merged.get("id:a")?.status).toBe("doing");
		expect(merged.get("id:b")?.status).toBe("done");
		expect(adapter.files.get("Notebooks/_meta/board-0b000000.json")).toContain('"id:a"');
	});

	it("writes nothing for a change that is already there, and nothing when only looking", async () => {
		const adapter = new MemoryAdapter();
		const store = make(adapter);
		await store.load();
		await store.setStatus({ key: "id:a", status: null });
		expect(adapter.writes).toHaveLength(0);
		await store.setStatus({ key: "id:a", status: "done" });
		await store.setStatus({ key: "id:a", status: "done" });
		expect(adapter.writes).toHaveLength(1);
	});

	it("never overwrites an unreadable own file: keeps a copy and refuses", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/board-0a000000.json", "{ broken");
		await expect(make(adapter).setStatus({ key: "id:a", status: "done" })).rejects.toBeInstanceOf(BoardBlockedError);
		expect(adapter.files.get("Notebooks/_meta/board-0a000000.json")).toBe("{ broken");
		expect([...adapter.files.keys()].some((k) => k.includes("board.unreadable-"))).toBe(true);
		// An empty file (not yet synced) is not "no data" either.
		adapter.files.set("Notebooks/_meta/board-0a000000.json", "");
		await expect(make(adapter).setStatus({ key: "id:a", status: "done" })).rejects.toBeInstanceOf(BoardBlockedError);
		expect(adapter.files.get("Notebooks/_meta/board-0a000000.json")).toBe("");
	});

	it("skips another device's unreadable file and reports it", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/board-0b000000.json", "nope");
		const store = make(adapter);
		await store.setStatus({ key: "id:a", status: "done" });
		expect(store.blocked).toContain("board-0b000000.json");
		expect(adapter.files.get("Notebooks/_meta/board-0b000000.json")).toBe("nope");
	});

	it("tells the listeners when the merged statuses change, and only then", async () => {
		const adapter = new MemoryAdapter();
		const store = make(adapter);
		let n = 0;
		const off = store.onChange(() => void n++);
		await store.setStatus({ key: "id:a", status: "done" });
		expect(n).toBe(1);
		await store.load();
		expect(n).toBe(1);
		adapter.files.set("Notebooks/_meta/board-0b000000.json", serializeBoard(file("0b000000", item("id:a", "print", 9_999_999))));
		await store.load();
		expect(n).toBe(2);
		expect(store.snapshot().get("id:a")?.status).toBe("print");
		off();
		await store.setStatus({ key: "id:q", status: "todo" });
		expect(n).toBe(2);
	});

	it("recognises its device files by name", () => {
		const store = make();
		expect(store.watches("Notebooks/_meta/board-0b000000.json")).toBe(true);
		expect(store.watches("Notebooks/_meta/library-0b000000.json")).toBe(false);
		expect(store.watches("Notebooks/_meta/board-0b.json")).toBe(false);
	});
});

describe("board pruning", () => {
	const NOW = 100 * 86_400_000;
	const OLD = NOW - BOARD_PRUNE_GRACE_MS - 1;
	const ids = (f: BoardFile): string[] => f.items.map((i) => i.key);

	it("drops the statuses of notebooks that are gone, once they are older than the grace period", () => {
		const own = file("0a000000", item("id:alive", "done", OLD), item("id:gone", "done", OLD), item("id:recent", "done", NOW - 1000));
		const after = pruneBoardFile(own, [], new Set(["id:alive"]), NOW);
		expect(ids(after)).toEqual(["id:alive", "id:recent"]);
	});

	it("keeps everything when the library is not complete (no live set)", () => {
		const own = file("0a000000", item("id:gone", "done", OLD));
		expect(pruneBoardFile(own, [], null, NOW)).toBe(own);
	});

	it("drops a cleared status nobody contradicts, but keeps one that hides another device's status", () => {
		const own = file("0a000000", item("id:a", null, 5), item("id:b", null, 9), item("id:c", "done", 5));
		const other = file("0b000000", item("id:b", "doing", 3));
		expect(ids(pruneBoardFile(own, [other], null, NOW))).toEqual(["id:b", "id:c"]);
		// …and one that hides a status stored under the path key.
		const hiding = pruneBoardFile(file("0a000000", item("id:a", null, 9)), [file("0b000000", item("path:A.notebook", "doing", 3))], null, NOW);
		expect(ids(hiding)).toEqual(["id:a"]);
	});

	it("never touches the other devices' files and keeps unknown fields", () => {
		const own: BoardFile = { ...file("0a000000", item("id:gone", "x", OLD), item("id:keep", "y", OLD, { note: 1 })), extra: { future: true }, unknown: [{ odd: 1 }] };
		const other = file("0b000000", item("id:gone", "x", OLD));
		const after = pruneBoardFile(own, [other], new Set(["id:keep"]), NOW);
		expect(after.extra).toEqual({ future: true });
		expect(after.unknown).toEqual([{ odd: 1 }]);
		expect(after.items[0]?.extra).toEqual({ note: 1 });
		expect(other.items).toHaveLength(1);
	});

	it("the store prunes only its own file, only when something goes, and a clear is dropped on rewrite", async () => {
		const adapter = new MemoryAdapter();
		const other = serializeBoard(file("0b000000", item("id:gone", "doing", OLD)));
		adapter.files.set("Notebooks/_meta/board-0b000000.json", other);
		const store = new BoardStateStore(adapter, () => "Notebooks", "0a000000", () => NOW);
		expect(await store.prune(new Set())).toBe(false); // no own file yet: nothing to do
		await store.setStatus([{ key: "id:x", status: "done" }, { key: "id:gone", status: "done" }]);
		adapter.writes.length = 0;
		expect(await store.prune(null)).toBe(false);
		expect(adapter.writes).toHaveLength(0);
		const own = "Notebooks/_meta/board-0a000000.json";
		adapter.files.set(own, serializeBoard(file("0a000000", item("id:x", "done", OLD), item("id:gone", "done", OLD))));
		expect(await store.prune(new Set(["id:x"]))).toBe(true);
		expect(adapter.writes).toEqual([own]);
		expect(adapter.files.get(own)).toContain('"id:x"');
		expect(adapter.files.get(own)).not.toContain('"id:gone"');
		expect(adapter.files.get("Notebooks/_meta/board-0b000000.json")).toBe(other);
		// Clearing the only status of a notebook rewrites the file without the cleared line.
		await store.setStatus({ key: "id:x", status: null });
		expect(adapter.files.get(own)).not.toContain('"id:x"');
	});

	it("an unreadable own file is never pruned", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/board-0a000000.json", "{ broken");
		const store = new BoardStateStore(adapter, () => "Notebooks", "0a000000", () => NOW);
		await expect(store.prune(new Set())).rejects.toBeInstanceOf(BoardBlockedError);
		expect(adapter.files.get("Notebooks/_meta/board-0a000000.json")).toBe("{ broken");
	});
});
