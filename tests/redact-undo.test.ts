/**
 * 0.29 redactundo: review fixes R3-1 (Undo and Redo of a move never slide ink out from under, or under, a redaction box; a refused step stays
 * in the history) and R3-2 (a table insert that would push ink of a drawing-state part is refused).
 */
import { describe, expect, it } from "vitest";
import { analyseLines, lineMoveCommand, planLineMove } from "../src/ink/line-reorder";
import { captureForStep, redactStepCheck, stepMovesUnderRedaction, type StepBoxes } from "../src/ink/redact-step";
import { detectTable, gridAt, insertRow, normaliseSpec } from "../src/ink/table";
import { insertTableCommand, planTableEdit } from "../src/ink/table-edit";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { UpdateItems, type PageItem } from "../src/model/groups";
import { jumpHistory } from "../src/model/history-jump";
import { AddElement, AddStroke, Batch, EraseStrokes, History, type Command } from "../src/model/history";
import { pageRules } from "../src/model/page-undo";
import type { RedactBox } from "../src/model/redact";
import { checkContent, freezeStroke } from "../src/model/serialize";
import { PAPER_SPACING, RENDER_INK, type NotebookDocument, type Page, type Point, type Stroke, type TextElement } from "../src/model/types";
import { line } from "./helpers";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);

/** The boxes of the notebook, changed by the test as the person would in the Redact dialog. */
function store(unreadable = false) {
	const boxes: Record<string, RedactBox[]> = {};
	const state = { unreadable };
	const read = (): StepBoxes => ({
		boxesOf: (id) => boxes[id] ?? [],
		unreadable: state.unreadable,
		any: Object.values(boxes).some((l) => l.length > 0),
	});
	return { boxes, state, read };
}

function rig(opts: { guard?: boolean; pages?: number; pagewise?: boolean; unreadable?: boolean } = {}) {
	const doc = createDocument(NOW);
	for (let i = 1; i < (opts.pages ?? 1); i++) doc.pages.push(createPage());
	const history = new History(() => doc, 500, opts.guard === false ? null : checkContent);
	if (opts.pagewise) {
		history.setPageRules(pageRules);
		history.setPagewise(true);
	}
	const s = store(opts.unreadable);
	const refused: Array<"undo" | "redo"> = [];
	history.setStepCheck(redactStepCheck(s.read, (step) => refused.push(step)));
	return { doc, history, s, refused };
}

const items = (p: Page): unknown[] => [...p.strokes, ...(p.elements ?? [])];

const loopRow = (base: number): Stroke[] =>
	Array.from({ length: 5 }, (_, i) => {
		const cx = 80 + i * 20;
		const points = Array.from({ length: 29 }, (_, k) => {
			const a = Math.PI / 2 + (k / 28) * 2 * Math.PI;
			return pt(cx + 4 * Math.cos(a), base - 5 + 5 * Math.sin(a));
		});
		return freezeStroke({ ...createStroke("#111111", 1.5, points, "pen", RENDER_INK), id: `r${base}-${i}` });
	});

/** Three lines of handwriting (y 100, 150, 200) and the step that moves the first one below the second. */
function reorder(doc: NotebookDocument): Command {
	const page = createPage(undefined, { kind: "blank", spacing: PAPER_SPACING.blank });
	page.strokes.push(...[100, 150, 200].flatMap(loopRow));
	doc.pages[0] = page;
	const model = analyseLines(page);
	const move = planLineMove(model, 0, 1);
	if (!move.ok) throw new Error("setup: the move is refused");
	return lineMoveCommand(page, model, move)!.command;
}

const translate = (dx: number, dy: number) => (item: PageItem): PageItem =>
	"points" in item
		? freezeStroke({ ...item, points: item.points.map((p) => quantizePoint(p[0] + dx, p[1] + dy, p[2])) })
		: { ...item, x: (item as TextElement).x + dx, y: (item as TextElement).y + dy };

