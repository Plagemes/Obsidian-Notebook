import {
	blockWidth, eventFromText, EVENT_SIZE, layoutTimeline, MIN_AXIS, PADX, TITLE_SIZE, TICK_SIZE,
	type TimelineEvent, type TimelineLabels, type TimelineLayout,
} from "../math/timeline-layout";
import { createId } from "../model/document";
import { isLockedElement } from "../model/groups";
import { AddElement, AddStroke, Batch, RemoveElement, ReplaceElement, ReplaceStroke, type Command } from "../model/history";
import { RENDER_FREEHAND, type Page, type PageElement, type Point, type Stroke, type TapeElement, type TextElement } from "../model/types";
import { SUBJECT_COLORS } from "../ui/palette";
import { movesUnderRedaction, type RedactGuard } from "./redact";
import { ellipsePoints, polygonPoints } from "./shapes";
import { selectionHoldsCovered } from "./tape-guard";

/**
 * Timeline element (0.30, roadmap #148). A timeline is ordinary content, nothing is added to the document format: vector shape strokes (the
 * axis, ticks, poles, dots) and text boxes (title, one label per event, tick labels), all of one fresh group. The geometry is
 * `math/timeline-layout.ts`; this file turns it into strokes and text boxes and makes the undoable steps, as `ink/chart.ts` does for charts.
 *
 * THE LINK is the group id, free text of at most 64 characters: `nbt1.<colour>.<random>`. A timeline is recognised, read back and edited by that
 * id alone (read leniently: an id that does not parse is just a group). "Edit timeline" reads the events back from the label boxes (the text
 * boxes of the size of an event: the first line is the date as typed, the rest the label), the title from the topmost title-sized box, the
 * place from the first point of the axis (the first stroke) and the length from the width of the strokes; it asks again, lays the timeline out
 * anew and replaces the group in one step. Copying a timeline gives its group a fresh id (`groupRenamer`), which drops the link on purpose:
 * the copy is a picture. A text box whose size was changed (the group was resized) cannot be read back and the edit is refused: nothing is
 * ever dropped silently. What is derived (tick labels, gap notes, positions of everything) is rebuilt; colours and moves of single items are not kept.
 */

export const TIMELINE_PREFIX = "nbt1";
export const TIMELINE_COLOURS = SUBJECT_COLORS.length;

export const TIMELINE_SIZES = ["compact", "standard", "wide"] as const;
export type TimelineSize = (typeof TIMELINE_SIZES)[number];
const SIZE_WIDTH: Record<TimelineSize, number> = { compact: 300, standard: 440, wide: Infinity };
/** Room kept between a new timeline and the page edge, pt. */
const MARGIN = 8;

export const clampColour = (v: number): number => Math.min(TIMELINE_COLOURS - 1, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));
export const timelineColour = (index: number): string => SUBJECT_COLORS[clampColour(index)]!.base;

export function timelineGroupId(colour: number, random: string = createId().replace(/-/g, "").slice(0, 8)): string {
	return `${TIMELINE_PREFIX}.${clampColour(colour)}.${random}`;
}

/** The colour (palette index) a group id carries, or null when the id is not a timeline's. */
export function parseTimelineGroup(group: string | undefined): { colour: number; random: string } | null {
	if (group === undefined) return null;
	const parts = group.split(".");
	if (parts.length !== 3 || parts[0] !== TIMELINE_PREFIX || !/^[0-7]$/.test(parts[1]!) || parts[2] === "") return null;
	return { colour: Number(parts[1]), random: parts[2]! };
}

/** The width of a timeline block of a size on a page `pageWidth` wide (the wide one fills the page less its margins); null when the page is too narrow. */
export function timelineWidth(size: TimelineSize, pageWidth: number): number | null {
	const room = pageWidth - 2 * MARGIN;
	const w = Math.min(SIZE_WIDTH[size], room);
	return w < blockWidth(MIN_AXIS) ? null : w;
}

