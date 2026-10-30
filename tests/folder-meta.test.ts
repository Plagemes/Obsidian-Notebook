import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import {
	applyFolderOps, emptyFolderMeta, FOLDER_META_FORMAT, folderMetaOf, mergeFolderFiles, parseFolderMeta, patchOps, planRename,
	serializeFolderMeta, validFolderValue, type FolderItem, type FolderMetaFile,
} from "../src/library/folder-meta";
import { FolderMetaBlockedError, FolderMetaStore } from "../src/library/folder-meta-store";

function file(device: string, ...items: FolderItem[]): FolderMetaFile {
	return { ...emptyFolderMeta(device), items };
}

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

describe("folder metadata file", () => {
	it("round-trips deterministically (sorted by path, fixed field order)", () => {
		const data = file("0a1b2c3d",
			{ path: "N/b", icon: { v: "brain", at: 2 }, color: { v: "#F0565E", at: 1 } },
			{ path: "N/a", description: { v: "Notes", at: 3 }, art: { v: "waves", at: 3 } },
		);
		const text = serializeFolderMeta(data);
		expect(text.indexOf('"N/a"')).toBeLessThan(text.indexOf('"N/b"'));
		expect(text).toContain(`{"path":"N/b","color":{"v":"#F0565E","at":1},"icon":{"v":"brain","at":2}}`);
		const back = parseFolderMeta(text, "0a1b2c3d");
		expect(back.ok).toBe(true);
		if (back.ok) expect(serializeFolderMeta(back.data)).toBe(text);
	});

	it("refuses what is not ours, empty, damaged or newer files", () => {
		expect(parseFolderMeta("", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseFolderMeta("{", "0a1b2c3d")).toMatchObject({ ok: false, reason: "json" });
		expect(parseFolderMeta('{"format":"x","version":1,"items":[]}', "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
		expect(parseFolderMeta(`{"format":"${FOLDER_META_FORMAT}","version":2,"items":[]}`, "0a1b2c3d")).toMatchObject({ ok: false, reason: "future" });
	});

	it("keeps items it does not understand and writes them back", () => {
		const odd = { path: "N/x", color: { v: "red", at: 1 } };
		const r = parseFolderMeta(`{"format":"${FOLDER_META_FORMAT}","version":1,"device":"0a1b2c3d","items":[${JSON.stringify(odd)}]}`, "0a1b2c3d");
		expect(r.ok && r.data.unknown).toEqual([odd]);
		if (r.ok) expect(serializeFolderMeta(r.data)).toContain('"red"');
	});

	it("validates values", () => {
		expect(validFolderValue("color", "#16C2A3")).toBe(true);
		expect(validFolderValue("color", "teal")).toBe(false);
		expect(validFolderValue("icon", "graduation-cap")).toBe(true);
		expect(validFolderValue("icon", "Bad Icon")).toBe(false);
		expect(validFolderValue("art", "cells")).toBe(true);
		expect(validFolderValue("art", "stars")).toBe(false);
		expect(validFolderValue("description", "")).toBe(false);
		expect(validFolderValue("description", null)).toBe(true);
	});
});

describe("folder metadata merge", () => {
	it("latest change wins per folder and field; a tie goes to the larger device", () => {
		const a = file("aaaaaaaa", { path: "N/x", color: { v: "#111111", at: 5 }, icon: { v: "atom", at: 1 } });
		const b = file("bbbbbbbb", { path: "N/x", color: { v: "#222222", at: 3 }, icon: { v: "brain", at: 1 } });
		const m = mergeFolderFiles([a, b]).get("N/x");
		expect(m?.color).toBe("#111111");
		expect(m?.icon).toBe("brain");
	});

	it("a cleared field (null) hides the older value", () => {
		const a = file("aaaaaaaa", { path: "N/x", color: { v: "#111111", at: 5 } });
		const b = file("bbbbbbbb", { path: "N/x", color: { v: null, at: 6 } });
		expect(folderMetaOf(mergeFolderFiles([a, b]).get("N/x"))).toBeNull();
	});

	it("a change takes a time later than what it read, even with a slow clock", () => {
		const merged = mergeFolderFiles([file("bbbbbbbb", { path: "N/x", color: { v: "#222222", at: 9000 } })]);
		const after = applyFolderOps(emptyFolderMeta("aaaaaaaa"), merged, [{ path: "N/x", field: "color", value: "#333333" }], 100);
		expect(after.items[0]!.color).toEqual({ v: "#333333", at: 9001 });
	});

	it("skips no-op changes and invalid values", () => {
		const merged = mergeFolderFiles([file("bbbbbbbb", { path: "N/x", color: { v: "#222222", at: 5 } })]);
		const own = emptyFolderMeta("aaaaaaaa");
		expect(applyFolderOps(own, merged, [{ path: "N/x", field: "color", value: "#222222" }], 10).items).toEqual([]);
		expect(applyFolderOps(own, merged, [{ path: "N/y", field: "description", value: null }], 10).items).toEqual([]);
		expect(applyFolderOps(own, merged, [{ path: "N/x", field: "color", value: "nope" }], 10).items).toEqual([]);
	});

	it("patchOps: undefined leaves a field alone, null or a blank description clears it", () => {
		expect(patchOps("N/x", { color: "#111111", description: "  ", icon: undefined })).toEqual([
			{ path: "N/x", field: "color", value: "#111111" },
			{ path: "N/x", field: "description", value: null },
		]);
	});

	it("a rename moves the folder's fields and those of the folders inside it", () => {
		const own = file("aaaaaaaa",
			{ path: "N/Bio", color: { v: "#111111", at: 1 }, icon: { v: "brain", at: 1 } },
			{ path: "N/Bio/Cells", art: { v: "cells", at: 1 } },
			{ path: "N/Biology", color: { v: "#999999", at: 1 } },
		);
		const merged = mergeFolderFiles([own]);
		const ops = planRename(merged, "N/Bio", "N/Life");
		expect(ops).toContainEqual({ path: "N/Life", field: "color", value: "#111111" });
		expect(ops).toContainEqual({ path: "N/Life/Cells", field: "art", value: "cells" });
		expect(ops).toContainEqual({ path: "N/Bio", field: "color", value: null });
		expect(ops.some((o) => o.path.startsWith("N/Biology"))).toBe(false);
		const all = mergeFolderFiles([applyFolderOps(own, merged, ops, 10)]);
		expect(folderMetaOf(all.get("N/Life/Cells"))).toEqual({ art: "cells" });
		expect(folderMetaOf(all.get("N/Biology"))).toEqual({ color: "#999999" });
		expect(folderMetaOf(all.get("N/Life"))).toEqual({ color: "#111111", icon: "brain" });
		expect(folderMetaOf(all.get("N/Bio"))).toBeNull();
		expect(planRename(merged, "N/Other", "N/Else")).toEqual([]);
	});
});

describe("folder metadata store", () => {
	const make = (device = "0a1b2c3d", adapter = new MemoryAdapter(), now = () => 1000) => ({ adapter, store: new FolderMetaStore(adapter, () => "Notebooks", device, now) });

	it("writes only its own file, merges every device, and notifies on change", async () => {
		const { adapter, store } = make();
		adapter.files.set("Notebooks/_meta/folders-ffffffff.json", serializeFolderMeta(file("ffffffff", { path: "Notebooks/Math", icon: { v: "sigma", at: 5 } })));
		let calls = 0;
		const off = store.onFolderMetaChange(() => calls++);
		await store.load();
		expect(store.getFolderMeta("Notebooks/Math")).toEqual({ icon: "sigma" });
		await store.set("Notebooks/Math", { color: "#16C2A3", description: "Analysis" });
		expect(adapter.writes).toEqual(["Notebooks/_meta/folders-0a1b2c3d.json"]);
		expect(store.getFolderMeta("Notebooks/Math")).toEqual({ color: "#16C2A3", icon: "sigma", description: "Analysis" });
		expect(calls).toBe(2);
		off();
		await store.set("Notebooks/Math", { color: "#F0565E" });
		expect(calls).toBe(2);
	});

	it("follows a rename and writes nothing for folders without metadata", async () => {
		const { adapter, store } = make();
		await store.load();
		await store.set("Notebooks/A", { color: "#111111" });
		adapter.writes = [];
		await store.rename("Notebooks/Z", "Notebooks/Y");
		expect(adapter.writes).toEqual([]);
		await store.rename("Notebooks/A", "Notebooks/B");
		expect(store.getFolderMeta("Notebooks/B")).toEqual({ color: "#111111" });
		expect(store.getFolderMeta("Notebooks/A")).toBeNull();
		// The rename of the folder written by another device (its file syncs in later) still reads it back.
		const fresh = make("0a1b2c3d", adapter).store;
		await fresh.load();
		expect(fresh.getFolderMeta("Notebooks/B")).toEqual({ color: "#111111" });
	});

	it("never overwrites its own unreadable or empty file, and keeps a copy", async () => {
		for (const bad of ["", "{ broken"]) {
			const { adapter, store } = make();
			adapter.files.set("Notebooks/_meta/folders-0a1b2c3d.json", bad);
			await expect(store.set("Notebooks/A", { color: "#111111" })).rejects.toBeInstanceOf(FolderMetaBlockedError);
			expect(adapter.files.get("Notebooks/_meta/folders-0a1b2c3d.json")).toBe(bad);
			expect([...adapter.files.keys()].some((k) => k.includes("folders.unreadable-"))).toBe(true);
			expect(store.blocked).toContain("folders-0a1b2c3d.json");
		}
	});

	it("skips another device's unreadable file and reports it", async () => {
		const { adapter, store } = make();
		adapter.files.set("Notebooks/_meta/folders-ffffffff.json", "nope");
		await store.set("Notebooks/A", { icon: "atom" });
		expect(store.getFolderMeta("Notebooks/A")).toEqual({ icon: "atom" });
		expect(store.blocked).toContain("folders-ffffffff.json");
		expect(adapter.files.get("Notebooks/_meta/folders-ffffffff.json")).toBe("nope");
	});

	it("watches the device files only", () => {
		const { store } = make();
		expect(store.watches("Notebooks/_meta/folders-12345678.json")).toBe(true);
		expect(store.watches("Notebooks/_meta/library-12345678.json")).toBe(false);
		expect(store.watches("Notebooks/_meta/folders.unreadable-12345678.json")).toBe(false);
	});
});
