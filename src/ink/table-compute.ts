import { evaluateSheet, formulaOfText, rewriteWithResult, showValue, type CellValue, type SheetCell } from "../math/table-formula";
import { Batch, ReplaceElement, type Command } from "../model/history";
import { isLockedElement } from "../model/groups";
import type { Page, PageElement, TextElement } from "../model/types";
import { boxesTouching, type RedactGuard } from "./redact";
import { colsOf, rowsOf, type TableGrid } from "./table";
import { cellAnchor, cellText } from "./table-data";

/**
 * "Compute table" (0.30, roadmap #147): the formulas typed in the text boxes of a hand-drawn table, worked out and written back. Pure: no
 * 'obsidian', no canvas, nothing added to the document format.
 *
 * Convention. A cell is a formula cell when a text box whose middle (as for the other table readers, `cellAnchor`) lies in it starts with
 * "=". Computing rewrites that very box to `=<formula> -> <result>` (the arrow is U+2192): the formula stays in the box, so it can be edited
 * and computed again, and the result is a number or an error code (#REF, #CYCLE, #DIV/0, #VALUE, #NAME, #NUM, #ERR). Compute only ever
 * replaces the result it owns, the value right after the arrow: words the person adds after it ("=B2*C2 -> 120 (checked by hand)") and notes
 * on lines below the formula stay, and so do the box's line breaks. If the text after the arrow is not a result, the result is put in
 * before it and their words follow a second arrow (nothing is deleted, and computing again changes nothing). No second box is made, so
 * nothing can fall out of step with the formula. Cells are named like a
 * spreadsheet's: A1 is the top-left cell of the table, header row included. Handwriting is not read: numbers come from text boxes (and from
 * typeset equations that are just a number) only; a number with a trailing "%" is a percentage.
 *
 * Several boxes in one cell: the first formula box (reading order) is the cell's formula and the other boxes are left alone; with no
 * formula box the cell's text is all its boxes joined, as `readCells` does.
 */

export interface FormulaGrid {
	rows: number;
	cols: number;
	cells: SheetCell[][];
	/** The formula box of each formula cell, `"r,c"` -> box. */
	boxes: Map<string, TextElement>;
	/** Every element read from the table (text boxes and equations inside it), whether it holds a formula or not. */
	read: PageElement[];
}

const key = (r: number, c: number): string => `${r},${c}`;

/** Index of the interval of `lines` (ascending) holding `v`, or -1: the first line is inside the table, the last is not. */
function intervalOf(lines: readonly number[], v: number): number {
	if (lines.length < 2 || v < lines[0]! || v >= lines[lines.length - 1]!) return -1;
	for (let i = 0; i < lines.length - 1; i++) if (v >= lines[i]! && v < lines[i + 1]!) return i;
	return -1;
}

/** Reads the cells of `grid` from the elements of a page, sorting formula cells from the rest. */
export function readFormulaGrid(grid: TableGrid, elements: readonly PageElement[]): FormulaGrid {
	const rows = rowsOf(grid);
	const cols = colsOf(grid);
	const found: Array<{ el: PageElement; r: number; c: number; x: number; y: number }> = [];
	for (const el of elements) {
		const a = cellAnchor(el);
		if (!a) continue;
		const r = intervalOf(grid.ys, a.y);
		const c = intervalOf(grid.xs, a.x);
		if (r >= 0 && c >= 0) found.push({ el, r, c, x: a.x, y: a.y });
	}
	found.sort((p, q) => p.y - q.y || p.x - q.x);
	const parts: string[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => []));
	const boxes = new Map<string, TextElement>();
	for (const f of found) {
		if (f.el.type === "text" && formulaOfText(f.el.text) !== null) {
			if (!boxes.has(key(f.r, f.c))) boxes.set(key(f.r, f.c), f.el);
			continue;
		}
		const text = cellText(f.el);
		if (text !== "") parts[f.r]![f.c]!.push(text);
	}
	const cells: SheetCell[][] = parts.map((row, r) => row.map((texts, c) => {
		const box = boxes.get(key(r, c));
		const f = box ? formulaOfText(box.text) : null;
		return f ? { formula: f.src } : { value: texts.join(" ") };
	}));
	return { rows, cols, cells, boxes, read: found.map((f) => f.el) };
}

export type ComputeRefusal =
	/** The table holds no formula (a box starting with "="). */
	| "none"
	/** Every formula box already shows the result it would get. */
	| "same"
	/** A formula box is locked. */
	| "locked"
	/** A formula box belongs to a part of a drawing with states. */
	| "states"
	/** The table, or a box to be written, touches a redaction box (or the boxes cannot be read). */
	| "redacted";

export interface ComputeSummary {
	/** Formula cells found. */
	formulas: number;
	/** Boxes whose text changes. */
	changed: number;
	/** Formula cells that came out as an error. */
	errors: number;
}

export type ComputePlan = { ok: true; cmd: Command; summary: ComputeSummary; values: CellValue[][] } | { ok: false; reason: ComputeRefusal; summary?: ComputeSummary };

/** The text a formula box shows once computed. */
export function computedText(box: TextElement, value: CellValue): string | null {
	return rewriteWithResult(box.text, showValue(value));
}

/**
 * The step that writes the results of every formula of the table into their boxes (ONE History step: a Batch of ReplaceElement, which is
 * what History already treats as page-local), or why nothing is done. Fail closed on redaction: a result is derived from the cells of the
 * table, so the table is refused whenever any box read from it, or any box to be written, touches a redaction box.
 */
export function planTableCompute(page: Page, grid: TableGrid, guard?: RedactGuard): ComputePlan {
	const elements = page.elements ?? [];
	const sheet = readFormulaGrid(grid, elements);
	if (sheet.boxes.size === 0) return { ok: false, reason: "none" };
	const values = evaluateSheet(sheet.cells);
	const inPart = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) inPart.add(id);

	const edits: Array<{ before: TextElement; after: TextElement }> = [];
	let errors = 0;
	for (const [k, box] of sheet.boxes) {
		const [r, c] = k.split(",").map(Number) as [number, number];
		const value = values[r]![c]!;
		if (value.k === "err") errors++;
		const text = computedText(box, value);
		if (text === null || text === box.text) continue;
		edits.push({ before: box, after: { ...box, text } });
	}
	const summary: ComputeSummary = { formulas: sheet.boxes.size, changed: edits.length, errors };
	if (edits.length === 0) return { ok: false, reason: "same", summary };
	if (edits.some((e) => isLockedElement(e.before))) return { ok: false, reason: "locked", summary };
	if (edits.some((e) => inPart.has(e.before.id))) return { ok: false, reason: "states", summary };
	if (guard) {
		if (guard.unreadable) return { ok: false, reason: "redacted", summary };
		if (guard.boxes.length > 0 && boxesTouching({ strokes: [], elements: [...sheet.read, ...edits.map((e) => e.after)] }, guard.boxes).length > 0) {
			return { ok: false, reason: "redacted", summary };
		}
	}
	const cmd = new Batch("Compute table", edits.map((e) => new ReplaceElement(page.id, e.before, e.after)));
	return { ok: true, cmd, summary, values };
}

