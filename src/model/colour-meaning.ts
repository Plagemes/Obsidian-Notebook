/**
 * 0.22 (#101) Colours with meaning: the reader says what each ink colour means (red = definition, blue = example). The
 * legend is plain settings data (plugin settings, with an optional per-notebook override in a `_meta` sidecar, see
 * library/meanings.ts); the document is never touched. Pure: no 'obsidian' import, so it runs in Node tests.
 *
 * - `matchMeaning` finds the legend entry a stroke colour belongs to: the nearest legend colour within a tolerance, so a
 *   slightly different red (a custom picker value, a night-mode shade, a pen set) still counts as "definition".
 * - `meaningRegions` collects the ink of each meaning into regions (close strokes of one meaning are one region), like the
 *   highlights digest does for highlighter strokes; the digest note is built from them (`buildMeaningSection`).
 * - `strokeDimmer` is what the view-only "filter by meaning" hands the renderer.
 */
import { normaliseHex, hexToRgb } from "../ink/colour";
import { strokeBands, strokeBox, type HighlightRegion } from "./highlight-digest";
import type { Page, Stroke } from "./types";
import type { TextBand } from "../pdf/region-text";

/** Meanings in a legend. */
export const MEANING_MAX = 12;
/** Longest label (characters). */
export const MEANING_LABEL_MAX = 40;
/** Colours closer than this (0 = identical, 1 = black against white) are the same meaning. */
export const MATCH_TOLERANCE = 0.12;
/** Choices of the tolerance setting. */
export const TOLERANCES = { strict: 0.06, normal: MATCH_TOLERANCE, loose: 0.2 } as const;
export type ToleranceName = keyof typeof TOLERANCES;
export const isToleranceName = (v: unknown): v is ToleranceName => v === "strict" || v === "normal" || v === "loose";
/** Ink of one meaning closer than this (pt) is one region of the digest. */
export const MEANING_GAP = 24;

export interface Meaning {
	/** `#rrggbb`, lower case. */
	colour: string;
	label: string;
}

/** A label that fits: one line, trimmed, at most `MEANING_LABEL_MAX` characters. */
export function cleanMeaningLabel(raw: unknown): string {
	return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MEANING_LABEL_MAX) : "";
}

/**
 * A legend from stored data, leniently: anything that is not a list gives an empty legend; an entry without a valid colour or
 * a label is skipped; a colour that is already in the list keeps its first label; at most `MEANING_MAX` entries.
 */
export function parseLegend(raw: unknown): Meaning[] {
	if (!Array.isArray(raw)) return [];
	const out: Meaning[] = [];
	for (const e of raw) {
		if (typeof e !== "object" || e === null) continue;
		const colour = normaliseHex(typeof (e as { colour?: unknown }).colour === "string" ? (e as { colour: string }).colour : "");
		const label = cleanMeaningLabel((e as { label?: unknown }).label);
		if (!colour || !label || out.some((m) => m.colour === colour)) continue;
		out.push({ colour, label });
		if (out.length >= MEANING_MAX) break;
	}
	return out;
}

/**
 * The legend to use: the notebook's own when it has one (even an empty list means "no meanings here"), else the global one.
 * `override` is null when the notebook has no override.
 */
export function effectiveLegend(global: readonly Meaning[], override: readonly Meaning[] | null): readonly Meaning[] {
	return override ?? global;
}

/** Perceptual-ish distance of two `#rrggbb` colours in 0..1 (the "redmean" weighting; 0 = same). Invalid input is far from all. */
export function colourDistance(a: string, b: string): number {
	const x = hexToRgb(a), y = hexToRgb(b);
	if (!x || !y) return 1;
	const rm = (x.r + y.r) / 2;
	const dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b;
	const d = Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
	return Math.min(1, d / 764.8);
}

/**
 * The index of the legend entry `colour` belongs to: the nearest one within `tolerance`; a tie goes to the earlier entry.
 * -1 when none is close enough.
 */
export function matchMeaning(colour: string, legend: readonly Meaning[], tolerance = MATCH_TOLERANCE): number {
	let best = -1;
	let bestD = Infinity;
	for (let i = 0; i < legend.length; i++) {
		const d = colourDistance(colour, legend[i]!.colour);
		if (d <= tolerance && d < bestD) {
			best = i;
			bestD = d;
		}
	}
	return best;
}

