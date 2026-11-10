import { describe, expect, it } from "vitest";
import { analyseLines, lineMoveCommand, lineMoveUnderRedaction, planLineMove } from "../src/ink/line-reorder";
import { movesUnderRedaction } from "../src/ink/redact";
import { detectTable, gridAt, insertCol, insertRow, normaliseSpec, removeLastRow } from "../src/ink/table";
import { editTableCommand, insertTableCommand, planTableEdit } from "../src/ink/table-edit";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { freezeStroke, serializeChecked } from "../src/model/serialize";
import { PAPER_SPACING, RENDER_INK, type Page, type Point, type Stroke } from "../src/model/types";

/** Review round 2 fixes: R2-2 (page bounds of table inserts), R2-5 (states and all-or-nothing), R2-4 (redaction boxes under bulk moves). */
const NOW = new Date("2026-11-10T10:00:00.000Z");
const style = { color: "#1e1e1e", width: 1.5 };
let n = 0;
const ids = () => `fx${++n}`;
const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);

function setup() {
	const doc = createDocument(NOW);
	const p = doc.pages[0]!;
	const history = new History(() => doc, 100);
	return { doc, p, history };
}

function tableOn(p: Page, history: History, spec: { rows: number; cols: number; cellW: number; cellH: number }, x: number, y: number) {
	const grid = gridAt(normaliseSpec(spec, p.width), x, y, p);
	const made = insertTableCommand(p, grid, style, ids);
	history.execute(made.cmd);
	return { grid, made, table: detectTable(p.strokes.filter((s) => s.group === made.group))! };
}

describe("R2-2: table inserts stay on the page", () => {
	it("refuses Add column on a full-width table, with no partial edit", () => {
		const { doc, p, history } = setup();
		const { table, grid } = tableOn(p, history, { rows: 2, cols: 4, cellW: 400, cellH: 30 }, p.width / 2, 300);
		// Ink in the last column would be pushed beyond the right edge too.
		const ink = createStroke("#00f", 2, [pt(grid.xs[3]! + 5, grid.ys[1]! + 5), pt(grid.xs[3]! + 20, grid.ys[1]! + 9)]);
		p.strokes.push(ink);
		const before = p.strokes.slice();
		const edit = insertCol(table.grid, 3)!;
		expect(planTableEdit(p, table, edit, p.strokes)).toEqual({ ok: false, reason: "edge" });
		expect(editTableCommand(p, table, edit, p.strokes)).toBeNull();
		expect(p.strokes).toEqual(before);
		expect(() => serializeChecked(doc)).not.toThrow();
	});

	it("refuses Add row at the bottom of a fixed-height page, allows it on an infinite page", () => {
		const { p, history } = setup();
		const { table } = tableOn(p, history, { rows: 2, cols: 2, cellW: 60, cellH: 60 }, 300, p.height - 70);
		const edit = insertRow(table.grid, 1)!;
		expect(planTableEdit(p, table, edit, p.strokes)).toEqual({ ok: false, reason: "edge" });
		p.infinite = true;
		expect(planTableEdit(p, table, edit, p.strokes).ok).toBe(true);
	});

	it("still adds a row or a column where there is room, and Remove never needs room", () => {
		const { p, history } = setup();
		const { table } = tableOn(p, history, { rows: 3, cols: 3, cellW: 50, cellH: 30 }, 300, 300);
		expect(planTableEdit(p, table, insertRow(table.grid, 0)!, p.strokes).ok).toBe(true);
		expect(planTableEdit(p, table, insertCol(table.grid, 0)!, p.strokes).ok).toBe(true);
		expect(planTableEdit(p, table, removeLastRow(table.grid)!, p.strokes).ok).toBe(true);
	});

	it("refuses when only the pushed ink would leave the page", () => {
		const { p, history } = setup();
		// A small table near the right edge: the new column fits, but ink inside the last column is pushed past the edge only if the table box does not
		// already; build it so the grown box is inside while ink pushed by a wide column is not (ink lies fully inside the table).
		const { table, grid } = tableOn(p, history, { rows: 1, cols: 2, cellW: 100, cellH: 40 }, p.width - 110, 200);
		const last = createStroke("#00f", 2, [pt(grid.xs[2]! - 8, grid.ys[0]! + 8), pt(grid.xs[2]! - 3, grid.ys[0]! + 12)]);
		p.strokes.push(last);
		const edit = insertCol(table.grid, 0)!;
		const plan = planTableEdit(p, table, edit, p.strokes);
		expect(plan.ok ? "ok" : plan.reason).toBe("edge");
	});
});

