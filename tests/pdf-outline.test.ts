import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { DEFAULT_OUTLINE_SOURCES, OutlineBuilder, type OutlineSources } from "../src/model/outline-builder";
import { mapPdfOutline, sourcePageIndex } from "../src/model/pdf-outline-map";
import type { Asset, Page } from "../src/model/types";
import { MAX_CACHED_PDFS, normaliseOutlineCache, OUTLINE_CACHE_KEY, storeOutline } from "../src/pdf/outline-cache";
import { PdfOutlineSource, RETRY_MS } from "../src/pdf/outline-source";
import { linkAt, MAX_OUTLINE_ENTRIES, pageIndexOfDest, readPageLinks, readPdfOutline, safeExternalUrl, type PdfOutlineEntry } from "../src/pdf/pdf-outline";
import type { PdfDoc, PdfPage } from "../src/pdf/pdfjs-types";

const ASSET = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";

/** A fake pdf.js document: page references are `{ num }` objects whose page index is `num - 1`. */
function fakeDoc(over: Partial<PdfDoc> & { outline?: unknown; named?: Record<string, unknown> } = {}): PdfDoc {
	const { outline, named, ...rest } = over;
	return {
		numPages: 10,
		getPage: async () => { throw new Error("not needed"); },
		destroy: async () => undefined,
		getOutline: async () => outline ?? null,
		getDestination: async (id: string) => named?.[id] ?? null,
		getPageIndex: async (ref: unknown) => (ref as { num: number }).num - 1,
		...rest,
	};
}

const ref = (n: number) => [{ num: n, gen: 0 }, { name: "XYZ" }, 0, 0, null];

describe("the outline of a PDF (#46)", () => {
	it("flattens nested bookmarks with levels and 1-based pages, resolving names, references and indices", async () => {
		const doc = fakeDoc({
			named: { "chapter.2": ref(4) },
			outline: [
				{ title: "Intro", dest: ref(1), items: [{ title: "  Aims \n and scope ", dest: "chapter.2", items: [] }] },
				{ title: "Chapter 2", dest: [5, { name: "Fit" }], items: [{ title: "Lost", dest: "missing" }] },
				{ title: "", dest: ref(9), items: [{ title: "Child of an untitled one", dest: ref(9) }] },
				{ title: "No destination" },
			],
		});
		expect(await readPdfOutline(doc)).toEqual([
			{ title: "Intro", level: 1, page: 1 },
			{ title: "Aims and scope", level: 2, page: 4 },
			{ title: "Chapter 2", level: 1, page: 6 },
			{ title: "Lost", level: 2, page: 0 },
			{ title: "Child of an untitled one", level: 2, page: 9 },
			{ title: "No destination", level: 1, page: 0 },
		]);
	});

	it("gives an empty list for a PDF without an outline, and throws when the PDF cannot be read", async () => {
		expect(await readPdfOutline(fakeDoc())).toEqual([]);
		expect(await readPdfOutline(fakeDoc({ getOutline: undefined }))).toEqual([]);
		await expect(readPdfOutline(fakeDoc({ getOutline: async () => { throw new Error("corrupt"); } }))).rejects.toThrow("corrupt");
	});

	it("reads a hostile outline within bounds", async () => {
		const wide = Array.from({ length: MAX_OUTLINE_ENTRIES + 500 }, (_, i) => ({ title: `T${i}`, dest: ref(1) }));
		expect((await readPdfOutline(fakeDoc({ outline: wide }))).length).toBe(MAX_OUTLINE_ENTRIES);
		let deep: Record<string, unknown> = { title: "leaf", dest: ref(1) };
		for (let i = 0; i < 30; i++) deep = { title: `d${i}`, dest: ref(1), items: [deep] };
		const levels = (await readPdfOutline(fakeDoc({ outline: [deep] }))).map((e) => e.level);
		expect(Math.max(...levels)).toBeLessThanOrEqual(8);
		expect((await readPdfOutline(fakeDoc({ outline: "nonsense" })))).toEqual([]);
	});

	it("resolves a destination only to a page that exists", async () => {
		const doc = fakeDoc({ named: { n: ref(3) } });
		expect(await pageIndexOfDest(doc, "n")).toBe(2);
		expect(await pageIndexOfDest(doc, ref(11))).toBeNull();
		expect(await pageIndexOfDest(doc, [-1])).toBeNull();
		expect(await pageIndexOfDest(doc, [])).toBeNull();
		expect(await pageIndexOfDest(doc, "nope")).toBeNull();
		expect(await pageIndexOfDest(fakeDoc({ getPageIndex: async () => { throw new Error("x"); } }), ref(1))).toBeNull();
	});
});

