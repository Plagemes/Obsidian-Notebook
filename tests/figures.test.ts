import { describe, expect, it } from "vitest";
import { createId, createPage } from "../src/model/document";
import {
	collectFigures, figureCounts, filterFigures, hasSections, pageCount, JobQueue, LruCache, scopePages, thumbPixelWidth,
	THUMB_CSS_WIDTH, turnedBox,
} from "../src/model/figures";
import type { ExcerptElement, ImageElement, Page, TextElement } from "../src/model/types";

const image = (asset: string, x = 10, y = 10, extra: Partial<ImageElement> = {}): ImageElement => ({ id: createId(), type: "image", asset, x, y, width: 100, height: 50, rotation: 0, ...extra });
const crop = (asset: string | undefined, y = 10): ExcerptElement => ({
	id: createId(), type: "excerpt", x: 5, y, width: 80, height: 40, source: { notebook: "n", doc: "d", page: "p", x: 0, y: 0, width: 80, height: 40 },
	...(asset ? { asset } : {}),
});
const lecture = (): TextElement => ({ id: createId(), type: "text", x: 20, y: 20, width: 200, text: "Physics — 2026-11-03", fontSize: 16, color: "#000" });
const pageWith = (...elements: Page["elements"] & object): Page => {
	const p = createPage();
	p.elements = elements;
	return p;
};

describe("figures: collection", () => {
	it("collects photos and anchored crops in reading order, page by page", () => {
		const a = image("A", 200, 10);
		const b = image("B", 10, 10);
		const c = crop("C", 300);
		const pages = [pageWith(a, c, b), createPage(), pageWith(image("D"))];
		const all = collectFigures(pages, [0, 1, 2]);
		expect(all.map((f) => f.asset)).toEqual(["B", "A", "C", "D"]);
		expect(all.map((f) => f.kind)).toEqual(["photo", "photo", "crop", "photo"]);
		expect(all.map((f) => f.pageIndex)).toEqual([0, 0, 0, 2]);
		expect(all[0]!.key).toBe(`${pages[0]!.id}:${b.id}`);
	});

	it("leaves out excerpts without a snapshot, pictures of unknown assets and non-figures", () => {
		const pages = [pageWith(crop(undefined), image("GONE"), image("OK"), lecture())];
		expect(collectFigures(pages, [0], new Set(["OK"])).map((f) => f.asset)).toEqual(["OK"]);
		expect(collectFigures(pages, [0]).map((f) => f.asset)).toEqual(["GONE", "OK"]);
	});

	it("ignores page indexes that do not exist and zero-sized pictures", () => {
		const pages = [pageWith(image("A", 0, 0, { width: 0 }), image("B"))];
		expect(collectFigures(pages, [0, 5, -1]).map((f) => f.asset)).toEqual(["B"]);
	});

	it("a rotated picture is reported by its bounding box, keeping its own aspect", () => {
		const box = turnedBox({ x: 0, y: 0, width: 100, height: 50 }, Math.PI / 2);
		expect(box.width).toBeCloseTo(50);
		expect(box.height).toBeCloseTo(100);
		expect(box.x).toBeCloseTo(25);
		expect(box.y).toBeCloseTo(-25);
		const f = collectFigures([pageWith(image("A", 0, 0, { rotation: Math.PI / 2 }))], [0])[0]!;
		expect(f.aspect).toBeCloseTo(2);
		expect(f.height).toBeCloseTo(100);
	});

	it("never mutates the pages", () => {
		const pages = [pageWith(image("A"))];
		const before = JSON.stringify(pages);
		collectFigures(pages, [0]);
		expect(JSON.stringify(pages)).toBe(before);
	});
});

