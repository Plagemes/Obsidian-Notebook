import { createId } from "../model/document";
import { freshLegend, MAX_MARKER_NUMBER, reconcileLegend, withEntry } from "../model/figure-legend";
import { collectFigures } from "../model/figures";
import { isLockedElement } from "../model/groups";
import { AddElement, AddStroke, Batch, ReplaceElement, type Command } from "../model/history";
import { RENDER_FREEHAND, type Page, type PageElement, type Stroke, type TextElement } from "../model/types";
import { elementBounds } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { boxesTouching, type RedactGuard } from "./redact";
import { ellipsePoints, linePoints } from "./shapes";
import { estimateMeasure, LINE_HEIGHT, type MeasureText } from "./text-layout";

/**
 * 0.30 (#247) Numbered markers on a figure (1, 2, 3) with a legend that lists them. Nothing is added to the document format: a marker is
 * ordinary content, one group of a vector circle (a shape stroke) and a text box holding its number; the legend is one group of a short
 * rule (a shape stroke) and a text box whose lines read `1. words` (the words are the person's, `model/figure-legend.ts`).
 *
 * THE LINK lives in the group ids, which are free text (at most 64 characters): `nbm1.<role>.<set>.<random>` where `role` is `m` (a
 * marker) or `l` (a legend) and `set` names the figure the markers belong to: the element id of a picture, or a fresh id for a region of
 * ink. Every marker is a group of its own, so one marker moves, is restyled or is deleted alone; the markers and the legend of one figure are
 * found together by their `set`. Copying them (paste, duplicate a page) gives every group a fresh id (`groupRenamer`), which drops the link on
 * purpose, like a copied chart: the copy is a picture that shows the same numbers and the same legend, and neither it nor the original can
 * change the other.
 *
 * NUMBERING is by placement order: a new marker takes the number after the highest one of its figure, so no earlier marker ever changes
 * number by itself (the numbers the person has already read, written about or referred to hold still) and one insert is one small step.
 * Deleting a marker leaves a gap; the explicit *Renumber markers* closes gaps (the markers keep their order, 1 2 4 becomes 1 2 3), drops the
 * legend lines of markers that are gone and adds an empty line for a marker without one, in ONE undo step. It is explicit on purpose: an
 * automatic renumber after a delete would change numbers while the person is still working on the figure, with no way to tell it from an edit.
 *
 * Text boxes are drawn under the ink, so the disc of a marker is a translucent tint (never a solid fill that would hide its number).
 */

export const MARKER_PREFIX = "nbm1";
export type MarkerRole = "m" | "l";

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

const SET_OK = /^[A-Za-z0-9_-]{1,40}$/;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const randomPart = (): string => createId().replace(/-/g, "").slice(0, 8);

/** The set of a figure that is a picture: its element id, when that can be written in a group id (null otherwise). */
export function setIdOfFigure(figureId: string): string | null {
	return SET_OK.test(figureId) ? figureId : null;
}

/** A fresh set id for a region of ink. */
export function newSetId(random: string = createId().replace(/-/g, "").slice(0, 12)): string {
	return `r${random}`;
}

export function markerGroupId(role: MarkerRole, set: string, random: string = randomPart()): string {
	return `${MARKER_PREFIX}.${role}.${set}.${random}`;
}

export interface MarkerGroup {
	role: MarkerRole;
	set: string;
}

/** What a group id says, or null when it is not one of ours (read leniently: an id that does not parse is just a group). */
export function parseMarkerGroup(group: string | undefined): MarkerGroup | null {
	if (group === undefined || !group.startsWith(`${MARKER_PREFIX}.`)) return null;
	const parts = group.split(".");
	if (parts.length !== 4 || parts[0] !== MARKER_PREFIX || (parts[1] !== "m" && parts[1] !== "l") || !SET_OK.test(parts[2]!) || parts[3] === "") return null;
	return { role: parts[1], set: parts[2]! };
}

// --- reading the page ---

export interface MarkerItem {
	set: string;
	group: string;
	number: number;
	circle: Stroke;
	text: TextElement;
	/** Centre and radius of the disc, pt. */
	cx: number;
	cy: number;
	r: number;
}

