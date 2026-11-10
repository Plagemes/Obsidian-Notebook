import { boundGraphId, pinnedInk } from "./attach";
import { analyseBaseline } from "./baseline";
import { elementBounds } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { RULED_MARGIN_X } from "./paper";
import { applyPlacement, emptyPlacement } from "./selection-transform";
import { estimateMeasure } from "./text-layout";
import { translate } from "./transform";
import { selectableItems } from "../model/groups";
import type { Batch } from "../model/history";
import { isLinePen, type Page, type PageElement, type Point, type Stroke } from "../model/types";

/**
 * 0.26 (#238): "Tidy up" (pure, no 'obsidian'). One step that straightens a page of handwriting: the words onto their baseline, the
 * starts of the lines onto a common left margin, and the oversized gaps between the lines closed. It is a thin orchestration of the
 * engines that already exist and does not repeat their logic:
 *  1. words: `analyseBaseline` (ink/baseline.ts) finds the crooked words and how far each one moves up or down;
 *  2. lines: the same analysis hands over the lines it found (words chained along a baseline, as they are after step 1: the moves are applied to copies);
 *  3. margin and gaps: whole lines move rigidly, sideways (the starts that are nearly one margin become one, an indent stays an indent;
 *     on ruled paper the margin line of the paper is preferred when the writing is close to it) and upwards (a gap of two blank lines
 *     or more shrinks to one, so a paragraph break stays; with "Keep paragraph breaks" off every gap closes to the ordinary line
 *     spacing). On ruled paper a line only moves by whole rules, so it stays on its rule.
 *
 * What it leaves alone: anything that is not handwriting made with a line pen (shapes, highlighter, markers, pictures, text boxes,
 * areas and every other element), locked elements and the groups they belong to, a group that is not wholly in the request, the
 * ink a collapsed note keeps hidden, ink bound to a graph, and a line that has something else on it or in its way (an underline,
 * a drawing, a box beside it): a line only moves when the strip it sweeps is free. Lines never end up on top of each other.
 * Everything is a rigid translation (points, pressure, width, id and layer untouched), so the result is ONE undo step (a `Batch`
 * of `ReplaceStroke`, which remaps) and the page times are not touched: the ink is moved, not written now. The document format
 * does not change.
 */

export const TIDY_RULES = {
	/** A line needs this many strokes to be moved as a line; a lone mark stays where it is. */
	minLineStrokes: 3,
	/** Starts of lines closer than this many `S` (the size of the writing) to a margin belong to it. */
	leftTolerance: 2,
	/** Smaller moves (pt) are not made, so a second run finds nothing to do. */
	minMove: 0.5,
	/** On ruled paper the margin line of the paper is taken when the margin found is within this many `S` of where writing starts next to it, which is `marginPad` `S` right of the line. */
	marginSnap: 3, marginPad: 0.6,
	/** A gap is ordinary up to this many line pitches above the usual gap; from `gapExcess` pitches on it is oversized. A pitch is one line of writing plus the usual gap (the rule spacing on ruled paper). */
	gapOk: 0.6, gapExcess: 1.8,
	/** The usual gap between lines is this quantile of the gaps found (0..1). */
	usualQuantile: 0.3,
	/** Pieces of a line side by side closer than this many `S`, overlapping this share of the lower one vertically, are one line. */
	joinGap: 6, joinOverlap: 0.6,
	/** The gaps never close below this many `S`. */
	floorGap: 0.25,
	/** The strip a line sweeps is grown by this many `S` before it is tested against what is in its way. */
	obstaclePad: 0.3,
	/** Two lines are one above the other when their x ranges overlap by this share of the narrower one. */
	overlapShare: 0.15,
} as const;

export interface TidyOptions {
	/** Straighten the words onto their baseline. */
	baseline: boolean;
	/** Bring the starts of the lines onto a common left margin. */
	margin: boolean;
	/** Close oversized gaps between lines. */
	gaps: boolean;
	/** With gaps on: keep a paragraph break (a gap of two blank lines or more shrinks to one) instead of closing every gap. */
	keepParagraphs: boolean;
}

export const DEFAULT_TIDY_OPTIONS: Readonly<TidyOptions> = { baseline: true, margin: true, gaps: true, keepParagraphs: true };

