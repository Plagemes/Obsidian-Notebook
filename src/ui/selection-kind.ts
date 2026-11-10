// 0.14 generative UI (402): what a selection holds, so the selection bar shows the actions of that content. Pure.

/** ink: only strokes. image: only pictures. text: only text boxes. mixed: more than one of those (or anything else). object: only other objects (maths, graphs, excerpts, markers, boxes). */
export type SelectionKind = "ink" | "image" | "text" | "mixed" | "object";

export interface SelectionMix {
	strokes: number;
	images: number;
	texts: number;
	/** Selected elements that are neither pictures nor text boxes. */
	others: number;
}

/** The kind of a selection; null when nothing is selected. */
export function selectionKindOf(m: SelectionMix): SelectionKind | null {
	const present = [m.strokes > 0, m.images > 0, m.texts > 0, m.others > 0];
	const n = present.filter(Boolean).length;
	if (n === 0) return null;
	if (n > 1) return "mixed";
	if (m.strokes > 0) return "ink";
	if (m.images > 0) return "image";
	if (m.texts > 0) return "text";
	return "object";
}

/** The mix from the counts the view puts in the UI context (`texts` absent counts as 0: older callers). */
export function mixFromCounts(sel: { strokes: number; elements: number; images: number; texts?: number }): SelectionMix {
	const texts = sel.texts ?? 0;
	return { strokes: sel.strokes, images: sel.images, texts, others: Math.max(0, sel.elements - sel.images - texts) };
}

// ------------------------------------------------------------------------------------- suggestions from geometry (#403, 0.28)
// Deterministic rules, no AI: what the shape of a selection of ink most likely asks for. A row of words → highlight it or put it into
// a note; two clusters of ink joined by an arrow → link; a loop drawn around other ink → group. Pure.

/** A stroke as the rules see it: its box, a few of its points (page coordinates) and whether it is handwriting (a line pen). */
export interface GeoStroke {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	/** Points `[x, y]` in drawing order (the full stroke or a sample of it). */
	pts: ReadonlyArray<readonly [number, number]>;
	/** A pen, fountain pen or brush stroke (not a marker, highlighter or shape). */
	handwriting: boolean;
}

export type GeoSuggestion = "row" | "link" | "loop";

/** The actions of each suggestion, best first (each is an existing action, run through its normal path). */
export const SUGGESTION_ACTIONS: Readonly<Record<GeoSuggestion, readonly string[]>> = {
	row: ["selection-highlight", "selection-insert-note"],
	link: ["link-selection", "selection-group"],
	loop: ["selection-group"],
};

/** At most this many suggestion chips. */
export const MAX_SUGGESTIONS = 2;
/** More strokes than this and the rules stay silent (they must stay cheap on a big selection). */
const MAX_GEO_STROKES = 250;

const w = (s: GeoStroke): number => s.maxX - s.minX;
const h = (s: GeoStroke): number => s.maxY - s.minY;
const diag = (s: GeoStroke): number => Math.hypot(w(s), h(s));
const median = (xs: number[]): number => {
	const a = [...xs].sort((x, y) => x - y);
	return a.length === 0 ? 0 : a[Math.floor(a.length / 2)]!;
};

function union(list: readonly GeoStroke[]): { minX: number; minY: number; maxX: number; maxY: number } {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const s of list) {
		minX = Math.min(minX, s.minX); minY = Math.min(minY, s.minY); maxX = Math.max(maxX, s.maxX); maxY = Math.max(maxY, s.maxY);
	}
	return { minX, minY, maxX, maxY };
}

/** Distance between two boxes (0 when they touch or overlap). */
function boxGap(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }): number {
	return Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
}

/** A single stroke that closes on itself and is big enough to be a loop (not a dot or a letter "o"). */
function isLoop(s: GeoStroke): boolean {
	const first = s.pts[0], last = s.pts[s.pts.length - 1];
	if (!first || !last || s.pts.length < 8 || Math.min(w(s), h(s)) < 40) return false;
	return Math.hypot(first[0] - last[0], first[1] - last[1]) <= 0.3 * Math.max(w(s), h(s));
}

/** Groups strokes whose boxes are within `gap` of each other (single linkage). */
function clusterBy(list: readonly GeoStroke[], gap: number): GeoStroke[][] {
	const parent = list.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (boxGap(list[i]!, list[j]!) <= gap) parent[find(i)] = find(j);
	const out = new Map<number, GeoStroke[]>();
	list.forEach((s, i) => out.set(find(i), [...(out.get(find(i)) ?? []), s]));
	return [...out.values()];
}

