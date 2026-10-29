import type { Point, Tool } from "../model/types";

/**
 * Wet-ink geometry (render version 2, see docs/architecture.md §6).
 *
 * A stroke is a chain of discs ("nodes") joined by the tangent trapezoids between consecutive
 * discs: the area swept by a disc whose radius follows the pressure. Between two stored points the
 * chain follows a centripetal Catmull–Rom curve, so fast strokes stay round instead of polygonal.
 *
 * The geometry is built incrementally and is causal: the nodes between points k and k+1 depend only
 * on points k-1..k+2, so they are final as soon as point k+2 exists (or the stroke ends). Painting
 * each new piece as it becomes final therefore produces exactly the shape that is later drawn from
 * the saved points: nothing already on screen changes when the pen lifts.
 *
 * Everything is in page coordinates (pt). The hot path writes to typed arrays and allocates
 * nothing per point (arrays grow by doubling).
 */

/** Maximum length (pt) of one curve piece between two nodes. */
export const INK_STEP_PT = 1.5;
/** At most this many nodes between two stored points. */
export const INK_MAX_STEPS = 16;
const TAU = Math.PI * 2;

/** Disc radius (pt) for a point. Pen: the same pressure response as PEN_V1 (perfect-freehand, thinning 0.6). */
export function inkRadius(tool: Tool, width: number, pressure: number): number {
	if (tool === "pen") return Math.max(0.01, width * (0.2 + 0.6 * pressure));
	return Math.max(0.01, width / 2);
}

/** What paths are drawn into: Path2D and CanvasRenderingContext2D both qualify. */
export interface PathSink {
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	arc(x: number, y: number, r: number, start: number, end: number): void;
	closePath(): void;
}

function grow(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
	if (need <= a.length) return a;
	let n = a.length * 2;
	while (n < need) n *= 2;
	const b = new Float64Array(n);
	b.set(a);
	return b;
}

export class InkBuilder {
	tool: Tool = "pen";
	width = 1;

	/** Stored (quantized) points: x, y, pressure. */
	px = new Float64Array(256);
	py = new Float64Array(256);
	pp = new Float64Array(256);
	/** Number of stored points. */
	count = 0;

	/** Nodes: centre and radius. */
	nx = new Float64Array(512);
	ny = new Float64Array(512);
	nr = new Float64Array(512);
	nodeCount = 0;
	/** Segments (point k → k+1) already turned into nodes. */
	private segments = 0;
	private finished = false;

	reset(tool: Tool, width: number): void {
		this.tool = tool;
		this.width = width;
		this.count = 0;
		this.nodeCount = 0;
		this.segments = 0;
		this.finished = false;
	}

	/** Index of the stored point the last node sits on; points after it are not final yet. */
	get finalPoint(): number {
		return this.segments;
	}

	get done(): boolean {
		return this.finished;
	}

	/** Distance (pt) from the last stored point, Infinity when there is none. */
	distanceToLast(x: number, y: number): number {
		const n = this.count;
		if (n === 0) return Infinity;
		return Math.hypot(x - this.px[n - 1]!, y - this.py[n - 1]!);
	}

	/**
	 * Adds a point (quantized like the file). Returns false when it lands on the previous point,
	 * which is then left unchanged (its disc may already be on screen).
	 */
	add(x: number, y: number, pressure: number): boolean {
		if (this.finished) return false;
		// Inline rounding (a helper returning doubles would box them).
		const qx = Math.round(x * 100) / 100, qy = Math.round(y * 100) / 100;
		const qpr = Math.round((Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5) * 1000) / 1000;
		const n = this.count;
		if (n > 0 && this.px[n - 1] === qx && this.py[n - 1] === qy) return false;
		if (n + 1 > this.px.length) {
			this.px = grow(this.px, n + 1);
			this.py = grow(this.py, n + 1);
			this.pp = grow(this.pp, n + 1);
		}
		this.px[n] = qx;
		this.py[n] = qy;
		this.pp[n] = qpr;
		this.count = n + 1;
		if (n === 0) {
			this.reserveNodes(1);
			this.nx[0] = qx;
			this.ny[0] = qy;
			this.nr[0] = inkRadius(this.tool, this.width, qpr);
			this.nodeCount = 1;
		}
		else if (n >= 2) this.emit(n - 2, n - 1, n);
		return true;
	}