export interface LegendItem {
	set: string;
	group: string;
	text: TextElement;
	rule: Stroke | null;
}

/** The markers of one figure in the order of their numbers (then top to bottom, left to right), and its legend if it has one. */
export interface MarkerSet {
	set: string;
	markers: MarkerItem[];
	legend: LegendItem | null;
}

type Items = Pick<Page, "strokes" | "elements">;

/** The box of the points themselves (a ring's centre and radius, without the width of its line). */
function pointsBox(s: Stroke): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of s.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

const readingOrder =(a: { number: number; cy: number; cx: number }, b: { number: number; cy: number; cx: number }): number => a.number - b.number || a.cy - b.cy || a.cx - b.cx;

/**
 * Every set of markers on the page. A group counts only when it is whole: a marker is exactly one text box that holds a number and at
 * least one shape stroke (a circle whose eraser took half, or a number the person edited into words, is a stray group, not a marker); a
 * legend is exactly one text box. Cheap when the page has none: one pass over the groups.
 */
export function markerSets(page: Items): Map<string, MarkerSet> {
	const strokesBy = new Map<string, Stroke[]>();
	for (const s of page.strokes) {
		if (s.group === undefined || !s.group.startsWith(`${MARKER_PREFIX}.`) || s.tool !== "shape" || parseMarkerGroup(s.group) === null) continue;
		const list = strokesBy.get(s.group);
		if (list) list.push(s);
		else strokesBy.set(s.group, [s]);
	}
	const textsBy = new Map<string, TextElement[]>();
	for (const e of page.elements ?? []) {
		if (e.type !== "text" || e.group === undefined || !e.group.startsWith(`${MARKER_PREFIX}.`) || parseMarkerGroup(e.group) === null) continue;
		const list = textsBy.get(e.group);
		if (list) list.push(e);
		else textsBy.set(e.group, [e]);
	}
	const sets = new Map<string, MarkerSet>();
	const get = (set: string): MarkerSet => {
		let s = sets.get(set);
		if (!s) sets.set(set, (s = { set, markers: [], legend: null }));
		return s;
	};
	for (const [group, texts] of textsBy) {
		const info = parseMarkerGroup(group)!;
		if (texts.length !== 1) continue;
		const text = texts[0]!;
		const strokes = strokesBy.get(group) ?? [];
		if (info.role === "l") {
			const s = get(info.set);
			s.legend ??= { set: info.set, group, text, rule: strokes[0] ?? null };
			continue;
		}
		const circle = strokes[0];
		const m = /^\s*(\d{1,3})\s*$/.exec(text.text);
		if (!circle || !m || Number(m[1]) < 1 || circle.points.length < 3) continue;
		const b = pointsBox(circle);
		get(info.set).markers.push({
			set: info.set, group, number: Number(m[1]), circle, text,
			cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, r: Math.max(1, (b.maxX - b.minX) / 2),
		});
	}
	for (const s of sets.values()) s.markers.sort(readingOrder);
	// a legend with no marker left is still a set (the legend of a figure whose markers were all deleted)
	return sets;
}

/** The set a group id belongs to, if it is one of ours. */
const setOf = (group: string | undefined): string | null => parseMarkerGroup(group)?.set ?? null;

// --- what a selection is ---

export type MarkerTargetKind = "figure" | "region" | "set";

export interface MarkerTarget {
	kind: MarkerTargetKind;
	/** The set to add to (a new one for a figure or a region without markers yet). */
	set: string;
	/** The box of the figure (a picture's box, or the bounds of the selected ink); null for a set whose figure is gone. */
	box: Box | null;
}

const boxOf = (b: BBox): Box => ({ x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY });

const unionOf = (boxes: readonly BBox[]): BBox | null => {
	if (boxes.length === 0) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const b of boxes) {
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	return Number.isFinite(minX + minY + maxX + maxY) ? { minX, minY, maxX, maxY } : null;
};

/** Element kinds that are (part of) a drawing a marker can point at; a selection of notes, text boxes or checkboxes alone is not a figure. */
const DRAWN: ReadonlySet<PageElement["type"]> = new Set(["image", "excerpt", "graph", "equation", "box"]);