/** Remembered choices read back leniently: anything that is not a boolean takes the default. */
export function normaliseTidyOptions(raw: unknown): TidyOptions {
	const out: TidyOptions = { ...DEFAULT_TIDY_OPTIONS };
	if (raw && typeof raw === "object") {
		const r = raw as Record<string, unknown>;
		for (const key of ["baseline", "margin", "gaps", "keepParagraphs"] as const) if (typeof r[key] === "boolean") out[key] = r[key];
	}
	return out;
}

/** What to tidy: the strokes and elements of a selection, or all of a page. */
export interface TidyRequest {
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
}

export interface TidyShift {
	dx: number;
	dy: number;
}

export interface TidyAnalysis {
	/** How far each stroke moves in all (a stroke of the page, as it is now). */
	moves: Map<Stroke, TidyShift>;
	/** Words straightened, lines moved sideways, gaps closed. */
	words: number;
	aligned: number;
	tightened: number;
	/** The height won by closing gaps (the lowest line moves up by this much), pt. */
	saved: number;
	/** Lines found among the ink the request covers. */
	lines: number;
	/** Strokes of the request left alone (not line-pen handwriting, hidden, in a group that is not whole). */
	skipped: number;
	/** The page is locked: the history will refuse the step. */
	locked: boolean;
}

const EMPTY: Omit<TidyAnalysis, "moves"> = { words: 0, aligned: 0, tightened: 0, saved: 0, lines: 0, skipped: 0, locked: false };

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const pad = (b: BBox, p: number): BBox => ({ minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p });
const touches = (a: BBox, b: BBox): boolean => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

const overlapArea = (a: BBox, b: BBox): number =>
	Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));

/** A stroke as it will be after the moves so far (the stroke itself when it has not moved). */
function shifted(s: Stroke, o: TidyShift | undefined): Stroke {
	if (!o) return s;
	return { ...s, points: s.points.map(([x, y, p]): Point => [x + o.dx, y + o.dy, p]) };
}

export interface Row {
	strokes: Stroke[];
	box: BBox;
}

export function unionBox(boxes: readonly BBox[]): BBox {
	return {
		minX: Math.min(...boxes.map((b) => b.minX)), minY: Math.min(...boxes.map((b) => b.minY)),
		maxX: Math.max(...boxes.map((b) => b.maxX)), maxY: Math.max(...boxes.map((b) => b.maxY)),
	};
}

/** Pieces of lines that lie side by side on the same rows (the vertical overlap is most of the lower piece, the gap between them is under `gap`) become one line. */
export function joinPieces(rows: readonly Row[], gap: number): Row[] {
	const n = rows.length;
	if (n < 2 || n > 600) return [...rows];
	const parent = rows.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const a = rows[i]!.box, b = rows[j]!.box;
			const across = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
			const overlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
			if (across <= gap && overlap >= TIDY_RULES.joinOverlap * Math.min(a.maxY - a.minY, b.maxY - b.minY)) parent[find(i)] = find(j);
		}
	}
	const groups = new Map<number, Row[]>();
	rows.forEach((r, i) => {
		const k = find(i);
		const list = groups.get(k);
		if (list) list.push(r);
		else groups.set(k, [r]);
	});
	return [...groups.values()].map((list) => (list.length === 1 ? list[0]! : { strokes: list.flatMap((r) => r.strokes), box: unionBox(list.map((r) => r.box)) }));
}

