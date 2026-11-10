import { boundGraphId, pinnedInk, withPinnedInk } from "./attach";
import { analyseBaseline } from "./baseline";
import { elementBounds, transformElement, type MeasureText } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { transformStroke } from "./lasso";
import { inkOwnership } from "./selection-transform";
import { joinPieces, TIDY_RULES, unionBox, type Row } from "./tidy";
import { estimateMeasure } from "./text-layout";
import { movesUnderRedaction, type RedactGuard } from "./redact";
import { translate } from "./transform";
import { isNote, SetPageComments } from "../model/comments";
import { isLockedElement, UpdateItems, type PageItem } from "../model/groups";
import { Batch, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import { stickyFrame } from "../model/sticky";
import { isLinePen, type CommentRegion, type Page, type PageComment, type PageCommentNote, type PageElement, type Stroke } from "../model/types";

/**
 * 0.28 (#256): "Line handle" (pure, no 'obsidian'). Whole handwritten lines are dragged to a new place between the other lines.
 *
 * The lines are the ones "Align to baseline" and "Tidy up" already find (`analyseBaseline` rows, pieces side by side joined as in
 * `tidy.ts`), plus: lines whose rows overlap vertically are one line (two columns on the same rows), and a line is the strip of
 * the page between its neighbours: its BAND. A line moves together with
 *  - its line-pen handwriting (`isLinePen`), the invisible ink and the underline-like line-pen strokes fully inside its band,
 *  - every element fully inside its band (an area highlighter behind the line, a text box or a checkbox beside it, a sticky note
 *    with the ink it keeps hidden, a graph with the ink bound to it), and
 *  - the margin comments whose region is fully inside its band (their regions shift in the same undo step).
 * Nothing else moves. A line is REFUSED (it gets a `blocked` reason, and no move that involves it is planned) when
 *  - an element in its band is locked ("locked"), or something that does not move (a highlighter stroke, a shape, an element or a
 *    comment region that reaches into the neighbour band, a part of a drawing with states) touches anything that moves with it ("busy"),
 *  - it holds part of a group whose other members are not in the same line ("group": a group moves whole or not at all), or
 *  - an item would have to move with two lines at once ("conflict").
 * A locked page refuses every move, and so does a page with a PDF or picture background (the writing annotates what is printed
 * there). A move is also refused when anything that moves with a line (its REACH: handwriting, elements, ink bound to them) would
 * land on something that stays or on another moved line ("crowded"), or when anything that moves (its EXTENT: the reach plus the ink a
 * collapsed note keeps hidden, the expanded box of a note and the comment regions) would leave the page ("edge").
 *
 * The move of line `from` to place `to` re-lays the lines between the two places one after the other from the upper one, each taking
 * the pitch (its top to the top of the next line) it had: the lines in between shift up or down by the moved line's pitch and the
 * spacing is kept. Everything is a rigid translation in y (points, pressure, width, taper, id and layer untouched), ONE undo step
 * (`UpdateItems`, plus `SetPageComments` when comments move; both remap or have nothing to remap), and the page times are not
 * touched: the ink is moved, not written now. The document format does not change.
 */

export const LINE_RULES = {
	/** Two rows overlapping vertically by this share of the shorter one are the same line. */
	mergeOverlap: 0.5,
	/** An item is "fully inside" a band within this many pt. */
	slack: 0.5,
	/** Boxes overlapping by less than this many pt² do not touch. */
	touchArea: 0.5,
	/** A shift under this many pt is no move. */
	minMove: 0.05,
	/** The bands of the first and the last line reach this many `S` (the size of the writing) beyond the ink. */
	endPad: 0.6,
	/** A backdrop is at least this many times the area of the line it lies behind. */
	backdropFactor: 4,
	/** A landed line is compared with the staying lines this many places beyond the two ends of the move. */
	neighbours: 2,
} as const;

/** Why a line cannot move. */
export type LineBlock = "locked" | "busy" | "group" | "conflict";

export interface ReorderLine {
	/** Position in reading order, top to bottom. */
	index: number;
	/** The box of its handwriting (page coordinates): the lines are laid out by it. */
	box: BBox;
	/** The box of everything visible that moves with the line (handwriting, elements, ink bound to them): what must not land on anything. */
	reach: BBox;
	/** `reach` plus what is not drawn now (ink a collapsed note keeps hidden, invisible ink, the expanded box of a note, comment regions): what must stay on the page. */
	extent: BBox;
	/** The strip of the page it owns: a moved element must be fully inside it. */
	band: { top: number; bottom: number };
	/** Its top to the top of the next line (the last one: its height plus the usual gap), pt: how much room the line takes. */
	pitch: number;
	/** Everything that moves with it. */
	strokes: Stroke[];
	elements: PageElement[];
	/** The ids of the margin comments whose region moves with it. */
	comments: string[];
	blocked: LineBlock | null;
}

interface Obstacle {
	box: BBox;
	locked: boolean;
}

export interface LineModel {
	pageId: string;
	lines: ReorderLine[];
	/** The page is locked: no move is made. */
	locked: boolean;
	/** The page has a PDF or picture background: the writing annotates it and stays on it. */
	background: boolean;
	/** The size of the writing (pt), 0 when there is none. */
	size: number;
	/** Page height when the page does not grow, else 0. */
	limit: number;
	/** What stays put wherever a line goes: strokes and elements that are in no line, by their top. */
	obstacles: Obstacle[];
	/** `obstacleReach[k]`: the largest bottom among `obstacles[0..k]` (it lets a search stop early). */
	obstacleReach: number[];
}

const EMPTY_MODEL = (page: Page): LineModel => ({
	pageId: page.id, lines: [], locked: page.locked === true, background: page.background !== undefined, size: 0, limit: 0, obstacles: [], obstacleReach: [],
});

const overlapY = (a: BBox, b: BBox): number => Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
const overlapArea = (a: BBox, b: BBox): number => Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, overlapY(a, b));
const contains = (outer: BBox, inner: BBox, slack: number): boolean =>
	outer.minX <= inner.minX + slack && outer.maxX >= inner.maxX - slack && outer.minY <= inner.minY + slack && outer.maxY >= inner.maxY - slack;

