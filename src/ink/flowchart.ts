import { Batch, ReplaceStroke, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import { RENDER_FREEHAND, type Page, type PageElement, type Point, type Stroke, type TapeElement } from "../model/types";
import { arrowEnds } from "../zettel/arrows";
import { elementBounds, type MeasureText } from "./elements";
import {
	boxArea, connectorBetween, distanceToShape, insideShape, layoutBoxes, type LayoutBox, type NodeShape,
} from "./flowchart-layout";
import { pointSegmentDistance, strokeBounds, type BBox } from "./hit-test";
import { recognizeShape, type RecognizedShape } from "./recognize";
import { movesUnderRedaction, type RedactGuard } from "./redact";
import { applyPlacement, emptyPlacement } from "./selection-transform";
import { arrowPoints, linePoints } from "./shapes";
import { boxTouchesTapes, strokeTouchesTapes } from "./tape-guard";
import { estimateMeasure } from "./text-layout";
import { translate } from "./transform";

/**
 * Hand-drawn flowcharts that tidy themselves (0.30, roadmap #245). Pure, no 'obsidian'. The explicit action "Tidy flowchart" on a selection:
 *
 * 1. Recognise. Closed strokes become boxes (rectangle, diamond, ellipse: the recogniser of "hold to snap" for rectangles and ellipses, a
 *    stricter diamond fit of its own); an open stroke that is an arrow (one stroke, or a line plus a small head drawn next to its end) or a
 *    line and that starts and ends on two different boxes becomes a connector. Whatever else lies inside a box (handwriting, text boxes,
 *    equations) is its label and moves with it. Everything else in the selection stays where it is.
 * 2. Lay out (`flowchart-layout.ts`): boxes are centred in columns and rows, the gaps are evened out and the first box lands on the grid.
 *    The boxes only move: their strokes keep their points, pressure and style.
 * 3. Connect: every connector is drawn again, straight, from outline to outline (a line that was an arrow keeps its head; the stroke keeps
 *    its colour, width and group and becomes a shape stroke). A connector the layout did not disturb and that is already clean stays.
 *
 * ONE undo step (a `Batch` of the commands that already exist: `ReplaceStroke`, `ReplaceElement`). It is refused, and nothing changes, when the
 * moved ink would touch a redaction box before or after (fail closed), when it would touch a study tape, when it would leave the page, or
 * when the picture is not a grid of boxes. Nothing is added to the document format.
 */

export const FLOWCHART_LABEL = "Tidy flowchart";

/** Smallest box: shorter side and longer side, pt. Smaller closed shapes are letters, bullets and dots. */
const MIN_SIDE = 20;
const MIN_LONG = 36;
/** How near (pt) an arrow's end must be to a box to be attached to it, at least; grows with the box. */
const ATTACH_MIN = 10;
const ATTACH_SHARE = 0.1;
const ATTACH_MAX = 20;
/** A chart in which no box would move by this much (pt) is tidy already: the recogniser's fit of a clean shape is only that exact, and a tidy chart must read as tidy. */
const MOVE_EPSILON = 1.5;
/** Connector ends closer than this (pt) to where they should be are left as drawn. */
const END_TOLERANCE = 1.5;
/** Most a head stroke may measure, pt, and how near its apex must be to a line's end. */
const HEAD_MAX = 45;
const HEAD_REACH = 7;
/**
 * A head is only read when it is clearly one (it is deleted when it is): at most this share of the line's length, wings 8..75 deg off the
 * line and within 30 deg of each other, the apex not deeper than HEAD_DEEP inside a box, and no other writing within HEAD_NEIGHBOUR pt.
 */
const HEAD_LINE_SHARE = 0.45;
const HEAD_MIN_LINE = 24;
const HEAD_ANGLE_MIN = 8;
const HEAD_ANGLE_MAX = 75;
const HEAD_ANGLE_SKEW = 30;
const HEAD_DEEP = 4;
const HEAD_NEIGHBOUR = 3;
/** A box nested in another one is a label (a bullet, a ring around a digit) when it covers less than this share of it. */
const LABEL_SHARE = 0.25;
/** Items may stick out of the page by this much (pt) before the tidy-up is refused. */
const EDGE_TOL = 6;
/** Ink that was on the page may end up this far (pt) off it: the reach of its own line after the boxes snap to the grid. */
const EDGE_SLACK = 2;
/** Wing length of a redrawn head when it cannot be read from the old one, and its limits. */
const WING_DEFAULT = 12;
const WING_MIN = 6;
const WING_MAX = 22;
/** Writing within this distance (pt) of a connector, and not inside a box, is the connector's label. */
const EDGE_LABEL_REACH = 22;
/** Distance between the connectors that join the same two boxes, pt. */
const PARALLEL = 12;

type V = [number, number];
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

// ---------------------------------------------------------------- recognition of single strokes

function pathLength(p: readonly V[]): number {
	let l = 0;
	for (let i = 1; i < p.length; i++) l += dist(p[i - 1]!, p[i]!);
	return l;
}

/** `n` points equally spaced along the path. */
function resample(p: readonly V[], n: number): V[] {
	const total = pathLength(p);
	if (p.length < 2 || total === 0) return Array.from({ length: n }, () => [...(p[0] ?? [0, 0])] as V);
	const step = total / (n - 1);
	const out: V[] = [[...p[0]!] as V];
	let acc = 0;
	let next = step;
	for (let i = 1; i < p.length && out.length < n - 1; i++) {
		const a = p[i - 1]!, b = p[i]!;
		const seg = dist(a, b);
		while (seg > 0 && acc + seg >= next && out.length < n - 1) {
			const t = (next - acc) / seg;
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			next += step;
		}
		acc += seg;
	}
	out.push([...p[p.length - 1]!] as V);
	return out;
}

const bboxOf = (pts: ReadonlyArray<readonly number[]>): BBox => {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		minX = Math.min(minX, p[0]!); minY = Math.min(minY, p[1]!); maxX = Math.max(maxX, p[0]!); maxY = Math.max(maxY, p[1]!);
	}
	return { minX, minY, maxX, maxY };
};

