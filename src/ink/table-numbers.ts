import type { PageElement, TextElement } from "../model/types";
import { colsOf, rowsOf, type TableGrid } from "./table";
import { estimateMeasure, type MeasureText } from "./text-layout";
import { shownText } from "./wikilink";

/**
 * The text of each cell of a hand-drawn table (0.29, roadmap #295). Only TEXT BOXES are read: handwriting is ink and is not recognised.
 * A text box belongs to the cell that holds the middle of its first line; a box whose middle is outside the grid is ignored, and boxes in
 * one cell are joined with a space. Statistics read their numbers from here (math/stats.ts); the format is not touched.
 */
export function readTableCells(grid: TableGrid, elements: readonly PageElement[], measure: MeasureText = estimateMeasure): string[][] {
	const rows = rowsOf(grid);
	const cols = colsOf(grid);
	const cells: string[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => []));
	const found: { el: TextElement; r: number; c: number }[] = [];
	for (const el of elements) {
		if (el.type !== "text") continue;
		const shown = shownText(el.text).text;
		const first = shown.split("\n")[0] ?? "";
		const cx = el.x + Math.min(el.width, measure(first, el.fontSize)) / 2;
		const cy = el.y + el.fontSize * 0.6;
		const c = indexIn(grid.xs, cx);
		const r = indexIn(grid.ys, cy);
		if (c < 0 || r < 0) continue;
		found.push({ el, r, c });
	}
	// Reading order inside a cell: top to bottom, then left to right.
	found.sort((a, b) => a.el.y - b.el.y || a.el.x - b.el.x);
	for (const { el, r, c } of found) cells[r]![c]!.push(shownText(el.text).text.replace(/\s*\n\s*/g, " ").trim());
	return cells.map((row) => row.map((parts) => parts.filter((p) => p !== "").join(" ")));
}

/** The cells of column `c` (0-based), top to bottom. */
export function columnOf(cells: readonly (readonly string[])[], c: number): string[] {
	return cells.map((row) => row[c] ?? "");
}

/** The index of the interval of `lines` that holds `v` (the first line included, the last excluded), or -1. */
function indexIn(lines: readonly number[], v: number): number {
	for (let i = 0; i < lines.length - 1; i++) if (v >= lines[i]! && v < lines[i + 1]!) return i;
	return -1;
}

/**
 * Whether the first row of a table is a header: its cells hold words and the rows under it hold numbers in at least one column.
 * Used to leave the header out of the numbers and to name the columns on the card. `isNumber` is `parseCellNumber`.
 */
export function hasHeaderRow(cells: readonly (readonly string[])[], isNumber: (s: string) => boolean): boolean {
	if (cells.length < 2) return false;
	const head = cells[0]!;
	if (head.every((h) => h.trim() === "")) return false;
	if (head.some((h) => h.trim() !== "" && isNumber(h))) return false;
	return cells.slice(1).some((row) => row.some((v) => isNumber(v)));
}
