import { pointSegmentDistance, type BBox } from "./hit-test";

/**
 * Layout and geometry of a hand-drawn flowchart (0.30, roadmap #245). Pure, no 'obsidian'.
 *
 * The boxes of a flowchart are laid out like the cells of a table without lines: the centres are clustered into columns and rows (a
 * column is the boxes whose centres lie within a fraction of a box width of each other), every box is centred in its column and row, the
 * gaps between the columns (and between the rows) become one value, and the whole chart keeps its top-left corner, snapped to the grid.
 * Boxes only move; they never change shape or size, and the order of the columns and rows is the order they were drawn in.
 */

export type NodeShape = "rectangle" | "diamond" | "ellipse";

export interface LayoutBox {
	shape: NodeShape;
	/** The outline of the shape (not the ink around it), page units. */
	box: BBox;
}

/** Share of a box width (height) within which two centres are in the same column (row). */
const CLUSTER_SHARE = 0.4;
/** Smallest gap, pt, between two neighbouring columns or rows: room for an arrow with its head. */
export const MIN_GAP = 28;
/** Clearance, pt, kept between an arrow's ends and the outline it touches. */
const CLEARANCE = 1.5;
/** Arrows shorter than this (pt) are not drawn: the boxes touch. */
const MIN_ARROW = 14;

const width = (b: BBox): number => b.maxX - b.minX;
const height = (b: BBox): number => b.maxY - b.minY;
const centreX = (b: BBox): number => (b.minX + b.maxX) / 2;
const centreY = (b: BBox): number => (b.minY + b.maxY) / 2;
export const boxArea = (b: BBox): number => width(b) * height(b);

// ---------------------------------------------------------------- shapes

/** Whether (x, y) lies inside the shape grown by `pad` (pt). */
export function insideShape(shape: NodeShape, b: BBox, x: number, y: number, pad = 0): boolean {
	const hw = width(b) / 2 + pad;
	const hh = height(b) / 2 + pad;
	if (!(hw > 0) || !(hh > 0)) return false;
	const dx = Math.abs(x - centreX(b));
	const dy = Math.abs(y - centreY(b));
	if (shape === "rectangle") return dx <= hw && dy <= hh;
	if (shape === "diamond") return dx / hw + dy / hh <= 1;
	return (dx / hw) ** 2 + (dy / hh) ** 2 <= 1;
}

/** The corners of the outline of a shape, in order (an ellipse as a 48-gon). */
function outline(shape: NodeShape, b: BBox): Array<[number, number]> {
	const cx = centreX(b), cy = centreY(b), hw = width(b) / 2, hh = height(b) / 2;
	if (shape === "rectangle") return [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
	if (shape === "diamond") return [[cx, b.minY], [b.maxX, cy], [cx, b.maxY], [b.minX, cy]];
	return Array.from({ length: 48 }, (_, i): [number, number] => [cx + hw * Math.cos((2 * Math.PI * i) / 48), cy + hh * Math.sin((2 * Math.PI * i) / 48)]);
}

/** Distance from (x, y) to the shape: 0 inside or on it. */
export function distanceToShape(shape: NodeShape, b: BBox, x: number, y: number): number {
	if (insideShape(shape, b, x, y)) return 0;
	if (shape === "rectangle") return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));
	const o = outline(shape, b);
	let best = Infinity;
	for (let i = 0; i < o.length; i++) {
		const a = o[i]!, c = o[(i + 1) % o.length]!;
		best = Math.min(best, pointSegmentDistance(x, y, a[0], a[1], c[0], c[1]));
	}
	return best;
}

// ---------------------------------------------------------------- connectors

export interface ConnectorEnds {
	from: [number, number];
	to: [number, number];
}

/**
 * The straight connector from box `a` to box `b` that runs between their outlines. Boxes that overlap in the horizontal (vertical) direction
 * get a vertical (horizontal) connector through the middle of the overlap, so a chart laid out in rows and columns has straight, square
 * arrows; any other pair is joined centre to centre. `offset` shifts it sideways (two connectors between the same boxes). Null when the
 * boxes touch or overlap or the connector would be a few points long.
 */
export function connectorBetween(a: LayoutBox, b: LayoutBox, offset = 0): ConnectorEnds | null {
	const ax = centreX(a.box), ay = centreY(a.box), bx = centreX(b.box), by = centreY(b.box);
	const overlapX = Math.min(a.box.maxX, b.box.maxX) - Math.max(a.box.minX, b.box.minX);
	const overlapY = Math.min(a.box.maxY, b.box.maxY) - Math.max(a.box.minY, b.box.minY);
	const apartY = overlapY < 0;
	const apartX = overlapX < 0;
	const needX = 0.4 * Math.min(width(a.box), width(b.box));
	const needY = 0.4 * Math.min(height(a.box), height(b.box));
	let p: [number, number];
	let q: [number, number];
	if (apartY && overlapX >= needX) {
		const xm = Math.max(a.box.minX, b.box.minX) + overlapX / 2 + offset;
		p = [xm, ay];
		q = [xm, by];
	} else if (apartX && overlapY >= needY) {
		const ym = Math.max(a.box.minY, b.box.minY) + overlapY / 2 + offset;
		p = [ax, ym];
		q = [bx, ym];
	} else {
		const len = Math.hypot(bx - ax, by - ay);
		if (len < 1e-6) return null;
		const nx = -(by - ay) / len, ny = (bx - ax) / len;
		p = [ax + nx * offset, ay + ny * offset];
		q = [bx + nx * offset, by + ny * offset];
	}
	if (!insideShape(a.shape, a.box, p[0], p[1]) || !insideShape(b.shape, b.box, q[0], q[1])) return null;
	const at = (t: number): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
	// The shapes are convex: bisect for the last point inside `a` and the first point inside `b` on the way.
	let lo = 0, hi = 1;
	if (insideShape(a.shape, a.box, ...at(1))) return null;
	for (let i = 0; i < 32; i++) {
		const mid = (lo + hi) / 2;
		if (insideShape(a.shape, a.box, ...at(mid))) lo = mid;
		else hi = mid;
	}
	const tA = lo;
	lo = 0;
	hi = 1;
	if (insideShape(b.shape, b.box, ...at(0))) return null;
	for (let i = 0; i < 32; i++) {
		const mid = (lo + hi) / 2;
		if (insideShape(b.shape, b.box, ...at(mid))) hi = mid;
		else lo = mid;
	}
	const tB = hi;
	if (!(tB > tA)) return null;
	const from = at(tA), to = at(tB);
	const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
	if (len < MIN_ARROW) return null;
	const ux = (to[0] - from[0]) / len, uy = (to[1] - from[1]) / len;
	return {
		from: [from[0] + ux * CLEARANCE, from[1] + uy * CLEARANCE],
		to: [to[0] - ux * CLEARANCE, to[1] - uy * CLEARANCE],
	};
}

