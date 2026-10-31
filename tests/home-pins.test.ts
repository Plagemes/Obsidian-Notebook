import { describe, expect, it } from "vitest";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import {
	applyFolderOps, emptyFolderMeta, folderMetaOf, mergeFolderFiles, parseFolderMeta, patchOps, planRename, serializeFolderMeta, validFolderValue,
} from "../src/library/folder-meta";
import { FolderMetaStore } from "../src/library/folder-meta-store";
import { blankPageLike, isBlankPage } from "../src/library/loose-sheet-logic";
import { createPage, createStroke } from "../src/model/document";

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

describe("pinned folders (folder metadata, 0.13)", () => {
	it("only '1' (or a clear) is a valid pinned value", () => {
		expect(validFolderValue("pinned", "1")).toBe(true);
		expect(validFolderValue("pinned", null)).toBe(true);
		expect(validFolderValue("pinned", "0")).toBe(false);
		expect(validFolderValue("pinned", "yes")).toBe(false);
	});

	it("pins and unpins, and the merged state says so", () => {
		const own = emptyFolderMeta("0a1b2c3d");
		const pinned = applyFolderOps(own, new Map(), patchOps("N/Anatomia", { pinned: "1" }), 100);
		const merged = mergeFolderFiles([pinned]);
		expect(folderMetaOf(merged.get("N/Anatomia"))?.pinned).toBe(true);
		const unpinned = applyFolderOps(pinned, merged, patchOps("N/Anatomia", { pinned: null }), 200);
		expect(folderMetaOf(mergeFolderFiles([unpinned]).get("N/Anatomia"))).toBeNull();
	});

	it("the latest device wins, per folder", () => {
		const a = applyFolderOps(emptyFolderMeta("0000000a"), new Map(), patchOps("N/X", { pinned: "1" }), 100);
		// Device b has read a's file, then unpins: its clear is later than a's pin, so it wins everywhere.
		const b = applyFolderOps(emptyFolderMeta("0000000b"), mergeFolderFiles([a]), patchOps("N/X", { pinned: null }), 200);
		expect(folderMetaOf(mergeFolderFiles([a, b]).get("N/X"))).toBeNull();
		expect(folderMetaOf(mergeFolderFiles([b, a]).get("N/X"))).toBeNull();
	});

	it("survives a rename of the folder, with the subfolders", () => {
		const own = applyFolderOps(emptyFolderMeta("0a1b2c3d"), new Map(), [...patchOps("N/A", { pinned: "1" }), ...patchOps("N/A/Sub", { pinned: "1", color: "#F0565E" })], 100);
		const merged = mergeFolderFiles([own]);
		const after = applyFolderOps(own, merged, planRename(merged, "N/A", "N/B"), 200);
		const next = mergeFolderFiles([after]);
		expect(folderMetaOf(next.get("N/B"))?.pinned).toBe(true);
		expect(folderMetaOf(next.get("N/B/Sub"))).toEqual({ pinned: true, color: "#F0565E" });
		expect(folderMetaOf(next.get("N/A"))).toBeNull();
	});

	it("is written and read back by the store, in this device's file only", async () => {
		const adapter = new MemoryAdapter();
		const store = new FolderMetaStore(adapter, () => "Notebooks", "0a1b2c3d", () => 1000);
		await store.setPinned("Notebooks/Anatomia", true);
		await store.setPinned("Notebooks/Fisiologia", true);
		expect(store.pinnedFolders()).toEqual(["Notebooks/Anatomia", "Notebooks/Fisiologia"]);
		expect(store.getFolderMeta("Notebooks/Anatomia")?.pinned).toBe(true);
		const text = adapter.files.get(store.ownPath)!;
		const back = parseFolderMeta(text, "0a1b2c3d");
		expect(back.ok).toBe(true);
		if (back.ok) expect(serializeFolderMeta(back.data)).toBe(text);
		await store.setPinned("Notebooks/Anatomia", false);
		expect(store.pinnedFolders()).toEqual(["Notebooks/Fisiologia"]);
		let changes = 0;
		store.onFolderMetaChange(() => changes++);
		await store.setPinned("Notebooks/Fisiologia", false);
		expect(changes).toBe(1);
	});

	it("the old fields are untouched by pinning", async () => {
		const adapter = new MemoryAdapter();
		const store = new FolderMetaStore(adapter, () => "Notebooks", "0a1b2c3d", () => 1000);
		await store.set("Notebooks/Anatomia", { color: "#F0565E", icon: "heart-pulse" });
		await store.setPinned("Notebooks/Anatomia", true);
		expect(store.getFolderMeta("Notebooks/Anatomia")).toEqual({ color: "#F0565E", icon: "heart-pulse", pinned: true });
	});
});

describe("Quick page (loose sheet)", () => {
	it("a page with nothing on it is blank; ink, objects or a background make it not", () => {
		const page = createPage();
		expect(isBlankPage(page)).toBe(true);
		const inked = createPage();
		inked.strokes.push(createStroke("#000000", 2, [[1, 1, 0.5]] as never, "pen"));
		expect(isBlankPage(inked)).toBe(false);
		expect(isBlankPage({ ...createPage(), elements: [{ id: "e", type: "marker", kind: "question", x: 1, y: 1 }] })).toBe(false);
		expect(isBlankPage({ ...createPage(), background: { kind: "image", asset: "a" } as never })).toBe(false);
	});

	it("the new page has the size and paper of the last one, and its own id", () => {
		const last = createPage({ width: 420, height: 595 }, { kind: "ruled", spacing: 28 });
		const next = blankPageLike(last);
		expect([next.width, next.height, next.paper.kind, next.paper.spacing]).toEqual([420, 595, "ruled", 28]);
		expect(next.id).not.toBe(last.id);
		expect(next.strokes).toEqual([]);
	});
});