/** Area of the polygon (shoelace). */
function polygonArea(p: ReadonlyArray<readonly number[]>): number {
	let s = 0;
	for (let i = 0; i < p.length; i++) {
		const a = p[i]!, b = p[(i + 1) % p.length]!;
		s += a[0]! * b[1]! - b[0]! * a[1]!;
	}
	return Math.abs(s) / 2;
}

/**
 * A closed stroke that follows the outline of a diamond (the four points of the box's sides joined by straight lines). Stricter than the
 * recogniser's tests: a circle must not pass. Returns the box, or null.
 */
function fitDiamond(points: readonly Point[]): BBox | null {
	const raw: V[] = [];
	for (const [x, y] of points) {
		const last = raw[raw.length - 1];
		if (!last || Math.hypot(x - last[0], y - last[1]) > 0.01) raw.push([x, y]);
	}
	if (raw.length < 8) return null;
	const length = pathLength(raw);
	if (length < 60) return null;
	if (dist(raw[0]!, raw[raw.length - 1]!) / length > 0.15) return null;
	const pts = resample([...raw, raw[0]!], 65).slice(0, 64);
	const b = bboxOf(pts);
	const w = b.maxX - b.minX, h = b.maxY - b.minY;
	const short = Math.min(w, h);
	if (short < MIN_SIDE) return null;
	const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
	const verts: V[] = [[cx, b.minY], [b.maxX, cy], [cx, b.maxY], [b.minX, cy]];
	const toOutline = (q: V): number => {
		let best = Infinity;
		for (let i = 0; i < 4; i++) {
			const a = verts[i]!, c = verts[(i + 1) % 4]!;
			best = Math.min(best, pointSegmentDistance(q[0], q[1], a[0], a[1], c[0], c[1]));
		}
		return best;
	};
	const d = pts.map(toOutline);
	const rms = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length);
	if (rms / short > 0.045 || Math.max(...d) / short > 0.13) return null;
	// Every corner, and the middle of every side, has stroke near it: no side is missing.
	const anchors: V[] = [...verts];
	for (let i = 0; i < 4; i++) anchors.push([(verts[i]![0] + verts[(i + 1) % 4]![0]) / 2, (verts[i]![1] + verts[(i + 1) % 4]![1]) / 2]);
	for (const [k, a] of anchors.entries()) {
		const near = Math.min(...pts.map((q) => dist(q, a)));
		if (near / short > (k < 4 ? 0.2 : 0.1)) return null;
	}
	return b;
}