/** Pairs of legend entries whose colours are within `tolerance` of each other: strokes of either would match the nearer one. */
export function nearDuplicates(legend: readonly Meaning[], tolerance = MATCH_TOLERANCE): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < legend.length; i++) {
		for (let j = i + 1; j < legend.length; j++) {
			if (colourDistance(legend[i]!.colour, legend[j]!.colour) <= tolerance) out.push([i, j]);
		}
	}
	return out;
}

/** A free colour for a new legend entry: the first of `candidates` that is not within `tolerance` of an entry (else the first). */
export function nextFreeColour(legend: readonly Meaning[], candidates: readonly string[], tolerance = MATCH_TOLERANCE): string {
	for (const c of candidates) {
		const n = normaliseHex(c);
		if (n && matchMeaning(n, legend, tolerance) < 0) return n;
	}
	return normaliseHex(candidates[0] ?? "") ?? "#ef4444";
}

/** Replaces entry `index` (adds one at the end when it is past the end), keeping the list valid; the input is not changed. */
export function withMeaning(legend: readonly Meaning[], index: number, m: Meaning): Meaning[] {
	const next = legend.map((x) => ({ ...x }));
	if (index >= 0 && index < next.length) next[index] = { ...m };
	else next.push({ ...m });
	return parseLegend(next);
}

export function withoutMeaning(legend: readonly Meaning[], index: number): Meaning[] {
	return legend.filter((_, i) => i !== index).map((x) => ({ ...x }));
}

// ---------------------------------------------------------------------------------------------------- the filter

/** The alpha ink of other meanings is drawn with while a filter is on. */
export const DIM_ALPHA = 0.16;

/**
 * What the renderer asks for each stroke while "filter by meaning" is on: true when the stroke is NOT of the shown meaning
 * (it is drawn faint). A stroke whose colour has no meaning is dimmed too. Null `shown` (no filter) dims nothing.
 */
export function strokeDimmer(legend: readonly Meaning[], shown: number | null, tolerance = MATCH_TOLERANCE): ((s: Pick<Stroke, "color">) => boolean) | null {
	if (shown === null || shown < 0 || shown >= legend.length) return null;
	const cache = new Map<string, boolean>();
	return (s) => {
		let dim = cache.get(s.color);
		if (dim === undefined) {
			dim = matchMeaning(s.color, legend, tolerance) !== shown;
			cache.set(s.color, dim);
		}
		return dim;
	};
}

/** How many strokes of each legend entry the pages hold (and `none`: strokes of no meaning), hidden ink left out. */
export function meaningCounts(pages: readonly Page[], legend: readonly Meaning[], tolerance = MATCH_TOLERANCE): { perMeaning: number[]; none: number } {
	const perMeaning = legend.map(() => 0);
	let none = 0;
	for (const page of pages) {
		for (const s of page.strokes) {
			if (s.hidden) continue;
			const i = matchMeaning(s.color, legend, tolerance);
			if (i < 0) none++;
			else perMeaning[i]!++;
		}
	}
	return { perMeaning, none };
}

// -------------------------------------------------------------------------------------------------- the regions

export interface MeaningRegion extends HighlightRegion {
	/** Index into the legend. */
	meaning: number;
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const grow = (r: Box, d: number): Box => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

/**
 * The ink of each meaning, page by page, top to bottom then left to right: strokes of one meaning whose boxes are within `gap`
 * of each other are one region. Hidden (invisible-ink) strokes are left out; ink of no meaning is not listed. Pass the pages as
 * shown (the live state views). `colour` of a region is the legend colour.
 */
export function meaningRegions(pages: readonly Page[], legend: readonly Meaning[], tolerance = MATCH_TOLERANCE, gap = MEANING_GAP): MeaningRegion[] {
	const out: MeaningRegion[] = [];
	if (legend.length === 0) return out;
	pages.forEach((page, pageIndex) => {
		const items: Array<{ stroke: Stroke; box: Box; meaning: number }> = [];
		for (const stroke of page.strokes) {
			if (stroke.hidden) continue;
			const meaning = matchMeaning(stroke.color, legend, tolerance);
			if (meaning < 0) continue;
			const box = strokeBox(stroke);
			if (box) items.push({ stroke, box, meaning });
		}
		const parent = items.map((_, i) => i);
		const find = (i: number): number => {
			while (parent[i] !== i) {
				parent[i] = parent[parent[i]!]!;
				i = parent[i]!;
			}
			return i;
		};
		const near = gap / 2;
		for (let i = 0; i < items.length; i++) {
			const a = grow(items[i]!.box, near);
			for (let j = i + 1; j < items.length; j++) {
				if (items[i]!.meaning !== items[j]!.meaning) continue;
				const b = grow(items[j]!.box, near);
				if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) parent[find(j)] = find(i);
			}
		}
		const groups = new Map<number, number[]>();
		items.forEach((_, i) => {
			const r = find(i);
			const list = groups.get(r);
			if (list) list.push(i);
			else groups.set(r, [i]);
		});
		const regions: MeaningRegion[] = [];
		for (const members of groups.values()) {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			const bands: TextBand[] = [];
			for (const i of members) {
				const b = items[i]!.box;
				x0 = Math.min(x0, b.x0);
				y0 = Math.min(y0, b.y0);
				x1 = Math.max(x1, b.x1);
				y1 = Math.max(y1, b.y1);
				bands.push(...strokeBands(items[i]!.stroke));
			}
			const meaning = items[members[0]!]!.meaning;
			regions.push({
				pageIndex, pageId: page.id, colour: legend[meaning]!.colour, meaning,
				rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
				strokeIds: members.map((i) => items[i]!.stroke.id), bands,
			});
		}
		regions.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
		out.push(...regions);
	});
	return out;
}

