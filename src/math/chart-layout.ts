/**
 * Charts from table data (0.29, roadmap #244). Pure: no 'obsidian', no canvas, no DOM. Three steps, each testable alone:
 *
 *  1. `parseCellNumber`: the text of a cell as a number (a decimal comma, thousands separators, a percent or currency sign), or null.
 *  2. `chartDataFromCells`: a grid of cell texts as labels and series (the first column names the rows, the first row names the series
 *     when it holds no number), counting what was left out.
 *  3. `layoutChart`: a bar, line or pie chart in a box as plain primitives (polygons, circles, texts). `ink/chart.ts` turns them into
 *     ordinary vector shape strokes and text boxes, so every render and export path draws a chart with no change to the document format.
 *
 * Scales and ticks (`niceTicks`) and pie angles (`pieSlices`) are exported for the tests.
 */

export type Vec = readonly [number, number];

export const CHART_KINDS = ["bar", "line", "pie"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** At most this many series are drawn (the palette has eight colours); extra columns are counted in `droppedSeries`. */
export const CHART_MAX_SERIES = 8;
/** At most this many pie slices are drawn; the smallest ones beyond it are joined into one "other" slice. */
export const PIE_MAX_SLICES = 12;

/** Fixed look of everything that is not data. */
export const CHART_INK = "#1f2430";
export const CHART_MUTED = "#667085";
export const CHART_FRAME = "#c8cdd8";
const GRID = "#9aa3b2";

export const TITLE_SIZE = 13;
export const LABEL_SIZE = 9;
export const VALUE_SIZE = 8;
const LINE_H = 1.25;
const PAD = 10;

// --- numbers from text ---

const GROUPED = /^\d{1,3}$/;

/** `body` (digits and separators only) as a number, `dec` being its decimal separator (or null when it has none). Null when the grouping is wrong. */
function numberOf(body: string, dec: "." | "," | null): number | null {
	const thousands = dec === "." ? "," : dec === "," ? "." : body.includes(",") ? "," : body.includes(".") ? "." : null;
	let whole = body;
	let frac = "";
	if (dec !== null) {
		const at = body.lastIndexOf(dec);
		whole = body.slice(0, at);
		frac = body.slice(at + 1);
		if (!/^\d+$/.test(frac)) return null;
	}
	if (thousands !== null && whole.includes(thousands)) {
		const groups = whole.split(thousands);
		if (!GROUPED.test(groups[0]!) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
		whole = groups.join("");
	}
	if (!/^\d*$/.test(whole) || (whole === "" && frac === "")) return null;
	const n = Number(`${whole === "" ? "0" : whole}${frac === "" ? "" : "." + frac}`);
	return Number.isFinite(n) ? n : null;
}

/**
 * The number a cell's text stands for, or null. Spaces are ignored; "−" is a minus; a sign for percent or currency (€ $ £ ¥) is dropped;
 * with one separator it is the decimal one ("3,5" and "3.5" are 3.5, as the app is used in Italian), with several of one kind they are
 * thousands separators ("1.234.567"), and with both the last one is the decimal separator ("1.234,5" and "1,234.5" are 1234.5).
 */
export function parseCellNumber(raw: string): number | null {
	let s = raw.replace(/[\s  ]/g, "").replace(/[−‒–]/g, "-");
	if (s === "") return null;
	s = s.replace(/%$/, "").replace(/^([+-]?)[€$£¥]/, "$1").replace(/[€$£¥]$/, "");
	let neg = false;
	if (s.startsWith("-")) {
		neg = true;
		s = s.slice(1);
	} else if (s.startsWith("+")) s = s.slice(1);
	if (s === "" || !/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
	const dots = (s.match(/\./g) ?? []).length;
	const commas = (s.match(/,/g) ?? []).length;
	let dec: "." | "," | null = null;
	if (dots > 0 && commas > 0) dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
	else if (commas === 1) dec = ",";
	else if (dots === 1) dec = ".";
	// Both kinds present: the other kind may only be thousands separators (they cannot repeat after the decimal one).
	if (dec !== null && (s.match(dec === "." ? /\./g : /,/g) ?? []).length > 1) return null;
	const n = numberOf(s, dec);
	return n === null ? null : neg ? -n : n;
}

// --- data from cells ---

export interface ChartSeries {
	/** The text of the header cell ("" when the table has no header row). */
	name: string;
	/** One value per label; null where the cell is empty or not a number. */
	values: Array<number | null>;
}

export interface ChartData {
	labels: string[];
	series: ChartSeries[];
	/** Non-empty cells of the data area that are not numbers (left out). */
	skipped: number;
	/** Numeric columns beyond `CHART_MAX_SERIES` (left out). */
	droppedSeries: number;
	/** The first row was read as the names of the series. */
	header: boolean;
}

/** How many numbers the chart will show (pie: only the first series). */
export function countNumbers(data: ChartData, kind: ChartKind = "bar"): number {
	const list = kind === "pie" ? data.series.slice(0, 1) : data.series;
	let n = 0;
	for (const s of list) for (const v of s.values) if (v !== null) n++;
	return n;
}

/**
 * The labels and series of a grid of cell texts (`cells[row][col]`). With two columns or more the first column holds the labels and every
 * other column is a series; with one column its numbers are one series labelled 1, 2, 3. The first row is a header (the names of the series)
 * when the table has another row and no cell of its value columns is a number. Rows with no label and no value are left out; a column with no
 * number at all is not a series.
 */
export function chartDataFromCells(cells: ReadonlyArray<readonly string[]>): ChartData {
	const empty: ChartData = { labels: [], series: [], skipped: 0, droppedSeries: 0, header: false };
	const rows = cells.length;
	const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
	if (rows === 0 || cols === 0) return empty;
	const at = (r: number, c: number): string => (cells[r]?.[c] ?? "").trim();
	const valueCols = cols >= 2 ? Array.from({ length: cols - 1 }, (_, i) => i + 1) : [0];
	const header = rows >= 2 && valueCols.every((c) => parseCellNumber(at(0, c)) === null);
	const dataRows: number[] = [];
	for (let r = header ? 1 : 0; r < rows; r++) {
		if (at(r, 0) === "" && valueCols.every((c) => at(r, c) === "")) continue;
		dataRows.push(r);
	}
	if (dataRows.length === 0) return { ...empty, header };
	let skipped = 0;
	const series: ChartSeries[] = [];
	for (const c of valueCols) {
		const values = dataRows.map((r) => {
			const text = at(r, c);
			const n = parseCellNumber(text);
			if (n === null && text !== "") skipped++;
			return n;
		});
		if (values.some((v) => v !== null)) series.push({ name: header ? at(0, c) : "", values });
	}
	const labels = dataRows.map((r, i) => (cols >= 2 && at(r, 0) !== "" ? at(r, 0) : String(i + 1)));
	return { labels, series: series.slice(0, CHART_MAX_SERIES), skipped, droppedSeries: Math.max(0, series.length - CHART_MAX_SERIES), header };
}

// --- scales and ticks ---

export interface Ticks {
	ticks: number[];
	lo: number;
	hi: number;
	step: number;
}

/** A "nice" number (1, 2, 5 times a power of ten) near `v`; rounded to the nearest, else the next one up. */
function niceNumber(v: number, round: boolean): number {
	const e = Math.floor(Math.log10(v));
	const f = v / Math.pow(10, e);
	let nf: number;
	if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
	else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
	return nf * Math.pow(10, e);
}

/** Decimals needed to write multiples of `step` exactly (capped). */
export function decimalsOf(step: number): number {
	if (!(step > 0) || !Number.isFinite(step)) return 0;
	return Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
}

/**
 * Axis ticks covering [min, max] with about `count` marks at round values. A flat range is widened (down to zero for a positive value, up to
 * zero for a negative one); no finite input gives 0..1. The ticks run from `lo` to `hi`, both multiples of `step`.
 */
export function niceTicks(min: number, max: number, count = 5): Ticks {
	let a = Number.isFinite(min) ? min : 0;
	let b = Number.isFinite(max) ? max : 1;
	if (a > b) [a, b] = [b, a];
	if (a === b) {
		if (a === 0) b = 1;
		else if (a > 0) a = 0;
		else b = 0;
	}
	const marks = Math.max(2, Math.round(count));
	const step = niceNumber(niceNumber(b - a, false) / (marks - 1), true);
	const lo = Math.floor(a / step + 1e-9) * step;
	const hi = Math.ceil(b / step - 1e-9) * step;
	const d = decimalsOf(step);
	const k = Math.pow(10, d);
	const ticks: number[] = [];
	for (let v = lo, i = 0; v <= hi + step * 1e-6 && i < 200; i++, v = lo + i * step) ticks.push(Math.round(v * k) / k);
	return { ticks, lo: ticks[0] ?? lo, hi: ticks[ticks.length - 1] ?? hi, step };
}

/** A tick or value as text: no more decimals than the step needs (or two), millions as "1.5M". */
export function formatValue(v: number, step?: number): string {
	if (!Number.isFinite(v)) return "";
	if (Math.abs(v) >= 1e6) return `${trim((v / 1e6).toFixed(2))}M`;
	const d = step !== undefined ? decimalsOf(step) : 2;
	return trim(v.toFixed(Math.min(d, 6)));
}

const trim = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

// --- pie ---

export interface PieSlice {
	label: string;
	value: number;
	/** Share of the total, 0..1. */
	fraction: number;
	/** Angles in radians, clockwise from the top (12 o'clock is -π/2 in page coordinates, y down). */
	start: number;
	end: number;
}

/**
 * The slices of a pie: positive values only (zero, negative and missing ones have no slice), in the order given, clockwise from the top.
 * Beyond `PIE_MAX_SLICES` the smallest are joined into one slice named `otherLabel` that comes last. Empty when the total is not positive.
 */
export function pieSlices(labels: readonly string[], values: ReadonlyArray<number | null>, otherLabel = "…"): PieSlice[] {
	let items = values.map((v, i) => ({ label: labels[i] ?? String(i + 1), value: v ?? 0, i })).filter((s) => s.value > 0);
	if (items.length > PIE_MAX_SLICES) {
		const keep = new Set([...items].sort((a, b) => b.value - a.value || a.i - b.i).slice(0, PIE_MAX_SLICES - 1).map((s) => s.i));
		const rest = items.filter((s) => !keep.has(s.i));
		items = [...items.filter((s) => keep.has(s.i)), { label: otherLabel, value: rest.reduce((n, s) => n + s.value, 0), i: Infinity }];
	}
	const total = items.reduce((n, s) => n + s.value, 0);
	if (!(total > 0)) return [];
	let a = -Math.PI / 2;
	return items.map((s) => {
		const fraction = s.value / total;
		const start = a;
		a += fraction * 2 * Math.PI;
		return { label: s.label, value: s.value, fraction, start, end: a };
	});
}

/** A share as text: "42", or "<1" for a slice that rounds to nothing. */
export function percentText(fraction: number): string {
	const p = Math.round(fraction * 100);
	return p === 0 && fraction > 0 ? "<1" : String(p);
}

// --- layout ---

export interface ChartBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ChartStyleSpec {
	title: string;
	/** Series (bar, line) or slice (pie) colours in order, `#rrggbb`; used round when there are more series than colours. */
	colours: readonly string[];
	/** The name of the joined slice of a pie with many slices. */
	otherLabel?: string;
}

interface ShapeBase {
	color: string;
	width: number;
	fill?: string;
	/** 0.05–1; absent = full strength. */
	opacity?: number;
}
/** A polygon or polyline; a closed one ends where it starts. */
export type ChartPoly = ShapeBase & { type: "poly"; vertices: Vec[]; closed: boolean };
export type ChartCircle = ShapeBase & { type: "circle"; cx: number; cy: number; r: number };
export type ChartShape = ChartPoly | ChartCircle;

/** A text box: (x, y) is the top-left corner, `width` is room enough for the text on one line. */
export interface ChartText {
	x: number;
	y: number;
	width: number;
	text: string;
	size: number;
	color: string;
}

export interface ChartLayout {
	shapes: ChartShape[];
	texts: ChartText[];
}

/** Width in pt of `s` at the font size (the default is a rough fixed pitch, as `estimateMeasure` of the text layout). */
export type Measure = (s: string, size: number) => number;
const estimate: Measure = (s, size) => Array.from(s).length * size * 0.55;

const colourAt = (colours: readonly string[], i: number): string => colours.length === 0 ? CHART_INK : colours[i % colours.length]!;

/** `s` shortened with an ellipsis to at most `max` characters (a minimum of one). */
export function clip(s: string, max: number): string {
	const chars = Array.from(s);
	const m = Math.max(1, Math.floor(max));
	return chars.length <= m ? s : m <= 1 ? "…" : chars.slice(0, m - 1).join("") + "…";
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

class Out {
	readonly shapes: ChartShape[] = [];
	readonly texts: ChartText[] = [];
	constructor(private readonly measure: Measure) {}

	poly(vertices: Vec[], closed: boolean, color: string, width: number, extra: Partial<ShapeBase> = {}): void {
		this.shapes.push({ type: "poly", vertices, closed, color, width, ...extra });
	}

	circle(cx: number, cy: number, r: number, color: string, width: number, extra: Partial<ShapeBase> = {}): void {
		this.shapes.push({ type: "circle", cx, cy, r, color, width, ...extra });
	}

	/** Text whose top-left corner is (x, y). */
	text(x: number, y: number, text: string, size: number, color: string): void {
		if (text === "") return;
		this.texts.push({ x: round(x), y: round(y), width: Math.ceil(this.measure(text, size) * 1.3 + 6), text, size, color });
	}

	width(text: string, size: number): number {
		return this.measure(text, size);
	}

	/** Text centred on (cx, cy). */
	centred(cx: number, cy: number, text: string, size: number, color: string): void {
		this.text(cx - this.width(text, size) / 2, cy - (size * LINE_H) / 2, text, size, color);
	}

	/** Text that ends at x, centred vertically on cy. */
	endAt(x: number, cy: number, text: string, size: number, color: string): void {
		this.text(x - this.width(text, size), cy - (size * LINE_H) / 2, text, size, color);
	}

	/** Text that starts at x, centred vertically on cy. */
	startAt(x: number, cy: number, text: string, size: number, color: string): void {
		this.text(x, cy - (size * LINE_H) / 2, text, size, color);
	}
}

const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * A chart in `box`. The first shape is the frame (the outline of the box, so the box is the bounding box of the shapes); the title is at the
 * top left; bar and line charts have a value axis with round ticks and light grid lines, one label per row under the axis (every k-th when
 * they would touch) and a legend when there are several series; a pie has its legend at the right with the share of each slice. Data that
 * has nothing to show (no numbers) gives the frame and the title only.
 */
export function layoutChart(kind: ChartKind, data: ChartData, style: ChartStyleSpec, box: ChartBox, measure: Measure = estimate): ChartLayout {
	const out = new Out(measure);
	const { x, y, width: w, height: h } = box;
	out.poly(rect(x, y, x + w, y + h), true, CHART_FRAME, 1);
	const title = style.title.trim();
	const titleH = title === "" ? 0 : TITLE_SIZE * LINE_H + 6;
	if (title !== "") out.text(x + PAD, y + PAD, clip(title, Math.max(4, (w - 2 * PAD) / (TITLE_SIZE * 0.55))), TITLE_SIZE, CHART_INK);
	if (countNumbers(data, kind) === 0) return { shapes: out.shapes, texts: out.texts };
	if (kind === "pie") pie(out, data, style, box, y + PAD + titleH);
	else cartesian(out, kind, data, style, box, y + PAD + titleH);
	return { shapes: out.shapes, texts: out.texts };
}

function cartesian(out: Out, kind: "bar" | "line", data: ChartData, style: ChartStyleSpec, box: ChartBox, top0: number): void {
	const { x, y, width: w, height: h } = box;
	const n = data.labels.length;
	const multi = data.series.length > 1;
	const legendH = multi ? 18 : 0;
	const xLabelH = LABEL_SIZE * LINE_H + 4;
	let min = Infinity, max = -Infinity;
	for (const s of data.series) for (const v of s.values) if (v !== null) { min = Math.min(min, v); max = Math.max(max, v); }
	let lo0 = min, hi0 = max;
	if (kind === "bar") {
		lo0 = Math.min(0, min);
		hi0 = Math.max(0, max);
	} else if (min >= 0 && min < 0.6 * max) lo0 = 0;
	const axis = niceTicks(lo0, hi0, 5);
	const tickText = axis.ticks.map((t) => formatValue(t, axis.step));
	const yLabelW = tickText.reduce((m, s) => Math.max(m, out.width(s, LABEL_SIZE)), 0);
	const top = top0 + (kind === "bar" ? 14 : 8);
	const bottom = y + h - PAD - legendH - xLabelH;
	const left = x + PAD + yLabelW + 6;
	const right = x + w - PAD;
	if (right - left < 24 || bottom - top < 24 || n === 0) return;
	const yOf = (v: number): number => bottom - ((v - axis.lo) / (axis.hi - axis.lo)) * (bottom - top);
	const zeroY = yOf(Math.min(Math.max(0, axis.lo), axis.hi));

	// Grid lines and value labels.
	axis.ticks.forEach((t, i) => {
		const ty = yOf(t);
		if (Math.abs(ty - zeroY) > 0.5 && ty > top - 0.5) out.poly([[left, ty], [right, ty]], false, GRID, 0.6, { opacity: 0.45 });
		out.endAt(left - 5, ty, tickText[i]!, LABEL_SIZE, CHART_MUTED);
	});

	const band = (right - left) / n;
	const centre = (i: number): number => left + (i + 0.5) * band;
	const k = Math.max(1, Math.ceil(22 / band));
	const maxChars = Math.max(2, Math.floor((band * k) / (LABEL_SIZE * 0.55)));
	data.labels.forEach((label, i) => {
		if (i % k === 0) out.centred(centre(i), bottom + 3 + (LABEL_SIZE * LINE_H) / 2, clip(label, maxChars), LABEL_SIZE, CHART_MUTED);
	});

	if (kind === "bar") {
		const s = data.series.length;
		const groupW = band * 0.72;
		const barW = groupW / s;
		const labelled = n * s <= 14;
		data.series.forEach((series, si) => {
			const colour = colourAt(style.colours, si);
			series.values.forEach((v, i) => {
				if (v === null) return;
				const x0 = centre(i) - groupW / 2 + si * barW;
				const yv = yOf(v);
				if (Math.abs(yv - zeroY) >= 0.5) out.poly(rect(x0, Math.min(yv, zeroY), x0 + barW, Math.max(yv, zeroY)), true, colour, 0.8, { fill: colour });
				if (labelled) {
					const text = formatValue(v);
					if (out.width(text, VALUE_SIZE) <= barW + 8) out.centred(x0 + barW / 2, v >= 0 ? Math.min(yv, zeroY) - 7 : Math.max(yv, zeroY) + 7, text, VALUE_SIZE, CHART_INK);
				}
			});
		});
	} else {
		data.series.forEach((series, si) => {
			const colour = colourAt(style.colours, si);
			let run: Vec[] = [];
			const flush = (): void => {
				if (run.length >= 2) out.poly(run, false, colour, 2);
				run = [];
			};
			series.values.forEach((v, i) => {
				if (v === null) flush();
				else run.push([centre(i), yOf(v)]);
			});
			flush();
			series.values.forEach((v, i) => {
				if (v !== null) out.circle(centre(i), yOf(v), 2.6, colour, 0.6, { fill: colour });
			});
		});
	}

	// Axes over the data: the left one and the zero line.
	out.poly([[left, top - 2], [left, bottom]], false, CHART_INK, 1);
	out.poly([[left, zeroY], [right, zeroY]], false, CHART_INK, 1);

	if (multi) legend(out, data.series.map((s, i) => ({ text: s.name === "" ? String(i + 1) : s.name, colour: colourAt(style.colours, i) })), left, y + h - PAD - legendH / 2, right);
}

/** A row of swatches with names from x to at most `limit`. */
function legend(out: Out, items: ReadonlyArray<{ text: string; colour: string }>, x: number, cy: number, limit: number): void {
	let cx = x;
	for (const it of items) {
		const text = clip(it.text, 14);
		const need = 12 + out.width(text, LABEL_SIZE);
		if (cx + need > limit) break;
		out.poly(rect(cx, cy - 4, cx + 8, cy + 4), true, it.colour, 0.8, { fill: it.colour });
		out.startAt(cx + 12, cy, text, LABEL_SIZE, CHART_INK);
		cx += need + 12;
	}
}

function pie(out: Out, data: ChartData, style: ChartStyleSpec, box: ChartBox, top: number): void {
	const { x, y, width: w, height: h } = box;
	const first = data.series[0];
	if (!first) return;
	const slices = pieSlices(data.labels, first.values, style.otherLabel ?? "…");
	if (slices.length === 0) return;
	const rows = slices.map((s) => `${s.label} ${percentText(s.fraction)}%`);
	const widest = rows.reduce((m, s) => Math.max(m, out.width(s, LABEL_SIZE)), 0);
	const legendW = Math.min(widest + 14, Math.max(60, (w - 2 * PAD) * 0.45));
	const bottom = y + h - PAD;
	const r = Math.max(8, Math.min((w - 2 * PAD - legendW - 12) / 2, (bottom - top) / 2));
	const cx = x + PAD + r;
	const cy = (top + bottom) / 2;
	slices.forEach((s, i) => {
		const colour = colourAt(style.colours, i);
		if (s.fraction >= 0.9999) {
			out.circle(cx, cy, r, colour, 0.8, { fill: colour });
			return;
		}
		const steps = Math.max(2, Math.ceil(((s.end - s.start) * 180) / Math.PI / 4));
		const v: Vec[] = [[cx, cy]];
		for (let j = 0; j <= steps; j++) {
			const a = s.start + ((s.end - s.start) * j) / steps;
			v.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
		}
		out.poly(v, true, colour, 0.8, { fill: colour });
	});
	// Legend: swatch, name and share, one row per slice, centred on the pie.
	const rowH = Math.min(15, Math.max(11, (bottom - top) / slices.length));
	const lx = cx + r + 14;
	const ly = cy - (rowH * (slices.length - 1)) / 2;
	const room = x + w - PAD - (lx + 12);
	slices.forEach((s, i) => {
		const colour = colourAt(style.colours, i);
		const yy = ly + i * rowH;
		out.poly(rect(lx, yy - 4, lx + 8, yy + 4), true, colour, 0.8, { fill: colour });
		const tail = ` ${percentText(s.fraction)}%`;
		const labelMax = Math.max(2, Math.floor(room / (LABEL_SIZE * 0.55)) - Array.from(tail).length);
		out.startAt(lx + 12, yy, clip(s.label, labelMax) + tail, LABEL_SIZE, CHART_INK);
	});
}