interface BoxFit {
	shape: NodeShape;
	box: BBox;
}

/** The box a stroke draws (`rec`: what the shape recogniser made of it), or null when it is not clearly one. */
function boxOf(stroke: Stroke, rec: RecognizedShape | null): BoxFit | null {
	if (rec?.kind === "rectangle" || rec?.kind === "ellipse") {
		const poly = rec.points[0]!;
		const box = bboxOf(poly);
		if (rec.kind === "ellipse") return sized({ shape: "ellipse", box });
		const ratio = polygonArea(poly) / Math.max(1e-6, boxArea(box));
		if (ratio >= 0.72) return sized({ shape: "rectangle", box });
		if (ratio >= 0.42 && ratio <= 0.6) return sized({ shape: "diamond", box });
		return null;
	}
	if (rec === null) {
		const box = fitDiamond(stroke.points);
		return box ? sized({ shape: "diamond", box }) : null;
	}
	return null;
}

function sized(fit: BoxFit): BoxFit | null {
	const w = fit.box.maxX - fit.box.minX, h = fit.box.maxY - fit.box.minY;
	return Math.min(w, h) >= MIN_SIDE && Math.max(w, h) >= MIN_LONG ? fit : null;
}

interface Link {
	from: V;
	to: V;
	arrow: boolean;
	/** Wing length of the head, pt. */
	wing: number;
}

/** The connector a stroke draws (an arrow in one stroke, or a plain line), or null. */
function linkOf(stroke: Stroke, rec: RecognizedShape | null): Link | null {
	const pts = stroke.points;
	if (stroke.tool === "shape") {
		const ends = arrowEnds(pts);
		if (ends) return { from: ends.tail, to: ends.tip, arrow: true, wing: wingOf(pts, ends.tail, ends.tip) };
	}
	const line = rec?.points[0];
	if (!rec || !line || line.length < 2) return null;
	if (rec.kind === "line") return { from: [line[0]![0], line[0]![1]], to: [line[line.length - 1]![0], line[line.length - 1]![1]], arrow: false, wing: WING_DEFAULT };
	if (rec.kind === "arrow") {
		const ends = arrowEnds(line);
		return ends ? { from: ends.tail, to: ends.tip, arrow: true, wing: wingOf(line, ends.tail, ends.tip) } : null;
	}
	return null;
}

/** Length of the wings of an arrow polyline (tail → tip → wing → tip → wing), pt. */
function wingOf(points: readonly Point[], tail: V, tip: V): number {
	let tipIndex = 0;
	let best = -1;
	points.forEach((p, i) => {
		const d = Math.hypot(p[0] - tail[0], p[1] - tail[1]);
		if (d > best) { best = d; tipIndex = i; }
	});
	let wing = 0;
	for (let i = tipIndex + 1; i < points.length; i++) wing = Math.max(wing, Math.hypot(points[i]![0] - tip[0], points[i]![1] - tip[1]));
	return Math.min(WING_MAX, Math.max(WING_MIN, wing || WING_DEFAULT));
}

/** A small "V" stroke: its apex and the middle of its wing ends, or null. */
function headOf(stroke: Stroke): { apex: V; back: V; wing: number; ends: [V, V] } | null {
	const raw: V[] = stroke.points.map((p) => [p[0], p[1]]);
	if (raw.length < 3) return null;
	const length = pathLength(raw);
	const b = bboxOf(raw);
	if (length < 8 || Math.hypot(b.maxX - b.minX, b.maxY - b.minY) > HEAD_MAX) return null;
	const p0 = raw[0]!, pn = raw[raw.length - 1]!;
	const chord = dist(p0, pn);
	if (chord < 3) return null;
	let apexAt = 0;
	let far = -1;
	raw.forEach((q, i) => {
		const d = pointSegmentDistance(q[0], q[1], p0[0], p0[1], pn[0], pn[1]);
		if (d > far) { far = d; apexAt = i; }
	});
	const apex = raw[apexAt]!;
	const w1 = dist(p0, apex), w2 = dist(pn, apex);
	if (apexAt === 0 || apexAt === raw.length - 1 || w1 < 5 || w2 < 5 || w1 / w2 > 2 || w2 / w1 > 2) return null;
	const tol = 0.18 * Math.min(w1, w2) + 0.8;
	for (let i = 1; i < apexAt; i++) if (pointSegmentDistance(raw[i]![0], raw[i]![1], p0[0], p0[1], apex[0], apex[1]) > tol) return null;
	for (let i = apexAt + 1; i < raw.length - 1; i++) if (pointSegmentDistance(raw[i]![0], raw[i]![1], apex[0], apex[1], pn[0], pn[1]) > tol) return null;
	const a1 = Math.atan2(p0[1] - apex[1], p0[0] - apex[0]), a2 = Math.atan2(pn[1] - apex[1], pn[0] - apex[0]);
	const between = Math.abs(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2)));
	if (between < (15 * Math.PI) / 180 || between > (130 * Math.PI) / 180) return null;
	return { apex, back: [(p0[0] + pn[0]) / 2, (p0[1] + pn[1]) / 2], wing: Math.min(WING_MAX, Math.max(WING_MIN, (w1 + w2) / 2)), ends: [p0, pn] };
}