describe("the links of a PDF page (#46)", () => {
	const page = { getViewport: () => ({ width: 600, height: 800 }), getAnnotations: undefined } as unknown as PdfPage;
	const withAnnotations = (annotations: unknown[]): PdfPage => ({ ...page, getAnnotations: async () => annotations });
	// pdf.js transform of a 600 x 800 page at scale 1: y is flipped.
	const T = [1, 0, 0, -1, 0, 800];

	it("reads internal links and web links with boxes in the viewport (y down), and skips what is not a link", async () => {
		const links = await readPageLinks(fakeDoc({ named: { toc: ref(2) } }), withAnnotations([
			{ subtype: "Link", rect: [100, 700, 200, 720], dest: ref(5) },
			{ subtype: "Link", rect: [100, 600, 300, 620], dest: "toc" },
			{ subtype: "Link", rect: [10, 10, 110, 30], url: "https://example.org/a" },
			{ subtype: "Link", rect: [10, 40, 110, 60], action: "NextPage" },
			{ subtype: "Link", rect: [10, 70, 110, 90], action: "FirstPage" },
			{ subtype: "Text", rect: [0, 0, 5, 5] },
			{ subtype: "Link", rect: [0, 0, 0, 0], url: "https://zero.example" },
			{ subtype: "Link", rect: [1, 2], url: "https://broken.example" },
			{ subtype: "Link", rect: [20, 20, 40, 40], dest: ref(99) },
			"junk",
		]), 3, T);
		expect(links).toEqual([
			{ x: 100, y: 80, width: 100, height: 20, page: 5 },
			{ x: 100, y: 180, width: 200, height: 20, page: 2 },
			{ x: 10, y: 770, width: 100, height: 20, url: "https://example.org/a" },
			{ x: 10, y: 740, width: 100, height: 20, page: 4 },
			{ x: 10, y: 710, width: 100, height: 20, page: 1 },
		]);
	});

	it("uses the usual flip when the viewport has no transform, and gives nothing without annotations", async () => {
		const links = await readPageLinks(fakeDoc(), withAnnotations([{ subtype: "Link", rect: [0, 780, 50, 800], dest: ref(2) }]), 1);
		expect(links).toEqual([{ x: 0, y: 0, width: 50, height: 20, page: 2 }]);
		expect(await readPageLinks(fakeDoc(), page, 1, T)).toEqual([]);
	});

	it("finds the smallest link under a point, with a tolerance", () => {
		const big = { x: 0, y: 0, width: 200, height: 200, page: 1 };
		const small = { x: 50, y: 50, width: 20, height: 10, url: "https://a.b" };
		expect(linkAt([big, small], { x: 55, y: 55 })).toBe(small);
		expect(linkAt([big, small], { x: 150, y: 150 })).toBe(big);
		expect(linkAt([small], { x: 48, y: 55 })).toBeNull();
		expect(linkAt([small], { x: 48, y: 55 }, 3)).toBe(small);
	});

	it("opens only web and mail addresses", () => {
		expect(safeExternalUrl("https://example.org/a b")).toBe("https://example.org/a%20b");
		expect(safeExternalUrl("HTTP://example.org")).toBe("http://example.org/");
		expect(safeExternalUrl("mailto:me@example.org")).toBe("mailto:me@example.org");
		for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "obsidian://open?vault=x", "data:text/html,hi", "", "example.org", "  ftp://x"]) expect(safeExternalUrl(bad), bad).toBeNull();
	});
});

const asset = (id: string): Asset => ({ id, kind: "pdf", path: `Notebooks/_assets/${id}.pdf`, name: `${id}.pdf`, bytes: 8 });
function pdfPage(assetId: string, n: number): Page {
	const p = createPage();
	p.background = { kind: "pdf", asset: assetId, page: n };
	return p;
}
const outline: PdfOutlineEntry[] = [
	{ title: "Part A", level: 1, page: 1 },
	{ title: "A.1", level: 2, page: 2 },
	{ title: "A.2", level: 2, page: 4 },
	{ title: "Part B", level: 1, page: 6 },
	{ title: "B.1", level: 2, page: 8 },
	{ title: "Unresolved", level: 1, page: 0 },
];