// ---------------------------------------------------------------- columns and rows

/**
 * Groups values that lie close together: the index of the cluster of every value, the clusters numbered in increasing order of their mean.
 * A value joins the cluster that is currently last when it is within `tol` of that cluster's mean.
 */
export function cluster1d(values: readonly number[], tol: number): number[] {
	const order = values.map((_, i) => i).sort((i, j) => values[i]! - values[j]! || i - j);
	const out = new Array<number>(values.length).fill(0);
	let cluster = -1;
	let sum = 0;
	let n = 0;
	for (const i of order) {
		const v = values[i]!;
		if (cluster < 0 || v - sum / n > tol) {
			cluster++;
			sum = 0;
			n = 0;
		}
		out[i] = cluster;
		sum += v;
		n++;
	}
	return out;
}

const median = (v: readonly number[]): number => {
	const s = [...v].sort((a, b) => a - b);
	return s.length === 0 ? 0 : s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const snap = (v: number, grid: number): number => (grid > 0 ? Math.round(v / grid) * grid : v);

export interface BoxLayout {
	/** How far each box moves, pt, in the order of the input. */
	deltas: Array<[number, number]>;
	columns: number;
	rows: number;
	/** The column and row of every box. */
	cells: Array<[number, number]>;
}

/** Positions along one axis: the start of every cluster given its size and its current centre, equal gaps, the first start on the grid. */
function stack(sizes: readonly number[], centres: readonly number[], grid: number): { starts: number[]; gap: number } {
	const n = sizes.length;
	if (n === 0) return { starts: [], gap: 0 };
	const firstStart = centres[0]! - sizes[0]! / 2;
	if (n === 1) return { starts: [snap(firstStart, grid)], gap: 0 };
	let total = 0;
	for (let i = 0; i + 1 < n; i++) total += centres[i + 1]! - sizes[i + 1]! / 2 - (centres[i]! + sizes[i]! / 2);
	const gap = Math.max(MIN_GAP, snap(total / (n - 1), grid));
	const starts = [snap(firstStart, grid)];
	for (let i = 1; i < n; i++) starts.push(starts[i - 1]! + sizes[i - 1]! + gap);
	return { starts, gap };
}

/**
 * Lays the boxes out in columns and rows (see the module comment). Null when two boxes land in the same cell (the chart is not a grid
 * of boxes: nothing is moved). `grid` is the step the first column, the first row and the gaps snap to (0: no snapping).
 */
export function layoutBoxes(boxes: readonly LayoutBox[], grid: number): BoxLayout | null {
	const n = boxes.length;
	if (n === 0) return { deltas: [], columns: 0, rows: 0, cells: [] };
	const cx = boxes.map((b) => centreX(b.box)), cy = boxes.map((b) => centreY(b.box));
	const w = boxes.map((b) => width(b.box)), h = boxes.map((b) => height(b.box));
	const col = cluster1d(cx, CLUSTER_SHARE * median(w));
	const row = cluster1d(cy, CLUSTER_SHARE * median(h));
	const columns = Math.max(...col) + 1;
	const rows = Math.max(...row) + 1;
	const seen = new Set<number>();
	for (let i = 0; i < n; i++) {
		const key = col[i]! * rows + row[i]!;
		if (seen.has(key)) return null;
		seen.add(key);
	}
	const colW = new Array<number>(columns).fill(0), colC = new Array<number>(columns).fill(0), colN = new Array<number>(columns).fill(0);
	const rowH = new Array<number>(rows).fill(0), rowC = new Array<number>(rows).fill(0), rowN = new Array<number>(rows).fill(0);
	for (let i = 0; i < n; i++) {
		colW[col[i]!] = Math.max(colW[col[i]!]!, w[i]!);
		colC[col[i]!] = colC[col[i]!]! + cx[i]!;
		colN[col[i]!]!++;
		rowH[row[i]!] = Math.max(rowH[row[i]!]!, h[i]!);
		rowC[row[i]!] = rowC[row[i]!]! + cy[i]!;
		rowN[row[i]!]!++;
	}
	const xs = stack(colW, colC.map((s, c) => s / colN[c]!), grid);
	const ys = stack(rowH, rowC.map((s, r) => s / rowN[r]!), grid);
	const deltas = boxes.map((_, i): [number, number] => [
		xs.starts[col[i]!]! + colW[col[i]!]! / 2 - cx[i]!,
		ys.starts[row[i]!]! + rowH[row[i]!]! / 2 - cy[i]!,
	]);
	return { deltas, columns, rows, cells: boxes.map((_, i): [number, number] => [col[i]!, row[i]!]) };
}
