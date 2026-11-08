import { boundGraphId, pinnedInk } from "./attach";
import { applyPlacement, emptyPlacement, type Placement } from "./selection-transform";
import { translate } from "./transform";
import type { Batch } from "../model/history";
import { isLinePen, type Page, type Stroke } from "../model/types";
import { RULED_TOP_LINES } from "./paper";

/**
 * 0.25 (#93): "Align to baseline" (pure, no 'obsidian'). Crooked handwritten words are moved straight up or down onto a common baseline.
 *
 * From the committed points alone (strokes carry no timestamps):
 *  1. Handwriting: line pens only (`isLinePen`), visible, not bound to a graph, not the ink a collapsed sticky note keeps hidden. The
 *     size of the writing, `S`, is a high-ish percentile of the stroke heights; everything below is a multiple of it, so the rules
 *     follow the size of the hand. Underlines and strike-throughs (long and flat) and drawings (much taller than the writing) are left alone.
 *  2. Words: strokes of the same line whose boxes are less than a fraction of `S` apart horizontally and overlap vertically are one
 *     word; the small strokes (the dot of an i, a comma, a full stop, an accent) go with the nearest word. Strokes of one group are
 *     one unit that moves rigidly (never apart); a group that is not wholly asked for, or that holds a locked element, is not moved.
 *  3. The baseline of a word is where most letters sit, not the lowest ink: the strokes' crossings of every horizontal scan line are
 *     counted (a horizontal bar, as the bar of a T or an e, adds nothing; a vertical stem or a bowl adds as many as it crosses), and
 *     the baseline is the lowest scan line that still has at least half of the busiest line's crossings. The tail of a g, p, y or q
 *     is thin (one crossing, or the same as the body for a loop), so it stays below the baseline. A word made only of descenders is
 *     ambiguous; the estimate is then the bottom of the tails.
 *  4. Lines: words are chained left to right while their baselines are within a fraction of `S` of the one before (and the gap is not
 *     a margin wide). Each line gets ONE straight baseline: horizontal, at the weighted median of its words; or, when four words or more lie
 *     clearly on a slope (a real rise and a small scatter around the fitted straight line), that sloped line, so a line written uphill
 *     stays uphill and only the wobble goes. On ruled paper the line is put on the ruled line nearest to it instead.
 *  5. Each word moves only in y, by its distance to the line: a rigid translation (the vector points move together, pressure, width,
 *     style, id and layer untouched, nothing is rotated or scaled). A move that is tiny is not made (so a second run does nothing),
 *     and one that is huge (more than `maxShift` times the size of the writing) is not either: that is another line.
 */

export const BASELINE_RULES = {
	/** `S` is this percentile of the heights of the strokes (0..1). */
	sizePercentile: 0.6,
	/** A stroke taller than this many `S` is a drawing; a long flat one (underline) is not text. */
	maxHeight: 3.5, flatHeight: 0.2, flatWidth: 1.5,
	/** A stroke shorter than this many `S` and narrower than `bigWidth` is a small mark (dot, comma, accent). */
	smallHeight: 0.5, bigWidth: 0.5,
	/** Letters closer than this many `S` horizontally, overlapping this share of the smaller height vertically, are one word. */
	wordGap: 0.4, wordOverlap: 0.3,
	/** A small mark goes with the nearest word if it is at most this many `S` from it. */
	attachReach: 0.5,
	/** A word belongs to a line while its baseline is within this many `S` (at most 0.45 of a ruled line) of the one before, and the gap to it is under `lineGap` S. */
	lineTolerance: 0.85, lineGap: 6,
	/** Baseline: the scan line step is `S / binDivisor`; the baseline is the lowest scan line with this share of the busiest one. */
	binDivisor: 16, bandShare: 0.5,
	/** A move under this many pt is not made; one over `maxShift` times `S` is not made either. */
	minMove: 0.25, maxShift: 2,
	/** A slope is kept only with at least `slopeMinWords` words, a rise of `slopeMinRise` S, an angle of `slopeMinDegrees` and a scatter of at most `slopeScatter` of the rise. */
	slopeMinWords: 4, slopeMinRise: 1, slopeMinDegrees: 1.5, slopeScatter: 0.25,
} as const;