const area = (b: BBox): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
/** Something that lies behind the whole line and is much bigger than it (a page picture, a locked background): the line may leave it. */
const backdrop = (outer: BBox, line: BBox): boolean => contains(outer, line, 1) && area(outer) >= LINE_RULES.backdropFactor * area(line);

const shiftBox = (b: BBox, dy: number): BBox => (dy === 0 ? b : { ...b, minY: b.minY + dy, maxY: b.maxY + dy });
const regionBox = (r: CommentRegion): BBox => ({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height });

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function union(boxes: readonly BBox[]): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const b of boxes) {
		if (b.minX < minX) minX = b.minX;
		if (b.minY < minY) minY = b.minY;
		if (b.maxX > maxX) maxX = b.maxX;
		if (b.maxY > maxY) maxY = b.maxY;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Rows that share most of their vertical extent are one line (two columns, or a line cut in pieces far apart). One sort and one sweep
 * against the running union of the line being built: O(n log n), however many rows a long page has.
 */
export function mergeBands(rows: readonly Row[]): Row[] {
	const sorted = [...rows].sort((a, b) => a.box.minY - b.box.minY);
	const out: Row[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last) {
			const h = Math.min(last.box.maxY - last.box.minY, r.box.maxY - r.box.minY);
			if (h > 0 && overlapY(last.box, r.box) >= LINE_RULES.mergeOverlap * h) {
				for (const s of r.strokes) last.strokes.push(s);
				last.box = unionBox([last.box, r.box]);
				continue;
			}
		}
		out.push({ strokes: [...r.strokes], box: r.box });
	}
	return out;
}

/** The first obstacle that touches `box` and is not `ignored`, or null. Looks only at the obstacles that can reach `box` vertically. */
function firstObstacle(model: Pick<LineModel, "obstacles" | "obstacleReach">, box: BBox, ignored: (o: Obstacle) => boolean): Obstacle | null {
	const list = model.obstacles;
	// The obstacles are sorted by their top: those from `end` on start below the box.
	let lo = 0, hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid]!.box.minY < box.maxY) lo = mid + 1;
		else hi = mid;
	}
	for (let k = lo - 1; k >= 0 && model.obstacleReach[k]! > box.minY; k--) {
		const o = list[k]!;
		if (overlapArea(box, o.box) > LINE_RULES.touchArea && !ignored(o)) return o;
	}
	return null;
}