describe("the PDF outline on the pages of a notebook (#46)", () => {
	it("maps every entry to the page that shows its PDF page when the whole PDF is in the notebook", () => {
		const pages = Array.from({ length: 10 }, (_, i) => pdfPage(ASSET, i + 1));
		const mapped = mapPdfOutline(pages, ASSET, outline);
		expect(mapped.map((m) => [m.title, m.index, m.exact])).toEqual([["Part A", 0, true], ["A.1", 1, true], ["A.2", 3, true], ["Part B", 5, true], ["B.1", 7, true]]);
	});

	it("maps by source page when the notebook has a range, moved pages and a page twice", () => {
		// PDF pages 4, 5, 6, 7, 8 only, page 8 first, and page 4 once more at the end.
		const pages = [pdfPage(ASSET, 8), pdfPage(ASSET, 4), pdfPage(ASSET, 5), pdfPage(ASSET, 6), pdfPage(ASSET, 7), pdfPage(ASSET, 4)];
		const by = sourcePageIndex(pages, ASSET);
		expect([...by.entries()].sort()).toEqual([[4, 1], [5, 2], [6, 3], [7, 4], [8, 0]]);
		const mapped = mapPdfOutline(pages, ASSET, outline);
		// Part A (1) and A.1 (2) are before the range: both would land on page 4, which A.2 starts at: left out.
		expect(mapped.map((m) => [m.title, m.index, m.exact])).toEqual([["A.2", 1, true], ["Part B", 3, true], ["B.1", 0, true]]);
	});

	it("sends an entry whose page is missing to the next page that is shown, unless a later entry starts there", () => {
		const pages = [pdfPage(ASSET, 3), pdfPage(ASSET, 4), pdfPage(ASSET, 7)];
		const mapped = mapPdfOutline(pages, ASSET, outline);
		// Part A (1) would take page 3, but A.1 starts at 2: left out. A.1 (2) -> page 3, not exact. Part B (6) -> 7. B.1 (8) has no later page.
		expect(mapped.map((m) => [m.title, m.index, m.exact])).toEqual([["A.1", 0, false], ["A.2", 1, true], ["Part B", 2, false]]);
	});

	it("ignores other PDFs and notebooks without the PDF", () => {
		const pages = [pdfPage(OTHER, 1), createPage()];
		expect(mapPdfOutline(pages, ASSET, outline)).toEqual([]);
		expect(mapPdfOutline([pdfPage(ASSET, 1)], ASSET, [])).toEqual([]);
	});
});

describe("the PDF outline inside the generated outline (#46)", () => {
	const pages = [pdfPage(ASSET, 1), pdfPage(ASSET, 2), pdfPage(ASSET, 4), pdfPage(ASSET, 6)];
	const assets = { [ASSET]: asset(ASSET) };
	const input = { pages, assets, pdfOutlines: { [ASSET]: outline } };
	const none: OutlineSources = { bookmarks: false, slides: false, headings: false, markers: false, pdf: false };

	it("nests the entries under the PDF's document row, before its slides, by their own levels", () => {
		const items = new OutlineBuilder().build(input, { ...DEFAULT_OUTLINE_SOURCES, headings: false });
		// The document row comes first, then Part A (level 1 of the outline), then A.1 under it, then the slides below the entries.
		expect(items[0]!.kind).toBe("document");
		expect(items[1]).toMatchObject({ kind: "pdf", title: "Part A", depth: 2, index: 0, source: "pdf" });
		expect(items.find((i) => i.title === "A.1")).toMatchObject({ kind: "pdf", depth: 3, index: 1 });
		expect(items.find((i) => i.title === "Part B")).toMatchObject({ kind: "pdf", depth: 2, index: 3, pdf: { asset: ASSET, page: 6, exact: true } });
		// The slide of a page comes after the PDF entries that point at that page.
		const idx = (pred: (i: (typeof items)[number]) => boolean) => items.findIndex(pred);
		expect(idx((i) => i.title === "A.1")).toBeLessThan(idx((i) => i.kind === "slide" && i.index === 1));
		expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
	});

	it("leaves the entries out when the source is off or no outline is given, and lists only them in the section", () => {
		const off = new OutlineBuilder().build(input, { ...DEFAULT_OUTLINE_SOURCES, headings: false, pdf: false });
		expect(off.some((i) => i.kind === "pdf")).toBe(false);
		const missing = new OutlineBuilder().build({ pages, assets }, DEFAULT_OUTLINE_SOURCES);
		expect(missing.some((i) => i.kind === "pdf")).toBe(false);
		const only = new OutlineBuilder().buildPdf(input);
		expect(only.every((i) => i.kind === "pdf")).toBe(true);
		expect(only.map((i) => [i.title, i.depth])).toEqual([["Part A", 1], ["A.1", 2], ["A.2", 2], ["Part B", 1]]);
		expect(new OutlineBuilder().build(input, none)).toEqual([]);
	});

	it("keeps the key of an entry when the notebook changes around it", () => {
		const a = new OutlineBuilder().buildPdf(input);
		const b = new OutlineBuilder().buildPdf({ ...input, pages: [createPage(), ...pages] });
		expect(b.map((i) => i.key)).toEqual(a.map((i) => i.key));
		expect(b.map((i) => i.index)).toEqual(a.map((i) => i.index + 1));
	});
});

