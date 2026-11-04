/**
 * Magnetic snap and alignment guides (roadmap #71). Pure: no 'obsidian', no canvas, no document format.
 *
 * While a selection (ink, a picture, a text box, a shape) is moved or scaled, its box can be pulled to
 * - the paper grid of the page (`gridOf`: grid, dotted, millimetre and ruled paper; blank and the v7 patterns have none), and
 * - alignment lines: the edges and centres of the other items of the page, the page centre and edges, the margins
 *   (`snapTargets`).
 * The result is a correction in page units (pt) and the guides to draw (thin coloured lines, only while dragging).
 *
 * Cheap on purpose: `snapMove` and `snapScale` run on every pointer sample, so they walk flat arrays with plain loops and
 * allocate only the small result (at most `MAX_GUIDES` guides). The targets are built once when the drag starts.
 */
import type { BBox } from "../ink/hit-test";

export type SnapMode = "off" | "grid" | "guides" | "both";
export const SNAP_MODES: readonly SnapMode[] = ["off", "grid", "guides", "both"];
export const DEFAULT_SNAP_MODE: SnapMode = "both";

/** How close (CSS px on screen) a box has to come to a line before it is pulled onto it. */
export const SNAP_STRENGTH_MIN = 3;
export const SNAP_STRENGTH_MAX = 20;
export const SNAP_STRENGTH_STEP = 1;
export const DEFAULT_SNAP_STRENGTH = 8;

/** Most guides shown at once (the screen would turn into a net otherwise). */
export const MAX_GUIDES = 6;
/** Two positions closer than this (pt) are the same line. */
const EPS = 0.05;
/** Millimetre paper snaps to every Nth line (5 mm), not to each millimetre. */
export const MILLIMETRE_SNAP_EVERY = 5;
/** The scale factor of a scale drag stays within these bounds (the same as the drag itself). */
export const SCALE_MIN = 0.05;
export const SCALE_MAX = 20;

export const normaliseSnapMode = (v: unknown): SnapMode => (v === "off" || v === "grid" || v === "guides" || v === "both" ? v : DEFAULT_SNAP_MODE);

export function normaliseSnapStrength(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_SNAP_STRENGTH;
	return Math.round(Math.min(SNAP_STRENGTH_MAX, Math.max(SNAP_STRENGTH_MIN, v)));
}

export const usesGrid = (mode: SnapMode): boolean => mode === "grid" || mode === "both";
export const usesGuides = (mode: SnapMode): boolean => mode === "guides" || mode === "both";

/** What a line is, for its colour. */
export type GuideKind = "edge" | "centre" | "page" | "margin" | "grid";

/** A line to draw: `axis: "x"` is a vertical line at x = `pos`, from `from` to `to` (y); `axis: "y"` a horizontal one. */
export interface SnapGuide {
	axis: "x" | "y";
	pos: number;
	from: number;
	to: number;
	kind: GuideKind;
}

/** A line the box can align to. `lo`/`hi` is its extent along the other axis (where the guide is drawn from). */
export interface SnapLine {
	pos: number;
	lo: number;
	hi: number;
	kind: GuideKind;
}

/** Alignment lines of a page: `vertical` at x positions, `horizontal` at y positions. */
export interface SnapTargets {
	vertical: SnapLine[];
	horizontal: SnapLine[];
}

export const EMPTY_TARGETS: SnapTargets = { vertical: [], horizontal: [] };

/** Grid lines at `origin + n * step`; a step of 0 means no snapping on that axis. */
export interface SnapGrid {
	stepX: number;
	stepY: number;
	originX: number;
	originY: number;
}

export interface SnapPage {
	width: number;
	height: number;
	paper: { kind: string; spacing: number };
	margins?: { left: number; right: number; bottom: number };
	infinite?: boolean;
}

/** x of the vertical margin line of ruled paper (25 mm; the same value as `RULED_MARGIN_X` in ink/paper.ts, kept here to stay standalone). */
const RULED_MARGIN = 25 * (72 / 25.4);

/** The paper lines a box snaps to; null when the paper has none (blank paper and the patterned v7 kinds). */
export function gridOf(page: SnapPage): SnapGrid | null {
	const { kind, spacing } = page.paper;
	if (!(spacing > 0)) return null;
	switch (kind) {
		case "grid":
		case "dotted":
			return { stepX: spacing, stepY: spacing, originX: 0, originY: 0 };
		case "millimetre":
			return { stepX: spacing * MILLIMETRE_SNAP_EVERY, stepY: spacing * MILLIMETRE_SNAP_EVERY, originX: 0, originY: 0 };
		case "ruled":
			return { stepX: 0, stepY: spacing, originX: 0, originY: 0 };
		default:
			return null;
	}
}

