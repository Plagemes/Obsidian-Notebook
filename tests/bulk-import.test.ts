import { describe, expect, it } from "vitest";
import {
	buildEntries, classifyFile, extensionOf, formatSize, MAX_BULK_BYTES, naturalCompare, planNotebooks, safeNotebookName, skipCounts, stemOf,
	summarize, uniqueName, type BulkEntry, type BulkOutcome, type BulkSource, type PlanOptions,
} from "../src/library/bulk-import-logic";
import { BulkSkipError, applyLook, runBulkImport, type BulkControl, type BulkJob, type BulkRunDeps } from "../src/library/bulk-import-run";
import { parse } from "../src/model/serialize";
import type { Asset, NotebookDocument } from "../src/model/types";

const bytes = (...b: number[]) => new Uint8Array(b);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);

describe("file names", () => {
	it("splits a name into stem and extension", () => {
		expect(extensionOf("Anatomy.PDF")).toBe("pdf");
		expect(extensionOf("a/b\\c.d.jpeg")).toBe("jpeg");
		expect(extensionOf("noext")).toBe("");
		expect(extensionOf(".pdf")).toBe("pdf");
		expect(stemOf("C:\\x\\Lecture 1.final.pdf")).toBe("Lecture 1.final");
		expect(stemOf("noext")).toBe("noext");
	});

	it("orders numbers naturally", () => {
		expect(["p10.png", "p2.png", "P1.png"].sort(naturalCompare)).toEqual(["P1.png", "p2.png", "p10.png"]);
	});

	it("makes names every platform accepts", () => {
		expect(safeNotebookName("a/b:c", "x")).toBe("a b c");
		expect(safeNotebookName("  ", "PDF")).toBe("PDF");
		expect(safeNotebookName("con", "x")).toBe("con file");
		expect(safeNotebookName("name...", "x")).toBe("name");
		expect(safeNotebookName("x".repeat(300), "x")).toHaveLength(120);
	});

	it("formats sizes", () => {
		expect(formatSize(0)).toBe("0 KB");
		expect(formatSize(100)).toBe("1 KB");
		expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
	});
});

describe("classifyFile", () => {
	it("accepts PDFs and images", () => {
		expect(classifyFile("a.pdf", 10, "application/pdf", PDF)).toEqual({ kind: "pdf", skip: null });
		expect(classifyFile("a.PNG", 10, "", PNG)).toEqual({ kind: "image", skip: null });
		expect(classifyFile("a.jpg", 10, "image/jpeg", JPG)).toEqual({ kind: "image", skip: null });
		// Android content URIs: no extension, the MIME type says it.
		expect(classifyFile("document", 10, "application/pdf", null)).toEqual({ kind: "pdf", skip: null });
	});

	it("explains what it leaves out", () => {
		expect(classifyFile("notes.txt", 10, "text/plain", null).skip).toBe("unsupported");
		expect(classifyFile("photo.heic", 10, "", null).skip).toBe("heic");
		expect(classifyFile("photo.png", 10, "", bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0)).skip).toBe("heic");
		expect(classifyFile("a.pdf", 0, "", null).skip).toBe("empty");
		expect(classifyFile("a.pdf", MAX_BULK_BYTES + 1, "", null).skip).toBe("tooBig");
		expect(classifyFile("a.pdf", 10, "", new TextEncoder().encode("<html>not a pdf</html>")).skip).toBe("corrupt");
		expect(classifyFile("a.png", 10, "", new TextEncoder().encode("this is text, renamed")).skip).toBe("corrupt");
	});

	it("never rejects a file only because its first bytes could not be read", () => {
		expect(classifyFile("a.pdf", 10, "", null).skip).toBeNull();
		expect(classifyFile("a.png", 10, "", new Uint8Array(0)).skip).toBeNull();
	});

	it("lists the same file twice once", () => {
		const e = buildEntries([
			{ name: "A.pdf", size: 5, type: "", head: PDF },
			{ name: "a.pdf", size: 5, type: "", head: PDF },
			{ name: "a.pdf", size: 6, type: "", head: PDF },
		]);
		expect(e.map((x) => x.skip)).toEqual([null, "duplicate", null]);
		expect([...skipCounts(e)]).toEqual([["duplicate", 1]]);
	});
});

