/** 0.16 review fixes on the bulk import (C8). */
import { describe, expect, it } from "vitest";
import {
	FINGERPRINT_BYTES, MAX_BULK_IMAGE_BYTES, MAX_BULK_PDF_BYTES, buildEntries, bulkLimit, bulkLimitMb, classifyFile, fingerprintOf,
	type BulkSource,
} from "../src/library/bulk-import-logic";
import { runBulkImport, type BulkControl, type BulkJob, type BulkRunDeps } from "../src/library/bulk-import-run";
import type { Asset, NotebookDocument } from "../src/model/types";

const PDF = new TextEncoder().encode("%PDF-1.7\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("C8: size limits by kind", () => {
	it("a PDF may be up to 100 MB and an image up to 50 MB, each with its own message value", () => {
		expect(bulkLimit("pdf")).toBe(MAX_BULK_PDF_BYTES);
		expect(bulkLimit("image")).toBe(MAX_BULK_IMAGE_BYTES);
		expect(bulkLimitMb("pdf")).toBe(100);
		expect(bulkLimitMb("image")).toBe(50);
		expect(classifyFile("a.pdf", MAX_BULK_PDF_BYTES, "", PDF).skip).toBeNull();
		expect(classifyFile("a.pdf", MAX_BULK_PDF_BYTES + 1, "", PDF).skip).toBe("tooBig");
		expect(classifyFile("a.png", MAX_BULK_IMAGE_BYTES, "", PNG).skip).toBeNull();
		expect(classifyFile("a.png", MAX_BULK_IMAGE_BYTES + 1, "", PNG)).toEqual({ kind: "image", skip: "tooBig" });
	});
});

describe("C8: same name and size is a duplicate only when the ends match", () => {
	const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

	it("fingerprints differ when the first or the last 64 KB differ, and match for equal files", () => {
		const a = fingerprintOf(bytes(100, 1), bytes(100, 2), 5000);
		expect(fingerprintOf(bytes(100, 1), bytes(100, 2), 5000)).toBe(a);
		expect(fingerprintOf(bytes(100, 9), bytes(100, 2), 5000)).not.toBe(a);
		expect(fingerprintOf(bytes(100, 1), bytes(100, 9), 5000)).not.toBe(a);
		expect(fingerprintOf(bytes(100, 1), bytes(100, 2), 5001)).not.toBe(a);
		// Moving a byte across the boundary between the two parts is a different file.
		expect(fingerprintOf(new Uint8Array([1, 2, 3]), new Uint8Array([4]), 4)).not.toBe(fingerprintOf(new Uint8Array([1, 2]), new Uint8Array([3, 4]), 4));
		expect(FINGERPRINT_BYTES).toBe(64 * 1024);
	});

	const f = (name: string, size: number, fingerprint?: string | null) => ({ name, size, type: "", head: PDF, ...(fingerprint !== undefined ? { fingerprint } : {}) });

	it("equal fingerprints are copies; different ones are two files that share a name", () => {
		expect(buildEntries([f("A.pdf", 5, "x"), f("a.pdf", 5, "x")]).map((e) => e.skip)).toEqual([null, "duplicate"]);
		expect(buildEntries([f("A.pdf", 5, "x"), f("a.pdf", 5, "y")]).map((e) => e.skip)).toEqual([null, null]);
		// Nothing to compare (not read): the old rule, same name and size.
		expect(buildEntries([f("A.pdf", 5), f("a.pdf", 5)]).map((e) => e.skip)).toEqual([null, "duplicate"]);
		expect(buildEntries([f("A.pdf", 5, null), f("a.pdf", 5, null)]).map((e) => e.skip)).toEqual([null, "duplicate"]);
	});
});

