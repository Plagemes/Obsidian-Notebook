import { describe, expect, it } from "vitest";
import {
	CHART_MAX_SERIES, chartDataFromCells, clip, countNumbers, decimalsOf, formatValue, layoutChart, niceTicks, parseCellNumber, percentText, pieSlices,
	PIE_MAX_SLICES, type ChartData, type ChartLayout, type ChartPoly,
} from "../src/math/chart-layout";

const box = { x: 20, y: 30, width: 300, height: 200 };
const colours = ["#111111", "#222222", "#333333"];
const data = (labels: string[], ...series: Array<Array<number | null>>): ChartData => ({
	labels, series: series.map((values, i) => ({ name: `S${i + 1}`, values })), skipped: 0, droppedSeries: 0, header: true,
});

const polys = (l: ChartLayout): ChartPoly[] => l.shapes.filter((s): s is ChartPoly => s.type === "poly");
const filled = (l: ChartLayout): ChartPoly[] => polys(l).filter((s) => s.fill !== undefined);

function extent(l: ChartLayout) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const add = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
	for (const s of l.shapes) {
		if (s.type === "circle") { add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); } else for (const [x, y] of s.vertices) add(x, y);
	}
	return { minX, minY, maxX, maxY };
}

describe("parseCellNumber (#244)", () => {
	it("reads plain numbers, a decimal comma and signs", () => {
		expect(parseCellNumber("12")).toBe(12);
		expect(parseCellNumber(" 3.5 ")).toBe(3.5);
		expect(parseCellNumber("3,5")).toBe(3.5);
		expect(parseCellNumber("-4")).toBe(-4);
		expect(parseCellNumber("−4,5")).toBe(-4.5);
		expect(parseCellNumber("+7")).toBe(7);
		expect(parseCellNumber(".5")).toBe(0.5);
	});

	it("reads thousands separators of either kind and drops percent and currency signs", () => {
		expect(parseCellNumber("1.234.567")).toBe(1234567);
		expect(parseCellNumber("1,234,567")).toBe(1234567);
		expect(parseCellNumber("1.234,5")).toBe(1234.5);
		expect(parseCellNumber("1,234.5")).toBe(1234.5);
		expect(parseCellNumber("1 234")).toBe(1234);
		expect(parseCellNumber("45%")).toBe(45);
		expect(parseCellNumber("€ 12,50")).toBe(12.5);
		expect(parseCellNumber("$99")).toBe(99);
		expect(parseCellNumber("12€")).toBe(12);
	});

	it("gives null for anything that is not one number", () => {
		for (const s of ["", "  ", "abc", "12 apples", "1.2.3", "1,2,3x", "10-12", "12/05", "5.", "-", "%", "1.23,45.6", "1e3", "NaN", "Infinity", "1,23.456,7"]) {
			expect(parseCellNumber(s), s).toBeNull();
		}
		expect(parseCellNumber("1.2345.678")).toBeNull();
	});
});

describe("chartDataFromCells (#244)", () => {
	it("takes the first column as labels and the first row as series names when it holds no number", () => {
		const d = chartDataFromCells([["Month", "Sales", "Cost"], ["Jan", "10", "4"], ["Feb", "12,5", "5"], ["Mar", "8", "x"]]);
		expect(d.header).toBe(true);
		expect(d.labels).toEqual(["Jan", "Feb", "Mar"]);
		expect(d.series.map((s) => s.name)).toEqual(["Sales", "Cost"]);
		expect(d.series[0]!.values).toEqual([10, 12.5, 8]);
		expect(d.series[1]!.values).toEqual([4, 5, null]);
		expect(d.skipped).toBe(1);
	});

	it("reads a first row of numbers as data, with no header", () => {
		const d = chartDataFromCells([["a", "1"], ["b", "2"]]);
		expect(d.header).toBe(false);
		expect(d.labels).toEqual(["a", "b"]);
		expect(d.series).toHaveLength(1);
		expect(d.series[0]!.name).toBe("");
		expect(d.series[0]!.values).toEqual([1, 2]);
	});

	it("labels the rows 1, 2, 3 for a one-column table and when a label cell is empty", () => {
		expect(chartDataFromCells([["5"], ["7"], ["9"]]).labels).toEqual(["1", "2", "3"]);
		expect(chartDataFromCells([["x", "1"], ["", "2"]]).labels).toEqual(["x", "2"]);
	});

	it("keeps empty and non-numeric cells as gaps, counts the latter, and skips rows that are empty", () => {
		const d = chartDataFromCells([["h", "v"], ["a", "1"], ["", ""], ["b", ""], ["c", "n/a"], ["d", "4"]]);
		expect(d.labels).toEqual(["a", "b", "c", "d"]);
		expect(d.series[0]!.values).toEqual([1, null, null, 4]);
		expect(d.skipped).toBe(1);
	});

	it("drops a column without a number and reports columns beyond the limit", () => {
		const row = (label: string, v: string) => [label, ...Array.from({ length: 10 }, () => v)];
		const d = chartDataFromCells([["h", ...Array.from({ length: 10 }, (_, i) => `s${i}`)], row("a", "1"), row("b", "2")]);
		expect(d.series).toHaveLength(CHART_MAX_SERIES);
		expect(d.droppedSeries).toBe(2);
		const e = chartDataFromCells([["h", "s1", "s2"], ["a", "1", ""], ["b", "2", "word"]]);
		expect(e.series.map((s) => s.name)).toEqual(["s1"]);
	});

	it("gives nothing for an empty or text-only table", () => {
		expect(chartDataFromCells([])).toMatchObject({ labels: [], series: [] });
		expect(chartDataFromCells([[]])).toMatchObject({ labels: [], series: [] });
		const d = chartDataFromCells([["a", "b"], ["c", "d"]]);
		expect(d.series).toHaveLength(0);
		expect(countNumbers(d)).toBe(0);
		expect(chartDataFromCells([["", ""], ["", ""]]).series).toHaveLength(0);
	});

	it("counts the numbers a chart shows (a pie: its first series only)", () => {
		const d = data(["a", "b"], [1, 2], [3, null]);
		expect(countNumbers(d, "bar")).toBe(3);
		expect(countNumbers(d, "pie")).toBe(2);
	});
});

