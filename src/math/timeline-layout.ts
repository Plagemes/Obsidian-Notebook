import { layoutText } from "../ink/text-layout";

/**
 * Timeline element (0.30, roadmap #148): the pure part. Dates are read from text (plain years, years BC / AD, centuries in Arabic or Roman
 * numerals, decades, year ranges, calendar dates), turned into a position on one number line, and laid out as an axis with proportional
 * spacing, ticks, event dots and flag-style labels. No 'obsidian' import: `ink/timeline.ts` turns the layout into strokes and text boxes.
 *
 * POSITIONS are astronomical years: 1 AD is 1, 1 BC is 0, 2 BC is -1 (so the distance between 1 BC and 1 AD is one year, as it is). A
 * calendar date adds its fraction of the year. Nothing here is stored in the document: the position is derived from the text of the label,
 * so editing the text of a label and running "Edit timeline" moves its dot.
 *
 * SPACING is proportional to the real distance. When one gap is more than four times all the other gaps together (3000 BC to 1900, then
 * 1900 to 1969) the proportional drawing would squeeze every other event onto one spot, so such a gap is COMPRESSED: it is drawn as a
 * fixed-length dashed piece of axis with a "//" break and a note of the true length ("4900 years"), and the other gaps share the rest of
 * the axis. At most three gaps are compressed. Ticks are drawn only on the proportional parts.
 *
 * LABELS are flags: a pole from the dot to the label, the label to the right of the pole, above or below the axis. Labels that would
 * touch are stacked in bands, the later (right-hand) event always on the nearer band, so no pole crosses a label.
 */

// --- dates ---

export const MAX_EVENTS = 24;
export const MAX_LABEL = 160;

export type DateKind = "year" | "range" | "decade" | "century" | "day";

export interface ParsedDate {
	/** Astronomical year (fractional for a calendar date; the middle of a century, decade or range). */
	pos: number;
	kind: DateKind;
}

const MONTHS: Record<string, number> = {
	jan: 1, january: 1, gen: 1, gennaio: 1, feb: 2, february: 2, febbraio: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4, aprile: 4,
	may: 5, mag: 5, maggio: 5, jun: 6, june: 6, giu: 6, giugno: 6, jul: 7, july: 7, lug: 7, luglio: 7, aug: 8, august: 8, ago: 8, agosto: 8,
	sep: 9, sept: 9, september: 9, set: 9, settembre: 9, oct: 10, october: 10, ott: 10, ottobre: 10, nov: 11, november: 11, novembre: 11,
	dec: 12, december: 12, dic: 12, dicembre: 12,
};

const MAX_YEAR = 999999;

/** Astronomical position of year `n` (1 and up) AD or BC. */
export const yearPos = (n: number, bc: boolean): number => (bc ? 1 - n : n);

const dayFraction = (month: number, day: number): number => ((month - 1) * 31 + (day - 1)) / 372;

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

/** A Roman numeral (i to xcix), or null when it is not a well-formed one. */
export function romanValue(s: string): number | null {
	if (!/^[ivxlc]{1,8}$/.test(s)) return null;
	let total = 0;
	for (let i = 0; i < s.length; i++) {
		const v = ROMAN[s[i]!]!;
		const next = ROMAN[s[i + 1] ?? ""] ?? 0;
		total += v < next ? -v : v;
	}
	// ill-formed numerals ("iiii", "vx") do not come back as themselves
	return total >= 1 && total <= 99 && toRoman(total) === s ? total : null;
}

