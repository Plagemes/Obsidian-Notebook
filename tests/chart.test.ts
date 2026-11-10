import { describe, expect, it } from "vitest";
import {
	buildChart, chartColours, chartGroupId, chartOfSelection, chartSize, CHART_COLOURS, findSourceTable, layoutFor, parseChartGroup, placeChart,
	planChartInsert, planChartUpdate, tableInSelection, type ChartChoice, type ChartLink,
} from "../src/ink/chart";
import { gridAt, tableOfSelection } from "../src/ink/table";
import { cellAnchor, cellText, readCells } from "../src/ink/table-data";
import { insertTableCommand } from "../src/ink/table-edit";
import { chartDataFromCells } from "../src/math/chart-layout";
import { createDocument, createPage } from "../src/model/document";
import { groupRenamer } from "../src/model/groups";
import { History } from "../src/model/history";
import { pageRules, pageScope } from "../src/model/page-undo";
import { serializeChecked } from "../src/model/serialize";
import type { EquationElement, NotebookDocument, Page, PageElement, Stroke, TextElement } from "../src/model/types";
import { line } from "./helpers";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const spec = { rows: 4, cols: 3, cellW: 60, cellH: 30 };
const style = { color: "#1e1e1e", width: 1.5 };
const choice: ChartChoice = { kind: "bar", title: "Sales", colour: 1, size: "medium" };
let n = 0;
const ids = () => `i${++n}`;

function setup(): { doc: NotebookDocument; page: Page; history: History; group: string } {
	const doc = createDocument(NOW);
	const page = doc.pages[0]!;
	const history = new History(() => doc, 100, null, null, null, null);
	const grid = gridAt(spec, 200, 150, { width: page.width, height: page.height });
	const made = insertTableCommand(page, grid, style, ids);
	expect(history.execute(made.cmd)).toBe(true);
	return { doc, page, history, group: made.group };
}

/** A text box in the middle of a cell of the table the group is. */
function cellBox(page: Page, row: number, col: number, text: string): TextElement {
	const t = tableOfSelection(page.strokes.filter((s) => s.tool === "shape"), 0)!;
	const x = (t.grid.xs[col]! + t.grid.xs[col + 1]!) / 2;
	const y = (t.grid.ys[row]! + t.grid.ys[row + 1]!) / 2;
	return { id: ids(), type: "text", x: x - 20, y: y - 6, width: 40, text, fontSize: 10, color: "#000000" };
}

function fill(page: Page, rows: string[][]): void {
	rows.forEach((r, i) => r.forEach((text, j) => { if (text !== "") (page.elements ??= []).push(cellBox(page, i, j, text)); }));
}

const SALES = [["Month", "Sales", "Cost"], ["Jan", "10", "4"], ["Feb", "12", "5"], ["Mar", "8", "6"]];

describe("the chart group id (#244)", () => {
	it("round-trips the link and stays within the group id limit", () => {
		const link: ChartLink = { kind: "line", colour: 5, titled: true, source: "123e4567-e89b-12d3-a456-426614174000" };
		const id = chartGroupId(link, "abcd1234");
		expect(id.length).toBeLessThanOrEqual(64);
		expect(parseChartGroup(id)).toEqual(link);
		expect(parseChartGroup(chartGroupId({ ...link, kind: "pie", titled: false }))).toMatchObject({ kind: "pie", titled: false, colour: 5 });
	});

	it("writes no link for a source it cannot hold, and reads other groups as not charts", () => {
		const long = chartGroupId({ kind: "bar", colour: 0, titled: false, source: "x".repeat(60) });
		expect(long.length).toBeLessThanOrEqual(64);
		expect(parseChartGroup(long)).toMatchObject({ source: null });
		expect(parseChartGroup(chartGroupId({ kind: "bar", colour: 0, titled: false, source: "a.b" }))).toMatchObject({ source: null });
		for (const g of [undefined, "", "g1", "123e4567-e89b-12d3-a456-426614174000", "nbc1.b0t.src", "nbc1.x0t.src.rand", "nbc1.b9t.src.rand", "nbc2.b0t.src.rand", "nbc1.b0t..rand", "nbc1.b0t.s.r.extra"]) {
			expect(parseChartGroup(g), String(g)).toBeNull();
		}
	});

	it("gives the palette round from the first colour", () => {
		expect(chartColours(0)).toHaveLength(CHART_COLOURS);
		expect(chartColours(2)[0]).not.toBe(chartColours(0)[0]);
		expect(chartColours(2)[CHART_COLOURS - 1]).toBe(chartColours(1)[0]);
		expect(chartColours(99)[0]).toBe(chartColours(CHART_COLOURS - 1)[0]);
		expect(chartColours(NaN)[0]).toBe(chartColours(0)[0]);
	});
});

