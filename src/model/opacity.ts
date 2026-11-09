// Opacity of ink, pictures and areas (format v24, roadmap #358): pure helpers, no 'obsidian'.

/**
 * The optional `opacity` of a stroke, an image or an area: a number in [OPACITY_MIN, OPACITY_MAX] that MULTIPLIES the look the item has without
 * it. So 1 (and an absent value) is the look of every earlier version: a ballpoint pen is opaque, the highlighter is its 35 % multiplied over the
 * page, the marker its 85 %, an area the highlighter's look, a picture opaque. 0.5 on the highlighter is half of its 35 %. Written only when the
 * item is not at full strength, so a notebook that never uses it is byte for byte what earlier versions wrote.
 */
export const OPACITY_MIN = 0.05;
export const OPACITY_MAX = 1;
/** The slider's step, as a fraction (5 %). */
export const OPACITY_STEP = 0.05;
/** What the person sees: percent. */
export const OPACITY_DEFAULT = 1;

/** A value the format accepts. */
export function isOpacity(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= OPACITY_MIN && v <= OPACITY_MAX;
}

/**
 * The opacity to store for a requested value: clamped to the allowed range and rounded to a whole percent; undefined (nothing stored) at full
 * strength or for a value that is not a number.
 */
export function normaliseOpacity(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v));
	const rounded = Math.round(clamped * 100) / 100;
	return rounded >= OPACITY_MAX ? undefined : rounded;
}

/** The opacity an item is drawn with: its own, or 1 when it has none (or an invalid one). */
export function opacityOf(item: { opacity?: number }): number {
	return item.opacity !== undefined && isOpacity(item.opacity) ? item.opacity : OPACITY_DEFAULT;
}

/** Whole percent, for labels. */
export function opacityPercent(v: number | undefined): number {
	return Math.round((v === undefined ? OPACITY_DEFAULT : v) * 100);
}

/** `base` (the alpha the item has without an opacity) scaled by the opacity of `item`. */
export function scaledAlpha(base: number, item: { opacity?: number }): number {
	return base * opacityOf(item);
}

/** A copy of `item` with `opacity` set (or removed at full strength). The very same object when nothing changes. */
export function withOpacity<T extends { opacity?: number }>(item: T, opacity: number | undefined): T {
	const next = normaliseOpacity(opacity);
	if (next === item.opacity) return item;
	const { opacity: _o, ...rest } = item;
	void _o;
	return (next === undefined ? rest : { ...rest, opacity: next }) as T;
}

/** A slider position in percent as the fraction to use: a whole percent from 5 to 100. */
export function opacityFromPercent(percent: number): number {
	const p = Math.min(Math.round(OPACITY_MAX * 100), Math.max(Math.round(OPACITY_MIN * 100), Math.round(percent)));
	return p / 100;
}
