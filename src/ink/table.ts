import { createId, quantizePoint } from "../model/document";
import type { SnapLine } from "../model/snap";
import { RENDER_FREEHAND, type ShapeDash, type Stroke } from "../model/types";
import { SHAPE_PRESSURE } from "./shapes";

/**
 * Hand-drawn tables (0.28, roadmap #41). Pure: no 'obsidian', no canvas. A table is plain vector ink: one straight shape stroke per grid
 * line (two points each), all sharing one group id, so it moves, resizes, copies, exports and erases like any group and adds nothing to
 * the document format. The table is recognised again from those lines alone (`detectTable`), which is what lets "Add row" and friends
 * work on a table made by this plugin, and leaves a group of lines drawn by hand that happens to be a grid editable as well.
 *
 * Ink written inside cells is ordinary ink. A row or column insert shifts the ink that lies fully inside the table below or right of the
 * inserted line (`inkToShift`); every other edit leaves ink where it is.
 */

export const TABLE_MAX_ROWS = 30;
export const TABLE_MAX_COLS = 16;
export const TABLE_MIN_CELL = 12;
/** Room kept between a new table and the page edge, pt. */
export const TABLE_PAGE_MARGIN = 8;
/** Two positions closer than this (pt) are the same grid line. */
const EPS = 0.06;

/** The grid lines: `xs` are the vertical lines left to right (columns + 1), `ys` the horizontal ones top to bottom (rows + 1). */
export interface TableGrid {
	xs: number[];
	ys: number[];
}

export interface TableStyle {
	color: string;
	width: number;
	dash?: ShapeDash;
	/** Width of the line under the first row (a header); absent = the same as every other line. */
	headerWidth?: number;
	/** v24 (#358): the opacity every line of the table carries (absent = full strength). An edit rebuilds the lines, so it keeps it. */
	opacity?: number;
}

export interface TableSpec {
	rows: number;
	cols: number;
	cellW: number;
	cellH: number;
}

export const rowsOf = (g: TableGrid): number => g.ys.length - 1;
export const colsOf = (g: TableGrid): number => g.xs.length - 1;

export interface TableBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export function tableBox(g: TableGrid): TableBox {
	return { minX: g.xs[0]!, minY: g.ys[0]!, maxX: g.xs[g.xs.length - 1]!, maxY: g.ys[g.ys.length - 1]! };
}

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

/** A spec inside the limits, with cells that fit a page of width `pageWidth` (cells shrink, never below TABLE_MIN_CELL). */
export function normaliseSpec(spec: TableSpec, pageWidth: number): TableSpec {
	const rows = clampInt(spec.rows, 1, TABLE_MAX_ROWS);
	const cols = clampInt(spec.cols, 1, TABLE_MAX_COLS);
	const room = Math.max(TABLE_MIN_CELL * cols, pageWidth - 2 * TABLE_PAGE_MARGIN);
	const cellW = Math.max(TABLE_MIN_CELL, Math.min(Math.round(spec.cellW) || TABLE_MIN_CELL, Math.floor(room / cols)));
	const cellH = Math.max(TABLE_MIN_CELL, Math.round(spec.cellH) || TABLE_MIN_CELL);
	return { rows, cols, cellW, cellH };
}

/** The grid of an even table whose centre is (cx, cy), kept inside a page (the height is only a limit when the page is not infinite). */
export function gridAt(spec: TableSpec, cx: number, cy: number, page: { width: number; height: number; infinite?: boolean }): TableGrid {
	const w = spec.cols * spec.cellW;
	const h = spec.rows * spec.cellH;
	const x0 = Math.max(TABLE_PAGE_MARGIN, Math.min(page.width - w - TABLE_PAGE_MARGIN, cx - w / 2));
	const yMax = page.infinite ? Infinity : page.height - h - TABLE_PAGE_MARGIN;
	const y0 = Math.max(TABLE_PAGE_MARGIN, Math.min(yMax, cy - h / 2));
	const r2 = (v: number): number => Math.round(v * 100) / 100;
	return {
		xs: Array.from({ length: spec.cols + 1 }, (_, i) => r2(x0 + i * spec.cellW)),
		ys: Array.from({ length: spec.rows + 1 }, (_, i) => r2(y0 + i * spec.cellH)),
	};
}

