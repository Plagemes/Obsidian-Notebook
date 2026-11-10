import { fmt, parseCellNumber, regress, summarize, type Regression, type Summary } from "../math/stats";
import { tableBox, type TableGrid } from "./table";
import { columnOf, hasHeaderRow } from "./table-numbers";

/**
 * What the statistics card shows (0.29, roadmap #295): a summary of one column and, when a second column is chosen, the least-squares line of
 * that column against the first. Pure; the card (view/table-stats.ts) draws it and the "Insert as text" action turns it into a text box.
 */
export interface TableStatsModel {
	/** The cells of the table, header row removed when there is one. */
	data: string[][];
	/** One name per column: the header text, or "" when there is no header (the card then says "Column 1"). */
	names: string[];
	/** Whether the first row was taken as a header. */
	header: boolean;
	/** Columns that hold at least one number. */
	numeric: number[];
}

export function modelOf(cells: readonly (readonly string[])[], cols: number): TableStatsModel {
	const isNum = (s: string): boolean => parseCellNumber(s) !== null;
	const header = hasHeaderRow(cells, isNum);
	const data = (header ? cells.slice(1) : cells).map((r) => [...r]);
	const names = Array.from({ length: cols }, (_, c) => (header ? (cells[0]![c] ?? "").trim() : ""));
	const numeric: number[] = [];
	for (let c = 0; c < cols; c++) if (columnOf(data, c).some(isNum)) numeric.push(c);
	return { data, names, header, numeric };
}

export interface TableStatsReport {
	column: number;
	against: number | null;
	summary: Summary | null;
	regression: Regression | null;
}

/** The numbers for column `column` and, when `against` is another column, the line of `against` (y) over `column` (x). */
export function reportOf(m: TableStatsModel, column: number, against: number | null): TableStatsReport {
	const xs = columnOf(m.data, column);
	const second = against !== null && against !== column ? against : null;
	return {
		column,
		against: second,
		summary: summarize(xs),
		regression: second === null ? null : regress(xs, columnOf(m.data, second)),
	};
}

/** The words the text version needs; the view fills them from the translations. */
export interface ReportWords {
	column(name: string, index: number): string;
	title(col: string): string;
	count(n: number, skipped: number): string;
	mean: string;
	median: string;
	sd: string;
	min: string;
	max: string;
	sum: string;
	regressionTitle(y: string, x: string): string;
	line: string;
	notEnough: string;
	noNumbers: string;
}

/** The rows [label, value] of the summary of a report (empty when the column has no number). */
export function summaryRows(r: TableStatsReport, w: ReportWords): Array<[string, string]> {
	const s = r.summary;
	if (!s) return [];
	return [
		[w.count(s.count, s.skipped), ""],
		[w.mean, fmt(s.mean)],
		[w.median, fmt(s.median)],
		[w.sd, s.sd === null ? "-" : fmt(s.sd)],
		[w.min, fmt(s.min)],
		[w.max, fmt(s.max)],
		[w.sum, fmt(s.sum)],
	];
}

/** The rows of the regression: the line, slope, intercept and r². Empty when there is none. */
export function regressionRows(r: TableStatsReport, labels: { slope: string; intercept: string; r2: string }): Array<[string, string]> {
	const g = r.regression;
	if (!g) return [];
	return [
		[labels.slope, fmt(g.slope)],
		[labels.intercept, fmt(g.intercept)],
		[labels.r2, g.r2 === null ? "-" : fmt(g.r2)],
	];
}

/** "y = 2x + 1" with the signs tidied. */
export function lineText(g: Regression): string {
	const slope = fmt(g.slope);
	const icpt = g.intercept;
	const tail = icpt === 0 ? "" : ` ${icpt < 0 ? "-" : "+"} ${fmt(Math.abs(icpt))}`;
	return `y = ${slope}x${tail}`;
}

/** The plain text of a report, for a text box or the clipboard. */
export function reportText(m: TableStatsModel, r: TableStatsReport, w: ReportWords, regLabels: { slope: string; intercept: string; r2: string }): string {
	const name = (c: number): string => w.column(m.names[c] ?? "", c);
	const lines: string[] = [w.title(name(r.column))];
	if (!r.summary) lines.push(w.noNumbers);
	else for (const [k, v] of summaryRows(r, w)) lines.push(v === "" ? k : `${k}: ${v}`);
	if (r.against !== null) {
		lines.push("", w.regressionTitle(name(r.against), name(r.column)));
		if (!r.regression) lines.push(w.notEnough);
		else {
			lines.push(lineText(r.regression));
			for (const [k, v] of regressionRows(r, regLabels)) lines.push(`${k}: ${v}`);
			if (r.regression.skipped > 0) lines.push(w.count(r.regression.count, r.regression.skipped));
		}
	}
	return lines.join("\n");
}

/**
 * Where the text box of a report goes: to the right of the table, top-aligned, when there is room on the page; else under it; always
 * inside the page. Pure geometry, x/y/width in page units.
 */
export function boxBeside(grid: TableGrid, page: { width: number; height: number; infinite?: boolean }, width: number, gap = 14): { x: number; y: number; width: number } {
	const b = tableBox(grid);
	const w = Math.min(width, Math.max(60, page.width - 16));
	let x = b.maxX + gap;
	let y = b.minY;
	if (x + w > page.width - 8) {
		x = b.minX;
		y = b.maxY + gap;
	}
	x = Math.max(8, Math.min(x, page.width - w - 8));
	if (!page.infinite) y = Math.max(8, Math.min(y, page.height - 40));
	return { x, y, width: w };
}