/** The lines of `page` and what moves with each (see the file comment). Pure analysis; nothing is changed. */
export function analyseLines(page: Page, measure: MeasureText = estimateMeasure): LineModel {
	const elements = page.elements ?? [];
	const pinned = new Set(pinnedInk(page.strokes, elements));
	const handwriting = (s: Stroke): boolean => isLinePen(s.tool) && boundGraphId(s) === null && !pinned.has(s) && s.points.length > 0;
	const ink = page.strokes.filter((s) => handwriting(s) && s.hidden !== true);
	if (ink.length === 0) return EMPTY_MODEL(page);
	// The baseline analysis keeps a group that is not wholly in the request out of the lines. Here a line holding such a group is still
	// a line (it is refused below, and shows as refused): the analysis runs on ungrouped copies of the grouped strokes.
	const back = new Map<Stroke, Stroke>();
	const copies = new Map<Stroke, Stroke>();
	for (const s of ink) {
		if (s.group === undefined) continue;
		const copy: Stroke = { ...s };
		delete copy.group;
		back.set(copy, s);
		copies.set(s, copy);
	}
	const virtual: Page = copies.size === 0 ? page : { ...page, strokes: page.strokes.map((s) => copies.get(s) ?? s) };
	const base = analyseBaseline(virtual, copies.size === 0 ? ink : ink.map((s) => copies.get(s) ?? s));
	const size = base.size > 0 ? base.size : 12;
	const found = (base.rows ?? []).filter((r) => r.length > 0).map((r): Row => {
		const strokes = r.map((s) => back.get(s) ?? s);
		return { strokes, box: unionBox(strokes.map((s) => strokeBounds(s))) };
	});
	const rows = mergeBands(joinPieces(found, TIDY_RULES.joinGap * size));
	if (rows.length === 0) return { ...EMPTY_MODEL(page), size };

	// The bands: the strip between the middles of the gaps to the neighbours.
	const bands = rows.map((r, i) => {
		const prev = rows[i - 1]?.box, next = rows[i + 1]?.box;
		const top = prev ? Math.min(r.box.minY, (prev.maxY + r.box.minY) / 2) : r.box.minY - LINE_RULES.endPad * size;
		const bottom = next ? Math.max(r.box.maxY, (r.box.maxY + next.minY) / 2) : r.box.maxY + LINE_RULES.endPad * size;
		return { top, bottom };
	});
	const gaps = rows.slice(1).map((r, i) => r.box.minY - rows[i]!.box.maxY).filter((g) => g > 0);
	const usual = gaps.length > 0 ? median(gaps) : 0.5 * size;
	const lines: ReorderLine[] = rows.map((r, i) => ({
		index: i, box: r.box, reach: r.box, extent: r.box, band: bands[i]!,
		pitch: rows[i + 1] ? rows[i + 1]!.box.minY - r.box.minY : r.box.maxY - r.box.minY + usual,
		strokes: [...r.strokes], elements: [], comments: [], blocked: null,
	}));
	const owner = new Map<Stroke | PageElement, number>();
	const conflicted = new Set<number>();
	const claim = (item: Stroke | PageElement, line: number): void => {
		const was = owner.get(item);
		if (was === undefined) owner.set(item, line);
		else if (was !== line) { conflicted.add(was); conflicted.add(line); }
	};
	lines.forEach((l) => l.strokes.forEach((s) => claim(s, l.index)));
	const inBand = (box: BBox): number => bands.findIndex((b) => box.minY >= b.top - LINE_RULES.slack && box.maxY <= b.bottom + LINE_RULES.slack);

	// Line-pen strokes of the page that the analysis did not take as writing (an underline, a bracket) or that are invisible: with the line when fully inside its band.
	const lockedIn = new Set<number>();
	for (const s of page.strokes) {
		if (owner.has(s) || !handwriting(s)) continue;
		const at = inBand(strokeBounds(s));
		if (at >= 0) { lines[at]!.strokes.push(s); claim(s, at); }
	}
	// Elements fully inside a band; a locked one refuses the line.
	const elementBox = new Map<PageElement, BBox>();
	for (const e of elements) {
		const box = elementBounds(e, measure);
		elementBox.set(e, box);
		const at = inBand(box);
		if (at < 0) continue;
		if (isLockedElement(e)) {
			lockedIn.add(at);
			continue;
		}
		lines[at]!.elements.push(e);
		claim(e, at);
	}
	// The ink a sticky note keeps hidden, and the ink bound to a graph, goes with its object.
	for (const l of lines) {
		if (l.elements.length === 0) continue;
		const have = new Set(l.strokes);
		for (const s of withPinnedInk(page.strokes, [], l.elements)) if (!have.has(s)) { l.strokes.push(s); have.add(s); }
		for (const s of inkOwnership(page, [], l.elements, measure, false).followers) if (!have.has(s)) { l.strokes.push(s); have.add(s); }
		for (const s of l.strokes) claim(s, l.index);
	}
	// Margin comments: a region fully inside a band moves with its line; one that touches the writing of a line without being inside its band refuses it.
	const commentBusy = new Set<number>();
	const commentBoxes = new Map<number, BBox[]>();
	for (const c of page.comments ?? []) {
		if (!isNote(c)) continue;
		const box = regionBox(c.region);
		const at = inBand(box);
		if (at >= 0) {
			lines[at]!.comments.push(c.id);
			const list = commentBoxes.get(at);
			if (list) list.push(box);
			else commentBoxes.set(at, [box]);
			continue;
		}
		for (const l of lines) if (overlapArea(l.box, box) > LINE_RULES.touchArea) commentBusy.add(l.index);
	}
	// Parts of a drawing with states pivot about a point and are posed by a state: a line that holds one of their items is refused.
	const stateItems = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) stateItems.add(id);

	// How far each line reaches: what is visible and moves with it, and what is not drawn now but must stay on the page.
	for (const l of lines) {
		const seen: BBox[] = [l.box];
		const all: BBox[] = [l.box];
		for (const s of l.strokes) {
			const b = strokeBounds(s);
			all.push(b);
			if (!pinned.has(s) && s.hidden !== true) seen.push(b);
		}
		for (const e of l.elements) {
			const b = elementBox.get(e)!;
			seen.push(b);
			all.push(b);
			if (e.type === "sticky") all.push(stickyFrame(e));
		}
		for (const b of commentBoxes.get(l.index) ?? []) all.push(b);
		l.reach = union(seen);
		l.extent = union(all);
	}

	// Groups move whole or not at all: every member of a group that has a member in a line must be in that line.
	const groupSize = new Map<string, number>();
	for (const s of page.strokes) if (s.group !== undefined) groupSize.set(s.group, (groupSize.get(s.group) ?? 0) + 1);
	for (const e of elements) if (e.group !== undefined) groupSize.set(e.group, (groupSize.get(e.group) ?? 0) + 1);
	for (const l of lines) {
		const here = new Map<string, number>();
		for (const i of [...l.strokes, ...l.elements]) if (i.group !== undefined) here.set(i.group, (here.get(i.group) ?? 0) + 1);
		for (const [g, n] of here) if (groupSize.get(g) !== n) l.blocked = "group";
	}

	// What stays: every stroke and element that is in no line (the ink a collapsed note keeps hidden is not there to be touched). A line
	// whose reach has something on it (that is not a backdrop) is busy.
	const obstacles: Obstacle[] = [];
	for (const s of page.strokes) if (!owner.has(s) && !pinned.has(s) && s.points.length > 0) obstacles.push({ box: strokeBounds(s), locked: false });
	for (const e of elements) if (!owner.has(e)) obstacles.push({ box: elementBox.get(e)!, locked: isLockedElement(e) });
	obstacles.sort((a, b) => a.box.minY - b.box.minY);
	const obstacleReach: number[] = [];
	let reach = -Infinity;
	for (const o of obstacles) obstacleReach.push((reach = Math.max(reach, o.box.maxY)));
	const model: LineModel = {
		pageId: page.id, lines, locked: page.locked === true, background: page.background !== undefined, size,
		limit: page.infinite === true ? 0 : page.height, obstacles, obstacleReach,
	};
	for (const l of lines) {
		if (l.blocked === null && lockedIn.has(l.index)) l.blocked = "locked";
		if (l.blocked !== null) continue;
		const o = firstObstacle(model, l.reach, (x) => backdrop(x.box, l.reach));
		if (o) l.blocked = o.locked ? "locked" : "busy";
		else if (commentBusy.has(l.index) || l.strokes.some((s) => stateItems.has(s.id)) || l.elements.some((e) => stateItems.has(e.id))) l.blocked = "busy";
		else if (conflicted.has(l.index)) l.blocked = "conflict";
	}
	return model;
}