describe("reading the cells of a table (#244)", () => {
	it("puts each text box in the cell its first line is in", () => {
		const { page } = setup();
		fill(page, SALES);
		const t = tableOfSelection(page.strokes, 0)!;
		const cells = readCells(t.grid, page.elements!);
		expect(cells).toEqual(SALES);
	});

	it("joins several boxes of one cell top to bottom, and ignores boxes outside the table and other elements", () => {
		const { page } = setup();
		const t = tableOfSelection(page.strokes, 0)!;
		const a = cellBox(page, 1, 1, "1");
		const b = { ...cellBox(page, 1, 1, "000"), y: a.y + 8 };
		const outside: TextElement = { ...cellBox(page, 0, 0, "far"), x: 400, y: 600 };
		const sticky = { id: "s", type: "checkbox", x: t.grid.xs[1]! + 5, y: t.grid.ys[1]! + 5 } as unknown as PageElement;
		page.elements = [b, a, outside, sticky];
		const cells = readCells(t.grid, page.elements);
		expect(cells[1]![1]).toBe("1 000");
		expect(cells.flat().filter((c) => c !== "")).toHaveLength(1);
		expect(cells).toHaveLength(4);
		expect(cells[0]).toHaveLength(3);
	});

	it("reads a typeset number as a cell and leaves other markup alone", () => {
		const eq: EquationElement = { id: "e", type: "equation", x: 0, y: 0, width: 20, height: 10, latex: "12{,}5\\,", fontSize: 12, color: "#000000" };
		expect(cellText(eq)).toBe("12,5");
		expect(cellAnchor(eq)).toEqual({ x: 10, y: 5 });
		const text: TextElement = { id: "t", type: "text", x: 10, y: 20, width: 100, text: "ab\ncd", fontSize: 10, color: "#000" };
		expect(cellText(text)).toBe("ab cd");
		expect(cellAnchor(text)!.y).toBeCloseTo(26.25);
	});
});

