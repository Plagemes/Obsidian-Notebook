import { describe, expect, it } from "vitest";
import { freshLegend, parseLegend, reconcileLegend, withEntry, wordsOf } from "../src/model/figure-legend";

const words = (text: string) => parseLegend(text).entries.map((e) => ({ number: e.number, words: e.words }));

describe("the legend text of numbered markers (#247)", () => {
	it("reads numbered lines, a heading, and indented continuation lines", () => {
		const p = parseLegend("Key\n1. Cell wall\n2) Nucleus\n   in the middle\n3.\n");
		expect(p.lines).toEqual(["Key", "1. Cell wall", "2) Nucleus", "   in the middle", "3.", ""]);
		expect(words("Key\n1. Cell wall\n2) Nucleus\n   in the middle\n3.\n")).toEqual([
			{ number: 1, words: "Cell wall" },
			{ number: 2, words: "Nucleus\nin the middle" },
			{ number: 3, words: "" },
		]);
		expect(p.entries[1]).toMatchObject({ start: 2, end: 4 });
	});

	it("does not take a measurement or a sentence for an entry, nor an unindented line for a description", () => {
		expect(words("1. Length\n2.5 mm wide\n10 cells")).toEqual([{ number: 1, words: "Length" }]);
	});

	it("review I3 (a): a note after a blank line is free text, never the description of the last entry", () => {
		expect(words("1. A\n2. B\n\n   Source: textbook p.4")).toEqual([{ number: 1, words: "A" }, { number: 2, words: "B" }]);
	});

	it("reads CRLF lines without taking the \\r for words", () => {
		expect(words("1. A\r\n2. B\r\n")).toEqual([{ number: 1, words: "A" }, { number: 2, words: "B" }]);
	});

	it("starts a fresh legend with an empty line per number", () => {
		expect(freshLegend([2, 1])).toBe("1.\n2.");
		expect(freshLegend([])).toBe("");
	});

	it("adds the line of a new marker without touching the words already typed", () => {
		expect(withEntry("1. Cell wall\n2. Nucleus", 3)).toBe("1. Cell wall\n2. Nucleus\n3.");
		expect(withEntry("1. A\n3. C", 2)).toBe("1. A\n2.\n3. C");
		expect(withEntry("Key\n1. A", 2)).toBe("Key\n1. A\n2.");
		expect(withEntry("1. A", 1)).toBe("1. A");
		expect(withEntry("", 1)).toBe("1.");
		expect(withEntry("Key\n", 1)).toBe("Key\n1.\n");
		expect(wordsOf("1. A\n2. B", 2)).toBe("B");
		expect(wordsOf("1. A", 9)).toBe("");
	});

	it("review I2: Add keeps blank lines, indentation, separators and trailing notes as typed", () => {
		const typed = "Key\n\n1) Wall\n     thick here\n\n2) Nucleus\n\nSource: p.4\n";
		// one line spliced after the last entry; the blank spacer, the note and the final newline stay; the new line is written like its neighbour
		expect(withEntry(typed, 3)).toBe("Key\n\n1) Wall\n     thick here\n\n2) Nucleus\n3)\n\nSource: p.4\n");
		expect(withEntry("  1. A\n  2. B", 3)).toBe("  1. A\n  2. B\n  3.");
		// the result never has fewer lines than before
		expect(withEntry(typed, 3).split("\n").length).toBe(typed.split("\n").length + 1);
	});

	it("keeps each description with its marker when the numbers change", () => {
		// marker 2 was deleted: 1 stays, 3 becomes 2, the line of 2 is removed and reported
		const p = reconcileLegend("1. Wall\n2. Nucleus\n3. Vacuole", [{ from: 1, to: 1 }, { from: 3, to: 2 }]);
		expect(p.text).toBe("1. Wall\n2. Vacuole");
		expect(p.dropped).toBe(1);
		expect(p.removed).toEqual(["2. Nucleus"]);
		expect(p.added).toBe(0);
	});

	it("removes an empty line of a deleted marker without reporting words", () => {
		const p = reconcileLegend("1. Wall\n2.\n3. Vacuole", [{ from: 1, to: 1 }, { from: 3, to: 2 }]);
		expect(p.text).toBe("1. Wall\n2. Vacuole");
		expect(p.dropped).toBe(1);
		expect(p.removed).toEqual([]);
	});

	it("gives a marker without a line an empty one, and keeps a heading", () => {
		const p = reconcileLegend("Key\n1. Wall", [{ from: 1, to: 1 }, { from: 2, to: 2 }]);
		expect(p.text).toBe("Key\n1. Wall\n2.");
		expect(p.added).toBe(1);
		expect(reconcileLegend("Key\n", [{ from: 1, to: 1 }]).text).toBe("Key\n1.\n");
	});

	it("leaves a legend reordered by hand in its order (only numbers change, in place)", () => {
		expect(reconcileLegend("2. B\n1. A", [{ from: 1, to: 1 }, { from: 2, to: 2 }]).text).toBe("2. B\n1. A");
		expect(reconcileLegend("3. C\n1. A", [{ from: 1, to: 1 }, { from: 3, to: 2 }]).text).toBe("2. C\n1. A");
	});

	it("gives two markers that carried one number the words only once", () => {
		const p = reconcileLegend("1. A\n2. B", [{ from: 1, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]);
		expect(p.text).toBe("1. A\n2.\n3. B");
		expect(p.added).toBe(1);
	});

	it("review I2/I3: renumbering keeps blank lines, indentation, separators and the person's notes", () => {
		const typed = "Key\n\n  1) Wall\n       thick here\n\n  3) Vacuole\n\nSource: textbook p.4\n";
		const p = reconcileLegend(typed, [{ from: 1, to: 1 }, { from: 3, to: 2 }]);
		expect(p.text).toBe("Key\n\n  1) Wall\n       thick here\n\n  2) Vacuole\n\nSource: textbook p.4\n");
		expect(p.dropped).toBe(0);
	});

	it("review I3 (a): the note after the entries stays when the last marker is gone", () => {
		const p = reconcileLegend("1. Wall\n2. Nucleus\n\nSource: textbook p.4", [{ from: 1, to: 1 }]);
		expect(p.text).toBe("1. Wall\n\nSource: textbook p.4");
		expect(p.removed).toEqual(["2. Nucleus"]);
		// an unindented line right under the entry is free text too, so it stays
		expect(reconcileLegend("1. Wall\n2. Nucleus\nSource: p.4", [{ from: 1, to: 1 }]).text).toBe("1. Wall\nSource: p.4");
	});

	it("review I3 (b): two entries with one number both follow their marker, none is dropped silently", () => {
		const p = reconcileLegend("1. A\n3. B\n3. C", [{ from: 1, to: 1 }, { from: 3, to: 2 }]);
		expect(p.text).toBe("1. A\n2. B\n2. C");
		expect(p.shared).toBe(1);
		expect(p.dropped).toBe(0);
		// both lines of a deleted number are removed AND reported, each one
		const q = reconcileLegend("1. A\n2. B\n2. C", [{ from: 1, to: 1 }]);
		expect(q.text).toBe("1. A");
		expect(q.dropped).toBe(2);
		expect(q.removed).toEqual(["2. B", "2. C"]);
	});

	it("review I3 (d): a line that looks like an entry is reported with its words when it would go", () => {
		const p = reconcileLegend("1. Soil\n   samples from\n10. Mai sampled", [{ from: 1, to: 1 }]);
		expect(p.text).toBe("1. Soil\n   samples from");
		expect(p.removed).toEqual(["10. Mai sampled"]);
	});

	it("removes the indented lines of a deleted entry with it, and reports them", () => {
		const p = reconcileLegend("1. A\n2. B\n   more of B\n3. C", [{ from: 1, to: 1 }, { from: 3, to: 2 }]);
		expect(p.text).toBe("1. A\n2. C");
		expect(p.removed).toEqual(["2. B\n   more of B"]);
	});

	it("keeps CRLF line ends", () => {
		expect(reconcileLegend("1. A\r\n3. C\r\n", [{ from: 1, to: 1 }, { from: 3, to: 2 }]).text).toBe("1. A\r\n2. C\r\n");
	});
});