export interface BaselineOptions {
	/** False: every line is made horizontal, however clearly it is sloped. Default true. */
	keepSlope?: boolean;
	/** False: ruled paper is treated like blank paper (words go to the common baseline of their line, not to the rule). Default true. */
	snapToRules?: boolean;
}

interface Info {
	stroke: Stroke;
	minX: number; maxX: number; minY: number; maxY: number;
	h: number; w: number; len: number;
}

function inspect(stroke: Stroke): Info {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, len = 0;
	const pts = stroke.points;
	for (let i = 0; i < pts.length; i++) {
		const [x, y] = pts[i]!;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
		if (i > 0) len += Math.hypot(x - pts[i - 1]![0], y - pts[i - 1]![1]);
	}
	return { stroke, minX, maxX, minY, maxY, h: maxY - minY, w: maxX - minX, len };
}

function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median where each value weighs `weights[i]`; two halves of equal weight give their mean. */
export function weightedMedian(values: readonly number[], weights: readonly number[]): number {
	const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
	const total = order.reduce((n, i) => n + Math.max(0, weights[i] ?? 0), 0);
	if (!(total > 0)) return median(values);
	let acc = 0;
	for (let k = 0; k < order.length; k++) {
		const i = order[k]!;
		acc += Math.max(0, weights[i] ?? 0);
		if (acc > total / 2 + 1e-9) return values[i]!;
		if (Math.abs(acc - total / 2) <= 1e-9) return k + 1 < order.length ? (values[i]! + values[order[k + 1]!]!) / 2 : values[i]!;
	}
	return values[order[order.length - 1]!]!;
}

/**
 * The baseline (y, page coordinates) of the strokes of one word, see the file comment. `size` is the size of the writing (`S`); it only
 * sets the fineness of the scan. A word whose ink is flatter than two scan lines has its lowest ink for baseline.
 */
export function wordBaseline(strokes: readonly Stroke[], size: number): number {
	const infos = strokes.map(inspect).filter((i) => Number.isFinite(i.minY));
	if (infos.length === 0) return 0;
	const minY = Math.min(...infos.map((i) => i.minY));
	const maxY = Math.max(...infos.map((i) => i.maxY));
	const bin = Math.max(0.25, size / BASELINE_RULES.binDivisor);
	if (maxY - minY < 2 * bin) return maxY;
	const count = Math.floor((maxY - minY) / bin) + 1;
	const crossings = new Float64Array(count);
	for (const { stroke } of infos) {
		const pts = stroke.points;
		for (let i = 1; i < pts.length; i++) {
			const ay = pts[i - 1]![1];
			const by = pts[i]![1];
			const dy = Math.abs(by - ay);
			if (dy === 0) continue;
			// Every scan line the segment crosses gets one crossing (shared out over the bins the segment spans).
			const lo = Math.min(ay, by);
			const first = Math.floor((lo - minY) / bin);
			const last = Math.floor((lo + dy - minY) / bin);
			for (let k = first; k <= last; k++) {
				const from = Math.max(lo, minY + k * bin);
				const to = Math.min(lo + dy, minY + (k + 1) * bin);
				if (to > from && k >= 0 && k < count) crossings[k] = crossings[k]! + (to - from) / bin;
			}
		}
	}
	const smooth = new Float64Array(count);
	let peak = 0;
	for (let i = 0; i < count; i++) {
		const a = crossings[i - 1] ?? crossings[i]!;
		const c = crossings[i + 1] ?? crossings[i]!;
		smooth[i] = (a + 2 * crossings[i]! + c) / 4;
		if (smooth[i]! > peak) peak = smooth[i]!;
	}
	if (!(peak > 0)) return maxY;
	const threshold = peak * BASELINE_RULES.bandShare;
	for (let i = count - 1; i >= 0; i--) if (smooth[i]! >= threshold) return Math.min(maxY, minY + (i + 1) * bin);
	return maxY;
}

