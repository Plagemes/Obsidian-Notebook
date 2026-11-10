import { describe, expect, it } from "vitest";
import { entryLine, freshLegend, legendText, parseLegend, reconcileLegend, withEntry, wordsOf } from "../src/model/figure-legend";

describe("the legend text of numbered markers (#247)", () => {
	it("reads numbered lines, a heading, and continuation lines", () => {
		const p = parseLegend("Key\n1. Cell wall\n2) Nucleus\n   in the middle\n3.\n");
		expect(p.head).toEqual(["Key"]);
		expect(p.entries).toEqual([
			{ number: 1, words: "Cell wall" },
			{ number: 2, words: "Nucleus\nin the middle" },
			{ number: 3, words: "" },
		]);
	});

	it("does not take a measurement or a sentence for an entry", () => {
		const p = parseLegend("1. Length\n2.5 mm wide\n10 cells");
		expect(p.entries).toEqual([{ number: 1, words: "Length\n2.5 mm wide\n10 cells" }]);
	});

	it("writes entries back the way they are read", () => {
		const text = "Key\n1. One\n2. Two\n   more\n3.";
		const p = parseLegend(text);
		expect(legendText(p.head, p.entries)).toBe(text);
		expect(entryLine(4, "")).toBe("4.");
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
		expect(wordsOf("1. A\n2. B", 2)).toBe("B");
		expect(wordsOf("1. A", 9)).toBe("");
	});

	it("keeps each description with its marker when the numbers change", () => {
		// marker 2 was deleted: 1 stays, 3 becomes 2, the line of 2 is dropped
		const p = reconcileLegend("1. Wall\n2. Nucleus\n3. Vacuole", [{ from: 1, to: 1 }, { from: 3, to: 2 }]);
		expect(p.text).toBe("1. Wall\n2. Vacuole");
		expect(p.dropped).toBe(1);
		expect(p.added).toBe(0);
	});

	it("gives a marker without a line an empty one, and keeps a heading", () => {
		const p = reconcileLegend("Key\n1. Wall", [{ from: 1, to: 1 }, { from: 2, to: 2 }]);
		expect(p.text).toBe("Key\n1. Wall\n2.");
		expect(p.added).toBe(1);
	});

	it("does not lose the words of a legend reordered by hand", () => {
		const p = reconcileLegend("2. B\n1. A", [{ from: 1, to: 1 }, { from: 2, to: 2 }]);
		expect(p.text).toBe("1. A\n2. B");
	});

	it("gives two markers that carried one number the words only once", () => {
		const p = reconcileLegend("1. A\n2. B", [{ from: 1, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]);
		expect(p.text).toBe("1. A\n2.\n3. B");
		expect(p.added).toBe(1);
	});
});