const entry = (id: number, fileName: string, kind: BulkEntry["kind"], skip: BulkEntry["skip"] = null): BulkEntry => ({ id, fileName, size: 1000, kind, skip });
const opts = (o: Partial<PlanOptions> = {}): PlanOptions => ({
	mode: "per-file", typed: {}, groupName: "Images 2026-11-04", fallbackPdf: "PDF", fallbackImage: "Image", taken: () => false, ...o,
});

describe("planNotebooks", () => {
	it("names each notebook after its file and leaves out the skipped ones", () => {
		const plan = planNotebooks([entry(0, "Anatomy.pdf", "pdf"), entry(1, "x.txt", null, "unsupported"), entry(2, "Map.png", "image")], opts());
		expect(plan.map((p) => [p.key, p.kind, p.name])).toEqual([["f0", "pdf", "Anatomy"], ["f2", "image", "Map"]]);
	});

	it("never takes a name that exists, nor one already planned (any case)", () => {
		const taken = new Set(["anatomy", "anatomy 2"]);
		const plan = planNotebooks([entry(0, "Anatomy.pdf", "pdf"), entry(1, "ANATOMY.png", "image"), entry(2, "Other.pdf", "pdf"), entry(3, "other.pdf", "pdf")], opts({ taken: (n) => taken.has(n.toLowerCase()) }));
		expect(plan.map((p) => p.name)).toEqual(["Anatomy 3", "ANATOMY 4", "Other", "other 2"]);
		expect(plan[0]!.wanted).toBe("Anatomy");
	});

	it("uses the name the user typed, sanitised, and still keeps it unique", () => {
		const plan = planNotebooks([entry(0, "a.pdf", "pdf"), entry(1, "b.pdf", "pdf")], opts({ typed: { f0: " Bio/Chem ", f1: "Bio Chem" } }));
		expect(plan.map((p) => p.name)).toEqual(["Bio Chem", "Bio Chem 2"]);
	});

	it("falls back when a file has no usable name", () => {
		const plan = planNotebooks([entry(0, ".pdf", "pdf"), entry(1, "///.png", "image")], opts());
		expect(plan.map((p) => p.name)).toEqual(["PDF", "Image"]);
	});

	it("puts all the images in one notebook, in natural order, when asked; PDFs stay apart", () => {
		const list = [entry(0, "p10.png", "image"), entry(1, "Book.pdf", "pdf"), entry(2, "p2.jpg", "image"), entry(3, "p1.jpg", "image"), entry(4, "bad.png", "image", "corrupt")];
		const plan = planNotebooks(list, opts({ mode: "images-together" }));
		expect(plan.map((p) => [p.key, p.name, p.entries])).toEqual([["images", "Images 2026-11-04", [3, 2, 0]], ["f1", "Book", [1]]]);
	});

	it("per-file mode keeps one notebook per image", () => {
		expect(planNotebooks([entry(0, "a.png", "image"), entry(1, "b.png", "image")], opts()).map((p) => p.entries)).toEqual([[0], [1]]);
	});

	it("a lone image is not turned into a group", () => {
		const plan = planNotebooks([entry(0, "a.png", "image")], opts({ mode: "images-together" }));
		expect(plan.map((p) => p.key)).toEqual(["images"]);
		expect(plan[0]!.entries).toEqual([0]);
	});

	it("uniqueName always finds a free name", () => {
		expect(uniqueName("A", () => false, new Set())).toBe("A");
		expect(uniqueName("A", (n) => n === "A" || n === "A 2", new Set(["a 3"]))).toBe("A 4");
	});
});

// ----------------------------------------------------------------------------- the runner

function source(name: string, data: Uint8Array | null, type = ""): BulkSource {
	return { name, size: data?.length ?? 0, type, head: () => Promise.resolve(data), read: () => (data ? Promise.resolve(data.slice().buffer) : Promise.reject(new Error("gone"))) };
}

