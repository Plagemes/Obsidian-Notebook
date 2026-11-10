import { describe, expect, it } from "vitest";
import { fmt, numbersOf, parseCellNumber, regress, summarize } from "../src/math/stats";
import { hasHeaderRow, readTableCells } from "../src/ink/table-numbers";
import { boxBeside, lineText, modelOf, reportOf, reportText, type ReportWords } from "../src/ink/table-report";
import type { TextElement } from "../src/model/types";

const text = (x: number, y: number, s: string, width = 40): TextElement => ({ id: `${x}-${y}`, type: "text", x, y, width, text: s, fontSize: 12, color: "#000000" });

describe("parseCellNumber", () => {
	it("reads integers, decimals, a decimal comma and signs", () => {
		expect(parseCellNumber("12")).toBe(12);
		expect(parseCellNumber(" 3.5 ")).toBe(3.5);
		expect(parseCellNumber("3,5")).toBe(3.5);
		expect(parseCellNumber("-2")).toBe(-2);
		expect(parseCellNumber("−2,5")).toBe(-2.5);
		expect(parseCellNumber("+4")).toBe(4);
		expect(parseCellNumber(".5")).toBe(0.5);
		expect(parseCellNumber("1e3")).toBe(1000);
	});
	it("takes the last separator as the decimal mark when both appear", () => {
		expect(parseCellNumber("1.234,5")).toBe(1234.5);
		expect(parseCellNumber("1,234.5")).toBe(1234.5);
		expect(parseCellNumber("1 234,5")).toBe(1234.5);
	});
	it("rejects what is not a number", () => {
		for (const s of ["", "  ", "abc", "3 kg", "1,2,3", "--1", "NaN", "Infinity", "1/2", "-"]) expect(parseCellNumber(s)).toBeNull();
	});
});

describe("numbersOf and summarize", () => {
	it("skips non-numeric cells, counts them, and ignores empty ones", () => {
		const r = numbersOf(["1", "", "x", "2,5", "  ", "n/a"]);
		expect(r.values).toEqual([1, 2.5]);
		expect(r.skipped).toBe(2);
	});
	it("is null for an empty column or one without numbers", () => {
		expect(summarize([])).toBeNull();
		expect(summarize(["", "a"])).toBeNull();
	});
	it("handles one value", () => {
		const s = summarize(["7"])!;
		expect(s).toMatchObject({ count: 1, mean: 7, median: 7, min: 7, max: 7, sum: 7, sdPop: 0 });
		expect(s.sd).toBeNull();
	});
	it("computes mean, median (odd and even), deviations, extremes", () => {
		const odd = summarize(["2", "4", "4", "4", "5", "5", "7", "9"])!;
		expect(odd.mean).toBe(5);
		expect(odd.median).toBe(4.5);
		expect(odd.sdPop).toBeCloseTo(2, 10);
		expect(odd.sd).toBeCloseTo(Math.sqrt(32 / 7), 10);
		expect(odd.min).toBe(2);
		expect(odd.max).toBe(9);
		const even = summarize(["3", "1", "2"])!;
		expect(even.median).toBe(2);
		expect(even.sum).toBe(6);
	});
	it("counts the skipped cells in the summary", () => {
		expect(summarize(["1", "x", "3"])).toMatchObject({ count: 2, skipped: 1, mean: 2 });
	});
});

describe("regress", () => {
	it("fits an exact line", () => {
		const g = regress(["1", "2", "3", "4"], ["3", "5", "7", "9"])!;
		expect(g.slope).toBeCloseTo(2, 10);
		expect(g.intercept).toBeCloseTo(1, 10);
		expect(g.r2).toBeCloseTo(1, 10);
		expect(g.count).toBe(4);
	});
	it("gives r2 below 1 for noisy data", () => {
		const g = regress(["1", "2", "3", "4", "5"], ["2", "4.5", "5", "8.5", "9"])!;
		expect(g.r2!).toBeGreaterThan(0.9);
		expect(g.r2!).toBeLessThan(1);
	});
	it("accepts decimal commas and counts rows with a non-number", () => {
		const g = regress(["1", "2,5", "x", "4", ""], ["2", "5", "9", "8", ""])!;
		expect(g.count).toBe(3);
		expect(g.skipped).toBe(1);
		expect(g.slope).toBeCloseTo(2, 10);
	});
	it("is null with fewer than two rows or equal x", () => {
		expect(regress(["1"], ["2"])).toBeNull();
		expect(regress(["2", "2"], ["1", "3"])).toBeNull();
		expect(regress([], [])).toBeNull();
	});
	it("has an undefined r2 when y does not vary", () => {
		const g = regress(["1", "2", "3"], ["5", "5", "5"])!;
		expect(g.slope).toBe(0);
		expect(g.intercept).toBe(5);
		expect(g.r2).toBeNull();
	});
});

