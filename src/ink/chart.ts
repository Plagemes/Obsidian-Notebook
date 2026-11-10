import { chartDataFromCells, countNumbers, LABEL_SIZE, layoutChart, VALUE_SIZE, type ChartBox, type ChartData, type ChartKind, type ChartLayout } from "../math/chart-layout";
import { createId } from "../model/document";
import { isLockedElement } from "../model/groups";
import { AddElement, AddStroke, Batch, RemoveElement, removeStrokes, type Command } from "../model/history";
import { RENDER_FREEHAND, type Page, type PageElement, type Stroke, type TextElement } from "../model/types";
import { SUBJECT_COLORS } from "../ui/palette";
import { detectTable, tableBox, type DetectedTable } from "./table";
import { readCells } from "./table-data";
import { ellipsePoints, polygonPoints } from "./shapes";

/**
 * Charts from table data (0.29, roadmap #244). A chart is ordinary content, nothing is added to the document format: vector shape strokes
 * (the frame, grid lines, bars, wedges, lines, dots; bars and wedges are closed shapes with a fill) and text boxes (title, axis labels,
 * legend), all of one fresh group. The geometry is `math/chart-layout.ts`; this file turns it into strokes and text boxes and makes the
 * undoable steps.
 *
 * THE LINK TO THE TABLE lives in the group id, which is free text of at most 64 characters: `nbc1.<kind><colour><titled>.<source>.<random>`
 * where `source` is the group id of the table the chart was read from. A chart is recognised, updated from its table and told apart from other
 * groups by that id alone (read leniently: an id that does not parse is just a group). Copying a chart gives its group a fresh id
 * (`groupRenamer`), which drops the link on purpose: the copy is a picture. The title is the topmost text box of the chart, so an edited title
 * survives an update; the box is the bounding box of the shapes (the frame), so a moved or resized chart is updated where it is.
 */

export const CHART_PREFIX = "nbc1";
/** The id of the group of a chart has no table to read when the table's own id cannot be written here. */
const NO_SOURCE = "-";
const MAX_SOURCE = 46;
const KIND_CHAR: Record<ChartKind, string> = { bar: "b", line: "l", pie: "p" };

export const CHART_COLOURS = SUBJECT_COLORS.length;

export type ChartSize = "small" | "medium" | "large";
export const CHART_SIZES: Record<ChartSize, { w: number; h: number }> = { small: { w: 220, h: 150 }, medium: { w: 300, h: 200 }, large: { w: 400, h: 260 } };
/** Room kept between a chart and the page edge, and between a chart and its table, pt. */
const MARGIN = 8;
const GAP = 16;

/** What the group id of a chart says. */
export interface ChartLink {
	kind: ChartKind;
	/** Index in the palette of the colour of the first series or slice (0 to 7). */
	colour: number;
	/** The chart has a title (the topmost text box of the group). */
	titled: boolean;
	/** The group id of the table the chart reads, or null when it could not be written. */
	source: string | null;
}

export const clampColour = (v: number): number => Math.min(CHART_COLOURS - 1, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));

/** The series colours: the palette from `first` on, round the eight colours. */
export function chartColours(first: number): string[] {
	const f = clampColour(first);
	return Array.from({ length: CHART_COLOURS }, (_, i) => SUBJECT_COLORS[(f + i) % CHART_COLOURS]!.base);
}

export function chartGroupId(link: ChartLink, random: string = createId().replace(/-/g, "").slice(0, 8)): string {
	const src = link.source !== null && link.source !== "" && link.source.length <= MAX_SOURCE && !link.source.includes(".") ? link.source : NO_SOURCE;
	return `${CHART_PREFIX}.${KIND_CHAR[link.kind]}${clampColour(link.colour)}${link.titled ? "t" : "n"}.${src}.${random}`;
}

/** The link a group id carries, or null when the id is not a chart's. */
export function parseChartGroup(group: string | undefined): ChartLink | null {
	if (group === undefined) return null;
	const parts = group.split(".");
	if (parts.length !== 4 || parts[0] !== CHART_PREFIX) return null;
	const m = /^([blp])([0-7])([tn])$/.exec(parts[1]!);
	if (!m || parts[2] === "" || parts[3] === "") return null;
	const kind: ChartKind = m[1] === "b" ? "bar" : m[1] === "l" ? "line" : "pie";
	return { kind, colour: Number(m[2]), titled: m[3] === "t", source: parts[2] === NO_SOURCE ? null : parts[2]! };
}