/**
 * Cheap kind of a selection (no scan of the page): `set` when it holds a marker or a legend, `figure` for exactly one picture, `region` for
 * ink or other drawn items, null for anything else (nothing, or text boxes and notes alone).
 */
export function selectionMarkerKind(sel: { strokes: readonly Stroke[]; elements: readonly PageElement[] }): MarkerTargetKind | null {
	if (sel.strokes.length + sel.elements.length === 0) return null;
	if (sel.strokes.some((s) => setOf(s.group) !== null) || sel.elements.some((e) => setOf(e.group) !== null)) return "set";
	if (sel.strokes.length === 0 && sel.elements.length === 1 && (sel.elements[0]!.type === "image" || sel.elements[0]!.type === "excerpt")) return "figure";
	return sel.strokes.length > 0 || sel.elements.some((e) => DRAWN.has(e.type)) ? "region" : null;
}

/** How far outside the box of a region a marker may have been dragged and still belong to the region's set, pt. */
const NEAR = 24;

/**
 * What a selection means for markers. Markers or a legend in it: their set (when it holds more than one set: null, ambiguous). One picture:
 * its set. Any other items: a region, which joins the set whose markers lie in it (the one with the most of them) or starts a new set.
 */
export function markerTarget(page: Page, sel: { strokes: readonly Stroke[]; elements: readonly PageElement[] }, measure: MeasureText = estimateMeasure, newId: () => string = newSetId): MarkerTarget | null {
	const kind = selectionMarkerKind(sel);
	if (kind === null) return null;
	const own = new Set<string>();
	for (const s of sel.strokes) {
		const set = setOf(s.group);
		if (set !== null) own.add(set);
	}
	for (const e of sel.elements) {
		const set = setOf(e.group);
		if (set !== null) own.add(set);
	}
	if (own.size > 1) return null;
	const loose = [
		...sel.strokes.filter((s) => setOf(s.group) === null).map(strokeBounds),
		...sel.elements.filter((e) => setOf(e.group) === null).map((e) => elementBounds(e, measure)),
	];
	const figures = collectFigures([page], [0]);
	if (own.size === 1) {
		const set = [...own][0]!;
		const picture = figures.find((f) => setIdOfFigure(f.elementId) === set);
		const box = picture ? { x: picture.x, y: picture.y, width: picture.width, height: picture.height } : loose.length > 0 ? boxOf(unionOf(loose)!) : null;
		return { kind: "set", set, box };
	}
	if (kind === "figure") {
		const el = sel.elements[0]!;
		const f = figures.find((x) => x.elementId === el.id);
		if (f) {
			const box = { x: f.x, y: f.y, width: f.width, height: f.height };
			const set = setIdOfFigure(f.elementId);
			if (set !== null) return { kind: "figure", set, box };
			return { kind: "region", set: nearSet(page, box) ?? newId(), box };
		}
	}
	const union = unionOf(loose);
	if (!union) return null;
	const box = boxOf(union);
	return { kind: "region", set: nearSet(page, box) ?? newId(), box };
}

/** The set whose markers lie most in (or just outside) `box`, if any lies in it at all. */
function nearSet(page: Items, box: Box): string | null {
	let best: string | null = null;
	let most = 0;
	for (const s of markerSets(page).values()) {
		const n = s.markers.filter((m) => m.cx >= box.x - NEAR && m.cx <= box.x + box.width + NEAR && m.cy >= box.y - NEAR && m.cy <= box.y + box.height + NEAR).length;
		if (n > most) {
			most = n;
			best = s.set;
		}
	}
	return best;
}

// --- building ---

/** Size of the disc of a marker on a figure of this box: a small share of the shorter side, kept readable and not too big. */
export function markerRadius(box: Box | null): number {
	if (!box) return 11;
	const side = Math.min(box.width, box.height);
	return round2(Math.min(17, Math.max(10, side * 0.055)));
}

/** The line weight of the ring of a marker. */
const RING_WIDTH = 1.6;
/** The width of the legend rule, pt, and its gap above the first entry. */
const RULE_WIDTH = 1;
const RULE_GAP = 4;
/** Room between a figure and its legend, pt. */
const LEGEND_GAP = 6;
/** Smallest and largest font size of a number in a marker. */
const numberSize = (r: number): number => round2(Math.max(8, r * 1.1));

