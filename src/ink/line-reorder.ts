import { boundGraphId, pinnedInk, withPinnedInk } from "./attach";
import { analyseBaseline } from "./baseline";
import { elementBounds, transformElement, type MeasureText } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { transformStroke } from "./lasso";
import { inkOwnership } from "./selection-transform";
import { joinPieces, TIDY_RULES, unionBox, type Row } from "./tidy";
import { estimateMeasure } from "./text-layout";
import { translate } from "./transform";
import { isLockedElement, UpdateItems, type PageItem } from "../model/groups";
import { freezeStroke } from "../model/serialize";
import { isLinePen, type Page, type PageElement, type Stroke } from "../model/types";

/**
 * 0.28 (#256): "Line handle" (pure, no 'obsidian'). Whole handwritten lines are dragged to a new place between the other lines.
 *
 * The lines are the ones "Align to baseline" and "Tidy up" already find (`analyseBaseline` rows, pieces side by side joined as in
 * `tidy.ts`), plus: lines whose rows overlap vertically are one line (two columns on the same rows), and a line is the strip of
 * the page between its neighbours: its BAND. A line moves together with
 *  - its line-pen handwriting (`isLinePen`), the invisible ink and the underline-like line-pen strokes fully inside its band, and
 *  - every element fully inside its band (an area highlighter behind the line, a text box or a checkbox beside it, a sticky note
 *    with the ink it keeps hidden, a graph with the ink bound to it).
 * Nothing else moves. A line is REFUSED (it gets a `blocked` reason, and no move that involves it is planned) when
 *  - an element in its band is locked ("locked"), or something that does not move (a highlighter stroke, a shape, an element that
 *    reaches into the neighbour band) is on it ("busy"),
 *  - it holds part of a group whose other members are not in the same line ("group": a group moves whole or not at all), or
 *  - an item would have to move with two lines at once ("conflict").
 * A locked page refuses every move. A move is also refused when a moved line would land on something that stays ("crowded") or
 * outside the page ("edge").
 *
 * The move of line `from` to place `to` re-lays the lines between the two places one after the other from the upper one, each taking
 * the pitch (its top to the top of the next line) it had: the lines in between shift up or down by the moved line's pitch and the
 * spacing is kept. Everything is a rigid translation in y (points, pressure, width, taper, id and layer untouched), ONE undo step
 * (`UpdateItems`, which remaps), and the page times are not touched: the ink is moved, not written now. The document format does not change.
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
} as const;

/** Why a line cannot move. */
export type LineBlock = "locked" | "busy" | "group" | "conflict";

export interface ReorderLine {
	/** Position in reading order, top to bottom. */
	index: number;
	/** The box of its handwriting (page coordinates). */
	box: BBox;
	/** The strip of the page it owns: a moved element must be fully inside it. */
	band: { top: number; bottom: number };
	/** Its top to the top of the next line (the last one: its height plus the usual gap), pt: how much room the line takes. */
	pitch: number;
	/** Everything that moves with it. */
	strokes: Stroke[];
	elements: PageElement[];
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
	/** The size of the writing (pt), 0 when there is none. */
	size: number;
	/** Page height when the page does not grow, else 0. */
	limit: number;
	obstacles: Obstacle[];
}

const EMPTY_MODEL = (page: Page): LineModel => ({ pageId: page.id, lines: [], locked: page.locked === true, size: 0, limit: 0, obstacles: [] });

const overlapY = (a: BBox, b: BBox): number => Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
const overlapArea = (a: BBox, b: BBox): number => Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, overlapY(a, b));
const contains = (outer: BBox, inner: BBox, slack: number): boolean =>
	outer.minX <= inner.minX + slack && outer.maxX >= inner.maxX - slack && outer.minY <= inner.minY + slack && outer.maxY >= inner.maxY - slack;

