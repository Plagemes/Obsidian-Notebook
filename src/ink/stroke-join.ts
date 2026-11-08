import { boundGraphId, pinnedInk } from "./attach";
import { pathLength } from "./hook-clean";
import { isLockedElement } from "../model/groups";
import { Batch, ReplaceStroke } from "../model/history";
import { freezeStroke } from "../model/serialize";
import { isLinePen, type Page, type Point, type Stroke } from "../model/types";

/**
 * 0.24 (#313): joining of strokes that a tiny pen dropout split in two (pure, no 'obsidian').
 *
 * When the pen briefly loses contact in the middle of a line (a skipped digitiser report, a sweaty palm, a screen protector edge) the
 * line is saved as two strokes: the first ends where contact was lost and the next starts a few points further on, going the same way.
 * This module finds such pairs from the committed points and joins them into ONE stroke. Nothing is guessed from time (points carry
 * no timestamps); the test is purely geometric and deliberately strict, because a wrong join changes what a person wrote:
 *  - the two strokes must be NEXT to each other in the page order (nothing was drawn between them), in the same style (tool, colour,
 *    width, nib, render version, slide) and in the same group, or both in none;
 *  - the gap between the end of the first and the start of the second is a few points at most, a small multiple of the pen width, no
 *    more than a few times the spacing of the points where the pen was moving, and a small share of the shorter piece: the next letter
 *    of a word, the dot of an "i", a dashed line and a full stop are all further apart than that;
 *  - the direction is continuous: the line leaves the first stroke and enters the second the same way (a sharp turn is a pen lift
 *    that meant something: the corner of an L, a V, the foot of a 2), and the gap itself runs along that direction;
 *  - both pieces are real lines (three points and a few pen widths long at least): a dot is never a fragment of a line;
 *  - the pressure at the two ends does not jump.
 * The joined stroke is the first one with the points of the others after its own: same id, style and fields, points still
 * [x, y, pressure] in page coordinates, pressure untouched. Ink a collapsed sticky note keeps hidden and strokes of a group that holds
 * a locked element are never taken.
 */

export const JOIN_RULES = {
	/** A piece needs at least this many points, and is at least this long (pen widths, with a floor in pt). */
	minPoints: 3, minLenWidths: 3, minLenPt: 3,
	/** The gap is at most `gapWidths` pen widths, within [gapMinPt, gapMaxPt] pt. */
	gapWidths: 3, gapMinPt: 2, gapMaxPt: 8,
	/** And at most this many times the point spacing near the two ends, plus half a pen width. */
	gapSpacings: 4,
	/** And at most this share of the shorter of the two pieces. */
	gapShare: 0.15,
	/** The direction of the line may turn this many degrees at the joint, at most. */
	maxTurn: 40,
	/** A gap longer than this many pen widths must itself run along the line: its angle to both ends is at most `maxGapTurn` degrees. */
	gapDirectedWidths: 0.25, maxGapTurn: 50,
	/** The direction of an end is measured over this much of the line (pen widths, at least `windowMinPt` pt). */
	windowWidths: 1.2, windowMinPt: 2,
	/** The pressure at the two ends differs by at most this much. */
	pressureJump: 0.45,
} as const;

const COS_TURN = Math.cos((JOIN_RULES.maxTurn * Math.PI) / 180);
const COS_GAP_TURN = Math.cos((JOIN_RULES.maxGapTurn * Math.PI) / 180);

/** The unit direction of the line at its end: from the point `window` back along the line to the last point (null when it has none). */
function endDirection(pts: readonly Point[], atEnd: boolean, window: number): [number, number] | null {
	const n = pts.length;
	const tip = atEnd ? pts[n - 1]! : pts[0]!;
	let walked = 0;
	for (let k = 1; k < n; k++) {
		const prev = atEnd ? pts[n - k]! : pts[k - 1]!;
		const cur = atEnd ? pts[n - 1 - k]! : pts[k]!;
		walked += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
		if (walked >= window || k === n - 1) {
			const dx = atEnd ? tip[0] - cur[0] : cur[0] - tip[0];
			const dy = atEnd ? tip[1] - cur[1] : cur[1] - tip[1];
			const len = Math.hypot(dx, dy);
			return len > 1e-9 ? [dx / len, dy / len] : null;
		}
	}
	return null;
}