describe("R3-1: Undo and Redo of a line move keep what lies under a redaction box", () => {
	it("the reorder's Undo is refused while a box covers the moved line, and stays in the history; it runs once the box is gone", () => {
		const { doc, history, s, refused } = rig();
		const cmd = reorder(doc);
		expect(history.execute(cmd)).toBe(true);
		const page = doc.pages[0]!;
		// The first line now sits at y 150: a box is drawn over it (the "SSN" line).
		s.boxes[page.id] = [{ x: 70, y: 140, width: 120, height: 14 }];
		const before = items(page);
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
		expect(items(page)).toEqual(before);
		items(page).forEach((it, i) => expect(it).toBe(before[i]));
		expect(history.canUndo()).toBe(true);
		expect(history.stepsTo(cmd)).toEqual({ direction: "undo", steps: 0 });
		expect(history.canRedo()).toBe(false);
		expect(checkContent(doc)).toBeNull();
		// The box removed: the same step is undone.
		s.boxes[page.id] = [];
		expect(history.undo()).toBe(cmd);
		expect(page.strokes.find((x) => x.id === "r100-0")!.points[0]![1]).toBeLessThan(110);
	});

	it("the Redo is refused when a box was drawn over the line it would move, and stays the next Redo", () => {
		const { doc, history, s, refused } = rig();
		const cmd = reorder(doc);
		history.execute(cmd);
		history.undo();
		const page = doc.pages[0]!;
		s.boxes[page.id] = [{ x: 70, y: 90, width: 120, height: 14 }];
		const before = items(page);
		expect(history.redo()).toBeNull();
		expect(refused).toEqual(["redo"]);
		items(page).forEach((it, i) => expect(it).toBe(before[i]));
		expect(history.stepsTo(cmd)).toEqual({ direction: "redo", steps: 1 });
		expect(history.canUndo()).toBe(false);
	});

	it("a box elsewhere on the page, a box on another page, or no box at all lets the Undo run (nothing is captured without boxes)", () => {
		const { doc, history, s } = rig({ pages: 2 });
		const cmd = reorder(doc);
		history.execute(cmd);
		const page = doc.pages[0]!;
		s.boxes[page.id] = [{ x: 70, y: 600, width: 120, height: 14 }];
		s.boxes[doc.pages[1]!.id] = [{ x: 70, y: 140, width: 120, height: 14 }];
		expect(history.undo()).toBe(cmd);
		expect(history.redo()).toBe(cmd);
		for (const k of Object.keys(s.boxes)) delete s.boxes[k];
		expect(captureForStep(doc, s.read())).toBeNull();
		expect(history.undo()).toBe(cmd);
	});

	it("unreadable boxes refuse any undo that moves ink (fail closed), but not one that only adds or removes ink", () => {
		const { doc, history, refused } = rig({ unreadable: true });
		const cmd = reorder(doc);
		history.execute(cmd);
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
		const s = line(300, 400, 360, 405);
		expect(history.execute(new AddStroke(doc.pages[0]!.id, s, doc.pages[0]!.strokes.length))).toBe(true);
		expect(history.undo()).not.toBeNull();
		expect(doc.pages[0]!.strokes).not.toContain(s);
	});
});