/** The lines of a grid as strokes of one fresh group (horizontal lines first, top to bottom; then vertical ones, left to right). */
export function buildTable(grid: TableGrid, style: TableStyle, group: string = createId(), newId: () => string = createId): Stroke[] {
	const { minX, minY, maxX, maxY } = tableBox(grid);
	const out: Stroke[] = [];
	const make = (width: number, a: [number, number], b: [number, number]): Stroke => {
		const s: Stroke = {
			id: newId(), tool: "shape", color: style.color, width, render: RENDER_FREEHAND, group,
			points: [quantizePoint(a[0], a[1], SHAPE_PRESSURE), quantizePoint(b[0], b[1], SHAPE_PRESSURE)],
		};
		if (style.dash) s.dash = style.dash;
		if (style.opacity !== undefined) s.opacity = style.opacity;
		return s;
	};
	const header = style.headerWidth !== undefined && style.headerWidth > style.width && rowsOf(grid) >= 2;
	grid.ys.forEach((y, i) => out.push(make(header && i === 1 ? (style.headerWidth as number) : style.width, [minX, y], [maxX, y])));
	for (const x of grid.xs) out.push(make(style.width, [x, minY], [x, maxY]));
	return out;
}

interface Line {
	stroke: Stroke;
	horizontal: boolean;
	pos: number;
	lo: number;
	hi: number;
}

function lineOf(s: Stroke): Line | null {
	if (s.tool !== "shape" || s.points.length !== 2 || s.fill !== undefined || s.hidden) return null;
	const [a, b] = [s.points[0]!, s.points[1]!];
	if (Math.abs(a[1] - b[1]) <= EPS && Math.abs(a[0] - b[0]) > EPS) return { stroke: s, horizontal: true, pos: (a[1] + b[1]) / 2, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) };
	if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) > EPS) return { stroke: s, horizontal: false, pos: (a[0] + b[0]) / 2, lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) };
	return null;
}

export interface DetectedTable {
	grid: TableGrid;
	style: TableStyle;
	/** The strokes that make the table (all the strokes passed in). */
	strokes: Stroke[];
}

/**
 * The table a set of strokes makes, or null when they are not exactly a grid: every stroke a straight horizontal or vertical shape line,
 * at least two of each, horizontal lines all spanning the same width and vertical ones the same height, ends meeting the outer lines, no
 * two lines on the same position.
 */
export function detectTable(strokes: readonly Stroke[]): DetectedTable | null {
	if (strokes.length < 4 || strokes.length > TABLE_MAX_ROWS + TABLE_MAX_COLS + 2) return null;
	const lines: Line[] = [];
	for (const s of strokes) {
		const l = lineOf(s);
		if (!l) return null;
		lines.push(l);
	}
	const hs = lines.filter((l) => l.horizontal).sort((a, b) => a.pos - b.pos);
	const vs = lines.filter((l) => !l.horizontal).sort((a, b) => a.pos - b.pos);
	if (hs.length < 2 || vs.length < 2) return null;
	for (const set of [hs, vs]) for (let i = 1; i < set.length; i++) if (set[i]!.pos - set[i - 1]!.pos <= EPS) return null;
	const x0 = vs[0]!.pos, x1 = vs[vs.length - 1]!.pos, y0 = hs[0]!.pos, y1 = hs[hs.length - 1]!.pos;
	if (hs.some((l) => Math.abs(l.lo - x0) > EPS || Math.abs(l.hi - x1) > EPS)) return null;
	if (vs.some((l) => Math.abs(l.lo - y0) > EPS || Math.abs(l.hi - y1) > EPS)) return null;
	const first = hs[0]!.stroke;
	const widths = lines.map((l) => l.stroke.width);
	const width = Math.min(...widths);
	const style: TableStyle = { color: first.color, width };
	if (first.dash) style.dash = first.dash;
	if (first.opacity !== undefined && lines.every((l) => l.stroke.opacity === first.opacity)) style.opacity = first.opacity;
	const under = hs[1]!.stroke.width;
	if (hs.length >= 3 && under > width && hs.every((l, i) => i === 1 || l.stroke.width === width) && vs.every((l) => l.stroke.width === width)) style.headerWidth = under;
	return { grid: { xs: vs.map((l) => l.pos), ys: hs.map((l) => l.pos) }, style, strokes: [...strokes] };
}

/** The table among the strokes of a selection: every stroke is of one group and that group is a table (null otherwise, e.g. other ink selected too). */
export function tableOfSelection(strokes: readonly Stroke[], elementCount = 0): DetectedTable | null {
	if (elementCount > 0 || strokes.length === 0) return null;
	const group = strokes[0]!.group;
	if (group === undefined || strokes.some((s) => s.group !== group)) return null;
	return detectTable(strokes);
}

// --- edits of a grid (a new grid; null when the edit is not possible) ---

/** What a row or column insert moves: ink at or beyond `from` along `axis` goes `by` further. */
export interface InsertShift {
	axis: "x" | "y";
	from: number;
	by: number;
}