/** The centred text box of a number in the disc at (`cx`, `cy`). */
function numberBox(n: number, cx: number, cy: number, fontSize: number, color: string, group: string, id: string, measure: MeasureText): TextElement {
	const label = String(n);
	const w = measure(label, fontSize);
	// The box is a little wider than the digits (a font that measures wider elsewhere never wraps a number); the digits start at x.
	return { id, type: "text", x: round2(cx - w / 2), y: round2(cy - (fontSize * LINE_HEIGHT) / 2), width: round2(Math.ceil(w * 1.3) + 4), text: label, fontSize, color, group };
}

function ring(cx: number, cy: number, r: number, color: string, group: string, id: string): Stroke {
	return { id, tool: "shape", color, width: RING_WIDTH, render: RENDER_FREEHAND, group, points: ellipsePoints([cx, cy], r, r), fill: color, fillTint: true };
}

export interface MarkerBuildOptions {
	color: string;
	/** Font size of the legend text. */
	fontSize: number;
	measure?: MeasureText;
	newId?: () => string;
	/** The random part of the group ids (tests). */
	random?: () => string;
	/** Where the centre of the new marker goes, when the person chose a spot. */
	at?: { x: number; y: number };
}

export type MarkerRefusal =
	/** The figure already has the largest number. */
	| "full"
	/** The new items would lie under a redaction box (or the boxes cannot be read). */
	| "redacted"
	/** The legend, or a marker that must change, is locked. */
	| "locked"
	/** The legend, or a marker that must change, belongs to a part of a drawing with states. */
	| "states"
	/** Nothing to change. */
	| "same"
	/** The set has no marker left (renumbering would empty its legend). */
	| "none"
	/** The target has no room (no spot on the page). */
	| "nowhere";

export interface MarkerAddPlan {
	ok: true;
	cmd: Command;
	number: number;
	group: string;
	strokes: Stroke[];
	elements: TextElement[];
	legendCreated: boolean;
}

export type MarkerPlan = MarkerAddPlan | { ok: false; reason: MarkerRefusal };

const inParts = (page: Pick<Page, "states">): Set<string> => {
	const out = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) out.add(id);
	return out;
};

function aroundMarkers(markers: readonly MarkerItem[]): Box | null {
	const u = unionOf(markers.map((m) => ({ minX: m.cx - m.r, minY: m.cy - m.r, maxX: m.cx + m.r, maxY: m.cy + m.r })));
	if (!u) return null;
	const r = markers[0]!.r;
	return { x: u.minX - 4, y: u.minY - 4, width: Math.max(u.maxX - u.minX, 0) + 8 + 9 * r, height: Math.max(u.maxY - u.minY, 0) + 8 + 6 * r };
}

/** Where the next marker of a figure goes: on a grid inside the box (row by row from its top-left corner), the first spot not on another marker of the set. */
export function nextSpot(box: Box | null, page: Pick<Page, "width" | "height" | "infinite">, taken: readonly { cx: number; cy: number }[], r: number): { x: number; y: number } | null {
	const inset = 4;
	const pitch = 3 * r;
	const from: Box = box ?? { x: page.width / 2 - 2 * pitch, y: page.height / 2 - 2 * pitch, width: 4 * pitch, height: 4 * pitch };
	const cols = Math.max(1, Math.floor((from.width - 2 * inset - 2 * r) / pitch) + 1);
	for (let k = 0; k < 600; k++) {
		const x = from.x + inset + r + (k % cols) * pitch;
		const y = from.y + inset + r + Math.floor(k / cols) * pitch;
		if (x + r > page.width || (!page.infinite && y + r > page.height)) {
			// off the page: this row (or all of them) has no room; a wider row cannot help, a lower one cannot either
			if (y + r > page.height && !page.infinite) return null;
			continue;
		}
		if (taken.some((t) => Math.hypot(t.cx - x, t.cy - y) < 2.2 * r)) continue;
		return { x: round2(x), y: round2(y) };
	}
	return null;
}