function fakeDeps(over: Partial<BulkRunDeps<string>> = {}) {
	const created: Array<{ path: string; doc: NotebookDocument }> = [];
	const stored: string[] = [];
	let yields = 0;
	const deps: BulkRunDeps<string> = {
		store: (b, name, kind) => {
			stored.push(name);
			const asset: Asset = { id: stored.length.toString(16).padStart(64, "0"), kind, path: `_assets/${name}`, name, bytes: b.byteLength };
			return Promise.resolve(asset);
		},
		pdfSizes: () => Promise.resolve([{ width: 595, height: 842 }, { width: 595, height: 842 }]),
		imageSize: (_b, name) => (name.startsWith("heic") ? Promise.reject(new BulkSkipError("heic")) : name.startsWith("bad") ? Promise.reject(new Error("cannot decode")) : Promise.resolve({ width: 4000, height: 3000 })),
		create: (folder, name, doc) => {
			// Like createNotebook: a taken name gets a number, a notebook is never replaced.
			let path = `${folder}/${name}.notebook`;
			for (let i = 2; created.some((c) => c.path === path); i++) path = `${folder}/${name} ${i}.notebook`;
			created.push({ path, doc });
			return Promise.resolve({ file: path, path });
		},
		artStyle: () => "waves",
		yieldToUi: () => {
			yields++;
			return Promise.resolve();
		},
		...over,
	};
	return { deps, created, stored, yields: () => yields };
}

const ctl = (cancelAt = Infinity): BulkControl & { seen: string[] } => {
	const seen: string[] = [];
	return {
		seen,
		cancelled: () => seen.length >= cancelAt,
		onProgress: (p) => void seen.push(`${p.done}/${p.total} ${p.file}`),
	};
};

const job = (key: string, kind: "pdf" | "image", name: string, files: Array<[string, Uint8Array | null]>): BulkJob => ({
	key, kind, name, files: files.map(([n, d]) => ({ fileName: n, source: source(n, d) })),
});

