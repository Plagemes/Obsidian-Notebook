import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import type { Page } from "../src/model/types";
import { bandPoints, bandWidth, snapHighlight } from "../src/pdf/text-snap";
import { PageTextCache, runSearch, type PdfTextSource, type SearchHit } from "../src/pdf/text-index";
import type { PageTextContent, TextBox } from "../src/pdf/text-items";
import { assemblePageText, findInPage, hitBoxes, mergeLineBoxes, normalizeQuery, normalizeText, snippetOf } from "../src/pdf/text-search";
import { backgroundAlpha, hasBackgrounds, hasPdfPages, insertHits, revealViewport, searchTargets, stepIndex } from "../src/view/reading-logic";
import { DEFAULT_DIM, DIM_MAX, DIM_MIN, normaliseDim, readReadingSettings } from "../src/view/reading-settings";
import { readSettings } from "../src/settings";

/** A run: 10 pt high, 5 pt per character, left at x, top at y. */
function run(str: string, x: number, y: number, h = 10): TextBox {
	return { str, x, y, width: str.length * (h / 2), height: h };
}

function content(items: TextBox[]): PageTextContent {
	return { width: 600, height: 800, items };
}

describe("normalizeText / normalizeQuery", () => {
	it("ignores case, accents, ligatures and the amount of white space", () => {
		expect(normalizeText("Caffè  LATTE\n\tﬁne").norm).toBe("caffe latte fine");
		expect(normalizeText("co­op​era").norm).toBe("coopera");
		expect(normalizeText("a b").norm).toBe("a b");
	});

	it("keeps the offset of every character in the original", () => {
		const n = normalizeText("A  b");
		expect(n.norm).toBe("a b");
		expect([...n.origin]).toEqual([0, 1, 3]);
		const lig = normalizeText("xﬁy");
		expect(lig.norm).toBe("xfiy");
		expect([...lig.origin]).toEqual([0, 1, 1, 2]);
	});

	it("rejects queries shorter than two characters", () => {
		expect(normalizeQuery("a")).toBe("");
		expect(normalizeQuery("  a ")).toBe("");
		expect(normalizeQuery("  Ab ")).toBe("ab");
	});
});

describe("assemblePageText", () => {
	it("joins touching runs, separates gaps and lines with one space", () => {
		const page = assemblePageText([run("Hel", 0, 0), run("lo", 15, 0), run("world", 40, 0), run("next line", 0, 20)]);
		expect(page.text).toBe("Hello world next line");
		expect(page.spans.map((s) => page.text.slice(s.start, s.end))).toEqual(["Hel", "lo", "world", "next line"]);
	});

	it("does not double a space the runs already carry", () => {
		const page = assemblePageText([run("a ", 0, 0), run("b", 10, 0), run(" ", 15, 0), run("c", 20, 0)]);
		expect(page.text).toBe("a b c");
	});
});

describe("findInPage", () => {
	const page = assemblePageText([run("The Quick brown fox", 0, 0), run("jumps over the quick dog", 0, 20)]);

	it("finds every match ignoring case, as offsets into the original text", () => {
		const hits = findInPage(page, normalizeQuery("QUICK"));
		expect(hits).toHaveLength(2);
		expect(hits.map((h) => page.text.slice(h.start, h.end))).toEqual(["Quick", "quick"]);
	});

	it("finds a phrase across two runs and across a line break", () => {
		expect(findInPage(page, normalizeQuery("fox jumps"))).toHaveLength(1);
		const h = findInPage(page, normalizeQuery("brown  fox"))[0]!;
		expect(page.text.slice(h.start, h.end)).toBe("brown fox");
	});

	it("matches accents and ligatures with plain letters and maps the end back", () => {
		const p = assemblePageText([run("un caffè ﬁne", 0, 0)]);
		const [a, b] = [findInPage(p, normalizeQuery("caffe"))[0]!, findInPage(p, normalizeQuery("fine"))[0]!];
		expect(p.text.slice(a.start, a.end)).toBe("caffè");
		expect(p.text.slice(b.start, b.end)).toBe("ﬁne");
	});

	it("respects the limit, does not overlap and finds nothing for an empty query", () => {
		const p = assemblePageText([run("aaaa aaaa", 0, 0)]);
		expect(findInPage(p, "aa")).toHaveLength(4);
		expect(findInPage(p, "aa", 3)).toHaveLength(3);
		expect(findInPage(p, "")).toEqual([]);
	});
});

