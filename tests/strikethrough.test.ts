import { beforeEach, describe, expect, it } from "vitest";
import { createStroke } from "../src/model/document";
import type { Page, Point, Stroke, Tool } from "../src/model/types";
import { detectStrikes, NO_STRIKES, StrikeCache, strikeLineOf, struckInk } from "../src/ink/strikethrough";
import { segmentText } from "../src/ink/words";
import { cleanPageForExport, hasCleanableContent } from "../src/model/clean-export";
import { expandToGroups } from "../src/model/groups";
import { reseed, writeLine } from "./words-gen";

/** A straight pass from (x0, y0) to (x1, y1) with a little hand wobble (deterministic). */
function line(id: string, x0: number, y0: number, x1: number, y1: number, tool: Tool = "pen"): Stroke {
	const pts: Point[] = [];
	const n = 12;
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(i * 1.7) * 0.4, 0.5]);
	}
	const s = createStroke("#000000", 1.5, pts, tool);
	s.id = id;
	return s;
}

const BASE = 100;
const H = 16;

/** Bounds of the words of a line of writing, left to right. */
function wordBoxes(text: Stroke[]) {
	return segmentText(text).lines.flatMap((l) => l.words.map((w) => w.bounds));
}

/** A line through the middle of word `i` of `text`, overhanging by `over` pt on each side. */
function strikeWord(text: Stroke[], i: number, over = 4, y = BASE - 5): Stroke {
	const b = wordBoxes(text)[i]!;
	return line("strike", b.minX - over, y, b.maxX + over, y);
}

const idsOf = (r: { words: Array<{ strokeIds: string[] }> }) => r.words.map((w) => w.strokeIds.map((id) => id.split(":")[1]).filter((v, k, a) => a.indexOf(v) === k).join(","));

