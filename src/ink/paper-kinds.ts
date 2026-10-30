/**
 * Geometry of the v7 paper kinds (roadmap #73): Cornell, music staff, isometric, hexagonal, calligraphy and
 * the daily and weekly planners. Pure (no canvas): segments in page coordinates (pt), like paper.ts, so the
 * canvas, the thumbnails and both exporters draw the same pattern.
 *
 * Rules shared with the older papers: nothing is drawn on the page edge; segments are clipped to the page and
 * only those that cross `visible` are returned; "minor" lines are the ones left out when they would be closer
 * than about 3 CSS px on screen (`includeMinor: false`), "major" and "margin" lines always stay.
 *
 * Bounded output: one pattern never has more than MAX_PAPER_SEGMENTS segments (the exporters draw the whole
 * page, and calligraphy or hexagons at the smallest spacing would otherwise give hundreds of thousands). A
 * pattern that would exceed it falls back to its major and margin lines, and when that leaves nothing (or is
 * still too much) to the same pattern on a coarser lattice (spacing doubled until it fits): never a blank page.
 */
import { MM, type Page, type PaperKind } from "../model/types";
import type { BBox } from "./hit-test";
import type { PaperLine, PaperLineKind } from "./paper";

/** Cornell: the cue column takes this share of the width, the summary area this share of the height. */
export const CORNELL_CUE_RATIO = 0.3;
export const CORNELL_SUMMARY_RATIO = 0.2;
/** Cornell: the title area above the notes is this many line heights. */
export const CORNELL_HEADER_LINES = 2;

/** Music: blank space left and right of the staves, above the first one and below the last one. */
export const MUSIC_SIDE = 12 * MM;
export const MUSIC_TOP = 15 * MM;
export const MUSIC_BOTTOM = 10 * MM;
/** Music: a staff (5 lines, 4 gaps) starts every this many gaps (so 6 gaps of space between staves). */
export const MUSIC_PERIOD_GAPS = 10;

/** Calligraphy: ascender and descender heights and the space between groups, in x-heights. */
export const CALLIGRAPHY_ASCENDER = 0.8;
export const CALLIGRAPHY_DESCENDER = 0.8;
export const CALLIGRAPHY_GAP = 0.6;
/** Calligraphy: the slant guides lean this many degrees from the horizontal (copperplate is about 55°). */
export const CALLIGRAPHY_SLANT_DEG = 55;
/** Calligraphy: one slant guide every this many x-heights. */
export const CALLIGRAPHY_SLANT_EVERY = 2;

/** Planners: the title area is this many rows; the daily planner's time column is this wide. */
export const PLANNER_HEADER_ROWS = 3;
export const PLANNER_TIME_COLUMN = 20 * MM;
/** Daily planner: the schedule takes this share of the width, the notes column the rest. */
export const PLANNER_SCHEDULE_RATIO = 0.62;

/** Most segments in one v7 pattern (the older papers stay under about 10k on a page). */
export const MAX_PAPER_SEGMENTS = 30_000;
/** Hexagonal: most hexagons walked for one pattern (three segments each, so within MAX_PAPER_SEGMENTS). */
export const MAX_HEXAGONS = Math.floor(MAX_PAPER_SEGMENTS / 3);
/** Most lines walked along one axis before the lattice is coarsened (the same bound as the older papers). */
export const MAX_V7_STEPS = 5000;

const EPS = 1e-6;

/** Paper kinds drawn by this module. */
export const V7_PAPER_KINDS: ReadonlySet<PaperKind> = new Set<PaperKind>(["cornell", "music", "isometric", "hexagonal", "calligraphy", "planner-day", "planner-week"]);