	/** The pen lifted: the last segment becomes final. */
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		const n = this.count;
		while (this.segments < n - 1) {
			const k = this.segments;
			this.emit(k, k + 1, Math.min(k + 2, n - 1));
		}
	}

	/** Stored points as the model's Point arrays (allocates; for commit and shape recognition). */
	toPoints(): Point[] {
		const out: Point[] = new Array<Point>(this.count);
		for (let i = 0; i < this.count; i++) out[i] = [this.px[i]!, this.py[i]!, this.pp[i]!];
		return out;
	}

	/** Builds the whole geometry of saved points. */
	static fromPoints(points: readonly Point[], width: number, tool: Tool, into = new InkBuilder()): InkBuilder {
		into.reset(tool, width);
		for (const p of points) into.add(p[0], p[1], p[2]);
		into.finish();
		return into;
	}

	/** Appends the nodes of segment b → c (c = b+1), using `d` (b+2, or c at the end) as the next point. */
	private emit(b: number, c: number, d: number): void {
		const a = b > 0 ? b - 1 : b;
		const { px, py } = this;
		const ax = px[a]!, ay = py[a]!, bx = px[b]!, by = py[b]!, cx = px[c]!, cy = py[c]!, dx = px[d]!, dy = py[d]!;
		const rb = inkRadius(this.tool, this.width, this.pp[b]!);
		const rc = inkRadius(this.tool, this.width, this.pp[c]!);
		const len = Math.hypot(cx - bx, cy - by);
		const steps = Math.min(INK_MAX_STEPS, Math.max(1, Math.ceil(len / INK_STEP_PT)));
		// Written straight into the arrays: passing doubles to a helper would box them (garbage per node).
		this.reserveNodes(steps);
		const { nx, ny, nr } = this;
		let i = this.nodeCount;
		if (steps > 1) {
			// Centripetal Catmull–Rom (alpha 0.5) as a Hermite segment on [0, 1].
			const t01 = Math.sqrt(Math.hypot(bx - ax, by - ay));
			const t12 = Math.sqrt(len);
			const t23 = Math.sqrt(Math.hypot(dx - cx, dy - cy));
			let m1x = cx - bx, m1y = cy - by, m2x = cx - bx, m2y = cy - by;
			if (t01 > 1e-9) {
				m1x += t12 * ((bx - ax) / t01 - (cx - ax) / (t01 + t12));
				m1y += t12 * ((by - ay) / t01 - (cy - ay) / (t01 + t12));
			}
			if (t23 > 1e-9) {
				m2x += t12 * ((dx - cx) / t23 - (dx - bx) / (t12 + t23));
				m2y += t12 * ((dy - cy) / t23 - (dy - by) / (t12 + t23));
			}
			const qax = 2 * bx - 2 * cx + m1x + m2x, qay = 2 * by - 2 * cy + m1y + m2y;
			const qbx = -3 * bx + 3 * cx - 2 * m1x - m2x, qby = -3 * by + 3 * cy - 2 * m1y - m2y;
			for (let j = 1; j < steps; j++) {
				const t = j / steps;
				nx[i] = ((qax * t + qbx) * t + m1x) * t + bx;
				ny[i] = ((qay * t + qby) * t + m1y) * t + by;
				nr[i] = rb + (rc - rb) * t;
				i++;
			}
		}
		nx[i] = cx;
		ny[i] = cy;
		nr[i] = rc;
		this.nodeCount = i + 1;
		this.segments = b + 1;
	}

	private reserveNodes(k: number): void {
		const need = this.nodeCount + k;
		if (need <= this.nx.length) return;
		this.nx = grow(this.nx, need);
		this.ny = grow(this.ny, need);
		this.nr = grow(this.nr, need);
	}
}

/**
 * Adds the disc of node `i` and, for i > 0, the trapezoid tangent to the discs of nodes i-1 and i.
 * All subpaths have the same orientation, so a nonzero fill of many of them is their union.
 */
export function addCapsule(sink: PathSink, nx: ArrayLike<number>, ny: ArrayLike<number>, nr: ArrayLike<number>, i: number, disc = true): void {
	const bx = nx[i]!, by = ny[i]!, rb = nr[i]!;
	if (i > 0) addTrapezoid(sink, nx[i - 1]!, ny[i - 1]!, nr[i - 1]!, bx, by, rb);
	if (disc) {
		sink.moveTo(bx + rb, by);
		sink.arc(bx, by, rb, 0, TAU);
		sink.closePath();
	}
}