/** The size nearest to a block width, for the dialog of an edit. */
export function nearestSize(width: number, pageWidth: number): TimelineSize {
	let best: TimelineSize = "standard";
	let gap = Infinity;
	for (const s of TIMELINE_SIZES) {
		const w = timelineWidth(s, pageWidth);
		if (w !== null && Math.abs(w - width) < gap) {
			gap = Math.abs(w - width);
			best = s;
		}
	}
	return best;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

// --- building ---

/** The strokes and text boxes of a layout, all of group `group`, the block's top-left corner at `origin`. */
export function buildTimeline(layout: TimelineLayout, group: string, origin: { x: number; y: number }, newId: () => string = createId): { strokes: Stroke[]; elements: TextElement[] } {
	const { x: ox, y: oy } = origin;
	const strokes: Stroke[] = layout.shapes.map((s) => {
		const points = s.type === "circle"
			? ellipsePoints([s.cx + ox, s.cy + oy], s.r, s.r)
			: polygonPoints(s.vertices.map((v) => [v[0] + ox, v[1] + oy] as const), s.closed);
		const stroke: Stroke = { id: newId(), tool: "shape", color: s.color, width: s.width, render: RENDER_FREEHAND, group, points };
		if (s.fill !== undefined) stroke.fill = s.fill;
		if (s.dash !== undefined) stroke.dash = s.dash;
		return stroke;
	});
	const elements: TextElement[] = layout.texts.map((t) => ({
		id: newId(), type: "text", x: r2(t.x + ox), y: r2(t.y + oy), width: t.width, text: t.text, fontSize: t.size, color: t.color, group,
	}));
	return { strokes, elements };
}

export interface TimelineChoice {
	title: string;
	/** Palette index of the colour of the dots and poles. */
	colour: number;
	/** "keep" in an edit: the axis keeps the length it has. */
	size: TimelineSize | "keep";
	events: readonly TimelineEvent[];
}

const layoutFor = (choice: Pick<TimelineChoice, "title" | "colour" | "events">, width: number, labels: TimelineLabels): TimelineLayout =>
	layoutTimeline(choice.events, { title: choice.title.trim(), colour: timelineColour(choice.colour), labels }, width);

/** The layout the dialog shows: the timeline exactly as it will be drawn. */
export function previewLayout(choice: TimelineChoice, pageWidth: number, labels: TimelineLabels, keepWidth?: number): TimelineLayout {
	const width = choice.size === "keep" ? keepWidth ?? blockWidth(MIN_AXIS * 2) : timelineWidth(choice.size, pageWidth) ?? blockWidth(MIN_AXIS);
	return layoutFor(choice, width, labels);
}

// --- finding things ---

export interface DetectedTimeline {
	group: string;
	colour: number;
	strokes: Stroke[];
	elements: PageElement[];
}

/** The timeline a selection is: every item belongs to one group whose id is a timeline's (null otherwise, e.g. other items selected too). */
export function timelineOfSelection(strokes: readonly Stroke[], elements: readonly PageElement[]): DetectedTimeline | null {
	const first = strokes[0]?.group ?? elements[0]?.group;
	const link = parseTimelineGroup(first);
	if (first === undefined || !link || strokes.length === 0) return null;
	if (strokes.some((s) => s.group !== first) || elements.some((e) => e.group !== first)) return null;
	return { group: first, colour: link.colour, strokes: [...strokes], elements: [...elements] };
}

/** What an edit starts from: the title, the events as lines of text, and where the timeline is. */
export interface TimelineDraft {
	title: string;
	/** One line per event, `date: label` (lines whose date is not understood any more are kept so the person sees them). */
	text: string;
	colour: number;
	/** The block width of the timeline now. */
	width: number;
	origin: { x: number; y: number };
}

/** Why a timeline cannot be read back (nothing is changed). */
export type ReadRefusal = "unreadable" | "gone";

export function readTimeline(tl: DetectedTimeline): TimelineDraft | ReadRefusal {
	// Review 0.30 (I9): the axis is found by its shape (the leftmost horizontal line), not by being first in the page order: "Bring to front"
	// on one member must not move where an edit puts the timeline.
	let first: Point | undefined;
	for (const s of tl.strokes) {
		const p = s.points[0];
		if (!p || s.fill !== undefined || s.points.length < 2 || s.points.some((q) => Math.abs(q[1] - p[1]) > 0.01) || s.points.every((q) => Math.abs(q[0] - p[0]) < 0.01)) continue;
		if (!first || Math.min(...s.points.map((q) => q[0])) < first[0]) first = [Math.min(...s.points.map((q) => q[0])), p[1], p[2]];
	}
	first ??= tl.strokes[0]?.points[0];
	if (!first) return "gone";
	let maxX = -Infinity;
	for (const s of tl.strokes) for (const [x] of s.points) if (x > maxX) maxX = x;
	const boxes: TextElement[] = [];
	for (const e of tl.elements) {
		if (e.type !== "text") return "unreadable";
		boxes.push(e);
	}
	const titles = boxes.filter((e) => e.fontSize === TITLE_SIZE);
	const events = boxes.filter((e) => e.fontSize === EVENT_SIZE);
	if (boxes.some((e) => e.fontSize !== TITLE_SIZE && e.fontSize !== EVENT_SIZE && e.fontSize !== TICK_SIZE) || titles.length > 1 || events.length === 0) return "unreadable";
	events.sort((a, b) => a.x - b.x || a.y - b.y);
	const lines = events.map((e) => {
		const parsed = eventFromText(e.text);
		if (parsed) return parsed.label === "" ? parsed.dateText : `${parsed.dateText}: ${parsed.label}`;
		// kept as typed, on one line, so the dialog can say which one is not understood
		return e.text.replace(/\s*\n\s*/g, ": ").trim();
	});
	const axisLength = r2(maxX - first[0]);
	return {
		title: titles[0] ? titles[0].text.replace(/\s+/g, " ").trim() : "",
		text: lines.join("\n"),
		colour: tl.colour,
		width: blockWidth(axisLength),
		origin: { x: r2(first[0] - PADX), y: r2(first[1]) },
	};
}

// --- inserting ---

export type TimelineRefusal =
	/** Nothing to draw: no event with a date. */
	| "noEvents"
	/** The timeline would leave the page (too tall or too wide for it). */
	| "edge"
	/** The new timeline would touch a redaction box (or the stored boxes cannot be read). */
	| "redacted"
	/** The members of the timeline are no longer all on the page, or some are out of view. */
	| "gone"
	/** The text boxes of the timeline were resized or are not all labels: it cannot be read back. */
	| "unreadable"
	/** A text box of the timeline is locked. */
	| "locked"
	/** A shape of the timeline belongs to a part of a drawing with states. */
	| "states"
	/** Review 0.30 (I6): the old or the new timeline lies, even in part, under a study tape (an answer would come out from under it). */
	| "tape"
	/** The dialog gives the very timeline that is there. */
	| "same";

export type TimelineInsertPlan = { ok: true; cmd: Command; strokes: Stroke[]; elements: TextElement[]; group: string } | { ok: false; reason: TimelineRefusal };

type PageBox = Pick<Page, "id" | "strokes" | "elements" | "width" | "height" | "infinite">;

const insidePage = (page: Pick<Page, "width" | "height" | "infinite">, x: number, y: number, w: number, h: number): boolean =>
	x >= -0.01 && y >= -0.01 && x + w <= page.width + 0.01 && (page.infinite === true || y + h <= page.height + 0.01);

/** "Timeline": the timeline of `choice` added to `page` as one group, in one step, centred on `target` (kept inside the page). */
export function planTimelineInsert(
	page: PageBox, choice: TimelineChoice, target: { x: number; y: number }, labels: TimelineLabels, guard?: RedactGuard, newId: () => string = createId,
): TimelineInsertPlan {
	if (choice.events.length === 0) return { ok: false, reason: "noEvents" };
	const width = timelineWidth(choice.size === "keep" ? "standard" : choice.size, page.width);
	if (width === null) return { ok: false, reason: "edge" };
	const layout = layoutFor(choice, width, labels);
	if (layout.width > page.width - 2 * MARGIN + 0.01) return { ok: false, reason: "edge" };
	const yMax = page.infinite === true ? Infinity : page.height - MARGIN - layout.height;
	if (yMax < MARGIN) return { ok: false, reason: "edge" };
	const origin = {
		x: r2(Math.max(MARGIN, Math.min(page.width - MARGIN - layout.width, target.x - layout.width / 2))),
		y: r2(Math.max(MARGIN, Math.min(yMax, target.y - layout.height / 2))),
	};
	const group = timelineGroupId(choice.colour, newId().replace(/-/g, "").slice(0, 8));
	const built = buildTimeline(layout, group, { x: origin.x, y: r2(origin.y) }, newId);
	if (guard && movesUnderRedaction(guard, { strokes: [], elements: [] }, built)) return { ok: false, reason: "redacted" };
	const e0 = page.elements?.length ?? 0;
	const cmd = new Batch("Insert timeline", [
		...built.strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i)),
		...built.elements.map((e, i) => new AddElement(page.id, e, e0 + i)),
	]);
	return { ok: true, cmd, strokes: built.strokes, elements: built.elements, group };
}