/** Where a new legend goes: under the figure (a caption under it is stepped over), as wide as the figure, else above it. */
export function legendSpot(box: Box | null, page: Pick<Page, "width" | "height" | "infinite">, fontSize: number, lines: number, captioned: boolean, at: { x: number; y: number }): { x: number; y: number; width: number } {
	const lh = fontSize * LINE_HEIGHT;
	const width = Math.max(110, Math.min(box?.width ?? 180, page.width - 16));
	const baseX = box?.x ?? at.x - width / 2;
	const x = Math.max(0, Math.min(baseX, page.width - width));
	const need = RULE_GAP + lines * lh + 4;
	if (!box) return { x: round2(x), y: round2(Math.max(0, Math.min(page.infinite ? Infinity : page.height - need, at.y))), width: round2(width) };
	const below = box.y + box.height + LEGEND_GAP + (captioned ? lh + 4 : 0);
	const y = page.infinite || below + need <= page.height ? below : Math.max(0, box.y - LEGEND_GAP - need);
	return { x: round2(x), y: round2(y), width: round2(width) };
}

/** Whether a caption box (`{{figcap:<id>}}`) of the figure exists on the page (the legend then goes under it). */
function captionedFigure(page: Items, set: string): boolean {
	return (page.elements ?? []).some((e) => e.type === "text" && e.text.includes(`{{figcap:${set}}}`));
}

const redacts = (guard: RedactGuard | undefined, strokes: readonly Stroke[], elements: readonly PageElement[]): boolean =>
	!!guard && (guard.unreadable === true || (guard.boxes.length > 0 && boxesTouching({ strokes, elements }, guard.boxes).length > 0));

/**
 * "Add marker": the next numbered marker of the figure (a circle and its number, one group) and its line in the legend, ONE step. The legend
 * is created under the figure when the figure has none yet (with a line for every marker it has, so a legend deleted by hand comes back whole),
 * else the line is added to it in place and the words already typed stay as they are. Refused when the new items would lie under a redaction
 * box, when the legend is locked or part of a drawing with states, or when the figure already has the largest number.
 */
export function planAddMarker(page: Page, target: MarkerTarget, opts: MarkerBuildOptions, guard?: RedactGuard): MarkerPlan {
	const newId = opts.newId ?? createId;
	const random = opts.random ?? randomPart;
	const measure = opts.measure ?? estimateMeasure;
	const existing = markerSets(page).get(target.set) ?? null;
	const markers = existing?.markers ?? [];
	const number = markers.reduce((m, x) => Math.max(m, x.number), 0) + 1;
	if (number > MAX_MARKER_NUMBER) return { ok: false, reason: "full" };
	// A figure that is gone (a set picked up through its markers alone): the markers' own neighbourhood, a little to the right and below.
	const box = target.box ?? aroundMarkers(markers);
	const r = markers.length > 0 ? markers[markers.length - 1]!.r : markerRadius(box);
	const color = markers.length > 0 ? markers[markers.length - 1]!.circle.color : opts.color;
	const spot = opts.at && finite(opts.at.x) && finite(opts.at.y) ? { x: opts.at.x, y: opts.at.y } : nextSpot(box, page, markers, r);
	if (!spot) return { ok: false, reason: "nowhere" };
	const cx = Math.max(r, Math.min(page.width - r, spot.x));
	const cy = Math.max(r, spot.y);
	const group = markerGroupId("m", target.set, random());
	const circle = ring(round2(cx), round2(cy), r, color, group, newId());
	const digits = numberBox(number, round2(cx), round2(cy), numberSize(r), color, group, newId(), measure);
	const strokes: Stroke[] = [circle];
	const elements: TextElement[] = [digits];
	const legend = existing?.legend ?? null;
	const commands: Command[] = [];
	let legendCreated = false;
	if (legend) {
		if (isLockedElement(legend.text)) return { ok: false, reason: "locked" };
		if (inParts(page).has(legend.text.id)) return { ok: false, reason: "states" };
		const text = withEntry(legend.text.text, number);
		if (text !== legend.text.text) commands.push(new ReplaceElement(page.id, legend.text, { ...legend.text, text }));
	} else {
		legendCreated = true;
		const numbers = [...markers.map((m) => m.number), number];
		const text = freshLegend(numbers);
		const fontSize = Math.max(10, opts.fontSize);
		const where = legendSpot(box, page, fontSize, numbers.length, captionedFigure(page, target.set), { x: cx, y: cy + r + LEGEND_GAP });
		const lgroup = markerGroupId("l", target.set, random());
		const rule: Stroke = { id: newId(), tool: "shape", color, width: RULE_WIDTH, render: RENDER_FREEHAND, group: lgroup, points: linePoints([where.x, where.y], [where.x + where.width, where.y]) };
		const box2: TextElement = { id: newId(), type: "text", x: where.x, y: round2(where.y + RULE_GAP), width: where.width, text, fontSize, color, group: lgroup };
		strokes.push(rule);
		elements.push(box2);
	}
	if (redacts(guard, strokes, elements)) return { ok: false, reason: "redacted" };
	const e0 = page.elements?.length ?? 0;
	commands.unshift(
		...strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i)),
		...elements.map((e, i) => new AddElement(page.id, e, e0 + i)),
	);
	return { ok: true, cmd: new Batch("Add marker", commands), number, group, strokes, elements, legendCreated };
}

