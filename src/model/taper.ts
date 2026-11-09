// Stroke taper (format v25, roadmap #351): pure helpers, no 'obsidian'.

import { isLinePen, RENDER_INK, type Stroke, type Tool } from "./types";

/**
 * The optional `taperStart` and `taperEnd` of a stroke: how much its line thins towards its first and its last point, a number in
 * [TAPER_MIN, TAPER_MAX]. 0 (and an absent value) is the look of every earlier version: the line keeps its width up to the end. Written only
 * when the end is tapered, so a notebook that never uses it is byte for byte what earlier versions wrote.
 *
 * The value is a LENGTH measured in line widths, so the same setting looks the same on a fine pen and on a broad one and survives a stroke being
 * scaled: the taper spans `value * TAPER_SPAN` widths of the stroke (1 = twelve widths, 0.5 = six, 0.05 = a bit over half a width), but never
 * more than half the stroke's own length (a short stroke tapers into a spindle, a dot stays a dot). Over that length the radius of the line
 * grows from TAPER_TIP of its normal size at the very end to the full size, along an ease-out curve (`taperFactor`): a pointed tip that fills
 * out quickly, like the flick of a pen. Only the lines of handwriting taper (pen, fountain pen, brush: `isLinePen`); the highlighter, the
 * marker and shapes keep their constant ends, and only strokes of the wet-ink geometry (render 2) can taper.
 */
export const TAPER_MIN = 0.05;
export const TAPER_MAX = 1;
/** The slider's step (5 %). */
export const TAPER_STEP = 0.05;
/** A taper of 1 spans this many line widths. */
export const TAPER_SPAN = 12;
/** Share of the normal radius left at the very tip of a tapered end. */
export const TAPER_TIP = 0.04;

/** A value the format accepts. */
export function isTaper(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= TAPER_MIN && v <= TAPER_MAX;
}

/**
 * The taper to store for a requested value: clamped to the allowed range and rounded to a whole percent; undefined (nothing stored) for none,
 * for less than the smallest taper, or for a value that is not a number.
 */
export function normaliseTaper(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	const rounded = Math.round(Math.min(TAPER_MAX, Math.max(0, v)) * 100) / 100;
	return rounded < TAPER_MIN ? undefined : rounded;
}

/** The taper an end is drawn with: its own, or 0 (none) when it has none or an invalid one. */
export function taperOf(v: number | undefined): number {
	return v !== undefined && isTaper(v) ? v : 0;
}

/** Whole percent, for labels. */
export function taperPercent(v: number | undefined): number {
	return Math.round(taperOf(v) * 100);
}

/** A slider position in percent as the value to use: 0 (no taper) or a whole percent from 5 to 100. */
export function taperFromPercent(percent: number): number {
	const p = Math.min(100, Math.max(0, Math.round(percent)));
	return p < Math.round(TAPER_MIN * 100) ? 0 : p / 100;
}

/** The two ends of a stroke's taper (each 0 = none). */
export interface Taper {
	start: number;
	end: number;
}

/** Whether a stroke of this tool and geometry can carry a taper at all (see `TAPER_MIN`): a line pen drawn by the wet-ink geometry. */
export function canTaper(tool: Tool, render?: number): boolean {
	return isLinePen(tool) && (render === undefined || render === RENDER_INK);
}

/** The taper `stroke` is drawn with, or undefined when neither end is tapered (the common case: nothing to do). */
export function strokeTaper(stroke: Pick<Stroke, "tool" | "render"> & { taperStart?: number; taperEnd?: number }): Taper | undefined {
	if (stroke.taperStart === undefined && stroke.taperEnd === undefined) return undefined;
	if (!canTaper(stroke.tool, stroke.render)) return undefined;
	const start = taperOf(stroke.taperStart), end = taperOf(stroke.taperEnd);
	return start === 0 && end === 0 ? undefined : { start, end };
}

/** Length (pt) the taper `value` spans on a line of `width`. */
export function taperLength(value: number, width: number): number {
	return value * TAPER_SPAN * width;
}

/** Share of the normal radius at distance `u` (0 at the tip, 1 and more where the line has its full size) along the taper. */
export function taperFactor(u: number): number {
	if (!(u > 0)) return TAPER_TIP;
	if (u >= 1) return 1;
	return TAPER_TIP + (1 - TAPER_TIP) * u * (2 - u);
}

/** `item` with the ends set (an end of 0 or less than the smallest taper is removed). The very same object when nothing changes. */
export function withTaper<T extends { taperStart?: number; taperEnd?: number }>(item: T, start: number | undefined, end: number | undefined): T {
	const s = normaliseTaper(start), e = normaliseTaper(end);
	if (s === item.taperStart && e === item.taperEnd) return item;
	const { taperStart: _s, taperEnd: _e, ...rest } = item;
	void _s;
	void _e;
	return { ...rest, ...(s === undefined ? {} : { taperStart: s }), ...(e === undefined ? {} : { taperEnd: e }) } as T;
}

/**
 * The taper a piece of `stroke` made of `points` (a run cut out of it by an eraser or a redaction box) keeps: the original's taper of an end only
 * when the piece still reaches that end (same position as the first / last point of the stroke); a cut makes new, untapered ends.
 */
export function pieceTaper(stroke: { points: readonly (readonly number[])[]; taperStart?: number; taperEnd?: number }, points: readonly (readonly number[])[]): { taperStart?: number; taperEnd?: number } {
	const first = stroke.points[0], last = stroke.points[stroke.points.length - 1];
	const same = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean => a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];
	return {
		...(stroke.taperStart !== undefined && same(points[0], first) ? { taperStart: stroke.taperStart } : {}),
		...(stroke.taperEnd !== undefined && same(points[points.length - 1], last) ? { taperEnd: stroke.taperEnd } : {}),
	};
}

/**
 * The taper fields a NEW stroke of `tool` is created with from the pen's settings: only the line pens have them, and an end set to none (or less
 * than the smallest taper) has no key at all, so ink written without a taper is stored exactly as before.
 */
export function newStrokeTaper(tool: Tool, start: number | undefined, end: number | undefined): { taperStart?: number; taperEnd?: number } {
	if (!isLinePen(tool)) return {};
	const s = normaliseTaper(start), e = normaliseTaper(end);
	return { ...(s === undefined ? {} : { taperStart: s }), ...(e === undefined ? {} : { taperEnd: e }) };
}

/** The two taper fields of `item` as an object to spread into a copy (only the ones that are set). */
export function taperFields(item: { taperStart?: number; taperEnd?: number }): { taperStart?: number; taperEnd?: number } {
	return {
		...(item.taperStart === undefined ? {} : { taperStart: item.taperStart }),
		...(item.taperEnd === undefined ? {} : { taperEnd: item.taperEnd }),
	};
}