function toRoman(n: number): string {
	const table: Array<[number, string]> = [[90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
	let out = "";
	for (const [v, sym] of table) while (n >= v) {
		out += sym;
		n -= v;
	}
	return out;
}

const BC_SUFFIX = /(^|\s|\d)(?:bce|bc|ac|a c|aev|avanti cristo|before christ|prima di cristo)$/;
const AD_SUFFIX = /(^|\s|\d)(?:ad|ce|dc|d c|ev|dopo cristo|anno domini)$/;
const BC_PREFIX = /^()(?:bce|bc)\s+/;
const AD_PREFIX = /^()(?:ad|ce|anno domini)\s+/;

/**
 * The position of a date typed as text, or null when it is not understood. Understood (case and dots do not matter):
 * `1492`, `1492 AD`, `AD 1492`, `44 BC`, `44 a.C.`, `-44` (BC), `c. 1500`, `1914-1918`, `490-479 BC`, `1960s`, `5th century BC`, `XV secolo`,
 * `2 d.C.`, `1789-07-14`, `14/07/1789`, `14 July 1789`, `luglio 1789`. There is no year 0.
 */
export function parseTimelineDate(raw: string): ParsedDate | null {
	let s = raw.toLowerCase().replace(/[−‒–—]/g, "-").replace(/\s+/g, " ").trim();
	if (s === "" || s.length > 60) return null;
	for (let i = 0; i < 2; i++) s = s.replace(/^(?:circa|ca\.?|c\.|about|around|approx\.?|approximately|verso il|verso|intorno al|intorno|~)\s*(?=[\d-])/, "").replace(/^(?:the|il|lo|la|nel|in)\s+/, "");
	// calendar dates
	let m = /^(\d{1,6})-(\d{1,2})-(\d{1,2})$/.exec(s) ?? null;
	let dmy: [number, number, number] | null = m ? [Number(m[3]), Number(m[2]), Number(m[1])] : null;
	if (!dmy) {
		m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{1,6})$/.exec(s);
		if (m) dmy = [Number(m[1]), Number(m[2]), Number(m[3])];
	}
	if (dmy) {
		const [d, mo, y] = dmy;
		return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { pos: y + dayFraction(mo, d), kind: "day" } : null;
	}
	m = /^(?:(\d{1,2})\s+)?([a-z]+)\s*,?\s*(?:of\s+|del\s+|di\s+)?(\d{1,6})$/.exec(s);
	const month = m ? MONTHS[m[2]!] : undefined;
	if (m && month !== undefined) {
		const day = m[1] === undefined ? 1 : Number(m[1]);
		const y = Number(m[3]);
		return y >= 1 && day >= 1 && day <= 31 ? { pos: y + dayFraction(month, day), kind: "day" } : null;
	}
	// the era
	let body = s.replace(/\./g, "").replace(/\s+/g, " ").trim();
	const found: Array<"bc" | "ad"> = [];
	const strip = (re: RegExp, kind: "bc" | "ad"): void => {
		if (re.test(body)) {
			body = body.replace(re, "$1").trim();
			found.push(kind);
		}
	};
	strip(BC_SUFFIX, "bc");
	strip(AD_SUFFIX, "ad");
	strip(BC_PREFIX, "bc");
	strip(AD_PREFIX, "ad");
	if (found.length > 1) return null;
	const era = found[0] ?? null;
	const bc = era === "bc";
	// centuries
	const centuryOf = (n: number | null): ParsedDate | null => n === null || n < 1 || n > 99 ? null : { pos: bc ? -n * 100 + 50.5 : (n - 1) * 100 + 50.5, kind: "century" };
	m = /^(\d{1,2})(?:st|nd|rd|th|°|º|ª)?\s*(?:century|cent|secolo|sec|c)$/.exec(body);
	if (m) return centuryOf(Number(m[1]));
	m = /^([ivxlc]{1,8})\s*(?:century|cent|secolo|sec)$/.exec(body);
	if (m) return centuryOf(romanValue(m[1]!));
	m = /^(?:century|cent|secolo|sec)\s*(\d{1,2}|[ivxlc]{1,8})$/.exec(body);
	if (m) return centuryOf(/^\d/.test(m[1]!) ? Number(m[1]) : romanValue(m[1]!));
	// decades
	m = /^(\d{3,4})s$/.exec(body);
	if (m) return bc ? null : { pos: Number(m[1]) + 4.5, kind: "decade" };
	// ranges
	m = /^(\d{1,6})\s*-\s*(\d{1,6})$/.exec(body);
	if (m) {
		const a = Number(m[1]);
		let b = Number(m[2]);
		if (m[2]!.length < m[1]!.length && !bc) b = Number(m[1]!.slice(0, m[1]!.length - m[2]!.length) + m[2]);
		if (a < 1 || b < 1 || a > MAX_YEAR || b > MAX_YEAR) return null;
		return { pos: (yearPos(a, bc) + yearPos(b, bc)) / 2, kind: "range" };
	}
	// years
	m = /^(-?)(\d{1,6})$/.exec(body);
	if (m) {
		const n = Number(m[2]);
		if (n < 1 || n > MAX_YEAR) return null;
		if (m[1] === "-" && era !== null) return null;
		return { pos: yearPos(n, bc || m[1] === "-"), kind: "year" };
	}
	return null;
}

/** The label of a year for a tick: `1492`, `500 BC` (`bc` is the word for BC). */
export function yearLabel(display: number, bc: string): string {
	return display < 0 ? `${-display} ${bc}` : String(display);
}

export interface TimelineEvent {
	/** The date as typed (the first line of the label's text box). */
	dateText: string;
	label: string;
	pos: number;
}

export interface LineProblem {
	/** 1-based line of the typed text. */
	line: number;
	text: string;
	reason: "date" | "long";
}

/** The date and the label of one typed line: the longest start of the line that is a date, the rest is the label. Null when none is. */
export function splitEventLine(line: string): { dateText: string; label: string; date: ParsedDate } | null {
	let best: { at: number; date: ParsedDate } | null = null;
	for (let i = 1; i <= line.length; i++) {
		const ch = line[i] ?? " ";
		if (i < line.length && !" \t:|;,".includes(ch)) continue;
		const date = parseTimelineDate(line.slice(0, i));
		if (date) best = { at: i, date };
	}
	if (!best) return null;
	return {
		dateText: line.slice(0, best.at).trim().replace(/\s+/g, " "),
		label: line.slice(best.at).replace(/^[\s:|;,\-–—]+/, "").trim().replace(/\s+/g, " "),
		date: best.date,
	};
}

/** The events of typed text, one per line (`date: label`, also `date - label`, `date, label`, `date label`), in time order. */
export function parseEventLines(text: string): { events: TimelineEvent[]; problems: LineProblem[]; dropped: number } {
	const events: TimelineEvent[] = [];
	const problems: LineProblem[] = [];
	let dropped = 0;
	text.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
		const line = raw.trim();
		if (line === "") return;
		if (line.length > 2 * MAX_LABEL) {
			problems.push({ line: i + 1, text: line, reason: "long" });
			return;
		}
		const split = splitEventLine(line);
		if (!split) {
			problems.push({ line: i + 1, text: line, reason: "date" });
			return;
		}
		if (split.label.length > MAX_LABEL) {
			problems.push({ line: i + 1, text: line, reason: "long" });
			return;
		}
		if (events.length >= MAX_EVENTS) {
			dropped++;
			return;
		}
		events.push({ dateText: split.dateText, label: split.label, pos: split.date.pos });
	});
	return { events: events.map((e, i) => ({ e, i })).sort((a, b) => a.e.pos - b.e.pos || a.i - b.i).map(({ e }) => e), problems, dropped };
}

