import { beforeEach, describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { DEFAULT_OUTLINE_SOURCES, filterByCategory, OutlineBuilder, type OutlineSources } from "../src/model/outline-builder";
import { detectHeadings, referenceHeight } from "../src/ink/headings";
import { segmentText } from "../src/ink/words";
import { DEFAULT_META, type Asset, type MarkerElement, type NotebookMeta, type Page } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { reseed, writeLine } from "./words-gen";

const none: OutlineSources = { bookmarks: false, slides: false, headings: false, markers: false };
const only = (k: keyof OutlineSources): OutlineSources => ({ ...none, [k]: true });

/** A page with a big title and a few lines of small text under it. */
function titledPage(tag: string, title: string, opts: { x?: number; baseY?: number; H?: number } = {}): Page {
	const page = createPage();
	const baseY = opts.baseY ?? 90;
	page.strokes = [
		...writeLine(`${tag}t`, title, { x: opts.x ?? 50, baseY, H: opts.H ?? 40 }),
		...writeLine(`${tag}a`, "some small text follows here", { x: 50, baseY: baseY + 50, H: 12 }),
		...writeLine(`${tag}b`, "and a second line of it", { x: 50, baseY: baseY + 76, H: 12 }),
		...writeLine(`${tag}c`, "then the third one more", { x: 50, baseY: baseY + 102, H: 12 }),
	];
	return page;
}

function plainPage(tag: string): Page {
	const page = createPage();
	page.strokes = [
		...writeLine(`${tag}a`, "only small text on this page", { x: 50, baseY: 100, H: 12 }),
		...writeLine(`${tag}b`, "and a second line of it", { x: 50, baseY: 126, H: 12 }),
		...writeLine(`${tag}c`, "then the third one more", { x: 50, baseY: 152, H: 12 }),
	];
	return page;
}

const marker = (kind: MarkerElement["kind"], y: number, text?: string): MarkerElement => ({ id: `m${kind}${y}`, type: "marker", kind, x: 20, y, ...(text ? { text } : {}) });

describe("detectHeadings", () => {
	beforeEach(() => reseed(11));

	it("finds a line of large handwriting at the top of a block", () => {
		const page = titledPage("p", "chapter one");
		const h = detectHeadings(segmentText(page.strokes), page);
		expect(h).toHaveLength(1);
		expect(h[0]!.strokeIds.every((id) => id.startsWith("pt"))).toBe(true);
		expect(h[0]!.ratio).toBeGreaterThan(2.4);
		expect(h[0]!.level).toBe(1);
		expect(h[0]!.rect.y).toBeLessThan(90);
		expect(h[0]!.rect.height).toBeGreaterThan(30);
	});

	it("gives a less large heading the second level", () => {
		const page = titledPage("p", "morning moon", { H: 26 });
		const h = detectHeadings(segmentText(page.strokes), page);
		expect(h).toHaveLength(1);
		expect(h[0]!.level).toBe(2);
	});

	it("finds nothing on a page of evenly sized text", () => {
		const page = plainPage("p");
		expect(detectHeadings(segmentText(page.strokes), page)).toEqual([]);
	});

	it("ignores text only a little larger than usual", () => {
		const page = titledPage("p", "common error", { H: 13 });
		expect(detectHeadings(segmentText(page.strokes), page)).toEqual([]);
	});

	it("ignores a large line that sits right under another line (not the start of a block)", () => {
		const page = createPage();
		page.strokes = [
			...writeLine("a", "first small line of text", { x: 50, baseY: 100, H: 12 }),
			...writeLine("b", "second small line", { x: 50, baseY: 118, H: 12 }),
			...writeLine("c", "third small line", { x: 50, baseY: 136, H: 12 }),
			...writeLine("t", "big", { x: 50, baseY: 162, H: 36 }),
		];
		expect(detectHeadings(segmentText(page.strokes), page)).toEqual([]);
	});

	it("finds a large line that follows a blank line", () => {
		const page = createPage();
		page.strokes = [
			...writeLine("a", "first small line of text", { x: 50, baseY: 100, H: 12 }),
			...writeLine("b", "second small line", { x: 50, baseY: 118, H: 12 }),
			...writeLine("c", "third small line", { x: 50, baseY: 136, H: 12 }),
			...writeLine("t", "next area", { x: 50, baseY: 215, H: 36 }),
		];
		expect(detectHeadings(segmentText(page.strokes), page)).toHaveLength(1);
	});

	it("ignores a large line far to the right of the text (not near the left of the block)", () => {
		const page = titledPage("p", "title", { x: 330 });
		expect(detectHeadings(segmentText(page.strokes), page)).toEqual([]);
	});

	it("ignores a single large stroke (a drawing)", () => {
		const page = plainPage("p");
		const s = writeLine("d", "o", { x: 50, baseY: 300, H: 60 });
		expect(s).toHaveLength(1);
		page.strokes = [...s, ...page.strokes];
		expect(detectHeadings(segmentText(page.strokes), page)).toEqual([]);
	});

	it("uses the notebook's usual size on a page with only a title line", () => {
		const page = createPage();
		page.strokes = writeLine("t", "part two", { x: 60, baseY: 200, H: 40 });
		const layout = segmentText(page.strokes);
		expect(detectHeadings(layout, page)).toEqual([]);
		expect(detectHeadings(layout, page, 12)).toHaveLength(1);
	});

	it("takes the weighted median as the reference", () => {
		expect(referenceHeight([{ height: 40, weight: 8 }, { height: 12, weight: 60 }])).toBe(12);
		expect(referenceHeight([])).toBe(0);
	});
});

describe("OutlineBuilder", () => {
	beforeEach(() => reseed(11));

	it("lists the bookmarks in page order with their title, colour and category", () => {
		const pages = [plainPage("a"), plainPage("b"), plainPage("c")];
		const meta: NotebookMeta = { ...DEFAULT_META, bookmarks: [pages[2]!.id, pages[0]!.id], bookmarkInfo: { [pages[0]!.id]: { title: "Intro", category: "important" }, [pages[2]!.id]: { color: "#22c55e" } } };
		const out = new OutlineBuilder().build({ pages, meta }, only("bookmarks"));
		expect(out.map((i) => [i.index, i.title, i.color, i.category])).toEqual([[0, "Intro", "#ef4444", "important"], [2, "", "#22c55e", null]]);
		expect(out.every((i) => i.kind === "bookmark" && i.depth === 1)).toBe(true);
	});

	it("merges bookmarks, headings, slides and markers by page and position, nested by level", () => {
		const slideA = titledPage("s1", "limits");
		slideA.background = { kind: "pdf", asset: "pdfA", page: 1 };
		slideA.elements = [marker("question", 300, "why?"), marker("gap", 320), marker("star", 200)];
		const slideB = plainPage("s2");
		slideB.background = { kind: "pdf", asset: "pdfA", page: 2 };
		const notes = titledPage("n", "summary", { H: 26 });
		const pages = [slideA, slideB, notes];
		const assets: Record<string, Asset> = { pdfA: { id: "pdfA", kind: "pdf", path: "x.pdf", name: "Lecture 1.pdf", bytes: 1 } };
		const meta: NotebookMeta = { ...DEFAULT_META, bookmarks: [slideB.id], bookmarkInfo: { [slideB.id]: { title: "Key slide" } } };
		const out = new OutlineBuilder().build({ pages, meta, assets });
		expect(out.map((i) => `${i.index}:${i.kind}:${i.depth}`)).toEqual([
			"0:document:1",
			"0:slide:2",
			"0:heading:3",
			"0:marker:4", // star at y 200: the heading (y ~ 50) comes first
			"0:marker:4", // question at y 300
			"1:bookmark:1",
			"1:slide:2",
			"2:heading:3",
		]);
		expect(out[0]!.title).toBe("Lecture 1.pdf");
		expect(out[1]!.slide).toEqual({ asset: "pdfA", page: 1 });
		expect(out[3]!.marker?.kind).toBe("star");
		expect(out[4]!.title).toBe("why?");
		expect(out[2]!.heading?.level).toBe(1);
		expect(out[7]!.heading?.level).toBe(2);
	});

	it("marks a slide change only where the PDF page or file changes", () => {
		const mk = (asset: string, page: number): Page => {
			const p = createPage();
			p.background = { kind: "pdf", asset, page };
			return p;
		};
		const blank = createPage();
		const pages = [mk("a", 1), mk("a", 1), blank, mk("a", 2), mk("b", 1)];
		const out = new OutlineBuilder().build({ pages }, only("slides"));
		expect(out.map((i) => `${i.index}:${i.kind}:${i.slide?.asset}${i.slide?.page}`)).toEqual([
			"0:document:a1", "0:slide:a1", "3:slide:a2", "4:document:b1", "4:slide:b1",
		]);
	});

	it("leaves out a source that is switched off", () => {
		const page = titledPage("p", "title");
		page.background = { kind: "pdf", asset: "x", page: 1 };
		page.elements = [marker("homework", 400, "ex 3")];
		const pages = [page];
		const meta: NotebookMeta = { ...DEFAULT_META, bookmarks: [page.id] };
		const b = new OutlineBuilder();
		const kinds = (s: OutlineSources) => [...new Set(b.build({ pages, meta }, s).map((i) => i.kind))].sort();
		expect(kinds(DEFAULT_OUTLINE_SOURCES)).toEqual(["bookmark", "document", "heading", "marker", "slide"]);
		expect(kinds({ ...DEFAULT_OUTLINE_SOURCES, headings: false })).toEqual(["bookmark", "document", "marker", "slide"]);
		expect(kinds({ ...DEFAULT_OUTLINE_SOURCES, slides: false, markers: false })).toEqual(["bookmark", "heading"]);
		expect(kinds(none)).toEqual([]);
	});

	it("does not list gap markers", () => {
		const page = plainPage("p");
		page.elements = [marker("gap", 100), marker("gap", 200, "fill")];
		expect(new OutlineBuilder().build({ pages: [page] }, only("markers"))).toEqual([]);
	});

	it("nests two heading sizes: the small one is a child of the large one, and the next large one closes it", () => {
		const a = titledPage("a", "noon moon", { H: 40 });
		const b = titledPage("b", "sun rose", { H: 26 });
		const c = titledPage("c", "own area", { H: 40 });
		const out = new OutlineBuilder().build({ pages: [a, b, c] }, only("headings"));
		expect(out.map((i) => `${i.index}:${i.depth}`)).toEqual(["0:1", "1:2", "2:1"]);
	});

	it("caches the text layout per page: an unchanged page is not analysed again", () => {
		const pages = [titledPage("a", "one"), plainPage("b"), plainPage("c")];
		const b = new OutlineBuilder();
		b.build({ pages }, only("headings"));
		expect(b.lastComputed).toBe(3);
		b.build({ pages }, only("headings"));
		expect(b.lastComputed).toBe(0);
		// A new stroke on one page (its strokes change, the others keep theirs).
		pages[1]!.strokes = [...pages[1]!.strokes, ...writeLine("z", "new", { x: 50, baseY: 300, H: 12 })];
		b.build({ pages }, only("headings"));
		expect(b.lastComputed).toBe(1);
	});

	it("forgets pages that are gone and survives an empty notebook", () => {
		const pages = [titledPage("a", "one"), plainPage("b")];
		const b = new OutlineBuilder();
		b.build({ pages }, only("headings"));
		expect(b.build({ pages: [] })).toEqual([]);
		expect(b.build({ pages: [pages[1]!] }, only("headings"))).toEqual([]);
		expect(b.lastComputed).toBe(1);
		b.build({ pages: [pages[1]!] }, only("headings"));
		expect(b.lastComputed).toBe(0);
	});

	it("reads only visible ink", () => {
		const page = titledPage("p", "hidden title");
		for (const s of page.strokes) if (s.id.startsWith("pt")) s.hidden = true;
		expect(new OutlineBuilder().build({ pages: [page] }, only("headings"))).toEqual([]);
	});

	it("gives stable keys", () => {
		const pages = [titledPage("a", "one")];
		const b = new OutlineBuilder();
		const keys = (): string[] => b.build({ pages }).map((i) => i.key);
		expect(keys()).toEqual(keys());
		expect(new Set(keys()).size).toBe(keys().length);
	});

	it("filters by bookmark category as a flat list", () => {
		const pages = [plainPage("a"), plainPage("b")];
		const meta: NotebookMeta = { ...DEFAULT_META, bookmarks: pages.map((p) => p.id), bookmarkInfo: { [pages[1]!.id]: { category: "review" } } };
		const out = new OutlineBuilder().build({ pages, meta });
		expect(filterByCategory(out, "review").map((i) => i.index)).toEqual([1]);
		expect(filterByCategory(out, null)).toHaveLength(out.length);
	});
});

describe("outline settings", () => {
	it("lists every source by default and reads each switch on its own", () => {
		expect(DEFAULT_SETTINGS.outlineBookmarks && DEFAULT_SETTINGS.outlineSlides && DEFAULT_SETTINGS.outlineHeadings && DEFAULT_SETTINGS.outlineMarkers).toBe(true);
		const s = readSettings({ outlineHeadings: false, outlineSlides: "no", outlineMarkers: false });
		expect([s.outlineBookmarks, s.outlineSlides, s.outlineHeadings, s.outlineMarkers]).toEqual([true, true, false, false]);
	});
});