const area = (b: BBox): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
/** Something that lies behind the whole line and is much bigger than it (a page picture, a locked background): the line may leave it. */
const backdrop = (outer: BBox, line: BBox): boolean => contains(outer, line, 1) && area(outer) >= LINE_RULES.backdropFactor * area(line);

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Rows that share most of their vertical extent are one line (two columns, or a line cut in pieces far apart). */
function mergeBands(rows: Row[]): Row[] {
	const out = [...rows].sort((a, b) => a.box.minY - b.box.minY);
	const pairAt = (): [number, number] | null => {
		for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				const a = out[i]!.box, b = out[j]!.box;
				const h = Math.min(a.maxY - a.minY, b.maxY - b.minY);
				if (h > 0 && overlapY(a, b) >= LINE_RULES.mergeOverlap * h) return [i, j];
			}
		}
		return null;
	};
	for (let pair = pairAt(); pair; pair = pairAt()) {
		const [i, j] = pair;
		out[i] = { strokes: [...out[i]!.strokes, ...out[j]!.strokes], box: unionBox([out[i]!.box, out[j]!.box]) };
		out.splice(j, 1);
	}
	return out.sort((a, b) => a.box.minY - b.box.minY);
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
		index: i, box: r.box, band: bands[i]!,
		pitch: rows[i + 1] ? rows[i + 1]!.box.minY - r.box.minY : r.box.maxY - r.box.minY + usual,
		strokes: [...r.strokes], elements: [], blocked: null,
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
	for (const e of elements) {
		const box = elementBounds(e, measure);
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

	// Groups move whole or not at all: every member of a group that has a member in a line must be in that line.
	const groupSize = new Map<string, number>();
	for (const s of page.strokes) if (s.group !== undefined) groupSize.set(s.group, (groupSize.get(s.group) ?? 0) + 1);
	for (const e of elements) if (e.group !== undefined) groupSize.set(e.group, (groupSize.get(e.group) ?? 0) + 1);
	for (const l of lines) {
		const here = new Map<string, number>();
		for (const i of [...l.strokes, ...l.elements]) if (i.group !== undefined) here.set(i.group, (here.get(i.group) ?? 0) + 1);
		for (const [g, n] of here) if (groupSize.get(g) !== n) l.blocked = "group";
	}

	// What stays: every stroke and element that is in no line. A line with something on it (that is not a backdrop) is busy.
	const obstacles: Obstacle[] = [];
	for (const s of page.strokes) if (!owner.has(s) && s.points.length > 0) obstacles.push({ box: strokeBounds(s), locked: false });
	for (const e of elements) if (!owner.has(e)) obstacles.push({ box: elementBounds(e, measure), locked: isLockedElement(e) });
	for (const l of lines) {
		if (l.blocked === null && lockedIn.has(l.index)) l.blocked = "locked";
		if (l.blocked !== null) continue;
		for (const o of obstacles) {
			if (overlapArea(l.box, o.box) <= LINE_RULES.touchArea || backdrop(o.box, l.box)) continue;
			l.blocked = o.locked ? "locked" : "busy";
			break;
		}
		if (l.blocked === null && conflicted.has(l.index)) l.blocked = "conflict";
	}
	return { pageId: page.id, lines, locked: page.locked === true, size, limit: page.infinite === true ? 0 : page.height, obstacles };
}

export type LineRefusal = "same" | "range" | "page-locked" | LineBlock | "crowded" | "edge";

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
	const landed = (i: number): BBox => {
		const b = model.lines[i]!.box, d = shifts[i]!;
		return { ...b, minY: b.minY + d, maxY: b.maxY + d };
	};
	for (let i = lo; i <= hi; i++) {
		const box = landed(i);
		if (box.minY < 0 || (model.limit > 0 && box.maxY > model.limit)) return { ok: false, reason: "edge" };
		for (const o of model.obstacles) if (overlapArea(box, o.box) > LINE_RULES.touchArea && !backdrop(o.box, box)) return { ok: false, reason: "crowded" };
		// The lines that stay: no more overlap with them than before.
		for (let k = 0; k < n; k++) {
			if (k >= lo && k <= hi) continue;
			if (overlapArea(box, model.lines[k]!.box) > overlapArea(model.lines[i]!.box, model.lines[k]!.box) + 0.01) return { ok: false, reason: "crowded" };
		}
	}
	return { ok: true, from, to, shifts };
}

/** The move one place up (`-1`) or down (`+1`) of line `from`. */
export function planLineStep(model: LineModel, from: number, step: -1 | 1): LineMoveResult {
	return planLineMove(model, from, from + step);
}

export interface LineMovePlan {
	command: UpdateItems;
	/** Strokes and elements that move, and how far (by id). */
	moved: ReadonlyMap<string, number>;
	strokes: number;
	elements: number;
}

/** The step that makes `move`: ONE undo (`UpdateItems`, rigid translations in y). Null when nothing moves. */
export function lineMoveCommand(page: Page, model: LineModel, move: LineMove, measure: MeasureText = estimateMeasure): LineMovePlan | null {
	const strokeDy = new Map<string, number>();
	const elementDy = new Map<string, number>();
	for (const l of model.lines) {
		const dy = move.shifts[l.index] ?? 0;
		if (Math.abs(dy) < LINE_RULES.minMove) continue;
		for (const s of l.strokes) strokeDy.set(s.id, dy);
		for (const e of l.elements) elementDy.set(e.id, dy);
	}
	if (strokeDy.size + elementDy.size === 0) return null;
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
	return { command: new UpdateItems(page.id, ids, change, "Move line"), moved, strokes: strokeDy.size, elements: elementDy.size };
}