/** The text of an event as it is written in its label box, and back. */
export const eventText = (e: Pick<TimelineEvent, "dateText" | "label">): string => (e.label === "" ? e.dateText : `${e.dateText}\n${e.label}`);

export function eventFromText(text: string): TimelineEvent | null {
	const nl = text.indexOf("\n");
	const first = (nl < 0 ? text : text.slice(0, nl)).trim().replace(/\s+/g, " ");
	const date = parseTimelineDate(first);
	if (!date) return null;
	return { dateText: first, label: nl < 0 ? "" : text.slice(nl + 1).replace(/\s+/g, " ").trim(), pos: date.pos };
}

// --- layout ---

export const TIMELINE_INK = "#1f2430";
export const TIMELINE_MUTED = "#667085";

export const TITLE_SIZE = 13;
/** The size of the text of an event; the size tells the kinds of text box of a timeline apart when it is read back. */
export const EVENT_SIZE = 10;
export const TICK_SIZE = 8;

/** Padding of the block at its sides, and room beyond the first and last dot on the axis, pt. */
export const PADX = 8;
const PADY = 8;
const EXT = 12;
/** Width of a label box and the space between its pole and its text. */
export const BOX_W = 92;
const FLAG = 4;
/** Horizontal space kept between two labels in one band. */
const GAPX = 6;
const DOT_R = 3.6;
const BAND_GAP = 8;
/** Room between the axis and the nearest band, above and below (below also holds the tick labels). */
const NEAR_ABOVE = 12;
const NEAR_BELOW = 24;
const MIN_TICK_PX = 56;
const MAX_COMPRESSED = 3;
const COMPRESS_RATIO = 4;
const LINE_H = 1.25;