describe("detectStrikes", () => {
	beforeEach(() => reseed(11));

	it("finds a word with a line through its middle", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const strike = strikeWord(text, 1);
		const r = detectStrikes([...text, strike]);
		expect(idsOf(r)).toEqual(["1"]);
		expect(r.words[0]!.strikeIds).toEqual(["strike"]);
		expect(r.ink.has("strike")).toBe(true);
		for (const s of text) expect(r.ink.has(s.id), s.id).toBe(s.id.split(":")[1] === "1");
	});

	it("is the same when the line is drawn right to left or the strokes come in another order", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const s = strikeWord(text, 2);
		const back = line("strike", s.points[s.points.length - 1]![0], s.points[0]![1], s.points[0]![0], s.points[0]![1]);
		expect(idsOf(detectStrikes([...text, back]))).toEqual(["2"]);
		expect(idsOf(detectStrikes([...text.slice().reverse(), s]))).toEqual(["2"]);
	});

	it("does not count an underline, an overline or a line far from the text", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		expect(detectStrikes([...text, strikeWord(text, 1, 4, BASE + 3)]).words).toHaveLength(0);
		expect(detectStrikes([...text, strikeWord(text, 1, 4, BASE + 8)]).words).toHaveLength(0);
		expect(detectStrikes([...text, strikeWord(text, 1, 4, BASE - 1.1 * H)]).words).toHaveLength(0);
		expect(detectStrikes([...text, strikeWord(text, 1, 4, BASE - 60)]).words).toHaveLength(0);
		expect(detectStrikes([...text, strikeWord(text, 1, 4, BASE - 5)]).words).toHaveLength(1);
	});

	it("finds a single crossed-out letter", () => {
		const text = writeLine("a", "see a dog", { x: 40, baseY: BASE });
		const r = detectStrikes([...text, strikeWord(text, 1, 5)]);
		expect(idsOf(r)).toEqual(["1"]);
		expect(r.words[0]!.strokeIds).toHaveLength(1);
	});

	it("strikes every word a long line of one line of text covers, and only those", () => {
		const text = writeLine("a", "one two three four five", { x: 40, baseY: BASE });
		const boxes = wordBoxes(text);
		const long = line("strike", boxes[1]!.minX - 3, BASE - 5, boxes[3]!.maxX + 3, BASE - 5);
		const r = detectStrikes([...text, long]);
		expect(idsOf(r).sort()).toEqual(["1", "2", "3"]);
		expect(r.words.every((w) => w.strikeIds.join() === "strike")).toBe(true);
	});

	it("strikes only what was written before the line: a line first and the word after it strikes nothing", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const strike = strikeWord(text, 1);
		expect(detectStrikes([strike, ...text]).words).toHaveLength(0);
		// A line between the words and the rest: only the strokes before it are struck.
		const word1 = text.filter((s) => s.id.split(":")[1] === "1");
		const rest = text.filter((s) => s.id.split(":")[1] !== "1");
		const r = detectStrikes([...rest, ...word1, strike]);
		expect(idsOf(r)).toEqual(["1"]);
	});

	it("a new word written on the place of a struck one afterwards stays visible", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const b = wordBoxes(text)[1]!;
		const strike = strikeWord(text, 1);
		const fresh = writeLine("n", "brave", { x: b.minX, baseY: BASE });
		const first = detectStrikes([...text, strike]);
		expect(first.ink.has("strike")).toBe(true);
		const r = detectStrikes([...text, strike, ...fresh]);
		for (const s of fresh) expect(r.ink.has(s.id), s.id).toBe(false);
		// Whatever is still struck is only what was written before the line.
		for (const id of r.ink) expect(id.startsWith("n:"), id).toBe(false);
	});

	it("does not glue two words together because a line passes over both", () => {
		const text = writeLine("a", "alpha beta gamma", { x: 40, baseY: BASE });
		const boxes = wordBoxes(text);
		const r = detectStrikes([...text, line("strike", boxes[0]!.minX - 3, BASE - 5, boxes[1]!.maxX + 3, BASE - 5)]);
		expect(r.words).toHaveLength(2);
		expect(r.words.map((w) => w.strokeIds.length)).toEqual([5, 4]);
	});

	it("leaves a word alone that the line covers only at its edge", () => {
		const text = writeLine("a", "alpha beta gamma", { x: 40, baseY: BASE });
		const b = wordBoxes(text)[1]!;
		expect(detectStrikes([...text, line("strike", b.minX - 20, BASE - 5, b.minX + 0.3 * (b.maxX - b.minX), BASE - 5)]).words).toHaveLength(0);
	});

	it("strikes words on a slanted line when the line follows the slant", () => {
		const text = writeLine("a", "slanted words are here", { x: 40, baseY: BASE, slope: 0.15 });
		const b = wordBoxes(text)[1]!;
		const yAt = (x: number) => BASE + 0.15 * (x - 40) - 5;
		const r = detectStrikes([...text, line("strike", b.minX - 4, yAt(b.minX - 4), b.maxX + 4, yAt(b.maxX + 4))]);
		expect(idsOf(r)).toEqual(["1"]);
	});

	it("keeps lines apart: a line through one line of text strikes nothing in the next", () => {
		const text = [...writeLine("a", "first line here", { x: 40, baseY: BASE }), ...writeLine("b", "second line here", { x: 40, baseY: BASE + 2 * H })];
		const b = wordBoxes(text.filter((s) => s.id.startsWith("b")))[1]!;
		const r = detectStrikes([...text, line("strike", b.minX - 4, BASE + 2 * H - 5, b.maxX + 4, BASE + 2 * H - 5)]);
		expect(r.words).toHaveLength(1);
		expect(r.words[0]!.strokeIds.every((id) => id.startsWith("b"))).toBe(true);
	});

	it("does not take a scribble, a short dash or a wavy zig-zag for a strike", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const b = wordBoxes(text)[1]!;
		const zig: Point[] = [];
		for (let i = 0; i <= 16; i++) zig.push([b.minX - 2 + ((b.maxX - b.minX + 4) * (i % 2 ? i - 1 : i + 1)) / 16, BASE - 5 + (i % 2) * 3, 0.5]);
		const scribble = createStroke("#000000", 1.5, zig, "pen");
		scribble.id = "strike";
		expect(detectStrikes([...text, scribble]).words).toHaveLength(0);
		const dash = line("strike", b.minX, BASE - 5, b.minX + 5, BASE - 5);
		expect(detectStrikes([...text, dash]).words).toHaveLength(0);
		const steep = line("strike", b.minX - 4, BASE - 25, b.maxX + 4, BASE + 5);
		expect(detectStrikes([...text, steep]).words).toHaveLength(0);
	});

	it("ignores hidden ink, the highlighter, the marker and shapes as strike lines", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const hidden = strikeWord(text, 1);
		hidden.hidden = true;
		expect(detectStrikes([...text, hidden]).words).toHaveLength(0);
		for (const tool of ["highlighter", "marker", "shape"] as const) {
			const s = strikeWord(text, 1);
			s.tool = tool;
			expect(detectStrikes([...text, s]).words, tool).toHaveLength(0);
		}
		const brush = strikeWord(text, 1);
		brush.tool = "brush";
		expect(detectStrikes([...text, brush]).words).toHaveLength(1);
	});

	it("finds nothing on an empty page, on a page without a long straight stroke, or with only a line", () => {
		expect(detectStrikes([])).toBe(NO_STRIKES);
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		expect(detectStrikes(text)).toBe(NO_STRIKES);
		expect(detectStrikes([line("strike", 20, 50, 200, 50)]).words).toHaveLength(0);
	});

	it("does not change the strokes it reads", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const all = [...text, strikeWord(text, 1)];
		const before = JSON.stringify(all);
		detectStrikes(all);
		expect(JSON.stringify(all)).toBe(before);
	});

	it("strikes both words when two lines cross one word each, and counts a double strike once", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const b = wordBoxes(text)[1]!;
		const twice = [line("s1", b.minX - 4, BASE - 6, b.maxX + 4, BASE - 6), line("s2", b.minX - 4, BASE - 4, b.maxX + 4, BASE - 4)];
		const r = detectStrikes([...text, ...twice]);
		expect(r.words).toHaveLength(1);
		expect(r.words[0]!.strikeIds.sort()).toEqual(["s1", "s2"]);
	});
});

