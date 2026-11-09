import { taperFactor, taperLength, type Taper } from "../model/taper";
import { isNewPen, NIB_DEFAULT, type Point, type Tool } from "../model/types";

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

/**
 * New pens (format v20, #35). Their disc radius is not a function of the pressure alone: it is worked out once per stored point, when
 * the point is added (`InkBuilder.add`), from the point's pressure and the way the pen has been moving, and kept in `InkBuilder.pr`. It is
 * causal (it depends on the points up to this one only), so the wet ink and the committed stroke are built from the same numbers.
 *
 * - Fountain pen: a nib is a line at the stroke's nib angle `θ`; a line that moves along it is hairline thin, one that moves across it is
 *   as wide as the nib is long. The disc of a point has the width the nib would leave for the direction the pen has been moving in
 *   (`|sin|` of the angle between them, from FOUNTAIN_MIN to 1), times a pressure factor from 0.7 to 1.3. Ends are crisp: full width at
 *   once, no taper.
 * - Brush: pressure is the main control (a power curve from a fine tip to a full belly), movement thins the line the faster it goes, the
 *   first stretch grows from a point and the last sample of the stroke closes it to a point (soft ends).
 * - Marker: a flat chisel, constant for any pressure; the width follows the direction like the fountain pen's, but only between
 *   MARKER_MIN and 1 of the nominal width.
 */
export const FOUNTAIN_MIN = 0.14;
export const MARKER_MIN = 0.6;
const BRUSH_GAIN = 1.6;
const BRUSH_SPEED = 0.5;
const BRUSH_FLOOR = 0.08;
const BRUSH_START = 0.3;
const BRUSH_END = 0.35;
/** Speed (pt per stored point, smoothed) below which the brush is not thinned and above which it is thinned fully. */
const BRUSH_SLOW = 1.2;
const BRUSH_FAST = 10;
/** How much of the direction so far the pen keeps when it moves on (the rest is the new movement). */
const DIR_KEEP = 0.5;
/** Direction factor of a point before the pen has moved (the single point of a tap). */
const DIR_TAP = 0.7;

/** Largest disc radius a stroke of this tool and width can have (pt): where the culling boxes and the hit tests have to reach. */
export function inkReach(tool: Tool, width: number): number {
	const half = width / 2;
	if (tool === "fountain") return half * 1.3;
	if (tool === "brush") return half * BRUSH_GAIN;
	return half;
}

/**
 * Position at `t` (0..1) on the curve the ink geometry draws between stored points `b` and `b + 1` (`b + 1 < points.length`):
 * the same centripetal Catmull–Rom segment InkBuilder.emit builds its nodes from (a test keeps the two in step).
 * Not for the hot path: it allocates. Used where a stroke is cut and the pieces must keep their shape.
 */