/** Block width = axis length + PADX on both sides + the label of the last dot (which starts EXT before the end of the axis). */
export const blockWidth = (axisLength: number): number => axisLength + 2 * PADX + BOX_W + FLAG - EXT;
export const axisLengthOf = (width: number): number => width - 2 * PADX - BOX_W - FLAG + EXT;
export const MIN_AXIS = 120;

export interface TimelineLabels {
	/** The word for BC in tick labels. */
	bc: string;
	/** The note on a compressed gap, from its true length in years. */
	gap: (years: number) => string;
}

export interface TimelineStyle {
	title: string;
	/** `#rrggbb` of the dots and poles. */
	colour: string;
	labels: TimelineLabels;
}

type Vec = readonly [number, number];
interface ShapeBase {
	color: string;
	width: number;
	fill?: string;
	dash?: "dashed" | "dotted";
}
export type TimelinePoly = ShapeBase & { type: "poly"; vertices: Vec[]; closed: boolean };
export type TimelineCircle = ShapeBase & { type: "circle"; cx: number; cy: number; r: number };
export type TimelineShape = TimelinePoly | TimelineCircle;

export interface TimelineText {
	x: number;
	y: number;
	width: number;
	text: string;
	size: number;
	color: string;
	/** The text as wrapped (pessimistically), for pictures that cannot wrap. */
	lines: string[];
}

export interface TimelineLayout {
	shapes: TimelineShape[];
	texts: TimelineText[];
	/** Size of the block; (0, 0) is its top-left corner. */
	width: number;
	height: number;
	/** The axis starts at (x0, axisY). */
	x0: number;
	axisY: number;
	/** How many gaps are drawn compressed. */
	compressed: number;
}

const round = (v: number): number => Math.round(v * 100) / 100;
const measureOf = (size: number) => (s: string): number => Array.from(s).length * size * 0.6;

function textAt(x: number, y: number, text: string, size: number, color: string, width: number): TimelineText {
	const laid = layoutText(text, size, width, measureOf(size));
	return { x: round(x), y: round(y), width: round(width), text, size, color, lines: laid.lines };
}

/** A one-line text box wide enough for its text. */
function lineAt(x: number, y: number, text: string, size: number, color: string): TimelineText {
	const w = Math.ceil(Array.from(text).length * size * 0.55 * 1.3 + 6);
	return { x: round(x), y: round(y), width: w, text, size, color, lines: [text] };
}

const clipText = (s: string, max: number): string => {
	const chars = Array.from(s);
	const m = Math.max(1, Math.floor(max));
	return chars.length <= m ? s : m <= 1 ? "…" : chars.slice(0, m - 1).join("") + "…";
};

/** Which gaps of the distinct positions are drawn compressed (indexes into the gaps). */
export function compressedGaps(positions: readonly number[]): Set<number> {
	const out = new Set<number>();
	if (positions.length < 3) return out;
	const gaps = positions.slice(1).map((p, i) => p - positions[i]!);
	while (out.size < MAX_COMPRESSED) {
		let k = -1;
		let rest = 0;
		let count = 0;
		for (let i = 0; i < gaps.length; i++) if (!out.has(i)) {
			rest += gaps[i]!;
			count++;
			if (k < 0 || gaps[i]! > gaps[k]!) k = i;
		}
		if (count < 2 || k < 0) break;
		if (gaps[k]! > COMPRESS_RATIO * (rest - gaps[k]!)) out.add(k);
		else break;
	}
	return out;
}

/** The nice step (1, 2 or 5 times a power of ten, at least 1) that is at least `min`. */
export function niceStep(min: number): number {
	if (!(min > 1)) return 1;
	const pow = Math.pow(10, Math.floor(Math.log10(min)));
	for (const m of [1, 2, 5, 10]) if (m * pow >= min) return m * pow;
	return 10 * pow;
}