/**
 * The alignment lines of a page: the edges and centres of `boxes` (the other items), the page centre and edges and the
 * margins (the background box when margins are set; the margin line of ruled paper). A line holds the extent of the box it
 * comes from, so a guide runs from the moved box to the item it aligns with.
 */
export function snapTargets(page: SnapPage, boxes: readonly BBox[]): SnapTargets {
	const vertical: SnapLine[] = [];
	const horizontal: SnapLine[] = [];
	const { width, height } = page;
	// The page: edges, centre.
	vertical.push({ pos: 0, lo: 0, hi: height, kind: "page" }, { pos: width, lo: 0, hi: height, kind: "page" }, { pos: width / 2, lo: 0, hi: height, kind: "page" });
	horizontal.push({ pos: 0, lo: 0, hi: width, kind: "page" }, { pos: height / 2, lo: 0, hi: width, kind: "page" });
	if (!page.infinite) horizontal.push({ pos: height, lo: 0, hi: width, kind: "page" });
	// Margins: the background box, and the margin line of ruled paper.
	const m = page.margins;
	if (m) {
		if (m.left > 0) vertical.push({ pos: m.left, lo: 0, hi: height, kind: "margin" });
		if (m.right > 0) vertical.push({ pos: width - m.right, lo: 0, hi: height, kind: "margin" });
		if (m.bottom > 0 && !page.infinite) horizontal.push({ pos: height - m.bottom, lo: 0, hi: width, kind: "margin" });
	}
	if (page.paper.kind === "ruled" && RULED_MARGIN < width) vertical.push({ pos: RULED_MARGIN, lo: 0, hi: height, kind: "margin" });
	// The other items.
	for (const b of boxes) {
		if (!(b.maxX >= b.minX) || !(b.maxY >= b.minY)) continue;
		vertical.push({ pos: b.minX, lo: b.minY, hi: b.maxY, kind: "edge" }, { pos: b.maxX, lo: b.minY, hi: b.maxY, kind: "edge" });
		vertical.push({ pos: (b.minX + b.maxX) / 2, lo: b.minY, hi: b.maxY, kind: "centre" });
		horizontal.push({ pos: b.minY, lo: b.minX, hi: b.maxX, kind: "edge" }, { pos: b.maxY, lo: b.minX, hi: b.maxX, kind: "edge" });
		horizontal.push({ pos: (b.minY + b.maxY) / 2, lo: b.minX, hi: b.maxX, kind: "centre" });
	}
	return { vertical, horizontal };
}

/** Bounding box of `b` under an affine matrix [a, b, c, d, e, f] (canvas convention). */
export function transformedBox(b: BBox, m: readonly [number, number, number, number, number, number]): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < 4; i++) {
		const x = i & 1 ? b.maxX : b.minX;
		const y = i & 2 ? b.maxY : b.minY;
		const tx = m[0] * x + m[2] * y + m[4];
		const ty = m[1] * x + m[3] * y + m[5];
		if (tx < minX) minX = tx;
		if (tx > maxX) maxX = tx;
		if (ty < minY) minY = ty;
		if (ty > maxY) maxY = ty;
	}
	return { minX, minY, maxX, maxY };
}

export interface SnapResult {
	/** What to add to the box position (page units). */
	dx: number;
	dy: number;
	guides: SnapGuide[];
}

interface AxisPull {
	/** Correction to add (0 when nothing is in reach). */
	delta: number;
	/** The pull came from the grid (not from an alignment line). */
	grid: boolean;
	pulled: boolean;
}

const NO_PULL: AxisPull = { delta: 0, grid: false, pulled: false };

/** Nearest grid line to `v`: the distance to add. */
function toGrid(v: number, step: number, origin: number): number {
	const n = Math.round((v - origin) / step);
	return origin + n * step - v;
}

/** The correction that brings the features (min, centre, max) of one axis onto the nearest line within `thr`. Guides beat the grid. */
function pullAxis(min: number, max: number, lines: readonly SnapLine[], step: number, origin: number, useGuides: boolean, useGrid: boolean, thr: number): AxisPull {
	const mid = (min + max) / 2;
	if (useGuides) {
		let best = 0;
		let bestAbs = Infinity;
		for (let i = 0; i < lines.length; i++) {
			const p = lines[i]!.pos;
			let d = p - min;
			let a = Math.abs(d);
			if (a <= thr && a < bestAbs) { best = d; bestAbs = a; }
			d = p - mid; a = Math.abs(d);
			if (a <= thr && a < bestAbs) { best = d; bestAbs = a; }
			d = p - max; a = Math.abs(d);
			if (a <= thr && a < bestAbs) { best = d; bestAbs = a; }
		}
		if (bestAbs !== Infinity) return { delta: best, grid: false, pulled: true };
	}
	if (useGrid && step > 0) {
		const d1 = toGrid(min, step, origin);
		const d2 = toGrid(max, step, origin);
		const d = Math.abs(d1) <= Math.abs(d2) ? d1 : d2;
		if (Math.abs(d) <= thr) return { delta: d, grid: true, pulled: true };
	}
	return NO_PULL;
}

