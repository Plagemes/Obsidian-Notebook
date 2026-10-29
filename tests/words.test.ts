import { beforeEach, describe, expect, it } from "vitest";
import { createStroke } from "../src/model/document";
import type { Stroke } from "../src/model/types";
import { reseed, writeLine } from "./words-gen";
import { MultiTap } from "../src/ink/multitap";
import { lineAt, segmentText, TextLayoutCache, wordAt } from "../src/ink/words";

function structure(strokes: Stroke[]) {
	return segmentText(strokes).lines.map((l) => l.words.map((w) => w.strokeIds.map((id) => id.split(":").slice(0, 2).join(":")).sort()));
}

describe("segmentText", () => {
	beforeEach(() => reseed(7));
	it("separates words (word gap) from letters (letter gap)", () => {
		const s = writeLine("a", "hello brave new world", { x: 40, baseY: 100 });
		const layout = segmentText(s);
		expect(layout.lines).toHaveLength(1);
		expect(layout.lines[0]!.words.map((w) => w.strokeIds.length)).toEqual([5, 5, 3, 5]);
		expect(layout.lines[0]!.strokeIds).toHaveLength(18);
		layout.lines[0]!.words.forEach((w, wi) => expect(new Set(w.strokeIds.map((id) => id.split(":")[1]))).toEqual(new Set([String(wi)])));
	});

	it("keeps lines apart even with overlapping descenders and ascenders", () => {
		const s = [
			...writeLine("a", "gypsy jumping quickly", { x: 40, baseY: 100 }),
			...writeLine("b", "hello lovely day", { x: 40, baseY: 100 + 1.5 * 16 }),
			...writeLine("c", "pgq bdf", { x: 40, baseY: 100 + 3 * 16 }),
		];
		const layout = segmentText(s);
		expect(layout.lines).toHaveLength(3);
		expect(layout.lines.map((l) => l.words.length)).toEqual([3, 3, 2]);
		for (const [i, tag] of ["a", "b", "c"].entries()) expect(layout.lines[i]!.strokeIds.every((id) => id.startsWith(tag))).toBe(true);
	});

	it("handles slanted lines and reports the slope of the baseline", () => {
		for (const slope of [-0.35, -0.15, 0.15, 0.4]) {
			const s = [
				...writeLine("a", "slanted lines of text here", { x: 40, baseY: 200, slope }),
				...writeLine("b", "second one under it", { x: 40, baseY: 200 + 3 * 16, slope }),
			];
			const layout = segmentText(s);
			expect(layout.lines.map((l) => l.words.length), `slope ${slope}`).toEqual([5, 4]);
			expect(layout.lines[0]!.baseline.slope).toBeCloseTo(slope, 1);
		}
	});

	it("handles mixed sizes: a heading above small text", () => {
		const s = [
			...writeLine("h", "big title", { x: 40, baseY: 80, H: 40 }),
			...writeLine("a", "small text follows here", { x: 40, baseY: 130, H: 12 }),
			...writeLine("b", "and more small text", { x: 40, baseY: 160, H: 12 }),
		];
		const layout = segmentText(s);
		expect(layout.lines.map((l) => l.words.length)).toEqual([2, 4, 4]);
		expect(layout.lines[0]!.letterHeight).toBeGreaterThan(30);
		expect(layout.lines[1]!.letterHeight).toBeLessThan(15);
	});

	it("attaches i-dots and punctuation to their word", () => {
		const s = writeLine("a", "the quick fox", { x: 40, baseY: 100 });
		const i = s.find((x) => x.id === "a:1:2")!;
		const ix = i.points[0]![0] + 2;
		const dot = createStroke("#000000", 2, [[ix, 100 - 16 * 1.3, 0.5], [ix + 0.5, 100 - 16 * 1.3 + 0.5, 0.5]]);
		dot.id = "a:1:dot";
		const last = s[s.length - 1]!;
		const lx = last.points[5]![0] + 2.5;
		const stop = createStroke("#000000", 2, [[lx, 100, 0.5], [lx + 0.5, 100 + 0.5, 0.5]]);
		stop.id = "a:2:stop";
		const layout = segmentText([...s, dot, stop]);
		expect(layout.lines).toHaveLength(1);
		expect(layout.lines[0]!.words).toHaveLength(3);
		expect(layout.lines[0]!.words[1]!.strokeIds).toContain("a:1:dot");
		expect(layout.lines[0]!.words[2]!.strokeIds).toContain("a:2:stop");
	});

	it("ignores highlighter, shapes, oversized strokes and empty strokes", () => {
		const text = writeLine("a", "some text here", { x: 40, baseY: 100 });
		const hl = writeLine("hl", "some", { x: 40, baseY: 100, tool: "highlighter" });
		const shape = writeLine("sh", "ab", { x: 200, baseY: 300, tool: "shape" });
		const underline = createStroke("#000000", 1.5, [[40, 112, 0.5], [300, 112, 0.5]]);
		underline.id = "ul";
		const empty = createStroke("#000000", 1.5, []);
		empty.id = "empty";
		const layout = segmentText([...text, ...hl, ...shape, underline, empty]);
		expect(layout.lines).toHaveLength(1);
		expect(layout.lines[0]!.strokeIds).toHaveLength(text.length);
		expect(layout.ignored).toEqual(expect.arrayContaining(["ul", "empty", ...hl.map((x) => x.id), ...shape.map((x) => x.id)]));
	});

	it("does not join two columns into one line", () => {
		const s = [
			...writeLine("l", "left column text", { x: 40, baseY: 100 }),
			...writeLine("r", "right column text", { x: 420, baseY: 100 }),
		];
		const layout = segmentText(s);
		expect(layout.lines).toHaveLength(2);
		expect(layout.lines[0]!.strokeIds.every((id) => id.startsWith("l"))).toBe(true);
	});

	it("is independent of stroke order and of the handwriting size", () => {
		const s = [
			...writeLine("a", "order should not matter", { x: 40, baseY: 100 }),
			...writeLine("b", "at all really", { x: 40, baseY: 150 }),
		];
		const shuffled = s.slice().sort((p, q) => Math.sin(p.id.length * 7 + p.points[0]![0]) - Math.sin(q.id.length * 7 + q.points[0]![0]));
		expect(structure(shuffled)).toEqual(structure(s));
		const small = [
			...writeLine("a", "order should not matter", { x: 40, baseY: 100, H: 8 }),
			...writeLine("b", "at all really", { x: 40, baseY: 125, H: 8 }),
		];
		expect(segmentText(small).lines.map((l) => l.words.length)).toEqual([4, 3]);
	});

	it("returns an empty layout for an empty page", () => {
		const layout = segmentText([]);
		expect(layout.lines).toEqual([]);
		expect(layout.unit).toBe(0);
	});

	it("returns lines top to bottom and words left to right with consistent boxes", () => {
		const s = [
			...writeLine("b", "second line here", { x: 40, baseY: 160 }),
			...writeLine("a", "first line is here", { x: 40, baseY: 100 }),
		];
		const layout = segmentText(s);
		expect(layout.lines[0]!.strokeIds[0]!.startsWith("a")).toBe(true);
		for (const line of layout.lines) {
			for (let i = 1; i < line.words.length; i++) expect(line.words[i]!.bounds.minX).toBeGreaterThan(line.words[i - 1]!.bounds.maxX);
			for (const w of line.words) {
				expect(w.bounds.minX).toBeGreaterThanOrEqual(line.bounds.minX);
				expect(w.bounds.maxX).toBeLessThanOrEqual(line.bounds.maxX);
			}
			expect(line.baseline.x0).toBe(line.bounds.minX);
		}
		// The baseline sits at the letter bottoms (descenders are below it).
		expect(layout.lines[0]!.baseline.y0).toBeCloseTo(100, 0);
	});
});