/**
 * Is this small "V" confidently the head of the line that ends at `end` (the line runs from `end` towards `other`)? A handwritten "V", "L",
 * "<" or ">" has the same shape, and a head that is taken is DELETED, so only a clearly symmetric, clearly small one counts: the wings lie on
 * either side of the line, at much the same angle to it and of much the same length, and the head is small against the line.
 */
function headFitsLine(head: NonNullable<ReturnType<typeof headOf>>, end: readonly number[], other: readonly number[]): boolean {
	const len = dist(end, other);
	if (len < HEAD_MIN_LINE || Math.max(dist(head.apex, head.ends[0]), dist(head.apex, head.ends[1])) > HEAD_LINE_SHARE * len) return false;
	const ux = (other[0]! - end[0]!) / len, uy = (other[1]! - end[1]!) / len;
	const side: number[] = [];
	const angle: number[] = [];
	for (const w of head.ends) {
		const wx = w[0] - head.apex[0], wy = w[1] - head.apex[1], wl = Math.hypot(wx, wy);
		if (wl < 1e-6) return false;
		side.push(ux * wy - uy * wx);
		angle.push(Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy) / wl))));
	}
	const [s1, s2] = side as [number, number];
	if (s1 * s2 >= 0) return false;
	const [a1, a2] = angle as [number, number];
	const lo = (HEAD_ANGLE_MIN * Math.PI) / 180, hi = (HEAD_ANGLE_MAX * Math.PI) / 180;
	if (a1 < lo || a1 > hi || a2 < lo || a2 > hi) return false;
	return Math.abs(a1 - a2) <= (HEAD_ANGLE_SKEW * Math.PI) / 180;
}

// ---------------------------------------------------------------- the picture

export interface FlowNode extends LayoutBox {
	stroke: Stroke;
	/** What moves with the box: its label strokes and text boxes. */
	strokes: Stroke[];
	elements: PageElement[];
}

export interface FlowEdge {
	stroke: Stroke;
	/** The small head strokes drawn next to a line: replaced by the head of the new arrow. */
	heads: Stroke[];
	from: number;
	to: number;
	arrow: boolean;
	wing: number;
	/** The ends as drawn. */
	drawn: Link;
	/** Writing and text boxes beside the connector (a "yes" or "no"): they follow it when it is drawn again. */
	strokes: Stroke[];
	elements: PageElement[];
}

export interface FlowModel {
	nodes: FlowNode[];
	edges: FlowEdge[];
}

export type FlowRefusal = "few" | "nested" | "ambiguous" | "none" | "redacted" | "tape" | "edge" | "gone";

/** What is a label of a box: the text-like elements whose boxes may follow it. */
const LABEL_ELEMENTS: ReadonlySet<PageElement["type"]> = new Set(["text", "equation"]);

const centreOf = (b: BBox): V => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/**
 * Reads the picture: the boxes, the connectors between them and the labels. Only what is passed in is read (the caller passes the selection,
 * visible ink only, without locked elements). A failure says why there is no flowchart.
 */