/** Alignment guides of a box that sits where it sits: every line that one of its edges or its centre lies on. */
export function alignmentGuides(box: BBox, targets: SnapTargets, out: SnapGuide[] = []): SnapGuide[] {
	const mx = (box.minX + box.maxX) / 2;
	const my = (box.minY + box.maxY) / 2;
	for (let i = 0; i < targets.vertical.length; i++) {
		const t = targets.vertical[i]!;
		if (Math.abs(t.pos - box.minX) <= EPS || Math.abs(t.pos - mx) <= EPS || Math.abs(t.pos - box.maxX) <= EPS) addGuide(out, "x", t, box.minY, box.maxY);
	}
	for (let i = 0; i < targets.horizontal.length; i++) {
		const t = targets.horizontal[i]!;
		if (Math.abs(t.pos - box.minY) <= EPS || Math.abs(t.pos - my) <= EPS || Math.abs(t.pos - box.maxY) <= EPS) addGuide(out, "y", t, box.minX, box.maxX);
	}
	return out;
}

/** Adds the guide for `t`, or widens the one already at that position (several items can share a line). */
function addGuide(out: SnapGuide[], axis: "x" | "y", t: SnapLine, lo: number, hi: number): void {
	const from = Math.min(lo, t.lo), to = Math.max(hi, t.hi);
	for (let i = 0; i < out.length; i++) {
		const g = out[i]!;
		if (g.axis === axis && Math.abs(g.pos - t.pos) <= EPS) {
			if (from < g.from) g.from = from;
			if (to > g.to) g.to = to;
			// A page or margin line keeps its colour over an item edge at the same place.
			if (t.kind === "page" || t.kind === "margin") g.kind = t.kind;
			return;
		}
	}
	if (out.length < MAX_GUIDES) out.push({ axis, pos: t.pos, from, to, kind: t.kind });
}

/** The grid line a snapped box edge sits on, as a faint guide (the box edge that was pulled onto the grid). */
function gridGuide(out: SnapGuide[], axis: "x" | "y", box: BBox, step: number, origin: number): void {
	const lo = axis === "x" ? box.minX : box.minY;
	const hi = axis === "x" ? box.maxX : box.maxY;
	const edge = Math.abs(toGrid(lo, step, origin)) <= Math.abs(toGrid(hi, step, origin)) ? lo : hi;
	const pos = origin + Math.round((edge - origin) / step) * step;
	if (out.length >= MAX_GUIDES) return;
	out.push(axis === "x"
		? { axis, pos, from: box.minY, to: box.maxY, kind: "grid" }
		: { axis, pos, from: box.minX, to: box.maxX, kind: "grid" });
}

/**
 * Snaps a box that is being moved. `thr` is the reach in page units (strength in px divided by the view scale).
 * Per axis the nearest alignment line wins over the grid; `mode` decides which of the two exist.
 */
export function snapMove(box: BBox, targets: SnapTargets | null, grid: SnapGrid | null, mode: SnapMode, thr: number): SnapResult {
	const none: SnapResult = { dx: 0, dy: 0, guides: [] };
	if (mode === "off" || !(thr > 0)) return none;
	const useGuides = usesGuides(mode) && targets !== null;
	const useGrid = usesGrid(mode) && grid !== null;
	if (!useGuides && !useGrid) return none;
	const t = targets ?? EMPTY_TARGETS;
	const px = pullAxis(box.minX, box.maxX, t.vertical, grid?.stepX ?? 0, grid?.originX ?? 0, useGuides, useGrid, thr);
	const py = pullAxis(box.minY, box.maxY, t.horizontal, grid?.stepY ?? 0, grid?.originY ?? 0, useGuides, useGrid, thr);
	if (!px.pulled && !py.pulled) {
		// Nothing pulled, but a box can already lie on a line.
		return useGuides ? { dx: 0, dy: 0, guides: alignmentGuides(box, t) } : none;
	}
	const moved: BBox = { minX: box.minX + px.delta, maxX: box.maxX + px.delta, minY: box.minY + py.delta, maxY: box.maxY + py.delta };
	const guides = useGuides ? alignmentGuides(moved, t) : [];
	if (px.grid && grid && !guides.some((g) => g.axis === "x")) gridGuide(guides, "x", moved, grid.stepX, grid.originX);
	if (py.grid && grid && !guides.some((g) => g.axis === "y")) gridGuide(guides, "y", moved, grid.stepY, grid.originY);
	return { dx: px.delta, dy: py.delta, guides };
}

