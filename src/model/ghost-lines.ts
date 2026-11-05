/**
 * Ghost guide lines on blank paper (roadmap #94). Pure: no 'obsidian', no canvas, no document format.
 *
 * After a first line of handwriting, the baseline and the line height are inferred from the last strokes (their boxes), and
 * two faint dashed guides (the baseline in use and the next one) are drawn near the pen for a moment. Nothing is stored,
 * exported or printed: the result lives on the renderer's live layer only.
 *
 * Cheap on purpose: `inferGhostLines` runs once per finished stroke over at most `MAX_STROKES` boxes (a few hundred
 * comparisons), never per frame.
 */

export type GhostMode = "off" | "writing" | "always";
export const GHOST_MODES: readonly GhostMode[] = ["off", "writing", "always"];
export const DEFAULT_GHOST_MODE: GhostMode = "off";

/** Fixed line spacings (mm) offered next to "auto"; 8 mm is the ruled paper default. */
export const GHOST_SPACINGS_MM: readonly number[] = [6, 7, 8, 9, 10];
/** "auto" follows the handwriting; otherwise one of GHOST_SPACINGS_MM as text (a settings dropdown holds text). */
export const DEFAULT_GHOST_SPACING = "auto";
const PT_PER_MM = 72 / 25.4;

export const normaliseGhostMode = (v: unknown): GhostMode => (v === "off" || v === "writing" || v === "always" ? v : DEFAULT_GHOST_MODE);

export function normaliseGhostSpacing(v: unknown): string {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && GHOST_SPACINGS_MM.includes(n) ? String(n) : DEFAULT_GHOST_SPACING;
}

/** Idle time (ms) before the guides start to fade in "when writing" mode, and how long the fade takes. */
export const GHOST_IDLE_MS = 1600;
export const GHOST_FADE_MS = 700;

/** The box of one finished stroke, page coordinates (pt). Callers pass the pen strokes of the page, oldest first. */
export interface GhostBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface GhostLines {
	/** Baseline through (`x`, `y`) with this slope (dy/dx, small). */
	x: number;
	y: number;
	slope: number;
	/** Vertical distance between two lines, pt. */
	spacing: number;
	/** Horizontal extent of the line that was written, pt. */
	x0: number;
	x1: number;
	/** How many strokes the baseline was inferred from. */
	strokes: number;
}

/** The newest strokes looked at. */
export const MAX_STROKES = 48;
/** A line needs this many strokes (and this much width) before it counts as a first line of text. */
export const MIN_LINE_STROKES = 3;
export const MIN_LINE_WIDTH = 36;
/** Largest tilt of a line of writing that is followed (degrees); beyond it the line is taken as flat. */
export const MAX_TILT_DEG = 12;
export const MIN_SPACING = 14;
export const MAX_SPACING = 60;
/** Line spacing as a multiple of the median stroke height when there is no earlier line to measure. */
const SPACING_PER_HEIGHT = 2.4;
/** A stroke taller than this multiple of the median height, or wider than WIDTH_FACTOR times it, is a drawing, not text. */
const TALL_FACTOR = 3.2;
const WIDE_FACTOR = 22;
/** Absolute limits: a stroke bigger than this is never a letter, whatever the rest looks like (pt). */
const MAX_TEXT_HEIGHT = 44;
const MAX_TEXT_WIDTH = 180;

const median = (values: number[]): number => {
	values.sort((a, b) => a - b);
	const n = values.length;
	return n === 0 ? 0 : n % 2 ? values[(n - 1) / 2]! : (values[n / 2 - 1]! + values[n / 2]!) / 2;
};

const valid = (b: GhostBox): boolean =>
	Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY) && b.maxX >= b.minX && b.maxY >= b.minY;

/** Slope of a set of (cx, bottom) points: the median of the pairwise slopes (robust to descenders), clamped to the tilt we follow. */
function lineSlope(xs: number[], ys: number[]): number {
	const slopes: number[] = [];
	for (let i = 0; i < xs.length; i++) {
		for (let j = i + 1; j < xs.length; j++) {
			const dx = xs[j]! - xs[i]!;
			if (Math.abs(dx) < 8) continue;
			slopes.push((ys[j]! - ys[i]!) / dx);
		}
	}
	if (slopes.length === 0) return 0;
	const maxSlope = Math.tan((MAX_TILT_DEG * Math.PI) / 180);
	const s = median(slopes);
	return Math.abs(s) > maxSlope ? 0 : s;
}

/**
 * The baseline, line height and extent of the line of writing the newest strokes belong to, or null when there is no line
 * yet (fewer than `MIN_LINE_STROKES` strokes on a line, or only drawings).
 *
 * - Drawings are outliers: a box much taller or much wider than the typical handwriting stroke is left out.
 * - The baseline of a stroke is the bottom of its box; descenders are a minority, so the median of the line is used.
 * - A line may be tilted (up to `MAX_TILT_DEG`): strokes are grouped by their distance to the fitted line, not to a flat one.
 * - If the newest stroke starts a new line (too few strokes yet), the latest line that already has enough is used.
 * - `fixedSpacing` (pt) replaces the inferred line height; 0 or absent means follow the writing.
 */
