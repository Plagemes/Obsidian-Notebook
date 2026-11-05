import { beforeEach, describe, expect, it } from "vitest";
import { createPage, createStroke } from "../src/model/document";
import { detectHeadings, underlineCandidates } from "../src/ink/headings";
import { segmentText } from "../src/ink/words";
import { HeadingIndex, pageFingerprint, textStrokes } from "../src/model/heading-index";
import { DEFAULT_OUTLINE_SOURCES, OutlineBuilder } from "../src/model/outline-builder";
import type { Page, Point, Stroke } from "../src/model/types";
import { reseed, writeLine } from "./words-gen";

const body = (tag: string, baseY: number): Stroke[] => [
	...writeLine(`${tag}a`, "some small text follows here", { x: 50, baseY, H: 12 }),
	...writeLine(`${tag}b`, "and a second line of it", { x: 50, baseY: baseY + 26, H: 12 }),
	...writeLine(`${tag}c`, "then the third one more", { x: 50, baseY: baseY + 52, H: 12 }),
];

/** A straight stroke from (x0, y0) to (x1, y1) with `n` points. */
function rule(id: string, x0: number, y0: number, x1: number, y1: number, n = 12, tool: Stroke["tool"] = "pen"): Stroke {
	const pts: Point[] = Array.from({ length: n }, (_, k) => [x0 + ((x1 - x0) * k) / (n - 1), y0 + ((y1 - y0) * k) / (n - 1), 0.5]);
	const s = createStroke("#000000", 1.5, pts, tool);
	s.id = id;
	return s;
}

function lastX(strokes: Stroke[]): number {
	return Math.max(...strokes.flatMap((s) => s.points.map((p) => p[0])));
}

function detect(page: Page, ref = 0) {
	const strokes = textStrokes(page.strokes);
	return detectHeadings(segmentText(strokes), page, ref, {}, strokes);
}

describe("headings: size ratio and level", () => {
	beforeEach(() => reseed(21));

	it("level 1 at about 3x the body, level 2 at about 2x, none at 1.4x", () => {
		const mk = (H: number) => {
			const page = createPage();
			page.strokes = [...writeLine("t", "chapter one", { x: 50, baseY: 90, H }), ...body("b", 150)];
			return detect(page);
		};
		expect(mk(36)[0]?.level).toBe(1);
		expect(mk(24)[0]?.level).toBe(2);
		expect(mk(17)).toEqual([]);
	});

	it("finds several headings on a page and none among body lines", () => {
		const page = createPage();
		page.strokes = [
			...writeLine("t1", "first topic", { x: 50, baseY: 80, H: 34 }),
			...body("b1", 130),
			...writeLine("t2", "second topic", { x: 50, baseY: 300, H: 26 }),
			...body("b2", 350),
		];
		const h = detect(page);
		expect(h).toHaveLength(2);
		expect(h.map((x) => x.level)).toEqual([1, 2]);
		expect(h[0]!.rect.y).toBeLessThan(h[1]!.rect.y);
	});

	it("a drawing (one big stroke, a framed box) among text is not a heading", () => {
		const page = createPage();
		const frame = [rule("f1", 300, 60, 520, 60), rule("f2", 520, 60, 520, 160), rule("f3", 520, 160, 300, 160), rule("f4", 300, 160, 300, 60)];
		const circle = createStroke("#000000", 1.5, Array.from({ length: 40 }, (_, k): Point => [200 + 60 * Math.cos(k / 6), 400 + 60 * Math.sin(k / 6), 0.5]), "pen");
		page.strokes = [...body("b", 300), ...frame, circle];
		expect(detect(page)).toEqual([]);
	});

	it("a rotated heading (a slanted line of big letters) is found with its box around the ink", () => {
		const page = createPage();
		page.strokes = [...writeLine("t", "slanted title", { x: 50, baseY: 90, H: 34, slope: 0.12 }), ...body("b", 200)];
		const h = detect(page);
		expect(h).toHaveLength(1);
		expect(h[0]!.level).toBe(1);
		expect(h[0]!.rect.x).toBeLessThanOrEqual(50);
	});

	it("a slanted body does not turn into headings", () => {
		const page = createPage();
		page.strokes = [
			...writeLine("a", "some small text follows here", { x: 50, baseY: 100, H: 12, slope: 0.1 }),
			...writeLine("b", "and a second line of it", { x: 50, baseY: 126, H: 12, slope: 0.1 }),
			...writeLine("c", "then the third one more", { x: 50, baseY: 152, H: 12, slope: 0.1 }),
		];
		expect(detect(page)).toEqual([]);
	});

	it("highlighter and invisible ink are not read", () => {
		const page = createPage();
		const big = writeLine("t", "chapter one", { x: 50, baseY: 90, H: 36, tool: "highlighter" });
		page.strokes = [...big, ...body("b", 150)];
		expect(detect(page)).toEqual([]);
		const hidden = writeLine("h", "chapter one", { x: 50, baseY: 90, H: 36 }).map((s) => ({ ...s, hidden: true as const }));
		page.strokes = [...hidden, ...body("b", 150)];
		expect(detect(page)).toEqual([]);
	});
});