/** The lowest value of `rules` ruled paper: the y of the ruled lines of a page (multiples of the spacing, from the third on, inside the page). */
export function ruledLines(page: Pick<Page, "paper" | "height">): number[] | null {
	const { kind, spacing } = page.paper;
	if (kind !== "ruled" || !(spacing > 0)) return null;
	const out: number[] = [];
	for (let j = RULED_TOP_LINES; j * spacing < page.height && out.length < 5000; j++) out.push(j * spacing);
	return out.length > 0 ? out : null;
}

function nearest(sorted: readonly number[], y: number): number {
	let best = sorted[0]!;
	for (const r of sorted) if (Math.abs(r - y) < Math.abs(best - y)) best = r;
	return best;
}

interface Unit {
	infos: Info[];
	/** The strokes that decide the baseline (not the small marks). */
	big: Info[];
	/** Movable: it has a letter-sized stroke, is not too tall, and its groups are wholly in the request. */
	movable: boolean;
	minX: number; maxX: number; minY: number; maxY: number;
	baseline: number;
	weight: number;
	cx: number;
}

export interface BaselineMove {
	strokes: Stroke[];
	/** Distance to move down (negative: up), pt. */
	dy: number;
	/** The line the word is on (0-based, in reading order, top to bottom). */
	line: number;
}

export interface BaselineAnalysis {
	moves: BaselineMove[];
	/** Words found (movable ones), lines they make, and strokes left alone. */
	words: number;
	lines: number;
	skipped: number;
	/** The size of the writing, pt. */
	size: number;
	ruled: boolean;
	/** The words found: their x extent, baseline and number of strokes (for the tests and the harness). */
	found?: Array<{ minX: number; maxX: number; baseline: number; strokes: number }>;
}

const EMPTY: BaselineAnalysis = { moves: [], words: 0, lines: 0, skipped: 0, size: 0, ruled: false };

/** Union-find over indices. */
function dsu(n: number): { find: (i: number) => number; join: (a: number, b: number) => void } {
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	return { find, join: (a, b) => { parent[find(a)] = find(b); } };
}