/**
 * A cheap fingerprint of what the lines of a page depend on: its size, paper edge, background, lock and the identity of every stroke
 * and element (they are replaced on every edit, never changed in place; `stamp` numbers an object), of the comments and of the states.
 */
export function pageSignature(page: Page, stamp: (o: object) => number): string {
	let acc = 0;
	for (const s of page.strokes) acc = (acc * 31 + stamp(s)) | 0;
	for (const e of page.elements ?? []) acc = (acc * 31 + stamp(e)) | 0;
	const m = page.margins;
	return [
		page.id, page.locked === true ? 1 : 0, page.width, page.height, page.infinite === true ? 1 : 0, page.background?.kind ?? "", m ? `${m.left},${m.right},${m.bottom}` : "",
		page.strokes.length, page.elements?.length ?? 0, page.comments ? stamp(page.comments) : 0, page.states ? stamp(page.states) : 0, acc,
	].join("|");
}

export type LineRefusal = "same" | "range" | "page-locked" | "background" | LineBlock | "crowded" | "edge";

export interface LineMove {
	from: number;
	to: number;
	/** How far each line (by index) moves down (negative: up), pt; 0 for the lines that stay. */
	shifts: number[];
}

export type LineMoveResult = ({ ok: true } & LineMove) | { ok: false; reason: LineRefusal };