/** Tangent trapezoid between two discs (nothing when one contains the other). */
export function addTrapezoid(sink: PathSink, ax: number, ay: number, ra: number, bx: number, by: number, rb: number): void {
	const ddx = bx - ax, ddy = by - ay;
	const d = Math.hypot(ddx, ddy);
	if (d <= Math.abs(ra - rb) + 1e-9) return;
	const ux = ddx / d, uy = ddy / d;
	const cos = (ra - rb) / d;
	const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
	// n1 = u rotated by +phi, n2 = u rotated by -phi.
	const n1x = ux * cos - uy * sin, n1y = ux * sin + uy * cos;
	const n2x = ux * cos + uy * sin, n2y = -ux * sin + uy * cos;
	sink.moveTo(ax + ra * n2x, ay + ra * n2y);
	sink.lineTo(bx + rb * n2x, by + rb * n2y);
	sink.lineTo(bx + rb * n1x, by + rb * n1y);
	sink.lineTo(ax + ra * n1x, ay + ra * n1y);
	sink.closePath();
}

/** Unit normals of the trapezoid between nodes a and b, written to `out` (n1x, n1y, n2x, n2y); false if degenerate. */
function normals(nx: ArrayLike<number>, ny: ArrayLike<number>, nr: ArrayLike<number>, a: number, b: number, out: Float64Array): boolean {
	const ddx = nx[b]! - nx[a]!, ddy = ny[b]! - ny[a]!;
	const d = Math.hypot(ddx, ddy);
	if (d <= Math.abs(nr[a]! - nr[b]!) + 1e-9) return false;
	const ux = ddx / d, uy = ddy / d;
	const cos = (nr[a]! - nr[b]!) / d;
	const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
	out[0] = ux * cos - uy * sin;
	out[1] = ux * sin + uy * cos;
	out[2] = ux * cos + uy * sin;
	out[3] = -ux * sin + uy * cos;
	return true;
}

/** Normals of each trapezoid of the committed path (n1x, n1y, n2x, n2y per trapezoid), reused. */
let TN = new Float64Array(4 * 256);
let TV = new Uint8Array(256);

/**
 * Adds the committed path of a finished geometry: the same area as the capsules painted while
 * writing, with far fewer edges to fill. The chain is cut into runs where the outline bends
 * gently; each run is one polygon through the tangent points of its trapezoids (on each side,
 * one point per node on the bisector of the two neighbouring normals), and a disc is kept at each
 * end of a run. A run ends where consecutive trapezoids turn by more than 25°, where a trapezoid
 * vanishes (one disc inside the next) or where either side of the outline would step backwards
 * (a turn tighter than the radius), so a polygon never folds over itself. Inside a run the
 * polygon differs from the union of capsules by at most r·(1 − cos 12.5°) ≈ 2.4% of the radius,
 * on the outer side of bends: below a pixel at any normal zoom.
 */
export function addInkPath(sink: PathSink, g: InkBuilder): void {
	const { nx, ny, nr, nodeCount: n } = g;
	if (n === 0) return;
	if (TV.length < n) {
		TN = new Float64Array(4 * n * 2);
		TV = new Uint8Array(n * 2);
	}
	for (let j = 0; j + 1 < n; j++) {
		TV[j] = normals(nx, ny, nr, j, j + 1, NA) ? 1 : 0;
		TN[4 * j] = NA[0]!;
		TN[4 * j + 1] = NA[1]!;
		TN[4 * j + 2] = NA[2]!;
		TN[4 * j + 3] = NA[3]!;
	}
	addDisc(sink, nx[0]!, ny[0]!, nr[0]!);
	let s = 0;
	while (s < n - 1) {
		if (!TV[s]) {
			// One disc contains the next: the disc alone is the shape.
			s++;
			addDisc(sink, nx[s]!, ny[s]!, nr[s]!);
			continue;
		}
		// Extend the run [s, e] while the next trapezoid continues it smoothly.
		let e = s + 1;
		while (e < n - 1 && TV[e] && smoothJoin(nx, ny, nr, e)) e++;
		// One side, forward (n2), then the other, backward (n1): positive orientation like the capsules.
		for (let k = s; k <= e; k++) {
			sideNormal(k, s, e, 2);
			const x = nx[k]! + nr[k]! * SN[0]!, y = ny[k]! + nr[k]! * SN[1]!;
			if (k === s) sink.moveTo(x, y);
			else sink.lineTo(x, y);
		}
		for (let k = e; k >= s; k--) {
			sideNormal(k, s, e, 0);
			sink.lineTo(nx[k]! + nr[k]! * SN[0]!, ny[k]! + nr[k]! * SN[1]!);
		}
		sink.closePath();
		addDisc(sink, nx[e]!, ny[e]!, nr[e]!);
		s = e;
	}
}