/** The mean distance between consecutive points over the first (or last) few segments: how fast the pen moved there. */
function endSpacing(pts: readonly Point[], atEnd: boolean): number {
	const n = pts.length;
	const count = Math.min(4, n - 1);
	let sum = 0;
	for (let k = 0; k < count; k++) {
		const a = atEnd ? pts[n - 1 - k]! : pts[k]!;
		const b = atEnd ? pts[n - 2 - k]! : pts[k + 1]!;
		sum += Math.hypot(a[0] - b[0], a[1] - b[1]);
	}
	return count > 0 ? sum / count : 0;
}

function sameStyle(a: Stroke, b: Stroke): boolean {
	return a.tool === b.tool && a.color.toLowerCase() === b.color.toLowerCase() && Math.abs(a.width - b.width) < 0.01
		&& (a.nib ?? -1) === (b.nib ?? -1) && a.render === b.render && a.slide === b.slide
		// Ink bound to a graph (id prefix) moves and is clipped with that graph: never join it with ink of another graph or with free ink.
		&& boundGraphId(a) === boundGraphId(b);
}

/** Whether `s` is a line long enough to be one half of a split gesture. */
function isPiece(s: Stroke): boolean {
	if (!isLinePen(s.tool) || s.hidden || s.points.length < JOIN_RULES.minPoints) return false;
	return pathLength(s.points) >= Math.max(JOIN_RULES.minLenPt, JOIN_RULES.minLenWidths * s.width);
}

/**
 * Whether `next` continues `prev` after a dropout: the end of `prev` and the start of `next` are one gesture that was split. Looks only
 * at the two strokes' own points and style (not at the page order, groups or locks: `planJoin` does that).
 */
export function isDropoutPair(prev: Stroke, next: Stroke): boolean {
	if (!isPiece(prev) || !isPiece(next) || !sameStyle(prev, next)) return false;
	const a = prev.points;
	const b = next.points;
	const w = prev.width;
	const end = a[a.length - 1]!;
	const start = b[0]!;
	const gx = start[0] - end[0];
	const gy = start[1] - end[1];
	const gap = Math.hypot(gx, gy);
	// How far apart the ends may be: absolute, in pen widths, in point spacings, and against the length of the shorter piece.
	const spacing = Math.max(endSpacing(a, true), endSpacing(b, false));
	const reach = Math.min(
		Math.min(JOIN_RULES.gapMaxPt, Math.max(JOIN_RULES.gapMinPt, JOIN_RULES.gapWidths * w)),
		JOIN_RULES.gapSpacings * spacing + 0.5 * w,
		JOIN_RULES.gapShare * Math.min(pathLength(a), pathLength(b)),
	);
	if (gap > reach) return false;
	if (Math.abs(end[2] - start[2]) > JOIN_RULES.pressureJump) return false;
	// The direction is continuous across the joint.
	const window = Math.max(JOIN_RULES.windowMinPt, JOIN_RULES.windowWidths * w);
	const da = endDirection(a, true, window);
	const db = endDirection(b, false, window);
	if (!da || !db) return false;
	if (da[0] * db[0] + da[1] * db[1] < COS_TURN) return false;
	// A gap that is more than a touch runs forwards along the line: a start behind the end, or off to the side, is another stroke.
	if (gap > JOIN_RULES.gapDirectedWidths * w) {
		const ux = gx / gap;
		const uy = gy / gap;
		if (ux * da[0] + uy * da[1] < COS_GAP_TURN || ux * db[0] + uy * db[1] < COS_GAP_TURN) return false;
	}
	return true;
}

/** `first` with the points of `rest` after its own, in order (a start that coincides with the end before it is not repeated). Same id and fields as `first`. */
export function joinStrokes(first: Stroke, rest: readonly Stroke[]): Stroke {
	const points: Point[] = [...first.points];
	for (const s of rest) {
		const last = points[points.length - 1]!;
		const from = s.points[0] && Math.hypot(s.points[0][0] - last[0], s.points[0][1] - last[1]) < 0.01 ? 1 : 0;
		for (let i = from; i < s.points.length; i++) points.push(s.points[i]!);
	}
	return freezeStroke({ ...first, points });
}