describe("snippetOf", () => {
	it("returns the text around a match without cutting words", () => {
		const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
		const at = text.indexOf("epsilon");
		const s = snippetOf(text, { start: at, end: at + 7 }, 14);
		expect(s.match).toBe("epsilon");
		expect(s.cutBefore && s.cutAfter).toBe(true);
		expect(s.before.startsWith(" ")).toBe(false);
		expect(`${s.before}${s.match}${s.after}`).toBe("gamma delta epsilon zeta eta");
	});

	it("marks nothing as cut when the text is short", () => {
		const s = snippetOf("hello world", { start: 0, end: 5 });
		expect(s).toEqual({ before: "", match: "hello", after: " world", cutBefore: false, cutAfter: false });
	});
});

describe("hitBoxes", () => {
	it("returns the part of a run that a match covers", () => {
		const items = [run("0123456789", 100, 50)];
		const c = content(items);
		const page = assemblePageText(items);
		const [box] = hitBoxes(c, page, { start: 2, end: 5 });
		expect(box).toMatchObject({ x: 110, y: 50, width: 15, height: 10 });
	});

	it("merges the boxes of a match that spans runs of one line, but not of two lines", () => {
		const items = [run("foo", 0, 0), run("bar", 20, 0), run("baz", 0, 20)];
		const c = content(items);
		const page = assemblePageText(items);
		const boxes = hitBoxes(c, page, { start: 0, end: page.text.length });
		expect(boxes).toHaveLength(2);
		expect(boxes[0]).toMatchObject({ x: 0, width: 35 });
		expect(boxes[1]).toMatchObject({ y: 20 });
	});

	it("keeps far apart boxes of one line separate", () => {
		expect(mergeLineBoxes([run("a", 0, 0), run("b", 100, 0)])).toHaveLength(2);
	});
});