const NA = new Float64Array(4);
const SN = new Float64Array(2);
const BEND_COS = Math.cos((25 * Math.PI) / 180);

/** Unit normal on side `off` (0: n1, 2: n2) at node k of the run [s, e]: the bisector inside the run. */
function sideNormal(k: number, s: number, e: number, off: number): void {
	if (k === s || k === e) {
		const j = k === s ? s : e - 1;
		SN[0] = TN[4 * j + off]!;
		SN[1] = TN[4 * j + off + 1]!;
		return;
	}
	const x = TN[4 * (k - 1) + off]! + TN[4 * k + off]!, y = TN[4 * (k - 1) + off + 1]! + TN[4 * k + off + 1]!;
	const l = Math.hypot(x, y) || 1;
	SN[0] = x / l;
	SN[1] = y / l;
}

/** Can the run continue through node k (trapezoids k-1 and k are both valid)? */
function smoothJoin(nx: ArrayLike<number>, ny: ArrayLike<number>, nr: ArrayLike<number>, k: number): boolean {
	const a = 4 * (k - 1), b = 4 * k;
	if (TN[a]! * TN[b]! + TN[a + 1]! * TN[b + 1]! < BEND_COS) return false;
	if (TN[a + 2]! * TN[b + 2]! + TN[a + 3]! * TN[b + 3]! < BEND_COS) return false;
	// Neither side may step backwards between node k and k+1 (turn tighter than the radius).
	const dx = nx[k + 1]! - nx[k]!, dy = ny[k + 1]! - ny[k]!;
	for (let off = 0; off <= 2; off += 2) {
		const x0 = nx[k]! + nr[k]! * (TN[a + off]! + TN[b + off]!) / 2, y0 = ny[k]! + nr[k]! * (TN[a + off + 1]! + TN[b + off + 1]!) / 2;
		const x1 = nx[k + 1]! + nr[k + 1]! * TN[b + off]!, y1 = ny[k + 1]! + nr[k + 1]! * TN[b + off + 1]!;
		if ((x1 - x0) * dx + (y1 - y0) * dy <= 0) return false;
	}
	return true;
}

function addDisc(sink: PathSink, x: number, y: number, r: number): void {
	sink.moveTo(x + r, y);
	sink.arc(x, y, r, 0, TAU);
	sink.closePath();
}

/** Bounding box of a finished geometry (pt). */
export function inkBounds(g: InkBuilder): { minX: number; minY: number; maxX: number; maxY: number } {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < g.nodeCount; i++) {
		const x = g.nx[i]!, y = g.ny[i]!, r = g.nr[i]!;
		if (x - r < minX) minX = x - r;
		if (y - r < minY) minY = y - r;
		if (x + r > maxX) maxX = x + r;
		if (y + r > maxY) maxY = y + r;
	}
	return { minX, minY, maxX, maxY };
}

const shared = new InkBuilder();

/** Committed path of saved points into `sink` (Path2D, canvas, or an export writer). */
export function inkPath(sink: PathSink, points: readonly Point[], width: number, tool: Tool): void {
	addInkPath(sink, InkBuilder.fromPoints(points, width, tool, shared));
}

/** SVG number: 0.01 pt precision. */
function svgNum(v: number): string {
	return (Math.round(v * 100) / 100).toString();
}

/** Collects a path as an SVG `d` string (arcs as two half-circle `A` commands). */
export class SvgPathSink implements PathSink {
	d = "";
	moveTo(x: number, y: number): void {
		this.d += `M${svgNum(x)} ${svgNum(y)}`;
	}
	lineTo(x: number, y: number): void {
		this.d += `L${svgNum(x)} ${svgNum(y)}`;
	}
	arc(x: number, y: number, r: number): void {
		// Full circle from angle 0, positive direction (sweep flag 1), like canvas arc(…, 0, 2π).
		const f = svgNum;
		this.d += `A${f(r)} ${f(r)} 0 1 1 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x + r)} ${f(y)}`;
	}
	closePath(): void {
		this.d += "Z";
	}
}