describe("strikeLineOf", () => {
	it("accepts a straight pass in either direction and refuses the rest", () => {
		expect(strikeLineOf(line("a", 10, 50, 90, 52))?.length).toBeCloseTo(80, 0);
		const back = strikeLineOf(line("a", 90, 52, 10, 50))!;
		expect(back.x0).toBeLessThan(back.x1);
		expect(strikeLineOf(line("a", 10, 50, 90, 90))).toBeNull();
		expect(strikeLineOf(createStroke("#000", 1, [[1, 1, 0.5]], "pen"))).toBeNull();
	});
});

describe("StrikeCache", () => {
	it("recomputes only when the strokes changed", () => {
		reseed(3);
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const strokes = [...text, strikeWord(text, 1)];
		const cache = new StrikeCache();
		expect(cache.peek("p")).toBeNull();
		const first = cache.get("p", strokes);
		expect(first.words).toHaveLength(1);
		expect(cache.get("p", strokes)).toBe(first);
		expect(cache.fresh("p", strokes)).toBe(true);
		const less = strokes.slice(0, -1);
		expect(cache.fresh("p", less)).toBe(false);
		expect(cache.get("p", less).words).toHaveLength(0);
		cache.retain(new Set(["other"]));
		expect(cache.peek("p")).toBeNull();
	});

	it("does not look at a page with more strokes than the cap (a dense page never holds the thread) and remembers that", () => {
		reseed(3);
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const strokes = [...text, strikeWord(text, 1)];
		const cache = new StrikeCache();
		expect(cache.get("dense", strokes, strokes.length - 1)).toBe(NO_STRIKES);
		expect(cache.fresh("dense", strokes)).toBe(true);
		expect(cache.get("ok", strokes, strokes.length).words).toHaveLength(1);
	});
});

describe("a group a selection touches comes whole, with its hidden struck members", () => {
	it("expandToGroups completes the group from the ink it is given", () => {
		reseed(3);
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const strike = strikeWord(text, 1);
		const all = [...text, strike];
		const struck = struckInk(all);
		const grouped = all.map((s) => (struck.has(s.id) || s.id === text[0]!.id ? { ...s, group: "g1" } : s)) as Stroke[];
		const page = { strokes: grouped, elements: [] } as unknown as Page;
		const seen = grouped.filter((s) => !struck.has(s.id));
		const visible = seen.filter((s) => s.group === "g1");
		expect(visible).toHaveLength(1);
		// With the view's list (struck ink left out) the hidden members stay behind; with the whole list they come along.
		expect(expandToGroups(page, { strokes: visible, elements: [] }, seen).strokes).toHaveLength(1);
		expect(expandToGroups(page, { strokes: visible, elements: [] }, grouped).strokes).toHaveLength(1 + struck.size);
	});
});

describe("clean export of struck words", () => {
	beforeEach(() => reseed(5));
	const pageOf = (strokes: Stroke[]): Page => ({ id: "p1", width: 600, height: 800, paper: { kind: "plain" }, strokes } as unknown as Page);

	it("is off by default: the page is drawn as it is", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const page = pageOf([...text, strikeWord(text, 1)]);
		expect(cleanPageForExport(page, {})).toBe(page);
		expect(hasCleanableContent(page, {})).toBe(false);
	});

	it("leaves out the struck words and their lines when asked, without touching the page", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const page = pageOf([...text, strikeWord(text, 1)]);
		const count = page.strokes.length;
		expect(hasCleanableContent(page, { struck: true, markers: false, comments: false, collapsedStickies: false })).toBe(true);
		const clean = cleanPageForExport(page, { struck: true });
		expect(clean).not.toBe(page);
		expect(clean.strokes.map((s) => s.id).filter((id) => id.startsWith("a:1") || id === "strike")).toEqual([]);
		expect(clean.strokes).toHaveLength(count - 5 - 1);
		expect(page.strokes).toHaveLength(count);
		expect(struckInk(page.strokes).size).toBe(6);
	});

	it("returns the same page when nothing is struck", () => {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const page = pageOf(text);
		expect(cleanPageForExport(page, { struck: true })).toBe(page);
	});
});