describe("fmt", () => {
	it("trims digits and the negative zero", () => {
		expect(fmt(1 / 3)).toBe("0.333333");
		expect(fmt(2)).toBe("2");
		expect(fmt(-0)).toBe("0");
		expect(fmt(Number.NaN)).toBe("-");
	});
});

describe("readTableCells", () => {
	const grid = { xs: [0, 100, 200], ys: [0, 30, 60, 90] };
	it("puts each text box in the cell that holds the middle of its first line", () => {
		const cells = readTableCells(grid, [text(5, 5, "Name"), text(105, 5, "Value"), text(5, 35, "a"), text(105, 35, "3,5"), text(105, 65, "4")]);
		expect(cells).toEqual([["Name", "Value"], ["a", "3,5"], ["", "4"]]);
	});
	it("ignores boxes outside the grid and non-text elements, and joins boxes in one cell in reading order", () => {
		const cells = readTableCells(grid, [text(300, 5, "out"), text(110, 10, "second"), text(105, 4, "first"), { id: "i", type: "image", asset: "a", x: 5, y: 5, width: 5, height: 5, rotation: 0 }]);
		expect(cells[0]).toEqual(["", "first second"]);
	});
});

describe("model and report", () => {
	const cells = [["x", "y", "note"], ["1", "3", "a"], ["2", "5", "b"], ["3", "7", "c"], ["z", "9", ""]];
	it("takes a words-over-numbers first row as the header", () => {
		expect(hasHeaderRow(cells, (s) => parseCellNumber(s) !== null)).toBe(true);
		expect(hasHeaderRow([["1", "2"], ["3", "4"]], (s) => parseCellNumber(s) !== null)).toBe(false);
		const m = modelOf(cells, 3);
		expect(m.header).toBe(true);
		expect(m.names).toEqual(["x", "y", "note"]);
		expect(m.numeric).toEqual([0, 1]);
		expect(m.data.length).toBe(4);
	});
	it("reports a column and a regression", () => {
		const m = modelOf(cells, 3);
		const r = reportOf(m, 0, 1);
		expect(r.summary).toMatchObject({ count: 3, skipped: 1, mean: 2 });
		expect(r.regression!.slope).toBeCloseTo(2, 10);
		expect(reportOf(m, 0, 0).against).toBeNull();
		expect(lineText({ count: 3, skipped: 0, slope: 2, intercept: 1, r2: 1 })).toBe("y = 2x + 1");
		expect(lineText({ count: 3, skipped: 0, slope: -0.5, intercept: -2, r2: 1 })).toBe("y = -0.5x - 2");
		expect(lineText({ count: 3, skipped: 0, slope: 1, intercept: 0, r2: 1 })).toBe("y = 1x");
	});
	it("writes the report as plain text", () => {
		const w: ReportWords = {
			column: (n, i) => n || `Col ${i + 1}`, title: (c) => `Stats ${c}`, count: (n, s) => (s ? `${n} values (${s} skipped)` : `${n} values`),
			mean: "Mean", median: "Median", sd: "SD", min: "Min", max: "Max", sum: "Sum", regressionTitle: (y, x) => `Line ${y}~${x}`, line: "Line",
			notEnough: "not enough", noNumbers: "none",
		};
		const m = modelOf(cells, 3);
		const out = reportText(m, reportOf(m, 0, 1), w, { slope: "Slope", intercept: "Intercept", r2: "R2" });
		expect(out).toContain("Stats x");
		expect(out).toContain("3 values (1 skipped)");
		expect(out).toContain("Mean: 2");
		expect(out).toContain("Line y~x");
		expect(out).toContain("y = 2x + 1");
		expect(out).toContain("R2: 1");
		expect(reportText(m, reportOf(m, 2, null), w, { slope: "", intercept: "", r2: "" })).toContain("none");
	});
});

describe("boxBeside", () => {
	const grid = { xs: [20, 120], ys: [20, 80] };
	it("goes to the right of the table when there is room", () => {
		expect(boxBeside(grid, { width: 400, height: 600 }, 150)).toEqual({ x: 134, y: 20, width: 150 });
	});
	it("goes under the table when the right is too narrow, and stays inside the page", () => {
		const b = boxBeside(grid, { width: 200, height: 600 }, 150);
		expect(b).toEqual({ x: 20, y: 94, width: 150 });
		const narrow = boxBeside(grid, { width: 100, height: 600 }, 150);
		expect(narrow.x + narrow.width).toBeLessThanOrEqual(100);
	});
});