/** Liang–Barsky: the part of the segment inside the box, or null. */
function clip(x1: number, y1: number, x2: number, y2: number, box: BBox): [number, number, number, number] | null {
	let t0 = 0;
	let t1 = 1;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const p = [-dx, dx, -dy, dy];
	const q = [x1 - box.minX, box.maxX - x1, y1 - box.minY, box.maxY - y1];
	for (let i = 0; i < 4; i++) {
		const pi = p[i]!;
		const qi = q[i]!;
		if (Math.abs(pi) < EPS) {
			if (qi < 0) return null;
			continue;
		}
		const r = qi / pi;
		if (pi < 0) {
			if (r > t1) return null;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return null;
			if (r < t1) t1 = r;
		}
	}
	return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

/** Collects segments: clipped to the page, kept only when they cross `visible`, never on the page edge. */
class Sink {
	readonly lines: PaperLine[] = [];
	/** True once the pattern needed more than MAX_PAPER_SEGMENTS segments: the generators stop, the caller falls back. */
	full = false;
	private readonly page: BBox;
	constructor(private readonly width: number, private readonly height: number, private readonly visible: BBox, readonly includeMinor: boolean) {
		this.page = { minX: 0, minY: 0, maxX: width, maxY: height };
	}

	add(x1: number, y1: number, x2: number, y2: number, kind: PaperLineKind): void {
		if (this.full || (kind === "minor" && !this.includeMinor)) return;
		const c = clip(x1, y1, x2, y2, this.page);
		if (!c) return;
		const [a, b, c2, d] = c;
		if (Math.hypot(c2 - a, d - b) < 0.01) return;
		// On the page edge (a horizontal line at the top or bottom, a vertical one at the sides): not drawn.
		const onEdge = (Math.abs(b - d) < EPS && (Math.abs(b) < EPS || Math.abs(b - this.height) < EPS))
			|| (Math.abs(a - c2) < EPS && (Math.abs(a) < EPS || Math.abs(a - this.width) < EPS));
		if (onEdge) return;
		if (!clip(a, b, c2, d, this.visible)) return;
		if (this.lines.length >= MAX_PAPER_SEGMENTS) {
			this.full = true;
			return;
		}
		this.lines.push({ x1: a, y1: b, x2: c2, y2: d, kind });
	}

	horizontal(y: number, kind: PaperLineKind, x1 = 0, x2 = this.width): void {
		if (y < this.visible.minY || y > this.visible.maxY) return;
		this.add(x1, y, x2, y, kind);
	}

	vertical(x: number, kind: PaperLineKind, y1 = 0, y2 = this.height): void {
		if (x < this.visible.minX || x > this.visible.maxX) return;
		this.add(x, y1, x, y2, kind);
	}
}

/** Index range k with lo <= k * step <= hi. */
function steps(lo: number, hi: number, step: number): [number, number] {
	return [Math.ceil(lo / step - EPS), Math.floor(hi / step + EPS)];
}

function cornell(s: Sink, w: number, h: number, sp: number): void {
	const header = CORNELL_HEADER_LINES * sp;
	const summary = h * (1 - CORNELL_SUMMARY_RATIO);
	const cue = w * CORNELL_CUE_RATIO;
	const [a, b] = steps(Math.max(header + sp, 0), h, sp);
	for (let k = a; k <= b && !s.full; k++) {
		const y = k * sp;
		if (Math.abs(y - summary) < sp * 0.25) continue; // the summary line takes its place
		s.horizontal(y, "minor");
	}
	if (header < h) s.horizontal(header, "major");
	if (summary > header) s.horizontal(summary, "major");
	if (cue < w && summary > header) s.vertical(cue, "margin", header, summary);
}

function music(s: Sink, w: number, h: number, sp: number): void {
	const period = MUSIC_PERIOD_GAPS * sp;
	const x1 = Math.min(MUSIC_SIDE, w / 4);
	const x2 = w - x1;
	for (let top = MUSIC_TOP; top + 4 * sp <= h - MUSIC_BOTTOM + EPS && !s.full; top += period) {
		for (let i = 0; i < 5; i++) s.horizontal(top + i * sp, i === 0 || i === 4 ? "major" : "minor", x1, x2);
	}
}

const TAN30 = Math.tan(Math.PI / 6);

function isometric(s: Sink, w: number, h: number, sp: number, visible: BBox): void {
	const dx = (sp * Math.sqrt(3)) / 2;
	const [ia, ib] = steps(Math.max(visible.minX, EPS), Math.min(visible.maxX, w - EPS), dx);
	for (let i = Math.max(1, ia); i <= ib && !s.full; i++) s.vertical(i * dx, "minor");
	// y = ±x·tan30 + k·sp: through the lattice points (column i at y = k·sp + i·sp/2).
	const lo = Math.max(0, visible.minY);
	const hi = Math.min(h, visible.maxY);
	const x0 = Math.max(0, visible.minX);
	const x1 = Math.min(w, visible.maxX);
	// Rising lines (y decreases as x grows): y = -x·tan30 + c; c ranges over what reaches the visible box.
	const [ra, rb] = steps(lo + x0 * TAN30, hi + x1 * TAN30, sp);
	for (let k = ra; k <= rb && !s.full; k++) s.add(0, k * sp, w, k * sp - w * TAN30, "minor");
	const [fa, fb] = steps(lo - x1 * TAN30, hi - x0 * TAN30, sp);
	for (let k = fa; k <= fb && !s.full; k++) s.add(0, k * sp, w, k * sp + w * TAN30, "minor");
}

function hexagonal(s: Sink, sp: number, visible: BBox, w: number, h: number): void {
	if (!s.includeMinor) return;
	const colStep = 1.5 * sp;
	const rowStep = Math.sqrt(3) * sp;
	const box = { minX: Math.max(0, visible.minX), minY: Math.max(0, visible.minY), maxX: Math.min(w, visible.maxX), maxY: Math.min(h, visible.maxY) };
	if (box.maxX < box.minX || box.maxY < box.minY) return;
	const i0 = Math.floor(box.minX / colStep) - 1;
	const i1 = Math.ceil(box.maxX / colStep) + 1;
	const j0 = Math.floor(box.minY / rowStep) - 1;
	const j1 = Math.ceil(box.maxY / rowStep) + 1;
	if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_HEXAGONS) {
		s.full = true;
		return;
	}
	const vx = [1, 0.5, -0.5, -1, -0.5, 0.5].map((c) => c * sp);
	const vy = [0, 1, 1, 0, -1, -1].map((c) => (c * rowStep) / 2);
	for (let i = i0; i <= i1 && !s.full; i++) {
		const cx = i * colStep;
		const off = (((i % 2) + 2) % 2) * (rowStep / 2);
		for (let j = j0; j <= j1; j++) {
			const cy = j * rowStep + off;
			// Flat-top hexagon, vertices 0..5 clockwise from the right (y down). Each hexagon draws its
			// bottom-left, left-top and top edges; the neighbours draw the other three.
			for (const [a, b] of [[2, 3], [3, 4], [4, 5]] as const) s.add(cx + vx[a]!, cy + vy[a]!, cx + vx[b]!, cy + vy[b]!, "minor");
		}
	}
}

