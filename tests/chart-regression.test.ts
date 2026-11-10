import { describe, expect, it } from "vitest";
import { chartGroupId, layoutFor, parseChartGroup, planChartInsert, planChartUpdate, chartOfSelection, type ChartChoice } from "../src/ink/chart";
import { gridAt, tableOfSelection } from "../src/ink/table";
import { readCells } from "../src/ink/table-data";
import { insertTableCommand } from "../src/ink/table-edit";
import { chartDataFromCells, layoutChart } from "../src/math/chart-layout";
import { dashedSegment, fitTrend, trendLabel } from "../src/math/chart-regression";
import { createDocument } from "../src/model/document";
import { History } from "../src/model/history";
import type { Stroke, TextElement } from "../src/model/types";

describe("fitTrend", () => {
	it("fits an exact line with R² 1", () => {
		const f = fitTrend([3, 5, 7, 9])!;
		expect(f.slope).toBeCloseTo(2, 10);
		expect(f.intercept).toBeCloseTo(1, 10);
		expect(f.r2).toBeCloseTo(1, 10);
		expect(f.count).toBe(4);
	});
	it("skips empty rows but keeps row positions", () => {
		const f = fitTrend([1, null, 3, 4])!;
		expect(f.count).toBe(3);
		// points (1,1) (3,3) (4,4)
		expect(f.slope).toBeCloseTo(1, 10);
		expect(f.intercept).toBeCloseTo(0, 10);
	});
	it("is null with fewer than two numbers, and has no R² for a flat series", () => {
		expect(fitTrend([null, 4, null])).toBeNull();
		expect(fitTrend([])).toBeNull();
		const flat = fitTrend([5, 5, 5])!;
		expect(flat.slope).toBe(0);
		expect(flat.r2).toBeNull();
	});
	it("gives R² below 1 for scattered data", () => {
		const f = fitTrend([1, 4, 2, 5, 3])!;
		expect(f.r2!).toBeGreaterThan(0);
		expect(f.r2!).toBeLessThan(1);
	});
});

describe("trendLabel", () => {
	it("writes the equation and R²", () => {
		expect(trendLabel({ count: 4, slope: 2, intercept: 1, r2: 1 })).toBe("y = 2x + 1  R² = 1");
		expect(trendLabel({ count: 4, slope: -0.5, intercept: -2.25, r2: 0.8123 })).toBe("y = -0.5x − 2.25  R² = 0.81");
		expect(trendLabel({ count: 3, slope: 0, intercept: 5, r2: null })).toBe("y = 0x + 5");
		expect(trendLabel({ count: 3, slope: 3, intercept: 0, r2: 0.5 })).toBe("y = 3x  R² = 0.5");
	});
});

describe("dashedSegment", () => {
	it("cuts a line into dashes inside the band", () => {
		const d = dashedSegment([0, 10], [100, 10], 0, 20);
		expect(d.length).toBeGreaterThan(5);
		expect(d[0]![0]).toEqual([0, 10]);
		expect(d.every(([a, b]) => a[1] === 10 && b[0] > a[0])).toBe(true);
		expect(d[d.length - 1]![1][0]).toBeLessThanOrEqual(100);
	});
	it("clips to the band and drops a line outside it", () => {
		const d = dashedSegment([0, -50], [100, 150], 0, 100);
		for (const [a, b] of d) for (const p of [a, b]) {
			expect(p[1]).toBeGreaterThanOrEqual(-1e-9);
			expect(p[1]).toBeLessThanOrEqual(100 + 1e-9);
		}
		expect(dashedSegment([0, 200], [100, 300], 0, 100)).toEqual([]);
		expect(dashedSegment([0, -5], [100, -5], 0, 100)).toEqual([]);
	});
});

const SERIES = [["Month", "Sales"], ["Jan", "10"], ["Feb", "12"], ["Mar", "15"], ["Apr", "19"]];
const box = { x: 0, y: 0, width: 300, height: 200 };

describe("trend line in the layout", () => {
	const data = chartDataFromCells(SERIES);
	const style = { title: "", colours: ["#336699"] };

	it("adds dashes and a label to a line chart only when asked", () => {
		const plain = layoutChart("line", data, style, box);
		const trend = layoutChart("line", data, { ...style, trend: true }, box);
		expect(trend.shapes.length).toBeGreaterThan(plain.shapes.length);
		expect(trend.texts.length).toBe(plain.texts.length + 1);
		const label = trend.texts.find((t) => t.text.startsWith("y = "))!;
		expect(label.text).toContain("R² =");
		expect(label.size).toBe(9);
		// a bar chart and a pie ignore the option
		for (const kind of ["bar", "pie"] as const) {
			expect(layoutChart(kind, data, { ...style, trend: true }, box)).toEqual(layoutChart(kind, data, style, box));
		}
	});

	it("draws nothing extra when there are fewer than two numbers", () => {
		const one = chartDataFromCells([["A", "1"]]);
		expect(layoutChart("line", one, { ...style, trend: true }, box)).toEqual(layoutChart("line", one, style, box));
	});
});