describe("whole pages", () => {
	const texts = ["the quick brown fox jumps", "over the lazy dog again", "pack my box with five", "dozen liquor jugs please", "sphinx of black quartz", "judge my vow today"];

	it("recovers every line and word of a ruled page, for several seeds and a slight slant", () => {
		for (const seedValue of [1, 2, 3, 4, 5, 6]) {
			reseed(seedValue);
			const strokes: Stroke[] = [];
			const slope = seedValue % 2 ? 0 : -0.04;
			for (let i = 0; i < 24; i++) strokes.push(...writeLine(`L${i}`, texts[i % texts.length]!, { x: 50, baseY: 80 + i * 34, slope }));
			const layout = segmentText(strokes);
			expect(layout.lines, `seed ${seedValue}`).toHaveLength(24);
			layout.lines.forEach((l, i) => {
				expect(new Set(l.strokeIds.map((id) => id.split(":")[0])), `seed ${seedValue} line ${i}`).toEqual(new Set([`L${i}`]));
				expect(l.words.length, `seed ${seedValue} line ${i}`).toBe(texts[i % texts.length]!.split(" ").length);
			});
		}
	});
});

describe("wordAt / lineAt", () => {
	reseed(7);
	const s = [
		...writeLine("a", "alpha beta gamma", { x: 40, baseY: 100 }),
		...writeLine("b", "delta epsilon", { x: 40, baseY: 150 }),
	];
	const layout = segmentText(s);

	it("finds the word under a point and the nearest within the tolerance", () => {
		const w = layout.lines[0]!.words[1]!;
		const cx = (w.bounds.minX + w.bounds.maxX) / 2;
		expect(wordAt(layout, cx, 95, 6)!.word).toBe(w);
		expect(wordAt(layout, w.bounds.maxX + 3, 95, 6)!.word).toBe(w);
		expect(wordAt(layout, cx, 125, 3)).toBeNull();
	});

	it("finds the line of a point, also in the gap between words and beside the text", () => {
		const l0 = layout.lines[0]!;
		const gapX = (l0.words[0]!.bounds.maxX + l0.words[1]!.bounds.minX) / 2;
		expect(lineAt(layout, gapX, 95, 6)).toBe(l0);
		expect(lineAt(layout, 20, 95, 30)).toBe(l0);
		expect(lineAt(layout, 20, 400, 6)).toBeNull();
	});
});