/** Where each word of `strokes` of `page` has to move to sit on its line's baseline. Pure analysis; nothing is changed. */
export function analyseBaseline(page: Page, strokes: readonly Stroke[], options: BaselineOptions = {}): BaselineAnalysis {
	const R = BASELINE_RULES;
	const onPage = new Set(page.strokes);
	const hidden = new Set(pinnedInk(page.strokes, page.elements ?? []));
	const asked = new Set(strokes.filter((s) => onPage.has(s) && !hidden.has(s)));
	let skipped = 0;
	// 1. Handwriting.
	const candidates: Info[] = [];
	for (const s of asked) {
		if (!isLinePen(s.tool) || s.hidden === true || boundGraphId(s) !== null || s.points.length === 0) { skipped++; continue; }
		const info = inspect(s);
		if (![info.minX, info.maxX, info.minY, info.maxY].every(Number.isFinite)) { skipped++; continue; }
		candidates.push(info);
	}
	if (candidates.length === 0) return { ...EMPTY, skipped };
	const heights = candidates.map((c) => c.h).sort((a, b) => a - b);
	const size = Math.max(3, percentile(heights, R.sizePercentile));
	const text: Info[] = [];
	for (const c of candidates) {
		const flat = c.h < R.flatHeight * size && c.w > R.flatWidth * size;
		if (c.h > R.maxHeight * size || flat) skipped++;
		else text.push(c);
	}
	if (text.length === 0) return { ...EMPTY, skipped, size };

	// 2. Words.
	const isBig = (i: Info): boolean => i.h >= R.smallHeight * size || i.w >= R.bigWidth * size;
	const bigs = text.filter(isBig).sort((a, b) => a.minX - b.minX);
	const smalls = text.filter((i) => !isBig(i));
	const uf = dsu(text.length);
	const at = new Map(text.map((t, i) => [t, i]));
	{
		const active: Info[] = [];
		for (const cur of bigs) {
			for (let k = active.length - 1; k >= 0; k--) {
				const o = active[k]!;
				if (o.maxX + R.wordGap * size < cur.minX) { active.splice(k, 1); continue; }
				const overlap = Math.min(o.maxY, cur.maxY) - Math.max(o.minY, cur.minY);
				const smaller = Math.min(o.h, cur.h);
				if (overlap >= R.wordOverlap * smaller && overlap >= 0) uf.join(at.get(o)!, at.get(cur)!);
			}
			active.push(cur);
		}
	}
	const gap = (a: Info, b: Info): number => Math.hypot(Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX)), Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY)));
	for (const m of smalls) {
		let best: Info | null = null;
		let bestGap = R.attachReach * size;
		for (const b of bigs) {
			if (b.minX - m.maxX > bestGap) break;
			const g = gap(m, b);
			if (g <= bestGap) { best = b; bestGap = g; }
		}
		// A small mark with no word near it (a lone dot, a dash between things) is left where it is.
		if (best) uf.join(at.get(m)!, at.get(best)!);
	}
	// Strokes of one group are one unit.
	const groups = new Map<string, Info[]>();
	for (const t of text) {
		if (t.stroke.group === undefined) continue;
		const g = groups.get(t.stroke.group);
		if (g) g.push(t);
		else groups.set(t.stroke.group, [t]);
	}
	const fixedGroups = new Set<string>();
	for (const [id, members] of groups) {
		for (let k = 1; k < members.length; k++) uf.join(at.get(members[0]!)!, at.get(members[k]!)!);
		// Every member of the group must be one of these strokes: a group that holds an element (a locked one above all) or a stroke
		// that is not handwriting asked for is not torn apart, so it stays where it is.
		let all = 0;
		for (const s of page.strokes) if (s.group === id) all++;
		for (const e of page.elements ?? []) if (e.group === id) all++;
		if (all !== members.length) fixedGroups.add(id);
	}
	const unitsByRoot = new Map<number, Info[]>();
	text.forEach((t, i) => {
		const r = uf.find(i);
		const list = unitsByRoot.get(r);
		if (list) list.push(t);
		else unitsByRoot.set(r, [t]);
	});
	const units: Unit[] = [];
	for (const infos of unitsByRoot.values()) {
		const big = infos.filter(isBig);
		const minX = Math.min(...infos.map((i) => i.minX));
		const maxX = Math.max(...infos.map((i) => i.maxX));
		const minY = Math.min(...infos.map((i) => i.minY));
		const maxY = Math.max(...infos.map((i) => i.maxY));
		const fixed = infos.some((i) => i.stroke.group !== undefined && fixedGroups.has(i.stroke.group));
		const lettered = big.some((i) => i.h >= R.smallHeight * size);
		const movable = !fixed && lettered && maxY - minY <= R.maxHeight * size;
		if (!movable) { skipped += infos.length; continue; }
		units.push({
			infos, big, movable, minX, maxX, minY, maxY,
			baseline: wordBaseline(big.map((i) => i.stroke), size),
			weight: big.reduce((n, i) => n + i.len, 0) || 1,
			cx: (minX + maxX) / 2,
		});
	}
	if (units.length === 0) return { ...EMPTY, skipped, size };

	// 4. Lines.
	units.sort((a, b) => a.minX - b.minX);
	const lines: Unit[][] = [];
	const ruledSpacing = page.paper.kind === "ruled" && page.paper.spacing > 0 ? page.paper.spacing : Infinity;
	const tolerance = Math.min(R.lineTolerance * size, 0.45 * ruledSpacing);
	for (const u of units) {
		let best: Unit[] | null = null;
		let bestDiff = tolerance;
		for (const line of lines) {
			const last = line[line.length - 1]!;
			if (u.minX - last.maxX > R.lineGap * size) continue;
			const diff = Math.abs(u.baseline - last.baseline);
			if (diff <= bestDiff) { best = line; bestDiff = diff; }
		}
		if (best) best.push(u);
		else lines.push([u]);
	}
	lines.sort((a, b) => median(a.map((u) => u.baseline)) - median(b.map((u) => u.baseline)));

	// 5. One straight baseline per line, then the moves.
	const rules = options.snapToRules === false ? null : ruledLines(page);
	const keepSlope = options.keepSlope !== false;
	const moves: BaselineMove[] = [];
	let lineCount = 0;
	lines.forEach((line, lineIndex) => {
		const baselines = line.map((u) => u.baseline);
		const weights = line.map((u) => u.weight);
		const level = weightedMedian(baselines, weights);
		let targetAt = (_u: Unit): number => level;
		if (keepSlope && line.length >= R.slopeMinWords) {
			const fit = steepFit(line, size);
			if (fit) targetAt = (u) => fit.slope * u.cx + fit.intercept;
		}
		const width = median(line.flatMap((u) => u.big.map((i) => i.stroke.width)));
		let moved = false;
		// On ruled paper the line sits on a ruled line: one for the whole line unless it is clearly sloped.
		const sloped = targetAt(line[0]!) !== targetAt(line[line.length - 1]!);
		const one = rules && !sloped ? nearest(rules, level + width / 2) : null;
		for (const u of line) {
			const ruleTarget = rules ? (one ?? nearest(rules, targetAt(u) + width / 2)) : null;
			const target = ruleTarget !== null ? ruleTarget - width / 2 : targetAt(u);
			const dy = target - u.baseline;
			if (Math.abs(dy) < R.minMove || Math.abs(dy) > R.maxShift * size) continue;
			moves.push({ strokes: u.infos.map((i) => i.stroke), dy, line: lineIndex });
			moved = true;
		}
		if (moved) lineCount++;
	});
	return { moves, words: units.length, lines: lineCount, skipped, size, ruled: rules !== null, found: units.map((u) => ({ minX: u.minX, maxX: u.maxX, baseline: u.baseline, strokes: u.infos.length })) };
}