export interface GridEdit {
	grid: TableGrid;
	shift?: InsertShift;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** A row after row `at` (0-based), as tall as that row. */
export function insertRow(g: TableGrid, at: number): GridEdit | null {
	const rows = rowsOf(g);
	if (rows >= TABLE_MAX_ROWS || at < 0 || at >= rows) return null;
	const h = g.ys[at + 1]! - g.ys[at]!;
	const ys = [...g.ys.slice(0, at + 2), ...g.ys.slice(at + 1).map((y) => r2(y + h))];
	return { grid: { xs: g.xs, ys }, shift: { axis: "y", from: g.ys[at + 1]!, by: h } };
}

/** A column after column `at` (0-based), as wide as that column. */
export function insertCol(g: TableGrid, at: number): GridEdit | null {
	const cols = colsOf(g);
	if (cols >= TABLE_MAX_COLS || at < 0 || at >= cols) return null;
	const w = g.xs[at + 1]! - g.xs[at]!;
	const xs = [...g.xs.slice(0, at + 2), ...g.xs.slice(at + 1).map((x) => r2(x + w))];
	return { grid: { xs, ys: g.ys }, shift: { axis: "x", from: g.xs[at + 1]!, by: w } };
}

/** Drops the last row (never the only one). Ink is left alone. */
export function removeLastRow(g: TableGrid): GridEdit | null {
	return rowsOf(g) <= 1 ? null : { grid: { xs: g.xs, ys: g.ys.slice(0, -1) } };
}

/** Drops the last column (never the only one). Ink is left alone. */
export function removeLastCol(g: TableGrid): GridEdit | null {
	return colsOf(g) <= 1 ? null : { grid: { xs: g.xs.slice(0, -1), ys: g.ys } };
}

/** Every row as tall and every column as wide as the others, the outer frame unchanged. Null when it already is. */
export function evenCells(g: TableGrid): GridEdit | null {
	const spread = (v: readonly number[]): number[] => {
		const lo = v[0]!, hi = v[v.length - 1]!, n = v.length - 1;
		return v.map((_, i) => r2(lo + ((hi - lo) * i) / n));
	};
	const xs = spread(g.xs), ys = spread(g.ys);
	const same = xs.every((x, i) => Math.abs(x - g.xs[i]!) <= EPS) && ys.every((y, i) => Math.abs(y - g.ys[i]!) <= EPS);
	return same ? null : { grid: { xs, ys } };
}

/** The row (or column) a position falls in; the last one when it is outside the table (so an insert there appends). */
export function cellIndexAt(lines: readonly number[], v: number): number {
	for (let i = 0; i < lines.length - 1; i++) if (v >= lines[i]! && v < lines[i + 1]!) return i;
	return lines.length - 2;
}

/** A piece of ink the edit may move: its id and its box. */
export interface InkBox {
	id: string;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	group?: string;
	hidden?: boolean;
}

/**
 * The ink an insert pushes along: ink that is in no group, visible, lies fully inside the table (before the edit) and beyond the inserted
 * line along the axis of the insert. Ink that crosses the line, or that is partly outside the table, stays.
 */
export function inkToShift(grid: TableGrid, shift: InsertShift, ink: readonly InkBox[]): string[] {
	const t = tableBox(grid);
	const out: string[] = [];
	for (const b of ink) {
		if (b.group !== undefined || b.hidden) continue;
		if (b.minX < t.minX - EPS || b.maxX > t.maxX + EPS || b.minY < t.minY - EPS || b.maxY > t.maxY + EPS) continue;
		if ((shift.axis === "y" ? b.minY : b.minX) >= shift.from - EPS) out.push(b.id);
	}
	return out;
}

/**
 * The cell lines of every table among `strokes` as alignment lines for the snap engine (model/snap.ts): a moved box can be pulled to a
 * row or column line of a table that is on the page, in addition to the table's outline. Strokes that are not a whole table are skipped.
 */
export function tableSnapLines(strokes: readonly Stroke[]): { vertical: SnapLine[]; horizontal: SnapLine[] } {
	const vertical: SnapLine[] = [];
	const horizontal: SnapLine[] = [];
	const byGroup = new Map<string, Stroke[]>();
	for (const s of strokes) {
		if (s.group === undefined || s.tool !== "shape") continue;
		const list = byGroup.get(s.group);
		if (list) list.push(s);
		else byGroup.set(s.group, [s]);
	}
	for (const list of byGroup.values()) {
		const t = detectTable(list);
		if (!t) continue;
		const box = tableBox(t.grid);
		for (const x of t.grid.xs) vertical.push({ pos: x, lo: box.minY, hi: box.maxY, kind: "edge" });
		for (const y of t.grid.ys) horizontal.push({ pos: y, lo: box.minX, hi: box.maxX, kind: "edge" });
	}
	return { vertical, horizontal };
}