describe("snapHighlight", () => {
	// Two lines of three words, 10 pt high, 5 pt per char: words are 15 pt wide, separated by a 5 pt space.
	const line1 = run("one two six", 100, 100);
	const line2 = run("ten bis xyz", 100, 120);
	const boxes = [line1, line2];
	const stroke = (...pts: Array<[number, number]>) => pts.map(([x, y]) => [x, y, 0.5] as const);

	it("covers whole words on the line the stroke runs along", () => {
		// From inside "one" to inside "two" at the middle of line 1.
		const bands = snapHighlight(stroke([105, 105], [130, 105]), boxes);
		expect(bands).toHaveLength(1);
		expect(bands[0]!.x0).toBeCloseTo(100, 5);
		expect(bands[0]!.x1).toBeCloseTo(135, 5);
		// 1.1 heights, from just below the top of the run.
		expect(bandWidth(bands[0]!)).toBeCloseTo(11, 5);
		expect(bands[0]!.y0).toBeCloseTo(101.2, 5);
	});

	it("includes a word only when at least 40% of it is covered", () => {
		// Covers the first 4 pt of "two" (27%): not included; all of "one": included.
		const bands = snapHighlight(stroke([101, 105], [124, 105]), boxes);
		expect(bands).toHaveLength(1);
		expect(bands[0]!.x1).toBeCloseTo(115, 5);
		// Covers 8 of 15 pt (53%): included.
		const more = snapHighlight(stroke([101, 105], [128, 105]), boxes);
		expect(more[0]!.x1).toBeCloseTo(135, 5);
	});

	it("makes one band per line when the stroke crosses two lines", () => {
		const bands = snapHighlight(stroke([102, 104], [180, 104], [102, 124], [180, 124]), boxes);
		expect(bands).toHaveLength(2);
		expect(bands[0]!.y0).toBeLessThan(bands[1]!.y0);
		for (const b of bands) {
			expect(b.x0).toBeCloseTo(100, 5);
			expect(b.x1).toBeCloseTo(155, 5);
		}
	});

	it("takes the nearest line when the stroke ran in the gap between two lines", () => {
		// y = 111 is below line 1 (100-110) and above line 2 (120-130), within the loose tolerance of both; line 1 is nearer.
		const bands = snapHighlight(stroke([102, 111], [150, 111]), boxes);
		expect(bands).toHaveLength(1);
		expect(bands[0]!.y0).toBeCloseTo(101.2, 5);
	});

	it("gives nothing when the stroke is not near any text", () => {
		expect(snapHighlight(stroke([102, 300], [150, 300]), boxes)).toEqual([]);
		expect(snapHighlight(stroke([400, 105], [450, 105]), boxes)).toEqual([]);
		expect(snapHighlight([], boxes)).toEqual([]);
		expect(snapHighlight(stroke([102, 105], [150, 105]), [])).toEqual([]);
	});

	it("keeps separate pieces of a line apart when a column gap lies between them", () => {
		const cols = [run("left col", 100, 100), run("right col", 300, 100)];
		const bands = snapHighlight(stroke([102, 105], [400, 105]), cols);
		expect(bands).toHaveLength(2);
		expect(bands[0]!.x1).toBeLessThan(bands[1]!.x0);
	});

	it("highlights a word that a tap touches, and ignores blank and vertical runs", () => {
		const bands = snapHighlight(stroke([132, 105]), boxes);
		expect(bands).toHaveLength(1);
		expect(bands[0]!.x0).toBeCloseTo(120, 5);
		expect(bands[0]!.x1).toBeCloseTo(135, 5);
		const vertical: TextBox = { str: "rotated", x: 50, y: 100, width: 10, height: 80 };
		expect(snapHighlight(stroke([55, 120]), [vertical, run("   ", 0, 100)])).toEqual([]);
	});

	it("turns a band into a horizontal highlighter stroke of the band's height", () => {
		const band = { x0: 100, x1: 160, y0: 101, y1: 112 };
		const pts = bandPoints(band);
		expect(pts.length).toBeGreaterThanOrEqual(2);
		for (const p of pts) expect(p[1]).toBeCloseTo(106.5, 5);
		// Round ends reach about the band's ends: the end points are inset by a fraction of the radius.
		expect(pts[0]![0]).toBeCloseTo(100 + 5.5 * 0.45, 5);
		expect(pts[pts.length - 1]![0]).toBeCloseTo(160 - 5.5 * 0.45, 5);
		// A band narrower than its caps still gives two distinct points.
		const tiny = bandPoints({ x0: 100, x1: 101, y0: 0, y1: 11 });
		expect(tiny).toHaveLength(2);
		expect(tiny[1]![0]).toBeGreaterThan(tiny[0]![0]);
	});
});