describe("runBulkImport", () => {
	it("makes one valid notebook per job, in order, giving the UI thread back between files", async () => {
		const f = fakeDeps();
		const c = ctl();
		const r = await runBulkImport([job("f0", "pdf", "Book", [["Book.pdf", PDF]]), job("f1", "image", "Map", [["Map.png", PNG]])], "Notebooks", { paper: "blank", cover: null }, f.deps, c);
		expect(r.outcomes.map((o) => [o.name, o.path, o.pages])).toEqual([["Book", "Notebooks/Book.notebook", 2], ["Map", "Notebooks/Map.notebook", 1]]);
		expect(c.seen).toEqual(["0/2 Book.pdf", "1/2 Map.png"]);
		expect(f.yields()).toBeGreaterThanOrEqual(4);
		for (const made of f.created) expect(parse(JSON.stringify(made.doc)).ok).toBe(true);
		// PDF pages keep the PDF page sizes, image pages follow the picture's shape.
		expect(f.created[0]!.doc.pages[0]!.background).toMatchObject({ kind: "pdf", page: 1 });
		const ip = f.created[1]!.doc.pages[0]!;
		expect(ip.background?.kind).toBe("image");
		expect(Math.round((ip.height / ip.width) * 100)).toBe(75);
		expect(r.notStarted).toBe(0);
		expect(r.cancelled).toBe(false);
	});

	it("skips files that cannot be read or decoded with a reason, and goes on", async () => {
		const f = fakeDeps({ pdfSizes: (id) => (id.endsWith("2") ? Promise.reject(new Error("Invalid PDF structure")) : Promise.resolve([{ width: 600, height: 800 }])) });
		const r = await runBulkImport([
			job("f0", "pdf", "Good", [["good.pdf", PDF]]),
			job("f1", "pdf", "Broken", [["broken.pdf", PDF]]),
			job("images", "image", "Photos", [["a.png", PNG], ["heic1.jpg", JPG], ["bad.png", PNG], ["gone.png", null], ["b.png", PNG]]),
		], "N", { paper: "blank", cover: null }, f.deps, ctl());
		expect(r.outcomes.map((o) => o.path !== null)).toEqual([true, false, true]);
		expect(r.outcomes[1]!.skipped).toEqual([{ file: "broken.pdf", reason: "corrupt", detail: "Invalid PDF structure" }]);
		expect(r.outcomes[1]!.failed).toBeNull();
		expect(r.outcomes[2]!.skipped.map((s) => [s.file, s.reason])).toEqual([["heic1.jpg", "heic"], ["bad.png", "corrupt"], ["gone.png", "unreadable"]]);
		expect(r.outcomes[2]!.pages).toBe(2);
		const s = summarize(r.outcomes, 1, 0, false);
		expect(s).toMatchObject({ created: 2, pages: 3, failed: 0, skipped: 5, first: "N/Good.notebook" });
	});

	it("never overwrites: two jobs with the same name get two notebooks", async () => {
		const f = fakeDeps();
		const r = await runBulkImport([job("a", "pdf", "Same", [["1.pdf", PDF]]), job("b", "pdf", "Same", [["2.pdf", PDF]])], "N", { paper: "blank", cover: null }, f.deps, ctl());
		expect(r.outcomes.map((o) => o.path)).toEqual(["N/Same.notebook", "N/Same 2.notebook"]);
	});

	it("stops after the file in progress when cancelled; later notebooks are not started", async () => {
		const f = fakeDeps();
		const r = await runBulkImport([job("a", "pdf", "A", [["a.pdf", PDF]]), job("b", "pdf", "B", [["b.pdf", PDF]]), job("c", "pdf", "C", [["c.pdf", PDF]])], "N", { paper: "blank", cover: null }, f.deps, ctl(1));
		expect(r.outcomes.map((o) => o.name)).toEqual(["A"]);
		expect(r.notStarted).toBe(2);
		expect(r.cancelled).toBe(true);
		expect(f.created).toHaveLength(1);
	});

	it("keeps the images done so far when a group is cancelled, and says so", async () => {
		const f = fakeDeps();
		const r = await runBulkImport([job("images", "image", "Photos", [["1.png", PNG], ["2.png", PNG], ["3.png", PNG]])], "N", { paper: "blank", cover: null }, f.deps, ctl(2));
		expect(r.outcomes[0]).toMatchObject({ pages: 2, partial: true });
		expect(r.cancelled).toBe(true);
		expect(f.created[0]!.doc.pages).toHaveLength(2);
	});

	it("a failing create is reported for that notebook only", async () => {
		const f = fakeDeps({ create: (_f, name) => (name === "A" ? Promise.reject(new Error("disk full")) : Promise.resolve({ file: name, path: `N/${name}.notebook` })) });
		const r = await runBulkImport([job("a", "pdf", "A", [["a.pdf", PDF]]), job("b", "pdf", "B", [["b.pdf", PDF]])], "N", { paper: "blank", cover: null }, f.deps, ctl());
		expect(r.outcomes.map((o) => [o.name, o.path, o.failed])).toEqual([["A", null, "disk full"], ["B", "N/B.notebook", null]]);
		expect(summarize(r.outcomes, 0, 0, false)).toMatchObject({ created: 1, failed: 1 });
	});

	it("applies the paper and the cover to every notebook", async () => {
		const f = fakeDeps();
		await runBulkImport([job("a", "pdf", "A", [["a.pdf", PDF]]), job("b", "image", "B", [["b.png", PNG]])], "N", { paper: "dotted", cover: "#16C2A3" }, f.deps, ctl());
		for (const made of f.created) {
			expect(made.doc.pages.every((p) => p.paper.kind === "dotted")).toBe(true);
			expect(made.doc.meta?.cover).toBe("#16C2A3");
			expect(made.doc.meta?.coverArt?.kind).toBe("art");
			expect(parse(JSON.stringify(made.doc)).ok).toBe(true);
		}
	});

	it("an automatic cover and blank paper leave the document as a single import makes it", () => {
		const doc = { meta: { coverArt: { kind: "art", style: "waves", seed: "x" } }, pages: [{ paper: { kind: "blank", spacing: 1 } }] } as unknown as NotebookDocument;
		applyLook(doc, { paper: "blank", cover: null }, "n", "waves");
		expect(doc.meta?.coverArt).toBeUndefined();
		expect(doc.pages[0]!.paper.kind).toBe("blank");
	});
});

describe("summarize", () => {
	it("counts what was made, left out and not started", () => {
		const o = (p: Partial<BulkOutcome>): BulkOutcome => ({ key: "k", name: "n", path: null, pages: 0, skipped: [], failed: null, partial: false, ...p });
		const s = summarize([o({ path: "a", pages: 3 }), o({ path: "b", pages: 4, skipped: [{ file: "x", reason: "corrupt" }] }), o({ skipped: [{ file: "y", reason: "empty" }] }), o({ failed: "boom" })], 2, 5, true);
		expect(s).toEqual({ created: 2, pages: 7, failed: 1, skipped: 4, notStarted: 5, cancelled: true, first: "a" });
	});
});