function calligraphy(s: Sink, w: number, h: number, sp: number, visible: BBox): void {
	const asc = CALLIGRAPHY_ASCENDER * sp;
	const desc = CALLIGRAPHY_DESCENDER * sp;
	const period = sp + asc + desc + CALLIGRAPHY_GAP * sp;
	const run = (sp + asc + desc) / Math.tan((CALLIGRAPHY_SLANT_DEG * Math.PI) / 180);
	const every = CALLIGRAPHY_SLANT_EVERY * sp;
	for (let top = 1.5 * sp; top + sp + asc + desc <= h + EPS && !s.full; top += period) {
		const bottom = top + asc + sp + desc;
		if (bottom < visible.minY || top > visible.maxY) continue;
		const baseline = top + asc + sp;
		s.horizontal(top, "minor");
		s.horizontal(top + asc, "minor");
		s.horizontal(baseline, "major");
		s.horizontal(bottom, "minor");
		if (!s.includeMinor) continue;
		// Slant guides across the band, leaning right as they go up.
		const [a, b] = steps(Math.max(-run, visible.minX - run), Math.min(w, visible.maxX), every);
		for (let k = a; k <= b && !s.full; k++) s.add(k * every, bottom, k * every + run, top, "minor");
	}
}

function plannerDay(s: Sink, w: number, h: number, sp: number): void {
	const header = PLANNER_HEADER_ROWS * sp;
	if (header >= h) return;
	const split = w * PLANNER_SCHEDULE_RATIO;
	const last = Math.floor((h - sp) / sp + EPS) * sp;
	s.horizontal(header, "major");
	for (let k = 1; header + k * sp <= last + EPS && !s.full; k++) {
		const y = header + k * sp;
		// Every second row is an hour: a major line across the schedule, minor in the notes column.
		s.horizontal(y, k % 2 === 0 ? "major" : "minor", 0, split);
		s.horizontal(y, "minor", split, w);
	}
	const end = Math.max(header, last);
	if (PLANNER_TIME_COLUMN < split) s.vertical(PLANNER_TIME_COLUMN, "margin", header, end);
	if (split < w) s.vertical(split, "major", header, end);
}