describe("inserting a chart (#244)", () => {
	it("adds the chart as one group of shape strokes and text boxes in one undo step", () => {
		const { doc, page, history, group } = setup();
		fill(page, SALES);
		const t = tableOfSelection(page.strokes, 0)!;
		const data = chartDataFromCells(readCells(t.grid, page.elements!));
		const before = { s: page.strokes.length, e: page.elements!.length };
		const plan = planChartInsert(page, t, data, choice, { x: 300, y: 400 }, "Other", ids);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(history.execute(plan.cmd)).toBe(true);
		expect(page.strokes.length).toBe(before.s + plan.strokes.length);
		expect(page.elements!.length).toBe(before.e + plan.elements.length);
		expect(plan.strokes.every((s) => s.group === plan.group && s.tool === "shape")).toBe(true);
		expect(plan.elements.every((e) => e.group === plan.group)).toBe(true);
		expect(parseChartGroup(plan.group)).toEqual({ kind: "bar", colour: 1, titled: true, source: group });
		expect(plan.group.length).toBeLessThanOrEqual(64);
		expect(plan.elements.some((e) => e.text === "Sales")).toBe(true);
		// 3 months x 2 series
		expect(plan.strokes.filter((s) => s.fill !== undefined)).toHaveLength(6 + 2);
		expect(serializeChecked(doc)).toBeTruthy();
		expect(history.undo()).not.toBeNull();
		expect(page.strokes.length).toBe(before.s);
		expect(page.elements!.length).toBe(before.e);
		expect(history.redo()).not.toBeNull();
		expect(page.strokes.length).toBe(before.s + plan.strokes.length);
	});

	it("is a step local to its page for per-page undo, inserted and updated", () => {
		const { doc, page, history } = setup();
		history.setPageRules(pageRules);
		fill(page, SALES);
		const t = tableOfSelection(page.strokes, 0)!;
		const plan = planChartInsert(page, t, chartDataFromCells(readCells(t.grid, page.elements!)), choice, { x: 0, y: 0 }, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		for (const cmd of [plan.cmd]) {
			const scope = pageScope(cmd);
			expect(scope.local).toBe(true);
			expect([...scope.pages]).toEqual([page.id]);
			expect(scope.registers).toEqual([]);
		}
		history.execute(plan.cmd);
		const e = page.elements!.find((x) => x.type === "text" && x.text === "12" && x.group === undefined) as TextElement;
		page.elements![page.elements!.indexOf(e)] = { ...e, text: "44" };
		const chart = chartOfSelection(page.strokes.filter((s) => s.group === plan.group), page.elements!.filter((x) => x.group === plan.group))!;
		const update = planChartUpdate(doc.pages, page, chart, page.strokes, undefined, ids);
		if (!update.ok) throw new Error("update");
		const scope = pageScope(update.cmd);
		expect(scope.local).toBe(true);
		expect([...scope.pages]).toEqual([page.id]);
	});

	it("is refused when the table has no number to show", () => {
		const { page } = setup();
		fill(page, [["a", "b", "c"], ["d", "e", "f"]]);
		const t = tableOfSelection(page.strokes, 0)!;
		const data = chartDataFromCells(readCells(t.grid, page.elements!));
		expect(planChartInsert(page, t, data, choice, { x: 0, y: 0 })).toEqual({ ok: false, reason: "noData" });
		expect(page.strokes.length).toBe(4 + 5);
	});

	it("draws every kind into a document the writer accepts", () => {
		for (const kind of ["bar", "line", "pie"] as const) {
			const { doc, page, history } = setup();
			fill(page, SALES);
			const t = tableOfSelection(page.strokes, 0)!;
			const data = chartDataFromCells(readCells(t.grid, page.elements!));
			const plan = planChartInsert(page, t, data, { ...choice, kind, title: "" }, { x: 0, y: 0 }, undefined, ids);
			expect(plan.ok, kind).toBe(true);
			if (!plan.ok) continue;
			expect(history.execute(plan.cmd)).toBe(true);
			expect(serializeChecked(doc), kind).toBeTruthy();
			expect(parseChartGroup(plan.group)!.titled).toBe(false);
		}
	});

	it("places the chart below the table, else to the right, above, or on the target", () => {
		const size = { width: 300, height: 200 };
		const table = { x: 100, y: 100, width: 180, height: 120 };
		const page = { width: 595, height: 842 };
		expect(placeChart(table, size, page, { x: 0, y: 0 })).toEqual({ x: 100, y: 236, width: 300, height: 200 });
		const low = placeChart({ ...table, y: 500, width: 100 }, size, page, { x: 0, y: 0 });
		expect(low).toMatchObject({ x: 216, y: 500 });
		const lowRight = placeChart({ x: 400, y: 650, width: 180, height: 120 }, size, page, { x: 0, y: 0 });
		expect(lowRight.y).toBe(650 - 16 - 200);
		const cramped = placeChart({ x: 8, y: 8, width: 579, height: 826 }, size, page, { x: 300, y: 400 });
		expect(cramped).toEqual({ x: 150, y: 300, width: 300, height: 200 });
		const infinite = placeChart({ x: 8, y: 8000, width: 579, height: 826 }, size, { ...page, infinite: true }, { x: 0, y: 0 });
		expect(infinite.y).toBe(8000 + 826 + 16);
		expect(chartSize("large", 200)).toEqual({ width: 184, height: 120 });
	});
});

describe("selection helpers (#244)", () => {
	it("finds the one table among a selection that has other ink and other groups", () => {
		const { page } = setup();
		const loose = line(0, 0, 10, 10);
		const other = { ...line(0, 0, 10, 0), group: "other", tool: "shape" as const };
		expect(tableInSelection([...page.strokes, loose])).not.toBeNull();
		expect(tableInSelection([...page.strokes, loose, other])).not.toBeNull();
		expect(tableInSelection([loose, other])).toBeNull();
		expect(tableInSelection([])).toBeNull();
	});

	it("is null for two tables", () => {
		const { page, history } = setup();
		const grid = gridAt(spec, 200, 500, { width: page.width, height: page.height });
		history.execute(insertTableCommand(page, grid, style, ids).cmd);
		expect(tableInSelection(page.strokes)).toBeNull();
	});

	it("knows a chart by its group and nothing else", () => {
		const { page, history } = setup();
		fill(page, SALES);
		const t = tableOfSelection(page.strokes, 0)!;
		const plan = planChartInsert(page, t, chartDataFromCells(readCells(t.grid, page.elements!)), choice, { x: 0, y: 0 }, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		history.execute(plan.cmd);
		const c = chartOfSelection(plan.strokes, plan.elements)!;
		expect(c.group).toBe(plan.group);
		expect(c.link.kind).toBe("bar");
		expect(chartOfSelection(plan.strokes, [...plan.elements, page.elements![0]!])).toBeNull();
		expect(chartOfSelection(page.strokes.slice(0, 3), [])).toBeNull();
		expect(chartOfSelection([], plan.elements)).toBeNull();
		// the table, being a different group, is not a chart
		expect(chartOfSelection(page.strokes.filter((s) => s.group === t.strokes[0]!.group), [])).toBeNull();
	});

	it("loses the link when the group is copied", () => {
		const rename = groupRenamer(() => "fresh");
		expect(parseChartGroup(rename(chartGroupId({ kind: "pie", colour: 0, titled: false, source: "s" })))).toBeNull();
	});
});

describe("updating a chart (#244)", () => {
	function withChart(kind: ChartChoice["kind"] = "bar") {
		const s = setup();
		fill(s.page, SALES);
		const t = tableOfSelection(s.page.strokes, 0)!;
		const plan = planChartInsert(s.page, t, chartDataFromCells(readCells(t.grid, s.page.elements!)), { ...choice, kind }, { x: 0, y: 0 }, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		s.history.execute(plan.cmd);
		const chart = () => chartOfSelection(s.page.strokes.filter((x) => x.group === plan.group), s.page.elements!.filter((e) => e.group === plan.group))!;
		return { ...s, plan, chart, inView: () => s.page.strokes as readonly Stroke[] };
	}

	it("says the chart is up to date when the numbers did not change, even after a first update", () => {
		const w = withChart();
		expect(planChartUpdate(w.doc.pages, w.page, w.chart(), w.inView())).toEqual({ ok: false, reason: "same" });
		for (const kind of ["line", "pie"] as const) {
			const k = withChart(kind);
			expect(planChartUpdate(k.doc.pages, k.page, k.chart(), k.inView()), kind).toEqual({ ok: false, reason: "same" });
		}
	});

	it("redraws the chart in place, in one undo step, when a number changes", () => {
		const w = withChart();
		const old = w.chart();
		const edited = w.page.elements!.find((e) => e.type === "text" && e.text === "12" && e.group === undefined) as TextElement;
		w.page.elements![w.page.elements!.indexOf(edited)] = { ...edited, text: "40" };
		const plan = planChartUpdate(w.doc.pages, w.page, w.chart(), w.inView(), undefined, ids);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const counts = { s: w.page.strokes.length, e: w.page.elements!.length };
		const depth = w.history.groupedSteps;
		expect(w.history.execute(plan.cmd)).toBe(true);
		const after = w.chart();
		expect(after.group).toBe(old.group);
		expect(after.strokes.some((s) => old.strokes.includes(s))).toBe(false);
		expect(after.elements.some((e) => old.elements.includes(e))).toBe(false);
		expect(w.page.strokes.length).toBe(counts.s - old.strokes.length + plan.strokes.length);
		expect(w.page.elements!.length).toBe(counts.e - old.elements.length + plan.elements.length);
		// the frame is where it was
		const frame = (c: { strokes: Stroke[] }) => c.strokes[0]!.points.map((p) => [p[0], p[1]]);
		expect(frame(after)).toEqual(frame(old));
		// the new axis is wider: 40 needs a taller scale
		expect(after.elements.map((e) => (e.type === "text" ? e.text : "")).some((t) => t === "40")).toBe(true);
		expect(serializeChecked(w.doc)).toBeTruthy();
		expect(w.history.groupedSteps).toBe(depth);
		// one undo brings the old chart back whole
		expect(w.history.undo()).not.toBeNull();
		expect(w.page.strokes.filter((s) => s.group === old.group).map((s) => s.id)).toEqual(old.strokes.map((s) => s.id));
		expect(w.page.elements!.filter((e) => e.group === old.group).map((e) => e.id)).toEqual(old.elements.map((e) => e.id));
		expect(w.page.strokes.length).toBe(counts.s);
		expect(w.history.redo()).not.toBeNull();
		expect(w.chart().strokes.length).toBe(plan.strokes.length);
	});

	it("follows a moved chart and keeps an edited title", () => {
		const w = withChart();
		const dx = 40, dy = -25;
		const old = w.chart();
		const moved = new Map(old.strokes.map((s) => [s, { ...s, points: s.points.map((p) => [p[0] + dx, p[1] + dy, p[2]] as [number, number, number]) }]));
		w.page.strokes = w.page.strokes.map((s) => moved.get(s) ?? s);
		const title = w.page.elements!.find((e) => e.group === old.group && e.type === "text" && e.text === "Sales") as TextElement;
		w.page.elements![w.page.elements!.indexOf(title)] = { ...title, x: title.x + dx, y: title.y + dy, text: "Q1 sales" };
		const e = w.page.elements!.find((x) => x.type === "text" && x.text === "12" && x.group === undefined) as TextElement;
		w.page.elements![w.page.elements!.indexOf(e)] = { ...e, text: "30" };
		const plan = planChartUpdate(w.doc.pages, w.page, w.chart(), w.inView(), undefined, ids);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const frame = plan.strokes[0]!.points[0]!;
		expect([frame[0], frame[1]]).toEqual([old.strokes[0]!.points[0]![0] + dx, old.strokes[0]!.points[0]![1] + dy]);
		expect(plan.elements.some((x) => x.text === "Q1 sales")).toBe(true);
		expect(plan.elements.filter((x) => x.text === "Sales")).toHaveLength(1); // the legend only
	});

	it("refuses when the source table is gone, the numbers are gone, the chart is locked, partly hidden or in a drawing state", () => {
		const gone = withChart();
		const lines = gone.page.strokes.filter((s) => s.group === gone.group);
		gone.page.strokes = gone.page.strokes.filter((s) => !lines.includes(s));
		expect(planChartUpdate(gone.doc.pages, gone.page, gone.chart(), gone.inView())).toEqual({ ok: false, reason: "noSource" });

		const empty = withChart();
		empty.page.elements = empty.page.elements!.filter((e) => e.group !== undefined);
		expect(planChartUpdate(empty.doc.pages, empty.page, empty.chart(), empty.inView())).toEqual({ ok: false, reason: "noData" });

		const locked = withChart();
		const chart = locked.chart();
		const first = chart.elements[0]!;
		locked.page.elements![locked.page.elements!.indexOf(first)] = { ...first, locked: true };
		expect(planChartUpdate(locked.doc.pages, locked.page, locked.chart(), locked.inView())).toEqual({ ok: false, reason: "locked" });

		const hidden = withChart();
		const view = hidden.page.strokes.filter((s) => s !== hidden.chart().strokes[0]);
		expect(planChartUpdate(hidden.doc.pages, hidden.page, hidden.chart(), view)).toEqual({ ok: false, reason: "gone" });

		const stale = withChart();
		const c = stale.chart();
		stale.page.strokes = stale.page.strokes.map((s) => (s === c.strokes[1] ? { ...s } : s));
		expect(planChartUpdate(stale.doc.pages, stale.page, c, stale.inView())).toEqual({ ok: false, reason: "gone" });

		const states = withChart();
		states.page.states = { parts: [{ id: "p", items: [states.chart().strokes[0]!.id] }] } as unknown as Page["states"];
		expect(planChartUpdate(states.doc.pages, states.page, states.chart(), states.inView())).toEqual({ ok: false, reason: "states" });
	});

	it("refuses a chart with no table to read", () => {
		const w = withChart();
		const c = w.chart();
		const orphan = { ...c, link: { ...c.link, source: null } };
		expect(planChartUpdate(w.doc.pages, w.page, orphan, w.inView())).toEqual({ ok: false, reason: "noLink" });
	});

	it("reads a table that lies on another page", () => {
		const w = withChart();
		const second = createPage();
		w.doc.pages.push(second);
		const t = tableOfSelection(w.page.strokes.filter((s) => s.tool === "shape" && s.group === w.group), 0)!;
		expect(findSourceTable(w.doc.pages, w.group)).not.toBeNull();
		// Move the chart onto page two: strokes and elements go with their group id
		const chart = w.chart();
		w.page.strokes = w.page.strokes.filter((s) => !chart.strokes.includes(s));
		w.page.elements = w.page.elements!.filter((e) => !chart.elements.includes(e));
		second.strokes.push(...chart.strokes);
		second.elements = [...chart.elements];
		const e = w.page.elements.find((x) => x.type === "text" && x.text === "12") as TextElement;
		w.page.elements[w.page.elements.indexOf(e)] = { ...e, text: "50" };
		const plan = planChartUpdate(w.doc.pages, second, chartOfSelection(second.strokes, second.elements)!, second.strokes, undefined, ids);
		expect(plan.ok).toBe(true);
		expect(t.strokes.length).toBeGreaterThan(0);
	});

	it("lays the chart out the same way the dialog preview does", () => {
		const data = chartDataFromCells(SALES);
		const a = layoutFor({ kind: "line", colour: 3 }, data, "T", { x: 0, y: 0, width: 300, height: 200 });
		const b = buildChart(a, "g", ids);
		expect(b.strokes[0]!.points[0]).toEqual([0, 0, 0.5]);
		expect(b.strokes.every((s) => s.group === "g" && s.render === 1)).toBe(true);
	});
});