describe("PageTextCache and runSearch", () => {
	function source(pages: Record<string, TextBox[]>, log: string[] = [], broken = new Set<string>()): PdfTextSource {
		return {
			async pageText(asset, page) {
				log.push(`${asset}|${page}`);
				await Promise.resolve();
				if (broken.has(asset)) throw new Error("unreadable");
				return content(pages[`${asset}|${page}`] ?? []);
			},
		};
	}

	const noYield = { now: () => 0, yieldToUi: async () => undefined };

	it("fetches a page once, even for concurrent requests, and forgets a PDF on clear", async () => {
		const log: string[] = [];
		const cache = new PageTextCache(source({ "a|1": [run("hello", 0, 0)] }, log));
		const [x, y] = await Promise.all([cache.get("a", 1), cache.get("a", 1)]);
		expect(x).toBe(y);
		expect(log).toEqual(["a|1"]);
		expect(cache.peek("a", 1)?.text.text).toBe("hello");
		cache.clear("a");
		expect(cache.peek("a", 1)).toBeNull();
	});

	it("does not cache a page that cannot be read", async () => {
		const cache = new PageTextCache(source({}, [], new Set(["bad"])));
		expect(await cache.get("bad", 1)).toBeNull();
		expect(cache.size).toBe(0);
	});

	it("evicts the oldest pages beyond its limit", async () => {
		const cache = new PageTextCache(source({}), 2);
		for (const p of [1, 2, 3]) await cache.get("a", p);
		expect(cache.peek("a", 1)).toBeNull();
		expect(cache.peek("a", 3)).not.toBeNull();
	});

	const targets = [1, 2, 3, 4, 5].map((n) => ({ pageId: `p${n}`, asset: "a", pdfPage: n }));
	const pages = {
		"a|1": [run("nothing here", 0, 0)],
		"a|2": [run("find me and find me again", 0, 0)],
		"a|3": [run("nothing", 0, 0)],
		"a|5": [run("FIND", 0, 0)],
	};

	it("streams hits in the order the pages were searched, with snippets, and reports progress", async () => {
		const cache = new PageTextCache(source(pages));
		const batches: SearchHit[][] = [];
		const progress: number[] = [];
		const result = await runSearch({ query: "find", targets, cache, batch: 2, ...noYield }, {
			onHits: (h) => batches.push(h),
			onProgress: (done) => progress.push(done),
		}, { cancelled: false });
		expect(result).toEqual({ truncated: false, cancelled: false, unreadable: 0 });
		const all = batches.flat();
		expect(all.map((h) => h.target.pageId)).toEqual(["p2", "p2", "p5"]);
		expect(all[0]!.snippet.match).toBe("find");
		expect(progress[progress.length - 1]).toBe(5);
	});

	it("stops at the limit and says so", async () => {
		const cache = new PageTextCache(source(pages));
		const got: SearchHit[] = [];
		const result = await runSearch({ query: "find", targets, cache, limit: 2, ...noYield }, { onHits: (h) => got.push(...h) }, { cancelled: false });
		expect(result.truncated).toBe(true);
		expect(got).toHaveLength(2);
	});

	it("stops when cancelled", async () => {
		const cache = new PageTextCache(source(pages));
		const signal = { cancelled: false };
		const got: SearchHit[] = [];
		const result = await runSearch({ query: "find", targets, cache, batch: 1, ...noYield }, {
			onHits: (h) => {
				got.push(...h);
				signal.cancelled = true;
			},
		}, signal);
		expect(result.cancelled).toBe(true);
		expect(got).toHaveLength(2); // the page that was being matched, none after
	});

	it("gives the event loop back when its time budget is used, and not before", async () => {
		let clock = 0;
		let yields = 0;
		const cache = new PageTextCache(source({}));
		await runSearch({
			query: "find", targets, cache, batch: 1, budgetMs: 8,
			now: () => (clock += 5),
			yieldToUi: async () => {
				yields++;
			},
		}, { onHits: () => undefined }, { cancelled: false });
		expect(yields).toBeGreaterThanOrEqual(2);
		yields = 0;
		await runSearch({ query: "find", targets, cache, batch: 1, budgetMs: 8, now: () => 0, yieldToUi: async () => void yields++ }, { onHits: () => undefined }, { cancelled: false });
		expect(yields).toBe(0);
	});

	it("skips the rest of a PDF that cannot be read and counts it once", async () => {
		const log: string[] = [];
		const cache = new PageTextCache(source(pages, log, new Set(["a"])));
		const result = await runSearch({ query: "find", targets, cache, batch: 1, ...noYield }, { onHits: () => undefined }, { cancelled: false });
		expect(result.unreadable).toBe(1);
		expect(log).toEqual(["a|1"]);
	});

	it("searches a PDF page shown on two notebook pages once and reports both", async () => {
		const log: string[] = [];
		const cache = new PageTextCache(source(pages, log));
		const two = [{ pageId: "x", asset: "a", pdfPage: 5 }, { pageId: "y", asset: "a", pdfPage: 5 }];
		const got: SearchHit[] = [];
		await runSearch({ query: "find", targets: two, cache, ...noYield }, { onHits: (h) => got.push(...h) }, { cancelled: false });
		expect(got.map((h) => h.target.pageId)).toEqual(["x", "y"]);
		expect(log).toEqual(["a|5"]);
	});
});