export function readFlowchart(strokes: readonly Stroke[], elements: readonly PageElement[], measure: MeasureText = estimateMeasure): FlowModel | "few" | "nested" {
	// 1. boxes
	const recs = new Map<Stroke, RecognizedShape | null>();
	for (const s of strokes) if (s.tool !== "highlighter") recs.set(s, recognizeShape(s.points));
	const boxStrokes = new Set<Stroke>();
	let nodes: FlowNode[] = [];
	for (const s of strokes) {
		if (s.tool === "highlighter") continue;
		const fit = boxOf(s, recs.get(s) ?? null);
		if (!fit) continue;
		nodes.push({ ...fit, stroke: s, strokes: [], elements: [] });
		boxStrokes.add(s);
	}
	// A small shape inside another is a label (a bullet, a ring), a big one is a second chart: not read.
	const labelShapes = new Set<FlowNode>();
	for (const inner of nodes) {
		const c = centreOf(inner.box);
		for (const outer of nodes) {
			if (outer === inner || !insideShape(outer.shape, outer.box, c[0], c[1])) continue;
			if (boxArea(inner.box) < LABEL_SHARE * boxArea(outer.box)) labelShapes.add(inner);
			else return "nested";
		}
	}
	nodes = nodes.filter((n) => !labelShapes.has(n));
	if (nodes.length < 2) return "few";
	const area = (n: FlowNode): number => boxArea(n.box);
	const holder = (x: number, y: number): FlowNode | null => {
		let found: FlowNode | null = null;
		for (const n of nodes) if (insideShape(n.shape, n.box, x, y) && (!found || area(n) < area(found))) found = n;
		return found;
	};
	// 2. connectors
	const links: Array<{ stroke: Stroke; link: Link }> = [];
	for (const s of strokes) {
		if (boxStrokes.has(s) || s.tool === "highlighter") continue;
		const link = linkOf(s, recs.get(s) ?? null);
		if (link) links.push({ stroke: s, link });
	}
	const used = new Set<Stroke>();
	const heads = new Map<Stroke, Stroke[]>();
	// A line with a small head drawn at one end is an arrow.
	const loose = strokes.filter((s) => !boxStrokes.has(s) && !links.some((l) => l.stroke === s) && s.tool !== "highlighter");
	// A head stroke is deleted when the line is redrawn, so it is read only when it is clearly a head (a handwritten "V", "L", "<" or ">" next
	// to the end of a line is not one, and is left alone, the line then being a plain line): not inside a box, not part of other writing,
	// symmetric about the line, small against it, and the only candidate of that line.
	const deepInside = (x: number, y: number): boolean => nodes.some((n) => insideShape(n.shape, n.box, x, y, -HEAD_DEEP));
	const candidates: Array<{ s: Stroke; l: (typeof links)[number]; end: "from" | "to"; head: NonNullable<ReturnType<typeof headOf>> }> = [];
	for (const s of loose) {
		const head = headOf(s);
		if (!head || deepInside(head.apex[0], head.apex[1])) continue;
		const sb = strokeBounds(s);
		const crowded = loose.some((o) => {
			if (o === s) return false;
			const ob = strokeBounds(o);
			return ob.minX <= sb.maxX + HEAD_NEIGHBOUR && ob.maxX >= sb.minX - HEAD_NEIGHBOUR && ob.minY <= sb.maxY + HEAD_NEIGHBOUR && ob.maxY >= sb.minY - HEAD_NEIGHBOUR;
		});
		if (crowded) continue;
		let best: { l: (typeof links)[number]; end: "from" | "to"; d: number } | null = null;
		for (const l of links) {
			if (l.link.arrow) continue;
			for (const end of ["from", "to"] as const) {
				const e = l.link[end];
				const other = l.link[end === "from" ? "to" : "from"];
				const d = dist(e, head.apex);
				if (d > HEAD_REACH || (best && d >= best.d)) continue;
				// The wings point back along the line, on either side of it.
				const ux = other[0] - e[0], uy = other[1] - e[1], len = Math.hypot(ux, uy) || 1;
				const bx = head.back[0] - head.apex[0], by = head.back[1] - head.apex[1], bl = Math.hypot(bx, by) || 1;
				if ((ux * bx + uy * by) / (len * bl) < 0.6 || !headFitsLine(head, e, other)) continue;
				best = { l, end, d };
			}
		}
		if (best) candidates.push({ s, l: best.l, end: best.end, head });
	}
	for (const c of candidates) {
		// Two strokes that both look like the head of one line: unsure, so neither is taken.
		if (candidates.some((o) => o !== c && o.l === c.l)) continue;
		const { l, end, head, s } = c;
		if (end === "from") l.link = { ...l.link, from: l.link.to, to: l.link.from };
		l.link = { ...l.link, arrow: true, wing: head.wing };
		heads.set(l.stroke, [s]);
		used.add(s);
	}
	const edges: FlowEdge[] = [];
	for (const { stroke, link } of links) {
		const a = attach(nodes, link.from);
		const b = attach(nodes, link.to);
		if (!a || !b || a === b) continue;
		edges.push({ stroke, heads: heads.get(stroke) ?? [], from: nodes.indexOf(a), to: nodes.indexOf(b), arrow: link.arrow, wing: link.wing, drawn: link, strokes: [], elements: [] });
		used.add(stroke);
	}
	// A head that did not end up on a connector between two boxes is just a stroke.
	for (const [line, hs] of heads) if (!edges.some((e) => e.stroke === line)) for (const h of hs) used.delete(h);
	// 3. labels
	for (const n of labelShapes) {
		const c = centreOf(n.box);
		holder(c[0], c[1])?.strokes.push(n.stroke);
		used.add(n.stroke);
	}
	for (const s of strokes) {
		if (boxStrokes.has(s) || used.has(s)) continue;
		const c = centreOf(strokeBounds(s));
		const home = holder(c[0], c[1]);
		if (home) home.strokes.push(s);
		else nearestEdge(edges, c)?.strokes.push(s);
	}
	for (const e of elements) {
		if (!LABEL_ELEMENTS.has(e.type)) continue;
		const c = centreOf(elementBounds(e, measure));
		const home = holder(c[0], c[1]);
		if (home) home.elements.push(e);
		else nearestEdge(edges, c)?.elements.push(e);
	}
	return { nodes, edges };
}