describe("the cache of PDF outlines (#46)", () => {
	it("keeps a valid, bounded store and drops bad rows", () => {
		const good = { at: 5, entries: [{ title: "A", level: 1, page: 2 }] };
		const data = normaliseOutlineCache({ [ASSET]: good, "bad id!": good, [OTHER]: { at: 1, entries: [{ title: "", level: 1, page: 1 }, { title: "ok", level: 99, page: -3 }, 7] }, nope: 1, short: good });
		expect(Object.keys(data).sort()).toEqual([ASSET, OTHER]);
		expect(data[OTHER]!.entries).toEqual([{ title: "ok", level: 8, page: 0 }]);
		expect(normaliseOutlineCache("x")).toEqual({});
		expect(normaliseOutlineCache(null)).toEqual({});
		let cache = {};
		for (let i = 0; i < MAX_CACHED_PDFS + 5; i++) cache = storeOutline(cache, `id${String(i).padStart(10, "0")}`, [], i);
		expect(Object.keys(cache)).toHaveLength(MAX_CACHED_PDFS);
		expect("id0000000000" in cache).toBe(false);
		expect(storeOutline(cache, "x", [], 1)).toBe(cache);
	});

	function storage(initial: unknown = null) {
		const data: Record<string, unknown> = initial ? { [OUTLINE_CACHE_KEY]: initial } : {};
		return { data, loadLocalStorage: (k: string) => data[k] ?? null, saveLocalStorage: (k: string, v: unknown) => { data[k] = JSON.parse(JSON.stringify(v)); } };
	}
	const tick = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};

	it("reads a PDF once, remembers an empty outline too, and a new session does not read it again", async () => {
		const store = storage();
		let reads = 0;
		let changed = 0;
		const make = () => new PdfOutlineSource({ storage: store, read: async () => { reads++; return reads === 1 ? [{ title: "A", level: 1, page: 2 }] : []; }, changed: () => changed++ });
		const first = make();
		expect(first.get(ASSET)).toBeUndefined();
		expect(first.get(ASSET)).toBeUndefined();
		await tick();
		expect(reads).toBe(1);
		expect(changed).toBe(1);
		expect(first.get(ASSET)).toEqual([{ title: "A", level: 1, page: 2 }]);
		expect(Object.keys(store.data[OUTLINE_CACHE_KEY] as object)).toEqual([ASSET]);
		// A PDF without an outline is a result too.
		first.get(OTHER);
		await tick();
		expect(first.get(OTHER)).toEqual([]);
		const second = make();
		expect(second.known([ASSET, OTHER])).toEqual({ [ASSET]: [{ title: "A", level: 1, page: 2 }], [OTHER]: [] });
		await tick();
		expect(reads).toBe(2);
	});

	it("does not remember a failure, and tries again only after a while", async () => {
		const store = storage();
		let now = 1000;
		let reads = 0;
		const src = new PdfOutlineSource({ storage: store, now: () => now, read: async () => { reads++; throw new Error("unreadable"); }, changed: () => undefined });
		src.get(ASSET);
		await tick();
		src.get(ASSET);
		await tick();
		expect(reads).toBe(1);
		now += RETRY_MS + 1;
		src.get(ASSET);
		await tick();
		expect(reads).toBe(2);
		expect(store.data[OUTLINE_CACHE_KEY]).toBeUndefined();
	});

	it("works when the device storage is broken", async () => {
		const broken = { loadLocalStorage: () => { throw new Error("no"); }, saveLocalStorage: () => { throw new Error("no"); } };
		const src = new PdfOutlineSource({ storage: broken, read: async () => [{ title: "A", level: 1, page: 1 }], changed: () => undefined });
		src.get(ASSET);
		await tick();
		expect(src.get(ASSET)).toEqual([{ title: "A", level: 1, page: 1 }]);
	});
});