describe("R3-1: table inserts and lasso moves", () => {
	it("the Undo of Add row is refused while a box covers the pushed ink where it is now (history without the content guard: the inverse puts it back)", () => {
		const { doc, history, s, refused } = rig({ guard: false });
		const p = doc.pages[0]!;
		const grid = gridAt(normaliseSpec({ rows: 3, cols: 2, cellW: 80, cellH: 40 }, p.width), 300, 300, p);
		const made = insertTableCommand(p, grid, { color: "#1e1e1e", width: 1.5 }, () => `t${Math.random().toString(36).slice(2, 10)}`);
		history.execute(made.cmd);
		const table = detectTable(p.strokes.filter((x) => x.group === made.group))!;
		const ink = createStroke("#00f", 2, [pt(grid.xs[0]! + 10, grid.ys[2]! + 10), pt(grid.xs[0]! + 40, grid.ys[2]! + 14)]);
		history.execute(new AddStroke(p.id, ink, p.strokes.length));
		const plan = planTableEdit(p, table, insertRow(table.grid, 0)!, p.strokes);
		if (!plan.ok) throw new Error(plan.reason);
		expect(history.execute(plan.cmd)).toBe(true);
		const pushed = p.strokes.find((x) => x.id === ink.id)!;
		expect(pushed.points[0]![1]).toBeCloseTo(ink.points[0]![1] + 40, 1);
		s.boxes[p.id] = [{ x: grid.xs[0]! + 5, y: grid.ys[2]! + 45, width: 60, height: 15 }];
		const lines = p.strokes.length;
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
		expect(p.strokes.length).toBe(lines);
		expect(p.strokes.find((x) => x.id === ink.id)).toBe(pushed);
		expect(history.stepsTo(plan.cmd)).toEqual({ direction: "undo", steps: 0 });
	});

	it("a lasso move of ink and a text box: the Undo is refused when a box covers either one; a restyle under a box is not a move", () => {
		const { doc, history, s, refused } = rig();
		const p = doc.pages[0]!;
		const ink = line(100, 300, 160, 305);
		const text: TextElement = { id: "txt1", type: "text", x: 100, y: 400, width: 120, text: "SSN 123", fontSize: 16, color: "#000000" };
		history.execute(new AddStroke(p.id, ink, 0));
		history.execute(new AddElement(p.id, text, 0));
		const move = new UpdateItems(p.id, new Set([ink.id, text.id]), translate(200, 0), "Move selection");
		expect(history.execute(move)).toBe(true);
		// Only the text box, where it is now.
		s.boxes[p.id] = [{ x: 290, y: 390, width: 160, height: 40 }];
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
		// A restyle of the moved ink under a box of its own.
		s.boxes[p.id] = [{ x: 290, y: 290, width: 80, height: 30 }];
		const restyle = new UpdateItems(p.id, new Set([ink.id]), (item) => ("points" in item ? freezeStroke({ ...item, color: "#ff0000" }) : item), "Change colour");
		expect(history.execute(restyle)).toBe(true);
		expect(history.undo()).toBe(restyle);
		// The move itself still is refused (the ink box covers the moved ink).
		expect(history.undo()).toBeNull();
		expect(history.stepsTo(move)).toEqual({ direction: "undo", steps: 0 });
	});

	it("erasing or writing under a box is undone and redone freely (ink appears or goes; a box cuts whatever lies under it)", () => {
		const { doc, history, s } = rig();
		const p = doc.pages[0]!;
		const ink = line(100, 300, 160, 305);
		history.execute(new AddStroke(p.id, ink, 0));
		s.boxes[p.id] = [{ x: 90, y: 290, width: 90, height: 30 }];
		const erase = new EraseStrokes(p.id, [{ stroke: ink, index: 0 }]);
		expect(history.execute(erase)).toBe(true);
		expect(history.undo()).toBe(erase);
		expect(history.redo()).toBe(erase);
		expect(history.undo()).toBe(erase);
		expect(history.undo()).not.toBeNull();
		expect(p.strokes).toHaveLength(0);
	});

	it("a move to another page: its Redo is refused when the ink it takes away lies under a box of the page it leaves", () => {
		const { doc, history, s, refused } = rig({ pages: 2 });
		const [a, b] = [doc.pages[0]!, doc.pages[1]!];
		const ink = line(100, 300, 160, 305);
		history.execute(new AddStroke(a.id, ink, 0));
		const move = new Batch("Move to page", [new EraseStrokes(a.id, [{ stroke: ink, index: 0 }]), new AddStroke(b.id, ink, 0, false)]);
		expect(history.execute(move)).toBe(true);
		expect(history.undo()).toBe(move);
		s.boxes[a.id] = [{ x: 90, y: 290, width: 90, height: 30 }];
		expect(history.redo()).toBeNull();
		expect(refused).toEqual(["redo"]);
		expect(a.strokes).toContain(ink);
		expect(b.strokes).not.toContain(ink);
		expect(history.stepsTo(move)).toEqual({ direction: "redo", steps: 1 });
	});

	it("stepMovesUnderRedaction: a reshaped stroke (another number of points: a trimmed hook, a join) is not a move", () => {
		const doc = createDocument(NOW);
		const p = doc.pages[0]!;
		const ink = line(100, 300, 160, 305);
		p.strokes.push(ink);
		const s = store();
		s.boxes[p.id] = [{ x: 90, y: 290, width: 90, height: 30 }];
		const before = captureForStep(doc, s.read())!;
		p.strokes[0] = freezeStroke({ ...ink, points: ink.points.slice(0, 6) });
		expect(stepMovesUnderRedaction(before, doc, s.read())).toBe(false);
		p.strokes[0] = freezeStroke({ ...ink, points: ink.points.map((q) => quantizePoint(q[0] + 50, q[1], q[2])) });
		expect(stepMovesUnderRedaction(before, doc, s.read())).toBe(true);
	});
});