// --- editing ---

export type TimelineUpdatePlan = { ok: true; cmd: Command; strokes: Stroke[]; elements: TextElement[]; group: string } | { ok: false; reason: TimelineRefusal };

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.05;

/** Whether two sets of strokes and text boxes draw the same timeline (ids and group are ignored; coordinates to 0.05 pt). */
export function sameTimeline(oldStrokes: readonly Stroke[], oldElements: readonly PageElement[], strokes: readonly Stroke[], elements: readonly TextElement[]): boolean {
	if (oldStrokes.length !== strokes.length || oldElements.length !== elements.length) return false;
	const sameStroke = (a: Stroke, b: Stroke): boolean =>
		a.color === b.color && a.width === b.width && a.fill === b.fill && a.dash === b.dash && a.points.length === b.points.length
		&& a.points.every((p, i) => near(p[0], b.points[i]![0]) && near(p[1], b.points[i]![1]));
	const sameText = (a: PageElement, b: TextElement): boolean =>
		a.type === "text" && a.text === b.text && a.fontSize === b.fontSize && a.color === b.color && near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width);
	return oldStrokes.every((s, i) => sameStroke(s, strokes[i]!)) && oldElements.every((e, i) => sameText(e, elements[i]!));
}

/**
 * "Edit timeline": the timeline `tl` (selected, so also in view) is replaced by the one of `choice`, in the place it has now (its axis starts
 * where the old one started), as ONE step: the old shapes and text boxes out, the new ones in at the same z-order slot. `inView` is the ink of
 * the page that the person sees: every member of the group must be there, so a timeline partly hidden by a collapsed note is left alone.
 */