/** A runner rig where `store` keeps a list of the stored copies and `discard` removes them. */
function rig(opts: { badPdf?: boolean; createFails?: boolean } = {}) {
	const vault = new Set<string>();
	const trashed: string[] = [];
	const deps: BulkRunDeps<string> = {
		store: async (b, name, kind) => {
			const asset: Asset = { id: (vault.size + 1).toString(16).padStart(64, "0"), kind, path: `_assets/${name}`, name, bytes: b.byteLength };
			vault.add(asset.path);
			return asset;
		},
		discard: async (asset) => {
			vault.delete(asset.path);
			trashed.push(asset.path);
		},
		pdfSizes: async () => {
			if (opts.badPdf) throw new Error("Invalid PDF structure");
			return [{ width: 595, height: 842 }];
		},
		imageSize: async () => ({ width: 10, height: 10 }),
		create: async (folder, name, doc: NotebookDocument) => {
			if (opts.createFails) throw new Error("disk full");
			void doc;
			return { file: `${folder}/${name}`, path: `${folder}/${name}.notebook` };
		},
		artStyle: () => "waves",
		yieldToUi: () => Promise.resolve(),
	};
	return { deps, vault, trashed };
}

const source = (name: string, data: Uint8Array): BulkSource => ({ name, size: data.length, type: "", head: async () => data, read: async () => data.slice().buffer });
const job = (key: string, kind: "pdf" | "image", name: string, files: Array<[string, Uint8Array]>): BulkJob => ({
	key, kind, name, files: files.map(([n, d]) => ({ fileName: n, source: source(n, d) })),
});
const ctl: BulkControl = { cancelled: () => false, onProgress: () => undefined };

describe("C8: a PDF that cannot be read leaves no copy behind", () => {
	it("removes the copy it stored for a damaged PDF, keeps the copies of good ones", async () => {
		const bad = rig({ badPdf: true });
		const out = await runBulkImport([job("f0", "pdf", "Broken", [["Broken.pdf", PDF]])], "N", { paper: "blank", cover: null }, bad.deps, ctl);
		expect(out.outcomes[0]!.skipped.map((s) => s.reason)).toEqual(["corrupt"]);
		expect(bad.trashed).toEqual(["_assets/Broken.pdf"]);
		expect(bad.vault.size).toBe(0);

		const good = rig();
		const ok = await runBulkImport([job("f0", "pdf", "Good", [["Good.pdf", PDF]])], "N", { paper: "blank", cover: null }, good.deps, ctl);
		expect(ok.outcomes[0]!.path).not.toBeNull();
		expect(good.trashed).toEqual([]);
		expect(good.vault.has("_assets/Good.pdf")).toBe(true);
	});

	it("removes the copies of a notebook that could not be created, but not a copy another notebook of the run holds", async () => {
		const r = rig({ createFails: true });
		await runBulkImport([job("f0", "pdf", "A", [["A.pdf", PDF]])], "N", { paper: "blank", cover: null }, r.deps, ctl);
		expect(r.trashed).toEqual(["_assets/A.pdf"]);

		// Two files with the same bytes share an asset: the second job's failure must not remove what the first one holds.
		const shared = rig();
		let n = 0;
		shared.deps.create = async (folder, name) => {
			if (++n === 2) throw new Error("disk full");
			return { file: `${folder}/${name}`, path: `${folder}/${name}.notebook` };
		};
		shared.deps.store = async (b, name, kind) => {
			const asset: Asset = { id: "a".repeat(64), kind, path: "_assets/same.pdf", name, bytes: b.byteLength };
			shared.vault.add(asset.path);
			return asset;
		};
		await runBulkImport([job("f0", "pdf", "One", [["One.pdf", PDF]]), job("f1", "pdf", "Two", [["Two.pdf", PDF]])], "N", { paper: "blank", cover: null }, shared.deps, ctl);
		expect(shared.trashed).toEqual([]);
		expect(shared.vault.has("_assets/same.pdf")).toBe(true);
	});

	it("a file found larger than its kind's limit while reading is left out with the limit as the detail", async () => {
		const r = rig();
		const huge = { name: "Huge.png", size: 10, type: "", head: async () => PNG, read: async () => new ArrayBuffer(MAX_BULK_IMAGE_BYTES + 1) } as BulkSource;
		const out = await runBulkImport([{ key: "f0", kind: "image", name: "Huge", files: [{ fileName: "Huge.png", source: huge }] }], "N", { paper: "blank", cover: null }, r.deps, ctl);
		expect(out.outcomes[0]!.skipped).toEqual([{ file: "Huge.png", reason: "tooBig", detail: "50" }]);
		expect(r.vault.size).toBe(0);
	});
});
