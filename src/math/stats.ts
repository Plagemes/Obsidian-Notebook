// Descriptive statistics and simple linear regression over plain numbers (0.29, roadmap #295). Pure: no DOM, no Obsidian.

/** The minus signs typeset by keyboards and word processors (U+2212, U+2012, U+2013), built from code points so the source stays plain ASCII. */
const MINUS_SIGNS = new RegExp("[" + String.fromCharCode(0x2212, 0x2012, 0x2013) + "]", "g");

/**
 * Reads one cell of a table as a number, or null when it is not one. Accepts a decimal comma ("3,5"), the typographic minus, spaces or a
 * non-breaking space as thousands separators and, when both separators appear, takes the LAST one as the decimal mark ("1.234,5" and
 * "1,234.5" are both 1234.5). A lone comma is a decimal mark ("1,234" is 1.234). Anything else ("abc", "3 kg", "") is not a number.
 */
export function parseCellNumber(raw: string): number | null {
	let s = raw.replace(/\s/g, "").replace(MINUS_SIGNS, "-");
	if (s === "") return null;
	const comma = s.lastIndexOf(",");
	const dot = s.lastIndexOf(".");
	if (comma >= 0 && dot >= 0) {
		const decimal = comma > dot ? "," : ".";
		const group = decimal === "," ? /\./g : /,/g;
		s = s.replace(group, "").replace(decimal, ".");
	} else if (comma >= 0) {
		if (s.indexOf(",") !== comma) return null; // several commas and no dot: not a number
		s = s.replace(",", ".");
	}
	if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/** The numbers of a list of cell texts, plus how many non-empty cells were not numbers (empty cells are not counted at all). */
export interface ColumnNumbers {
	values: number[];
	skipped: number;
}

export function numbersOf(cells: readonly string[]): ColumnNumbers {
	const values: number[] = [];
	let skipped = 0;
	for (const c of cells) {
		if (c.trim() === "") continue;
		const n = parseCellNumber(c);
		if (n === null) skipped++;
		else values.push(n);
	}
	return { values, skipped };
}

export interface Summary {
	count: number;
	/** Non-empty cells that were not numbers. */
	skipped: number;
	sum: number;
	mean: number;
	median: number;
	min: number;
	max: number;
	/** Sample standard deviation (n - 1); null with fewer than two values. */
	sd: number | null;
	/** Population standard deviation (n). */
	sdPop: number;
}

/** The summary of a column, or null when it holds no number. */
export function summarize(cells: readonly string[]): Summary | null {
	const { values, skipped } = numbersOf(cells);
	const n = values.length;
	if (n === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	let sum = 0;
	for (const v of values) sum += v;
	const mean = sum / n;
	let ss = 0;
	for (const v of values) ss += (v - mean) * (v - mean);
	const mid = n >> 1;
	const median = n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
	return {
		count: n, skipped, sum, mean, median, min: sorted[0]!, max: sorted[n - 1]!,
		sd: n >= 2 ? Math.sqrt(ss / (n - 1)) : null, sdPop: Math.sqrt(ss / n),
	};
}

export interface Regression {
	/** Rows used: both cells numbers. */
	count: number;
	/** Rows left out because one of the two cells was not a number (rows empty in both are not counted). */
	skipped: number;
	slope: number;
	intercept: number;
	/** Coefficient of determination; null when y does not vary (the fit is flat, r is undefined). */
	r2: number | null;
}

/** Least-squares line y = slope * x + intercept through the rows where both cells are numbers; null with fewer than two rows or all x equal. */
export function regress(xs: readonly string[], ys: readonly string[]): Regression | null {
	const px: number[] = [];
	const py: number[] = [];
	let skipped = 0;
	const len = Math.max(xs.length, ys.length);
	for (let i = 0; i < len; i++) {
		const a = xs[i] ?? "";
		const b = ys[i] ?? "";
		if (a.trim() === "" && b.trim() === "") continue;
		const x = parseCellNumber(a);
		const y = parseCellNumber(b);
		if (x === null || y === null) skipped++;
		else {
			px.push(x);
			py.push(y);
		}
	}
	const n = px.length;
	if (n < 2) return null;
	let mx = 0, my = 0;
	for (let i = 0; i < n; i++) {
		mx += px[i]!;
		my += py[i]!;
	}
	mx /= n;
	my /= n;
	let sxx = 0, syy = 0, sxy = 0;
	for (let i = 0; i < n; i++) {
		const dx = px[i]! - mx;
		const dy = py[i]! - my;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	if (sxx === 0) return null;
	const slope = sxy / sxx;
	return { count: n, skipped, slope, intercept: my - slope * mx, r2: syy === 0 ? null : Math.min(1, (sxy * sxy) / (sxx * syy)) };
}

/** A number for a card or a text box: at most `digits` significant digits, no trailing zeros, no "-0". */
export function fmt(n: number, digits = 6): string {
	if (!Number.isFinite(n)) return "-";
	const r = Number(n.toPrecision(digits));
	const s = Object.is(r, -0) ? "0" : String(r);
	return s;
}
