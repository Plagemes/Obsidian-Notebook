import { describe, expect, it } from "vitest";
import { buildSemanticSources, LABEL_TEXT_MAX, shortName } from "../src/model/semantic-sources";
import { OutlineBuilder, type OutlineItem } from "../src/model/outline-builder";
import type { Asset, Page, PageElement, Stroke } from "../src/model/types";

function page(id: string, elements: PageElement[] = [], strokes: Stroke[] = []): Page {
	return { id, width: 595, height: 842, paper: { kind: "blank", spacing: 28 }, strokes, elements };
}

function item(over: Partial<OutlineItem> & Pick<OutlineItem, "kind" | "pageId" | "index">): OutlineItem {
	return { key: `k:${over.kind}:${over.pageId}`, source: "bookmarks", y: 0, depth: 1, title: "", color: null, category: null, ...over };
}

const asset = (id: string, name: string): Asset => ({ id, kind: "image", path: `x/${id}.png`, name, bytes: 10 });

describe("semantic zoom sources", () => {
	const pages = [page("p0"), page("p1"), page("p2")];

	it("makes a picture label of a heading, with its ink and proportions", () => {
		const h = item({ kind: "heading", source: "headings", pageId: "p1", index: 1, y: 100, heading: { rect: { x: 20, y: 100, width: 200, height: 40 }, strokeIds: ["a", "b"], ratio: 2.5, level: 1 } });
		const [s] = buildSemanticSources({ pages, outline: [h] });
		expect(s).toMatchObject({ kind: "heading", level: 1, pageIndex: 1, x: 20, y: 100, width: 200, height: 40, aspect: 5, ink: ["a", "b"] });
		expect(s!.text).toBeUndefined();
	});

	it("keeps the level of a second-level heading", () => {
		const h = item({ kind: "heading", source: "headings", pageId: "p0", index: 0, heading: { rect: { x: 0, y: 0, width: 80, height: 20 }, strokeIds: ["a"], ratio: 1.8, level: 2 } });
		expect(buildSemanticSources({ pages, outline: [h] })[0]!.level).toBe(2);
	});

	it("labels titled bookmarks, PDF names and PDF sections with text, stacked down the page", () => {
		const out = buildSemanticSources({
			pages,
			outline: [
				item({ kind: "bookmark", pageId: "p0", index: 0, title: "Chapter 1" }),
				item({ kind: "document", source: "slides", pageId: "p0", index: 0, title: "lecture_notes.pdf" }),
				item({ kind: "pdf", source: "pdf", pageId: "p0", index: 0, title: "Introduction", depth: 2 }),
				item({ kind: "pdf", source: "pdf", pageId: "p0", index: 0, title: "Too deep", depth: 3 }),
				item({ kind: "bookmark", pageId: "p1", index: 1, title: "" }),
			],
		});
		expect(out.map((s) => s.text)).toEqual(["Chapter 1", "lecture notes", "Introduction"]);
		expect(out.map((s) => s.kind)).toEqual(["bookmark", "document", "section"]);
		expect(out.map((s) => s.level)).toEqual([1, 1, 2]);
		expect(new Set(out.map((s) => s.y)).size).toBe(3);
	});

	it("ignores outline rows that do not belong to a page of the document, slides and markers", () => {
		const out = buildSemanticSources({
			pages,
			outline: [
				item({ kind: "bookmark", pageId: "gone", index: 1, title: "Stale" }),
				item({ kind: "slide", source: "slides", pageId: "p0", index: 0, title: "" }),
				item({ kind: "marker", source: "markers", pageId: "p0", index: 0, title: "Why?" }),
				item({ kind: "bookmark", pageId: "nowhere", index: 9, title: "Beyond" }),
			],
		});
		expect(out).toEqual([]);
	});

	it("labels large excerpts by their source notebook and large pictures by their file, and skips small ones", () => {
		const big = { x: 40, y: 50, width: 300, height: 200 };
		const els: PageElement[] = [
			{ id: "e1", type: "excerpt", ...big, source: { notebook: "Notebooks/Biology/Cells.notebook", doc: "d", page: "q", x: 0, y: 0, width: 10, height: 10 } },
			{ id: "e2", type: "excerpt", x: 0, y: 0, width: 40, height: 40, source: { notebook: "A.notebook", doc: "d", page: "q", x: 0, y: 0, width: 10, height: 10 } },
			{ id: "i1", type: "image", asset: "a1", ...big, x: 40, y: 400, rotation: 0 },
			{ id: "i2", type: "image", asset: "a2", x: 0, y: 0, width: 300, height: 4, rotation: 0 },
			{ id: "i3", type: "image", asset: "missing", ...big, rotation: 0 },
		];
		const out = buildSemanticSources({ pages: [page("p0", els)], outline: [], assets: { a1: asset("a1", "krebs_cycle.png"), a2: asset("a2", "line.png") } });
		expect(out.map((s) => [s.kind, s.text, s.level])).toEqual([["excerpt", "Cells", 3], ["image", "krebs cycle", 3]]);
		expect(out[0]).toMatchObject({ pageIndex: 0, x: 40, y: 50 });
	});

	it("shortens names", () => {
		expect(shortName("folder/sub/My_File.final.pdf")).toBe("My File.final");
		expect(shortName("x".repeat(100) + ".png").length).toBe(LABEL_TEXT_MAX);
		expect(shortName("noext")).toBe("noext");
	});

	it("builds the sources of a real outline, without touching the pages", () => {
		const doc = [page("p0"), page("p1")];
		const before = JSON.stringify(doc);
		const outline = new OutlineBuilder().build({ pages: doc, meta: { bookmarks: ["p1"], bookmarkInfo: { p1: { title: "Exam topics" } } } as never }, { bookmarks: true, slides: true, headings: true, markers: false, pdf: false });
		const out = buildSemanticSources({ pages: doc, outline });
		expect(out.map((s) => s.text)).toEqual(["Exam topics"]);
		expect(JSON.stringify(doc)).toBe(before);
	});
});