describe("R3-1: per-page undo, groups, history-panel jumps and a failing check", () => {
	it("per-page Undo taken out of order is refused and the step stays where it was; the other page's undo still works", () => {
		const { doc, history, s, refused } = rig({ pages: 2, pagewise: true });
		const cmd = reorder(doc);
		expect(history.execute(cmd)).toBe(true);
		const other = doc.pages[1]!;
		const later = line(10, 10, 60, 12);
		history.execute(new AddStroke(other.id, later, 0));
		s.boxes[doc.pages[0]!.id] = [{ x: 70, y: 140, width: 120, height: 14 }];
		const order = history.entries().undo.map((e) => e.cmd);
		expect(history.undoOnPage(doc.pages[0]!.id)).toEqual({ kind: "refused" });
		expect(refused).toEqual(["undo"]);
		expect(history.entries().undo.map((e) => e.cmd)).toEqual(order);
		expect(history.undoOnPage(other.id)).toMatchObject({ kind: "done" });
		expect(other.strokes).toHaveLength(0);
		// Redo of the other page, then the boxes go: the reorder is undone on its page.
		expect(history.redoOnPage(other.id)).toMatchObject({ kind: "done" });
		s.boxes[doc.pages[0]!.id] = [];
		expect(history.undoOnPage(doc.pages[0]!.id)).toEqual({ kind: "done", cmd });
	});

	it("a group (macro) is one step: its Undo is refused as a whole and stays one entry", () => {
		const { doc, history, s } = rig();
		const p = doc.pages[0]!;
		const ink = line(100, 300, 160, 305);
		history.execute(new AddStroke(p.id, ink, 0));
		history.group("Macro", () => {
			history.execute(new UpdateItems(p.id, new Set([ink.id]), translate(0, 100), "Move selection"));
			history.execute(new AddStroke(p.id, line(400, 600, 450, 602), p.strokes.length));
		});
		expect(history.depth().undo).toBe(2);
		s.boxes[p.id] = [{ x: 90, y: 390, width: 90, height: 30 }];
		const before = items(p);
		expect(history.undo()).toBeNull();
		expect(items(p)).toEqual(before);
		expect(history.depth()).toEqual({ undo: 2, redo: 0 });
	});

	it("a history-panel jump stops at a refused step and leaves every step in the history", () => {
		const { doc, history, s } = rig();
		const p = doc.pages[0]!;
		const ink = line(100, 300, 160, 305);
		history.execute(new AddStroke(p.id, ink, 0));
		history.execute(new UpdateItems(p.id, new Set([ink.id]), translate(0, 100), "Move selection"));
		history.execute(new AddStroke(p.id, line(400, 600, 450, 602), p.strokes.length));
		s.boxes[p.id] = [{ x: 90, y: 390, width: 90, height: 30 }];
		const r = jumpHistory(history, { kind: "start" });
		expect(r).toMatchObject({ direction: "undo", wanted: 3, done: 1 });
		expect(history.depth()).toEqual({ undo: 2, redo: 1 });
	});

	it("a check that throws refuses the step (fail closed) and keeps it", () => {
		const doc = createDocument(NOW);
		const history = new History(() => doc, 100, checkContent);
		const p = doc.pages[0]!;
		const s = line(100, 300, 160, 305);
		history.execute(new AddStroke(p.id, s, 0));
		history.setStepCheck(() => () => {
			throw new Error("boom");
		});
		expect(history.undo()).toBeNull();
		expect(p.strokes).toEqual([s]);
		expect(history.canUndo()).toBe(true);
		history.setStepCheck(() => {
			throw new Error("boom");
		});
		expect(history.undo()).toBeNull();
		expect(p.strokes).toEqual([s]);
		history.setStepCheck(null);
		expect(history.undo()).not.toBeNull();
	});
});

describe("R3-2: a table insert never pushes ink of a drawing-state part", () => {
	it("Add row is refused (states) when ink it would push belongs to a states part; other ink is pushed as before", () => {
		const doc = createDocument(NOW);
		const p = doc.pages[0]!;
		const grid = gridAt(normaliseSpec({ rows: 3, cols: 2, cellW: 80, cellH: 40 }, p.width), 300, 300, p);
		let n = 0;
		const made = insertTableCommand(p, grid, { color: "#1e1e1e", width: 1.5 }, () => `st${++n}`);
		made.cmd.apply(doc);
		const table = detectTable(p.strokes.filter((x) => x.group === made.group))!;
		const ink = createStroke("#00f", 2, [pt(grid.xs[0]! + 10, grid.ys[2]! + 10), pt(grid.xs[0]! + 40, grid.ys[2]! + 14)]);
		p.strokes.push(ink);
		const edit = insertRow(table.grid, 0)!;
		expect(planTableEdit(p, table, edit, p.strokes).ok).toBe(true);
		p.states = { parts: [{ id: "part1", pivot: [grid.xs[0]! + 25, grid.ys[2]! + 12], items: [ink.id] }], list: [] };
		expect(planTableEdit(p, table, edit, p.strokes)).toEqual({ ok: false, reason: "states" });
		// A part whose ink the insert does not push (above the new row) does not stop it.
		p.states = { parts: [{ id: "part1", pivot: [10, 10], items: ["elsewhere"] }], list: [] };
		expect(planTableEdit(p, table, edit, p.strokes).ok).toBe(true);
	});
});