/** Regions of one meaning grouped by meaning in legend order (page order inside). */
export function groupByMeaning<T extends { region: { meaning: number } }>(items: readonly T[]): Map<number, T[]> {
	const by = new Map<number, T[]>();
	for (const it of items) {
		const list = by.get(it.region.meaning);
		if (list) list.push(it);
		else by.set(it.region.meaning, [it]);
	}
	return new Map([...by].sort((a, b) => a[0] - b[0]));
}


// ----------------------------------------------------------------------------------------------- the Markdown

export const MEANING_START = "<!-- notebook-meanings:start -->";
export const MEANING_END = "<!-- notebook-meanings:end -->";

export interface MeaningItem {
	region: MeaningRegion;
	/** 1-based page number. */
	pageNumber: number;
	/** Markdown that shows the picture of the region (an embed); null when it could not be made. */
	image: string | null;
	/** The PDF text under the ink ("" when none). */
	text: string;
}

export interface MeaningBuild {
	legend: readonly Meaning[];
	items: readonly MeaningItem[];
	pageLink: (pageNumber: number, pageId: string) => string;
	intro: string;
	none: string;
	/** Heading of a meaning with no ink, e.g. "No ink of this meaning". */
	emptyMeaning: string;
	/** Escapes a legend label for a Markdown heading. */
	escape: (text: string) => string;
}

const quote = (text: string): string => text.split(/\r?\n/).map((l) => `> ${l}`).join("\n");

/** The Markdown between (and including) the two marker comments: one `##` section per meaning, in legend order. */
export function buildMeaningSection(b: MeaningBuild): string {
	const lines: string[] = [MEANING_START, "", b.intro, ""];
	if (b.items.length === 0) lines.push(b.none, "");
	else {
		const by = groupByMeaning(b.items);
		b.legend.forEach((m, i) => {
			lines.push(`## ${b.escape(m.label)}`, "");
			const list = by.get(i);
			if (!list || list.length === 0) {
				lines.push(`*${b.emptyMeaning}*`, "");
				return;
			}
			for (const item of list) {
				const parts: string[] = [];
				if (item.image) parts.push(item.image);
				if (item.text) parts.push(quote(item.text));
				parts.push(b.pageLink(item.pageNumber, item.region.pageId));
				lines.push(parts.join("\n\n"), "");
			}
		});
	}
	lines.push(MEANING_END);
	return lines.join("\n");
}

export type MeaningReplace = { text: string; outcome: "created" | "replaced" | "appended" | "unsafe" };

/** `existing` with the section between the markers replaced; text outside is never changed; an unpaired marker is "unsafe". */
export function replaceMeaningSection(existing: string, section: string): MeaningReplace {
	const start = existing.indexOf(MEANING_START);
	const end = start >= 0 ? existing.indexOf(MEANING_END, start + MEANING_START.length) : existing.indexOf(MEANING_END);
	if (start >= 0 && end >= 0) return { text: existing.slice(0, start) + section + existing.slice(end + MEANING_END.length), outcome: "replaced" };
	if (start >= 0 || end >= 0) return { text: existing, outcome: "unsafe" };
	if (existing.trim() === "") return { text: `${section}\n`, outcome: "created" };
	return { text: `${existing.replace(/\s+$/u, "")}\n\n${section}\n`, outcome: "appended" };
}

/** The picture name of the `n`-th region of a page for the meaning digest. */
export function meaningImageName(notebook: string, pageNumber: number, n: number): string {
	return `${notebook} meaning p${pageNumber}-${n}.png`;
}