describe("axis ticks and scales (#244)", () => {
	it("picks round ticks that cover the range", () => {
		expect(niceTicks(0, 10).ticks).toEqual([0, 2, 4, 6, 8, 10]);
		expect(niceTicks(0, 97).ticks).toEqual([0, 20, 40, 60, 80, 100]);
		const t = niceTicks(3, 47);
		expect(t.lo).toBeLessThanOrEqual(3);
		expect(t.hi).toBeGreaterThanOrEqual(47);
		expect(t.ticks.length).toBeGreaterThanOrEqual(3);
		expect(t.ticks.length).toBeLessThanOrEqual(8);
		expect(niceTicks(0, 0.7).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
		expect(niceTicks(-5, 5).ticks).toContain(0);
	});

	it("gives evenly spaced ticks with no float noise", () => {
		const t = niceTicks(0, 1);
		expect(t.ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
		const big = niceTicks(0, 1234567);
		for (let i = 1; i < big.ticks.length; i++) expect(big.ticks[i]! - big.ticks[i - 1]!).toBeCloseTo(big.step, 6);
	});

	it("widens a flat range and survives bad input", () => {
		expect(niceTicks(5, 5).lo).toBe(0);
		expect(niceTicks(5, 5).hi).toBeGreaterThanOrEqual(5);
		expect(niceTicks(-5, -5).hi).toBe(0);
		expect(niceTicks(0, 0).ticks.length).toBeGreaterThanOrEqual(2);
		expect(niceTicks(NaN, NaN).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
		expect(niceTicks(10, 0).ticks[0]).toBe(0);
	});

	it("writes values with only the decimals they need", () => {
		expect(decimalsOf(0.2)).toBe(1);
		expect(decimalsOf(5)).toBe(0);
		expect(decimalsOf(0.05)).toBe(2);
		expect(formatValue(12.5)).toBe("12.5");
		expect(formatValue(3)).toBe("3");
		expect(formatValue(0.1 + 0.2)).toBe("0.3");
		expect(formatValue(1500000)).toBe("1.5M");
		expect(formatValue(40, 20)).toBe("40");
		expect(formatValue(0.4, 0.2)).toBe("0.4");
		expect(formatValue(NaN)).toBe("");
	});

	it("clips with an ellipsis", () => {
		expect(clip("abcdef", 4)).toBe("abc…");
		expect(clip("abc", 4)).toBe("abc");
		expect(clip("abc", 1)).toBe("…");
	});
});

describe("pie slices (#244)", () => {
	it("starts at the top and goes clockwise to a full turn", () => {
		const s = pieSlices(["a", "b", "c"], [1, 1, 2]);
		expect(s).toHaveLength(3);
		expect(s[0]!.start).toBeCloseTo(-Math.PI / 2);
		expect(s[0]!.fraction).toBeCloseTo(0.25);
		expect(s[0]!.end).toBeCloseTo(s[1]!.start);
		expect(s[2]!.end).toBeCloseTo(-Math.PI / 2 + 2 * Math.PI);
		expect(s.reduce((n, x) => n + x.fraction, 0)).toBeCloseTo(1);
		expect(s[2]!.end - s[2]!.start).toBeCloseTo(Math.PI);
	});

	it("leaves out zero, negative and missing values, and gives nothing for a total that is not positive", () => {
		const s = pieSlices(["a", "b", "c", "d"], [3, 0, -2, null]);
		expect(s.map((x) => x.label)).toEqual(["a"]);
		expect(s[0]!.fraction).toBe(1);
		expect(pieSlices(["a"], [0])).toEqual([]);
		expect(pieSlices(["a", "b"], [-1, null])).toEqual([]);
		expect(pieSlices([], [])).toEqual([]);
	});

	it("joins the smallest slices beyond the limit into one that comes last", () => {
		const labels = Array.from({ length: 15 }, (_, i) => `L${i}`);
		const values = Array.from({ length: 15 }, (_, i) => 100 - i);
		const s = pieSlices(labels, values, "Other");
		expect(s).toHaveLength(PIE_MAX_SLICES);
		expect(s[s.length - 1]!.label).toBe("Other");
		expect(s[s.length - 1]!.value).toBe(values.slice(PIE_MAX_SLICES - 1).reduce((a, b) => a + b, 0));
		expect(s.slice(0, -1).map((x) => x.label)).toEqual(labels.slice(0, PIE_MAX_SLICES - 1));
		expect(s.reduce((n, x) => n + x.fraction, 0)).toBeCloseTo(1);
	});

	it("writes shares, with a floor for tiny ones", () => {
		expect(percentText(0.256)).toBe("26");
		expect(percentText(0.001)).toBe("<1");
		expect(percentText(1)).toBe("100");
	});
});

describe("chart layout (#244)", () => {
	it("draws the frame first and the title at the top left", () => {
		const l = layoutChart("bar", data(["a", "b"], [1, 2]), { title: "Sales", colours }, box);
		const frame = l.shapes[0] as ChartPoly;
		expect(frame.closed).toBe(true);
		expect(frame.vertices[0]).toEqual([box.x, box.y]);
		expect(frame.vertices[2]).toEqual([box.x + box.width, box.y + box.height]);
		const title = l.texts.find((t) => t.text === "Sales")!;
		expect(title.x).toBeGreaterThan(box.x);
		expect(title.y).toBeGreaterThan(box.y);
		expect(title.y).toBeLessThan(box.y + 20);
	});

	it("keeps every shape inside the box, whatever the kind", () => {
		const d = data(["Jan", "Feb", "Mar", "Apr"], [10, 35, -8, 22], [5, null, 18, 9]);
		for (const kind of ["bar", "line", "pie"] as const) {
			const e = extent(layoutChart(kind, d, { title: "T", colours }, box));
			expect(e.minX, kind).toBeGreaterThanOrEqual(box.x - 1e-6);
			expect(e.minY, kind).toBeGreaterThanOrEqual(box.y - 1e-6);
			expect(e.maxX, kind).toBeLessThanOrEqual(box.x + box.width + 1e-6);
			expect(e.maxY, kind).toBeLessThanOrEqual(box.y + box.height + 1e-6);
		}
	});

	it("draws one filled bar per number, from the zero line, taller for larger values", () => {
		const l = layoutChart("bar", data(["a", "b", "c"], [10, 20, 40]), { title: "", colours }, box);
		const bars = filled(l);
		expect(bars).toHaveLength(3);
		const heights = bars.map((b) => b.vertices[2]![1] - b.vertices[0]![1]);
		expect(heights[1]!).toBeCloseTo(heights[0]! * 2, 5);
		expect(heights[2]!).toBeCloseTo(heights[0]! * 4, 5);
		expect(bars.every((b) => b.fill === colours[0] && b.closed)).toBe(true);
		// left to right, all standing on the same line
		expect(bars[0]!.vertices[0]![0]).toBeLessThan(bars[1]!.vertices[0]![0]);
		expect(new Set(bars.map((b) => b.vertices[2]![1])).size).toBe(1);
	});

	it("hangs negative bars below the zero line and gaps leave no bar", () => {
		const l = layoutChart("bar", data(["a", "b", "c"], [10, -10, null]), { title: "", colours }, box);
		const bars = filled(l);
		expect(bars).toHaveLength(2);
		expect(bars[0]!.vertices[2]![1]).toBeCloseTo(bars[1]!.vertices[0]![1], 5);
	});

	it("groups the bars of several series and adds a legend", () => {
		const l = layoutChart("bar", data(["a", "b"], [1, 2], [2, 1]), { title: "", colours }, box);
		const bars = filled(l).filter((b) => b.vertices[2]![0] - b.vertices[0]![0] > 9);
		expect(bars).toHaveLength(4);
		expect(bars.map((b) => b.fill)).toEqual([colours[0], colours[0], colours[1], colours[1]]);
		expect(l.texts.map((t) => t.text)).toEqual(expect.arrayContaining(["S1", "S2"]));
	});

	it("draws a line chart as one polyline per run of numbers with a dot per number", () => {
		const l = layoutChart("line", data(["a", "b", "c", "d", "e"], [1, 2, null, 4, 5]), { title: "", colours }, box);
		const lines = polys(l).filter((p) => p.width === 2);
		expect(lines).toHaveLength(2);
		expect(lines.map((p) => p.vertices.length)).toEqual([2, 2]);
		expect(l.shapes.filter((s) => s.type === "circle")).toHaveLength(4);
		// a rising series climbs the page (smaller y)
		expect(lines[0]!.vertices[1]![1]).toBeLessThan(lines[0]!.vertices[0]![1]);
	});

	it("draws one dot and no line for a lone number", () => {
		const l = layoutChart("line", data(["a", "b", "c"], [null, 5, null]), { title: "", colours }, box);
		expect(polys(l).filter((p) => p.width === 2)).toHaveLength(0);
		expect(l.shapes.filter((s) => s.type === "circle")).toHaveLength(1);
	});

	it("draws a wedge per slice and a legend row with the shares", () => {
		const l = layoutChart("pie", data(["Apples", "Pears"], [3, 1]), { title: "", colours }, box);
		const wedges = filled(l).filter((p) => p.vertices.length > 4);
		expect(wedges).toHaveLength(2);
		expect(wedges[0]!.fill).toBe(colours[0]);
		expect(wedges[1]!.fill).toBe(colours[1]);
		expect(l.texts.map((t) => t.text)).toEqual(["Apples 75%", "Pears 25%"]);
	});

	it("draws a lone slice as a full circle", () => {
		const l = layoutChart("pie", data(["only"], [5]), { title: "", colours }, box);
		expect(l.shapes.filter((s) => s.type === "circle")).toHaveLength(1);
	});

	it("uses the first series of a table with several for a pie, and the colours round", () => {
		const l = layoutChart("pie", data(["a", "b", "c", "d"], [1, 1, 1, 1], [9, 9, 9, 9]), { title: "", colours }, box);
		const wedges = filled(l).filter((p) => p.vertices.length > 4);
		expect(wedges.map((w) => w.fill)).toEqual([colours[0], colours[1], colours[2], colours[0]]);
		expect(l.texts.every((t) => t.text.endsWith("25%"))).toBe(true);
	});

	it("gives only the frame and the title when there is nothing to show", () => {
		const none = data(["a"], [null]);
		for (const kind of ["bar", "line", "pie"] as const) {
			const l = layoutChart(kind, none, { title: "T", colours }, box);
			expect(l.shapes).toHaveLength(1);
			expect(l.texts.map((t) => t.text)).toEqual(["T"]);
		}
		const neg = layoutChart("pie", data(["a", "b"], [-1, 0]), { title: "", colours }, box);
		expect(neg.shapes).toHaveLength(1);
	});

	it("survives a box too small to draw in", () => {
		const l = layoutChart("bar", data(["a"], [1]), { title: "A title that is far too long for this box", colours }, { x: 0, y: 0, width: 40, height: 30 });
		expect(l.shapes.length).toBeGreaterThanOrEqual(1);
		const tiny = layoutChart("pie", data(["a"], [1]), { title: "", colours }, { x: 0, y: 0, width: 30, height: 20 });
		expect(tiny.shapes.length).toBeGreaterThanOrEqual(1);
	});

	it("is deterministic and writes every number finite", () => {
		const d = data(["a", "b", "c"], [1.5, 2.25, 3.125]);
		const a = layoutChart("line", d, { title: "x", colours }, box);
		expect(layoutChart("line", d, { title: "x", colours }, box)).toEqual(a);
		for (const s of a.shapes) {
			const nums = s.type === "circle" ? [s.cx, s.cy, s.r] : s.vertices.flat();
			expect(nums.every(Number.isFinite)).toBe(true);
		}
		expect(a.texts.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y) && t.width > 0)).toBe(true);
	});

	it("shows every other label when the bands are narrow, and clips long ones", () => {
		const labels = Array.from({ length: 20 }, (_, i) => `Category ${i}`);
		const l = layoutChart("bar", data(labels, labels.map((_, i) => i + 1)), { title: "", colours }, { ...box, width: 260 });
		const shown = l.texts.filter((t) => t.text.startsWith("C") || t.text.endsWith("…"));
		expect(shown.length).toBeLessThan(20);
		expect(shown.length).toBeGreaterThan(2);
		expect(shown.every((t) => Array.from(t.text).length <= 12)).toBe(true);
	});
});