/** The connector, as drawn, that a point beside it belongs to: the nearest one within reach. */
function nearestEdge(edges: readonly FlowEdge[], p: readonly number[]): FlowEdge | null {
	let best: FlowEdge | null = null;
	let bd = EDGE_LABEL_REACH;
	for (const e of edges) {
		const d = pointSegmentDistance(p[0]!, p[1]!, e.drawn.from[0], e.drawn.from[1], e.drawn.to[0], e.drawn.to[1]);
		if (d <= bd) {
			best = e;
			bd = d;
		}
	}
	return best;
}

/** The box a connector end belongs to: the nearest one within reach. */
function attach(nodes: readonly FlowNode[], p: readonly number[]): FlowNode | null {
	let best: FlowNode | null = null;
	let bd = Infinity;
	for (const n of nodes) {
		const reach = Math.min(ATTACH_MAX, ATTACH_MIN + ATTACH_SHARE * Math.min(n.box.maxX - n.box.minX, n.box.maxY - n.box.minY));
		const d = distanceToShape(n.shape, n.box, p[0]!, p[1]!);
		if (d <= reach && (d < bd || (d === bd && best && boxArea(n.box) < boxArea(best.box)))) {
			best = n;
			bd = d;
		}
	}
	return best;
}

// ---------------------------------------------------------------- the plan

export interface FlowOptions {
	/** Step of the grid the first box and the gaps snap to; 0 or absent: 8 pt. */
	grid?: number;
	measure?: MeasureText;
	/** The redaction boxes of the page: moved ink never touches one, before or after. */
	guard: RedactGuard;
}

export type FlowPlan =
	| { ok: true; cmd: Command; strokes: Stroke[]; elements: PageElement[]; boxes: number; arrows: number }
	| { ok: false; reason: FlowRefusal };

export const DEFAULT_GRID = 8;

/** The grid step to use from the paper's step: never finer than 8 pt (a multiple of the paper's step). */
export function flowGrid(paperStep: number | undefined): number {
	return paperStep && paperStep > 0 ? paperStep * Math.max(1, Math.ceil(DEFAULT_GRID / paperStep)) : DEFAULT_GRID;
}

const within = (page: Pick<Page, "width" | "height" | "infinite">, b: BBox, tol: number): boolean =>
	b.minX >= -tol && b.minY >= -tol && b.maxX <= page.width + tol && (page.infinite === true || b.maxY <= page.height + tol);