// --- building ---

/** The strokes and text boxes of a layout, all of group `group`. */
export function buildChart(layout: ChartLayout, group: string, newId: () => string = createId): { strokes: Stroke[]; elements: TextElement[] } {
	const strokes: Stroke[] = layout.shapes.map((s) => {
		const points = s.type === "circle"
			? ellipsePoints([s.cx, s.cy], s.r, s.r)
			: polygonPoints(s.vertices, s.closed);
		const stroke: Stroke = { id: newId(), tool: "shape", color: s.color, width: s.width, render: RENDER_FREEHAND, group, points };
		if (s.fill !== undefined) stroke.fill = s.fill;
		if (s.opacity !== undefined) stroke.opacity = s.opacity;
		return stroke;
	});
	const elements: TextElement[] = layout.texts.map((t) => ({
		id: newId(), type: "text", x: t.x, y: t.y, width: t.width, text: t.text, fontSize: t.size, color: t.color, group,
	}));
	return { strokes, elements };
}

/** The chart of a choice, read from `data`, in `box`. */
export function layoutFor(link: Pick<ChartLink, "kind" | "colour">, data: ChartData, title: string, box: ChartBox, otherLabel?: string): ChartLayout {
	return layoutChart(link.kind, data, { title, colours: chartColours(link.colour), otherLabel }, box);
}

// --- finding things ---

/** The table among the strokes of a selection (strokes of other groups, and loose ink, are ignored); null unless there is exactly one. */
export function tableInSelection(strokes: readonly Stroke[]): DetectedTable | null {
	const byGroup = new Map<string, Stroke[]>();
	for (const s of strokes) {
		if (s.group === undefined || s.tool !== "shape") continue;
		const list = byGroup.get(s.group);
		if (list) list.push(s);
		else byGroup.set(s.group, [s]);
	}
	let found: DetectedTable | null = null;
	for (const list of byGroup.values()) {
		const t = detectTable(list);
		if (!t) continue;
		if (found) return null;
		found = t;
	}
	return found;
}

export interface DetectedChart {
	group: string;
	link: ChartLink;
	strokes: Stroke[];
	elements: PageElement[];
}

/** The chart a selection is: every item belongs to one group whose id is a chart's (null otherwise, e.g. other items selected too). */
export function chartOfSelection(strokes: readonly Stroke[], elements: readonly PageElement[]): DetectedChart | null {
	const first = strokes[0]?.group ?? elements[0]?.group;
	const link = parseChartGroup(first);
	if (first === undefined || !link || strokes.length === 0) return null;
	if (strokes.some((s) => s.group !== first) || elements.some((e) => e.group !== first)) return null;
	return { group: first, link, strokes: [...strokes], elements: [...elements] };
}

/** The table with group id `group` on any of `pages` (the first page that has one), with the text it holds. */
export function findSourceTable(pages: readonly Pick<Page, "strokes" | "elements">[], group: string): { table: DetectedTable; cells: string[][] } | null {
	for (const page of pages) {
		const lines = page.strokes.filter((s) => s.group === group);
		if (lines.length === 0) continue;
		const table = detectTable(lines);
		if (table) return { table, cells: readCells(table.grid, page.elements ?? []) };
	}
	return null;
}

/** A coordinate on the 0.01 pt grid the points are stored on: a box rounded so, laid out again, gives the very same points (an unchanged chart is "same"). */
const r2 = (v: number): number => Math.round(v * 100) / 100;

const pointsBox = (strokes: readonly Stroke[]): ChartBox | null => {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const s of strokes) for (const [x, y] of s.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return minX <= maxX ? { x: r2(minX), y: r2(minY), width: r2(maxX - minX), height: r2(maxY - minY) } : null;
};

/**
 * The text of the topmost (then leftmost) text box: a chart's title. Boxes in the size of an axis, value or legend label are never the
 * title, so a deleted title box leaves the chart untitled instead of promoting a label.
 */
function titleOf(elements: readonly PageElement[]): string {
	let best: TextElement | null = null;
	for (const e of elements) {
		if (e.type !== "text" || e.fontSize === LABEL_SIZE || e.fontSize === VALUE_SIZE) continue;
		if (!best || e.y < best.y || (e.y === best.y && e.x < best.x)) best = e;
	}
	return best ? best.text.replace(/\s+/g, " ").trim() : "";
}