export function planTimelineUpdate(
	page: Page, tl: DetectedTimeline, choice: TimelineChoice, inView: readonly Stroke[], labels: TimelineLabels, guard?: RedactGuard, newId: () => string = createId,
): TimelineUpdatePlan {
	const elements = page.elements ?? [];
	const mine = (s: Stroke): boolean => s.group === tl.group;
	if (tl.strokes.length === 0 || tl.strokes.some((s) => !page.strokes.includes(s)) || tl.elements.some((e) => !elements.includes(e))) return { ok: false, reason: "gone" };
	if (page.strokes.filter(mine).length !== tl.strokes.length || inView.filter(mine).length !== tl.strokes.length) return { ok: false, reason: "gone" };
	// a locked box is never in a selection, so look at the whole group on the page before the count check
	if (elements.some((e) => e.group === tl.group && isLockedElement(e))) return { ok: false, reason: "locked" };
	if (elements.filter((e) => e.group === tl.group).length !== tl.elements.length) return { ok: false, reason: "gone" };
	const inPart = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) inPart.add(id);
	if (tl.strokes.some((s) => inPart.has(s.id)) || tl.elements.some((e) => inPart.has(e.id))) return { ok: false, reason: "states" };
	if (choice.events.length === 0) return { ok: false, reason: "noEvents" };
	const draft = readTimeline(tl);
	if (typeof draft === "string") return { ok: false, reason: draft };
	const width = choice.size === "keep" ? draft.width : timelineWidth(choice.size, page.width);
	if (width === null) return { ok: false, reason: "edge" };
	const layout = layoutFor(choice, width, labels);
	// A new size is placed where the old one was, moved sideways into the page when it would stick out; otherwise nothing moves.
	const x = choice.size === "keep" ? draft.origin.x : r2(Math.max(MARGIN, Math.min(page.width - MARGIN - layout.width, draft.origin.x)));
	const origin = { x, y: r2(draft.origin.y - layout.axisY) };
	if (!insidePage(page, origin.x, origin.y, layout.width, layout.height)) return { ok: false, reason: "edge" };
	// the colour is part of the group id; the rest of it stays
	const link = parseTimelineGroup(tl.group)!;
	const group = clampColour(choice.colour) === link.colour ? tl.group : timelineGroupId(choice.colour, link.random);
	const built = buildTimeline(layout, group, origin, newId);
	if (sameTimeline(tl.strokes, tl.elements, built.strokes, built.elements)) return { ok: false, reason: "same" };
	if (guard && movesUnderRedaction(guard, { strokes: tl.strokes, elements: tl.elements }, built)) return { ok: false, reason: "redacted" };
	// Review 0.30 (I6): as the flowchart tidy, refuse when anything old or new lies under a study tape (hidden or not: revealing is a view state)
	const tapes = elements.filter((e): e is TapeElement => e.type === "tape");
	if (tapes.length > 0 && (selectionHoldsCovered(tl.strokes, tl.elements, tapes) || selectionHoldsCovered(built.strokes, built.elements, tapes))) return { ok: false, reason: "tape" };
	return { ok: true, ...updateCommand(page, tl, built, group) };
}

