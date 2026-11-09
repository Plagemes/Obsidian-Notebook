// 0.26 ctxpalette (#394): the context palette of the colour picker. Two short rows of colours that belong to the page in
// hand: "On this page" (the colours already used here, ranked by use) and "From the slide" (the dominant colours of the
// PDF or picture behind the page). Pure: no DOM, no 'obsidian'. The view samples a small raster and hands it in.
import { hexToRgb, normaliseHex, rgbToHex, type Rgb } from "./colour";

/** Two colours closer than this CIE76 distance (ΔE) count as the same colour. */
export const SAME_COLOUR_DE = 8;
/** At most this many colours in the "On this page" row. */
export const ON_PAGE_MAX = 8;
/** At most this many colours in the "From the slide" row. */
export const SLIDE_MAX = 6;
/** The longest side (px) of the raster the view samples from the background. */
export const SAMPLE_SIDE = 56;
/** A background colour covering less than this share of the page is not offered. */
export const MIN_SHARE = 0.015;
/** How many colours the median cut aims for before the near ones are merged and the paper white is dropped. */
const CUT_BOXES = 10;
/** Rounds of k-means after the median cut. */
const KMEANS_ROUNDS = 5;
/** Pages remembered by the dominant-colour cache. */
export const CACHE_MAX = 24;

/** CIE L*a*b* (D65) of a `#rrggbb` colour; null for an invalid one. */
export function labOf(hex: string): [number, number, number] | null {
	const c = hexToRgb(hex);
	return c ? labOfRgb(c) : null;
}