/** The position of a displayed year (display 0 is the boundary between 1 BC and 1 AD; 1 BC is -1). */
const displayPos = (d: number): number => (d < 0 ? d + 1 : d > 0 ? d : 0.5);
const posDisplay = (p: number): number => (p >= 0.5 ? p : p - 1);

/**
 * The timeline of `events` (in time order, at least one) on a block `width` wide. Each event's label is a flag; `style.title` (when not empty)
 * is at the top left. The block's height follows the labels.
 */
export function layoutTimeline(events: readonly TimelineEvent[], style: TimelineStyle, width: number): TimelineLayout {
	const shapes: TimelineShape[] = [];
	const texts: TimelineText[] = [];
	const L = Math.max(MIN_AXIS, axisLengthOf(width));
	const W = blockWidth(L);
	const x0 = PADX;
	const x1 = x0 + L;
	const dotRange = L - 2 * EXT;

	// distinct positions and where they go on the axis
	const positions: number[] = [];
	for (const e of events) if (positions.length === 0 || positions[positions.length - 1] !== e.pos) positions.push(e.pos);
	const compressed = compressedGaps(positions);
	const px: number[] = positions.length === 1 ? [x0 + EXT + dotRange / 2] : [];
	let perYear = 0;
	if (positions.length > 1) {
		const gapPx = compressed.size === 0 ? 0 : Math.min(Math.max(60, 0.2 * dotRange), (0.4 * dotRange) / compressed.size);
		let proportional = 0;
		for (let i = 0; i + 1 < positions.length; i++) if (!compressed.has(i)) proportional += positions[i + 1]! - positions[i]!;
		const rest = dotRange - gapPx * compressed.size;
		perYear = proportional > 0 ? rest / proportional : 0;
		let x = x0 + EXT;
		px.push(x);
		for (let i = 0; i + 1 < positions.length; i++) {
			x += compressed.has(i) ? gapPx : (positions[i + 1]! - positions[i]!) * perYear;
			px.push(x);
		}
	}
	const xOf = (pos: number): number => px[positions.indexOf(pos)]!;
	const xs = events.map((e) => xOf(e.pos));

	// bands: later events nearer to the axis, so no pole crosses a label
	const n = events.length;
	const reach = BOX_W + FLAG + GAPX;
	const boxes = events.map((e) => textAt(0, 0, eventText(e), EVENT_SIZE, TIMELINE_INK, BOX_W));
	const heights = boxes.map((b) => b.lines.length * EVENT_SIZE * LINE_H);
	const level: number[] = new Array<number>(n).fill(0);
	const above: boolean[] = new Array<boolean>(n).fill(true);
	for (let i = n - 1; i >= 0; i--) {
		let la = 0, lb = 0;
		for (let j = i + 1; j < n && xs[j]! - xs[i]! < reach; j++) {
			if (above[j]!) la = Math.max(la, level[j]! + 1);
			else lb = Math.max(lb, level[j]! + 1);
		}
		above[i] = la < lb ? true : lb < la ? false : i % 2 === 0;
		level[i] = above[i] ? la : lb;
	}
	const bandH = (up: boolean): number[] => {
		const out: number[] = [];
		for (let i = 0; i < n; i++) if (above[i] === up) out[level[i]!] = Math.max(out[level[i]!] ?? 0, heights[i]!);
		return out;
	};
	const offsets = (up: boolean): { at: number[]; extent: number } => {
		const hs = bandH(up);
		const at: number[] = [];
		let off = up ? NEAR_ABOVE : NEAR_BELOW;
		for (let k = 0; k < hs.length; k++) {
			at[k] = off;
			off += (hs[k] ?? 0) + BAND_GAP;
		}
		return { at, extent: hs.length === 0 ? 0 : off - BAND_GAP };
	};
	const up = offsets(true);
	const down = offsets(false);
	const title = style.title.trim();
	const titleH = title === "" ? 0 : TITLE_SIZE * LINE_H + 6;
	const axisY = round(PADY + titleH + Math.max(up.extent, 14));
	const height = round(axisY + Math.max(down.extent, 20) + PADY);
	if (title !== "") texts.push(lineAt(PADX, PADY, clipText(title, (W - 2 * PADX) / (TITLE_SIZE * 0.6)), TITLE_SIZE, TIMELINE_INK));

	// the axis: solid parts, dashed in a compressed gap
	const axis = (xa: number, xb: number, dash?: "dashed"): void => {
		shapes.push({ type: "poly", vertices: [[round(xa), axisY], [round(xb), axisY]], closed: false, color: dash ? TIMELINE_MUTED : TIMELINE_INK, width: 1.6, ...(dash ? { dash } : {}) });
	};
	let from = x0;
	const breaks: number[] = [];
	for (let i = 0; i + 1 < positions.length; i++) if (compressed.has(i)) {
		axis(from, px[i]!);
		axis(px[i]!, px[i + 1]!, "dashed");
		breaks.push((px[i]! + px[i + 1]!) / 2);
		from = px[i + 1]!;
		const years = Math.max(1, Math.round(positions[i + 1]! - positions[i]!));
		texts.push(lineAt((px[i]! + px[i + 1]!) / 2 - (Array.from(style.labels.gap(years)).length * TICK_SIZE * 0.55) / 2, axisY + 7, style.labels.gap(years), TICK_SIZE, TIMELINE_MUTED));
	}
	axis(from, x1);
	shapes.push({ type: "poly", vertices: [[round(x1 - 6), round(axisY - 4)], [round(x1), axisY], [round(x1 - 6), round(axisY + 4)]], closed: false, color: TIMELINE_INK, width: 1.6 });
	for (const bx of breaks) for (const dx of [-4, 4]) {
		shapes.push({ type: "poly", vertices: [[round(bx + dx - 2.5), round(axisY + 5)], [round(bx + dx + 2.5), round(axisY - 5)]], closed: false, color: TIMELINE_INK, width: 1.4 });
	}

	// ticks on the proportional parts
	if (positions.length > 1 && perYear > 0) {
		const step = niceStep(MIN_TICK_PX / perYear);
		const lo = Math.ceil(posDisplay(positions[0]!) / step) * step;
		const hi = Math.floor(posDisplay(positions[positions.length - 1]!) / step) * step;
		for (let d = lo; d <= hi && (hi - lo) / step <= 60; d += step) {
			const p = displayPos(d);
			let seg = -1;
			for (let i = 0; i + 1 < positions.length; i++) if (!compressed.has(i) && p >= positions[i]! && p <= positions[i + 1]!) {
				seg = i;
				break;
			}
			if (seg < 0) continue;
			const x = px[seg]! + (p - positions[seg]!) * perYear;
			shapes.push({ type: "poly", vertices: [[round(x), round(axisY - 3)], [round(x), round(axisY + 3)]], closed: false, color: TIMELINE_MUTED, width: 1 });
			const label = yearLabel(d, style.labels.bc);
			const half = (Array.from(label).length * TICK_SIZE * 0.55) / 2 + 3;
			if (!xs.some((dx) => Math.abs(dx - x) < half + 2) && !breaks.some((bx) => Math.abs(bx - x) < half + 8)) texts.push(lineAt(x - half + 3, axisY + 5, label, TICK_SIZE, TIMELINE_MUTED));
		}
	}

	// poles, labels and dots
	const dots: TimelineShape[] = [];
	for (let i = 0; i < n; i++) {
		const x = xs[i]!;
		const h = heights[i]!;
		const isUp = above[i]!;
		const near = (isUp ? up : down).at[level[i]!]!;
		const top = isUp ? axisY - near - h : axisY + near;
		const farEnd = isUp ? top : top + h;
		shapes.push({ type: "poly", vertices: [[round(x), round(axisY + (isUp ? -DOT_R : DOT_R))], [round(x), round(farEnd)]], closed: false, color: style.colour, width: 1.2 });
		const box = boxes[i]!;
		texts.push({ ...box, x: round(x + FLAG), y: round(top) });
		dots.push({ type: "circle", cx: round(x), cy: axisY, r: DOT_R, color: style.colour, width: 1.5, fill: style.colour });
	}
	shapes.push(...dots);
	return { shapes, texts, width: round(W), height, x0, axisY, compressed: compressed.size };
}
