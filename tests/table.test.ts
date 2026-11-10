import { describe, expect, it } from "vitest";
import {
	buildTable, cellIndexAt, colsOf, detectTable, evenCells, gridAt, insertCol, insertRow, inkToShift, normaliseSpec, removeLastCol, removeLastRow,
	rowsOf, tableOfSelection, tableSnapLines, TABLE_MAX_COLS, TABLE_MAX_ROWS,
} from "../src/ink/table";
import { editTableCommand, insertTableCommand } from "../src/ink/table-edit";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { serializeChecked } from "../src/model/serialize";
import { line } from "./helpers";

const NOW = new Date("2026-10-29T10:00:00.000Z");
const style = { color: "#1e1e1e", width: 1.5 };
const spec = { rows: 3, cols: 4, cellW: 50, cellH: 30 };
const page = { width: 595, height: 842 };
let n = 0;
const ids = () => `id${++n}`;

function setup(locked = false) {
	const doc = createDocument(NOW);
	const p = doc.pages[0]!;
	const refused: string[][] = [];
	const history = new History(() => doc, 100, null, null, null, (pageIds) => refused.push([...pageIds]));
	if (locked) p.locked = true;
	return { doc, p, history, refused };
}

describe("table geometry (#41)", () => {
	it("builds one shape line per grid line in one group, rows first", () => {
		const grid = gridAt(spec, 300, 400, page);
		expect(rowsOf(grid)).toBe(3);
		expect(colsOf(grid)).toBe(4);
		const strokes = buildTable(grid, { ...style, dash: "dashed", headerWidth: 3 }, "g1", ids);
		expect(strokes).toHaveLength(4 + 5);
		expect(strokes.every((s) => s.tool === "shape" && s.group === "g1" && s.points.length === 2 && s.dash === "dashed")).toBe(true);
		expect(strokes[1]!.width).toBe(3);
		expect(strokes[0]!.width).toBe(1.5);
		expect(new Set(strokes.map((s) => s.id)).size).toBe(strokes.length);
	});

	it("centres the table and keeps it on the page", () => {
		const g = gridAt(spec, 300, 400, page);
		expect(g.xs[0]).toBe(200);
		expect(g.ys[0]).toBe(355);
		const corner = gridAt(spec, 0, 0, page);
		expect([corner.xs[0], corner.ys[0]]).toEqual([8, 8]);
		const far = gridAt(spec, 9999, 9999, page);
		expect(far.xs[far.xs.length - 1]).toBe(587);
	});

	it("shrinks cells to the page width and clamps the counts", () => {
		const s = normaliseSpec({ rows: 99, cols: 99, cellW: 200, cellH: 5 }, 595);
		expect(s.rows).toBe(TABLE_MAX_ROWS);
		expect(s.cols).toBe(TABLE_MAX_COLS);
		expect(s.cellW * s.cols).toBeLessThanOrEqual(595 - 16);
		expect(s.cellH).toBe(12);
		expect(normaliseSpec({ rows: 2, cols: 2, cellW: 40, cellH: 20 }, 595)).toEqual({ rows: 2, cols: 2, cellW: 40, cellH: 20 });
	});

	it("recognises its own table, with style and header, and nothing else", () => {
		const grid = gridAt(spec, 300, 400, page);
		const strokes = buildTable(grid, { ...style, dash: "dotted", headerWidth: 3 }, "g", ids);
		const t = detectTable(strokes)!;
		expect(t.grid).toEqual(grid);
		expect(t.style).toEqual({ color: "#1e1e1e", width: 1.5, dash: "dotted", headerWidth: 3 });
		expect(detectTable(strokes.slice(1))).toBeNull();
		expect(detectTable([...strokes, line(0, 0, 10, 10)])).toBeNull();
		const wobbly = [...strokes.slice(0, -1), createStroke("#000", 1, [quantizePoint(5, 5, 0.5), quantizePoint(9, 9, 0.5)])];
		expect(detectTable(wobbly)).toBeNull();
		expect(tableOfSelection(strokes)).not.toBeNull();
		expect(tableOfSelection(strokes, 1)).toBeNull();
		expect(tableOfSelection([...strokes.slice(0, 3), { ...strokes[3]!, group: "other" }, ...strokes.slice(4)])).toBeNull();
	});

	it("inserts a row or a column as tall or wide as its neighbour and reports the shift", () => {
		const g = gridAt(spec, 300, 400, page);
		const r = insertRow(g, 0)!;
		expect(rowsOf(r.grid)).toBe(4);
		expect(r.shift).toEqual({ axis: "y", from: g.ys[1], by: 30 });
		expect(r.grid.ys[r.grid.ys.length - 1]).toBe(g.ys[3]! + 30);
		const c = insertCol(g, 3)!;
		expect(colsOf(c.grid)).toBe(5);
		expect(c.shift!.axis).toBe("x");
		expect(insertRow(g, 3)).toBeNull();
		const tall = gridAt({ ...spec, rows: TABLE_MAX_ROWS }, 300, 400, { width: 595, height: 5000 });
		expect(insertRow(tall, 0)).toBeNull();
	});

	it("removes the last row or column but never the only one, and evens uneven cells", () => {
		const g = gridAt(spec, 300, 400, page);
		expect(rowsOf(removeLastRow(g)!.grid)).toBe(2);
		expect(colsOf(removeLastCol(g)!.grid)).toBe(3);
		expect(removeLastRow({ xs: [0, 1], ys: [0, 5] })).toBeNull();
		expect(removeLastCol({ xs: [0, 1], ys: [0, 5, 9] })).toBeNull();
		expect(evenCells(g)).toBeNull();
		const uneven = { xs: [0, 10, 100], ys: [0, 5, 20, 30] };
		const e = evenCells(uneven)!.grid;
		expect(e.xs).toEqual([0, 50, 100]);
		expect(e.ys).toEqual([0, 10, 20, 30]);
	});

	it("finds the cell index of a position and appends outside the table", () => {
		const g = gridAt(spec, 300, 400, page);
		expect(cellIndexAt(g.ys, g.ys[1]! + 1)).toBe(1);
		expect(cellIndexAt(g.ys, 0)).toBe(2);
		expect(cellIndexAt(g.xs, g.xs[0]! + 1)).toBe(0);
	});

	it("shifts only ungrouped visible ink fully inside the table beyond the line", () => {
		const g = gridAt(spec, 300, 400, page);
		const shift = { axis: "y" as const, from: g.ys[1]!, by: 30 };
		const box = (id: string, y0: number, y1: number, extra = {}) => ({ id, minX: g.xs[0]! + 5, maxX: g.xs[0]! + 20, minY: y0, maxY: y1, ...extra });
		const got = inkToShift(g, shift, [
			box("below", g.ys[1]! + 2, g.ys[1]! + 10),
			box("above", g.ys[0]! + 2, g.ys[0]! + 10),
			box("across", g.ys[1]! - 5, g.ys[1]! + 5),
			box("grouped", g.ys[1]! + 2, g.ys[1]! + 10, { group: "x" }),
			box("hidden", g.ys[1]! + 2, g.ys[1]! + 10, { hidden: true }),
			box("outside", g.ys[2]!, g.ys[3]! + 20),
			{ id: "left", minX: g.xs[0]! - 30, maxX: g.xs[0]! + 5, minY: g.ys[2]!, maxY: g.ys[2]! + 4 },
		]);
		expect(got).toEqual(["below"]);
	});
});