describe("headings: underlined lines", () => {
	beforeEach(() => reseed(33));

	it("a slightly larger underlined line is a level 2 heading, and the underline is part of it", () => {
		const page = createPage();
		const title = writeLine("t", "key results", { x: 50, baseY: 90, H: 17 });
		const under = rule("u", 48, 98, lastX(title) + 4, 98);
		page.strokes = [...title, under, ...body("b", 150)];
		expect(detect(page)).toHaveLength(1);
		const h = detect(page)[0]!;
		expect(h.underlined).toBe(true);
		expect(h.level).toBe(2);
		expect(h.strokeIds).toContain("u");
		expect(h.rect.y + h.rect.height).toBeGreaterThan(98);
		// The same line without the underline is body text.
		page.strokes = [...title, ...body("b", 150)];
		expect(detect(page)).toEqual([]);
	});

	it("an underlined line of ordinary size is not a heading", () => {
		const page = createPage();
		const line = writeLine("t", "just a sentence here", { x: 50, baseY: 90, H: 12 });
		page.strokes = [...line, rule("u", 48, 96, lastX(line), 96), ...body("b", 150)];
		expect(detect(page)).toEqual([]);
	});

	it("a slanted underline under a slanted line belongs to it; a rule at a very different angle does not", () => {
		const page = createPage();
		const title = writeLine("t", "tilted heading", { x: 50, baseY: 90, H: 17, slope: 0.1 });
		const x1 = lastX(title);
		const slanted = rule("u", 48, 98, x1, 98 + 0.1 * (x1 - 48));
		page.strokes = [...title, slanted, ...body("b", 220)];
		expect(detect(page)[0]?.underlined).toBe(true);
		const crossing = rule("u", 48, 98, x1, 98 + 0.45 * (x1 - 48));
		page.strokes = [...title, crossing, ...body("b", 220)];
		expect(detect(page).every((h) => !h.underlined)).toBe(true);
	});

	it("a rule far under the line, or one that covers little of it, is not an underline", () => {
		const page = createPage();
		const title = writeLine("t", "key results", { x: 50, baseY: 90, H: 17 });
		const x1 = lastX(title);
		page.strokes = [...title, rule("far", 48, 140, x1, 140), ...body("b", 200)];
		expect(detect(page)).toEqual([]);
		page.strokes = [...title, rule("short", 50, 98, 50 + (x1 - 50) * 0.3, 98), ...body("b", 200)];
		expect(detect(page)).toEqual([]);
	});

	it("underline candidates are long, straight and nearly horizontal", () => {
		const wiggly = createStroke("#000000", 1.5, Array.from({ length: 20 }, (_, k): Point => [k * 10, k % 2 ? 0 : 12, 0.5]), "pen");
		const steep = rule("steep", 0, 0, 20, 100);
		const ok = rule("ok", 0, 0, 100, 3);
		const hl = rule("hl", 0, 0, 100, 0, 12, "highlighter");
		const ids = underlineCandidates([wiggly, steep, ok, hl], 30).map((r) => r.id);
		expect(ids).toEqual(["ok"]);
	});

	it("an underline of the previous block does not stop the next heading from starting its block", () => {
		const page = createPage();
		const first = writeLine("t1", "first", { x: 50, baseY: 80, H: 30 });
		page.strokes = [...first, rule("u1", 48, 92, lastX(first), 92), ...body("b1", 130), ...writeLine("t2", "second", { x: 50, baseY: 260, H: 30 }), ...body("b2", 310)];
		expect(detect(page)).toHaveLength(2);
	});
});