/** `items` that are in `list`, in the order of `list`. */
const inOrder = <T>(items: readonly T[], list: readonly T[]): T[] => items.filter((i) => list.includes(i)).sort((a, b) => list.indexOf(a) - list.indexOf(b));

/**
 * Review 0.30 (I5): the step of an edit keeps the identity of what survives. A stroke or text box of the new timeline takes the id of an old one
 * and REPLACES it in its slot (ReplaceStroke / ReplaceElement); only the surplus is removed or added. The Undo and Redo redaction check
 * (`ink/redact-step.ts`) matches items by id: with fresh ids a label that moved would be one that disappears and another that appears, which it
 * does not count as a move, and an Undo could bring a label out from under a box drawn after the edit. Text boxes are matched by their exact
 * text first (the same event is the same label wherever it moved), then the rest by order among boxes of the same size; strokes by order.
 * The new timeline keeps the z-order slots of the old one (ink written over it stays over it).
 */
function updateCommand(page: Page, tl: DetectedTimeline, built: { strokes: Stroke[]; elements: TextElement[] }, group: string): { cmd: Command; strokes: Stroke[]; elements: TextElement[]; group: string } {
	const elements = page.elements ?? [];
	const oldStrokes = inOrder(tl.strokes, page.strokes);
	const oldElements = inOrder(tl.elements, elements);
	// strokes: by order
	const strokes: Stroke[] = built.strokes.map((s, i) => (oldStrokes[i] ? { ...s, id: oldStrokes[i]!.id } : s));
	const keptStrokes = Math.min(oldStrokes.length, strokes.length);
	// text boxes: exact text and size first, then what is left by order among the boxes of one size
	const twin = new Map<TextElement, PageElement>();
	const used = new Set<PageElement>();
	const pair = (accept: (o: PageElement, n: TextElement) => boolean): void => {
		for (const n of built.elements) {
			if (twin.has(n)) continue;
			const o = oldElements.find((e) => !used.has(e) && accept(e, n));
			if (o) {
				twin.set(n, o);
				used.add(o);
			}
		}
	};
	pair((o, n) => o.type === "text" && o.fontSize === n.fontSize && o.text === n.text);
	pair((o, n) => o.type === "text" && o.fontSize === n.fontSize);
	const texts: TextElement[] = built.elements.map((n) => (twin.has(n) ? { ...n, id: twin.get(n)!.id } : n));
	const cmds: Command[] = [];
	const sList = [...page.strokes];
	oldStrokes.slice(0, keptStrokes).forEach((o, i) => {
		cmds.push(new ReplaceStroke(page.id, o, [strokes[i]!], sList.indexOf(o)));
		sList[sList.indexOf(o)] = strokes[i]!;
	});
	// surplus old strokes out (last index first, so Undo puts each back in place)
	for (const o of oldStrokes.slice(keptStrokes).map((s) => ({ s, i: sList.indexOf(s) })).sort((a, b) => b.i - a.i)) {
		cmds.push(new ReplaceStroke(page.id, o.s, [], o.i));
		sList.splice(o.i, 1);
	}
	// surplus new strokes in, right after the last one that stayed
	const sAt = sList.indexOf(strokes[keptStrokes - 1]!) + 1;
	strokes.slice(keptStrokes).forEach((s, i) => cmds.push(new AddStroke(page.id, s, sAt + i)));
	const eList = [...elements];
	built.elements.forEach((n, i) => {
		const o = twin.get(n);
		if (!o) return;
		cmds.push(new ReplaceElement(page.id, o, texts[i]!));
		eList[eList.indexOf(o)] = texts[i]!;
	});
	for (const o of oldElements.filter((e) => !used.has(e))) {
		cmds.push(new RemoveElement(page.id, o));
		eList.splice(eList.indexOf(o), 1);
	}
	let eAt = Math.max(0, ...texts.filter((e, i) => twin.has(built.elements[i]!)).map((e) => eList.indexOf(e) + 1));
	if (eAt === 0) eAt = Math.max(0, Math.min(eList.length, ...oldElements.map((e) => elements.indexOf(e))));
	texts.forEach((e, i) => {
		if (!twin.has(built.elements[i]!)) cmds.push(new AddElement(page.id, e, eAt++));
	});
	return { cmd: new Batch("Update timeline", cmds), strokes, elements: texts, group };
}