describe("table commands (#41)", () => {
	it("inserts a table as one undo step and removes it with one undo", () => {
		const { doc, p, history } = setup();
		const grid = gridAt(spec, 300, 400, page);
		const { cmd, strokes, group } = insertTableCommand(p, grid, style);
		expect(history.execute(cmd)).toBe(true);
		expect(p.strokes).toHaveLength(9);
		expect(p.strokes.every((s) => s.group === group)).toBe(true);
		expect(() => serializeChecked(doc)).not.toThrow();
		history.undo();
		expect(p.strokes).toHaveLength(0);
		history.redo();
		expect(p.strokes.map((s) => s.id)).toEqual(strokes.map((s) => s.id));
	});

	it("add row replaces the lines (fresh ids, same group), shifts ink below the line and undoes in one step", () => {
		const { doc, p, history } = setup();
		const grid = gridAt(spec, 300, 400, page);
		const made = insertTableCommand(p, grid, { ...style, headerWidth: 3 });
		history.execute(made.cmd);
		const pt = (x: number, y: number) => quantizePoint(x, y, 0.5);
		const inCell = createStroke("#00f", 2, [pt(grid.xs[0]! + 10, grid.ys[2]! + 8), pt(grid.xs[0]! + 30, grid.ys[2]! + 12)]);
		const above = createStroke("#00f", 2, [pt(grid.xs[0]! + 10, grid.ys[0]! + 8), pt(grid.xs[0]! + 30, grid.ys[0]! + 12)]);
		const outside = createStroke("#00f", 2, [pt(grid.xs[0]! + 10, grid.ys[3]! + 40), pt(grid.xs[0]! + 30, grid.ys[3]! + 44)]);
		p.strokes.push(inCell, above, outside);
		const table = detectTable(p.strokes.filter((s) => s.group === made.group))!;
		const done = editTableCommand(p, table, insertRow(table.grid, 0)!, p.strokes)!;
		const before = p.strokes.length;
		expect(history.execute(done.cmd)).toBe(true);
		expect(p.strokes).toHaveLength(before + 1);
		const lines = p.strokes.filter((s) => s.group === made.group);
		expect(lines).toHaveLength(5 + 5);
		expect(lines.some((s) => made.strokes.some((o) => o.id === s.id))).toBe(false);
		expect(detectTable(lines)!.style.headerWidth).toBe(3);
		expect(p.strokes.find((s) => s.id === inCell.id)!.points[0]![1]).toBeCloseTo(inCell.points[0]![1] + 30, 2);
		expect(p.strokes.find((s) => s.id === above.id)!.points).toEqual(above.points);
		expect(p.strokes.find((s) => s.id === outside.id)!.points).toEqual(outside.points);
		expect(() => serializeChecked(doc)).not.toThrow();
		history.undo();
		expect(p.strokes).toHaveLength(before);
		expect(p.strokes.find((s) => s.id === inCell.id)).toBe(inCell);
		expect(p.strokes.filter((s) => s.group === made.group).map((s) => s.id).sort()).toEqual(made.strokes.map((s) => s.id).sort());
		history.redo();
		expect(p.strokes.filter((s) => s.group === made.group)).toHaveLength(10);
	});

	it("add column shifts ink to the right, and remove keeps ink where it is", () => {
		const { p, history } = setup();
		const grid = gridAt(spec, 300, 400, page);
		const made = insertTableCommand(p, grid, style);
		history.execute(made.cmd);
		const pt = (x: number, y: number) => quantizePoint(x, y, 0.5);
		const ink = createStroke("#00f", 2, [pt(grid.xs[3]! + 5, grid.ys[1]! + 5), pt(grid.xs[3]! + 20, grid.ys[1]! + 9)]);
		p.strokes.push(ink);
		let table = detectTable(p.strokes.filter((s) => s.group === made.group))!;
		history.execute(editTableCommand(p, table, insertCol(table.grid, 1)!, p.strokes)!.cmd);
		expect(p.strokes.find((s) => s.id === ink.id)!.points[0]![0]).toBeCloseTo(ink.points[0]![0] + 50, 2);
		table = detectTable(p.strokes.filter((s) => s.group === made.group))!;
		expect(colsOf(table.grid)).toBe(5);
		history.execute(editTableCommand(p, table, removeLastCol(table.grid)!, p.strokes)!.cmd);
		expect(p.strokes.find((s) => s.id === ink.id)!.points[0]![0]).toBeCloseTo(ink.points[0]![0] + 50, 2);
		table = detectTable(p.strokes.filter((s) => s.group === made.group))!;
		expect(colsOf(table.grid)).toBe(4);
	});

	it("is refused on a locked page", () => {
		const { p, history, refused } = setup(true);
		const { cmd } = insertTableCommand(p, gridAt(spec, 300, 400, page), style);
		expect(history.execute(cmd)).toBe(false);
		expect(p.strokes).toHaveLength(0);
		expect(refused.length).toBe(1);
	});
});

describe("table snapping (#41)", () => {
  it("offers every row and column line of a table as an alignment line, and skips groups that are not tables", () => {
    const grid = gridAt(spec, 300, 400, page);
    const strokes = [...buildTable(grid, style, "t", ids), line(0, 0, 50, 50)];
    const lines = tableSnapLines(strokes);
    expect(lines.vertical.map((l) => l.pos)).toEqual(grid.xs);
    expect(lines.horizontal.map((l) => l.pos)).toEqual(grid.ys);
    expect(tableSnapLines(strokes.slice(2))).toEqual({ vertical: [], horizontal: [] });
  });
});