/** The two ends of an arrow-like stroke: its first point and the point farthest from it (the tip of a head drawn in one stroke is the far end). */
function connectorEnds(s: GeoStroke): [readonly [number, number], readonly [number, number]] | null {
	const a = s.pts[0];
	if (!a) return null;
	let far = a, best = -1;
	for (const p of s.pts) {
		const d = Math.hypot(p[0] - a[0], p[1] - a[1]);
		if (d > best) { best = d; far = p; }
	}
	return [a, far];
}

const pointGap = (p: readonly [number, number], b: { minX: number; minY: number; maxX: number; maxY: number }): number =>
	Math.hypot(Math.max(0, b.minX - p[0], p[0] - b.maxX), Math.max(0, b.minY - p[1], p[1] - b.maxY));

/** Two clusters of ink joined by one arrow-like stroke whose ends touch both. */
function hasArrowBetween(list: readonly GeoStroke[]): boolean {
	if (list.length < 3) return false;
	const med = median(list.map((s) => Math.max(w(s), h(s))));
	const touch = Math.max(14, 0.6 * med);
	const candidates = [...list].filter((s) => diag(s) >= 60).sort((a, b) => diag(b) - diag(a)).slice(0, 4);
	for (const c of candidates) {
		const ends = connectorEnds(c);
		if (!ends) continue;
		// Small strokes next to an end are the head of the arrow, not content.
		const onEnd = (s: GeoStroke): boolean => diag(s) < 25 && s.pts.some((p) => ends.some((e) => Math.hypot(p[0] - e[0], p[1] - e[1]) <= 6));
		const rest = list.filter((s) => s !== c && !onEnd(s));
		const clusters = clusterBy(rest, Math.max(18, 0.9 * med)).filter((cl) => cl.length > 0);
		if (clusters.length !== 2) continue;
		const [x, y] = clusters.map(union) as [ReturnType<typeof union>, ReturnType<typeof union>];
		const joins = (pointGap(ends[0], x) <= touch && pointGap(ends[1], y) <= touch) || (pointGap(ends[0], y) <= touch && pointGap(ends[1], x) <= touch);
		// The arrow must run between the clusters, not lie inside one of them.
		if (joins && boxGap(x, y) > 0) return true;
	}
	return false;
}

/** One loop drawn around all the other ink of the selection. */
function hasLoopAround(list: readonly GeoStroke[]): boolean {
	if (list.length < 2) return false;
	for (const l of list) {
		if (!isLoop(l)) continue;
		const others = list.filter((s) => s !== l);
		if (others.every((s) => s.minX >= l.minX - 2 && s.maxX <= l.maxX + 2 && s.minY >= l.minY - 2 && s.maxY <= l.maxY + 2)) return true;
	}
	return false;
}

/** A single horizontal row of handwriting: several strokes, wide, no taller than a line of writing. */
function isRowOfWords(list: readonly GeoStroke[]): boolean {
	if (list.length < 2 || list.some((s) => !s.handwriting)) return false;
	const box = union(list);
	const bw = box.maxX - box.minX, bh = box.maxY - box.minY;
	const line = Math.max(median(list.map(h)), 8);
	return bw >= 40 && bw >= 1.5 * bh && bh <= Math.max(48, 2.5 * line);
}

/**
 * What the geometry of a selection of ink suggests, best first. A selection with anything but ink (pictures, text, objects: `others` > 0)
 * or from several pages gets nothing: the rules are about handwriting only.
 */
export function suggestFromGeometry(strokes: readonly GeoStroke[], others: number): GeoSuggestion[] {
	if (others > 0 || strokes.length === 0 || strokes.length > MAX_GEO_STROKES) return [];
	const out: GeoSuggestion[] = [];
	if (hasArrowBetween(strokes)) out.push("link");
	if (hasLoopAround(strokes)) out.push("loop");
	if (out.length === 0 && isRowOfWords(strokes)) out.push("row");
	return out;
}

/** The action ids of the chips for these suggestions: at most MAX_SUGGESTIONS, no repeats. */
export function suggestionActions(found: readonly GeoSuggestion[]): string[] {
	const ids: string[] = [];
	for (const s of found) for (const id of SUGGESTION_ACTIONS[s]) if (!ids.includes(id)) ids.push(id);
	return ids.slice(0, MAX_SUGGESTIONS);
}