// --- inserting ---

/** The size of a new chart on a page `pageWidth` wide (never wider than the page less its margins). */
export function chartSize(size: ChartSize, pageWidth: number): { width: number; height: number } {
	const s = CHART_SIZES[size];
	const width = Math.max(120, Math.min(s.w, pageWidth - 2 * MARGIN));
	return { width, height: Math.round((width * s.h) / s.w) };
}

/**
 * Where a new chart goes: below its table when there is room, else to the right, else above it, else centred on `target` (over the table,
 * kept inside the page). `page.infinite` pages have no bottom.
 */
export function placeChart(
	table: ChartBox, size: { width: number; height: number }, page: { width: number; height: number; infinite?: boolean }, target: { x: number; y: number },
): ChartBox {
	const { width: w, height: h } = size;
	const fitsX = (x: number): boolean => x >= MARGIN && x + w <= page.width - MARGIN;
	const fitsY = (y: number): boolean => y >= MARGIN && (page.infinite === true || y + h <= page.height - MARGIN);
	const clampX = (x: number): number => Math.max(MARGIN, Math.min(page.width - MARGIN - w, x));
	const below = { x: clampX(table.x), y: table.y + table.height + GAP };
	if (fitsY(below.y)) return { ...below, width: w, height: h };
	const right = { x: table.x + table.width + GAP, y: table.y };
	if (fitsX(right.x) && fitsY(right.y)) return { ...right, width: w, height: h };
	const above = { x: clampX(table.x), y: table.y - GAP - h };
	if (fitsY(above.y)) return { ...above, width: w, height: h };
	const yMax = page.infinite ? Infinity : page.height - MARGIN - h;
	return { x: clampX(target.x - w / 2), y: Math.max(MARGIN, Math.min(yMax, target.y - h / 2)), width: w, height: h };
}

export interface ChartChoice {
	kind: ChartKind;
	title: string;
	/** Palette index of the first colour. */
	colour: number;
	size: ChartSize;
}

export type ChartInsertPlan = { ok: true; cmd: Command; strokes: Stroke[]; elements: TextElement[]; group: string } | { ok: false; reason: "noData" };

/** "Insert chart": the chart of `data` for `table` added to `page` as one group, in one step. Refused when there is nothing to show. */
export function planChartInsert(
	page: Pick<Page, "id" | "strokes" | "elements" | "width" | "height" | "infinite">, table: DetectedTable, data: ChartData, choice: ChartChoice,
	target: { x: number; y: number }, otherLabel?: string, newId: () => string = createId,
): ChartInsertPlan {
	if (countNumbers(data, choice.kind) === 0) return { ok: false, reason: "noData" };
	const t = tableBox(table.grid);
	const placed = placeChart({ x: t.minX, y: t.minY, width: t.maxX - t.minX, height: t.maxY - t.minY }, chartSize(choice.size, page.width), page, target);
	const box: ChartBox = { x: r2(placed.x), y: r2(placed.y), width: r2(placed.width), height: r2(placed.height) };
	const title = choice.title.trim();
	const link: ChartLink = { kind: choice.kind, colour: choice.colour, titled: title !== "", source: table.strokes[0]?.group ?? null };
	const group = chartGroupId(link, newId().replace(/-/g, "").slice(0, 8));
	const built = buildChart(layoutFor(link, data, title, box, otherLabel), group, newId);
	const e0 = page.elements?.length ?? 0;
	const cmd = new Batch("Insert chart", [
		...built.strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i)),
		...built.elements.map((e, i) => new AddElement(page.id, e, e0 + i)),
	]);
	return { ok: true, cmd, strokes: built.strokes, elements: built.elements, group };
}

// --- updating ---

/** Why a chart is not updated (nothing is changed in any of these cases). */
export type ChartRefusal =
	/** The members of the chart are no longer all on the page, or some are out of view (a stale selection, a collapsed note). */
	| "gone"
	/** The chart has no table to read: it was copied, or the table's group id could not be written into its own. */
	| "noLink"
	/** The table the chart was made from is not in the notebook (deleted, or no longer a whole grid). */
	| "noSource"
	/** The table holds no number the chart can show. */
	| "noData"
	/** A text box of the chart is locked. */
	| "locked"
	/** A shape of the chart belongs to a part of a drawing with states. */
	| "states"
	/** The table gives the very chart that is there. */
	| "same";