describe("reading logic", () => {
	const pdf = (id: string, page: number): Page => ({ ...createPage(), id, background: { kind: "pdf", asset: "a", page } });
	const blank = (id: string): Page => ({ ...createPage(), id });
	const image = (id: string): Page => ({ ...createPage(), id, background: { kind: "image", asset: "i" } });

	it("lists the PDF pages starting at the page in view and wrapping round", () => {
		const pages = [pdf("p1", 1), blank("b"), pdf("p2", 2), image("i"), pdf("p3", 3)];
		expect(searchTargets(pages, 0).map((t) => t.pageId)).toEqual(["p1", "p2", "p3"]);
		expect(searchTargets(pages, 3).map((t) => t.pageId)).toEqual(["p3", "p1", "p2"]);
		expect(searchTargets([], 0)).toEqual([]);
		expect(searchTargets(pages, 99)[0]?.pageId).toBe("p3");
		expect(hasPdfPages([blank("b"), image("i")])).toBe(false);
		expect(hasBackgrounds([blank("b"), image("i")])).toBe(true);
		expect(hasBackgrounds([blank("b")])).toBe(false);
	});

	it("steps through results and wraps", () => {
		expect(stepIndex(0, -1, 1)).toBe(-1);
		expect(stepIndex(3, -1, 1)).toBe(0);
		expect(stepIndex(3, -1, -1)).toBe(2);
		expect(stepIndex(3, 2, 1)).toBe(0);
		expect(stepIndex(3, 0, -1)).toBe(2);
	});

	it("keeps hits in notebook order when pages are searched in another order", () => {
		const snippet = { before: "", match: "", after: "", cutBefore: false, cutAfter: false };
		const hit = (pageId: string, start: number): SearchHit => ({ target: { pageId, asset: "a", pdfPage: 1 }, start, end: start + 1, snippet });
		const order = new Map([["p1", 0], ["p2", 1], ["p3", 2]]);
		const list: SearchHit[] = [];
		insertHits(list, [hit("p3", 5), hit("p3", 1)], order);
		insertHits(list, [hit("p1", 9)], order);
		insertHits(list, [hit("gone", 0)], order);
		expect(list.map((h) => `${h.target.pageId}:${h.start}`)).toEqual(["p1:9", "p3:1", "p3:5", "gone:0"]);
	});

	it("leaves the view alone when the hit is visible and centres it otherwise", () => {
		const v = { scale: 2, offsetX: 0, offsetY: 0 };
		const view = { width: 400, height: 600 };
		expect(revealViewport(v, view, { x: 50, y: 100, width: 40, height: 10 })).toBe(v);
		const moved = revealViewport(v, view, { x: 50, y: 1000, width: 40, height: 10 });
		expect(moved.scale).toBe(2);
		expect(2 * 1005 + moved.offsetY).toBeCloseTo(300, 5);
		// With something covering the top 100 px the hit is centred in the rest.
		const inset = revealViewport(v, view, { x: 50, y: 1000, width: 40, height: 10 }, 100);
		expect(2 * 1005 + inset.offsetY).toBeCloseTo((124 + 576) / 2, 5);
		// A hit hidden under the covered strip is moved even though it is on screen.
		expect(revealViewport(v, view, { x: 50, y: 10, width: 40, height: 10 }, 100)).not.toBe(v);
		const sideways = revealViewport(v, view, { x: 600, y: 100, width: 40, height: 10 });
		expect(2 * 620 + sideways.offsetX).toBeCloseTo(200, 5);
	});
});

describe("reading settings", () => {
	it("defaults to everything off and a mid strength", () => {
		expect(readReadingSettings({})).toEqual({ snapHighlighter: false, dimBackground: false, dimStrength: DEFAULT_DIM });
		expect(readSettings(undefined)).toMatchObject({ snapHighlighter: false, dimBackground: false, dimStrength: DEFAULT_DIM });
	});

	it("reads valid values, clamps the strength and ignores the wrong types", () => {
		expect(readReadingSettings({ snapHighlighter: true, dimBackground: true, dimStrength: 0.6 })).toEqual({ snapHighlighter: true, dimBackground: true, dimStrength: 0.6 });
		expect(readReadingSettings({ snapHighlighter: "yes", dimBackground: 1, dimStrength: "x" })).toEqual({ snapHighlighter: false, dimBackground: false, dimStrength: DEFAULT_DIM });
		expect(normaliseDim(5)).toBeCloseTo(DIM_MAX, 10);
		expect(normaliseDim(-1)).toBeCloseTo(DIM_MIN, 10);
		expect(normaliseDim(0.47)).toBeCloseTo(0.45, 10);
		expect(readSettings({ dimBackground: true, dimStrength: 0.3 })).toMatchObject({ dimBackground: true, dimStrength: 0.3 });
	});

	it("dims by mixing white in: the background opacity is 1 minus the strength", () => {
		expect(backgroundAlpha(false, 0.5)).toBe(1);
		expect(backgroundAlpha(true, 0.25)).toBe(0.75);
		expect(backgroundAlpha(true, 5)).toBeCloseTo(0.1, 10);
		expect(backgroundAlpha(true, -1)).toBe(1);
	});
});
