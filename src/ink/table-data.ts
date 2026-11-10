import type { PageElement } from "../model/types";
import type { TableGrid } from "./table";
import { estimateMeasure } from "./text-layout";

/**
 * The text in the cells of a hand-drawn table (0.29, roadmap #244). Pure: no 'obsidian', no canvas. The table itself is only lines
 * (`ink/table.ts`), and the plugin does not read handwriting, so the contents are the TEXT BOXES (and typeset equations that are just a
 * number) whose anchor (the middle of the first line of a text box, the middle of an equation) lies in a cell. Anything else on the page,
 * handwriting included, is not read.
 */

/** Where an element reads from: the middle of its first line (text) or of its box (equation); null for any other kind of element. */
export function cellAnchor(el: PageElement): { x: number; y: number } | null {
	if (el.type === "text") {
		const first = el.text.replace(/\r\n?/g, "\n").split("\n")[0] ?? "";
		const w = Math.min(el.width, estimateMeasure(first, el.fontSize));
		return { x: el.x + w / 2, y: el.y + el.fontSize * 0.625 };
	}
	if (el.type === "equation") return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
	return null;
}

/** The text an element holds as a cell would show it ("" for a kind that holds none). An equation's markup for spacing and braces is dropped. */
export function cellText(el: PageElement): string {
	if (el.type === "text") return el.text.replace(/\s+/g, " ").trim();
	if (el.type === "equation") return el.latex.replace(/\\[,;:! ]|\\%|\\\$|[{}$]/g, "").replace(/\s+/g, " ").trim();
	return "";
}

/** Index of the interval of `lines` (ascending positions) that holds `v`, or -1 when `v` is outside them. */
function intervalOf(lines: readonly number[], v: number): number {
	if (v < lines[0]! || v >= lines[lines.length - 1]!) return -1;
	for (let i = 0; i < lines.length - 1; i++) if (v >= lines[i]! && v < lines[i + 1]!) return i;
	return -1;
}

/**
 * The cells of `grid` as text, `cells[row][col]`: every text box and equation whose anchor is inside the table is added to its cell (several
 * in one cell are joined with a space, top to bottom and left to right). A cell with nothing in it is "".
 */
export function readCells(grid: TableGrid, elements: readonly PageElement[]): string[][] {
	const rows = grid.ys.length - 1;
	const cols = grid.xs.length - 1;
	const found: Array<{ r: number; c: number; x: number; y: number; text: string }> = [];
	for (const el of elements) {
		const a = cellAnchor(el);
		if (!a) continue;
		const text = cellText(el);
		if (text === "") continue;
		const r = intervalOf(grid.ys, a.y);
		const c = intervalOf(grid.xs, a.x);
		if (r >= 0 && c >= 0) found.push({ r, c, x: a.x, y: a.y, text });
	}
	found.sort((p, q) => p.y - q.y || p.x - q.x);
	const cells: string[][] = Array.from({ length: Math.max(0, rows) }, () => Array.from({ length: Math.max(0, cols) }, () => ""));
	for (const f of found) {
		const row = cells[f.r]!;
		row[f.c] = row[f.c] === "" ? f.text : `${row[f.c]} ${f.text}`;
	}
	return cells;
}
