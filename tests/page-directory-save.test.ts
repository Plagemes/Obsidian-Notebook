// Review fix R7 (0.26): what a read-only refresh of the page directory kept is never written over a newer entry of the library index.
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import { LibraryIndex, type LibraryEntry } from "../src/library/index";
import { entriesToSave, mergeIntoIndex } from "../src/view/quick-switcher";

function entry(path: string, mtime: number, extra: Partial<LibraryEntry> = {}): LibraryEntry {
	return { path, folder: "", name: path.replace(/\.notebook$/, ""), mtime, size: 1, created: 0, modified: mtime, pages: 1, tags: [], favorite: false, cover: "", ...extra };
}

describe("page directory: pending entries of a read-only refresh", () => {
	it("an entry older than the one on disk is not written; a newer one and a new path are", () => {
		const onDisk = new LibraryIndex();
		onDisk.upsert(entry("A.notebook", 200, { thumb: "data:new", thumbMtime: 200 }));
		onDisk.upsert(entry("B.notebook", 100));
		mergeIntoIndex(onDisk, [entry("A.notebook", 100), entry("B.notebook", 150), entry("C.notebook", 5)]);
		expect(onDisk.get("A.notebook")).toMatchObject({ mtime: 200, thumb: "data:new" });
		expect(onDisk.get("B.notebook")?.mtime).toBe(150);
		expect(onDisk.get("C.notebook")?.mtime).toBe(5);
	});

	it("keeps the newer thumbnail of the same version of a file (unchanged behaviour)", () => {
		const onDisk = new LibraryIndex();
		onDisk.upsert(entry("A.notebook", 100, { thumb: "data:thumb", thumbMtime: 100 }));
		mergeIntoIndex(onDisk, [entry("A.notebook", 100)]);
		expect(onDisk.get("A.notebook")?.thumb).toBe("data:thumb");
	});

	it("writes one entry per path, the last read, and none for a notebook deleted or read again since", () => {
		const index = new LibraryIndex();
		index.upsert(entry("A.notebook", 300));
		index.upsert(entry("B.notebook", 100));
		const pending = [entry("A.notebook", 100), entry("B.notebook", 100), entry("Gone.notebook", 50), entry("A.notebook", 200)];
		const now = [entry("A.notebook", 300)];
		const out = entriesToSave(pending, now, index);
		expect(out.map((e) => [e.path, e.mtime])).toEqual([["A.notebook", 300], ["B.notebook", 100]]);
		// Control: with nothing newer in memory, what was read is written.
		expect(entriesToSave([entry("B.notebook", 100)], [], index)).toHaveLength(1);
	});
});