describe("HeadingIndex", () => {
	beforeEach(() => reseed(5));

	const titled = (tag: string, title: string): Page => {
		const page = createPage();
		page.strokes = [...writeLine(`${tag}t`, title, { x: 50, baseY: 90, H: 34 }), ...body(`${tag}b`, 150)];
		return page;
	};

	it("fingerprints content, not objects: equal strokes give an equal fingerprint, a moved or missing stroke does not", () => {
		const page = titled("a", "one");
		const copy: Page = { ...page, strokes: page.strokes.map((s) => ({ ...s, points: s.points.map((p) => [...p] as Point) })) };
		expect(pageFingerprint(copy)).toBe(pageFingerprint(page));
		const moved: Page = { ...page, strokes: page.strokes.map((s, i) => (i === 3 ? { ...s, points: s.points.map((p): Point => [p[0] + 5, p[1], p[2]]) } : s)) };
		expect(pageFingerprint(moved)).not.toBe(pageFingerprint(page));
		expect(pageFingerprint({ ...page, strokes: page.strokes.slice(1) })).not.toBe(pageFingerprint(page));
		// Highlighter ink does not count.
		const extra = writeLine("hl", "mark", { x: 50, baseY: 500, H: 12, tool: "highlighter" });
		expect(pageFingerprint({ ...page, strokes: [...page.strokes, ...extra] })).toBe(pageFingerprint(page));
	});

	it("analyses a page once; rebuilt strokes with the same content are not analysed again", () => {
		const page = titled("a", "one");
		const idx = new HeadingIndex();
		expect(idx.headings([page])).toHaveLength(1);
		expect(idx.computed).toBe(1);
		idx.headings([page]);
		expect(idx.computed).toBe(1);
		const rebuilt: Page = { ...page, strokes: page.strokes.map((s) => ({ ...s })) };
		expect(idx.headings([rebuilt])).toHaveLength(1);
		expect(idx.computed).toBe(1);
		const edited: Page = { ...page, strokes: page.strokes.slice(2) };
		idx.headings([edited]);
		expect(idx.computed).toBe(2);
	});

	it("warm works in small steps and leaves nothing for the next read", () => {
		const pages = [titled("a", "one"), titled("b", "two"), titled("c", "three"), titled("d", "four")];
		const idx = new HeadingIndex();
		expect(idx.pending(pages)).toBe(4);
		// A clock that moves 10 ms per look and a budget of 15 ms: a call analyses a page or two (at least one always).
		let t = 0;
		const now = () => (t += 10);
		let left = idx.warm(pages, 15, now);
		expect(left).toBeGreaterThan(0);
		expect(idx.computed).toBeLessThan(4);
		let guard = 0;
		while (left > 0 && guard++ < 10) left = idx.warm(pages, 15, now);
		expect(left).toBe(0);
		expect(idx.pending(pages)).toBe(0);
		idx.resetCount();
		expect(idx.headings(pages)).toHaveLength(4);
		expect(idx.computed).toBe(0);
	});

	it("a page with too few lines is measured against the notebook, and a heavy page is skipped", () => {
		const lone = createPage();
		lone.strokes = writeLine("x", "title", { x: 50, baseY: 90, H: 36 });
		const idx = new HeadingIndex();
		expect(idx.headings([lone])).toEqual([]);
		const rest = createPage();
		rest.strokes = body("r", 100);
		expect(idx.headings([lone, rest]).map((h) => h.index)).toEqual([0]);
		const heavy = createPage();
		heavy.strokes = Array.from({ length: 4001 }, (_, i) => rule(`s${i}`, 0, i % 50, 10, i % 50));
		expect(new HeadingIndex().headings([heavy])).toEqual([]);
	});

	it("the outline carries the underline through the same cache", () => {
		const page = createPage();
		const title = writeLine("t", "key results", { x: 50, baseY: 90, H: 17 });
		page.strokes = [...title, rule("u", 48, 98, lastX(title) + 4, 98), ...body("b", 150)];
		const b = new OutlineBuilder();
		const out = b.build({ pages: [page] }, { ...DEFAULT_OUTLINE_SOURCES, bookmarks: false, slides: false, markers: false, pdf: false });
		expect(out).toHaveLength(1);
		expect(out[0]!.heading?.strokeIds).toContain("u");
		expect(b.lastComputed).toBe(1);
		b.build({ pages: [page] });
		expect(b.lastComputed).toBe(0);
	});
});
