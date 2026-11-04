import { describe, expect, it } from "vitest";
import {
	AnnotateCache, assetIdsInText, fileKey, findAnnotators, mayMentionAsset, notebookPageFor, notebooksNaming, summarizeForAnnotate, viewerPageNumber, type ScanDeps,
} from "../src/library/annotate-pdf-logic";

const bg = (asset: string, page: number) => ({ kind: "pdf", asset, page });

describe("annotate PDF logic", () => {
	const a = summarizeForAnnotate("A.notebook", "A", { modified: 5, pages: [{ background: bg("x", 1) }, { background: bg("x", 2) }, {}] });
	const b = summarizeForAnnotate("B.notebook", "B", { modified: 9, pages: [{ background: bg("y", 1) }, { background: { kind: "image", asset: "x" } }] });
	const c = summarizeForAnnotate("C.notebook", "C", { modified: 9, pages: [{}, { background: bg("x", 4) }, { background: bg("x", 2) }] });

	it("summarizes only PDF backgrounds", () => {
		expect(b.backgrounds).toEqual([{ asset: "y", page: 1 }, null]);
	});
	it("finds notebooks on the asset, newest first, none for an unknown PDF", () => {
		expect(findAnnotators([a, b, c], "x", null).map((r) => r.path)).toEqual(["C.notebook", "A.notebook"]);
		expect(findAnnotators([a, b, c], "zzz", null)).toEqual([]);
		expect(findAnnotators([a, b, c], "x", null)[1]!.pdfPages).toBe(2);
	});
	it("opens the notebook page that shows the viewer page, else the first PDF page, else 1", () => {
		expect(notebookPageFor(c.backgrounds, "x", 2)).toBe(3);
		expect(notebookPageFor(c.backgrounds, "x", 99)).toBe(2);
		expect(notebookPageFor(c.backgrounds, "x", null)).toBe(2);
		expect(notebookPageFor(a.backgrounds, "q", 1)).toBe(1);
	});
	it("pre-filters by asset id", () => {
		expect(mayMentionAsset('{"assets":{"abc":1}}', "abc")).toBe(true);
		expect(mayMentionAsset("{}", "abc")).toBe(false);
		expect(mayMentionAsset("abc", "")).toBe(false);
	});
	it("reads the viewer page defensively", () => {
		expect(viewerPageNumber({ viewer: { child: { pdfViewer: { pdfViewer: { currentPageNumber: 7 } } } } })).toBe(7);
		expect(viewerPageNumber({ viewer: { child: { pdfViewer: { currentPageNumber: 3 } } } })).toBe(3);
		expect(viewerPageNumber({ viewer: null })).toBeNull();
		expect(viewerPageNumber({ viewer: { child: { pdfViewer: { currentPageNumber: 0 } } } })).toBeNull();
		expect(viewerPageNumber(undefined)).toBeNull();
	});
});

describe("annotate PDF cost control", () => {
	const ID = "a".repeat(24);
	const OTHER = "b".repeat(24);
	const text = (...ids: string[]) => `{"assets":{${ids.map((i) => `"${i}":{}`).join(",")}}}`;

	it("finds the quoted asset ids of a notebook, also the 24-char start of a longer id", () => {
		const ids = assetIdsInText(`{"background":{"kind":"pdf","asset":"${ID}","page":1},"assets":{"${"c".repeat(64)}":{"id":"x"}},"z":"short","w":"not hex ${OTHER}"}`);
		expect(ids.has(ID)).toBe(true);
		expect(ids.has("c".repeat(24))).toBe(true);
		expect(ids.has("c".repeat(64))).toBe(true);
		expect(ids.has(OTHER)).toBe(false);
	});

	it("keeps only asset values and asset-map keys, not any other quoted hex string", () => {
		const OTH = "d".repeat(32);
		const ids = assetIdsInText(`{"assets":{"${ID}":{"id":"${OTH}","kind":"pdf"}},"pages":[{"id":"${"e".repeat(30)}","note":"${"f".repeat(40)}","background":{"asset" : "${"1".repeat(64)}"}}]}`);
		expect([...ids].sort()).toEqual([ID, "1".repeat(64), "1".repeat(24)].sort());
	});

	it("keeps a bounded cache keyed by path and content stamp", () => {
		const c = new AnnotateCache();
		expect(c.pdfId("a.pdf", fileKey({ mtime: 1, size: 2 }))).toBeNull();
		c.setPdfId("a.pdf", fileKey({ mtime: 1, size: 2 }), "id1");
		expect(c.pdfId("a.pdf", "1:2")).toBe("id1");
		expect(c.pdfId("a.pdf", "9:2")).toBeNull(); // changed file: hashed again
		for (let i = 0; i < 100; i++) c.setPdfId(`p${i}.pdf`, "1:1", "x");
		expect(c.size.pdfs).toBeLessThanOrEqual(64);
		expect(c.pdfId("a.pdf", "1:2")).toBeNull();
		for (let i = 0; i < 5000; i++) c.setNotebookIds(`n${i}`, "1:1", new Set());
		expect(c.size.notebooks).toBeLessThanOrEqual(4000);
	});

	it("reads only the notebooks that are new or changed, and reports progress", async () => {
		const cache = new AnnotateCache();
		const files = [{ p: "a", k: "1:1", t: text(ID) }, { p: "b", k: "1:1", t: text(OTHER) }, { p: "c", k: "1:1", t: text(ID, OTHER) }];
		const reads: string[] = [];
		const steps: Array<[number, number]> = [];
		const deps = (): ScanDeps<(typeof files)[number]> => ({
			path: (f) => f.p, key: (f) => f.k, read: async (f) => (reads.push(f.p), f.t), cache, progress: (d, t) => steps.push([d, t]),
		});
		const first = await notebooksNaming(files, ID, deps());
		expect(first.matches.map((f) => f.p)).toEqual(["a", "c"]);
		expect(reads).toEqual(["a", "b", "c"]);
		expect(steps[0]).toEqual([0, 3]);
		expect(steps[steps.length - 1]).toEqual([3, 3]);
		// a second run (even for another PDF) reads nothing
		reads.length = 0;
		expect((await notebooksNaming(files, OTHER, deps())).matches.map((f) => f.p)).toEqual(["b", "c"]);
		expect(reads).toEqual([]);
		// one notebook changed: only it is read again
		files[0] = { p: "a", k: "2:5", t: text(OTHER) };
		expect((await notebooksNaming(files, ID, deps())).matches.map((f) => f.p)).toEqual(["c"]);
		expect(reads).toEqual(["a"]);
	});

	it("can be cancelled, keeps what it learned, and skips a notebook it cannot read", async () => {
		const cache = new AnnotateCache();
		const files = ["a", "b", "c", "d"].map((p) => ({ p, k: "1:1" }));
		let n = 0;
		const failed: string[] = [];
		const out = await notebooksNaming(files, ID, {
			path: (f) => f.p, key: (f) => f.k, cache,
			read: async (f) => {
				if (f.p === "a") throw new Error("gone");
				n++;
				return text(ID);
			},
			failed: (f) => failed.push(f.p),
			cancelled: () => n >= 2,
		});
		expect(out).toEqual({ matches: [], cancelled: true });
		expect(failed).toEqual(["a"]);
		expect(cache.notebookIds("b", "1:1")?.has(ID)).toBe(true);
		expect(cache.notebookIds("d", "1:1")).toBeNull();
	});
});