/** Theil–Sen straight line through (cx, baseline) of the words of a line, when the line is clearly sloped (see the file comment); else null. */
function steepFit(line: readonly Unit[], size: number): { slope: number; intercept: number } | null {
	const R = BASELINE_RULES;
	const slopes: number[] = [];
	for (let i = 0; i < line.length; i++) {
		for (let j = i + 1; j < line.length; j++) {
			const dx = line[j]!.cx - line[i]!.cx;
			if (Math.abs(dx) > 1e-6) slopes.push((line[j]!.baseline - line[i]!.baseline) / dx);
		}
	}
	if (slopes.length === 0) return null;
	const slope = median(slopes);
	const intercept = median(line.map((u) => u.baseline - slope * u.cx));
	const span = Math.max(...line.map((u) => u.cx)) - Math.min(...line.map((u) => u.cx));
	const rise = Math.abs(slope) * span;
	const angle = (Math.atan(Math.abs(slope)) * 180) / Math.PI;
	if (rise < R.slopeMinRise * size || angle < R.slopeMinDegrees) return null;
	const scatter = median(line.map((u) => Math.abs(u.baseline - (slope * u.cx + intercept))));
	return scatter <= R.slopeScatter * rise ? { slope, intercept } : null;
}

export interface BaselinePlan {
	command: Batch;
	/** The strokes of the request after the move (each moved one replaced by its moved copy). */
	strokes: Stroke[];
	/** What became of each stroke that moved. */
	changes: ReadonlyMap<Stroke, Stroke>;
	/** Words moved, the lines they are on, and whether they were put on ruled lines. */
	words: number;
	lines: number;
	ruled: boolean;
}

/**
 * The command that puts the words among `strokes` of `page` on their line's baseline, as ONE undo step (rigid vertical moves). Null
 * when nothing needs to move. Nothing is stamped (the ink is moved, not written now).
 */
export function planBaseline(page: Page, strokes: readonly Stroke[], options: BaselineOptions = {}, label = "Align to baseline"): BaselinePlan | null {
	const analysis = analyseBaseline(page, strokes, options);
	if (analysis.moves.length === 0) return null;
	const placement: Placement = emptyPlacement();
	for (const m of analysis.moves) {
		const matrix = translate(0, m.dy);
		for (const s of m.strokes) placement.strokes.set(s, matrix);
	}
	const plan = applyPlacement(page, strokes, [], placement, undefined, label);
	if (!plan) return null;
	const changes = new Map<Stroke, Stroke>();
	const before = strokes.filter((s) => page.strokes.includes(s));
	before.forEach((s, i) => {
		const after = plan.strokes[i]!;
		if (after !== s) changes.set(s, after);
	});
	return { command: plan.command, strokes: plan.strokes, changes, words: analysis.moves.length, lines: analysis.lines, ruled: analysis.ruled };
}
