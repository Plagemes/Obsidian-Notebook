import { pinnedInk } from "./attach";
import { Batch, ReplaceStroke, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import { isLinePen, type Page, type Point, type Stroke } from "../model/types";

/**
 * 0.23 (#314): clean-up of hooks and stray dots (pure, no 'obsidian').
 *
 * A "hook" is the little tick a pen leaves where it lands or lifts: a few points at the very start or end of a stroke that turn
 * sharply back against the line. A "stray dot" is a tiny mark made by the pen bouncing right after it lifted from (or right before
 * it landed on) a stroke, touching that stroke's end. Both are found geometrically from the committed points; nothing is stored,
 * the stroke keeps its id, its style and every field (nib, group…), and its points stay [x, y, pressure] in page coordinates.
 *
 * The rules are deliberately conservative, because a wrong cut changes what a person wrote:
 *  - a hook is short in absolute terms (a few pen widths) and in share of the stroke; a leg of a real corner (the foot of an L, the
 *    tip of a check mark, the barb of an arrow) is longer than that and is never touched;
 *  - the line before it must be straight enough for the turn to mean something, and the turn must be sharp (a reversal);
 *  - a dot is removed only when it is single-pen tiny, in the same style as the stroke next to it in the page order, and touching
 *    one end of that stroke: the dot of an "i" or "j" and a full stop sit apart from the stroke and are kept.
 */

export const HOOK_RULES = {
	/** A stroke needs at least this many points to be looked at for hooks. */
	minPoints: 6,
	/** Longest hook in pen widths, and its bounds in pt. */
	capWidths: 3, capMin: 2.5, capMax: 6,
	/** Longest hook as a share of the whole stroke's length (per end). */
	capShare: 0.1,
	/** The hook's own chord is at least this many pen widths (and 0.8 pt): shorter jitter is not a visible hook. */
	minChordWidths: 0.8, minChordPt: 0.8,
	/** The turn between the line and the hook, in degrees, at least. */
	minTurn: 120,
	/** The line before the hook: chord / arc of its window, at least. */
	straight: 0.95,
	/** A stray dot: at most this many points, and its extent at most this many pen widths. */
	dotPoints: 4, dotExtentWidths: 0.8, dotExtentMinPt: 0.6,
	/** A stray dot touches an end of the neighbour stroke: centre to end at most `touchWidths` pen widths + `touchPt`. */
	touchWidths: 1, touchPt: 0.4,
	/** The neighbour of a dot is a real stroke: at least this many pen widths long. */
	neighbourWidths: 4,
} as const;

const COS_TURN = Math.cos((HOOK_RULES.minTurn * Math.PI) / 180);

/** Limits that can be tightened per call (the defaults are `HOOK_RULES`). */
export interface HookOptions {
	/** The turn between the line and the hook, in degrees, at least. */
	minTurn?: number;
	/** Longest hook as a share of the stroke's length. */
	capShare?: number;
}

/**
 * The limits of "Trim hooks as you write", which cuts while the person writes and so can meet the exit tail of a printed "a", "d"
 * or "u": only a near reversal (the pen flicking back along its own line) and a very short hook count. The clean-up of a selection
 * keeps the wider default rules, because the person asked for it and can see what it does.
 */
export const AUTO_HOOK_OPTIONS: HookOptions = { minTurn: 155, capShare: 0.06 };

/** Cumulative arc length at each point. */
function cumulative(pts: readonly Point[]): number[] {
	const out = [0];
	for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
	return out;
}

/** The length of the line through `pts` (pt). */
export function pathLength(pts: readonly Point[]): number {
	let sum = 0;
	for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
	return sum;
}

/** The longest hook for a pen of `width` (pt) on a line `total` long. */
function hookCap(width: number, total: number, share: number): number {
	const abs = Math.min(HOOK_RULES.capMax, Math.max(HOOK_RULES.capMin, HOOK_RULES.capWidths * width));
	return Math.min(abs, total * share);
}

/**
 * The index of the point where the line really ends, when the last points are a hook; null when they are not. The points after
 * that index are the hook. The sharpest turn wins when several candidates qualify.
 */
function endCorner(pts: readonly Point[], cum: readonly number[], width: number, opts: HookOptions): number | null {
	const n = pts.length;
	const total = cum[n - 1]!;
	const cap = hookCap(width, total, opts.capShare ?? HOOK_RULES.capShare);
	const minChord = Math.max(HOOK_RULES.minChordPt, HOOK_RULES.minChordWidths * width);
	const end = pts[n - 1]!;
	let best: number | null = null;
	let bestCos = opts.minTurn === undefined ? COS_TURN : Math.cos((opts.minTurn * Math.PI) / 180);
	for (let k = n - 2; k >= 2; k--) {
		const hookLen = total - cum[k]!;
		if (hookLen > cap) break;
		const corner = pts[k]!;
		const hx = end[0] - corner[0];
		const hy = end[1] - corner[1];
		const hookChord = Math.hypot(hx, hy);
		if (hookChord < minChord) continue;
		// The line before the corner, over a window longer than the hook (a smooth bend of a letter is not a hook).
		const window = Math.max(2.5 * hookLen, 4 * width, 5);
		let j = k - 1;
		while (j > 0 && cum[k]! - cum[j]! < window) j--;
		const arc = cum[k]! - cum[j]!;
		if (arc < window) continue;
		const from = pts[j]!;
		const bx = corner[0] - from[0];
		const by = corner[1] - from[1];
		const bodyChord = Math.hypot(bx, by);
		if (bodyChord === 0 || bodyChord / arc < HOOK_RULES.straight) continue;
		const cos = (bx * hx + by * hy) / (bodyChord * hookChord);
		if (cos <= bestCos) {
			best = k;
			bestCos = cos;
		}
	}
	return best;
}

export interface HookTrim {
	/** First and last point kept (indices into the original points). */
	from: number;
	to: number;
	/** How many points were cut at the start and at the end. */
	head: number;
	tail: number;
}

/** Where the hooks of `stroke` are: the range of points to keep, or null when it has none (or is not a stroke to look at). */
export function findHooks(stroke: Stroke, opts: HookOptions = {}): HookTrim | null {
	const pts = stroke.points;
	if (!isLinePen(stroke.tool) || stroke.hidden || pts.length < HOOK_RULES.minPoints) return null;
	const cum = cumulative(pts);
	const total = cum[cum.length - 1]!;
	if (!(total > 0)) return null;
	const n = pts.length;
	const tailCorner = endCorner(pts, cum, stroke.width, opts);
	// The start is the end of the line read backwards.
	const reversed = [...pts].reverse();
	const rcum = cumulative(reversed);
	const headCornerRev = endCorner(reversed, rcum, stroke.width, opts);
	const to = tailCorner ?? n - 1;
	const from = headCornerRev === null ? 0 : n - 1 - headCornerRev;
	// What is left must still be a line, and the two cuts must not meet.
	if (to - from < 3) return null;
	if (from === 0 && to === n - 1) return null;
	return { from, to, head: from, tail: n - 1 - to };
}

/** `stroke` without its hooks (same id, style and fields), or `stroke` itself when it has none. */
export function trimHooks(stroke: Stroke, opts: HookOptions = {}): Stroke {
	const hooks = findHooks(stroke, opts);
	if (!hooks) return stroke;
	const points: Point[] = stroke.points.slice(hooks.from, hooks.to + 1);
	return freezeStroke({ ...stroke, points });
}

function extent(pts: readonly Point[]): number {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	return Math.hypot(maxX - minX, maxY - minY);
}

function sameStyle(a: Stroke, b: Stroke): boolean {
	return a.tool === b.tool && a.color.toLowerCase() === b.color.toLowerCase() && Math.abs(a.width - b.width) < 0.01 && (a.nib ?? -1) === (b.nib ?? -1);
}

/** Whether `stroke` is a pen-bounce dot that touches an end of `neighbour` (the stroke written just before or after it). */
export function isStrayDot(stroke: Stroke, neighbour: Stroke | undefined): boolean {
	if (!neighbour || !isLinePen(stroke.tool) || stroke.hidden || stroke.group !== undefined) return false;
	const pts = stroke.points;
	if (pts.length === 0 || pts.length > HOOK_RULES.dotPoints) return false;
	const w = stroke.width;
	if (extent(pts) > Math.max(HOOK_RULES.dotExtentMinPt, HOOK_RULES.dotExtentWidths * w)) return false;
	if (neighbour.hidden || !sameStyle(stroke, neighbour)) return false;
	const np = neighbour.points;
	// The neighbour is a real stroke (a dot beside a dot is a pair of dots someone made, and neither is a bounce).
	if (np.length < 3 || pathLength(np) < HOOK_RULES.neighbourWidths * w) return false;
	let cx = 0, cy = 0;
	for (const p of pts) { cx += p[0]; cy += p[1]; }
	cx /= pts.length;
	cy /= pts.length;
	const reach = HOOK_RULES.touchWidths * w + HOOK_RULES.touchPt;
	const a = np[0]!;
	const b = np[np.length - 1]!;
	return Math.hypot(cx - a[0], cy - a[1]) <= reach || Math.hypot(cx - b[0], cy - b[1]) <= reach;
}

export interface CleanupPlan {
	command: Batch;
	/** The strokes of the request after the clean-up: trimmed ones replaced by their new objects, removed dots left out. */
	strokes: Stroke[];
	/** What became of each stroke that changed: its trimmed copy, or null when it was a stray dot and is gone. */
	changes: ReadonlyMap<Stroke, Stroke | null>;
	/** Strokes whose hooks were cut, and dots removed. */
	trimmed: number;
	removed: number;
}

/**
 * The command that cleans `strokes` of `page` as ONE undo step: hooks cut, stray dots removed. Null when there is nothing to do.
 * Strokes that are no longer on the page are skipped. Neighbours of a dot are the strokes next to it in the page's order, whether
 * or not they were asked for. A trimmed stroke keeps its position in the page order (and so its layer), its id and all its fields.
 */
export function planCleanup(page: Page, strokes: readonly Stroke[]): CleanupPlan | null {
	// Ink that a collapsed sticky note keeps hidden is out of view: it is never edited here, nor taken for a neighbour.
	const hidden = new Set(pinnedInk(page.strokes, page.elements ?? []));
	const asked = new Set(strokes.filter((s) => !hidden.has(s)));
	const beside = (i: number): Stroke | undefined => { const s = page.strokes[i]; return s && !hidden.has(s) ? s : undefined; };
	const at = new Map<Stroke, number>();
	page.strokes.forEach((s, i) => { if (asked.has(s)) at.set(s, i); });
	const steps: Array<{ index: number; cmd: Command }> = [];
	const after = new Map<Stroke, Stroke | null>();
	let trimmed = 0;
	let removed = 0;
	for (const [stroke, index] of at) {
		if (isStrayDot(stroke, beside(index - 1)) || isStrayDot(stroke, beside(index + 1))) {
			steps.push({ index, cmd: new ReplaceStroke(page.id, stroke, [], index) });
			after.set(stroke, null);
			removed++;
			continue;
		}
		const next = trimHooks(stroke);
		if (next === stroke) continue;
		steps.push({ index, cmd: new ReplaceStroke(page.id, stroke, [next], index) });
		after.set(stroke, next);
		trimmed++;
	}
	if (steps.length === 0) return null;
	// Highest position first: undo then puts every removed dot back where it was.
	steps.sort((a, b) => b.index - a.index);
	const kept: Stroke[] = [];
	for (const s of strokes) {
		const next = after.has(s) ? after.get(s) : s;
		if (next) kept.push(next);
	}
	return { command: new Batch("Clean up strokes", steps.map((s) => s.cmd)), strokes: kept, changes: after, trimmed, removed };
}

export interface PenUpTrim {
	/** The step that replaces the committed stroke by its trimmed copy (same id, style and position). */
	command: ReplaceStroke;
	trimmed: Stroke;
}

/**
 * "Trim hooks as you write": the stroke is committed as written (so the raw points are in the history), and this is the step that
 * follows it. `strokeId` is looked up on the page because the committed object may not be the one that was drawn. Null when the stroke
 * is not on the page or has no hook under the stricter automatic limits. One Undo gives the raw stroke back, a second removes it.
 */
export function planPenUpTrim(page: Page, strokeId: string): PenUpTrim | null {
	const index = page.strokes.findIndex((s) => s.id === strokeId);
	if (index < 0) return null;
	const stroke = page.strokes[index]!;
	const trimmed = trimHooks(stroke, AUTO_HOOK_OPTIONS);
	if (trimmed === stroke) return null;
	return { command: new ReplaceStroke(page.id, stroke, [trimmed], index), trimmed };
}