export type ChartUpdatePlan = { ok: true; cmd: Command; strokes: Stroke[]; elements: TextElement[] } | { ok: false; reason: ChartRefusal };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether two sets of strokes and text boxes draw the same chart (ids are ignored). */
export function sameChart(oldStrokes: readonly Stroke[], oldElements: readonly PageElement[], strokes: readonly Stroke[], elements: readonly TextElement[]): boolean {
	if (oldStrokes.length !== strokes.length || oldElements.length !== elements.length) return false;
	const norm = (s: Stroke): unknown => ({ c: s.color, w: s.width, f: s.fill, o: s.opacity, p: s.points });
	const normE = (e: PageElement): unknown => (e.type === "text" ? { x: e.x, y: e.y, w: e.width, t: e.text, s: e.fontSize, c: e.color } : e.type);
	return oldStrokes.every((s, i) => same(norm(s), norm(strokes[i]!))) && oldElements.every((e, i) => same(normE(e), normE(elements[i]!)));
}

/**
 * "Update chart": the chart `chart` (selected, so also in view) is read again from its source table and replaced by the new one in the same
 * place, as ONE step (the old shapes and text boxes out, the new ones in, the same group id, fresh item ids). `pages` are all the pages of the
 * notebook (the table can be on another page than the chart) and `inView` the ink of the chart's page that the person sees: every member of
 * the group must be there, so a chart partly hidden by a collapsed note is left alone.
 */
export function planChartUpdate(
	pages: readonly Page[], page: Page, chart: DetectedChart, inView: readonly Stroke[], otherLabel?: string, newId: () => string = createId,
): ChartUpdatePlan {
	const elements = page.elements ?? [];
	const mine = (s: Stroke): boolean => s.group === chart.group;
	if (chart.strokes.length === 0 || chart.strokes.some((s) => !page.strokes.includes(s)) || chart.elements.some((e) => !elements.includes(e))) return { ok: false, reason: "gone" };
	if (page.strokes.filter(mine).length !== chart.strokes.length || inView.filter(mine).length !== chart.strokes.length) return { ok: false, reason: "gone" };
	// a locked box is never in a selection, so look at the whole group on the page before the count check
	if (elements.some((e) => e.group === chart.group && isLockedElement(e))) return { ok: false, reason: "locked" };
	if (elements.filter((e) => e.group === chart.group).length !== chart.elements.length) return { ok: false, reason: "gone" };
	const inPart = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) inPart.add(id);
	if (chart.strokes.some((s) => inPart.has(s.id)) || chart.elements.some((e) => inPart.has(e.id))) return { ok: false, reason: "states" };
	if (chart.link.source === null) return { ok: false, reason: "noLink" };
	const source = findSourceTable(pages, chart.link.source);
	if (!source) return { ok: false, reason: "noSource" };
	const data = chartDataFromCells(source.cells);
	if (countNumbers(data, chart.link.kind) === 0) return { ok: false, reason: "noData" };
	const box = pointsBox(chart.strokes);
	if (!box) return { ok: false, reason: "gone" };
	const title = chart.link.titled ? titleOf(chart.elements) : "";
	const built = buildChart(layoutFor(chart.link, data, title, box, otherLabel), chart.group, newId);
	if (sameChart(chart.strokes, chart.elements, built.strokes, built.elements)) return { ok: false, reason: "same" };
	const removedStrokes = removeStrokes(page.id, page.strokes, chart.strokes, "Update chart");
	if (!removedStrokes) return { ok: false, reason: "gone" };
	// the new chart takes the z-order slot of the old one (ink written over it stays over it)
	const sBase = Math.max(0, Math.min(...chart.strokes.map((s) => page.strokes.indexOf(s))));
	const eBase = chart.elements.length === 0 ? elements.length : Math.max(0, Math.min(...chart.elements.map((e) => elements.indexOf(e))));
	const cmd = new Batch("Update chart", [
		removedStrokes,
		...chart.elements.map((e) => new RemoveElement(page.id, e)),
		...built.strokes.map((s, i) => new AddStroke(page.id, s, sBase + i)),
		...built.elements.map((e, i) => new AddElement(page.id, e, eBase + i)),
	]);
	return { ok: true, cmd, strokes: built.strokes, elements: built.elements };
}