function plannerWeek(s: Sink, w: number, h: number, sp: number): void {
	const header = PLANNER_HEADER_ROWS * sp;
	const bottom = h - sp;
	if (header >= bottom) return;
	// Seven days and a notes box: 2 × 4 boxes on a portrait page, 4 × 2 on a landscape one.
	const cols = w > h ? 4 : 2;
	const rows = 8 / cols;
	const boxH = (bottom - header) / rows;
	s.horizontal(header, "major");
	s.horizontal(bottom, "major");
	for (let c = 1; c < cols; c++) s.vertical((w * c) / cols, "major", header, bottom);
	for (let r = 0; r < rows; r++) {
		const top = header + r * boxH;
		if (r > 0) s.horizontal(top, "major");
		for (let y = top + sp; y < top + boxH - sp * 0.5 && !s.full; y += sp) s.horizontal(y, "minor");
	}
}

function draw(kind: PaperKind, w: number, h: number, spacing: number, visible: BBox, includeMinor: boolean): Sink {
	const s = new Sink(w, h, visible, includeMinor);
	switch (kind) {
		case "cornell":
			cornell(s, w, h, spacing);
			break;
		case "music":
			music(s, w, h, spacing);
			break;
		case "isometric":
			isometric(s, w, h, spacing, visible);
			break;
		case "hexagonal":
			hexagonal(s, spacing, visible, w, h);
			break;
		case "calligraphy":
			calligraphy(s, w, h, spacing, visible);
			break;
		case "planner-day":
			plannerDay(s, w, h, spacing);
			break;
		case "planner-week":
			plannerWeek(s, w, h, spacing);
			break;
	}
	return s;
}

/** Most doublings of the spacing tried by the fallback (far beyond any page). */
const MAX_COARSENING = 40;

/**
 * Lines of a v7 paper kind (no dots), or null for the other kinds. At most MAX_PAPER_SEGMENTS: a denser
 * pattern falls back to its major lines, else to a coarser lattice (see the module comment).
 */
export function v7PaperLines(page: Page, visible: BBox, includeMinor: boolean): PaperLine[] | null {
	const { kind, spacing } = page.paper;
	if (!V7_PAPER_KINDS.has(kind)) return null;
	const { width: w, height: h } = page;
	if (!(spacing > 0) || !Number.isFinite(spacing)) return [];
	// Too many lines to even walk: start on a coarser lattice (power-of-two multiples keep its lines on the original one).
	let sp = spacing;
	for (let i = 0; i < MAX_COARSENING && Math.max(w, h) / sp > MAX_V7_STEPS; i++) sp *= 2;
	const first = draw(kind, w, h, sp, visible, includeMinor);
	if (!first.full) return first.lines;
	if (includeMinor) {
		const major = draw(kind, w, h, sp, visible, false);
		if (!major.full && major.lines.length > 0) return major.lines;
	}
	for (let i = 0; i < MAX_COARSENING; i++) {
		sp *= 2;
		const coarse = draw(kind, w, h, sp, visible, includeMinor);
		if (!coarse.full) return coarse.lines;
	}
	return first.lines;
}