// --- renumbering ---

export interface RenumberPlan {
	ok: true;
	cmd: Command;
	/** How many markers got another number, legend lines dropped (their marker was gone) and lines added (a marker had none). */
	changed: number;
	dropped: number;
	added: number;
}

/** The number each marker should have: 1, 2, 3, ... in the order they have now. */
export function renumbered(markers: readonly MarkerItem[]): { marker: MarkerItem; to: number }[] {
	return [...markers].sort(readingOrder).map((marker, i) => ({ marker, to: i + 1 }));
}

/**
 * "Renumber markers": the markers of the set numbered 1, 2, 3, ... in the order they have (a gap left by a deleted marker closes), the
 * legend following: each line keeps its words with its marker, a line whose marker is gone is dropped, a marker without a line gets an empty
 * one. ONE step. Refused when something that must change is locked or belongs to a part of a drawing with states, or when nothing changes.
 */
export function planRenumber(page: Page, set: MarkerSet, opts: { measure?: MeasureText } = {}): RenumberPlan | { ok: false; reason: MarkerRefusal } {
	const measure = opts.measure ?? estimateMeasure;
	if (set.markers.length === 0) return { ok: false, reason: "none" };
	const parts = inParts(page);
	const commands: Command[] = [];
	let changed = 0;
	const plan = renumbered(set.markers);
	for (const { marker, to } of plan) {
		if (to === marker.number) continue;
		if (isLockedElement(marker.text)) return { ok: false, reason: "locked" };
		if (parts.has(marker.text.id)) return { ok: false, reason: "states" };
		const fresh = numberBox(to, marker.cx, marker.cy, marker.text.fontSize, marker.text.color, marker.group, marker.text.id, measure);
		// the person's own font size, colour and any extra flags stay; only the number and its centring change
		commands.push(new ReplaceElement(page.id, marker.text, { ...marker.text, text: fresh.text, x: fresh.x, y: fresh.y, width: fresh.width }));
		changed++;
	}
	let dropped = 0;
	let added = 0;
	const legend = set.legend;
	if (legend) {
		const l = reconcileLegend(legend.text.text, plan.map((p) => ({ from: p.marker.number, to: p.to })));
		if (l.text !== legend.text.text) {
			if (isLockedElement(legend.text)) return { ok: false, reason: "locked" };
			if (parts.has(legend.text.id)) return { ok: false, reason: "states" };
			commands.push(new ReplaceElement(page.id, legend.text, { ...legend.text, text: l.text }));
		}
		dropped = l.dropped;
		added = l.added;
	}
	if (commands.length === 0) return { ok: false, reason: "same" };
	return { ok: true, cmd: new Batch("Renumber markers", commands), changed, dropped, added };
}

/** Whether a renumber would change anything (the action is offered more eagerly then). */
export function needsRenumber(page: Page, set: MarkerSet): boolean {
	return planRenumber(page, set).ok;
}