export interface ScaleSnapResult {
	/** The snapped uniform factor (the one passed in when nothing is in reach). */
	k: number;
	guides: SnapGuide[];
}

/**
 * Snaps a uniform scale drag. `box0` is the box of the selection before the scale (at k = 1), `anchor` the fixed point
 * of the scale, `k` the factor the pointer asks for. Every feature of the box (edge, centre) moves along its axis as
 * `anchor + k * (feature - anchor)`, so for each line the factor that lands a feature on it is known exactly; the nearest
 * one within `thr` wins. Only one factor exists, so a single axis snaps at a time.
 */
export function snapScale(
	box0: BBox, anchor: readonly [number, number], k: number, targets: SnapTargets | null, grid: SnapGrid | null, mode: SnapMode, thr: number,
): ScaleSnapResult {
	const none: ScaleSnapResult = { k, guides: [] };
	if (mode === "off" || !(thr > 0)) return none;
	const useGuides = usesGuides(mode) && targets !== null;
	const useGrid = usesGrid(mode) && grid !== null;
	if (!useGuides && !useGrid) return none;
	const t = targets ?? EMPTY_TARGETS;
	let bestK = k;
	let bestErr = Infinity;
	let bestGrid = false;
	const consider = (a: number, f0: number, lines: readonly SnapLine[], step: number, origin: number, edge: boolean): void => {
		const span = f0 - a;
		if (Math.abs(span) < 1e-6) return;
		const at = a + k * span;
		const tryPos = (pos: number, isGrid: boolean): void => {
			const kt = (pos - a) / span;
			if (!(kt >= SCALE_MIN && kt <= SCALE_MAX)) return;
			const err = Math.abs(at - pos);
			// A line beats a grid line at the same distance.
			if (err <= thr && (err < bestErr - 1e-9 || (Math.abs(err - bestErr) <= 1e-9 && bestGrid && !isGrid))) { bestErr = err; bestK = kt; bestGrid = isGrid; }
		};
		if (useGuides) for (let i = 0; i < lines.length; i++) tryPos(lines[i]!.pos, false);
		if (useGrid && edge && step > 0) tryPos(origin + Math.round((at - origin) / step) * step, true);
	};
	const [ax, ay] = anchor;
	consider(ax, box0.minX, t.vertical, grid?.stepX ?? 0, grid?.originX ?? 0, true);
	consider(ax, (box0.minX + box0.maxX) / 2, t.vertical, grid?.stepX ?? 0, grid?.originX ?? 0, false);
	consider(ax, box0.maxX, t.vertical, grid?.stepX ?? 0, grid?.originX ?? 0, true);
	consider(ay, box0.minY, t.horizontal, grid?.stepY ?? 0, grid?.originY ?? 0, true);
	consider(ay, (box0.minY + box0.maxY) / 2, t.horizontal, grid?.stepY ?? 0, grid?.originY ?? 0, false);
	consider(ay, box0.maxY, t.horizontal, grid?.stepY ?? 0, grid?.originY ?? 0, true);
	if (bestErr === Infinity) return useGuides ? { k, guides: alignmentGuides(scaledBox(box0, anchor, k), t) } : none;
	const box1 = scaledBox(box0, anchor, bestK);
	const guides = useGuides ? alignmentGuides(box1, t) : [];
	if (bestGrid && grid) {
		if (grid.stepX > 0 && !guides.some((g) => g.axis === "x")) gridGuide(guides, "x", box1, grid.stepX, grid.originX);
		if (grid.stepY > 0 && !guides.some((g) => g.axis === "y")) gridGuide(guides, "y", box1, grid.stepY, grid.originY);
	}
	return { k: bestK, guides };
}

/** The box after a uniform scale `k` about `anchor`. */
export function scaledBox(b: BBox, anchor: readonly [number, number], k: number): BBox {
	const [ax, ay] = anchor;
	return { minX: ax + k * (b.minX - ax), maxX: ax + k * (b.maxX - ax), minY: ay + k * (b.minY - ay), maxY: ay + k * (b.maxY - ay) };
}