/** Where the dragged line `from` lands when its middle is at `y`: the number of the other lines whose middle is above it. */
export function dropIndex(model: LineModel, from: number, y: number): number {
	let to = 0;
	for (const l of model.lines) if (l.index !== from && (l.box.minY + l.box.maxY) / 2 < y) to++;
	return to;
}

/** The move of line `from` to place `to` (0-based places in the new order), or why it is refused. Pure. */
export function planLineMove(model: LineModel, from: number, to: number): LineMoveResult {
	const n = model.lines.length;
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) return { ok: false, reason: "range" };
	if (from === to) return { ok: false, reason: "same" };
	if (model.locked) return { ok: false, reason: "page-locked" };
	if (model.background) return { ok: false, reason: "background" };
	const lo = Math.min(from, to), hi = Math.max(from, to);
	for (let i = lo; i <= hi; i++) {
		const b = model.lines[i]!.blocked;
		if (b !== null) return { ok: false, reason: b };
	}
	// The lines lo..hi in their new order, laid one after the other from the top of the upper one, each with its own pitch.
	const order: number[] = [];
	for (let i = lo; i <= hi; i++) if (i !== from) order.push(i);
	order.splice(to - lo, 0, from);
	const shifts = new Array<number>(n).fill(0);
	let top = model.lines[lo]!.box.minY;
	for (const i of order) {
		const line = model.lines[i]!;
		shifts[i] = top - line.box.minY;
		top += line.pitch;
	}
	for (let i = lo; i <= hi; i++) if (Math.abs(shifts[i]!) < LINE_RULES.minMove) shifts[i] = 0;
	const reachAt = (i: number): BBox => shiftBox(model.lines[i]!.reach, shifts[i]!);
	for (let i = lo; i <= hi; i++) {
		const line = model.lines[i]!;
		const extent = shiftBox(line.extent, shifts[i]!);
		if (extent.minY < 0 || (model.limit > 0 && extent.maxY > model.limit)) return { ok: false, reason: "edge" };
		const box = reachAt(i);
		if (firstObstacle(model, box, (o) => backdrop(o.box, box))) return { ok: false, reason: "crowded" };
		// The lines that stay, next to the two ends of the move: no more overlap with them than before.
		for (let k = Math.max(0, lo - LINE_RULES.neighbours); k <= Math.min(n - 1, hi + LINE_RULES.neighbours); k++) {
			if (k >= lo && k <= hi) continue;
			if (overlapArea(box, model.lines[k]!.reach) > overlapArea(line.reach, model.lines[k]!.reach) + 0.01) return { ok: false, reason: "crowded" };
		}
	}
	// The moved lines among themselves: lines that are next to each other now are not over each other more than they were.
	for (let k = 1; k < order.length; k++) {
		const a = order[k - 1]!, b = order[k]!;
		if (overlapArea(reachAt(a), reachAt(b)) > overlapArea(model.lines[a]!.reach, model.lines[b]!.reach) + 0.01) return { ok: false, reason: "crowded" };
	}
	return { ok: true, from, to, shifts };
}

/** The move one place up (`-1`) or down (`+1`) of line `from`. */
export function planLineStep(model: LineModel, from: number, step: -1 | 1): LineMoveResult {
	return planLineMove(model, from, from + step);
}

