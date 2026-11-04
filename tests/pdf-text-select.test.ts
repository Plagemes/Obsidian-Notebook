import { describe, expect, it } from "vitest";
import type { PageTextContent, TextBox } from "../src/pdf/text-items";
import { assemblePageText } from "../src/pdf/text-search";
import {
	caretAt, caretInRun, formatQuote, isTap, pageToPdf, pdfRectToPage, rangeBetween, rangeHasText, selectionBoxes, selectionText, unionBox, wordRange,
} from "../src/pdf/text-select";

/** One run per line: 10 pt high, 10 pt per character, lines 20 pt apart. */
function run(str: string, x: number, y: number): TextBox {
	return { str, x, y, width: str.length * 10, height: 10 };
}

const content = (items: TextBox[]): PageTextContent => ({ width: 600, height: 800, items });

describe("PDF text selection geometry (#45)", () => {
	const items = [run("Hello world", 72, 100), run("second line", 72, 120), run("a broken-", 72, 140), run("word here", 72, 160)];
	const c = content(items);
	const page = assemblePageText(items);

	it("moves points between the notebook page and the PDF viewport, margins included", () => {
		// The PDF is drawn 100 pt to the right on a page 700 wide, at the same scale.
		const rect = { x: 100, y: 0, width: 600, height: 800 };
		expect(pageToPdf({ x: 172, y: 50 }, rect, c)).toEqual({ x: 72, y: 50 });
		// A PDF drawn at half size.
		const half = { x: 0, y: 0, width: 300, height: 400 };
		expect(pageToPdf({ x: 150, y: 100 }, half, c)).toEqual({ x: 300, y: 200 });
		const back = pdfRectToPage({ x: 300, y: 200, width: 60, height: 20 }, half, c);
		expect(back).toEqual({ x: 150, y: 100, width: 30, height: 10 });
	});

	it("finds the character boundary nearest to a x in a run", () => {
		const box = items[0]!;
		expect(caretInRun(box, 0)).toBe(0);
		expect(caretInRun(box, 10_000)).toBe(11);
		expect(caretInRun(box, 72 + 60)).toBe(6);
		expect(caretInRun(box, 72 + 14)).toBe(1);
		// With real glyph widths: the first character is much wider than the rest.
		const wide = (text: string): number => (text.length === 0 ? 0 : 50 + (text.length - 1));
		expect(caretInRun({ str: "Wiiiii", x: 0, y: 0, width: 100, height: 10 }, 60, wide)).toBe(1);
	});

	it("puts a point on the nearest run, and refuses a point far from any text when asked to", () => {
		// Inside the second line, 25 pt into it.
		const inside = caretAt(c, page, { x: 72 + 30, y: 125 });
		expect(inside).not.toBeNull();
		// "second line" starts at offset 12 of the page text; three characters in.
		expect(inside!.offset).toBe(15);
		expect(inside!.distance).toBe(0);
		expect(inside!.item).toBe(1);
		// Far below the text: a drag still lands on the last line, a tap (maxDistance) lands nowhere.
		const far = { x: 300, y: 700 };
		expect(caretAt(c, page, far)?.item).toBe(3);
		expect(caretAt(c, page, far, undefined, 1.5)).toBeNull();
		// Between two lines it takes the nearer one.
		expect(caretAt(c, page, { x: 90, y: 116 })?.item).toBe(1);
		expect(caretAt(c, page, { x: 90, y: 114 })?.item).toBe(0);
		expect(caretAt(content([]), assemblePageText([]), { x: 1, y: 1 })).toBeNull();
	});

	it("selects the word around an offset, and nothing on white space", () => {
		const text = "Hello world, it's fine";
		expect(wordRange(text, 2)).toEqual({ start: 0, end: 5 });
		expect(wordRange(text, 5)).toEqual({ start: 0, end: 5 });
		expect(wordRange(text, 6)).toEqual({ start: 6, end: 11 });
		expect(wordRange(text, 14)).toEqual({ start: 13, end: 17 });
		expect(wordRange("a  b", 2)).toBeNull();
		expect(wordRange("", 0)).toBeNull();
		expect(wordRange("caffè", 3)).toEqual({ start: 0, end: 5 });
	});

	it("orders the ends of a drag and rejects an empty range", () => {
		expect(rangeBetween(9, 3)).toEqual({ start: 3, end: 9 });
		expect(rangeBetween(3, 9)).toEqual({ start: 3, end: 9 });
		expect(rangeBetween(4, 4)).toBeNull();
		expect(rangeHasText(page, { start: 0, end: 5 })).toBe(true);
		expect(rangeHasText(assemblePageText([run("a   b", 0, 0)]), { start: 1, end: 4 })).toBe(false);
	});

	it("copies a range as text: partial runs, lines joined with a space, hyphenated words joined again", () => {
		expect(selectionText(c, page, { start: 0, end: 5 })).toBe("Hello");
		expect(selectionText(c, page, { start: 6, end: 18 })).toBe("world second");
		// "a broken-" then "word here" is "broken-word" only when the next line starts in lower case: a hyphen kept in front of a capital.
		const all = selectionText(c, page, { start: 0, end: page.text.length });
		expect(all).toBe("Hello world second line a brokenword here");
		const capital = [run("pre-", 0, 0), run("Marx", 0, 20)];
		expect(selectionText(content(capital), assemblePageText(capital), { start: 0, end: 9 })).toBe("pre- Marx");
		// A hyphen inside a line stays.
		const inline = [run("well-known fact", 0, 0)];
		expect(selectionText(content(inline), assemblePageText(inline), { start: 0, end: 15 })).toBe("well-known fact");
	});

	it("joins runs of one line as they are and separates a gap", () => {
		const items2 = [run("foo", 0, 0), run("bar", 30, 0), run("baz", 100, 0)];
		const p2 = assemblePageText(items2);
		expect(selectionText(content(items2), p2, { start: 0, end: p2.text.length })).toBe("foobar baz");
	});

	it("gives one box per line for a range over two lines, a little lower and taller than the run", () => {
		const boxes = selectionBoxes(c, page, { start: 6, end: 17 });
		expect(boxes).toHaveLength(2);
		expect(boxes[0]!.x).toBeCloseTo(72 + 60, 5);
		expect(boxes[0]!.y).toBeCloseTo(101, 5);
		expect(boxes[0]!.height).toBeCloseTo(11.5, 5);
		expect(boxes[1]!.x).toBeCloseTo(72, 5);
		expect(unionBox(boxes)!.width).toBeGreaterThan(0);
		expect(unionBox([])).toBeNull();
	});

	it("tells a tap from a drag", () => {
		expect(isTap(3, 120)).toBe(true);
		expect(isTap(12, 120)).toBe(false);
		expect(isTap(3, 900)).toBe(false);
	});

	it("formats a quote with where it comes from and a link back", () => {
		expect(formatQuote("Selected text", { pdf: "Slides.pdf", pdfPage: 12, link: "[[Notes#p7|Notes, p. 7]]" }))
			.toBe("> Selected text\n>\n> — Slides.pdf, p. 12 · [[Notes#p7|Notes, p. 7]]");
		expect(formatQuote("a\nb", { pdf: "", pdfPage: 3, link: "" })).toBe("> a\n> b\n>\n> — p. 3");
	});
});