describe("TextLayoutCache", () => {
	it("reuses the layout while the strokes are the same objects and recomputes on change", () => {
		const s = writeLine("a", "cache me", { x: 40, baseY: 100 });
		const cache = new TextLayoutCache();
		const a = cache.get(s);
		expect(cache.get(s.slice())).toBe(a);
		const more = [...s, ...writeLine("b", "and more", { x: 40, baseY: 150 })];
		const b = cache.get(more);
		expect(b).not.toBe(a);
		expect(b.lines).toHaveLength(2);
	});
});

describe("MultiTap", () => {
	it("counts quick taps close to each other up to three, then starts over", () => {
		const m = new MultiTap(400, 30);
		expect(m.tap(1000, 100, 100)).toBe(1);
		expect(m.tap(1200, 105, 98)).toBe(2);
		expect(m.tap(1400, 100, 102)).toBe(3);
		expect(m.tap(1550, 100, 100)).toBe(1);
	});

	it("resets when too slow, too far, or reset()", () => {
		const m = new MultiTap(400, 30);
		m.tap(0, 0, 0);
		expect(m.tap(500, 0, 0)).toBe(1);
		expect(m.tap(600, 100, 0)).toBe(1);
		expect(m.tap(700, 100, 0)).toBe(2);
		m.reset();
		expect(m.tap(750, 100, 0)).toBe(1);
	});
});