export interface LineMovePlan {
	/** The step: `UpdateItems`, with `SetPageComments` in a `Batch` when comments move too. */
	command: Command;
	/** Strokes and elements that move, and how far (by id). */
	moved: ReadonlyMap<string, number>;
	/** Margin comments of the page that move, and how far (by id). */
	movedComments: ReadonlyMap<string, number>;
	strokes: number;
	elements: number;
	/** Margin comments whose region moved. */
	comments: number;
}

/**
 * The step that makes `move`: ONE undo (rigid translations in y). Null when nothing moves, and when none of what would move is on
 * `page` (a plan made for another page, or for a page that changed since): it never makes an empty step.
 */
export function lineMoveCommand(page: Page, model: LineModel, move: LineMove, measure: MeasureText = estimateMeasure): LineMovePlan | null {
	if (model.pageId !== page.id) return null;
	const strokeDy = new Map<string, number>();
	const elementDy = new Map<string, number>();
	const commentDy = new Map<string, number>();
	for (const l of model.lines) {
		const dy = move.shifts[l.index] ?? 0;
		if (Math.abs(dy) < LINE_RULES.minMove) continue;
		for (const s of l.strokes) strokeDy.set(s.id, dy);
		for (const e of l.elements) elementDy.set(e.id, dy);
		for (const c of l.comments) commentDy.set(c, dy);
	}
	// Only what is on the page now counts: a plan that finds none of its items there is not a step.
	const onPage = new Set<string>();
	for (const s of page.strokes) if (strokeDy.has(s.id)) onPage.add(s.id);
	for (const e of page.elements ?? []) if (elementDy.has(e.id)) onPage.add(e.id);
	const commentsHere = (page.comments ?? []).filter((c): c is PageCommentNote => isNote(c) && commentDy.has(c.id));
	if (onPage.size === 0 && commentsHere.length === 0) return null;
	const ids = new Set<string>([...strokeDy.keys(), ...elementDy.keys()]);
	const change = (item: PageItem): PageItem => {
		if ("type" in item) {
			const dy = elementDy.get(item.id);
			return dy === undefined ? item : transformElement(item, translate(0, dy), measure);
		}
		const dy = strokeDy.get(item.id);
		return dy === undefined ? item : freezeStroke(transformStroke(item, translate(0, dy)));
	};
	const moved = new Map<string, number>([...strokeDy, ...elementDy]);
	const items = new UpdateItems(page.id, ids, change, "Move line");
	let command: Command = items;
	if (commentsHere.length > 0) {
		const list = (page.comments ?? []).map((c): PageComment => {
			const dy = isNote(c) ? commentDy.get(c.id) : undefined;
			return dy === undefined || !isNote(c) ? c : { ...c, region: { ...c.region, y: Math.round((c.region.y + dy) * 100) / 100 } };
		});
		command = new Batch("Move line", [items, new SetPageComments(page.id, page.comments, list, "Move line")]);
	}
	const movedComments = new Map<string, number>(commentsHere.map((c) => [c.id, commentDy.get(c.id)!]));
	return { command, moved, movedComments, strokes: strokeDy.size, elements: elementDy.size, comments: commentsHere.length };
}

/**
 * Review fix (R2-4): whether the step `plan` takes ink from under a redaction box of the page, or puts ink under one (fail closed: boxes that
 * cannot be read refuse any move). A reorder moves whole lines in one gesture, so the line a box was drawn over can slide away and another
 * take its place; the move is refused instead (the person removes or redoes the boxes first).
 */
export function lineMoveUnderRedaction(page: Page, plan: LineMovePlan, guard: RedactGuard, measure: MeasureText = estimateMeasure): boolean {
	const strokes = page.strokes.filter((s) => plan.moved.has(s.id));
	const elements = (page.elements ?? []).filter((e) => plan.moved.has(e.id));
	const notes = (page.comments ?? []).filter((c): c is PageCommentNote => isNote(c) && plan.movedComments.has(c.id));
	return movesUnderRedaction(
		guard,
		{ strokes, elements, regions: notes.map((c) => c.region) },
		{
			strokes: strokes.map((s) => transformStroke(s, translate(0, plan.moved.get(s.id)!))),
			elements: elements.map((e) => transformElement(e, translate(0, plan.moved.get(e.id)!), measure)),
			regions: notes.map((c) => ({ ...c.region, y: c.region.y + plan.movedComments.get(c.id)! })),
		},
	);
}