function labOfRgb({ r, g, b }: Rgb): [number, number, number] {
	const lin = (v: number): number => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const R = lin(r), G = lin(g), B = lin(b);
	const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
	const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
	const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
	const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const fx = f(x), fy = f(y), fz = f(z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ΔE (CIE76) of two `#rrggbb` colours: 0 = identical, about 2.3 = just noticeable, 100+ = black against white. Invalid input is far from all. */
export function deltaE(a: string, b: string): number {
	const x = labOf(a), y = labOf(b);
	if (!x || !y) return Infinity;
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// --- the colours already used on the page ---

/** The least a page must give: ink with a colour (and a shape's fill) and elements that may carry one. Any `Page` fits. */
export interface UsageSource {
	strokes: readonly { tool: string; color: string; fill?: string }[];
	elements?: readonly { type: string; color?: string }[];
}

/** Element types whose `color` is a colour of the writer's (a sticky note's is paper, a picture has none). */
const INK_ELEMENTS: ReadonlySet<string> = new Set(["text", "marker", "box", "equation", "graph", "checkbox", "area"]);

export interface UsedColour {
	hex: string;
	/** How many strokes, fills and elements use it (near shades counted together). */
	uses: number;
}

/**
 * The colours used on a page, most used first (a tie goes to the one used last). Strokes of every pen, the highlighter and
 * shapes count, so do a shape's fill, text, markers, boxes, equations, graphs, checkboxes and areas. Near shades (a pen set's
 * slightly different red, a recoloured copy) are one colour, named by its most used shade.
 */
export function usedColours(page: UsageSource): UsedColour[] {
	const seen = new Map<string, { uses: number; last: number }>();
	let order = 0;
	const note = (raw: string | undefined): void => {
		const hex = raw ? normaliseHex(raw) : null;
		if (!hex) return;
		order++;
		const e = seen.get(hex);
		if (e) {
			e.uses++;
			e.last = order;
		} else seen.set(hex, { uses: 1, last: order });
	};
	for (const s of page.strokes) {
		if (s.tool === "eraser") continue;
		note(s.color);
		if (s.fill) note(s.fill);
	}
	for (const e of page.elements ?? []) if (INK_ELEMENTS.has(e.type)) note(e.color);
	const exact = [...seen].map(([hex, v]) => ({ hex, ...v })).sort((a, b) => b.uses - a.uses || b.last - a.last);
	// Merge near shades into the most used one (the list is already in that order).
	const out: Array<{ hex: string; uses: number; last: number }> = [];
	for (const c of exact) {
		const home = out.find((o) => deltaE(o.hex, c.hex) < SAME_COLOUR_DE);
		if (home) {
			home.uses += c.uses;
			home.last = Math.max(home.last, c.last);
		} else out.push({ ...c });
	}
	return out.sort((a, b) => b.uses - a.uses || b.last - a.last).map(({ hex, uses }) => ({ hex, uses }));
}

// --- the dominant colours of a background ---

/** A small RGBA raster (what `getImageData` gives). */
export interface Raster {
	width: number;
	height: number;
	data: ArrayLike<number>;
}

export interface DominantColour {
	hex: string;
	/** The share of the sampled pixels, 0..1. */
	share: number;
}

/** Size (px) of the raster to sample for a background of `width` × `height`: the longest side `SAMPLE_SIDE`, never zero. */
export function sampleSize(width: number, height: number, side = SAMPLE_SIDE): { width: number; height: number } {
	if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
	const k = side / Math.max(width, height);
	return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Paper white and the greys next to it: not worth offering as an ink colour. */
export function isPaperLike(hex: string): boolean {
	const lab = labOf(hex);
	if (!lab) return true;
	return lab[0] >= 93 && Math.hypot(lab[1], lab[2]) < 9;
}

interface Box {
	px: number[]; // flat r,g,b triples
	n: number;
}

function rangeOf(box: Box): { channel: number; span: number } {
	const lo = [255, 255, 255], hi = [0, 0, 0];
	for (let i = 0; i < box.px.length; i += 3) {
		for (let c = 0; c < 3; c++) {
			const v = box.px[i + c]!;
			if (v < lo[c]!) lo[c] = v;
			if (v > hi[c]!) hi[c] = v;
		}
	}
	let channel = 0, span = -1;
	for (let c = 0; c < 3; c++) if (hi[c]! - lo[c]! > span) { span = hi[c]! - lo[c]!; channel = c; }
	return { channel, span };
}

/**
 * The dominant colours of a raster by median cut: the pixels are split at the median of their widest channel until there are
 * `boxes` groups, each group is its mean colour, refined by a few rounds of k-means. Transparent pixels are ignored. Near colours are merged (their shares add up),
 * paper white is dropped and so is anything under `MIN_SHARE`. Deterministic, most common first, at most `max`.
 */
export function dominantColours(raster: Raster, max = SLIDE_MAX, boxes = CUT_BOXES): DominantColour[] {
	const { width, height, data } = raster;
	const total = width * height;
	if (!(total > 0) || data.length < total * 4) return [];
	const all: number[] = [];
	for (let i = 0; i < total; i++) {
		if ((data[i * 4 + 3] ?? 255) < 128) continue;
		all.push(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
	}
	const counted = all.length / 3;
	if (counted === 0) return [];
	const queue: Box[] = [{ px: all, n: counted }];
	while (queue.length < boxes) {
		// Split the box with the widest spread, weighted by how many pixels it holds.
		let best = -1, bestScore = 0, bestChannel = 0;
		for (let i = 0; i < queue.length; i++) {
			const b = queue[i]!;
			if (b.n < 2) continue;
			const { channel, span } = rangeOf(b);
			const score = span * Math.sqrt(b.n);
			if (span > 0 && score > bestScore) { best = i; bestScore = score; bestChannel = channel; }
		}
		if (best < 0) break;
		const box = queue[best]!;
		const trip: number[][] = [];
		for (let i = 0; i < box.px.length; i += 3) trip.push([box.px[i]!, box.px[i + 1]!, box.px[i + 2]!]);
		trip.sort((a, b) => a[bestChannel]! - b[bestChannel]!);
		const mid = trip.length >> 1;
		const a = trip.slice(0, mid).flat(), b = trip.slice(mid).flat();
		queue.splice(best, 1, { px: a, n: mid }, { px: b, n: trip.length - mid });
	}
	// The median cut splits by count, so a big flat area can take several boxes while two small ones stay mixed: a few rounds of
	// k-means from the box means move each centre onto its own cluster (a few thousand pixels, a handful of centres: cheap).
	let centres = queue.map((b) => {
		let r = 0, g = 0, bl = 0;
		for (let i = 0; i < b.px.length; i += 3) { r += b.px[i]!; g += b.px[i + 1]!; bl += b.px[i + 2]!; }
		return [r / b.n, g / b.n, bl / b.n];
	});
	let counts: number[] = queue.map((b) => b.n);
	for (let round = 0; round < KMEANS_ROUNDS; round++) {
		const sum = centres.map(() => [0, 0, 0]);
		const n = centres.map(() => 0);
		for (let i = 0; i < all.length; i += 3) {
			const r = all[i]!, g = all[i + 1]!, b = all[i + 2]!;
			let best = 0, bestD = Infinity;
			for (let c = 0; c < centres.length; c++) {
				const m = centres[c]!;
				const d = (m[0]! - r) ** 2 + (m[1]! - g) ** 2 + (m[2]! - b) ** 2;
				if (d < bestD) { bestD = d; best = c; }
			}
			const s = sum[best]!;
			s[0]! += r; s[1]! += g; s[2]! += b;
			n[best]!++;
		}
		const next: number[][] = [], nextCounts: number[] = [];
		for (let c = 0; c < centres.length; c++) {
			if (n[c] === 0) continue;
			next.push([sum[c]![0]! / n[c]!, sum[c]![1]! / n[c]!, sum[c]![2]! / n[c]!]);
			nextCounts.push(n[c]!);
		}
		centres = next;
		counts = nextCounts;
	}
	const means = centres.map((m, i) => ({ hex: rgbToHex({ r: Math.round(m[0]!), g: Math.round(m[1]!), b: Math.round(m[2]!) }), share: counts[i]! / counted })).sort((a, b) => b.share - a.share);
	const merged: DominantColour[] = [];
	for (const m of means) {
		const home = merged.find((o) => deltaE(o.hex, m.hex) < SAME_COLOUR_DE);
		if (home) home.share += m.share;
		else merged.push({ ...m });
	}
	return merged.filter((m) => m.share >= MIN_SHARE && !isPaperLike(m.hex)).sort((a, b) => b.share - a.share).slice(0, max);
}

// --- the two rows ---

export interface ContextSwatch {
	hex: string;
	/** The meaning (colours with meaning, 0.22) this colour has in the legend, if any. */
	label?: string;
}

export interface ContextPalette {
	onPage: ContextSwatch[];
	slide: ContextSwatch[];
}

export interface ContextInput {
	used: readonly UsedColour[];
	slide: readonly DominantColour[];
	/** The recent colours the picker already shows: nothing near them is offered again. */
	recent: readonly string[];
	/** The meaning of a colour in the legend in force, or undefined. */
	labelOf?: (hex: string) => string | undefined;
}

/**
 * The two rows. A colour near a recent colour is left out (the recent row has it); a colour near one already in the page row is
 * left out of the slide row (the page wins), and within a row near shades appear once. A row with nothing left is empty.
 */
export function buildContextPalette(input: ContextInput): ContextPalette {
	const taken: string[] = [];
	for (const r of input.recent) {
		const hex = normaliseHex(r);
		if (hex) taken.push(hex);
	}
	const pick = (hexes: readonly string[], max: number): ContextSwatch[] => {
		const out: ContextSwatch[] = [];
		for (const raw of hexes) {
			const hex = normaliseHex(raw);
			if (!hex || out.length >= max) continue;
			if (taken.some((t) => deltaE(t, hex) < SAME_COLOUR_DE)) continue;
			taken.push(hex);
			const label = input.labelOf?.(hex);
			out.push(label ? { hex, label } : { hex });
		}
		return out;
	};
	const onPage = pick(input.used.map((u) => u.hex), ON_PAGE_MAX);
	const slide = pick(input.slide.map((d) => d.hex), SLIDE_MAX);
	return { onPage, slide };
}

// --- the cache ---

/** Dominant colours by background (asset and page), the least recently used page dropped first. Cheap to ask, so asking is free. */
export class DominantCache {
	private readonly map = new Map<string, DominantColour[]>();

	constructor(private readonly max = CACHE_MAX) {}

	get(key: string): DominantColour[] | undefined {
		const v = this.map.get(key);
		if (v) {
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}

	set(key: string, value: DominantColour[]): void {
		this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
	}

	get size(): number {
		return this.map.size;
	}
}