/** Moved ink stays on the page (give or take the width of its own line); only ink that already stuck out (`was`) is allowed EDGE_TOL of it afterwards. */
const inside = (page: Pick<Page, "width" | "height" | "infinite">, b: BBox, was: BBox): boolean =>
	within(page, b, within(page, was, EDGE_SLACK) ? EDGE_SLACK : EDGE_TOL);

function redrawn(s: Stroke, points: Point[]): Stroke {
	if (s.tool === "shape") return freezeStroke({ ...s, points });
	const { nib: _nib, taperStart: _ts, taperEnd: _te, ...flat } = s;
	void _nib;
	void _ts;
	void _te;
	return freezeStroke({ ...flat, tool: "shape", render: RENDER_FREEHAND, points });
}

/**
 * The step that tidies the flowchart in `req` on `page` (see the file comment), or the reason why not. `req` is what the person may edit:
 * the visible ink and unlocked elements of the selection, groups completed.
 */
export function planFlowchart(page: Page, req: { strokes: readonly Stroke[]; elements: readonly PageElement[] }, options: FlowOptions): FlowPlan {
	const measure = options.measure ?? estimateMeasure;
	const onPage = new Set(page.strokes);
	const inPart = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) inPart.add(id);
	const strokes = req.strokes.filter((s) => onPage.has(s) && s.hidden !== true && !inPart.has(s.id));
	const elementsOnPage = new Set(page.elements ?? []);
	const elements = req.elements.filter((e) => elementsOnPage.has(e) && e.locked !== true && !inPart.has(e.id));
	const model = readFlowchart(strokes, elements, measure);
	if (model === "few" || model === "nested") return { ok: false, reason: model };
	const { nodes, edges } = model;
	const layout = layoutBoxes(nodes, options.grid && options.grid > 0 ? options.grid : DEFAULT_GRID);
	if (!layout) return { ok: false, reason: "ambiguous" };
	// Where the boxes will be.
	const placed: LayoutBox[] = nodes.map((n, i) => {
		const [dx, dy] = layout.deltas[i]!;
		return { shape: n.shape, box: { minX: n.box.minX + dx, minY: n.box.minY + dy, maxX: n.box.maxX + dx, maxY: n.box.maxY + dy } };
	});
	// Either the chart is tidy already (nothing would move by more than the recogniser's own error) or every box that is off moves into place.
	const off = (i: number, limit: number): boolean => Math.abs(layout.deltas[i]![0]) >= limit || Math.abs(layout.deltas[i]![1]) >= limit;
	const untidy = nodes.some((_, i) => off(i, MOVE_EPSILON));
	const moves = nodes.map((_, i) => untidy && off(i, 0.02));
	// The connectors: parallel ones between the same two boxes are set apart.
	const pairs = new Map<string, FlowEdge[]>();
	for (const e of edges) {
		const key = e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`;
		pairs.set(key, [...(pairs.get(key) ?? []), e]);
	}
	const redraw: Array<{ edge: FlowEdge; stroke: Stroke; shift: V }> = [];
	for (const e of edges) {
		const same = pairs.get(e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`)!;
		const offset = same.length > 1 ? (same.indexOf(e) - (same.length - 1) / 2) * PARALLEL : 0;
		const ends = connectorBetween(placed[e.from]!, placed[e.to]!, offset);
		if (!ends) {
			// The boxes are too close (or too tangled) for a connector: if either moves, the connector would be left behind.
			if (moves[e.from] || moves[e.to]) return { ok: false, reason: "ambiguous" };
			continue;
		}
		const clean = e.stroke.tool === "shape" && e.heads.length === 0
			&& dist(ends.from, e.drawn.from) <= END_TOLERANCE && dist(ends.to, e.drawn.to) <= END_TOLERANCE;
		if (clean && !moves[e.from] && !moves[e.to]) continue;
		const wing = Math.min(e.wing, 0.5 * dist(ends.from, ends.to));
		const points = e.arrow ? arrowPoints(ends.from, ends.to, wing) : linePoints(ends.from, ends.to);
		// The connector's label keeps its place against the middle of the connector.
		const shift: V = [(ends.from[0] + ends.to[0] - e.drawn.from[0] - e.drawn.to[0]) / 2, (ends.from[1] + ends.to[1] - e.drawn.from[1] - e.drawn.to[1]) / 2];
		redraw.push({ edge: e, stroke: redrawn(e.stroke, points), shift });
	}
	if (!moves.some(Boolean) && redraw.length === 0) return { ok: false, reason: "none" };
	// What moves: the box, its labels.
	const placement = emptyPlacement();
	const moverStrokes: Stroke[] = [];
	const moverElements: PageElement[] = [];
	nodes.forEach((n, i) => {
		if (!moves[i]) return;
		const m = translate(layout.deltas[i]![0], layout.deltas[i]![1]);
		for (const s of [n.stroke, ...n.strokes]) { placement.strokes.set(s, m); moverStrokes.push(s); }
		for (const e of n.elements) { placement.elements.set(e, m); moverElements.push(e); }
	});
	for (const r of redraw) {
		if (Math.hypot(r.shift[0], r.shift[1]) < MOVE_EPSILON) continue;
		const m = translate(r.shift[0], r.shift[1]);
		for (const s of r.edge.strokes) { placement.strokes.set(s, m); moverStrokes.push(s); }
		for (const e of r.edge.elements) { placement.elements.set(e, m); moverElements.push(e); }
	}
	const placedPlan = moverStrokes.length + moverElements.length > 0 ? applyPlacement(page, moverStrokes, moverElements, placement, measure, FLOWCHART_LABEL) : null;
	if (moverStrokes.length + moverElements.length > 0 && !placedPlan) return { ok: false, reason: "gone" };
	const afterStrokes = placedPlan?.strokes ?? [];
	const afterElements = placedPlan?.elements ?? [];
	const droppedHeads = redraw.flatMap((r) => r.edge.heads);
	// Redaction, tapes, the page edge: before and after.
	const before = { strokes: [...moverStrokes, ...redraw.map((r) => r.edge.stroke), ...droppedHeads], elements: moverElements };
	const after = { strokes: [...afterStrokes, ...redraw.map((r) => r.stroke)], elements: afterElements };
	if (movesUnderRedaction(options.guard, before, after)) return { ok: false, reason: "redacted" };
	const tapes = (page.elements ?? []).filter((e): e is TapeElement => e.type === "tape");
	if (tapes.length > 0) {
		const touches = (set: typeof before): boolean => set.strokes.some((s) => strokeTouchesTapes(s, tapes)) || set.elements.some((e) => boxTouchesTapes(elementBounds(e, measure), tapes));
		if (touches(before) || touches(after)) return { ok: false, reason: "tape" };
	}
	let edgeOut = false;
	// `before` and `after` line up one to one (the dropped heads come last in `before` and have no partner).
	after.strokes.forEach((s, i) => { if (!inside(page, strokeBounds(s), strokeBounds(before.strokes[i]!))) edgeOut = true; });
	after.elements.forEach((e, i) => { if (!inside(page, elementBounds(e, measure), elementBounds(before.elements[i]!, measure))) edgeOut = true; });
	if (edgeOut) return { ok: false, reason: "edge" };
	// The command: moves first, then the connectors drawn again, then the heads that are gone (last index first, so Undo puts them back in place).
	const commands: Command[] = placedPlan ? [...placedPlan.command.commands] : [];
	for (const r of redraw) commands.push(new ReplaceStroke(page.id, r.edge.stroke, [r.stroke], page.strokes.indexOf(r.edge.stroke)));
	const gone = droppedHeads.map((s) => ({ s, i: page.strokes.indexOf(s) })).filter((x) => x.i >= 0).sort((a, b) => b.i - a.i);
	for (const g of gone) commands.push(new ReplaceStroke(page.id, g.s, [], g.i));
	// The selection after the step.
	const swapped = new Map<Stroke, Stroke>();
	moverStrokes.forEach((s, i) => swapped.set(s, afterStrokes[i]!));
	for (const r of redraw) swapped.set(r.edge.stroke, r.stroke);
	const dropped = new Set(droppedHeads);
	const swappedEl = new Map<PageElement, PageElement>();
	moverElements.forEach((e, i) => swappedEl.set(e, afterElements[i]!));
	return {
		ok: true,
		cmd: new Batch(FLOWCHART_LABEL, commands),
		strokes: req.strokes.filter((s) => !dropped.has(s)).map((s) => swapped.get(s) ?? s),
		elements: req.elements.map((e) => swappedEl.get(e) ?? e),
		boxes: nodes.length,
		arrows: redraw.length,
	};
}