export function inferGhostLines(boxes: readonly GhostBox[], fixedSpacing = 0): GhostLines | null {
	const recent: GhostBox[] = [];
	for (let i = Math.max(0, boxes.length - MAX_STROKES); i < boxes.length; i++) if (valid(boxes[i]!)) recent.push(boxes[i]!);
	if (recent.length < MIN_LINE_STROKES) return null;

	const heights = recent.map((b) => Math.max(1, b.maxY - b.minY));
	const medH = median(heights.slice());
	const text: GhostBox[] = [];
	for (const b of recent) {
		const h = b.maxY - b.minY;
		const w = b.maxX - b.minX;
		if (h <= Math.min(MAX_TEXT_HEIGHT, TALL_FACTOR * medH) && w <= Math.min(MAX_TEXT_WIDTH, WIDE_FACTOR * medH)) text.push(b);
	}
	if (text.length < MIN_LINE_STROKES) return null;
	const textH = median(text.map((b) => Math.max(1, b.maxY - b.minY)));
	const tol = Math.max(3, 0.9 * textH);

	const taken = new Uint8Array(text.length);
	const cx = (b: GhostBox) => (b.minX + b.maxX) / 2;
	interface Row { ax: number; ay: number; slope: number; count: number; x0: number; x1: number }
	const rows: Row[] = [];
	let found: Row | null = null;

	// Newest stroke first: its line, then the newest stroke left over, and so on.
	for (let seed = text.length - 1; seed >= 0; seed--) {
		if (taken[seed]) continue;
		let slope = 0;
		let ax = cx(text[seed]!);
		let ay = text[seed]!.maxY;
		let members: number[] = [];
		// Two passes: flat first, then along the fitted tilt.
		for (let pass = 0; pass < 2; pass++) {
			members = [];
			for (let i = 0; i < text.length; i++) {
				if (taken[i]) continue;
				const b = text[i]!;
				if (Math.abs(b.maxY - (ay + slope * (cx(b) - ax))) <= tol) members.push(i);
			}
			if (pass === 0 && members.length >= 2) slope = lineSlope(members.map((i) => cx(text[i]!)), members.map((i) => text[i]!.maxY));
		}
		if (members.length === 0) { taken[seed] = 1; continue; }
		let mx = 0;
		let x0 = Infinity;
		let x1 = -Infinity;
		for (const i of members) {
			taken[i] = 1;
			const b = text[i]!;
			mx += cx(b);
			x0 = Math.min(x0, b.minX);
			x1 = Math.max(x1, b.maxX);
		}
		mx /= members.length;
		// Baseline of the line: the median bottom, relative to the fitted slope, at the line's mean x.
		const y = median(members.map((i) => text[i]!.maxY - slope * (cx(text[i]!) - mx)));
		const row: Row = { ax: mx, ay: y, slope, count: members.length, x0, x1 };
		rows.push(row);
		if (!found && row.count >= MIN_LINE_STROKES && x1 - x0 >= MIN_LINE_WIDTH) found = row;
	}
	if (!found) return null;

	let spacing = fixedSpacing > 0 ? fixedSpacing : 0;
	if (spacing <= 0) {
		// Measure against the nearest other line of writing when there is one; else guess from the size of the writing.
		const guess = SPACING_PER_HEIGHT * textH;
		let best = Infinity;
		for (const r of rows) {
			if (r === found || r.count < 2) continue;
			const d = Math.abs(r.ay + r.slope * (found.ax - r.ax) - found.ay);
			if (d >= guess * 0.5 && d <= guess * 2.5 && d < best) best = d;
		}
		spacing = Number.isFinite(best) ? best : guess;
	}
	spacing = Math.min(MAX_SPACING, Math.max(MIN_SPACING, spacing));
	return { x: found.ax, y: found.ay, slope: found.slope, spacing, x0: found.x0, x1: found.x1, strokes: found.count };
}

/** A guide to draw: a segment in page coordinates and how strong it is (the baseline in use is stronger than the next). */
export interface GhostSegment {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	strength: number;
}

/** How far past the written line the guides run (pt). */
export const GHOST_REACH = 220;

/**
 * The segments to draw for `lines` on a page `pageWidth` wide: the baseline in use and the next one. They start a little
 * before the written line and run past it, clamped to the page.
 */
export function ghostSegments(lines: GhostLines, pageWidth: number, pageHeight: number): GhostSegment[] {
	const left = Math.max(0, lines.x0 - 12);
	const right = Math.min(pageWidth, lines.x1 + GHOST_REACH);
	if (!(right - left > 8)) return [];
	const out: GhostSegment[] = [];
	const at = (x: number, dy: number) => lines.y + dy + lines.slope * (x - lines.x);
	const next = lines.spacing;
	for (const [dy, strength] of [[0, 0.55], [next, 1]] as const) {
		const y1 = at(left, dy);
		const y2 = at(right, dy);
		if (y1 < 0 || y2 < 0 || y1 > pageHeight || y2 > pageHeight) continue;
		out.push({ x1: left, y1, x2: right, y2, strength });
	}
	return out;
}

/** Opacity (0..1) of the guides `elapsed` ms after the last stroke ended; "always" never fades. */
export function ghostAlpha(mode: GhostMode, elapsed: number): number {
	if (mode === "off") return 0;
	if (mode === "always" || elapsed <= GHOST_IDLE_MS) return 1;
	const t = (elapsed - GHOST_IDLE_MS) / GHOST_FADE_MS;
	return t >= 1 ? 0 : 1 - t;
}

/**
 * 0.20 review (D4): whether a new stroke has to redraw the guides. Only when they had started to fade ("writing" mode, past the
 * idle time): otherwise the alpha is 1 before and after, and the redraw would land on the first frame of the stroke for nothing.
 */
export function ghostTouchRedraws(mode: GhostMode, elapsed: number): boolean {
	return mode === "writing" && elapsed > GHOST_IDLE_MS;
}

/** Whether the guides apply to this page (blank paper only). */
export const ghostApplies = (mode: GhostMode, paperKind: string): boolean => mode !== "off" && paperKind === "blank";

/** The fixed spacing in pt for a saved setting value, or 0 to follow the handwriting. */
export const ghostSpacingPt = (setting: string): number => {
	const mm = Number(normaliseGhostSpacing(setting));
	return mm > 0 ? mm * PT_PER_MM : 0;
};