describe("figures: scope", () => {
	const doc = (): Page[] => {
		const p0 = createPage();
		const p1 = pageWith(lecture());
		const p2 = createPage();
		const p3 = pageWith(lecture());
		const p4 = createPage();
		return [p0, p1, p2, p3, p4];
	};

	it("section = the lecture of the current page", () => {
		const pages = doc();
		expect(hasSections(pages)).toBe(true);
		expect(scopePages(pages, { scope: "section", current: 2 })).toEqual([1, 2]);
		expect(scopePages(pages, { scope: "section", current: 4 })).toEqual([3, 4]);
		expect(scopePages(pages, { scope: "section", current: 0 })).toEqual([0]);
	});

	it("a notebook without lecture headers has one section: the notebook", () => {
		const pages = [createPage(), createPage(), createPage()];
		expect(hasSections(pages)).toBe(false);
		expect(scopePages(pages, { scope: "section", current: 1 })).toEqual([0, 1, 2]);
	});

	it("notebook = every page; range = the typed pages, sorted, unique and in range", () => {
		const pages = doc();
		expect(scopePages(pages, { scope: "notebook", current: 3 })).toEqual([0, 1, 2, 3, 4]);
		expect(scopePages(pages, { scope: "range", current: 0, range: [3, 1, 1, 9, -2] })).toEqual([1, 3]);
		expect(scopePages(pages, { scope: "range", current: 0 })).toEqual([]);
		expect(scopePages([], { scope: "notebook", current: 0 })).toEqual([]);
	});
});

describe("figures: grouping and counts", () => {
	const pages = [pageWith(image("A"), crop("B", 200)), createPage(), pageWith(image("A"), image("C", 10, 100))];
	const all = collectFigures(pages, [0, 1, 2]);

	it("counts by kind", () => {
		expect(figureCounts(all)).toEqual({ photo: 3, crop: 1, total: 4 });
		expect(figureCounts([])).toEqual({ photo: 0, crop: 0, total: 0 });
	});

	it("filters by kind", () => {
		expect(filterFigures(all, "crop")).toHaveLength(1);
		expect(filterFigures(all, "photo")).toHaveLength(3);
		expect(filterFigures(all, null)).toHaveLength(4);
	});

	it("counts the pages that have figures", () => {
		expect(pageCount(all)).toBe(2);
		expect(pageCount([])).toBe(0);
	});
});

describe("figures: thumbnail budget", () => {
	it("never enlarges a small picture and never goes past twice the device ratio", () => {
		expect(thumbPixelWidth(100, 2)).toBe(100);
		expect(thumbPixelWidth(4000, 3)).toBe(THUMB_CSS_WIDTH * 2);
		expect(thumbPixelWidth(4000, 1)).toBe(THUMB_CSS_WIDTH);
		expect(thumbPixelWidth(4000, Number.NaN)).toBe(THUMB_CSS_WIDTH);
		expect(thumbPixelWidth(0, 1)).toBe(1);
	});

	it("the cache keeps the most recently used and hands back what it drops", () => {
		const dropped: string[] = [];
		const cache = new LruCache<number>(2, (k) => dropped.push(k));
		cache.set("a", 1);
		cache.set("b", 2);
		expect(cache.get("a")).toBe(1);
		cache.set("c", 3);
		expect(dropped).toEqual(["b"]);
		expect(cache.has("a") && cache.has("c") && !cache.has("b")).toBe(true);
		cache.set("a", 10);
		expect(dropped).toEqual(["b", "a"]);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(dropped).toHaveLength(4);
	});

	it("the queue runs one job at a time, in order, and survives a failing job", async () => {
		const q = new JobQueue(1);
		const order: string[] = [];
		let active = 0;
		let peak = 0;
		const job = (name: string, fail = false) => async () => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			order.push(name);
			active--;
			if (fail) throw new Error("boom");
		};
		q.add("1", job("1"));
		q.add("2", job("2", true));
		q.add("2", job("dup"));
		q.add("3", job("3"));
		q.add("4", job("4"));
		q.cancel("4");
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(order).toEqual(["1", "2", "3"]);
		expect(peak).toBe(1);
		expect(q.pending).toBe(0);
	});

	it("a stopped queue takes no more jobs", async () => {
		const q = new JobQueue(1);
		q.stop();
		let ran = false;
		q.add("x", async () => {
			ran = true;
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(ran).toBe(false);
	});
});