describe("chart group id with a trend (old ids still parse)", () => {
	it("round-trips the trend flag within the id limit", () => {
		const link = { kind: "line" as const, colour: 2, titled: true, trend: true, source: "123e4567-e89b-12d3-a456-426614174000" };
		const id = chartGroupId(link, "abcd1234");
		expect(id.split(".")[1]).toBe("l2tr");
		expect(id.length).toBeLessThanOrEqual(64);
		expect(parseChartGroup(id)).toEqual(link);
		const longest = chartGroupId({ ...link, source: "x".repeat(46) }, "abcd1234");
		expect(longest.length).toBeLessThanOrEqual(64);
		expect(parseChartGroup(longest)).toMatchObject({ trend: true, source: null });
	});
	it("parses 0.29 ids as before, without a trend", () => {
		expect(parseChartGroup("nbc1.l3t.src.abcd1234")).toEqual({ kind: "line", colour: 3, titled: true, source: "src" });
		expect(parseChartGroup("nbc1.b0n.-.abcd1234")).toEqual({ kind: "bar", colour: 0, titled: false, source: null });
	});
	it("writes no trend letter for other kinds and ignores it when read on them", () => {
		expect(chartGroupId({ kind: "bar", colour: 1, titled: false, trend: true, source: "s" }, "r1").split(".")[1]).toBe("b1n");
		expect(parseChartGroup("nbc1.b1nr.s.r1")).toEqual({ kind: "bar", colour: 1, titled: false, source: "s" });
		expect(parseChartGroup("nbc1.l1tx.s.r1")).toBeNull();
	});
	it("layoutFor takes the trend from the link", () => {
		const data = chartDataFromCells(SERIES);
		const a = layoutFor({ kind: "line", colour: 1, trend: true }, data, "", box);
		const b = layoutFor({ kind: "line", colour: 1 }, data, "", box);
		expect(a.shapes.length).toBeGreaterThan(b.shapes.length);
	});
});

describe("a trend survives Update chart", () => {
	let n = 0;
	const ids = () => `r${++n}`;
	const choice: ChartChoice = { kind: "line", title: "Sales", colour: 1, size: "medium", trend: true };

	function make(withTrend: boolean) {
		const doc = createDocument(new Date("2026-11-10T10:00:00.000Z"));
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, null, null, null, null);
		const grid = gridAt({ rows: 5, cols: 2, cellW: 60, cellH: 30 }, 200, 150, { width: page.width, height: page.height });
		const made = insertTableCommand(page, grid, { color: "#1e1e1e", width: 1.5 }, ids);
		history.execute(made.cmd);
		const t = tableOfSelection(page.strokes.filter((s) => s.tool === "shape"), 0)!;
		SERIES.forEach((row, i) => row.forEach((text, j) => {
			const x = (t.grid.xs[j]! + t.grid.xs[j + 1]!) / 2;
			const y = (t.grid.ys[i]! + t.grid.ys[i + 1]!) / 2;
			(page.elements ??= []).push({ id: ids(), type: "text", x: x - 20, y: y - 6, width: 40, text, fontSize: 10, color: "#000000" } as TextElement);
		}));
		const table = tableOfSelection(page.strokes.filter((s) => s.tool === "shape"), 0)!;
		const plan = planChartInsert(page, table, chartDataFromCells(readCells(table.grid, page.elements!)), { ...choice, trend: withTrend }, { x: 0, y: 0 }, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		history.execute(plan.cmd);
		const chart = () => chartOfSelection(page.strokes.filter((x) => x.group === plan.group), page.elements!.filter((e) => e.group === plan.group))!;
		return { doc, page, history, plan, chart };
	}

	it("inserts with the trend in the group id and the label on the chart", () => {
		const w = make(true);
		expect(parseChartGroup(w.plan.group)).toMatchObject({ kind: "line", trend: true });
		expect(w.plan.elements.some((e) => e.text.startsWith("y = "))).toBe(true);
		const without = make(false);
		expect(parseChartGroup(without.plan.group)?.trend).toBeUndefined();
		expect(without.plan.elements.some((e) => e.text.startsWith("y = "))).toBe(false);
	});

	it("keeps the trend when the chart is updated and the title stays the title", () => {
		const w = make(true);
		const edited = w.page.elements!.find((e) => e.type === "text" && e.text === "19" && e.group === undefined) as TextElement;
		w.page.elements![w.page.elements!.indexOf(edited)] = { ...edited, text: "30" };
		const chart = w.chart();
		const plan = planChartUpdate(w.doc.pages, w.page, chart, w.page.strokes as readonly Stroke[], undefined, ids);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(w.history.execute(plan.cmd)).toBe(true);
		const after = w.chart();
		expect(after.link.trend).toBe(true);
		const label = after.elements.find((e) => e.type === "text" && e.text.startsWith("y = ")) as TextElement;
		expect(label).toBeTruthy();
		// the new numbers change the fitted slope
		expect(label.text).not.toBe((chart.elements.find((e) => e.type === "text" && e.text.startsWith("y = ")) as TextElement).text);
		expect(after.elements.some((e) => e.type === "text" && e.text === "Sales")).toBe(true);
		// unchanged afterwards
		expect(planChartUpdate(w.doc.pages, w.page, after, w.page.strokes as readonly Stroke[], undefined, ids)).toEqual({ ok: false, reason: "same" });
	});
});