/** The number of items (strokes and elements) of `page` that are in `group`, and whether one of them is a locked element. */
function groupInfo(page: Pick<Page, "strokes" | "elements">, group: string): { members: number; locked: boolean } {
	let members = 0;
	let locked = false;
	for (const s of page.strokes) if (s.group === group) members++;
	for (const e of page.elements ?? []) {
		if (e.group !== group) continue;
		members++;
		if (isLockedElement(e)) locked = true;
	}
	return { members, locked };
}

export interface JoinPlan {
	command: Batch;
	/** The strokes of the request after the join: each run replaced by its joined stroke, the absorbed ones left out. */
	strokes: Stroke[];
	/** What became of each stroke that changed: the joined stroke (for the first of a run), or null when it was absorbed into the one before. */
	changes: ReadonlyMap<Stroke, Stroke | null>;
	/** How many strokes were absorbed (the number of joints made), and how many joined strokes came out. */
	joints: number;
	runs: number;
}

/**
 * The command that joins the dropout-split strokes among `strokes` of `page` as ONE undo step. Null when there is nothing to join.
 * Two strokes are joined only when both are asked for and they are neighbours in the page order; chains of several fragments become
 * one stroke. Strokes no longer on the page, ink a collapsed note keeps hidden, and strokes of a group that holds a locked element
 * are skipped. A group keeps at least two members on the page (a group of one is dissolved), so strokes that make up all of a group
 * are not joined. The joined stroke takes the place of the first piece in the page order (so its layer).
 */
export function planJoin(page: Page, strokes: readonly Stroke[]): JoinPlan | null {
	const hidden = new Set(pinnedInk(page.strokes, page.elements ?? []));
	const asked = new Set(strokes.filter((s) => !hidden.has(s)));
	const groups = new Map<string, { members: number; locked: boolean }>();
	const groupOk = (a: Stroke, b: Stroke, taken: number): boolean => {
		if (a.group !== b.group) return false;
		if (a.group === undefined) return true;
		let info = groups.get(a.group);
		if (!info) groups.set(a.group, (info = groupInfo(page, a.group)));
		// Taking `taken` members into the first must leave at least two members: a group of one is dissolved.
		return !info.locked && info.members - taken >= 2;
	};
	const usable = (s: Stroke | undefined): s is Stroke => !!s && asked.has(s);
	const steps: Array<{ index: number; cmd: ReplaceStroke }> = [];
	const changes = new Map<Stroke, Stroke | null>();
	let joints = 0;
	let runs = 0;
	let i = 0;
	const all = page.strokes;
	while (i < all.length) {
		const head = all[i]!;
		if (!usable(head)) { i++; continue; }
		let current = head;
		const absorbed: Array<{ stroke: Stroke; index: number }> = [];
		let j = i + 1;
		while (j < all.length) {
			const next = all[j]!;
			if (!usable(next) || !groupOk(current, next, absorbed.length + 1) || !isDropoutPair(current, next)) break;
			absorbed.push({ stroke: next, index: j });
			current = joinStrokes(head, absorbed.map((x) => x.stroke));
			j++;
		}
		if (absorbed.length > 0) {
			steps.push({ index: i, cmd: new ReplaceStroke(page.id, head, [current], i) });
			changes.set(head, current);
			for (const a of absorbed) {
				steps.push({ index: a.index, cmd: new ReplaceStroke(page.id, a.stroke, [], a.index) });
				changes.set(a.stroke, null);
			}
			joints += absorbed.length;
			runs++;
		}
		i = j;
	}
	if (steps.length === 0) return null;
	// Highest position first: undo then puts every absorbed piece back where it was.
	steps.sort((x, y) => y.index - x.index);
	const kept: Stroke[] = [];
	for (const s of strokes) {
		const next = changes.has(s) ? changes.get(s) : s;
		if (next) kept.push(next);
	}
	return { command: new Batch("Join broken strokes", steps.map((s) => s.cmd)), strokes: kept, changes, joints, runs };
}