/** Where the ink of `req` has to move to tidy `page`. Pure analysis; nothing is changed. */
export function analyseTidy(page: Page, req: TidyRequest, options: TidyOptions = DEFAULT_TIDY_OPTIONS): TidyAnalysis {
	const R = TIDY_RULES;
	const moves = new Map<Stroke, TidyShift>();
	const locked = page.locked === true;
	const onPage = new Set(page.strokes);
	const pageElements = page.elements ?? [];
	const asked = req.strokes.filter((s) => onPage.has(s));
	// The request becomes what an edit may touch: locked elements are dropped, groups come whole, hidden ink never.
	const picked = selectableItems(page, { strokes: asked, elements: req.elements.filter((e) => pageElements.includes(e)) });
	const hidden = new Set(pinnedInk(page.strokes, pageElements));
	const ink = picked.strokes.filter((s) => isLinePen(s.tool) && s.hidden !== true && boundGraphId(s) === null && !hidden.has(s) && s.points.length > 0);
	const skipped = Math.max(0, asked.length - ink.length);
	if (ink.length === 0) return { moves, ...EMPTY, skipped, locked };

	const add = (s: Stroke, dx: number, dy: number): void => {
		const o = moves.get(s);
		if (o) { o.dx += dx; o.dy += dy; } else moves.set(s, { dx, dy });
	};

	// 1. The words onto their baseline. Words written very crooked chain into lines only once they are straighter, so the analysis
	// runs again on copies of the straightened ink until it finds nothing more to move (three rounds at most). The lines it ends with
	// are the lines the next steps move, whether or not this step is on: the line is the same line, it just moves as one.
	const base = analyseBaseline(page, ink);
	const size = base.size > 0 ? base.size : 12;
	const down = new Map<Stroke, number>();
	const wordsMoved = new Set<Stroke>();
	let found: Stroke[][] = base.rows ?? [];
	let round = base;
	for (let pass = 0; pass < 3 && round.moves.length > 0; pass++) {
		for (const m of round.moves) {
			wordsMoved.add(m.strokes[0]!);
			for (const s of m.strokes) down.set(s, (down.get(s) ?? 0) + m.dy);
		}
		const copy = new Map<Stroke, Stroke>();
		for (const s of ink) copy.set(s, shifted(s, down.has(s) ? { dx: 0, dy: down.get(s)! } : undefined));
		const back = new Map<Stroke, Stroke>();
		for (const [orig, c] of copy) back.set(c, orig);
		const virtual: Page = { ...page, strokes: page.strokes.map((s) => copy.get(s) ?? s) };
		const next = analyseBaseline(virtual, ink.map((s) => copy.get(s)!));
		// What the next round finds is in terms of the copies: back to the strokes of the page.
		round = { ...next, moves: next.moves.map((m) => ({ ...m, strokes: m.strokes.map((c) => back.get(c) ?? c) })) };
		found = (next.rows ?? []).map((r) => r.map((c) => back.get(c) ?? c));
	}
	let words = 0;
	if (options.baseline) {
		for (const [s, dy] of down) add(s, 0, dy);
		words = wordsMoved.size;
	}
	// The groups: a line holding part of a group that reaches beyond the line is not moved as a line.
	const groupSize = new Map<string, number>();
	for (const s of page.strokes) if (s.group !== undefined) groupSize.set(s.group, (groupSize.get(s.group) ?? 0) + 1);
	for (const e of pageElements) if (e.group !== undefined) groupSize.set(e.group, (groupSize.get(e.group) ?? 0) + 1);
	// A line the baseline analysis cut in two (a word whose baseline it read differently) is put back together: pieces side by side on
	// the same rows are one line, so a line is never moved by halves.
	const rows = joinPieces(found.map((strokes) => ({ strokes, box: unionBox(strokes.map((s) => strokeBounds(shifted(s, moves.get(s))))) })), R.joinGap * size)
		.filter((row) => {
			if (row.strokes.length < R.minLineStrokes) return false;
			const here = new Map<string, number>();
			for (const s of row.strokes) if (s.group !== undefined) here.set(s.group, (here.get(s.group) ?? 0) + 1);
			for (const [g, n] of here) if (groupSize.get(g) !== n) return false;
			return true;
		});
	const moving = new Set<Stroke>();
	for (const row of rows) for (const s of row.strokes) moving.add(s);
	const lines = rows.length;

	// What is in the way: every stroke that is not part of a line that moves, and every element. Invisible ink and the ink a collapsed note
	// keeps hidden never move here but are there once revealed or expanded, so a line must not be moved onto them either.
	const obstacles: BBox[] = [];
	for (const s of page.strokes) {
		if (s.points.length === 0 || moving.has(s)) continue;
		obstacles.push(strokeBounds(shifted(s, moves.get(s))));
	}
	for (const e of pageElements) obstacles.push(elementBounds(e, estimateMeasure));
	const margin = R.obstaclePad * size;
	/** Whether something that does not move is in the strip `swept` (grown a little); `beside`: a line that moves, on the same rows, is in the way too. */
	const blocked = (self: Row, swept: BBox, beside: boolean): boolean => {
		const area = pad(swept, margin);
		for (const o of obstacles) if (touches(area, o)) return true;
		if (!beside) return false;
		for (const other of rows) {
			if (other === self || !(swept.minX < other.box.maxX && swept.maxX > other.box.minX)) continue;
			const overlap = Math.min(swept.maxY, other.box.maxY) - Math.max(swept.minY, other.box.minY);
			if (overlap > 0.5 * Math.min(swept.maxY - swept.minY, other.box.maxY - other.box.minY)) return true;
		}
		return false;
	};
	/** Whether `after` (where a line would end up) overlaps the box of another line more than the line does where it is now: two lines never end on top of each other. */
	const crowds = (self: Row, before: BBox, after: BBox, boxOf: (other: Row) => BBox): boolean => {
		for (const other of rows) {
			if (other === self) continue;
			const o = boxOf(other);
			if (overlapArea(after, o) > overlapArea(before, o) + 0.01) return true;
		}
		return false;
	};
	const moveRow = (row: Row, dx: number, dy: number): void => {
		for (const s of row.strokes) add(s, dx, dy);
		row.box = { minX: row.box.minX + dx, maxX: row.box.maxX + dx, minY: row.box.minY + dy, maxY: row.box.maxY + dy };
	};

	// 3a. The starts of the lines onto a common left margin.
	let aligned = 0;
	if (options.margin && rows.length >= 2) {
		const tolerance = R.leftTolerance * size;
		const ruledPaper = page.paper.kind === "ruled" && RULED_MARGIN_X < page.width;
		const left = rows.map((r) => r.box.minX);
		let remaining = rows.map((_, i) => i);
		const order: Array<{ members: number[]; target: number }> = [];
		while (remaining.length >= 2) {
			let best: number[] = [];
			let at = Infinity;
			for (const i of remaining) {
				const near = remaining.filter((j) => Math.abs(left[j]! - left[i]!) <= tolerance);
				if (near.length > best.length || (near.length === best.length && left[i]! < at)) { best = near; at = left[i]!; }
			}
			if (best.length < 2) break;
			let target = median(best.map((j) => left[j]!));
			if (ruledPaper) {
				const edge = RULED_MARGIN_X + R.marginPad * size;
				if (Math.abs(target - edge) <= R.marginSnap * size) target = edge;
			}
			order.push({ members: best, target });
			const taken = new Set(best);
			remaining = remaining.filter((j) => !taken.has(j));
		}
		for (const { members, target } of order) {
			for (const i of members) {
				const row = rows[i]!;
				const dx = target - row.box.minX;
				if (Math.abs(dx) < R.minMove) continue;
				const swept: BBox = { minX: Math.min(row.box.minX, row.box.minX + dx), maxX: Math.max(row.box.maxX, row.box.maxX + dx), minY: row.box.minY, maxY: row.box.maxY };
				const landed: BBox = { ...row.box, minX: row.box.minX + dx, maxX: row.box.maxX + dx };
				if (blocked(row, swept, true) || crowds(row, row.box, landed, (o) => o.box)) continue;
				moveRow(row, dx, 0);
				aligned++;
			}
		}
	}

	// 3b. Oversized gaps between lines.
	let tightened = 0;
	let saved = 0;
	if (options.gaps && rows.length >= 3) {
		const spacing = page.paper.kind === "ruled" && page.paper.spacing > 0 ? page.paper.spacing : 0;
		const sorted = [...rows].sort((a, b) => a.box.minY + a.box.maxY - b.box.minY - b.box.maxY);
		const above = (row: Row, k: number): Row[] => {
			const mid = row.box.minY + row.box.maxY;
			const out: Row[] = [];
			for (let j = 0; j < k; j++) {
				const o = sorted[j]!;
				if (o.box.minY + o.box.maxY >= mid) continue;
				const overlap = Math.min(o.box.maxX, row.box.maxX) - Math.max(o.box.minX, row.box.minX);
				if (overlap > R.overlapShare * Math.min(o.box.maxX - o.box.minX, row.box.maxX - row.box.minX)) out.push(o);
			}
			return out;
		};
		const preds = sorted.map((row, k) => above(row, k));
		const nearest: number[] = [];
		sorted.forEach((row, k) => {
			const p = preds[k]!;
			if (p.length > 0) nearest.push(Math.max(0, row.box.minY - Math.max(...p.map((o) => o.box.maxY))));
		});
		// The usual gap is a low quantile of the gaps (a page of paragraphs and holes still has mostly ordinary gaps); a pitch is a line of writing plus that gap.
		const ordered = [...nearest].sort((a, b) => a - b);
		const usual = ordered[Math.floor(R.usualQuantile * (ordered.length - 1))] ?? 0;
		const pitch = spacing > 0 ? spacing : usual + median(sorted.map((r) => r.box.maxY - r.box.minY));
		const shift = new Map<Row, number>();
		sorted.forEach((row, k) => {
			const p = preds[k]!;
			let need = p.length === 0 ? 0 : -Infinity;
			// Where the line would be if it only kept up with the lines above it.
			const closest = p.reduce<Row | null>((best, o) => (best === null || o.box.maxY > best.box.maxY ? o : best), null);
			const follow = closest ? shift.get(closest) ?? 0 : 0;
			for (const o of p) {
				const gap = row.box.minY - o.box.maxY;
				const extra = gap - usual;
				let goal = gap;
				if (extra > R.gapOk * pitch) {
					if (!options.keepParagraphs) goal = Math.min(gap, Math.max(usual, R.floorGap * size));
					else if (extra >= R.gapExcess * pitch) goal = usual + pitch;
				}
				need = Math.max(need, (shift.get(o) ?? 0) - (gap - goal));
			}
			let s = Math.min(0, need);
			// On ruled paper a line moves by whole rules only (never less than asked for: no overlap).
			if (spacing > 0 && s < 0) s = Math.ceil(s / spacing - 1e-6) * spacing;
			if (s > -R.minMove) s = 0;
			if (s < 0 && blocked(row, { minX: row.box.minX, maxX: row.box.maxX, minY: row.box.minY + s, maxY: row.box.maxY }, false)) s = 0;
			// Another line that moves, whatever its horizontal overlap with this one, is where it will be (lines above are decided already; the others have not moved yet).
			if (s < 0) {
				const landed: BBox = { ...row.box, minY: row.box.minY + s, maxY: row.box.maxY + s };
				const final = (o: Row): BBox => {
					const d = shift.get(o) ?? 0;
					return d === 0 ? o.box : { ...o.box, minY: o.box.minY + d, maxY: o.box.maxY + d };
				};
				if (crowds(row, row.box, landed, final)) s = 0;
			}
			shift.set(row, s);
			if (s < follow - R.minMove) tightened++;
			if (-s > saved) saved = -s;
		});
		for (const row of sorted) {
			const s = shift.get(row) ?? 0;
			if (s !== 0) moveRow(row, 0, s);
		}
	}

	for (const [s, o] of [...moves]) if (Math.abs(o.dx) < 0.005 && Math.abs(o.dy) < 0.005) moves.delete(s);
	return { moves, words, aligned, tightened, saved, lines, skipped, locked };
}

export interface TidyPlan {
	/** The step: one undo, a `Batch` of rigid moves. */
	command: Batch;
	/** What became of each stroke that moved. */
	changes: ReadonlyMap<Stroke, Stroke>;
	analysis: TidyAnalysis;
}

/** The command that tidies `req` on `page` as ONE undo step, or null when nothing needs to move (or the page is locked). */
export function planTidy(page: Page, req: TidyRequest, options: TidyOptions = DEFAULT_TIDY_OPTIONS, label = "Tidy up page"): TidyPlan | null {
	const analysis = analyseTidy(page, req, options);
	if (analysis.moves.size === 0 || analysis.locked) return null;
	const placement = emptyPlacement();
	for (const [s, o] of analysis.moves) placement.strokes.set(s, translate(o.dx, o.dy));
	const movers = [...analysis.moves.keys()].filter((s) => page.strokes.includes(s));
	const plan = applyPlacement(page, movers, [], placement, estimateMeasure, label);
	if (!plan) return null;
	const changes = new Map<Stroke, Stroke>();
	movers.forEach((s, i) => {
		const after = plan.strokes[i]!;
		if (after !== s) changes.set(s, after);
	});
	return { command: plan.command, changes, analysis };
}
