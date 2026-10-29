import { describe, expect, it, vi } from "vitest";
import { libraryIndexPath, mergeMeta, parseStoredJson, patchNotebookId, patchNotebookMeta } from "../src/library/host-logic";
import { buildPdfDocument, importPdfAsNotebook, LARGE_PDF_BYTES, pdfNotebookName, type ImportDeps } from "../src/library/import-pdf";
import { createDocument } from "../src/model/document";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import type { Asset } from "../src/model/types";
import { DEFAULT_META } from "../src/model/types";

const asset: Asset = { id: "a".repeat(24), kind: "pdf", path: "Notebooks/_assets/aaaa.pdf", name: "Paper.pdf", bytes: 10 };

describe("library index path", () => {
	it("lives in the plugin folder", () => {
		expect(libraryIndexPath(".obsidian", "notebook")).toBe(".obsidian/plugins/notebook/library-index.json");
		expect(libraryIndexPath("/.config/", "notebook")).toBe(".config/plugins/notebook/library-index.json");
	});

	it("tolerates missing or corrupt files", () => {
		expect(parseStoredJson(null)).toBeNull();
		expect(parseStoredJson("")).toBeNull();
		expect(parseStoredJson("{not json")).toBeNull();
		expect(parseStoredJson('{"version":1}')).toEqual({ version: 1 });
	});
});

describe("mergeMeta", () => {
	it("replaces only the given fields and does not share arrays", () => {
		const patch = { tags: ["a"] };
		const merged = mergeMeta({ ...DEFAULT_META, favorite: true, bookmarks: ["p"] }, patch);
		expect(merged).toEqual({ tags: ["a"], favorite: true, cover: DEFAULT_META.cover, bookmarks: ["p"] });
		expect(merged.tags).not.toBe(patch.tags);
		expect(mergeMeta(undefined, { favorite: true }).favorite).toBe(true);
		expect(DEFAULT_META.favorite).toBe(false);
	});
});

describe("patchNotebookMeta", () => {
	it("writes the patched metadata and leaves the rest alone", () => {
		const doc = createDocument(new Date("2026-01-01T00:00:00Z"));
		const json = serialize(doc);
		const r = patchNotebookMeta(json, { favorite: true, tags: ["x", "y"], cover: "#ff0000" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.changed).toBe(true);
		expect(r.migrated).toBe(false);
		const back = parse(r.text);
		expect(back.ok && back.doc.meta).toMatchObject({ favorite: true, tags: ["x", "y"], cover: "#ff0000" });
		expect(back.ok && back.doc.id).toBe(doc.id);
		expect(back.ok && back.doc.pages).toEqual(doc.pages);
	});

	it("reports no change for an identical patch", () => {
		const json = serialize(createDocument());
		const r = patchNotebookMeta(json, { favorite: false });
		expect(r.ok && r.changed).toBe(false);
	});

	it("refuses unreadable files", () => {
		expect(patchNotebookMeta("{ nope", { favorite: true }).ok).toBe(false);
		expect(patchNotebookMeta("", { favorite: true }).ok).toBe(false);
		expect(patchNotebookMeta('{"format":"other"}', { favorite: true }).ok).toBe(false);
	});

	it("refuses a patch that would not survive the round trip", () => {
		const json = serialize(createDocument());
		expect(patchNotebookMeta(json, { cover: "not a colour" }).ok).toBe(false);
	});
});

describe("PDF import", () => {
	it("names the notebook after the file", () => {
		expect(pdfNotebookName("Lecture 1.pdf")).toBe("Lecture 1");
		expect(pdfNotebookName("dir/Lecture.PDF")).toBe("Lecture");
		expect(pdfNotebookName(["C:", "x", "Book.pdf"].join(String.fromCharCode(92)))).toBe("Book");
	});

	it("builds one page per PDF page with its own size and the asset registered", () => {
		const doc = buildPdfDocument(asset, [{ width: 595, height: 842 }, { width: 842, height: 595 }]);
		expect(doc.pages).toHaveLength(2);
		expect(doc.pages[1]).toMatchObject({ width: 842, height: 595, paper: { kind: "blank" }, background: { kind: "pdf", asset: asset.id, page: 2 } });
		expect(doc.assets).toEqual({ [asset.id]: asset });
		expect(serializeChecked(doc).ok).toBe(true);
		expect(() => buildPdfDocument(asset, [])).toThrow();
	});

	function deps(over: Partial<ImportDeps<string>> = {}): ImportDeps<string> & { opened: string[]; notes: string[]; hidden: number } {
		const state = { opened: [] as string[], notes: [] as string[], hidden: 0 };
		const base: ImportDeps<string> = {
			pick: async () => ({ name: "Paper.pdf", bytes: new ArrayBuffer(10) }),
			store: async () => asset,
			pageSizes: async () => [{ width: 595, height: 842 }],
			create: async (folder, name) => `${folder}/${name}.notebook`,
			open: async (f) => void state.opened.push(f),
			progress: () => () => void state.hidden++,
			notify: (text) => void state.notes.push(text),
			messages: { working: (n) => `working ${n}`, failed: (e) => `failed ${e}`, empty: () => "empty" },
		};
		return Object.assign(state, base, over);
	}

	it("imports and opens the new notebook", async () => {
		const d = deps();
		expect(await importPdfAsNotebook(d, "Notebooks/Uni")).toBe(true);
		expect(d.opened).toEqual(["Notebooks/Uni/Paper.notebook"]);
		expect(d.notes).toEqual([]);
	});

	it("does nothing when the picker is cancelled", async () => {
		const d = deps({ pick: async () => null });
		expect(await importPdfAsNotebook(d, "N")).toBe(false);
		expect(d.opened).toEqual([]);
		expect(d.notes).toEqual([]);
	});

	it("shows progress for large PDFs and always hides it", async () => {
		const d = deps({ pick: async () => ({ name: "Big.pdf", bytes: new ArrayBuffer(LARGE_PDF_BYTES) }), pageSizes: async () => { throw new Error("boom"); } });
		const progress = vi.spyOn(d, "progress");
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await importPdfAsNotebook(d, "N")).toBe(false);
		expect(progress).toHaveBeenCalledWith("working Big");
		expect(d.hidden).toBe(1);
		expect(d.notes).toEqual(["failed boom"]);
		err.mockRestore();
	});

	it("reports an empty PDF", async () => {
		const d = deps({ pageSizes: async () => [] });
		expect(await importPdfAsNotebook(d, "N")).toBe(false);
		expect(d.notes).toEqual(["empty"]);
	});
});

describe("patchNotebookId", () => {
	it("changes only the document id", () => {
		const doc = createDocument(new Date("2026-01-01T00:00:00Z"));
		const r = patchNotebookId(serialize(doc), "new-id");
		expect(r.ok && r.changed).toBe(true);
		if (!r.ok) return;
		const back = parse(r.text);
		expect(back.ok && back.doc.id).toBe("new-id");
		expect(back.ok && back.doc.pages).toEqual(doc.pages);
	});

	it("refuses unreadable files and empty ids", () => {
		expect(patchNotebookId("{ nope", "x").ok).toBe(false);
		expect(patchNotebookId(serialize(createDocument()), "").ok).toBe(false);
	});
});