export function inkCurveAt(points: readonly Point[], b: number, t: number): [number, number] {
	const n = points.length;
	const c = b + 1;
	const A = points[b > 0 ? b - 1 : b]!, B = points[b]!, C = points[c]!, D = points[c + 1 < n ? c + 1 : c]!;
	const ax = A[0], ay = A[1], bx = B[0], by = B[1], cx = C[0], cy = C[1], dx = D[0], dy = D[1];
	const t01 = Math.sqrt(Math.hypot(bx - ax, by - ay));
	const t12 = Math.sqrt(Math.hypot(cx - bx, cy - by));
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
	return [((qax * t + qbx) * t + m1x) * t + bx, ((qay * t + qby) * t + m1y) * t + by];
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
	/** Disc radius of each stored point (worked out when the point is added; see `FOUNTAIN_MIN`). */
	pr = new Float64Array(256);
	/** Nib angle in degrees (the fountain pen and the marker). */
	nib = NIB_DEFAULT;
	/** Movement so far: the direction (smoothed), the length of the path and its speed (smoothed), for the new pens. */
	private dirX = 0;
	private dirY = 0;
	private arc = 0;
	private speed = 0;
	private nibSin = 0;
	private nibCos = 0;
	/** Number of stored points. */
	count = 0;

	/**
	 * Taper (format v25, #351; see `model/taper.ts`): the length (pt) over which the line thins towards its first and its last point, 0 = none.
	 * The START is applied to the radius of each stored point as it is added (`pr`: it depends on the way travelled so far only, so it is causal
	 * like everything else here, and the wet ink thins from the first sample). The END is known only when the pen lifts: `finish()` thins the last
	 * nodes of the chain. A stroke shorter than twice the start taper has it shortened at `finish()` (a rebuild), so that the two ends meet at the
	 * middle at most and a dot stays a dot. `pb` is the radius of a point before the taper and `pa` the length of the polyline to it.
	 */
	taperStart = 0;
	taperEnd = 0;
	private pb = new Float64Array(256);
	private pa = new Float64Array(256);
	private tapered = false;

	/** Nodes: centre and radius. */
	nx = new Float64Array(512);
	ny = new Float64Array(512);
	nr = new Float64Array(512);
	nodeCount = 0;
	/** Segments (point k → k+1) already turned into nodes. */
	private segments = 0;
	private finished = false;

	reset(tool: Tool, width: number, nib: number = NIB_DEFAULT, taper?: Taper): void {
		this.tool = tool;
		this.width = width;
		this.nib = nib;
		this.taperStart = taper && taper.start > 0 ? taperLength(taper.start, width) : 0;
		this.taperEnd = taper && taper.end > 0 ? taperLength(taper.end, width) : 0;
		this.tapered = this.taperStart > 0 || this.taperEnd > 0;
		if (this.tapered && this.pb.length < this.px.length) {
			this.pb = new Float64Array(this.px.length);
			this.pa = new Float64Array(this.px.length);
		}
		const a = (nib * Math.PI) / 180;
		this.nibSin = Math.sin(a);
		this.nibCos = Math.cos(a);
		this.dirX = 0;
		this.dirY = 0;
		this.arc = 0;
		this.speed = 0;
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
	 * Disc radius of point `n` of a fountain pen, brush or marker (see FOUNTAIN_MIN), `x`, `y`, `p` being the stored point and the
	 * previous points the stored ones. Updates the movement state: call once per added point, in order. Allocation-free.
	 */
	private movingRadius(n: number, x: number, y: number, p: number): number {
		let len = 0;
		if (n > 0) {
			const sx = x - this.px[n - 1]!, sy = y - this.py[n - 1]!;
			len = Math.hypot(sx, sy);
			this.dirX = this.dirX * DIR_KEEP + sx;
			this.dirY = this.dirY * DIR_KEEP + sy;
			this.arc += len;
			this.speed = this.speed * 0.5 + len * 0.5;
		}
		const half = this.width / 2;
		const tool = this.tool;
		if (tool === "brush") {
			const t = Math.min(1, Math.max(0, (this.speed - BRUSH_SLOW) / (BRUSH_FAST - BRUSH_SLOW)));
			const thin = 1 - BRUSH_SPEED * t * t * (3 - 2 * t);
			const press = BRUSH_FLOOR + (1 - BRUSH_FLOOR) * Math.pow(p, 1.4);
			const grown = Math.min(1, this.arc / (0.8 * this.width + 2));
			return Math.max(0.01, half * BRUSH_GAIN * press * thin * (BRUSH_START + (1 - BRUSH_START) * grown));
		}
		// The width a nib leaves for the direction the pen moves in: |sin| of the angle between them.
		let across = DIR_TAP;
		const dl = Math.hypot(this.dirX, this.dirY);
		if (dl > 1e-6) across = Math.abs(this.dirX * this.nibSin + this.dirY * this.nibCos) / dl;
		if (tool === "fountain") return Math.max(0.01, half * (FOUNTAIN_MIN + (1 - FOUNTAIN_MIN) * across) * (0.7 + 0.6 * p));
		return Math.max(0.01, half * (MARKER_MIN + (1 - MARKER_MIN) * across));
	}

	/**
	 * Disc radius of a provisional tip point (the raw pen position, a predicted point) that is not a stored point: the pressure for the old
	 * pens, the radius of the last stored point for the new ones (their radius follows the movement, which a tip point does not have yet).
	 * Format v25: inside the start taper the tip is thinned like the trail (by the way travelled to the tip at `x`, `y`: the polyline to the last
	 * stored point plus the straight distance from it), so no full-size dot rides at the pen while the line behind it is still thin.
	 */
	tipRadius(pressure: number, x?: number, y?: number): number {
		const n = this.count;
		if (isNewPen(this.tool) && n > 0) return this.pr[n - 1]!;
		const r = inkRadius(this.tool, this.width, pressure);
		if (this.taperStart > 0) {
			let arc = 0;
			if (n > 0) {
				arc = this.pa[n - 1]!;
				if (x !== undefined && y !== undefined) arc += Math.hypot(x - this.px[n - 1]!, y - this.py[n - 1]!);
			}
			if (arc < this.taperStart) return Math.max(0.01, r * taperFactor(arc / this.taperStart));
		}
		return r;
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
			this.pr = grow(this.pr, n + 1);
		}
		if (this.tapered && n + 1 > this.pb.length) {
			this.pb = grow(this.pb, n + 1);
			this.pa = grow(this.pa, n + 1);
		}
		this.px[n] = qx;
		this.py[n] = qy;
		this.pp[n] = qpr;
		// The old pens keep their pressure-only radius (the same number the nodes always had); the new ones follow the movement too.
		const radius = isNewPen(this.tool) ? this.movingRadius(n, qx, qy, qpr) : inkRadius(this.tool, this.width, qpr);
		if (this.tapered) {
			// The start taper thins the point by the way travelled so far (the polyline through the stored points).
			const arc = n > 0 ? this.pa[n - 1]! + Math.hypot(qx - this.px[n - 1]!, qy - this.py[n - 1]!) : 0;
			this.pb[n] = radius;
			this.pa[n] = arc;
			this.pr[n] = this.taperStart > 0 ? Math.max(0.01, radius * taperFactor(arc / this.taperStart)) : radius;
		} else this.pr[n] = radius;
		this.count = n + 1;
		if (n === 0) {
			this.reserveNodes(1);
			this.nx[0] = qx;
			this.ny[0] = qy;
			this.nr[0] = this.pr[0]!;
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
		// Format v25: a tapered stroke is finished by its own routine (the plain one below is untouched, so an untapered stroke is what it always was).
		if (this.tapered && n >= 1) {
			this.finishTapered();
			return;
		}
		// Brush: the last sample closes the line to a point. Only the last segment is still to be built, so nothing on screen changes.
		if (this.tool === "brush" && n >= 2 && this.segments <= n - 2) this.pr[n - 1] = Math.max(0.01, this.pr[n - 1]! * BRUSH_END);
		while (this.segments < n - 1) {
			const k = this.segments;
			this.emit(k, k + 1, Math.min(k + 2, n - 1));
		}
	}

	/**
	 * `finish()` of a stroke with a taper. The start taper is already in the radii of the points; it is shortened to half the stroke's length when
	 * the stroke is shorter than twice of it (then the nodes are built again from the untapered radii, which is the only case the wet ink and the
	 * committed stroke differ at the start). The end taper is then applied to the last nodes of the chain, over at most half the stroke's length.
	 */
	private finishTapered(): void {
		const n = this.count;
		const half = this.pa[n - 1]! / 2;
		if (this.taperStart > half) {
			// A start taper longer than half the stroke: rebuild with the shorter one (a dot, with no length, is not tapered at all).
			this.taperStart = half;
			for (let k = 0; k < n; k++) this.pr[k] = this.taperStart > 0 ? Math.max(0.01, this.pb[k]! * taperFactor(this.pa[k]! / this.taperStart)) : this.pb[k]!;
			if (this.tool === "brush" && n >= 2) this.pr[n - 1] = Math.max(0.01, this.pr[n - 1]! * BRUSH_END);
			this.nx[0] = this.px[0]!;
			this.ny[0] = this.py[0]!;
			this.nr[0] = this.pr[0]!;
			this.nodeCount = 1;
			this.segments = 0;
		} else if (this.tool === "brush" && n >= 2 && this.segments <= n - 2) this.pr[n - 1] = Math.max(0.01, this.pr[n - 1]! * BRUSH_END);
		while (this.segments < n - 1) {
			const k = this.segments;
			this.emit(k, k + 1, Math.min(k + 2, n - 1));
		}
		const end = Math.min(this.taperEnd, half);
		if (end <= 0) return;
		const { nx, ny, nr, nodeCount: m } = this;
		let dist = 0;
		for (let i = m - 1; i >= 0; i--) {
			if (i < m - 1) dist += Math.hypot(nx[i + 1]! - nx[i]!, ny[i + 1]! - ny[i]!);
			if (dist >= end) break;
			nr[i] = Math.max(0.01, nr[i]! * taperFactor(dist / end));
		}
	}

	/** Stored points as the model's Point arrays (allocates; for commit and shape recognition). */
	toPoints(): Point[] {
		const out: Point[] = new Array<Point>(this.count);
		for (let i = 0; i < this.count; i++) out[i] = [this.px[i]!, this.py[i]!, this.pp[i]!];
		return out;
	}

	/** Builds the whole geometry of saved points. */
	static fromPoints(points: readonly Point[], width: number, tool: Tool, into = new InkBuilder(), nib: number = NIB_DEFAULT, taper?: Taper): InkBuilder {
		into.reset(tool, width, nib, taper);
		for (const p of points) into.add(p[0], p[1], p[2]);
		into.finish();
		return into;
	}

	/** Appends the nodes of segment b → c (c = b+1), using `d` (b+2, or c at the end) as the next point. */
	private emit(b: number, c: number, d: number): void {
		const a = b > 0 ? b - 1 : b;
		const { px, py } = this;
		const ax = px[a]!, ay = py[a]!, bx = px[b]!, by = py[b]!, cx = px[c]!, cy = py[c]!, dx = px[d]!, dy = py[d]!;
		const rb = this.pr[b]!;
		const rc = this.pr[c]!;
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
export function inkPath(sink: PathSink, points: readonly Point[], width: number, tool: Tool, nib: number = NIB_DEFAULT, taper?: Taper): void {
	addInkPath(sink, InkBuilder.fromPoints(points, width, tool, shared, nib, taper));
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