describe("R2-5: states membership and all-or-nothing", () => {
	it("refuses an edit when a line of the table belongs to a part of a drawing with states", () => {
		const { p, history } = setup();
		const { table } = tableOn(p, history, { rows: 2, cols: 2, cellW: 50, cellH: 30 }, 300, 300);
		p.states = { parts: [{ id: "part1", pivot: [300, 300], items: [table.strokes[0]!.id] }], list: [] };
		expect(planTableEdit(p, table, insertRow(table.grid, 0)!, p.strokes)).toEqual({ ok: false, reason: "states" });
	});

	it("refuses when some lines are not the objects on the page (no duplicated lines)", () => {
		const { p, history } = setup();
		const { table } = tableOn(p, history, { rows: 2, cols: 2, cellW: 50, cellH: 30 }, 300, 300);
		const stale = { ...table, strokes: [...table.strokes.slice(0, -1), { ...table.strokes[table.strokes.length - 1]! }] };
		const before = p.strokes.length;
		expect(planTableEdit(p, stale, insertRow(table.grid, 0)!, p.strokes)).toEqual({ ok: false, reason: "gone" });
		expect(editTableCommand(p, stale, insertRow(table.grid, 0)!, p.strokes)).toBeNull();
		expect(p.strokes).toHaveLength(before);
	});
});

describe("R2-4: bulk moves never change what lies under a redaction box", () => {
	it("a table insert that pushes ink out from under a box, or under one, is refused; unreadable boxes refuse any push", () => {
		const { p, history } = setup();
		const { table, grid } = tableOn(p, history, { rows: 3, cols: 2, cellW: 80, cellH: 40 }, 300, 300);
		const ink = createStroke("#00f", 2, [pt(grid.xs[0]! + 10, grid.ys[2]! + 10), pt(grid.xs[0]! + 40, grid.ys[2]! + 14)]);
		p.strokes.push(ink);
		const edit = insertRow(table.grid, 0)!;
		// A box over the ink as it is now.
		const over = { boxes: [{ x: grid.xs[0]! + 5, y: grid.ys[2]! + 5, width: 60, height: 15 }] };
		expect(planTableEdit(p, table, edit, p.strokes, undefined, over)).toEqual({ ok: false, reason: "redacted" });
		// A box where the ink would land (one row lower).
		const landing = { boxes: [{ x: grid.xs[0]! + 5, y: grid.ys[2]! + 5 + 40, width: 60, height: 15 }] };
		expect(planTableEdit(p, table, edit, p.strokes, undefined, landing)).toEqual({ ok: false, reason: "redacted" });
		expect(planTableEdit(p, table, edit, p.strokes, undefined, { boxes: [], unreadable: true })).toEqual({ ok: false, reason: "redacted" });
		// A box somewhere else, or no box: allowed.
		expect(planTableEdit(p, table, edit, p.strokes, undefined, { boxes: [{ x: 10, y: 10, width: 40, height: 20 }] }).ok).toBe(true);
		expect(planTableEdit(p, table, edit, p.strokes, undefined, { boxes: [] }).ok).toBe(true);
		// An edit that moves no ink is not touched by the boxes.
		expect(planTableEdit(p, table, removeLastRow(table.grid)!, p.strokes, undefined, over).ok).toBe(true);
	});

	const loopRow = (base: number): Stroke[] =>
		Array.from({ length: 5 }, (_, i) => {
			const cx = 80 + i * 20;
			const points = Array.from({ length: 29 }, (_, k) => {
				const a = Math.PI / 2 + (k / 28) * 2 * Math.PI;
				return pt(cx + 4 * Math.cos(a), base - 5 + 5 * Math.sin(a));
			});
			return freezeStroke({ ...createStroke("#111111", 1.5, points, "pen", RENDER_INK), id: `r${base}-${i}` });
		});

	function reorderPage() {
		const page = createPage(undefined, { kind: "blank", spacing: PAPER_SPACING.blank });
		page.strokes.push(...[100, 150, 200].flatMap(loopRow));
		const model = analyseLines(page);
		const move = planLineMove(model, 0, 1);
		if (!move.ok) throw new Error("setup: the move is refused");
		return { page, model, plan: lineMoveCommand(page, model, move)! };
	}

	it("Reorder lines is refused when a moved line is under a box, or lands under one, or the boxes are unreadable", () => {
		const { page, plan } = reorderPage();
		expect(plan).not.toBeNull();
		expect(lineMoveUnderRedaction(page, plan, { boxes: [] })).toBe(false);
		expect(lineMoveUnderRedaction(page, plan, { boxes: [{ x: 70, y: 90, width: 120, height: 14 }] })).toBe(true);
		// A box over the line that stays, where a moved line lands.
		expect(lineMoveUnderRedaction(page, plan, { boxes: [{ x: 70, y: 140, width: 120, height: 14 }] })).toBe(true);
		expect(lineMoveUnderRedaction(page, plan, { boxes: [], unreadable: true })).toBe(true);
		// A box on empty paper far from every moved line.
		expect(lineMoveUnderRedaction(page, plan, { boxes: [{ x: 70, y: 600, width: 120, height: 14 }] })).toBe(false);
	});

	it("movesUnderRedaction: nothing moved is never refused, even with unreadable boxes", () => {
		expect(movesUnderRedaction({ boxes: [], unreadable: true }, { strokes: [], elements: [] }, { strokes: [], elements: [] })).toBe(false);
	});
});
